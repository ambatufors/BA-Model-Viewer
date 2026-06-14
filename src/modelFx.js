
// Model FX (i gave up)
// CH0334 (Cafe_Reaction), CH0335 (Cafe_Reaction), CH0145 (Cafe_Reaction) test
// Out of scope (matches plan): nested-prefab spawn, world-space particles, trails, and full velocity simulation.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Unity MinMaxState enum (raw dump uses minMaxState field).
const MMS_CONSTANT = 0;
const MMS_CURVE = 1;
const MMS_TWO_CURVES = 2;
const MMS_TWO_CONSTANTS = 3;

// Unity ParticleSystemGradientMode (startColor uses minMaxState as the mode).
// This is a DIFFERENT enum from the curve MinMaxState above — value 3 means
// TwoGradients here, NOT TwoConstants — so color sampling must not reuse the
// curve enum. 0=Color 1=Gradient 2=TwoColors 3=TwoGradients 4=RandomColor.
const GRAD_COLOR = 0;
const GRAD_GRADIENT = 1;
const GRAD_TWO_COLORS = 2;
const GRAD_TWO_GRADIENTS = 3;
const GRAD_RANDOM_COLOR = 4;

const MAX_EMITTER_CAPACITY = 256;
const DEFAULT_CAPACITY = 32;
const UNITY_RENDER_MODE_STRETCH = 1;
const UNITY_RENDER_MODE_MESH = 4;
const UNITY_RENDER_MODE_NONE = 5;
// Unity ParticleSystemRenderSpace (m_RenderAlignment): how a particle's
// orientation is resolved. View/Facing billboard toward the camera; World/Local
// keep the emitter's object-space frame; Velocity aligns the mesh to its motion
// direction. (The runtime previously mislabeled 4 as "Facing" and billboarded
// it — which flattened the velocity-aligned emotion marks into a slab facing
// the camera. Facing is 3; Velocity is 4.)
const UNITY_RENDER_ALIGNMENT_VIEW = 0;
const UNITY_RENDER_ALIGNMENT_WORLD = 1;
const UNITY_RENDER_ALIGNMENT_LOCAL = 2;
const UNITY_RENDER_ALIGNMENT_FACING = 3;
const UNITY_RENDER_ALIGNMENT_VELOCITY = 4;
// Unity TextureWrapMode -> THREE wrapping. Unity enum order (per docs):
// 0=Repeat, 1=Clamp, 2=Mirror, 3=MirrorOnce. THREE has no MirrorOnce — map it
// to MirroredRepeat (closest; Unity clamps after one mirror, but BA fx never
// relies on that). Default is Clamp: BA fx gradient ramps (e.g. FX_TEX_Gra_W_01,
// the CH0325 head_red blush sweep) are authored Clamp, and clamping is the safe
// default for an unknown overlay — Repeat silently TILES a scrolled ramp into
// multiple stacked sweeps instead of one rising front.
const UNITY_WRAP_REPEAT = 0;
const UNITY_WRAP_CLAMP = 1;
const UNITY_WRAP_MIRROR = 2;
const UNITY_WRAP_MIRROR_ONCE = 3;
function unityWrapToThree(wrap) {
  switch (Number(wrap)) {
    case UNITY_WRAP_REPEAT:
      return THREE.RepeatWrapping;
    case UNITY_WRAP_MIRROR:
    case UNITY_WRAP_MIRROR_ONCE:
      return THREE.MirroredRepeatWrapping;
    case UNITY_WRAP_CLAMP:
    default:
      return THREE.ClampToEdgeWrapping;
  }
}

// Soft ceiling for the fx tint peak channel. Keeps extreme-HDR
// materials (e.g. FX_MAT_White_05 _Color=23.97) blooming as a glow instead of
// a flashbang white block. Sits above the bloom threshold (scene.js = 1.5) so
// capped effects still bloom. See colorVec clamp in FxEmitter.init.
const FX_COLOR_CEILING = 2.5;
// Mesh-mode FX particles are authored in a bone-local frame that does not line up
// with the exported glTF bone node (the FBX->glTF export keeps skinning correct
// via inverse bind matrices, but a child parented to the bone node inherits a
// rotated frame). The correction is DATA-DRIVEN: tools/fx/compute_mesh_frame_fix.py
// derives it per mesh by best-fitting the FX shell onto the character's own face
// geometry and writes index.json meshes[].frame_quat. The viewer reads that here.
// This legacy table only covers meshes dumped before that field existed.
const LEGACY_MESH_PARTICLE_FRAME_FIXES = {
  FX_MESH_CH0334_Acc_Head: { scale: [-1, 1, 1] },
};

function resolveMeshFrameFix(meshName, dataFix) {
  if (dataFix && (dataFix.quat || dataFix.rotation || dataFix.scale)) return dataFix;
  return LEGACY_MESH_PARTICLE_FRAME_FIXES[meshName] || null;
}
const tmpWorldQuat = new THREE.Quaternion();
const tmpParentWorldQuat = new THREE.Quaternion();

// Map a BA DSFX shader name to a THREE blending descriptor. The blend mode is
// encoded in the shader NAME (dump_fx.py captures it via the merged-env shader
// index). Unity Pass0 srcBlend/dstBlend (verified from truth bundles) collapse
// onto THREE blend presets + premultipliedAlpha:
//   (SrcAlpha, 1-SrcAlpha) -> Normal              (AlphaBlend_0)
//   (One,      1-SrcAlpha) -> Normal + premult    (AlphaBlend_Add / _Add_Mask / Step)
//   (SrcAlpha, One)        -> Additive            (AlwaysView_Add)
//   (One,      One)        -> Additive + premult  (Additive_0)
//   (DstColor, Zero)       -> Custom multiplicative (Multiplicative_0)
// Distortion shaders (Zero,Zero in Pass0; real work in a grab pass) can't be a
// single blend — fall back to faint additive so they don't render as a blob.
// Historically every fx material was forced AdditiveBlending, which turned
// alpha-blended glows (e.g. CH0334 Cafe_Reaction emotion discs) into a bright
// blob on a black bg. This resolver restores per-material blend fidelity.
function resolveFxBlend(shaderName) {
  const s = String(shaderName || "");
  if (/Multiplicative/.test(s)) {
    return {
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendEquation: THREE.AddEquation,
      premultiply: false,
      multiplicative: true,
    };
  }
  if (/Distort/.test(s)) return { blending: THREE.AdditiveBlending, premultiply: false };
  if (/AlphaBlend_Add|_Add_Mask|\bStep/.test(s)) return { blending: THREE.NormalBlending, premultiply: true };
  if (/AlphaBlend/.test(s)) return { blending: THREE.NormalBlending, premultiply: false };
  if (/AlwaysView_Add/.test(s)) return { blending: THREE.AdditiveBlending, premultiply: false };
  if (/Additive/.test(s)) return { blending: THREE.AdditiveBlending, premultiply: true };
  return { blending: THREE.AdditiveBlending, premultiply: false };
}

// Unity Cull mode (material _Cull_Mode / _Cull): 0=Off, 1=Front, 2=Back -> THREE
// side. Mesh-mode FX shells (e.g. the CH0325 head_red head shell) are authored
// Cull Back; rendering them DoubleSide exposes the shell's inner surface at its
// open rim (the neck/chin), which read as a bright streak under the chin. Honor
// the authored cull so only the outward faces draw. Default DoubleSide keeps flat
// quad/decal particles visible from both sides.
function resolveMeshCullSide(matData) {
  const cull = Number(matData?.floats?._Cull_Mode ?? matData?.floats?._Cull ?? 0);
  if (cull === 1) return THREE.BackSide; // Cull Front -> draw back faces
  if (cull === 2) return THREE.FrontSide; // Cull Back -> draw front faces
  return THREE.DoubleSide; // Cull Off
}

function applyFxBlendState(material, blend) {
  const b = blend || { blending: THREE.AdditiveBlending, premultiply: false };
  material.blending = b.blending;
  if (b.blendSrc != null) material.blendSrc = b.blendSrc;
  if (b.blendDst != null) material.blendDst = b.blendDst;
  if (b.blendSrcAlpha != null) material.blendSrcAlpha = b.blendSrcAlpha;
  if (b.blendDstAlpha != null) material.blendDstAlpha = b.blendDstAlpha;
  if (b.blendEquation != null) material.blendEquation = b.blendEquation;
  material.premultipliedAlpha = !!b.premultiply;
}

function materialDepthTestEnabled(matData) {
  const f = matData?.floats || {};
  const zTest = Number(f._ZTest_Mode ?? f._ZTest);
  // Unity CompareFunction.Always = 8. Missing values default to LEqual for FX.
  return !(Number.isFinite(zTest) && zTest === 8);
}

// BA DSFX face/body FX (AlphaBlend / Additive / Distort, all ZWrite-off) are
// authored as flat decals that sit ON the character surface (render_alignment
// Local). The instanced-billboard path renders them camera-facing instead, so a
// quad centered on a CONVEX surface (e.g. the cheek) swings partly behind that
// surface as the camera turns off-axis; with depth testing on, the face mesh
// then clips it on one side — the notch, which reads as worse the
// further the camera pans (off-axis foreshortening + poorer depth precision at
// the 0.01..100 range compound it). These surface FX never write depth and are
// sorted transparent overlays in Unity, so we render them WITHOUT depth testing
// (they can no longer be one-sidedly clipped by the surface they lay over) and
// order them by the Unity sorting key. Stretch rays are not surface decals:
// honor their material ZTest so the character depth buffer can occlude rays that
// pass behind the model.
function resolveFxRenderState(matData, renderer) {
  const shaderName = String(matData?.shader || "");
  const sortingFudge = Number(renderer?.sorting_fudge ?? 0);
  const sortingOrder = Number(renderer?.sorting_order ?? 0);
  const isStretchParticle = Number(renderer?.render_mode) === UNITY_RENDER_MODE_STRETCH;
  const isMultiplicative = /Multiplicative/.test(shaderName);
  // Matches the DSFX transparent families resolveFxBlend already recognizes; a
  // missing material (soft-glow fallback) is also an additive overlay.
  const isFxOverlay =
    !shaderName ||
    /Distort|AlphaBlend|Additive|AlwaysView|Multiplicative|\bStep/.test(shaderName);
  const disableDepthTestForSurfaceOverlay = isFxOverlay && !isStretchParticle && !isMultiplicative;
  // Unity's transparent queue draws back-to-front; a MORE-NEGATIVE sorting_fudge
  // biases an object nearer so it draws later (on top). Mirror that: renderOrder
  // rises as fudge falls, with sorting_order as the coarse key. Base 20 keeps fx
  // above the opaque character (renderOrder 0). e.g. cheek mask (fudge -100) ->
  // 21 draws over its glow disc (fudge +50) -> 19.5.
  return {
    depthTest: disableDepthTestForSurfaceOverlay ? false : materialDepthTestEnabled(matData),
    renderOrder: isFxOverlay ? 20 + sortingOrder * 4 - sortingFudge / 100 : 0,
  };
}

function stabilizeMaskTexture(texture) {
  if (!texture || texture.userData?.fxMaskStable) return;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  texture.userData = { ...(texture.userData || {}), fxMaskStable: true };
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
const POST_DURATION_GRACE = 4.0; // seconds — keep prefab alive for trailing particles after lengthInSec

function applyMeshParticleFrameFix(group, fix) {
  if (fix?.scale) {
    group.scale.set(fix.scale[0], fix.scale[1], fix.scale[2]);
  }
  if (fix?.rotation) {
    group.rotation.set(fix.rotation[0], fix.rotation[1], fix.rotation[2]);
  }
  if (fix?.quat) {
    group.quaternion.set(fix.quat[0], fix.quat[1], fix.quat[2], fix.quat[3]);
  }
}

function makeSoftGlowTexture(size = 128) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, "rgba(255,255,255,1.0)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.45)");
  grad.addColorStop(1.0, "rgba(255,255,255,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  tex.userData = { fxFallback: true };
  return tex;
}

const UNITY_SHAPE_CONE = 4;
const UNITY_SHAPE_CONE_VOLUME = 8;
const UNITY_SHAPE_CIRCLE = 10;
const UNITY_SHAPE_CIRCLE_EDGE = 11;
const UNITY_ARC_MODE_BURSTSPREAD = 3;

// Sample a spawn offset (emitter-local) for a ShapeModule. `spread` carries the
// particle's index within its burst so BurstSpread arc mode can fan particles
// evenly across the arc (matches Unity's i/count distribution); pass null for
// rate-emitted particles (random arc position).
function sampleShape(shape, spread, rng = Math.random) {
  const fallbackDirection = new THREE.Vector3(0, 0, 1);
  if (!shape) return { position: null, direction: fallbackDirection };
  const arc = (shape.arcDeg ?? 360) * Math.PI / 180;
  let theta;
  if (shape.arcMode === UNITY_ARC_MODE_BURSTSPREAD && spread && spread.total > 1) {
    theta = (spread.index / (spread.total - 1)) * arc;
  } else {
    theta = rng() * arc;
  }
  switch (shape.type) {
    case UNITY_SHAPE_CIRCLE:
    case UNITY_SHAPE_CIRCLE_EDGE: {
      // Circle spawns on the XY plane, angle from +X. Edge = always on rim;
      // filled circle picks a radius within [inner, outer] per radiusThickness.
      const rOuter = shape.radius || 0;
      const rInner = rOuter * (1 - clamp01(shape.radiusThickness ?? 1));
      const r = shape.type === UNITY_SHAPE_CIRCLE_EDGE
        ? rOuter
        : rInner + (rOuter - rInner) * Math.sqrt(rng());
      const position = new THREE.Vector3(r * Math.cos(theta), r * Math.sin(theta), 0);
      const direction = position.lengthSq() > 1e-8
        ? position.clone().normalize()
        : fallbackDirection.clone();
      return { position, direction, angle: theta };
    }
    case UNITY_SHAPE_CONE:
    case UNITY_SHAPE_CONE_VOLUME: {
      // Cone base is a disc on the XY plane of given radius. Approximate Unity's
      // cone direction by tilting from +Z toward the sampled radial direction.
      const r = (shape.radius || 0) * Math.sqrt(rng());
      const a = rng() * 2 * Math.PI;
      const radial = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
      const angle = (shape.angleDeg ?? 25) * Math.PI / 180;
      const direction = new THREE.Vector3(
        radial.x * Math.sin(angle),
        radial.y * Math.sin(angle),
        Math.cos(angle)
      ).normalize();
      return {
        position: new THREE.Vector3(r * radial.x, r * radial.y, 0),
        direction,
        angle: a,
      };
    }
    default:
      return { position: null, direction: fallbackDirection, angle: 0 };
  }
}

function sampleShapePosition(shape, spread, rng = Math.random) {
  return sampleShape(shape, spread, rng).position;
}

function sampleMinMax(spec, rng = Math.random) {
  if (!spec) return 0;
  const state = spec.minMaxState ?? 0;
  const scalar = Number(spec.scalar ?? 0);
  const minScalar = Number(spec.minScalar ?? scalar);
  if (state === MMS_TWO_CONSTANTS) {
    const lo = Math.min(minScalar, scalar);
    const hi = Math.max(minScalar, scalar);
    return lo + (hi - lo) * rng();
  }
  // Curves are not evaluated yet — fall back to scalar sample (constant).
  return scalar;
}

function evaluateCurve(curve, t, fallback = 1) {
  const keys = curve?.m_Curve;
  if (!Array.isArray(keys) || !keys.length) return fallback;
  const x = clamp01(t);
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (x <= Number(first.time ?? 0)) return Number(first.value ?? fallback);
  if (x >= Number(last.time ?? 1)) return Number(last.value ?? fallback);

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    const ta = Number(a.time ?? 0);
    const tb = Number(b.time ?? 1);
    if (x < ta || x > tb) continue;
    const u = (x - ta) / Math.max(1e-6, tb - ta);
    return Number(a.value ?? fallback) + (Number(b.value ?? fallback) - Number(a.value ?? fallback)) * u;
  }
  return fallback;
}

function sampleMinMaxAt(spec, t, fallback = 1) {
  if (!spec) return fallback;
  const state = spec.minMaxState ?? 0;
  const scalar = Number(spec.scalar ?? fallback);
  if (state === MMS_CURVE || state === MMS_TWO_CURVES) {
    return scalar * evaluateCurve(spec.maxCurve, t, 1);
  }
  return Number.isFinite(scalar) ? scalar : fallback;
}

function readTextureSlotTransform(slot) {
  const scale = Array.isArray(slot?.scale) ? slot.scale : null;
  const offset = Array.isArray(slot?.offset) ? slot.offset : null;
  const sx = Number(scale?.[0] ?? 1) || 1;
  const sy = Number(scale?.[1] ?? 1) || 1;
  const ox = Number(offset?.[0] ?? 0) || 0;
  const oy = Number(offset?.[1] ?? 0) || 0;
  return {
    scale: new THREE.Vector2(sx, sy),
    offset: new THREE.Vector2(ox, oy),
    isNonIdentity: Math.abs(sx - 1) > 1e-6 ||
      Math.abs(sy - 1) > 1e-6 ||
      Math.abs(ox) > 1e-6 ||
      Math.abs(oy) > 1e-6,
  };
}

// Sample a particle's START color. Unity's startColor is a MinMaxGradient whose
// minMaxState is the GRADIENT-mode enum (NOT the curve enum): 0=Color,
// 1=Gradient, 2=TwoColors, 3=TwoGradients, 4=RandomColor. Gradient modes (1,3)
// are sampled at systemT = the emitter's age-at-spawn normalized over its
// duration, so particles born early get the t≈0 end and late ones get t≈1.
// RandomColor (4) samples the gradient at a random t per particle.
function sampleColor(spec, rng = Math.random, systemT = 0) {
  const fallback = { r: 1, g: 1, b: 1, a: 1 };
  if (!spec) return fallback;
  const mode = spec.minMaxState ?? 0;
  const lo = spec.minColor || spec.maxColor || fallback;
  const hi = spec.maxColor || spec.minColor || fallback;
  const t = clamp01(systemT);
  switch (mode) {
    case GRAD_GRADIENT:
      return evaluateRawGradient(spec.maxGradient, t);
    case GRAD_TWO_COLORS: {
      const u = rng();
      return {
        r: (lo.r ?? 1) + ((hi.r ?? 1) - (lo.r ?? 1)) * u,
        g: (lo.g ?? 1) + ((hi.g ?? 1) - (lo.g ?? 1)) * u,
        b: (lo.b ?? 1) + ((hi.b ?? 1) - (lo.b ?? 1)) * u,
        a: (lo.a ?? 1) + ((hi.a ?? 1) - (lo.a ?? 1)) * u,
      };
    }
    case GRAD_TWO_GRADIENTS: {
      const u = rng();
      const a = evaluateRawGradient(spec.minGradient, t);
      const b = evaluateRawGradient(spec.maxGradient, t);
      return {
        r: a.r + (b.r - a.r) * u,
        g: a.g + (b.g - a.g) * u,
        b: a.b + (b.b - a.b) * u,
        a: a.a + (b.a - a.a) * u,
      };
    }
    case GRAD_RANDOM_COLOR:
      return evaluateRawGradient(spec.maxGradient, rng());
    case GRAD_COLOR:
    default:
      return { r: hi.r ?? 1, g: hi.g ?? 1, b: hi.b ?? 1, a: hi.a ?? 1 };
  }
}

function readGradientKey(gradient, index, fallback) {
  const key = gradient?.[`key${index}`] || fallback;
  return {
    r: Number(key?.r ?? fallback.r ?? 1),
    g: Number(key?.g ?? fallback.g ?? 1),
    b: Number(key?.b ?? fallback.b ?? 1),
    a: Number(key?.a ?? fallback.a ?? 1),
  };
}

function collectGradientKeys(gradient, countKey, timePrefix, fallback) {
  const count = Math.max(0, Math.min(8, Number(gradient?.[countKey] ?? 0)));
  const keys = [];
  for (let i = 0; i < count; i++) {
    keys.push({
      time: clamp01(Number(gradient?.[`${timePrefix}${i}`] ?? 0) / 65535),
      color: readGradientKey(gradient, i, fallback),
    });
  }
  keys.sort((a, b) => a.time - b.time);
  return keys;
}

function interpolateKeys(keys, t, pick, fallback) {
  if (!keys.length) return fallback;
  const x = clamp01(t);
  if (x <= keys[0].time) return pick(keys[0]);
  const last = keys[keys.length - 1];
  if (x >= last.time) return pick(last);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (x < a.time || x > b.time) continue;
    const u = (x - a.time) / Math.max(1e-6, b.time - a.time);
    const av = pick(a);
    const bv = pick(b);
    if (typeof av === "number") return av + (bv - av) * u;
    return {
      r: av.r + (bv.r - av.r) * u,
      g: av.g + (bv.g - av.g) * u,
      b: av.b + (bv.b - av.b) * u,
      a: av.a + (bv.a - av.a) * u,
    };
  }
  return fallback;
}

function evaluateRawGradient(gradient, t) {
  const fallback = { r: 1, g: 1, b: 1, a: 1 };
  if (!gradient) return fallback;
  const colorKeys = collectGradientKeys(gradient, "m_NumColorKeys", "ctime", fallback);
  const alphaKeys = collectGradientKeys(gradient, "m_NumAlphaKeys", "atime", fallback);
  const rgb = interpolateKeys(colorKeys, t, (k) => k.color, fallback);
  const alpha = interpolateKeys(alphaKeys, t, (k) => k.color.a, fallback.a);
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha };
}

function evaluateGradient(gradientSpec, t) {
  return evaluateRawGradient(gradientSpec?.maxGradient, t);
}

function rgbNear(color, target, tolerance = 1e-3) {
  return (
    Math.abs(Number(color?.r ?? 1) - target) <= tolerance &&
    Math.abs(Number(color?.g ?? 1) - target) <= tolerance &&
    Math.abs(Number(color?.b ?? 1) - target) <= tolerance
  );
}

function gradientRgbOnlyFadesFromInvisibleDark(gradientSpec) {
  const gradient = gradientSpec?.maxGradient;
  if (!gradient) return false;
  const colorKeys = collectGradientKeys(gradient, "m_NumColorKeys", "ctime", { r: 1, g: 1, b: 1, a: 1 });
  if (colorKeys.length < 2) return false;

  let sawVisibleWhite = false;
  let sawInvisibleDark = false;
  for (const key of colorKeys) {
    const color = key.color || {};
    const alpha = Number(color.a ?? 1);
    if (alpha <= 1e-3) {
      if (rgbNear(color, 0, 5e-2)) {
        sawInvisibleDark = true;
      } else if (!rgbNear(color, 1)) {
        return false;
      }
      continue;
    }

    if (!rgbNear(color, 1)) return false;
    sawVisibleWhite = true;
  }

  return sawVisibleWhite && sawInvisibleDark;
}

function buildBillboardGeometry(capacity) {
  const base = new THREE.BufferGeometry();
  base.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.5, -0.5, 0,
     0.5, -0.5, 0,
     0.5,  0.5, 0,
    -0.5,  0.5, 0,
  ], 3));
  base.setAttribute("uv", new THREE.Float32BufferAttribute([
    0, 0,  1, 0,  1, 1,  0, 1,
  ], 2));
  base.setIndex([0, 1, 2, 0, 2, 3]);

  const geom = new THREE.InstancedBufferGeometry();
  geom.index = base.index;
  geom.setAttribute("position", base.attributes.position);
  geom.setAttribute("uv", base.attributes.uv);

  const centers = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
  const rotations = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
  const frames = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
  const flips = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("instanceCenter", centers);
  geom.setAttribute("instanceColor", colors);
  geom.setAttribute("instanceSize", sizes);
  geom.setAttribute("instanceRotation", rotations);
  geom.setAttribute("instanceFrame", frames);
  geom.setAttribute("instanceFlip", flips);
  geom.instanceCount = 0;
  return { geometry: geom, attrs: { centers, colors, sizes, rotations, frames, flips } };
}

function makeBillboardMaterial(texture, tilesX, tilesY, frameU, frameV, color, texMode, blend, renderState, billboard = true, pivot = null) {
  const b = blend || { blending: THREE.AdditiveBlending, premultiply: false };
  const material = new THREE.ShaderMaterial({
    uniforms: {
      u_Tex: { value: texture },
      u_Tiles: { value: new THREE.Vector2(tilesX || 1, tilesY || 1) },
      u_Frame: { value: new THREE.Vector2(frameU || 0, frameV || 0) },
      u_Pivot: { value: new THREE.Vector2(Number(pivot?.x ?? 0) || 0, Number(pivot?.y ?? 0) || 0) },
      u_Color: { value: color || new THREE.Vector4(1, 1, 1, 1) },
      // 0 = direct (use tex.rgba for color + alpha)
      // 1 = mask  (tex.alpha or luminance is the shape; color comes from u_Color * vColor)
      u_TexMode: { value: texMode | 0 },
      // 1 = premultiply rgb by alpha (for One,1-SrcAlpha "AlphaBlend_Add" shaders
      // rendered via THREE NormalBlending, and One,One "Additive_0").
      u_Premultiply: { value: b.premultiply ? 1 : 0 },
      // Unity Multiplicative_0 uses Blend DstColor Zero, so transparent pixels
      // must output white (no-op) rather than rely on destination alpha blending.
      u_Multiplicative: { value: b.multiplicative ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 instanceCenter;
      attribute vec4 instanceColor;
      attribute vec2 instanceSize;
      attribute float instanceRotation;
      attribute vec2 instanceFrame;
      attribute vec2 instanceFlip;
      uniform vec2 u_Pivot;
      varying vec2 vUv;
      varying vec2 vFrame;
      varying vec2 vFlip;
      varying vec4 vColor;
      void main() {
        vUv = uv;
        vFrame = instanceFrame;
        vFlip = instanceFlip;
        vColor = instanceColor;
        ${billboard ? /* glsl */ `
        // View/Facing/Stretch billboards add the corner in view space below,
        // which bypasses modelViewMatrix scale. Unity scalingMode=Hierarchy
        // still scales these particles, so fold the object hierarchy scale into
        // the local corner before billboard-facing it.
        vec2 billboardHierarchyScale = vec2(
          length(modelMatrix[0].xyz),
          length(modelMatrix[1].xyz)
        );
        ` : /* glsl */ `
        vec2 billboardHierarchyScale = vec2(1.0);
        `}
        // Unity's ParticleSystemRenderer pivot is an authored offset from the
        // particle center. Negative Y should pull the quad below the emitter
        // origin (e.g. CH0145 Miyu's face emotion mark), not push it upward.
        vec3 rotated = vec3((position.xy + u_Pivot) * instanceSize * billboardHierarchyScale, position.z);
        float c = cos(instanceRotation);
        float s = sin(instanceRotation);
        rotated = vec3(rotated.x * c - rotated.y * s, rotated.x * s + rotated.y * c, rotated.z);
        ${billboard ? /* glsl */ `
        // View/Facing: add the rotated corner in VIEW space so the quad always
        // faces the camera (offset is camera-plane-aligned).
        vec4 mvCenter = modelViewMatrix * vec4(instanceCenter, 1.0);
        vec4 mvPos = mvCenter + vec4(rotated, 0.0);
        ` : /* glsl */ `
        // World/Local: add the rotated corner in the emitter's OBJECT space, so
        // the quad lies in the emitter local XY plane (a decal glued to the
        // surface) and foreshortens correctly as the camera orbits.
        vec4 mvPos = modelViewMatrix * vec4(instanceCenter + rotated, 1.0);
        `}
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D u_Tex;
      uniform vec2 u_Tiles;
      uniform vec2 u_Frame;
      uniform vec4 u_Color;
      uniform int u_TexMode;
      uniform int u_Premultiply;
      uniform int u_Multiplicative;
      varying vec2 vUv;
      varying vec2 vFrame;
      varying vec2 vFlip;
      varying vec4 vColor;
      void main() {
        vec2 localUv = mix(vUv, vec2(1.0) - vUv, step(0.5, vFlip));
        vec2 tiled = (u_Frame + vFrame) + localUv / u_Tiles;
        vec4 tex = texture2D(u_Tex, tiled);
        vec4 c;
        if (u_TexMode == 1) {
          // Mask composite: shape comes from texture (alpha if meaningful,
          // else luminance), color comes from material _Color * particle vColor.
          // BA fx masks store the cutout shape in tex.a; some store it in
          // RGB with full-opaque alpha — handle both via the same fallback.
          float maskAlpha = tex.a < 0.99 ? tex.a : max(max(tex.r, tex.g), tex.b);
          c = vec4(u_Color.rgb, u_Color.a * maskAlpha) * vColor;
        } else if (u_TexMode == 2) {
          // Coverage texture: grayscale RGB stores only the soft alpha shape
          // (_RGBRGBA=0 DSFX glows). Color must come from material/particle tint.
          float coverage = max(max(tex.r, tex.g), tex.b);
          c = vec4(u_Color.rgb, u_Color.a * coverage) * vColor;
        } else {
          // Direct mode: texture carries full RGBA color (Emotion atlas, etc).
          float lum = max(max(tex.r, tex.g), tex.b);
          float texAlpha = tex.a < 0.99 ? tex.a * lum : lum;
          c = vec4(tex.rgb, texAlpha) * u_Color * vColor;
        }
        if (c.a < 0.005) discard;
        if (u_Multiplicative == 1) {
          c.rgb = mix(vec3(1.0), c.rgb, clamp(c.a, 0.0, 1.0));
          c.a = 1.0;
        } else if (u_Premultiply == 1) {
          // Premultiplied-alpha blend (Unity One,1-SrcAlpha / One,One): fold
          // alpha into rgb so THREE reproduces the additive-over result.
          c.rgb *= c.a;
        }
        gl_FragColor = c;
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: renderState?.depthTest ?? true,
    side: THREE.DoubleSide,
    toneMapped: false,
    blending: b.blending,
    // The fragment shader already premultiplies rgb by alpha for the One,*
    // Unity blends (AlphaBlend_Add / _Add_Mask / Step -> One,1-SrcAlpha;
    // Additive_0 -> One,One). THREE's NormalBlending/AdditiveBlending default to
    // a SrcAlpha source factor, which would multiply by alpha a SECOND time and
    // darken soft low-alpha masks (the cheek-blush turning dark). Setting
    // premultipliedAlpha switches the source factor to One so the GPU blend
    // matches the shader's manual premultiply exactly.
    premultipliedAlpha: !!b.premultiply,
  });
  applyFxBlendState(material, b);
  return material;
}

// Compute a single (u, v) tile offset based on UVModule.frameOverTime.scalar.
// Curve-driven frames are not evaluated; the constant scalar pins to one cell.
function computeUvFrame(uv) {
  return computeUvFrameAt(uv, 0);
}

function computeUvFrameAt(uv, normalizedTime) {
  if (!uv?.enabled) return { tilesX: 1, tilesY: 1, u: 0, v: 0 };
  const tilesX = Math.max(1, Number(uv?.tilesX || 1));
  const tilesY = Math.max(1, Number(uv?.tilesY || 1));
  const animType = Number(uv?.animationType || 0);
  const rowIndex = Math.max(0, Math.min(tilesY - 1, Number(uv?.rowIndex || 0)));
  const cycles = Math.max(0, Number(uv?.cycles ?? 1) || 1);
  const baseFrame = sampleMinMaxAt(uv?.frameOverTime, normalizedTime, Number(uv?.frameOverTime?.scalar ?? 0) || 0);
  const startFrame = sampleMinMaxAt(uv?.startFrame, normalizedTime, Number(uv?.startFrame?.scalar ?? 0) || 0);
  const frameScalar = ((baseFrame * cycles + startFrame) % 1 + 1) % 1;
  // Unity indexes texture-sheet rows top-to-bottom. With tex.flipY=false,
  // THREE's V offset needs the inverted row so atlas frame N samples the same
  // tile Unity chose (CH0335 Shy emotion marks use a 1x2 sheet).
  const unityRowToV = (row) => (tilesY - 1 - row) / tilesY;
  if (animType === 1) {
    const col = Math.max(0, Math.min(tilesX - 1, Math.floor(frameScalar * tilesX)));
    return { tilesX, tilesY, u: col / tilesX, v: unityRowToV(rowIndex) };
  }
  const total = tilesX * tilesY;
  const idx = Math.max(0, Math.min(total - 1, Math.floor(frameScalar * total)));
  const col = idx % tilesX;
  const row = Math.floor(idx / tilesX);
  return { tilesX, tilesY, u: col / tilesX, v: unityRowToV(row) };
}

function minMaxPositiveBound(spec) {
  if (!spec) return 0;
  const scalar = Number(spec.scalar ?? 0);
  const minScalar = Number(spec.minScalar ?? scalar);
  let maxValue = Math.max(
    Number.isFinite(scalar) ? scalar : 0,
    Number.isFinite(minScalar) ? minScalar : 0
  );
  for (const curveName of ["maxCurve", "minCurve"]) {
    const keys = spec[curveName]?.m_Curve;
    if (!Array.isArray(keys)) continue;
    for (const key of keys) {
      const value = Number(key?.value ?? 0);
      if (Number.isFinite(value)) maxValue = Math.max(maxValue, value);
    }
  }
  return maxValue;
}

function hasParticleEmission(particleData) {
  const emission = particleData?.EmissionModule || {};
  if (!emission.enabled) return false;
  if (minMaxPositiveBound(emission.rateOverTime) > 0) return true;
  const bursts = Array.isArray(emission.m_Bursts) ? emission.m_Bursts : [];
  return bursts.some((burst) => {
    const probability = Number(burst?.probability ?? 1);
    const cycleCount = Number(burst?.cycleCount ?? 1);
    return probability > 0 && cycleCount !== 0 && minMaxPositiveBound(burst?.countCurve) > 0;
  });
}

function isRenderableParticleSystem(particleData) {
  const renderer = particleData?.renderer || {};
  if (renderer.enabled === false) return false;
  if (Number(renderer.render_mode) === UNITY_RENDER_MODE_NONE) return false;
  const materials = Array.isArray(renderer.materials)
    ? renderer.materials.filter(Boolean)
    : [];
  return materials.length > 0 && hasParticleEmission(particleData);
}

class FxEmitter {
  constructor(particleData, options = {}) {
    this.data = particleData;
    this.duration = Number(particleData.lengthInSec ?? 1);
    this.looping = !!particleData.looping;
    // MainModule startDelay: how long after prefab activation this system waits
    // before it begins simulating/emitting. Unity stages the systems of one
    // prefab via per-system delays (e.g. CH0334 Cafe_Reaction: find_emotion at
    // 0s, rect_particle at 1.27s, the rest at ~3.6s). Without it every system
    // emits on the first trigger. startDelay is a constant MinMaxCurve.
    this.startDelay = Math.max(0, sampleMinMax(particleData.startDelay));
    this.delayRemaining = this.startDelay;
    const renderer = particleData.renderer || {};
    this.isMeshMode =
      Number(renderer.render_mode) === UNITY_RENDER_MODE_MESH && !!renderer.mesh;
    this.camera = options.camera || null;

    const init = particleData.InitialModule || {};
    this.startLifetime = init.startLifetime;
    this.startSize = init.startSize;
    this.startSizeY = init.startSizeY;
    this.startSizeZ = init.startSizeZ;
    this.size3D = !!init.size3D;
    this.startColor = init.startColor;
    this.startRotationX = init.startRotationX;
    this.startRotationY = init.startRotationY;
    this.startRotationZ = init.startRotation;
    this.startRotation = this.startRotationZ;
    this.startSpeed = init.startSpeed;
    const cap = Number(init.maxNumParticles ?? DEFAULT_CAPACITY);
    this.capacity = Math.max(1, Math.min(MAX_EMITTER_CAPACITY, Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_CAPACITY));

    const emission = particleData.EmissionModule || {};
    this.emissionEnabled = !!emission.enabled;
    this.rateOverTime = emission.rateOverTime;
    // m_Bursts is sometimes a list even when m_BurstCount=0; honour what's there.
    this.bursts = Array.isArray(emission.m_Bursts) ? emission.m_Bursts : [];
    this.isStretchMode = Number(renderer.render_mode) === UNITY_RENDER_MODE_STRETCH;
    this.renderAlignment = Number(renderer.render_alignment ?? 0);
    // Billboard (camera-facing) only for View/Facing. World/Local keep the
    // emitter object-space frame; Velocity orients each mesh to its own motion.
    this.isBillboardAlignment =
      this.renderAlignment === UNITY_RENDER_ALIGNMENT_VIEW ||
      this.renderAlignment === UNITY_RENDER_ALIGNMENT_FACING;
    this.isVelocityAlignment = this.renderAlignment === UNITY_RENDER_ALIGNMENT_VELOCITY;
    this.velocityScale = Number(renderer.velocity_scale ?? 0) || 0;
    // m_LengthScale stretches the billboard along its velocity in Stretch mode.
    // Only meaningful for Stretch billboards (not Mesh particles); the sign is
    // a Unity authoring convention that does not flip the rendered quad.
    this.lengthScale = Math.abs(Number(renderer.length_scale ?? 2)) || 2;
    // m_Pivot: per-particle anchor offset (in size-relative mesh units). For the
    // velocity-aligned emotion marks, pivot.y=0.5 base-anchors each "!" bar at its
    // spawn point so it extends outward as a radial ray (the in-game sunburst).
    this.pivot = new THREE.Vector3(
      Number(renderer.pivot?.x ?? 0) || 0,
      Number(renderer.pivot?.y ?? 0) || 0,
      Number(renderer.pivot?.z ?? 0) || 0
    );

    const colorModule = particleData.ColorModule || {};
    this.colorOverLifetime = colorModule.enabled ? colorModule.gradient : null;
    this.lifetimeColorAlphaOnly = false;
    const customDataModule = particleData.CustomDataModule || {};
    const customDataVectorMode = customDataModule.enabled && Number(customDataModule.mode0) === 1;
    this.customDataUvOffsetX = customDataVectorMode ? customDataModule.vector0_0 : null;
    this.customDataUvOffsetY = customDataVectorMode ? customDataModule.vector0_1 : null;
    this.usesCustomUvOffset = false;
    this.textureUvScale = new THREE.Vector2(1, 1);
    this.textureUvOffsetBase = new THREE.Vector2(0, 0);
    const sizeModule = particleData.SizeModule || {};
    this.sizeOverLifetime = sizeModule.enabled ? sizeModule.curve : null;
    this.sizeOverLifetimeY = sizeModule.enabled && sizeModule.separateAxes ? sizeModule.y : null;

    // ShapeModule: where particles spawn. The MVP previously emitted everything
    // at the emitter origin, so burst particles meant to fan out along a shape
    // (e.g. the "!!" emotion marks on a Circle arc) collapsed to one point.
    const shape = particleData.ShapeModule || {};
    this.shape = shape.enabled
      ? {
          type: Number(shape.type),
          radius: Number((shape.radius && shape.radius.value) ?? 0),
          arcDeg: Number((shape.arc && shape.arc.value) ?? 360),
          arcRad: Number((shape.arc && shape.arc.value) ?? 360) * Math.PI / 180,
          arcMode: Number((shape.arc && shape.arc.mode) ?? 0),
          angleDeg: Number(shape.angle ?? 25),
          radiusThickness: Number(shape.radiusThickness ?? 1),
        }
      : null;

    this.uvModule = particleData.UVModule;
    this.uvFrame = computeUvFrame(this.uvModule);
    this.pivotMirrorU =
      !this.isStretchMode &&
      this.isBillboardAlignment &&
      this.pivot.x > 1e-5 &&
      this.uvFrame.tilesX === 1 &&
      this.uvFrame.tilesY > 1;

    this.particles = new Array(this.capacity).fill(null).map(() => ({ alive: false }));
    this.age = 0;
    this.rateAccumulator = 0;
    this.firedBurstCycles = new Array(this.bursts.length).fill(0);
    this.dead = false;
    this.liveCount = 0;

    this.geometry = null;
    this.attrs = null;
    this.material = null;
    this.mesh = null;
    this.meshTemplate = null;
    this.meshParticleObjects = null;
  }

  init(textureCache, materialLookup, meshLookup = {}, meshFrameFixLookup = {}) {
    const { geometry, attrs } = buildBillboardGeometry(this.capacity);
    this.geometry = geometry;
    this.attrs = attrs;

    // Resolve material + texture from renderer info dumped by dump_fx.py
    // (renderer.materials[0]). BA fx materials follow two patterns:
    //   1) Single-texture: _Texture / _MainTex carries the full RGBA atlas
    //      (used by FX_MAT_Emotion_03, ParticlesUnlit, ...).
    //   2) Mask composite: _Tex_Main is a solid-color carrier (often
    //      FX_TEX_White_01 4x4) and _Tex_Mask provides the actual alpha
    //      shape of the effect (used by FX_MAT_Shy_08 for cheek blush). The
    //      runtime samples mask.luminance * main.rgb so the colored white
    //      square doesn't show through.
    const renderer = this.data.renderer || {};
    const matName = (renderer.materials || [])[0] || null;
    const matData = matName ? materialLookup?.[matName] : null;
    const tex_slot = matData?.textures || {};

    // Resolve a material texture slot to a loaded THREE.Texture. Prefer the
    // stable path_id (schema v3 — disambiguates name-collided variants like the
    // 64x64 yellow vs 128x16 gray FX_TEX_Color_01); fall back to name for v2
    // dumps and slots without a path_id.
    const resolveSlot = (slot) => {
      if (!slot) return null;
      if (slot.path_id != null && textureCache[slot.path_id]) return textureCache[slot.path_id];
      if (slot.name && textureCache[slot.name]) return textureCache[slot.name];
      return null;
    };

    // Detect mask-composite path: presence of _Tex_Mask alongside a tiny
    // single-color _Tex_Main (the FX_TEX_White_01 placeholder pattern).
    const maskTexName = tex_slot._Tex_Mask?.name || null;
    const isMaskComposite = !!(maskTexName && (tex_slot._Tex_Main || tex_slot._MainTex));

    const usesCoverageTexture =
      !isMaskComposite &&
      Number(matData?.floats?._RGBRGBA ?? 1) === 0 &&
      /AlphaBlend_Add|AlwaysView_Add|Additive|\bStep/.test(String(matData?.shader || ""));
    const materialTintedTexture = isMaskComposite || usesCoverageTexture;
    this.lifetimeColorAlphaOnly =
      materialTintedTexture && gradientRgbOnlyFadesFromInvisibleDark(this.colorOverLifetime);

    let mainTexture = null;
    let mainTextureSlot = null;
    let maskTexture = null;
    if (isMaskComposite) {
      // Use mask as the renderable shape, main as solid tint (skip the
      // tiny white_01 lookup entirely — its 4x4 size offers no detail).
      maskTexture = resolveSlot(tex_slot._Tex_Mask);
      stabilizeMaskTexture(maskTexture);
      mainTexture = maskTexture; // fragment shader uses one sampler
      mainTextureSlot = tex_slot._Tex_Mask || tex_slot._Tex_Main || tex_slot._MainTex || null;
    } else {
      const candidates = [
        tex_slot._Texture,
        tex_slot._MainTex,
        tex_slot._Tex_Main,
        tex_slot._Tex_Mask,
      ];
      for (const slot of candidates) {
        const resolved = resolveSlot(slot);
        if (resolved) {
          mainTexture = resolved;
          mainTextureSlot = slot;
          break;
        }
      }
    }

    let texture = mainTexture;
    if (!texture) {
      texture = makeSoftGlowTexture();
      this._fallbackTexture = texture;
    }
    const textureTransform = readTextureSlotTransform(mainTextureSlot);
    this.textureUvScale.copy(textureTransform.scale);
    this.textureUvOffsetBase.copy(textureTransform.offset);
    this.usesCustomUvOffset =
      Number(matData?.floats?._Custom_Data_MainMask_Offset_Use ?? 0) > 0 &&
      !!(this.customDataUvOffsetX || this.customDataUvOffsetY);
    // NOTE: wrap mode is applied once at load (ensureTextures) from each asset's
    // Unity-authored m_WrapU/m_WrapV — it is NOT forced to Repeat here. A scaled
    // or scrolled UV (textureTransform.isNonIdentity / usesCustomUvOffset) does
    // not imply tiling: BA gradient ramps are Clamp, and forcing Repeat tiled the
    // CH0325 head_red blush into 3 stacked sweeps instead of one rising front.

    // BA fx _Color is authored as HDR (values reach 2–24×). Unity renders the
    // raw value × texture, so the HDR drives both color and the bloom that makes
    // marks/glows read as bright in-game. We faithfully keep _Color and tame ONLY
    // genuine flashbangs via the hue-preserving FX_COLOR_CEILING clamp below.
    //
    // (Previously a flat HDR_SAFETY=0.35 pre-multiply also scaled every _Color
    // down. That double-attenuation crushed moderate-HDR FX below the 1.5 bloom
    // threshold — e.g. the Cafe_Reaction emotion marks (_Color=2.0) rendered at
    // 0.70: dim olive bars instead of the bright orange sunburst. The ceiling
    // alone already clamps the extreme tints — White_05=23.97 lands on 2.5 with
    // or without the pre-multiply — so the pre-crush only ever hurt the mids.)
    const colorVec = (() => {
      const c = matData?.colors?._Color || matData?.colors?._BaseColor || matData?.colors?._TintColor || { r: 1, g: 1, b: 1, a: 1 };
      let r = c.r ?? 1;
      let g = c.g ?? 1;
      let b = c.b ?? 1;
      // Hue-preserving soft ceiling: scale all channels by one factor so an
      // extreme tint (e.g. FX_MAT_White_05 _Color=23.97 on the antenna glow,
      // paired with a solid-white carrier + additive blend) still blooms as a
      // glow rather than a white block. Peaks already under the ceiling are
      // untouched, so marks at 2.0 keep their full above-bloom-threshold value.
      const peak = Math.max(r, g, b);
      if (peak > FX_COLOR_CEILING) {
        const k = FX_COLOR_CEILING / peak;
        r *= k;
        g *= k;
        b *= k;
      }
      return new THREE.Vector4(r, g, b, c.a ?? 1);
    })();

    const fxBlend = resolveFxBlend(matData?.shader);
    const fxRenderState = resolveFxRenderState(matData, renderer);

    this.material = makeBillboardMaterial(
      texture,
      this.uvFrame.tilesX,
      this.uvFrame.tilesY,
      0,
      0,
      colorVec,
      isMaskComposite ? 1 : (usesCoverageTexture ? 2 : 0),
      fxBlend,
      fxRenderState,
      // Billboard (camera-facing) for View/Facing; for World/Local lay the quad
      // flat in the emitter's object-space frame so it sticks to the surface
      // (the cheek decal) instead of swinging toward the camera. Velocity-mode
      // billboards are stretch quads handled in _writeAttrs, keep them camera-facing.
      this.isBillboardAlignment || this.isVelocityAlignment,
      this.pivot
    );

    const meshTemplate = this.isMeshMode ? meshLookup[renderer.mesh] : null;
    if (meshTemplate) {
      this.geometry.dispose();
      this.geometry = null;
      this.attrs = null;
      this.material.dispose();
      this.material = null;
      this.meshTemplate = meshTemplate;
      this.mesh = new THREE.Group();
      this.mesh.name = `FxMeshEmitter_${this.data.go_name || "unnamed"}`;
      // Mesh particles are authored in a bone-local frame that differs from the
      // exported glTF bone node, so apply the data-driven frame fix (index.json
      // meshes[].frame_quat, computed by tools/fx/compute_mesh_frame_fix.py),
      // falling back to the legacy table for pre-field dumps.
      applyMeshParticleFrameFix(
        this.mesh,
        resolveMeshFrameFix(renderer.mesh, meshFrameFixLookup[renderer.mesh])
      );
      const meshCullSide = resolveMeshCullSide(matData);
      this.meshParticleObjects = this.particles.map(() =>
        this._createMeshParticleObject(texture, colorVec, fxBlend, fxRenderState, meshCullSide)
      );
      for (const obj of this.meshParticleObjects) {
        obj.visible = false;
        this.mesh.add(obj);
      }
      return;
    }

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = `FxEmitter_${this.data.go_name || "unnamed"}`;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = fxRenderState.renderOrder;
  }

  _createMeshParticleObject(texture, baseColor, blend, renderState = null, cullSide = THREE.DoubleSide) {
    const b = blend || { blending: THREE.AdditiveBlending, premultiply: false };
    const root = this.meshTemplate.clone(true);
    root.frustumCulled = false;
    root.userData.fxBaseColor = baseColor.clone();
    const materials = [];
    root.traverse((child) => {
      if (!child.isMesh) return;
      const mat = new THREE.MeshBasicMaterial({
        map: texture || null,
        color: new THREE.Color(baseColor.x, baseColor.y, baseColor.z),
        transparent: true,
        opacity: baseColor.w,
        depthWrite: false,
        depthTest: renderState?.depthTest ?? true,
        side: cullSide,
        toneMapped: false,
        blending: b.blending,
        // Matches makeBillboardMaterial: the patched fragment below premultiplies
        // rgb by alpha for One,* Unity blends, so premultipliedAlpha must switch
        // the GPU source factor to One to avoid a second alpha multiply (which
        // would darken the disc instead of fading it).
        premultipliedAlpha: !!b.premultiply,
      });
      applyFxBlendState(mat, b);
      mat.userData.fxUvScale = this.textureUvScale.clone();
      mat.userData.fxUvOffset = this.textureUvOffsetBase.clone();
      // BA DSFX glow-disc materials (FX_Circle_01, FX_Ngone_01) ship a grey
      // radial texture with alpha=255 and derive coverage from RGB luminance
      // (the shader's _RGBRGBA path). MeshBasicMaterial otherwise samples the
      // opaque alpha and draws a solid disc — the "blob". Patch the fragment to
      // derive coverage from the raw texel (luminance when alpha is opaque,
      // else texAlpha*luminance — mirrors makeBillboardMaterial), and
      // premultiply for One,1-SrcAlpha shaders so the disc fades at its edges
      // like in-game.
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.u_Premultiply = { value: b.premultiply ? 1 : 0 };
        shader.uniforms.u_Multiplicative = { value: b.multiplicative ? 1 : 0 };
        shader.uniforms.u_FxUvScale = { value: mat.userData.fxUvScale };
        shader.uniforms.u_FxUvOffset = { value: mat.userData.fxUvOffset };
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            "#include <common>\nuniform int u_Premultiply;\nuniform int u_Multiplicative;\nuniform vec2 u_FxUvScale;\nuniform vec2 u_FxUvOffset;\nvec4 fxRawTexel;"
          )
          .replace(
            "#include <map_fragment>",
            `#ifdef USE_MAP
              vec2 fxMapUv = vMapUv * u_FxUvScale + u_FxUvOffset;
              fxRawTexel = texture2D( map, fxMapUv );
              diffuseColor *= fxRawTexel;
            #else
              fxRawTexel = vec4(1.0);
            #endif`
          )
          .replace(
            "#include <dithering_fragment>",
            `#include <dithering_fragment>
            {
              float fxLum = max(max(fxRawTexel.r, fxRawTexel.g), fxRawTexel.b);
              float fxCov = fxRawTexel.a < 0.99 ? fxRawTexel.a * fxLum : fxLum;
              gl_FragColor.a = opacity * fxCov;
              if (u_Multiplicative == 1) {
                gl_FragColor.rgb = mix(vec3(1.0), gl_FragColor.rgb, clamp(gl_FragColor.a, 0.0, 1.0));
                gl_FragColor.a = 1.0;
              } else if (u_Premultiply == 1) {
                gl_FragColor.rgb *= gl_FragColor.a;
              }
            }`
          );
      };
      child.material = mat;
      child.frustumCulled = false;
      child.renderOrder = renderState?.renderOrder ?? 0;
      materials.push(mat);
    });
    root.userData.fxMaterials = materials;
    // Apply m_Pivot as a base-anchor: shift each cloned mesh child by +pivot (in
    // mesh-local units) so the per-frame root transform anchors each "!" bar's
    // base at its spawn point and extends it OUTWARD along the radial (velocity)
    // axis — the wide in-game sunburst. (Offsetting by -pivot instead points the
    // bars inward, bunching their tips at the small spawn circle.) No-op for
    // pivot=0 emitters (discs, antenna).
    if (this.pivot.lengthSq() > 1e-8) {
      for (const child of root.children) {
        child.position.add(this.pivot);
      }
    }
    return root;
  }

  _spawnOne(rng, spread = null) {
    let slot = -1;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.particles[i].alive) { slot = i; break; }
    }
    if (slot < 0) return;
    const p = this.particles[slot];
    p.alive = true;
    p.age = 0;
    p.lifetime = Math.max(0.05, sampleMinMax(this.startLifetime, rng));
    const sx = sampleMinMax(this.startSize, rng);
    const sy = this.size3D ? sampleMinMax(this.startSizeY, rng) : sx;
    const sz = this.size3D ? sampleMinMax(this.startSizeZ, rng) : sx;
    p.sizeX = Math.max(0.01, sx > 0 ? sx : 0.2);
    p.sizeY = Math.max(0.01, sy > 0 ? sy : p.sizeX);
    p.sizeZ = Math.max(0.01, sz > 0 ? sz : p.sizeX);
    // systemT: emitter age-at-spawn normalized over duration (Unity samples
    // startColor gradients on this axis). Looping systems wrap each cycle.
    const dur = this.duration > 1e-6 ? this.duration : 1;
    const systemT = this.looping ? (this.age % dur) / dur : clamp01(this.age / dur);
    p.color = sampleColor(this.startColor, rng, systemT);
    p.rotationX = sampleMinMax(this.startRotationX, rng);
    p.rotationY = sampleMinMax(this.startRotationY, rng);
    p.rotationZ = sampleMinMax(this.startRotationZ, rng);
    p.rotation = p.rotationZ;
    if (!p.position) p.position = new THREE.Vector3();
    if (!p.velocity) p.velocity = new THREE.Vector3();
    // Spawn position from the ShapeModule (fans burst particles along the shape);
    // emitters with no shape stay at the emitter origin.
    const shapeSample = sampleShape(this.shape, spread, rng);
    if (shapeSample.position) p.position.copy(shapeSample.position);
    else p.position.set(0, 0, 0);
    const speed = Math.max(0, sampleMinMax(this.startSpeed, rng));
    p.velocity.copy(shapeSample.direction).multiplyScalar(speed);
    this.liveCount++;
  }

  update(dt, rng = Math.random) {
    if (this.dead) return;
    // Hold the system inert until its startDelay elapses. age stays 0 so bursts
    // and lifetime curves begin fresh the moment the system actually starts.
    // Carry any dt overshoot past the delay into this frame's simulation.
    if (this.delayRemaining > 0) {
      if (this.delayRemaining >= dt) {
        this.delayRemaining -= dt;
        return;
      }
      dt -= this.delayRemaining;
      this.delayRemaining = 0;
    }
    const wasInDuration = this.age <= this.duration;
    this.age += dt;

    // Bursts: each burst has time, countCurve, cycleCount, repeatInterval.
    for (let i = 0; i < this.bursts.length; i++) {
      const b = this.bursts[i] || {};
      const cycleCount = Math.max(1, Number(b.cycleCount ?? 1));
      if (this.firedBurstCycles[i] >= cycleCount) continue;
      const baseTime = Number(b.time ?? 0);
      const interval = Math.max(0.0001, Number(b.repeatInterval ?? 0));
      const nextTime = baseTime + this.firedBurstCycles[i] * interval;
      if (this.age >= nextTime) {
        const probability = Number(b.probability ?? 1);
        if (rng() <= probability) {
          const count = Math.max(0, Math.floor(sampleMinMax(b.countCurve, rng)));
          for (let n = 0; n < count; n++) this._spawnOne(rng, { index: n, total: count });
        }
        this.firedBurstCycles[i] += 1;
      }
    }

    // Rate-over-time: only while emission is enabled and we're inside duration
    // (or looping forever).
    if (this.emissionEnabled && (this.looping || wasInDuration)) {
      const rate = sampleMinMax(this.rateOverTime, rng);
      if (rate > 0) {
        this.rateAccumulator += rate * dt;
        const count = Math.floor(this.rateAccumulator);
        for (let i = 0; i < count; i++) this._spawnOne(rng);
        this.rateAccumulator -= count;
      }
    }

    // Age + cull
    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      if (p.velocity) p.position.addScaledVector(p.velocity, dt);
      p.age += dt;
      if (p.age >= p.lifetime) {
        p.alive = false;
        this.meshParticleObjects?.[i] && (this.meshParticleObjects[i].visible = false);
        continue;
      }
      live++;
    }
    this.liveCount = live;

    // One-shot prefab: dead once duration elapsed AND no live particles remain.
    if (!this.looping && this.age > this.duration + POST_DURATION_GRACE && live === 0) {
      this.dead = true;
    }

    this._writeAttrs();
  }

  _writeMeshObjects() {
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      const obj = this.meshParticleObjects?.[i];
      if (!obj) continue;
      if (!p.alive) {
        obj.visible = false;
        continue;
      }
      obj.visible = true;
      obj.position.copy(p.position);
      if (this.isBillboardAlignment && this.camera) {
        // View / Facing: orient the mesh to face the camera, then apply the
        // particle's start rotation as a roll about the view axis.
        this.camera.getWorldQuaternion(tmpWorldQuat);
        obj.parent?.getWorldQuaternion(tmpParentWorldQuat);
        obj.quaternion.copy(tmpParentWorldQuat.invert().multiply(tmpWorldQuat));
        obj.rotateZ(p.rotationZ || 0);
      } else if (this.isVelocityAlignment) {
        // Velocity: align the mesh's long (+Y) axis to its motion direction in
        // the emitter's authored local frame. With a circle/cone shape this fans
        // the marks out radially (the "!!" emphasis strokes radiating outward).
        // startRotation is authored relative to the View-billboard frame, NOT the
        // velocity frame, so it is NOT added here — adding it rotates each bar
        // tangential instead of radial.
        const vx = p.velocity?.x || 0;
        const vy = p.velocity?.y || 0;
        const velAngle = (Math.abs(vx) + Math.abs(vy) > 1e-6)
          ? Math.atan2(vy, vx) - Math.PI / 2
          : 0;
        obj.rotation.set(0, 0, velAngle);
      } else {
        // World / Local: keep the emitter object-space frame, authored rotation.
        obj.rotation.set(p.rotationX || 0, p.rotationY || 0, p.rotationZ || 0);
      }
      const t = clamp01(p.age / p.lifetime);
      const lifetimeColor = this.colorOverLifetime
        ? evaluateGradient(this.colorOverLifetime, t)
        : null;
      const lifetimeRgb = this.lifetimeColorAlphaOnly ? null : lifetimeColor;
      const fade = 1;
      const customUvOffsetX =
        this.usesCustomUvOffset && this.customDataUvOffsetX
          ? sampleMinMaxAt(this.customDataUvOffsetX, t, 0)
          : 0;
      const customUvOffsetY =
        this.usesCustomUvOffset && this.customDataUvOffsetY
          ? sampleMinMaxAt(this.customDataUvOffsetY, t, 0)
          : 0;
      const sizeScaleX = this.sizeOverLifetime ? sampleMinMaxAt(this.sizeOverLifetime, t, 1) : 1;
      const sizeScaleY = this.sizeOverLifetimeY ? sampleMinMaxAt(this.sizeOverLifetimeY, t, 1) : sizeScaleX;
      obj.scale.set(
        p.sizeX * sizeScaleX,
        p.sizeY * sizeScaleY,
        p.sizeZ * sizeScaleX
      );
      const base = obj.userData.fxBaseColor;
      for (const mat of obj.userData.fxMaterials || []) {
        mat.color.setRGB(
          base.x * p.color.r * (lifetimeRgb?.r ?? 1),
          base.y * p.color.g * (lifetimeRgb?.g ?? 1),
          base.z * p.color.b * (lifetimeRgb?.b ?? 1)
        );
        mat.opacity =
          base.w * (p.color.a ?? 1) * (lifetimeColor?.a ?? 1) * fade;
        mat.userData.fxUvOffset?.set(
          this.textureUvOffsetBase.x + customUvOffsetX,
          this.textureUvOffsetBase.y + customUvOffsetY
        );
      }
    }
  }

  _writeAttrs() {
    if (this.meshParticleObjects) {
      this._writeMeshObjects();
      return;
    }
    const { centers, colors, sizes, rotations, frames, flips } = this.attrs;
    let idx = 0;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      centers.array[idx * 3 + 0] = p.position.x;
      centers.array[idx * 3 + 1] = p.position.y;
      centers.array[idx * 3 + 2] = p.position.z;
      const t = clamp01(p.age / p.lifetime);
      const lifetimeColor = this.colorOverLifetime
        ? evaluateGradient(this.colorOverLifetime, t)
        : null;
      const lifetimeRgb = this.lifetimeColorAlphaOnly ? null : lifetimeColor;
      const fade = 1;
      colors.array[idx * 4 + 0] = p.color.r * (lifetimeRgb?.r ?? 1);
      colors.array[idx * 4 + 1] = p.color.g * (lifetimeRgb?.g ?? 1);
      colors.array[idx * 4 + 2] = p.color.b * (lifetimeRgb?.b ?? 1);
      colors.array[idx * 4 + 3] = (p.color.a ?? 1) * (lifetimeColor?.a ?? 1) * fade;
      const sizeScaleX = this.sizeOverLifetime ? sampleMinMaxAt(this.sizeOverLifetime, t, 1) : 1;
      const sizeScaleY = this.sizeOverLifetimeY ? sampleMinMaxAt(this.sizeOverLifetimeY, t, 1) : sizeScaleX;
      let outSizeX = p.sizeX * sizeScaleX;
      let outSizeY = p.sizeY * sizeScaleY;
      let outRotation = p.rotation;
      if (this.isStretchMode) {
        const speed = p.velocity?.length?.() || 0;
        outSizeY = Math.max(outSizeY, outSizeX + speed * this.lengthScale * 0.12);
        const vx = p.velocity?.x || 0;
        const vy = p.velocity?.y || 0;
        if (Math.abs(vx) + Math.abs(vy) > 1e-5) {
          outRotation = Math.atan2(vy, vx) - Math.PI / 2;
        }
      }
      sizes.array[idx * 2 + 0] = outSizeX;
      sizes.array[idx * 2 + 1] = outSizeY;
      rotations.array[idx] = outRotation;
      const frame = computeUvFrameAt(this.uvModule, t);
      frames.array[idx * 2 + 0] = frame.u;
      frames.array[idx * 2 + 1] = frame.v;
      // CH0335 Shy emotion marks use positive pivot.x on a 1x2 sheet for the
      // mirrored side. Do not apply renderer m_Flip globally; non-Shy flip work
      // remains out of scope for this sidecar.
      flips.array[idx * 2 + 0] = this.pivotMirrorU ? 1 : 0;
      flips.array[idx * 2 + 1] = 0;
      idx++;
    }
    centers.needsUpdate = true;
    colors.needsUpdate = true;
    sizes.needsUpdate = true;
    rotations.needsUpdate = true;
    frames.needsUpdate = true;
    flips.needsUpdate = true;
    this.geometry.instanceCount = idx;
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
    for (const obj of this.meshParticleObjects || []) {
      obj.traverse((child) => {
        if (!child.isMesh) return;
        if (Array.isArray(child.material)) {
          for (const mat of child.material) mat.dispose?.();
        } else {
          child.material?.dispose?.();
        }
      });
    }
    this._fallbackTexture?.dispose?.();
    if (this.mesh?.parent) this.mesh.parent.remove(this.mesh);
  }
}

class ActiveSpawn {
  constructor(prefabName, prefabTree, attach, particleDatas, anchor, fallbackRoot, textureCache, materialLookup, meshCache, camera, meshFrameFixLookup = {}) {
    this.prefabName = prefabName;
    this.attach = attach || null;
    this.camera = camera || null;
    this.meshFrameFixLookup = meshFrameFixLookup || {};
    this.expired = false;
    this.emitters = [];
    this.skippedParticleSystems = 0;

    // The prefab root group is parented under the resolved bone anchor. If the
    // anchor isn't found we fall back to characterRoot so spawn isn't lost.
    this.attachParent = anchor || fallbackRoot;
    this.root = new THREE.Group();
    this.root.name = `ModelFxSpawn_${prefabName}`;
    this.attachParent.add(this.root);

    // Auto-destroy timer: prefer CharacterAnimationEventEffect.TimerTypeDuration
    // when LifeMode === 1 (bounded). 9999 means "permanent" — disable timer.
    const timer = attach?.timer_duration;
    const lifeMode = attach?.life_mode;
    this.timerLeft = (lifeMode === 1 && Number.isFinite(timer) && timer < 9999)
      ? Math.max(0.1, Number(timer))
      : Infinity;

    // Build descendant Group hierarchy from the prefab tree so each particle
    // emitter parents to its own GO and inherits the chain of local transforms.
    // pidToGroup maps go_path_id -> THREE.Group. Root group at index 0 is the
    // prefab root with identity transform (parent_path_id=0 from dumper).
    this.pidToGroup = new Map();
    const descendants = prefabTree?.descendants || [];
    if (!descendants.length) {
      // Defensive fallback: synthesize a root entry so emitters still parent.
      this.pidToGroup.set(0, this.root);
    } else {
      // First pass: create all groups with local transforms.
      for (const d of descendants) {
        const g = new THREE.Group();
        g.name = `Fx_${d.go_name || "node"}`;
        const lt = d.local_transform;
        if (lt?.position) g.position.set(lt.position.x ?? 0, lt.position.y ?? 0, lt.position.z ?? 0);
        if (lt?.rotation) g.quaternion.set(lt.rotation.x ?? 0, lt.rotation.y ?? 0, lt.rotation.z ?? 0, lt.rotation.w ?? 1);
        if (lt?.scale) g.scale.set(lt.scale.x ?? 1, lt.scale.y ?? 1, lt.scale.z ?? 1);
        this.pidToGroup.set(d.path_id, g);
      }
      // Second pass: parent each group. parent_path_id=0 means top-level
      // (under prefab root). The first descendant entry IS the prefab root,
      // collapse it into our existing this.root so we don't double-nest.
      const rootEntry = descendants[0];
      const rootGroup = this.pidToGroup.get(rootEntry.path_id);
      if (rootGroup) {
        // Move rootEntry's local transform onto this.root and replace mapping
        this.root.position.copy(rootGroup.position);
        this.root.quaternion.copy(rootGroup.quaternion);
        this.root.scale.copy(rootGroup.scale);
        this.pidToGroup.set(rootEntry.path_id, this.root);
      }
      for (const d of descendants) {
        if (d === rootEntry) continue;
        const child = this.pidToGroup.get(d.path_id);
        if (!child) continue;
        const parent = this.pidToGroup.get(d.parent_path_id) || this.root;
        parent.add(child);
      }
    }

    // Spawn each emitter, parent to its own descendant group via go_path_id.
    for (const data of particleDatas) {
      if (!isRenderableParticleSystem(data)) {
        this.skippedParticleSystems++;
        continue;
      }
      const emitter = new FxEmitter(data, { camera: this.camera });
      emitter.init(textureCache, materialLookup, meshCache, this.meshFrameFixLookup);
      this.emitters.push(emitter);
      const parent = (data.go_path_id != null && this.pidToGroup.get(data.go_path_id)) || this.root;
      parent.add(emitter.mesh);
    }
  }

  tick(dt, rng) {
    if (!this.emitters.length) {
      this.expired = true;
      return;
    }
    if (Number.isFinite(this.timerLeft)) {
      this.timerLeft -= dt;
      if (this.timerLeft <= 0) {
        this.expired = true;
        return;
      }
    }
    let allDead = true;
    for (const emitter of this.emitters) {
      emitter.update(dt, rng);
      if (!emitter.dead) allDead = false;
    }
    // If timer is infinite (loop or no attach metadata) we still cull when
    // every emitter has finished naturally — prevents leaks for one-shot FX.
    if (allDead && !Number.isFinite(this.timerLeft)) this.expired = true;
  }

  dispose() {
    for (const emitter of this.emitters) emitter.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
    this.emitters = [];
    this.pidToGroup?.clear?.();
  }
}

/**
 * Build a model-FX runtime that listens to mixer animation events and spawns
 * the matching prefab particle systems.
 *
 * @param {object} options
 * @param {object} options.fxIndex — parsed fx/index.json (schema_version 2)
 * @param {object} options.animEvents — parsed fx/anim_events.json
 * @param {string} options.basePath — URL prefix for fx asset fetches (must end with "fx/")
 * @param {THREE.Object3D} options.characterRoot — node to parent spawned prefabs under
 *        when no bone anchor is resolved
 * @param {object} options.mixerState — animationState exposing currentActions[]
 * @returns {Promise<{ tick:(dt:number)=>void, dispose:()=>void }>}
 */
export async function createModelFx({
  fxIndex,
  animEvents,
  basePath,
  characterRoot,
  mixerState,
  camera,
  cacheVersion,
}) {
  // Group particle entries by their prefab root.
  const particlesByPrefab = new Map();
  for (const entry of fxIndex?.particles || []) {
    if (!entry?.root || !entry?.file) continue;
    const list = particlesByPrefab.get(entry.root) || [];
    list.push(entry);
    particlesByPrefab.set(entry.root, list);
  }

  // Index prefab metadata by name (file path + attach info).
  const prefabMeta = new Map();
  for (const p of fxIndex?.prefabs || []) {
    if (!p?.name) continue;
    prefabMeta.set(p.name, p);
  }

  // Per-mesh frame-fix lookup (name -> { quat?, rotation?, scale? }) from the
  // index. Computed offline by tools/fx/compute_mesh_frame_fix.py so the viewer
  // carries no per-mesh rotation constants in code.
  const meshFrameFixLookup = {};
  for (const m of fxIndex?.meshes || []) {
    if (!m?.name) continue;
    if (m.frame_quat || m.frame_rotation || m.frame_scale) {
      meshFrameFixLookup[m.name] = {
        quat: m.frame_quat,
        rotation: m.frame_rotation,
        scale: m.frame_scale,
      };
    }
  }

  // Bone-index lookup. fxParentBones is an array of { index, name, transform_path_id }.
  // index_param 0 → bone_root (~animator root). Empty/null name → fallback to character root.
  const fxParentBones = fxIndex?.fx_parent_bones || [];

  // Group + sort animation events by clip name.
  const eventsByClip = new Map();
  for (const ev of animEvents?.events || []) {
    if (!ev?.clip || !ev?.prefab) continue;
    const list = eventsByClip.get(ev.clip) || [];
    list.push(ev);
    eventsByClip.set(ev.clip, list);
  }
  for (const list of eventsByClip.values()) {
    list.sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
  }

  // Material JSON cache + lookup (loaded lazily once per character).
  const materialLookup = {};
  let materialsPreloaded = false;
  async function ensureMaterials() {
    if (materialsPreloaded) return;
    materialsPreloaded = true;
    await Promise.all((fxIndex.materials || []).map(async (m) => {
      if (!m?.name || !m?.file) return;
      try {
        const data = await loadJson(basePath + m.file);
        materialLookup[m.name] = data;
      } catch (err) {
        warnAssetLoadFailure("material", m.name || m.file, err);
      }
    }));
  }

  // Texture loader (lazy, per-character cache). Keyed by path_id (schema v3,
  // stable per-asset id) AND by name. BA fx reuses one texture name across
  // differently-sized assets (e.g. FX_TEX_Color_01 = 128x16 gray ramp AND
  // 64x64 yellow), so name is not unique — v3 materials resolve by path_id.
  // The name key is retained for v2 (legacy) dumps and as a fallback; on a name
  // collision the name key just last-wins, which path_id lookups bypass.
  const textureCache = {};
  const texLoader = new THREE.TextureLoader();
  let texturesPreloaded = false;
  async function ensureTextures() {
    if (texturesPreloaded) return;
    texturesPreloaded = true;
    // Dedupe by file URL so every distinct variant is loaded exactly once even
    // when several share a name.
    const seen = new Set();
    const wanted = (fxIndex.textures || []).filter((t) => {
      if (!t?.name || !t?.file) return false;
      if (seen.has(t.file)) return false;
      seen.add(t.file);
      return true;
    });
    await Promise.all(wanted.map(async (t) => {
      try {
        const tex = await texLoader.loadAsync(bust(basePath + t.file));
        tex.flipY = false;
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        // Honor the Unity-authored wrap mode (captured per-asset by dump_fx.py).
        // Wrap is intrinsic to the texture asset, so set it here once at load.
        // Missing fields (older v2/v3 dumps) fall back to Clamp via unityWrapToThree.
        tex.wrapS = unityWrapToThree(t.wrap_u);
        tex.wrapT = unityWrapToThree(t.wrap_v);
        if (t.path_id != null) textureCache[t.path_id] = tex;
        if (!(t.name in textureCache)) textureCache[t.name] = tex;
      } catch (err) {
        warnAssetLoadFailure("texture", t.name || t.file, err);
      }
    }));
  }

  const meshCache = {};
  const gltfLoader = new GLTFLoader();
  let meshesPreloaded = false;
  async function ensureMeshes() {
    if (meshesPreloaded) return;
    meshesPreloaded = true;
    const seen = new Set();
    const wanted = (fxIndex.meshes || []).filter((m) => {
      if (!m?.name || !m?.file) return false;
      if (seen.has(m.name)) return false;
      seen.add(m.name);
      return true;
    });
    await Promise.all(wanted.map(async (m) => {
      try {
        const gltf = await gltfLoader.loadAsync(bust(basePath + m.file));
        meshCache[m.name] = gltf.scene;
      } catch (err) {
        warnAssetLoadFailure("mesh", m.name || m.file, err);
      }
    }));
  }

  // Particle JSON cache (avoid refetching when the same prefab spawns again).
  const particleJsonCache = new Map();
  const prefabJsonCache = new Map();

  // Append a cache-busting query string when provided so loader.js's
  // ASSET_CACHE_VERSION bumps invalidate stale fx JSON in the browser cache.
  function bust(url) {
    if (!cacheVersion) return url;
    return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(cacheVersion)}`;
  }

  function warnAssetLoadFailure(kind, name, err) {
    console.warn(`[modelFx] ${kind} load failed: ${name}`, err);
  }

  async function loadJson(url) {
    const resp = await fetch(bust(url));
    if (!resp.ok) throw new Error(`fetch failed: ${url}`);
    return resp.json();
  }

  async function loadParticleJson(entry) {
    if (particleJsonCache.has(entry.file)) return particleJsonCache.get(entry.file);
    const data = await loadJson(basePath + entry.file);
    particleJsonCache.set(entry.file, data);
    return data;
  }

  async function loadPrefabJson(meta) {
    if (!meta?.file) return null;
    if (prefabJsonCache.has(meta.file)) return prefabJsonCache.get(meta.file);
    const data = await loadJson(basePath + meta.file);
    prefabJsonCache.set(meta.file, data);
    return data;
  }

  async function preloadFxAssets() {
    await Promise.all([ensureTextures(), ensureMaterials(), ensureMeshes()]);
    const prefabLoads = [...prefabMeta.values()].map((meta) =>
      loadPrefabJson(meta).catch((err) => {
        console.warn(`[modelFx] prefab preload failed: ${meta?.name || meta?.file}`, err);
        return null;
      })
    );
    const particleLoads = [...particlesByPrefab.values()].flat().map((entry) =>
      loadParticleJson(entry).catch((err) => {
        console.warn(`[modelFx] particle preload failed: ${entry?.file}`, err);
        return null;
      })
    );
    await Promise.all([...prefabLoads, ...particleLoads]);
  }

  await preloadFxAssets();

  // Bone Object3D cache: traverse characterRoot once per bone name. Uses
  // normalized name matching (lowercase + strip spaces/underscores) to mirror
  // loader.js's findObjectByName — three.js bone names from GLTF can differ
  // from Unity ("Bip001 Head" vs "Bip001_Head" vs "bip001head") depending on
  // exporter quirks.
  const boneCache = new Map();
  function normalizeName(name) {
    return String(name || "").toLowerCase().replace(/[\s_]+/g, "");
  }
  function scoreBoneCandidate(obj) {
    let score = obj?.isBone ? 10 : 0;
    for (let cur = obj; cur; cur = cur.parent) {
      const partName = normalizeName(cur.userData?.skinnedPartName || "");
      if (partName === "body") score += 100;
      else if (partName.includes("body")) score += 50;
      else if (partName.includes("weapon") || partName.includes("prop")) score -= 10;
    }
    return score;
  }
  function findBone(name) {
    if (!name || !characterRoot) return null;
    if (boneCache.has(name)) return boneCache.get(name);
    const wanted = normalizeName(name);
    let found = null;
    let bestScore = -Infinity;
    characterRoot.traverse((obj) => {
      if (normalizeName(obj.name) !== wanted) return;
      const score = scoreBoneCandidate(obj);
      if (!found || score > bestScore) {
        found = obj;
        bestScore = score;
      }
    });
    boneCache.set(name, found);
    if (!found) {
      console.warn(`[modelFx] bone not found: ${name} (fallback to root)`);
    }
    return found;
  }

  // Resolve the anchor THREE.Object3D for a prefab spawn, given:
  //   - prefab.attach.parent_index (CharacterAnimationEventEffect.ParentIndex,
  //     authoritative when present)
  //   - event.int_param (legacy/fallback path used by prefabs without attach
  //     metadata)
  // Both index into fxParentBones[i].name, then resolved against characterRoot.
  function resolveAnchor(meta, ev) {
    const index = meta?.attach?.parent_index ?? ev?.int_param ?? 0;
    const bone = fxParentBones.find((b) => b.index === index);
    const name = bone?.name;
    if (!name) return characterRoot;
    return findBone(name) || characterRoot;
  }

  const activeSpawns = [];
  const lastTimeByClip = new Map();
  const firedEventKeys = new Set();
  let spawnGeneration = 0;
  let disposed = false;

  function eventKey(clipName, ev) {
    return `${clipName}|${Number(ev?.time || 0).toFixed(4)}|${ev?.prefab || ""}`;
  }

  function clearFiredEventsForClip(clipName) {
    const prefix = `${clipName}|`;
    for (const key of [...firedEventKeys]) {
      if (key.startsWith(prefix)) firedEventKeys.delete(key);
    }
  }

  function fireEventOnce(clipName, ev) {
    const key = eventKey(clipName, ev);
    if (firedEventKeys.has(key)) return;
    firedEventKeys.add(key);
    spawnPrefab(ev.prefab, ev);
  }

  async function spawnPrefab(prefabName, ev) {
    if (disposed) return;
    const generation = spawnGeneration;
    console.log(`[modelFx] spawnPrefab: ${prefabName} clip=${ev?.clip} t=${ev?.time?.toFixed(3)}`);
    const entries = particlesByPrefab.get(prefabName);
    if (!entries?.length) {
      console.warn(`[modelFx] no particles for prefab ${prefabName}`);
      return;
    }
    const meta = prefabMeta.get(prefabName);
    try {
      await Promise.all([ensureTextures(), ensureMaterials(), ensureMeshes()]);
      const [datas, prefabTree] = await Promise.all([
        Promise.all(entries.map(loadParticleJson)),
        loadPrefabJson(meta),
      ]);
      if (disposed || generation !== spawnGeneration) return;
      const anchor = resolveAnchor(meta, ev);
      const spawn = new ActiveSpawn(
        prefabName,
        prefabTree,
        meta?.attach,
        datas,
        anchor,
        characterRoot,
        textureCache,
        materialLookup,
        meshCache,
        camera,
        meshFrameFixLookup
      );
      if (!spawn.emitters.length) {
        spawn.dispose();
        console.info(`[modelFx] skip ${prefabName}: no renderable emitters`);
        return;
      }
      activeSpawns.push(spawn);
      const anchorName = anchor?.name || "(root)";
      const skipped = spawn.skippedParticleSystems;
      console.info(
        `[modelFx] spawn ${prefabName} (${spawn.emitters.length} visible${skipped ? `, ${skipped} skipped` : ""}/${datas.length} particle systems) @ ${anchorName}`
      );
    } catch (err) {
      console.warn(`[modelFx] spawn failed for ${prefabName}:`, err);
    }
  }

  function tick(dt) {
    if (disposed) return;
    const rng = Math.random;

    // Detect mixer-time crossings to fire animation events.
    if (mixerState?.currentActions) {
      const clipTimes = new Map();
      for (const action of mixerState.currentActions) {
        if (!action) continue;
        const clip = action.getClip ? action.getClip() : action._clip;
        const clipName = clip?.name;
        if (!clipName) continue;
        const t = Number(action.time);
        if (!Number.isFinite(t)) continue;
        const prev = clipTimes.get(clipName);
        if (prev == null || t > prev) clipTimes.set(clipName, t);
      }
      for (const [clipName, t] of clipTimes) {
        const events = eventsByClip.get(clipName);
        if (!events?.length) continue;
        const lastT = lastTimeByClip.get(clipName);
        if (lastT === undefined) {
          // First sighting can happen after the action has already advanced
          // while fx sidecars preload. Catch up events from clip start.
          for (const ev of events) {
            if ((ev.time || 0) <= t + 1e-4) {
              fireEventOnce(clipName, ev);
            }
          }
          lastTimeByClip.set(clipName, t);
          continue;
        }
        if (t < lastT - 1e-3) {
          // Loop wraparound: fire any events <= t (clip restarted).
          clearFiredEventsForClip(clipName);
          for (const ev of events) {
            if ((ev.time || 0) <= t + 1e-4) fireEventOnce(clipName, ev);
          }
        } else {
          for (const ev of events) {
            const evTime = Number(ev.time || 0);
            if (evTime > lastT && evTime <= t + 1e-4) {
              fireEventOnce(clipName, ev);
            }
          }
        }
        lastTimeByClip.set(clipName, t);
      }
    }

    // Tick + cull active spawns.
    for (let i = activeSpawns.length - 1; i >= 0; i--) {
      const spawn = activeSpawns[i];
      spawn.tick(dt, rng);
      if (spawn.expired) {
        spawn.dispose();
        activeSpawns.splice(i, 1);
      }
    }
  }

  function reset() {
    spawnGeneration++;
    for (const spawn of activeSpawns) spawn.dispose();
    activeSpawns.length = 0;
    lastTimeByClip.clear();
    firedEventKeys.clear();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    for (const tex of Object.values(textureCache)) {
      tex?.dispose?.();
    }
    for (const meshRoot of Object.values(meshCache)) {
      meshRoot?.traverse?.((child) => {
        if (!child.isMesh) return;
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) {
          for (const mat of child.material) mat.dispose?.();
        } else {
          child.material?.dispose?.();
        }
      });
    }
    particleJsonCache.clear();
    prefabJsonCache.clear();
    boneCache.clear();
  }

  return { tick, reset, dispose };
}
