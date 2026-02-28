'use client';

/**
 * SceneOverlay — a fixed canvas that draws the projected 3-D wireframe bounding box
 * around the active ROI. A small pinch handle at the box center lets the user
 * pinch to shrink/enlarge the selection (scale edge vertices around center).
 */

import { useRef, useEffect, useCallback } from 'react';
import { projectToScreen, screenToRay, rayPlaneIntersection, rayAABBEntry, getCameraForward } from '@/lib/roiSelection.js';

const PINCH_HANDLE_SIZE = 56;
const SCALE_MIN = 0.25;
const SCALE_MAX = 2;

function dist(t0, t1) {
  return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
}

const BOX_EDGES = [
  [0,1],[1,2],[2,3],[3,0], // near face (min Z)
  [4,5],[5,6],[6,7],[7,4], // far  face (max Z)
  [0,4],[1,5],[2,6],[3,7], // connecting edges
];

function getCornersFromBounds(bounds) {
  const { min: mn, max: mx } = bounds;
  return [
    [mn.x, mn.y, mn.z], [mx.x, mn.y, mn.z],
    [mx.x, mx.y, mn.z], [mn.x, mx.y, mn.z],
    [mn.x, mn.y, mx.z], [mx.x, mn.y, mx.z],
    [mx.x, mx.y, mx.z], [mn.x, mx.y, mx.z],
  ];
}

function drawBox(ctx, roi, bounds, displayCenter, camera, w, h) {
  const corners       = getCornersFromBounds(bounds);
  const screenCorners = corners.map(([wx, wy, wz]) =>
    projectToScreen(wx, wy, wz, camera, w, h),
  );

  // Dashed edges
  ctx.strokeStyle = 'rgba(129, 140, 248, 0.7)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([5, 4]);

  for (const [a, b] of BOX_EDGES) {
    const sa = screenCorners[a];
    const sb = screenCorners[b];
    if (!sa || !sb) continue;
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Corner dots
  ctx.fillStyle = 'rgba(129, 140, 248, 0.8)';
  for (const sc of screenCorners) {
    if (!sc) continue;
    ctx.beginPath();
    ctx.arc(sc.x, sc.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // World-center crosshair (use displayCenter when provided for move handle)
  const center = displayCenter ?? roi.worldCenter;
  const cs = projectToScreen(
    center.x, center.y, center.z,
    camera, w, h,
  );
  if (cs) {
    const arm = 9;
    ctx.strokeStyle = 'rgba(129, 140, 248, 0.9)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(cs.x - arm, cs.y); ctx.lineTo(cs.x + arm, cs.y);
    ctx.moveTo(cs.x, cs.y - arm); ctx.lineTo(cs.x, cs.y + arm);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cs.x, cs.y, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  return cs;
}

function getFaceMeta(bounds, face) {
  const { min: mn, max: mx } = bounds;
  const cx = (mn.x + mx.x) / 2, cy = (mn.y + mx.y) / 2, cz = (mn.z + mx.z) / 2;
  const map = {
    minX: { value: mn.x, center: { x: mn.x, y: cy, z: cz }, normal: { x: -1, y: 0, z: 0 } },
    maxX: { value: mx.x, center: { x: mx.x, y: cy, z: cz }, normal: { x: 1, y: 0, z: 0 } },
    minY: { value: mn.y, center: { x: cx, y: mn.y, z: cz }, normal: { x: 0, y: -1, z: 0 } },
    maxY: { value: mx.y, center: { x: cx, y: mx.y, z: cz }, normal: { x: 0, y: 1, z: 0 } },
    minZ: { value: mn.z, center: { x: cx, y: cy, z: mn.z }, normal: { x: 0, y: 0, z: -1 } },
    maxZ: { value: mx.z, center: { x: cx, y: cy, z: mx.z }, normal: { x: 0, y: 0, z: 1 } },
  };
  return map[face];
}

export default function SceneOverlay({
  roi,
  displayBounds,
  displayCenter,
  viewerRef,
  selectionScale = 1,
  onSelectionScaleChange,
  onSelectionCenterChange,
  onFaceDrag,
}) {
  const canvasRef = useRef(null);
  const handleRef = useRef(null);
  const boundsRef = useRef(null);
  const bounds = displayBounds ?? roi?.bounds;
  const pinchRef = useRef(null);
  const dragRef = useRef(null);
  const faceDragRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const handle = handleRef.current;
    if (!canvas) return;

    if (!roi?.bounds) {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      if (handle) {
        handle.style.display = 'none';
      }
      return;
    }

    let rafId;
    const frame = () => {
      rafId = requestAnimationFrame(frame);
      const camera = viewerRef.current?.camera;
      if (!camera) return;
      boundsRef.current = bounds;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const center = displayCenter ?? roi?.worldCenter;
      const cs = drawBox(ctx, roi, bounds, center, camera, canvas.width, canvas.height);
      if (handle && cs) {
        handle.style.display = 'block';
        handle.style.left = `${cs.x - PINCH_HANDLE_SIZE / 2}px`;
        handle.style.top = `${cs.y - PINCH_HANDLE_SIZE / 2}px`;
      } else if (handle) {
        handle.style.display = 'none';
      }
    };

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, [roi, bounds, displayCenter, viewerRef]);

  const onTouchStart = useCallback((e) => {
    if (e.touches.length === 2 && onSelectionScaleChange) {
      pinchRef.current = {
        initialDistance: dist(e.touches[0], e.touches[1]),
        initialScale: selectionScale,
      };
      dragRef.current = null;
    } else if (e.touches.length === 1 && onSelectionCenterChange && displayCenter) {
      dragRef.current = { startCenter: { ...displayCenter } };
      pinchRef.current = null;
    }
  }, [selectionScale, displayCenter, onSelectionScaleChange, onSelectionCenterChange]);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if (!displayCenter || !onSelectionCenterChange) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startCenter: { ...displayCenter } };
  }, [displayCenter, onSelectionCenterChange]);

  const onPointerMove = useCallback((e) => {
    if (e.pointerType === 'touch') return;
    if (!dragRef.current || !onSelectionCenterChange) return;
    e.preventDefault();
    const camera = viewerRef.current?.camera;
    if (!camera) return;
    const ray = screenToRay(camera, e.clientX, e.clientY, window.innerWidth, window.innerHeight);
    if (!ray) return;
    const planeNormal = getCameraForward(camera);
    const hit = rayPlaneIntersection(ray.origin, ray.direction, dragRef.current.startCenter, planeNormal);
    if (hit) {
      onSelectionCenterChange(hit);
      dragRef.current.startCenter = hit;
    }
  }, [onSelectionCenterChange, viewerRef]);

  const onPointerUp = useCallback((e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    dragRef.current = null;
    faceDragRef.current = null;
  }, []);

  const onCanvasPointerDown = useCallback((e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || !boundsRef.current || !onFaceDrag) return;
    const camera = viewerRef.current?.camera;
    if (!camera) return;
    const ray = screenToRay(camera, e.clientX, e.clientY, window.innerWidth, window.innerHeight);
    if (!ray) return;
    const hit = rayAABBEntry(ray, boundsRef.current);
    if (!hit || hit.t < 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const meta = getFaceMeta(boundsRef.current, hit.face);
    faceDragRef.current = {
      face: hit.face,
      startValue: meta.value,
      startX: e.clientX,
      startY: e.clientY,
    };
  }, [onFaceDrag, viewerRef]);

  const onCanvasPointerMove = useCallback((e) => {
    if (e.pointerType === 'touch') return;
    if (!faceDragRef.current || !onFaceDrag) return;
    const camera = viewerRef.current?.camera;
    if (!camera || !boundsRef.current) return;
    e.preventDefault();
    const { face, startValue, startX, startY } = faceDragRef.current;
    const meta = getFaceMeta(boundsRef.current, face);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const p0 = projectToScreen(meta.center.x, meta.center.y, meta.center.z, camera, w, h);
    const n = meta.normal;
    const p1 = projectToScreen(
      meta.center.x + n.x,
      meta.center.y + n.y,
      meta.center.z + n.z,
      camera,
      w,
      h
    );
    if (!p0 || !p1) return;
    const screenDx = p1.x - p0.x;
    const screenDy = p1.y - p0.y;
    const screenLen = Math.hypot(screenDx, screenDy) || 1;
    const mouseDx = e.clientX - startX;
    const mouseDy = e.clientY - startY;
    const worldDelta = (mouseDx * screenDx + mouseDy * screenDy) / (screenLen * 100);
    const newValue = startValue + worldDelta;
    onFaceDrag(face, newValue);
  }, [onFaceDrag, viewerRef]);

  const onCanvasPointerUp = useCallback((e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    faceDragRef.current = null;
  }, []);

  const onTouchMove = useCallback((e) => {
    if (e.touches.length === 2 && pinchRef.current && onSelectionScaleChange) {
      e.preventDefault();
      const d = dist(e.touches[0], e.touches[1]);
      const { initialDistance, initialScale } = pinchRef.current;
      if (initialDistance <= 0) return;
      let scale = initialScale * (d / initialDistance);
      scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, scale));
      onSelectionScaleChange(scale);
    } else if (e.touches.length === 1 && dragRef.current && onSelectionCenterChange) {
      e.preventDefault();
      const camera = viewerRef.current?.camera;
      if (!camera) return;
      const t = e.touches[0];
      const ray = screenToRay(camera, t.clientX, t.clientY, window.innerWidth, window.innerHeight);
      if (!ray) return;
      const planeNormal = getCameraForward(camera);
      const hit = rayPlaneIntersection(ray.origin, ray.direction, dragRef.current.startCenter, planeNormal);
      if (hit) {
        onSelectionCenterChange(hit);
        dragRef.current.startCenter = hit;
      }
    }
  }, [onSelectionScaleChange, onSelectionCenterChange, viewerRef]);

  const onTouchEnd = useCallback((e) => {
    if (e.touches.length < 2) pinchRef.current = null;
    if (e.touches.length < 1) dragRef.current = null;
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: roi?.bounds && onFaceDrag ? 'auto' : 'none',
          zIndex: 18,
          cursor: roi?.bounds && onFaceDrag ? 'grab' : 'default',
        }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerLeave={onCanvasPointerUp}
      />
      {roi?.bounds && (onSelectionScaleChange || onSelectionCenterChange) && (
        <div
          ref={handleRef}
          role="button"
          tabIndex={0}
          aria-label="Drag to move selection, pinch to resize"
          style={{
            position: 'fixed',
            width: PINCH_HANDLE_SIZE,
            height: PINCH_HANDLE_SIZE,
            marginLeft: 0,
            marginTop: 0,
            borderRadius: '50%',
            background: 'rgba(129, 140, 248, 0.12)',
            border: '1px solid rgba(129, 140, 248, 0.4)',
            cursor: 'grab',
            zIndex: 19,
            touchAction: 'none',
            display: 'none',
          }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />
      )}
    </>
  );
}
