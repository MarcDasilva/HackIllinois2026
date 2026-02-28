/**
 * Canvas-based visual effects for animated ROI regions.
 *
 * Each effect renders onto a 2D canvas overlay that sits on top of the
 * Gaussian splat scene. Effects are driven by a high-resolution timer (t in
 * seconds) and computed entirely on the CPU — no shader patching required.
 *
 * GPU-side per-splat displacement (Phase 5) will require accessing
 * viewer.splatMesh.material and patching the vertex shader uniforms; this
 * file provides the canvas fallback that works today.
 *
 * All helpers import projectToScreen so they can map 3-D world bounds into
 * 2-D screen space without touching THREE.js.
 */

import { projectToScreen } from './roiSelection.js';

// ─── Screen-space AABB helper ────────────────────────────────────────────────

/**
 * Project all 8 corners of a 3-D AABB into screen space and return the 2-D
 * bounding box of the visible corners plus a centroid.
 * Returns null if every corner is behind the camera.
 */
export function getRoiScreenBounds(roi, camera, width, height) {
  const { min, max } = roi.bounds;
  const corners = [
    [min.x, min.y, min.z], [max.x, min.y, min.z],
    [max.x, max.y, min.z], [min.x, max.y, min.z],
    [min.x, min.y, max.z], [max.x, min.y, max.z],
    [max.x, max.y, max.z], [min.x, max.y, max.z],
  ];

  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  let visible = 0;

  for (const [wx, wy, wz] of corners) {
    const s = projectToScreen(wx, wy, wz, camera, width, height);
    if (!s) continue;
    visible++;
    if (s.x < sMinX) sMinX = s.x;
    if (s.y < sMinY) sMinY = s.y;
    if (s.x > sMaxX) sMaxX = s.x;
    if (s.y > sMaxY) sMaxY = s.y;
  }

  if (!visible) return null;

  // Clamp to canvas so effects don't draw wildly off-screen
  sMinX = Math.max(-200, sMinX);
  sMinY = Math.max(-200, sMinY);
  sMaxX = Math.min(width  + 200, sMaxX);
  sMaxY = Math.min(height + 200, sMaxY);

  const w = sMaxX - sMinX;
  const h = sMaxY - sMinY;

  return {
    minX: sMinX, minY: sMinY,
    maxX: sMaxX, maxY: sMaxY,
    cx: (sMinX + sMaxX) / 2,
    cy: (sMinY + sMaxY) / 2,
    w, h,
  };
}

// ─── Individual effects ───────────────────────────────────────────────────────

// Sway — animated sinusoidal wind-wisps running horizontally through the region
function drawSway(ctx, anim, sb, t) {
  const { amplitude = 0.05, frequency = 0.8 } = anim.params;
  const amp  = Math.min(sb.w * 0.12, 28) * Math.max(0.1, amplitude * 20);
  const freq = frequency * 2.5;
  const lines = Math.max(3, Math.round(sb.h / 24));

  ctx.save();
  ctx.strokeStyle = 'rgba(129, 140, 248, 0.45)';
  ctx.lineWidth = 1.5;

  for (let n = 0; n < lines; n++) {
    const phase  = (n / lines) * Math.PI * 2;
    const yBase  = sb.minY + (sb.h * (n + 0.5)) / lines;
    const alpha  = 0.2 + 0.3 * Math.abs(Math.sin(t * 0.7 + phase));
    ctx.globalAlpha = alpha;

    ctx.beginPath();
    const step = Math.max(2, sb.w / 80);
    for (let px = sb.minX; px <= sb.maxX; px += step) {
      const noise = Math.sin((px / sb.w) * 6 + t * freq + phase) * amp
                  + Math.sin((px / sb.w) * 2 + t * freq * 0.4 + phase) * amp * 0.4;
      if (px === sb.minX) ctx.moveTo(px, yBase + noise);
      else                ctx.lineTo(px, yBase + noise);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// Ripple — expanding concentric ellipses from the centroid
function drawRipple(ctx, anim, sb, t) {
  const rings = 4;
  const maxR  = Math.max(sb.w, sb.h) * 0.65;

  ctx.save();
  ctx.strokeStyle = '#818cf8';
  ctx.lineWidth   = 1.5;

  for (let n = 0; n < rings; n++) {
    const phase    = n / rings;
    const progress = ((t * 0.6 + phase) % 1);
    const rx = sb.w * 0.5 * progress;
    const ry = sb.h * 0.5 * progress;
    ctx.globalAlpha = (1 - progress) * 0.55;

    ctx.beginPath();
    ctx.ellipse(sb.cx, sb.cy, Math.max(2, rx), Math.max(2, ry), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// Flicker — fast-noise driven glow at the centroid (fire/lamp effect)
function drawFlicker(ctx, anim, sb, t) {
  const { flickerSpeed = 8 } = anim.params;
  // Deterministic pseudo-random flicker: sum of incommensurable sinusoids
  const noise = Math.sin(t * flickerSpeed * 7.3)  * 0.45
              + Math.sin(t * flickerSpeed * 13.1)  * 0.30
              + Math.cos(t * flickerSpeed * 4.9)   * 0.25;
  const intensity = Math.max(0, Math.min(1, 0.5 + 0.5 * noise));

  const radius = Math.max(sb.w, sb.h) * 0.45;

  ctx.save();
  ctx.globalAlpha = 0.35 + 0.4 * intensity;

  const g = ctx.createRadialGradient(sb.cx, sb.cy, 0, sb.cx, sb.cy, radius);
  g.addColorStop(0,   'rgba(251, 211, 100, 0.9)');
  g.addColorStop(0.35,'rgba(249, 115,  22, 0.6)');
  g.addColorStop(1,   'rgba(251, 191,  36, 0)');

  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(sb.cx, sb.cy, sb.w * 0.55, sb.h * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Pulse — slow breathing ring + fill
function drawPulse(ctx, anim, sb, t) {
  const { pulseRate = 1.5, minOpacity = 0.4, maxOpacity = 1.0 } = anim.params;
  const phase = Math.sin(t * pulseRate * Math.PI * 2);       // -1..1
  const scale = 0.78 + 0.28 * (0.5 + 0.5 * phase);
  const alpha = minOpacity + (maxOpacity - minOpacity) * (0.5 + 0.5 * phase);

  ctx.save();

  // Fill glow
  ctx.globalAlpha = Math.max(0, alpha * 0.25);
  const g = ctx.createRadialGradient(sb.cx, sb.cy, 0, sb.cx, sb.cy, sb.w * scale * 0.5);
  g.addColorStop(0, 'rgba(167, 139, 250, 0.7)');
  g.addColorStop(1, 'rgba(167, 139, 250, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(sb.cx, sb.cy, sb.w * scale * 0.5, sb.h * scale * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Stroke ring
  ctx.globalAlpha = Math.max(0, alpha * 0.65);
  ctx.strokeStyle = '#a78bfa';
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.ellipse(sb.cx, sb.cy, sb.w * scale * 0.5, sb.h * scale * 0.5, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

// Drift — buoyant particles rising from the bottom of the region
function drawDrift(ctx, anim, sb, t) {
  const { driftSpeed = 0.02 } = anim.params;
  const count   = Math.max(6, Math.round(sb.w / 18));
  const tScaled = t * driftSpeed * 12;

  ctx.save();
  ctx.fillStyle = '#818cf8';

  for (let n = 0; n < count; n++) {
    const seed    = n / count;
    const cycleT  = (tScaled + seed) % 1;         // 0..1 lifetime
    const px      = sb.minX + seed * sb.w
                  + Math.sin(seed * 9.1 + t * 0.8) * sb.w * 0.06;
    const py      = sb.maxY - cycleT * sb.h * 1.4; // rises upward
    const alpha   = cycleT < 0.6
                  ? cycleT / 0.6
                  : (1 - cycleT) / 0.4;
    const radius  = 2 + seed * 1.5;

    ctx.globalAlpha = Math.max(0, alpha * 0.65);
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Draw one animation's visual effect onto `ctx`.
 * Called every frame by SceneOverlay.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} animation  - { id, roiId, roi, effect, params, startTime }
 * @param {object} camera     - viewer.camera
 * @param {number} width      - canvas pixel width
 * @param {number} height     - canvas pixel height
 * @param {number} t          - elapsed seconds since animation start
 */
export function drawAnimationEffect(ctx, animation, camera, width, height, t) {
  const sb = getRoiScreenBounds(animation.roi, camera, width, height);
  if (!sb || sb.w < 4 || sb.h < 4) return;

  switch (animation.effect) {
    case 'sway':    return drawSway   (ctx, animation, sb, t);
    case 'ripple':  return drawRipple (ctx, animation, sb, t);
    case 'flicker': return drawFlicker(ctx, animation, sb, t);
    case 'pulse':   return drawPulse  (ctx, animation, sb, t);
    case 'drift':   return drawDrift  (ctx, animation, sb, t);
    default:        return drawPulse  (ctx, animation, sb, t);
  }
}
