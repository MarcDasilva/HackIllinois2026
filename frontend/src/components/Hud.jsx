'use client';

import { useState, useRef } from 'react';

const CONTROLS = [
  { icon: '⇥',   action: 'Drag to look around',   kbd: false },
  { icon: '⊞',   action: 'Scroll to zoom',         kbd: false },
  { icon: 'W/S', action: 'Fly forward / back',     kbd: true  },
  { icon: 'A/D', action: 'Fly left / right',       kbd: true  },
  { icon: 'E/Q', action: 'Fly up / down',          kbd: true  },
  { icon: '⇧',   action: '4× speed boost',         kbd: true  },
];

export default function Hud({
  fileName, isLoading, loadProgress, error, onReset,
  lassoActive, onLassoToggle,
  roi, computing, onClearRoi,
  onCommand, commandPending, lastAction,
  onCommandFocus, onCommandBlur,
  onDelete, deleting, canDelete,
}) {
  const [controlsOpen, setControlsOpen] = useState(false);
  const [cmdText,      setCmdText]      = useState('');
  const textareaRef = useRef(null);

  const submitCommand = () => {
    const text = cmdText.trim();
    if (!text || commandPending) return;
    onCommand?.(text);
    setCmdText('');
  };

  const onTextKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitCommand();
    }
  };

  return (
    <>
      {/* ── Top-left: logo + scene name ── */}
      <div style={styles.topLeft}>
        <div style={styles.logoMark}>
          <svg width="18" height="18" viewBox="0 0 28 28" fill="none">
            <rect x="2"  y="2"  width="11" height="11" rx="2" fill="#818cf8" />
            <rect x="15" y="2"  width="11" height="11" rx="2" fill="#818cf8" opacity="0.5" />
            <rect x="2"  y="15" width="11" height="11" rx="2" fill="#818cf8" opacity="0.5" />
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

      {/* ── Top-right: toolbar ── */}
      <div style={styles.topRight}>
        <button style={styles.iconBtn} title="Load new scene" onClick={onReset}>
          <FolderIcon />
          <span style={styles.btnLabel}>New scene</span>
        </button>

        <button
          style={{ ...styles.iconBtn, ...(lassoActive ? styles.iconBtnActive : {}) }}
          title={lassoActive ? 'Cancel selection (Esc)' : 'Box select (⌘⇧P)'}
          onClick={onLassoToggle}
          disabled={isLoading}
        >
          <BoxSelectIcon />
          <span style={styles.btnLabel}>{lassoActive ? 'Cancel' : 'Select'}</span>
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
              <div key={c.action} style={styles.controlRow}>
                <span style={c.kbd ? styles.kbdBadge : styles.mouseBadge}>{c.icon}</span>
                <span style={styles.controlAction}>{c.action}</span>
              </div>
            ))}
            <p style={{ ...styles.controlsTitle, marginTop: 10 }}>Box Select</p>
            <div style={styles.controlRow}>
              <span style={styles.kbdBadge}>⌘⇧P</span>
              <span style={styles.controlAction}>Toggle box select</span>
            </div>
            <div style={styles.controlRow}>
              <span style={styles.mouseBadge}>⇥</span>
              <span style={styles.controlAction}>Drag to draw cube</span>
            </div>
            <div style={styles.controlRow}>
              <span style={styles.kbdBadge}>Esc</span>
              <span style={styles.controlAction}>Cancel selection</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Lasso active banner ── */}
      {lassoActive && (
        <div style={styles.lassoBanner}>
          <div style={styles.lassoDot} />
          <span>
            Drag to draw selection cube — release to confirm ·{' '}
            <kbd style={styles.kbdInline}>Esc</kbd> or{' '}
            <kbd style={styles.kbdInline}>⌘⇧P</kbd> to cancel
          </span>
        </div>
      )}

      {/* ── ROI info + command bar ── */}
      {!lassoActive && (roi || computing) && (
        <div style={styles.roiPanel}>
          {computing ? (
            <div style={styles.roiRow}>
              <span style={styles.roiLabel}>Computing selection…</span>
            </div>
          ) : (
            <>
              {/* ROI header */}
              <div style={styles.roiTitleRow}>
                <span style={styles.roiTitle}>Selection</span>
                <button style={styles.clearBtn} onClick={onClearRoi} title="Clear selection">✕</button>
              </div>

              {/* ROI stats */}
              <div style={styles.roiRow}>
                <span style={styles.roiLabel}>Splats</span>
                <span style={styles.roiValue}>{fmt(roi.estimatedCount)}</span>
              </div>
              <div style={styles.roiRow}>
                <span style={styles.roiLabel}>Center</span>
                <span style={styles.roiValue}>{fmtVec(roi.worldCenter)}</span>
              </div>

              {/* ── Delete button ── */}
              <button
                style={{
                  ...styles.deleteBtn,
                  ...(!canDelete || deleting ? styles.deleteBtnDisabled : {}),
                }}
                onClick={onDelete}
                disabled={!canDelete || deleting}
                title={
                  !canDelete
                    ? 'Deletion only supported for .ply files'
                    : 'Remove all splats inside the cube from the scene'
                }
              >
                {deleting ? 'Deleting…' : 'Delete inside cube'}
              </button>
              {!canDelete && (
                <p style={styles.deleteNote}>Deletion requires a .ply source file</p>
              )}

              {/* ── NL command bar ── */}
              <div style={styles.cmdBar}>
                <textarea
                  ref={textareaRef}
                  value={cmdText}
                  onChange={(e) => setCmdText(e.target.value)}
                  onKeyDown={onTextKeyDown}
                  onFocus={onCommandFocus}
                  onBlur={onCommandBlur}
                  placeholder={'Describe what to do…\ne.g. "make it sway in the wind"'}
                  style={styles.cmdTextarea}
                  rows={2}
                  disabled={commandPending}
                />
                <button
                  style={{
                    ...styles.cmdSubmit,
                    ...((!cmdText.trim() || commandPending) ? styles.cmdSubmitDisabled : {}),
                  }}
                  onClick={submitCommand}
                  disabled={!cmdText.trim() || commandPending}
                >
                  {commandPending ? <SpinnerIcon /> : <SendIcon />}
                </button>
              </div>

              {/* Last action result */}
              {lastAction && (
                <div style={styles.actionResult}>
                  {lastAction.action === 'error' ? (
                    <span style={{ color: '#f87171' }}>{lastAction.error ?? 'Unknown error'}</span>
                  ) : (
                    <>
                      <span style={styles.actionBadge(lastAction.action)}>
                        {lastAction.action}
                      </span>
                      {lastAction.effect && (
                        <span style={{ ...styles.actionBadge('effect'), color: EFFECT_COLORS[lastAction.effect] ?? '#818cf8' }}>
                          {lastAction.effect}
                        </span>
                      )}
                      {lastAction.async && (
                        <span style={{ ...styles.actionBadge('async'), color: '#fb923c' }}>async</span>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Loading bar ── */}
      {isLoading && !error && (
        <div style={styles.loadingBar}>
          <div style={styles.loadingInner}>
            <div style={styles.loadingTextRow}>
              <span style={styles.loadingLabel}>Loading Gaussian splats…</span>
              <span style={styles.loadingPct}>{loadProgress}%</span>
            </div>
            <div style={styles.progressTrack}>
              <div style={{ ...styles.progressFill, width: `${loadProgress}%` }} />
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
            <button style={styles.retryBtn} onClick={onReset}>Load a different file</button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(str, max) {
  return str.length > max ? '…' + str.slice(-(max - 1)) : str;
}

function fmt(n) {
  if (n == null) return '—';
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M'
       : n >= 1_000     ? (n / 1_000).toFixed(1) + 'k'
       : String(n);
}

function fmtVec(v) {
  if (!v) return '—';
  const f = (n) => n.toFixed(2);
  return `${f(v.x)}, ${f(v.y)}, ${f(v.z)}`;
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3.293a1 1 0 0 1 .707.293L7.207 4.5H13.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8z"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function BoxSelectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="1.5" width="13" height="13" rx="1.5"
        stroke="currentColor" strokeWidth="1.2" strokeDasharray="3 2" />
      <rect x="5" y="5" width="6" height="6" rx="1"
        stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="3.5" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 7h1M7 7h1M10 7h1M4 10h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M14 8L2 2l2.5 6L2 14l12-6z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ animation: 'spin 0.8s linear infinite' }}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="10" strokeLinecap="round" />
    </svg>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  topLeft: {
    position: 'fixed', top: 16, left: 16,
    display: 'flex', alignItems: 'center', gap: 12,
    pointerEvents: 'none',
  },
  logoMark: {
    display: 'flex', alignItems: 'center', gap: 7,
    background: 'rgba(6,6,9,0.75)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 10, padding: '6px 12px',
    backdropFilter: 'blur(12px)',
  },
  logoText: { fontSize: 14, fontWeight: 600, color: '#f4f4f5', letterSpacing: '-0.01em' },
  sceneLabel: {
    fontSize: 12, color: '#71717a',
    background: 'rgba(6,6,9,0.75)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 8, padding: '5px 10px',
    backdropFilter: 'blur(12px)',
    maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },

  topRight: {
    position: 'fixed', top: 16, right: 16,
    display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
    zIndex: 30,
  },
  iconBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: 'rgba(6,6,9,0.8)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 8, color: '#a1a1aa',
    fontSize: 12, fontWeight: 500, padding: '6px 12px',
    backdropFilter: 'blur(12px)', cursor: 'pointer',
  },
  iconBtnActive: {
    color: '#818cf8',
    border: '1px solid rgba(129,140,248,0.35)',
    background: 'rgba(129,140,248,0.1)',
  },
  btnLabel: { lineHeight: 1 },

  controlsPanel: {
    background: 'rgba(10,10,16,0.92)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 12, padding: '14px 16px',
    backdropFilter: 'blur(16px)', minWidth: 230,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  controlsTitle: {
    fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
    color: '#52525b', textTransform: 'uppercase', marginBottom: 2,
  },
  controlRow: { display: 'flex', alignItems: 'center', gap: 10 },
  mouseBadge: {
    width: 30, height: 20, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 5, fontSize: 13, color: '#818cf8',
  },
  kbdBadge: {
    minWidth: 30, height: 20, flexShrink: 0, padding: '0 4px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(129,140,248,0.1)',
    border: '1px solid rgba(129,140,248,0.2)',
    borderRadius: 5, fontSize: 11, fontWeight: 600, color: '#818cf8',
  },
  controlAction: { fontSize: 13, color: '#a1a1aa' },

  lassoBanner: {
    position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
    display: 'flex', alignItems: 'center', gap: 10,
    background: 'rgba(10,10,16,0.92)',
    border: '1px solid rgba(129,140,248,0.3)',
    borderRadius: 10, padding: '10px 18px',
    backdropFilter: 'blur(16px)', fontSize: 13, color: '#a1a1aa',
    pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 30,
  },
  lassoDot: {
    width: 8, height: 8, borderRadius: '50%', background: '#818cf8',
    boxShadow: '0 0 6px #818cf8', animation: 'pulse 1.2s ease-in-out infinite',
  },
  kbdInline: {
    background: 'rgba(129,140,248,0.15)',
    border: '1px solid rgba(129,140,248,0.25)',
    borderRadius: 4, padding: '1px 5px',
    fontSize: 11, fontWeight: 600, color: '#818cf8', fontFamily: 'inherit',
  },

  // ROI + command panel
  roiPanel: {
    position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(10,10,16,0.92)',
    border: '1px solid rgba(129,140,248,0.25)',
    borderRadius: 14, padding: '14px 16px',
    backdropFilter: 'blur(16px)',
    width: 320, maxWidth: 'calc(100vw - 32px)',
    display: 'flex', flexDirection: 'column', gap: 8,
    zIndex: 30,
  },
  roiTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  roiTitle:    { fontSize: 12, fontWeight: 600, color: '#818cf8', letterSpacing: '0.04em' },
  roiRow:      { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16 },
  roiLabel:    { fontSize: 12, color: '#52525b' },
  roiValue:    { fontSize: 12, fontWeight: 500, color: '#d4d4d8', fontVariantNumeric: 'tabular-nums' },
  clearBtn:    { background: 'none', border: 'none', color: '#52525b', cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1 },

  // NL command bar
  cmdBar: {
    display: 'flex', gap: 8, alignItems: 'flex-end',
    marginTop: 4,
    borderTop: '1px solid rgba(255,255,255,0.06)',
    paddingTop: 10,
  },
  cmdTextarea: {
    flex: 1, resize: 'none',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 8, color: '#e4e4e7',
    fontSize: 12, padding: '8px 10px', lineHeight: 1.5,
    fontFamily: 'inherit', outline: 'none',
  },
  cmdSubmit: {
    flexShrink: 0, width: 34, height: 34,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(129,140,248,0.15)',
    border: '1px solid rgba(129,140,248,0.3)',
    borderRadius: 8, color: '#818cf8', cursor: 'pointer',
  },
  cmdSubmitDisabled: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.06)',
    color: '#3f3f46', cursor: 'default',
  },

  // Action result badge row
  actionResult: {
    display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2,
  },
  actionBadge: (type) => ({
    fontSize: 11, fontWeight: 600, padding: '2px 7px',
    borderRadius: 5, letterSpacing: '0.03em',
    background: 'rgba(129,140,248,0.1)',
    border: '1px solid rgba(129,140,248,0.2)',
    color: type === 'animate' ? '#818cf8'
         : type === 'effect'  ? '#818cf8'
         : '#a1a1aa',
  }),

  // Delete button
  deleteBtn: {
    width: '100%', padding: '9px 0',
    background: 'rgba(239, 68, 68, 0.12)',
    border: '1px solid rgba(239, 68, 68, 0.35)',
    borderRadius: 8, color: '#f87171',
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
    marginTop: 2,
  },
  deleteBtnDisabled: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.06)',
    color: '#3f3f46', cursor: 'not-allowed',
  },
  deleteNote: {
    fontSize: 11, color: '#52525b', textAlign: 'center', marginTop: -2,
  },

  // Loading bar
  loadingBar: { position: 'fixed', bottom: 0, left: 0, right: 0, padding: '0 24px 20px', pointerEvents: 'none' },
  loadingInner: {
    background: 'rgba(10,10,16,0.88)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 12, padding: '12px 16px',
    backdropFilter: 'blur(16px)', maxWidth: 480, margin: '0 auto',
  },
  loadingTextRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  loadingLabel:  { fontSize: 13, color: '#a1a1aa' },
  loadingPct:    { fontSize: 13, fontWeight: 600, color: '#818cf8', fontVariantNumeric: 'tabular-nums' },
  progressTrack: { height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' },
  progressFill:  { height: '100%', background: 'linear-gradient(90deg, #6366f1, #818cf8)', borderRadius: 2, transition: 'width 0.3s ease' },

  // Error
  errorOverlay: { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' },
  errorCard: { background: 'rgba(14,14,22,0.96)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 16, padding: '32px 36px', maxWidth: 420, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' },
  errorTitle: { fontSize: 17, fontWeight: 600, color: '#f87171' },
  errorBody:  { fontSize: 13, color: '#71717a', lineHeight: 1.6 },
  retryBtn:   { marginTop: 8, background: 'rgba(129,140,248,0.1)', border: '1px solid rgba(129,140,248,0.25)', borderRadius: 8, color: '#818cf8', fontSize: 13, fontWeight: 500, padding: '9px 20px', cursor: 'pointer' },
};
