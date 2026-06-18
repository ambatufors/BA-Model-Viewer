import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { toonVertSrc, toonFragSrc } from "./shaders/toon.js";
import { hairTransparentVertSrc, hairTransparentFragSrc } from "./shaders/hairTransparent.js";
import {
  simpleTransparentVertSrc,
  simpleTransparentFragSrc
} from "./shaders/simpleTransparent.js";
import { outlineVertSrc, outlineFragSrc } from "./shaders/outline.js";
import { eyeMouthVertSrc, eyeMouthFragSrc } from "./shaders/eyemouth.js";

import { DEFAULT_UNIFORMS, makeUniformsObj } from "./uniforms.js";
import {
  applyUnityBlendState,
  createSimpleTexturedMaterial,
  getMaterialShaderName,
  isSimpleTexturedMaterialData,
  isTransparentMaterialData,
  parseMaterialOverrides,
  shouldRouteToHairTransparent,
  shouldRouteToSimpleTransparent
} from "./materials.js";
import {
  attachHaloAnimationState,
  buildHaloAnimationProfile,
  createHaloMaterial,
  createHaloProxyMesh,
  pickHaloTextureKey
} from "./haloFx.js";
import { createHaloParticleSystem } from "./haloParticles.js";
import { createModelFx } from "./modelFx.js";

let modelsIndex = [];
const ASSET_CACHE_VERSION = "build-10"; //You should poke this after modifying the code
const HEAD_MESH_BASE_NAMES = new Set([
  "Face",
  "Hair",
  "EyeMouth",
  "Eyebrow",
  "Eyebrow2"
]);
const TRANSIENT_HALO_SOURCE_RE =
  /(?:cutin|motion|appear|spawn|timeline|camera|interaction|effect)/i;
const FLIPPED_UV_ATTRIBUTES = new WeakSet();
const FX_SHELL_TEXTURES = new Map();
const NEUTRAL_FACE_MASK_CACHE = new WeakMap();
const DEFAULT_ANIMATION_PATTERNS = [
  /Formation_Idle/i,
  /Normal_Idle/i,
  /Tactical_Start/i,
  /Cafe_Idle/i,
  /Idle/i
];

export function getModelsIndex() {
  return modelsIndex;
}

export function pickDefaultAnimationClip(clipNames = []) {
  for (const pattern of DEFAULT_ANIMATION_PATTERNS) {
    const match = clipNames.find((name) => pattern.test(name));
    if (match) return match;
  }
  return clipNames[0] || "";
}

function withCacheVersion(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}v=${ASSET_CACHE_VERSION}`;
}

function getMeshBaseName(name) {
  const source = String(name || "");
  const faceMeshMatch = source.match(/(?:^|_)(Face\d*)(?:_Mesh)?$/i);
  if (faceMeshMatch) return faceMeshMatch[1];
  const skillDiceMatch = source.match(/(?:^|_)(Skill_Dice)(?:_Outline|_Mesh)?$/i);
  if (skillDiceMatch) return skillDiceMatch[1];
  const prop02Match = source.match(/(?:^|_)(Prop02)(?:_Eye\d+)?(?:_Mesh)?$/i);
  if (prop02Match) return prop02Match[1];
  const brushMatch = source.match(/(?:^|_)(Brush(?:_\d+)?)$/i);
  if (brushMatch) return brushMatch[1];
  return source.replace(/^Face\d+_/, "").replace(/^.*_/, "") || source;
}

function isSkinnedPropMeshInfo(meshInfo) {
  const name = String(meshInfo?.name || "");
  return !!meshInfo?.isSkinned && /(Medicine|Bottle|Prop)/i.test(name);
}

function pickTextureKey(texCache, keys) {
  for (const key of keys) {
    if (key && texCache[key]) return key;
  }
  return null;
}

function materialTextureName(matData, slotName) {
  return matData?.textures?.[slotName]?.name || null;
}

function isNeutralFaceMaskTexture(tex) {
  if (!tex) return false;
  if (NEUTRAL_FACE_MASK_CACHE.has(tex)) return NEUTRAL_FACE_MASK_CACHE.get(tex);

  let neutral = false;
  try {
    const image = tex.image;
    const width = image?.naturalWidth || image?.videoWidth || image?.width || 0;
    const height =
      image?.naturalHeight || image?.videoHeight || image?.height || 0;
    if (width > 0 && height > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      let maxR = 0;
      let minG = 255;
      let maxG = 0;
      for (let i = 0; i < data.length; i += 4) {
        maxR = Math.max(maxR, data[i]);
        minG = Math.min(minG, data[i + 1]);
        maxG = Math.max(maxG, data[i + 1]);
      }
      neutral = maxR <= 3 && minG >= 125 && maxG <= 131;
    }
  } catch (e) {
    neutral = false;
  }

  NEUTRAL_FACE_MASK_CACHE.set(tex, neutral);
  return neutral;
}

function getTextureSourcePrefix(key, baseName) {
  const suffix = `_${baseName}`.toLowerCase();
  const lower = key.toLowerCase();
  const idx = lower.lastIndexOf(suffix);
  return idx >= 0 ? key.slice(0, idx) : key;
}

function resolveFaceMaterial(matFiles, charId, name, baseName) {
  const exact = `${charId}_${name}`;
  const base = `${charId}_${baseName}`;
  const candidates = [exact];
  if (base !== exact) candidates.push(base);
  candidates.push(name, baseName);

  let matName = candidates.find((k) => matFiles[k]) || null;
  if (!matName) {
    const suffix = `_${baseName}`.toLowerCase();
    const fallback = Object.keys(matFiles).find((k) => {
      const lower = k.toLowerCase();
      return lower.endsWith(suffix);
    });
    matName = fallback || null;
  }

  if (!matName && baseName === "Halo") {
    const haloCandidates = Object.keys(matFiles).filter((k) =>
      /_Halo$/i.test(k)
    );
    if (haloCandidates.length) {
      const scored = haloCandidates.map((k) => {
        let score = 0;
        if (k.toUpperCase() === exact.toUpperCase()) score += 100;
        if (k.toUpperCase().startsWith(charId.toUpperCase())) score += 40;
        if (k.toLowerCase().includes("original")) score += 30;
        if (k.toLowerCase().includes("scenario")) score += 20;
        if (k.toLowerCase().includes("carrier")) score += 15;
        if (k.toLowerCase().includes(charId.toLowerCase())) score += 10;
        return [score, k];
      });
      scored.sort((a, b) => b[0] - a[0]);
      matName = scored[0][1];
    }
  }

  return { matName, matData: matName ? matFiles[matName] : null };
}

function resolvePartMaterial(matFiles, charId, name, baseName, meshInfo) {
  const explicitName = meshInfo?.material_name || meshInfo?.materialName;
  if (explicitName && matFiles[explicitName]) {
    return { matName: explicitName, matData: matFiles[explicitName] };
  }
  return resolveFaceMaterial(matFiles, charId, name, baseName);
}

function resolveMainTexture(texCache, charId, name, baseName, matData = null) {
  const exact = `${charId}_${name}`;
  const base = `${charId}_${baseName}`;
  let texKey = pickTextureKey(texCache, [
    materialTextureName(matData, "_MainTex"),
    exact,
    base
  ]);

  if (!texKey) {
    const suffix = `_${baseName}`.toLowerCase();
    const candidates = Object.keys(texCache).filter((n) => {
      const lower = n.toLowerCase();
      return lower.endsWith(suffix) && !lower.includes("_mask");
    });
    const preferred = candidates.find((n) => n.startsWith(charId));
    texKey = preferred || candidates[0] || null;
  }

  return { texKey, tex: texKey ? texCache[texKey] : null };
}

function resolveMaskTexture(
  texCache,
  charId,
  name,
  baseName,
  mainTexKey,
  matData = null
) {
  const exact = `${charId}_${name}_Mask`;
  const base = `${charId}_${baseName}_Mask`;
  let texKey = pickTextureKey(texCache, [
    materialTextureName(matData, "_MaskTex"),
    mainTexKey && `${mainTexKey}_Mask`,
    exact,
    base
  ]);

  if (!texKey && mainTexKey) {
    const sourcePrefix = getTextureSourcePrefix(mainTexKey, baseName);
    const candidates = Object.keys(texCache).filter((n) => {
      const lower = n.toLowerCase();
      return (
        lower.includes("mask") &&
        lower.includes(baseName.toLowerCase()) &&
        n.startsWith(sourcePrefix)
      );
    });
    texKey = candidates[0] || null;
  }

  return { texKey, tex: texKey ? texCache[texKey] : null };
}

async function loadManifestData(basePath, fallback) {
  try {
    const resp = await fetch(withCacheVersion(basePath + "manifest.json"));
    if (!resp.ok) return fallback;
    const manifest = await resp.json();
    return {
      ...fallback,
      meshes: manifest.meshes || fallback.meshes || [],
      skinned_meshes: manifest.skinned_meshes || fallback.skinned_meshes || [],
      textures: manifest.textures || fallback.textures || [],
      materials: manifest.materials || fallback.materials || [],
      animations: manifest.animations || fallback.animations || [],
      halo_transform: manifest.halo_transform || fallback.halo_transform,
      head_transform: manifest.head_transform || fallback.head_transform,
      head_anchor: manifest.head_anchor || fallback.head_anchor,
      halo_anchor: manifest.halo_anchor || fallback.halo_anchor,
      halo_follow: manifest.halo_follow || fallback.halo_follow,
      halo_profile: manifest.halo_profile || fallback.halo_profile,
      halo_particles_file:
        manifest.halo_particles_file || fallback.halo_particles_file,
      fx_index_file: manifest.fx_index_file || fallback.fx_index_file,
      fx_anim_events_file:
        manifest.fx_anim_events_file || fallback.fx_anim_events_file,
      // fx_overlays lives only in the per-character manifest (e.g. CH0145
      // cutin spiral eyes), never in models_index. Without this line the
      // overlay block in loadCharacter never sees it and the FX silently
      // stops loading.
      fx_overlays: manifest.fx_overlays || fallback.fx_overlays
    };
  } catch (e) {
    return fallback;
  }
}

function isHaloMeshInfo(meshInfo) {
  const name = String(meshInfo?.name || "");
  const baseName = getMeshBaseName(name);
  return baseName === "Halo" || name.toLowerCase().includes("halo");
}

function isRuntimeStaticMeshInfo(meshInfo) {
  return (
    isHaloMeshInfo(meshInfo) ||
    !!meshInfo?.fx_prop ||
    !!meshInfo?.follow_target ||
    meshInfo?.source_kind === "character_prop"
  );
}

function normalizeObjectName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[\s_]+/g, "");
}

function findObjectByName(root, name) {
  if (!root || !name) return null;
  let found = null;
  const wanted = normalizeObjectName(name);
  root.traverse((object) => {
    if (!found && normalizeObjectName(object.name) === wanted) found = object;
  });
  return found;
}

function hasRenderableDescendant(root) {
  if (!root) return false;
  let found = false;
  root.traverse((object) => {
    if (!found && (object.isMesh || object.isSkinnedMesh)) found = true;
  });
  return found;
}

function fxOverlayNameMatches(actual, wanted) {
  const actualText = String(actual || "");
  const wantedText = String(wanted || "");
  if (!actualText || !wantedText) return false;
  const actualBase = actualText.split("/").pop();
  const wantedBase = wantedText.split("/").pop();
  return (
    normalizeObjectName(actualText) === normalizeObjectName(wantedText) ||
    normalizeObjectName(actualBase) === normalizeObjectName(wantedBase)
  );
}

function findFxOverlayPart(rendererToggleParts, tagOrName) {
  if (!tagOrName) return null;
  return (
    rendererToggleParts?.find((part) => {
      const tag = String(part.root?.userData?.toggleTag || "");
      const name = String(part.root?.userData?.skinnedPartName || "");
      return (
        fxOverlayNameMatches(tag, tagOrName) ||
        fxOverlayNameMatches(name, tagOrName)
      );
    }) || null
  );
}

function findFxOverlaySkinnedRoot(group, partName) {
  if (!group || !partName) return null;
  let found = null;
  group.traverse((object) => {
    if (found) return;
    const name = object.userData?.skinnedPartName;
    if (fxOverlayNameMatches(name, partName)) found = object;
  });
  return found;
}

function findSharedSkeletonParentBone(group, boneName, partName) {
  const preferredRoot = findFxOverlaySkinnedRoot(group, partName);
  const preferredBone = findObjectByName(preferredRoot, boneName);
  return preferredBone || findObjectByName(group, boneName);
}

function findParentAttachBone(group, boneName, partName) {
  if (partName) return findSharedSkeletonParentBone(group, boneName, partName);
  return findObjectByName(group, boneName);
}

function findFxOverlayParentBone({
  group,
  rendererToggleParts,
  parentBoneName,
  parentPartName,
  gatePart
}) {
  const preferredPart = findFxOverlayPart(rendererToggleParts, parentPartName);
  const preferredRoot =
    preferredPart?.root || findFxOverlaySkinnedRoot(group, parentPartName);
  const roots = [preferredRoot, gatePart?.root, group].filter(Boolean);
  for (const root of roots) {
    const bone = findObjectByName(root, parentBoneName);
    if (bone) return bone;
  }
  return null;
}

function reparentFxFollowerToBone(follower, bone) {
  if (!follower?.root || !bone) {
    return false;
  }
  if (follower.root.parent !== bone) {
    bone.add(follower.root);
  }
  follower.parentBone = bone;
  return true;
}

function reparentFxFollowerToPartBone(follower, part) {
  if (!part?.root || !follower?.parentBoneName) return false;
  const bone = findObjectByName(part.root, follower.parentBoneName);
  return reparentFxFollowerToBone(follower, bone);
}

function parseFxOverlayWindows(overlay) {
  const windows =
    overlay?.show_clip_windows ||
    overlay?.showClipWindows ||
    overlay?.clip_windows ||
    overlay?.clipWindows ||
    [];
  if (!Array.isArray(windows)) return [];
  return windows
    .map((window) => {
      const start = Number(
        window?.start ?? window?.start_time ?? window?.startTime ?? 0
      );
      const duration = Number(window?.duration ?? window?.length);
      const rawEnd =
        window?.end ?? window?.end_time ?? window?.endTime ?? null;
      const end = Number.isFinite(Number(rawEnd))
        ? Number(rawEnd)
        : Number.isFinite(duration)
          ? start + duration
          : Infinity;
      const clipName =
        window?.clip ?? window?.clip_name ?? window?.clipName ?? null;
      const pattern =
        window?.clip_pattern ?? window?.clipPattern ?? null;
      const patterns = [
        ...(Array.isArray(window?.clip_patterns)
          ? window.clip_patterns
          : []),
        ...(Array.isArray(window?.clipPatterns) ? window.clipPatterns : []),
        ...(pattern ? [pattern] : [])
      ];
      return {
        clipName: clipName ? String(clipName) : "",
        clipPatterns: patterns.map((item) => String(item)),
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : Infinity
      };
    })
    .filter(
      (window) =>
        (window.clipName || window.clipPatterns.length) &&
        Number.isFinite(window.start) &&
        window.end > window.start
    );
}

function findFxOverlayWindow(follower, clipName, time) {
  const windows = follower?.showClipWindows;
  if (!windows?.length) return null;
  const t = Number.isFinite(time) ? time : 0;
  for (const window of windows) {
    if (window.clipName && window.clipName !== clipName) continue;
    if (
      window.clipPatterns?.length &&
      !clipNameMatches(window.clipPatterns, clipName)
    ) {
      continue;
    }
    if (t + 1e-4 < window.start) continue;
    if (Number.isFinite(window.end) && t >= window.end - 1e-4) continue;
    return window;
  }
  return null;
}

function setFxFollowerVisibility(
  follower,
  visible,
  clipName,
  time,
  activationStart = null
) {
  if (!follower?.root) return;
  const wasVisible = follower.root.visible === true;
  follower.root.visible = !!visible;
  if (visible) {
    const start = Number.isFinite(activationStart) ? activationStart : time;
    if (
      !wasVisible ||
      follower.activatedClip !== clipName ||
      !Number.isFinite(follower.activatedAtClipTime) ||
      Math.abs(follower.activatedAtClipTime - start) > 1e-4
    ) {
      follower.activatedAtClipTime = start;
      follower.activatedClip = clipName;
    }
  } else {
    follower.activatedAtClipTime = null;
    follower.activatedClip = null;
  }
}

function hasWindowedFxFollowers(followers) {
  return followers?.some((follower) => follower.showClipWindows?.length);
}

function getSkinnedPartName(assetData, meshInfo, child) {
  const sourceName = meshInfo.name || "";
  let baseName = getMeshBaseName(sourceName);
  const material = Array.isArray(child.material)
    ? child.material[0]
    : child.material;
  const match = String(material?.name || "").match(/_sub(\d+)$/i);
  const submeshIndex = match ? Number.parseInt(match[1], 10) : NaN;
  const submeshOrder =
    meshInfo.submesh_order ||
    (baseName === "Body" ? assetData.submesh_order : null);
  const mappedName = Number.isInteger(submeshIndex)
    ? submeshOrder?.[submeshIndex]
    : null;
  if (mappedName) {
    return { name: mappedName, baseName: getMeshBaseName(mappedName) };
  }
  return { name: baseName, baseName };
}

function getGeometryGroup(geometry, materialIndex) {
  return (
    (geometry.groups || []).find(
      (group) => group.materialIndex === materialIndex
    ) || null
  );
}

function computeLegacyMouthUvBounds(geometry, group = null) {
  const uvAttr = geometry.attributes?.uv;
  if (!uvAttr) return null;

  const indexAttr = geometry.index;
  const start = group?.start ?? 0;
  const count = group?.count ?? (indexAttr ? indexAttr.count : uvAttr.count);
  let mU0 = 9,
    mU1 = -9,
    mV0 = 9,
    mV1 = -9;
  let found = false;

  for (let i = start; i < start + count; i++) {
    const vertexIndex = indexAttr ? indexAttr.getX(i) : i;
    const u = uvAttr.getX(vertexIndex);
    const v = uvAttr.getY(vertexIndex);
    if (v > 0.79 && u < 0.25) {
      mU0 = Math.min(mU0, u);
      mU1 = Math.max(mU1, u);
      mV0 = Math.min(mV0, v);
      mV1 = Math.max(mV1, v);
      found = true;
    }
  }

  return found
    ? { min: new THREE.Vector2(mU0, mV0), max: new THREE.Vector2(mU1, mV1) }
    : null;
}

function collectUvComponents(geometry, group = null) {
  const uvAttr = geometry.attributes?.uv;
  const posAttr = geometry.attributes?.position;
  if (!uvAttr || !posAttr) return null;

  const indexAttr = geometry.index;
  const start = group?.start ?? 0;
  const count = group?.count ?? (indexAttr ? indexAttr.count : uvAttr.count);
  const triangles = [];
  const vertexToTriangles = new Map();

  for (let i = start; i + 2 < start + count; i += 3) {
    const tri = [
      indexAttr ? indexAttr.getX(i) : i,
      indexAttr ? indexAttr.getX(i + 1) : i + 1,
      indexAttr ? indexAttr.getX(i + 2) : i + 2
    ];
    const triIndex = triangles.length;
    triangles.push(tri);
    for (const vertexIndex of tri) {
      const linked = vertexToTriangles.get(vertexIndex) || [];
      linked.push(triIndex);
      vertexToTriangles.set(vertexIndex, linked);
    }
  }

  if (!triangles.length) return null;

  const visited = new Set();
  const components = [];
  for (let i = 0; i < triangles.length; i++) {
    if (visited.has(i)) continue;

    const stack = [i];
    const vertices = new Set();
    visited.add(i);
    while (stack.length) {
      const triIndex = stack.pop();
      for (const vertexIndex of triangles[triIndex]) {
        vertices.add(vertexIndex);
        for (const next of vertexToTriangles.get(vertexIndex) || []) {
          if (!visited.has(next)) {
            visited.add(next);
            stack.push(next);
          }
        }
      }
    }

    let minU = Infinity,
      minV = Infinity,
      maxU = -Infinity,
      maxV = -Infinity;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    let sumZ = 0;
    let sumY = 0;
    for (const vertexIndex of vertices) {
      const u = uvAttr.getX(vertexIndex);
      const v = uvAttr.getY(vertexIndex);
      const x = posAttr.getX(vertexIndex);
      const y = posAttr.getY(vertexIndex);
      const z = posAttr.getZ(vertexIndex);
      minU = Math.min(minU, u);
      minV = Math.min(minV, v);
      maxU = Math.max(maxU, u);
      maxV = Math.max(maxV, v);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      sumY += y;
      sumZ += z;
    }

    components.push({
      min: new THREE.Vector2(minU, minV),
      max: new THREE.Vector2(maxU, maxV),
      meanY: sumY / vertices.size,
      meanZ: sumZ / vertices.size,
      width: maxX - minX,
      height: maxZ - minZ,
      yExtent: maxY - minY,
      positionMin: new THREE.Vector3(minX, minY, minZ),
      positionMax: new THREE.Vector3(maxX, maxY, maxZ),
      uvArea: (maxU - minU) * (maxV - minV),
      vertexCount: vertices.size
    });
  }

  return components;
}

// A "mouth-tile-region" component sits at v > 0.75 && u < 0.30 in the canonical
// EyeMouth atlas layout. It exists for single-face characters (CH0060/63/etc.)
// and on the auxiliary CH0288_EyeMouth.glb / CH0326_EyeMouth.glb for multi-face
// characters. It does NOT exist on the per-face EyeMouth submeshes of multi-face
// characters (CH0288_Face_EyeMouth.glb), so this function returns null there
// — the caller treats null as "no mouth tile in this submesh", lets the sclera
// shell render normally from MainTex, and the mouth lives on a separate GLB.
function findMouthRegion(components) {
  if (!components?.length) return null;
  const candidates = components.filter(
    (c) => c.min.y > 0.75 && c.max.x < 0.30
  );
  if (!candidates.length) return null;
  // Prefer the largest such cluster (most likely the lip outline).
  candidates.sort((a, b) => b.uvArea - a.uvArea);
  const c = candidates[0];
  return {
    min: c.min,
    max: c.max,
    positionMin: c.positionMin,
    positionMax: c.positionMax
  };
}

// Returns { mouth } where mouth is { min, max } or null.
//
// The mouth region is the canonical mouth-tile UV cluster of the EyeMouth
// atlas (v > 0.75, u < 0.30) — present on single-face EyeMouth meshes and
// on the auxiliary CH0288_EyeMouth.glb / CH0326_EyeMouth.glb. It is absent
// on multi-face per-face submeshes (CH0288_Face_EyeMouth, etc.) where the
// mouth has been split into its own GLB. For those, mouth=null is the
// correct outcome — the historical heuristic of "lowest meanZ" picked the
// sclera UV cluster instead, causing the sclera-tile fragments to be
// discarded by the mouth-tile-remap branch and the white-of-eye to vanish.
//
// Falls back to legacy threshold-based scan when component analysis fails.
function computeEyeMouthRegions(geometry, group = null) {
  const components = collectUvComponents(geometry, group);
  let mouth = findMouthRegion(components);
  if (!mouth) {
    mouth = computeLegacyMouthUvBounds(geometry, group);
  }
  return { mouth };
}

function cloneUvBounds(bounds) {
  if (!bounds) return null;
  return {
    min: bounds.min.clone(),
    max: bounds.max.clone()
  };
}

function computeMouthSampleUvBounds(bounds) {
  if (!bounds) return null;
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  if (!(width > 0 && height > 0)) return cloneUvBounds(bounds);

  // Some EyeMouth meshes (CH0307) pack the same full-width mouth geometry into
  // half of the canonical mouth UV cell. Hit-test the real component, but sample
  // the tile against the restored canonical-width cell so the lip curve does not
  // split across the mirrored mouth topology.
  if (width < height * 0.85) {
    const targetWidth = Math.min(0.30, width * 2.0);
    if (bounds.min.x > 0.08) {
      return {
        min: new THREE.Vector2(
          Math.max(0, bounds.max.x - targetWidth),
          bounds.min.y
        ),
        max: bounds.max.clone()
      };
    }
    if (bounds.max.x < 0.17) {
      return {
        min: bounds.min.clone(),
        max: new THREE.Vector2(
          Math.min(0.30, bounds.min.x + targetWidth),
          bounds.max.y
        )
      };
    }
  }

  return cloneUvBounds(bounds);
}

function shouldSampleMouthTileByPosition(bounds) {
  if (!bounds?.positionMin || !bounds?.positionMax) return false;
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  return width > 0 && height > 0 && width < height * 0.85;
}

function bleedTransparentMouthTileRgb(ctx, width, height) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const source = new Uint8ClampedArray(data);
  const neighborOffsets = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1]
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (source[offset + 3] !== 0) continue;

      for (const [dx, dy] of neighborOffsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const neighborOffset = (ny * width + nx) * 4;
        if (source[neighborOffset + 3] === 0) continue;
        data[offset] = source[neighborOffset];
        data[offset + 1] = source[neighborOffset + 1];
        data[offset + 2] = source[neighborOffset + 2];
        break;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function resolveMouthTileIndex(mouthTexST, cols, rows) {
  const offset = mouthTexST?.offset || [0, 0];
  const offsetX = Array.isArray(offset) ? offset[0] : offset.x;
  const offsetY = Array.isArray(offset) ? offset[1] : offset.y;
  const col = THREE.MathUtils.clamp(
    Math.floor((offsetX || 0) * cols + 1e-4),
    0,
    cols - 1
  );
  const unityRow = THREE.MathUtils.clamp(
    Math.floor((offsetY || 0) * rows + 1e-4),
    0,
    rows - 1
  );
  const canvasRow = rows - 1 - unityRow;
  return canvasRow * cols + col;
}

function mouthTileCodeToIndex(code, cols, rows) {
  if (!Number.isFinite(code) || cols <= 0 || rows <= 0) return null;
  const intCode = Math.trunc(code);
  const col = intCode % 100;
  const unityRow = Math.floor(intCode / 100);
  if (col < 0 || col >= cols || unityRow < 0 || unityRow >= rows) return null;
  return (rows - 1 - unityRow) * cols + col;
}

// Strip the Bip001 root translation track from CH0336's
// `Cafe_my_carrier_01_door_01_01[_Idle]` clips. Those clips bake a root offset
// that places Yuzu inside the Carrier mech cabin (z ≈ -1.7..-2.0). Since the
// viewer doesn't need to load the cabin, the translation just drops her below the
// floor. Removing the track lets the rest of the animation play in place.
function stripCH0336RootTranslation(clips) {
  for (const clip of clips || []) {
    const name = clip?.name || "";
    if (!/Cafe_my_carrier_01_door_01_01/i.test(name)) continue;
    const tracks = clip.tracks || [];
    clip.tracks = tracks.filter(
      (track) => !/^Bip001\.(position|translation)(?:\[|$|\.)/i.test(track.name)
    );
  }
}

function buildExpressionTracks(animations) {
  const tracks = new Map();
  for (const animation of animations || []) {
    const mouthEvents = [];
    const rendererEvents = [];
    for (const event of animation.events || []) {
      const functionName = event.function || event.functionName || "";
      const time = Number(event.time);
      if (!Number.isFinite(time)) continue;
      if (functionName === "SetMouthTile" || functionName === "SetHorizontallyFlippedMouthTile") {
        const tileCode = Number.parseInt(
          event.int ?? event.intParameter ?? event.data,
          10
        );
        if (!Number.isFinite(tileCode)) continue;
        mouthEvents.push({
          time: Math.max(0, time),
          tileCode,
          flipped: functionName === "SetHorizontallyFlippedMouthTile"
        });
      } else if (
        functionName === "AniEvt_EnableChildRenderer" ||
        functionName === "AniEvt_DisableChildRenderer"
      ) {
        const childIndex = Number.parseInt(
          event.int ?? event.intParameter ?? event.data,
          10
        );
        if (!Number.isFinite(childIndex)) continue;
        rendererEvents.push({
          time: Math.max(0, time),
          childIndex,
          enable: functionName === "AniEvt_EnableChildRenderer",
        });
      }
    }
    if (mouthEvents.length || rendererEvents.length) {
      mouthEvents.sort((a, b) => a.time - b.time);
      rendererEvents.sort((a, b) => a.time - b.time);
      tracks.set(animation.name, {
        mouth: mouthEvents,
        renderer: rendererEvents,
      });
    }
  }
  return tracks;
}

function collectAnimationSummaries(assetData) {
  const byName = new Map();
  for (const animation of assetData?.animations || []) {
    if (animation?.name && !byName.has(animation.name)) {
      byName.set(animation.name, animation);
    }
  }
  for (const meshInfo of assetData?.skinned_meshes || []) {
    for (const animation of meshInfo?.animations || []) {
      if (!animation?.name) continue;
      const current = byName.get(animation.name);
      // Prefer the summary that carries events/renderer toggles, but keep
      // the first one otherwise. NP0283 field/cafe exports store animation
      // summaries under skinned_meshes only, so top-level assetData.animations
      // is empty there.
      if (
        !current ||
        ((!current.events?.length && animation.events?.length) ||
          (!current.renderer_toggles && animation.renderer_toggles))
      ) {
        byName.set(animation.name, animation);
      }
    }
  }
  return [...byName.values()];
}

function expressionEventAtTime(events, time) {
  if (!events?.length) return null;
  let selected = null;
  const t = Number.isFinite(time) ? time : 0;
  for (const event of events) {
    if (event.time <= t + 1e-4) {
      selected = event;
    } else {
      break;
    }
  }
  return selected;
}

function applyMouthTileCode(material, tileCode, flipped = false) {
  const tiles = material?.userData?.mouthTiles;
  if (!tiles?.length) return false;
  if (material.userData.hasMouthRegion === false) return false;

  const cols = material.userData.mouthCols || 1;
  const rows = material.userData.mouthRows || 1;
  const index = mouthTileCodeToIndex(tileCode, cols, rows);
  const tile = index == null ? null : tiles[index];
  if (!tile) return false;

  // Flip is a per-event property, must be re-applied even when the tile
  // index hasn't changed (e.g. consecutive events on the same tile that
  // toggle the horizontal flip).
  if (material.uniforms.u_MouthFlipX) {
    material.uniforms.u_MouthFlipX.value = !!flipped;
  }
  material.userData.currentMouthTileFlipped = !!flipped;

  if (material.userData.currentMouthTileIndex === index) {
    material.userData.currentMouthTileCode = tileCode;
    return true;
  }
  material.uniforms.u_MouthTileTex.value = tile;
  material.uniforms.u_HasMouthTileTex.value = true;
  material.userData.currentMouthTileCode = tileCode;
  material.userData.currentMouthTileIndex = index;
  return true;
}

function applyDefaultMouthTile(material) {
  const tiles = material?.userData?.mouthTiles;
  if (!tiles?.length) return false;
  if (material.userData.hasMouthRegion === false) return false;
  const defaultIndex = Number.isInteger(material.userData.defaultMouthTileIndex)
    ? material.userData.defaultMouthTileIndex
    : 0;
  const index = THREE.MathUtils.clamp(defaultIndex, 0, tiles.length - 1);
  const tile = tiles[index] || tiles[0];
  if (!tile) return false;

  if (material.uniforms.u_MouthFlipX) {
    material.uniforms.u_MouthFlipX.value = false;
  }
  material.userData.currentMouthTileFlipped = false;

  if (material.userData.currentMouthTileIndex !== index) {
    material.uniforms.u_MouthTileTex.value = tile;
    material.uniforms.u_HasMouthTileTex.value = true;
    material.userData.currentMouthTileIndex = index;
  }
  material.userData.currentMouthTileCode = null;
  return true;
}

// Walk through Ani(Enable|Disable)ChildRenderer events up to `time` and
// derive the visibility for each child index. The Unity AnimationClip
// emits one final state per index, so we keep the last seen value. If a
// clip has no events at all for an index, its target stays at the value
// it was set to by the previously played clip (matches game runtime).
function applyExpressionRendererState(targets, events, time) {
  if (!targets?.size) return;
  const decided = new Map();
  if (events?.length) {
    const t = Number.isFinite(time) ? time : 0;
    for (const event of events) {
      if (event.time > t + 1e-4) break;
      decided.set(event.childIndex, event.enable);
    }
  }
  for (const [childIndex, roots] of targets) {
    if (!decided.has(childIndex)) continue;
    const enable = decided.get(childIndex);
    for (const root of roots) {
      root.visible = enable;
    }
  }
}

// Sample a Renderer.m_Enabled curve at `time` (seconds into the clip).
// Curves are step-interpolated in Unity for boolean-like enabled state:
// the value holds until the next sample. Returns null if there are no
// samples at or before `time`, signalling the runtime to leave the
// renderer at its current visibility (i.e. the previous clip's value).
function sampleRendererToggleCurve(samples, time) {
  if (!samples?.length) return null;
  const t = Number.isFinite(time) ? time : 0;
  let current = null;
  for (const sample of samples) {
    if (sample.time > t + 1e-4) break;
    current = sample.enabled;
  }
  return current;
}

// Apply per-clip Renderer.m_Enabled samples to each registered renderer
// root. `parts` is an array of `{root, clips: Map<clipName, samples>}`.
// Renderers that don't list a curve for `clipName` keep their last
// applied visibility, mirroring Unity's "no curve = no override" rule.
function applyRendererToggleParts(parts, clipName, time) {
  if (!parts?.length) return;
  for (const part of parts) {
    const samples = part.clips?.get(clipName);
    if (!samples) continue;
    const decided = sampleRendererToggleCurve(samples, time);
    if (decided == null) continue;
    part.root.visible = !!decided;
    // FX overlays gated by this part follow the same on/off clock as
    // the part itself, while also tracking the timestamp the part
    // first became visible during this clip so spin can be referenced
    // from there.
    const followers = part.fxFollowers;
    if (followers?.length) {
      for (const follower of followers) {
        if (follower.showClipWindows?.length) continue;
        const wasVisible = follower.root.visible === true;
        follower.root.visible = !!decided;
        if (decided && !wasVisible) {
          follower.activatedAtClipTime = time;
          follower.activatedClip = clipName;
        }
        if (!decided) {
          follower.activatedAtClipTime = null;
          follower.activatedClip = null;
        }
      }
    }
  }
}

function applyFxOverlayWindowVisibility(followers, clipName, time) {
  if (!followers?.length) return;
  for (const follower of followers) {
    if (!follower.showClipWindows?.length) continue;
    const window = findFxOverlayWindow(follower, clipName, time);
    setFxFollowerVisibility(
      follower,
      !!window,
      clipName,
      time,
      window?.start
    );
  }
}

function parseFxOverlaySpinAxis(source, fallback = null) {
  const raw =
    source?.spin_axis_local ||
    source?.spinAxisLocal ||
    source?.spin_axis ||
    source?.spinAxis;
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? [raw.x, raw.y, raw.z]
      : null;
  if (values?.length >= 3) {
    const axis = new THREE.Vector3(
      Number(values[0]),
      Number(values[1]),
      Number(values[2])
    );
    if (axis.lengthSq() > 1e-8) return axis.normalize();
  }
  return fallback ? fallback.clone() : null;
}

function getInitialRendererVisible(meshInfo) {
  const value =
    meshInfo?.initial_renderer_visible ??
    meshInfo?.initialRendererVisible;
  return typeof value === "boolean" ? value : true;
}

// Load fx_overlays manifest entries (e.g. CH0145 cutin spiral eyes).
// Each overlay attaches one or more mesh instances to a target bone of
// the character group, gated by an existing renderer-toggle part. The
// overlay material reuses an already-loaded atlas texture from the
// shared texCache rather than uploading a duplicate, mirroring how the
// FX_MAT_Eyes_01 material in the truth bundle binds the same Face
// atlas as the SkinnedMeshRenderer it complements.
async function loadFxOverlays({
  group,
  fxOverlays,
  basePath,
  texCache,
  rendererToggleParts,
  loader
}) {
  if (!Array.isArray(fxOverlays) || !fxOverlays.length) {
    return [];
  }
  const meshLoader = loader || new GLTFLoader();
  const followers = [];
  for (const overlay of fxOverlays) {
    if (!overlay?.instances?.length) continue;
    const overlaySpinAxis = parseFxOverlaySpinAxis(overlay, FX_DEFAULT_SPIN_AXIS);
    const gatePart = overlay.gate_part_tag
      ? rendererToggleParts.find(
          (part) => part.root?.userData?.toggleTag === overlay.gate_part_tag
        )
      : null;
    const parentBone = overlay.parent_bone
      ? findFxOverlayParentBone({
          group,
          rendererToggleParts,
          parentBoneName: overlay.parent_bone,
          parentPartName: overlay.parent_part_name,
          gatePart
        })
      : null;
    if (!parentBone) {
      console.warn(
        `[fx_overlays] ${overlay.id}: parent bone '${overlay.parent_bone}' not found`
      );
      continue;
    }
    const atlasTex = overlay.atlas_texture_key
      ? texCache[overlay.atlas_texture_key]
      : null;
    if (!atlasTex) {
      console.warn(
        `[fx_overlays] ${overlay.id}: atlas texture '${overlay.atlas_texture_key}' missing in texCache`
      );
      continue;
    }
    const overlayRoot = new THREE.Group();
    overlayRoot.name = `fx_overlay/${overlay.id}`;
    // Hidden until the gating renderer toggle flips on.
    overlayRoot.visible = false;
    const instanceMeshes = [];
    for (const instance of overlay.instances) {
      try {
        const meshUrl = withCacheVersion(basePath + instance.mesh_file);
        const gltf = await new Promise((resolve, reject) => {
          meshLoader.load(meshUrl, resolve, undefined, reject);
        });
        // Material: opaque MeshBasicMaterial sharing the Face atlas.
        // FX_MAT_Eyes_01 uses _SrcBlend=1 _DstBlend=0 _ZWrite=1 with
        // _Color=white. The face SMR also writes to the depth buffer
        // at the same Z range, so we lift the FX out of the depth
        // fight by skipping depthTest and bumping renderOrder. This
        // matches how Unity's particle system would draw the mesh
        // particles after the head SMR within the same opaque queue.
        const fxMaterial = new THREE.MeshBasicMaterial({
          map: atlasTex,
          color: 0xffffff,
          side: THREE.DoubleSide,
          transparent: false,
          depthTest: false,
          depthWrite: false
        });
        gltf.scene.traverse((child) => {
          if (!child.isMesh) return;
          child.material = fxMaterial;
          child.frustumCulled = false;
          child.renderOrder = 100;
        });
        const instanceRoot = gltf.scene;
        instanceRoot.name = `fx_overlay/${overlay.id}/${instance.name}`;
        if (Array.isArray(instance.local_position)) {
          instanceRoot.position.fromArray(instance.local_position);
        }
        if (Array.isArray(instance.local_rotation_quat)) {
          const [qx, qy, qz, qw] = instance.local_rotation_quat;
          instanceRoot.quaternion.set(qx, qy, qz, qw);
        }
        const baseScale = Number.isFinite(instance.particle_size)
          ? instance.particle_size
          : 1;
        instanceRoot.scale.setScalar(baseScale);
        // Stash the rest-pose quaternion so the per-frame spin update
        // can compose a local-axis rotation against the original tilt
        // instead of accumulating drift each frame.
        instanceRoot.userData.fxRestQuaternion = instanceRoot.quaternion.clone();
        instanceRoot.userData.fxSpinAxis = parseFxOverlaySpinAxis(
          instance,
          overlaySpinAxis
        );
        instanceRoot.userData.fxBaseScale = baseScale;
        overlayRoot.add(instanceRoot);
        instanceMeshes.push(instanceRoot);
      } catch (err) {
        console.warn(
          `[fx_overlays] ${overlay.id}: failed to load ${instance.mesh_file}:`,
          err
        );
      }
    }
    if (!instanceMeshes.length) continue;
    parentBone.add(overlayRoot);
    const follower = {
      id: overlay.id,
      root: overlayRoot,
      instances: instanceMeshes,
      parentBoneName: overlay.parent_bone || "",
      parentPartName: overlay.parent_part_name || "",
      showClipWindows: parseFxOverlayWindows(overlay),
      parentBone,
      spinAxis: overlaySpinAxis,
      spinSpeedRadPerSec: Number.isFinite(overlay.spin_speed_rad_per_sec)
        ? overlay.spin_speed_rad_per_sec
        : 0,
      activatedAtClipTime: null,
      activatedClip: null
    };
    overlayRoot.userData.fxOverlayFollower = follower;
    followers.push(follower);
    // Gate the follower against the matching renderer-toggle part.
    // The gate part may still be deferred (lazy-loaded face SMRs are
    // common). If so, queue the follower in a pending map keyed by
    // gate tag and let the toggle-part registration site pick it up.
    if (overlay.gate_part_tag) {
      if (gatePart) {
        if (!follower.showClipWindows?.length) {
          reparentFxFollowerToPartBone(follower, gatePart);
        }
        if (!Array.isArray(gatePart.fxFollowers)) gatePart.fxFollowers = [];
        gatePart.fxFollowers.push(follower);
      } else {
        if (!group.userData.fxOverlayPendingByGateTag) {
          group.userData.fxOverlayPendingByGateTag = new Map();
        }
        const queue =
          group.userData.fxOverlayPendingByGateTag.get(overlay.gate_part_tag) ||
          [];
        queue.push(follower);
        group.userData.fxOverlayPendingByGateTag.set(
          overlay.gate_part_tag,
          queue
        );
        console.info(
          `[fx_overlays] ${overlay.id}: gate '${overlay.gate_part_tag}' deferred, ` +
            `will attach when toggle part registers`
        );
      }
    }
  }
  return followers;
}

// Per-frame spin update for FX overlay instances. Called from the
// scene animation loop; rotates each instance around its configured
// local axis by (clipTime - activatedAtClipTime) * spinSpeed,
// preserving the rest quaternion as the base.
const FX_DEFAULT_SPIN_AXIS = new THREE.Vector3(0, 0, 1);
const FX_SPIN_QUAT = new THREE.Quaternion();
export function applyFxOverlaySpin(followers, animationState) {
  if (!followers?.length) return;
  const action =
    animationState?.currentActions?.find((a) => a.enabled) ||
    animationState?.currentActions?.[0];
  const clipTime = Number.isFinite(action?.time) ? action.time : 0;
  for (const follower of followers) {
    if (!follower.root.visible) continue;
    const start = Number.isFinite(follower.activatedAtClipTime)
      ? follower.activatedAtClipTime
      : clipTime;
    const elapsed = Math.max(0, clipTime - start);
    const angle = follower.spinSpeedRadPerSec * elapsed;
    for (const instance of follower.instances) {
      const rest = instance.userData.fxRestQuaternion;
      if (!rest) continue;
      const axis =
        instance.userData.fxSpinAxis || follower.spinAxis || FX_DEFAULT_SPIN_AXIS;
      FX_SPIN_QUAT.setFromAxisAngle(axis, angle);
      instance.quaternion.copy(rest).multiply(FX_SPIN_QUAT);
    }
  }
}

function isRendererEventControlledMesh(meshInfo) {
  const explicit =
    meshInfo?.event_renderer_controlled ??
    meshInfo?.eventRendererControlled;
  if (typeof explicit === "boolean") return explicit;

  const name = getMeshBaseName(meshInfo?.name || "");
  return /^Face\d*$/i.test(name);
}

function enableSkinningMaterial(material) {
  if (!material) return material;
  if (Array.isArray(material)) {
    for (const item of material) enableSkinningMaterial(item);
    return material;
  }
  material.skinning = true;
  material.defines = { ...(material.defines || {}), USE_SKINNING: "" };
  material.needsUpdate = true;
  return material;
}

function enableVertexColorMaterial(material, geometry) {
  if (!material || !geometry?.attributes?.color) return material;
  if (Array.isArray(material)) {
    for (const item of material) enableVertexColorMaterial(item, geometry);
    return material;
  }
  material.vertexColors = true;
  if (geometry.attributes.color.itemSize >= 4) {
    material.vertexAlphas = true;
  }
  material.needsUpdate = true;
  return material;
}

function shouldUseMeshVertexColors(meshInfo) {
  return !(
    meshInfo?.ignore_vertex_colors === true ||
    meshInfo?.ignoreVertexColors === true
  );
}

function flipGeometryUvYOnce(geometry) {
  const uvAttr = geometry?.attributes?.uv;
  if (!uvAttr || FLIPPED_UV_ATTRIBUTES.has(uvAttr)) return;
  for (let i = 0; i < uvAttr.count; i++) {
    uvAttr.setY(i, 1.0 - uvAttr.getY(i));
  }
  uvAttr.needsUpdate = true;
  FLIPPED_UV_ATTRIBUTES.add(uvAttr);
  geometry.userData.viewerUvYFlipped = true;
}

function makeHiddenMaterial() {
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false
  });
  material.visible = false;
  return material;
}

function makeOutlineMesh(source, material) {
  if (!source.isSkinnedMesh) {
    return new THREE.Mesh(source.geometry, material);
  }
  const outline = new THREE.SkinnedMesh(source.geometry, material);
  outline.bind(source.skeleton, source.bindMatrix);
  outline.bindMatrix.copy(source.bindMatrix);
  outline.bindMatrixInverse.copy(source.bindMatrixInverse);
  outline.frustumCulled = source.frustumCulled;
  return outline;
}

function createOutlineMaterial(name, baseName, built) {
  // Hair alpha uses MX/C-Hair-Transparent so buildPartMaterial flips
  // `isOverlay` to true via `finalTransparent` (line ~2101). That flag was
  // originally meant for EyeMouth/Eyebrow decals, not for primary meshes
  // that just happen to render through a transparent pass. Allow Hair through
  // so it gets a proper backface outline like the body.
  const isHair = baseName === "Hair" || name === "Hair";
  const skipOutline =
    (built.isOverlay && !isHair) ||
    built.isHaloMesh ||
    built.isSkinnedProp ||
    built.noFaceTexture;
  if (skipOutline) return null;

  const ot =
    built.overrides.u_OutlineTint || DEFAULT_UNIFORMS.u_OutlineTint.clone();
  const thickness = name === "Hair" ? 0.0005 : 0.001;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      u_OutlineThickness: { value: thickness },
      u_OutlineZCorrection: { value: 0.0 },
      u_OutlineTint: { value: ot },
      u_MainTex: { value: built.mainTex },
      u_HasMainTex: { value: !!built.mainTex }
    },
    vertexShader: outlineVertSrc,
    fragmentShader: outlineFragSrc,
    side: THREE.BackSide
  });
  material.userData.isOutlineMaterial = true;
  return material;
}

function attachOutlineMesh(source, material) {
  const outline = makeOutlineMesh(source, material);
  outline.userData.isOutlineMesh = true;
  outline.userData.outlineSourceMeshName = source.name || "";
  outline.userData.outlineSourceMeshBaseName = source.userData?.meshBaseName || "";
  if (!Array.isArray(source.userData.outlineMeshes)) {
    source.userData.outlineMeshes = [];
  }
  source.userData.outlineMeshes.push(outline);
  outline.renderOrder = Math.max(0, (source.renderOrder || 0) - 0.01);
  source.parent.add(outline);
  return outline;
}

function clipNameMatches(patterns, clipName) {
  const name = String(clipName || "");
  return (patterns || []).some((pattern) => {
    const value = String(pattern || "");
    if (!value) return false;
    try {
      return new RegExp(value, "i").test(name);
    } catch (e) {
      return name.toLowerCase().includes(value.toLowerCase());
    }
  });
}

function shouldShowVisiblePart(rule, clipName) {
  if (!rule) return true;
  const showPatterns = rule.show_clip_patterns || rule.showClipPatterns || [];
  const hidePatterns = rule.hide_clip_patterns || rule.hideClipPatterns || [];
  let visible = rule.default_visible ?? rule.defaultVisible ?? true;

  if (showPatterns.length) {
    visible = clipNameMatches(showPatterns, clipName);
  }
  if (clipNameMatches(hidePatterns, clipName)) {
    visible = false;
  }
  return !!visible;
}

function createAnimationState(
  parts,
  expressionTracks = new Map(),
  expressionMaterials = [],
  visibleParts = [],
  options = {},
  expressionRendererTargets = new Map(),
  rendererToggleParts = [],
  fxOverlayFollowers = []
) {
  if (!parts.length) return null;
  const mixers = [];
  const actionsByName = new Map();
  const clipRecordsByName = new Map();

  const state = {
    mixers,
    clipNames: [],
    actionsByName,
    currentActions: [],
    activeClip: "",
    expressionTracks,
    expressionMaterials,
    expressionRendererTargets,
    rendererToggleParts,
    fxOverlayFollowers,
    visibleParts,
    lastExpressionClip: "",
    lastExpressionTime: -1,
    playing: true,
    speed: 1,
    addPart(part) {
      if (!part?.root || !part?.clips?.length) return;
      const mixer = new THREE.AnimationMixer(part.root);
      mixers.push(mixer);
      const clipAliases = part.clipAliases || part.clip_aliases || {};
      const aliasEntries =
        clipAliases && typeof clipAliases === "object"
          ? Object.entries(clipAliases)
          : [];
      for (const clip of part.clips) {
        const recordNames = new Set([clip.name]);
        for (const [aliasName, sourceName] of aliasEntries) {
          if (sourceName === clip.name) recordNames.add(aliasName);
        }
        for (const recordName of recordNames) {
          const records = clipRecordsByName.get(recordName) || [];
          records.push({ mixer, clip, action: null });
          clipRecordsByName.set(recordName, records);
        }
      }
      state.clipNames = [
        ...new Set([...(options.clipNames || []), ...clipRecordsByName.keys()])
      ].sort();
    },
    actionsForClip(name) {
      const records = clipRecordsByName.get(name) || [];
      if (!records.length) return [];
      const actions = records.map((record) => {
        if (!record.action)
          record.action = record.mixer.clipAction(record.clip);
        return record.action;
      });
      actionsByName.set(name, actions);
      return actions;
    },
    async playClip(name, opts = {}) {
      if (!name) return;
      if (!opts.skipLazyLoad && options.lazyLoadForClip) {
        await options.lazyLoadForClip(name, state);
      }
      const actions = state.actionsForClip(name);
      if (!actions.length) {
        options.modelFxProvider?.()?.reset?.();
        state.activeClip = name;
        state.updateVisibility();
        state.updateExpressions(true);
        return;
      }
      options.modelFxProvider?.()?.reset?.();
      for (const action of state.currentActions) action.stop();
      state.currentActions = actions.map((action) => {
        action.reset();
        action.enabled = true;
        action.paused = !state.playing;
        action.play();
        return action;
      });
      state.activeClip = name;
      state.lastExpressionClip = "";
      state.updateVisibility();
      state.updateExpressions(true);
    },
    setPlaying(playing) {
      state.playing = !!playing;
      for (const action of state.currentActions) action.paused = !state.playing;
      if (state.playing) state.updateExpressions(true);
    },
    setSpeed(speed) {
      state.speed = Number.isFinite(speed) ? speed : 1;
    },
    getDuration() {
      let max = 0;
      for (const action of state.currentActions) {
        const dur = action.getClip?.()?.duration || 0;
        if (dur > max) max = dur;
      }
      return max;
    },
    getTime() {
      const action = state.currentActions[0];
      const t = Number(action?.time);
      return Number.isFinite(t) ? t : 0;
    },
    seek(time) {
      const duration = state.getDuration();
      if (!duration) return;
      const clamped = Math.max(0, Math.min(time, duration));
      for (const action of state.currentActions) {
        action.enabled = true;
        action.time = clamped;
      }
      // mixer.update(0) re-applies the pose at the new time without advancing it
      for (const mixer of mixers) mixer.update(0);
      state.updateExpressions(true);
    },
    updateVisibility() {
      for (const part of state.visibleParts) {
        part.root.visible = shouldShowVisiblePart(part.rule, state.activeClip);
      }
    },
    updateExpressions(force = false) {
      if (
        !state.expressionMaterials.length &&
        !state.expressionRendererTargets.size &&
        !state.rendererToggleParts.length &&
        !hasWindowedFxFollowers(state.fxOverlayFollowers)
      )
        return;
      const track = state.expressionTracks.get(state.activeClip);
      const action =
        state.currentActions.find((item) => item.enabled) ||
        state.currentActions[0];
      const actionTime = Number(action?.time);
      const time = Number.isFinite(actionTime) ? actionTime : 0;
      if (
        !force &&
        state.lastExpressionClip === state.activeClip &&
        Math.abs(state.lastExpressionTime - time) < 1e-4
      ) {
        return;
      }
      state.lastExpressionClip = state.activeClip;
      state.lastExpressionTime = time;

      if (state.expressionMaterials.length) {
        const mouthEvent = track
          ? expressionEventAtTime(track.mouth, time)
          : null;
        if (!mouthEvent) {
          for (const material of state.expressionMaterials) {
            applyDefaultMouthTile(material);
          }
        } else {
          for (const material of state.expressionMaterials) {
            applyMouthTileCode(material, mouthEvent.tileCode, !!mouthEvent.flipped);
          }
        }
      }

      if (state.expressionRendererTargets.size) {
        applyExpressionRendererState(
          state.expressionRendererTargets,
          track?.renderer,
          time
        );
      }

      if (state.rendererToggleParts.length) {
        applyRendererToggleParts(
          state.rendererToggleParts,
          state.activeClip,
          time
        );
      }
      applyFxOverlayWindowVisibility(
        state.fxOverlayFollowers,
        state.activeClip,
        time
      );
    },
    stop() {
      for (const mixer of mixers) mixer.stopAllAction();
      state.currentActions = [];
    }
  };

  for (const part of parts) {
    state.addPart(part);
  }
  if (options.clipNames?.length) {
    state.clipNames = [...new Set(options.clipNames)].sort();
  }

  const preferred = pickDefaultAnimationClip(state.clipNames);
  void state.playClip(preferred, { skipLazyLoad: true });
  return state;
}

function makeHaloTint(matData, profile) {
  const colors = matData?.colors || {};
  // Glow colors are additive shader controls; using them as base tint over-pinks textured halos.
  const tint = colors._Tint ||
    colors._SimpleBaseColor ||
    colors._BaseColor ||
    colors._Color || { r: 1, g: 1, b: 1, a: 1 };
  return new THREE.Vector4(
    tint.r * profile.tint.x,
    tint.g * profile.tint.y,
    tint.b * profile.tint.z,
    tint.a * profile.tint.w
  );
}

function applyMaterialRampParams(material, matData) {
  if (!matData?.floats) return;
  const fromIdx = matData.floats._FromHaloIndex;
  const toIdx = matData.floats._ToHaloIndex;
  const blendRatio = matData.floats._BlendRatio;
  if (fromIdx == null && toIdx == null && blendRatio == null) return;
  material.uniforms.u_UseRamp.value = true;
  material.uniforms.u_FromHaloIndex.value = fromIdx ?? 0.0;
  material.uniforms.u_ToHaloIndex.value = toIdx ?? fromIdx ?? 0.0;
  material.uniforms.u_BlendRatio.value = blendRatio ?? 0.0;
}

function haloRootQuaternion(assetData) {
  const tiltDeg =
    assetData?.halo_follow?.placement_tilt_deg ??
    assetData?.halo_anchor?.placement_tilt_deg ??
    assetData?.halo_transform?.placement_tilt_deg;
  if (Number.isFinite(tiltDeg)) {
    const q = new THREE.Quaternion();
    q.setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      -THREE.MathUtils.degToRad(tiltDeg)
    );
    return q;
  }

  return (
    quaternionFromData(assetData?.halo_anchor?.rotation) ||
    quaternionFromData(assetData?.halo_transform?.rotation)
  );
}

function haloParticleRootQuaternion(assetData) {
  return haloRootQuaternion(assetData);
}

function quaternionFromData(data) {
  if (!data) return null;
  const quat = new THREE.Quaternion(
    data.x ?? 0,
    data.y ?? 0,
    data.z ?? 0,
    data.w ?? 1
  );
  return quat.lengthSq() > 1e-8 ? quat.normalize() : null;
}

function applyStaticHaloSourceRotation(haloRoot, assetData) {
  if (assetData?.halo_anchor?.rotation) return;
  const quat = quaternionFromData(assetData?.halo_transform?.rotation);
  if (quat) haloRoot.quaternion.copy(quat);
}

function vector3FromPosition(pos) {
  if (!pos) return null;
  if (pos instanceof THREE.Vector3) return pos.clone();
  if (Array.isArray(pos))
    return new THREE.Vector3(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0);
  return new THREE.Vector3(pos.x ?? 0, pos.y ?? 0, pos.z ?? 0);
}

function directionInLocalRootSpace(localRoot, object, localDirection) {
  const originWorld = new THREE.Vector3();
  const endWorld = localDirection.clone();
  const originLocal = new THREE.Vector3();
  const endLocal = new THREE.Vector3();
  object.updateWorldMatrix(true, false);
  localRoot.updateWorldMatrix(true, true);
  object.getWorldPosition(originWorld);
  object.localToWorld(endWorld);
  originLocal.copy(originWorld);
  endLocal.copy(endWorld);
  localRoot.worldToLocal(originLocal);
  localRoot.worldToLocal(endLocal);
  return endLocal.sub(originLocal);
}

function yawFromLocalRootDirection(direction) {
  if (!direction || direction.lengthSq() < 1e-10) return null;
  // The character group is in exported mesh space here: local Z is model up.
  const flat = new THREE.Vector2(direction.x, direction.y);
  if (flat.lengthSq() < 1e-10) return null;
  return Math.atan2(flat.y, flat.x);
}

function localRootQuaternionForObject(localRoot, object) {
  const rootWorldQuat = new THREE.Quaternion();
  const objectWorldQuat = new THREE.Quaternion();
  localRoot.updateWorldMatrix(true, true);
  object.updateWorldMatrix(true, false);
  localRoot.getWorldQuaternion(rootWorldQuat).invert();
  object.getWorldQuaternion(objectWorldQuat);
  return rootWorldQuat.multiply(objectWorldQuat).normalize();
}

function shouldUseFullHaloFollowRotation(haloFollow) {
  // TargetRelativeRotation marks Unity's FxFollower full-rotation path.
  return !!haloFollow?.target_relative_rotation && !haloFollow?.fix_y_rotation;
}

function getManifestHeadPosition(assetData) {
  return vector3FromPosition(
    assetData?.head_transform?.position ||
      assetData?.head_anchor?.position ||
      assetData?.halo_anchor?.head_position
  );
}

function computeMeshBounds(root, predicate) {
  const box = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  root.traverse((child) => {
    if (!child.isMesh || !predicate(child)) return;
    box.expandByObject(child);
  });
  return box.isEmpty() ? null : box;
}

function isPrimaryCharacterMesh(child) {
  const baseName = child.userData?.meshBaseName;
  return baseName === "Body" || HEAD_MESH_BASE_NAMES.has(baseName);
}

function computeSpawnBounds(group) {
  return (
    computeMeshBounds(group, isPrimaryCharacterMesh) ||
    computeMeshBounds(
      group,
      (child) => !child.userData?.isHaloMesh && !child.userData?.isOutlineMesh
    ) ||
    new THREE.Box3().setFromObject(group)
  );
}

function centerModelOnOrigin(group) {
  const box = computeSpawnBounds(group);
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  group.position.x -= center.x;
  group.position.y -= box.min.y;
  group.position.z -= center.z;
  return box;
}

function haloTopPadding(size) {
  return THREE.MathUtils.clamp(size.z * 0.055, 0.035, 0.08);
}

function haloDepthOffset(size) {
  return THREE.MathUtils.clamp(size.y * 0.55, 0.18, 0.28);
}

function sourcePositionToLocal(pos) {
  return new THREE.Vector3(pos.x, pos.z, pos.y);
}

function haloSourceIsTransient(data) {
  return TRANSIENT_HALO_SOURCE_RE.test(data?.source_path || "");
}

function haloAnchorIsTrivial(anchor) {
  const pos = vector3FromPosition(anchor?.position);
  return !pos || pos.lengthSq() < 1e-8;
}

function haloTargetLooksValid(target, headPos) {
  if (!target || !headPos) return !!target;
  const lift = target.z - headPos.z;
  const horizontal = Math.hypot(target.x - headPos.x, target.y - headPos.y);
  return lift >= 0.15 && lift <= 0.7 && horizontal <= 0.8;
}

function adjustHaloTargetDepth(target, headPos, depthMode, placementTiltDeg) {
  if (!target || !headPos) return target;
  const corrected = target.clone();
  if (depthMode === "head") {
    corrected.y = headPos.y;
    return corrected;
  }
  if (depthMode === "tilt") {
    const sourceDepth = target.y - headPos.y;
    if (Math.abs(sourceDepth) < 1e-6 || !Number.isFinite(placementTiltDeg)) {
      corrected.y = headPos.y;
      return corrected;
    }
    const lift = Math.max(0, target.z - headPos.z);
    const tiltRad = THREE.MathUtils.degToRad(
      THREE.MathUtils.clamp(placementTiltDeg, 0, 80)
    );
    const projectedDepth = Math.min(
      Math.abs(sourceDepth),
      lift * Math.tan(tiltRad)
    );
    corrected.y = headPos.y - Math.sign(sourceDepth) * projectedDepth;
    return corrected;
  }
  if (depthMode === "preserve") {
    return corrected;
  }
  corrected.y = headPos.y - (target.y - headPos.y);
  return corrected;
}

function getMetadataHaloTarget(assetData, headPos) {
  const depthMode =
    assetData?.halo_follow?.depth_mode ||
    assetData?.halo_anchor?.depth_mode ||
    assetData?.halo_transform?.depth_mode;
  const placementTiltDeg =
    assetData?.halo_follow?.placement_tilt_deg ??
    assetData?.halo_anchor?.placement_tilt_deg ??
    assetData?.halo_transform?.placement_tilt_deg;
  const anchor = assetData?.halo_anchor;
  if (
    anchor?.position &&
    !haloSourceIsTransient(anchor) &&
    !haloAnchorIsTrivial(anchor)
  ) {
    const target = vector3FromPosition(anchor.position);
    if (haloTargetLooksValid(target, headPos)) {
      return adjustHaloTargetDepth(
        target,
        headPos,
        depthMode,
        placementTiltDeg
      );
    }
  }

  const haloFollow = assetData?.halo_follow;
  const followPosition = vector3FromPosition(
    haloFollow?.target_position || haloFollow?.position
  );
  const followSpace = haloFollow?.coordinate_space || haloFollow?.space;
  if (followPosition && !haloSourceIsTransient(haloFollow)) {
    const target =
      followSpace && /^(viewer|mesh|local)$/i.test(followSpace)
        ? followPosition
        : sourcePositionToLocal(followPosition);
    if (haloTargetLooksValid(target, headPos)) {
      return adjustHaloTargetDepth(
        target,
        headPos,
        depthMode,
        placementTiltDeg
      );
    }
  }

  const haloTransform = assetData?.halo_transform;
  const rawTransformPosition = vector3FromPosition(haloTransform?.position);
  const space = haloTransform?.coordinate_space || haloTransform?.space;
  if (rawTransformPosition && !haloSourceIsTransient(haloTransform)) {
    const target =
      space && /^(viewer|mesh|local)$/i.test(space)
        ? rawTransformPosition
        : sourcePositionToLocal(rawTransformPosition);
    if (haloTargetLooksValid(target, headPos)) {
      return adjustHaloTargetDepth(
        target,
        headPos,
        depthMode,
        placementTiltDeg
      );
    }
  }

  return null;
}

function sanitizeHaloMeshTarget(center, headPos, haloSize) {
  const target = center.clone();
  const horizontalLimit = Math.max(haloSize.x * 0.12, 0.025);
  if (Math.abs(target.x - headPos.x) > horizontalLimit) {
    target.x = headPos.x;
  }

  const expectedDepth = THREE.MathUtils.clamp(haloSize.y * 0.86, 0.14, 0.24);
  const depthDelta = target.y - headPos.y;
  if (Math.abs(depthDelta) > expectedDepth * 1.6) {
    target.y = headPos.y - Math.sign(depthDelta || -1) * expectedDepth;
  }

  const lift = target.z - headPos.z;
  if (lift < 0.3) {
    const expectedLift = THREE.MathUtils.clamp(
      Math.max(haloSize.x, haloSize.y) * 1.2,
      0.32,
      0.46
    );
    target.z = headPos.z + expectedLift;
  }

  return target;
}

function getStaticHaloTarget(group, headPos) {
  const haloBox = computeMeshBounds(
    group,
    (child) => child.userData?.isHaloMesh
  );
  if (!haloBox) return null;
  const center = haloBox.getCenter(new THREE.Vector3());
  if (!headPos) return center;
  return sanitizeHaloMeshTarget(
    center,
    headPos,
    haloBox.getSize(new THREE.Vector3())
  );
}

function estimateHaloTargetPosition(group, assetData) {
  const headPos = getManifestHeadPosition(assetData);
  const metadataTarget = getMetadataHaloTarget(assetData, headPos);
  if (metadataTarget) return metadataTarget;

  const haloTarget = getStaticHaloTarget(group, headPos);
  if (haloTarget) return haloTarget;

  const characterBox =
    computeMeshBounds(
      group,
      (child) => !child.userData?.isHaloMesh && !child.userData?.isOutlineMesh
    ) || new THREE.Box3().setFromObject(group);
  const headBox = computeMeshBounds(group, (child) =>
    HEAD_MESH_BASE_NAMES.has(child.userData?.meshBaseName)
  );
  const anchorBox = headBox || characterBox;
  const size = characterBox.getSize(new THREE.Vector3());
  const center = anchorBox.getCenter(new THREE.Vector3());
  const topZ = anchorBox.max.z;
  const padding = haloTopPadding(size);

  if (headPos) {
    const headOffset = Math.max(size.z * 0.34, 0.3);
    return new THREE.Vector3(
      headPos.x,
      headPos.y,
      Math.max(headPos.z + headOffset, topZ + padding)
    );
  }

  if (anchorBox) {
    return new THREE.Vector3(center.x, center.y, topZ + padding);
  }

  const legacyHaloPosition = vector3FromPosition(
    assetData?.halo_transform?.position
  );
  if (legacyHaloPosition && !haloSourceIsTransient(assetData?.halo_transform)) {
    return sourcePositionToLocal(legacyHaloPosition);
  }

  return new THREE.Vector3();
}

function alignHaloRootToTarget(haloRoot, target) {
  const box = new THREE.Box3().setFromObject(haloRoot);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  haloRoot.position.add(target.clone().sub(center));
}

function createCenteredHaloPivot(haloRoot) {
  const box = new THREE.Box3().setFromObject(haloRoot);
  if (box.isEmpty()) return haloRoot;

  const centerWorld = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  haloRoot.updateMatrix();
  haloRoot.updateWorldMatrix(true, true);
  const centerLocal = haloRoot.worldToLocal(centerWorld.clone());
  const offset = centerLocal.length();
  if (offset <= Math.max(maxDim * 0.75, 0.05)) return haloRoot;

  const pivot = new THREE.Group();
  pivot.name = `${haloRoot.name || "Halo"}_Pivot`;
  pivot.userData = {
    ...haloRoot.userData,
    isHaloPivotRoot: true,
    haloPivotLocalCenter: centerLocal.toArray()
  };

  const pivotMatrix = haloRoot.matrix
    .clone()
    .multiply(
      new THREE.Matrix4().makeTranslation(
        centerLocal.x,
        centerLocal.y,
        centerLocal.z
      )
    );
  pivotMatrix.decompose(pivot.position, pivot.quaternion, pivot.scale);

  haloRoot.position.set(-centerLocal.x, -centerLocal.y, -centerLocal.z);
  haloRoot.quaternion.identity();
  haloRoot.scale.set(1, 1, 1);
  haloRoot.updateMatrix();
  pivot.add(haloRoot);

  console.info(
    `[halo] centered baked halo pivot (${offset.toFixed(3)} local units)`
  );
  return pivot;
}

function attachHaloRuntimeFollow(
  localRoot,
  haloRoot,
  followTarget,
  haloTarget,
  haloFollow = null
) {
  if (!localRoot || !haloRoot || !followTarget || !haloTarget) return false;
  localRoot.updateWorldMatrix(true, true);
  followTarget.updateWorldMatrix(true, false);
  const targetWorldPos = localRoot.localToWorld(haloTarget.clone());
  const targetForwardLocal =
    vector3FromPosition(localRoot.userData?.haloFollowLocalForward) ||
    new THREE.Vector3(0, 1, 0);
  const baseYaw = yawFromLocalRootDirection(
    directionInLocalRootSpace(localRoot, followTarget, targetForwardLocal)
  );
  const baseQuaternion = haloRoot.quaternion.clone();
  let targetRelativeQuaternion = null;
  if (shouldUseFullHaloFollowRotation(haloFollow)) {
    // Manifest target_relative_rotation is in Unity world space, while
    // baseQuaternion lives in viewer local space after group/orientFix
    // wrapping. Calibrate against the actual bone world quaternion so the
    // halo tracks tilts accurately.
    const targetLocalQuaternion = localRootQuaternionForObject(
      localRoot,
      followTarget
    );
    targetRelativeQuaternion = targetLocalQuaternion
      .invert()
      .multiply(baseQuaternion)
      .normalize();
  }
  haloRoot.userData.haloFollow = {
    localRoot,
    target: followTarget,
    targetLocalOffset: followTarget.worldToLocal(targetWorldPos),
    targetForwardLocal,
    baseYaw,
    baseQuaternion,
    targetRelativeQuaternion,
    rootOffset: haloRoot.position.clone().sub(haloTarget)
  };
  return true;
}

function attachPositionRuntimeFollow(
  localRoot,
  object,
  followTarget,
  targetLocalOffset = new THREE.Vector3()
) {
  if (!localRoot || !object || !followTarget) return false;
  object.userData.haloFollow = {
    localRoot,
    target: followTarget,
    targetLocalOffset: targetLocalOffset.clone(),
    rootOffset: new THREE.Vector3()
  };
  return true;
}

function colorKey(colorData = {}) {
  return [
    colorData.r ?? 1,
    colorData.g ?? 1,
    colorData.b ?? 1,
    colorData.a ?? 1
  ]
    .map((value) => Number(value).toFixed(3))
    .join(":");
}

function rgbaString(colorData, alphaScale = 1) {
  const r = Math.round(THREE.MathUtils.clamp(colorData.r ?? 1, 0, 1) * 255);
  const g = Math.round(THREE.MathUtils.clamp(colorData.g ?? 1, 0, 1) * 255);
  const b = Math.round(THREE.MathUtils.clamp(colorData.b ?? 1, 0, 1) * 255);
  const a = THREE.MathUtils.clamp((colorData.a ?? 1) * alphaScale, 0, 1);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function createFxShellTexture(colorData) {
  const key = colorKey(colorData);
  if (FX_SHELL_TEXTURES.has(key)) return FX_SHELL_TEXTURES.get(key);

  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const center = size / 2;
  const radius = size * 0.48;
  ctx.clearRect(0, 0, size, size);

  const fill = ctx.createRadialGradient(
    center,
    center,
    0,
    center,
    center,
    radius
  );
  fill.addColorStop(0.0, rgbaString(colorData, 0.04));
  fill.addColorStop(0.42, rgbaString(colorData, 0.12));
  fill.addColorStop(0.66, rgbaString(colorData, 0.62));
  fill.addColorStop(0.82, rgbaString(colorData, 0.28));
  fill.addColorStop(1.0, rgbaString(colorData, 0.0));
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.needsUpdate = true;
  FX_SHELL_TEXTURES.set(key, texture);
  return texture;
}

function attachFxPropShell(root, meshInfo) {
  const shell = meshInfo?.fx_shell;
  if (!root || !shell) return null;
  const colorData = shell.color || { r: 1.0, g: 0.42, b: 0.72, a: 0.42 };
  const texture = createFxShellTexture(colorData);
  const material = new THREE.SpriteMaterial({
    map: texture,
    color: new THREE.Color(
      colorData.r ?? 1,
      colorData.g ?? 1,
      colorData.b ?? 1
    ),
    transparent: true,
    opacity: colorData.a ?? 0.42,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  });
  material.userData.isFxPropShellMaterial = true;
  const sprite = new THREE.Sprite(material);
  sprite.name = `${meshInfo.name || "FxProp"}_Shell`;
  const spriteSize = Number.isFinite(shell.size) ? shell.size : 0.15;
  sprite.scale.set(spriteSize, spriteSize, 1);
  sprite.renderOrder = 1.5;
  sprite.userData.isFxPropShell = true;
  root.add(sprite);
  return sprite;
}

export async function loadCharacterIndex() {
  try {
    const resp = await fetch(withCacheVersion("models_index.json"));
    if (!resp.ok) {
      throw new Error(`models_index.json fetch failed: ${resp.status}`);
    }
    modelsIndex = await resp.json();
    const sel = document.getElementById("charSelect");
    if (!sel) return modelsIndex;
    for (const char of modelsIndex) {
      const opt = document.createElement("option");
      opt.value = char.id;
      opt.textContent = `${char.id} (${char.meshes.length} meshes)`;
      sel.appendChild(opt);
    }
    return modelsIndex;
  } catch (e) {
    console.warn("Could not load models_index.json:", e);
    throw e;
  }
}

export async function loadCharacter(
  charId,
  scene,
  controls,
  camera,
  clearScene
) {
  const charData = modelsIndex.find((c) => c.id === charId);
  if (!charData) {
    alert("Character not found");
    return;
  }

  const basePath = charData.path + "/";
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();

  try {
    const assetData = await loadManifestData(basePath, charData);

    const loadTex = async (name) => {
      const tex = await texLoader.loadAsync(
        withCacheVersion(basePath + "textures/" + name)
      );
      tex.flipY = false;
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      // Cap panel seams baked into the albedo are 1-3px wide. At the grazing
      // back-top orbit angle the texture is compressed along one axis; without
      // anisotropic filtering those thin lines alias into hard streaks (they
      // soften only when you zoom/look head-on, where the compression drops).
      // Trilinear mips + max anisotropy reproduce that head-on softening at
      // every angle. three.js clamps anisotropy to the GPU max.
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = 16;
      tex.needsUpdate = true;
      return tex;
    };

    // Load material data
    const matFiles = {};
    for (const m of assetData.materials || []) {
      try {
        matFiles[m.name] = await (
          await fetch(withCacheVersion(basePath + m.file))
        ).json();
      } catch (e) {
        console.warn(`[${charId}] material preload failed: ${m.name || m.file}`, e);
      }
    }
    const haloProfile = buildHaloAnimationProfile(assetData, matFiles);

    // Preload textures
    const texCache = {};
    const texNamesToLoad = new Set();
    for (const t of assetData.textures || []) {
      const name = t.name || "";
      if (!name || name.startsWith("Character_Mouth")) continue;
      if (!name.startsWith("FX_") || haloProfile.textureKeys.includes(name)) {
        texNamesToLoad.add(name);
      }
    }
    // Also preload textures referenced by halo particle materials (FX_MAT_*).
    // These materials feed the particle system and need their masks/atlases loaded.
    for (const [matName, matData] of Object.entries(matFiles)) {
      if (!/^(FX_MAT_|.*_Halo$|.*_Cutin_Halo$)/i.test(matName)) continue;
      for (const slot of Object.values(matData?.textures || {})) {
        if (slot?.name) texNamesToLoad.add(slot.name);
      }
    }
    // Force-preload common FX atlas textures used by legacy halo particle
    // fallback. Current exports should load material-referenced textures above.
    if (assetData.halo_particles_file) {
      for (const candidate of [
        "FX_TEX_CH0069_Halo_01",
        "FX_TEX_Color_Gra_01",
        "FX_TEX_Noise_Stars_03",
        "FX_TEX_Noise_Stars_03a",
        "FX_TEX_Circle_Glow_02",
        "FX_TEX_Trail_01"
      ]) {
        if ((assetData.textures || []).some((t) => t.name === candidate)) {
          texNamesToLoad.add(candidate);
        }
      }
    }
    const charTextures = [...(assetData.textures || [])].filter((t) =>
      texNamesToLoad.has(t.name)
    );
    await Promise.all(
      charTextures.map(async (t) => {
        try {
          texCache[t.name] = await loadTex(t.file.replace("textures/", ""));
        } catch (e) {
          console.warn(`[${charId}] texture preload failed: ${t.name || t.file}`, e);
        }
      })
    );

    clearScene();
    const group = new THREE.Group();
    let realHaloCount = 0;
    const haloRoots = [];
    const animatedParts = [];
    const visibleParts = [];
    const pendingFollows = [];
    const pendingParentAttach = [];
    const animationSummaries = collectAnimationSummaries(assetData);
    const expressionTracks = buildExpressionTracks(animationSummaries);
    const eyeMouthMaterials = [];
    const expressionRendererTargets = new Map();
    const rendererToggleParts = [];
    const animationClipNames = [
      ...new Set(
        animationSummaries.map((item) => item?.name).filter(Boolean)
      )
    ].sort();
    const defaultClipName = pickDefaultAnimationClip(animationClipNames);
    const haloFollowTargetName =
      assetData.halo_follow?.follow_target ||
      assetData.head_transform?.bone ||
      "Bip001 Head";
    let haloFollowTarget = null;
    group.userData.haloFollowLocalForward =
      vector3FromPosition(assetData.halo_follow?.local_forward) ||
      new THREE.Vector3(0, 1, 0);

    // Prefer skinned GLBs when available so AnimationMixer can drive the source skeleton.
    const staticMeshList = [...(assetData.meshes || charData.meshes || [])];
    const skinnedMeshList = [...(assetData.skinned_meshes || [])].filter(
      (item) => item.file
    );
    const meshList = skinnedMeshList.length
      ? [
          ...skinnedMeshList.map((item) => ({ ...item, isSkinned: true })),
          ...staticMeshList.filter(isRuntimeStaticMeshInfo)
        ]
      : staticMeshList;

    // Add Halo to mesh list if not already present but file exists
    const hasHalo = meshList.some((m) => m.name.toLowerCase().includes("halo"));
    if (!hasHalo) {
      try {
        const haloResp = await fetch(basePath + `${charId}_Halo.glb`, {
          method: "HEAD"
        });
        if (haloResp.ok) {
          meshList.push({ name: "Halo", file: `${charId}_Halo.glb` });
        }
      } catch (e) {
        console.debug(`[${charId}] optional halo mesh probe failed`, e);
      }
    }

    const shouldDeferSkinnedMesh = (meshInfo) =>
      meshInfo.isSkinned &&
      meshInfo.visibility &&
      getMeshBaseName(meshInfo.name) !== "Body" &&
      !(
        Array.isArray(meshInfo.renderer_toggle_clips) &&
        meshInfo.renderer_toggle_clips.length
      ) &&
      !shouldShowVisiblePart(meshInfo.visibility, defaultClipName);
    const initialMeshList = [];
    const deferredMeshInfos = new Set();
    for (const meshInfo of meshList) {
      if (shouldDeferSkinnedMesh(meshInfo)) {
        deferredMeshInfos.add(meshInfo);
      } else {
        initialMeshList.push(meshInfo);
      }
    }
    if (deferredMeshInfos.size) {
      console.info(
        `[${charId}] deferred ${deferredMeshInfos.size} hidden skinned part(s) until matching animation`
      );
    }

    // Pre-load mouth tile spritesheet and cut into individual tile textures.
    // Some characters reference per-character atlases (e.g. ch0170 uses
    // Character_Mouth_2 from its own textures/ folder); fall back to the global
    // sheet for materials that don't override.
    let mouthTiles = [];
    let mouthRows = 4,
      mouthCols = 4;
    try {
      const eyeMouthMatName = `${charId}_EyeMouth`;
      const eyeMouthMat = matFiles[eyeMouthMatName];
      const mouthAtlasName = eyeMouthMat?.textures?._MouthTileTex?.name || null;
      const matCols = Number(eyeMouthMat?.floats?._MouthTileCols);
      const matRows = Number(eyeMouthMat?.floats?._MouthTileRows);
      mouthCols =
        Number.isFinite(matCols) && matCols > 0 ? Math.round(matCols) : 8;
      mouthRows =
        Number.isFinite(matRows) && matRows > 0 ? Math.round(matRows) : 8;

      let mouthAtlasUrl = "mouth/Character_Mouth.png";
      if (mouthAtlasName) {
        const texEntry = (assetData.textures || []).find(
          (t) => t.name === mouthAtlasName
        );
        if (texEntry?.file) {
          mouthAtlasUrl = basePath + texEntry.file;
        } else {
          mouthAtlasUrl = `mouth/${mouthAtlasName}.png`;
        }
      }

      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = withCacheVersion(mouthAtlasUrl);
      });

      const tw = img.width / mouthCols;
      const th = img.height / mouthRows;
      for (let row = 0; row < mouthRows; row++) {
        for (let col = 0; col < mouthCols; col++) {
          const canvas = document.createElement("canvas");
          canvas.width = tw;
          canvas.height = th;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, col * tw, row * th, tw, th, 0, 0, tw, th);
          bleedTransparentMouthTileRgb(ctx, canvas.width, canvas.height);
          const tex = new THREE.CanvasTexture(canvas);
          tex.flipY = false;
          tex.colorSpace = THREE.LinearSRGBColorSpace;
          tex.generateMipmaps = false;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          mouthTiles.push(tex);
        }
      }
      console.log(
        `Mouth tiles: ${mouthTiles.length} (${mouthCols}x${mouthRows}) from ${mouthAtlasUrl}`
      );
    } catch (e) {
      console.warn("Mouth tiles not loaded:", e.message);
    }

    const buildPartMaterial = (
      child,
      name,
      baseName,
      groupInfo = null,
      meshInfo = null
    ) => {
      const debugShader =
        typeof window !== "undefined" && window.__KANI_SHADER_DEBUG !== false;
      const logShaderRoute = (route, info = {}) => {
        if (!debugShader) return;
        const matData = info.matData;
        const f = matData?.floats || {};
        const c = matData?.colors || {};
        const tex = matData?.textures || {};
        console.log(
          `[shader] ${charId} ${info.name || name} (base=${info.baseName || baseName}) -> ${route}`,
          {
            matName: info.matName ?? null,
            shaderName: matData ? getMaterialShaderName(matData) : null,
            mainTexKey: info.mainTexKey ?? null,
            hasMainTex: !!info.mainTex,
            hasMaskTex: !!info.maskTex,
            isHair: info.isHair ?? null,
            isFace: info.isFace ?? null,
            isAlphaSubmesh: info.isAlphaSubmesh ?? null,
            isOverlay: info.isOverlay ?? null,
            isHaloMesh: info.isHaloMesh ?? null,
            isOutlineProp: info.isOutlineProp ?? null,
            isSkinnedProp: info.isSkinnedProp ?? null,
            isFxProp: info.isFxProp ?? null,
            transparentByData: matData
              ? isTransparentMaterialData(matData)
              : null,
            blend: {
              _SrcBlend: f._SrcBlend ?? null,
              _DstBlend: f._DstBlend ?? null,
              _SrcBlendAlpha: f._SrcBlendAlpha ?? null,
              _DstBlendAlpha: f._DstBlendAlpha ?? null,
              _ZWrite: f._ZWrite ?? null,
              _Cull: f._Cull ?? null,
              _Surface: f._Surface ?? null,
              _Cutoff: f._Cutoff ?? null
            },
            uniforms: info.uniforms ?? null,
            textureSlots: Object.keys(tex),
            colorKeys: Object.keys(c),
            floatKeys: Object.keys(f)
          }
        );
      };
      const isHaloMesh =
        baseName === "Halo" || name.toLowerCase().includes("halo");
      const isFxProp = !!meshInfo?.fx_prop || baseName === "PropLight";
      const isOverlay =
        baseName === "EyeMouth" ||
        baseName === "Eyebrow" ||
        baseName === "Eyebrow2";
      const isEyeMouth = baseName === "EyeMouth";
      // Outline_* meshes are sticker / decal geometry that piggy-back on the
      // body texture (e.g. CH0082 medicine bottle uses the body atlas to draw
      // its label). They share the body material reference but the Layer4
      // picker would map the decal pixels through the layer that belongs to
      // skin/clothing, washing the colours out. Render those decals through
      // the simple textured path so the label keeps its source colours.
      const isOutlineProp =
        meshInfo &&
        !meshInfo.isSkinned &&
        /^Outline(_|$)/i.test(meshInfo.name || "");
      // Skinned prop bottles like CH0082's MedicineProp ride a small
      // private bone chain (bone_medicine, bone_lid, bone_pill_*) but reuse
      // the character's body atlas + body/alpha materials. The atlas region
      // mapped onto the prop is a pre-shaded sprite (bottle, cap, pills,
      // label) that should be drawn straight, but the body's Layer4 shader
      // tints those pixels through `_ShadowTintR4` (red/orange) wherever
      // mask.r is low, producing the dark-red label artefact reported on
      // CH0082's bottle. Force such props through the simple textured path
      // so the atlas RGB is rendered as-is. Detected by manifest name match
      // on `(Medicine|Prop|Bottle)` rather than skin-weight count to avoid
      // false positives on light hair/cloth bones. Prop can appear mid-name
      // too, e.g. CH0184 `GymProp`.
      const isSkinnedProp = isSkinnedPropMeshInfo(meshInfo);

      if (isFxProp) {
        const colorData = meshInfo?.color || {
          r: 0.8396,
          g: 0.2099,
          b: 0.4984,
          a: 0.55
        };
        const material = new THREE.MeshBasicMaterial({
          color: new THREE.Color(
            colorData.r ?? 1,
            colorData.g ?? 1,
            colorData.b ?? 1
          ),
          transparent: true,
          opacity: colorData.a ?? 0.55,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending
        });
        material.userData.isFxPropMaterial = true;
        logShaderRoute("fxProp/MeshBasicMaterial", { isFxProp });
        return {
          material,
          isHaloMesh,
          isOverlay: true,
          isEyeMouth,
          noFaceTexture: false,
          overrides: {},
          mainTex: null
        };
      }

      const { matName, matData } = resolvePartMaterial(
        matFiles,
        charId,
        name,
        baseName,
        meshInfo
      );
      const { texKey: mainTexKey, tex: resolvedMainTex } = resolveMainTexture(
        texCache,
        charId,
        name,
        baseName,
        matData
      );
      let mainTex = resolvedMainTex;
      const allowTextureFallback =
        meshInfo?.allow_texture_fallback !== false &&
        meshInfo?.allowTextureFallback !== false &&
        meshInfo?.disable_body_texture_fallback !== true &&
        meshInfo?.disableBodyTextureFallback !== true;
      if (isHaloMesh && !mainTex) {
        const haloTexKey = pickHaloTextureKey(texCache, haloProfile);
        if (haloTexKey) mainTex = texCache[haloTexKey];
      }
      if (
        !mainTex &&
        (baseName === "Face" ||
          name === "Unknown" ||
          name.startsWith("Unknown_"))
      ) {
        // No texture needed
      } else if (
        !mainTex &&
        name !== "Body" &&
        !isHaloMesh &&
        allowTextureFallback
      ) {
        mainTex = texCache[`${charId}_Body`] || null;
      }
      if (!mainTex && name === "Body")
        mainTex = texCache[Object.keys(texCache)[0]] || null;

      const { tex: maskTex } = resolveMaskTexture(
        texCache,
        charId,
        name,
        baseName,
        mainTexKey,
        matData
      );
      const overrides = parseMaterialOverrides(matData);
      const useSimpleTransparent =
        baseName !== "Face" && shouldRouteToSimpleTransparent(matData);
      // BA convention: any mesh / submesh whose name ends in "Alpha"
      // (e.g. Outline_Alpha, Cutin_Body_Alpha, *_Alpha submesh of the body)
      // is the alpha-blended companion of the matching opaque mesh.
      // Game's exporter sometimes drops _Surface=1 / _DstBlend != 0 from the JSON,
      // which would otherwise route the mesh through the opaque cutoff path
      // and discard every pixel whose albedo alpha < _Cutoff (the medicine
      // bottle on CH0082 reproduces this exactly).
      const isAlphaSubmesh = baseName === "Alpha" || /_Alpha$/i.test(name);
      const renderTransparent =
        isOverlay ||
        isAlphaSubmesh ||
        (!isHaloMesh && isTransparentMaterialData(matData));
      if (isAlphaSubmesh) {
        overrides.u_Cutoff = 0.0;
      }
      if (useSimpleTransparent) {
        overrides.u_Cutoff = 0.0;
        overrides.u_ShadowSharpness = -20.0;
      }
      const noFaceTexture =
        !mainTex &&
        (name === "Face" || name === "Unknown" || name.startsWith("Unknown_"));
      if (noFaceTexture) {
        logShaderRoute("noFaceTexture/hidden", {
          matName,
          matData,
          mainTexKey,
          mainTex,
          maskTex,
          isAlphaSubmesh,
          isOverlay
        });
        return {
          material: makeHiddenMaterial(),
          isHaloMesh,
          isOverlay,
          isEyeMouth,
          noFaceTexture,
          overrides,
          mainTex
        };
      }

      const uniforms = makeUniformsObj(overrides);
      if (mainTex) {
        uniforms.u_MainTex.value = mainTex;
        uniforms.u_HasMainTex.value = true;
      }
      if (maskTex) {
        uniforms.u_MaskTex.value = maskTex;
        uniforms.u_HasMaskTex.value = true;
      }

      const isHair = baseName === "Hair" || name === "Hair";
      if (isHair) {
        const hairSpecName = pickTextureKey(texCache, [
          materialTextureName(matData, "_HairSpecTex"),
          `${charId}_Hair_Spec`,
          `${charId}_Spec`,
          ...Object.keys(texCache).filter(
            (n) => n.toLowerCase().includes("spec") && n.startsWith(charId)
          )
        ]);
        if (hairSpecName && texCache[hairSpecName]) {
          uniforms.u_HairSpecTex.value = texCache[hairSpecName];
          uniforms.u_HasHairSpecTex.value = true;
        }
        uniforms.u_ShadowSharpness = { value: -20.0 };
        // Game's `MX/C-Hair` (opaque) shader has no `_Cutoff` property —
        // it never discards by alpha. The viewer's `toon.js` however
        // defaults `u_Cutoff` to 0.2 and discards `albedo.a < u_Cutoff`.
        // Hair materials that ride `MX/C-Hair` (e.g. CH0264_Hair) ship
        // with no `_Cutoff` in JSON and a hair atlas whose alpha=0 across
        // most pixels (alpha is reserved for the `*_Hair_Alpha` companion
        // submesh). Without this guard the head goes invisible behind the
        // toon discard.
        if (matData?.floats?._Cutoff == null && uniforms.u_Cutoff) {
          uniforms.u_Cutoff.value = 0.0;
        }
      }

      const isFace = baseName === "Face";
      if (isFace) {
        uniforms.u_IsFaceShader.value = true;
        // When the face material has no _ShadowSharpness key
        // Unity initialises the Range slot to 0, which disables face shadow
        // entirely (DXBC mul_sat * -0 → shadow=0 → face fully lit). CH0076
        // and most chibi faces ship without _ShadowSharpness for this reason
        // — the game shows them with no toon shadow on the face. Match that.
        if (overrides.u_ShadowSharpness == null) {
          uniforms.u_ShadowSharpness.value = 0.0;
        }
        if (!matData) {
          uniforms.u_ShadowLightDir.value.set(
            -0.3419051170349121,
            0.9397348761558533,
            0.0
          );
          uniforms.u_ShadowThreshold.value = 0.7;
          console.warn(
            `[${charId}] face material missing for ${name}; using fallback face shader params`
          );
        } else if (matName && matName !== `${charId}_${name}`) {
          console.info(
            `[${charId}] face material alias: ${name} -> ${matName}`
          );
        }
      }

      if (isHaloMesh) {
        const glowStrength =
          matData?.floats?._GlowStrength0 ??
          matData?.floats?._GlowStrength ??
          haloProfile.glowStrength ??
          1.0;
        const tint = makeHaloTint(matData, haloProfile);
        const material = createHaloMaterial({
          texture: mainTex,
          profile: haloProfile,
          tint,
          glowStrength,
          matData
        });
        applyMaterialRampParams(material, matData);
        logShaderRoute("halo/createHaloMaterial", {
          matName,
          matData,
          mainTexKey,
          mainTex,
          maskTex,
          isHaloMesh: true,
          uniforms: { glowStrength }
        });
        return {
          material,
          isHaloMesh,
          isOverlay,
          isEyeMouth,
          noFaceTexture,
          overrides,
          mainTex
        };
      }

      if (
        !useSimpleTransparent &&
        (isSimpleTexturedMaterialData(matData) || isOutlineProp || isSkinnedProp)
      ) {
        if (isOutlineProp) {
          // Static Outline_* meshes are filtered out earlier by
          // isRuntimeStaticMeshInfo, so this branch is defensive only.
          logShaderRoute("outlineProp/hidden", {
            matName,
            matData,
            mainTexKey,
            mainTex,
            maskTex,
            isOutlineProp
          });
          return {
            material: makeHiddenMaterial(),
            isHaloMesh,
            isOverlay: false,
            isEyeMouth,
            noFaceTexture: false,
            isSkinnedProp,
            overrides,
            mainTex
          };
        }
        const material = createSimpleTexturedMaterial({
          texture: mainTex,
          matData
        });
        logShaderRoute("simpleTextured/MeshBasicMaterial", {
          matName,
          matData,
          mainTexKey,
          mainTex,
          maskTex,
          isAlphaSubmesh,
          isOverlay: renderTransparent,
          isSkinnedProp
        });
        return {
          material,
          isHaloMesh,
          isOverlay: renderTransparent,
          isEyeMouth,
          noFaceTexture,
          isSkinnedProp,
          overrides,
          mainTex
        };
      }

      if (isEyeMouth) {
        const codeMul = matData?.colors?._CodeMultiplyColor || {
          r: 1,
          g: 1,
          b: 1,
          a: 1
        };
        const codeAdd = matData?.colors?._CodeAddColor || {
          r: 0,
          g: 0,
          b: 0,
          a: 0
        };
        const mouthTexST = matData?.textures?._MouthTileTex || {
          offset: [0, 0]
        };
        const defaultIdx = resolveMouthTileIndex(
          mouthTexST,
          mouthCols,
          mouthRows
        );
        const defaultTile = mouthTiles[defaultIdx] || mouthTiles[0] || null;
        const regions = computeEyeMouthRegions(child.geometry, groupInfo);
        const mouthBounds = regions.mouth;
        const mouthSampleBounds = computeMouthSampleUvBounds(mouthBounds);
        const useMouthPositionSample =
          shouldSampleMouthTileByPosition(mouthBounds);
        const sourceName = meshInfo?.name || "";
        console.log(
          `[${charId}] EyeMouth submesh '${sourceName}': mouth=`,
          mouthBounds,
          " sample=",
          mouthSampleBounds,
          " positionSample=",
          useMouthPositionSample,
          ` defaultIdx=${defaultIdx} mouthTiles.len=${mouthTiles.length} hasTile=${!!defaultTile}`
        );
        const material = new THREE.ShaderMaterial({
          uniforms: {
            u_MainTex: { value: mainTex },
            u_HasMainTex: { value: !!mainTex },
            u_Tint: { value: new THREE.Vector4(1, 1, 1, 1) },
            u_CodeMultiplyColor: {
              value: new THREE.Vector4(
                codeMul.r,
                codeMul.g,
                codeMul.b,
                codeMul.a
              )
            },
            u_CodeAddColor: {
              value: new THREE.Vector4(
                codeAdd.r,
                codeAdd.g,
                codeAdd.b,
                codeAdd.a
              )
            },
            u_MouthTileTex: { value: defaultTile },
            u_HasMouthTileTex: {
              value: !!defaultTile && !!mouthBounds
            },
            u_MouthFlipX: { value: false },
            u_MouthUVMin: {
              value: mouthBounds?.min || new THREE.Vector2(0, 0)
            },
            u_MouthUVMax: {
              value: mouthBounds?.max || new THREE.Vector2(0, 0)
            },
            u_MouthSampleUVMin: {
              value: mouthSampleBounds?.min || new THREE.Vector2(0, 0)
            },
            u_MouthSampleUVMax: {
              value: mouthSampleBounds?.max || new THREE.Vector2(0, 0)
            },
            u_MouthUsePositionSample: {
              value: useMouthPositionSample
            },
            u_MouthPositionMin: {
              value: mouthBounds?.positionMin || new THREE.Vector3(0, 0, 0)
            },
            u_MouthPositionMax: {
              value: mouthBounds?.positionMax || new THREE.Vector3(0, 0, 0)
            }
          },
          vertexShader: eyeMouthVertSrc,
          fragmentShader: eyeMouthFragSrc,
          side: THREE.DoubleSide,
          // Unity MX/C-EyesMouth is Geometry+1/Opaque, not a transparent pass.
          transparent: false,
          depthWrite: true,
          depthTest: true,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1
        });
        material.userData.mouthTiles = mouthTiles;
        material.userData.mouthCols = mouthCols;
        material.userData.mouthRows = mouthRows;
        material.userData.defaultMouthTileIndex = defaultIdx;
        material.userData.currentMouthTileIndex = defaultIdx;
        material.userData.hasMouthRegion = !!mouthBounds;
        eyeMouthMaterials.push(material);
        logShaderRoute("eyeMouth/ShaderMaterial", {
          matName,
          matData,
          mainTexKey,
          mainTex,
          maskTex,
          isOverlay: true,
          isEyeMouth: true,
          uniforms: {
            mouthCols,
            mouthRows,
            defaultMouthTileIndex: defaultIdx,
            mouthTilesLen: mouthTiles.length,
            hasMouthRegion: !!mouthBounds
          }
        });
        return {
          material,
          isHaloMesh,
          isOverlay,
          isEyeMouth,
          noFaceTexture,
          overrides,
          mainTex
        };
      }

      // Decide which shader pipeline to use based on the material's shader
      // name. Generic C-General transparent stays intentionally un-routed;
      // C-Simple-Transparent is a real live prop route once shader metadata
      // is restored from the truth bundles.
      const useHairTransparent =
        !isFace && shouldRouteToHairTransparent(matData);

      let vertSrc = toonVertSrc;
      let fragSrc = toonFragSrc;
      if (useHairTransparent) {
        vertSrc = hairTransparentVertSrc;
        fragSrc = hairTransparentFragSrc;
      } else if (useSimpleTransparent) {
        vertSrc = simpleTransparentVertSrc;
        fragSrc = simpleTransparentFragSrc;
      }

      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: vertSrc,
        fragmentShader: fragSrc,
        side: THREE.DoubleSide,
        vertexColors: !!child.geometry?.attributes?.color,
        vertexAlphas: (child.geometry?.attributes?.color?.itemSize || 0) >= 4
      });
      // applyUnityBlendState owns transparent/depthWrite/blend factors based
      // on the material's actual Unity flags, so leave the ShaderMaterial
      // defaults alone here and let it decide.
      applyUnityBlendState(material, matData);
      if (isAlphaSubmesh) {
        // *_Alpha submeshes are transparent companions. Hair alpha uses the
        // real MX/C-Hair-Transparent path above; older exports without shader
        // names still need this fallback to stay transparent.
        material.transparent = true;
        if (!material.premultipliedAlpha) {
          material.blending = THREE.CustomBlending;
          material.blendSrc = THREE.SrcAlphaFactor;
          material.blendDst = THREE.OneMinusSrcAlphaFactor;
          material.blendSrcAlpha = THREE.OneFactor;
          material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
        }
      }
      const finalTransparent = material.transparent || isOverlay;
      if (isOverlay) {
        material.transparent = true;
        material.depthWrite = false;
      }
      const route = useHairTransparent
        ? "hairTransparent"
        : useSimpleTransparent
          ? "simpleTransparent"
          : isFace
            ? "toon(face)"
            : "toon";
      logShaderRoute(`shader/${route}`, {
        matName,
        matData,
        mainTexKey,
        mainTex,
        maskTex,
        isHair,
        isFace,
        isAlphaSubmesh,
        isOverlay: finalTransparent,
        uniforms: {
          materialTransparent: material.transparent,
          depthWrite: material.depthWrite,
          premultipliedAlpha: material.premultipliedAlpha,
          side: material.side,
          u_Cutoff: uniforms.u_Cutoff?.value,
          u_HasMainTex: uniforms.u_HasMainTex?.value,
          u_HasMaskTex: uniforms.u_HasMaskTex?.value,
          u_IsFaceShader: uniforms.u_IsFaceShader?.value
        }
      });
      return {
        material,
        isHaloMesh,
        isOverlay: finalTransparent,
        isEyeMouth,
        noFaceTexture,
        overrides,
        mainTex
      };
    };

    let animationState = null;
    const deferredMeshLoads = new Map();
    const loadedMeshInfos = new Set();
    const loadMeshPart = async (meshInfo) => {
      const sourceName = meshInfo.name;
      const sourceBaseName = getMeshBaseName(sourceName);

      let gltf;
      try {
        gltf = await new Promise((resolve, reject) => {
          loader.load(
            withCacheVersion(basePath + meshInfo.file),
            resolve,
            undefined,
            reject
          );
        });
      } catch (e) {
        console.warn(`Skipping ${sourceName}:`, e.message);
        return false;
      }
      if (meshInfo.isSkinned && gltf.animations?.length) {
        if (charId === "CH0336") stripCH0336RootTranslation(gltf.animations);
        const animatedPart = {
          root: gltf.scene,
          clips: gltf.animations,
          clipAliases: meshInfo.clip_aliases || meshInfo.clipAliases || null
        };
        if (animationState) animationState.addPart(animatedPart);
        else animatedParts.push(animatedPart);
      }
      if (meshInfo.isSkinned) {
        gltf.scene.userData.skinnedPartName = meshInfo.name;
        gltf.scene.traverse((obj) => {
          obj.userData.skinnedPartName = meshInfo.name;
        });
      }
      if (meshInfo.visibility) {
        visibleParts.push({ root: gltf.scene, rule: meshInfo.visibility });
        if (animationState) {
          gltf.scene.visible = shouldShowVisiblePart(
            meshInfo.visibility,
            animationState.activeClip
          );
        }
      }
      // Renderer.m_Enabled curves baked into each clip take precedence
      // over the static visibility rule. Build a per-clip sample map so
      // updateExpressions can sample the curve frame-accurate.
      if (
        Array.isArray(meshInfo.renderer_toggle_clips) &&
        meshInfo.renderer_toggle_clips.length
      ) {
        const clips = new Map();
        for (const entry of meshInfo.renderer_toggle_clips) {
          if (!entry?.name || !Array.isArray(entry.samples)) continue;
          const samples = entry.samples
            .map((s) => ({
              time: Number(s.time) || 0,
              enabled: !!s.enabled
            }))
            .sort((a, b) => a.time - b.time);
          if (samples.length) clips.set(entry.name, samples);
        }
        if (clips.size) {
          gltf.scene.userData.toggleTag = `${charId}/${meshInfo.name}`;
          const togglePart = { root: gltf.scene, clips };
          rendererToggleParts.push(togglePart);
          // FX overlays may have been registered before this toggle
          // part loaded (deferred face SMRs are common). Resolve any
          // pending followers waiting on this gate tag now.
          const pendingByTag = group.userData.fxOverlayPendingByGateTag;
          if (pendingByTag) {
            const queued = pendingByTag.get(gltf.scene.userData.toggleTag);
            if (queued?.length) {
              if (!Array.isArray(togglePart.fxFollowers))
                togglePart.fxFollowers = [];
              for (const follower of queued) {
                if (!follower.showClipWindows?.length) {
                  reparentFxFollowerToPartBone(follower, togglePart);
                }
                togglePart.fxFollowers.push(follower);
              }
              pendingByTag.delete(gltf.scene.userData.toggleTag);
              // Run the curve now so the new followers pick up the
              // current visibility instead of waiting for the next
              // expression update tick.
              if (animationState) {
                applyRendererToggleParts(
                  [togglePart],
                  animationState.activeClip,
                  animationState.lastExpressionTime >= 0
                    ? animationState.lastExpressionTime
                    : 0
                );
              }
            }
          }
          // Re-apply current state if the animation state already exists
          // (deferred load path): pick the right initial visibility.
          if (animationState) {
            const samples = clips.get(animationState.activeClip);
            const decided = sampleRendererToggleCurve(
              samples,
              0
            );
            if (decided != null) {
              gltf.scene.visible = !!decided;
            }
          }
        }
      }
      // Renderer.m_Enabled curves drive visibility frame-accurate; skip
      // both the static visibility rule and the ChildRenderer-event path
      // when curves are present so they don't fight the curve sampler.
      const hasRendererToggleCurves =
        Array.isArray(meshInfo.renderer_toggle_clips) &&
        meshInfo.renderer_toggle_clips.length > 0;
      if (
        !hasRendererToggleCurves &&
        meshInfo.isSkinned &&
        Number.isInteger(meshInfo.child_index) &&
        isRendererEventControlledMesh(meshInfo)
      ) {
        let bucket = expressionRendererTargets.get(meshInfo.child_index);
        if (!bucket) {
          bucket = new Set();
          expressionRendererTargets.set(meshInfo.child_index, bucket);
        }
        bucket.add(gltf.scene);
        // ChildRenderer events are reliable for face-swap renderers. Core
        // Body/Weapon/Prop children can also appear in Ex/Cutin events; letting
        // those events drive viewer visibility makes CH0087 flicker and hides
        // the flowerpot around the loop boundary.
        gltf.scene.visible = getInitialRendererVisible(meshInfo);
      }
      if (meshInfo.isSkinned && !haloFollowTarget) {
        haloFollowTarget = findObjectByName(gltf.scene, haloFollowTargetName);
      }
      const skinnedUvNeedsFlip =
        meshInfo.isSkinned && !gltf.parser?.json?.extras?.viewerUvYFlipped;

      gltf.scene.traverse((child) => {
        if (!child.isMesh) return;
        if (skinnedUvNeedsFlip) flipGeometryUvYOnce(child.geometry);
        // Three.js frustum-culls SkinnedMesh against its rest-pose AABB,
        // not the deformed pose. When the camera zooms close to a face
        // SMR, the rest-pose box can fall outside the view even though
        // the live skinned geometry still covers screen pixels — the
        // mesh blinks out as the user dollies in. Disable per-mesh
        // culling for skinned content; the perf cost is negligible for
        // single-character scenes and the visual win is significant.
        if (child.isSkinnedMesh) child.frustumCulled = false;
        // Outline_Body / Outline_cutin_Body / Outline_Alpha are physical
        // sticker / decal meshes layered onto a prop, NOT a Body submesh
        // bundle. They ship a single primitive even when their parent
        // skinned mesh holds 7 submesh slots. Treating them as the body
        // submesh path makes the loader pick the wrong material (it would
        // map slot 0 to "Body" and apply the Layer4 character shader),
        // which is what made the CH0082 medicine bottle's label go grey.
        const isOutlineSourceMesh = /^Outline(_|$)/i.test(sourceName);
        const useSkinnedSubmeshMaterials =
          meshInfo.isSkinned &&
          !isOutlineSourceMesh &&
          (sourceBaseName === "Body" || meshInfo.submesh_order?.length) &&
          Array.isArray(child.material) &&
          child.material.length > 1;
        if (useSkinnedSubmeshMaterials) {
          const submeshNames =
            meshInfo.submesh_order || assetData.submesh_order || [];
          const built = child.material.map((_oldMaterial, materialIndex) => {
            const partName =
              submeshNames[materialIndex] || `sub${materialIndex}`;
            const partBaseName = getMeshBaseName(partName);
            return buildPartMaterial(
              child,
              partName,
              partBaseName,
              getGeometryGroup(child.geometry, materialIndex),
              meshInfo
            );
          });
          child.material = built.map((item) => item.material);
          // Three renders each geometry group with its own material, so the
          // transparent EyeMouth/Eyebrow groups still sort after opaque groups.
          // Keeping the whole skinned mesh at overlay order makes Hair/Body
          // diverge from the static path.
          child.renderOrder = 0;
          child.userData.meshBaseName = "Body";
          child.userData.skinnedPartNames = submeshNames;
          child.userData.isHaloMesh = false;
          enableSkinningMaterial(child.material);

          const outlineMaterials = built.map((item, materialIndex) => {
            const partName =
              submeshNames[materialIndex] || `sub${materialIndex}`;
            const partBaseName = getMeshBaseName(partName);
            return (
              createOutlineMaterial(partName, partBaseName, item) ||
              makeHiddenMaterial()
            );
          });
          if (
            outlineMaterials.some(
              (material) => material.userData?.isOutlineMaterial
            )
          ) {
            enableSkinningMaterial(outlineMaterials);
            attachOutlineMesh(child, outlineMaterials);
          }
          return;
        }

        const resolvedPart = meshInfo.isSkinned
          ? getSkinnedPartName(assetData, meshInfo, child)
          : { name: sourceName, baseName: sourceBaseName };
        const name = resolvedPart.name;
        const baseName = resolvedPart.baseName;
        const built = buildPartMaterial(child, name, baseName, null, meshInfo);

        child.userData.meshBaseName = baseName;
        child.userData.isHaloMesh = built.isHaloMesh;
        child.material = built.material;

        if (built.isHaloMesh) {
          attachHaloAnimationState(child, haloProfile);
          child.renderOrder = 2;
          realHaloCount++;
        } else if (built.isOverlay) {
          child.renderOrder = 1;
        }
        if (child.isSkinnedMesh) enableSkinningMaterial(child.material);

        const outlineMaterial = createOutlineMaterial(name, baseName, built);
        if (outlineMaterial) {
          if (child.isSkinnedMesh) enableSkinningMaterial(outlineMaterial);
          attachOutlineMesh(child, outlineMaterial);
        }
      });
      attachFxPropShell(gltf.scene, meshInfo);
      gltf.scene.traverse((child) => {
        if (!child.isMesh) return;
        if (shouldUseMeshVertexColors(meshInfo)) {
          enableVertexColorMaterial(child.material, child.geometry);
        }
      });
      const isSourceHalo = isHaloMeshInfo(meshInfo);
      const rootToAdd = isSourceHalo
        ? createCenteredHaloPivot(gltf.scene)
        : gltf.scene;
      if (isSourceHalo) {
        gltf.scene.userData.isHaloRoot = true;
        rootToAdd.userData.isHaloRoot = true;
        haloRoots.push(rootToAdd);
      }
      if (meshInfo.follow_target) {
        pendingFollows.push({ root: rootToAdd, meshInfo });
      }
      if (meshInfo.isSkinned) {
        // Skinned bones place the mesh in Unity world Y-up at rest, while the
        // static GLBs (incl. Halo) are stored mesh-local Z-up. The character
        // group applies `rotation.x = -PI/2` to stand the static meshes up.
        // Wrap the skinned scene in an inverse +PI/2 X rotation so the group
        // rotation becomes a no-op for skinned content; the AnimationMixer is
        // still bound to gltf.scene, so animations are unaffected.
        const orientFix = new THREE.Group();
        orientFix.rotation.x = Math.PI / 2;
        orientFix.userData.skinnedPartName = meshInfo.name;
        orientFix.add(gltf.scene);
        group.add(orientFix);
        if (meshInfo.parent_bone) {
          // External cafe props (e.g. CH0072 WaterPot) ship with their own
          // private skeleton that is not parented under the character. The
          // exporter records the static rest TRS relative to a character
          // bone so the viewer can re-parent the prop after the body's
          // skeleton is in scene.
          pendingParentAttach.push({ wrapper: orientFix, meshInfo });
        }
      } else {
        group.add(rootToAdd);
      }
      loadedMeshInfos.add(meshInfo);
      return true;
    };

    for (const meshInfo of initialMeshList) {
      await loadMeshPart(meshInfo);
    }

    const resolvePendingFollows = (warnMissing = false) => {
      for (let i = pendingFollows.length - 1; i >= 0; i--) {
        const follow = pendingFollows[i];
        const followTarget = findObjectByName(
          group,
          follow.meshInfo.follow_target
        );
        const offset =
          vector3FromPosition(
            follow.meshInfo.follow_offset || follow.meshInfo.target_local_offset
          ) || new THREE.Vector3();
        if (
          attachPositionRuntimeFollow(group, follow.root, followTarget, offset)
        ) {
          pendingFollows.splice(i, 1);
        } else if (warnMissing) {
          console.warn(
            `[${charId}] follow target not found for ${follow.meshInfo.name}: ${follow.meshInfo.follow_target}`
          );
        }
      }
    };

    const resolvePendingParentAttach = (warnMissing = false) => {
      for (let i = pendingParentAttach.length - 1; i >= 0; i--) {
        const pending = pendingParentAttach[i];
        const sharedSkeletonParentPart =
          pending.meshInfo.shared_skeleton_parent_part ||
          pending.meshInfo.parent_part_name ||
          pending.meshInfo.parent_part ||
          "Body";
        const bone = pending.meshInfo.shared_skeleton_root
          ? findSharedSkeletonParentBone(
              group,
              pending.meshInfo.parent_bone,
              sharedSkeletonParentPart
            )
          : findParentAttachBone(
              group,
              pending.meshInfo.parent_bone,
              pending.meshInfo.parent_part_name || pending.meshInfo.parent_part
            );
        if (!bone) {
          if (warnMissing) {
            console.warn(
              `[${charId}] parent bone not found for ${pending.meshInfo.name}: ${pending.meshInfo.parent_bone}`
            );
          }
          continue;
        }
        const wrapper = pending.wrapper;
        if (pending.meshInfo.shared_skeleton_root) {
          // CH0091 BeachProp: prop's skeleton lives under its own bone_root.
          // Re-parent prop's bone_root children into the body bone_root so prop
          // bones become siblings of Bip001, then move the render scene into
          // the same mesh container before hiding the now-empty orientation
          // wrapper.
          const propBoneRoot = wrapper.getObjectByName("bone_root");
          if (propBoneRoot) {
            const targetBoneRoot = bone; // already found by name "bone_root"
            const boneChildren = propBoneRoot.children.slice();
            for (const child of boneChildren) {
              targetBoneRoot.add(child);
            }
            const meshContainer = targetBoneRoot.parent || group;
            let movedRenderRoots = 0;
            const wrapperChildren = wrapper.children.slice();
            for (const child of wrapperChildren) {
              if (child === propBoneRoot) continue;
              if (hasRenderableDescendant(child)) {
                meshContainer.add(child);
                movedRenderRoots += 1;
              }
            }
            wrapper.visible = movedRenderRoots === 0;
            wrapper.userData.sharedSkeletonAttached = true;
            wrapper.userData.sharedSkeletonParentPart = sharedSkeletonParentPart;
            wrapper.userData.sharedSkeletonMovedRenderRoots = movedRenderRoots;
            pendingParentAttach.splice(i, 1);
            console.info(
              `[${charId}] shared-skeleton attach: reparented ${pending.meshInfo.name} prop bones into ${sharedSkeletonParentPart}/${pending.meshInfo.parent_bone}; moved ${movedRenderRoots} render root(s)`
            );
            continue;
          }
          // Fall through to standard path if propBoneRoot not found.
        }
        if (wrapper.parent) wrapper.parent.remove(wrapper);
        const pos = pending.meshInfo.parent_local_position;
        const rot = pending.meshInfo.parent_local_rotation;
        const scale = pending.meshInfo.parent_local_scale;
        if (pos) wrapper.position.set(pos.x ?? 0, pos.y ?? 0, pos.z ?? 0);
        else wrapper.position.set(0, 0, 0);
        if (rot)
          wrapper.quaternion.set(
            rot.x ?? 0,
            rot.y ?? 0,
            rot.z ?? 0,
            rot.w ?? 1
          );
        else wrapper.quaternion.identity();
        if (scale) wrapper.scale.set(scale.x ?? 1, scale.y ?? 1, scale.z ?? 1);
        else wrapper.scale.set(1, 1, 1);
        bone.add(wrapper);
        wrapper.userData.parentBoneAttached = pending.meshInfo.parent_bone;
        pendingParentAttach.splice(i, 1);
        console.info(
          `[${charId}] attached ${pending.meshInfo.name} to bone ${pending.meshInfo.parent_bone}`
        );
      }
    };

    const loadDeferredMeshInfo = async (meshInfo) => {
      if (!meshInfo) return false;
      if (loadedMeshInfos.has(meshInfo)) return true;

      const key = meshInfo.file || meshInfo.name;
      if (!deferredMeshLoads.has(key)) {
        deferredMeshLoads.set(
          key,
          loadMeshPart(meshInfo).then((loaded) => {
            if (loaded) deferredMeshInfos.delete(meshInfo);
            return loaded;
          })
        );
      }
      const loaded = await deferredMeshLoads.get(key);
      if (loaded) {
        resolvePendingFollows(false);
        resolvePendingParentAttach(false);
      }
      return !!loaded;
    };

    group.userData.listModelPartRegistry = () =>
      meshList
        .filter((meshInfo) => meshInfo?.name && meshInfo?.file)
        .map((meshInfo) => ({
          id: meshInfo.name,
          name: meshInfo.name,
          file: meshInfo.file,
          isSkinned: !!meshInfo.isSkinned,
          loaded: loadedMeshInfos.has(meshInfo),
          deferred: deferredMeshInfos.has(meshInfo)
        }));

    group.userData.loadModelPart = async (partId) => {
      const meshInfo = meshList.find((item) => item?.name === partId);
      const loaded = await loadDeferredMeshInfo(meshInfo);
      if (loaded && animationState) {
        animationState.updateVisibility();
        animationState.updateExpressions(true);
      }
      return loaded;
    };

    const lazyLoadForClip = async (clipName) => {
      const needed = [...deferredMeshInfos].filter((meshInfo) =>
        shouldShowVisiblePart(meshInfo.visibility, clipName)
      );
      if (!needed.length) return;

      await Promise.all(
        needed.map((meshInfo) => loadDeferredMeshInfo(meshInfo))
      );
      console.info(
        `[${charId}] lazy-loaded ${needed.length} skinned part(s) for ${clipName}`
      );
    };

    animationState = createAnimationState(
      animatedParts,
      expressionTracks,
      eyeMouthMaterials,
      visibleParts,
      {
        clipNames: animationClipNames,
        lazyLoadForClip,
        modelFxProvider: () => group.userData.modelFx
      },
      expressionRendererTargets,
      rendererToggleParts
    );
    if (animationState) {
      group.userData.animationState = animationState;
      group.userData.expressionTrackCount = expressionTracks.size;
      // Apply renderer-toggle/mouth events for the default clip's t=0
      // state once all skinned meshes are registered. This ensures the
      // initial frame matches the clip's intended face/prop selection
      // (otherwise spare meshes would stay hidden until the timeline
      // moved past the first event).
      animationState.updateExpressions(true);
      console.info(
        `[${charId}] animations: ${animationState.clipNames.length} clip(s), ` +
          `materialized action sets: ${animationState.actionsByName.size}, ` +
          `expression tracks: ${expressionTracks.size}`
      );
    }

    resolvePendingFollows(false);
    resolvePendingParentAttach(false);

    for (const haloRoot of haloRoots) {
      applyStaticHaloSourceRotation(haloRoot, assetData);
    }
    const haloTarget = estimateHaloTargetPosition(group, assetData);
    for (const haloRoot of haloRoots) {
      alignHaloRootToTarget(haloRoot, haloTarget);
      attachHaloRuntimeFollow(
        group,
        haloRoot,
        haloFollowTarget,
        haloTarget,
        assetData.halo_follow
      );
    }

    // Spawn halo particle system if metadata is present.
    if (assetData.halo_particles_file) {
      try {
        const particleData = await (
          await fetch(
            withCacheVersion(basePath + assetData.halo_particles_file)
          )
        ).json();
        const particles = await createHaloParticleSystem({
          particleData,
          materialDataByName: matFiles,
          textureCache: texCache,
          basePath
        });
        if (particles?.root) {
          particles.root.position.copy(haloTarget);
          // Static halo meshes can have their plane baked into geometry; particle
          // emitters need the exported placement tilt on the root transform.
          const particleRootQuat = haloParticleRootQuaternion(assetData);
          if (particleRootQuat)
            particles.root.quaternion.copy(particleRootQuat);
          particles.root.userData.haloParticleUpdate = particles.update;
          group.add(particles.root);
          attachHaloRuntimeFollow(
            group,
            particles.root,
            haloFollowTarget,
            haloTarget,
            assetData.halo_follow
          );
          console.info(
            `[${charId}] halo particles: ${particles.emitters.length} emitter(s)`
          );
        }
      } catch (err) {
        console.warn(`[${charId}] halo particles failed:`, err);
      }
    }

    // FX overlays: extra non-skinned meshes attached to bones during
    // specific clip windows (e.g. CH0145 cutin spiral eyes). Loaded
    // after halo so the texCache and bones are fully resolved.
    if (Array.isArray(assetData.fx_overlays) && assetData.fx_overlays.length) {
      try {
        const fxFollowers = await loadFxOverlays({
          group,
          fxOverlays: assetData.fx_overlays,
          basePath,
          texCache,
          rendererToggleParts,
          loader
        });
        if (fxFollowers.length) {
          group.userData.fxOverlayFollowers = fxFollowers;
          if (animationState) {
            animationState.fxOverlayFollowers = fxFollowers;
          }
          // Sync against the active clip immediately so the initial
          // visibility matches the active clip time.
          if (animationState) {
            applyRendererToggleParts(
              rendererToggleParts,
              animationState.activeClip,
              animationState.lastExpressionTime >= 0
                ? animationState.lastExpressionTime
                : 0
            );
            applyFxOverlayWindowVisibility(
              fxFollowers,
              animationState.activeClip,
              animationState.lastExpressionTime >= 0
                ? animationState.lastExpressionTime
                : 0
            );
          }
          console.info(
            `[${charId}] fx overlays: ${fxFollowers.length} follower(s)`
          );
        }
      } catch (err) {
        console.warn(`[${charId}] fx overlays failed:`, err);
      }
    }

    if (
      animationState &&
      assetData.fx_index_file &&
      assetData.fx_anim_events_file
    ) {
      try {
        const [fxIndex, animEvents] = await Promise.all([
          fetch(withCacheVersion(basePath + assetData.fx_index_file)).then(
            (resp) => {
              if (!resp.ok) throw new Error(`fetch failed: ${assetData.fx_index_file}`);
              return resp.json();
            }
          ),
          fetch(withCacheVersion(basePath + assetData.fx_anim_events_file)).then(
            (resp) => {
              if (!resp.ok) throw new Error(`fetch failed: ${assetData.fx_anim_events_file}`);
              return resp.json();
            }
          )
        ]);
        group.userData.modelFx = await createModelFx({
          fxIndex,
          animEvents,
          basePath: basePath + "fx/",
          characterRoot: group,
          mixerState: animationState,
          camera,
          cacheVersion: ASSET_CACHE_VERSION
        });
        console.info(
          `[${charId}] model fx: ${(fxIndex.particles || []).length} particle system(s), ` +
            `${(animEvents.events || []).length} event(s)`
        );
      } catch (err) {
        console.warn(`[${charId}] model fx failed:`, err);
      }
    }

    if (
      haloProfile.enabled &&
      haloProfile.allowSynthetic &&
      realHaloCount === 0
    ) {
      const haloTexKey = pickHaloTextureKey(texCache, haloProfile);
      const haloTex = haloTexKey ? texCache[haloTexKey] : null;
      if (haloProfile.mode === "plane" && !haloTex) {
        console.warn(`[${charId}] halo plane skipped; texture missing`);
      } else {
        const proxySize = new THREE.Box3()
          .setFromObject(group)
          .getSize(new THREE.Vector3());
        const proxyPos = haloTarget;
        const proxy = createHaloProxyMesh({
          profile: haloProfile,
          texture: haloTex,
          tint: haloProfile.tint,
          glowStrength: haloProfile.glowStrength,
          position: proxyPos,
          size: proxySize
        });
        group.add(proxy);
        attachHaloRuntimeFollow(
          group,
          proxy,
          haloFollowTarget,
          proxyPos,
          assetData.halo_follow
        );
        console.info(
          `[${charId}] halo proxy enabled (${haloProfile.mode})${haloTexKey ? ` using ${haloTexKey}` : ""}`
        );
      }
    }

    group.rotation.x = -Math.PI / 2;

    const box = computeSpawnBounds(group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 2.0 / maxDim;
    group.scale.multiplyScalar(scale);
    const scaledBox = computeSpawnBounds(group);
    const scaledSize = scaledBox.getSize(new THREE.Vector3());
    scaledBox.getCenter(center);
    group.position.sub(center);
    group.position.y += scaledSize.y * 0.5;
    group.userData.centerOnOrigin = () => centerModelOnOrigin(group);
    scene.add(group);
    controls.target.set(0, scaledSize.y * 0.4, 0);
    camera.position.set(0, scaledSize.y * 0.4, 5);
    controls.update();
    console.log(`${charId} loaded`);
    return group;
  } catch (e) {
    console.error(`Failed to load ${charId}:`, e);
    alert(`Failed: ${e.message}`);
    return null;
  }
}
