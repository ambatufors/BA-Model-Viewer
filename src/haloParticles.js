
// Halo particle runtime.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Unity enum constants we care about.
const SHAPE_CONE = 4;
const SHAPE_CONE_VOLUME = 8;
const SHAPE_DONUT = 17;
const RENDER_BILLBOARD = 0;
const RENDER_STRETCH = 1;
const RENDER_HORIZONTAL_BILLBOARD = 2;
const RENDER_VERTICAL_BILLBOARD = 3;
const RENDER_MESH = 4;
const RENDER_NONE = 5;
const MINMAX_CONSTANT = 0;
const MINMAX_CURVE = 1;
const MINMAX_TWO_CURVES = 2;
const MINMAX_TWO_CONSTANTS = 3;

const DEFAULT_PARTICLE_CAPACITY = 256;
const MAX_EMITTERS_PER_HALO = 32;
const TRAIL_HDR_SCALE = 0.32;
const TRAIL_RAMP_BLEND = 0.96;
const TRAIL_RAMP_BLUR_STEP = 0.008;
// Unity material _Color values for BA halo FX can reach 3–6× (HDR). That is
// calibrated for Unity's tone-mapped pipeline; in the viewer, using them raw
// blows bloom into a flashbang. Pre-scale so the peak ring/sparkle lands near
// 1.5–2.0 range and bloom threshold picks up just the highlights.
const HDR_COLOR_SAFETY_SCALE = 0.35;

function makeSoftGlowTexture(size = 128) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, "rgba(255,255,255,1.0)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.5)");
  grad.addColorStop(1.0, "rgba(255,255,255,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function minMaxValue(spec, rng = Math.random) {
  if (!spec) return 0;
  const { state, scalar, min_scalar: minScalar } = spec;
  if (state === MINMAX_TWO_CONSTANTS) {
    const a = Number(minScalar ?? 0);
    const b = Number(scalar ?? 0);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return lo + (hi - lo) * rng();
  }
  // state 0, 1, 2 — fall back to scalar (treat curves as constant for now)
  return Number(scalar ?? 0);
}

function minMaxColor(spec, rng = Math.random) {
  if (!spec) return { r: 1, g: 1, b: 1, a: 1 };
  const lo = spec.min_color || spec.max_color || { r: 1, g: 1, b: 1, a: 1 };
  const hi = spec.max_color || spec.min_color || { r: 1, g: 1, b: 1, a: 1 };
  if (spec.state === MINMAX_TWO_CONSTANTS) {
    const t = rng();
    return {
      r: lo.r + (hi.r - lo.r) * t,
      g: lo.g + (hi.g - lo.g) * t,
      b: lo.b + (hi.b - lo.b) * t,
      a: lo.a + (hi.a - lo.a) * t,
    };
  }
  return {
    r: hi.r ?? 1,
    g: hi.g ?? 1,
    b: hi.b ?? 1,
    a: hi.a ?? 1,
  };
}

function colorStops(entries = []) {
  return entries
    .filter((item) => item?.kind === "color" && item.color)
    .map((item) => ({
      time: THREE.MathUtils.clamp(Number(item.time ?? 0), 0, 1),
      color: {
        r: item.color.r ?? 1,
        g: item.color.g ?? 1,
        b: item.color.b ?? 1,
        a: item.color.a ?? 1,
      },
    }))
    .sort((a, b) => a.time - b.time);
}

function sampleColorStops(stops, t) {
  if (!stops.length) return { r: 1, g: 1, b: 1, a: 1 };
  if (t <= stops[0].time) return stops[0].color;
  const last = stops[stops.length - 1];
  if (t >= last.time) return last.color;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t < a.time || t > b.time) continue;
    const span = Math.max(0.0001, b.time - a.time);
    const f = (t - a.time) / span;
    return {
      r: THREE.MathUtils.lerp(a.color.r, b.color.r, f),
      g: THREE.MathUtils.lerp(a.color.g, b.color.g, f),
      b: THREE.MathUtils.lerp(a.color.b, b.color.b, f),
      a: THREE.MathUtils.lerp(a.color.a, b.color.a, f),
    };
  }
  return last.color;
}

function sampleGradientColor(spec, t, mix = 1) {
  if (!spec) return { r: 1, g: 1, b: 1, a: 1 };
  const minStops = colorStops(spec.minGradient || []);
  const maxStops = colorStops(spec.maxGradient || []);
  const minColor = minStops.length ? sampleColorStops(minStops, t) : (spec.min_color || spec.max_color);
  const maxColor = maxStops.length ? sampleColorStops(maxStops, t) : (spec.max_color || spec.min_color);
  if (!minColor && !maxColor) return { r: 1, g: 1, b: 1, a: 1 };
  if (!minColor) return maxColor;
  if (!maxColor) return minColor;
  const f = THREE.MathUtils.clamp(mix, 0, 1);
  return {
    r: THREE.MathUtils.lerp(minColor.r ?? 1, maxColor.r ?? 1, f),
    g: THREE.MathUtils.lerp(minColor.g ?? 1, maxColor.g ?? 1, f),
    b: THREE.MathUtils.lerp(minColor.b ?? 1, maxColor.b ?? 1, f),
    a: THREE.MathUtils.lerp(minColor.a ?? 1, maxColor.a ?? 1, f),
  };
}

function quaternionFromData(q) {
  if (!q) return new THREE.Quaternion();
  return new THREE.Quaternion(q.x ?? 0, q.y ?? 0, q.z ?? 0, q.w ?? 1);
}

function vectorFromData(v) {
  if (!v) return new THREE.Vector3();
  return new THREE.Vector3(v.x ?? 0, v.y ?? 0, v.z ?? 0);
}

function sampleShape(shape, rng = Math.random, out = new THREE.Vector3()) {
  if (!shape) {
    out.set(0, 0, 0);
    return out;
  }
  const type = shape.type;
  const radius = Number(shape.radius ?? 0);
  const arcDeg = Number(shape.arc ?? 360);
  const arcRad = (arcDeg * Math.PI) / 180;
  if (type === SHAPE_CONE || type === SHAPE_CONE_VOLUME || type === SHAPE_DONUT) {
    const angle = rng() * arcRad;
    // Unity ShapeModule cone base lies in local XY plane, Z is the cone axis.
    out.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
    return out;
  }
  out.set(0, 0, 0);
  return out;
}

function materialSrcFactor(floats = {}) {
  // Unity BlendMode numeric values used in BA materials
  const srcBlend = floats._SrcBlend ?? 1;
  const dstBlend = floats._DstBlend ?? 0;
  if (srcBlend === 1 && dstBlend === 1) return "additive";
  // SrcAlpha (5), OneMinusSrcAlpha (10) → normal alpha blend
  if (srcBlend === 5 && dstBlend === 10) return "alpha";
  return "alpha";
}

function findTrailColorTexture(textureCache, matData = null) {
  const sourceName = matData?.textures?._Tex_Main?.name || matData?.textures?._MainTex?.name;
  const sourceTexture = sourceName ? textureCache[sourceName] : null;
  if (sourceTexture) {
    sourceTexture.wrapS = sourceTexture.wrapT = THREE.ClampToEdgeWrapping;
    sourceTexture.needsUpdate = true;
    return sourceTexture;
  }

  const names = Object.keys(textureCache || {});
  const key = names.find((name) => /_Halo$/i.test(name) && !/cutin/i.test(name))
    || names.find((name) => /_Cutin_Halo$/i.test(name));
  const texture = key ? textureCache[key] : null;
  if (texture) {
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
  }
  return texture;
}

function makeBillboardMaterial(matData, textureCache, options = {}) {
  const blend = materialSrcFactor(matData?.floats || {});
  const color = matData?.colors?._Color || matData?.colors?._BaseColor || { r: 1, g: 1, b: 1, a: 1 };
  const scale = HDR_COLOR_SAFETY_SCALE;

  let mainTex = null;
  const mainTexName = matData?.textures?._MainTex?.name
    || matData?.textures?._Tex_Main?.name
    || matData?.textures?._Tex_Mask?.name
    || null;
  if (mainTexName && textureCache[mainTexName]) {
    mainTex = textureCache[mainTexName];
  }
  // Older exports missed external material texture CABs, leaving _Tex_Mask null.
  // Keep a fallback path for those legacy manifests, but prefer the source
  // material texture above (for CH0069 this is FX_TEX_CH0069_Halo_01).
  if (!mainTex && (options.tilesX > 1 || options.tilesY > 1)) {
    for (const candidate of ["FX_TEX_CH0069_Halo_01", "FX_TEX_Noise_Stars_03", "FX_TEX_Noise_Stars_03a", "FX_TEX_Circle_Glow_02"]) {
      if (textureCache[candidate]) {
        mainTex = textureCache[candidate];
        break;
      }
    }
  }
  const fallbackTex = mainTex ? null : makeSoftGlowTexture();
  const boundTex = mainTex || fallbackTex;
  // Don't override boundTex.colorSpace here: loader.js already tagged textures
  // as LinearSRGB to match the viewer pipeline. Forcing sRGB would cause a
  // double gamma pass when the particle renders on top of character pixels.

  const material = new THREE.ShaderMaterial({
    uniforms: {
      u_Tex: { value: boundTex },
      u_Color: { value: new THREE.Vector4((color.r ?? 1) * scale, (color.g ?? 1) * scale, (color.b ?? 1) * scale, color.a ?? 1) },
      u_Tiles: { value: new THREE.Vector2(options.tilesX || 1, options.tilesY || 1) },
      u_FrameOffset: { value: new THREE.Vector2(options.frameOffsetU || 0, options.frameOffsetV || 0) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 instanceCenter;
      attribute vec4 instanceColor;
      attribute float instanceSize;
      attribute float instanceRotation;
      varying vec2 vUv;
      varying vec4 vColor;
      void main() {
        vUv = uv;
        vColor = instanceColor;
        // Camera-aligned billboard: rotate quad corner by instanceRotation in view space.
        vec3 corner = position * instanceSize;
        float c = cos(instanceRotation);
        float s = sin(instanceRotation);
        vec3 rotated = vec3(corner.x * c - corner.y * s, corner.x * s + corner.y * c, corner.z);
        vec4 mvCenter = modelViewMatrix * vec4(instanceCenter, 1.0);
        vec4 mvPos = mvCenter + vec4(rotated, 0.0);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D u_Tex;
      uniform vec4 u_Color;
      uniform vec2 u_Tiles;
      uniform vec2 u_FrameOffset;
      varying vec2 vUv;
      varying vec4 vColor;
      void main() {
        vec2 tiled = u_FrameOffset + vUv / u_Tiles;
        vec4 tex = texture2D(u_Tex, tiled);
        // BA FX atlases often store cutout intensity in RGB while alpha is 1
        // everywhere. Derive particle alpha from luminance to avoid drawing
        // the black atlas background as an opaque quad.
        float lum = max(max(tex.r, tex.g), tex.b);
        float texAlpha = tex.a < 0.99 ? tex.a * lum : lum;
        vec4 c = vec4(tex.rgb, texAlpha) * u_Color * vColor;
        if (c.a < 0.005) discard;
        gl_FragColor = c;
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    blending: blend === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  material.userData.fallbackTexture = fallbackTex;
  return material;
}

function makeMeshInstanceMaterial(matData, textureCache) {
  const blend = materialSrcFactor(matData?.floats || {});
  const color = matData?.colors?._Color || matData?.colors?._BaseColor || { r: 1, g: 1, b: 1, a: 1 };
  // BA trail materials store their color ramp in _Tex_Main and the trail alpha
  // shape in _Tex_Mask. Older exports missed external _Tex_Main, so keep the
  // halo ramp fallback for compatibility.
  const isTrailMat = typeof matData?.name === "string" && /trail/i.test(matData.name);
  const scale = isTrailMat ? TRAIL_HDR_SCALE : HDR_COLOR_SAFETY_SCALE;
  const colorTex = isTrailMat ? findTrailColorTexture(textureCache, matData) : null;
  const tint = isTrailMat && !colorTex ? { r: 1.0, g: 0.75, b: 0.92 } : { r: 1.0, g: 1.0, b: 1.0 };
  const maskName = matData?.textures?._Tex_Mask?.name || matData?.textures?._MainTex?.name;
  const maskScale = matData?.textures?._Tex_Mask?.scale || matData?.textures?._MainTex?.scale || [1, 1];
  let maskTex = null;
  if (maskName && textureCache[maskName]) {
    maskTex = textureCache[maskName];
    maskTex.wrapS = maskTex.wrapT = THREE.RepeatWrapping;
    maskTex.needsUpdate = true;
  }
  return new THREE.ShaderMaterial({
    uniforms: {
      u_MaskTex: { value: maskTex },
      u_HasMask: { value: maskTex ? 1 : 0 },
      u_ColorTex: { value: colorTex },
      u_HasColorTex: { value: colorTex ? 1 : 0 },
      u_ColorBlend: { value: colorTex ? TRAIL_RAMP_BLEND : 0 },
      u_ColorBlurStep: { value: TRAIL_RAMP_BLUR_STEP },
      u_Color: { value: new THREE.Vector4((color.r ?? 1) * scale * tint.r, (color.g ?? 1) * scale * tint.g, (color.b ?? 1) * scale * tint.b, color.a ?? 1) },
      u_MaskScale: { value: new THREE.Vector2(maskScale[0] || 1, maskScale[1] || 1) },
      u_Time: { value: 0 },
      u_ScrollSpeed: { value: new THREE.Vector2(matData?.floats?._Mask_Speed_X || 0, matData?.floats?._Mask_Speed_Y || 0) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D u_MaskTex;
      uniform int u_HasMask;
      uniform sampler2D u_ColorTex;
      uniform int u_HasColorTex;
      uniform float u_ColorBlend;
      uniform float u_ColorBlurStep;
      uniform vec4 u_Color;
      uniform vec2 u_MaskScale;
      uniform float u_Time;
      uniform vec2 u_ScrollSpeed;
      varying vec2 vUv;

      vec4 sampleTrailColor(vec2 uv) {
        vec2 stepUv = vec2(u_ColorBlurStep, u_ColorBlurStep);
        vec2 c = clamp(uv, vec2(0.0), vec2(1.0));
        vec4 color = texture2D(u_ColorTex, c) * 0.40;
        color += texture2D(u_ColorTex, clamp(c + vec2(stepUv.x, 0.0), vec2(0.0), vec2(1.0))) * 0.12;
        color += texture2D(u_ColorTex, clamp(c - vec2(stepUv.x, 0.0), vec2(0.0), vec2(1.0))) * 0.12;
        color += texture2D(u_ColorTex, clamp(c + vec2(0.0, stepUv.y), vec2(0.0), vec2(1.0))) * 0.12;
        color += texture2D(u_ColorTex, clamp(c - vec2(0.0, stepUv.y), vec2(0.0), vec2(1.0))) * 0.12;
        color += texture2D(u_ColorTex, clamp(c + stepUv, vec2(0.0), vec2(1.0))) * 0.06;
        color += texture2D(u_ColorTex, clamp(c - stepUv, vec2(0.0), vec2(1.0))) * 0.06;
        return color;
      }

      void main() {
        vec2 uv = vUv * u_MaskScale + u_ScrollSpeed * u_Time;
        float maskAlpha = 1.0;
        if (u_HasMask == 1) {
          vec4 m = texture2D(u_MaskTex, uv);
          // FX_TEX_Trail_01 is a grayscale stroke on black background. Its alpha
          // channel is often solid 1 even where RGB is 0, so using mask.a directly
          // makes the black background render opaque black. Use luminance of RGB
          // as the cutout, and combine with alpha only if alpha looks meaningful.
          float lum = max(max(m.r, m.g), m.b);
          maskAlpha = lum;
          if (m.a < 0.99) maskAlpha *= m.a; // honor real alpha channels too
        }
        float alpha = maskAlpha * u_Color.a;
        if (alpha < 0.01) discard;
        vec3 color = u_Color.rgb;
        if (u_HasColorTex == 1) {
          vec4 colorSample = sampleTrailColor(vUv);
          vec3 blendedRamp = mix(vec3(1.0), colorSample.rgb, u_ColorBlend);
          color *= blendedRamp;
          alpha *= mix(1.0, colorSample.a, u_ColorBlend);
        }
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    blending: blend === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
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

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute("position", base.attributes.position);
  geometry.setAttribute("uv", base.attributes.uv);

  const centers = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
  const rotations = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("instanceCenter", centers);
  geometry.setAttribute("instanceColor", colors);
  geometry.setAttribute("instanceSize", sizes);
  geometry.setAttribute("instanceRotation", rotations);
  geometry.instanceCount = 0;
  return { geometry, centers, colors, sizes, rotations };
}

function computeUvFrameOffset(uv) {
  const tilesX = uv?.tiles_x || 1;
  const tilesY = uv?.tiles_y || 1;
  const rowIndex = uv?.row_index || 0;
  const animType = uv?.animation_type || 0;
  const frameScalar = (uv?.frame_over_time?.scalar ?? 0) || 0;
  if (animType === 1) {
    // SingleRow
    const frameIdx = Math.max(0, Math.min(tilesX - 1, Math.floor(frameScalar * tilesX)));
    return { tilesX, tilesY, u: frameIdx / tilesX, v: rowIndex / tilesY };
  }
  // WholeSheet
  const total = tilesX * tilesY;
  const frameIdx = Math.max(0, Math.min(total - 1, Math.floor(frameScalar * total)));
  const col = frameIdx % tilesX;
  const row = Math.floor(frameIdx / tilesX);
  return { tilesX, tilesY, u: col / tilesX, v: row / tilesY };
}

class Emitter {
  constructor(spec, materialData, textureCache, trailMeshMap) {
    this.spec = spec;
    this.name = spec.name;
    const init = spec.initial || {};
    this.lifetimeSpec = init.start_lifetime;
    this.sizeSpec = init.start_size;
    this.rotationSpec = init.start_rotation;
    this.colorSpec = init.start_color;
    this.colorOverLifeSpec = spec.color_over_life?.enabled ? spec.color_over_life.gradient : null;
    this.duration = Number(spec.duration ?? 1);
    this.looping = !!spec.looping;
    const rateSpec = spec.emission?.rate_over_time || null;
    this.rate = Number(rateSpec?.scalar ?? 0);
    this.emissionEnabled = !!spec.emission?.enabled && this.rate > 0;

    const renderer = spec.renderer || {};
    this.renderMode = renderer.render_mode;

    // Will be filled by init():
    this.instanced = null;     // for billboard mode
    this.meshInstanced = null; // for mesh mode
    this.capacity = 0;
    this.particles = [];
    this.accumulator = 0;
    this.age = 0;
    this.clockTime = 0;
    this.object3d = new THREE.Group();
    this.object3d.name = `Emitter_${spec.name}`;
    const lt = spec.local_transform;
    if (lt) {
      this.object3d.position.copy(vectorFromData(lt.position));
      this.object3d.quaternion.copy(quaternionFromData(lt.rotation));
      this.object3d.scale.copy(vectorFromData(lt.scale || { x: 1, y: 1, z: 1 }));
    }

    this.materialData = materialData;
    this.textureCache = textureCache;
    this.trailMeshMap = trailMeshMap;
    this._prewarm = !!spec.prewarm;
    // Unity caps live particles at InitialModule.max_num_particles. Honor that as
    // our capacity so we don't over-spawn (CH0069 trail emitters have max=1).
    const unityMax = Number(init.max_num_particles);
    this._unityMax = Number.isFinite(unityMax) && unityMax > 0 ? Math.min(unityMax, 2048) : null;
  }

  init(options) {
    const requested = Math.max(1, Math.min(options.capacity ?? DEFAULT_PARTICLE_CAPACITY, 2048));
    const capacity = this._unityMax ? Math.min(requested, this._unityMax) : requested;
    this.capacity = capacity;
    this.particles = new Array(capacity).fill(null).map(() => ({ alive: false }));

    if (this.renderMode === RENDER_NONE) return; // container only
    if (this.renderMode === RENDER_STRETCH) {
      // Unity Stretch billboard aligns a quad along velocity direction with
      // lengthScale/velocityScale. Our current velocity model is zero, so
      // stretched quads collapse into oversized bright blobs. Skip rendering
      // until proper stretch + velocity is implemented.
      return;
    }

    if (this.renderMode === RENDER_MESH) {
      const meshFile = this.spec.renderer?.mesh_file;
      const geometry = meshFile ? this.trailMeshMap[meshFile] : null;
      if (!geometry) {
        console.warn(`halo particles: mesh geometry '${meshFile}' not found for emitter ${this.name}`);
        return;
      }
      const material = makeMeshInstanceMaterial(this.materialData, this.textureCache);
      const instanced = new THREE.InstancedMesh(geometry, material, capacity);
      instanced.frustumCulled = false;
      instanced.count = 0;
      instanced.name = `EmitterMesh_${this.name}`;
      this.meshInstanced = instanced;
      this.object3d.add(instanced);
      return;
    }

    // Billboard / stretch / axis-billboard — all treated as camera-billboard for MVP
    const uvOffset = computeUvFrameOffset(this.spec.uv);
    const { geometry, centers, colors, sizes, rotations } = buildBillboardGeometry(capacity);
    const material = makeBillboardMaterial(this.materialData, this.textureCache, {
      tilesX: uvOffset.tilesX,
      tilesY: uvOffset.tilesY,
      frameOffsetU: uvOffset.u,
      frameOffsetV: uvOffset.v,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.name = `EmitterBillboard_${this.name}`;
    this.instanced = { mesh, geometry, centers, colors, sizes, rotations };
    this.object3d.add(mesh);
  }

  _spawn(rng = Math.random) {
    if (!this.capacity) return;
    // Find a dead slot
    let slot = -1;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.particles[i].alive) { slot = i; break; }
    }
    if (slot < 0) return; // over capacity

    const lifetime = Math.max(0.01, minMaxValue(this.lifetimeSpec, rng));
    const size = Math.max(0, minMaxValue(this.sizeSpec, rng));
    const rotation = Number(this.rotationSpec?.scalar ?? 0);
    const color = minMaxColor(this.colorSpec, rng);
    const position = new THREE.Vector3();
    sampleShape(this.spec.shape, rng, position);

    const p = this.particles[slot];
    p.alive = true;
    p.age = 0;
    p.lifetime = lifetime;
    p.size = size;
    p.rotation = rotation;
    p.color = color;
    p.colorLifeMix = rng();
    p.position = position;
    p.velocity = new THREE.Vector3(0, 0, 0);
  }

  update(dt, rng = Math.random) {
    if (!this.capacity) return;
    this.clockTime += dt;

    // Emission
    if (this.emissionEnabled) {
      this.accumulator += this.rate * dt;
      const count = Math.floor(this.accumulator);
      for (let i = 0; i < count; i++) this._spawn(rng);
      this.accumulator -= count;
    }

    // Age + kill
    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.lifetime) {
        p.alive = false;
        continue;
      }
      p.position.addScaledVector(p.velocity, dt);
      live++;
    }

    // Update GPU attributes
    if (this.instanced) this._writeBillboardAttrs();
    if (this.meshInstanced) this._writeMeshAttrs();
  }

  _writeBillboardAttrs() {
    const { geometry, centers, colors, sizes, rotations } = this.instanced;
    let idx = 0;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      centers.array[idx * 3 + 0] = p.position.x;
      centers.array[idx * 3 + 1] = p.position.y;
      centers.array[idx * 3 + 2] = p.position.z;
      const a = Math.max(0, 1 - p.age / p.lifetime); // simple linear alpha fade
      const lifeT = THREE.MathUtils.clamp(p.age / p.lifetime, 0, 1);
      const lifeColor = this.colorOverLifeSpec
        ? sampleGradientColor(this.colorOverLifeSpec, lifeT, p.colorLifeMix)
        : { r: 1, g: 1, b: 1, a: 1 };
      colors.array[idx * 4 + 0] = p.color.r * lifeColor.r;
      colors.array[idx * 4 + 1] = p.color.g * lifeColor.g;
      colors.array[idx * 4 + 2] = p.color.b * lifeColor.b;
      colors.array[idx * 4 + 3] = p.color.a * lifeColor.a * a;
      sizes.array[idx] = p.size;
      rotations.array[idx] = p.rotation;
      idx++;
    }
    centers.needsUpdate = true;
    colors.needsUpdate = true;
    sizes.needsUpdate = true;
    rotations.needsUpdate = true;
    geometry.instanceCount = idx;
  }

  _writeMeshAttrs() {
    const im = this.meshInstanced;
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    let idx = 0;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      // For mesh-instance particles we still render at the sampled position with
      // the emitter's implicit orientation. No per-particle rotation for MVP.
      quat.identity();
      matrix.compose(p.position, quat, new THREE.Vector3(p.size, p.size, p.size));
      im.setMatrixAt(idx, matrix);
      idx++;
    }
    im.count = idx;
    im.instanceMatrix.needsUpdate = true;
    im.material.uniforms.u_Time.value = this.clockTime;
  }

  prewarm(rng = Math.random, steps = 60) {
    // Run a stabilized simulation once to avoid the halo starting empty.
    if (!this.capacity || !this._prewarm) return;
    const dt = Math.min(0.1, this.duration / Math.max(1, steps));
    for (let i = 0; i < steps; i++) this.update(dt, rng);
  }
}

async function loadTrailMeshes(basePath, particles) {
  const wanted = new Set();
  for (const p of particles) {
    const f = p.renderer?.mesh_file;
    if (f) wanted.add(f);
  }
  if (!wanted.size) return {};
  const loader = new GLTFLoader();
  const out = {};
  for (const file of wanted) {
    try {
      const gltf = await new Promise((resolve, reject) =>
        loader.load(basePath + file, resolve, undefined, reject)
      );
      let geom = null;
      gltf.scene.traverse((obj) => {
        if (obj.isMesh && !geom) geom = obj.geometry;
      });
      if (geom) out[file] = geom;
    } catch (err) {
      console.warn(`halo particles: failed to load trail mesh ${file}`, err);
    }
  }
  return out;
}

function buildMaterialLookup(materialDataByName) {
  // Accept either {name: data} or array of {name, ...data}
  if (!materialDataByName) return {};
  if (Array.isArray(materialDataByName)) {
    const out = {};
    for (const m of materialDataByName) {
      if (m?.name) out[m.name] = m;
    }
    return out;
  }
  return materialDataByName;
}

/**
 * Build a halo particle system for an asset that has halo_particles metadata.
 *
 * @param {object} options
 * @param {object} options.particleData — parsed halo_particles.json
 * @param {object} options.materialDataByName — { materialName -> parsed material json }
 * @param {object} options.textureCache — { textureName -> THREE.Texture }
 * @param {string} options.basePath — base URL for GLB fetches (trail meshes)
 * @returns {Promise<{root: THREE.Group, update: (dt:number)=>void, emitters: Emitter[]}>}
 */
export async function createHaloParticleSystem({ particleData, materialDataByName, textureCache = {}, basePath }) {
  const root = new THREE.Group();
  root.name = "HaloParticleSystem";

  const particles = (particleData?.particles || []).slice(0, MAX_EMITTERS_PER_HALO);
  if (!particles.length) return { root, update: () => {}, emitters: [] };

  const trailMeshMap = await loadTrailMeshes(basePath, particles);
  const matLookup = buildMaterialLookup(materialDataByName);

  // Separate the FX_<...>_Halo container (render mode None) from active emitters.
  // particles.root already has the halo orientation applied by loader.js (from
  // halo_anchor.rotation, viewer basis). The container's local_transform.rotation
  // in halo_particles.json is raw Unity basis — applying it here would double
  // the rotation. So we only use the container's scale and position (position is
  // already baked into haloTarget, kept as identity); child emitter local
  // rotations still apply relative to this container.
  let containerSpec = null;
  const childSpecs = [];
  for (const p of particles) {
    if (p.renderer?.render_mode === RENDER_NONE || (typeof p.name === "string" && /^FX_.*_Halo$/i.test(p.name) && !/trail|blood|star|particle/i.test(p.name))) {
      containerSpec = p;
    } else {
      childSpecs.push(p);
    }
  }
  const containerNode = new THREE.Group();
  containerNode.name = "HaloFXContainer";
  if (containerSpec?.local_transform?.scale) {
    const s = containerSpec.local_transform.scale;
    containerNode.scale.set(s.x ?? 1, s.y ?? 1, s.z ?? 1);
  }
  root.add(containerNode);

  const emitters = [];
  for (const spec of childSpecs) {
    const matName = spec.renderer?.material_name;
    const matData = matName ? matLookup[matName] : null;
    const emitter = new Emitter(spec, matData, textureCache, trailMeshMap);
    emitter.init({ capacity: 512 });
    if (emitter.object3d) containerNode.add(emitter.object3d);
    emitter.prewarm();
    emitters.push(emitter);
    if (typeof window !== "undefined" && window.HALO_PARTICLES_DEBUG) {
      const dbg = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.05, 0.05),
        new THREE.MeshBasicMaterial({ color: 0xffff00, wireframe: true, depthTest: false })
      );
      dbg.renderOrder = 999;
      emitter.object3d.add(dbg);
      console.info(`[halo] debug cube for ${spec.name} at local position`, emitter.object3d.position.toArray());
    }
  }

  console.info(`[halo] particle system: container=${containerSpec?.name ?? "none"} children=${emitters.length} trailMeshes=${Object.keys(trailMeshMap).join(",") || "(none)"}`);
  for (const e of emitters) {
    const r = e.spec.renderer || {};
    console.info(`[halo]   ${e.name}: mode=${r.render_mode} mat=${r.material_name ?? "-"} mesh=${r.mesh_name ?? "-"} rate=${e.rate} enabled=${e.emissionEnabled} cap=${e.capacity}`);
  }

  function update(dt) {
    for (const e of emitters) e.update(dt);
  }

  return { root, update, emitters };
}
