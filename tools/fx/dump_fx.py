"""Dump FX assets (textures + materials + particle systems) for inspection.

Discovery dump for a character. Output layout::

  extracted_models/<CHAR>/fx/
    index.json                         — per-char index (schema_version 3)
    prefabs/<PrefabName>.json          — descendants tree with local transforms
    textures/<TexName>.png             — referenced Texture2Ds; name-collided
        variants get a `__<W>x<H>` (and, if still ambiguous, `__<pidtag>`) suffix
    materials/<MatName>.json           — Material saved properties
    particles/<RootPrefab>__<GoName>.json — ParticleSystem config

Schema highlights (truth-derived from Unity bundles):
  - Texture references (index.json.textures[] and each material's
    textures[slot]) carry the resolved Texture2D `path_id` + `size`. BA fx
    reuses one m_Name across differently-sized textures (e.g. FX_TEX_Color_01
    is both a 128x16 gray ramp and a 64x64 yellow), so name is NOT a unique key;
    the viewer resolves by path_id and falls back to name for older (v2) dumps.
  - Each prefab dump records `CharacterAnimationEventEffect` fields when present:
    `parent_index` (index into AnimationEventReceiverWithBones.fxParentBones),
    `timer_duration` (auto-destroy timeout, seconds), `life_mode`.
  - `index.json.fx_parent_bones` lists the resolved bone names per index from
    the character's AnimationEventReceiverWithBones (typically 10 entries:
    bone_root / Bip001 Pelvis / Bip001 Head / ...).
  - Each prefab descendant has `local_transform { position, rotation, scale }`
    plus `parent_path_id` so the runtime can rebuild the GO hierarchy.
  - JSON output is finite-only (Infinity/NaN stand-ins emitted as 1e308/0)
    so JSON.parse / json.load consumers don't choke.

Usage::

    python tools/fx/dump_fx.py CH0057                     # full char dump
    python tools/fx/dump_fx.py CH0057 --emotion           # keyword shortcut
    python tools/fx/dump_fx.py CH0057 --prefab FX_..._01  # exact prefab subtree
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import UnityPy

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))

from bundle_resolver import (
    find_character_bundles,
    find_common_dependency_candidates,
    resolve_dependency_closure,
)
from export_halo_mesh import obj_to_trimesh


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ASSETBUNDLES = Path(
    r"D:\BAJP\YostarGames\BlueArchive_JP\BlueArchive_Data\StreamingAssets\AssetBundles"
)
DEFAULT_OUTPUT_ROOT = ROOT / "extracted_models"
CAB_INDEX_FILE = ROOT / "cab_index.json"

SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
# Stand-ins used to keep JSON output spec-compliant (no bare Infinity/NaN).
_BIG_FLOAT = 1e308


def safe_name(s: str) -> str:
    return SAFE_NAME_RE.sub("_", s).strip("_") or "unnamed"


def _finite(value):
    """Recursively replace non-finite floats with finite stand-ins.

    Unity ParticleSystem dumps occasionally encode `+Infinity` / `-Infinity` /
    `NaN` (e.g. `_CameraFadeParams.g`, curve `m_PreInfinity` slope) which
    Python's json emits as bare `Infinity` tokens — those are not valid JSON
    and break browser/strict parsers. We don't sample curves yet so the
    sentinel value doesn't matter; just keep them finite.
    """
    if isinstance(value, float):
        if math.isnan(value):
            return 0.0
        if math.isinf(value):
            return _BIG_FLOAT if value > 0 else -_BIG_FLOAT
        return value
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_finite(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_finite(v) for v in value)
    return value


def _write_json(path: Path, data) -> None:
    path.write_text(
        json.dumps(_finite(data), indent=2, ensure_ascii=False, allow_nan=False, default=str),
        encoding="utf-8",
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Dump FX textures/materials/particles for a character.")
    p.add_argument("char_id")
    p.add_argument("--assetbundles", type=Path, default=DEFAULT_ASSETBUNDLES)
    p.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    p.add_argument(
        "--filter",
        default=None,
        help="Optional substring filter on prefab/particle/material names (case-insensitive).",
    )
    p.add_argument(
        "--emotion",
        action="store_true",
        help="Shortcut: keep only emotion-related assets (blush/shy/heart/rage/shout/tear/sweat/notice).",
    )
    p.add_argument(
        "--prefab",
        action="append",
        default=None,
        metavar="NAME",
        help="Walk transform tree from this prefab root and dump only assets it references. "
             "Can be repeated. Example: --prefab FX_Hina_Original_Ex01_Motion_Cam_Emotion",
    )
    p.add_argument(
        "--from-anim-events",
        action="store_true",
        help="Auto-discover FX prefabs from AnimationClip events (InstantiateFx / "
             "AniEvt_InstantiateFx). Writes fx/anim_events.json and dumps every "
             "referenced prefab.",
    )
    p.add_argument(
        "--no-deps",
        action="store_true",
        help="Skip dependency closure (faster, but particle materials/textures will be missing).",
    )
    p.add_argument(
        "--all-textures",
        action="store_true",
        help="Dump every Texture2D in the loaded set, not just ones reachable from materials.",
    )
    p.add_argument(
        "--scope",
        choices=("char", "all"),
        default="char",
        help="'char' (default) restricts material/texture dump to assets reachable from a "
             "renderer in the character's bundles. 'all' dumps everything in the loaded env.",
    )
    return p.parse_args()


def transform_chain(transform) -> list[str]:
    chain: list[str] = []
    cur = transform
    seen: set[int] = set()
    while cur is not None:
        pid = getattr(cur, "path_id", None)
        if pid in seen:
            break
        if pid is not None:
            seen.add(pid)
        try:
            go = cur.m_GameObject.read()
            chain.append(str(go.m_Name))
            father = cur.m_Father
            cur = father.read() if getattr(father, "path_id", 0) else None
        except Exception:
            break
    return chain


def get_transform(go):
    components = getattr(go, "m_Components", None) or getattr(go, "m_Component", []) or []
    for pair in components:
        comp = None
        try:
            comp = pair.component.read()
        except Exception:
            try:
                comp = pair.read()
            except Exception:
                continue
        if comp is None:
            continue
        if comp.__class__.__name__ in ("Transform", "RectTransform"):
            return comp
    return None


def collect_descendants(env, prefab_names: list[str]) -> set[int]:
    """Walk transform trees from each named prefab root, return path_ids of all GOs visited."""
    wanted = {n.lower() for n in prefab_names}
    found_pids: set[int] = set()
    roots = []  # list of root Transform objects
    for obj in env.objects:
        if obj.type.name != "GameObject":
            continue
        try:
            go = obj.read()
            if str(go.m_Name).lower() not in wanted:
                continue
            t = get_transform(go)
            if t is not None:
                roots.append((go, getattr(obj, "path_id", None), t))
        except Exception:
            continue

    def walk(t):
        if t is None:
            return
        try:
            go_pptr = getattr(t, "m_GameObject", None)
            go_pid = getattr(go_pptr, "path_id", None) if go_pptr is not None else None
            if go_pid is None or go_pid in found_pids:
                return
            found_pids.add(go_pid)
            for child_ptr in getattr(t, "m_Children", []) or []:
                if not getattr(child_ptr, "path_id", 0):
                    continue
                try:
                    child_t = child_ptr.read()
                except Exception:
                    continue
                walk(child_t)
        except Exception:
            return

    for _go, _go_pid, t in roots:
        walk(t)
    return found_pids


def collect_prefab_assets(env, prefab_names: list[str]) -> tuple[set[int], set[int]]:
    """From all renderers under named prefab roots, collect material + mesh path_ids."""
    descendant_pids = collect_descendants(env, prefab_names)
    if not descendant_pids:
        return set(), set()

    mat_pids: set[int] = set()
    mesh_pids: set[int] = set()
    for obj in env.objects:
        if obj.type.name not in (
            "MeshRenderer",
            "SkinnedMeshRenderer",
            "ParticleSystemRenderer",
        ):
            continue
        try:
            d = obj.read()
            owner_pid = getattr(d.m_GameObject, "path_id", None)
        except Exception:
            continue
        if owner_pid not in descendant_pids:
            continue
        for mat_ref in getattr(d, "m_Materials", []) or []:
            pid = getattr(mat_ref, "path_id", None)
            if pid:
                mat_pids.add(pid)
        mesh_ref = getattr(d, "m_Mesh", None)
        if mesh_ref is not None:
            pid = getattr(mesh_ref, "path_id", None)
            if pid:
                mesh_pids.add(pid)
    return mat_pids, mesh_pids


def _pair_items(items):
    for entry in items or []:
        if isinstance(entry, dict):
            yield entry.get("first"), entry.get("second")
        else:
            yield entry[0], entry[1]


def _vec3(v) -> dict | None:
    if v is None:
        return None
    return {
        "x": float(getattr(v, "x", 0.0) or 0.0),
        "y": float(getattr(v, "y", 0.0) or 0.0),
        "z": float(getattr(v, "z", 0.0) or 0.0),
    }


def _quat(q) -> dict | None:
    if q is None:
        return None
    return {
        "x": float(getattr(q, "x", 0.0) or 0.0),
        "y": float(getattr(q, "y", 0.0) or 0.0),
        "z": float(getattr(q, "z", 0.0) or 0.0),
        "w": float(getattr(q, "w", 1.0) or 1.0),
    }


def _read_class_name(monobehaviour) -> str | None:
    """Resolve the script class name for a MonoBehaviour env object.

    UnityPy's env wrappers expose attributes lazily, so we cannot rely on
    `hasattr`. Always go through `.read()` (idempotent on already-read
    payloads via the type-tree contract) and then dereference m_Script.
    """
    target = monobehaviour
    try:
        if hasattr(target, "type") and hasattr(target, "read"):
            target = target.read()
    except Exception:
        return None
    try:
        script = getattr(target, "m_Script", None)
        if script is None:
            return None
        return str(script.read().m_ClassName)
    except Exception:
        return None


def _resolve_fx_parent_bones(tt, by_pid) -> list[dict]:
    """Resolve one receiver's fxParentBones PPtr list to {index, name, pid}."""
    bones: list[dict] = []
    for i, b in enumerate(tt.get("fxParentBones") or []):
        t_pid = b.get("m_PathID") if isinstance(b, dict) else None
        bone_name: str | None = None
        if t_pid:
            t_obj = by_pid.get(t_pid)
            if t_obj is not None:
                try:
                    t = t_obj.read()
                    go_pptr = getattr(t, "m_GameObject", None)
                    go_pid = getattr(go_pptr, "path_id", None) if go_pptr else None
                    go_obj = by_pid.get(go_pid) if go_pid else None
                    if go_obj is not None:
                        bone_name = str(go_obj.read().m_Name)
                except Exception:
                    pass
        bones.append({"index": i, "name": bone_name, "transform_path_id": t_pid or 0})
    return bones


def collect_fx_parent_bones(env, by_pid, char_id: str | None = None) -> list[dict]:
    """Resolve an AnimationEventReceiverWithBones.fxParentBones list to bone names.

    The dependency closure for one character pulls in FOREIGN animators (boss
    objects like Labor_Decagram_Guard_1, other chars' rigs) whose receivers
    carry a SPARSE fxParentBones list — only bone_root + fire_01 resolve, every
    other slot (incl. index 2 = Bip001 Head) is null. First-hit-wins would pick
    one of those foreign receivers and ship a broken bone map, sending every
    parent_index>0 FX spawn to the character origin instead of its real bone.

    Fix: prefer the receiver owned by THIS character's own animator GO
    (CH#### / Cafe_/Strategy_/Battle/Echelon_<char> naming), and among all
    candidates pick the one resolving the MOST bones. char_id scopes the owner
    match; when omitted we still fall back to the densest list available.
    """
    char_up = (char_id or "").upper()
    best: list[dict] | None = None
    best_score = (-1, -1)  # (owner_matches_char, resolved_bone_count)

    # Both receiver classes carry the same fxParentBones field. Newer rigs use
    # AnimationEventReceiverWithBones; older ones (e.g. CH0145) use
    # CharacterAnimationEventReceiver. Accept both or the bone map comes back
    # empty and every parent_index>0 FX spawns at the character origin.
    receiver_classes = {
        "AnimationEventReceiverWithBones",
        "CharacterAnimationEventReceiver",
    }
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        if _read_class_name(obj) not in receiver_classes:
            continue
        try:
            tt = obj.read_typetree()
        except Exception:
            continue
        bones = _resolve_fx_parent_bones(tt, by_pid)
        if not bones:
            continue

        owner_name = ""
        try:
            owner_name = str(obj.read().m_GameObject.read().m_Name)
        except Exception:
            pass
        owner_matches = 1 if (char_up and char_up in owner_name.upper()) else 0
        resolved = sum(1 for b in bones if b.get("name"))
        score = (owner_matches, resolved)
        if score > best_score:
            best_score = score
            best = bones

    return best or []


def collect_prefab_attach_info(env, prefab_name: str) -> dict | None:
    """Extract CharacterAnimationEventEffect fields from the prefab root GO.

    Truth (from BAJP): every FX prefab destined to be spawned by an
    AnimationEvent carries this MonoBehaviour at its root with three fields
    we care about:
      - LifeMode (int): 1 = bounded by TimerTypeDuration; other values are
        looped or manually destroyed in-game and are passed through as-is.
      - TimerTypeDuration (float seconds): how long the prefab stays alive
        before automatic destroy. 9999.0 is used as "permanent".
      - ParentIndex (int): index into AnimationEventReceiverWithBones
        .fxParentBones on the animator. THIS overrides the AnimationEvent
        int_param convention. 0 = bone_root (~animator root), 2 = Bip001 Head.
    """
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        if _read_class_name(obj) != "CharacterAnimationEventEffect":
            continue
        try:
            d = obj.read()
            owner_name = str(d.m_GameObject.read().m_Name)
        except Exception:
            continue
        if owner_name != prefab_name:
            continue
        try:
            tt = obj.read_typetree()
        except Exception:
            continue
        return {
            "parent_index": tt.get("ParentIndex"),
            "timer_duration": tt.get("TimerTypeDuration"),
            "life_mode": tt.get("LifeMode"),
        }
    return None


def _gameobject_components(go) -> list[str]:
    out: list[str] = []
    for cp in getattr(go, "m_Components", None) or getattr(go, "m_Component", None) or []:
        try:
            ref = getattr(cp, "component", None) or cp
            comp = ref.read()
        except Exception:
            continue
        cls = comp.__class__.__name__
        if cls == "MonoBehaviour":
            sn = _read_class_name(ref) if hasattr(ref, "read") else None
            out.append(f"MB:{sn}" if sn else "MB:?")
        else:
            out.append(cls)
    return out


def dump_prefab_tree(env, by_pid, prefab_name: str) -> dict | None:
    """Walk the transform tree from a prefab root and capture the descendant
    hierarchy with local transforms + parent path_ids so the runtime can
    rebuild parent/child structure on the JS side.
    """
    root_t = None
    for obj in env.objects:
        if obj.type.name != "GameObject":
            continue
        try:
            go = obj.read()
            if str(go.m_Name) != prefab_name:
                continue
            t = get_transform(go)
            if t is not None:
                root_t = t
                break
        except Exception:
            continue
    if root_t is None:
        return None

    descendants: list[dict] = []
    seen: set[int] = set()

    def walk(t, parent_path_id):
        try:
            go_pptr = getattr(t, "m_GameObject", None)
            go_pid = getattr(go_pptr, "path_id", None) if go_pptr else None
            if go_pid is None or go_pid in seen:
                return
            seen.add(go_pid)
            go_obj = by_pid.get(go_pid)
            go = go_obj.read() if go_obj else None
            descendants.append({
                "go_name": str(go.m_Name) if go else "",
                "path_id": go_pid,
                "parent_path_id": parent_path_id,
                "local_transform": {
                    "position": _vec3(getattr(t, "m_LocalPosition", None)),
                    "rotation": _quat(getattr(t, "m_LocalRotation", None)),
                    "scale": _vec3(getattr(t, "m_LocalScale", None)),
                },
                "components": _gameobject_components(go) if go else [],
            })
            for child_ptr in getattr(t, "m_Children", []) or []:
                if not getattr(child_ptr, "path_id", 0):
                    continue
                try:
                    child_t = child_ptr.read()
                except Exception:
                    continue
                walk(child_t, go_pid)
        except Exception:
            return

    walk(root_t, 0)
    return {"name": prefab_name, "descendants": descendants}


def dump_material(env, by_pid, mat_obj, shader_index=None) -> dict:
    try:
        data = mat_obj.read()
        tt = mat_obj.read_typetree()
    except Exception as exc:
        return {"error": str(exc)}

    out = {
        "name": str(data.m_Name),
        "shader": None,
        "floats": {},
        "colors": {},
        "ints": {},
        "textures": {},
    }
    shader_ref = getattr(data, "m_Shader", None)
    if shader_ref is not None and getattr(shader_ref, "path_id", 0):
        # Primary: resolve by path_id against the merged-env shader index.
        # The shader lives in an external bundle, so PPtr.read() is unreliable
        # in a merged env; the path_id lookup is stable and cheap.
        if shader_index is not None:
            out["shader"] = shader_index.get(getattr(shader_ref, "path_id", None))
        # Fallback: direct read (works when shader is in the same source file).
        if not out["shader"]:
            try:
                out["shader"] = str(shader_ref.read().m_ParsedForm.name)
            except Exception:
                try:
                    out["shader"] = str(shader_ref.read().m_Name)
                except Exception:
                    pass

    # Resolve texture slots via the READ material's m_SavedProperties so PPtrs
    # with non-zero m_FileID (external bundle refs) resolve through UnityPy's
    # PPtr.read() chain — mirroring the renderer-materials fix in dump_particle.
    # The typetree's raw m_PathID is per-source-file and unsafe to look up in the
    # merged env's by_pid index. We record the resolved Texture2D's stable
    # path_id + size so the viewer can disambiguate name-collided variants
    # (e.g. FX_TEX_Color_01 ships as both a 128x16 gray ramp and a 64x64 yellow).
    saved = getattr(data, "m_SavedProperties", None)
    tex_envs = getattr(saved, "m_TexEnvs", None) if saved is not None else None
    for first, second in _pair_items(tex_envs or []):
        tex_ptr = getattr(second, "m_Texture", None)
        tex_name, tex_pid, tex_size = None, None, None
        if tex_ptr is not None and getattr(tex_ptr, "path_id", 0):
            tex_pid = getattr(tex_ptr, "path_id", None)
            try:
                td = tex_ptr.read()
                tex_name = str(td.m_Name)
                tex_size = list(td.image.size)
            except Exception:
                pass
        scale = getattr(second, "m_Scale", None)
        offset = getattr(second, "m_Offset", None)
        out["textures"][str(first)] = {
            "name": tex_name,
            "path_id": tex_pid,
            "size": tex_size,
            "scale": [getattr(scale, "x", None), getattr(scale, "y", None)] if scale is not None else None,
            "offset": [getattr(offset, "x", None), getattr(offset, "y", None)] if offset is not None else None,
        }
    # floats/colors/ints are scalar (no name-collision concern), read from the
    # typetree as before.
    props = tt.get("m_SavedProperties") or {}
    for first, second in _pair_items(props.get("m_Floats") or []):
        out["floats"][first] = second
    for first, second in _pair_items(props.get("m_Colors") or []):
        if isinstance(second, dict):
            out["colors"][first] = {k: second.get(k) for k in ("r", "g", "b", "a")}
    for first, second in _pair_items(props.get("m_Ints") or []):
        out["ints"][first] = second
    return out


def dump_particle(env, by_pid, ps_obj) -> dict | None:
    try:
        data = ps_obj.read()
        go = data.m_GameObject.read()
        go_name = str(go.m_Name)
        go_pid = getattr(data.m_GameObject, "path_id", None)
        transform = get_transform(go)
        chain = transform_chain(transform) if transform else [go_name]
        local_transform = None
        if transform is not None:
            local_transform = {
                "position": _vec3(getattr(transform, "m_LocalPosition", None)),
                "rotation": _quat(getattr(transform, "m_LocalRotation", None)),
                "scale": _vec3(getattr(transform, "m_LocalScale", None)),
            }
        tt = ps_obj.read_typetree()
    except Exception:
        return None

    # Find the matching ParticleSystemRenderer to know mesh + material.
    # Cache the GO path_id from the PS PPtr (NOT from the dereferenced
    # GameObject — UnityPy's GameObject wrapper has no .path_id attribute,
    # which previously caused the comparison to crash silently and leave
    # psr_info=None on every particle).
    target_go_pid = data.m_GameObject.path_id
    psr_info = None
    for o in env.objects:
        if o.type.name != "ParticleSystemRenderer":
            continue
        try:
            d = o.read()
            if d.m_GameObject.path_id != target_go_pid:
                continue
            tt2 = o.read_typetree()
        except Exception:
            continue
        mat_names = []
        # Iterate via the read MonoBehaviour's m_Materials attribute so PPtrs
        # with non-zero m_FileID (external bundle references) resolve via
        # UnityPy's PPtr.read() chain. by_pid lookup misses external refs.
        for mat_ref in getattr(d, "m_Materials", []) or []:
            try:
                mat_data = mat_ref.read()
                mat_names.append(str(mat_data.m_Name))
            except Exception:
                pass
        mesh_name = None
        mesh_ref = getattr(d, "m_Mesh", None)
        if mesh_ref is not None:
            try:
                mesh_name = str(mesh_ref.read().m_Name)
            except Exception:
                pass
        psr_info = {
            "enabled": tt2.get("m_Enabled"),
            "render_mode": tt2.get("m_RenderMode"),
            "render_alignment": tt2.get("m_RenderAlignment"),
            "sort_mode": tt2.get("m_SortMode"),
            "materials": mat_names,
            "mesh": mesh_name,
            "min_particle_size": tt2.get("m_MinParticleSize"),
            "max_particle_size": tt2.get("m_MaxParticleSize"),
            "pivot": tt2.get("m_Pivot"),
            "flip": tt2.get("m_Flip"),
            "length_scale": tt2.get("m_LengthScale"),
            "velocity_scale": tt2.get("m_VelocityScale"),
            "camera_velocity_scale": tt2.get("m_CameraVelocityScale"),
            "freeform_stretching": tt2.get("m_FreeformStretching"),
            "rotate_with_stretch_direction": tt2.get("m_RotateWithStretchDirection"),
            "allow_roll": tt2.get("m_AllowRoll"),
            "sorting_fudge": tt2.get("m_SortingFudge"),
            "sorting_order": tt2.get("m_SortingOrder"),
        }
        break

    return {
        "go_name": go_name,
        "go_path_id": go_pid,
        "chain": chain,
        "local_transform": local_transform,
        "looping": tt.get("looping"),
        "prewarm": tt.get("prewarm"),
        "playOnAwake": tt.get("playOnAwake"),
        "lengthInSec": tt.get("lengthInSec"),
        # MainModule startDelay staggers WHEN this system begins relative to
        # prefab activation. It is a sibling of lengthInSec (NOT inside
        # EmissionModule). Dropping it makes every system in a prefab emit at
        # once on the first trigger (e.g. CH0334 Cafe_Reaction fired all 8
        # systems at t=0 instead of staggering to 1.27s / 3.6s / 3.7s).
        "startDelay": tt.get("startDelay"),
        "startDelayMultiplier": tt.get("startDelayMultiplier"),
        "speed": tt.get("speed"),
        "moveWithTransform": tt.get("moveWithTransform"),
        "scalingMode": tt.get("scalingMode"),
        "InitialModule": tt.get("InitialModule"),
        "ShapeModule": tt.get("ShapeModule"),
        "EmissionModule": tt.get("EmissionModule"),
        "ColorModule": tt.get("ColorModule"),
        "CustomDataModule": tt.get("CustomDataModule"),
        "SizeModule": tt.get("SizeModule"),
        "RotationModule": tt.get("RotationModule"),
        "VelocityModule": tt.get("VelocityModule"),
        "UVModule": tt.get("UVModule"),
        "TrailModule": tt.get("TrailModule"),
        "renderer": psr_info,
    }


def export_textures(tex_objs, out_dir: Path) -> dict[int, dict]:
    """Export Texture2Ds with collision-proof filenames, keyed by path_id.

    Multiple Texture2Ds can share an m_Name (e.g. FX_TEX_Color_01 ships as a
    128x16 gray ramp AND a 64x64 solid yellow). Materials reference textures by
    name only, so the OLD code (one PNG per name, skip-if-exists) silently
    dropped every collided variant and the viewer could not tell them apart.

    We disambiguate by path_id (Unity's stable per-asset id):
      - single variant of a name -> clean `{name}.png` (preserves v2 layout)
      - name collision            -> `{name}__{W}x{H}.png`
      - (name,size) also collides -> `{name}__{W}x{H}__{pidtag}.png`
    Always overwrite so stale/renamed PNGs from prior dumps don't linger.

    Returns {path_id: {name, path_id, size, file}}.
    """
    # First pass: read each texture's name + size, group by name to find clashes.
    metas: list[dict] = []
    name_counts: dict[str, int] = {}
    namesize_counts: dict[tuple, int] = {}
    for obj in tex_objs:
        try:
            data = obj.read()
            name = str(data.m_Name)
            if not name:
                continue
            size = list(data.image.size)
        except Exception:
            continue
        pid = getattr(obj, "path_id", None)
        # Capture the Unity-authored wrap mode (TextureWrapMode: 0=Repeat,
        # 1=Clamp, 2=Mirror, 3=MirrorOnce). The viewer needs this to avoid
        # tiling clamp-authored gradient ramps (e.g. FX_TEX_Gra_W_01, the
        # CH0325 head_red blush sweep). Newer textures store per-axis m_WrapU/
        # m_WrapV; older ones only a single m_WrapMode — fall back to it.
        wrap_u, wrap_v = None, None
        ts = getattr(data, "m_TextureSettings", None)
        if ts is not None:
            wrap_u = getattr(ts, "m_WrapU", None)
            wrap_v = getattr(ts, "m_WrapV", None)
            wrap_mode = getattr(ts, "m_WrapMode", None)
            if wrap_u is None:
                wrap_u = wrap_mode
            if wrap_v is None:
                wrap_v = wrap_mode
        metas.append({
            "obj": obj, "data": data, "name": name, "size": size, "path_id": pid,
            "wrap_u": wrap_u, "wrap_v": wrap_v,
        })
        name_counts[name] = name_counts.get(name, 0) + 1
        namesize_counts[(name, tuple(size))] = namesize_counts.get((name, tuple(size)), 0) + 1

    # Second pass: pick filename per variant + write PNG (always overwrite).
    out: dict[int, dict] = {}
    for m in metas:
        name, size, pid = m["name"], m["size"], m["path_id"]
        if name_counts[name] <= 1:
            fname = f"{safe_name(name)}.png"
        elif namesize_counts[(name, tuple(size))] <= 1:
            fname = f"{safe_name(name)}__{size[0]}x{size[1]}.png"
        else:
            pidtag = str(pid).replace("-", "n")
            fname = f"{safe_name(name)}__{size[0]}x{size[1]}__{pidtag}.png"
        out_path = out_dir / fname
        try:
            m["data"].image.save(str(out_path))
        except Exception:
            continue
        out[pid] = {
            "name": name,
            "path_id": pid,
            "size": size,
            "wrap_u": m.get("wrap_u"),
            "wrap_v": m.get("wrap_v"),
            "file": f"textures/{out_path.name}",
        }
    return out


def export_particle_renderer_meshes(env, descendant_pids: set[int] | None, out_dir: Path) -> list[dict]:
    """Export Mesh assets referenced by ParticleSystemRenderer mesh mode."""
    out_dir.mkdir(parents=True, exist_ok=True)
    exported: list[dict] = []
    seen: set[str] = set()
    for obj in env.objects:
        if obj.type.name != "ParticleSystemRenderer":
            continue
        try:
            data = obj.read()
            owner_pid = getattr(data.m_GameObject, "path_id", None)
        except Exception:
            continue
        if descendant_pids is not None and owner_pid not in descendant_pids:
            continue
        mesh_ref = getattr(data, "m_Mesh", None)
        if mesh_ref is None or not getattr(mesh_ref, "path_id", 0):
            continue
        try:
            mesh = mesh_ref.read()
            name = str(getattr(mesh, "m_Name", "") or f"Mesh_{mesh_ref.path_id}")
        except Exception:
            continue
        if name in seen:
            continue
        try:
            tri = obj_to_trimesh(mesh)
        except Exception:
            tri = None
        if tri is None:
            continue
        seen.add(name)
        out_path = out_dir / f"{safe_name(name)}.glb"
        tri.export(str(out_path), file_type="glb")
        exported.append({
            "name": name,
            "file": f"meshes/{out_path.name}",
            "verts": int(len(tri.vertices)),
            "faces": int(len(tri.faces)),
        })
    return exported


EMOTION_KEYWORDS = (
    "shy", "blush", "cheek", "tear", "sweat", "heart", "rage",
    "shout", "kirino_shout", "anger", "angry", "surprise", "shock",
    "notice", "exclam", "emotion", "emoji", "bubble", "sigh",
)

ANIM_FX_FUNCS = {"InstantiateFx", "AniEvt_InstantiateFx", "PlayFx", "AniEvt_PlayFx"}


def collect_anim_fx_events(env, scope_files: set[str] | None = None) -> list[dict]:
    """Walk AnimationClips, return FX-spawn events with prefab names resolved.

    When scope_files is given, only clips whose serialised source file is in that
    set are scanned. This restricts the scan to the character's OWN bundles so we
    don't treat foreign clips (other chars / bosses pulled in via the shared
    dependency closure) as FX sources for this character.
    """
    name_by_pid: dict[int, str] = {}
    for o in env.objects:
        if o.type.name != "GameObject":
            continue
        try:
            n = str(o.read().m_Name)
        except Exception:
            continue
        pid = getattr(o, "path_id", None)
        if pid is not None:
            name_by_pid[pid] = n

    events: list[dict] = []
    for o in env.objects:
        if o.type.name != "AnimationClip":
            continue
        if scope_files is not None:
            sf_name = str(getattr(getattr(o, "assets_file", None), "name", ""))
            if sf_name not in scope_files:
                continue
        try:
            tt = o.read_typetree()
        except Exception:
            continue
        clip_name = str(tt.get("m_Name") or "")
        for e in tt.get("m_Events") or []:
            func = e.get("functionName")
            if func not in ANIM_FX_FUNCS:
                continue
            ref_pid = (e.get("objectReferenceParameter") or {}).get("m_PathID", 0)
            prefab = name_by_pid.get(ref_pid) if ref_pid else None
            events.append({
                "clip": clip_name,
                "time": float(e.get("time") or 0.0),
                "func": str(func),
                "prefab_path_id": ref_pid,
                "prefab": prefab,
                "string_param": e.get("data") or "",
                "int_param": e.get("intParameter"),
                "float_param": e.get("floatParameter"),
            })
    events.sort(key=lambda r: (r["clip"], r["time"]))
    return events


def filter_match(text: str, needle: str | None) -> bool:
    if not needle:
        return True
    return needle.lower() in text.lower()


def emotion_match(*texts: str) -> bool:
    blob = " ".join(t.lower() for t in texts if t)
    return any(kw in blob for kw in EMOTION_KEYWORDS)


def main() -> None:
    args = parse_args()
    char_id = args.char_id.upper()
    char_lower = char_id.lower()

    bundles = find_character_bundles(args.assetbundles, char_lower)
    if not bundles:
        raise SystemExit(f"No bundles found for {char_id} in {args.assetbundles}")
    # Seed bundles = this character's OWN bundles (characters/skillcut/cafe-anim/
    # spine/...), before the dependency closure drags in shared + foreign bundles.
    # Used to scope the anim-clip scan so we only treat THIS char's clips as FX
    # sources — the full closure also contains other chars' and bosses' clips
    # (CH0202/CH0331/Labor_Decagram) that would otherwise leak foreign FX prefabs.
    seed_bundles = list(bundles)

    if not args.no_deps:
        candidates = list(bundles) + find_common_dependency_candidates(args.assetbundles)
        # Pull in shared FX bundles too — particle materials/meshes for character cutins
        # live mostly in effectsfreezed-* and etceffects-* namespaces.
        # Also force-include MX_monoscripts so MonoBehaviour script class names
        # resolve (CharacterAnimationEventEffect / AnimationEventReceiverWithBones
        # need their MonoScript objects to extract attach metadata).
        for pat in (
            "assets-_mx-etceffects-*-_mxdependency-*.bundle",
            "assets-_mx-etceffects-_mxcommon-_mxdependency-*.bundle",
            "assets-_mx-effectsfreezed-*-_mxdependency-*.bundle",
            "packages-com.unity.render-pipelines.universal-shaders-particles-_mxdependency-*.bundle",
            "MX_monoscripts_*.bundle",
        ):
            candidates.extend(args.assetbundles.glob(pat))
        resolution = resolve_dependency_closure(
            args.assetbundles,
            seed_bundles=bundles,
            candidate_bundles=candidates,
            cab_index_file=CAB_INDEX_FILE,
        )
        bundles = resolution.bundles
        # Exclude spinelobbies bundles that don't belong to this character.
        # The _mxcommon spinelobbies bundle (and other characters' spine lobby
        # bundles) are pulled in as dependencies of the char's own spine lobby
        # bundle, but they contain shared bokeh/blur materials named after other
        # characters (e.g. FX_MAT_Akane_boke_00, FX_MAT_Nonomi_boke_01) that
        # leak into the FX dump via scoped_material_pids. Spine lobby assets are
        # 2D spine animations unrelated to 3D character FX, so excluding them
        # from the FX env is safe.
        bundles = [
            b for b in bundles
            if "spinelobbies" not in b.name.lower()
            or char_lower in b.name.lower()
        ]
        # Force-add MX_monoscripts even if closure didn't pick it up — the
        # bundle has no CAB cross-reference back to the chr but MonoBehaviours
        # need it to resolve script PPtrs.
        for ms in args.assetbundles.glob("MX_monoscripts_*.bundle"):
            if ms not in bundles:
                bundles.append(ms)
        # Force-add the DSFX shader bundle(s). FX material m_Shader PPtrs are
        # external refs into the prolog shader bundle; without it loaded into the
        # SAME env, dump_material's shader read fails and ships shader="". The
        # shader's blend mode (Additive vs AlphaBlend) is encoded in the shader
        # NAME, which the viewer needs to pick the right THREE blend mode. PPtr
        # path_ids are only stable within one merged env, so the shaders must be
        # in this env (not a side index) to resolve by path_id.
        for sh in args.assetbundles.glob("prologdepengroup-assets-_mx-shaders-_mxprolog-*.bundle"):
            if sh not in bundles:
                bundles.append(sh)
        added = len(resolution.added_dependencies)
        unresolved = len(resolution.unresolved_cabs)
        print(f"[dump_fx] dependency closure: +{added} bundles, {unresolved} unresolved CAB(s)")

    print(f"[dump_fx] {char_id}: loading {len(bundles)} bundle(s)")
    env = UnityPy.load(*[str(b) for b in bundles])

    by_pid = {getattr(o, "path_id", None): o for o in env.objects}

    # Shader path_id -> name index. FX material m_Shader PPtrs resolve to these.
    # Built from the merged env so path_ids match what dump_material reads. The
    # shader NAME carries the blend mode (DSFX/FX_SHADER_Additive_0 vs
    # _AlphaBlend_0 vs _AlphaBlend_Add), which the viewer maps to a THREE
    # blending mode instead of hardcoding additive.
    shader_index: dict[int, str] = {}
    for _o in env.objects:
        if _o.type.name != "Shader":
            continue
        try:
            _sd = _o.read()
            _nm = None
            try:
                _nm = str(_sd.m_ParsedForm.m_Name)
            except Exception:
                _nm = str(getattr(_sd, "m_Name", "")) or None
            if _nm:
                shader_index[_o.path_id] = _nm
        except Exception:
            pass
    print(f"[dump_fx] shader index: {len(shader_index)} shaders")

    out_root = args.output_root / char_id / "fx"
    tex_dir = out_root / "textures"
    mat_dir = out_root / "materials"
    par_dir = out_root / "particles"
    pfb_dir = out_root / "prefabs"
    mesh_dir = out_root / "meshes"
    tex_dir.mkdir(parents=True, exist_ok=True)
    mat_dir.mkdir(parents=True, exist_ok=True)
    par_dir.mkdir(parents=True, exist_ok=True)
    pfb_dir.mkdir(parents=True, exist_ok=True)
    mesh_dir.mkdir(parents=True, exist_ok=True)

    # Clear previously-dumped assets so renamed/orphaned files don't linger.
    # Texture filenames in particular changed shape (name -> name__WxH on
    # collision), and an even older dump left a stale FX_TEX_Color_01.png that
    # matches no current truth variant. We regenerate every asset each run, so a
    # clean sweep keeps the output dir an exact mirror of the dump.
    for _d, _glob in ((tex_dir, "*.png"), (mat_dir, "*.json"),
                      (par_dir, "*.json"), (pfb_dir, "*.json"), (mesh_dir, "*.glb")):
        for _f in _d.glob(_glob):
            try:
                _f.unlink()
            except OSError:
                pass

    summary: dict = {
        "schema_version": 3,
        "char_id": char_id,
        "scope": args.scope,
        "filter": args.filter,
        "prefab_roots": args.prefab,
        "emotion_only": bool(args.emotion),
        "from_anim_events": bool(args.from_anim_events),
        "bundle_count": len(bundles),
        "fx_parent_bones": collect_fx_parent_bones(env, by_pid, char_id),
        "prefabs": [],
        "textures": [],
        "materials": [],
        "meshes": [],
        "particles": [],
        "anim_events_file": None,
    }

    # --from-anim-events: scan AnimationClip.m_Events for FX spawns, write side-file,
    # then auto-populate args.prefab so the rest of the pipeline dumps them.
    if args.from_anim_events:
        # Restrict the clip scan to the character's OWN bundles. The dependency
        # closure pulls in shared bundles containing other chars'/bosses' clips
        # (CH0202_Cafe_Reaction, Labor_Decagram_*, ...) whose FX events would
        # otherwise leak foreign prefabs into this character's dump.
        scope_files: set[str] = set()
        for b in seed_bundles:
            try:
                env_b = UnityPy.load(str(b))
            except Exception:
                continue
            for sf in getattr(env_b, "assets", []) or []:
                scope_files.add(str(getattr(sf, "name", "")))
        events = collect_anim_fx_events(env, scope_files=scope_files or None)
        prefab_set: list[str] = []
        seen: set[str] = set()
        for ev in events:
            n = ev.get("prefab")
            if n and n not in seen:
                seen.add(n)
                prefab_set.append(n)

        anim_events_path = out_root / "anim_events.json"
        _write_json(
            anim_events_path,
            {
                "schema_version": 1,
                "char_id": char_id,
                "fx_functions": sorted(ANIM_FX_FUNCS),
                "prefabs": prefab_set,
                "events": events,
            },
        )
        summary["anim_events_file"] = "anim_events.json"
        print(
            f"[dump_fx] --from-anim-events: {len(events)} FX events, "
            f"{len(prefab_set)} unique prefab(s)"
        )

        if args.prefab is None:
            args.prefab = prefab_set
        else:
            for p in prefab_set:
                if p not in args.prefab:
                    args.prefab.append(p)
        summary["prefab_roots"] = args.prefab

    # --prefab mode: walk transform tree from given prefab root(s) and restrict the
    # dump to assets reachable from those subtrees. This bypasses keyword filters.
    prefab_mat_pids: set[int] | None = None
    prefab_descendant_pids: set[int] | None = None
    if args.prefab:
        prefab_descendant_pids = collect_descendants(env, args.prefab)
        prefab_mat_pids, _ = collect_prefab_assets(env, args.prefab)
        if not prefab_descendant_pids:
            raise SystemExit(f"[dump_fx] no GameObject named {args.prefab} found in loaded env")
        print(
            f"[dump_fx] --prefab: {len(prefab_descendant_pids)} GO(s), "
            f"{len(prefab_mat_pids)} material ref(s) under {args.prefab}"
        )
        # Write a per-prefab manifest listing descendant gameobjects + renderer info.
        for prefab_name in args.prefab:
            tree = dump_prefab_tree(env, by_pid, prefab_name)
            if tree is None:
                print(f"[dump_fx] warn: prefab '{prefab_name}' not found")
                continue
            attach_info = collect_prefab_attach_info(env, prefab_name)
            tree["attach"] = attach_info
            pfb_path = pfb_dir / f"{safe_name(prefab_name)}.json"
            _write_json(pfb_path, tree)
            summary_entry = {
                "name": prefab_name,
                "file": f"prefabs/{pfb_path.name}",
                "descendant_count": len(tree.get("descendants") or []),
            }
            if attach_info is not None:
                summary_entry["attach"] = attach_info
            summary["prefabs"].append(summary_entry)
        summary["meshes"].extend(
            export_particle_renderer_meshes(env, prefab_descendant_pids, mesh_dir)
        )
        if summary["meshes"]:
            print(f"[dump_fx] particle meshes={len(summary['meshes'])}")

    # In 'char' scope, build the set of materials actually reachable from renderers
    # whose serialised file is one of the character's primary bundles. Materials in
    # shared FX bundles (effectsfreezed-*) only get dumped if some char-side
    # renderer references them.
    scoped_material_pids: set[int] | None = None
    if args.scope == "char":
        primary_files: set[str] = set()
        for b in bundles:
            try:
                env_b = UnityPy.load(str(b))
            except Exception:
                continue
            for sf in getattr(env_b, "assets", []) or []:
                primary_files.add(str(getattr(sf, "name", "")))
        scoped_material_pids = set()
        for obj in env.objects:
            if obj.type.name not in (
                "MeshRenderer",
                "SkinnedMeshRenderer",
                "ParticleSystemRenderer",
            ):
                continue
            sf_name = str(getattr(getattr(obj, "assets_file", None), "name", ""))
            if sf_name not in primary_files:
                continue
            try:
                tt = obj.read_typetree()
            except Exception:
                continue
            for mp in tt.get("m_Materials") or []:
                if not isinstance(mp, dict):
                    continue
                fid = mp.get("m_FileID", 0)
                pid = mp.get("m_PathID", 0)
                if pid == 0:
                    continue
                if fid == 0:
                    scoped_material_pids.add(pid)
                    continue
                # External — resolve via externals on the renderer's source file
                src = getattr(obj, "assets_file", None)
                externals = list(getattr(src, "externals", []) or [])
                if fid - 1 >= len(externals):
                    continue
                ext_name = externals[fid - 1].path.split("/")[-1].lower()
                # Look for a Material with matching path_id whose source matches ext_name
                for m_obj in env.objects:
                    if m_obj.type.name != "Material":
                        continue
                    if getattr(m_obj, "path_id", None) != pid:
                        continue
                    m_sf = str(getattr(getattr(m_obj, "assets_file", None), "name", "")).lower()
                    if not ext_name or ext_name in m_sf:
                        scoped_material_pids.add(getattr(m_obj, "path_id"))
                        break

    # --- Materials (first pass, collect referenced texture path_ids for filtered dump) ---
    referenced_tex_pids: set[int] = set()
    for obj in env.objects:
        if obj.type.name != "Material":
            continue
        try:
            name = str(obj.read().m_Name)
        except Exception:
            continue
        if not filter_match(name, args.filter):
            continue
        if prefab_mat_pids is not None:
            if getattr(obj, "path_id", None) not in prefab_mat_pids:
                continue
        elif scoped_material_pids is not None and getattr(obj, "path_id", None) not in scoped_material_pids:
            continue
        rec = dump_material(env, by_pid, obj, shader_index)
        if not rec:
            continue
        if args.emotion and not args.prefab:
            tex_names = [t.get("name") or "" for t in rec["textures"].values()]
            if not emotion_match(rec["name"], *tex_names):
                continue
        for tex in rec["textures"].values():
            if tex.get("path_id"):
                referenced_tex_pids.add(tex["path_id"])
        out_path = mat_dir / f"{safe_name(rec['name'])}.json"
        _write_json(out_path, rec)
        summary["materials"].append({"name": rec["name"], "file": f"materials/{out_path.name}"})

    # --- Textures (only those referenced by dumped materials, or all if --all-textures) ---
    # Iterate env.objects directly (not by_pid) so we never hit dict last-write-wins
    # on cross-file path_id collisions — path_ids are only unique within a source
    # file. export_textures disambiguates name/size collisions by path_id.
    if args.all_textures:
        tex_objs = [o for o in env.objects if o.type.name == "Texture2D"]
    else:
        tex_objs = [
            o for o in env.objects
            if o.type.name == "Texture2D" and getattr(o, "path_id", None) in referenced_tex_pids
        ]
    summary["textures"] = list(export_textures(tex_objs, tex_dir).values())

    # --- ParticleSystems ---
    mesh_file_by_name = {m["name"]: m["file"] for m in summary.get("meshes", [])}
    for obj in env.objects:
        if obj.type.name != "ParticleSystem":
            continue
        rec = dump_particle(env, by_pid, obj)
        if not rec:
            continue
        root = rec["chain"][-1] if rec["chain"] else "root"
        if not (filter_match(rec["go_name"], args.filter) or filter_match(root, args.filter) or filter_match(" ".join(rec["chain"]), args.filter)):
            continue
        if prefab_descendant_pids is not None:
            try:
                ps_data = obj.read()
                owner_pid = getattr(ps_data.m_GameObject, "path_id", None)
            except Exception:
                owner_pid = None
            if owner_pid not in prefab_descendant_pids:
                continue
        elif args.emotion:
            mats = (rec.get("renderer") or {}).get("materials") or []
            mesh = (rec.get("renderer") or {}).get("mesh") or ""
            if not emotion_match(rec["go_name"], root, *rec["chain"], *mats, mesh):
                continue
        fname = f"{safe_name(root)}__{safe_name(rec['go_name'])}.json"
        out_path = par_dir / fname
        _write_json(out_path, rec)
        particle_entry = {
            "go_name": rec["go_name"],
            "go_path_id": rec.get("go_path_id"),
            "root": root,
            "file": f"particles/{fname}",
            "renderer_materials": (rec.get("renderer") or {}).get("materials"),
            "renderer_mesh": (rec.get("renderer") or {}).get("mesh"),
        }
        mesh_name = particle_entry.get("renderer_mesh")
        if mesh_name in mesh_file_by_name:
            particle_entry["renderer_mesh_file"] = mesh_file_by_name[mesh_name]
        summary["particles"].append(particle_entry)

    _write_json(out_root / "index.json", summary)

    # Link the FX index into the character's manifest.json (sibling file).
    manifest_path = out_root.parent / "manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            manifest = None
        if isinstance(manifest, dict):
            manifest["fx_index_file"] = "fx/index.json"
            if summary.get("anim_events_file"):
                manifest["fx_anim_events_file"] = "fx/anim_events.json"
            manifest_path.write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            link_info = "fx_index_file"
            if summary.get("anim_events_file"):
                link_info += " + fx_anim_events_file"
            print(f"[dump_fx] manifest.json: {link_info}")

    print(
        f"[dump_fx] textures={len(summary['textures'])} "
        f"materials={len(summary['materials'])} particles={len(summary['particles'])}"
    )
    print(f"[dump_fx] wrote {out_root}")


if __name__ == "__main__":
    main()
