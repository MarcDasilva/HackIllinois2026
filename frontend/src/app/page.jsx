'use client';

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import UploadScreen from '@/components/UploadScreen';

// GaussianSplats3D touches WebGL/Workers/window at import time — must be client-only.
const GaussianViewer = dynamic(() => import('@/components/GaussianViewer'), {
  ssr: false,
  loading: () => <div style={{ position: 'fixed', inset: 0, background: '#000' }} />,
});

/**
 * Parse a raw SSE chunk (possibly containing multiple messages) into
 * an array of { event, data } objects.
 */
function parseSseChunk(chunk) {
  const messages = [];
  // Split on double-newline boundaries
  const blocks = chunk.split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = 'message';
    let dataStr = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!dataStr) continue;
    try {
      messages.push({ event, data: JSON.parse(dataStr) });
    } catch {
      // ignore malformed chunks
    }
  }
  return messages;
}

export default function Page() {
  const [scene, setScene] = useState(null);         // { url, fileName }
  const [genEvents, setGenEvents] = useState([]);   // accumulated SSE events
  const [isGenerating, setIsGenerating] = useState(false);
  // world_context extracted from the splat file name (or a static placeholder
  // until the pipeline sends its own context format).
  const [worldContext] = useState({
    world_id: 'scene_01',
    description: 'User-uploaded Gaussian splat scene',
    surfaces: [],
    occupied_regions: [],
  });

  const handleFile = useCallback(
    (file) => {
      if (scene?.url) URL.revokeObjectURL(scene.url);
      setScene({ url: URL.createObjectURL(file), fileName: file.name });
      setGenEvents([]);
    },
    [scene],
  );

  const handleReset = useCallback(() => {
    if (scene?.url) URL.revokeObjectURL(scene.url);
    setScene(null);
    setGenEvents([]);
    setIsGenerating(false);
  }, [scene]);

  const handlePrompt = useCallback(async (prompt) => {
    if (isGenerating) return;
    setIsGenerating(true);
    setGenEvents([]);

    let response;
    try {
      response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          world_context: worldContext,
          user_prompt: prompt,
          num_candidates: 2,
          base_seed: 42,
        }),
      });
    } catch (err) {
      setGenEvents([{
        event: 'error',
        data: { message: `Network error: ${err.message}` },
      }]);
      setIsGenerating(false);
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      setGenEvents([{
        event: 'error',
        data: { message: `Server error ${response.status}: ${text}` },
      }]);
      setIsGenerating(false);
      return;
    }

    // Read the SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages (delimited by \n\n)
        const boundary = buffer.lastIndexOf('\n\n');
        if (boundary === -1) continue;

        const complete = buffer.slice(0, boundary + 2);
        buffer = buffer.slice(boundary + 2);

        const newEvents = parseSseChunk(complete);
        if (newEvents.length === 0) continue;

        setGenEvents((prev) => {
          const next = [...prev, ...newEvents];
          // Stop streaming once we receive done or error
          const last = next[next.length - 1];
          if (last.event === 'done' || last.event === 'error') {
            setIsGenerating(false);
          }
          return next;
        });
      }
    } catch (err) {
      setGenEvents((prev) => [
        ...prev,
        { event: 'error', data: { message: `Stream interrupted: ${err.message}` } },
      ]);
      setIsGenerating(false);
    }
  }, [isGenerating, worldContext]);

  const handleDismissGen = useCallback(() => {
    setGenEvents([]);
  }, []);

  if (!scene) return <UploadScreen onFile={handleFile} />;

  return (
    <GaussianViewer
      key={scene.url}
      splatUrl={scene.url}
      fileName={scene.fileName}
      onReset={handleReset}
      onPrompt={handlePrompt}
      genEvents={genEvents}
      onDismissGen={handleDismissGen}
    />
  );
}
