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
  const [scene, setScene] = useState(null); // { url, fileName }

  const handleFile = useCallback(
    (file) => {
      if (scene?.url) URL.revokeObjectURL(scene.url);
      setScene({ url: URL.createObjectURL(file), fileName: file.name });
    },
    [scene],
  );

  const handleReset = useCallback(() => {
    if (scene?.url) URL.revokeObjectURL(scene.url);
    setScene(null);
  }, [scene]);

  if (!scene) return <UploadScreen onFile={handleFile} />;

  return (
    <GaussianViewer
      key={scene.url}
      splatUrl={scene.url}
      fileName={scene.fileName}
      onReset={handleReset}
    />
  );
}
