'use client';

/**
 * SelectionBox overlay — click-drag to draw a screen-space rectangle.
 * The rectangle is converted to a 4-corner polygon and passed to onComplete,
 * which feeds computeRoi just like the old freehand lasso did.
 * SceneOverlay then projects the resulting 3-D AABB as a wireframe cube.
 */

import { useRef, useEffect, useCallback } from 'react';

const STROKE_ACTIVE = 'rgba(129, 140, 248, 0.9)';
const STROKE_DONE   = 'rgba(129, 140, 248, 0.65)';
const FILL_ACTIVE   = 'rgba(129, 140, 248, 0.10)';
const FILL_DONE     = 'rgba(129, 140, 248, 0.07)';

function drawRect(ctx, x1, y1, x2, y2, done) {
  const left = Math.min(x1, x2);
  const top  = Math.min(y1, y2);
  const w    = Math.abs(x2 - x1);
  const h    = Math.abs(y2 - y1);
  if (w < 1 || h < 1) return;

  ctx.fillStyle   = done ? FILL_DONE   : FILL_ACTIVE;
  ctx.strokeStyle = done ? STROKE_DONE : STROKE_ACTIVE;
  ctx.lineWidth   = done ? 1.5 : 1;
  ctx.setLineDash(done ? [] : [5, 4]);

  ctx.beginPath();
  ctx.rect(left, top, w, h);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);

  // Corner handles
  ctx.fillStyle = done ? STROKE_DONE : STROKE_ACTIVE;
  for (const [cx, cy] of [[left, top], [left + w, top], [left + w, top + h], [left, top + h]]) {
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Props:
 *   active    {boolean}         — enable drawing (captures pointer events)
 *   roi       {object|null}     — current ROI; used to keep the rect visible after draw
 *   onComplete {fn(polygon[])}  — called with 4-corner polygon on release
 *   onCancel  {fn}              — called on Escape
 */
export default function LassoOverlay({ active, roi, onComplete, onCancel }) {
  const canvasRef  = useRef(null);
  const drawState  = useRef({ drawing: false, x0: 0, y0: 0, x1: 0, y1: 0 });

  // ── Resize ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      repaint();
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const { drawing, x0, y0, x1, y1 } = drawState.current;

    if (drawing) {
      drawRect(ctx, x0, y0, x1, y1, false);
      return;
    }

    // When a selection exists we show only the 3D cube (SceneOverlay);
    // do not redraw the 2D rectangle here.
  }, [roi]);

  // Repaint when roi changes (e.g. cleared externally)
  useEffect(() => { repaint(); }, [roi, repaint]);

  // ── Pointer handlers ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!active) {
      if (drawState.current.drawing) {
        drawState.current = { drawing: false, x0: 0, y0: 0, x1: 0, y1: 0 };
        repaint();
      }
      return;
    }

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      drawState.current = { drawing: true, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      repaint();
    };

    const onPointerMove = (e) => {
      if (!drawState.current.drawing) return;
      drawState.current.x1 = e.clientX;
      drawState.current.y1 = e.clientY;
      repaint();
    };

    const onPointerUp = (e) => {
      if (!drawState.current.drawing) return;
      drawState.current.drawing = false;

      const { x0, y0 } = drawState.current;
      const x1 = e.clientX, y1 = e.clientY;

      // Require a minimum drag size to avoid accidental single clicks
      if (Math.abs(x1 - x0) < 8 || Math.abs(y1 - y0) < 8) {
        drawState.current = { drawing: false, x0: 0, y0: 0, x1: 0, y1: 0 };
        repaint();
        return;
      }

      const left  = Math.min(x0, x1);
      const top   = Math.min(y0, y1);
      const right = Math.max(x0, x1);
      const bot   = Math.max(y0, y1);

      // 4-corner polygon (clockwise from top-left)
      const polygon = [
        { x: left,  y: top },
        { x: right, y: top },
        { x: right, y: bot },
        { x: left,  y: bot },
      ];

      repaint();
      onComplete(polygon);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        drawState.current = { drawing: false, x0: 0, y0: 0, x1: 0, y1: 0 };
        repaint();
        onCancel?.();
      }
    };

    canvas.addEventListener('pointerdown',  onPointerDown);
    window.addEventListener('pointermove',  onPointerMove);
    window.addEventListener('pointerup',    onPointerUp);
    window.addEventListener('keydown',      onKeyDown);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove',  onPointerMove);
      window.removeEventListener('pointerup',    onPointerUp);
      window.removeEventListener('keydown',      onKeyDown);
    };
  }, [active, onComplete, onCancel, repaint]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position:      'fixed',
        inset:         0,
        pointerEvents: active ? 'all' : 'none',
        cursor:        active ? 'crosshair' : 'default',
        zIndex:        20,
      }}
    />
  );
}
