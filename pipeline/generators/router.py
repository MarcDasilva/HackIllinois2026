"""
Generator router: dispatches to the correct open-source 3D generator
based on asset_spec.generation_plan.preferred_generator.

Supported generators:
  - triposr  : VAST-AI TripoSR (fast, hard-surface, best default)
  - trellis  : Microsoft TRELLIS (higher quality, slower)
  - shap-e   : OpenAI Shap-E (fallback, simple shapes)
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger("generator.router")


def run_generator(
    generator: str,
    asset_spec: dict,
    out_dir: Path,
    models_cache: Path,
    seed: int = 42,
) -> Path:
    """
    Dispatch to the appropriate generator.
    Returns the Path of the produced raw mesh file (.obj or .ply or .glb).
    """
    generator = generator.lower().strip()

    dispatch = {
        "triposr": _run_triposr,
        "trellis": _run_trellis,
        "shap-e":  _run_shape,
    }

    if generator not in dispatch:
        log.warning("Unknown generator '%s', falling back to triposr", generator)
        generator = "triposr"

    log.info("Dispatching to generator: %s  seed=%d", generator, seed)
    mesh_path = dispatch[generator](asset_spec, out_dir, models_cache, seed)

    if not mesh_path.exists():
        raise RuntimeError(f"Generator '{generator}' did not produce output at {mesh_path}")

    log.info("Raw mesh written: %s  (%.1f KB)", mesh_path, mesh_path.stat().st_size / 1024)
    return mesh_path


# ---------------------------------------------------------------------------
# TripoSR
# ---------------------------------------------------------------------------
def _run_triposr(
    asset_spec: dict,
    out_dir: Path,
    models_cache: Path,
    seed: int,
) -> Path:
    """
    TripoSR: text → (synthetic render via Stable Diffusion) → mesh

    TripoSR is image-conditioned. We first generate a reference render from the
    text prompt using a lightweight SD pipeline, then feed that image to TripoSR.
    """
    import torch
    import numpy as np
    from PIL import Image

    torch.manual_seed(seed)
    np.random.seed(seed & 0xFFFFFFFF)

    gen_prompt = (
        asset_spec.get("generation_plan", {}).get("prompt_for_generator")
        or _build_visual_prompt(asset_spec)
    )
    log.info("[TripoSR] Visual prompt: %s", gen_prompt)

    # ── Step 1: Render a reference image ────────────────────────────────────
    ref_image = _generate_reference_image(gen_prompt, out_dir, models_cache, seed)

    # ── Step 2: Run TripoSR ─────────────────────────────────────────────────
    mesh_path = out_dir / "raw_mesh.obj"
    _triposr_infer(ref_image, mesh_path, models_cache)

    return mesh_path


def _generate_reference_image(
    prompt: str,
    out_dir: Path,
    models_cache: Path,
    seed: int,
) -> Path:
    """Generate a single clean orthographic-ish image via SD 2.1-base.

    Deliberately avoids AutoPipelineForText2Image because that import triggers
    diffusers.pipelines.hunyuandit which requires MT5Tokenizer from transformers
    – a symbol that was removed from the transformers top-level in recent releases.
    StableDiffusionPipeline (SD 1.x/2.x) is self-contained and avoids this chain.
    """
    import torch
    import os
    from diffusers import StableDiffusionPipeline

    hf_token = os.environ.get("HF_TOKEN")

    enhanced_prompt = (
        f"{prompt}, single object, white background, studio lighting, "
        "photorealistic, no shadows, centered, 3/4 view, product photo"
    )
    negative_prompt = (
        "background, cluttered, multiple objects, text, watermark, cartoon, "
        "sketch, low quality, blurry, deformed"
    )

    # SD 1.5 community re-upload: fully public, no HF token required.
    # "runwayml/stable-diffusion-v1-5" is the canonical public model but has
    # become gated intermittently; "Lykon/dreamshaper-8" is consistently open.
    model_id = "Lykon/dreamshaper-8"
    cache_dir = models_cache / "dreamshaper-8"

    log.info("[TripoSR/SD] Loading %s (cache=%s)", model_id, cache_dir)
    pipe = StableDiffusionPipeline.from_pretrained(
        model_id,
        torch_dtype=torch.float16,
        cache_dir=str(cache_dir),
        token=hf_token,
        safety_checker=None,          # skip NSFW checker – speeds up load
        requires_safety_checker=False,
    ).to("cuda")
    pipe.set_progress_bar_config(disable=True)

    generator = torch.Generator("cuda").manual_seed(seed)
    image = pipe(
        prompt=enhanced_prompt,
        negative_prompt=negative_prompt,
        num_inference_steps=25,
        guidance_scale=7.5,
        generator=generator,
        height=512,
        width=512,
    ).images[0]

    img_path = out_dir / "reference_render.png"
    image.save(img_path)
    log.info("[TripoSR/SD] Reference image saved: %s", img_path)
    return img_path


def _triposr_infer(image_path: Path, mesh_path: Path, models_cache: Path) -> None:
    """Run TripoSR inference. Requires the tsr package installed in the image."""
    import torch
    from PIL import Image

    try:
        from tsr.system import TSR
        from tsr.utils import remove_background, resize_foreground
    except ImportError:
        log.warning("[TripoSR] tsr package not available, using mock mesh")
        _write_mock_mesh(mesh_path)
        return

    model_cache = models_cache / "triposr"
    model_cache.mkdir(parents=True, exist_ok=True)

    # TSR.from_pretrained() does NOT accept cache_dir — it calls hf_hub_download
    # internally.  We pre-download the two required files into our Modal Volume
    # cache using hf_hub_download (which does support cache_dir), then pass the
    # resulting local snapshot directory directly to TSR.from_pretrained().
    from huggingface_hub import hf_hub_download
    import os

    hf_token = os.environ.get("HF_TOKEN")

    log.info("[TripoSR] Pre-fetching model weights into %s …", model_cache)
    # hf_hub_download returns the local path of the downloaded file.
    # Both files land in <cache_dir>/models--stabilityai--TripoSR/snapshots/<hash>/
    # Grab the snapshot directory from one of the downloaded file paths.
    config_local = hf_hub_download(
        repo_id="stabilityai/TripoSR",
        filename="config.yaml",
        cache_dir=str(model_cache),
        token=hf_token,
    )
    hf_hub_download(
        repo_id="stabilityai/TripoSR",
        filename="model.ckpt",
        cache_dir=str(model_cache),
        token=hf_token,
    )
    # The snapshot directory is two levels above the downloaded file
    # (.../snapshots/<hash>/config.yaml → .../snapshots/<hash>)
    snapshot_dir = str(Path(config_local).parent)
    log.info("[TripoSR] Loading model from snapshot: %s", snapshot_dir)
    model = TSR.from_pretrained(
        snapshot_dir,
        config_name="config.yaml",
        weight_name="model.ckpt",
    )
    model.renderer.set_chunk_size(8192)
    model.to("cuda")

    image = Image.open(image_path).convert("RGBA")
    image = remove_background(image)
    image = resize_foreground(image, 0.85)
    # TripoSR's image tokenizer normalises with a 3-channel mean/std, so the
    # image must be RGB.  Composite the RGBA onto a white background before
    # converting, so the transparent regions become white rather than black.
    background = Image.new("RGBA", image.size, (255, 255, 255, 255))
    background.paste(image, mask=image.split()[3])  # paste using alpha as mask
    image = background.convert("RGB")

    log.info("[TripoSR] Running inference...")
    with torch.no_grad():
        scene_codes = model([image], device="cuda")
        # has_vertex_color=True bakes vertex colors from the triplane decoder.
        # Pass threshold explicitly (default 25.0 matches TripoSR defaults).
        meshes = model.extract_mesh(scene_codes, has_vertex_color=True, resolution=256)

    mesh = meshes[0]
    mesh.export(str(mesh_path))
    log.info("[TripoSR] Mesh exported: %s", mesh_path)


# ---------------------------------------------------------------------------
# TRELLIS
# ---------------------------------------------------------------------------
def _run_trellis(
    asset_spec: dict,
    out_dir: Path,
    models_cache: Path,
    seed: int,
) -> Path:
    """
    Microsoft TRELLIS: text → 3D (structured latents → mesh + texture).
    Falls back to TripoSR if trellis is not installed.
    """
    import torch

    try:
        from trellis.pipelines import TrellisTextTo3DPipeline
    except ImportError:
        log.warning("[TRELLIS] Not installed – falling back to TripoSR")
        return _run_triposr(asset_spec, out_dir, models_cache, seed)

    torch.manual_seed(seed)

    gen_prompt = (
        asset_spec.get("generation_plan", {}).get("prompt_for_generator")
        or _build_visual_prompt(asset_spec)
    )
    log.info("[TRELLIS] Prompt: %s", gen_prompt)

    model_cache = models_cache / "trellis"
    model_cache.mkdir(parents=True, exist_ok=True)

    pipeline = TrellisTextTo3DPipeline.from_pretrained(
        "microsoft/TRELLIS-text-large",
        cache_dir=str(model_cache),
    ).to("cuda")

    outputs = pipeline.run(
        gen_prompt,
        seed=seed,
        formats=["mesh"],
    )

    mesh_path = out_dir / "raw_mesh.glb"
    outputs["mesh"].export(str(mesh_path))
    log.info("[TRELLIS] Mesh exported: %s", mesh_path)
    return mesh_path


# ---------------------------------------------------------------------------
# Shap-E (fallback)
# ---------------------------------------------------------------------------
def _run_shape(
    asset_spec: dict,
    out_dir: Path,
    models_cache: Path,
    seed: int,
) -> Path:
    """OpenAI Shap-E: text → 3D (simple shapes, fast, lower quality)."""
    import torch

    try:
        from shap_e.diffusion.sample import sample_latents
        from shap_e.diffusion.gaussian_diffusion import diffusion_from_config
        from shap_e.models.download import load_model, load_config
        from shap_e.util.notebooks import decode_latent_mesh
    except ImportError:
        log.warning("[Shap-E] Not installed – falling back to TripoSR")
        return _run_triposr(asset_spec, out_dir, models_cache, seed)

    torch.manual_seed(seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    gen_prompt = (
        asset_spec.get("generation_plan", {}).get("prompt_for_generator")
        or _build_visual_prompt(asset_spec)
    )
    log.info("[Shap-E] Prompt: %s", gen_prompt)

    xm      = load_model("transmitter",      device=device)
    model   = load_model("text300M",         device=device)
    diffusion = diffusion_from_config(load_config("diffusion"))

    latents = sample_latents(
        batch_size=1,
        model=model,
        diffusion=diffusion,
        guidance_scale=15.0,
        model_kwargs={"texts": [gen_prompt]},
        progress=False,
        clip_denoised=True,
        use_fp16=True,
        use_karras=True,
        karras_steps=64,
        sigma_min=1e-3,
        sigma_max=160,
        s_churn=0,
    )

    mesh = decode_latent_mesh(xm, latents[0]).tri_mesh()
    mesh_path = out_dir / "raw_mesh.obj"
    with open(mesh_path, "w") as f:
        mesh.write_obj(f)

    log.info("[Shap-E] Mesh exported: %s", mesh_path)
    return mesh_path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _build_visual_prompt(asset_spec: dict) -> str:
    """Construct a short visual prompt from the asset spec if none is provided."""
    obj  = asset_spec.get("object", {})
    name = obj.get("name", "object")
    desc = obj.get("description", "")
    mats = obj.get("materials", [])

    mat_desc = ""
    if mats:
        m = mats[0].get("pbr", {})
        color   = m.get("baseColor", "")
        metal   = float(m.get("metallic", 0))
        rough   = float(m.get("roughness", 0.5))
        mat_str = f"{color} colored, {'metallic' if metal > 0.5 else 'matte'}, {'smooth' if rough < 0.3 else 'rough'}"
        mat_desc = f", {mat_str}"

    return f"{name}{mat_desc}, {desc}".strip(", ")


def _write_mock_mesh(mesh_path: Path) -> None:
    """Write a minimal OBJ cube for testing when generators are unavailable."""
    obj_content = """\
# Mock cube mesh – replace with real generator output
v -0.5 -0.5 -0.5
v  0.5 -0.5 -0.5
v  0.5  0.5 -0.5
v -0.5  0.5 -0.5
v -0.5 -0.5  0.5
v  0.5 -0.5  0.5
v  0.5  0.5  0.5
v -0.5  0.5  0.5
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 4 8 5 1
"""
    mesh_path.write_text(obj_content)
    log.warning("[Mock] Wrote placeholder cube mesh to %s", mesh_path)
