from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODELS_DIR = ROOT / "extracted_models"
DEFAULT_OUTPUT = ROOT / "models_index.json"
METADATA_KEYS = (
    "halo_transform",
    "head_transform",
    "head_anchor",
    "halo_anchor",
    "halo_follow",
    "halo_profile",
    "halo_particles_file",
)
LEGACY_TEXTURE_EXCLUDES = {
    "Character_Mouth_2",
    "Character_Mouth_Black",
    "Character_Mouth_High",
    "Character_Mouth_Decagramaton",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rebuild models_index.json from extracted model manifests.")
    parser.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--filter-legacy-textures",
        action="store_true",
        help="Drop legacy FX_/mouth textures from the generated index.",
    )
    return parser.parse_args()


def keep_texture(texture: dict[str, Any], filter_legacy_textures: bool) -> bool:
    if not filter_legacy_textures:
        return True
    name = str(texture.get("name", ""))
    return not name.startswith("FX_") and name not in LEGACY_TEXTURE_EXCLUDES


def build_entry(char_dir: Path, filter_legacy_textures: bool = False) -> dict[str, Any] | None:
    manifest = char_dir / "manifest.json"
    if not manifest.exists():
        return None

    data = json.loads(manifest.read_text(encoding="utf-8"))
    textures = [item for item in data.get("textures", []) if keep_texture(item, filter_legacy_textures)]
    entry: dict[str, Any] = {
        "id": data.get("char_id", char_dir.name.upper()),
        "path": f"extracted_models/{char_dir.name}",
        "submesh_order": data.get("submesh_order", []),
        "meshes": data.get("meshes", []),
        "skinned_meshes": data.get("skinned_meshes", []),
        "textures": textures,
        "materials": data.get("materials", []),
        "animations": data.get("animations", []),
    }
    for key in METADATA_KEYS:
        if key in data:
            entry[key] = data[key]
    return entry


def build_index(models_dir: Path, filter_legacy_textures: bool = False) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for char_dir in sorted(models_dir.iterdir()):
        if not char_dir.is_dir():
            continue
        entry = build_entry(char_dir, filter_legacy_textures)
        if entry is not None:
            entries.append(entry)
    return entries


def main() -> int:
    args = parse_args()
    if not args.models_dir.exists():
        print(f"Missing models dir: {args.models_dir}")
        return 1

    index = build_index(args.models_dir, args.filter_legacy_textures)
    args.output.write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"Wrote {len(index)} characters to {args.output}")
    for entry in index:
        print(
            f"  {entry['id']}: {len(entry['meshes'])} meshes, "
            f"{len(entry['textures'])} tex, {len(entry['materials'])} mat"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
