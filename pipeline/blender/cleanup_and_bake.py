"""
Headless Blender cleanup and PBR baking script.

Called by Modal Stage C as:
    blender --background --python cleanup_and_bake.py -- \
        --input  /path/to/raw_mesh.obj \
        --output /path/to/cleaned.glb \
        --spec   /path/to/asset_spec.json

This script runs INSIDE Blender's embedded Python interpreter.
Do NOT import external packages that are not available in Blender's Python.
"""

from __future__ import annotations

import json
import math
import os
import sys
import logging
from pathlib import Path

# Blender's Python does not have 'logging' configured by default
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [BLENDER] %(levelname)s: %(message)s",
)
log = logging.getLogger("blender_cleanup")


def parse_args():
    """Parse args after '--' separator that Blender uses for user args."""
    import argparse

    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []

    parser = argparse.ArgumentParser(description="Blender cleanup + PBR bake")
    parser.add_argument("--input",  required=True, help="Path to raw mesh")
    parser.add_argument("--output", required=True, help="Path to cleaned .glb")
    parser.add_argument("--spec",   required=True, help="Path to asset_spec.json")
    return parser.parse_args(argv)


def import_mesh(bpy, filepath: str) -> list:
    """Import mesh supporting obj, ply, glb/gltf, fbx."""
    path = Path(filepath)
    ext  = path.suffix.lower()

    bpy.ops.object.select_all(action="DESELECT")

    if ext == ".obj":
        bpy.ops.wm.obj_import(filepath=filepath)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=filepath)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=filepath)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=filepath)
    else:
        raise ValueError(f"Unsupported mesh format: {ext}")

    imported = [obj for obj in bpy.context.selected_objects if obj.type == "MESH"]
    log.info("Imported %d mesh object(s) from %s", len(imported), filepath)
    return imported


def join_objects(bpy, objects: list):
    """Join multiple mesh objects into one."""
    if len(objects) <= 1:
        return objects[0] if objects else None

    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    return bpy.context.active_object


def fix_normals(bpy, obj):
    """Recalculate normals to point outward."""
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    log.info("Normals fixed for %s", obj.name)


def remove_doubles_and_artifacts(bpy, obj, merge_dist: float = 0.0001):
    """Merge by distance, remove loose geometry."""
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=merge_dist)
    bpy.ops.mesh.delete_loose()
    bpy.ops.object.mode_set(mode="OBJECT")
    log.info("Removed doubles (threshold=%.5f) on %s", merge_dist, obj.name)


def triangulate(bpy, obj):
    """Triangulate mesh to remove ngons."""
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.quads_convert_to_tris(quad_method="BEAUTY", ngon_method="BEAUTY")
    bpy.ops.object.mode_set(mode="OBJECT")
    log.info("Triangulated %s", obj.name)


def decimate(bpy, obj, max_tris: int):
    """Add a decimate modifier to hit max_tris target."""
    mesh = obj.data
    current_tris = len(mesh.polygons)
    if current_tris <= max_tris:
        log.info("Polycount %d already within target %d, skipping decimate", current_tris, max_tris)
        return

    ratio = max_tris / current_tris
    mod   = obj.modifiers.new(name="Decimate", type="DECIMATE")
    mod.ratio = max(0.05, min(ratio, 1.0))
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier="Decimate")
    new_tris = len(obj.data.polygons)
    log.info("Decimated %s: %d → %d tris (target %d)", obj.name, current_tris, new_tris, max_tris)


def smart_uv_unwrap(bpy, obj):
    """Smart UV project if no UV map exists or is empty."""
    mesh = obj.data
    if not mesh.uv_layers:
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=66.0, island_margin=0.02)
        bpy.ops.object.mode_set(mode="OBJECT")
        log.info("Smart UV unwrap applied to %s", obj.name)
    else:
        log.info("UV map already present on %s, skipping unwrap", obj.name)


def scale_to_spec(bpy, obj, spec_size: dict):
    """
    Non-uniformly scale the object so its bounding box matches spec size_m exactly.

    Axis mapping — Blender is Z-up; glTF export applies a -90° X rotation so:
      Blender X  →  GLB X   (spec "x" = width)
      Blender Z  →  GLB Y   (spec "y" = height as seen in GLB / validation)
      Blender Y  →  GLB -Z  (spec "z" = depth as seen in GLB / validation)

    Therefore in Blender space:
      spec x  →  Blender X  (sx scales Blender X)
      spec y  →  Blender Z  (sy scales Blender Z)
      spec z  →  Blender Y  (sz scales Blender Y)

    We apply an independent scale factor per axis so all three dimensions hit
    their targets.  Non-uniform scale is fine for static props.
    If no size_m is specified the mesh is left as-is.
    """
    import mathutils

    if not spec_size:
        log.info("No size_m in spec – skipping scale normalisation")
        return

    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    bbox = [obj.matrix_world @ mathutils.Vector(corner) for corner in obj.bound_box]
    cur_x = max(v.x for v in bbox) - min(v.x for v in bbox)
    cur_y = max(v.y for v in bbox) - min(v.y for v in bbox)
    cur_z = max(v.z for v in bbox) - min(v.z for v in bbox)

    tgt_x = float(spec_size.get("x", 0))   # width  → Blender X
    tgt_y = float(spec_size.get("y", 0))   # height → Blender Z
    tgt_z = float(spec_size.get("z", 0))   # depth  → Blender Y

    # Per-axis scale factors; fall back to 1.0 if spec axis is missing/zero
    sx = (tgt_x / cur_x) if (tgt_x > 0 and cur_x > 1e-6) else 1.0
    sy = (tgt_z / cur_y) if (tgt_z > 0 and cur_y > 1e-6) else 1.0  # spec z → Blender Y
    sz = (tgt_y / cur_z) if (tgt_y > 0 and cur_z > 1e-6) else 1.0  # spec y → Blender Z

    obj.scale = (obj.scale.x * sx, obj.scale.y * sy, obj.scale.z * sz)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    log.info(
        "Scaled %s per-axis (sx=%.4f sy=%.4f sz=%.4f) → GLB extents ~%.3f(x) %.3f(y) %.3f(z)m",
        obj.name, sx, sy, sz,
        tgt_x or cur_x * sx,
        tgt_y or cur_z * sz,
        tgt_z or cur_y * sy,
    )


def set_pivot_to_base_center(bpy, obj):
    """
    Translate mesh vertices so the bounding-box base-center sits at the world
    origin (0, 0, 0).

    Blender is Z-up: 'base' = min-Z face, centered on X and Y.
    GLB export performs a Y-up conversion (Blender Z → GLB Y), so after export
    the GLB Y-min will be 0 and the GLB X/Z centroid will be 0 — exactly what
    check_pivot_at_base validates.

    We manipulate vertices directly (via mesh.transform) to avoid the
    cursor/origin_set dance which can be unreliable in headless mode.
    """
    import mathutils

    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    # Make sure any pending transforms are applied first so the mesh data is
    # in world space (scale/rotation already applied by scale_to_spec).
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Compute bounding box in local (now == world) space
    mesh = obj.data
    verts = mesh.vertices
    xs = [v.co.x for v in verts]
    ys = [v.co.y for v in verts]
    zs = [v.co.z for v in verts]

    cx = (max(xs) + min(xs)) / 2.0
    cy = (max(ys) + min(ys)) / 2.0
    cz_min = min(zs)   # base = floor in Blender Z-up

    # Shift all vertices so base-center lands at origin
    offset = mathutils.Vector((-cx, -cy, -cz_min))
    mesh.transform(mathutils.Matrix.Translation(offset))
    mesh.update()

    # Also zero the object location (it was already 0 after transform_apply)
    obj.location = (0.0, 0.0, 0.0)

    log.info(
        "Pivot set to base-center for %s (shifted by %.4f, %.4f, %.4f)",
        obj.name, -cx, -cy, -cz_min,
    )


def apply_transforms(bpy, obj):
    """Apply all transforms so export is clean."""
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    log.info("Transforms applied for %s", obj.name)


def create_pbr_material(bpy, obj, spec_materials: list, texture_res: int, out_dir: Path):
    """
    Create a PBR node-based material from asset_spec materials.
    Bakes baseColor, normal, roughness, metallic, AO to image textures.
    """
    import bpy as _bpy

    # ── Create material ──────────────────────────────────────────────────────
    mat_name = f"{obj.name}_PBR"
    mat = _bpy.data.materials.get(mat_name) or _bpy.data.materials.new(name=mat_name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    # Principled BSDF
    bsdf  = nodes.new("ShaderNodeBsdfPrincipled")
    out_n = nodes.new("ShaderNodeOutputMaterial")
    links.new(bsdf.outputs["BSDF"], out_n.inputs["Surface"])

    # Apply first material part values (extend for multi-material later)
    if spec_materials:
        pbr = spec_materials[0].get("pbr", {})
        base_hex = pbr.get("baseColor", "#808080")
        metallic  = float(pbr.get("metallic",  0.0))
        roughness = float(pbr.get("roughness", 0.5))

        # Convert hex to linear RGB
        r, g, b = _hex_to_linear(base_hex)
        bsdf.inputs["Base Color"].default_value    = (r, g, b, 1.0)
        bsdf.inputs["Metallic"].default_value      = metallic
        bsdf.inputs["Roughness"].default_value     = roughness

        emissive = pbr.get("emissive")
        if emissive:
            er, eg, eb = _hex_to_linear(emissive)
            bsdf.inputs["Emission Color"].default_value  = (er, eg, eb, 1.0)
            bsdf.inputs["Emission Strength"].default_value = 1.0

    # Assign material to object
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)

    # ── Bake maps ────────────────────────────────────────────────────────────
    tex_dir = out_dir / "textures"
    tex_dir.mkdir(parents=True, exist_ok=True)

    bake_configs = [
        ("DIFFUSE",   "baseColor",  "sRGB"),
        ("NORMAL",    "normal",     "Non-Color"),
        ("ROUGHNESS", "roughness",  "Non-Color"),
        ("AO",        "ao",         "Non-Color"),
    ]

    # Track created image nodes keyed by bake_type so we can wire them up after baking.
    baked_nodes: dict[str, object] = {}

    for bake_type, tex_name, colorspace in bake_configs:
        img_name = f"{obj.name}_{tex_name}"
        img = _bpy.data.images.new(
            img_name, width=texture_res, height=texture_res, alpha=False
        )
        img.colorspace_settings.name = colorspace

        # Add image texture node (selected but NOT connected during bake)
        img_node = nodes.new("ShaderNodeTexImage")
        img_node.image = img
        nodes.active = img_node

        _bpy.context.view_layer.objects.active = obj
        obj.select_set(True)

        # Configure render engine for baking
        _bpy.context.scene.render.engine = "CYCLES"
        _bpy.context.scene.cycles.samples = 16  # low for speed; increase for quality

        bake_ok = False
        try:
            if bake_type == "DIFFUSE":
                _bpy.ops.object.bake(
                    type="DIFFUSE", pass_filter={"COLOR"},
                    use_selected_to_active=False,
                )
            elif bake_type == "NORMAL":
                _bpy.ops.object.bake(type="NORMAL", use_selected_to_active=False)
            elif bake_type == "ROUGHNESS":
                _bpy.ops.object.bake(type="ROUGHNESS", use_selected_to_active=False)
            elif bake_type == "AO":
                _bpy.ops.object.bake(type="AO", use_selected_to_active=False)

            img_path = str(tex_dir / f"{tex_name}.png")
            img.filepath_raw = img_path
            img.file_format  = "PNG"
            img.save()

            # Pack the baked image into the Blender file so it is embedded in
            # the exported GLB (without this pack() call, the GLB will reference
            # an external file path that does not exist in the container).
            img.pack()
            log.info("Baked and packed %s → %s", bake_type, img_path)
            bake_ok = True

        except Exception as exc:
            log.warning("Bake %s failed (will use flat values): %s", bake_type, exc)
            nodes.remove(img_node)
            img_node = None

        if bake_ok and img_node is not None:
            baked_nodes[bake_type] = img_node
        elif img_node is not None:
            nodes.remove(img_node)

    # ── Wire baked textures into the BSDF so the GLB exporter picks them up ──
    # DIFFUSE → Base Color
    if "DIFFUSE" in baked_nodes:
        links.new(baked_nodes["DIFFUSE"].outputs["Color"], bsdf.inputs["Base Color"])
        log.info("Wired DIFFUSE texture to Base Color")

    # NORMAL → Normal (via Normal Map node)
    if "NORMAL" in baked_nodes:
        nrm_map = nodes.new("ShaderNodeNormalMap")
        links.new(baked_nodes["NORMAL"].outputs["Color"], nrm_map.inputs["Color"])
        links.new(nrm_map.outputs["Normal"], bsdf.inputs["Normal"])
        log.info("Wired NORMAL texture to Normal")

    # ROUGHNESS → Roughness
    if "ROUGHNESS" in baked_nodes:
        links.new(baked_nodes["ROUGHNESS"].outputs["Color"], bsdf.inputs["Roughness"])
        log.info("Wired ROUGHNESS texture to Roughness")

    # AO is informational only (baked into the baseColor in a real workflow);
    # leave it packed but unconnected for now.

    return mat


def export_glb(bpy, out_path: str):
    """Export the active scene as GLB with PBR materials."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_image_format="AUTO",   # valid: AUTO, JPEG, NONE (PNG removed in Blender 3.x+)
        export_materials="EXPORT",
        export_normals=True,
        export_texcoords=True,
        export_apply=True,
        use_selection=False,
    )
    log.info("GLB exported: %s (%.1f KB)", out_path, Path(out_path).stat().st_size / 1024)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _hex_to_linear(hex_str: str) -> tuple[float, float, float]:
    """Convert #RRGGBB hex to linear float triple."""
    hex_str = hex_str.lstrip("#")
    if len(hex_str) == 3:
        hex_str = "".join(c * 2 for c in hex_str)
    r, g, b = (int(hex_str[i:i+2], 16) / 255.0 for i in (0, 2, 4))
    # sRGB → linear
    def to_lin(c): return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return to_lin(r), to_lin(g), to_lin(b)


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------
def main():
    try:
        import bpy
    except ImportError:
        print("ERROR: This script must be run inside Blender (--background --python)")
        sys.exit(1)

    args = parse_args()

    input_path  = args.input
    output_path = args.output
    spec_path   = args.spec

    out_dir     = Path(output_path).parent
    spec        = json.loads(Path(spec_path).read_text())

    gen_plan    = spec.get("generation_plan", {})
    qt          = gen_plan.get("quality_targets", {})
    max_tris    = int(qt.get("max_tris",          80000))
    tex_res     = int(qt.get("texture_resolution", 2048))
    spec_mats   = spec.get("object", {}).get("materials", [])

    # ── Clear default scene ──────────────────────────────────────────────────
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for block in bpy.data.meshes:
        bpy.data.meshes.remove(block)

    # ── Import ───────────────────────────────────────────────────────────────
    objects = import_mesh(bpy, input_path)
    if not objects:
        raise RuntimeError(f"No mesh objects imported from {input_path}")

    obj = join_objects(bpy, objects)

    # ── Cleanup pipeline ─────────────────────────────────────────────────────
    remove_doubles_and_artifacts(bpy, obj)
    fix_normals(bpy, obj)
    triangulate(bpy, obj)
    decimate(bpy, obj, max_tris)
    smart_uv_unwrap(bpy, obj)

    # ── Scale to spec dimensions ──────────────────────────────────────────────
    spec_size = spec.get("object", {}).get("size_m", {})
    scale_to_spec(bpy, obj, spec_size)

    # ── PBR material ─────────────────────────────────────────────────────────
    create_pbr_material(bpy, obj, spec_mats, tex_res, out_dir)

    # ── Pivot to base-center (vertices shifted directly, transforms frozen) ──
    set_pivot_to_base_center(bpy, obj)

    # ── Export ───────────────────────────────────────────────────────────────
    export_glb(bpy, output_path)
    log.info("cleanup_and_bake.py complete → %s", output_path)


if __name__ == "__main__":
    main()
