// EyeMouth shader: unlit overlay for eyes + mouth tile
export const eyeMouthVertSrc = `
precision highp float;
#include <common>
#include <skinning_pars_vertex>
varying vec2 vUv;
varying vec3 vMouthPosition;

void main() {
    vUv = uv;
    vMouthPosition = position;
    #include <skinbase_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}
`;

export const eyeMouthFragSrc = `
precision highp float;
varying vec2 vUv;
varying vec3 vMouthPosition;

uniform sampler2D u_MainTex;
uniform bool u_HasMainTex;
uniform vec4 u_Tint;
uniform vec4 u_CodeMultiplyColor;
uniform vec4 u_CodeAddColor;

uniform sampler2D u_MouthTileTex;
uniform bool u_HasMouthTileTex;
uniform bool u_MouthFlipX;
uniform vec2 u_MouthUVMin;
uniform vec2 u_MouthUVMax;
uniform vec2 u_MouthSampleUVMin;
uniform vec2 u_MouthSampleUVMax;
uniform bool u_MouthUsePositionSample;
uniform vec3 u_MouthPositionMin;
uniform vec3 u_MouthPositionMax;

void main() {
    vec4 tex = u_HasMainTex ? texture2D(u_MainTex, vUv) : vec4(0.0);

    // Mouth region: remap to [0,1] preserving aspect ratio
    if (u_HasMouthTileTex
        && vUv.y >= u_MouthUVMin.y && vUv.y <= u_MouthUVMax.y
        && vUv.x >= u_MouthUVMin.x && vUv.x <= u_MouthUVMax.x) {
        vec2 sampleCoord = vUv;
        vec2 sampleMin = u_MouthSampleUVMin;
        vec2 sampleMax = u_MouthSampleUVMax;
        if (u_MouthUsePositionSample) {
            sampleCoord = vMouthPosition.xz;
            sampleMin = u_MouthPositionMin.xz;
            sampleMax = u_MouthPositionMax.xz;
        }
        vec2 uvSize = sampleMax - sampleMin;
        vec2 center = (sampleMin + sampleMax) * 0.5;

        // Map to square using larger dimension, centered
        float maxDim = max(uvSize.x, uvSize.y);
        vec2 squareMin = center - maxDim * 0.5;
        vec2 squareUV = (sampleCoord - squareMin) / maxDim;
        if (u_MouthUsePositionSample) squareUV.y = 1.0 - squareUV.y;

        // SetHorizontallyFlippedMouthTile events flip the tile horizontally
        // around its centre while preserving the rest of the EyeMouth UV.
        if (u_MouthFlipX) squareUV.x = 1.0 - squareUV.x;

        if (squareUV.x >= 0.0 && squareUV.x <= 1.0 && squareUV.y >= 0.0 && squareUV.y <= 1.0) {
            vec4 mouthTex = texture2D(u_MouthTileTex, squareUV);
            if (mouthTex.a > 0.5) {
                tex = mouthTex;
            } else {
                // Transparent tile area: discard to show Face mesh below
                discard;
            }
        } else {
            discard;
        }
    }

    vec3 color = tex.rgb * u_Tint.rgb;
    color *= u_CodeMultiplyColor.rgb;
    color += u_CodeAddColor.rgb;
    if (tex.a < 0.01) discard;
    gl_FragColor = vec4(color, tex.a);
}
`;
