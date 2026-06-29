from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import UnityPy


CAB_RE = re.compile(r"CAB-([0-9a-f]{32})", re.I)

CHARACTER_BUNDLE_ALIASES = {
    "ch0072": ("mari_original", "mari"),
    "ch0091": ("hoshino_swimsuit",),
    "ch0184": ("yuuka_original",),
    "ch0232": ("kotama_original",),
    # CH0300's hammock is authored as the paired SM030001 model: its mesh and
    # standalone Normal/Vital/Appear clips live in SM030001 bundles.
    "ch0300": ("sm030001",),
}
CHARACTER_OBJECT_ALIASES = {
    "ch0072": ("Mari_Original",),
    "ch0091": ("Hoshino_Swimsuit",),
    "ch0232": ("Kotama_Original",),
    "ch0355": ("CH0355_01", "CH0355_02"),
}
CHARACTER_BUNDLE_ALIAS_KIND_EXCLUDES = {
    ("ch0232", "kotama_original"): frozenset(
        {"animationclips", "animatorcontrollers", "timelines"}
    ),
}


@dataclass
class BundleResolution:
    bundles: list[Path]
    added_dependencies: list[Path]
    unresolved_cabs: list[str]
    cab_index_size: int


def normalize_cab(value: object) -> str | None:
    m = CAB_RE.search(str(value))
    if not m:
        return None
    return f"cab-{m.group(1).lower()}"


def load_cab_index(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return {str(k).lower(): str(v) for k, v in data.items()}


def bundle_own_cabs(bundle: Path) -> set[str]:
    try:
        env = UnityPy.load(str(bundle))
    except Exception:
        return set()
    cabs: set[str] = set()
    for assets_file in getattr(env, "assets", []) or []:
        cab = normalize_cab(getattr(assets_file, "name", ""))
        if cab:
            cabs.add(cab)
    return cabs


def bundle_dependencies(bundle: Path) -> set[str]:
    try:
        env = UnityPy.load(str(bundle))
    except Exception:
        return set()
    deps: set[str] = set()
    for obj in env.objects:
        if obj.type.name != "AssetBundle":
            continue
        try:
            tt = obj.read_typetree()
        except Exception:
            continue
        for dep in tt.get("m_Dependencies") or []:
            cab = normalize_cab(dep)
            if cab:
                deps.add(cab)
    return deps


def index_bundle_owners(bundles: Iterable[Path]) -> dict[str, Path]:
    owners: dict[str, Path] = {}
    for bundle in sorted(set(bundles), key=lambda p: p.name.lower()):
        for cab in bundle_own_cabs(bundle):
            owners.setdefault(cab, bundle)
    return owners


def character_bundle_keys(char_id: str) -> tuple[str, ...]:
    lower = char_id.lower()
    return tuple(dict.fromkeys((lower, *CHARACTER_BUNDLE_ALIASES.get(lower, ()))))


def character_object_ids(char_id: str) -> tuple[str, ...]:
    canonical = char_id.upper()
    return tuple(dict.fromkeys((canonical, *CHARACTER_OBJECT_ALIASES.get(char_id.lower(), ()))))


def bundle_kind(bundle: Path | str) -> str:
    name = Path(bundle).name.lower()
    if "animationclips" in name:
        return "animationclips"
    if "animatorcontrollers" in name:
        return "animatorcontrollers"
    if "timelines" in name:
        return "timelines"
    if "meshes" in name:
        return "meshes"
    if "textures" in name:
        return "textures"
    if "materials" in name:
        return "materials"
    if "prefabs" in name:
        return "prefabs"
    if "_mxdependency-assets" in name or "_mxload-assets" in name:
        return "assets"
    if "audio" in name:
        return "audio"
    return "other"


def _allows_bundle_alias_kind(char_id: str, bundle_key: str, bundle: Path) -> bool:
    excluded = CHARACTER_BUNDLE_ALIAS_KIND_EXCLUDES.get((char_id.lower(), bundle_key))
    if not excluded:
        return True
    return bundle_kind(bundle) not in excluded


def find_character_bundles(root: Path, char_id: str) -> list[Path]:
    out: set[Path] = set()
    for lower in character_bundle_keys(char_id):
        patterns = [
            f"assets-_mx-characters-{lower}-_mxdependency-*.bundle",
            f"assets-_mx-characters-{lower}_*-_mxdependency-*.bundle",
            f"assets-_mx-scenes-skillcut-{lower}-_mxdependency-*.bundle",
            f"assets-_mx-spinecharacters-{lower}_spr-_mxdependency-*.bundle",
            f"assets-_mx-spinelobbies-{lower}_home-_mxdependency-*.bundle",
            f"character-{lower}-_mxload-*.bundle",
            f"character-{lower}_*-_mxload-*.bundle",
            f"cafe-characteranimation-{lower}-_mxload-*.bundle",
            f"cafe-characteranimation-{lower}_*-_mxload-*.bundle",
            f"tsainteraction_{lower}-_mxload-*.bundle",
            f"tsainteraction_{lower}_*-_mxload-*.bundle",
            f"{lower}_*_mxload-*.bundle",
            f"prologdepengroup-assets-_mx-characters-{lower}-_mxprolog-*.bundle",
            f"prologgroup-assets-_mx-addressableasset-character-{lower}-_mxprolog-*.bundle",
        ]
        for pattern in patterns:
            for bundle in root.glob(pattern):
                if _allows_bundle_alias_kind(char_id, lower, bundle):
                    out.add(bundle)
    return sorted(out, key=lambda p: p.name.lower())


def find_common_dependency_candidates(root: Path) -> list[Path]:
    patterns = [
        "assets-_mx-characters-_mxcommon-_mxdependency-*.bundle",
        "prologdepengroup-assets-_mx-characters-_mxcommon-_mxprolog-*.bundle",
        "character-animatorbase-_mxload-*.bundle",
        "assets-_mx-spinecharacters-_mxcommon-_mxdependency-*.bundle",
        "assets-_mx-shaders-_mxdependency-*.bundle",
        "prologdepengroup-assets-_mx-shaders-_mxprolog-*.bundle",
        "packages-com.unity.render-pipelines.universal-shaders-*_mxdependency-*.bundle",
        "MX_unitybuiltinshaders_*.bundle",
    ]
    out: set[Path] = set()
    for pattern in patterns:
        out.update(root.glob(pattern))
    return sorted(out, key=lambda p: p.name.lower())


def categorize_bundles(bundles: Iterable[Path]) -> dict[str, list[Path]]:
    buckets = {
        "meshes": [],
        "textures": [],
        "materials": [],
        "prefabs": [],
        "animationclips": [],
        "animatorcontrollers": [],
        "timelines": [],
        "assets": [],
        "audio": [],
        "other": [],
    }
    for bundle in sorted(set(bundles), key=lambda p: p.name.lower()):
        buckets[bundle_kind(bundle)].append(bundle)
    return buckets


def _resolve_from_persisted_index(root: Path, cab_index: dict[str, str], cab: str) -> Path | None:
    bundle_name = cab_index.get(cab) or cab_index.get(f"{cab}.ress")
    if not bundle_name:
        return None
    path = root / bundle_name
    return path if path.exists() else None


def resolve_dependency_closure(
    root: Path,
    seed_bundles: Iterable[Path],
    *,
    candidate_bundles: Iterable[Path] = (),
    cab_index_file: Path | None = None,
) -> BundleResolution:
    seeds = set(seed_bundles)
    candidates = set(candidate_bundles) | seeds
    owner_index = index_bundle_owners(candidates)
    persisted = load_cab_index(cab_index_file) if cab_index_file else {}

    resolved = set(seeds)
    # Sort the work queue so the closure is deterministic. Iterating a set of
    # Path is per-process random (Python hash randomization), which previously
    # made the same inputs resolve to different bundle sets across runs.
    pending = sorted(seeds, key=lambda p: p.name.lower())
    unresolved: set[str] = set()

    # Full BFS to a fixpoint: keep expanding until the queue drains. `resolved`
    # blocks re-enqueueing, so the closure is finite and order-independent. (The
    # old `rounds < max_rounds` guard counted bundles, not BFS depth, so it
    # silently truncated the closure after 8 bundles — dropping most deps and,
    # combined with the random queue order, yielding a different partial set
    # every run.)
    while pending:
        bundle = pending.pop(0)
        deps = bundle_dependencies(bundle)
        for cab in deps:
            dep = owner_index.get(cab) or _resolve_from_persisted_index(root, persisted, cab)
            if not dep:
                unresolved.add(cab)
                continue
            if dep not in resolved:
                resolved.add(dep)
                pending.append(dep)
                for owned in bundle_own_cabs(dep):
                    owner_index.setdefault(owned, dep)
            unresolved.discard(cab)

    added = sorted(resolved - seeds, key=lambda p: p.name.lower())
    return BundleResolution(
        bundles=sorted(resolved, key=lambda p: p.name.lower()),
        added_dependencies=added,
        unresolved_cabs=sorted(unresolved),
        cab_index_size=len(owner_index) + len(persisted),
    )
