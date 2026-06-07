import * as THREE from "three";
import { computeLightTones, ECHELON_LIGHT_COLOR, computeSH9FromAmbient } from "./lighting.js";

const {
  lightTone: defaultLightTone,
  shadowTone: defaultShadowTone,
  lightData: defaultLightData,
} = computeLightTones(
  ECHELON_LIGHT_COLOR.r,
  ECHELON_LIGHT_COLOR.g,
  ECHELON_LIGHT_COLOR.b
);

// URP-style SH9 baked from a flat ambient grey-blue. The body VS samples
// these as cb1[25..31]; we expose them per-shader-material so the host can
// override per scene if needed.
const DEFAULT_SH = computeSH9FromAmbient(new THREE.Color(0.06, 0.07, 0.085));

export const DEFAULT_UNIFORMS = {
  // ─── Globals ───
  // Echelon main light direction, shared with tools.shader_reference.
  u_MxCharLightDir: new THREE.Vector3(0.1016, 0.9941, 0.0381).normalize(),
  u_MxCharLightTone: defaultLightTone,
  u_MxCharShadowTone: defaultShadowTone,
  u_MxCharLightData: defaultLightData,
  u_MxCharLightDataY: defaultLightData.y,
  u_FogColor: new THREE.Vector3(0.16, 0.16, 0.18),

  // SH9 ambient (URP cb1[25..31])
  u_SHAr: DEFAULT_SH.SHAr.clone(),
  u_SHAg: DEFAULT_SH.SHAg.clone(),
  u_SHAb: DEFAULT_SH.SHAb.clone(),
  u_SHBr: DEFAULT_SH.SHBr.clone(),
  u_SHBg: DEFAULT_SH.SHBg.clone(),
  u_SHBb: DEFAULT_SH.SHBb.clone(),
  u_SHC:  DEFAULT_SH.SHC.clone(),

  // ─── Material ───
  u_Tint: new THREE.Vector4(1, 1, 1, 1),
  u_TwoSideTint: new THREE.Vector4(1, 1, 1, 1),
  u_Cutoff: 0.2,

  u_ShadowTint: new THREE.Vector3(1.0, 1.0, 1.0),     // VS uses .rgb; PS Layer4 ignores
  u_ShadowThreshold: 0.3,
  u_ShadowSharpness: -10.0,                            // body convention; hair=-20, face=material

  // Layer4 vectors
  u_ShadowThreshold4: new THREE.Vector4(0.3, 0.3, 0.3, 0.3),
  u_ShadowTintR4: new THREE.Vector4(1, 1, 1, 1),
  u_ShadowTintG4: new THREE.Vector4(1, 1, 1, 1),
  u_ShadowTintB4: new THREE.Vector4(1, 1, 1, 1),
  u_BaseBrightness4: new THREE.Vector4(0, 0, 0, 0),
  u_RimAreaMultiplier4: new THREE.Vector4(0, 0, 0, 0),
  u_RimStrength4: new THREE.Vector4(1, 1, 1, 1),
  u_ViewOffset4: new THREE.Vector4(0, 0, 0, 0),
  u_ViewPower4: new THREE.Vector4(1, 1, 1, 1),
  u_ViewStrength4: new THREE.Vector4(0, 0, 0, 0),
  u_InvViewPower4: new THREE.Vector4(1, 1, 1, 1),
  u_InvViewStrength4: new THREE.Vector4(0, 0, 0, 0),
  u_ViewLightEdge4: new THREE.Vector4(0, 0, 0, 0),
  u_UseLayer4: false,

  // Single-layer scalars
  u_BaseBrightness: 0.0,
  u_RimAreaMultiplier: 0.0,
  u_RimAreaLeveler: 3.0,
  u_RimStrength: 0.0,
  u_RimLightColor: new THREE.Vector4(0.5, 0.6, 0.9, 1.0),
  u_CodeAddRimColor: new THREE.Vector4(0, 0, 0, 0),
  u_ViewOffset: 0.0,
  u_ViewPower: 1.0,
  u_ViewStrength: 0.0,
  u_InvViewPower: 1.0,
  u_InvViewStrength: 0.0,
  u_ViewLightEdge: 0.0,

  u_MaskGSensitivity: 1.0,

  // Glow / spec
  u_GlowTint: new THREE.Vector4(0, 0, 0, 1),
  u_GlowStrength: 0.0,
  u_GlowPower: 20.0,

  // Hair anisotropic spec
  u_SpecDirMultiplier: new THREE.Vector3(0.4, 0.0, 0.0),
  u_SpecTopMultiplier: 1.0,
  u_SpecTopLeveler: 1.0,
  u_SpecBotArea: 0.5,
  u_SpecBotMultiplier: 1.0,
  u_SpecStrength: 0.0,
  u_AdjustiveHairShadow: 0.0,

  // Face shader
  u_IsFaceShader: false,
  u_ShadowLightDir: new THREE.Vector3(0.0, 1.0, 0.0),
  u_AdjustiveFaceShadow: 0.0,
  u_FaceShadowTintAlpha: 1.0,        // _ShadowTint.w used in face mask.r blend

  // Inline silhouette
  u_InlineTint: new THREE.Vector4(0.5, 0.5, 0.5, 1),
  u_InlineAmount: 0.0,

  // Code grading
  u_CodeAddColor: new THREE.Vector4(0, 0, 0, 0),
  u_CodeMultiplyColor: new THREE.Vector4(1, 1, 1, 1),
  u_GrayBrightness: 1.0,

  // Effects
  u_DitherThreshold: 0.0,

  // Default runtime mode: baked texture + DXBC shadow gate only. Full lighting
  // stays available for truth probes but is not the default viewer path.
  u_MainLightEnabled: false,
  u_ShadowOnlyEnabled: true,
  u_BodyShadowEnabled: false,

  // Point rim extension is forced off by controls.js during the no-rim
  // experiment; keep the uniforms for shader compatibility.
  u_RimLightPos: new THREE.Vector3(2, 3, 1),
  u_RimLightRange: 0.0,

  // Outline
  u_OutlineThickness: 0.001,
  u_OutlineZCorrection: 0.0,
  u_OutlineTint: new THREE.Vector4(0.35, 0.25, 0.2, 1)
};

export function makeUniformsObj(overrides = {}) {
  const u = {};
  for (const [key, val] of Object.entries(DEFAULT_UNIFORMS)) {
    u[key] = {
      value:
        val instanceof THREE.Vector4 || val instanceof THREE.Vector3
          ? val.clone()
          : val
    };
  }
  u.u_MainTex = { value: null };
  u.u_MaskTex = { value: null };
  u.u_HasMainTex = { value: false };
  u.u_HasMaskTex = { value: false };
  u.u_HairSpecTex = { value: null };
  u.u_HasHairSpecTex = { value: false };
  for (const [k, v] of Object.entries(overrides)) {
    if (u[k]) u[k].value = v;
  }
  return u;
}
