"""
Patch script: replaces TripoSR's isosurface.py (which imports torchmcubes)
with a version that uses PyMCubes (mcubes) instead.

Run inside the Modal image builder after TripoSR is cloned:
    python3 /tmp/patch_triposr_isosurface.py
"""

import pathlib

TARGET = pathlib.Path("/opt/TripoSR/tsr/models/isosurface.py")

PATCHED = '''\
from typing import Callable, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import mcubes


def _mcubes_wrapper(vol: torch.Tensor, level: float):
    """Thin wrapper so PyMCubes matches the torchmcubes return convention.

    torchmcubes.marching_cubes(vol, level) finds the isosurface where
    vol == level and returns (verts_tensor, faces_tensor) on the same device.

    mcubes.marching_cubes(vol_np, level) does the same thing on CPU numpy
    arrays and returns (verts_np, faces_np).  We convert back to tensors.
    """
    v_np, f_np = mcubes.marching_cubes(-vol.cpu().numpy(), -level)
    return (
        torch.from_numpy(v_np.astype(np.float32).copy()),
        torch.from_numpy(f_np.astype(np.int64).copy()),
    )


class IsosurfaceHelper(nn.Module):
    points_range: Tuple[float, float] = (0, 1)

    @property
    def grid_vertices(self) -> torch.FloatTensor:
        raise NotImplementedError


class MarchingCubeHelper(IsosurfaceHelper):
    def __init__(self, resolution: int) -> None:
        super().__init__()
        self.resolution = resolution
        self.mc_func: Callable = _mcubes_wrapper
        self._grid_vertices: Optional[torch.FloatTensor] = None

    @property
    def grid_vertices(self) -> torch.FloatTensor:
        if self._grid_vertices is None:
            x, y, z = (
                torch.linspace(*self.points_range, self.resolution),
                torch.linspace(*self.points_range, self.resolution),
                torch.linspace(*self.points_range, self.resolution),
            )
            x, y, z = torch.meshgrid(x, y, z, indexing="ij")
            verts = torch.cat(
                [x.reshape(-1, 1), y.reshape(-1, 1), z.reshape(-1, 1)], dim=-1
            ).reshape(-1, 3)
            self._grid_vertices = verts
        return self._grid_vertices

    def forward(
        self, level: torch.FloatTensor
    ) -> Tuple[torch.FloatTensor, torch.LongTensor]:
        level = -level.view(self.resolution, self.resolution, self.resolution)
        v_pos, t_pos_idx = self.mc_func(level.detach(), 0.0)
        v_pos = v_pos[..., [2, 1, 0]]
        v_pos = v_pos / (self.resolution - 1.0)
        return v_pos.to(level.device), t_pos_idx.to(level.device)
'''

TARGET.write_text(PATCHED)
print(f"Patched {TARGET} — torchmcubes replaced with PyMCubes wrapper.")
