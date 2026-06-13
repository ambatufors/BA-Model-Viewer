from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import trimesh
import UnityPy

try:
    from tools.bundle_resolver import character_bundle_keys, character_object_ids
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from bundle_resolver import character_bundle_keys, character_object_ids


DEFAULT_ASSETBUNDLES = Path(
    r"D:\BAJP\YostarGames\BlueArchive_JP\BlueArchive_Data\StreamingAssets\AssetBundles"
)
DEFAULT_OUTPUT_ROOT = Path(__file__).resolve().parents[1] / "extracted_models"
COMMON_TEXTURE_BUNDLE = "assets-_mx-characters-_mxcommon-_mxdependency-textures-2025-07-02_assets_all_2925187272.bundle"
KNOWN_MESH_DEPS = {
    "ch0060": ["tsurugi_original"],
}
HALO_OBJECT_ALIASES = {
    "CH0300": ("ch0225",),
}
DEPTH_FLIP_HALO_CHARS = {"CH0060", "CH0069", "CH0326"}
BAKED_GEOMETRY_HALO_CHARS = {"CH0335"}
FORCE_SOURCE_TRANSFORM_HALO_CHARS = {"CH0145"}
FORCE_VIEWER_DOWN_HALO_CHARS = {"CH0145"}
VIEWER_PITCH_DOWN_HALO_DEG = {"CH0145": -60.0}
PRESERVE_DEPTH_HALO_CHARS = {"CH0145", "CH0304"}
CIRCULAR_SCALE_ONLY_HALO_CHARS = {"CH0220"}
VIEWER_GROUP_ROTATION = np.array(
    [
        [1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, -1.0, 0.0],
    ],
    dtype=np.float64,
)
VIEWER_UP = np.array([0.0, 1.0, 0.0], dtype=np.float64)
HALO_RAW_TILT_TRANSFORM_THRESHOLD_DEG = 70.0
HALO_DEPTH_HEAD_THRESHOLD_DEG = 10.0
TRANSIENT_HALO_SOURCE_RE = re.compile(r"(?:cutin|motion|appear|spawn|timeline|camera|interaction|effect)", re.I)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export static halo MeshRenderer objects into extracted_models.")
    parser.add_argument("characters", nargs="+", help="Character ids, e.g. CH0069 CH0326")
    parser.add_argument("--assetbundles", type=Path, default=DEFAULT_ASSETBUNDLES)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--metadata-only", action="store_true", help="Update manifest halo metadata without rewriting GLB files.")
    return parser.parse_args()


def find_bundles(root: Path, char_id: str) -> list[Path]:
    bundles = []
    tokens = []
    for lower in character_bundle_keys(char_id):
        tokens.extend((
            f"characters-{lower}-",
            f"characters-{lower}_",
            f"character-{lower}-",
            f"character-{lower}_",
        ))
    for path in root.glob("*.bundle"):
        name = path.name.lower()
        if not any(token in name for token in tokens):
            continue
        if any(tag in name for tag in ("meshes", "prefabs", "materials")):
            bundles.append(path)
    for dep in KNOWN_MESH_DEPS.get(lower, []):
        bundles.extend(root.glob(f"assets-_mx-characters-{dep}-_mxdependency-meshes-*.bundle"))
    bundles = sorted(bundles, key=lambda p: p.name.lower())
    return resolve_external_mesh_bundles(root, bundles)


def object_keys(char_id: str) -> tuple[str, ...]:
    return tuple(source.lower() for source in character_object_ids(char_id))


def halo_object_keys(char_id: str) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(
            (
                *object_keys(char_id),
                *HALO_OBJECT_ALIASES.get(char_id.upper(), ()),
            )
        )
    )


def object_key_matches(name: str, key: str) -> bool:
    lowered = name.lower()
    return lowered == key or lowered.startswith(f"{key}_")


def any_object_key_matches(name: str, keys: tuple[str, ...]) -> bool:
    return any(object_key_matches(name, key) for key in keys)


def bundle_cabs(bundle: Path) -> set[str]:
    env = UnityPy.load(str(bundle))
    cabs: set[str] = set()
    for bf in env.files.values():
        if not hasattr(bf, "files"):
            continue
        for key in bf.files.keys():
            cabs.add(str(key).lower().removesuffix(".ress").removesuffix(".resS"))
    return cabs


def external_cabs(bundle: Path) -> set[str]:
    env = UnityPy.load(str(bundle))
    cabs: set[str] = set()
    for bf in env.files.values():
        if not hasattr(bf, "files"):
            continue
        for sf in bf.files.values():
            for ext in getattr(sf, "externals", []):
                match = re.search(r"CAB-([0-9a-f]{32})", str(ext), re.I)
                if match:
                    cabs.add("cab-" + match.group(1).lower())
    return cabs


def resolve_external_mesh_bundles(root: Path, bundles: list[Path]) -> list[Path]:
    loaded = set()
    wanted = set()
    for bundle in bundles:
        try:
            loaded.update(bundle_cabs(bundle))
            wanted.update(external_cabs(bundle))
        except Exception:
            continue

    missing = wanted - loaded
    if not missing:
        return bundles

    found: list[Path] = []
    for path in root.glob("*meshes*.bundle"):
        if path in bundles:
            continue
        try:
            cabs = bundle_cabs(path)
        except Exception:
            continue
        if cabs & missing:
            found.append(path)
            missing -= cabs
            if not missing:
                break

    return sorted([*bundles, *found], key=lambda p: p.name.lower())


def read_transform_data(transform) -> dict | None:
    try:
        pos = transform.m_LocalPosition
        rot = transform.m_LocalRotation
        scale = transform.m_LocalScale
        return {
            "position": {"x": pos.x, "y": pos.y, "z": pos.z},
            "rotation": {"x": rot.x, "y": rot.y, "z": rot.z, "w": rot.w},
            "scale": {"x": scale.x, "y": scale.y, "z": scale.z},
        }
    except Exception:
        return None


def find_named_transform(env, target_name: str) -> dict | None:
    for obj in env.objects:
        if obj.type.name not in ("Transform", "RectTransform"):
            continue
        try:
            data = obj.read()
            go = data.m_GameObject.read()
            if go.m_Name != target_name:
                continue
            transform = read_transform_data(data)
            if transform is not None:
                transform["source_path"] = " <- ".join(transform_chain_names(data))
                transform["name"] = go.m_Name
            return transform
        except Exception:
            continue
    return None


def transform_position(position: np.ndarray) -> dict:
    return {
        "x": float(position[0]),
        "y": float(position[1]),
        "z": float(position[2]),
    }


def matrix_scale(matrix: np.ndarray) -> dict:
    cols = matrix[:3, :3]
    return {
        "x": float(np.linalg.norm(cols[:, 0])),
        "y": float(np.linalg.norm(cols[:, 1])),
        "z": float(np.linalg.norm(cols[:, 2])),
    }


def matrix_to_quaternion(matrix: np.ndarray) -> dict:
    rot = np.array(matrix, dtype=np.float64, copy=True)
    for idx in range(3):
        norm = float(np.linalg.norm(rot[:, idx]))
        if norm > 1e-12:
            rot[:, idx] /= norm

    m00, m01, m02 = rot[0, 0], rot[0, 1], rot[0, 2]
    m10, m11, m12 = rot[1, 0], rot[1, 1], rot[1, 2]
    m20, m21, m22 = rot[2, 0], rot[2, 1], rot[2, 2]
    trace = m00 + m11 + m22
    if trace > 0.0:
        s = float(np.sqrt(trace + 1.0) * 2.0)
        return {
            "x": float((m21 - m12) / s),
            "y": float((m02 - m20) / s),
            "z": float((m10 - m01) / s),
            "w": float(0.25 * s),
        }
    if m00 > m11 and m00 > m22:
        s = float(np.sqrt(1.0 + m00 - m11 - m22) * 2.0)
        return {
            "x": float(0.25 * s),
            "y": float((m01 + m10) / s),
            "z": float((m02 + m20) / s),
            "w": float((m21 - m12) / s),
        }
    if m11 > m22:
        s = float(np.sqrt(1.0 + m11 - m00 - m22) * 2.0)
        return {
            "x": float((m01 + m10) / s),
            "y": float(0.25 * s),
            "z": float((m12 + m21) / s),
            "w": float((m02 - m20) / s),
        }
    s = float(np.sqrt(1.0 + m22 - m00 - m11) * 2.0)
    return {
        "x": float((m02 + m20) / s),
        "y": float((m12 + m21) / s),
        "z": float(0.25 * s),
        "w": float((m10 - m01) / s),
    }


def transform_from_matrix(
    matrix: np.ndarray,
    source_path: str | None = None,
    name: str | None = None,
    coordinate_space: str | None = None,
) -> dict:
    data = {
        "position": transform_position(matrix[:3, 3]),
        "rotation": matrix_to_quaternion(matrix[:3, :3]),
        "scale": matrix_scale(matrix),
    }
    if source_path is not None:
        data["source_path"] = source_path
    if name is not None:
        data["name"] = name
    if coordinate_space is not None:
        data["coordinate_space"] = coordinate_space
    return data


def find_head_matrix(env, char_id: str) -> tuple[np.ndarray, list[str]] | None:
    candidates: list[tuple[int, np.ndarray, list[str]]] = []
    keys = object_keys(char_id)
    for obj in env.objects:
        if obj.type.name not in ("Transform", "RectTransform"):
            continue
        try:
            data = obj.read()
            go = data.m_GameObject.read()
            if go.m_Name != "Bip001 Head":
                continue
            chain_names = transform_chain_names(data)
            lower_chain = [name.lower() for name in chain_names]
            matrix = prefab_to_mesh_basis(composed_transform_matrix(data))
        except Exception:
            continue

        score = 0
        if any(f"{key}_mesh" in lower_chain for key in keys):
            score += 100
        if any(any_object_key_matches(name, keys) for name in lower_chain):
            score += 30
        if any("cutin" in name for name in lower_chain):
            score -= 40
        if any(name.startswith("fx_mesh") for name in lower_chain):
            score -= 20

        candidates.append((score, matrix, chain_names))

    if not candidates:
        return None
    _score, matrix, chain_names = max(candidates, key=lambda item: item[0])
    return matrix, chain_names


def find_head_transform(env, char_id: str) -> dict | None:
    candidate = find_head_matrix(env, char_id)
    if candidate is None:
        return None
    matrix, chain_names = candidate
    return {
        "bone": "Bip001 Head",
        "position": transform_position(matrix[:3, 3]),
        "source_path": " <- ".join(chain_names),
    }


def vector3_from_typetree(data) -> np.ndarray | None:
    if data is None:
        return None
    try:
        return np.array([data["x"], data["y"], data["z"]], dtype=np.float64)
    except (KeyError, TypeError):
        try:
            return np.array([data.x, data.y, data.z], dtype=np.float64)
        except AttributeError:
            return None


def typetree_vector(data) -> dict | None:
    vec = vector3_from_typetree(data)
    return None if vec is None else transform_position(vec)


def typetree_quaternion(data) -> dict | None:
    if data is None:
        return None
    try:
        return {"x": float(data["x"]), "y": float(data["y"]), "z": float(data["z"]), "w": float(data["w"])}
    except (KeyError, TypeError):
        try:
            return {"x": float(data.x), "y": float(data.y), "z": float(data.z), "w": float(data.w)}
        except AttributeError:
            return None


def source_is_transient(source_path: str | None) -> bool:
    return bool(source_path and TRANSIENT_HALO_SOURCE_RE.search(source_path))


def follower_relative_to_viewer_head_basis(relative: np.ndarray) -> np.ndarray:
    # Follower offsets are stored in source/prefab axis order; convert to the viewer head basis
    # before applying the exported Bip001 Head matrix.
    return np.array([relative[0], relative[2], relative[1]], dtype=np.float64)


def resolve_ptr_name(by_path: dict[int | None, object], ptr) -> str | None:
    try:
        path_id = ptr.get("m_PathID")
    except AttributeError:
        path_id = getattr(ptr, "path_id", getattr(ptr, "m_PathID", None))
    target_obj = by_path.get(path_id)
    if target_obj is None:
        return None
    try:
        if target_obj.type.name in ("Transform", "RectTransform"):
            return target_obj.read().m_GameObject.read().m_Name
        if target_obj.type.name == "GameObject":
            return target_obj.read().m_Name
        return target_obj.type.name
    except Exception:
        return None


def halo_follow_candidate_score(char_id: str, chain_names: list[str], follow_target: str | None) -> int:
    keys = object_keys(char_id)
    lower_chain = [name.lower() for name in chain_names]
    source_path = " <- ".join(chain_names)
    score = 0
    if lower_chain and lower_chain[0] == "haloroot":
        score += 100
    if follow_target == "Bip001 Head":
        score += 50
    if any(name == f"cafe_{key}" for key in keys for name in lower_chain):
        score += 30
    if any(name == f"strategy_{key}" for key in keys for name in lower_chain):
        score += 25
    if any(name == f"echelon_{key}" for key in keys for name in lower_chain):
        score += 20
    if any(name == key for key in keys for name in lower_chain):
        score += 40
    elif any(any_object_key_matches(name, keys) for name in lower_chain):
        score += 10
    if source_is_transient(source_path):
        score -= 100
    return score


def find_halo_follow_data(env, char_id: str) -> dict | None:
    head_candidate = find_head_matrix(env, char_id)
    if head_candidate is None:
        return None
    head_matrix, _head_chain_names = head_candidate
    by_path = {getattr(obj, "path_id", None): obj for obj in env.objects}
    candidates: list[tuple[int, dict]] = []

    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tt = obj.read_typetree()
        except Exception:
            continue
        if "FollowTarget" not in tt or "TargetRelativePosition" not in tt:
            continue

        relative = vector3_from_typetree(tt.get("TargetRelativePosition"))
        if relative is None:
            continue
        try:
            data = obj.read()
            go = data.m_GameObject.read()
            transform = get_transform_object(go)
            chain_names = transform_chain_names(transform) if transform is not None else [go.m_Name]
        except Exception:
            continue

        if "haloroot" not in [name.lower() for name in chain_names]:
            continue

        follow_target = resolve_ptr_name(by_path, tt.get("FollowTarget"))
        score = halo_follow_candidate_score(char_id, chain_names, follow_target)
        source_path = " <- ".join(chain_names)
        relative_head_basis = follower_relative_to_viewer_head_basis(relative)
        target_position = head_matrix @ np.array(
            [relative_head_basis[0], relative_head_basis[1], relative_head_basis[2], 1.0],
            dtype=np.float64,
        )
        target_offset = head_matrix @ np.array(
            [relative_head_basis[0], relative_head_basis[1], relative_head_basis[2], 0.0],
            dtype=np.float64,
        )

        data_out = {
            "name": "HaloRoot",
            "source_path": source_path,
            "follow_target": follow_target,
            "coordinate_space": "viewer",
            "target_position": transform_position(target_position[:3]),
            "target_offset": transform_position(target_offset[:3]),
            "target_relative_position": typetree_vector(tt.get("TargetRelativePosition")),
            "clamp_min_offset": typetree_vector(tt.get("ClampMinOffset")),
            "clamp_max_offset": typetree_vector(tt.get("ClampMaxOffset")),
            "follow_position_power": tt.get("FollowPositionPower"),
            "follow_rotation_power": tt.get("FollowRotationPower"),
            "fix_y_rotation": tt.get("FixYRotation"),
            "local_forward": typetree_vector(tt.get("LocalForward")),
            "target_relative_rotation": typetree_quaternion(tt.get("TargetRelativeRotation")),
            "initial_rotation": typetree_quaternion(tt.get("InitialRotation")),
        }
        candidates.append((score, {key: value for key, value in data_out.items() if value is not None}))

    if not candidates:
        return None
    return max(candidates, key=lambda item: item[0])[1]


def find_halo_anchor_transform(env, char_id: str) -> dict | None:
    candidates: list[tuple[int, dict]] = []
    keys = object_keys(char_id)
    for obj in env.objects:
        if obj.type.name not in ("Transform", "RectTransform"):
            continue
        try:
            data = obj.read()
            go = data.m_GameObject.read()
            go_name = go.m_Name
            lower_name = go_name.lower()
            if "halo" not in lower_name:
                continue
            chain_names = transform_chain_names(data)
            lower_chain = [name.lower() for name in chain_names]
            matrix = prefab_to_mesh_basis(composed_transform_matrix(data))
        except Exception:
            continue

        score = 0
        if lower_name.endswith("_halo"):
            score += 50
        if lower_name != "haloroot":
            score += 10
        if any(name == "haloroot" for name in lower_chain):
            score += 30
        if any(any_object_key_matches(name, keys) for name in lower_chain):
            score += 20
        if lower_chain and lower_chain[-1] in keys:
            score += 15
        if not np.allclose(matrix[:3, 3], np.zeros(3, dtype=np.float64), atol=1e-6):
            score += 25
        if len(lower_chain) >= 2:
            score += 5
        if any("cutin" in name for name in lower_chain):
            score -= 20

        candidates.append(
            (
                score,
                transform_from_matrix(matrix, " <- ".join(chain_names), go_name, coordinate_space="viewer"),
            )
        )

    if not candidates:
        return find_named_transform(env, "HaloRoot")
    return max(candidates, key=lambda item: item[0])[1]


def get_transform_object(go):
    for pair in getattr(go, "m_Components", getattr(go, "m_Component", [])):
        try:
            comp = pair.component.read()
        except Exception:
            try:
                comp = pair.read()
            except Exception:
                continue
        if comp.__class__.__name__ in ("Transform", "RectTransform"):
            return comp
    return None


def quaternion_matrix(rot) -> np.ndarray:
    x, y, z, w = rot.x, rot.y, rot.z, rot.w
    norm = x * x + y * y + z * z + w * w
    if norm < 1e-8:
        return np.eye(3, dtype=np.float64)
    scale = 2.0 / norm
    xx, yy, zz = x * x * scale, y * y * scale, z * z * scale
    xy, xz, yz = x * y * scale, x * z * scale, y * z * scale
    wx, wy, wz = w * x * scale, w * y * scale, w * z * scale
    return np.array(
        [
            [1.0 - yy - zz, xy - wz, xz + wy],
            [xy + wz, 1.0 - xx - zz, yz - wx],
            [xz - wy, yz + wx, 1.0 - xx - yy],
        ],
        dtype=np.float64,
    )


def transform_matrix(transform) -> np.ndarray:
    pos = transform.m_LocalPosition
    scale = transform.m_LocalScale
    mat = np.eye(4, dtype=np.float64)
    mat[:3, :3] = quaternion_matrix(transform.m_LocalRotation) @ np.diag([scale.x, scale.y, scale.z])
    mat[:3, 3] = [pos.x, pos.y, pos.z]
    return mat


def composed_transform_matrix(transform) -> np.ndarray:
    chain = []
    current = transform
    seen: set[int] = set()
    while current is not None:
        path_id = getattr(current, "path_id", None)
        if path_id in seen:
            break
        if path_id is not None:
            seen.add(path_id)
        chain.append(current)
        try:
            father = current.m_Father
            current = father.read() if getattr(father, "path_id", 0) else None
        except Exception:
            current = None

    mat = np.eye(4, dtype=np.float64)
    for item in reversed(chain):
        mat = mat @ transform_matrix(item)
    return mat


def transform_chain_names(transform) -> list[str]:
    chain: list[str] = []
    current = transform
    seen: set[int] = set()
    while current is not None:
        path_id = getattr(current, "path_id", None)
        if path_id in seen:
            break
        if path_id is not None:
            seen.add(path_id)
        try:
            go = current.m_GameObject.read()
            chain.append(go.m_Name)
            father = current.m_Father
            current = father.read() if getattr(father, "path_id", 0) else None
        except Exception:
            break
    return chain


def prefab_to_mesh_basis(matrix: np.ndarray) -> np.ndarray:
    basis = np.array(
        [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    return basis @ matrix @ basis.T


def normalize_vector(vec: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vec))
    if norm < 1e-12:
        return vec.copy()
    return vec / norm


def plane_normal(points: np.ndarray) -> np.ndarray | None:
    if len(points) < 3:
        return None
    centered = points - points.mean(axis=0)
    try:
        eigvals, eigvecs = np.linalg.eigh(np.cov(centered.T))
    except Exception:
        return None
    normal = eigvecs[:, int(np.argmin(eigvals))]
    if np.linalg.norm(normal) < 1e-12:
        return None
    return normal


def transform_points(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    points_h = np.c_[points, np.ones(len(points), dtype=np.float64)]
    return (matrix @ points_h.T).T[:, :3]


def transform_normal(matrix: np.ndarray, normal: np.ndarray) -> np.ndarray:
    try:
        normal_matrix = np.linalg.inv(matrix[:3, :3]).T
    except np.linalg.LinAlgError:
        normal_matrix = matrix[:3, :3]
    return normalize_vector(normal_matrix @ normal)


def average_vertex_normal(tri: trimesh.Trimesh | None) -> np.ndarray | None:
    if tri is None:
        return None
    normals = np.asarray(getattr(tri, "vertex_normals", []), dtype=np.float64)
    if normals.ndim != 2 or normals.shape[1] != 3 or len(normals) == 0:
        return None
    normal = normals.mean(axis=0)
    if np.linalg.norm(normal) < 1e-8:
        return None
    return normalize_vector(normal)


def rotation_between_vectors(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    source = normalize_vector(source)
    target = normalize_vector(target)
    dot = float(np.clip(np.dot(source, target), -1.0, 1.0))
    if dot > 1.0 - 1e-8:
        return np.eye(3, dtype=np.float64)
    axis = np.cross(source, target)
    axis_len = float(np.linalg.norm(axis))
    if dot < -1.0 + 1e-8:
        fallback = np.array([1.0, 0.0, 0.0], dtype=np.float64)
        if abs(float(np.dot(source, fallback))) > 0.9:
            fallback = np.array([0.0, 1.0, 0.0], dtype=np.float64)
        axis = normalize_vector(np.cross(source, fallback))
        return -np.eye(3, dtype=np.float64) + 2.0 * np.outer(axis, axis)
    if axis_len < 1e-8:
        return np.eye(3, dtype=np.float64)
    axis /= axis_len
    x, y, z = axis
    skew = np.array(
        [[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]],
        dtype=np.float64,
    )
    return (
        np.eye(3, dtype=np.float64)
        + skew * axis_len
        + (skew @ skew) * (1.0 - dot)
    )


def force_viewer_down_halo_matrix(
    matrix: np.ndarray,
    tri: trimesh.Trimesh | None,
) -> np.ndarray:
    normal = average_vertex_normal(tri)
    if normal is None:
        return matrix
    current = transform_normal(matrix, normal)
    if float((VIEWER_GROUP_ROTATION @ current)[1]) <= 0.0:
        return matrix
    target = current.copy()
    target[2] = -abs(float(target[2]))
    if np.allclose(current, target, atol=1e-8):
        return matrix
    out = matrix.copy()
    out[:3, :3] = rotation_between_vectors(current, target) @ out[:3, :3]
    return out


def apply_viewer_x_rotation(matrix: np.ndarray, degrees: float) -> np.ndarray:
    angle = np.radians(float(degrees))
    cos_v = float(np.cos(angle))
    sin_v = float(np.sin(angle))
    viewer_rotation = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, cos_v, -sin_v],
            [0.0, sin_v, cos_v],
        ],
        dtype=np.float64,
    )
    out = matrix.copy()
    out[:3, :3] = (
        VIEWER_GROUP_ROTATION.T
        @ viewer_rotation
        @ VIEWER_GROUP_ROTATION
        @ out[:3, :3]
    )
    return out


def tilt_to_viewer_up(points: np.ndarray) -> float | None:
    normal = plane_normal(points)
    if normal is None:
        return None
    normal = normalize_vector(VIEWER_GROUP_ROTATION @ normal)
    dot = abs(float(np.dot(normal, VIEWER_UP)))
    return float(np.degrees(np.arccos(np.clip(dot, -1.0, 1.0))))


def raw_halo_viewer_tilt(tri: trimesh.Trimesh) -> float | None:
    return tilt_to_viewer_up(np.asarray(tri.vertices, dtype=np.float64))


def halo_mesh_should_use_transform(tri: trimesh.Trimesh | None, char_id: str | None = None) -> bool:
    if char_id and char_id.upper() in FORCE_SOURCE_TRANSFORM_HALO_CHARS:
        return True
    if tri is None:
        return True
    raw_tilt = raw_halo_viewer_tilt(tri)
    if raw_tilt is None:
        return True
    return raw_tilt >= HALO_RAW_TILT_TRANSFORM_THRESHOLD_DEG


def scale_only_matrix(matrix: np.ndarray) -> np.ndarray | None:
    scale = matrix_scale(matrix)
    values = np.array([scale["x"], scale["y"], scale["z"]], dtype=np.float64)
    if np.allclose(values, np.ones(3, dtype=np.float64), atol=1e-6):
        return None
    out = np.eye(4, dtype=np.float64)
    out[0, 0], out[1, 1], out[2, 2] = values
    return out


def circular_scale_only_matrix(
    matrix: np.ndarray,
    tri: trimesh.Trimesh | None,
) -> np.ndarray | None:
    out = scale_only_matrix(matrix)
    if tri is None:
        return out

    points = np.asarray(getattr(tri, "vertices", []), dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 3 or len(points) == 0:
        return out

    raw_extents = np.ptp(points, axis=0)
    if not np.all(np.isfinite(raw_extents)) or np.count_nonzero(raw_extents > 1e-8) < 2:
        return out

    depth_axis = int(np.argmin(raw_extents))
    plane_axes = [axis for axis in range(3) if axis != depth_axis]
    plane_scales = np.array([abs(float(out[axis, axis])) for axis in plane_axes], dtype=np.float64)
    if not np.all(np.isfinite(plane_scales)) or np.any(plane_scales <= 1e-8):
        return out

    target = float(np.min(plane_scales))
    for axis in plane_axes:
        out[axis, axis] = np.copysign(target, out[axis, axis])
    return out


def circular_preserve_rotation_matrix(
    matrix: np.ndarray,
    tri: trimesh.Trimesh | None,
) -> np.ndarray | None:
    if tri is None:
        return matrix.copy()

    points = np.asarray(getattr(tri, "vertices", []), dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 3 or len(points) == 0:
        return matrix.copy()

    raw_extents = np.ptp(points, axis=0)
    if not np.all(np.isfinite(raw_extents)) or np.count_nonzero(raw_extents > 1e-8) < 2:
        return matrix.copy()

    out = matrix.copy()
    depth_axis = int(np.argmin(raw_extents))
    plane_axes = [axis for axis in range(3) if axis != depth_axis]
    plane_scales = np.array(
        [np.linalg.norm(out[:3, axis]) for axis in plane_axes],
        dtype=np.float64,
    )
    if not np.all(np.isfinite(plane_scales)) or np.any(plane_scales <= 1e-8):
        return out

    target = float(np.min(plane_scales))
    for axis in plane_axes:
        column = out[:3, axis]
        length = float(np.linalg.norm(column))
        if length > 1e-12:
            out[:3, axis] = column / length * target
    return out


def flip_viewer_halo_face_down(
    matrix: np.ndarray,
    tri: trimesh.Trimesh | None,
) -> np.ndarray:
    normal = average_vertex_normal(tri)
    if normal is None:
        normal = plane_normal(np.asarray(getattr(tri, "vertices", []), dtype=np.float64))
    flipped = matrix @ face_direction_flip_matrix(tri)
    if normal is None:
        return flipped
    viewer_normal = VIEWER_GROUP_ROTATION @ transform_normal(flipped, normal)
    if float(viewer_normal[1]) <= 0.0:
        return flipped
    return matrix


def average_face_normal(tri: trimesh.Trimesh | None) -> np.ndarray | None:
    if tri is None:
        return None
    normals = np.asarray(getattr(tri, "face_normals", []), dtype=np.float64)
    areas = np.asarray(getattr(tri, "area_faces", []), dtype=np.float64)
    if normals.ndim != 2 or normals.shape[1] != 3 or len(normals) == 0:
        return None
    if areas.ndim != 1 or len(areas) != len(normals):
        areas = np.ones(len(normals), dtype=np.float64)
    weighted = (normals * areas[:, None]).sum(axis=0)
    return normalize_vector(weighted)


def predicted_export_viewer_normal(matrix: np.ndarray, source_normal: np.ndarray) -> np.ndarray:
    normal = VIEWER_GROUP_ROTATION @ transform_normal(matrix, source_normal)
    # trimesh's glTF export preserves geometry winding while node transforms
    # carry handedness. Positive-determinant node transforms read back with the
    # opposite face direction compared with Unity's OBJ normal basis; negative
    # determinant transforms already include that handedness flip.
    determinant = float(np.linalg.det(matrix[:3, :3]))
    if determinant >= 0.0:
        normal = -normal
    return normalize_vector(normal)


def face_direction_flip_matrix(tri: trimesh.Trimesh | None) -> np.ndarray:
    out = np.eye(4, dtype=np.float64)
    if tri is None:
        out[0, 0] = 1.0
        out[1, 1] = -1.0
        out[2, 2] = -1.0
        return out

    points = np.asarray(getattr(tri, "vertices", []), dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 3 or len(points) == 0:
        out[0, 0] = 1.0
        out[1, 1] = -1.0
        out[2, 2] = -1.0
        return out

    extents = np.ptp(points, axis=0)
    depth_axis = int(np.argmin(extents))
    plane_axes = [axis for axis in range(3) if axis != depth_axis]
    axis = max(plane_axes, key=lambda idx: float(extents[idx]))
    for idx in range(3):
        out[idx, idx] = 1.0 if idx == axis else -1.0
    return out


def preserve_source_face_direction(
    source_matrix: np.ndarray,
    simplified_matrix: np.ndarray | None,
    tri: trimesh.Trimesh | None,
) -> np.ndarray | None:
    if simplified_matrix is None:
        return None
    source_normal = average_face_normal(tri)
    if source_normal is None:
        return simplified_matrix

    source_viewer_normal = predicted_export_viewer_normal(source_matrix, source_normal)
    simplified_viewer_normal = predicted_export_viewer_normal(simplified_matrix, source_normal)
    if float(np.dot(source_viewer_normal, simplified_viewer_normal)) >= 0.0:
        return simplified_matrix
    return simplified_matrix @ face_direction_flip_matrix(tri)


def mesh_world_matrix(mesh_filter, char_id: str, tri: trimesh.Trimesh | None = None) -> np.ndarray | None:
    try:
        char_key = char_id.upper()
        if char_key in BAKED_GEOMETRY_HALO_CHARS:
            return None

        go = mesh_filter.m_GameObject.read()
        transform = get_transform_object(go)
        if transform is None:
            return None
        matrix = composed_transform_matrix(transform)
        if char_key in DEPTH_FLIP_HALO_CHARS:
            # Unity Z becomes viewer depth after basis swap + scene -90deg X.
            # Flip source Z so halo stays behind head, not in front.
            matrix[2, 3] *= -1.0
        matrix = prefab_to_mesh_basis(matrix)
        if char_key in FORCE_VIEWER_DOWN_HALO_CHARS:
            matrix = force_viewer_down_halo_matrix(matrix, tri)
        if char_key in VIEWER_PITCH_DOWN_HALO_DEG:
            matrix = apply_viewer_x_rotation(
                matrix,
                VIEWER_PITCH_DOWN_HALO_DEG[char_key],
            )
        if not halo_mesh_should_use_transform(tri, char_key):
            if char_key in CIRCULAR_SCALE_ONLY_HALO_CHARS:
                return flip_viewer_halo_face_down(
                    circular_preserve_rotation_matrix(matrix, tri),
                    tri,
                )
            return preserve_source_face_direction(matrix, scale_only_matrix(matrix), tri)
        return matrix
    except Exception:
        return None


def safe_mesh_name(go_name: str, char_id: str) -> str:
    if go_name.lower().endswith("_original_halo"):
        return "Halo"
    # Alias-keyed halo (e.g. hoshino_swimsuit_halo for CH0091): collapse to
    # the canonical "Halo" slot so it dedupes against the original-halo
    # variant pulled in via the common bundle, and the per-char selector
    # picks the alias-keyed candidate (higher score) over the unrelated
    # *_Original_Halo from a shared CAB.
    keys = halo_object_keys(char_id)
    if any(go_name.lower() == f"{key}_halo" for key in keys):
        return "Halo"
    name = re.sub(r"[^A-Za-z0-9_]+", "_", go_name).strip("_")
    if name.lower().startswith(char_id.lower() + "_"):
        name = name[len(char_id) + 1 :]
    return name or "Halo"


def obj_to_trimesh(mesh) -> trimesh.Trimesh | None:
    obj_text = mesh.export()
    if isinstance(obj_text, bytes):
        obj_text = obj_text.decode("utf-8")

    vertices: list[list[float]] = []
    tex_coords: list[list[float]] = []
    normals: list[list[float]] = []
    faces_list: list[str] = []

    for line in obj_text.splitlines():
        if line.startswith("v "):
            vertices.append([float(x) for x in line[2:].split()])
        elif line.startswith("vt "):
            tex_coords.append([float(x) for x in line[3:].split()])
        elif line.startswith("vn "):
            normals.append([float(x) for x in line[3:].split()])
        elif line.startswith("f "):
            faces_list.append(line[2:].strip())

    if not vertices or not faces_list:
        return None

    verts_arr = np.array(vertices, dtype=np.float32)
    uvs_arr = np.array(tex_coords, dtype=np.float32) if tex_coords else None
    normals_arr = np.array(normals, dtype=np.float32) if normals else None

    used: dict[tuple[int, int, int], int] = {}
    new_verts: list[np.ndarray] = []
    new_uvs: list[np.ndarray | list[float]] = []
    new_normals: list[np.ndarray | list[float]] = []
    face_indices: list[list[int]] = []

    for face_line in faces_list:
        face: list[int] = []
        for part in face_line.split():
            idx = part.split("/")
            vi = int(idx[0]) - 1
            ti = int(idx[1]) - 1 if len(idx) > 1 and idx[1] else vi
            ni = int(idx[2]) - 1 if len(idx) > 2 and idx[2] else vi
            key = (vi, ti, ni)
            if key not in used:
                used[key] = len(new_verts)
                new_verts.append(verts_arr[vi])
                new_uvs.append(uvs_arr[ti] if uvs_arr is not None and ti < len(uvs_arr) else [0.0, 0.0])
                new_normals.append(normals_arr[ni] if normals_arr is not None and ni < len(normals_arr) else [0.0, 1.0, 0.0])
            face.append(used[key])
        face_indices.append(face)

    out = trimesh.Trimesh(
        vertices=np.array(new_verts, dtype=np.float32),
        faces=np.array(face_indices, dtype=np.int32),
        vertex_normals=np.array(new_normals, dtype=np.float32),
        process=False,
    )
    out.visual = trimesh.visual.TextureVisuals(
        uv=np.array(new_uvs, dtype=np.float32),
        material=trimesh.visual.material.SimpleMaterial(),
    )
    return out


def export_trimesh_with_transform(output_path: Path, tri: trimesh.Trimesh, transform: np.ndarray | None = None) -> None:
    if transform is None or np.allclose(transform, np.eye(4, dtype=np.float64), atol=1e-6):
        tri.export(str(output_path), file_type="glb")
        return

    scene = trimesh.Scene()
    scene.add_geometry(
        tri,
        node_name=output_path.stem,
        geom_name=output_path.stem,
        transform=transform if transform is not None else np.eye(4, dtype=np.float64),
    )
    output_path.write_bytes(scene.export(file_type="glb"))


def halo_candidate_score(char_id: str, go_name: str, chain_names: list[str]) -> int:
    keys = halo_object_keys(char_id)
    lower_chain = [name.lower() for name in chain_names]
    score = 0

    if lower_chain and any(lower_chain[0] == f"{key}_halo" for key in keys):
        score += 10
    if "haloroot" in lower_chain:
        score += 100
    if any(key in lower_chain for key in keys):
        score += 60
    if any(name in lower_chain for key in keys for name in (f"echelon_{key}", f"strategy_{key}", f"cafe_{key}")):
        score += 40
    if len(lower_chain) == 1:
        score -= 30
    if any("cutin" in name or "motion" in name or name.startswith("fx_") for name in lower_chain[1:]):
        score -= 100

    return score


def find_mesh_filters(env, char_id: str) -> list[tuple[str, object, list[str]]]:
    found: dict[str, tuple[int, int, str, object, list[str]]] = {}
    seen: set[int] = set()
    order = 0
    keys = halo_object_keys(char_id)

    for obj in env.objects:
        if obj.type.name != "MeshFilter":
            continue
        try:
            data = obj.read()
            go = data.m_GameObject.read()
            go_name = go.m_Name
        except Exception:
            continue

        lower = go_name.lower()
        if "halo" not in lower:
            continue
        if not (any_object_key_matches(lower, keys) or lower == "halo" or lower.endswith("_original_halo")):
            continue
        # Compare case-insensitively: some prefabs use "Ch####_Halo" instead
        # of the canonical "CH####_Halo". Accept the canonical char-id halo,
        # any alias-keyed halo (e.g. hoshino_swimsuit_halo for CH0091), the
        # bare "halo" GameObject, and *_original_halo as a fallback for
        # characters whose alt-skin prefab references the original halo mesh.
        accepted_names = {f"{key}_halo" for key in keys}
        accepted_names.add(f"{char_id.lower()}_halo")
        accepted_names.add("halo")
        if lower not in accepted_names:
            if not lower.endswith("_original_halo"):
                continue
        if obj.path_id in seen:
            continue

        seen.add(obj.path_id)
        transform = get_transform_object(go)
        chain_names = transform_chain_names(transform) if transform is not None else [go_name]
        mesh_name = safe_mesh_name(go_name, char_id)
        score = halo_candidate_score(char_id, go_name, chain_names)
        current = found.get(mesh_name)
        if current is None or score > current[0]:
            found[mesh_name] = (score, order, go_name, data, chain_names)
        order += 1

    return [
        (go_name, data, chain_names)
        for _, order_idx, go_name, data, chain_names in sorted(found.values(), key=lambda item: item[1])
    ]


def exported_static_halo_tilt_deg(env, char_id: str) -> float | None:
    for _go_name, mesh_filter, _chain_names in find_mesh_filters(env, char_id):
        try:
            tri = obj_to_trimesh(mesh_filter.m_Mesh.read())
        except Exception:
            continue
        if tri is None:
            continue
        transform = mesh_world_matrix(mesh_filter, char_id, tri)
        points = np.asarray(tri.vertices, dtype=np.float64)
        if transform is not None:
            points = transform_points(transform, points)
        return tilt_to_viewer_up(points)
    return None


def source_static_halo_tilt_deg(env, char_id: str) -> float | None:
    for _go_name, mesh_filter, _chain_names in find_mesh_filters(env, char_id):
        try:
            tri = obj_to_trimesh(mesh_filter.m_Mesh.read())
            go = mesh_filter.m_GameObject.read()
            transform = get_transform_object(go)
        except Exception:
            continue
        if tri is None or transform is None:
            continue
        matrix = prefab_to_mesh_basis(composed_transform_matrix(transform))
        points = transform_points(matrix, np.asarray(tri.vertices, dtype=np.float64))
        return tilt_to_viewer_up(points)
    return None


def placement_static_halo_tilt_deg(env, char_id: str) -> float | None:
    char_key = char_id.upper()
    if char_key in CIRCULAR_SCALE_ONLY_HALO_CHARS:
        source_tilt = source_static_halo_tilt_deg(env, char_key)
        if source_tilt is not None:
            return source_tilt
    return exported_static_halo_tilt_deg(env, char_key)


def halo_depth_mode_for_tilt(tilt: float | None) -> str | None:
    if tilt is None:
        return None
    return "head" if tilt <= HALO_DEPTH_HEAD_THRESHOLD_DEG else "tilt"


def apply_halo_follow_depth_mode(env, char_id: str, halo_follow: dict | None) -> dict | None:
    if not halo_follow:
        return halo_follow
    tilt = placement_static_halo_tilt_deg(env, char_id)
    if tilt is None:
        return halo_follow
    halo_follow["placement_tilt_deg"] = float(round(tilt, 4))
    if char_id.upper() in PRESERVE_DEPTH_HALO_CHARS:
        halo_follow["depth_mode"] = "preserve"
    else:
        halo_follow["depth_mode"] = halo_depth_mode_for_tilt(tilt)
    return halo_follow


def update_manifest(
    output_dir: Path,
    char_id: str,
    exported: list[dict] | None,
    halo_transform: dict | None = None,
    head_transform: dict | None = None,
    halo_anchor: dict | None = None,
    halo_follow: dict | None = None,
) -> None:
    manifest_path = output_dir / "manifest.json"
    if not manifest_path.exists():
        return

    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    if exported is not None:
        meshes = data.setdefault("meshes", [])
        merged: list[dict] = []
        seen: set[tuple[str | None, str | None]] = set()

        for item in meshes:
            if "halo" in str(item.get("name", "")).lower():
                continue
            key = (item.get("file"), item.get("name"))
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)

        for item in exported:
            key = (item.get("file"), item.get("name"))
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)

        data["meshes"] = merged

    if halo_transform:
        data["halo_transform"] = halo_transform
    elif exported is not None:
        data.pop("halo_transform", None)
    if halo_anchor:
        data["halo_anchor"] = halo_anchor
    else:
        data.pop("halo_anchor", None)
    if halo_follow:
        data["halo_follow"] = halo_follow
    else:
        data.pop("halo_follow", None)
    if head_transform:
        data["head_transform"] = head_transform

    manifest_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def export_common_texture(root: Path, output_dir: Path, texture_name: str) -> dict | None:
    bundle = root / COMMON_TEXTURE_BUNDLE
    if not bundle.exists():
        return None

    env = UnityPy.load(str(bundle))
    tex_dir = output_dir / "textures"
    tex_dir.mkdir(parents=True, exist_ok=True)

    for obj in env.objects:
        if obj.type.name != "Texture2D":
            continue
        data = obj.read()
        if data.m_Name != texture_name:
            continue
        file_name = f"{texture_name}.png"
        data.image.save(str(tex_dir / file_name))
        return {"name": texture_name, "file": f"textures/{file_name}", "size": list(data.image.size)}

    return None


def ensure_manifest_texture(output_dir: Path, texture: dict) -> None:
    manifest_path = output_dir / "manifest.json"
    if not manifest_path.exists():
        return
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    textures = data.setdefault("textures", [])
    for idx, item in enumerate(textures):
        if item.get("name") == texture["name"]:
            textures[idx] = texture
            break
    else:
        textures.append(texture)
    manifest_path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def export_character(root: Path, output_root: Path, char_id: str, metadata_only: bool = False) -> int:
    char_id = char_id.upper()
    bundles = find_bundles(root, char_id)
    if not bundles:
        print(f"{char_id}: no bundles")
        return 0

    env = UnityPy.load(*[str(p) for p in bundles])
    output_dir = output_root / char_id.lower()
    output_dir.mkdir(parents=True, exist_ok=True)

    exported: list[dict] = []
    halo_transform = None
    halo_anchor = find_halo_anchor_transform(env, char_id)
    head_transform = find_head_transform(env, char_id)
    halo_follow = apply_halo_follow_depth_mode(env, char_id, find_halo_follow_data(env, char_id))
    if metadata_only:
        update_manifest(output_dir, char_id, None, None, head_transform, halo_anchor, halo_follow)
        print(f"{char_id}: updated halo metadata only")
        return 0

    seen_names: set[str] = set()
    for go_name, mesh_filter, chain_names in find_mesh_filters(env, char_id):
        try:
            mesh = mesh_filter.m_Mesh.read()
            tri = obj_to_trimesh(mesh)
        except Exception as exc:
            print(f"{char_id}: {go_name} failed: {exc}")
            continue

        if tri is None:
            continue

        mesh_name = safe_mesh_name(go_name, char_id)
        if mesh_name in seen_names:
            continue
        seen_names.add(mesh_name)
        file_name = f"{char_id}_{mesh_name}.glb"
        transform = mesh_world_matrix(mesh_filter, char_id, tri)
        if "halo" in mesh_name.lower() and halo_transform is None:
            halo_transform = transform_from_matrix(
                transform if transform is not None else np.eye(4, dtype=np.float64),
                " <- ".join(chain_names),
                mesh_name,
                coordinate_space="viewer",
            )
        export_trimesh_with_transform(output_dir / file_name, tri, transform)
        item = {"name": mesh_name, "file": file_name, "verts": len(tri.vertices), "faces": len(tri.faces)}
        exported.append(item)
        print(
            f"{char_id}: exported {go_name} -> {file_name} "
            f"({item['verts']} verts, {item['faces']} tris) via {' <- '.join(chain_names)}"
        )

    update_manifest(output_dir, char_id, exported, halo_transform, head_transform, halo_anchor, halo_follow)
    if char_id == "CH0060":
        texture = export_common_texture(root, output_dir, "FX_TEX_World_Halo_01")
        if texture:
            ensure_manifest_texture(output_dir, texture)
            print(f"{char_id}: exported FX_TEX_World_Halo_01")
    if not exported:
        print(f"{char_id}: no static halo mesh")
    return len(exported)


def main() -> None:
    args = parse_args()
    total = 0
    for char_id in args.characters:
        total += export_character(args.assetbundles, args.output_root, char_id, metadata_only=args.metadata_only)
    print(f"exported {total} halo mesh(es)")


if __name__ == "__main__":
    main()
