"""Compute attach metadata for external props with private skeletons.

Some characters carry props (e.g. CH0072 Mari's WaterPot) that ship in cafe
furniture bundles with their own private skeleton not parented to the
character. The cafe runtime co-positions the prop with a character bone;
without that runtime, the viewer renders the prop sitting at its bind pose.

This helper computes a static rest TRS relative to a target character bone
so the viewer can re-parent the prop after load. The formula is::

    X = Bone_world^-1 * Prop_animated_world * Prop_bind_world^-1

so that, when the prop's GLB scene (which already advances its own bones to
the bind pose at runtime) is parented under the bone with local TRS = X,
the mesh world position matches the cafe-scene position the prop reaches
at the chosen sample time.

Bone auto-detection: when ``candidate_bones`` lists more than one option,
the helper samples each candidate's world distance to the prop leaf bone
across the clip and picks the lowest ``mean + std`` score - i.e. the bone
that consistently sits closest to the prop.
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import UnityPy

from animation_clip_decoder import decode_animation_bundles, load_avatar_tos


# --- 4x4 matrix helpers (row-major; m[row][col]) ---


def _mat_identity() -> list[list[float]]:
    return [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]


def _mat_mul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    out = [[0.0] * 4 for _ in range(4)]
    for i in range(4):
        for j in range(4):
            out[i][j] = (
                a[i][0] * b[0][j]
                + a[i][1] * b[1][j]
                + a[i][2] * b[2][j]
                + a[i][3] * b[3][j]
            )
    return out


def _mat_from_trs(pos, rot, scale) -> list[list[float]]:
    x, y, z, w = rot
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    sx, sy, sz = scale
    return [
        [(1 - 2 * (yy + zz)) * sx, 2 * (xy - wz) * sy, 2 * (xz + wy) * sz, pos[0]],
        [2 * (xy + wz) * sx, (1 - 2 * (xx + zz)) * sy, 2 * (yz - wx) * sz, pos[1]],
        [2 * (xz - wy) * sx, 2 * (yz + wx) * sy, (1 - 2 * (xx + yy)) * sz, pos[2]],
        [0.0, 0.0, 0.0, 1.0],
    ]


def _mat_inverse(m: list[list[float]]) -> list[list[float]]:
    """4x4 inverse via Gauss-Jordan; returns identity if singular."""
    a = [row[:] for row in m]
    inv = [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]
    for col in range(4):
        piv = col
        for r in range(col + 1, 4):
            if abs(a[r][col]) > abs(a[piv][col]):
                piv = r
        if abs(a[piv][col]) < 1e-12:
            return _mat_identity()
        if piv != col:
            a[col], a[piv] = a[piv], a[col]
            inv[col], inv[piv] = inv[piv], inv[col]
        d = a[col][col]
        for j in range(4):
            a[col][j] /= d
            inv[col][j] /= d
        for r in range(4):
            if r == col:
                continue
            f = a[r][col]
            if f == 0:
                continue
            for j in range(4):
                a[r][j] -= f * a[col][j]
                inv[r][j] -= f * inv[col][j]
    return inv


def _decompose(m: list[list[float]]):
    pos = (m[0][3], m[1][3], m[2][3])
    sx = math.sqrt(m[0][0] ** 2 + m[1][0] ** 2 + m[2][0] ** 2)
    sy = math.sqrt(m[0][1] ** 2 + m[1][1] ** 2 + m[2][1] ** 2)
    sz = math.sqrt(m[0][2] ** 2 + m[1][2] ** 2 + m[2][2] ** 2)
    if sx == 0 or sy == 0 or sz == 0:
        return pos, (0.0, 0.0, 0.0, 1.0), (sx or 1.0, sy or 1.0, sz or 1.0)
    r = [
        [m[0][0] / sx, m[0][1] / sy, m[0][2] / sz],
        [m[1][0] / sx, m[1][1] / sy, m[1][2] / sz],
        [m[2][0] / sx, m[2][1] / sy, m[2][2] / sz],
    ]
    trace = r[0][0] + r[1][1] + r[2][2]
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        w = 0.25 * s
        x = (r[2][1] - r[1][2]) / s
        y = (r[0][2] - r[2][0]) / s
        z = (r[1][0] - r[0][1]) / s
    elif r[0][0] > r[1][1] and r[0][0] > r[2][2]:
        s = math.sqrt(1.0 + r[0][0] - r[1][1] - r[2][2]) * 2
        w = (r[2][1] - r[1][2]) / s
        x = 0.25 * s
        y = (r[0][1] + r[1][0]) / s
        z = (r[0][2] + r[2][0]) / s
    elif r[1][1] > r[2][2]:
        s = math.sqrt(1.0 + r[1][1] - r[0][0] - r[2][2]) * 2
        w = (r[0][2] - r[2][0]) / s
        x = (r[0][1] + r[1][0]) / s
        y = 0.25 * s
        z = (r[1][2] + r[2][1]) / s
    else:
        s = math.sqrt(1.0 + r[2][2] - r[0][0] - r[1][1]) * 2
        w = (r[1][0] - r[0][1]) / s
        x = (r[0][2] + r[2][0]) / s
        y = (r[1][2] + r[2][1]) / s
        z = 0.25 * s
    return pos, (x, y, z, w), (sx, sy, sz)


def _normalize_quat(q):
    x, y, z, w = q
    n = math.sqrt(x * x + y * y + z * z + w * w)
    if n == 0:
        return (0.0, 0.0, 0.0, 1.0)
    return (x / n, y / n, z / n, w / n)


def _slerp(a, b, t):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    if ax * bx + ay * by + az * bz + aw * bw < 0:
        bx, by, bz, bw = -bx, -by, -bz, -bw
    return _normalize_quat(
        (
            ax * (1 - t) + bx * t,
            ay * (1 - t) + by * t,
            az * (1 - t) + bz * t,
            aw * (1 - t) + bw * t,
        )
    )


def _sample_channel(channel, time):
    times = channel.times
    values = channel.values
    if not times:
        return None
    if time <= times[0]:
        return values[0]
    if time >= times[-1]:
        return values[-1]
    lo, hi = 0, len(times) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if times[mid] <= time:
            lo = mid
        else:
            hi = mid
    t0, t1 = times[lo], times[hi]
    v0, v1 = values[lo], values[hi]
    if t1 == t0:
        return v0
    a = (time - t0) / (t1 - t0)
    if len(v0) == 4:
        return _slerp(v0, v1, a)
    return tuple(v0[i] * (1 - a) + v1[i] * a for i in range(len(v0)))


def _collect_bind_poses(env, root_name) -> dict[str, tuple]:
    """Walk a single prefab tree and return path -> (parent, pos, rot, scale)."""
    out: dict[str, tuple] = {}
    for obj in env.objects:
        if obj.type.name not in ("Transform", "RectTransform"):
            continue
        try:
            t = obj.read()
            f = t.m_Father
            if getattr(f, "path_id", 0):
                continue
            go = t.m_GameObject.read()
            if str(go.m_Name) != root_name:
                continue
        except Exception:
            continue

        def walk(node, parent_path=""):
            try:
                go = node.m_GameObject.read()
                n = str(go.m_Name)
            except Exception:
                return
            full = f"{parent_path}/{n}" if parent_path else n
            pos = node.m_LocalPosition
            rot = node.m_LocalRotation
            scl = node.m_LocalScale
            out[full] = (
                parent_path,
                (pos.x, pos.y, pos.z),
                (rot.x, rot.y, rot.z, rot.w),
                (scl.x, scl.y, scl.z),
            )
            for ch_ptr in getattr(node, "m_Children", []) or []:
                try:
                    ch = ch_ptr.read()
                    walk(ch, full)
                except Exception:
                    pass

        walk(t)
        return out
    return out


def _strip_root_prefix(path: str, root_names: tuple[str, ...]) -> str:
    for root in root_names:
        prefix = f"{root}/"
        if path.startswith(prefix):
            return path[len(prefix):]
    return path


def _fk_world_matrix(bind, channels, bone_full_path, time, root_names):
    chain = []
    p = bone_full_path
    while p:
        chain.append(p)
        if p not in bind:
            break
        p = bind[p][0]
    chain.reverse()
    m = _mat_identity()
    for full in chain:
        if full not in bind:
            continue
        _parent, b_pos, b_rot, b_scale = bind[full]
        clip_path = _strip_root_prefix(full, root_names)
        pos, rot, scale = b_pos, b_rot, b_scale
        ch = channels.get((clip_path, "translation"))
        if ch and ch.times:
            pos = _sample_channel(ch, time)
        ch = channels.get((clip_path, "rotation"))
        if ch and ch.times:
            rot = _sample_channel(ch, time)
        ch = channels.get((clip_path, "scale"))
        if ch and ch.times:
            scale = _sample_channel(ch, time)
        m = _mat_mul(m, _mat_from_trs(pos, rot, scale))
    return m


def _resolve_bone_path(bind, bone_name) -> str | None:
    for full in bind:
        if full == bone_name or full.endswith(f"/{bone_name}"):
            return full
    return None


def _select_bone_target(
    char_bind,
    char_channels,
    prop_bind,
    prop_channels,
    point_path,
    candidate_bone_names,
    duration,
    root_names,
    *,
    n_samples: int = 20,
):
    """Pick the candidate bone with the lowest mean+std distance to point_path."""
    if duration <= 0:
        duration = 1.0
    sample_times = [i * (duration / max(1, n_samples - 1)) for i in range(n_samples)]
    best_score = float("inf")
    best_name = None
    best_path = None
    scores = []
    for cb_name in candidate_bone_names:
        cb_full = _resolve_bone_path(char_bind, cb_name)
        if cb_full is None:
            scores.append((cb_name, None, "not found"))
            continue
        diffs = []
        for t in sample_times:
            pa = _fk_world_matrix(prop_bind, prop_channels, point_path, t, root_names)
            ba = _fk_world_matrix(char_bind, char_channels, cb_full, t, root_names)
            d = math.sqrt(sum((pa[i][3] - ba[i][3]) ** 2 for i in range(3)))
            diffs.append(d)
        if not diffs:
            continue
        mean = sum(diffs) / len(diffs)
        var = sum((d - mean) ** 2 for d in diffs) / len(diffs)
        std = math.sqrt(var)
        score = mean + std
        scores.append((cb_name, score, f"mean={mean:.3f}m std={std:.3f}m"))
        if score < best_score:
            best_score = score
            best_name = cb_name
            best_path = cb_full
    return best_score, best_name, best_path, scores


def compute_external_prop_attach(prop_env, *, config: dict[str, Any], game_dir: Path) -> dict[str, Any] | None:
    """Compute parent-bone TRS metadata for an external prop.

    ``config`` keys (see ``tools/external_prop_config.json``):
      - char_bundles.{mesh, prefab, clips}
      - prop_bundles.{animationclips}
      - char_avatar_prefix, prop_avatar_prefix
      - prefab_root_char, prefab_root_prop
      - char_clip, prop_clip
      - prop_bone_leaf
      - candidate_bones (list)
      - sample_time (float, fallback when scoring picks a bone)
      - max_offset_dist (float, meters)

    ``prop_env`` must already contain the prop prefab + meshes.
    """
    char_paths = [
        game_dir / config["char_bundles"][k] for k in ("mesh", "prefab", "clips")
    ]
    if not all(p.exists() for p in char_paths):
        print(f"  [ExtProp] {config['prop_name']} attach: character bundles missing")
        return None

    try:
        char_env = UnityPy.load(*[str(p) for p in char_paths])
    except Exception as exc:
        print(f"  [ExtProp] {config['prop_name']} attach: cannot load char env ({exc})")
        return None

    char_root = config["prefab_root_char"]
    prop_root = config["prefab_root_prop"]
    char_bind = _collect_bind_poses(char_env, char_root)
    prop_bind = _collect_bind_poses(prop_env, prop_root)
    if not char_bind or not prop_bind:
        print(f"  [ExtProp] {config['prop_name']} attach: prefab roots not found")
        return None

    point_path = _resolve_bone_path(prop_bind, config["prop_bone_leaf"])
    if not point_path:
        print(f"  [ExtProp] {config['prop_name']} attach: prop leaf bone missing")
        return None

    char_tos = load_avatar_tos(char_env, config.get("char_avatar_prefix"))
    prop_tos = load_avatar_tos(prop_env, config.get("prop_avatar_prefix"))

    char_clip_bundle = game_dir / config["char_bundles"]["clips"]
    prop_clip_bundle = game_dir / config["prop_bundles"]["animationclips"]
    char_clips = decode_animation_bundles([char_clip_bundle], char_tos)
    prop_clips = decode_animation_bundles([prop_clip_bundle], prop_tos)
    char_clip = next((c for c in char_clips if c.name == config["char_clip"]), None)
    prop_clip = next((c for c in prop_clips if c.name == config["prop_clip"]), None)
    if char_clip is None or prop_clip is None:
        print(f"  [ExtProp] {config['prop_name']} attach: target clips not found")
        return None

    candidate_bones = config.get("candidate_bones", [])
    if not candidate_bones:
        print(f"  [ExtProp] {config['prop_name']} attach: no candidate bones configured")
        return None

    duration = max(prop_clip.duration, char_clip.duration, 1.0)
    root_names = (char_root, prop_root)
    score, bone_name, bone_path, scores = _select_bone_target(
        char_bind,
        char_clip.channels,
        prop_bind,
        prop_clip.channels,
        point_path,
        candidate_bones,
        duration,
        root_names,
    )
    if scores:
        print(f"  [ExtProp] {config['prop_name']} bone scoring:")
        for name, sc, detail in scores:
            label = f"{sc:.3f}" if isinstance(sc, float) else str(sc)
            print(f"    - {name}: {label} ({detail})")
    if bone_path is None:
        print(f"  [ExtProp] {config['prop_name']} attach: no candidate bones resolved")
        return None
    max_dist = float(config.get("max_offset_dist", 0.30))
    if score > max_dist:
        print(
            f"  [ExtProp] {config['prop_name']} attach: best bone {bone_name} score "
            f"{score:.3f}m exceeds {max_dist:.3f}m threshold; falling back"
        )
        return None

    sample_time = float(config.get("sample_time", 0.0))
    bone_world = _fk_world_matrix(char_bind, char_clip.channels, bone_path, sample_time, root_names)
    prop_animated = _fk_world_matrix(prop_bind, prop_clip.channels, point_path, sample_time, root_names)
    prop_bind_world = _fk_world_matrix(prop_bind, {}, point_path, sample_time, root_names)

    rel = _mat_mul(
        _mat_mul(_mat_inverse(bone_world), prop_animated),
        _mat_inverse(prop_bind_world),
    )
    pos, rot, scale = _decompose(rel)

    print(
        f"  [ExtProp] {config['prop_name']} attach -> {bone_name}: "
        f"pos=({pos[0]:.3f},{pos[1]:.3f},{pos[2]:.3f}) "
        f"rot=({rot[0]:.3f},{rot[1]:.3f},{rot[2]:.3f},{rot[3]:.3f}) "
        f"scale=({scale[0]:.3f},{scale[1]:.3f},{scale[2]:.3f})"
    )

    return {
        "bone": bone_name,
        "position": {"x": float(pos[0]), "y": float(pos[1]), "z": float(pos[2])},
        "rotation": {
            "x": float(rot[0]),
            "y": float(rot[1]),
            "z": float(rot[2]),
            "w": float(rot[3]),
        },
        "scale": {"x": float(scale[0]), "y": float(scale[1]), "z": float(scale[2])},
    }
