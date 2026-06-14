import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { toonVertSrc, toonFragSrc } from "./shaders/toon.js";
import { makeUniformsObj } from "./uniforms.js";
import { loadCharacterIndex, loadCharacter, pickDefaultAnimationClip } from "./loader.js";
import {
  listModelParts,
  resetModelPartVisibilityOverrides,
  setModelPartVisibility,
  toggleAxes,
  toggleGrid,
  toggleBodyPartMarkers
} from "./scene.js";

let sceneRef, controlsRef, cameraRef, clearSceneFn, setModelFn;
let animationStateRef = null;
let modelPartsRenderToken = 0;
let isCharacterIndexLoading = false;
let isCharacterLoading = false;
let loadStatusVariantIndex = 0;
const LOAD_STATUS_VARIANTS = [
  "loader-scan",
  "loader-rain",
  "loader-pulse",
  "loader-sparkle",
  "loader-cascade",
  "loader-waverows",
  "loader-columns",
  "loader-helix",
  "loader-diagswipe",
  "loader-checkerboard"
];

export function initControls(scene, controls, camera, clearScene, setModel) {
  sceneRef = scene;
  controlsRef = controls;
  cameraRef = camera;
  clearSceneFn = clearScene;
  setModelFn = setModel;

  setupDragDrop();
  setupUIBindings();
  setupCharacterLoader();
  initializeCharacterIndex();
}

function setupCharacterLoader() {
  const sel = document.getElementById("charSelect");
  if (sel) sel.addEventListener("change", updateCharacterLoadControls);

  const btn = document.getElementById("btnLoadChar");
  if (btn)
    btn.addEventListener("click", async () => {
      if (!sel?.value || isCharacterIndexLoading || isCharacterLoading) return;

      const charId = sel.value;
      setCharacterLoading(true, `Loading ${charId}...`);
      try {
        const model = await loadCharacter(
          charId,
          sceneRef,
          controlsRef,
          cameraRef,
          clearSceneFn
        );
        if (model) {
          setModelFn(model);
          setAnimationState(model.userData?.animationState || null);
          syncMouthTileControl(model);
          applyUIState();
          renderModelPartsPanel();
        }
        setLoadStatus(model ? "" : "Load failed", !model);
      } catch (err) {
        console.warn(`Character load failed for ${charId}:`, err);
        setLoadStatus(`Failed to load ${charId}`, true);
      } finally {
        setCharacterLoading(false);
      }
    });
}

async function initializeCharacterIndex() {
  isCharacterIndexLoading = true;
  updateCharacterLoadControls();
  setLoadStatus("Loading character list...", false, true);
  try {
    await loadCharacterIndex();
    setLoadStatus("");
  } catch (err) {
    console.warn("Character index failed:", err);
    setLoadStatus("Character list failed to load", true);
  } finally {
    isCharacterIndexLoading = false;
    updateCharacterLoadControls();
  }
}

function setCharacterLoading(loading, message = "") {
  isCharacterLoading = loading;
  updateCharacterLoadControls();
  if (message) setLoadStatus(message, false, loading);
}

function updateCharacterLoadControls() {
  const sel = document.getElementById("charSelect");
  const btn = document.getElementById("btnLoadChar");
  const busy = isCharacterIndexLoading || isCharacterLoading;
  if (sel) sel.disabled = busy;
  if (!btn) return;

  btn.disabled = busy || !sel?.value;
  btn.classList.toggle("is-loading", isCharacterLoading);
  btn.textContent = isCharacterLoading ? "Loading..." : "Load Character";
  btn.setAttribute("aria-busy", isCharacterLoading ? "true" : "false");
}

function setLoadStatus(message, isError = false, isLoading = false) {
  const status = document.getElementById("loadStatus");
  if (!status) return;
  status.textContent = isLoading ? "" : message || "";
  if (isLoading && message) status.setAttribute("aria-label", message);
  else status.removeAttribute("aria-label");
  status.classList.toggle("is-error", !!isError);
  status.classList.toggle("is-loading", !!isLoading);
  status.classList.remove(...LOAD_STATUS_VARIANTS);
  if (isLoading) {
    status.classList.add(
      LOAD_STATUS_VARIANTS[
        loadStatusVariantIndex++ % LOAD_STATUS_VARIANTS.length
      ]
    );
  }
}

// ── Drag & Drop ──
function setupDragDrop() {
  document.body.addEventListener("dragover", (e) => e.preventDefault());
  document.body.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    const url = URL.createObjectURL(file);
    if (ext === "fbx")
      new FBXLoader().load(url, (obj) => processDroppedModel(obj));
    else if (ext === "glb" || ext === "gltf")
      new GLTFLoader().load(url, (gltf) => processDroppedModel(gltf.scene));
  });
}

function processDroppedModel(object) {
  clearSceneFn();
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = 2.0 / maxDim;
  object.scale.multiplyScalar(scale);
  box.setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);
  object.position.y += size.y * scale * 0.5;
  object.traverse((child) => {
    if (!child.isMesh) return;
    const uniforms = makeUniformsObj();
    if (child.material && child.material.map) {
      uniforms.u_MainTex.value = child.material.map;
      uniforms.u_HasMainTex.value = true;
    }
    child.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: toonVertSrc,
      fragmentShader: toonFragSrc,
      side: THREE.DoubleSide
    });
  });
  sceneRef.add(object);
  setModelFn(object);
  setAnimationState(null);
  syncMouthTileControl(object);
  applyUIState();
  renderModelPartsPanel();
  controlsRef.target.set(0, size.y * scale * 0.45, 0);
  cameraRef.position.set(0, size.y * scale * 0.45, 3.5);
  controlsRef.update();
}

// ── UI Bindings ──
function setupUIBindings() {
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    let valSpan = el.parentElement.querySelector(".val");
    if (!valSpan && el.type === "range") {
      valSpan = document.createElement("span");
      valSpan.className = "val";
      valSpan.textContent = el.value;
      el.parentElement.appendChild(valSpan);
    }
    el.addEventListener("input", () => {
      if (valSpan) valSpan.textContent = el.value;
      fn(el);
    });
  };

  bind("lightX", () => updateLightDir());
  bind("lightY", () => updateLightDir());
  bind("lightZ", () => updateLightDir());
  bind("shadowStep", (el) => {
    const v = parseFloat(el.value);
    setAllToon("u_ShadowThreshold", v);
    setAllToon("u_ShadowThreshold4", new THREE.Vector4(v, v, v, v));
  });
  bind("shadowSmooth", () => {});
  // Shadow-bias slider kept for legacy; the rewritten shader no longer needs
  // a global -0.5 fudge because the body VS now provides SH ambient and the
  // lit per-vertex colour. The bias still adjusts u_ShadowThreshold so users
  // can fine-tune per-character look without editing material JSON.
  bind("shadowBias", (el) => {
    const v = parseFloat(el.value);
    setAllToon("u_ShadowThresholdBias", v);
    // Push the bias into the live threshold uniform too, so existing UI still
    // shifts the shadow edge (DXBC threshold = _ShadowThreshold; we add the
    // user bias on top here so the slider still has effect.)
    if (sceneRef) {
      sceneRef.traverse((child) => {
        if (!child.isMesh) return;
        forEachMaterial(child.material, (material) => {
          const u = material.uniforms?.u_ShadowThreshold;
          if (!u) return;
          if (material.userData.__baseShadowThreshold == null) {
            material.userData.__baseShadowThreshold = u.value;
          }
          u.value = material.userData.__baseShadowThreshold + v;
        });
      });
    }
  });
  bind("outlineWidth", (el) =>
    setAllOutline("u_OutlineThickness", parseFloat(el.value))
  );
  bind("outlineColor", (el) => {
    const c = new THREE.Color(el.value);
    setAllOutline("u_OutlineTint", new THREE.Vector4(c.r, c.g, c.b, 1));
  });
  bind("ditherFade", (el) =>
    setAllToon("u_DitherThreshold", 1.0 - parseFloat(el.value))
  );
  bind("mouthTile", (el) => {
    const idx = parseInt(el.value);
    sceneRef.traverse((child) => {
      if (!child.isMesh) return;
      forEachMaterial(child.material, (material) => {
        if (!material.userData?.mouthTiles) return;
        const tiles = material.userData.mouthTiles;
        const tile = tiles[idx] || tiles[0];
        if (tile) {
          material.uniforms.u_MouthTileTex.value = tile;
          material.uniforms.u_HasMouthTileTex.value = true;
          material.userData.currentMouthTileIndex = idx;
          material.userData.currentMouthTileCode = null;
        }
      });
    });
  });
  bind("animationSpeed", (el) => {
    if (animationStateRef) animationStateRef.setSpeed(parseFloat(el.value));
  });

  const animationSelect = document.getElementById("animationSelect");
  if (animationSelect)
    animationSelect.addEventListener("change", () => {
      if (animationStateRef && animationSelect.value)
        animationStateRef
          .playClip(animationSelect.value)
          .then(() => renderModelPartsPanel())
          .catch((err) =>
            console.warn("Animation switch failed:", err)
          );
    });

  setupTimeline();

  const showAxesEl = document.getElementById("showAxes");
  if (showAxesEl)
    showAxesEl.addEventListener("change", () =>
      toggleAxes(showAxesEl.checked)
    );

  const showGridEl = document.getElementById("showGrid");
  if (showGridEl)
    showGridEl.addEventListener("change", () =>
      toggleGrid(showGridEl.checked)
    );

  const showBodyPartsEl = document.getElementById("showBodyParts");
  if (showBodyPartsEl)
    showBodyPartsEl.addEventListener("change", () =>
      toggleBodyPartMarkers(showBodyPartsEl.checked)
    );

  const modelPartsReset = document.getElementById("modelPartsReset");
  if (modelPartsReset)
    modelPartsReset.addEventListener("click", () => {
      resetModelPartVisibilityOverrides();
      renderModelPartsPanel();
    });

  const enableMainLightEl = document.getElementById("enableMainLight");
  if (enableMainLightEl) {
    enableMainLightEl.checked = false;
    enableMainLightEl.addEventListener("change", () => {
      setMainLightEnabled(enableMainLightEl.checked);
    });
  }

  setRimEnabled(false);
}

// Timeline
let timelineScrubbing = false;
let timelineWasPlaying = false;

function setupTimeline() {
  const track = document.getElementById("timelineTrack");
  const playBtn = document.getElementById("timelinePlay");
  if (!track || !playBtn) return;

  playBtn.addEventListener("click", () => {
    if (!animationStateRef) return;
    const next = !animationStateRef.playing;
    animationStateRef.setPlaying(next);
    updateMouthTileControlState();
    syncTimelinePlayButton();
  });

  const ratioFromEvent = (ev) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return 0;
    const x = ev.clientX - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  };

  const seekToEvent = (ev) => {
    if (!animationStateRef) return;
    const duration = animationStateRef.getDuration?.() || 0;
    if (!duration) return;
    animationStateRef.seek(ratioFromEvent(ev) * duration);
    updateTimelineUI();
  };

  track.addEventListener("pointerdown", (ev) => {
    if (!animationStateRef || !(animationStateRef.getDuration?.() > 0)) return;
    timelineScrubbing = true;
    timelineWasPlaying = animationStateRef.playing;
    // Pause while dragging so the playhead follows the cursor cleanly.
    if (timelineWasPlaying) animationStateRef.setPlaying(false);
    track.classList.add("scrubbing");
    track.setPointerCapture?.(ev.pointerId);
    seekToEvent(ev);
  });

  track.addEventListener("pointermove", (ev) => {
    if (timelineScrubbing) seekToEvent(ev);
  });

  const endScrub = (ev) => {
    if (!timelineScrubbing) return;
    timelineScrubbing = false;
    track.classList.remove("scrubbing");
    track.releasePointerCapture?.(ev.pointerId);
    if (timelineWasPlaying && animationStateRef) {
      animationStateRef.setPlaying(true);
    }
    syncTimelinePlayButton();
  };
  track.addEventListener("pointerup", endScrub);
  track.addEventListener("pointercancel", endScrub);

  // Independent rAF loop keeps the playhead in sync with the render loop
  // without creating a circular import between scene.js and controls.js.
  const tick = () => {
    requestAnimationFrame(tick);
    updateTimelineUI();
  };
  requestAnimationFrame(tick);
}

function syncTimelinePlayButton() {
  const playBtn = document.getElementById("timelinePlay");
  if (!playBtn) return;
  const playing = !!animationStateRef?.playing;
  playBtn.textContent = playing ? "❚❚" : "▶";
  playBtn.title = playing ? "Pause" : "Play";
}

function fmtTime(t) {
  return (Number.isFinite(t) ? t : 0).toFixed(2);
}

// Called every frame to advance the playhead/time label.
function updateTimelineUI() {
  const timeline = document.getElementById("timeline");
  if (!timeline || timeline.hidden) return;
  const state = animationStateRef;
  const duration = state?.getDuration?.() || 0;
  const time = state?.getTime?.() || 0;
  const ratio = duration > 0 ? Math.max(0, Math.min(1, time / duration)) : 0;
  const pct = (ratio * 100).toFixed(2) + "%";

  const fill = timeline.querySelector(".track-fill");
  const thumb = timeline.querySelector(".track-thumb");
  const label = document.getElementById("timelineTime");
  if (fill) fill.style.width = pct;
  if (thumb) thumb.style.left = pct;
  if (label) label.textContent = `${fmtTime(time)} / ${fmtTime(duration)}s`;
}

function setAnimationState(state) {
  animationStateRef = state;
  const select = document.getElementById("animationSelect");
  const speed = document.getElementById("animationSpeed");
  const timeline = document.getElementById("timeline");
  if (!select) return;

  select.innerHTML = '<option value="">None</option>';
  if (!state || !state.clipNames?.length) {
    select.disabled = true;
    if (speed) speed.disabled = true;
    if (timeline) timeline.hidden = true;
    updateMouthTileControlState();
    return;
  }

  if (timeline) timeline.hidden = false;
  syncTimelinePlayButton();

  select.disabled = false;
  if (speed) {
    speed.disabled = false;
    speed.value = String(state.speed);
  }

  for (const clipName of state.clipNames) {
    const option = document.createElement("option");
    option.value = clipName;
    option.textContent = clipName.replace(/^CH\d+_/, "");
    select.appendChild(option);
  }
  const preferred =
    state.activeClip ||
    pickDefaultAnimationClip(state.clipNames);
  select.value = preferred;
  state
    .playClip(preferred)
    .then(() => renderModelPartsPanel())
    .catch((err) =>
      console.warn("Initial animation failed:", err)
    );
  updateMouthTileControlState();
}

function renderModelPartsPanel() {
  const panel = document.getElementById("modelPartsPanel");
  const list = document.getElementById("modelPartsList");
  if (!panel || !list) return;

  const token = ++modelPartsRenderToken;
  const parts = listModelParts();
  panel.hidden = parts.length === 0;
  list.replaceChildren();
  if (!parts.length) return;

  for (const part of parts) {
    list.appendChild(createModelPartRow(part, token, false));
    for (const child of part.children || []) {
      list.appendChild(createModelPartRow(child, token, true));
    }
  }
}

function createModelPartRow(part, token, child) {
  const row = document.createElement("label");
  row.className = child ? "part-row part-child-row" : "part-row";
  if (part.forced !== null) row.classList.add("is-forced");
  if (!part.loaded) row.classList.add("is-deferred");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = part.visible;
  input.dataset.partId = part.id;
  input.addEventListener("change", async () => {
    const wanted = input.checked;
    input.disabled = true;
    row.classList.add("is-loading");
    try {
      await setModelPartVisibility(part.id, wanted);
    } catch (err) {
      console.warn(`Part visibility failed for ${part.id}:`, err);
    } finally {
      if (token === modelPartsRenderToken) {
        renderModelPartsPanel();
      }
    }
  });

  const name = document.createElement("span");
  name.className = "part-name";
  name.textContent = part.label;

  const meta = document.createElement("span");
  meta.className = "part-meta";
  if (!part.loaded) meta.textContent = "lazy";
  else if (part.forced !== null) meta.textContent = "forced";
  else if (!child) meta.textContent = String(part.children?.length || part.meshCount || part.targetCount || "");
  else meta.textContent = "";

  row.append(input, name, meta);
  return row;
}

function syncMouthTileControl(model) {
  const input = document.getElementById("mouthTile");
  if (!input) return;

  let defaultIndex = null;
  let maxIndex = 0;
  model?.traverse((child) => {
    if (!child.isMesh) return;
    forEachMaterial(child.material, (material) => {
      const tiles = material.userData?.mouthTiles;
      if (!tiles?.length) return;
      maxIndex = Math.max(maxIndex, tiles.length - 1);
      if (
        defaultIndex == null &&
        Number.isInteger(material.userData.defaultMouthTileIndex)
      ) {
        defaultIndex = material.userData.defaultMouthTileIndex;
      }
    });
  });

  input.max = String(maxIndex);
  if (defaultIndex != null) input.value = String(defaultIndex);
  const valSpan = input.parentElement?.querySelector(".val");
  if (valSpan) valSpan.textContent = input.value;
  updateMouthTileControlState();
}

function updateMouthTileControlState() {
  const input = document.getElementById("mouthTile");
  if (!input) return;

  const animationControlsMouth = !!(
    animationStateRef?.clipNames?.length &&
    animationStateRef.playing
  );
  input.disabled = animationControlsMouth;
  input.title = animationControlsMouth
    ? "Mouth tile is locked while animation playback is enabled"
    : "";
}

function applyUIState() {
  const shadowBiasEl = document.getElementById("shadowBias");
  if (shadowBiasEl) {
    shadowBiasEl.dispatchEvent(new Event("input"));
  }

  // Push the current Light X/Y/Z slider state into the freshly built
  // materials so a newly loaded model immediately picks up the user's
  // tuned light direction instead of falling back to DEFAULT_UNIFORMS.
  if (
    document.getElementById("lightX") &&
    document.getElementById("lightY") &&
    document.getElementById("lightZ")
  ) {
    updateLightDir();
  }

  const enableMainLightEl = document.getElementById("enableMainLight");
  if (enableMainLightEl) {
    enableMainLightEl.checked = false;
    setMainLightEnabled(false);
  } else {
    setMainLightEnabled(false);
  }

  setRimEnabled(false);
}

function forEachMaterial(material, fn) {
  if (Array.isArray(material)) {
    for (const item of material) forEachMaterial(item, fn);
    return;
  }
  if (material) fn(material);
}

function updateLightDir() {
  const lightX = document.getElementById("lightX");
  const lightY = document.getElementById("lightY");
  const lightZ = document.getElementById("lightZ");
  if (!lightX || !lightY || !lightZ) return;
  const x = parseFloat(lightX.value);
  const y = parseFloat(lightY.value);
  const z = parseFloat(lightZ.value);
  setAllToon("u_MxCharLightDir", new THREE.Vector3(x, y, z).normalize());
}

function setAllToon(name, value) {
  sceneRef.traverse((child) => {
    if (!child.isMesh) return;
    forEachMaterial(child.material, (material) => {
      if (material.uniforms?.[name]) material.uniforms[name].value = value;
    });
  });
}

function setAllOutline(name, value) {
  sceneRef.traverse((child) => {
    if (!child.isMesh) return;
    forEachMaterial(child.material, (material) => {
      if (material.side === THREE.BackSide && material.uniforms?.[name])
        material.uniforms[name].value = value;
    });
  });
}

function setMainLightEnabled(enabled) {
  if (!sceneRef) return;
  setAllToon("u_MainLightEnabled", !!enabled);
  setAllToon("u_ShadowOnlyEnabled", !enabled);
}

function setRimEnabled(_enabled) {
  if (!sceneRef) return;
  setAllToon("u_RimStrength", 0.0);
  setAllToon("u_RimAreaMultiplier", 0.0);
  setAllToon("u_RimLightRange", 0.0);
}
