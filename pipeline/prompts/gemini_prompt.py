"""
Gemini prompt builder for asset_spec.json generation.

build_prompt() returns a fully-formed string ready to send to Gemini.
The model is instructed to respond with ONLY valid JSON matching the schema.
"""

from __future__ import annotations
import json
from typing import Optional


# ---------------------------------------------------------------------------
# System instruction (prepended once)
# ---------------------------------------------------------------------------
SYSTEM_INSTRUCTION = """\
You are a 3D asset specification expert embedded in a world-model-aware asset generation pipeline.

Your job:
Given a JSON description of an existing 3D world scene, a user's text request for an object,
and an optional placement hint, produce a single strict JSON document called an "asset_spec".

Rules:
1. Respond with ONLY valid JSON – no markdown fences, no commentary outside the JSON.
2. All physical dimensions are in METERS, matching the world's unit system.
3. PBR material values: baseColor = hex string, metallic ∈ [0,1], roughness ∈ [0,1].
4. Infer missing placement details from the world's surfaces and semantic_zones.
5. The preferred_generator field must be exactly one of: "triposr", "trellis", "shap-e".
   - Use "triposr"  for hard-surface / mechanical objects (tools, boxes, furniture).
   - Use "trellis"  for organic or complex-silhouette objects.
   - Use "shap-e"   only as a last resort for very simple primitives.
6. max_tris must never exceed 120000. Default to 80000 for furniture/containers, 40000 for small props.
7. texture_resolution must be 512, 1024, or 2048.
8. Emit a top-level "confidence" object with float scores [0,1] for:
   "size_estimate", "material_match", "placement_feasibility".
9. negative_constraints MUST include at least: "avoid cartoon", "avoid low-poly game asset",
   "avoid unrealistic scale".
10. The "steps" array in generation_plan must be ordered and complete.
"""

# ---------------------------------------------------------------------------
# Output schema (shown to the model as reference)
# ---------------------------------------------------------------------------
OUTPUT_SCHEMA = {
    "object": {
        "name": "<string>",
        "category": "<string>",
        "description": "<one sentence, factual>",
        "size_m": {"x": "<float>", "y": "<float>", "z": "<float>"},
        "materials": [
            {
                "part": "<string>",
                "pbr": {
                    "baseColor": "<hex>",
                    "metallic": "<float 0-1>",
                    "roughness": "<float 0-1>",
                    "emissive": "<hex or null>",
                },
                "wear": "<none|light|moderate|heavy>",
                "texture_notes": "<optional hint for texture generation>",
            }
        ],
        "style_constraints": ["<string>"],
        "negative_constraints": ["<string>"],
        "lod_levels": "<1|2|3>",
    },
    "placement": {
        "target_surface_id": "<string from world surfaces[].id>",
        "pose": {
            "position": {"x": "<float>", "y": "<float>", "z": "<float>"},
            "rotation_euler_deg": {"x": 0, "y": "<float>", "z": 0},
        },
        "clearance_m": "<float, default 0.02>",
        "collision_allowed": False,
        "anchors": ["<sit_flat|align_with_surface_normal|wall_mount|floor_mount>"],
        "fallback_surface_ids": ["<string>"],
    },
    "generation_plan": {
        "preferred_generator": "<triposr|trellis|shap-e>",
        "prompt_for_generator": "<concise visual description for the 3D generator>",
        "steps": [
            "generate base mesh from text prompt",
            "UV unwrap if missing",
            "bake normals and ambient occlusion",
            "generate PBR textures (baseColor, normal, roughness, metallic, AO)",
            "decimate mesh to target polycount",
            "fix inverted normals",
            "remove non-manifold geometry",
            "set pivot/origin at base-center",
            "apply scale/rotation transforms",
            "export as glb with embedded textures",
        ],
        "quality_targets": {
            "max_tris": "<int>",
            "texture_resolution": "<int>",
            "format": "glb",
            "uv_padding_px": 4,
        },
    },
    "validation": {
        "must_pass": [
            "watertight_if_required",
            "no_inverted_normals",
            "no_ngons",
            "realistic_scale",
            "pbr_textures_present",
            "bbox_within_tolerance",
            "pivot_at_base_center",
        ]
    },
    "confidence": {
        "size_estimate": "<float 0-1>",
        "material_match": "<float 0-1>",
        "placement_feasibility": "<float 0-1>",
    },
}


# ---------------------------------------------------------------------------
# Public builder
# ---------------------------------------------------------------------------
def build_prompt(
    world_context: dict,
    user_prompt: str,
    placement_hint: Optional[dict] = None,
) -> str:
    """Assemble the full prompt string to send to Gemini."""

    world_json   = json.dumps(world_context, indent=2)
    schema_json  = json.dumps(OUTPUT_SCHEMA, indent=2)
    hint_section = (
        f"\n## Placement Hint (from user)\n```json\n{json.dumps(placement_hint, indent=2)}\n```\n"
        if placement_hint
        else "\n## Placement Hint\nNone provided – infer best placement from the world model.\n"
    )

    prompt = f"""{SYSTEM_INSTRUCTION}

---

## World Context (JSON)
```json
{world_json}
```

## User Request
"{user_prompt}"
{hint_section}

## Output Schema (follow exactly)
```json
{schema_json}
```

## Instructions
- Analyse the world's style, palette, lighting temperature, and wear_level.
- Derive realistic physical dimensions from real-world references (e.g., a toolbox is ~0.50 x 0.25 x 0.30 m).
- Pick the surface from world_context.surfaces whose allowed_placements matches the object category.
- Set position.y = surface bbox max_y + half the object height + clearance_m.
- Match PBR roughness/metallic to the world's wear_level and material type.
- The prompt_for_generator field should be a short (≤25 words), purely visual description
  suitable for TripoSR / Trellis image-conditioned generation.
- Output ONLY the JSON document. Do not include any explanatory text.
"""
    return prompt
