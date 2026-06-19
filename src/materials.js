import * as THREE from "three";

function vec4(obj, fallback = { r: 1, g: 1, b: 1, a: 1 }) {
  const source = obj || fallback;
  return new THREE.Vector4(
    source.r ?? fallback.r,
    source.g ?? fallback.g,
    source.b ?? fallback.b,
    source.a ?? fallback.a
  );
}

function vec4FromScalar(value) {
  return new THREE.Vector4(value, value, value, value);
}

function hasAny(obj, names) {
  return names.some((name) => obj?.[name] != null);
}

const MATERIAL_OPACITY_OVERRIDES = new Map([
  // Truth bundles mark this prop as MX/C-Simple-Transparent, but serialize
  // material and texture alpha as fully opaque. The live game still renders
  // the tabletop glass as translucent, so keep the parity override narrowly
  // scoped to the one material until a runtime property source is found.
  ["CH0100_Table_02", 0.38]
]);

export function getMaterialOpacityOverride(matData) {
  const materialName = String(matData?.name || "");
  return MATERIAL_OPACITY_OVERRIDES.get(materialName);
}

export function parseMaterialOverrides(matData) {
  const overrides = {};
  if (!matData) return overrides;

  const c = matData.colors || {};
  const f = matData.floats || {};
  const shaderName = getMaterialShaderName(matData);
  const isLayer4Shader = /Layer4/i.test(shaderName);

  if (c._Tint) overrides.u_Tint = vec4(c._Tint);
  else if (c._Color) overrides.u_Tint = vec4(c._Color);
  if (f._Cutoff != null) overrides.u_Cutoff = f._Cutoff;

  // Shadow params (Layer4)
  if (c._ShadowThreshold4) {
    overrides.u_ShadowThreshold4 = vec4(c._ShadowThreshold4);
    if (isLayer4Shader) overrides.u_UseLayer4 = true;
  }
  if (c._ShadowTintR4) overrides.u_ShadowTintR4 = vec4(c._ShadowTintR4);
  if (c._ShadowTintG4) overrides.u_ShadowTintG4 = vec4(c._ShadowTintG4);
  if (c._ShadowTintB4) overrides.u_ShadowTintB4 = vec4(c._ShadowTintB4);

  // Two-side tint (applied to lit colour on backfaces in transparent shader)
  if (c._TwoSideTint) overrides.u_TwoSideTint = vec4(c._TwoSideTint);

  // Single-layer fallback
  if (f._ShadowThreshold != null) overrides.u_ShadowThreshold = f._ShadowThreshold;
  if (c._ShadowTint) {
    overrides.u_ShadowTintR4 = vec4(c._ShadowTint);
    overrides.u_ShadowTint = new THREE.Vector3(c._ShadowTint.r, c._ShadowTint.g, c._ShadowTint.b);
    overrides.u_FaceShadowTintAlpha = c._ShadowTint.a ?? 1.0;
  }
  if (f._ShadowSharpness != null) overrides.u_ShadowSharpness = -Math.abs(f._ShadowSharpness);

  if (f._BaseBrightness != null) overrides.u_BaseBrightness = f._BaseBrightness;
  if (f._GlowPower != null) overrides.u_GlowPower = f._GlowPower;

  // View Light
  if (c._ViewPower4) overrides.u_ViewPower4 = vec4(c._ViewPower4);
  if (c._ViewStrength4) overrides.u_ViewStrength4 = vec4(c._ViewStrength4);
  if (c._ViewOffset4) overrides.u_ViewOffset4 = vec4(c._ViewOffset4);
  if (c._ViewLightEdge4) overrides.u_ViewLightEdge4 = vec4(c._ViewLightEdge4);
  if (c._InvViewPower4) overrides.u_InvViewPower4 = vec4(c._InvViewPower4);
  if (c._InvViewStrength4) overrides.u_InvViewStrength4 = vec4(c._InvViewStrength4);
  if (c._BaseBrightness4) overrides.u_BaseBrightness4 = vec4(c._BaseBrightness4);
  if (f._ViewOffset != null) overrides.u_ViewOffset4 = vec4FromScalar(f._ViewOffset);
  if (f._ViewPower != null) overrides.u_ViewPower4 = vec4FromScalar(f._ViewPower);
  if (f._ViewStrength != null) overrides.u_ViewStrength4 = vec4FromScalar(f._ViewStrength);
  if (f._InvViewPower != null) overrides.u_InvViewPower4 = vec4FromScalar(f._InvViewPower);
  if (f._InvViewStrength != null) overrides.u_InvViewStrength4 = vec4FromScalar(f._InvViewStrength);
  if (f._ViewLightEdge != null) overrides.u_ViewLightEdge4 = vec4FromScalar(f._ViewLightEdge);
  if (f._BaseBrightness != null) overrides.u_BaseBrightness4 = vec4FromScalar(f._BaseBrightness);

  // Rim (per-layer or single)
  if (c._RimAreaMultiplier4) {
    overrides.u_RimAreaMultiplier4 = vec4(c._RimAreaMultiplier4);
    overrides.u_RimAreaMultiplier = c._RimAreaMultiplier4.r;
  }
  if (f._RimAreaMultiplier != null) overrides.u_RimAreaMultiplier = f._RimAreaMultiplier;
  if (c._RimStrength4) {
    overrides.u_RimStrength4 = vec4(c._RimStrength4);
    overrides.u_RimStrength = c._RimStrength4.r;
  }
  if (f._RimStrength != null) overrides.u_RimStrength = f._RimStrength;
  if (f._RimAreaLeveler != null) overrides.u_RimAreaLeveler = f._RimAreaLeveler;

  // Glow
  if (c._GlowTint) overrides.u_GlowTint = vec4(c._GlowTint);
  if (f._GlowStrength != null) overrides.u_GlowStrength = f._GlowStrength;

  // Inline
  if (c._InlineTint) overrides.u_InlineTint = vec4(c._InlineTint);
  if (f._InlineAmount != null) overrides.u_InlineAmount = f._InlineAmount;

  // Outline
  if (c._OutlineTint) overrides.u_OutlineTint = vec4(c._OutlineTint);

  // Mask G sensitivity
  if (f._MaskGSensitivity != null) overrides.u_MaskGSensitivity = f._MaskGSensitivity;

  // Hair anisotropic specular
  if (c._SpecDirMultiplier) overrides.u_SpecDirMultiplier = new THREE.Vector3(c._SpecDirMultiplier.r, c._SpecDirMultiplier.g, c._SpecDirMultiplier.b);
  if (f._SpecTopMultiplier != null) overrides.u_SpecTopMultiplier = f._SpecTopMultiplier;
  if (f._SpecTopLeveler != null) overrides.u_SpecTopLeveler = f._SpecTopLeveler;
  if (f._SpecBotArea != null) overrides.u_SpecBotArea = f._SpecBotArea;
  if (f._SpecBotMultiplier != null) overrides.u_SpecBotMultiplier = f._SpecBotMultiplier;
  if (f._SpecStrength != null) overrides.u_SpecStrength = f._SpecStrength;
  if (f._AdjustiveHairShadow != null) overrides.u_AdjustiveHairShadow = f._AdjustiveHairShadow;

  // Face shader
  if (c._ShadowLightDir) overrides.u_ShadowLightDir = new THREE.Vector3(c._ShadowLightDir.r, c._ShadowLightDir.g, c._ShadowLightDir.b);
  if (f._AdjustiveFaceShadow != null) overrides.u_AdjustiveFaceShadow = f._AdjustiveFaceShadow;

  // Code colors
  if (c._CodeMultiplyColor) overrides.u_CodeMultiplyColor = vec4(c._CodeMultiplyColor);
  if (c._CodeAddColor) overrides.u_CodeAddColor = vec4(c._CodeAddColor);
  if (c._CodeAddRimColor) overrides.u_CodeAddRimColor = vec4(c._CodeAddRimColor);
  if (f._AdditionalLightStrength != null) overrides.u_AdditionalLightStrength = f._AdditionalLightStrength;
  if (f._AdditionalLightSharpness != null) overrides.u_AdditionalLightSharpness = f._AdditionalLightSharpness;
  if (f._DitherThreshold != null) overrides.u_DitherThreshold = f._DitherThreshold;
  if (f._GrayBrightness != null) overrides.u_GrayBrightness = f._GrayBrightness;

  const opacityOverride = getMaterialOpacityOverride(matData);
  if (opacityOverride != null) {
    const tint = overrides.u_Tint || vec4(c._Tint || c._Color);
    overrides.u_Tint = tint.clone();
    overrides.u_Tint.w = opacityOverride;
  }

  return overrides;
}

// Detect transparent routes by shader name. Game's transparent
// shader family has queue/depth/cull state on the pass, while material-side
// _SrcBlend/_DstBlend often arrives as inherited defaults. Keep shader names
// as the primary signal and use older JSON heuristics only as fallback.
//
// Older exported JSONs don't carry the shader name; for those we fall back to
// material-name and texture-slot heuristics (Hair material = hair shader,
// presence of `_HairSpecTex` slot = hair, Layer4 property groups = legacy
// Layer4 body shader, `_DstBlend != 0` = some transparent variant).
export function getMaterialShaderName(matData) {
  const direct = String(matData?.shader || matData?.shaderName || "");
  if (direct) return direct;
  // Heuristic fallback for older exports.
  const name = String(matData?.name || "").toLowerCase();
  const tex = matData?.textures || {};
  const f = matData?.floats || {};
  const c = matData?.colors || {};
  if (tex._HairSpecTex || /_hair$/i.test(name) || /^.*hair.*$/i.test(name)) {
    // Game ships TWO hair shaders that share the same `_HairSpecTex` slot:
    //   - MX/C-Hair             — opaque (Cull=2, ZWrite=1, SrcBlend=One,
    //                              DstBlend=Zero) used for the main hair mesh
    //   - MX/C-Hair-Transparent - transparent forward pass used for the
    //                             `*_Hair_Alpha` companion submesh that
    //                             overlays see-through wisp strands
    // Without distinguishing them, characters that ship both (e.g. CH0264
    // Konoka) routed the opaque main hair through the transparent pipeline
    // and the alpha=0 region of the shared atlas turned the head into a
    // grey blob (or the alpha pass into a slab). Disambiguate
    // by inspecting the per-material blend factors: only the truly
    // alpha-blended companion declares _DstBlend != 0.
    const dstBlend = f._DstBlend;
    const srcBlend = f._SrcBlend;
    const isAlphaName = /_alpha$/i.test(name);
    const isOpaqueBlend =
      (dstBlend != null && dstBlend === 0) ||
      (srcBlend != null && srcBlend === 1 && (dstBlend == null || dstBlend === 0));
    if (isOpaqueBlend && !isAlphaName) {
      return "MX/C-Hair";
    }
    return "MX/C-Hair-Transparent";
  }
  if (/_face$/i.test(name) || name.endsWith("face")) {
    return "MX/C-Face-Cutin";
  }
  if (
    c._ShadowThreshold4 ||
    c._ShadowTintR4 ||
    c._ShadowTintG4 ||
    c._ShadowTintB4
  ) {
    return "MX/C-General/Layer4";
  }
  if (f._DstBlend != null && f._DstBlend !== 0) {
    return "MX/C-General/Transparent";
  }
  return "";
}

export function isTransparentShaderName(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return /transparent/i.test(lower);
}

export function isHairTransparentShaderName(name) {
  if (!name) return false;
  return /c-hair-transparent/i.test(String(name));
}

export function isSimpleTransparentShaderName(name) {
  if (!name) return false;
  return /c-simple-transparent/i.test(String(name));
}

export function isTransparentMaterialData(matData) {
  const f = matData?.floats || {};
  const c = matData?.colors || {};
  if (isTransparentShaderName(getMaterialShaderName(matData))) return true;
  return (
    f._Surface === 1 ||
    (f._DstBlend != null && f._DstBlend !== 0) ||
    (f._ZWrite != null && f._ZWrite === 0 && (c._Color?.a ?? c._Tint?.a ?? 1) < 1) ||
    (c._Color?.a ?? c._Tint?.a ?? 1) < 0.999
  );
}

export function isSimpleTexturedMaterialData(matData) {
  const f = matData?.floats || {};
  const c = matData?.colors || {};
  const hasCharacterLighting =
    hasAny(f, [
      "_ShadowThreshold",
      "_MaskGSensitivity",
      "_RimAreaMultiplier",
      "_GlowStrength",
      "_ViewStrength",
      "_AdditionalLightStrength"
    ]) ||
    hasAny(c, [
      "_ShadowTint",
      "_ShadowThreshold4",
      "_ShadowTintR4",
      "_ShadowTintG4",
      "_ShadowTintB4"
    ]);
  if (!matData || hasCharacterLighting) return false;
  // Accept any material that has at least one texture slot. FX/particle and
  // prop materials use slots like `_MainTex`, `_Texture`, `_BaseMap`, etc.
  // Without this guard they fall through to the toon shader with
  // u_HasMainTex=false and render as a flat 0.82 grey or pitch black if
  // their albedo alpha drops to zero.
  const textures = matData.textures || {};
  return Object.keys(textures).length > 0;
}

export function unityCullToSide(cull) {
  if (cull === 1) return THREE.BackSide;
  if (cull === 2) return THREE.FrontSide;
  return THREE.DoubleSide;
}

export function unityBlendFactorToThree(value, fallback) {
  switch (Math.trunc(value ?? -1)) {
    case 0:
      return THREE.ZeroFactor;
    case 1:
      return THREE.OneFactor;
    case 2:
      return THREE.DstColorFactor;
    case 3:
      return THREE.SrcColorFactor;
    case 4:
      return THREE.OneMinusDstColorFactor;
    case 5:
      return THREE.SrcAlphaFactor;
    case 6:
      return THREE.OneMinusSrcColorFactor;
    case 7:
      return THREE.DstAlphaFactor;
    case 8:
      return THREE.OneMinusDstAlphaFactor;
    case 9:
      return THREE.SrcAlphaSaturateFactor;
    case 10:
      return THREE.OneMinusSrcAlphaFactor;
    default:
      return fallback;
  }
}

function unityBlendEnum(value, fallback) {
  return value == null ? fallback : Math.trunc(value);
}

export function usesPremultipliedAlphaBlend(matData) {
  const shaderName = getMaterialShaderName(matData);
  if (isHairTransparentShaderName(shaderName)) return false;
  // Generic body transparent is authored for premul blending in the viewer.
  // Hair transparent is explicitly excluded above: its DXBC writes straight
  // RGB plus alpha and CH0264_Hair_Alpha declares SrcAlpha/OneMinusSrcAlpha.
  if (isTransparentShaderName(shaderName)) return true;
  if (!isTransparentMaterialData(matData)) return false;
  const f = matData?.floats || {};
  return unityBlendEnum(f._SrcBlend, 1) === 1 && unityBlendEnum(f._DstBlend, 0) === 10;
}

export function shouldRouteToHairTransparent(matData) {
  return isHairTransparentShaderName(getMaterialShaderName(matData));
}

export function shouldRouteToSimpleTransparent(matData) {
  return isSimpleTransparentShaderName(getMaterialShaderName(matData));
}

export function applyUnityBlendState(material, matData) {
  const f = matData?.floats || {};
  const shaderName = getMaterialShaderName(matData);
  const transparent = isTransparentMaterialData(matData);
  const premul = usesPremultipliedAlphaBlend(matData);
  material.transparent = transparent;
  // Transparent forward passes in the extracted shaders hard-code ZWrite Off
  // and Cull Off even when the material property block still says ZWrite=1.
  material.depthWrite = isTransparentShaderName(shaderName)
    ? false
    : f._ZWrite != null
      ? f._ZWrite >= 0.5
      : !transparent;
  material.side = isTransparentShaderName(shaderName)
    ? THREE.DoubleSide
    : unityCullToSide(f._Cull);
  material.premultipliedAlpha = premul;

  if (premul) {
    // Force One + OneMinusSrcAlpha for the transparent shader family,
    // regardless of what the material JSON inherited from URP defaults.
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    return;
  }

  if (
    transparent ||
    f._SrcBlend != null ||
    f._DstBlend != null ||
    f._SrcBlendAlpha != null ||
    f._DstBlendAlpha != null
  ) {
    material.blending = THREE.CustomBlending;
    material.blendSrc = unityBlendFactorToThree(f._SrcBlend, THREE.OneFactor);
    material.blendDst = unityBlendFactorToThree(f._DstBlend, THREE.ZeroFactor);
    material.blendSrcAlpha = unityBlendFactorToThree(
      f._SrcBlendAlpha,
      material.blendSrc
    );
    material.blendDstAlpha = unityBlendFactorToThree(
      f._DstBlendAlpha,
      material.blendDst
    );
  }
}

export function createSimpleTexturedMaterial({ texture, matData }) {
  const colorData = matData?.colors?._Color || matData?.colors?._Tint || matData?.colors?._TintColor || {
    r: 1,
    g: 1,
    b: 1,
    a: 1
  };
  // Some FX materials store HDR values (>1) in _TintColor for bloom. Clamp
  // RGB to [0,1] for THREE.Color to avoid wrap-around / negative output, but
  // keep alpha as-is so blending honours opacity.
  const r = Math.max(0, Math.min(colorData.r ?? 1, 1));
  const g = Math.max(0, Math.min(colorData.g ?? 1, 1));
  const b = Math.max(0, Math.min(colorData.b ?? 1, 1));
  const material = new THREE.MeshBasicMaterial({
    map: texture || null,
    color: new THREE.Color(r, g, b),
    opacity: colorData.a ?? 1
  });
  applyUnityBlendState(material, matData);
  material.userData.isSimpleTexturedMaterial = true;
  return material;
}
