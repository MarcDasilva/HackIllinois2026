"""
Fast mesh cleanup and PBR GLB export — NO Blender, NO Cycles baking.

Replaces the old headless-Blender approach with a pure trimesh/pygltflib
pipeline that runs in ~3-5 s on CPU vs ~90 s with Blender+Cycles.

Called by Modal Stage C via subprocess as:
    python cleanup_and_bake.py \
        --input  /path/to/raw_mesh.obj \
        --output /path/to/cleaned.glb \
        --spec   /path/to/asset_spec.json

PBR materials are encoded directly as GLTF material constants (baseColorFactor,
metallicFactor, roughnessFactor) — no ray-traced texture baking required.
The output is a self-contained GLB with embedded colour data.
"""

from __future__ import annotations

import argparse
import json
import logging
import struct
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [CLEANUP] %(levelname)s: %(message)s",
)
log = logging.getLogger("cleanup_and_bake")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = sys.argv[1:]

    parser = argparse.ArgumentParser(description="Fast mesh cleanup + GLB export")
    parser.add_argument("--input",  required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--spec",   required=True)
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# Hex → linear RGBA
# ---------------------------------------------------------------------------
def _hex_to_linear_rgba(hex_str: str) -> list[float]:
    hex_str = hex_str.lstrip("#")
    if len(hex_str) == 3:
        hex_str = "".join(c * 2 for c in hex_str)
    r, g, b = (int(hex_str[i : i + 2], 16) / 255.0 for i in (0, 2, 4))

    def to_lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return [to_lin(r), to_lin(g), to_lin(b), 1.0]


# ---------------------------------------------------------------------------
# Main cleanup pipeline
# ---------------------------------------------------------------------------
def main():
    args   = parse_args()
    spec   = json.loads(Path(args.spec).read_text())

    gen_plan  = spec.get("generation_plan", {})
    qt        = gen_plan.get("quality_targets", {})
    max_tris  = int(qt.get("max_tris", 80_000))
    spec_mats = spec.get("object", {}).get("materials", [])
    spec_size = spec.get("object", {}).get("size_m", {})

    import trimesh
    import numpy as np

    # ── Load ─────────────────────────────────────────────────────────────────
    log.info("Loading mesh: %s", args.input)
    scene = trimesh.load(args.input, force="scene", process=False)

    if isinstance(scene, trimesh.Trimesh):
        mesh = scene
    elif isinstance(scene, trimesh.Scene):
        meshes = [g for g in scene.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise RuntimeError(f"No mesh geometry found in {args.input}")
        mesh = trimesh.util.concatenate(meshes)
    else:
        raise RuntimeError(f"Unexpected scene type: {type(scene)}")

    log.info("Loaded: %d verts, %d faces", len(mesh.vertices), len(mesh.faces))

    # ── Merge duplicate vertices ──────────────────────────────────────────────
    mesh.merge_vertices()

    # ── Remove degenerate/duplicate faces ────────────────────────────────────
    # trimesh API differs across versions (some methods were renamed/removed).
    remove_degenerate = getattr(mesh, "remove_degenerate_faces", None)
    if callable(remove_degenerate):
        remove_degenerate()
    else:
        mesh.update_faces(mesh.nondegenerate_faces())

    remove_duplicate = getattr(mesh, "remove_duplicate_faces", None)
    if callable(remove_duplicate):
        remove_duplicate()
    else:
        mesh.update_faces(mesh.unique_faces())

    mesh.remove_unreferenced_vertices()

    # ── Fix winding / normals ─────────────────────────────────────────────────
    trimesh.repair.fix_winding(mesh)
    trimesh.repair.fix_normals(mesh)

    # ── Decimate to max_tris ──────────────────────────────────────────────────
    current_tris = len(mesh.faces)
    if current_tris > max_tris:
        ratio = max_tris / current_tris
        log.info("Decimating %d → target %d tris (ratio=%.3f)", current_tris, max_tris, ratio)
        mesh = mesh.simplify_quadric_decimation(max_tris)
        log.info("After decimate: %d faces", len(mesh.faces))

    # ── Scale to spec dimensions ──────────────────────────────────────────────
    if spec_size:
        extents = mesh.bounding_box.extents  # [x, y, z]
        tgt = [float(spec_size.get("x", 0)), float(spec_size.get("y", 0)), float(spec_size.get("z", 0))]
        scale_vec = np.array([
            tgt[0] / extents[0] if (tgt[0] > 0 and extents[0] > 1e-6) else 1.0,
            tgt[1] / extents[1] if (tgt[1] > 0 and extents[1] > 1e-6) else 1.0,
            tgt[2] / extents[2] if (tgt[2] > 0 and extents[2] > 1e-6) else 1.0,
        ])
        mesh.apply_scale(scale_vec)
        log.info("Scaled to spec: %s", tgt)

    # ── Move pivot to base-center (Y-up: min-Y face, centered on X/Z) ────────
    bounds   = mesh.bounds          # [[minx,miny,minz],[maxx,maxy,maxz]]
    cx       = (bounds[0][0] + bounds[1][0]) / 2.0
    cy_min   = bounds[0][1]         # base in Y-up
    cz       = (bounds[0][2] + bounds[1][2]) / 2.0
    mesh.apply_translation([-cx, -cy_min, -cz])
    log.info("Pivot set to base-center (shifted %.4f, %.4f, %.4f)", -cx, -cy_min, -cz)

    # ── Apply PBR material as vertex colors + GLTF material constants ─────────
    pbr_values = {"baseColor": "#808080", "metallic": 0.0, "roughness": 0.5}
    if spec_mats:
        pbr_values.update(spec_mats[0].get("pbr", {}))

    base_color_linear = _hex_to_linear_rgba(pbr_values.get("baseColor", "#808080"))
    metallic          = float(pbr_values.get("metallic",  0.0))
    roughness         = float(pbr_values.get("roughness", 0.5))

    # Paint every vertex with the base colour (sRGB encoded for trimesh vertex_colors)
    def _lin_to_srgb(c):
        return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055

    srgb = [_lin_to_srgb(c) for c in base_color_linear[:3]]
    color_uint8 = [max(0, min(255, int(round(c * 255)))) for c in srgb] + [255]
    mesh.visual = trimesh.visual.ColorVisuals(
        mesh=mesh,
        vertex_colors=np.tile(color_uint8, (len(mesh.vertices), 1)).astype(np.uint8),
    )

    # ── Export to GLB ─────────────────────────────────────────────────────────
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    log.info("Exporting GLB: %s", out_path)
    exported = trimesh.exchange.gltf.export_glb(mesh)
    out_path.write_bytes(exported)

    # ── Patch GLTF material to add metallic/roughness constants ──────────────
    # trimesh's vertex-color export doesn't set metallicFactor/roughnessFactor.
    # We patch them directly into the binary GLTF JSON chunk.
    _patch_glb_material(out_path, base_color_linear, metallic, roughness)

    kb = out_path.stat().st_size / 1024
    log.info("GLB written: %s (%.1f KB)", out_path, kb)


# ---------------------------------------------------------------------------
# GLB material patcher
# ---------------------------------------------------------------------------
def _patch_glb_material(
    glb_path: Path,
    base_color: list[float],
    metallic: float,
    roughness: float,
) -> None:
    """
    Parse the GLB binary, locate the JSON chunk, inject PBR material values,
    rewrite the file.  GLB format: 12-byte header + chunk0 (JSON) + chunk1 (BIN).
    """
    import json as _json

    data = glb_path.read_bytes()
    if len(data) < 12:
        return

    # GLB header
    magic, version, total_len = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:   # "glTF"
        log.warning("Not a valid GLB, skipping material patch")
        return

    # Chunk 0 (JSON)
    chunk0_len, chunk0_type = struct.unpack_from("<II", data, 12)
    if chunk0_type != 0x4E4F534A:  # "JSON"
        log.warning("GLB chunk 0 is not JSON, skipping material patch")
        return

    json_bytes = data[20 : 20 + chunk0_len]
    gltf = _json.loads(json_bytes.rstrip(b"\x20"))

    # Ensure materials list exists with at least one entry
    if "materials" not in gltf or not gltf["materials"]:
        gltf["materials"] = [{"name": "mat0"}]

    mat = gltf["materials"][0]
    pbr = mat.setdefault("pbrMetallicRoughness", {})
    pbr["baseColorFactor"]         = base_color
    pbr["metallicFactor"]          = metallic
    pbr["roughnessFactor"]         = roughness
    mat["doubleSided"]             = False

    # Re-serialise + pad to 4-byte boundary
    new_json = _json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    pad = (4 - len(new_json) % 4) % 4
    new_json_padded = new_json + b" " * pad

    # Rebuild file
    new_chunk0_header = struct.pack("<II", len(new_json_padded), 0x4E4F534A)
    rest = data[20 + chunk0_len :]                   # BIN chunk + any trailing

    new_total = 12 + 8 + len(new_json_padded) + len(rest)
    new_header = struct.pack("<III", 0x46546C67, 2, new_total)

    glb_path.write_bytes(new_header + new_chunk0_header + new_json_padded + rest)
    log.info("GLB material patched: baseColor=%s metallic=%.2f roughness=%.2f",
             base_color[:3], metallic, roughness)


if __name__ == "__main__":
    main()
