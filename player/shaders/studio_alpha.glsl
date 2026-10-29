#include "common.glsl"

@vs
layout(location = 0) out vec2 v_uv;
void main() {
    v_uv = fullscreen_triangle_uv(uint(gl_VertexIndex));
    gl_Position = fullscreen_triangle_pos(v_uv, 0.0);
}
@end

@fs
layout(set = 1, binding = 0) uniform texture2D displayTexture;
layout(set = 1, binding = 1) uniform sampler displaySampler;
@depth
layout(set = 1, binding = 2) uniform texture2D sceneTexture;
@nearest
layout(set = 1, binding = 3) uniform sampler sceneSampler;
layout(location = 0) in vec2 v_uv;
layout(location = 0) out vec4 frag_color;
void main() {
    vec3 color = texture(sampler2D(displayTexture, displaySampler), v_uv).rgb;
    float depth = texture(sampler2D(sceneTexture, sceneSampler), v_uv).r;
    float alpha = step(0.000001, depth);
    frag_color = vec4(color, clamp(alpha, 0.0, 1.0));
}
@end
