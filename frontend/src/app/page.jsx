'use client';

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import UploadScreen from '@/components/UploadScreen';

// GaussianSplats3D touches WebGL/Workers/window at import time — must be client-only.
const GaussianViewer = dynamic(() => import('@/components/GaussianViewer'), {
  ssr: false,
  loading: () => <div style={{ position: 'fixed', inset: 0, background: '#000' }} />,
});

export default function Page() {
  // scene: { url, fileName, file }
  // `file` is the current File/Blob so the delete pipeline can read raw bytes.
  // After each deletion a new File is stored so future deletions layer correctly.
  const [scene, setScene] = useState(null);
  const [roi,   setRoi]   = useState(null);

  const handleFile = useCallback(
    (file) => {
      if (scene?.url) URL.revokeObjectURL(scene.url);
      setRoi(null);
      setScene({ url: URL.createObjectURL(file), fileName: file.name, file });
    },
    [scene],
  );

  const handleReset = useCallback(() => {
    if (scene?.url) URL.revokeObjectURL(scene.url);
    setRoi(null);
    setScene(null);
  }, [scene]);

  // Called by GaussianViewer after a delete operation.
  // blob     = filtered PLY Blob (splats inside the cube have opacity = 0)
  // newFile  = same data wrapped as a File for subsequent delete operations
  // cameraState = optional { position, rotation, rotationOrder } to restore view after load
  const handleSceneUpdate = useCallback(
    (blob, newFile, cameraState) => {
      if (scene?.url) URL.revokeObjectURL(scene.url);
      const newUrl = URL.createObjectURL(blob);
      setRoi(null);
      setScene({ url: newUrl, fileName: scene.fileName, file: newFile, cameraState: cameraState ?? null });
    },
    [scene],
  );

  const handleCameraRestored = useCallback(() => {
    setScene((prev) => (prev ? { ...prev, cameraState: null } : null));
  }, []);

  if (!scene) return <UploadScreen onFile={handleFile} />;

  return (
    <GaussianViewer
      key={scene.url}
      splatUrl={scene.url}
      fileName={scene.fileName}
      file={scene.file}
      onReset={handleReset}
      onRoiChange={setRoi}
      onSceneUpdate={handleSceneUpdate}
      initialCameraState={scene.cameraState ?? undefined}
      onCameraRestored={handleCameraRestored}
    />
  );
}
