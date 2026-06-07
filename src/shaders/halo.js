export const haloVertSrc = `
precision highp float;
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const haloFragSrc = `
precision highp float;
varying vec2 vUv;
uniform sampler2D u_MainTex;
uniform bool u_HasMainTex;
uniform vec4 u_Tint;
uniform float u_GlowStrength;
uniform bool u_UseGlowMask;
uniform vec4 u_GlowMaskColor;
uniform vec4 u_GlowTint;
uniform float u_GlowStrictness;
uniform float u_Time;
uniform vec2 u_UvScroll;
uniform float u_PulseSpeed;
uniform float u_PulseStrength;

// Ramp blend: sample two Y positions and lerp
uniform bool u_UseRamp;
uniform float u_FromHaloIndex;
uniform float u_ToHaloIndex;
uniform float u_BlendRatio;

void main() {
    vec2 animatedUv = vUv + u_UvScroll * u_Time;
    if (abs(u_UvScroll.x) + abs(u_UvScroll.y) > 0.0001) {
        animatedUv = fract(animatedUv);
    }
    vec4 texColor = vec4(1.0);

    if (u_HasMainTex) {
        if (u_UseRamp) {
            vec2 uvFrom = vec2(animatedUv.x, u_FromHaloIndex);
            vec2 uvTo = vec2(animatedUv.x, u_ToHaloIndex);
            vec4 texFrom = texture2D(u_MainTex, uvFrom);
            vec4 texTo = texture2D(u_MainTex, uvTo);
            texColor = mix(texFrom, texTo, u_BlendRatio);
        } else {
            texColor = texture2D(u_MainTex, animatedUv);
        }
    }

    float pulse = 1.0 + sin(u_Time * u_PulseSpeed) * u_PulseStrength;
    vec3 color = texColor.rgb;
    float alpha = texColor.a;

    color *= u_Tint.rgb * pulse;
    if (u_UseGlowMask) {
        // _GlowStrictness0 in BA's MX/C-Halo/UnlitTexturedPotal property has
        // display name "Glow Mask Tolerance" with Range(30, 0.34); higher value
        // = stricter match. Interpreting it as inverse tolerance: real tolerance
        // distance = 1/strictness. With CH0069_Halo strictness=12.8 this gives
        // ~0.078 — enough to catch the pink (R≈1, G≈0.86, B≈1) pixels near
        // _GlowMaskColor0 (0.996, 0.875, 0.996) while excluding the blue side of
        // the ramp (distance ~0.22). Old formula (30 - x)/30 had it at 0.57
        // which let the blue half of the ramp also pick up pink glow.
        float tolerance = clamp(1.0 / max(u_GlowStrictness, 0.01), 0.02, 0.8);
        float mask = 1.0 - smoothstep(0.0, tolerance, distance(texColor.rgb, u_GlowMaskColor.rgb));
        color += u_GlowTint.rgb * u_GlowStrength * mask * alpha;
    } else {
        color *= u_GlowStrength;
    }
    alpha *= u_Tint.a;

    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color, alpha);
}
`;
