#include "renderer.glsl"

// The outline of a VRM toon material: back faces of a copy of the body, pushed
// out along the normal by a width measured on screen, and colored by MToon's
// outline rule, outline color blended toward the shaded body color by the
// lighting mix. It shades the surface like mtoon.glsl to get that color.
// The outline width and lighting follow MToon 1.0 as published in UniVRM (MIT
// licence: Copyright (c) 2020 VRM Consortium, Copyright (c) 2018 Masataka SUMI
// for MToon).

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
    // the head-sphere normal for face shading, as in mtoon.glsl (material
    // words 32..34 hold the sphere's center)
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
    v_world_pos = position_ws.xyz;
    v_normal = normalize((v.model * vec4(v.normal, 0.0)).xyz);
    v_tangent = normalize((v.model * vec4(v.tangent, 0.0)).xyz);
    v_bitangent_sign = v.bitangent_sign;
    v_uv = v.uv;
    v_material_offset = v.material_offset;
    v_view_depth = -(hz_scene.view * position_ws).z;

    // width from outline_params (material words 44..47): .x the width, .w
    // whether vertex color red scales it
    float width = uintBitsToFloat(hz_materials.data[v.material_offset + 44u]);
    if (uintBitsToFloat(hz_materials.data[v.material_offset + 47u]) > 0.0)
        width *= v.color.r;
    // the projection's x and y scale: the length of the first three entries of
    // view_proj's first and second rows (the view part is a pure rotation)
    float scale_x = length(vec3(hz_scene.view_proj[0][0], hz_scene.view_proj[1][0], hz_scene.view_proj[2][0]));
    float scale_y = length(vec3(hz_scene.view_proj[0][1], hz_scene.view_proj[1][1], hz_scene.view_proj[2][1]));
    vec4 clip = hz_instance_clip(v, position_ws);
    vec2 normal_cs = (hz_scene.view_proj * vec4(v_normal, 0.0)).xy;
    vec2 push_dir = dot(normal_cs, normal_cs) > 1e-12 ? normalize(normal_cs) : vec2(0.0);
    float facing_z = normalize((hz_scene.view * vec4(v_normal, 0.0)).xyz).z;
    // a constant width on screen, capped with distance, corrected for aspect,
    // and thinner where the normal points at the camera
    vec2 shift = push_dir * (2.0 * width * min(clip.w, scale_y));
    shift.x *= scale_x / scale_y;
    clip.xy += shift * clamp(1.0 - facing_z * facing_z, 0.0, 1.0);
    gl_Position = clip;

#ifdef HZ_RENDERER_GBUFFER
    // motion vectors from the surface point before the push: the push barely
    // changes between frames, so it drops out of the difference
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
// the sky light and fog, on the web too: with the shadows (2) and this
// material's 8 maps they take 15 of WebGPU's 16 textures per stage
#define HZ_RENDERER_IBL
#define HZ_RENDERER_FOG
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
// the renderer's extra targets when it asks for them, as in mtoon.glsl
#ifdef HZ_RENDERER_GBUFFER
in vec4 v_clip_cur;
in vec4 v_clip_prev;
#endif

// The start of mtoon.glsl's material, field for field, as plain vec4s: the
// outline reads the body material's slice, so the order must match exactly.
@material
struct MaterialFS {
    vec4 lit_color;
    vec4 shade_color;
    vec4 rim_color;
    vec4 emissive;
    vec4 matcap_color;
    vec4 toon;
    vec4 highlight_color;
    vec4 highlight_params;
    vec4 face_params;
    vec4 gi_params;
    vec4 outline_color;
    vec4 outline_params;  // width, lighting mix, mode, vertex mask
    float alpha_cutoff;
    float shadow_strength;
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

// the toon ramp helpers, as in mtoon.glsl
float toon_step(float a, float b, float x) {
    return clamp((x - a) / max(b - a, 1e-4), 0.0, 1.0);
}
float toon_shift(MaterialFS mat, vec2 uv) {
    return mat.toon.x + mat.gi_params.y * texture_sample(shading_shift_map, mat.shading_shift_map, uv).r;
}
float toon_lit_main(float n_dot_l, float shift, float toony) {
    float half_lambert = toon_step(-1.0, 1.0, n_dot_l) * 2.0 - 1.0;
    return toon_step(toony - 1.0, 1.0 - toony, half_lambert + shift);
}
float toon_lit_point(float n_dot_l, float shift, float toony) {
    return toon_step(toony - 1.0, 1.0 - toony, n_dot_l + shift);
}
// the highlight tone's amount; unlike the main pass, the outline keys it on
// toony alone, so a zero toony (no highlight authored) means off
float toon_highlight(float n_dot_l, MaterialFS mat) {
    float softness = mat.highlight_params.y;
    if (softness <= 0.0)
        return 0.0;
    float half_lambert = toon_step(-1.0, 1.0, n_dot_l) * 2.0 - 1.0;
    return toon_step(softness - 1.0, 1.0 - softness, half_lambert + mat.highlight_params.x);
}
vec3 toon_light(vec3 lit, vec3 shade, vec3 highlight_rgb, float lit_amount,
                float highlight, vec3 radiance) {
    vec3 surface = mix(mix(shade, lit, lit_amount), highlight_rgb, highlight);
    return surface * radiance;
}

void main() {
    MaterialFS mat = MaterialFS_unpack(v_material_offset);

    vec4 base = mat.lit_color * texture_sample(map, mat.map, v_uv);
    if (base.a < mat.alpha_cutoff)
        discard;
    vec3 lit = base.rgb;
    vec3 shade = mat.shade_color.rgb * texture_sample(shade_map, mat.shade_map, v_uv).rgb;
    vec3 highlight_rgb = mat.highlight_color.rgb;

    // these are back faces, but the normal stays outward so the outline takes
    // the color of the lit front
    vec3 bump = unpack_normal_bc5(texture_sample(normal_map, mat.normal_map, v_uv).rg);
    bump.xy *= mat.gi_params.z;
    vec3 N = apply_normal_map(v_normal, v_tangent, v_bitangent_sign, bump);

    vec3 ramp_n = N;
    float face_amount = mat.face_params.w;
    if (face_amount > 0.0) {
        vec3 sphere_n = normalize(mat3(v_model_c0, v_model_c1, v_model_c2) * v_smooth_normal);
        float where = texture_sample(face_mask_map, mat.face_mask_map, v_uv).r;
        ramp_n = normalize(mix(N, sphere_n, face_amount * where));
    }

    float shift = toon_shift(mat, v_uv);
    float toony = mat.toon.y;
    float cast_shadow = mix(1.0, hz_shadow(v_world_pos), mat.shadow_strength);

    // the body's shaded color, as mtoon.glsl computes it
    vec3 color = vec3(0.0);
    vec3 received = vec3(0.0);
    uint sun_count = min(hz_scene.lights.directional_count, 4u);
    for (uint s = 0u; s < sun_count; ++s) {
        DirectionalLight sun = hz_scene.lights.directional[s];
        vec3 radiance = sun.color * sun.intensity;
        float n_dot_l = clamp(dot(ramp_n, normalize(-sun.direction)), -1.0, 1.0);
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
            float dim = falloff * 0.5 * (1.0 + min(n_dot_l, 0.0));
            color += dim * toon_light(lit, shade, highlight_rgb, toon_lit_point(n_dot_l, shift, toony),
                                      toon_highlight(n_dot_l, mat), radiance);
            received += radiance * falloff;
        }
    HZ_CLUSTER_LOOP_END

    vec3 scene_ambient = hz_scene.lights.ambient * hz_scene.lights.ambient_intensity;
    vec3 sky_here = toon_sky(N);
    vec3 sky_even = 0.5 * (toon_sky(vec3(0.0, 1.0, 0.0)) + toon_sky(vec3(0.0, -1.0, 0.0)));
    vec3 ambient = scene_ambient + mix(sky_here, sky_even, mat.gi_params.x);
    color += lit * ambient;
    received += ambient;

    vec3 V = normalize(hz_scene.camera_pos - v_world_pos);
    float edge = clamp(1.0 - dot(N, V) + mat.toon.w, 0.0, 1.0);
    vec3 rim = mat.rim_color.rgb * pow(edge, max(mat.toon.z, 9.765625e-4));
    // looking straight up or down, any sideways axis will do
    vec3 side = cross(V, vec3(0.0, 1.0, 0.0));
    vec3 frame_x = dot(side, side) > 1e-12 ? normalize(side) : vec3(1.0, 0.0, 0.0);
    vec3 frame_y = normalize(cross(frame_x, V));
    vec2 matcap_uv = 0.5 + 0.5 * vec2(dot(frame_x, N), dot(frame_y, N));
    rim += mat.matcap_color.rgb * texture_sample(matcap_map, mat.matcap_map, matcap_uv).rgb;
    rim *= texture_sample(rim_map, mat.rim_map, v_uv).rgb;
    if (mat.gi_params.w > 0.0)
        rim *= v_vcolor_r;
    color += rim * mix(vec3(1.0), received, mat.rim_color.a);

    color += mat.emissive.rgb * mat.emissive.a * texture_sample(emissive_map, mat.emissive_map, v_uv).rgb *
             hz_scene.pre_exposure;

    // the outline color, blended toward the body color by the lighting mix
    vec3 outline = toon_fog(mat.outline_color.rgb * mix(vec3(1.0), color, mat.outline_params.y),
                            v_view_depth);
    HzSurface surface = hz_surface_default();
    surface.normal = N;
    hz_output_lit(vec4(outline, base.a), surface, HZ_VELOCITY(v_clip_cur, v_clip_prev));
}
@end
