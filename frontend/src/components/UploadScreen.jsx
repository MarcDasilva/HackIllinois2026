'use client';

import { useState, useRef, useCallback } from 'react';

const ACCEPTED = ['.ply', '.splat', '.ksplat'];

function isValidFile(file) {
  const name = file.name.toLowerCase();
  return ACCEPTED.some((ext) => name.endsWith(ext));
}

export default function UploadScreen({ onFile }) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (!isValidFile(file)) {
        setError(`Unsupported format. Please use a .ply, .splat, or .ksplat file.`);
        return;
      }
      setError(null);
      onFile(file);
    },
    [onFile],
  );

  const handleFileInput = useCallback(
    (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!isValidFile(file)) {
        setError(`Unsupported format. Please use a .ply, .splat, or .ksplat file.`);
        return;
      }
      setError(null);
      onFile(file);
    },
    [onFile],
  );

  return (
    <div style={styles.root}>
      {/* Ambient background blobs */}
      <div style={styles.blobA} />
      <div style={styles.blobB} />

      <div style={styles.card}>
        {/* Logo / wordmark */}
        <div style={styles.logoRow}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect x="2" y="2" width="11" height="11" rx="2" fill="#818cf8" />
            <rect x="15" y="2" width="11" height="11" rx="2" fill="#818cf8" opacity="0.5" />
            <rect x="2" y="15" width="11" height="11" rx="2" fill="#818cf8" opacity="0.5" />
            <rect x="15" y="15" width="11" height="11" rx="2" fill="#818cf8" />
          </svg>
          <span style={styles.wordmark}>WorldEdit</span>
        </div>

        <p style={styles.tagline}>AI-Powered 3D Scene Editor</p>

        {/* Drop zone */}
        <div
          style={{
            ...styles.dropZone,
            ...(isDragging ? styles.dropZoneActive : {}),
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".ply,.splat,.ksplat"
            onChange={handleFileInput}
          />

          <div style={styles.uploadIcon}>
            <svg
              width="40"
              height="40"
              viewBox="0 0 40 40"
              fill="none"
              style={{ opacity: isDragging ? 1 : 0.6, transition: 'opacity 0.2s' }}
            >
              <circle cx="20" cy="20" r="19" stroke="#818cf8" strokeWidth="1.5" />
              <path
                d="M20 27V13M20 13L14 19M20 13L26 19"
                stroke="#818cf8"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <p style={styles.dropTitle}>
            {isDragging ? 'Release to load scene' : 'Drop your Gaussian Splat here'}
          </p>
          <p style={styles.dropSubtitle}>or click to browse files</p>

          <div style={styles.formatRow}>
            {ACCEPTED.map((fmt) => (
              <span key={fmt} style={styles.formatBadge}>
                {fmt.replace('.', '').toUpperCase()}
              </span>
            ))}
          </div>
        </div>

        {error && <p style={styles.errorMsg}>{error}</p>}

        <p style={styles.hint}>
          Supports World Labs Gaussian Splat PLY exports · Files up to 1 GB+
        </p>
      </div>
    </div>
  );
}

const styles = {
  root: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#060609',
    overflow: 'hidden',
  },

  blobA: {
    position: 'absolute',
    width: 600,
    height: 600,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)',
    top: -120,
    left: -120,
    pointerEvents: 'none',
  },

  blobB: {
    position: 'absolute',
    width: 500,
    height: 500,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(139,92,246,0.1) 0%, transparent 70%)',
    bottom: -100,
    right: -80,
    pointerEvents: 'none',
  },

  card: {
    position: 'relative',
    width: '100%',
    maxWidth: 520,
    padding: '40px 44px 36px',
    background: 'rgba(14, 14, 22, 0.9)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 20,
    backdropFilter: 'blur(20px)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 20,
  },

  logoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },

  wordmark: {
    fontSize: 22,
    fontWeight: 600,
    letterSpacing: '-0.02em',
    color: '#f4f4f5',
  },

  tagline: {
    fontSize: 13,
    color: '#71717a',
    letterSpacing: '0.02em',
    marginTop: -8,
  },

  dropZone: {
    width: '100%',
    borderRadius: 14,
    border: '1.5px dashed rgba(129,140,248,0.3)',
    background: 'rgba(129,140,248,0.03)',
    padding: '36px 24px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 10,
    cursor: 'pointer',
    transition: 'border-color 0.2s, background 0.2s',
    userSelect: 'none',
  },

  dropZoneActive: {
    borderColor: 'rgba(129,140,248,0.7)',
    background: 'rgba(129,140,248,0.08)',
  },

  uploadIcon: {
    marginBottom: 4,
  },

  dropTitle: {
    fontSize: 15,
    fontWeight: 500,
    color: '#d4d4d8',
  },

  dropSubtitle: {
    fontSize: 13,
    color: '#52525b',
  },

  formatRow: {
    display: 'flex',
    gap: 6,
    marginTop: 8,
  },

  formatBadge: {
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.05em',
    color: '#818cf8',
    background: 'rgba(129,140,248,0.1)',
    border: '1px solid rgba(129,140,248,0.2)',
    borderRadius: 6,
    padding: '3px 8px',
  },

  errorMsg: {
    fontSize: 13,
    color: '#f87171',
    background: 'rgba(248,113,113,0.08)',
    border: '1px solid rgba(248,113,113,0.2)',
    borderRadius: 8,
    padding: '8px 14px',
    width: '100%',
    textAlign: 'center',
  },

  hint: {
    fontSize: 12,
    color: '#3f3f46',
    textAlign: 'center',
    lineHeight: 1.6,
  },
};
