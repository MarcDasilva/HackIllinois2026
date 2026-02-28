/**
 * ROI (Region of Interest) selection utilities.
 *
 * All projection math uses raw matrix element arrays — no THREE.js import,
 * so there is zero risk of dual-bundle version conflicts at runtime.
 *
 * getSplatCenter(i, outCenter, false) only writes to .x/.y/.z, so a plain
 * object is sufficient as the outCenter argument.
 */

// ─── Projection ──────────────────────────────────────────────────────────────

/**
 * Project a world-space position into 2-D screen pixel coordinates.
 * Returns null when the point is behind the camera (w ≤ 0).
 *
 * THREE matrices are stored column-major, so element layout is:
 *   m[col*4 + row]  →  e.g. m[4] = col-1 row-0 = element (0,1)
 */
export function projectToScreen(wx, wy, wz, camera, width, height) {
  const vm = camera.matrixWorldInverse.elements; // view matrix
  const pm = camera.projectionMatrix.elements;   // projection matrix

  // World → view space
  const vx = vm[0] * wx + vm[4] * wy + vm[8]  * wz + vm[12];
  const vy = vm[1] * wx + vm[5] * wy + vm[9]  * wz + vm[13];
  const vz = vm[2] * wx + vm[6] * wy + vm[10] * wz + vm[14];
  const vw = vm[3] * wx + vm[7] * wy + vm[11] * wz + vm[15];

  // View → clip space
  const cx = pm[0] * vx + pm[4] * vy + pm[8]  * vz + pm[12] * vw;
  const cy = pm[1] * vx + pm[5] * vy + pm[9]  * vz + pm[13] * vw;
  const cw = pm[3] * vx + pm[7] * vy + pm[11] * vz + pm[15] * vw;

  if (cw <= 0) return null; // behind the near plane

  // NDC → screen pixels
  return {
    x: (cx / cw + 1) * 0.5 * width,
    y: (1 - cy / cw) * 0.5 * height,
  };
}

/**
 * Unproject screen pixel to a ray in world space (origin + direction).
 * Uses camera matrices; no full matrix inverse (uses projection scale from proj matrix).
 */
export function screenToRay(camera, screenX, screenY, width, height) {
  const ndcX = (screenX / width) * 2 - 1;
  const ndcY = 1 - (screenY / height) * 2;
  const pm = camera.projectionMatrix.elements;
  const m = camera.matrixWorld.elements;
  const ox = m[12], oy = m[13], oz = m[14];
  const scaleX = 1 / (pm[0] || 1);
  const scaleY = 1 / (pm[5] || 1);
  const dx = ndcX * scaleX;
  const dy = ndcY * scaleY;
  const dz = -1;
  const len = Math.hypot(dx, dy, dz) || 1;
  const vx = dx / len, vy = dy / len, vz = dz / len;
  const wx = m[0] * vx + m[4] * vy + m[8] * vz;
  const wy = m[1] * vx + m[5] * vy + m[9] * vz;
  const wz = m[2] * vx + m[6] * vy + m[10] * vz;
  const wlen = Math.hypot(wx, wy, wz) || 1;
  return {
    origin: { x: ox, y: oy, z: oz },
    direction: { x: wx / wlen, y: wy / wlen, z: wz / wlen },
  };
}

/**
 * Ray-plane intersection. Returns world point or null.
 * planeNormal should be unit length.
 */
export function rayPlaneIntersection(rayOrigin, rayDirection, planePoint, planeNormal) {
  const denom = planeNormal.x * rayDirection.x + planeNormal.y * rayDirection.y + planeNormal.z * rayDirection.z;
  if (Math.abs(denom) < 1e-8) return null;
  const t = ((planePoint.x - rayOrigin.x) * planeNormal.x + (planePoint.y - rayOrigin.y) * planeNormal.y + (planePoint.z - rayOrigin.z) * planeNormal.z) / denom;
  if (t < 0) return null;
  return {
    x: rayOrigin.x + rayDirection.x * t,
    y: rayOrigin.y + rayDirection.y * t,
    z: rayOrigin.z + rayDirection.z * t,
  };
}

/** Camera forward in world space (unit vector, direction the camera looks). */
export function getCameraForward(camera) {
  const m = camera.matrixWorld.elements;
  const x = -m[8], y = -m[9], z = -m[10];
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

/**
 * Ray-AABB intersection. Returns entry point and which face was hit, or null.
 * face is one of 'minX'|'maxX'|'minY'|'maxY'|'minZ'|'maxZ'.
 */
export function rayAABBEntry(ray, bounds) {
  const { origin: o, direction: d } = ray;
  const { min: bmin, max: bmax } = bounds;
  const tx = Math.abs(d.x) >= 1e-10 ? [(bmin.x - o.x) / d.x, (bmax.x - o.x) / d.x] : [-Infinity, Infinity];
  const ty = Math.abs(d.y) >= 1e-10 ? [(bmin.y - o.y) / d.y, (bmax.y - o.y) / d.y] : [-Infinity, Infinity];
  const tz = Math.abs(d.z) >= 1e-10 ? [(bmin.z - o.z) / d.z, (bmax.z - o.z) / d.z] : [-Infinity, Infinity];
  const tMinX = Math.min(tx[0], tx[1]);
  const tMaxX = Math.max(tx[0], tx[1]);
  const tMinY = Math.min(ty[0], ty[1]);
  const tMaxY = Math.max(ty[0], ty[1]);
  const tMinZ = Math.min(tz[0], tz[1]);
  const tMaxZ = Math.max(tz[0], tz[1]);
  const tEntry = Math.max(tMinX, tMinY, tMinZ);
  const tExit = Math.min(tMaxX, tMaxY, tMaxZ);
  if (tEntry > tExit || tExit < 0) return null;
  const t = tEntry >= 0 ? tEntry : tExit;
  const pt = {
    x: o.x + d.x * t,
    y: o.y + d.y * t,
    z: o.z + d.z * t,
  };
  const eps = 1e-6;
  const face =
    Math.abs(pt.x - bmin.x) < eps ? 'minX'
    : Math.abs(pt.x - bmax.x) < eps ? 'maxX'
    : Math.abs(pt.y - bmin.y) < eps ? 'minY'
    : Math.abs(pt.y - bmax.y) < eps ? 'maxY'
    : Math.abs(pt.z - bmin.z) < eps ? 'minZ'
    : 'maxZ';
  return { t, point: pt, face };
}

// ─── Point-in-polygon (ray casting) ─────────────────────────────────────────

function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Iterate over splats, project each to screen space, and run a point-in-polygon
 * test against the lasso polygon.
 *
 * @param {object}   splatMesh  - viewer.splatMesh (has getSplatCenter / getSplatCount)
 * @param {object}   camera     - viewer.camera (THREE PerspectiveCamera)
 * @param {Array}    polygon    - [{x, y}, …] screen-space lasso points
 * @param {number}   viewWidth  - canvas width in CSS pixels
 * @param {number}   viewHeight - canvas height in CSS pixels
 * @returns {object|null} ROI descriptor, or null if nothing was selected
 */
export function computeRoi(splatMesh, camera, polygon, viewWidth, viewHeight) {
  if (!splatMesh || !camera || polygon.length < 3) return null;

  const splatCount = splatMesh.getSplatCount?.() ?? 0;
  if (splatCount === 0) return null;

  // Axis-aligned bounding box of the lasso for fast pre-rejection
  let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
  for (const p of polygon) {
    if (p.x < bMinX) bMinX = p.x;
    if (p.y < bMinY) bMinY = p.y;
    if (p.x > bMaxX) bMaxX = p.x;
    if (p.y > bMaxY) bMaxY = p.y;
  }

  // Stride sampling — cap the PIP test budget at ~200 k iterations regardless
  // of scene size. Selected indices are scaled back to be representative.
  const stride = Math.max(1, Math.ceil(splatCount / 200_000));

  const selectedIndices = [];
  const center = { x: 0, y: 0, z: 0 }; // reused each iteration

  // World-space bounds of selected splats (for NL context / placement hints)
  let wMinX = Infinity,  wMinY = Infinity,  wMinZ = Infinity;
  let wMaxX = -Infinity, wMaxY = -Infinity, wMaxZ = -Infinity;

  for (let i = 0; i < splatCount; i += stride) {
    splatMesh.getSplatCenter(i, center, false); // writes x/y/z, no transform

    const s = projectToScreen(center.x, center.y, center.z, camera, viewWidth, viewHeight);
    if (!s) continue;

    // AABB pre-rejection (avoids full PIP test for most splats)
    if (s.x < bMinX || s.x > bMaxX || s.y < bMinY || s.y > bMaxY) continue;

    if (pointInPolygon(s.x, s.y, polygon)) {
      selectedIndices.push(i);
      if (center.x < wMinX) wMinX = center.x;
      if (center.y < wMinY) wMinY = center.y;
      if (center.z < wMinZ) wMinZ = center.z;
      if (center.x > wMaxX) wMaxX = center.x;
      if (center.y > wMaxY) wMaxY = center.y;
      if (center.z > wMaxZ) wMaxZ = center.z;
    }
  }

  if (selectedIndices.length === 0) return null;

  return {
    id: `roi-${Date.now()}`,
    label: 'lasso-selection',

    // Sampled indices (each represents `stride` actual splats)
    indices: selectedIndices,
    // Approximate total splat count in the selection
    estimatedCount: selectedIndices.length * stride,

    bounds: {
      min: { x: wMinX, y: wMinY, z: wMinZ },
      max: { x: wMaxX, y: wMaxY, z: wMaxZ },
    },
    worldCenter: {
      x: (wMinX + wMaxX) / 2,
      y: (wMinY + wMaxY) / 2,
      z: (wMinZ + wMaxZ) / 2,
    },

    // Keep the screen polygon so the overlay can redraw it
    polygon,
  };
}

// ─── Splat data extraction ────────────────────────────────────────────────────

/**
 * Read full Gaussian parameters (position + RGBA color) for a set of splat
 * indices. Used to build a sub-PLY payload for backend editing pipelines.
 *
 * getSplatColor writes to outColor.r / .g / .b / .a (0–255 or 0–1 depending
 * on compression level) — a plain object is safe.
 *
 * @param {object} splatMesh - viewer.splatMesh
 * @param {number[]} indices - sampled splat indices from computeRoi
 * @returns {Array<{index,x,y,z,r,g,b,opacity}>}
 */
export function extractSplatData(splatMesh, indices) {
  if (!splatMesh || !indices?.length) return [];

  const splatCount = splatMesh.getSplatCount?.() ?? 0;
  const center = { x: 0, y: 0, z: 0 };
  const color  = { r: 0, g: 0, b: 0, a: 1 };
  const result = [];

  for (const i of indices) {
    if (i >= splatCount) continue;

    splatMesh.getSplatCenter(i, center, false);

    try { splatMesh.getSplatColor(i, color); } catch { /* non-fatal */ }

    result.push({
      index:   i,
      x: center.x,
      y: center.y,
      z: center.z,
      r:       color.r ?? 0,
      g:       color.g ?? 0,
      b:       color.b ?? 0,
      opacity: color.a ?? color.opacity ?? 1,
    });
  }

  return result;
}
