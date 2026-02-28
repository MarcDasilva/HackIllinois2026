'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import Hud          from './Hud.jsx';
import LassoOverlay from './LassoOverlay.jsx';
import SceneOverlay from './SceneOverlay.jsx';
import { computeRoi }         from '@/lib/roiSelection.js';
import { parseIntent }        from '@/lib/intentParse.js';
import { buildFilteredPly, canDeleteInFormat } from '@/lib/buildFilteredPly.js';

// Blob URLs carry no extension — derive SceneFormat from the original filename.
function sceneFormatFromFileName(name) {
  const { SceneFormat } = GaussianSplats3D;
  const lower = (name ?? '').toLowerCase();
  if (lower.endsWith('.ksplat')) return SceneFormat.KSplat;
  if (lower.endsWith('.splat')) return SceneFormat.Splat;
  if (lower.endsWith('.spz'))   return SceneFormat.Spz;
  return SceneFormat.Ply;
}

// Scale AABB around world center for resize control.
function scaleBounds(bounds, worldCenter, scale) {
  if (!bounds?.min || !bounds?.max || !worldCenter || scale === 1) return bounds;
  const c = worldCenter;
  const min = bounds.min;
  const max = bounds.max;
  return {
    min: {
      x: c.x + (min.x - c.x) * scale,
      y: c.y + (min.y - c.y) * scale,
      z: c.z + (min.z - c.z) * scale,
    },
    max: {
      x: c.x + (max.x - c.x) * scale,
      y: c.y + (max.y - c.y) * scale,
      z: c.z + (max.z - c.z) * scale,
    },
  };
}

function translateBounds(bounds, delta) {
  if (!bounds?.min || !bounds?.max || !delta) return bounds;
  return {
    min: { x: bounds.min.x + delta.x, y: bounds.min.y + delta.y, z: bounds.min.z + delta.z },
    max: { x: bounds.max.x + delta.x, y: bounds.max.y + delta.y, z: bounds.max.z + delta.z },
  };
}

/** Get width, height, depth from AABB. */
function boundsDimensions(bounds) {
  if (!bounds?.min || !bounds?.max) return null;
  return {
    width: bounds.max.x - bounds.min.x,
    height: bounds.max.y - bounds.min.y,
    depth: bounds.max.z - bounds.min.z,
  };
}

/** Merge optional per-face overrides into bounds. Each override is number | null. */
function mergeFaceOverrides(baseBounds, overrides) {
  if (!baseBounds?.min || !baseBounds?.max) return baseBounds;
  if (!overrides) return baseBounds;
  const min = {
    x: overrides.minX ?? baseBounds.min.x,
    y: overrides.minY ?? baseBounds.min.y,
    z: overrides.minZ ?? baseBounds.min.z,
  };
  const max = {
    x: overrides.maxX ?? baseBounds.max.x,
    y: overrides.maxY ?? baseBounds.max.y,
    z: overrides.maxZ ?? baseBounds.max.z,
  };
  const eps = 1e-6;
  if (min.x > max.x - eps) min.x = max.x - eps;
  if (min.y > max.y - eps) min.y = max.y - eps;
  if (min.z > max.z - eps) min.z = max.z - eps;
  if (max.x < min.x + eps) max.x = min.x + eps;
  if (max.y < min.y + eps) max.y = min.y + eps;
  if (max.z < min.z + eps) max.z = min.z + eps;
  return { min, max };
}

// ─── Camera controls (look + fly + scroll-zoom) ───────────────────────────────
//
// startControls returns { stop, setEnabled } so lasso mode can pause
// navigation without tearing down and recreating all event listeners.

const LOOK_SENS    = 0.003;
const BASE_SPEED   = 0.06;
const SHIFT_MULT   = 4;
const SCROLL_SPEED = 0.4;

function startControls(viewer, domElement) {
  const keys   = new Set();
  let dragging = false;
  let enabled  = true;
  let lastX = 0, lastY = 0;

  const onPointerDown = (e) => {
    if (!enabled || e.button !== 0) return;
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    domElement.style.cursor = 'grabbing';
  };

  const onPointerMove = (e) => {
    if (!enabled || !dragging) return;
    const cam = viewer.camera;
    if (!cam) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    cam.rotation.order = 'YXZ';
    cam.rotation.y -= dx * LOOK_SENS;
    cam.rotation.x  = Math.max(
      -Math.PI / 2 + 0.01,
      Math.min(Math.PI / 2 - 0.01, cam.rotation.x - dy * LOOK_SENS),
    );
    cam.updateMatrixWorld(true);
    viewer.forceRenderNextFrame?.();
  };

  const onPointerUp = () => {
    dragging = false;
    if (enabled) domElement.style.cursor = '';
  };

  const onWheel = (e) => {
    if (!enabled) return;
    e.preventDefault();
    const cam = viewer.camera;
    if (!cam) return;
    const m = cam.matrixWorld.elements;
    const s = e.deltaY * 0.01 * SCROLL_SPEED;
    cam.position.x += m[8]  * s;
    cam.position.y += m[9]  * s;
    cam.position.z += m[10] * s;
    cam.updateMatrixWorld(true);
    viewer.forceRenderNextFrame?.();
  };

  const onKeyDown = (e) => {
    if (!enabled) return;
    if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))
      e.preventDefault();
    keys.add(e.code);
  };
  const onKeyUp = (e) => keys.delete(e.code);

  domElement.addEventListener('pointerdown', onPointerDown);
  domElement.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup',   onPointerUp);
  window.addEventListener('keydown',     onKeyDown);
  window.addEventListener('keyup',       onKeyUp);

  let rafId;
  const tick = () => {
    rafId = requestAnimationFrame(tick);
    if (!enabled || !keys.size) return;
    const cam = viewer.camera;
    if (!cam) return;
    const m  = cam.matrixWorld.elements;
    const rx = m[0],  ry = m[1],  rz = m[2];
    const fx = -m[8], fy = -m[9], fz = -m[10];
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? SHIFT_MULT : 1) * BASE_SPEED;
    let dx = 0, dy = 0, dz = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp'))                                 { dx += fx*speed; dy += fy*speed; dz += fz*speed; }
    if (keys.has('KeyS') || keys.has('ArrowDown'))                               { dx -= fx*speed; dy -= fy*speed; dz -= fz*speed; }
    if (keys.has('KeyA') || keys.has('ArrowLeft'))                               { dx -= rx*speed; dy -= ry*speed; dz -= rz*speed; }
    if (keys.has('KeyD') || keys.has('ArrowRight'))                              { dx += rx*speed; dy += ry*speed; dz += rz*speed; }
    if (keys.has('KeyE') || keys.has('Space'))                                   { dy += speed; }
    if (keys.has('KeyQ') || keys.has('ControlLeft') || keys.has('ControlRight')) { dy -= speed; }
    if (dx === 0 && dy === 0 && dz === 0) return;
    cam.position.x += dx; cam.position.y += dy; cam.position.z += dz;
    cam.updateMatrixWorld(true);
    viewer.forceRenderNextFrame?.();
  };
  rafId = requestAnimationFrame(tick);

  return {
    stop: () => {
      cancelAnimationFrame(rafId);
      domElement.removeEventListener('pointerdown', onPointerDown);
      domElement.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup',   onPointerUp);
      window.removeEventListener('keydown',     onKeyDown);
      window.removeEventListener('keyup',       onKeyUp);
    },
    setEnabled: (val) => {
      enabled = val;
      if (!val) { dragging = false; keys.clear(); domElement.style.cursor = 'crosshair'; }
      else      { domElement.style.cursor = 'grab'; }
    },
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GaussianViewer({ splatUrl, fileName, file, onReset, onRoiChange, onSceneUpdate, initialCameraState, onCameraRestored }) {
  const rootRef     = useRef(null);
  const viewerRef   = useRef(null);
  const controlsRef = useRef(null);

  // Scene loading
  const [loadProgress, setLoadProgress] = useState(0);
  const [isLoading,    setIsLoading]    = useState(true);
  const [error,        setError]        = useState(null);

  // Lasso & ROI
  const [lassoActive, setLassoActive] = useState(false);
  const [roi,         setRoi]         = useState(null);
  const [computing,   setComputing]   = useState(false);
  const [selectionScale, setSelectionScale] = useState(1);
  const [selectionCenter, setSelectionCenter] = useState(null);
  const [faceOverrides, setFaceOverrides] = useState({
    minX: null, maxX: null, minY: null, maxY: null, minZ: null, maxZ: null,
  });

  // NL command pipeline
  const [commandPending, setCommandPending] = useState(false);
  const [lastAction,     setLastAction]     = useState(null);

  // Delete pipeline
  const [deleting, setDeleting] = useState(false);

  // ── Lasso toggle ─────────────────────────────────────────────────────────
  const handleLassoToggle = useCallback(() => {
    setLassoActive((prev) => {
      const next = !prev;
      controlsRef.current?.setEnabled(!next);
      return next;
    });
  }, []);

  // ── Global shortcut: Cmd+Shift+P ─────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        handleLassoToggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleLassoToggle]);

  // ── Lasso complete → compute ROI ─────────────────────────────────────────
  const handleLassoComplete = useCallback((polygon) => {
    setLassoActive(false);
    controlsRef.current?.setEnabled(true);

    const viewer = viewerRef.current;
    if (!viewer?.splatMesh) return;

    setComputing(true);
    setTimeout(() => {
      const result = computeRoi(
        viewer.splatMesh, viewer.camera, polygon,
        window.innerWidth, window.innerHeight,
      );
      setRoi(result);
      setSelectionCenter(result ? { ...result.worldCenter } : null);
      setComputing(false);
      onRoiChange?.(result);
    }, 0);
  }, [onRoiChange]);

  // ── Cancel lasso ─────────────────────────────────────────────────────────
  const handleLassoCancel = useCallback(() => {
    setLassoActive(false);
    controlsRef.current?.setEnabled(true);
  }, []);

  // ── Clear ROI ─────────────────────────────────────────────────────────────
  const handleClearRoi = useCallback(() => {
    setRoi(null);
    setSelectionScale(1);
    setSelectionCenter(null);
    setFaceOverrides({ minX: null, maxX: null, minY: null, maxY: null, minZ: null, maxZ: null });
    setLastAction(null);
    onRoiChange?.(null);
  }, [onRoiChange]);

  // ── Delete all splats inside the selection cube ───────────────────────────
  const handleDelete = useCallback(async () => {
    if (!roi || !file || deleting) return;

    const scaled = scaleBounds(roi.bounds, roi.worldCenter, selectionScale);
    const delta = selectionCenter
      ? { x: selectionCenter.x - roi.worldCenter.x, y: selectionCenter.y - roi.worldCenter.y, z: selectionCenter.z - roi.worldCenter.z }
      : { x: 0, y: 0, z: 0 };
    const baseBounds = translateBounds(scaled, delta);
    const boundsToUse = mergeFaceOverrides(baseBounds, faceOverrides);

    const cam = viewerRef.current?.camera;
    const cameraState = cam
      ? {
          position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
          rotation: { x: cam.rotation.x, y: cam.rotation.y, z: cam.rotation.z },
          rotationOrder: cam.rotation.order || 'YXZ',
        }
      : null;

    setDeleting(true);
    try {
      const { blob, deletedCount } = await buildFilteredPly(file, boundsToUse);
      console.log(`[WorldEdit] Removed ${deletedCount.toLocaleString()} splats`);
      const newFile = new File([blob], fileName, { type: 'application/octet-stream' });
      setRoi(null);
      setSelectionScale(1);
      setSelectionCenter(null);
      setFaceOverrides({ minX: null, maxX: null, minY: null, maxY: null, minZ: null, maxZ: null });
      setLastAction(null);
      onSceneUpdate?.(blob, newFile, cameraState);
    } catch (err) {
      console.error('[WorldEdit] Delete error:', err);
    } finally {
      setDeleting(false);
    }
  }, [roi, selectionScale, selectionCenter, faceOverrides, file, fileName, deleting, onSceneUpdate]);

  const handleFaceDrag = useCallback((face, value) => {
    setFaceOverrides((prev) => ({ ...prev, [face]: value }));
  }, []);

  // ── Freeze / restore controls when the command bar is focused ─────────────
  const handleCommandFocus = useCallback(() => {
    controlsRef.current?.setEnabled(false);
  }, []);

  const handleCommandBlur = useCallback(() => {
    // Only re-enable if lasso mode is not active
    setLassoActive((prev) => {
      if (!prev) controlsRef.current?.setEnabled(true);
      return prev;
    });
  }, []);

  // ── NL command → intent parse (no auto-dispatch) ─────────────────────────
  //
  // The parsed action JSON is shown in the HUD so the user can review it.
  // Execution of any effect is triggered explicitly by the user in a future
  // step — nothing runs automatically here.
  const handleCommand = useCallback(async (text) => {
    if (!roi || !text.trim()) return;

    setCommandPending(true);
    setLastAction(null);

    try {
      const action = await parseIntent(text, roi);
      setLastAction(action);

      // Deselect is the one side-effect that is safe to apply immediately.
      if (action.action === 'deselect') handleClearRoi();

    } catch (err) {
      console.error('[WorldEdit] Intent parse error:', err);
      setLastAction({ action: 'error', raw: text, error: err?.message });
    } finally {
      setCommandPending(false);
    }
  }, [roi, handleClearRoi]);

  // ── Viewer lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!splatUrl || !rootRef.current) return;

    let cancelled = false;
    setIsLoading(true);
    setLoadProgress(0);
    setError(null);
    setLassoActive(false);
    setRoi(null);
    setLastAction(null);

    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:grab;';
    rootRef.current.appendChild(host);

    const viewer = new GaussianSplats3D.Viewer({
      rootElement:        host,
      selfDrivenMode:     true,
      useBuiltInControls: false,
      gpuAcceleratedSort: false,
      antialiased:        true,
      sceneRevealMode:    GaussianSplats3D.SceneRevealMode?.Instant ?? 2,
    });

    viewerRef.current = viewer;
    viewer.start();

    const controls = startControls(viewer, host);
    controlsRef.current = controls;

    viewer
      .addSplatScene(splatUrl, {
        format:          sceneFormatFromFileName(fileName),
        progressiveLoad: true,
        showLoadingUI:   false,
        onProgress: (pct) => {
          if (!cancelled) setLoadProgress(Math.min(100, Math.round(pct)));
        },
      })
      .then(() => {
        if (cancelled) return;
        setIsLoading(false);
        if (initialCameraState) {
          const cam = viewer.camera;
          if (cam) {
            cam.position.x = initialCameraState.position.x;
            cam.position.y = initialCameraState.position.y;
            cam.position.z = initialCameraState.position.z;
            cam.rotation.x = initialCameraState.rotation.x;
            cam.rotation.y = initialCameraState.rotation.y;
            cam.rotation.z = initialCameraState.rotation.z;
            cam.rotation.order = initialCameraState.rotationOrder || 'YXZ';
            cam.updateMatrixWorld(true);
          }
          onCameraRestored?.();
        }
        viewer.forceRenderNextFrame?.();
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[WorldEdit] Failed to load splat:', err);
        setError(err?.message ?? 'Failed to load scene. Check the file format and try again.');
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      viewerRef.current   = null;
      controlsRef.current = null;
      controls.stop();
      try {
        document.body.appendChild(host);
        viewer.stop?.();
        viewer.dispose();
      } catch {
        host.parentNode?.removeChild(host);
      }
    };
  }, [splatUrl]);

  return (
    <div ref={rootRef} style={styles.root}>
      {/* 3-D bounding box (RAF-driven, pointer-events: none) */}
      <SceneOverlay
        roi={roi}
        displayBounds={
          roi
            ? (() => {
                const scaled = scaleBounds(roi.bounds, roi.worldCenter, selectionScale);
                const delta = selectionCenter
                  ? {
                      x: selectionCenter.x - roi.worldCenter.x,
                      y: selectionCenter.y - roi.worldCenter.y,
                      z: selectionCenter.z - roi.worldCenter.z,
                    }
                  : { x: 0, y: 0, z: 0 };
                const base = translateBounds(scaled, delta);
                return mergeFaceOverrides(base, faceOverrides);
              })()
            : null
        }
        displayCenter={selectionCenter ?? roi?.worldCenter}
        viewerRef={viewerRef}
        selectionScale={selectionScale}
        onSelectionScaleChange={setSelectionScale}
        onSelectionCenterChange={setSelectionCenter}
        onFaceDrag={handleFaceDrag}
      />

      {/* Lasso drawing overlay (pointer-events: all when active) */}
      <LassoOverlay
        active={lassoActive}
        roi={roi}
        onComplete={handleLassoComplete}
        onCancel={handleLassoCancel}
      />

      {/* HUD — all UI chrome */}
      <Hud
        fileName={fileName}
        isLoading={isLoading}
        loadProgress={loadProgress}
        error={error}
        onReset={onReset}
        lassoActive={lassoActive}
        onLassoToggle={handleLassoToggle}
        roi={roi}
        computing={computing}
        onClearRoi={handleClearRoi}
        onCommand={handleCommand}
        commandPending={commandPending}
        lastAction={lastAction}
        onCommandFocus={handleCommandFocus}
        onCommandBlur={handleCommandBlur}
        onDelete={handleDelete}
        deleting={deleting}
        canDelete={canDeleteInFormat(fileName)}
      />
    </div>
  );
}

const styles = {
  root: { position: 'fixed', inset: 0, background: '#000' },
};
