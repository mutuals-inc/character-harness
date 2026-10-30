#include "renderer.glsl"

// Toon shading for VRM characters, following VRM's MToon material
// (VRMC_materials_mtoon): a lit and a shade color split by a soft toon ramp,
// rim light, matcap and emission. The ramp and rim follow MToon 1.0 as
// published in UniVRM (MIT licence: Copyright (c) 2020 VRM Consortium,
// Copyright (c) 2018 Masataka SUMI for MToon).
//
// On top of MToon, optional character features, all off unless a material
// turns them on: a highlight tone, face shading toward a sphere around the
// head, blush and nervous tints, sparkle decals in the eyes, watery eyes, and an Over Hair
// pass (MTOON_OVER_HAIR) that draws brows and lashes through the bangs.

@vs
#define HZ_RENDERER_VERTEX_SHADER
#define HZ_RENDERER_BLENDSHAPED
#define HZ_RENDERER_SKINNED
#define HZ_RENDERER_LIGHTING_CLUSTERS
#define HZ_RENDERER_VS_MATERIAL
#include "renderer_shaders.glsl"
out vec3 v_world_pos;
out vec3 v_normal;
out vec2 v_uv;
flat out uint v_material_offset;
out vec3 v_tangent;
out float v_bitangent_sign;
out float v_view_depth;
out vec3 v_smooth_normal;
flat out vec3 v_model_c0;
flat out vec3 v_model_c1;
flat out vec3 v_model_c2;
out float v_vcolor_r;
#ifdef HZ_RENDERER_GBUFFER
out vec4 v_clip_cur;
out vec4 v_clip_prev;
#endif

void main() {
    VertexInstanceData v = unpack_instance_data();
    v_vcolor_r = v.color.r;
#ifdef HZ_RENDERER_GBUFFER
    vec3 rest_pos = v.pos; // the undeformed position, for last frame's pose below
#endif

    apply_blendshapes(v.pos, v.vertex_index, v.bs_offsets_base, v.bs_weights_offset);
    // face shading: the normal of a sphere around the head, taken before
    // skinning and then skinned like the vertex, so it turns with the head.
    // The sphere's center is face_params.xyz, material words 32..34.
    vec3 face_center = vec3(
        uintBitsToFloat(hz_materials.data[v.material_offset + 32u]),
        uintBitsToFloat(hz_materials.data[v.material_offset + 33u]),
        uintBitsToFloat(hz_materials.data[v.material_offset + 34u]));
    vec3 to_vertex = v.pos - face_center;
    vec3 sphere_dir = dot(to_vertex, to_vertex) > 1e-12 ? normalize(to_vertex) : v.normal;
    apply_skinning(v.pos, v.normal, v.tangent, v.bone_offset, v.vertex_base, v.vertex_layout_flags);
    v_smooth_normal = skin_dir(sphere_dir, v.bone_offset, v.vertex_base, v.vertex_layout_flags);
    v_model_c0 = v.model[0].xyz;
    v_model_c1 = v.model[1].xyz;
    v_model_c2 = v.model[2].xyz;

    vec4 position_ws = v.model * vec4(v.pos, 1.0);
    gl_Position = hz_instance_clip(v, position_ws);
#ifdef MTOON_OVER_HAIR
    // move only the depth: test as if `push` meters closer to the camera, so
    // the brows win over the bangs right in front of them and still lose to
    // anything nearer. Rescaling z by the original w keeps the screen position.
    float push = uintBitsToFloat(hz_materials.data[v.material_offset + 92u]);
    vec3 toward_camera = hz_scene.camera_pos - position_ws.xyz;
    float camera_dist = length(toward_camera);
    vec3 nearer = position_ws.xyz +
                  toward_camera * (min(push, 0.5 * camera_dist) / max(camera_dist, 1e-4));
    vec4 nearer_clip = hz_instance_clip(v, vec4(nearer, 1.0));
    gl_Position.z = nearer_clip.z / nearer_clip.w * gl_Position.w;
#endif
    v_world_pos = position_ws.xyz;
    v_normal = normalize((v.model * vec4(v.normal, 0.0)).xyz);
    v_tangent = normalize((v.model * vec4(v.tangent, 0.0)).xyz);
    v_bitangent_sign = v.bitangent_sign;
    v_uv = v.uv;
    v_material_offset = v.material_offset;
    v_view_depth = -(hz_scene.view * position_ws).z;

#ifdef HZ_RENDERER_GBUFFER
    // this frame's and last frame's clip positions, without jitter, for motion
    // vectors; last frame's pose is rebuilt the same way, blendshapes then skin
    vec3 last_pos = rest_pos;
    apply_blendshapes_prev(last_pos, v.vertex_index, v.bs_offsets_base, v.bs_weights_offset);
    last_pos = apply_skinning_prev_pos(last_pos, v.bone_offset, v.vertex_base, v.vertex_layout_flags);
    HzVelocity vel = hz_instance_velocity(v, position_ws, unpack_prev_model() * vec4(last_pos, 1.0));
    v_clip_cur = vel.clip_cur;
    v_clip_prev = vel.clip_prev;
#endif
}
@end

@fs
#undef HZ_RENDERER_VERTEX_SHADER
#define HZ_RENDERER_FRAGMENT_SHADER
#define HZ_RENDERER_SHADOWS
#define HZ_RENDERER_LIGHTING_CLUSTERS
// WebGPU allows 16 sampled textures per stage and the material has 14, so the
// web build leaves out the sky light and fog (2 + 3 textures); the player's
// stage has no sky light and its fog is too thin to see at portrait distance
#ifndef SHADER_BACKEND_WGSL
#define HZ_RENDERER_IBL
#define HZ_RENDERER_FOG
#endif
// hz_output_lit declares and writes every target the pass asks for
#define HZ_RENDERER_OUTPUT
#include "renderer_shaders.glsl"
in vec3 v_world_pos;
in vec3 v_normal;
in vec2 v_uv;
flat in uint v_material_offset;
in vec3 v_tangent;
in float v_bitangent_sign;
in float v_view_depth;
in vec3 v_smooth_normal;
flat in vec3 v_model_c0;
flat in vec3 v_model_c1;
flat in vec3 v_model_c2;
in float v_vcolor_r;
// the renderer's extra targets when it asks for them: motion, normal, depth,
// how much the upscaler should trust history, and the opaque color
#ifdef HZ_RENDERER_GBUFFER
in vec4 v_clip_cur;
in vec4 v_clip_prev;
#endif

// The material, as the model's VRM MToon settings fill it; the engine's
// importer fills each field by its name. Each map's default
// leaves the result unchanged when the material has none (white multiplies by
// one, black adds nothing, the flat normal bends nothing). The field order is
// fixed: the vertex stage reads face_params and over_hair_params by position,
// and mtoon_outline.glsl reads the same slice up to face_mask_map.
@material
struct MaterialFS {
    @color vec4 lit_color;     // base color; .a opacity
    @color vec4 shade_color;   // the color in shadow
    @color vec4 rim_color;     // rim color; .a how much the rim follows the light
    @color vec4 emissive;      // emission color; .a strength
    @color vec4 matcap_color;  // matcap tint
    vec4 toon;                 // shift, toony, rim fresnel power, rim lift
    @color vec4 highlight_color;
    vec4 highlight_params;     // shift, toony, on (> 0.5), use highlight_map (> 0)
    vec4 face_params;          // sphere center (model space), blend amount
    vec4 gi_params;            // GI equalization, shift-map scale, normal-map scale, rim vertex mask
    @color vec4 outline_color; // used by the outline pass only
    vec4 outline_params;       // width, lighting mix, mode, vertex mask
    float alpha_cutoff;        // 0: no cutout
    float shadow_strength;     // 1: full cast shadow, 0: none (faces and eyes stay clean)
    @texture2D @white
    uint map;
    @texture2D @white
    uint shade_map;
    @texture2D @normal
    uint normal_map;
    @texture2D @black
    uint emissive_map;
    @texture2D @black
    uint matcap_map;
    @texture2D @white
    uint rim_map;
    @texture2D @black
    uint shading_shift_map;
    @texture2D @white
    uint face_mask_map;
    @texture2D @white
    uint highlight_map;
    @color vec4 blush_color;
    @color vec4 nervous_color;
    vec4 blush_params;          // blush amount, nervous amount
    @texture2D @white
    uint blush_mask;
    @texture2D @white
    uint nervous_mask;
    @color vec4 star_eyes_tint;
    vec4 star_teary_params;     // sparkle amount, tears on (> 0.5), tear amount, tear strength
    vec4 teary_params2;         // tear noise frequency, tear scroll speed
    @texture2D @black
    uint star_eyes_mask;        // RGBA decal
    @texture2D @black
    uint teary_noise;           // RG offsets
    @texture2D @white
    uint teary_mask;            // R: where the eye ripples
    // Over Hair: the UV rectangle drawn through the bangs (min xy, max zw), and
    // depth push (m), opacity, and the facing range it fades over. The app
    // sets both at spawn (app_character_over_hair_update); left at zero, the
    // pass draws nothing. over_hair_params is material word 92.
    vec4 over_hair_rect;
    vec4 over_hair_params;
};

// the sky's diffuse light toward dir; none without the sky light
vec3 toon_sky(vec3 dir) {
#ifdef HZ_RENDERER_IBL
    return ibl_irradiance(dir);
#else
    return vec3(0.0);
#endif
}

// fog over a lit color; none without fog
vec3 toon_fog(vec3 color, float view_depth) {
#ifdef HZ_RENDERER_FOG
    return hz_fog_apply(color, view_depth);
#else
    return color;
#endif
}

// 0 below a, 1 above b, linear between; never divides by zero
float toon_step(float a, float b, float x) {
    return clamp((x - a) / max(b - a, 1e-4), 0.0, 1.0);
}

// how much the ramp is shifted here: the factor plus the shift map
float toon_shift(MaterialFS mat, vec2 uv) {
    return mat.toon.x + mat.gi_params.y * texture_sample(shading_shift_map, mat.shading_shift_map, uv).r;
}

// lit amount (0 shade .. 1 lit) for the main lights: n.l remapped through a
// half-Lambert curve, then the toon ramp
float toon_lit_main(float n_dot_l, float shift, float toony) {
    float half_lambert = toon_step(-1.0, 1.0, n_dot_l) * 2.0 - 1.0;
    return toon_step(toony - 1.0, 1.0 - toony, half_lambert + shift);
}

// lit amount for point lights: the toon ramp straight on n.l
float toon_lit_point(float n_dot_l, float shift, float toony) {
    return toon_step(toony - 1.0, 1.0 - toony, n_dot_l + shift);
}

// the highlight tone's amount, a second ramp on the lit side; 0 when off
float toon_highlight(float n_dot_l, MaterialFS mat) {
    if (mat.highlight_params.z < 0.5)
        return 0.0;
    float half_lambert = toon_step(-1.0, 1.0, n_dot_l) * 2.0 - 1.0;
    float softness = mat.highlight_params.y;
    return toon_step(softness - 1.0, 1.0 - softness, half_lambert + mat.highlight_params.x);
}

// one light's contribution: shade to lit by the ramp, then toward the highlight
vec3 toon_light(vec3 lit, vec3 shade, vec3 highlight_rgb, float lit_amount,
                float highlight, vec3 radiance) {
    vec3 surface = mix(mix(shade, lit, lit_amount), highlight_rgb, highlight);
    return surface * radiance;
}

void main() {
    MaterialFS mat = MaterialFS_unpack(v_material_offset);

    vec2 uv = v_uv;
#ifdef MTOON_OVER_HAIR
    // this pass draws only its UV rectangle (say, the brows on the face texture)
    if (any(lessThan(v_uv, mat.over_hair_rect.xy)) || any(greaterThan(v_uv, mat.over_hair_rect.zw)))
        discard;
#endif
    // watery eyes: two scrolling noise samples at different scales offset the
    // UV, so the iris ripples; the mask is read at the steady UV
    if (mat.star_teary_params.y >= 0.5 && mat.star_teary_params.z > 0.0) {
        float ripple_area = texture_sample(teary_mask, mat.teary_mask, uv).r;
        float t = hz_scene.time * mat.teary_params2.y;
        vec2 noise_a = texture_sample(teary_noise, mat.teary_noise,
                                      uv * mat.teary_params2.x + vec2(0.0, t)).rg;
        vec2 noise_b = texture_sample(teary_noise, mat.teary_noise,
                                      uv * (mat.teary_params2.x * 1.37) + vec2(0.31, 0.73 * t)).rg;
        uv += (noise_a + noise_b - 1.0) * (mat.star_teary_params.z * mat.star_teary_params.w * ripple_area);
    }

    // base color and cutout
    vec4 base = mat.lit_color * texture_sample(map, mat.map, uv);
    if (base.a < mat.alpha_cutoff)
        discard;
    vec3 lit = base.rgb;
    vec3 shade = mat.shade_color.rgb * texture_sample(shade_map, mat.shade_map, uv).rgb;
    vec3 highlight_rgb = mat.highlight_color.rgb;
    if (mat.highlight_params.z >= 0.5 && mat.highlight_params.w > 0.0)
        highlight_rgb *= texture_sample(highlight_map, mat.highlight_map, uv).rgb;

    // blush and nervous tints, on every tone
    vec3 tint = vec3(1.0);
    if (mat.blush_params.x > 0.0)
        tint *= mix(vec3(1.0), mat.blush_color.rgb,
                    texture_sample(blush_mask, mat.blush_mask, uv).r * mat.blush_params.x);
    if (mat.blush_params.y > 0.0)
        tint *= mix(vec3(1.0), mat.nervous_color.rgb,
                    texture_sample(nervous_mask, mat.nervous_mask, uv).r * mat.blush_params.y);
    lit *= tint;
    shade *= tint;
    highlight_rgb *= tint;

    // sparkle: a decal over the lit and the shade tones, so it shows in shadow too
    if (mat.star_teary_params.x > 0.0) {
        vec4 decal = texture_sample(star_eyes_mask, mat.star_eyes_mask, uv);
        float cover = decal.a * mat.star_teary_params.x;
        vec3 decal_rgb = decal.rgb * mat.star_eyes_tint.rgb;
        lit = mix(lit, decal_rgb, cover);
        shade = mix(shade, decal_rgb, cover);
    }

    // surface normal; back faces of double-sided materials face the viewer
    vec3 bump = unpack_normal_bc5(texture_sample(normal_map, mat.normal_map, uv).rg);
    bump.xy *= mat.gi_params.z;
    vec3 N = apply_normal_map(v_normal, v_tangent, v_bitangent_sign, bump);
    if (!gl_FrontFacing)
        N = -N;

    // the normal the ramp uses: toward the head sphere where face shading is on
    vec3 ramp_n = N;
    float face_amount = mat.face_params.w;
    if (face_amount > 0.0) {
        vec3 sphere_n = normalize(mat3(v_model_c0, v_model_c1, v_model_c2) * v_smooth_normal);
        float where = texture_sample(face_mask_map, mat.face_mask_map, uv).r;
        ramp_n = normalize(mix(N, sphere_n, face_amount * where));
    }

    float shift = toon_shift(mat, uv);
    float toony = mat.toon.y;
    float cast_shadow = mix(1.0, hz_shadow(v_world_pos), mat.shadow_strength);

    // direct light; `received` sums the light falling here, which the rim
    // follows by rim_color.a
    vec3 color = vec3(0.0);
    vec3 received = vec3(0.0);
    uint sun_count = min(hz_scene.lights.directional_count, 4u);
    for (uint s = 0u; s < sun_count; ++s) {
        DirectionalLight sun = hz_scene.lights.directional[s];
        vec3 radiance = sun.color * sun.intensity;
        float n_dot_l = clamp(dot(ramp_n, normalize(-sun.direction)), -1.0, 1.0);
        // only the first light casts the shadow map; the others are fills
        float visible = s == 0u ? cast_shadow : 1.0;
        color += toon_light(lit, shade, highlight_rgb, toon_lit_main(n_dot_l, shift, toony) * visible,
                            toon_highlight(n_dot_l, mat) * visible, radiance);
        received += radiance * visible;
    }
    HZ_CLUSTER_LOOP_BEGIN(v_view_depth)
        vec3 to_point = light.position - v_world_pos;
        float reach = length(to_point);
        if (reach < light.radius) {
            vec3 radiance = light.color * light.intensity;
            float falloff = point_light_attenuation(reach, light.radius);
            float n_dot_l = clamp(dot(ramp_n, to_point / reach), -1.0, 1.0);
            // no shadow map for point lights: back faces darken by half-Lambert
            float dim = falloff * 0.5 * (1.0 + min(n_dot_l, 0.0));
            color += dim * toon_light(lit, shade, highlight_rgb, toon_lit_point(n_dot_l, shift, toony),
                                      toon_highlight(n_dot_l, mat), radiance);
            received += radiance * falloff;
        }
    HZ_CLUSTER_LOOP_END

    // ambient: the sky's diffuse light plus the scene ambient, blended toward
    // its up/down average by the GI equalization factor
    vec3 scene_ambient = hz_scene.lights.ambient * hz_scene.lights.ambient_intensity;
    vec3 sky_here = toon_sky(N);
    vec3 sky_even = 0.5 * (toon_sky(vec3(0.0, 1.0, 0.0)) + toon_sky(vec3(0.0, -1.0, 0.0)));
    vec3 ambient = scene_ambient + mix(sky_here, sky_even, mat.gi_params.x);
    color += lit * ambient;
    received += ambient;

    // rim: a fresnel edge plus the matcap, masked by the rim map (and the
    // vertex color, if the material asks), following the received light
    vec3 V = normalize(hz_scene.camera_pos - v_world_pos);
    float edge = clamp(1.0 - dot(N, V) + mat.toon.w, 0.0, 1.0);
    vec3 rim = mat.rim_color.rgb * pow(edge, max(mat.toon.z, 9.765625e-4));
    // the matcap is looked up by the normal in a frame built from the view
    // direction and world up
    // looking straight up or down, any sideways axis will do
    vec3 side = cross(V, vec3(0.0, 1.0, 0.0));
    vec3 frame_x = dot(side, side) > 1e-12 ? normalize(side) : vec3(1.0, 0.0, 0.0);
    vec3 frame_y = normalize(cross(frame_x, V));
    vec2 matcap_uv = 0.5 + 0.5 * vec2(dot(frame_x, N), dot(frame_y, N));
    rim += mat.matcap_color.rgb * texture_sample(matcap_map, mat.matcap_map, matcap_uv).rgb;
    rim *= texture_sample(rim_map, mat.rim_map, uv).rgb;
    if (mat.gi_params.w > 0.0)
        rim *= v_vcolor_r;
    color += rim * mix(vec3(1.0), received, mat.rim_color.a);

    color += mat.emissive.rgb * mat.emissive.a * texture_sample(emissive_map, mat.emissive_map, uv).rgb *
             hz_scene.pre_exposure;

    color = toon_fog(color, v_view_depth);
    float alpha = base.a;
#ifdef MTOON_OVER_HAIR
    // drawn over the hair at its opacity, fading out as the face turns away
    alpha *= mat.over_hair_params.y * smoothstep(mat.over_hair_params.z, max(mat.over_hair_params.w, mat.over_hair_params.z + 1e-4), dot(N, V));
#endif
    HzSurface surface = hz_surface_default();
    surface.normal = N;
    hz_output_lit(vec4(color, alpha), surface, HZ_VELOCITY(v_clip_cur, v_clip_prev));
}
@end
