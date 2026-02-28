"""
Placement utility: compute world transform matrix + world_patch.json.

The "world patch" format is a thin description that tells a world engine
how to insert the generated object into the existing scene.

No proprietary World Labs API is assumed. The patch is a JSON document
that the consuming application can interpret.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger("utils.placement")


# ---------------------------------------------------------------------------
# Public entry-point
# ---------------------------------------------------------------------------
def compute_world_patch(
    glb_path: Path,
    asset_spec: dict,
    world_context: dict,
) -> dict:
    """
    Compute the final world-space transform and emit a world_patch document.

    Transform computation priority:
      1) Use pose from asset_spec.placement (set by Gemini)
      2) Snap to target surface from world_context.surfaces
      3) Validate against occupied_regions and clamp if needed
    """
    placement = asset_spec.get("placement", {})
    obj_info  = asset_spec.get("object",    {})

    # ── Load mesh to get actual bbox ─────────────────────────────────────────
    mesh_extents = _get_mesh_extents(glb_path)

    # ── Resolve target surface ───────────────────────────────────────────────
    surface_id = placement.get("target_surface_id")
    surface    = _find_surface(world_context, surface_id)

    # ── Compute position ─────────────────────────────────────────────────────
    spec_pose   = placement.get("pose", {})
    spec_pos    = spec_pose.get("position", {})
    spec_rot    = spec_pose.get("rotation_euler_deg", {})
    clearance_m = float(placement.get("clearance_m", 0.02))

    position = _resolve_position(
        spec_pos=spec_pos,
        surface=surface,
        mesh_extents=mesh_extents,
        clearance_m=clearance_m,
        world_context=world_context,
    )

    rotation_deg = {
        "x": float(spec_rot.get("x", 0.0)),
        "y": float(spec_rot.get("y", 0.0)),
        "z": float(spec_rot.get("z", 0.0)),
    }

    # ── Check against occupied regions ───────────────────────────────────────
    occupied      = world_context.get("occupied_regions", [])
    collision_ok  = placement.get("collision_allowed", False)
    collision_warn = _check_occupied(position, mesh_extents, occupied) if not collision_ok else False

    # ── Build 4×4 transform matrix (column-major for glTF) ──────────────────
    matrix = _build_transform_matrix(position, rotation_deg)

    # ── World patch document ─────────────────────────────────────────────────
    patch = {
        "schema_version":    "1.0",
        "world_id":          world_context.get("world_id", "unknown"),
        "object": {
            "name":          obj_info.get("name", "generated_asset"),
            "category":      obj_info.get("category", "prop"),
            "asset_uri":     str(glb_path),  # local path; replace with cloud URI in production
        },
        "transform": {
            "position":            position,
            "rotation_euler_deg":  rotation_deg,
            "scale":               {"x": 1.0, "y": 1.0, "z": 1.0},
            "matrix_4x4_col_major": matrix,
        },
        "placement": {
            "target_surface_id":   surface_id or "unknown",
            "clearance_m":         clearance_m,
            "anchors":             placement.get("anchors", ["sit_flat"]),
            "collision_allowed":   collision_ok,
        },
        "physics": {
            "gravity":         world_context.get("physics", {}).get("gravity", 9.81),
            "is_static":       True,
            "collision_mesh":  "convex_hull",
        },
        "warnings": _collect_warnings(collision_warn, surface),
    }

    log.info(
        "World patch computed: pos=(%.3f, %.3f, %.3f) surface=%s",
        position["x"], position["y"], position["z"], surface_id,
    )
    return patch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_mesh_extents(glb_path: Path) -> dict[str, float]:
    """Load mesh and return bounding box extents in x,y,z."""
    try:
        import trimesh
        scene = trimesh.load(str(glb_path), force="scene")
        if isinstance(scene, trimesh.Trimesh):
            e = scene.bounding_box.extents
        elif isinstance(scene, trimesh.Scene):
            meshes = [g for g in scene.geometry.values() if isinstance(g, trimesh.Trimesh)]
            if not meshes:
                raise ValueError("No meshes in scene")
            combined = trimesh.util.concatenate(meshes)
            e = combined.bounding_box.extents
        else:
            raise ValueError(f"Unknown scene type: {type(scene)}")
        return {"x": float(e[0]), "y": float(e[1]), "z": float(e[2])}
    except Exception as exc:
        log.warning("Could not load mesh extents (%s), using spec size", exc)
        return {"x": 0.5, "y": 0.5, "z": 0.5}


def _find_surface(world_context: dict, surface_id: str | None) -> dict | None:
    """Look up a surface by ID from the world context."""
    surfaces = world_context.get("surfaces", [])
    if not surfaces:
        return None
    if surface_id:
        for s in surfaces:
            if s.get("id") == surface_id:
                return s
    # Fallback: first surface
    return surfaces[0]


def _resolve_position(
    spec_pos: dict,
    surface: dict | None,
    mesh_extents: dict,
    clearance_m: float,
    world_context: dict,
) -> dict[str, float]:
    """
    Compute final world position.

    Y (or Z, depending on up_axis) is snapped to surface + half-height + clearance.
    X/Z are taken from spec or surface center if missing.
    """
    up_axis = world_context.get("up_axis", "Y").upper()
    half_height = mesh_extents.get("y", 0.25) / 2

    # Start from spec position
    pos = {
        "x": float(spec_pos.get("x", 0.0)),
        "y": float(spec_pos.get("y", 0.0)),
        "z": float(spec_pos.get("z", 0.0)),
    }

    if surface:
        bbox  = surface.get("bbox", {})
        pose  = surface.get("pose", {})

        # Surface top height
        surface_top_y = (
            bbox.get("max_y")
            or (pose.get("y", 0) + bbox.get("height", 0))
            or 0.0
        )
        surface_top_y = float(surface_top_y)

        # If spec position was 0/missing, use surface center
        if pos["x"] == 0.0 and "center_x" in bbox:
            pos["x"] = float(bbox["center_x"])
        if pos["z"] == 0.0 and "center_z" in bbox:
            pos["z"] = float(bbox["center_z"])

        # Always snap Y to surface top + clearance
        if up_axis == "Y":
            pos["y"] = surface_top_y + clearance_m
        elif up_axis == "Z":
            pos["z"] = surface_top_y + clearance_m

    return pos


def _check_occupied(
    position: dict,
    mesh_extents: dict,
    occupied_regions: list[dict],
) -> bool:
    """Return True if the proposed placement overlaps any occupied region."""
    px, py, pz = position["x"], position["y"], position["z"]
    hx = mesh_extents.get("x", 0) / 2
    hz = mesh_extents.get("z", 0) / 2

    obj_min_x = px - hx
    obj_max_x = px + hx
    obj_min_z = pz - hz
    obj_max_z = pz + hz

    for region in occupied_regions:
        bbox = region.get("bbox", {})
        rx1  = float(bbox.get("min_x", 0))
        rx2  = float(bbox.get("max_x", 0))
        rz1  = float(bbox.get("min_z", 0))
        rz2  = float(bbox.get("max_z", 0))

        overlap_x = obj_max_x > rx1 and obj_min_x < rx2
        overlap_z = obj_max_z > rz1 and obj_min_z < rz2

        if overlap_x and overlap_z:
            log.warning(
                "Placement at (%.2f, %.2f) overlaps occupied region '%s'",
                px, pz, region.get("id", "?"),
            )
            return True
    return False


def _build_transform_matrix(
    position: dict,
    rotation_deg: dict,
) -> list[float]:
    """
    Build a 4×4 column-major transform matrix (glTF convention).
    Returns as flat list of 16 floats (column 0, column 1, ...).

    Rotation order: ZYX (intrinsic) = standard Euler
    """
    rx = math.radians(rotation_deg.get("x", 0.0))
    ry = math.radians(rotation_deg.get("y", 0.0))
    rz = math.radians(rotation_deg.get("z", 0.0))

    # Rotation matrices
    Rx = np.array([
        [1,           0,            0],
        [0,  math.cos(rx), -math.sin(rx)],
        [0,  math.sin(rx),  math.cos(rx)],
    ])
    Ry = np.array([
        [ math.cos(ry), 0, math.sin(ry)],
        [0,             1,            0],
        [-math.sin(ry), 0, math.cos(ry)],
    ])
    Rz = np.array([
        [math.cos(rz), -math.sin(rz), 0],
        [math.sin(rz),  math.cos(rz), 0],
        [0,             0,            1],
    ])

    R = Rz @ Ry @ Rx  # column-major convention

    # Build 4×4
    M = np.eye(4, dtype=float)
    M[:3, :3] = R
    M[0, 3]   = position.get("x", 0.0)
    M[1, 3]   = position.get("y", 0.0)
    M[2, 3]   = position.get("z", 0.0)

    # Column-major flat list (glTF)
    return M.T.flatten().tolist()


def _collect_warnings(collision_warn: bool, surface: dict | None) -> list[str]:
    warnings = []
    if collision_warn:
        warnings.append("Proposed position overlaps an occupied region – manual adjustment may be needed")
    if surface is None:
        warnings.append("No target surface found – position inferred from spec only")
    return warnings
