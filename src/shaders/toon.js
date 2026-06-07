// Toon character shader.
//
// Reverse-engineered from MX/C-General/Layer4-Inline DXBC
// (`extracted_shaders/dxbc/MX_C-General_Layer4-Inline/seg0_unknown_chunk47_5404bytes.asm`)
// and its sister body shaders (SingleInline, Hair-Transparent, Face-Cutin).
//
//
// VS exports (must mirror model's body VS):
//   vUv             — UV (o1.xy)
//   vSHAmbient      — URP per-vertex SH ambient (o2.xyz). Replaces missing SH.
//   vFog            — fog factor (o2.w).
//   vNormal         — world normal (o3.xyz).
//   vRimMask        — vertex colour alpha (o3.w). Painted rim mask.
//   vViewDir        — world surface→camera (o4.xyz).
//   vWorldPos       — world position (o7.xyz). Used by point rim light.
//   vLitTone        — _MxCharLightTone * _ShadowTint (o5.xyz). Lit-side colour.
//   vThreshold      — _ShadowThreshold + (1-_MxCharLightData.y)*0.15 (o5.w).
//   vNdotL, vNdotV  — convenience scalars (re-derived from vNormal in PS for
//                     two-side handling, but vNdotL is also used to early-out
//                     view light gating).

export const toonVertSrc = /* glsl */`
precision highp float;
#include <common>
#include <skinning_pars_vertex>

attribute vec4 tangent;

uniform vec3 u_MxCharLightDir;
uniform vec4 u_MxCharLightTone;
uniform vec3 u_ShadowTint;            // material _ShadowTint (or layer-weighted)
uniform float u_MxCharLightDataY;     // (maxC + minC) / 2 of light colour
uniform float u_ShadowThreshold;      // material _ShadowThreshold (single-layer)

// URP-style SH9 coefficients packed into 7 vec4s (matches cb1[25..31] layout).
// uSHAr/g/b carry the linear (L1) coefficients; uSHC carries the quadratic
// (L2) terms; uSHA + uSHB give the constant (L0). When the host doesn't fill
// these, they default to small ambient grey via DEFAULT_UNIFORMS.
uniform vec4 u_SHAr;
uniform vec4 u_SHAg;
uniform vec4 u_SHAb;
uniform vec4 u_SHBr;
uniform vec4 u_SHBg;
uniform vec4 u_SHBb;
uniform vec4 u_SHC;

varying vec2 vUv;
varying vec3 vSHAmbient;
varying float vFog;
varying vec3 vNormal;
varying float vRimMask;
varying vec3 vViewDir;
varying vec3 vWorldPos;
varying vec3 vLitTone;
varying float vThreshold;
varying vec3 vTangent;
varying vec3 vBitangent;

// URP SampleSH9: evaluates the L0+L1+L2 SH probe for a unit world normal.
// Mirrors cb1[25..31] dot products in the body VS (lines 64-72).
vec3 sampleSH9(vec3 n) {
    // L0 + L1 (uSHAr/g/b are the linear bands rotated to world space)
    vec4 normalAug = vec4(n, 1.0);
    vec3 x1 = vec3(dot(u_SHAr, normalAug), dot(u_SHAg, normalAug), dot(u_SHAb, normalAug));

    // Quadratic bands (uSHBr/g/b drive nyzz/nxyy etc., uSHC drives nx²-ny²)
    vec4 nQuad = vec4(n.x * n.y, n.y * n.z, n.z * n.z, n.x * n.z);
    vec3 x2 = vec3(dot(u_SHBr, nQuad), dot(u_SHBg, nQuad), dot(u_SHBb, nQuad));
    float final = (n.x * n.x - n.y * n.y) * u_SHC.x;
    return x1 + x2 + vec3(final);
}

void main() {
    vUv = uv;

    #include <skinbase_vertex>
    #include <beginnormal_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>

    vec3 objectTangent = tangent.xyz;
    #ifdef USE_SKINNING
        objectTangent = mat3(skinMatrix) * objectTangent;
    #endif

    vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
    vWorldPos = worldPos.xyz;

    vec3 worldNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
    vNormal = worldNormal;

    vTangent = normalize((modelMatrix * vec4(objectTangent, 0.0)).xyz);
    vBitangent = cross(vNormal, vTangent) * tangent.w;

    vViewDir = normalize(cameraPosition - worldPos.xyz);

    // SH ambient (URP cb1[25..31]). Match DXBC max/renorm at body VS lines
    // 75-80: clamp negatives, then if luminance < 0.3, soft-renormalize so
    // baseline ambient never fully blacks out shaded mid-tones.
    vec3 sh = max(sampleSH9(worldNormal), vec3(0.0));
    float lum = max(sh.x + sh.y + sh.z, 0.3);
    sh *= (0.3 / lum);
    vSHAmbient = sh;

    // Per-vertex lit colour: _MxCharLightTone * _ShadowTint. PS later blends
    // toward _MxCharShadowTone in shadow.
    vLitTone = u_MxCharLightTone.rgb * u_ShadowTint;

    // Threshold = _ShadowThreshold + (1 - lightData.y) * 0.15. For Echelon
    // white light this evaluates to _ShadowThreshold exactly.
    vThreshold = u_ShadowThreshold + (1.0 - u_MxCharLightDataY) * 0.15;

    // Vertex-colour alpha (rim mask). three.js doesn't expose vertex colour by
    // default unless USE_COLOR is defined. We use the convention that meshes
    // without authored vertex colour get rim mask = 1.0.
    #ifdef USE_COLOR
        vRimMask = color.w;
    #else
        vRimMask = 1.0;
    #endif

    vFog = 0.0; // host scene drives this if needed

    gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

export const toonFragSrc = /* glsl */`
precision highp float;

varying vec2 vUv;
varying vec3 vSHAmbient;
varying float vFog;
varying vec3 vNormal;
varying float vRimMask;
varying vec3 vViewDir;
varying vec3 vWorldPos;
varying vec3 vLitTone;
varying float vThreshold;
varying vec3 vTangent;
varying vec3 vBitangent;

// ─── Global lighting ───
uniform vec3 u_MxCharLightDir;
uniform vec4 u_MxCharLightTone;       // PS uses for view-light blends only
uniform vec4 u_MxCharShadowTone;      // dark-side colour
uniform vec4 u_MxCharLightData;       // x = maxC*0.85+0.15, y = (max+min)/2
uniform vec3 u_FogColor;

// ─── Textures ───
uniform sampler2D u_MainTex;
uniform sampler2D u_MaskTex;
uniform sampler2D u_HairSpecTex;
uniform bool u_HasMainTex;
uniform bool u_HasMaskTex;
uniform bool u_HasHairSpecTex;

// ─── Material props ───
uniform vec4 u_Tint;
uniform float u_Cutoff;

// Layer4 (per-channel via mask alpha cross-fade)
uniform vec4 u_ShadowThreshold4;
uniform vec4 u_ShadowTintR4;
uniform vec4 u_ShadowTintG4;
uniform vec4 u_ShadowTintB4;
uniform vec4 u_BaseBrightness4;
uniform vec4 u_RimAreaMultiplier4;
uniform vec4 u_RimStrength4;
uniform vec4 u_ViewOffset4;
uniform vec4 u_ViewPower4;
uniform vec4 u_ViewStrength4;
uniform vec4 u_InvViewPower4;
uniform vec4 u_InvViewStrength4;
uniform vec4 u_ViewLightEdge4;
uniform bool u_UseLayer4;

// Single-layer fallbacks
uniform float u_ShadowThreshold;
uniform float u_RimAreaLeveler;
uniform float u_RimAreaMultiplier;
uniform float u_RimStrength;
uniform float u_BaseBrightness;
uniform float u_ViewOffset;
uniform float u_ViewPower;
uniform float u_ViewStrength;
uniform float u_InvViewPower;
uniform float u_InvViewStrength;
uniform float u_ViewLightEdge;

uniform float u_MaskGSensitivity;

// Glow / specular
uniform vec4 u_GlowTint;
uniform float u_GlowStrength;
uniform float u_GlowPower;

// Hair anisotropic specular
uniform vec3 u_SpecDirMultiplier;
uniform float u_SpecTopMultiplier;
uniform float u_SpecTopLeveler;
uniform float u_SpecBotArea;
uniform float u_SpecBotMultiplier;
uniform float u_SpecStrength;
uniform float u_AdjustiveHairShadow;

// Shadow sharpness (-10 body, -20 hair, material-driven for face)
uniform float u_ShadowSharpness;

// Face shader mode
uniform bool u_IsFaceShader;
uniform vec3 u_ShadowLightDir;
uniform float u_AdjustiveFaceShadow;
uniform float u_FaceShadowTintAlpha;     // _ShadowTint.w used in mask.r blend

// Inline silhouette
uniform vec4 u_InlineTint;
uniform float u_InlineAmount;

// Rim point light (existing extension)
uniform vec3 u_RimLightPos;
uniform float u_RimLightRange;
uniform vec4 u_RimLightColor;

// Code grading
uniform vec4 u_CodeAddColor;
uniform vec4 u_CodeMultiplyColor;
uniform vec4 u_CodeAddRimColor;
uniform float u_GrayBrightness;

// Effects
uniform float u_DitherThreshold;

// Main-light gate. Runtime defaults to shadow-only: albedo/tint plus the DXBC
// shadow gate, without view light, rim, glow, or hair spec.
uniform bool u_MainLightEnabled;
uniform bool u_ShadowOnlyEnabled;
uniform bool u_BodyShadowEnabled;

// Layer-mask cross-fade (DXBC body PS lines 61-65). mask.a sits at quantised
// 0/0.25/0.5/0.75/1 with linear cross-fade across the steps.
vec4 layerWeightsFromMaskAlpha(float a) {
    vec3 d = vec3(a) - vec3(0.25, 0.50, 0.75);
    vec3 floors = floor(d);
    vec3 fracs = ceil(d);
    vec4 w;
    w.x =  -floors.x;
    w.yz = -floors.yz * fracs.xy;
    w.w  =  fracs.z;
    return w;
}

float pickLayerFloat(vec4 v, vec4 w) { return dot(v, w); }
vec3 pickLayerColor(vec4 r, vec4 g, vec4 b, vec4 w) {
    return vec3(dot(r, w), dot(g, w), dot(b, w));
}

void main() {
    // ─── Dither (line-based fade for cutscene transitions) ───
    if (u_DitherThreshold > 0.001) {
        float line = mod(gl_FragCoord.y, 4.0) / 4.0;
        if (line < u_DitherThreshold) discard;
    }

    // ─── Albedo ───
    vec4 albedo = u_HasMainTex ? texture2D(u_MainTex, vUv) : vec4(0.82, 0.80, 0.76, 1.0);
    albedo *= u_Tint;
    if (albedo.a < u_Cutoff) discard;

    if (!u_MainLightEnabled && !u_ShadowOnlyEnabled) {
        gl_FragColor = vec4(albedo.rgb, albedo.a);
        return;
    }

    vec4 mask = u_HasMaskTex ? texture2D(u_MaskTex, vUv) : vec4(0.0, 0.5, 0.0, 0.0);

    float faceSign = gl_FrontFacing ? 1.0 : -1.0;
    vec3 N = normalize(vNormal) * faceSign;
    vec3 V = normalize(vViewDir);
    float NdotL = dot(N, normalize(u_MxCharLightDir));
    // DXBC fresnel and shadow_input both use the raw NdotV without
    // clamping — back_lit fragments have a negative NdotV which lifts
    // fresnel above 1.0 (and pushes shadow_input strongly negative,
    // saturating shadow to 1).
    float NdotV = dot(N, V);
    float NdotVClamped = max(NdotV, 0.0);
    float fresnel = 1.0 - NdotV;

    // ─── Layer weights (only when Layer4 active) ───
    vec4 layerW = (u_UseLayer4 && u_HasMaskTex)
        ? layerWeightsFromMaskAlpha(mask.a)
        : vec4(1.0, 0.0, 0.0, 0.0);

    // ─── Shadow ───
    float threshold;
    float shadow;
    float shadowInput = 0.0;

    if (u_IsFaceShader) {
        // Face shadow gate is normal-independent — the DXBC asm chain
        // (chunk 46 lines 84-88) collapses to:
        //   shadowInput = -adjustedMask * _AdjustiveFaceShadow - threshold
        // The _ShadowLightDir slot drives the additional-light loop,
        // not the primary shadow gate. Verified 2026-05-21 on
        // CH0069_Cutin_Face — the earlier + faceNdotL term flipped
        // back-lit fragments to lit instead of holding them dark.
        float maskR_remap = u_HasMaskTex ? (mask.g * 2.0 - 1.0) : 0.0;
        float adjustedMask = u_HasMaskTex
            ? (-mask.r * u_FaceShadowTintAlpha + maskR_remap)
            : 0.0;
        threshold = vThreshold;
        shadowInput = -adjustedMask * u_AdjustiveFaceShadow - threshold;
        shadow = clamp(shadowInput * u_ShadowSharpness, 0.0, 1.0);
    } else {
        // Layer4 quirk (verified 2026-05-21 via DXBC sweep on CH0076 /
        // CH0082 / CH0170): the slot Game names _ShadowThreshold4 is
        // read by the rim-window code path (cb3[5] → r8.x), while the
        // actual shadow gate reads _RimStrength4 (cb3[13] → r3.w). The
        // property names mislead — the real threshold per layer is the
        // _RimStrength4 dp4. Single-layer body still uses the VS-built
        // vThreshold. See doc/shader-rewrite-plan.md Bug A.
        threshold = u_UseLayer4 ? pickLayerFloat(u_RimStrength4, layerW) : vThreshold;
        float maskG_remap = u_HasMaskTex ? (-mask.g * 2.0 + 1.0) : 0.0;
        float adjustedMask = maskG_remap;
        if (u_HasHairSpecTex) {
            adjustedMask += mask.r * u_AdjustiveHairShadow;
        }
        shadowInput = NdotV * 0.77 + NdotL + adjustedMask * u_MaskGSensitivity - threshold;
        shadow = clamp(shadowInput * u_ShadowSharpness, 0.0, 1.0);
    }
    if (!u_BodyShadowEnabled && !u_IsFaceShader && !u_HasHairSpecTex) {
        shadow = 0.0;
    }

    // ─── Lit/shadow colour blend ───
    // DXBC body PS:81-82 — lerp(shadowTone, layerTint*lightTone, shadow)
    // Game's *_MxCharShadowTone* is actually the **lit-side** colour, and
    // *_MxCharLightTone * shadowTint* is the **dark-side** colour. The naming
    // is inverted in the source. Confirmed by mul_sat r0.w, *, l(-10.0) on
    // shadowInput: positive shadowInput (lit) saturates to 0 → outputs
    // shadowTone (the lit colour). See doc/shader-truth.md §2.4 + this fix.
    vec3 layerShadowTint = u_UseLayer4
        ? pickLayerColor(u_ShadowTintR4, u_ShadowTintG4, u_ShadowTintB4, layerW)
        : vec3(1.0);

    vec3 litSide  = u_MxCharShadowTone.rgb;
    vec3 darkSide = u_UseLayer4
        ? (u_MxCharLightTone.rgb * layerShadowTint)
        : vLitTone;

    if (!u_MainLightEnabled) {
        vec3 shadowMul = mix(vec3(1.0), darkSide, shadow);
        gl_FragColor = vec4(albedo.rgb * shadowMul, albedo.a);
        return;
    }

    vec3 baseColor = mix(litSide, darkSide, shadow);

    // SH ambient + lightData scale (DXBC line 83).
    baseColor = baseColor * u_MxCharLightData.x + vSHAmbient;

    // Base brightness boost (per-layer in Layer4)
    float baseBright = u_UseLayer4 ? pickLayerFloat(u_BaseBrightness4, layerW) : u_BaseBrightness;
    baseColor += baseBright * u_MxCharShadowTone.rgb;

    // ─── View light (forward + inverse) ───
    if (!u_IsFaceShader) {
        float vOff = u_UseLayer4 ? pickLayerFloat(u_ShadowThreshold4, layerW) : u_ViewOffset;
        float vPow = u_UseLayer4 ? pickLayerFloat(u_ViewPower4, layerW) : u_ViewPower;
        float vStr = u_UseLayer4 ? pickLayerFloat(u_ViewStrength4, layerW) : u_ViewStrength;
        float ivPow = u_UseLayer4 ? pickLayerFloat(u_InvViewPower4, layerW) : u_InvViewPower;
        float ivStr = u_UseLayer4 ? pickLayerFloat(u_InvViewStrength4, layerW) : u_InvViewStrength;
        float vEdge = u_UseLayer4 ? pickLayerFloat(u_ViewLightEdge4, layerW) : u_ViewLightEdge;
        float invEdge = 1.0 - vEdge;

        // DXBC verified 2026-05-21 (CH0063 blue_layer trace). Half-vector
        // builds from lightDir * vOff + V, where vOff is the layer
        // dp4 of _ShadowThreshold4 (cb3[5]) — the slot Game named
        // "threshold" actually drives the view-light half-vector, while
        // the shadow gate uses _RimStrength4 (Bug A). The contribution
        // adds to baseColor BEFORE albedo modulation, so do not pre-mul
        // by albedo here (that double-multiplies once color = baseColor
        // * albedo runs at the end).
        vec3 H = normalize(u_MxCharLightDir * vOff + V);
        float NdotH = clamp(dot(N, H), 0.0, 1.0);

        if (vStr > 0.001) {
            float vTerm = pow(NdotH, max(vPow, 0.001));
            float maskG_remap = u_HasMaskTex ? (-mask.g * 2.0 + 1.0) : 0.0;
            vTerm = clamp(vTerm + maskG_remap * u_MaskGSensitivity, 0.0, 1.0);
            float vHard = clamp((vTerm - 0.5) * 10.0, 0.0, 1.0) * vEdge;
            vTerm = invEdge * vTerm + vHard;
            baseColor += vTerm * vStr * u_MxCharShadowTone.rgb;
        }

        if (ivStr > 0.001) {
            float ivTerm = pow(clamp(fresnel, 0.0, 1.0), max(ivPow, 0.001));
            float ivHard = min(ivTerm * 4000.0, 1.0) * vEdge;
            ivTerm = invEdge * ivTerm + ivHard;
            baseColor += ivTerm * ivStr * u_MxCharShadowTone.rgb;
        }
    }

    // ─── Rim ───
    {
        // DXBC verified 2026-05-21 (CH0076/CH0100/CH0170 sweeps). The
        // rim gate is cb3[11] = _ViewOffset4; the rim amplitude is
        // _RimAreaMultiplier4 × lightData.x. Critically, rim is NOT
        // gated by (1 - shadow) — instead the gating happens naturally
        // because most materials set _ViewOffset4 = 0 (so the term
        // collapses), while CH0100/CH0170 use it for the HDR back-lit
        // boost. Fresnel uses the unclamped NdotV (back_lit pushes it
        // above 1.0 which is the expected behaviour). See
        // doc/shader-rewrite-plan.md Bugs B + C.
        float rimWindow, rimGate, rimAmount;
        if (u_UseLayer4) {
            float vEdgeR = pickLayerFloat(u_ViewOffset4, layerW);
            rimWindow = max(vEdgeR - 1.0, 0.0);
            rimGate = clamp(fresnel * vEdgeR - rimWindow, 0.0, 1.0) * vRimMask;
            float rimAreaMult = pickLayerFloat(u_RimAreaMultiplier4, layerW);
            rimAmount = rimGate * rimAreaMult * u_MxCharLightData.x;
        } else if (u_IsFaceShader) {
            // Face shader uses _MaskGSensitivity as the fresnel gate and
            // _ShadowThreshold as the strength multiplier. DXBC verified
            // 2026-05-21 on CH0076_Face front_lit:
            //   rimGate = saturate(fresnel * _MaskGSensitivity - _ShadowSharpness)
            //   rimAmount = rimGate * vRimMask * _ShadowThreshold * lightData.x
            // Note _ShadowSharpness is consumed unsigned here (not negated).
            rimGate = clamp(
                fresnel * u_MaskGSensitivity - abs(u_ShadowSharpness),
                0.0, 1.0
            ) * vRimMask;
            rimAmount = rimGate * u_ShadowThreshold * u_MxCharLightData.x;
        } else {
            float rimArea = u_RimAreaMultiplier;
            float rimStrength = u_RimStrength;
            rimWindow = max(rimArea - 1.0, 0.0);
            rimGate = clamp(fresnel * rimArea - rimWindow, 0.0, 1.0)
                * vRimMask * rimStrength;
            rimAmount = rimGate;
        }

        // Rim colour: NdotL-modulated, scaled against lit tone
        // (cb0[127] = lit-side after the Game naming inversion fix).
        float rimNdot = clamp(NdotL * 4.0 + 0.25, 0.0, 1.0);
        vec3 rimColor = (rimNdot * 0.4 + 0.3) * u_MxCharShadowTone.rgb;
        baseColor += rimAmount * rimColor + rimAmount * u_CodeAddRimColor.rgb;
    }

    // ─── Point rim light (custom helper, not in game) ───
    if (u_RimLightRange > 0.01) {
        vec3 toLight = u_RimLightPos - vWorldPos;
        float dist = length(toLight);
        float atten = clamp(1.0 - (dist * dist) / (u_RimLightRange * u_RimLightRange), 0.0, 1.0);
        atten *= atten;
        if (atten > 0.001) {
            vec3 lightDir = normalize(toLight);
            float pNdotL = max(dot(N, lightDir), 0.0);
            float pFresnel = 1.0 - max(dot(-N, V), 0.0);
            float pointRim = pow(pFresnel, 8.0) * pNdotL * atten;
            baseColor += pointRim * u_RimLightColor.rgb;
        }
    }

    // ─── Hair anisotropic spec ───
    if (!u_IsFaceShader && u_HasHairSpecTex) {
        vec3 specT = texture2D(u_HairSpecTex, vUv).rgb * 2.0 - 1.0;
        vec3 T = normalize(vTangent);
        vec3 B = normalize(vBitangent) * faceSign;
        vec3 wSpec = normalize(T * specT.x + B * specT.y + N * specT.z);
        float specDot = dot(wSpec, T);
        vec3 specBlend = specT * u_SpecDirMultiplier;
        float anisoInput = specBlend.x + specBlend.y + specBlend.z + specDot;

        // DXBC ordering: bottom branch first (max/clamp/square), then top via
        // saturate(fade*topMul - topLev). See shader-truth.md §3.
        float fade = 1.0 - anisoInput;
        float topMul = clamp(fade * u_SpecTopMultiplier - u_SpecTopLeveler, 0.0, 1.0);
        float topVal = max(anisoInput, -u_SpecBotArea);
        topVal = (topVal + u_SpecBotArea) * (topVal + u_SpecBotArea) * u_SpecBotMultiplier;

        float sign = anisoInput >= 0.0 ? 1.0 : 0.0;
        float spec = (sign * topMul + topVal * (1.0 - sign)) * u_SpecStrength;

        // Hair spec masked to lit areas (PS:141)
        float specMask = clamp(shadowInput * 5.0 - 0.5, 0.0, 1.0);
        spec *= specMask;
        float specNdot = clamp(NdotL * 4.0 + 0.25, 0.0, 1.0);
        vec3 specTone = (specNdot * 0.4 + 0.3) * u_MxCharShadowTone.rgb;
        baseColor += spec * u_MxCharLightData.x * specTone;
    }

    // ─── Compose: albedo * lit term ───
    vec3 color = baseColor * albedo.rgb;

    // ─── Inline silhouette (dark stripe near edges) ───
    if (u_InlineAmount > 0.001) {
        float inlineMask = clamp(-NdotV * vRimMask + 1.0, 0.0, 1.0) * u_InlineAmount;
        vec3 inlineCol = inlineMask * u_InlineTint.rgb - vec3(1.0);
        float maskR = u_HasMaskTex ? mask.r : 0.0;
        color = mix(color, color * inlineCol, maskR);
    }

    // ─── Code grading (DXBC ordering: gray → addRim → add → multiply) ───
    // For hair and single-layer body shaders the DXBC PS collapses RGB
    // through dp3 luminance BEFORE the multiply / add / addRim chain
    // (verified 2026-05-21 via shade_truth on CH0076_Hair / CH0076_Body —
    // see doc/shader-rewrite-plan.md Bug D). Layer4 keeps RGB. Face is
    // unchanged (no luminance step in chunk 46).
    float gray = dot(color, vec3(0.2126, 0.7152, 0.0722)) * u_GrayBrightness;
    if (!u_UseLayer4 && !u_IsFaceShader) {
        color = vec3(gray);
    }
    color = color * u_CodeMultiplyColor.rgb + u_CodeAddColor.rgb;
    color += vec3(gray) * u_CodeAddRimColor.rgb;

    // ─── Fog ───
    if (vFog > 0.001) {
        float fogFactor = clamp(exp(-vFog), 0.0, 1.0);
        color = mix(u_FogColor, color, fogFactor);
    }

    gl_FragColor = vec4(color, albedo.a);
}
`;
