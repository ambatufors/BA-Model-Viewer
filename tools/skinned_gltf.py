from __future__ import annotations

import json
import math
import re
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from UnityPy.helpers.MeshHelper import MeshHandler

from animation_clip_decoder import DecodedAnimation


ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
FLOAT = 5126
UNSIGNED_BYTE = 5121
UNSIGNED_SHORT = 5123
UNSIGNED_INT = 5125


@dataclass
class SkinnedExport:
    name: str
    file: str
    verts: int
    faces: int
    bones: int
    mesh: str
    root_bone: str | None
    submesh_order: list[str]
    animations: list[dict[str, Any]]


class GlbBuilder:
    def __init__(self) -> None:
        self.bin = bytearray()
        self.buffer_views: list[dict[str, Any]] = []
        self.accessors: list[dict[str, Any]] = []

    def _align(self, alignment: int = 4) -> None:
        pad = (-len(self.bin)) % alignment
        if pad:
            self.bin.extend(b"\x00" * pad)

    def add_view(self, data: bytes, target: int | None = None) -> int:
        self._align()
        offset = len(self.bin)
        self.bin.extend(data)
        view: dict[str, Any] = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        self.buffer_views.append(view)
        return len(self.buffer_views) - 1

    def add_accessor(
        self,
        array: np.ndarray,
        component_type: int,
        accessor_type: str,
        *,
        target: int | None = None,
        include_minmax: bool = False,
    ) -> int:
        view = self.add_view(array.tobytes(), target)
        count = int(array.shape[0])
        accessor: dict[str, Any] = {
            "bufferView": view,
            "componentType": component_type,
            "count": count,
            "type": accessor_type,
        }
        if component_type == UNSIGNED_BYTE:
            accessor["normalized"] = True
        if include_minmax and count:
            flat = array.reshape(count, -1)
            accessor["min"] = flat.min(axis=0).astype(float).tolist()
            accessor["max"] = flat.max(axis=0).astype(float).tolist()
        self.accessors.append(accessor)
        return len(self.accessors) - 1


def _vector3(v: Any) -> list[float]:
    return [float(v.x), float(v.y), float(v.z)]


def _quaternion(q: Any) -> list[float]:
    return [float(q.x), float(q.y), float(q.z), float(q.w)]


def _transform_name(transform: Any) -> str:
    try:
        return str(transform.m_GameObject.read().m_Name)
    except Exception:
        return f"Transform_{_transform_path_id(transform)}"


def _transform_path_id(transform: Any) -> int:
    if transform is None:
        return 0
    direct_id = getattr(transform, "path_id", None) or getattr(transform, "m_PathID", None)
    if direct_id:
        return int(direct_id)
    reader = getattr(transform, "object_reader", None)
    return int(getattr(reader, "path_id", 0) or 0)


def _parent_transform(transform: Any) -> Any | None:
    try:
        father = transform.m_Father
        if not getattr(father, "path_id", 0):
            return None
        return father.read()
    except Exception:
        return None


def _transform_full_path(transform: Any) -> str:
    parts = []
    cur = transform
    seen: set[int] = set()
    while cur is not None:
        pid = _transform_path_id(cur)
        if pid in seen:
            break
        seen.add(pid)
        parts.append(_transform_name(cur))
        cur = _parent_transform(cur)
    return "/".join(reversed([part for part in parts if part]))


def _game_object_transform(go: Any) -> Any | None:
    for pair in getattr(go, "m_Components", getattr(go, "m_Component", [])) or []:
        try:
            ptr = getattr(pair, "component", pair)
            comp = ptr.read()
        except Exception:
            try:
                comp = pair.read()
            except Exception:
                continue
        if comp.__class__.__name__ in ("Transform", "RectTransform"):
            return comp
    return None


def _skinned_renderer_path(smr: Any) -> str:
    try:
        go = smr.m_GameObject.read()
        transform = _game_object_transform(go)
        if transform is not None:
            return _transform_full_path(transform)
        return str(go.m_Name)
    except Exception:
        return ""


def _skinned_renderer_initial_visible(smr: Any) -> bool:
    try:
        go = smr.m_GameObject.read()
        return bool(getattr(go, "m_IsActive", True)) and bool(
            getattr(smr, "m_Enabled", True)
        )
    except Exception:
        return True


def _transform_local_channels(transform: Any) -> dict[str, tuple[float, ...]]:
    pos = transform.m_LocalPosition
    rot = transform.m_LocalRotation
    scale = transform.m_LocalScale
    return {
        "translation": (float(pos.x), float(pos.y), float(pos.z)),
        "rotation": (float(rot.x), float(rot.y), float(rot.z), float(rot.w)),
        "scale": (float(scale.x), float(scale.y), float(scale.z)),
    }


def _skinned_renderer_joint_local_channels(smr: Any) -> dict[str, dict[str, tuple[float, ...]]]:
    channels: dict[str, dict[str, tuple[float, ...]]] = {}
    for ptr in getattr(smr, "m_Bones", []) or []:
        try:
            transform = ptr.read()
            channels[_transform_full_path(transform)] = _transform_local_channels(transform)
        except Exception:
            continue
    return channels


def _path_aliases(path: str) -> list[str]:
    parts = [part for part in path.split("/") if part]
    return ["/".join(parts[index:]) for index in range(len(parts))]


def _record_path_aliases(path_to_nodes: dict[str, set[int]], path: str, node_id: int) -> None:
    for alias in _path_aliases(path):
        path_to_nodes.setdefault(alias, set()).add(node_id)


def _resolve_animation_node_id(path_to_nodes: dict[str, set[int]], path: str) -> int | None:
    for alias in _path_aliases(path):
        node_ids = path_to_nodes.get(alias)
        if not node_ids:
            continue
        if len(node_ids) == 1:
            return next(iter(node_ids))
        return None
    return None


def _matrix4x4_to_gltf(m: Any) -> list[float]:
    # glTF MAT4 accessor data is column-major.
    return [
        float(m.e00), float(m.e10), float(m.e20), float(m.e30),
        float(m.e01), float(m.e11), float(m.e21), float(m.e31),
        float(m.e02), float(m.e12), float(m.e22), float(m.e32),
        float(m.e03), float(m.e13), float(m.e23), float(m.e33),
    ]


def _pad_vec4(values: Any, *, default: float = 0.0) -> tuple[float, float, float, float]:
    seq = list(values) if isinstance(values, (tuple, list)) else [values]
    seq = (seq + [default, default, default, default])[:4]
    return tuple(float(v) for v in seq)


def _joint_vec4(values: Any) -> tuple[int, int, int, int]:
    seq = list(values) if isinstance(values, (tuple, list)) else [values]
    seq = (seq + [0, 0, 0, 0])[:4]
    return tuple(max(0, int(v)) for v in seq)


def _weight_vec4(values: Any | None, joint_values: Any | None = None) -> tuple[float, float, float, float]:
    joints = list(joint_values) if isinstance(joint_values, (tuple, list)) else [joint_values]
    if values is None:
        if joints and joints[0] is not None:
            return (1.0, 0.0, 0.0, 0.0)
        return (0.0, 0.0, 0.0, 0.0)
    weights = [max(0.0, weight) for weight in _pad_vec4(values)]
    total = sum(weights)
    if total > 0 and math.isfinite(total):
        weights = [w / total for w in weights]
    elif joints and joints[0] is not None:
        weights = [1.0, 0.0, 0.0, 0.0]
    return tuple(float(w) for w in weights)


def _color_vec4(values: Any) -> tuple[int, int, int, int]:
    if hasattr(values, "r"):
        channels = [values.r, values.g, values.b, values.a]
    else:
        channels = list(values) if isinstance(values, (tuple, list)) else [values]
    channels = (channels + [255, 255, 255, 255])[:4]
    out = []
    for value in channels:
        value = float(value)
        if value <= 1.0:
            value *= 255.0
        out.append(int(max(0, min(round(value), 255))))
    return tuple(out)  # type: ignore[return-value]


def _mesh_colors_rgba(handler: MeshHandler, vertex_count: int) -> np.ndarray | None:
    colors = getattr(handler, "m_Colors", None) or []
    if len(colors) != vertex_count:
        return None
    return np.asarray([_color_vec4(color) for color in colors], dtype=np.uint8)


def _collect_skeleton_transforms(smr: Any) -> tuple[list[Any], list[Any]]:
    joint_transforms = []
    for ptr in getattr(smr, "m_Bones", []) or []:
        try:
            joint_transforms.append(ptr.read())
        except Exception:
            continue

    all_by_id: dict[int, Any] = {}
    for transform in joint_transforms:
        cur = transform
        while cur is not None:
            pid = _transform_path_id(cur)
            if not pid or pid in all_by_id:
                break
            all_by_id[pid] = cur
            cur = _parent_transform(cur)

    try:
        root = smr.m_RootBone.read() if getattr(smr.m_RootBone, "path_id", 0) else None
    except Exception:
        root = None
    if root is not None:
        cur = root
        while cur is not None:
            pid = _transform_path_id(cur)
            if not pid or pid in all_by_id:
                break
            all_by_id[pid] = cur
            cur = _parent_transform(cur)

    ordered = sorted(all_by_id.values(), key=lambda t: _transform_path_id(t))
    return ordered, joint_transforms


def _make_node(transform: Any) -> dict[str, Any]:
    node = {"name": _transform_name(transform)}
    try:
        pos = transform.m_LocalPosition
        if pos.x or pos.y or pos.z:
            node["translation"] = _vector3(pos)
    except Exception:
        pass
    try:
        rot = transform.m_LocalRotation
        if rot.x or rot.y or rot.z or rot.w != 1:
            node["rotation"] = _quaternion(rot)
    except Exception:
        pass
    try:
        scale = transform.m_LocalScale
        if scale.x != 1 or scale.y != 1 or scale.z != 1:
            node["scale"] = _vector3(scale)
    except Exception:
        pass
    return node


def _safe_mesh_name(mesh: Any, fallback: str) -> str:
    name = str(getattr(mesh, "m_Name", "") or fallback)
    for prefix in ("OL_",):
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name


def _source_ids(char_id: str, source_ids: Iterable[str] | None = None) -> tuple[str, ...]:
    return tuple(dict.fromkeys((char_id, *(source_ids or ()))))


def _name_has_source_prefix(name: str, char_id: str, source_ids: Iterable[str] | None = None) -> bool:
    lowered = name.lower()
    for source in _source_ids(char_id, source_ids):
        source_lower = source.lower()
        if lowered == source_lower or lowered.startswith(f"{source_lower}_"):
            return True
    return False


def _strip_source_prefix(name: str, char_id: str, source_ids: Iterable[str] | None = None) -> str:
    lowered = name.lower()
    for source in sorted(_source_ids(char_id, source_ids), key=len, reverse=True):
        prefix = f"{source}_"
        if lowered.startswith(prefix.lower()):
            return name[len(prefix):]
    return name


def _material_base_names(smr: Any, char_id: str, source_ids: Iterable[str] | None = None) -> list[str]:
    names: list[str] = []
    for index, mat_ref in enumerate(getattr(smr, "m_Materials", []) or []):
        try:
            name = str(mat_ref.read().m_Name)
        except Exception:
            names.append(f"sub{index}")
            continue
        name = _strip_source_prefix(name, char_id, source_ids)
        names.append(name or f"sub{index}")
    return names


def _is_skill_prop_name(name: str) -> bool:
    lowered = name.lower()
    return "skillprop" in lowered or "skillprob" in lowered


def _is_brush_name(name: str) -> bool:
    lowered = name.lower()
    return "brush" in lowered and not lowered.startswith("ol_")


def _is_named_prop_mesh(name: str) -> bool:
    lowered = name.lower()
    return "prop" in lowered and not lowered.startswith("ol_")


def _is_weapon_name(name: str) -> bool:
    lowered = name.lower()
    return "weapon" in lowered and not lowered.startswith("ol_")


def _path_mentions_current_character(
    path: str,
    char_id: str,
    source_ids: Iterable[str] | None = None,
) -> bool:
    owned_roots = set()
    for source in _source_ids(char_id, source_ids):
        key = source.upper()
        owned_roots.update({
            key,
            f"{key}_MESH",
            f"CAFE_{key}",
            f"STRATEGY_{key}",
            f"ECHELON_{key}",
        })
    return any(part.upper() in owned_roots for part in path.split("/") if part)


def _owned_root_rank(
    path: str,
    char_id: str,
    source_ids: Iterable[str] | None = None,
) -> int:
    parts = [part for part in path.split("/") if part]
    if not parts:
        return 0
    root = parts[0].upper()
    for source in _source_ids(char_id, source_ids):
        key = source.upper()
        if root == f"{key}_MESH":
            return 5
        if root == key:
            return 4
        if root in {f"CAFE_{key}", f"STRATEGY_{key}", f"ECHELON_{key}"}:
            return 3
        if root.startswith(f"{key}_"):
            return 1
    return 0


def _path_without_root(path: str) -> str:
    parts = [part for part in path.split("/") if part]
    return "/".join(parts[1:]) if len(parts) > 1 else path


def _skinned_export_candidate_score(
    char_id: str,
    owner_path: str,
    root_bone_path: str = "",
    avatar_paths: Iterable[str] | None = None,
    source_ids: Iterable[str] | None = None,
    *,
    export_name: str = "",
    go_name: str = "",
    mesh_name: str = "",
) -> int:
    score = max(
        _owned_root_rank(owner_path, char_id, source_ids),
        _owned_root_rank(root_bone_path, char_id, source_ids),
    ) * 100

    normalized_avatar_paths = {str(path) for path in (avatar_paths or ())}
    if root_bone_path:
        root_aliases = {root_bone_path, _path_without_root(root_bone_path)}
        if root_aliases & normalized_avatar_paths:
            score += 25
    if _is_ch0091_cafe_skinned_outline(char_id, go_name, mesh_name, owner_path):
        score += 300
    if char_id.upper() == "CH0091" and export_name.lower() == "prop":
        if _is_ch0091_cafe_beach_prop_outline(char_id, go_name, mesh_name, owner_path):
            score += 400
        if "bone_waterproofcase_00" in root_bone_path.lower():
            score -= 250
    return score


def _avatar_paths_mention_name(avatar_paths: Iterable[str] | None, name: str) -> bool:
    if not name:
        return False
    wanted = name.lower()
    for path in avatar_paths or ():
        parts = [part.lower() for part in str(path).split("/") if part]
        if wanted in parts:
            return True
    return False


def _is_owned_external_weapon(
    char_id: str,
    go_name: str,
    mesh_name: str,
    owner_path: str = "",
    avatar_paths: Iterable[str] | None = None,
    source_ids: Iterable[str] | None = None,
) -> bool:
    if not (_is_weapon_name(go_name) or _is_weapon_name(mesh_name)):
        return False
    if _is_outline_name(go_name) or _is_outline_name(mesh_name):
        return False
    # Reject weapons that explicitly carry a different unit's prefix
    # (CH####, NP####, EN####, etc.). Dependency-closure bundles often
    # pull alien weapon SMRs into the env (e.g. CH0081_Weapon arrives
    # with a shared shader bundle while exporting CH0334), and those
    # should never be exported as the current character's weapon.
    own_prefix = char_id.upper()
    foreign_unit_re = re.compile(r"^(CH|NP|NPC|EN|EV|MOB)\d{3,4}_", re.IGNORECASE)
    for candidate in (go_name, mesh_name):
        match = foreign_unit_re.match(candidate)
        if match and not candidate.upper().startswith(f"{own_prefix}_"):
            return False
    # `<SourceName>_Original_Weapon` only legitimately belongs to a
    # character whose source IDs include `<SourceName>`, whose owner
    # path / avatar path explicitly references the current character,
    # or whose avatar paths reference the SMR by name. When NONE of
    # those signals fire (e.g. Maki_Original_Weapon arrives in CH0334's
    # dependency closure because shared bone hierarchies pull the SMR
    # in but Aris's avatar does not list it), reject it instead of
    # letting `_avatar_paths_mention_name` falsely whitelist the alien
    # weapon.
    if re.search(r"_Original_Weapon", f"{go_name} {mesh_name}", re.IGNORECASE):
        owned_sources = {s.lower() for s in _source_ids(char_id, source_ids)}
        unit_in_path = _path_mentions_current_character(owner_path, char_id, source_ids)
        head_in_owned = False
        for candidate in (go_name, mesh_name):
            head = candidate.split("_Original_", 1)[0].lower()
            if head and head in owned_sources:
                head_in_owned = True
                break
        avatar_lists_smr = (
            _avatar_paths_mention_name(avatar_paths, go_name)
            or _avatar_paths_mention_name(avatar_paths, mesh_name)
        )
        # Only treat avatar evidence as authoritative when the avatar
        # path actually anchors the weapon under THIS character's mesh
        # root. A bare `Maki_Original_Weapon` entry can land in any
        # character's avatar lookup via shared bone closures and is not
        # by itself proof of ownership.
        avatar_anchors_owner = False
        if avatar_lists_smr and avatar_paths:
            for path in avatar_paths:
                if _path_mentions_current_character(path, char_id, source_ids):
                    avatar_anchors_owner = True
                    break
        if (
            not head_in_owned
            and not unit_in_path
            and not avatar_anchors_owner
            and not (avatar_lists_smr and not owner_path)
        ):
            return False
    return (
        _path_mentions_current_character(owner_path, char_id, source_ids)
        or _avatar_paths_mention_name(avatar_paths, go_name)
        or _avatar_paths_mention_name(avatar_paths, mesh_name)
    )


def _is_ch0091_cafe_beach_prop_outline(
    char_id: str,
    go_name: str,
    mesh_name: str,
    owner_path: str = "",
) -> bool:
    return (
        _ch0091_cafe_outline_export_name(char_id, go_name, mesh_name) == "Prop"
        and owner_path.lower().startswith("cafe_hoshino_swimsuit/")
    )


def _ch0091_cafe_outline_export_name(
    char_id: str,
    go_name: str,
    mesh_name: str = "",
) -> str:
    if char_id.upper() != "CH0091":
        return ""
    if not mesh_name.lower().startswith("ol_"):
        return ""
    return {
        "hoshino_swimsuit_beachprop_outline": "Prop",
    }.get(go_name.lower(), "")


def _is_ch0091_cafe_skinned_outline(
    char_id: str,
    go_name: str,
    mesh_name: str = "",
    owner_path: str = "",
) -> bool:
    return bool(
        _ch0091_cafe_outline_export_name(char_id, go_name, mesh_name)
        and owner_path.lower().startswith("cafe_hoshino_swimsuit/")
    )


def _is_outline_name(name: str) -> bool:
    normalized = name.lower().replace("_", "").replace("-", "")
    return "outline" in normalized or "outlline" in normalized


# Some prop GameObjects legitimately end with "_Outline" in their name even
# though the mesh itself is the actual prop, not an outline of another mesh
# (e.g. CH0063_Tube_Outline is Hina's swim ring). Maintain a small allow
# list keyed off recognizable prop tokens so the OL_-prefixed outline pair
# is still filtered. CH0288 is unusual: its character meshes (Face, Bag,
# Train) all carry the "_Outline" suffix on the GameObject name even though
# they are the real meshes; the actual outlines live on the OL_-prefixed
# Mesh assets and are filtered separately.
_PROP_OUTLINE_TOKENS = (
    "tube",
    "swimring",
    "umbrella",
    "phone",
    "bag",
    "train",
    "face",
)


def _is_prop_outline_name(name: str) -> bool:
    if not _is_outline_name(name):
        return False
    lowered = name.lower()
    return any(token in lowered for token in _PROP_OUTLINE_TOKENS)


def _skinned_export_name(
    char_id: str,
    go_name: str,
    mesh_name: str,
    source_ids: Iterable[str] | None = None,
) -> str:
    source = mesh_name or go_name
    ch0091_cafe_name = _ch0091_cafe_outline_export_name(char_id, go_name, mesh_name)
    if ch0091_cafe_name:
        return ch0091_cafe_name
    if char_id.upper() == "CH0172" and "my_event091_strategytable_prop_02" in f"{go_name} {mesh_name}".lower():
        return "Prop02"
    if char_id.upper() == "CH0174" and "dron01_outline" in f"{go_name} {mesh_name}".lower():
        return "Dron01"
    stripped = _strip_source_prefix(source, char_id, source_ids) or go_name
    if "cutin" in source.lower() and _is_weapon_name(source):
        return "Cutin_Weapon"
    if _is_weapon_name(source) or _is_weapon_name(go_name):
        if source.lower().endswith("weapon001") or go_name.lower().endswith("weapon001"):
            return "Weapon001"
        variant = re.search(r"(?:^|_)weapon[_-]?(\d+)$", stripped, re.I)
        if variant:
            return f"Weapon_{int(variant.group(1)):02d}"
        return "Weapon"
    if _is_skill_prop_name(source) or _is_skill_prop_name(go_name):
        return "SkillProp"
    if _is_brush_name(source) or _is_brush_name(go_name):
        return "Brush_01" if "01" in f"{source} {go_name}" else "Brush"
    if "prop" in source.lower() and ("outline" in source.lower() or "outlline" in source.lower()):
        prop_variant = re.search(r"(?:^|_)prop[_-]?(\d+)(?:_|$)", stripped, re.I)
        if prop_variant and int(prop_variant.group(1)) > 1:
            return f"Prop{int(prop_variant.group(1)):02d}"
        return "Prop"
    # Some characters (e.g. CH0288) name their real prop GameObjects with a
    # "_Outline" suffix even though they are not outlines. Strip the suffix
    # so they export as Bag / Train / Face instead of Bag_Outline etc.
    base = _strip_source_prefix(go_name, char_id, source_ids) or go_name
    base_lower = base.lower()
    if base_lower.endswith("_outline") or base_lower.endswith("_outlline"):
        trimmed = base.rsplit("_", 1)[0]
        if trimmed:
            return trimmed
    return stripped


def _visibility_rule_for_export_name(export_name: str, char_id: str = "") -> dict[str, Any] | None:
    lowered = export_name.lower()
    if lowered.startswith("cutin_"):
        return {"default_visible": False, "show_clip_patterns": ["Exs_Cutin"]}
    if char_id.upper() == "CH0100" and lowered == "glass":
        return {
            "default_visible": False,
            "show_clip_patterns": ["^CH0100_Cafe_(Idle|Reaction|Walk)$", "^CH0100_Exs_Cutin$"],
        }
    if char_id.upper() == "CH0273" and lowered == "prop":
        return {"default_visible": False, "show_clip_patterns": ["Exs_Cutin_Sportswear"]}
    if char_id.upper() == "CH0264" and lowered == "prop03":
        return {"default_visible": False, "show_clip_patterns": ["Exs_Cutin_Dummy"]}
    if char_id.upper() == "CH0172":
        if lowered == "hand01_mesh":
            return {"default_visible": True, "hide_clip_patterns": ["Cafe_my_event091_strategytable"]}
        if lowered == "hand02_mesh":
            return {"default_visible": False, "show_clip_patterns": ["Cafe_my_event091_strategytable"]}
        if lowered == "prop02":
            return {"default_visible": False, "show_clip_patterns": ["Cafe_my_event091_strategytable"]}
    if char_id.upper() == "CH0072" and lowered == "weapon":
        return {"default_visible": True, "hide_clip_patterns": ["Cafe_", "Exs_Cutin"]}
    if char_id.upper() == "CH0304" and lowered.startswith("weapon"):
        # Cafe_CH0304 prefab keeps both gun renderers enabled, and its Cafe
        # clips animate Bip001_Weapon / Bip001_Weapon_Case directly.
        return None
    if char_id.upper() == "CH0335":
        if "brush" in lowered:
            return {"default_visible": False, "show_clip_patterns": ["Interaction_02"]}
        if lowered == "prop":
            return {"default_visible": False, "show_clip_patterns": ["Exs"]}
        if lowered == "weapon":
            return {
                "default_visible": False,
                "show_clip_patterns": ["Normal_", "Move_", "Vital_", "Victory_", "Scenario_", "Exs", "Public01", "Formation_"],
                "hide_clip_patterns": ["Cafe_"],
            }
    if char_id.upper() == "CH0336":
        # Keep the carrier cabin disabled for now. The loader strips the
        # carrier-door root translation separately so the door clips still
        # frame Yuzu without requiring the cabin mesh.
        if lowered.startswith("cockpit") or lowered == "controller":
            return {"default_visible": False}
    if char_id.upper() == "CH0326" and lowered == "face02":
        return {"default_visible": False, "show_clip_patterns": ["Exs_Cutin"]}
    if char_id.upper() == "CH0145" and lowered == "garbagebox":
        # Truth prefab keeps Miyu's trash can renderer enabled. Leave it on
        # instead of applying the old Cafe-only temporary suppression.
        return None
    # CH0145 Face/Face01 swap is fully driven by Renderer.m_Enabled curves
    # baked into every clip (see renderer_toggle_clips). Don't add static
    # name-pattern rules — let the runtime sample the curves directly.
    # CH0288 face/prop swap is fully driven by AniEvt_*ChildRenderer events
    # in the AnimationClip. Don't add visibility rules — let the event
    # handler decide. Bag is everyday backpack, also event-controlled.
    if char_id.upper() == "CH0076" and lowered.startswith("fx_mesh_ch0076_keyring_prop_"):
        return {"default_visible": False, "show_clip_patterns": ["Exs_Cutin_01", "Exs_Cutin_02"]}
    if char_id.upper() == "CH0076" and "prop02" in lowered:
        return None
    if char_id.upper() in {"CH0247", "CH0264"} and "prop02" in lowered:
        # These Prop02_Mesh assets pack multiple sub-props into a single SMR
        # (CH0247: trash can/flower/bomb; CH0264: cup/book/hammer/tea).
        # The renderer is permanently enabled in the truth bundles
        # Game hides individual sub-props by collapsing their bone scale to ~0
        # inside each AnimationClip (e.g. cup keeps scale 0.86 in Cafe_Idle
        # but book/hammer drop to 0.07). Forcing a clip-name `Prop02` show
        # rule kept the entire SMR hidden because no clip name contains the
        # token. Drop the rule so the bone-scale animation drives visibility
        # naturally per sub-prop.
        return None
    if char_id.upper() == "CH0334":
        variant_clip_pattern = "^CH0334_(Cafe|Carrier|Scenario)_"
        if lowered == "arms_body":
            # Battle/echelon form. The truth prefab orders renderer index 2 as
            # Arms_Body and index 3 as Body; Formation_* disables 3 and enables
            # 2, while CH0334_Cafe_* does the inverse.
            return {
                "default_visible": True,
                "hide_clip_patterns": [variant_clip_pattern],
            }
        if lowered == "body":
            return {
                "default_visible": False,
                "show_clip_patterns": [variant_clip_pattern],
            }
        if lowered in {"weapon_01", "weapon01"}:
            return {
                "default_visible": True,
                "hide_clip_patterns": [variant_clip_pattern, "^Cafe_CH0334"],
            }
        if lowered in {"weapon_02", "weapon02"}:
            return {
                "default_visible": False,
                "show_clip_patterns": ["^CH0334_Scenario_"],
            }
    if "prop02" in lowered:
        return {"default_visible": False, "show_clip_patterns": ["Prop02"]}
    if lowered.startswith("scenario_weapon"):
        return {
            "default_visible": False,
            "show_clip_patterns": ["Scenario_"],
        }
    if lowered.startswith("weapon"):
        # Battle/Normal weapon. Hidden on cafe clips so the alternate
        # cafe-form weapon (e.g. wing) can take over.
        return {
            "default_visible": True,
            "hide_clip_patterns": [
                "^Cafe_",
                "my_event088",
            ],
        }
    return None


_PASSIVE_WEAPON_JOINT_NAMES = {
    "bip001_weapon",
    "bip001 weapon",
    "bone_buttstock",
    "bone_magazine",
    "bone_magazine01",
    "bone_bolt",
    "fire_01",
    "fire_02",
}


def _path_mentions_any_tail(path: str, tails: Iterable[str]) -> bool:
    parts = {part.lower() for part in path.split("/") if part}
    return any(tail.lower() in parts for tail in tails)


def _path_is_same_or_child(path: str, parent: str) -> bool:
    normalized = path.lower().strip("/")
    prefix = parent.lower().strip("/")
    return normalized == prefix or normalized.startswith(f"{prefix}/")


def _paths_overlap(path: str, other: str) -> bool:
    return bool(set(_path_aliases(path)) & set(_path_aliases(other)))


def _values_differ(
    left: Iterable[float],
    right: Iterable[float],
    *,
    epsilon: float = 1e-4,
) -> bool:
    return any(abs(float(a) - float(b)) > epsilon for a, b in zip(left, right))


def _channel_has_meaningful_prop_activity(
    animation: DecodedAnimation,
    joint_path: str,
    target: str,
    rest_values: tuple[float, ...],
) -> bool:
    for (path, channel_target), channel in animation.channels.items():
        if channel_target != target:
            continue
        if not _paths_overlap(path, joint_path):
            continue
        values = getattr(channel, "values", []) or []
        if len(values) < 3:
            continue
        if any(_values_differ(value, rest_values) for value in values):
            return True
    return False


def _animated_clip_names_for_joint_rest_delta(
    animations: Iterable[DecodedAnimation] | None,
    joint_channels: dict[str, dict[str, tuple[float, ...]]],
) -> set[str]:
    if not joint_channels or not animations:
        return set()
    out: set[str] = set()
    for animation in animations:
        for joint_path, rest_channels in joint_channels.items():
            if any(
                _channel_has_meaningful_prop_activity(animation, joint_path, target, rest)
                for target, rest in rest_channels.items()
            ):
                out.add(animation.name)
                break
    return out


def _leaf_joint_channels(
    joint_channels: dict[str, dict[str, tuple[float, ...]]],
) -> dict[str, dict[str, tuple[float, ...]]]:
    paths = set(joint_channels)
    return {
        path: channels
        for path, channels in joint_channels.items()
        if not any(
            other != path and _path_is_same_or_child(other, path)
            for other in paths
        )
    }


def _truth_visibility_rule_for_export(
    export_name: str,
    char_id: str,
    animations: Iterable[DecodedAnimation] | None,
    joint_channels: dict[str, dict[str, tuple[float, ...]]],
) -> dict[str, Any] | None:
    """Prefer animation evidence over broad name-based visibility fallbacks."""
    lowered = export_name.lower()
    if not lowered.startswith("weapon"):
        return _visibility_rule_for_export_name(export_name, char_id)

    fallback = _visibility_rule_for_export_name(export_name, char_id)
    # Battle/Normal weapon fallback emitted by `_visibility_rule_for_export_name`.
    # Evidence-based narrowing only applies when the export resolves to this
    # generic battle rule; scenario-weapon and per-character overrides fall
    # through unchanged.
    generic_weapon_hide = {
        "default_visible": True,
        "hide_clip_patterns": [
            "^Cafe_",
            "my_event088",
        ],
    }
    if fallback != generic_weapon_hide:
        return fallback

    active_channels = {
        path: channels
        for path, channels in _leaf_joint_channels(joint_channels).items()
        if path
        and not _path_mentions_any_tail(path, _PASSIVE_WEAPON_JOINT_NAMES)
        and "bip001_weapon" not in path.lower()
    }
    animated_clips = _animated_clip_names_for_joint_rest_delta(animations, active_channels)
    active_cafe_clips = {name for name in animated_clips if "cafe_" in name.lower()}
    if not active_cafe_clips:
        return fallback

    all_cafe_clips = {
        animation.name
        for animation in animations or []
        if "cafe_" in animation.name.lower()
    }
    hidden_cafe_clips = sorted(all_cafe_clips - active_cafe_clips)
    if hidden_cafe_clips:
        return {
            "default_visible": True,
            "hide_clip_patterns": [f"^{re.escape(name)}$" for name in hidden_cafe_clips],
        }
    if active_cafe_clips:
        return None
    return fallback


def _initial_renderer_visible_override_for_export_name(export_name: str, char_id: str = "") -> bool | None:
    if char_id.upper() == "CH0172" and export_name.lower() in {"hand02_mesh", "prop02"}:
        return False
    return None


def _event_renderer_controlled_for_export_name(export_name: str, char_id: str = "") -> bool:
    return char_id.upper() == "CH0091" and export_name.lower() in {"body01", "body02"}


def _ignore_vertex_colors_for_export_name(export_name: str, char_id: str = "") -> bool:
    if char_id.upper() == "CH0172" and export_name.lower() == "prop02":
        return True
    return False


def _is_skinned_export_candidate(
    char_id: str,
    go_name: str,
    mesh_name: str,
    owner_path: str = "",
    avatar_paths: Iterable[str] | None = None,
    source_ids: Iterable[str] | None = None,
) -> bool:
    is_ch0172_strategy_table_prop = (
        char_id.upper() == "CH0172"
        and "my_event091_strategytable_prop_02" in f"{go_name} {mesh_name}".lower()
    )
    is_ch0091_cafe_beach_prop_outline = _is_ch0091_cafe_beach_prop_outline(
        char_id, go_name, mesh_name, owner_path
    )
    is_ch0091_cafe_skinned_outline = _is_ch0091_cafe_skinned_outline(
        char_id, go_name, mesh_name, owner_path
    )
    if not _name_has_source_prefix(go_name, char_id, source_ids):
        if _is_owned_external_weapon(char_id, go_name, mesh_name, owner_path, avatar_paths, source_ids):
            pass
        elif is_ch0172_strategy_table_prop:
            pass
        elif is_ch0091_cafe_skinned_outline:
            pass
        elif not (char_id.upper() == "CH0335" and (_is_brush_name(go_name) or _is_brush_name(mesh_name))):
            return False
    if mesh_name.lower().startswith("ol_") and not is_ch0091_cafe_skinned_outline:
        return False
    lowered = f"{go_name} {mesh_name}".lower()
    if "scenario" in lowered or "carrier" in lowered:
        return False
    if _is_skill_prop_name(go_name) or _is_skill_prop_name(mesh_name):
        return True
    if char_id.upper() == "CH0335" and (_is_brush_name(go_name) or _is_brush_name(mesh_name)):
        return True
    if is_ch0172_strategy_table_prop:
        return True
    if is_ch0091_cafe_beach_prop_outline:
        return True
    if is_ch0091_cafe_skinned_outline:
        return True
    if _is_named_prop_mesh(go_name) or _is_named_prop_mesh(mesh_name):
        return True
    # CH0174's drone is a real prop SMR but its GO name `CH0174_Dron01_Outline`
    # collides with the generic outline filter (no "prop" or other prop token).
    # Whitelist it explicitly so it exports as the skinned `Dron01`.
    if char_id.upper() == "CH0174" and "dron01_outline" in f"{go_name} {mesh_name}".lower():
        return True
    # Some prop GOs legitimately end with "_Outline" in their name
    # (e.g. CH0063_Tube_Outline is the actual swim ring mesh, not an
    # outline of another mesh). Treat tube-style props as exportable
    # while keeping bare body/face outline meshes filtered.
    if _is_prop_outline_name(go_name) or _is_prop_outline_name(mesh_name):
        return True
    return not _is_outline_name(go_name) and not _is_outline_name(mesh_name)


def _primitive_indices(triangles: list[tuple[int, ...]]) -> np.ndarray:
    if not triangles:
        return np.zeros((0,), dtype="<u2")
    flat = np.asarray([idx for tri in triangles for idx in tri], dtype=np.uint32)
    if int(flat.max(initial=0)) <= 65535:
        return flat.astype("<u2")
    return flat.astype("<u4")


def _component_type_for_indices(indices: np.ndarray) -> int:
    return UNSIGNED_SHORT if indices.dtype.itemsize == 2 else UNSIGNED_INT


def _append_gltf_animations(
    builder: GlbBuilder,
    path_to_nodes: dict[str, set[int]],
    animations: list[DecodedAnimation],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    gltf_animations: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []

    for animation in animations:
        samplers: list[dict[str, Any]] = []
        channels: list[dict[str, Any]] = []
        skipped = 0
        keyframes = 0
        for channel in animation.channels.values():
            node_id = _resolve_animation_node_id(path_to_nodes, channel.path)
            if node_id is None:
                skipped += 1
                continue
            if not channel.times or len(channel.times) != len(channel.values):
                skipped += 1
                continue

            times = np.asarray(channel.times, dtype="<f4")
            values = np.asarray(channel.values, dtype="<f4")
            if values.ndim != 2:
                skipped += 1
                continue
            expected_width = 4 if channel.target == "rotation" else 3
            if values.shape[1] != expected_width:
                skipped += 1
                continue

            input_accessor = builder.add_accessor(times, FLOAT, "SCALAR", include_minmax=True)
            output_accessor = builder.add_accessor(
                values,
                FLOAT,
                "VEC4" if channel.target == "rotation" else "VEC3",
            )
            sampler_id = len(samplers)
            samplers.append(
                {
                    "input": input_accessor,
                    "output": output_accessor,
                    "interpolation": "LINEAR",
                }
            )
            channels.append(
                {
                    "sampler": sampler_id,
                    "target": {
                        "node": node_id,
                        "path": channel.target,
                    },
                }
            )
            keyframes += len(channel.times)

        if not channels:
            continue
        gltf_animations.append({"name": animation.name, "samplers": samplers, "channels": channels})
        summaries.append(
            {
                "name": animation.name,
                "duration": animation.duration,
                "sample_rate": animation.sample_rate,
                "channels": len(channels),
                "keyframes": keyframes,
                "skipped_channels": skipped,
                "source_bundle": animation.source_bundle,
            }
        )

    return gltf_animations, summaries


def export_skinned_smr(
    output_path: Path,
    smr: Any,
    name: str,
    *,
    char_id: str = "",
    animations: list[DecodedAnimation] | None = None,
    source_ids: Iterable[str] | None = None,
) -> SkinnedExport:
    mesh = smr.m_Mesh.read()
    handler = MeshHandler(mesh)
    handler.process()
    if not handler.m_Vertices:
        raise ValueError(f"{name}: mesh has no decoded vertices")
    if not handler.m_BoneIndices:
        raise ValueError(f"{name}: mesh has no decoded bone indices")

    vertices = np.asarray(handler.m_Vertices, dtype="<f4")
    normals = np.asarray(handler.m_Normals or [(0.0, 1.0, 0.0)] * len(vertices), dtype="<f4")
    if normals.ndim == 2 and normals.shape[1] > 3:
        normals = normals[:, :3]
    uv0 = np.asarray(handler.m_UV0 or [(0.0, 0.0)] * len(vertices), dtype="<f4")
    if uv0.ndim == 1:
        uv0 = uv0.reshape((-1, 2))
    elif uv0.ndim == 2 and uv0.shape[1] > 2:
        uv0 = uv0[:, :2]
    elif uv0.ndim == 2 and uv0.shape[1] == 1:
        uv0 = np.pad(uv0, ((0, 0), (0, 1)))
    # Unity mesh UVs are bottom-left origin, while the static GLB exporter and
    # viewer texture setup expect glTF-style top-left V coordinates.
    uv0[:, 1] = 1.0 - uv0[:, 1]

    joint_rows = [_joint_vec4(row) for row in handler.m_BoneIndices]
    weight_rows = [
        _weight_vec4(handler.m_BoneWeights[i] if handler.m_BoneWeights else None, handler.m_BoneIndices[i])
        for i in range(len(joint_rows))
    ]
    joints = np.asarray(joint_rows, dtype="<u2")
    weights = np.asarray(weight_rows, dtype="<f4")
    colors = _mesh_colors_rgba(handler, len(vertices))

    all_transforms, joint_transforms = _collect_skeleton_transforms(smr)
    if not joint_transforms:
        raise ValueError(f"{name}: renderer has no readable bones")

    transform_to_node: dict[int, int] = {}
    path_to_nodes: dict[str, set[int]] = {}
    nodes: list[dict[str, Any]] = [{"name": f"{name}_Mesh"}]
    for transform in all_transforms:
        node_id = len(nodes)
        transform_to_node[_transform_path_id(transform)] = node_id
        _record_path_aliases(path_to_nodes, _transform_full_path(transform), node_id)
        nodes.append(_make_node(transform))

    root_bone_node: int | None = None
    root_bone_name: str | None = None
    try:
        if getattr(smr.m_RootBone, "path_id", 0):
            root = smr.m_RootBone.read()
            root_bone_node = transform_to_node.get(_transform_path_id(root))
            root_bone_name = _transform_name(root)
    except Exception:
        pass

    child_sets: dict[int, list[int]] = {i: [] for i in range(len(nodes))}
    bone_node_ids = set(transform_to_node.values())
    for transform in all_transforms:
        node_id = transform_to_node[_transform_path_id(transform)]
        parent = _parent_transform(transform)
        parent_id = transform_to_node.get(_transform_path_id(parent)) if parent is not None else None
        if parent_id is not None:
            child_sets[parent_id].append(node_id)

    for node_id, children in child_sets.items():
        if children:
            nodes[node_id]["children"] = sorted(children)

    top_bones = sorted(
        node_id
        for node_id in bone_node_ids
        if not any(node_id in children for children in child_sets.values())
    )

    builder = GlbBuilder()
    pos_accessor = builder.add_accessor(vertices, FLOAT, "VEC3", target=ARRAY_BUFFER, include_minmax=True)
    normal_accessor = builder.add_accessor(normals, FLOAT, "VEC3", target=ARRAY_BUFFER)
    uv_accessor = builder.add_accessor(uv0, FLOAT, "VEC2", target=ARRAY_BUFFER)
    joints_accessor = builder.add_accessor(joints, UNSIGNED_SHORT, "VEC4", target=ARRAY_BUFFER)
    weights_accessor = builder.add_accessor(weights, FLOAT, "VEC4", target=ARRAY_BUFFER)
    color_accessor = (
        builder.add_accessor(colors, UNSIGNED_BYTE, "VEC4", target=ARRAY_BUFFER)
        if colors is not None
        else None
    )

    primitives = []
    face_count = 0
    for submesh_index, triangles in enumerate(handler.get_triangles()):
        indices = _primitive_indices(triangles)
        face_count += len(triangles)
        index_accessor = builder.add_accessor(
            indices,
            _component_type_for_indices(indices),
            "SCALAR",
            target=ELEMENT_ARRAY_BUFFER,
            include_minmax=True,
        )
        attributes = {
            "POSITION": pos_accessor,
            "NORMAL": normal_accessor,
            "TEXCOORD_0": uv_accessor,
            "JOINTS_0": joints_accessor,
            "WEIGHTS_0": weights_accessor,
        }
        if color_accessor is not None:
            attributes["COLOR_0"] = color_accessor
        primitives.append(
            {
                "attributes": attributes,
                "indices": index_accessor,
                "mode": 4,
                "material": submesh_index,
            }
        )

    bindposes = list(getattr(mesh, "m_BindPose", []) or [])
    matrices = [_matrix4x4_to_gltf(bindposes[i]) if i < len(bindposes) else np.eye(4, dtype=np.float32).T.reshape(-1).tolist() for i in range(len(joint_transforms))]
    ibm = np.asarray(matrices, dtype="<f4")
    ibm_accessor = builder.add_accessor(ibm, FLOAT, "MAT4")

    joint_nodes = [transform_to_node[_transform_path_id(transform)] for transform in joint_transforms if _transform_path_id(transform) in transform_to_node]
    gltf_animations, animation_summaries = _append_gltf_animations(builder, path_to_nodes, animations or [])
    nodes[0]["mesh"] = 0
    nodes[0]["skin"] = 0

    materials = [
        {
            "name": f"{name}_sub{submesh_index}",
            "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
        }
        for submesh_index in range(len(primitives))
    ]

    gltf = {
        "asset": {"version": "2.0", "generator": "web-viewer tools/skinned_gltf.py"},
        "extras": {"viewerUvYFlipped": True},
        "scene": 0,
        "scenes": [{"nodes": [0] + top_bones}],
        "nodes": nodes,
        "skins": [
            {
                "joints": joint_nodes,
                "inverseBindMatrices": ibm_accessor,
                **({"skeleton": root_bone_node} if root_bone_node is not None else {}),
            }
        ],
        "meshes": [{"name": name, "primitives": primitives}],
        "materials": materials,
        "buffers": [{"byteLength": len(builder.bin)}],
        "bufferViews": builder.buffer_views,
        "accessors": builder.accessors,
    }
    if gltf_animations:
        gltf["animations"] = gltf_animations

    output_path.parent.mkdir(parents=True, exist_ok=True)
    _write_glb(output_path, gltf, bytes(builder.bin))
    return SkinnedExport(
        name=name,
        file=str(output_path.name),
        verts=len(vertices),
        faces=face_count,
        bones=len(joint_nodes),
        mesh=_safe_mesh_name(mesh, name),
        root_bone=root_bone_name,
        submesh_order=_material_base_names(smr, char_id, source_ids),
        animations=animation_summaries,
    )


def _write_glb(path: Path, gltf: dict[str, Any], binary: bytes) -> None:
    json_bytes = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_pad = (-len(json_bytes)) % 4
    bin_pad = (-len(binary)) % 4
    json_chunk = json_bytes + b" " * json_pad
    bin_chunk = binary + b"\x00" * bin_pad
    total_length = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    with path.open("wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total_length))
        fh.write(struct.pack("<I4s", len(json_chunk), b"JSON"))
        fh.write(json_chunk)
        fh.write(struct.pack("<I4s", len(bin_chunk), b"BIN\x00"))
        fh.write(bin_chunk)


def _renderer_toggle_clips_for_go(
    go_name: str,
    animations: Iterable[DecodedAnimation] | None,
) -> list[dict[str, Any]]:
    """Collect per-clip Renderer.m_Enabled timelines targeting `go_name`.

    Returns a list of `{name, samples: [{time, enabled}]}` entries, one per
    AnimationClip that references this GameObject's renderer in a generic
    binding. Constant-value curves are preserved verbatim; the runtime
    consumes the literal samples and does not infer behavior from clip
    names.
    """
    if not go_name or not animations:
        return []
    out: list[dict[str, Any]] = []
    for animation in animations:
        toggles = getattr(animation, "renderer_toggles", None) or {}
        samples = toggles.get(go_name)
        if not samples:
            continue
        out.append(
            {
                "name": animation.name,
                "samples": [
                    {"time": float(t), "enabled": bool(v)} for t, v in samples
                ],
            }
        )
    out.sort(key=lambda item: item["name"])
    return out
    if not go_name or not animations:
        return []
    out: list[dict[str, Any]] = []
    for animation in animations:
        toggles = getattr(animation, "renderer_toggles", None) or {}
        samples = toggles.get(go_name)
        if not samples:
            continue
        out.append(
            {
                "name": animation.name,
                "samples": [
                    {"time": float(t), "enabled": bool(v)} for t, v in samples
                ],
            }
        )
    out.sort(key=lambda item: item["name"])
    return out


def export_character_skinned_assets(
    env: Any,
    char_id: str,
    output_dir: Path,
    *,
    animations: list[DecodedAnimation] | None = None,
    avatar_paths: Iterable[str] | None = None,
    source_ids: Iterable[str] | None = None,
) -> list[dict[str, Any]]:
    skinned_dir = output_dir / "skinned"
    exported: list[dict[str, Any]] = []
    candidate_order: list[str] = []
    candidates: dict[str, dict[str, Any]] = {}

    # The Unity AnimationClip events Ani(Enable|Disable)ChildRenderer use
    # the GameObject's sibling index inside its parent Transform to
    # identify the renderer. Resolve that per-SMR from the SMR's actual
    # parent transform — a global name -> index map collides when multiple
    # prefab variants (Battle vs Scenario) reuse a sibling slot for
    # different GameObjects (e.g. CH0334 Weapon_02 wing vs Arms_Body).
    def _resolve_child_index_for_smr(smr) -> int | None:
        try:
            owner_go = smr.m_GameObject.read()
            owner_tr_ref = getattr(owner_go, "m_Transform", None) or getattr(
                owner_go, "m_Component", None
            )
        except Exception:
            return None
        try:
            if owner_tr_ref is None:
                return None
            if hasattr(owner_tr_ref, "read"):
                owner_tr = owner_tr_ref.read()
            else:
                # Older UnityPy exposes Components as a list of (clsId, ptr)
                # pairs; pick the first Transform-like entry.
                owner_tr = None
                for entry in owner_tr_ref:
                    try:
                        cand = entry[1].read() if isinstance(entry, (tuple, list)) else entry.read()
                    except Exception:
                        continue
                    if hasattr(cand, "m_Father") and hasattr(cand, "m_Children"):
                        owner_tr = cand
                        break
                if owner_tr is None:
                    return None
        except Exception:
            return None

        owner_pid = _transform_path_id(owner_tr)
        if not owner_pid:
            return None
        parent_tr = _parent_transform(owner_tr)
        if parent_tr is None:
            return None
        try:
            siblings = list(getattr(parent_tr, "m_Children", []) or [])
        except Exception:
            return None
        for idx, child_ref in enumerate(siblings):
            if int(getattr(child_ref, "path_id", 0) or 0) == owner_pid:
                return idx
            try:
                child_tr = child_ref.read()
            except Exception:
                continue
            if _transform_path_id(child_tr) == owner_pid:
                return idx
        return None

    for obj in env.objects:
        if obj.type.name != "SkinnedMeshRenderer":
            continue
        try:
            smr = obj.read()
            go_name = str(smr.m_GameObject.read().m_Name)
            mesh = smr.m_Mesh.read()
            mesh_name = str(getattr(mesh, "m_Name", "") or go_name)
            owner_path = _skinned_renderer_path(smr)
            root = smr.m_RootBone.read() if getattr(smr.m_RootBone, "path_id", 0) else None
            root_bone_path = _transform_full_path(root) if root is not None else ""
        except Exception:
            continue

        if not _is_skinned_export_candidate(char_id, go_name, mesh_name, owner_path, avatar_paths, source_ids):
            continue

        out_name = _skinned_export_name(char_id, go_name, mesh_name, source_ids)
        score = _skinned_export_candidate_score(
            char_id,
            owner_path,
            root_bone_path,
            avatar_paths,
            source_ids,
            export_name=out_name,
            go_name=go_name,
            mesh_name=mesh_name,
        )
        if out_name not in candidates:
            candidate_order.append(out_name)
            candidates[out_name] = {
                "score": score,
                "smr": smr,
                "go_name": go_name,
                "mesh_name": mesh_name,
                "owner_path": owner_path,
            }
        elif score > candidates[out_name]["score"]:
            candidates[out_name] = {
                "score": score,
                "smr": smr,
                "go_name": go_name,
                "mesh_name": mesh_name,
                "owner_path": owner_path,
            }

    for out_name in candidate_order:
        candidate = candidates[out_name]
        smr = candidate["smr"]
        go_name = candidate["go_name"]
        mesh_name = candidate["mesh_name"]
        owner_path = candidate["owner_path"]
        out_path = skinned_dir / f"{char_id}_{out_name}.glb"
        try:
            item = export_skinned_smr(
                out_path,
                smr,
                out_name,
                char_id=char_id,
                animations=animations,
                source_ids=source_ids,
            )
            data = item.__dict__.copy()
            data["file"] = f"skinned/{item.file}"
            initial_visible = _skinned_renderer_initial_visible(smr)
            initial_override = _initial_renderer_visible_override_for_export_name(out_name, char_id)
            if initial_override is not None:
                initial_visible = initial_override
            data["initial_renderer_visible"] = initial_visible
            visibility = _truth_visibility_rule_for_export(
                out_name,
                char_id,
                animations,
                _skinned_renderer_joint_local_channels(smr),
            )
            if visibility:
                data["visibility"] = visibility
            if _event_renderer_controlled_for_export_name(out_name, char_id):
                data["event_renderer_controlled"] = True
            if _ignore_vertex_colors_for_export_name(out_name, char_id):
                data["ignore_vertex_colors"] = True
            toggle_clips = _renderer_toggle_clips_for_go(go_name, animations)
            if toggle_clips:
                data["renderer_toggle_clips"] = toggle_clips
            child_idx = _resolve_child_index_for_smr(smr)
            if child_idx is not None:
                data["child_index"] = child_idx
                data["go_name"] = go_name
            if _is_ch0091_cafe_beach_prop_outline(char_id, go_name, mesh_name, owner_path):
                data["parent_bone"] = "bone_root"
                data["shared_skeleton_root"] = True
                data["shared_skeleton_parent_part"] = "Body"
            exported.append(data)
            print(
                f"  [Skin] {out_name}: {item.verts} verts, {item.faces} tris, "
                f"{item.bones} bones, {len(item.animations)} animations"
            )
        except Exception as exc:
            print(f"  [Skin] {go_name}/{mesh_name} - FAILED: {exc}")

    return exported
