"""
World-Aligned 3D Asset Generation Pipeline
Modal app orchestrating: Gemini spec → 3D generation → Blender cleanup → Validation → Placement patch

Usage:
    python pipeline/modal_app.py run \
        --world world_context.json \
        --prompt "a red metal toolbox near the workbench" \
        --hint placement_hint.json \
        --candidates 2 \
        --seed 42
"""

from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from pathlib import Path
from typing import Optional, AsyncGenerator

import modal

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("world_asset_pipeline")

# ---------------------------------------------------------------------------
# Modal images
# ---------------------------------------------------------------------------

# Local pipeline packages baked into each image via add_local_python_source().
# This copies prompts/, generators/, validation/, utils/, blender/ into the
# image at build time so all intra-pipeline imports resolve in every container.
_LOCAL_PACKAGES = ["prompts", "generators", "validation", "utils", "blender"]

# Base image shared across stages (Stages A, D, E, orchestrator)
base_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "google-genai>=0.5.0",
        "tenacity>=8.2",
        "numpy>=1.26",
        "trimesh>=4.3",
        "scipy>=1.12",
        "pillow>=10.3",
        "pygltflib>=1.16",
        "rich>=13.7",
    )
    .add_local_python_source(*_LOCAL_PACKAGES)
)

# GPU image for geometry generation (Stage B – Trellis / TripoSR)
# Let pip resolve versions freely; only pin torch/torchvision/xformers together
# since those three must be co-installed from the same CUDA wheel index.
gpu_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04", add_python="3.11"
    )
    .apt_install(
        "git", "wget",
        "libgl1", "libglib2.0-0", "libgomp1",
    )
    .pip_install(
        "torch",
        "torchvision",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        "huggingface_hub",
        "diffusers>=0.27.0",   # SDXL-Turbo needs >=0.27
        "transformers>=4.41,<5",
        "accelerate",
        "safetensors",
        "sentencepiece",
        "trimesh>=4.3",
        "numpy>=1.26",
        "pillow>=10.3",
        "scipy>=1.12",
        "pygltflib>=1.16",
        "einops",
        "omegaconf",
        "rich>=13.7",
        # TripoSR runtime deps not already covered above
        "rembg[gpu]",     # remove_background() in tsr.utils — [gpu] pulls in onnxruntime-gpu
        "imageio[ffmpeg]",
        "xatlas",
        "moderngl",
        # PyMCubes: pure-Python/Cython marching cubes — used as a drop-in
        # replacement for torchmcubes which fails to build from source.
        "PyMCubes",
    )
    # TripoSR — no setup.py/pyproject.toml; clone and put on PYTHONPATH.
    # We do NOT run its requirements.txt (pins ancient conflicting versions).
    # Patch isosurface.py to use PyMCubes instead of the unbuildable torchmcubes.
    .run_commands(
        "git clone --depth 1 https://github.com/VAST-AI-Research/TripoSR.git /opt/TripoSR",
    )
    .add_local_file(
        str(Path(__file__).parent / "patch_triposr_isosurface.py"),
        "/tmp/patch_triposr_isosurface.py",
        copy=True,
    )
    .run_commands(
        "python3 /tmp/patch_triposr_isosurface.py",
    )
    .env({"PYTHONPATH": "/opt/TripoSR"})
    .add_local_python_source(*_LOCAL_PACKAGES)
)

# Blender image (Stage C – CPU)
blender_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "blender",
        "xvfb",
        "libgl1",
        "libglib2.0-0",
        "libgomp1",
    )
    .pip_install("trimesh>=4.3", "numpy>=1.26", "pillow>=10.3", "pygltflib>=1.16")
    .add_local_python_source(*_LOCAL_PACKAGES)
)

# ---------------------------------------------------------------------------
# Modal app + volumes
# ---------------------------------------------------------------------------
app = modal.App("world-asset-pipeline")

# Shared volumes
volume_inputs   = modal.Volume.from_name("wap-inputs",   create_if_missing=True)
volume_models   = modal.Volume.from_name("wap-models",   create_if_missing=True)
volume_outputs  = modal.Volume.from_name("wap-outputs",  create_if_missing=True)

INPUTS_PATH  = Path("/inputs")
MODELS_PATH  = Path("/models")
OUTPUTS_PATH = Path("/outputs")

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------
gemini_secret = modal.Secret.from_name("gemini-api-key")
hf_secret     = modal.Secret.from_name("huggingface-token")

# ---------------------------------------------------------------------------
# Stage A – generate_asset_spec
# ---------------------------------------------------------------------------
@app.function(
    image=base_image,
    secrets=[gemini_secret],
    volumes={
        str(INPUTS_PATH):  volume_inputs,
        str(OUTPUTS_PATH): volume_outputs,
    },
    timeout=120,
    retries=modal.Retries(max_retries=3, backoff_coefficient=2.0, initial_delay=2.0),
)
def generate_asset_spec(
    run_id: str,
    world_context: dict,
    user_prompt: str,
    placement_hint: Optional[dict] = None,
) -> dict:
    """Call Gemini to produce asset_spec JSON."""
    import os
    import re
    import time
    from google import genai
    from google.genai import types as genai_types
    from google.genai import errors as genai_errors
    from tenacity import (
        retry, stop_after_attempt,
        wait_exponential,
        retry_if_exception_type, before_sleep_log,
    )

    from prompts.gemini_prompt import build_prompt

    # v1beta is the correct endpoint: supports response_mime_type (JSON mode)
    # and all current Gemini models. Do NOT pin to v1 – it drops JSON mode support.
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

    prompt = build_prompt(world_context, user_prompt, placement_hint)

    # Model cascade: prefer currently available Gemini models.
    MODELS = ["gemini-2.5-flash"]

    def _extract_retry_delay(exc: Exception) -> float:
        """Pull the server-suggested retryDelay out of a 429 error message."""
        try:
            msg = str(exc)
            # The API embeds e.g. 'retryDelay': '53s' in the error dict
            match = re.search(r"'retryDelay':\s*'(\d+(?:\.\d+)?)s'", msg)
            if match:
                return float(match.group(1)) + 2.0   # small safety buffer
        except Exception:
            pass
        return 60.0   # conservative default when we can't parse the delay

    def _is_rate_limit(exc: Exception) -> bool:
        return (
            isinstance(exc, genai_errors.ClientError)
            and getattr(exc, "status_code", None) == 429
        )

    def _is_not_found(exc: Exception) -> bool:
        return (
            isinstance(exc, genai_errors.ClientError)
            and getattr(exc, "status_code", None) == 404
        )

    def _is_retryable(exc: Exception) -> bool:
        """Only 429 rate-limits are worth retrying; 404 model-not-found is permanent."""
        return _is_rate_limit(exc)

    def _is_daily_exhausted(exc: Exception) -> bool:
        """True when the free-tier *daily* quota is gone (limit: 0)."""
        return _is_rate_limit(exc) and "GenerateRequestsPerDayPerProject" in str(exc)

    raw: Optional[str] = None
    last_exc: Optional[Exception] = None

    for model_name in MODELS:
        log.info("[Stage A] Trying model=%s run_id=%s", model_name, run_id)

        class _DailyQuotaExhausted(Exception):
            """Raised immediately when the daily free-tier quota is gone; not retried."""

        @retry(
            # Only retry transient per-minute 429s; skip daily-exhausted and 404.
            retry=retry_if_exception_type(genai_errors.ClientError),
            stop=stop_after_attempt(3),
            wait=wait_exponential(multiplier=1, min=5, max=60),
            reraise=True,
            before_sleep=before_sleep_log(log, logging.WARNING),
        )
        def _call(model: str = model_name) -> str:
            log.info("[Stage A] Calling Gemini model=%s run_id=%s", model, run_id)
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=genai_types.GenerateContentConfig(
                        temperature=0.2,
                        response_mime_type="application/json",
                    ),
                )
                if not response.text:
                    raise RuntimeError(f"Empty Gemini response text for model={model}")
                return response.text
            except genai_errors.ClientError as exc:
                if _is_not_found(exc):
                    # 404 = wrong model name; do not retry
                    log.error(
                        "[Stage A] 404 for model=%s – skipping", model,
                    )
                    raise _DailyQuotaExhausted(str(exc)) from exc
                if _is_daily_exhausted(exc):
                    # Daily quota gone – cascade immediately, no sleep/retry
                    log.warning(
                        "[Stage A] Daily quota exhausted for model=%s – cascading now",
                        model,
                    )
                    raise _DailyQuotaExhausted(str(exc)) from exc
                if _is_rate_limit(exc):
                    delay = _extract_retry_delay(exc)
                    log.warning(
                        "[Stage A] 429 (per-minute) on model=%s – sleeping %.1fs",
                        model, delay,
                    )
                    time.sleep(delay)
                raise   # let tenacity decide whether to retry

        try:
            raw = _call()
            break   # success – stop trying further models
        except _DailyQuotaExhausted as exc:
            last_exc = exc
            log.warning(
                "[Stage A] model=%s quota/404 – cascading to next model",
                model_name,
            )
            continue   # immediate cascade; no sleep
        except genai_errors.ClientError as exc:
            last_exc = exc
            raise   # unexpected error – surface immediately

    if raw is None:
        raise RuntimeError(
            f"All Gemini models exhausted their quotas. Last error: {last_exc}"
        )

    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.error("[Stage A] Gemini returned invalid JSON: %s", exc)
        raise RuntimeError(f"Gemini JSON parse failed: {exc}") from exc

    # Persist
    out_dir = OUTPUTS_PATH / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    spec_path = out_dir / "asset_spec.json"
    spec_path.write_text(json.dumps(spec, indent=2))
    volume_outputs.commit()

    log.info("[Stage A] asset_spec.json written → %s", spec_path)
    return spec


# ---------------------------------------------------------------------------
# Weight pre-caching – run once at deploy time to warm the Modal Volume
# ---------------------------------------------------------------------------
@app.function(
    image=gpu_image,
    gpu="H100",
    secrets=[hf_secret],
    volumes={str(MODELS_PATH): volume_models},
    timeout=1800,
)
def precache_weights():
    """Download TripoSR and SDXL-Turbo weights into the wap-models volume.

    Run manually after changes to model IDs:
        modal run pipeline/modal_app.py::precache_weights
    """
    import os
    from huggingface_hub import hf_hub_download, snapshot_download

    hf_token = os.environ.get("HF_TOKEN")

    # ── TripoSR ──────────────────────────────────────────────────────────────
    triposr_cache = MODELS_PATH / "triposr"
    triposr_cache.mkdir(parents=True, exist_ok=True)
    log.info("[precache] Downloading TripoSR weights → %s", triposr_cache)
    hf_hub_download(
        repo_id="stabilityai/TripoSR",
        filename="config.yaml",
        cache_dir=str(triposr_cache),
        token=hf_token,
    )
    hf_hub_download(
        repo_id="stabilityai/TripoSR",
        filename="model.ckpt",
        cache_dir=str(triposr_cache),
        token=hf_token,
    )
    log.info("[precache] TripoSR weights cached.")

    # ── SDXL-Turbo ───────────────────────────────────────────────────────────
    sdxl_cache = MODELS_PATH / "sdxl-turbo"
    sdxl_cache.mkdir(parents=True, exist_ok=True)
    log.info("[precache] Downloading SDXL-Turbo weights → %s", sdxl_cache)
    snapshot_download(
        repo_id="stabilityai/sdxl-turbo",
        cache_dir=str(sdxl_cache),
        token=hf_token,
        ignore_patterns=["*.safetensors.index.json"],
    )
    log.info("[precache] SDXL-Turbo weights cached.")

    volume_models.commit()
    log.info("[precache] Volume committed. All weights ready.")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Stage B – generate_geometry (GPU, parallelised per candidate)
# ---------------------------------------------------------------------------
@app.function(
    image=gpu_image,
    gpu="H100",
    secrets=[hf_secret],
    volumes={
        str(MODELS_PATH):  volume_models,
        str(OUTPUTS_PATH): volume_outputs,
    },
    timeout=300,
    retries=modal.Retries(max_retries=2, backoff_coefficient=2.0, initial_delay=5.0),
    min_containers=1,
)
def generate_geometry(
    run_id: str,
    candidate_id: int,
    asset_spec: dict,
    seed: int = 42,
) -> str:
    """Run the chosen open-source generator and return the raw mesh path (relative to volume)."""
    from generators.router import run_generator

    cand_dir = OUTPUTS_PATH / run_id / f"candidate_{candidate_id:02d}"
    cand_dir.mkdir(parents=True, exist_ok=True)

    generator = asset_spec.get("generation_plan", {}).get("preferred_generator", "triposr")
    log.info(
        "[Stage B] run_id=%s candidate=%d generator=%s seed=%d",
        run_id, candidate_id, generator, seed,
    )

    mesh_path = run_generator(
        generator=generator,
        asset_spec=asset_spec,
        out_dir=cand_dir,
        models_cache=MODELS_PATH,
        seed=seed,
    )

    volume_outputs.commit()
    # Return relative path string for downstream stages
    return str(mesh_path.relative_to(OUTPUTS_PATH))


# ---------------------------------------------------------------------------
# Stage C – cleanup_and_pbr (CPU, pure Python — no Blender)
# ---------------------------------------------------------------------------
@app.function(
    image=base_image,
    cpu=2,
    memory=4096,
    volumes={
        str(OUTPUTS_PATH): volume_outputs,
    },
    timeout=120,
)
def cleanup_and_pbr(
    run_id: str,
    candidate_id: int,
    raw_mesh_rel: str,
    asset_spec: dict,
) -> str:
    """Fast trimesh-based cleanup + PBR GLB export (no Blender, no Cycles baking).
    Returns relative path to cleaned .glb."""
    import subprocess, sys

    raw_mesh_abs = OUTPUTS_PATH / raw_mesh_rel
    cand_dir     = OUTPUTS_PATH / run_id / f"candidate_{candidate_id:02d}"
    cleaned_glb  = cand_dir / "cleaned.glb"
    cand_dir.mkdir(parents=True, exist_ok=True)

    cleanup_script = Path(__file__).parent / "blender" / "cleanup_and_bake.py"

    spec_tmp = cand_dir / "asset_spec.json"
    spec_tmp.write_text(json.dumps(asset_spec))

    cmd = [
        sys.executable, str(cleanup_script),
        "--input",  str(raw_mesh_abs),
        "--output", str(cleaned_glb),
        "--spec",   str(spec_tmp),
    ]

    log.info("[Stage C] Running fast cleanup: %s", " ".join(cmd))
    result = subprocess.run(
        cmd,
        capture_output=True, text=True, timeout=100,
    )

    if result.returncode != 0:
        log.error("[Stage C] cleanup stderr:\n%s", result.stderr[-3000:])
        raise RuntimeError(f"Mesh cleanup failed (rc={result.returncode})")

    log.info("[Stage C] cleanup stdout:\n%s", result.stdout[-1000:])
    volume_outputs.commit()
    return str(cleaned_glb.relative_to(OUTPUTS_PATH))


# ---------------------------------------------------------------------------
# Stage D – validate_asset (CPU)
# ---------------------------------------------------------------------------
@app.function(
    image=base_image,
    volumes={
        str(OUTPUTS_PATH): volume_outputs,
    },
    timeout=120,
)
def validate_asset(
    run_id: str,
    candidate_id: int,
    cleaned_glb_rel: str,
    asset_spec: dict,
    world_context: dict,
) -> dict:
    """Run automated validation checks. Returns validation_report dict."""
    import numpy as np
    from validation.checks import run_all_checks

    cleaned_glb = OUTPUTS_PATH / cleaned_glb_rel

    log.info("[Stage D] Validating %s", cleaned_glb)
    report = run_all_checks(
        glb_path=cleaned_glb,
        asset_spec=asset_spec,
        world_context=world_context,
    )

    class _SafeEncoder(json.JSONEncoder):
        """Coerce numpy scalars (bool_, int_, float_) to native Python types."""
        def default(self, o):
            if isinstance(o, np.bool_):
                return bool(o)
            if isinstance(o, np.integer):
                return int(o)
            if isinstance(o, np.floating):
                return float(o)
            if isinstance(o, np.ndarray):
                return o.tolist()
            return super().default(o)

    report_path = OUTPUTS_PATH / run_id / f"candidate_{candidate_id:02d}" / "validation_report.json"
    report_path.write_text(json.dumps(report, indent=2, cls=_SafeEncoder))
    volume_outputs.commit()

    # Sanitise report for return (Modal serialises the return value too)
    report = json.loads(json.dumps(report, cls=_SafeEncoder))

    passed = report.get("passed", False)
    log.info("[Stage D] Validation %s for candidate %d", "PASSED" if passed else "FAILED", candidate_id)
    return report


# ---------------------------------------------------------------------------
# Stage E – placement_patch (CPU)
# ---------------------------------------------------------------------------
@app.function(
    image=base_image,
    volumes={
        str(OUTPUTS_PATH): volume_outputs,
    },
    timeout=60,
)
def placement_patch(
    run_id: str,
    candidate_id: int,
    cleaned_glb_rel: str,
    asset_spec: dict,
    world_context: dict,
) -> dict:
    """Compute final world transform and emit world_patch.json."""
    from utils.placement import compute_world_patch

    cleaned_glb = OUTPUTS_PATH / cleaned_glb_rel
    patch = compute_world_patch(
        glb_path=cleaned_glb,
        asset_spec=asset_spec,
        world_context=world_context,
    )

    patch_path = OUTPUTS_PATH / run_id / f"candidate_{candidate_id:02d}" / "world_patch.json"
    patch_path.write_text(json.dumps(patch, indent=2))
    volume_outputs.commit()

    log.info("[Stage E] world_patch.json written for candidate %d", candidate_id)
    return patch


# ---------------------------------------------------------------------------
# Orchestrator – ties all stages together
# ---------------------------------------------------------------------------
@app.function(
    image=base_image,
    volumes={
        str(INPUTS_PATH):  volume_inputs,
        str(OUTPUTS_PATH): volume_outputs,
    },
    timeout=1800,
)
def run_pipeline(
    world_context: dict,
    user_prompt: str,
    placement_hint: Optional[dict] = None,
    num_candidates: int = 2,
    base_seed: int = 42,
    run_id: Optional[str] = None,
) -> dict:
    """Full pipeline: spec → generate (parallel) → cleanup → validate → placement."""
    run_id = run_id or f"{int(time.time())}_{uuid.uuid4().hex[:8]}"
    log.info("=== Pipeline START run_id=%s candidates=%d ===", run_id, num_candidates)

    # Stage A
    asset_spec = generate_asset_spec.remote(
        run_id=run_id,
        world_context=world_context,
        user_prompt=user_prompt,
        placement_hint=placement_hint,
    )

    # Stage B – parallel candidate generation
    seeds = [base_seed + i * 1000 for i in range(num_candidates)]
    raw_mesh_rels = list(
        generate_geometry.map(
            [run_id] * num_candidates,
            list(range(num_candidates)),
            [asset_spec] * num_candidates,
            seeds,
        )
    )

    # Stages C + D + E per candidate
    # Within each candidate D and E are independent (both need cleaned GLB).
    # Across candidates all C+D+E fan-out concurrently via starmap.
    #
    # Strategy: run cleanup_and_pbr for all candidates first (they can share the
    # GPU image's multi-container pool), then fan-out D+E together.
    cleaned_rels = list(
        cleanup_and_pbr.starmap(
            [(run_id, cid, raw_rel, asset_spec) for cid, raw_rel in enumerate(raw_mesh_rels)]
        )
    )

    # Fan out validate + placement in parallel across all candidates.
    # zip the two starmap iterators together so D and E run concurrently.
    validate_args  = [(run_id, cid, c_rel, asset_spec, world_context) for cid, c_rel in enumerate(cleaned_rels)]
    placement_args = [(run_id, cid, c_rel, asset_spec, world_context) for cid, c_rel in enumerate(cleaned_rels)]

    reports = list(validate_asset.starmap(validate_args))
    patches = list(placement_patch.starmap(placement_args))

    results = [
        {
            "candidate_id": cid,
            "seed":         seeds[cid],
            "cleaned_glb":  cleaned_rels[cid],
            "validation":   reports[cid],
            "world_patch":  patches[cid],
        }
        for cid in range(len(raw_mesh_rels))
    ]

    # Rank: prefer passing candidates, then by score
    def _rank_key(r: dict) -> tuple:
        v = r["validation"]
        return (0 if v.get("passed") else 1, -v.get("score", 0))

    results.sort(key=_rank_key)
    best = results[0]

    summary = {
        "run_id":        run_id,
        "best_candidate": best["candidate_id"],
        "best_seed":     best["seed"],
        "best_glb":      best["cleaned_glb"],
        "validation":    best["validation"],
        "world_patch":   best["world_patch"],
        "all_candidates": results,
    }

    summary_path = OUTPUTS_PATH / run_id / "pipeline_summary.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2))
    volume_outputs.commit()

    log.info(
        "=== Pipeline DONE run_id=%s best_candidate=%d passed=%s ===",
        run_id, best["candidate_id"], best["validation"].get("passed"),
    )
    return summary


# ---------------------------------------------------------------------------
# Web API – FastAPI app exposed as a Modal ASGI endpoint
# ---------------------------------------------------------------------------
#
# fastapi/pydantic are only available in web_image. Guard the import so that
# base_image / gpu_image / blender_image containers can still load this module
# without crashing.  The web_api() function (which uses web_image) is the
# only place that actually calls into these objects.
# ---------------------------------------------------------------------------

web_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi>=0.110", "pydantic>=2.0", "python-multipart")
)

try:
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import StreamingResponse, Response
    from pydantic import BaseModel

    # ---------------------------------------------------------------------------
    # Pydantic model – must be at module level so FastAPI resolves annotations
    # ---------------------------------------------------------------------------

    class GenerateRequest(BaseModel):
        world_context: dict
        user_prompt: str
        placement_hint: Optional[dict] = None
        num_candidates: int = 2
        base_seed: int = 42

    # ---------------------------------------------------------------------------
    # FastAPI app – module-level
    # ---------------------------------------------------------------------------

    api = FastAPI(title="World Asset Pipeline API")

    api.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

except ImportError:
    # Non-web containers (base_image, gpu_image, blender_image) don't have
    # fastapi/pydantic installed.  Set sentinels so the rest of the file parses.
    FastAPI = HTTPException = CORSMiddleware = StreamingResponse = Response = None
    BaseModel = object
    GenerateRequest = None
    api = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def _stream_pipeline(req: GenerateRequest):
    import asyncio
    run_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"

    yield _sse("start", {"run_id": run_id, "message": "Pipeline started"})

    # ── Stage A ──────────────────────────────────────────────────────────────
    yield _sse("stage", {
        "stage": "A",
        "label": "Generating asset specification with Gemini…",
        "progress": 5,
    })
    try:
        asset_spec = await asyncio.to_thread(
            lambda: generate_asset_spec.remote(
                run_id=run_id,
                world_context=req.world_context,
                user_prompt=req.user_prompt,
                placement_hint=req.placement_hint,
            )
        )
    except Exception as exc:
        yield _sse("error", {"stage": "A", "message": str(exc)})
        return

    yield _sse("stage_done", {
        "stage": "A",
        "label": "Asset spec ready",
        "progress": 15,
        "asset_spec": asset_spec,
    })

    # ── Stage B ──────────────────────────────────────────────────────────────
    yield _sse("stage", {
        "stage": "B",
        "label": f"Generating {req.num_candidates} 3D geometry candidate(s) on GPU…",
        "progress": 20,
    })
    seeds = [req.base_seed + i * 1000 for i in range(req.num_candidates)]
    try:
        raw_mesh_rels = await asyncio.to_thread(
            lambda: list(
                generate_geometry.map(
                    [run_id] * req.num_candidates,
                    list(range(req.num_candidates)),
                    [asset_spec] * req.num_candidates,
                    seeds,
                )
            )
        )
    except Exception as exc:
        yield _sse("error", {"stage": "B", "message": str(exc)})
        return

    yield _sse("stage_done", {
        "stage": "B",
        "label": "Raw geometry generated",
        "progress": 45,
    })

    # ── Stages C + D + E — fully parallel ────────────────────────────────────
    # All candidates' cleanup runs concurrently (starmap), then all validate
    # and placement calls fan-out concurrently.  D and E are independent of
    # each other so both starmaps are issued before we await either result.
    n = len(raw_mesh_rels)

    yield _sse("stage", {
        "stage": "C",
        "label": f"Cleaning mesh & baking PBR textures ({n} candidate(s) in parallel)…",
        "progress": 48,
    })
    try:
        cleaned_rels = await asyncio.to_thread(
            lambda: list(
                cleanup_and_pbr.starmap(
                    [(run_id, cid, raw_rel, asset_spec)
                     for cid, raw_rel in enumerate(raw_mesh_rels)]
                )
            )
        )
    except Exception as exc:
        yield _sse("error", {"stage": "C", "message": str(exc)})
        return

    yield _sse("stage_done", {"stage": "C", "label": "Mesh cleanup done", "progress": 65})

    yield _sse("stage", {
        "stage": "D",
        "label": f"Validating {n} candidate(s) in parallel…",
        "progress": 67,
    })
    yield _sse("stage", {
        "stage": "E",
        "label": f"Computing world placement for {n} candidate(s) in parallel…",
        "progress": 68,
    })

    # Fire D and E as concurrent asyncio tasks — both fan-out via starmap
    async def _run_validate():
        return await asyncio.to_thread(
            lambda: list(
                validate_asset.starmap(
                    [(run_id, cid, c_rel, asset_spec, req.world_context)
                     for cid, c_rel in enumerate(cleaned_rels)]
                )
            )
        )

    async def _run_placement():
        return await asyncio.to_thread(
            lambda: list(
                placement_patch.starmap(
                    [(run_id, cid, c_rel, asset_spec, req.world_context)
                     for cid, c_rel in enumerate(cleaned_rels)]
                )
            )
        )

    try:
        reports, patches = await asyncio.gather(_run_validate(), _run_placement())
    except Exception as exc:
        yield _sse("error", {"stage": "D/E", "message": str(exc)})
        return

    yield _sse("stage_done", {"stage": "D", "label": "Validation complete", "progress": 88})
    yield _sse("stage_done", {"stage": "E", "label": "Placement computed", "progress": 95})

    results = [
        {
            "candidate_id": cid,
            "seed":         seeds[cid],
            "cleaned_glb":  cleaned_rels[cid],
            "validation":   reports[cid],
            "world_patch":  patches[cid],
        }
        for cid in range(n)
    ]

    # ── Rank & select best ────────────────────────────────────────────────────
    def _rank_key(r: dict) -> tuple:
        v = r["validation"]
        return (0 if v.get("passed") else 1, -v.get("score", 0))

    results.sort(key=_rank_key)
    best = results[0]

    summary = {
        "run_id": run_id,
        "best_candidate": best["candidate_id"],
        "best_seed": best["seed"],
        "best_glb": best["cleaned_glb"],
        "validation": best["validation"],
        "world_patch": best["world_patch"],
        "all_candidates": results,
    }

    summary_path = OUTPUTS_PATH / run_id / "pipeline_summary.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2))
    await volume_outputs.commit.aio()

    cid_best = best["candidate_id"]
    yield _sse("done", {
        "run_id": run_id,
        "progress": 100,
        "label": "Generation complete!",
        "download_path": f"{run_id}/candidate_{cid_best:02d}",
        "validation": best["validation"],
        "world_patch": best["world_patch"],
        "asset_spec": asset_spec,
    })


def _register_routes(api):
    @api.post("/generate")
    async def generate(req: GenerateRequest):
        return StreamingResponse(
            _stream_pipeline(req),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    @api.get("/download/{run_id}/{candidate_folder}")
    async def download_glb(run_id: str, candidate_folder: str):
        await volume_outputs.reload.aio()
        glb_path = OUTPUTS_PATH / run_id / candidate_folder / "cleaned.glb"
        if not glb_path.exists():
            raise HTTPException(status_code=404, detail="GLB not found")
        data = glb_path.read_bytes()
        return Response(
            content=data,
            media_type="model/gltf-binary",
            headers={
                "Content-Disposition": f'attachment; filename="asset_{run_id}.glb"',
                "Access-Control-Allow-Origin": "*",
            },
        )

    @api.get("/health")
    async def health():
        return {"status": "ok"}


# Register routes only when fastapi is available (i.e. in web_image containers)
if api is not None:
    _register_routes(api)


@app.function(
    image=web_image,
    volumes={
        str(OUTPUTS_PATH): volume_outputs,
    },
    timeout=1800,
    secrets=[gemini_secret],
)
@modal.concurrent(max_inputs=50)
@modal.asgi_app()
def web_api():
    return api



# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------
@app.local_entrypoint()
def main(
    world: str,
    prompt: str,
    hint: Optional[str] = None,
    candidates: int = 2,
    seed: int = 42,
    run_id: Optional[str] = None,
):
    """
    CLI:
        python pipeline/modal_app.py run \\
            --world world_context.json \\
            --prompt "a red metal toolbox near the workbench" \\
            --hint placement_hint.json \\
            --candidates 2 --seed 42
    """
    from rich.console import Console
    from rich.json import JSON

    console = Console()

    world_context   = json.loads(Path(world).read_text())
    placement_hint  = json.loads(Path(hint).read_text()) if hint else None

    console.rule("[bold cyan]World Asset Pipeline")
    console.print(f"[dim]World:[/dim]   {world}")
    console.print(f"[dim]Prompt:[/dim]  {prompt}")
    console.print(f"[dim]Hint:[/dim]    {hint or 'none'}")
    console.print(f"[dim]Seeds:[/dim]   {seed} … {seed + (candidates - 1) * 1000}")

    summary = run_pipeline.remote(
        world_context=world_context,
        user_prompt=prompt,
        placement_hint=placement_hint,
        num_candidates=candidates,
        base_seed=seed,
        run_id=run_id,
    )

    console.rule("[bold green]Pipeline Complete")
    console.print(JSON(json.dumps(summary, indent=2)))
