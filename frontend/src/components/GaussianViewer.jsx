'use client';

import { useEffect, useRef, useState } from 'react';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import Hud from './Hud.jsx';

// Blob URLs carry no extension — derive SceneFormat from the original filename.
function sceneFormatFromFileName(name) {
  const { SceneFormat } = GaussianSplats3D;
  const lower = (name ?? '').toLowerCase();
  if (lower.endsWith('.ksplat')) return SceneFormat.KSplat;
  if (lower.endsWith('.splat')) return SceneFormat.Splat;
  if (lower.endsWith('.spz'))   return SceneFormat.Spz;
  return SceneFormat.Ply;
}

// ─── Controls (look + fly + scroll-zoom) ─────────────────────────────────────
//
// Mouse drag  → yaw / pitch (camera stays in place, only direction changes)
// WASD / arrows → fly forward / back / strafe
// E / Space   → fly up
// Q / Ctrl    → fly down
// Shift       → 4× speed
// Scroll      → dolly forward / back
//
// All math uses plain numbers from matrixWorld.elements and camera.rotation
// (Euler x/y) — no THREE.Vector3 import, no dual-bundle version conflicts.

const LOOK_SENS   = 0.003;   // radians per pixel
const BASE_SPEED  = 0.06;    // units per frame @ 60 fps
const SHIFT_MULT  = 4;
const SCROLL_SPEED = 0.4;    // units per scroll delta-pixel

function startControls(viewer, domElement) {
  const keys = new Set();
  let dragging = false;
  let lastX = 0, lastY = 0;

  // ── Look (mouse drag) ──────────────────────────────────────────────────────
  const onPointerDown = (e) => {
    if (e.button !== 0) return; // left button only
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    domElement.style.cursor = 'grabbing';
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    const cam = viewer.camera;
    if (!cam) return;

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    // YXZ Euler order: yaw around world Y first, then pitch around local X.
    // camera.rotation.x / .y are plain numbers — safe to mutate directly.
    cam.rotation.order = 'YXZ';
    cam.rotation.y -= dx * LOOK_SENS;
    cam.rotation.x -= dy * LOOK_SENS;
    // Clamp pitch so the camera can't flip upside-down
    cam.rotation.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, cam.rotation.x));
    cam.updateMatrixWorld(true);
    viewer.forceRenderNextFrame?.();
  };

  const onPointerUp = () => {
    dragging = false;
    domElement.style.cursor = '';
  };

  // ── Scroll-to-zoom (dolly along look direction) ───────────────────────────
  const onWheel = (e) => {
    e.preventDefault();
    const cam = viewer.camera;
    if (!cam) return;
    const m = cam.matrixWorld.elements;
    const s = e.deltaY * 0.01 * SCROLL_SPEED;
    cam.position.x += -m[8] * -s;
    cam.position.y += -m[9] * -s;
    cam.position.z += -m[10] * -s;
    cam.updateMatrixWorld(true);
    viewer.forceRenderNextFrame?.();
  };

  domElement.addEventListener('pointerdown', onPointerDown);
  domElement.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  // ── WASD fly ───────────────────────────────────────────────────────────────
  const onKeyDown = (e) => {
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
    keys.add(e.code);
  };
  const onKeyUp = (e) => keys.delete(e.code);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup',   onKeyUp);

  let rafId;
  const tick = () => {
    rafId = requestAnimationFrame(tick);
    if (!keys.size) return;

    const cam = viewer.camera;
    if (!cam) return;

    // Read axes from (already-updated) world matrix
    const m  = cam.matrixWorld.elements;
    const rx = m[0],  ry = m[1],  rz = m[2];    // right
    const fx = -m[8], fy = -m[9], fz = -m[10];  // forward

    const speed =
      (keys.has('ShiftLeft') || keys.has('ShiftRight') ? SHIFT_MULT : 1) * BASE_SPEED;

    let dx = 0, dy = 0, dz = 0;

    if (keys.has('KeyW') || keys.has('ArrowUp'))                               { dx += fx * speed; dy += fy * speed; dz += fz * speed; }
    if (keys.has('KeyS') || keys.has('ArrowDown'))                             { dx -= fx * speed; dy -= fy * speed; dz -= fz * speed; }
    if (keys.has('KeyA') || keys.has('ArrowLeft'))                             { dx -= rx * speed; dy -= ry * speed; dz -= rz * speed; }
    if (keys.has('KeyD') || keys.has('ArrowRight'))                            { dx += rx * speed; dy += ry * speed; dz += rz * speed; }
    if (keys.has('KeyE') || keys.has('Space'))                                 { dy += speed; }
    if (keys.has('KeyQ') || keys.has('ControlLeft') || keys.has('ControlRight')) { dy -= speed; }

    if (dx === 0 && dy === 0 && dz === 0) return;

    cam.position.x += dx; cam.position.y += dy; cam.position.z += dz;
    cam.updateMatrixWorld(true);
    viewer.forceRenderNextFrame?.();
  };

  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    domElement.removeEventListener('pointerdown', onPointerDown);
    domElement.removeEventListener('wheel', onWheel);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup',   onKeyUp);
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GaussianViewer({ splatUrl, fileName, onReset }) {
  // rootRef is a React-owned div that holds only what React rendered (the HUD).
  // The viewer canvas is injected into an *imperative* host div that React never
  // renders into, so React's reconciliation never encounters unexpected children
  // and the "removeChild: node is not a child" error cannot occur.
  const rootRef  = useRef(null);
  const viewerRef = useRef(null);

  const [loadProgress, setLoadProgress] = useState(0);
  const [isLoading,    setIsLoading]    = useState(true);
  const [error,        setError]        = useState(null);

  useEffect(() => {
    if (!splatUrl || !rootRef.current) return;

    let cancelled = false;
    setIsLoading(true);
    setLoadProgress(0);
    setError(null);

    // Create an imperative host node that React never owns.
    // GaussianSplats3D will inject its canvas here; we remove it ourselves on cleanup.
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:grab;';
    rootRef.current.appendChild(host);

    const viewer = new GaussianSplats3D.Viewer({
      rootElement:        host,
      selfDrivenMode:     true,
      useBuiltInControls: false,  // all input handled by startControls()
      gpuAcceleratedSort: false,
      antialiased:        true,
      sceneRevealMode:    GaussianSplats3D.SceneRevealMode?.Instant ?? 2,
    });

    viewerRef.current = viewer;
    viewer.start();

    // Attach look + fly + scroll controls to the host element
    const stopControls = startControls(viewer, host);

    viewer
      .addSplatScene(splatUrl, {
        format:          sceneFormatFromFileName(fileName),
        progressiveLoad: true,
        showLoadingUI:   false,
        onProgress: (percent) => {
          if (!cancelled) setLoadProgress(Math.min(100, Math.round(percent)));
        },
      })
      .then(() => {
        if (cancelled) return;
        setIsLoading(false);
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
      viewerRef.current = null;
      stopControls();

      // GaussianSplats3D's dispose() calls document.body.removeChild(rootElement)
      // when usingExternalRenderer is false (i.e. we only provided rootElement,
      // not a renderer). Our host lives inside rootRef, not body, so we move it
      // to body first — letting the library clean up exactly as it intends.
      try {
        document.body.appendChild(host); // moves node; host is now a body child
        viewer.stop?.();
        viewer.dispose();               // removes canvas from host, host from body ✓
      } catch {
        host.parentNode?.removeChild(host); // fallback if dispose throws mid-way
      }
    };
  }, [splatUrl]);

  // React renders only the root wrapper + HUD here — no canvas div.
  // The viewer host is appended imperatively above.
  return (
    <div ref={rootRef} style={styles.root}>
      <Hud
        fileName={fileName}
        isLoading={isLoading}
        loadProgress={loadProgress}
        error={error}
        onReset={onReset}
      />
    </div>
  );
}

const styles = {
  root: {
    position: 'fixed',
    inset: 0,
    background: '#000',
  },
};
