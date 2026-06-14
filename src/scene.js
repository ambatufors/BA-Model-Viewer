import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import { applyFxOverlaySpin } from "./loader.js";

let scene, camera, renderer, controls, labelRenderer;
let composer, bloomPass;
let currentModel = null;
let lightHelpers = [];
let axisHelpers = [];
let gridHelper = null;
let bodyPartMarkersVisible = false;
const haloFollowWorldPos = new THREE.Vector3();
const haloFollowLocalPos = new THREE.Vector3();
const haloFollowOriginWorld = new THREE.Vector3();
const haloFollowOriginLocal = new THREE.Vector3();
const haloFollowDirectionLocal = new THREE.Vector3();
const haloFollowYawQuat = new THREE.Quaternion();
const haloFollowUpAxis = new THREE.Vector3(0, 0, 1);
const haloFollowRootWorldQuat = new THREE.Quaternion();
const haloFollowTargetWorldQuat = new THREE.Quaternion();
const haloFollowTargetLocalQuat = new THREE.Quaternion();
const bodyPartMarkerWorldPos = new THREE.Vector3();
const BODY_PART_ANCHORS = [
  {
    id: "head",
    label: "Head",
    color: "#ffd166",
    aliases: ["Bip001 Head", "Head"]
  },
  {
    id: "neck",
    label: "Neck",
    color: "#f78c6b",
    aliases: ["Bip001 Neck", "Neck"]
  },
  {
    id: "chest",
    label: "Chest",
    color: "#7ec8e3",
    aliases: ["Bip001 Spine1", "Bip001 Spine2", "Spine1", "Spine2", "Chest"]
  },
  {
    id: "pelvis",
    label: "Pelvis",
    color: "#c792ea",
    aliases: ["Bip001 Pelvis", "Pelvis"]
  },
  {
    id: "leftShoulder",
    label: "L Shoulder",
    color: "#82d982",
    aliases: ["Bip001 L Clavicle", "Bip001 L UpperArm", "L Clavicle", "L UpperArm"]
  },
  {
    id: "rightShoulder",
    label: "R Shoulder",
    color: "#82d982",
    aliases: ["Bip001 R Clavicle", "Bip001 R UpperArm", "R Clavicle", "R UpperArm"]
  },
  {
    id: "leftHand",
    label: "L Hand",
    color: "#89ddff",
    aliases: ["Bip001 L Hand", "L Hand", "LeftHand"]
  },
  {
    id: "rightHand",
    label: "R Hand",
    color: "#89ddff",
    aliases: ["Bip001 R Hand", "R Hand", "RightHand"]
  },
  {
    id: "leftKnee",
    label: "L Knee",
    color: "#ffcb6b",
    aliases: ["Bip001 L Calf", "L Calf", "LeftLeg"]
  },
  {
    id: "rightKnee",
    label: "R Knee",
    color: "#ffcb6b",
    aliases: ["Bip001 R Calf", "R Calf", "RightLeg"]
  },
  {
    id: "leftFoot",
    label: "L Foot",
    color: "#f07178",
    aliases: ["Bip001 L Foot", "L Foot", "LeftFoot"]
  },
  {
    id: "rightFoot",
    label: "R Foot",
    color: "#f07178",
    aliases: ["Bip001 R Foot", "R Foot", "RightFoot"]
  }
];

export function getScene() { return scene; }
export function getCamera() { return camera; }
export function getControls() { return controls; }
export function toggleLightHelpers(visible) {
  for (const h of lightHelpers) h.visible = visible;
}
export function toggleAxes(visible) {
  for (const h of axisHelpers) h.visible = visible;
}
export function toggleGrid(visible) {
  if (gridHelper) gridHelper.visible = !!visible;
}
export function toggleBodyPartMarkers(visible) {
  bodyPartMarkersVisible = !!visible;
  syncBodyPartMarkers();
}
export function listModelParts() {
  if (!currentModel) return [];

  const groups = collectModelPartGroups(currentModel);
  const registry = currentModel.userData?.listModelPartRegistry?.() || [];
  for (const item of registry) {
    if (!item?.id || groups.has(item.id)) continue;
    groups.set(item.id, {
      id: item.id,
      label: modelPartLabel(item.name || item.id),
      meshCount: 0,
      renderables: new Set(),
      targets: new Set(),
      children: [],
      loaded: !!item.loaded,
      deferred: !!item.deferred
    });
  }

  const overrides = getModelPartOverrides(currentModel);
  return [...groups.values()]
    .map((group) => ({
      id: group.id,
      label: group.label,
      visible: modelPartGroupVisible(group),
      forced: overrides.has(group.id) ? overrides.get(group.id) : null,
      loaded: group.loaded || group.targets.size > 0,
      deferred: group.deferred,
      meshCount: group.meshCount,
      targetCount: group.targets.size,
      children: modelPartChildEntries(group, overrides)
    }))
    .sort(compareModelPartEntries);
}
export async function setModelPartVisibility(partId, visible) {
  if (!currentModel || !partId) return listModelParts();

  setModelPartOverride(currentModel, partId, !!visible);
  if (visible && currentModel.userData?.loadModelPart) {
    await currentModel.userData.loadModelPart(partId);
  }
  applyModelPartVisibilityOverrides();
  return listModelParts();
}
export function resetModelPartVisibilityOverrides() {
  if (!currentModel) return [];

  const overrides = getModelPartOverrides(currentModel);
  const groups = collectModelPartGroups(currentModel);
  resetAllModelPartTargets(groups);
  overrides.clear();
  currentModel.userData.modelPartVisibilityOverrideOrder?.clear?.();
  reapplyAnimationVisibility();
  return listModelParts();
}

export function clearScene() {
  if (currentModel) {
    disposeBodyPartMarkers(currentModel);
    currentModel.userData?.modelFx?.dispose?.();
    currentModel.userData?.animationState?.stop?.();
    scene.remove(currentModel);
    currentModel = null;
  }
}

export function setCurrentModel(model) {
  currentModel = model;
  syncBodyPartMarkers();
  // Dev helpers: expose the most recently loaded character + a few small
  // utilities for poking at the live scene graph from the browser console
  // without a build step. Safe in production: just references and pure
  // visibility toggles, no global state writes.
  if (typeof window !== "undefined") {
    window.__currentModel = model;
    window.__dev = {
      seekTo: async (clipName, time) => {
        const state = model?.userData?.animationState;
        if (!state) {
          console.warn("no animation state");
          return;
        }
        await state.playClip(clipName);
        const action = state.currentActions[0];
        if (action) {
          action.time = time;
          action.paused = true;
          state.playing = false;
          state.lastExpressionTime = -1;
          state.updateExpressions(true);
        } else {
          console.warn(`no action for ${clipName}`);
        }
        console.log(`Seeked ${clipName} to t=${time}`);
      },
      hideByName: (substring) => {
        let count = 0;
        model?.traverse((child) => {
          if (
            child.name &&
            child.name.toLowerCase().includes(substring.toLowerCase())
          ) {
            child.visible = false;
            count++;
          }
        });
        console.log(`Hidden ${count} object(s) matching '${substring}'`);
      },
      showByName: (substring) => {
        let count = 0;
        model?.traverse((child) => {
          if (
            child.name &&
            child.name.toLowerCase().includes(substring.toLowerCase())
          ) {
            child.visible = true;
            count++;
          }
        });
        console.log(`Shown ${count} object(s) matching '${substring}'`);
      },
      // Sample any registered renderer-toggle mesh's main texture
      // directly via a temp 2D canvas. Lets us verify, from the live
      // scene, exactly which atlas pixels the mesh would fetch under
      // each flipY interpretation.
      readTexAt: (toggleSuffix, uvx, uvy) => {
        const parts = model?.userData?.animationState?.rendererToggleParts || [];
        const part = parts.find((p) =>
          p.root.userData?.toggleTag?.endsWith(toggleSuffix)
        );
        if (!part) {
          console.warn(`no toggle part with suffix '${toggleSuffix}'`);
          return;
        }
        let tex = null;
        part.root.traverse((child) => {
          if (tex || !child.isMesh) return;
          const mat = Array.isArray(child.material)
            ? child.material[0]
            : child.material;
          tex = mat?.uniforms?.u_MainTex?.value;
        });
        if (!tex?.image) {
          console.warn("no texture image");
          return;
        }
        const W = tex.image.width;
        const H = tex.image.height;
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(tex.image, 0, 0);
        const px = Math.max(0, Math.min(W - 1, Math.floor(uvx * W)));
        const py_false = Math.max(0, Math.min(H - 1, Math.floor((1 - uvy) * H)));
        const py_true = Math.max(0, Math.min(H - 1, Math.floor(uvy * H)));
        const a = Array.from(ctx.getImageData(px, py_false, 1, 1).data);
        const b = Array.from(ctx.getImageData(px, py_true, 1, 1).data);
        console.log(
          `tex ${W}x${H} flipY=${tex.flipY}` +
            ` | uv=(${uvx.toFixed(3)},${uvy.toFixed(3)})` +
            ` flipY-false py=${py_false} rgba=[${a.join(",")}]` +
            ` flipY-true py=${py_true} rgba=[${b.join(",")}]`
        );
      },
      // Render the live Face/Face01 mesh to a 2D canvas overlay using
      // canvas image-bitmap sampling that mirrors GL semantics. Pure
      // diagnostic helper: write the result to an <a> data-url so the
      // user can save it and compare against the source atlas.
      dumpMeshUvOverlay: (toggleSuffix) => {
        const parts = model?.userData?.animationState?.rendererToggleParts || [];
        const part = parts.find((p) =>
          p.root.userData?.toggleTag?.endsWith(toggleSuffix)
        );
        if (!part) {
          console.warn(`no toggle part with suffix '${toggleSuffix}'`);
          return;
        }
        let tex = null;
        let uvs = null;
        let indices = null;
        part.root.traverse((child) => {
          if (tex || !child.isMesh) return;
          const mat = Array.isArray(child.material)
            ? child.material[0]
            : child.material;
          tex = mat?.uniforms?.u_MainTex?.value;
          const uvAttr = child.geometry.attributes.uv;
          uvs = [];
          for (let i = 0; i < uvAttr.count; i++) {
            uvs.push([uvAttr.getX(i), uvAttr.getY(i)]);
          }
          const idxAttr = child.geometry.index;
          if (idxAttr) {
            indices = [];
            for (let i = 0; i < idxAttr.count; i++) indices.push(idxAttr.getX(i));
          }
        });
        if (!tex?.image || !uvs) {
          console.warn("no texture or UV data");
          return;
        }
        const W = tex.image.width;
        const H = tex.image.height;
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        const ctx = c.getContext("2d");
        ctx.drawImage(tex.image, 0, 0);
        ctx.strokeStyle = "rgba(255,0,0,0.8)";
        ctx.lineWidth = 1;
        const flipY = tex.flipY;
        const yFn = flipY ? (v) => v * H : (v) => (1 - v) * H;
        if (indices && indices.length) {
          for (let i = 0; i < indices.length; i += 3) {
            const a = indices[i],
              b = indices[i + 1],
              cc = indices[i + 2];
            ctx.beginPath();
            ctx.moveTo(uvs[a][0] * W, yFn(uvs[a][1]));
            ctx.lineTo(uvs[b][0] * W, yFn(uvs[b][1]));
            ctx.lineTo(uvs[cc][0] * W, yFn(uvs[cc][1]));
            ctx.closePath();
            ctx.stroke();
          }
        }
        const link = document.createElement("a");
        link.href = c.toDataURL("image/png");
        link.download = `${toggleSuffix.replace(/^\//, "")}_uv_overlay.png`;
        link.textContent = `download ${link.download}`;
        link.style.position = "fixed";
        link.style.top = "10px";
        link.style.left = "10px";
        link.style.background = "white";
        link.style.padding = "4px";
        link.style.zIndex = 9999;
        document.body.appendChild(link);
        console.log(`UV overlay written, click the link in top-left to save`);
      },
      bodyPartMarkers: () => {
        const entries =
          model?.userData?.bodyPartMarkers?.userData?.bodyPartMarkers || [];
        return entries.map((entry) => ({
          id: entry.id,
          label: entry.label,
          bone: entry.target?.name || "",
          visible: entry.marker?.visible !== false
        }));
      },
      modelParts: () => listModelParts()
    };
  }
}

export function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a2a2f);

  camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 1.0, 4);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  // Match the original pipeline: character textures are tagged LinearSRGB and
  // the framebuffer is treated as linear too. Changing this to sRGB breaks the
  // toon/face shaders because it would make OutputPass double-convert.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  // Post-process pipeline: render -> bloom -> output. UnrealBloomPass picks up
  // pixels with HDR values > threshold and blooms them. Halo particle materials
  // push color above 1.0 (e.g. FX_MAT_CH0151_Halo_02 _Color = 5.99) intentionally
  // to trigger the bloom pass.
  const hdrTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  composer = new EffectComposer(renderer, hdrTarget);
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.setPixelRatio(window.devicePixelRatio);
  const renderPass = new RenderPass(null, null); // scene/camera filled in animate()
  composer.addPass(renderPass);
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.25, // strength — BA uses a subtle bloom
    0.6,  // radius
    1.5   // threshold — raise bar so only HDR highlights bloom
  );
  composer.addPass(bloomPass);
  // No OutputPass: with renderer.outputColorSpace = LinearSRGB and NoToneMapping,
  // we want the composer output to match a direct renderer.render() call. Adding
  // OutputPass would inject an extra color-space conversion that breaks the
  // character toon/face shader look.

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.8, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.update();

  // Dev/probe handle: the FX screenshot harness projects emitter positions
  // through this to reason about screen coverage at varying camera distances.
  if (typeof window !== "undefined") {
    window.__viewerCamera = camera;
    window.__viewerControls = controls;
  }

  gridHelper = new THREE.GridHelper(10, 20, 0xaaaacc, 0x888899);
  scene.add(gridHelper);

  const axesLen = 2;
  const axes = new THREE.AxesHelper(axesLen);
  scene.add(axes);
  axisHelpers.push(axes);

  // Axis labels
  labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.domElement.style.position = "absolute";
  labelRenderer.domElement.style.top = "0";
  labelRenderer.domElement.style.left = "0";
  labelRenderer.domElement.style.pointerEvents = "none";
  document.body.appendChild(labelRenderer.domElement);

  function makeLabel(text, color, pos) {
    const div = document.createElement("div");
    div.textContent = text;
    div.style.color = color;
    div.style.fontSize = "13px";
    div.style.fontWeight = "bold";
    div.style.fontFamily = "monospace";
    const label = new CSS2DObject(div);
    label.position.copy(pos);
    scene.add(label);
    return label;
  }

  axisHelpers.push(
    makeLabel("+X", "#ddddee", new THREE.Vector3(axesLen + 0.15, 0, 0)),
    makeLabel("-X", "#ddddee", new THREE.Vector3(-axesLen - 0.15, 0, 0)),
    makeLabel("+Y", "#ddddee", new THREE.Vector3(0, axesLen + 0.15, 0)),
    makeLabel("-Y", "#ddddee", new THREE.Vector3(0, -axesLen - 0.15, 0)),
    makeLabel("+Z", "#ddddee", new THREE.Vector3(0, 0, axesLen + 0.15)),
    makeLabel("-Z", "#ddddee", new THREE.Vector3(0, 0, -axesLen - 0.15))
  );

  // Light direction helpers
  buildLightHelpers(makeLabel);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    bloomPass.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, clock.getDelta()); // clamp dt to avoid large jumps
    const time = clock.getElapsedTime();
    updateRuntimeAnimations(scene, time, dt);
    controls.update();
    // Composer needs scene + camera; set on the RenderPass each frame to allow
    // scene swaps.
    composer.passes[0].scene = scene;
    composer.passes[0].camera = camera;
    composer.render();
    labelRenderer.render(scene, camera);
  }
  animate();

  return { scene, camera, renderer, controls };
}

function updateRuntimeAnimations(root, time, dt) {
  const animationState = currentModel?.userData?.animationState;
  if (animationState?.playing) {
    for (const mixer of animationState.mixers || []) {
      mixer.timeScale = animationState.speed;
      mixer.update(dt);
    }
    animationState.updateExpressions?.();
    currentModel?.userData?.modelFx?.tick?.(dt);
  }
  applyModelPartVisibilityOverrides();
  currentModel?.userData?.centerOnOrigin?.();
  updateBodyPartMarkers();

  // FX overlays (e.g. CH0145 cutin spiral eyes) need a per-frame Z
  // spin against the active clip time. Visibility is already handled
  // by applyRendererToggleParts inside updateExpressions; this only
  // updates rotation and runs whether or not the model is paused so
  // the eyes still spin on a paused frame for diagnostic purposes.
  const fxFollowers = currentModel?.userData?.fxOverlayFollowers;
  if (fxFollowers?.length) {
    applyFxOverlaySpin(fxFollowers, animationState);
  }

  root.traverse((child) => {
    if (child.material?.uniforms?.u_Time) {
      child.material.uniforms.u_Time.value = time;
    }

    const followed = updateHaloFollow(child);

    const particleUpdate = child.userData?.haloParticleUpdate;
    if (particleUpdate) {
      particleUpdate(dt);
    }

    const anim = child.userData?.haloAnimation;
    if (!anim) return;

    const basePos = child.userData.haloBasePosition;
    if (basePos && !followed) {
      child.position.copy(basePos);
    }
    if (basePos || followed) {
      if (anim.bobSpeed && anim.bobAmount) {
        child.position.y += Math.sin(time * anim.bobSpeed) * anim.bobAmount;
      }
    }
  });
}

function updateHaloFollow(object) {
  const follow = object.userData?.haloFollow;
  if (!follow?.target || !follow?.localRoot || !follow?.targetLocalOffset || !follow.target.parent) return false;

  follow.localRoot.updateWorldMatrix(true, true);
  follow.target.updateWorldMatrix(true, false);
  haloFollowWorldPos.copy(follow.targetLocalOffset);
  follow.target.localToWorld(haloFollowWorldPos);
  haloFollowLocalPos.copy(haloFollowWorldPos);
  follow.localRoot.worldToLocal(haloFollowLocalPos);

  object.position
    .copy(haloFollowLocalPos)
    .add(follow.rootOffset);
  updateHaloFollowRotation(object, follow);
  return true;
}

function updateHaloFollowRotation(object, follow) {
  if (follow.targetRelativeQuaternion) {
    follow.localRoot.getWorldQuaternion(haloFollowRootWorldQuat).invert();
    follow.target.getWorldQuaternion(haloFollowTargetWorldQuat);
    haloFollowTargetLocalQuat
      .copy(haloFollowRootWorldQuat)
      .multiply(haloFollowTargetWorldQuat);
    object.quaternion
      .copy(haloFollowTargetLocalQuat)
      .multiply(follow.targetRelativeQuaternion);
    return;
  }

  if (!follow.baseQuaternion || !follow.targetForwardLocal || !Number.isFinite(follow.baseYaw)) return;

  follow.target.getWorldPosition(haloFollowOriginWorld);
  haloFollowWorldPos.copy(follow.targetForwardLocal);
  follow.target.localToWorld(haloFollowWorldPos);
  haloFollowOriginLocal.copy(haloFollowOriginWorld);
  haloFollowLocalPos.copy(haloFollowWorldPos);
  follow.localRoot.worldToLocal(haloFollowOriginLocal);
  follow.localRoot.worldToLocal(haloFollowLocalPos);
  haloFollowDirectionLocal.copy(haloFollowLocalPos).sub(haloFollowOriginLocal);

  const yaw = yawFromLocalDirection(haloFollowDirectionLocal);
  if (!Number.isFinite(yaw)) return;
  haloFollowYawQuat.setFromAxisAngle(haloFollowUpAxis, yaw - follow.baseYaw);
  object.quaternion.copy(follow.baseQuaternion).premultiply(haloFollowYawQuat);
}

function yawFromLocalDirection(direction) {
  const lenSq = direction.x * direction.x + direction.y * direction.y;
  if (lenSq < 1e-10) return null;
  return Math.atan2(direction.y, direction.x);
}

function buildLightHelpers(makeLabel) {
  updateLightHelpers(makeLabel);
  toggleLightHelpers(false);  // start hidden (checkbox unchecked by default)
}

export function updateLightHelpers(makeLabelFn) {
  // Remove old helpers
  for (const h of lightHelpers) scene.remove(h);
  lightHelpers = [];

  // Character light helpers are disabled for the no-main/no-rim experiment.
}

function getModelPartOverrides(model) {
  if (!model.userData.modelPartVisibilityOverrides) {
    model.userData.modelPartVisibilityOverrides = new Map();
  }
  return model.userData.modelPartVisibilityOverrides;
}

function getModelPartOverrideOrder(model) {
  if (!model.userData.modelPartVisibilityOverrideOrder) {
    model.userData.modelPartVisibilityOverrideOrder = new Map();
  }
  return model.userData.modelPartVisibilityOverrideOrder;
}

function setModelPartOverride(model, partId, visible) {
  const overrides = getModelPartOverrides(model);
  const order = getModelPartOverrideOrder(model);
  model.userData.modelPartVisibilityOverrideSerial =
    (model.userData.modelPartVisibilityOverrideSerial || 0) + 1;
  overrides.set(partId, !!visible);
  order.set(partId, model.userData.modelPartVisibilityOverrideSerial);
}

function orderedModelPartOverrides(model, overrides) {
  const order = getModelPartOverrideOrder(model);
  return [...overrides.entries()].sort((a, b) => {
    const orderA = order.get(a[0]) || 0;
    const orderB = order.get(b[0]) || 0;
    return orderA - orderB;
  });
}

function applyModelPartVisibilityOverrides() {
  if (!currentModel) return;
  const overrides = currentModel.userData?.modelPartVisibilityOverrides;
  if (!overrides?.size) return;

  const groups = collectModelPartGroups(currentModel);
  for (const [partId, visible] of orderedModelPartOverrides(
    currentModel,
    overrides
  )) {
    if (isModelPartChildId(partId)) {
      const child = findModelPartChild(groups, partId);
      if (child) applyModelPartChildOverride(child, visible);
    } else {
      const group = groups.get(partId);
      if (group) applyModelPartGroupOverride(group, visible);
    }
  }
}

function modelPartChildEntries(group, overrides) {
  if (!group.children?.length || group.children.length < 2) return [];
  return group.children.map((child) => ({
    id: child.id,
    parentId: group.id,
    label: child.label,
    visible: modelPartChildVisible(child),
    forced: overrides.has(child.id) ? overrides.get(child.id) : null,
    loaded: true,
    deferred: false,
    meshCount: 1,
    targetCount: child.onTargets.size
  }));
}

function isModelPartChildId(id) {
  return String(id || "").includes("::");
}

function findModelPartChild(groups, childId) {
  for (const group of groups.values()) {
    const child = group.children?.find((item) => item.id === childId);
    if (child) return child;
  }
  return null;
}

function modelPartChildVisible(child) {
  return isWorldVisible(child.renderable);
}

function resetAllModelPartTargets(groups) {
  for (const group of groups.values()) {
    for (const target of group.targets) target.visible = true;
    for (const child of group.children || []) {
      for (const target of child.onTargets) target.visible = true;
      for (const target of child.offTargets) target.visible = true;
    }
  }
}

function applyModelPartGroupOverride(group, visible) {
  for (const target of group.targets) {
    target.visible = !!visible;
  }
}

function applyModelPartChildOverride(child, visible) {
  const targets = visible ? child.onTargets : child.offTargets;
  for (const target of targets) {
    target.visible = !!visible;
  }
  for (const linked of child.linkedRenderables || []) {
    linked.visible = !!visible;
  }
}

function reapplyAnimationVisibility() {
  const state = currentModel?.userData?.animationState;
  if (!state) return;
  state.updateVisibility?.();
  state.updateExpressions?.(true);
}

function collectModelPartGroups(model) {
  const groups = new Map();
  model.traverse((object) => {
    if (!isModelPartRenderable(object)) return;

    const partId = resolveModelPartName(object, model);
    if (!partId) return;

    let group = groups.get(partId);
    if (!group) {
      group = {
        id: partId,
        label: modelPartLabel(partId),
        meshCount: 0,
        renderables: new Set(),
        targets: new Set(),
        children: [],
        loaded: true,
        deferred: false
      };
      groups.set(partId, group);
    }
    group.meshCount += 1;
    group.renderables.add(object);
    addModelPartTargets(group, object, partId, model);
    addModelPartChild(group, object, partId, model);
  });
  finalizeModelPartChildren(groups);
  return groups;
}

function isModelPartRenderable(object) {
  if (!object?.isMesh) return false;
  let cur = object;
  while (cur) {
    if (cur.userData?.isBodyPartMarkers || cur.userData?.isBodyPartMarker) {
      return false;
    }
    if (cur === currentModel) break;
    cur = cur.parent;
  }
  return true;
}

function resolveModelPartName(object, model) {
  let cur = object;
  while (cur && cur !== model) {
    const partName = cur.userData?.skinnedPartName;
    if (partName) return String(partName);
    cur = cur.parent;
  }

  cur = object;
  while (cur && cur !== model) {
    const baseName = cur.userData?.meshBaseName;
    if (baseName) return String(baseName);
    cur = cur.parent;
  }

  return object.name || "";
}

function addModelPartTargets(group, object, partId, model) {
  let matched = false;
  let cur = object;
  while (cur && cur !== model) {
    if (
      cur.userData?.skinnedPartName === partId ||
      cur.userData?.meshBaseName === partId
    ) {
      group.targets.add(cur);
      matched = true;
    }
    cur = cur.parent;
  }
  if (!matched) group.targets.add(object);
}

function addModelPartChild(group, object, partId, model) {
  const child = {
    id: `${partId}::${group.children.length}`,
    label: modelPartChildBaseLabel(object),
    renderable: object,
    linkedRenderables: Array.isArray(object.userData?.outlineMeshes)
      ? object.userData.outlineMeshes
      : [],
    onTargets: new Set([object]),
    offTargets: new Set([object])
  };

  let cur = object;
  while (cur && cur !== model) {
    if (
      cur.userData?.skinnedPartName === partId ||
      cur.userData?.meshBaseName === partId
    ) {
      child.onTargets.add(cur);
    }
    cur = cur.parent;
  }
  group.children.push(child);
}

function finalizeModelPartChildren(groups) {
  for (const group of groups.values()) {
    const counts = new Map();
    for (const child of group.children || []) {
      const count = counts.get(child.label) || 0;
      counts.set(child.label, count + 1);
    }

    const seen = new Map();
    for (const child of group.children || []) {
      const total = counts.get(child.label) || 0;
      if (total < 2) continue;

      const index = (seen.get(child.label) || 0) + 1;
      seen.set(child.label, index);
      child.label = `${child.label} ${index}`;
    }
  }
}

function modelPartChildBaseLabel(object) {
  if (object.userData?.isOutlineMesh) {
    const sourceBaseName = object.userData?.outlineSourceMeshBaseName;
    return sourceBaseName
      ? `${modelPartLabel(sourceBaseName)} Outline`
      : "Outline";
  }
  const baseName = object.userData?.meshBaseName;
  if (baseName) return modelPartLabel(baseName);
  if (object.name) return modelPartLabel(object.name);
  return object.type || "Mesh";
}

function modelPartGroupVisible(group) {
  if (!group.renderables?.size) return false;
  for (const object of group.renderables) {
    if (isWorldVisible(object)) return true;
  }
  return false;
}

function isWorldVisible(object) {
  let cur = object;
  while (cur) {
    if (cur.visible === false) return false;
    if (cur === currentModel) return true;
    cur = cur.parent;
  }
  return false;
}

function modelPartLabel(name) {
  return String(name || "")
    .replace(/^CH\d+_/i, "")
    .replace(/_/g, " ");
}

function compareModelPartEntries(a, b) {
  const rankA = modelPartRank(a.id);
  const rankB = modelPartRank(b.id);
  if (rankA !== rankB) return rankA - rankB;
  return a.label.localeCompare(b.label);
}

function modelPartRank(id) {
  const normalized = normalizeObjectName(id);
  if (normalized === "body") return 0;
  if (normalized === "hair") return 10;
  if (normalized.includes("face")) return 20;
  if (normalized.includes("eye") || normalized.includes("brow")) return 30;
  if (normalized.includes("halo")) return 40;
  if (normalized.includes("weapon")) return 50;
  if (normalized.includes("prop")) return 60;
  if (normalized.includes("cockpit") || normalized.includes("controller")) return 70;
  return 100;
}

function syncBodyPartMarkers() {
  if (!currentModel) return;
  disposeBodyPartMarkers(currentModel);
  if (!bodyPartMarkersVisible) return;

  const root = new THREE.Group();
  root.name = "__BodyPartMarkers";
  root.userData.isBodyPartMarkers = true;
  root.userData.bodyPartMarkers = [];
  currentModel.add(root);
  currentModel.userData.bodyPartMarkers = root;

  const usedTargets = new Set();
  const sphereGeometry = new THREE.SphereGeometry(0.025, 12, 8);
  for (const anchor of BODY_PART_ANCHORS) {
    const target = resolveBodyPartAnchor(currentModel, anchor.aliases, usedTargets);
    if (!target) continue;

    const marker = new THREE.Group();
    marker.name = `BodyPoint_${anchor.id}`;
    marker.userData.isBodyPartMarker = true;

    const dot = new THREE.Mesh(
      sphereGeometry,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(anchor.color),
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false
      })
    );
    dot.name = `${marker.name}_Dot`;
    dot.renderOrder = 20;
    marker.add(dot);

    const label = createBodyPartLabel(anchor.label, anchor.color);
    label.position.set(0, 0.045, 0);
    marker.add(label);

    root.add(marker);
    usedTargets.add(target);
    root.userData.bodyPartMarkers.push({
      id: anchor.id,
      label: anchor.label,
      marker,
      target
    });
  }

  updateBodyPartMarkers();
}

function disposeBodyPartMarkers(model) {
  const root = model?.userData?.bodyPartMarkers;
  if (!root) return;
  root.traverse((child) => {
    if (child.element?.remove) child.element.remove();
    if (child.geometry?.dispose) child.geometry.dispose();
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    for (const material of materials) {
      if (material?.dispose) material.dispose();
    }
  });
  root.parent?.remove(root);
  model.userData.bodyPartMarkers = null;
}

function updateBodyPartMarkers() {
  const root = currentModel?.userData?.bodyPartMarkers;
  const entries = root?.userData?.bodyPartMarkers || [];
  if (!entries.length) return;

  currentModel.updateWorldMatrix(true, true);
  for (const entry of entries) {
    const { marker, target } = entry;
    const available = !!target.parent;
    marker.visible = available;
    if (!available) continue;

    target.getWorldPosition(bodyPartMarkerWorldPos);
    marker.position.copy(bodyPartMarkerWorldPos);
    currentModel.worldToLocal(marker.position);
  }
}

function createBodyPartLabel(text, color) {
  const div = document.createElement("div");
  div.textContent = text;
  div.style.color = color;
  div.style.fontSize = "11px";
  div.style.fontWeight = "bold";
  div.style.fontFamily = "monospace";
  div.style.padding = "1px 4px";
  div.style.border = `1px solid ${color}`;
  div.style.borderRadius = "4px";
  div.style.background = "rgba(0, 0, 0, 0.68)";
  div.style.whiteSpace = "nowrap";
  div.style.textShadow = "0 1px 2px #000";
  const label = new CSS2DObject(div);
  label.userData.isBodyPartMarker = true;
  return label;
}

function normalizeObjectName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function resolveBodyPartAnchor(model, aliases, usedTargets) {
  let best = null;
  let bestScore = -Infinity;
  const normalizedAliases = aliases.map(normalizeObjectName);
  model.traverse((object) => {
    if (object.userData?.isBodyPartMarkers || object.userData?.isBodyPartMarker) {
      return;
    }
    if (usedTargets.has(object)) return;
    const objectName = normalizeObjectName(object.name);
    if (!normalizedAliases.includes(objectName)) return;

    const score = scoreBodyPartAnchor(object);
    if (score > bestScore) {
      best = object;
      bestScore = score;
    }
  });
  return best;
}

function scoreBodyPartAnchor(object) {
  let score = object.isBone ? 100 : 0;
  let cur = object;
  while (cur) {
    const partName = String(cur.userData?.skinnedPartName || "").toLowerCase();
    if (partName === "body") score += 50;
    else if (partName.includes("body")) score += 25;
    else if (partName.includes("weapon") || partName.includes("prop")) score -= 20;
    cur = cur.parent;
  }
  return score;
}
