export const outlineVertSrc = `
precision highp float;
#include <common>
#include <skinning_pars_vertex>
uniform float u_OutlineThickness;
uniform float u_OutlineZCorrection;
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
    vUv = uv;
    #include <skinbase_vertex>
    #include <beginnormal_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>

    vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);

    vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
    vec3 clipNormal = normalize((projectionMatrix * modelViewMatrix * vec4(objectNormal, 0.0)).xyz);
    clipPos.xy += clipNormal.xy * u_OutlineThickness * clipPos.w * 2.0;
    clipPos.z += u_OutlineZCorrection;
    gl_Position = clipPos;
}
`;

export const outlineFragSrc = `
precision highp float;
uniform vec4 u_OutlineTint;
uniform sampler2D u_MainTex;
uniform bool u_HasMainTex;
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
    // Game: outline color = grayscale(mainTex * outlineTint * mainLightColor)
    vec3 baseColor = u_HasMainTex ? texture2D(u_MainTex, vUv).rgb : vec3(0.5);
    vec3 tinted = baseColor * u_OutlineTint.rgb;
    float gray = dot(tinted, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor = vec4(vec3(gray), 1.0);
}
`;
