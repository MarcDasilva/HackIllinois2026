'use client';

import { useState } from 'react';

const CONTROLS = [
  { icon: '⇥',   action: 'Drag to look around',   kbd: false },
  { icon: '⊞',   action: 'Scroll to zoom',         kbd: false },
  { icon: 'W/S', action: 'Fly forward / back',     kbd: true  },
  { icon: 'A/D', action: 'Fly left / right',       kbd: true  },
  { icon: 'E/Q', action: 'Fly up / down',          kbd: true  },
  { icon: '⇧',   action: '4× speed boost',         kbd: true  },
];

export default function Hud({ fileName, isLoading, loadProgress, error, onReset }) {
  const [controlsOpen, setControlsOpen] = useState(false);

  return (
    <>
      {/* ── Top-left: logo + scene name ── */}
      <div style={styles.topLeft}>
        <div style={styles.logoMark}>
          <svg width="18" height="18" viewBox="0 0 28 28" fill="none">
            <rect x="2" y="2" width="11" height="11" rx="2" fill="#818cf8" />
            <rect x="15" y="2" width="11" height="11" rx="2" fill="#818cf8" opacity="0.5" />
            <rect x="2" y="15" width="11" height="11" rx="2" fill="#818cf8" opacity="0.5" />
            <rect x="15" y="15" width="11" height="11" rx="2" fill="#818cf8" />
          </svg>
          <span style={styles.logoText}>WorldEdit</span>
        </div>
        {fileName && (
          <span style={styles.sceneLabel} title={fileName}>
            {truncate(fileName, 32)}
          </span>
        )}
      </div>

      {/* ── Top-right: controls toggle + new scene button ── */}
      <div style={styles.topRight}>
        <button
          style={styles.iconBtn}
          title="Load new scene"
          onClick={onReset}
        >
          <FolderIcon />
          <span style={styles.btnLabel}>New scene</span>
        </button>

        <button
          style={{ ...styles.iconBtn, ...(controlsOpen ? styles.iconBtnActive : {}) }}
          title="Controls"
          onClick={() => setControlsOpen((v) => !v)}
        >
          <KeyboardIcon />
          <span style={styles.btnLabel}>Controls</span>
        </button>

        {controlsOpen && (
          <div style={styles.controlsPanel}>
            <p style={styles.controlsTitle}>Navigation</p>
            {CONTROLS.map((c) => (
              <div key={c.label} style={styles.controlRow}>
                <span style={c.kbd ? styles.kbdBadge : styles.mouseBadge}>{c.icon}</span>
                <span style={styles.controlAction}>{c.action}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Bottom: loading bar ── */}
      {isLoading && !error && (
        <div style={styles.loadingBar}>
          <div style={styles.loadingInner}>
            <div style={styles.loadingTextRow}>
              <span style={styles.loadingLabel}>Loading Gaussian splats…</span>
              <span style={styles.loadingPct}>{loadProgress}%</span>
            </div>
            <div style={styles.progressTrack}>
              <div
                style={{
                  ...styles.progressFill,
                  width: `${loadProgress}%`,
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Error overlay ── */}
      {error && (
        <div style={styles.errorOverlay}>
          <div style={styles.errorCard}>
            <p style={styles.errorTitle}>Failed to load scene</p>
            <p style={styles.errorBody}>{error}</p>
            <button style={styles.retryBtn} onClick={onReset}>
              Load a different file
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function truncate(str, max) {
  return str.length > max ? '…' + str.slice(-(max - 1)) : str;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3.293a1 1 0 0 1 .707.293L7.207 4.5H13.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="3.5" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4 7h1M7 7h1M10 7h1M4 10h8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

const styles = {
  topLeft: {
    position: 'fixed',
    top: 16,
    left: 16,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    pointerEvents: 'none',
  },

  logoMark: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    background: 'rgba(6,6,9,0.75)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 10,
    padding: '6px 12px',
    backdropFilter: 'blur(12px)',
  },

  logoText: {
    fontSize: 14,
    fontWeight: 600,
    color: '#f4f4f5',
    letterSpacing: '-0.01em',
  },

  sceneLabel: {
    fontSize: 12,
    color: '#71717a',
    background: 'rgba(6,6,9,0.75)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 8,
    padding: '5px 10px',
    backdropFilter: 'blur(12px)',
    maxWidth: 260,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  topRight: {
    position: 'fixed',
    top: 16,
    right: 16,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 8,
  },

  btnRow: {
    display: 'flex',
    gap: 8,
  },

  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: 'rgba(6,6,9,0.8)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 8,
    color: '#a1a1aa',
    fontSize: 12,
    fontWeight: 500,
    padding: '6px 12px',
    backdropFilter: 'blur(12px)',
    transition: 'color 0.15s, border-color 0.15s',
    cursor: 'pointer',
  },

  iconBtnActive: {
    color: '#818cf8',
    borderColor: 'rgba(129,140,248,0.3)',
    background: 'rgba(129,140,248,0.08)',
  },

  btnLabel: {
    lineHeight: 1,
  },

  controlsPanel: {
    background: 'rgba(10,10,16,0.92)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 12,
    padding: '14px 16px',
    backdropFilter: 'blur(16px)',
    minWidth: 220,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  controlsTitle: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    color: '#52525b',
    textTransform: 'uppercase',
    marginBottom: 4,
  },

  controlRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },

  mouseBadge: {
    width: 28,
    height: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 5,
    fontSize: 13,
    color: '#818cf8',
    flexShrink: 0,
  },

  kbdBadge: {
    width: 28,
    height: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(129,140,248,0.1)',
    border: '1px solid rgba(129,140,248,0.2)',
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 600,
    color: '#818cf8',
    flexShrink: 0,
  },

  controlAction: {
    fontSize: 13,
    color: '#a1a1aa',
  },

  loadingBar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    padding: '0 24px 20px',
    pointerEvents: 'none',
  },

  loadingInner: {
    background: 'rgba(10,10,16,0.88)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 12,
    padding: '12px 16px',
    backdropFilter: 'blur(16px)',
    maxWidth: 480,
    margin: '0 auto',
  },

  loadingTextRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },

  loadingLabel: {
    fontSize: 13,
    color: '#a1a1aa',
  },

  loadingPct: {
    fontSize: 13,
    fontWeight: 600,
    color: '#818cf8',
    fontVariantNumeric: 'tabular-nums',
  },

  progressTrack: {
    height: 4,
    background: 'rgba(255,255,255,0.06)',
    borderRadius: 2,
    overflow: 'hidden',
  },

  progressFill: {
    height: '100%',
    background: 'linear-gradient(90deg, #6366f1, #818cf8)',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  },

  errorOverlay: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.6)',
    backdropFilter: 'blur(4px)',
  },

  errorCard: {
    background: 'rgba(14,14,22,0.96)',
    border: '1px solid rgba(248,113,113,0.2)',
    borderRadius: 16,
    padding: '32px 36px',
    maxWidth: 420,
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    alignItems: 'center',
  },

  errorTitle: {
    fontSize: 17,
    fontWeight: 600,
    color: '#f87171',
  },

  errorBody: {
    fontSize: 13,
    color: '#71717a',
    lineHeight: 1.6,
  },

  retryBtn: {
    marginTop: 8,
    background: 'rgba(129,140,248,0.1)',
    border: '1px solid rgba(129,140,248,0.25)',
    borderRadius: 8,
    color: '#818cf8',
    fontSize: 13,
    fontWeight: 500,
    padding: '9px 20px',
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
};
