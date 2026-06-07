import * as THREE from "three";
import { haloVertSrc, haloFragSrc } from "./shaders/halo.js";

function vec2From(value, fallbackX = 0, fallbackY = 0) {
  if (value instanceof THREE.Vector2) return value.clone();
  if (Array.isArray(value)) return new THREE.Vector2(value[0] ?? fallbackX, value[1] ?? fallbackY);
  return new THREE.Vector2(fallbackX, fallbackY);
}

function vec4From(value, fallback = [1, 1, 1, 1]) {
  if (value instanceof THREE.Vector4) return value.clone();
  if (Array.isArray(value)) return new THREE.Vector4(value[0] ?? fallback[0], value[1] ?? fallback[1], value[2] ?? fallback[2], value[3] ?? fallback[3]);
  return new THREE.Vector4(fallback[0], fallback[1], fallback[2], fallback[3]);
}

function textureNames(assetData = {}) {
  return [...new Set((assetData.textures || []).map((t) => t?.name).filter(Boolean))];
}

function collectTextureKeys(names, patterns) {
  const out = [];
  for (const pattern of patterns) {
    const lowerPattern = pattern.toLowerCase();
    for (const name of names) {
      if (name.toLowerCase().includes(lowerPattern) && !out.includes(name)) {
        out.push(name);
      }
    }
  }
  return out;
}

function isHaloTextureName(name) {
  return /halo/i.test(name) && !/mask/i.test(name);
}

function isGenericFxTextureName(name) {
  return /^FX_TEX_/i.test(name);
}

function findHaloMaterial(materialDataByName = {}) {
  for (const [name, data] of Object.entries(materialDataByName)) {
    if (/halo/i.test(name) || /halo/i.test(data?.name || "")) {
      return data;
    }
  }
  return null;
}

function inferScaleHints(names) {
  const joined = names.join(" ").toLowerCase();
  if (joined.includes("world_halo")) {
    return { ringScale: 0.42, tubeScale: 0.42, planeScale: 0.42 };
  }
  if (joined.includes("original_halo")) {
    return { ringScale: 0.155, tubeScale: 0.12, planeScale: 0.16 };
  }
  if (joined.includes("scenario") || joined.includes("carrier")) {
    return { ringScale: 0.15, tubeScale: 0.16, planeScale: 0.16 };
  }
  if (joined.includes("cutin") || joined.includes("glow")) {
    return { ringScale: 0.15, tubeScale: 0.17, planeScale: 0.18 };
  }
  return { ringScale: 0.16, tubeScale: 0.18, planeScale: 0.16 };
}

function hasHaloMesh(assetData = {}) {
  return (assetData.meshes || []).some((mesh) => {
    const name = `${mesh?.name || ""} ${mesh?.file || ""}`;
    return /halo/i.test(name);
  });
}

function makeProfile(raw) {
  const profile = raw || {};
  return {
    enabled: !!profile.enabled,
    mode: profile.mode || "none",
    useTexture: profile.useTexture ?? true,
    texturePatterns: profile.texturePatterns || [],
    textureKeys: profile.textureKeys || [],
    uvScroll: vec2From(profile.uvScroll, 0, 0),
    pulseSpeed: profile.pulseSpeed ?? 0,
    pulseStrength: profile.pulseStrength ?? 0,
    glowStrength: profile.glowStrength ?? 1,
    tint: vec4From(profile.tint, [1, 1, 1, 1]),
    useRamp: !!profile.useRamp,
    fromHaloIndex: profile.fromHaloIndex ?? 0,
    toHaloIndex: profile.toHaloIndex ?? 0,
    blendRatio: profile.blendRatio ?? 0,
    bobSpeed: profile.bobSpeed ?? 0,
    bobAmount: profile.bobAmount ?? 0,
    allowSynthetic: !!profile.allowSynthetic,
    blending: profile.blending || "normal",
    ringScale: profile.ringScale ?? 0.16,
    tubeScale: profile.tubeScale ?? 0.18,
    planeScale: profile.planeScale ?? 0.42,
  };
}

function inferProfile(assetData = {}, materialDataByName = {}) {
  const names = textureNames(assetData);
  const haloNames = names.filter(isHaloTextureName);
  const dedicatedHaloNames = haloNames.filter((name) => !isGenericFxTextureName(name));
  const haloMaterial = findHaloMaterial(materialDataByName);
  const scaleHints = inferScaleHints(dedicatedHaloNames.length ? dedicatedHaloNames : haloNames);
  const glowStrength = haloMaterial?.floats?._GlowStrength0
    ?? haloMaterial?.floats?._GlowStrength
    ?? 1.0;

  return {
    enabled: dedicatedHaloNames.length > 0
      || haloNames.length > 0
      || !!haloMaterial
      || hasHaloMesh(assetData)
      || !!assetData.halo_transform
      || !!assetData.halo_anchor,
    mode: "static",
    useTexture: dedicatedHaloNames.length > 0,
    texturePatterns: dedicatedHaloNames,
    uvScroll: [0.0, 0.0],
    pulseSpeed: 0.0,
    pulseStrength: 0.0,
    glowStrength,
    tint: [1.0, 1.0, 1.0, 1.0],
    bobSpeed: 0.0,
    bobAmount: 0.0,
    allowSynthetic: true,
    blending: glowStrength > 1.1 ? "additive" : "normal",
    ...scaleHints,
  };
}

export function buildHaloAnimationProfile(assetData = {}, materialDataByName = {}) {
  const names = textureNames(assetData);
  const manifestProfile = assetData.halo_profile || assetData.haloProfile || {};
  const raw = { ...inferProfile(assetData, materialDataByName), ...manifestProfile };
  const profile = makeProfile(raw);

  if (!profile.useTexture) {
    profile.texturePatterns = [];
    profile.textureKeys = [];
    return profile;
  }

  if (!profile.texturePatterns.length) {
    profile.texturePatterns = profile.mode === "scroll"
      ? [
          "FX_TEX_Water_Wave_RGB_01",
          "FX_TEX_Water_Wave_RGB_02",
          "FX_TEX_Water_Wave_RGB_03",
          "FX_TEX_Water_Flow_01",
          "FX_TEX_Water_Flow_02",
          "FX_TEX_Water_Flow_03",
          "FX_TEX_Water_Bubble_01",
          "FX_TEX_Stretch_Scroll_02",
          "FX_TEX_Stretch_Scroll_01",
        ]
      : textureNames(assetData).filter(isHaloTextureName);
  }

  profile.textureKeys = collectTextureKeys(names, profile.texturePatterns);
  if (!profile.textureKeys.length) {
    profile.textureKeys = names.filter((name) => /halo/i.test(name) && !/mask/i.test(name));
  }

  if (!profile.enabled) {
    profile.enabled = profile.textureKeys.length > 0;
  }

  return profile;
}

export function pickHaloTextureKey(texCache, profile) {
  if (!profile?.useTexture) return null;

  const candidates = [...(profile.textureKeys || [])];
  for (const key of candidates) {
    if (texCache[key]) return key;
  }

  const cachedNames = Object.keys(texCache);
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const found = cachedNames.find((name) => name.toLowerCase() === lower || name.toLowerCase().includes(lower));
    if (found) return found;
  }

  const haloName = cachedNames.find((name) => /halo/i.test(name) && !/mask/i.test(name));
  if (haloName) return haloName;

  const fxName = cachedNames.find((name) => name.startsWith("FX_TEX_"));
  if (fxName) return fxName;

  return null;
}

function vec4Color(value, fallback = [1, 1, 1, 1]) {
  if (!value) return new THREE.Vector4(...fallback);
  return new THREE.Vector4(
    value.r ?? fallback[0],
    value.g ?? fallback[1],
    value.b ?? fallback[2],
    value.a ?? fallback[3],
  );
}

function hasGlowMask(matData) {
  return !!(matData?.colors?._GlowMaskColor0 || matData?.colors?._GlowMaskColor);
}

function usesOpaqueSourceBlend(matData) {
  const floats = matData?.floats || {};
  return floats._Surface === 0.0 && floats._SrcBlend === 1.0 && floats._DstBlend === 0.0;
}

export function createHaloMaterial({ texture, profile, tint, glowStrength, matData }) {
  const hasTexture = !!texture;
  const useGlowMask = hasGlowMask(matData);
  const opaqueSourceBlend = usesOpaqueSourceBlend(matData);
  if (texture && profile.mode === "scroll") {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
  }

  const material = new THREE.ShaderMaterial({
    uniforms: {
      u_MainTex: { value: texture || null },
      u_HasMainTex: { value: hasTexture },
      u_Tint: { value: tint ? tint.clone() : new THREE.Vector4(1, 1, 1, 1) },
      u_GlowStrength: { value: glowStrength ?? profile.glowStrength },
      u_UseGlowMask: { value: useGlowMask },
      u_GlowMaskColor: { value: vec4Color(matData?.colors?._GlowMaskColor0 || matData?.colors?._GlowMaskColor) },
      u_GlowTint: { value: vec4Color(matData?.colors?._GlowTint0 || matData?.colors?._GlowTint, [1, 1, 1, 1]) },
      u_GlowStrictness: { value: matData?.floats?._GlowStrictness0 ?? matData?.floats?._GlowStrictness ?? 3.0 },
      u_Time: { value: 0.0 },
      u_UvScroll: { value: profile.uvScroll.clone() },
      u_PulseSpeed: { value: profile.pulseSpeed },
      u_PulseStrength: { value: profile.pulseStrength },
      u_UseRamp: { value: profile.useRamp },
      u_FromHaloIndex: { value: profile.fromHaloIndex },
      u_ToHaloIndex: { value: profile.toHaloIndex },
      u_BlendRatio: { value: profile.blendRatio },
    },
    vertexShader: haloVertSrc,
    fragmentShader: haloFragSrc,
    side: THREE.DoubleSide,
    transparent: !opaqueSourceBlend,
    depthWrite: opaqueSourceBlend || false,
    blending: opaqueSourceBlend || profile.blending === "normal" ? THREE.NormalBlending : THREE.AdditiveBlending,
    toneMapped: false,
  });

  material.userData.haloProfile = profile;
  return material;
}

export function createHaloProxyMesh({ profile, texture, tint, glowStrength, position, size }) {
  const maxSpan = Math.max(size.x, size.z, size.y, 0.001);
  const radius = Math.max(maxSpan * profile.ringScale, 0.08);
  const geometry = profile.mode === "plane"
    ? new THREE.PlaneGeometry(Math.max(maxSpan * profile.planeScale, 0.2), Math.max(maxSpan * profile.planeScale, 0.2))
    : new THREE.TorusGeometry(radius, Math.max(radius * profile.tubeScale, maxSpan * 0.02), 14, 64);
  const material = createHaloMaterial({ texture, profile, tint, glowStrength });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "HaloProxy";
  mesh.position.copy(position);
  mesh.renderOrder = 2;
  mesh.userData.haloAnimation = {
    bobSpeed: profile.bobSpeed,
    bobAmount: profile.bobAmount,
  };
  mesh.userData.haloBasePosition = mesh.position.clone();
  return mesh;
}

export function attachHaloAnimationState(object, profile) {
  object.userData.haloAnimation = {
    bobSpeed: profile.bobSpeed,
    bobAmount: profile.bobAmount,
  };
  object.userData.haloBasePosition = object.position.clone();
}
