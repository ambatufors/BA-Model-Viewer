from __future__ import annotations

import math
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import UnityPy


TRANSFORM_TYPE_ID = 4
POSITION_ATTRIBUTE = 1
ROTATION_ATTRIBUTE = 2
SCALE_ATTRIBUTE = 3
EULER_ATTRIBUTE = 4

# Unity classID for Renderer base class (used to animate m_Enabled on
# any concrete renderer including SkinnedMeshRenderer/MeshRenderer).
RENDERER_TYPE_ID = 25
GAMEOBJECT_TYPE_ID = 1

# Attribute hashes are CRC32 of the property name. Unity emits these in
# m_ClipBindingConstant.genericBindings for non-Transform float curves.
M_ENABLED_HASH = 0xC50BCE51  # CRC32("m_Enabled") = 3305885265
M_IS_ACTIVE_HASH = 0x7C5A22F6  # CRC32("m_IsActive") = 2086281974


@dataclass
class StreamedCurveKey:
    index: int
    coeff: tuple[float, float, float, float]

    @property
    def value(self) -> float:
        return self.coeff[3]


@dataclass
class StreamedFrame:
    time: float
    keys: list[StreamedCurveKey]


@dataclass
class AnimationChannel:
    path: str
    target: str
    times: list[float] = field(default_factory=list)
    values: list[tuple[float, ...]] = field(default_factory=list)

    def add(self, time: float, value: tuple[float, ...]) -> None:
        if not math.isfinite(time):
            return
        self.times.append(float(time))
        self.values.append(value)

    def compact(self) -> None:
        merged: dict[float, tuple[float, ...]] = {}
        for time, value in zip(self.times, self.values):
            merged[round(time, 6)] = value
        self.times = sorted(merged)
        self.values = [merged[time] for time in self.times]


@dataclass
class DecodedAnimation:
    name: str
    sample_rate: float
    duration: float
    source_bundle: str
    channels: dict[tuple[str, str], AnimationChannel] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    skipped_curves: int = 0
    # path -> sorted list of (time, enabled_bool). Captures the m_Enabled
    # curve emitted by Unity on Renderer (and derivatives) so the runtime
    # can swap renderer visibility frame-accurate, instead of inferring
    # from clip-name patterns.
    renderer_toggles: dict[str, list[tuple[float, bool]]] = field(default_factory=dict)

    def add_channel_value(self, path: str, target: str, time: float, value: tuple[float, ...]) -> None:
        key = (path, target)
        channel = self.channels.get(key)
        if channel is None:
            channel = AnimationChannel(path=path, target=target)
            self.channels[key] = channel
        channel.add(time, value)

    def add_renderer_toggle(self, path: str, time: float, enabled: bool) -> None:
        if not math.isfinite(time):
            return
        bucket = self.renderer_toggles.setdefault(path, [])
        bucket.append((max(0.0, float(time)), bool(enabled)))

    def finalize(self) -> None:
        empty = []
        for key, channel in self.channels.items():
            channel.compact()
            if not channel.times:
                empty.append(key)
        for key in empty:
            del self.channels[key]
        # Compact toggles: dedupe identical (time, value) and sort by time.
        for path, samples in list(self.renderer_toggles.items()):
            if not samples:
                del self.renderer_toggles[path]
                continue
            seen: dict[float, bool] = {}
            for t, v in samples:
                seen[round(t, 6)] = v
            ordered = sorted(seen.items())
            # Strip leading entries that share value with the first entry
            # if the curve has only one effective state — keep the first
            # transition and onwards. Unity often emits a sentinel at
            # -FLT_MAX which add_renderer_toggle clamps to 0.0; that's fine.
            self.renderer_toggles[path] = [(t, v) for t, v in ordered]

    def summary(self) -> dict[str, Any]:
        data = {
            "name": self.name,
            "sample_rate": self.sample_rate,
            "duration": self.duration,
            "channels": len(self.channels),
            "keyframes": sum(len(channel.times) for channel in self.channels.values()),
            "skipped_curves": self.skipped_curves,
            "source_bundle": self.source_bundle,
        }
        if self.events:
            data["events"] = self.events
        if self.renderer_toggles:
            data["renderer_toggles"] = {
                path: [{"time": t, "enabled": v} for t, v in samples]
                for path, samples in self.renderer_toggles.items()
            }
        return data


def load_avatar_tos(env: Any, preferred_prefix: str | None = None) -> dict[int, str]:
    avatars: list[tuple[str, list[tuple[int, str]]]] = []
    preferred = (preferred_prefix or "").lower()
    for obj in env.objects:
        if obj.type.name != "Avatar":
            continue
        try:
            avatar = obj.read()
        except Exception:
            continue
        rows = [(int(key), str(path)) for key, path in (getattr(avatar, "m_TOS", []) or [])]
        avatars.append((str(getattr(avatar, "m_Name", "")), rows))

    def sort_key(item: tuple[str, list[tuple[int, str]]]) -> tuple[bool, bool, bool, str]:
        name = item[0].lower()
        return (
            bool(preferred and preferred not in name),
            "dummy" in name,
            "meshavatar" not in name,
            name,
        )

    path_by_hash: dict[int, str] = {}
    for _name, rows in sorted(avatars, key=sort_key):
        for key, path in rows:
            path_by_hash.setdefault(key, path)
    return path_by_hash


def parse_streamed_clip(data_words: list[int]) -> list[StreamedFrame]:
    if not data_words:
        return []
    blob = struct.pack(f"<{len(data_words)}I", *(word & 0xFFFFFFFF for word in data_words))
    frames: list[StreamedFrame] = []
    offset = 0
    total = len(blob)
    while offset + 8 <= total:
        time, key_count = struct.unpack_from("<fi", blob, offset)
        offset += 8
        if key_count < 0 or offset + key_count * 20 > total:
            break
        keys: list[StreamedCurveKey] = []
        for _ in range(key_count):
            index = struct.unpack_from("<i", blob, offset)[0]
            coeff = struct.unpack_from("<ffff", blob, offset + 4)
            offset += 20
            keys.append(StreamedCurveKey(index=index, coeff=coeff))
        frames.append(StreamedFrame(time=time, keys=keys))
    return frames


def _binding_dimension(binding: dict[str, Any]) -> int:
    if int(binding.get("typeID") or binding.get("classID") or 0) == TRANSFORM_TYPE_ID:
        attribute = int(binding.get("attribute") or 0)
        if attribute == ROTATION_ATTRIBUTE:
            return 4
        if attribute in {POSITION_ATTRIBUTE, SCALE_ATTRIBUTE, EULER_ATTRIBUTE}:
            return 3
    return 1

def _build_binding_lookup(bindings: list[dict[str, Any]]) -> dict[int, tuple[dict[str, Any], int]]:
    lookup: dict[int, tuple[dict[str, Any], int]] = {}
    cursor = 0
    for binding in bindings:
        dimension = _binding_dimension(binding)
        for index in range(cursor, cursor + dimension):
            lookup[index] = (binding, dimension)
        cursor += dimension
    return lookup


def _normalize_quaternion(values: list[float]) -> tuple[float, float, float, float]:
    x, y, z, w = (float(v) for v in values[:4])
    length = math.sqrt(x * x + y * y + z * z + w * w)
    if length > 0 and math.isfinite(length):
        return (x / length, y / length, z / length, w / length)
    return (0.0, 0.0, 0.0, 1.0)


def _euler_xyz_to_quaternion(values: list[float]) -> tuple[float, float, float, float]:
    # Serialized Transform Euler animation curves are stored in degrees and
    # compose as qz * qy * qx when reconstructed as local quaternions.
    x, y, z = (math.radians(float(v)) for v in values[:3])

    def axis_quaternion(axis: str, angle: float) -> tuple[float, float, float, float]:
        half = angle * 0.5
        s = math.sin(half)
        c = math.cos(half)
        if axis == "x":
            return (s, 0.0, 0.0, c)
        if axis == "y":
            return (0.0, s, 0.0, c)
        return (0.0, 0.0, s, c)

    def multiply(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
        ax, ay, az, aw = a
        bx, by, bz, bw = b
        return (
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        )

    qx = axis_quaternion("x", x)
    qy = axis_quaternion("y", y)
    qz = axis_quaternion("z", z)
    return _normalize_quaternion(list(multiply(multiply(qz, qy), qx)))


def _apply_curve(
    animation: DecodedAnimation,
    binding_lookup: dict[int, tuple[dict[str, Any], int]],
    path_by_hash: dict[int, str],
    curve_index: int,
    time: float,
    values: list[float],
) -> int:
    found = binding_lookup.get(curve_index)
    if not found:
        animation.skipped_curves += 1
        return 1

    binding, dimension = found
    raw_values = values[:dimension]
    if len(raw_values) < dimension:
        animation.skipped_curves += 1
        return max(1, dimension)

    type_id = int(binding.get("typeID") or binding.get("classID") or 0)
    attribute = int(binding.get("attribute") or 0)
    path = path_by_hash.get(int(binding.get("path") or 0))

    # Renderer.m_Enabled (and GameObject.m_IsActive) drive per-renderer
    # visibility from inside an AnimationClip. Both are 1-dimensional
    # float curves; treat any non-zero value as "enabled".
    if (
        type_id == RENDERER_TYPE_ID
        and (attribute & 0xFFFFFFFF) == M_ENABLED_HASH
    ) or (
        type_id == GAMEOBJECT_TYPE_ID
        and (attribute & 0xFFFFFFFF) == M_IS_ACTIVE_HASH
    ):
        if path:
            animation.add_renderer_toggle(path, time, raw_values[0] >= 0.5)
        else:
            animation.skipped_curves += dimension
        return dimension

    if type_id != TRANSFORM_TYPE_ID:
        animation.skipped_curves += 1
        return dimension

    if not path:
        animation.skipped_curves += dimension
        return dimension

    if attribute == POSITION_ATTRIBUTE:
        animation.add_channel_value(path, "translation", time, tuple(float(v) for v in raw_values[:3]))
    elif attribute == ROTATION_ATTRIBUTE:
        animation.add_channel_value(path, "rotation", time, _normalize_quaternion(raw_values))
    elif attribute == SCALE_ATTRIBUTE:
        animation.add_channel_value(path, "scale", time, tuple(float(v) for v in raw_values[:3]))
    elif attribute == EULER_ATTRIBUTE:
        animation.add_channel_value(path, "rotation", time, _euler_xyz_to_quaternion(raw_values))
    else:
        animation.skipped_curves += dimension
    return dimension


def _read_curve_sequence(
    animation: DecodedAnimation,
    binding_lookup: dict[int, tuple[dict[str, Any], int]],
    path_by_hash: dict[int, str],
    *,
    start_index: int,
    time: float,
    values: list[float],
) -> None:
    cursor = 0
    while cursor < len(values):
        cursor += _apply_curve(
            animation,
            binding_lookup,
            path_by_hash,
            start_index + cursor,
            time,
            values[cursor:],
        )


def _read_streamed_frame(
    animation: DecodedAnimation,
    binding_lookup: dict[int, tuple[dict[str, Any], int]],
    path_by_hash: dict[int, str],
    frame: StreamedFrame,
) -> None:
    values = [key.value for key in frame.keys]
    cursor = 0
    while cursor < len(frame.keys):
        cursor += _apply_curve(
            animation,
            binding_lookup,
            path_by_hash,
            frame.keys[cursor].index,
            frame.time,
            values[cursor:],
        )


def _read_animation_events(tree: dict[str, Any]) -> list[dict[str, Any]]:
    events = []
    for event in tree.get("m_Events") or []:
        function_name = str(event.get("functionName") or "")
        if not function_name:
            continue
        events.append(
            {
                "time": float(event.get("time") or 0.0),
                "function": function_name,
                "int": int(event.get("intParameter") or 0),
                "float": float(event.get("floatParameter") or 0.0),
                "data": str(event.get("data") or ""),
            }
        )
    return sorted(events, key=lambda item: item["time"])


def decode_animation_clip(obj: Any, path_by_hash: dict[int, str]) -> DecodedAnimation | None:
    try:
        clip = obj.read()
        tree = obj.read_typetree()
    except Exception:
        return None

    muscle = tree.get("m_MuscleClip") or {}
    clip_data = ((muscle.get("m_Clip") or {}).get("data") or {})
    bindings = ((tree.get("m_ClipBindingConstant") or {}).get("genericBindings") or [])
    if not clip_data or not bindings:
        return None

    start_time = float(muscle.get("m_StartTime") or 0.0)
    stop_time = float(muscle.get("m_StopTime") or start_time)
    animation = DecodedAnimation(
        name=str(getattr(clip, "m_Name", "") or tree.get("m_Name") or "AnimationClip"),
        sample_rate=float(getattr(clip, "m_SampleRate", tree.get("m_SampleRate") or 30.0)),
        duration=max(0.0, stop_time - start_time),
        source_bundle=Path(str(getattr(getattr(obj, "serialized_file", None), "name", ""))).name,
        events=_read_animation_events(tree),
    )
    binding_lookup = _build_binding_lookup(bindings)

    streamed = clip_data.get("m_StreamedClip") or {}
    frames = parse_streamed_clip(streamed.get("data") or [])
    for frame in frames[1:-1]:
        _read_streamed_frame(animation, binding_lookup, path_by_hash, frame)

    stream_count = int(streamed.get("curveCount") or 0)
    dense = clip_data.get("m_DenseClip") or {}
    dense_curve_count = int(dense.get("m_CurveCount") or 0)
    dense_frame_count = int(dense.get("m_FrameCount") or 0)
    dense_sample_rate = float(dense.get("m_SampleRate") or animation.sample_rate or 30.0)
    dense_begin = float(dense.get("m_BeginTime") or 0.0)
    dense_samples = [float(v) for v in dense.get("m_SampleArray") or []]
    for frame_index in range(dense_frame_count):
        offset = frame_index * dense_curve_count
        values = dense_samples[offset : offset + dense_curve_count]
        if not values:
            continue
        time = dense_begin + frame_index / dense_sample_rate
        _read_curve_sequence(
            animation,
            binding_lookup,
            path_by_hash,
            start_index=stream_count,
            time=time,
            values=values,
        )

    constant = clip_data.get("m_ConstantClip") or {}
    constant_values = [float(v) for v in constant.get("data") or []]
    if constant_values:
        constant_start_index = stream_count + dense_curve_count
        for time in (0.0, animation.duration):
            _read_curve_sequence(
                animation,
                binding_lookup,
                path_by_hash,
                start_index=constant_start_index,
                time=time,
                values=constant_values,
            )

    animation.finalize()
    return animation if animation.channels or animation.events else None


def decode_animation_bundles(animation_bundles: list[Path], path_by_hash: dict[int, str]) -> list[DecodedAnimation]:
    animations: list[DecodedAnimation] = []
    for bundle in animation_bundles:
        try:
            env = UnityPy.load(str(bundle))
        except Exception as exc:
            print(f"  [Anim] {bundle.name} - FAILED: {exc}")
            continue
        for obj in env.objects:
            if obj.type.name != "AnimationClip":
                continue
            decoded = decode_animation_clip(obj, path_by_hash)
            if decoded is None:
                continue
            decoded.source_bundle = bundle.name
            animations.append(decoded)
            print(
                f"  [Anim] {decoded.name}: {len(decoded.channels)} channels, "
                f"{sum(len(ch.times) for ch in decoded.channels.values())} keys"
            )
    return sorted(animations, key=lambda item: item.name.lower())
