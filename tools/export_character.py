import json
import os
import sys
from pathlib import Path

import numpy as np
import trimesh
import UnityPy

from bundle_resolver import (
    character_object_ids,
    categorize_bundles,
    find_character_bundles,
    find_common_dependency_candidates,
    resolve_dependency_closure,
)
from animation_clip_decoder import decode_animation_bundles, load_avatar_tos
from external_prop_attach import compute_external_prop_attach
from export_halo_mesh import (
    apply_halo_follow_depth_mode,
    export_character as export_halo_mesh_character,
    find_halo_anchor_transform,
    find_halo_follow_data,
    find_head_transform,
)
from skinned_gltf import (
    _is_skinned_export_candidate,
    _skinned_renderer_path,
    export_skinned_smr,
    export_character_skinned_assets,
)

ROOT = Path(__file__).resolve().parents[1]
GAME_DIR = Path(
    os.environ.get(
        "BAJP_ASSETBUNDLES",
        r"D:\BAJP\YostarGames\BlueArchive_JP\BlueArchive_Data\StreamingAssets\AssetBundles",
    )
)
OUTPUT_BASE = ROOT / "extracted_models"
COMMON_TEX_BUNDLES = [
    "assets-_mx-characters-_mxcommon-_mxdependency-textures-2025-07-02_assets_all_2925187272.bundle",
    "assets-_mx-characters-_mxcommon-_mxdependency-textures-2026-01-04_assets_all_3538991568.bundle",
    "prologdepengroup-assets-_mx-characters-_mxcommon-_mxprolog-2025-07-02_assets_all_169562978.bundle",
]

CAB_INDEX_FILE = ROOT / "cab_index.json"


def load_cab_index():
    """Load cab → bundle mapping for dependency resolution."""
    if CAB_INDEX_FILE.exists():
        return json.loads(CAB_INDEX_FILE.read_text(encoding='utf-8'))
    return {}


def resolve_dependencies(char_id: str) -> list:
    """Find additional bundles needed by resolving external cab references."""
    import re
    ch_lower = char_id.lower()
    cab_index = load_cab_index()
    if not cab_index:
        return []

    primary_bundles = sorted(GAME_DIR.glob(f"assets-_mx-characters-{ch_lower}-_mxdependency-*.bundle"))
    if not primary_bundles:
        return []

    env = UnityPy.load(*[str(path) for path in primary_bundles])
    ext_cabs = set()
    for bf in env.files.values():
        if hasattr(bf, 'files'):
            for sf in bf.files.values():
                if hasattr(sf, 'externals'):
                    for ext in sf.externals:
                        m = re.search(r'CAB-([0-9a-f]{32})', str(ext))
                        if m:
                            ext_cabs.add("cab-" + m.group(1).lower())

    # Find bundles containing these cabs (excluding self)
    self_bundles = set(b.name for b in GAME_DIR.glob(f"assets-_mx-characters-{ch_lower}-*.bundle"))
    dep_bundles = set()
    for cab in ext_cabs:
        bundle_name = cab_index.get(cab, "")
        if bundle_name and bundle_name not in self_bundles:
            dep_bundles.add(bundle_name)

    return [GAME_DIR / b for b in dep_bundles if (GAME_DIR / b).exists()]

SUBMESH_ORDER = {
    6: ["Face", "Eyebrow", "EyeMouth", "Eyebrow2", "Hair", "Body"],
    5: ["Face", "Eyebrow", "EyeMouth", "Hair", "Body"],
    4: ["Face", "EyeMouth", "Hair", "Body"],
    3: ["Face", "Hair", "Body"],
    2: ["Face", "Body"],
    1: ["Body"],
}

STATIC_FX_MESHES = {
    "CH0335": {
        "FX_MESH_CH0335_Prop_Light": {
            "name": "PropLight",
            "fx_prop": True,
            "visibility": {"default_visible": False, "show_clip_patterns": ["Exs"]},
            "follow_target": "bone_prop_pillar",
            "follow_offset": {"x": 0.0, "y": 0.0, "z": 0.01045},
            "color": {"r": 0.8396, "g": 0.2099, "b": 0.4984, "a": 0.55},
            "fx_shell": {
                "type": "sprite",
                "size": 0.15,
                "color": {"r": 1.0, "g": 0.42, "b": 0.72, "a": 0.42},
            },
        },
    },
}

MATERIAL_ALIASES = {
    "CH0304": [
        {
            "part_name": "Hat",
            "alias": "CH0304_Hat",
            "source": "CH0304_Body",
            "shader": "MX/C-General/Layer4-Inline",
        },
    ],
}

CH0072_FLOWERPOT_BUNDLES = {
    "meshes": "assets-_mx-cafe-momo-my_cafe_01_b_flowerpot-_mxdependency-meshes-2025-07-02_assets_all_244174811.bundle",
    "materials": "assets-_mx-cafe-momo-my_cafe_01_b_flowerpot-_mxdependency-materials-2025-07-02_assets_all_2005463858.bundle",
    "textures": "assets-_mx-cafe-momo-my_cafe_01_b_flowerpot-_mxdependency-textures-2025-07-02_assets_all_543688113.bundle",
    "prefabs": "assets-_mx-cafe-momo-my_cafe_01_b_flowerpot-_mxdependency-prefabs-2025-07-02_assets_all_3225207048.bundle",
    "animationclips": "assets-_mx-cafe-momo-my_cafe_01_b_flowerpot-_mxdependency-animationclips-2025-07-02_assets_all_2189450094.bundle",
}

CH0091_SEAHOUSE_TUBES_BUNDLES = {
    "meshes": "assets-_mx-cafe-seahouse-tubes-_mxdependency-meshes-2025-07-02_assets_all_122689578.bundle",
    "materials": "assets-_mx-cafe-seahouse-tubes-_mxdependency-materials-2025-07-02_assets_all_303623258.bundle",
    "textures": "assets-_mx-cafe-seahouse-tubes-_mxdependency-textures-2025-07-02_assets_all_1347181598.bundle",
    "animationclips": "assets-_mx-cafe-seahouse-tubes-_mxdependency-animationclips-2025-07-02_assets_all_2143471262.bundle",
}

HALO_PART_ALIASES = {
    "CH0300": ("CH0225_Halo",),
}

EXTERNAL_PROP_CONFIG_FILE = ROOT / "tools" / "external_prop_config.json"


def _load_external_prop_configs() -> dict[str, dict]:
    if not EXTERNAL_PROP_CONFIG_FILE.exists():
        return {}
    try:
        data = json.loads(EXTERNAL_PROP_CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"  [ExtProp] failed to read {EXTERNAL_PROP_CONFIG_FILE.name}: {exc}")
        return {}
    return data.get("configs", {}) or {}


def _static_fx_mesh_spec(char_id: str, go_name: str) -> dict | None:
    return STATIC_FX_MESHES.get(char_id.upper(), {}).get(go_name)


def _source_ids(char_id: str) -> tuple[str, ...]:
    return character_object_ids(char_id)


def _source_body_names(char_id: str) -> set[str]:
    return {f"{source}_Body" for source in _source_ids(char_id)}


def _source_part_names(char_id: str, part_name: str) -> set[str]:
    return {f"{source}_{part_name}" for source in _source_ids(char_id)}


def _source_halo_names(char_id: str) -> set[str]:
    return _source_part_names(char_id, "Halo") | set(
        HALO_PART_ALIASES.get(char_id.upper(), ())
    )


def _has_source_prefix(name: str, char_id: str) -> bool:
    lowered = name.lower()
    for source in _source_ids(char_id):
        source_lower = source.lower()
        if lowered == source_lower or lowered.startswith(f"{source_lower}_"):
            return True
    return False


def _strip_source_prefix(name: str, char_id: str) -> str:
    lowered = name.lower()
    for source in sorted(_source_ids(char_id), key=len, reverse=True):
        prefix = f"{source}_"
        if lowered.startswith(prefix.lower()):
            return name[len(prefix):]
    return name


def _dedupe_manifest_items(items: list[dict]) -> list[dict]:
    """Keep generated manifest lists stable when dependency passes overlap."""
    out = []
    seen = set()
    for item in items:
        key = (item.get("name"), item.get("file"))
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def _manifest_resolved_dependencies(paths: list[Path]) -> list[str]:
    """Keep manifest diagnostics focused on character/runtime dependencies."""
    return [
        path.name
        for path in paths
        if not path.name.lower().startswith("assets-_mx-cafe-")
    ]


def find_bundles(char_id: str) -> dict:
    """Find all bundles for a character ID."""
    if not GAME_DIR.exists():
        return categorize_bundles([])

    return categorize_bundles(find_character_bundles(GAME_DIR, char_id))


def resolve_submesh_order(env, char_id: str) -> list:
    """Find material order from the main SkinnedMeshRenderer (_Body)."""
    body_names = _source_body_names(char_id)
    for obj in env.objects:
        if obj.type.name != "SkinnedMeshRenderer":
            continue
        data = obj.read()
        try:
            go = data.m_GameObject.read()
            if go.m_Name not in body_names:
                continue
        except Exception:
            continue

        return _get_mat_names(data, char_id)

    return None


def _get_mat_names(smr_data, char_id: str) -> list:
    """Extract material base names from a SkinnedMeshRenderer."""
    import re
    mat_names = []
    for i, mat_ref in enumerate(smr_data.m_Materials):
        try:
            mat = mat_ref.read()
            name = mat.m_Name
            name = _strip_source_prefix(name, char_id)
            # Handle Name_Original_ and Scenario_02_ style prefixes
            name = re.sub(r'^[A-Za-z0-9]+_Original_', '', name)
            name = re.sub(r'^[A-Za-z]+_\d+_', '', name)
            mat_names.append(name)
        except Exception:
            if i == 0 and not mat_names:
                mat_names.append("Face")
            else:
                mat_names.append(f"Unknown_{i}")
    return mat_names


def _collect_renderer_material_targets(
    env,
    char_id: str,
    avatar_paths: set[str] | None = None,
) -> set[str]:
    targets: set[str] = set()
    for source in _source_ids(char_id):
        targets.update({
            f"{source}_Body", f"{source}_Hair", f"{source}_Face",
            f"{source}_EyeMouth", f"{source}_Weapon", f"{source}_Halo",
            f"{source}_Prop", f"{source}_Prop02", f"{source}_SkillProp",
            f"{source}_SkillProb_Cutin", f"{source}_Brush_01",
            f"{source}_Eyebrow", f"{source}_Eyebrow2",
        })
    body_names = _source_body_names(char_id)
    source_ids = _source_ids(char_id)

    for obj in env.objects:
        if obj.type.name != "SkinnedMeshRenderer":
            continue
        try:
            data = obj.read()
            go_name = str(data.m_GameObject.read().m_Name)
            mesh_name = str(getattr(data.m_Mesh.read(), "m_Name", "") or go_name)
            owner_path = _skinned_renderer_path(data)
        except Exception:
            continue
        if go_name not in body_names and not _is_skinned_export_candidate(
            char_id,
            go_name,
            mesh_name,
            owner_path,
            avatar_paths,
            source_ids,
        ):
            continue
        for mat_ref in getattr(data, "m_Materials", []) or []:
            try:
                targets.add(str(mat_ref.read().m_Name))
            except Exception:
                continue

    for obj in env.objects:
        if obj.type.name != "MeshRenderer":
            continue
        try:
            data = obj.read()
            go_name = str(data.m_GameObject.read().m_Name)
        except Exception:
            continue
        if go_name.lower() not in {name.lower() for name in _source_halo_names(char_id)}:
            continue
        for mat_ref in getattr(data, "m_Materials", []) or []:
            try:
                targets.add(str(mat_ref.read().m_Name))
            except Exception:
                continue

    return targets


def _export_smr_submeshes(env, go_name: str, char_id: str, output_dir: Path, mat_names: list, name_prefix: str = ""):
    """Export submeshes from a specific SkinnedMeshRenderer."""
    for obj in env.objects:
        if obj.type.name != "SkinnedMeshRenderer":
            continue
        data = obj.read()
        try:
            go = data.m_GameObject.read()
            if go.m_Name != go_name:
                continue
        except Exception:
            continue

        mesh = data.m_Mesh.read()
        obj_text = mesh.export()
        if isinstance(obj_text, bytes):
            obj_text = obj_text.decode('utf-8')

        lines = obj_text.split('\n')
        vertices, tex_coords, normals_l = [], [], []
        groups = {}
        current_group = None

        for line in lines:
            if line.startswith('v '):
                vertices.append([float(x) for x in line[2:].split()])
            elif line.startswith('vt '):
                tex_coords.append([float(x) for x in line[3:].split()])
            elif line.startswith('vn '):
                normals_l.append([float(x) for x in line[3:].split()])
            elif line.startswith('g '):
                current_group = line[2:].strip()
                groups.setdefault(current_group, [])
            elif line.startswith('f ') and current_group:
                groups[current_group].append(line[2:].strip())

        verts_arr = np.array(vertices, dtype=np.float32)
        uvs_arr = np.array(tex_coords, dtype=np.float32) if tex_coords else None
        normals_arr = np.array(normals_l, dtype=np.float32) if normals_l else None

        non_empty = [(k, v) for k, v in groups.items() if v]
        exported = []

        for gi, (gname, faces) in enumerate(non_empty):
            base_name = mat_names[gi] if gi < len(mat_names) else f"sub{gi}"
            full_name = f"{name_prefix}{base_name}" if name_prefix else base_name

            used_verts = {}
            new_verts, new_uvs, new_normals, face_list = [], [], [], []

            for face_line in faces:
                parts = face_line.split()
                face = []
                for p in parts:
                    idx = p.split('/')
                    vi = int(idx[0]) - 1
                    ti = int(idx[1]) - 1 if len(idx) > 1 and idx[1] else vi
                    ni = int(idx[2]) - 1 if len(idx) > 2 and idx[2] else vi
                    key = (vi, ti, ni)
                    if key not in used_verts:
                        used_verts[key] = len(new_verts)
                        new_verts.append(verts_arr[vi])
                        new_uvs.append(uvs_arr[ti] if uvs_arr is not None and ti < len(uvs_arr) else [0, 0])
                        new_normals.append(normals_arr[ni] if normals_arr is not None and ni < len(normals_arr) else [0, 1, 0])
                    face.append(used_verts[key])
                face_list.append(face)

            if not new_verts:
                continue

            sub_mesh = trimesh.Trimesh(
                vertices=np.array(new_verts, dtype=np.float32),
                faces=np.array(face_list, dtype=np.int32),
                vertex_normals=np.array(new_normals, dtype=np.float32),
                process=False,
            )
            sub_mesh.visual = trimesh.visual.TextureVisuals(
                uv=np.array(new_uvs, dtype=np.float32),
                material=trimesh.visual.material.SimpleMaterial(),
            )

            out_path = output_dir / f"{char_id}_{full_name}.glb"
            sub_mesh.export(str(out_path), file_type='glb')
            exported.append({"name": full_name, "file": f"{char_id}_{full_name}.glb", "verts": len(new_verts), "faces": len(face_list)})
            print(f"  [{gi}] {full_name}: {len(new_verts)} verts, {len(face_list)} tris")

        return exported

    return []


def export_submeshes(env, char_id: str, output_dir: Path, submesh_names: list):
    """Export submeshes from ALL relevant SkinnedMeshRenderers and MeshRenderers."""
    all_exported = []
    body_names = _source_body_names(char_id)

    # Export main Body SMR
    exported_go_names = set()
    for body_name in body_names:
        body_exported = _export_smr_submeshes(env, body_name, char_id, output_dir, submesh_names)
        if body_exported:
            exported_go_names.add(body_name)
            all_exported.extend(body_exported)
            break

    # Find and export additional SMRs (Face01, Face02, etc.)
    for obj in env.objects:
        if obj.type.name != "SkinnedMeshRenderer":
            continue
        data = obj.read()
        try:
            go = data.m_GameObject.read()
            go_name = go.m_Name
        except Exception:
            continue

        # Skip already exported, weapons, props, alternate outfits that
        # should not be visible on the base model. Outline filtering is
        # done via mesh-name prefix (OL_) below, because some characters
        # (e.g. CH0288) carry a "_Outline" suffix on the *real* prop
        # GameObjects (Bag_Outline, Train_Outline, Face_Outline) while
        # the actual outline meshes live on OL_-prefixed mesh assets.
        if go_name in exported_go_names:
            continue
        lower_go_name = go_name.lower()
        if any(skip in lower_go_name for skip in ["weapon", "prop", "glass", "scenario", "carrier"]):
            continue
        try:
            mesh_name_for_filter = data.m_Mesh.read().m_Name if data.m_Mesh.path_id else ""
        except Exception:
            mesh_name_for_filter = ""
        if mesh_name_for_filter.lower().startswith("ol_"):
            continue
        if not _has_source_prefix(go_name, char_id):
            continue

        exported_go_names.add(go_name)
        # Get material names for this SMR
        extra_mat_names = _get_mat_names(data, char_id)
        # Use SMR name as prefix (e.g. Face01_). Strip a trailing _Outline
        # so CH0288's Bag_Outline / Train_Outline / Face_Outline export as
        # Bag / Train / Face. Only the main Body SMR drops its prefix; even
        # a "Face" SMR keeps the prefix so its EyeMouth submesh does not
        # collide with the Body's EyeMouth.
        smr_suffix = _strip_source_prefix(go_name, char_id)
        if smr_suffix.lower().endswith("_outline"):
            smr_suffix = smr_suffix.rsplit("_", 1)[0]
        elif smr_suffix.lower().endswith("_outlline"):
            smr_suffix = smr_suffix.rsplit("_", 1)[0]
        prefix = "" if smr_suffix == "Body" else f"{smr_suffix}_"

        extra_exported = _export_smr_submeshes(env, go_name, char_id, output_dir, extra_mat_names, prefix)
        all_exported.extend(extra_exported)

    # Export Halo and other static MeshRenderer objects
    # Compare halo names case-insensitively because some prefabs use
    # "Ch####_Halo" rather than the canonical "CH####_Halo".
    halo_names_lower = {name.lower() for name in _source_halo_names(char_id)}
    for obj in env.objects:
        if obj.type.name != "MeshRenderer":
            continue
        data = obj.read()
        try:
            go = data.m_GameObject.read()
            go_name = go.m_Name
        except Exception:
            continue

        static_fx_spec = _static_fx_mesh_spec(char_id, go_name)
        is_halo_name = go_name.lower() in halo_names_lower
        if go_name in exported_go_names:
            continue
        if not static_fx_spec and not (_has_source_prefix(go_name, char_id) or is_halo_name):
            continue
        if not static_fx_spec and any(skip in go_name.lower() for skip in ["weapon", "prop", "outline", "glass"]):
            continue
        # Only export the base halo. Alternate carrier/scenario halos overlap
        # the default character when the viewer has no variant selector.
        if not static_fx_spec and not is_halo_name:
            continue

        exported_go_names.add(go_name)

        # For MeshRenderer, get the MeshFilter's mesh
        mesh_filter = None
        for comp_pair in go.m_Components:
            try:
                comp = comp_pair.read()
                if comp.__class__.__name__ == "MeshFilter" or (hasattr(comp, 'type') and 'MeshFilter' in str(comp.type)):
                    mesh_filter = comp
                    break
            except Exception:
                continue

        # Try to find MeshFilter via objects on same GameObject
        if mesh_filter is None:
            for obj2 in env.objects:
                if obj2.type.name != "MeshFilter":
                    continue
                try:
                    mf_data = obj2.read()
                    mf_go = mf_data.m_GameObject.read()
                    if mf_go.m_Name == go_name:
                        mesh_filter = mf_data
                        break
                except Exception:
                    continue

        if mesh_filter is None:
            continue

        try:
            mesh = mesh_filter.m_Mesh.read()
            obj_text = mesh.export()
            if isinstance(obj_text, bytes):
                obj_text = obj_text.decode('utf-8')

            # Parse OBJ
            vertices, tex_coords, normals_l = [], [], []
            faces_list = []
            for line in obj_text.split('\n'):
                if line.startswith('v '):
                    vertices.append([float(x) for x in line[2:].split()])
                elif line.startswith('vt '):
                    tex_coords.append([float(x) for x in line[3:].split()])
                elif line.startswith('vn '):
                    normals_l.append([float(x) for x in line[3:].split()])
                elif line.startswith('f '):
                    faces_list.append(line[2:].strip())

            if not vertices or not faces_list:
                continue

            verts_arr = np.array(vertices, dtype=np.float32)
            uvs_arr = np.array(tex_coords, dtype=np.float32) if tex_coords else None
            normals_arr = np.array(normals_l, dtype=np.float32) if normals_l else None

            used_verts = {}
            new_verts, new_uvs, new_normals, face_indices = [], [], [], []

            for face_line in faces_list:
                parts = face_line.split()
                face = []
                for p in parts:
                    idx = p.split('/')
                    vi = int(idx[0]) - 1
                    ti = int(idx[1]) - 1 if len(idx) > 1 and idx[1] else vi
                    ni = int(idx[2]) - 1 if len(idx) > 2 and idx[2] else vi
                    key = (vi, ti, ni)
                    if key not in used_verts:
                        used_verts[key] = len(new_verts)
                        new_verts.append(verts_arr[vi])
                        new_uvs.append(uvs_arr[ti] if uvs_arr is not None and ti < len(uvs_arr) else [0, 0])
                        new_normals.append(normals_arr[ni] if normals_arr is not None and ni < len(normals_arr) else [0, 1, 0])
                    face.append(used_verts[key])
                face_indices.append(face)

            mesh_name = (
                static_fx_spec["name"]
                if static_fx_spec
                else "Halo" if is_halo_name
                else _strip_source_prefix(go_name, char_id)
            )
            sub_mesh = trimesh.Trimesh(
                vertices=np.array(new_verts, dtype=np.float32),
                faces=np.array(face_indices, dtype=np.int32),
                vertex_normals=np.array(new_normals, dtype=np.float32),
                process=False,
            )
            sub_mesh.visual = trimesh.visual.TextureVisuals(
                uv=np.array(new_uvs, dtype=np.float32),
                material=trimesh.visual.material.SimpleMaterial(),
            )

            out_path = output_dir / f"{char_id}_{mesh_name}.glb"
            sub_mesh.export(str(out_path), file_type='glb')
            mesh_entry = {"name": mesh_name, "file": f"{char_id}_{mesh_name}.glb", "verts": len(new_verts), "faces": len(face_indices)}
            if static_fx_spec:
                mesh_entry.update({k: v for k, v in static_fx_spec.items() if k != "name"})
            all_exported.append(mesh_entry)
            print(f"  [MeshRenderer] {mesh_name}: {len(new_verts)} verts, {len(face_indices)} tris")
        except Exception as e:
            print(f"  [MeshRenderer] {go_name} - FAILED: {e}")

    return all_exported


def export_textures(env, char_id: str, output_dir: Path, wanted_names: set[str] | None = None):
    """Export textures referenced by selected character materials."""
    tex_dir = output_dir / "textures"
    tex_dir.mkdir(parents=True, exist_ok=True)

    exported = []
    seen = set()

    for path, obj in env.container.items():
        if obj.type.name != "Texture2D":
            continue
        data = obj.read()
        name = data.m_Name if hasattr(data, 'm_Name') else ""
        if not name or name in seen:
            continue
        if wanted_names is not None and name not in wanted_names:
            continue
        seen.add(name)

        try:
            img = data.image
            safe_name = name.replace('.psd', '').replace('.tga', '').replace(' ', '_')
            fname = f"{safe_name}.png"
            img.save(str(tex_dir / fname))
            exported.append({"name": name, "file": f"textures/{fname}", "size": list(img.size)})
            print(f"  [Tex] {name} ({img.size[0]}x{img.size[1]})")
        except Exception as e:
            print(f"  [Tex] {name} - FAILED: {e}")

    return exported


def extract_halo_transform(env, char_id: str):
    """Extract Halo GameObject's local transform from the prefab hierarchy."""
    # Match case-insensitively: some prefabs use mixed-case GameObject names
    # like "Ch0145_Halo" instead of the canonical "CH0145_Halo".
    halo_names = {name.lower() for name in _source_halo_names(char_id)}
    for obj in env.objects:
        if obj.type.name != "Transform" and obj.type.name != "RectTransform":
            continue
        try:
            data = obj.read()
            go = data.m_GameObject.read()
            if go.m_Name.lower() not in halo_names:
                continue
            pos = data.m_LocalPosition
            rot = data.m_LocalRotation
            scale = data.m_LocalScale
            return {
                "position": {"x": pos.x, "y": pos.y, "z": pos.z},
                "rotation": {"x": rot.x, "y": rot.y, "z": rot.z, "w": rot.w},
                "scale": {"x": scale.x, "y": scale.y, "z": scale.z},
            }
        except Exception:
            continue
    return None


def extract_halo_metadata(env, char_id: str) -> tuple[dict | None, dict | None, dict | None]:
    """Extract richer halo placement metadata when the source prefab has it."""
    try:
        head_transform = find_head_transform(env, char_id)
        halo_anchor = find_halo_anchor_transform(env, char_id)
        halo_follow = apply_halo_follow_depth_mode(env, char_id, find_halo_follow_data(env, char_id))
    except Exception as exc:
        print(f"  Halo metadata failed: {exc}")
        return None, None, None
    return head_transform, halo_anchor, halo_follow


def export_materials(
    env,
    char_id: str,
    output_dir: Path,
    avatar_paths: set[str] | None = None,
    extra_targets: set[str] | None = None,
):
    """Export material properties."""
    mat_dir = output_dir / "materials"
    mat_dir.mkdir(parents=True, exist_ok=True)

    exported = []
    referenced_textures: set[str] = set()
    targets = _collect_renderer_material_targets(env, char_id, avatar_paths)
    if extra_targets:
        targets.update(extra_targets)

    # Some bundles (notably the meshes bundle) embed mock Material objects
    # that share a name with the real character material but reference the
    # placeholder `FX/General Unlit Texture` shader and ship none of the
    # truth uniforms. The container iteration order is non-deterministic,
    # so iterating naively can leave the wrong variant on disk and silently
    # break the face/hair shader port. Score each candidate and keep the
    # one whose shader looks like a real MX/* character pass.
    def shader_score(shader_name: str) -> int:
        text = (shader_name or "").lower()
        if not text:
            return 0
        if "fx/general unlit" in text:
            return 1
        return 10

    candidates: dict[str, tuple[int, dict, set[str]]] = {}

    for path, obj in env.container.items():
        if obj.type.name != "Material":
            continue
        data = obj.read()
        name = data.m_Name
        if name not in targets:
            continue

        sp = data.m_SavedProperties
        # Capture the shader name so the runtime can route Transparent/Hair/
        # Simple-Transparent/etc. to the correct GLSL pipeline. Without this
        # the JSON only carries _SrcBlend/_DstBlend which Unity often leaves
        # at URP defaults (1, 0) for transparent materials.
        shader_name = None
        try:
            if data.m_Shader and getattr(data.m_Shader, "path_id", 0):
                shader_obj = data.m_Shader.read()
                shader_name = (
                    getattr(getattr(shader_obj, "m_ParsedForm", None), "m_Name", None)
                    or getattr(shader_obj, "name", None)
                )
        except Exception:
            shader_name = None
        mat_data = {
            "name": name,
            "shader": shader_name or "",
            "floats": {k: v for k, v in sp.m_Floats},
            "colors": {k: {"r": v.r, "g": v.g, "b": v.b, "a": v.a} for k, v in sp.m_Colors},
            "textures": {},
        }
        local_referenced: set[str] = set()
        for k, v in sp.m_TexEnvs:
            texture_name = None
            try:
                texture = v.m_Texture.read() if v.m_Texture and v.m_Texture.path_id else None
                texture_name = texture.m_Name if texture is not None else None
            except Exception:
                texture_name = None
            mat_data["textures"][k] = {
                "scale": [v.m_Scale.x, v.m_Scale.y],
                "offset": [v.m_Offset.x, v.m_Offset.y],
            }
            if texture_name:
                mat_data["textures"][k]["name"] = texture_name
                local_referenced.add(texture_name)

        # Higher score wins; ties prefer the variant with more uniforms
        # (truth materials carry the full _ShadowThreshold / _RimStrength
        # set, whereas the unlit mock ships only blend / cull state).
        score = (
            shader_score(shader_name),
            len(mat_data["floats"]) + len(mat_data["colors"]),
        )
        existing = candidates.get(name)
        if existing is None or score > existing[0]:
            candidates[name] = (score, mat_data, local_referenced)

    for name, (_score, mat_data, local_referenced) in candidates.items():
        fname = f"{name}.json"
        (mat_dir / fname).write_text(json.dumps(mat_data, indent=2), encoding="utf-8")
        exported.append({"name": name, "file": f"materials/{fname}"})
        referenced_textures.update(local_referenced)
        print(f"  [Mat] {name}")

    return exported, referenced_textures


def _add_material_aliases(
    char_id: str,
    output_dir: Path,
    mat_data: list[dict],
    skinned_data: list[dict],
    referenced_textures: set[str],
) -> None:
    """Add scoped material aliases for parts that reuse another source material."""
    specs = MATERIAL_ALIASES.get(char_id.upper(), [])
    if not specs:
        return

    mat_dir = output_dir / "materials"
    existing = {item.get("name") for item in mat_data}

    for spec in specs:
        alias = spec["alias"]
        source = spec["source"]
        source_path = mat_dir / f"{source}.json"
        if not source_path.exists():
            continue

        alias_data = json.loads(source_path.read_text(encoding="utf-8"))
        alias_data["name"] = alias
        alias_data["alias_of"] = source
        if spec.get("shader") and not alias_data.get("shader"):
            alias_data["shader"] = spec["shader"]
        alias_path = mat_dir / f"{alias}.json"
        alias_path.write_text(json.dumps(alias_data, indent=2), encoding="utf-8")

        if alias not in existing:
            mat_data.append({
                "name": alias,
                "file": f"materials/{alias_path.name}",
                "alias_of": source,
            })
            existing.add(alias)

        for item in skinned_data:
            if item.get("name") == spec["part_name"]:
                item["material_name"] = alias

        for tex in alias_data.get("textures", {}).values():
            if tex.get("name"):
                referenced_textures.add(tex["name"])


def _alias_exported_material(
    output_dir: Path,
    mat_data: list[dict],
    referenced_textures: set[str],
    *,
    source_name: str,
    alias_name: str,
    remove_source: bool = False,
    color_overrides: dict[str, dict[str, float]] | None = None,
) -> bool:
    """Copy an exported material JSON under a loader-safe alias."""
    mat_dir = output_dir / "materials"
    source_path = mat_dir / f"{source_name}.json"
    if not source_path.exists():
        return False

    alias_data = json.loads(source_path.read_text(encoding="utf-8"))
    alias_data["name"] = alias_name
    alias_data["alias_of"] = source_name
    if color_overrides:
        colors = alias_data.setdefault("colors", {})
        for color_name, value in color_overrides.items():
            colors[color_name] = dict(value)
    alias_path = mat_dir / f"{alias_name}.json"
    alias_path.write_text(json.dumps(alias_data, indent=2), encoding="utf-8")

    mat_data[:] = [
        item
        for item in mat_data
        if item.get("name") not in {source_name, alias_name}
    ]
    mat_data.append({
        "name": alias_name,
        "file": f"materials/{alias_path.name}",
        "alias_of": source_name,
    })

    for tex in alias_data.get("textures", {}).values():
        if tex.get("name"):
            referenced_textures.add(tex["name"])
    if remove_source:
        try:
            source_path.unlink()
        except OSError:
            pass
    return True


def export_common_textures(output_dir: Path):
    """Export shared textures (mouth atlas etc)."""
    tex_dir = output_dir / "textures"
    tex_dir.mkdir(parents=True, exist_ok=True)

    common_bundles = [GAME_DIR / b for b in COMMON_TEX_BUNDLES if (GAME_DIR / b).exists()]
    if not common_bundles:
        return []

    env = UnityPy.load(*[str(b) for b in common_bundles])
    exported = []

    for path, obj in env.container.items():
        if obj.type.name != "Texture2D":
            continue
        data = obj.read()
        name = data.m_Name
        if "Mouth" not in name:
            continue

        try:
            img = data.image
            fname = f"{name}.png"
            img.save(str(tex_dir / fname))
            exported.append({"name": name, "file": f"textures/{fname}", "size": list(img.size)})
            print(f"  [Common] {name} ({img.size[0]}x{img.size[1]})")
        except Exception as exc:
            print(f"  [Common] skip {name}: {exc}")

    return exported


def export_ch0072_flowerpot_props(output_dir: Path) -> tuple[list[dict], list[dict], list[dict]]:
    """Export Mari's cafe watering-can prop for my_cafe_01_b_flowerpot."""
    bundle_paths = [GAME_DIR / name for name in CH0072_FLOWERPOT_BUNDLES.values()]
    if not all(path.exists() for path in bundle_paths):
        missing = [path.name for path in bundle_paths if not path.exists()]
        print(f"  [CafeProp] CH0072 flowerpot bundles missing: {missing}")
        return [], [], []

    env = UnityPy.load(*[str(path) for path in bundle_paths])
    avatar_tos = load_avatar_tos(env, "my_cafe_01_b_flowerpot")
    waterpot_animations = []
    if avatar_tos:
        for animation in decode_animation_bundles([GAME_DIR / CH0072_FLOWERPOT_BUNDLES["animationclips"]], avatar_tos):
            if animation.name == "Cafe_my_cafe_01_b_flowerpot":
                animation.name = "Mari_Original_my_cafe_01_b_flowerpot"
                waterpot_animations.append(animation)
    else:
        print("  [CafeProp] CH0072 flowerpot avatar map missing")

    prop_smr = None
    for obj in env.objects:
        if obj.type.name != "SkinnedMeshRenderer":
            continue
        try:
            smr = obj.read()
            go_name = str(smr.m_GameObject.read().m_Name)
            mesh_name = str(getattr(smr.m_Mesh.read(), "m_Name", "") or go_name)
        except Exception:
            continue
        if go_name == "Mari_Original_WaterPot_Mesh" or mesh_name == "Mari_Original_WaterPot_Mesh":
            prop_smr = smr
            break

    skinned_data: list[dict] = []
    if prop_smr is None:
        print("  [CafeProp] Mari_Original_WaterPot_Mesh not found")
    else:
        item = export_skinned_smr(
            output_dir / "skinned" / "CH0072_WaterPot.glb",
            prop_smr,
            "WaterPot",
            char_id="CH0072",
            animations=waterpot_animations,
            source_ids=_source_ids("CH0072"),
        )
        data = item.__dict__.copy()
        data["file"] = f"skinned/{item.file}"
        data["visibility"] = {
            "default_visible": False,
            "show_clip_patterns": ["my_cafe_01_b_flowerpot"],
        }
        attach_config = _load_external_prop_configs().get("CH0072::WaterPot")
        attach = None
        if attach_config:
            attach_config = {**attach_config, "prop_name": attach_config.get("prop_name", "WaterPot")}
            attach = compute_external_prop_attach(env, config=attach_config, game_dir=GAME_DIR)
        else:
            print("  [CafeProp] no external_prop_config entry for CH0072::WaterPot")
        if attach:
            data["parent_bone"] = attach["bone"]
            data["parent_local_position"] = attach["position"]
            data["parent_local_rotation"] = attach["rotation"]
            data["parent_local_scale"] = attach["scale"]
        skinned_data.append(data)
        print(
            f"  [CafeProp] WaterPot: {item.verts} verts, {item.faces} tris, "
            f"{item.bones} bones, {len(item.animations)} animations"
        )

    mat_data, referenced_textures = export_materials(
        env,
        "CH0072",
        output_dir,
        extra_targets={"Mari_Original_WaterPot"},
    )
    tex_data = export_textures(env, "CH0072", output_dir, wanted_names=referenced_textures)
    return skinned_data, mat_data, tex_data


def export_ch0091_seahouse_tubes_props(output_dir: Path) -> tuple[list[dict], list[dict], list[dict]]:
    """Export Hoshino Swimsuit's cafe seahouse tube prop."""
    bundle_paths = [GAME_DIR / name for name in CH0091_SEAHOUSE_TUBES_BUNDLES.values()]
    if not all(path.exists() for path in bundle_paths):
        missing = [path.name for path in bundle_paths if not path.exists()]
        print(f"  [CafeProp] CH0091 seahouse tubes bundles missing: {missing}")
        return [], [], []

    env = UnityPy.load(*[str(path) for path in bundle_paths])
    avatar_tos = load_avatar_tos(env, "my_seahouse_01_tubes")
    tube_animations = []
    if avatar_tos:
        for animation in decode_animation_bundles(
            [GAME_DIR / CH0091_SEAHOUSE_TUBES_BUNDLES["animationclips"]],
            avatar_tos,
        ):
            if animation.name == "my_seahouse_01_tubes_Hoshino_Swimsuit_01":
                animation.name = "Hoshino_Swimsuit_Cafe_my_seahouse_01_tubes_01"
                tube_animations.append(animation)
    else:
        print("  [CafeProp] CH0091 seahouse tubes avatar map missing")

    prop_smr = None
    for obj in env.objects:
        if obj.type.name != "SkinnedMeshRenderer":
            continue
        try:
            smr = obj.read()
            go_name = str(smr.m_GameObject.read().m_Name)
            mesh_name = str(getattr(smr.m_Mesh.read(), "m_Name", "") or go_name)
        except Exception:
            continue
        if go_name == "my_seahouse_01_tubes" or mesh_name == "my_seahouse_01_tubes":
            prop_smr = smr
            break

    skinned_data: list[dict] = []
    if prop_smr is None:
        print("  [CafeProp] my_seahouse_01_tubes skinned mesh not found")
    else:
        item = export_skinned_smr(
            output_dir / "skinned" / "CH0091_SeahouseTubes.glb",
            prop_smr,
            "SeahouseTubes",
            char_id="CH0091",
            animations=tube_animations,
            source_ids=_source_ids("CH0091"),
        )
        data = item.__dict__.copy()
        data["file"] = f"skinned/{item.file}"
        data["submesh_order"] = ["SeahouseTubes"]
        data["visibility"] = {
            "default_visible": False,
            "show_clip_patterns": ["Cafe_my_seahouse_01_tubes"],
        }
        data["timeline_root"] = True
        data["ignore_vertex_colors"] = True
        skinned_data.append(data)
        print(
            f"  [CafeProp] SeahouseTubes: {item.verts} verts, {item.faces} tris, "
            f"{item.bones} bones, {len(item.animations)} animations"
        )

    mat_data, referenced_textures = export_materials(
        env,
        "CH0091",
        output_dir,
        extra_targets={"Material #2557"},
    )
    if _alias_exported_material(
        output_dir,
        mat_data,
        referenced_textures,
        source_name="Material #2557",
        alias_name="SeahouseTubes",
        remove_source=True,
        color_overrides={
            "_Color": {
                "r": 1.0,
                "g": 1.0,
                "b": 1.0,
                "a": 1.0,
            },
        },
    ):
        print("  [CafeProp] SeahouseTubes material alias: Material #2557 -> SeahouseTubes")
    tex_data = export_textures(env, "CH0091", output_dir, wanted_names=referenced_textures)
    return skinned_data, mat_data, tex_data


def _diagnose_orphan_skinned_meshes(skinned_data: list[dict], avatar_paths: set[str]) -> None:
    """Warn when an exported skinned mesh has a root bone outside the character avatar.

    Such meshes are usually external props (e.g. cafe-furniture skeletons) that
    need parent_bone metadata to attach to a character bone at runtime. This
    diagnostic surfaces the case so we don't silently ship a prop that drops to
    the floor (root cause of the CH0072 WaterPot bug).
    """
    if not avatar_paths:
        return
    avatar_tail = {p.split("/")[-1] for p in avatar_paths if isinstance(p, str)}
    issues: list[str] = []
    for entry in skinned_data:
        root_bone = entry.get("root_bone") or ""
        if not root_bone:
            continue
        if root_bone in avatar_tail:
            continue
        if entry.get("parent_bone") or entry.get("timeline_root"):
            continue  # already handled by attach metadata or timeline root space
        issues.append(
            f"  ! {entry.get('name')}: root_bone='{root_bone}' is not in the "
            f"character Avatar TOS and has no parent_bone metadata. Add an entry "
            f"to tools/external_prop_config.json or this prop will sit at rest pose."
        )
    if issues:
        print("\n[Diagnostic] external skinned skeletons without attach metadata:")
        for line in issues:
            print(line)



def main():
    if len(sys.argv) < 2:
        print("Usage: python tools/export_character.py <CHAR_ID>")
        print("Example: python tools/export_character.py CH0335")
        sys.exit(1)

    char_id = sys.argv[1].upper()
    output_dir = OUTPUT_BASE / char_id.lower()
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"=== Exporting {char_id} ===")
    print(f"Output: {output_dir}\n")

    # Find bundles
    bundles = find_bundles(char_id)
    print(f"Found bundles:")
    for k, v in bundles.items():
        if v:
            print(f"  {k}: {len(v)} bundles")

    if not bundles["meshes"]:
        print(f"ERROR: No mesh bundles found for {char_id}")
        sys.exit(1)

    # Load render-source bundles plus their CAB dependency closure. Animation
    # clips are decoded from their own bundles to avoid UnityPy object collisions
    # when unrelated AssetBundle payloads share internal CAB/path identifiers.
    render_seed = (
        bundles["meshes"]
        + bundles["textures"]
        + bundles["materials"]
        + bundles["prefabs"]
        + bundles["assets"]
    )
    dependency_candidates = (
        find_character_bundles(GAME_DIR, char_id)
        + find_common_dependency_candidates(GAME_DIR)
        + [GAME_DIR / name for name in COMMON_TEX_BUNDLES if (GAME_DIR / name).exists()]
    )
    resolution = resolve_dependency_closure(
        GAME_DIR,
        render_seed,
        candidate_bundles=dependency_candidates,
        cab_index_file=CAB_INDEX_FILE,
    )

    if resolution.added_dependencies:
        print(f"\nResolved CAB dependencies: {len(resolution.added_dependencies)} bundle(s)")
        for dep in resolution.added_dependencies[:20]:
            print(f"  + {dep.name}")
        if len(resolution.added_dependencies) > 20:
            print(f"  ... {len(resolution.added_dependencies) - 20} more")
    if resolution.unresolved_cabs:
        print(f"\nUnresolved CABs: {len(resolution.unresolved_cabs)}")
        for cab in resolution.unresolved_cabs[:12]:
            print(f"  ! {cab}")
        if len(resolution.unresolved_cabs) > 12:
            print(f"  ... {len(resolution.unresolved_cabs) - 12} more")

    all_paths = [str(b) for b in resolution.bundles]

    print(f"\nLoading {len(all_paths)} bundles...")
    env = UnityPy.load(*all_paths)

    # Resolve submesh order from SkinnedMeshRenderer
    print(f"\nResolving submesh order...")
    mat_order = resolve_submesh_order(env, char_id)
    if mat_order:
        print(f"  Material order: {mat_order}")
    else:
        # Fallback to common order by submesh count
        print(f"  Could not resolve, using fallback")
        mat_order = None

    # Export meshes
    print(f"\nExporting meshes...")
    if mat_order is None:
        # Need to determine submesh count first
        for obj in env.objects:
            if obj.type.name == "SkinnedMeshRenderer":
                data = obj.read()
                try:
                    go = data.m_GameObject.read()
                    if go.m_Name in _source_body_names(char_id):
                        mesh = data.m_Mesh.read()
                        obj_text = mesh.export()
                        if isinstance(obj_text, bytes):
                            obj_text = obj_text.decode('utf-8')
                        n_groups = sum(1 for line in obj_text.split('\n') if line.startswith('g ') and any(
                            fl.startswith('f ') for fl in obj_text.split('\n')[obj_text.split('\n').index(line):]
                        ))
                        mat_order = SUBMESH_ORDER.get(n_groups, [f"sub{i}" for i in range(n_groups)])
                        break
                except Exception:
                    continue
        if mat_order is None:
            mat_order = ["Body"]

    mesh_data = export_submeshes(env, char_id, output_dir, mat_order)

    # Decode source AnimationClip data into glTF-ready TRS channels.
    print(f"\nDecoding animations...")
    avatar_preference = next((source for source in _source_ids(char_id) if source.upper() != char_id), char_id)
    avatar_tos = load_avatar_tos(env, avatar_preference)
    avatar_paths = set(avatar_tos.values()) if avatar_tos else set()
    if avatar_tos and bundles["animationclips"]:
        animation_data = decode_animation_bundles(bundles["animationclips"], avatar_tos)
    else:
        animation_data = []
        if not avatar_tos:
            print("  [Anim] No Avatar m_TOS path map found")
        if not bundles["animationclips"]:
            print("  [Anim] No animation clip bundles found")

    # Export skinned source GLBs for AnimationClip playback.
    print(f"\nExporting skinned source meshes...")
    skinned_data = export_character_skinned_assets(
        env,
        char_id,
        output_dir,
        animations=animation_data,
        avatar_paths=avatar_paths,
        source_ids=_source_ids(char_id),
    )

    extra_skinned_data: list[dict] = []
    extra_mat_data: list[dict] = []
    extra_tex_data: list[dict] = []
    if char_id == "CH0072":
        print(f"\nExporting cafe props...")
        extra_skinned_data, extra_mat_data, extra_tex_data = export_ch0072_flowerpot_props(output_dir)
        skinned_data.extend(extra_skinned_data)
    if char_id == "CH0091":
        print(f"\nExporting cafe props...")
        extra_skinned_data, extra_mat_data, extra_tex_data = export_ch0091_seahouse_tubes_props(output_dir)
        skinned_data.extend(extra_skinned_data)

    _diagnose_orphan_skinned_meshes(skinned_data, avatar_paths)

    # Export materials
    print(f"\nExporting materials...")
    mat_data, referenced_textures = export_materials(
        env,
        char_id,
        output_dir,
        avatar_paths=avatar_paths,
    )
    _add_material_aliases(char_id, output_dir, mat_data, skinned_data, referenced_textures)

    # Export textures
    print(f"\nExporting textures...")
    tex_data = export_textures(env, char_id, output_dir, wanted_names=referenced_textures)

    # Export common textures (mouth atlas)
    print(f"\nExporting common textures...")
    common_data = export_common_textures(output_dir)

    # Extract Halo transform
    print(f"\nExtracting Halo transform...")
    halo_transform = extract_halo_transform(env, char_id)
    if halo_transform:
        print(f"  Position: {halo_transform['position']}")
        print(f"  Rotation: {halo_transform['rotation']}")
        print(f"  Scale: {halo_transform['scale']}")
    else:
        print(f"  No Halo transform found")

    head_transform, halo_anchor, halo_follow = extract_halo_metadata(env, char_id)
    if head_transform:
        print(f"  Head anchor: {head_transform['bone']} at {head_transform['position']}")
    if halo_follow:
        print(f"  Halo follow: {halo_follow['follow_target']} at {halo_follow['target_position']}")

    # Write manifest
    manifest = {
        "char_id": char_id,
        "submesh_order": mat_order,
        "meshes": mesh_data,
        "skinned_meshes": skinned_data,
        "textures": _dedupe_manifest_items(tex_data + extra_tex_data + common_data),
        "materials": _dedupe_manifest_items(mat_data + extra_mat_data),
        "animations": [item.summary() for item in animation_data],
        "source_bundles": {k: [b.name for b in v] for k, v in bundles.items() if v},
        "resolved_dependencies": _manifest_resolved_dependencies(resolution.added_dependencies),
        "unresolved_cabs": resolution.unresolved_cabs,
    }
    if halo_transform and not halo_anchor:
        manifest["halo_transform"] = halo_transform
    if head_transform:
        manifest["head_transform"] = head_transform
    if halo_anchor:
        manifest["halo_anchor"] = halo_anchor
    if halo_follow:
        manifest["halo_follow"] = halo_follow

    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"\nBaking halo mesh transform...")
    export_halo_mesh_character(GAME_DIR, OUTPUT_BASE, char_id)

    print(f"\n=== Done! ===")
    print(f"Manifest: {manifest_path}")
    print(f"Meshes: {len(mesh_data)}")
    print(f"Skinned meshes: {len(skinned_data)}")
    print(f"Animations: {len(animation_data)}")
    print(f"Textures: {len(tex_data) + len(common_data)}")
    print(f"Materials: {len(mat_data)}")


if __name__ == "__main__":
    main()
