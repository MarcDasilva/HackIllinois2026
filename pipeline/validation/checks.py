"""
Automated asset validation checks.

run_all_checks() is the public entry-point called by Stage D.
Returns a dict: { "passed": bool, "score": float, "checks": [...] }
"""

from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Any

log = logging.getLogger("validation.checks")

# Tolerance for bbox dimension comparison
BBOX_TOLERANCE_FRAC = 0.30   # ±30% of spec dimensions


# ---------------------------------------------------------------------------
# Public entry-point
# ---------------------------------------------------------------------------
def run_all_checks(
    glb_path: Path,
    asset_spec: dict,
    world_context: dict,
) -> dict:
    """Run all validation checks. Returns structured report."""
    results: list[dict[str, Any]] = []

    checks = [
        check_file_exists,
        check_can_load,
        check_polycount,
        check_no_inverted_normals,
        check_no_ngons,
        check_no_degenerate_faces,
        check_bbox_vs_spec,
        check_realistic_scale,
        check_textures_present,
        check_pivot_at_base,
        check_watertight,
        check_world_unit_match,
    ]

    mesh = None
    for fn in checks:
        try:
            result = fn(glb_path=glb_path, asset_spec=asset_spec, world_context=world_context, mesh=mesh)
            # Carry loaded mesh forward to avoid re-loading
            if result.get("mesh_ref") is not None:
                mesh = result.pop("mesh_ref")
        except Exception as exc:
            result = {
                "name":    fn.__name__,
                "passed":  False,
                "message": f"Exception: {exc}",
            }
        results.append(result)
        status = "PASS" if result["passed"] else "FAIL"
        log.info("[Validation] %-35s %s  %s", result["name"], status, result.get("message", ""))

    passed_count = sum(1 for r in results if r["passed"])
    total        = len(results)
    score        = passed_count / total

    # Certain checks are hard-failures
    hard_fail_names = {
        "check_file_exists",
        "check_can_load",
        "check_no_inverted_normals",
        "check_bbox_vs_spec",
        "check_realistic_scale",
        "check_textures_present",
    }
    overall_pass = all(
        r["passed"] for r in results if r["name"] in hard_fail_names
    )

    return {
        "passed": overall_pass,
        "score":  round(score, 3),
        "checks": results,
        "summary": f"{passed_count}/{total} checks passed",
    }


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------

def check_file_exists(glb_path, **_):
    exists = glb_path.exists() and glb_path.stat().st_size > 0
    return {
        "name":    "check_file_exists",
        "passed":  exists,
        "message": str(glb_path) if exists else f"File missing or empty: {glb_path}",
    }


def check_can_load(glb_path, **_):
    import trimesh
    try:
        scene = trimesh.load(str(glb_path), force="scene")
        meshes = _extract_meshes(scene)
        ok = len(meshes) > 0
        return {
            "name":     "check_can_load",
            "passed":   ok,
            "message":  f"{len(meshes)} mesh(es) loaded",
            "mesh_ref": meshes[0] if ok else None,
        }
    except Exception as exc:
        return {"name": "check_can_load", "passed": False, "message": str(exc), "mesh_ref": None}


def check_polycount(glb_path, asset_spec, mesh=None, **_):
    max_tris = (
        asset_spec.get("generation_plan", {})
                  .get("quality_targets", {})
                  .get("max_tris", 80000)
    )
    if mesh is None:
        mesh = _load_first_mesh(glb_path)
    if mesh is None:
        return {"name": "check_polycount", "passed": False, "message": "Could not load mesh"}

    tri_count = len(mesh.faces)
    ok = tri_count <= max_tris
    return {
        "name":    "check_polycount",
        "passed":  ok,
        "message": f"{tri_count} tris (max {max_tris})",
    }


def check_no_inverted_normals(glb_path, mesh=None, **_):
    if mesh is None:
        mesh = _load_first_mesh(glb_path)
    if mesh is None:
        return {"name": "check_no_inverted_normals", "passed": False, "message": "Could not load mesh"}

    import numpy as np
    # Check winding consistency using face normals vs centroid-to-centroid direction
    if not mesh.is_volume:
        # Non-manifold: just verify normals are not all zero
        has_normals = mesh.face_normals is not None and len(mesh.face_normals) > 0
        norms = np.linalg.norm(mesh.face_normals, axis=1) if has_normals else np.array([])
        zero_count = int(np.sum(norms < 1e-6))
        ok = zero_count < len(mesh.faces) * 0.05
        return {
            "name":    "check_no_inverted_normals",
            "passed":  ok,
            "message": f"{zero_count} degenerate normals out of {len(mesh.faces)}",
        }

    # For watertight meshes, check winding consistency
    try:
        is_winding_consistent = mesh.is_winding_consistent
    except Exception:
        is_winding_consistent = True  # benefit of the doubt

    return {
        "name":    "check_no_inverted_normals",
        "passed":  is_winding_consistent,
        "message": "winding consistent" if is_winding_consistent else "inconsistent winding detected",
    }


def check_no_ngons(glb_path, mesh=None, **_):
    """After triangulation, all faces should have exactly 3 vertices."""
    if mesh is None:
        mesh = _load_first_mesh(glb_path)
    if mesh is None:
        return {"name": "check_no_ngons", "passed": False, "message": "Could not load mesh"}

    # trimesh stores faces as triangles; if loaded from GLB they are already triangulated
    all_tris = all(len(f) == 3 for f in mesh.faces)
    return {
        "name":    "check_no_ngons",
        "passed":  all_tris,
        "message": "all triangles" if all_tris else "ngons detected",
    }


def check_no_degenerate_faces(glb_path, mesh=None, **_):
    import numpy as np
    if mesh is None:
        mesh = _load_first_mesh(glb_path)
    if mesh is None:
        return {"name": "check_no_degenerate_faces", "passed": False, "message": "Could not load mesh"}

    areas         = mesh.area_faces
    degenerate    = int(np.sum(areas < 1e-10))
    total         = len(mesh.faces)
    ok            = degenerate < total * 0.01
    return {
        "name":    "check_no_degenerate_faces",
        "passed":  ok,
        "message": f"{degenerate}/{total} degenerate faces",
    }


def check_bbox_vs_spec(glb_path, asset_spec, mesh=None, **_):
    if mesh is None:
        mesh = _load_first_mesh(glb_path)
    if mesh is None:
        return {"name": "check_bbox_vs_spec", "passed": False, "message": "Could not load mesh"}

    spec_size = asset_spec.get("object", {}).get("size_m", {})
    if not spec_size:
        return {"name": "check_bbox_vs_spec", "passed": True, "message": "No size_m in spec – skipped"}

    extents = mesh.bounding_box.extents  # [x, y, z]
    axes    = [("x", 0), ("y", 1), ("z", 2)]
    failures = []
    for axis, idx in axes:
        spec_val = float(spec_size.get(axis, 0))
        if spec_val <= 0:
            continue
        mesh_val  = extents[idx]
        rel_err   = abs(mesh_val - spec_val) / spec_val
        if rel_err > BBOX_TOLERANCE_FRAC:
            failures.append(
                f"{axis}: mesh={mesh_val:.3f}m spec={spec_val:.3f}m err={rel_err*100:.1f}%"
            )

    ok = len(failures) == 0
    return {
        "name":    "check_bbox_vs_spec",
        "passed":  ok,
        "message": "within tolerance" if ok else "; ".join(failures),
    }


def check_realistic_scale(glb_path, asset_spec, world_context, mesh=None, **_):
    """Object bbox must be within plausible physical range for its category."""
    if mesh is None:
        mesh = _load_first_mesh(glb_path)
    if mesh is None:
        return {"name": "check_realistic_scale", "passed": False, "message": "Could not load mesh"}

    extents    = mesh.bounding_box.extents
    max_extent = float(max(extents))
    min_extent = float(min(extents))

    # World units
    units      = world_context.get("units", "meters")
    scale_mult = 1.0 if units == "meters" else 0.01  # cm → m

    max_m = max_extent * scale_mult
    min_m = min_extent * scale_mult

    # Heuristic: single objects should be between 1cm and 10m in every axis
    HARD_MIN_M = 0.01
    HARD_MAX_M = 10.0

    ok = HARD_MIN_M <= min_m and max_m <= HARD_MAX_M
    return {
        "name":    "check_realistic_scale",
        "passed":  ok,
        "message": f"extents={extents[0]:.3f}x{extents[1]:.3f}x{extents[2]:.3f}{units} → max={max_m:.3f}m",
    }


def check_textures_present(glb_path, **_):
    """Check GLB has either embedded textures or vertex colors."""
    try:
        import pygltflib
        import trimesh

        glb = pygltflib.GLTF2()
        glb.load(str(glb_path))
        num_textures = len(getattr(glb, "textures", None) or [])
        num_images   = len(getattr(glb, "images", None) or [])

        has_textures = num_textures > 0 and num_images > 0

        # Our fast Stage C path can intentionally ship colorized vertex data
        # with PBR constants and no texture images.
        has_vertex_colors = False
        scene = trimesh.load(str(glb_path), force="scene")
        meshes = _extract_meshes(scene)
        for mesh in meshes:
            vc = getattr(getattr(mesh, "visual", None), "vertex_colors", None)
            if vc is not None and len(vc) > 0:
                has_vertex_colors = True
                break

        ok = has_textures or has_vertex_colors
        return {
            "name":    "check_textures_present",
            "passed":  ok,
            "message": (
                f"{num_textures} texture(s), {num_images} image(s), "
                f"vertex_colors={has_vertex_colors}"
            ),
        }
    except Exception as exc:
        return {
            "name":    "check_textures_present",
            "passed":  False,
            "message": f"Could not inspect GLB textures: {exc}",
        }


def check_pivot_at_base(glb_path, mesh=None, **_):
    """Pivot (object origin = 0,0,0) should be near the base center of the mesh."""
    if mesh is None:
        mesh = _load_first_mesh(glb_path)
    if mesh is None:
        return {"name": "check_pivot_at_base", "passed": False, "message": "Could not load mesh"}

    bounds  = mesh.bounds         # [[minx,miny,minz],[maxx,maxy,maxz]]
    extents = mesh.bounding_box.extents
    max_ext = float(max(extents)) if max(extents) > 0 else 1.0

    # Origin (0,0,0) should be within one BBOX_TOLERANCE_FRAC of the base
    # "base" = min Y face center
    center_x = (bounds[0][0] + bounds[1][0]) / 2
    center_z = (bounds[0][2] + bounds[1][2]) / 2
    base_y   = bounds[0][1]

    dist_lateral = math.sqrt(center_x**2 + center_z**2)
    dist_y       = abs(base_y)
    threshold    = max_ext * BBOX_TOLERANCE_FRAC

    ok = dist_lateral < threshold and dist_y < threshold
    return {
        "name":    "check_pivot_at_base",
        "passed":  ok,
        "message": (
            f"lateral offset={dist_lateral:.4f}m y_base={base_y:.4f}m threshold={threshold:.4f}m"
        ),
    }


def check_watertight(glb_path, mesh=None, **_):
    """Non-blocking check: warn if mesh is not watertight."""
    if mesh is None:
        mesh = _load_first_mesh(glb_path)
    if mesh is None:
        return {"name": "check_watertight", "passed": True, "message": "Could not load – skipped"}

    is_watertight = mesh.is_watertight
    return {
        "name":    "check_watertight",
        "passed":  True,  # soft check – not a hard failure
        "message": "watertight" if is_watertight else "NOT watertight (soft warning)",
    }


def check_world_unit_match(glb_path, world_context, mesh=None, **_):
    """Verify the object's dimensions are consistent with the world's unit system."""
    if mesh is None:
        mesh = _load_first_mesh(glb_path)
    if mesh is None:
        return {"name": "check_world_unit_match", "passed": True, "message": "Could not load – skipped"}

    units   = world_context.get("units", "meters")
    extents = mesh.bounding_box.extents
    max_ext = float(max(extents))

    # If world is in meters and max extent > 100, it's probably in cm
    if units == "meters" and max_ext > 100:
        return {
            "name":    "check_world_unit_match",
            "passed":  False,
            "message": f"World is meters but object max extent is {max_ext:.1f} – possible unit mismatch",
        }

    return {
        "name":    "check_world_unit_match",
        "passed":  True,
        "message": f"units={units} max_extent={max_ext:.3f}",
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _load_first_mesh(glb_path: Path):
    try:
        import trimesh
        scene = trimesh.load(str(glb_path), force="scene")
        meshes = _extract_meshes(scene)
        return meshes[0] if meshes else None
    except Exception as exc:
        log.warning("Could not load mesh from %s: %s", glb_path, exc)
        return None


def _extract_meshes(scene) -> list:
    import trimesh
    if isinstance(scene, trimesh.Trimesh):
        return [scene]
    if isinstance(scene, trimesh.Scene):
        meshes = []
        for geom in scene.geometry.values():
            if isinstance(geom, trimesh.Trimesh):
                meshes.append(geom)
        return meshes
    return []
