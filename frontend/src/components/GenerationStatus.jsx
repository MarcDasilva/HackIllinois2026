'use client';

/**
 * GenerationStatus
 *
 * Overlaid panel that appears while the pipeline is running.
 * Consumes a stream of SSE events and renders a live progress UI.
 *
 * Props:
 *   events  – array of { event, data } objects accumulated by the parent
 *   onClose – called when the user dismisses a finished/errored run
 */

const STAGE_META = {
  A: { label: 'Asset Spec',    icon: <SparkleIcon /> },
  B: { label: 'Geometry',      icon: <CubeIcon />    },
  C: { label: 'PBR Cleanup',   icon: <BrushIcon />   },
  D: { label: 'Validation',    icon: <CheckIcon />   },
  E: { label: 'Placement',     icon: <PinIcon />     },
};

export default function GenerationStatus({ events, onClose }) {
  if (!events || events.length === 0) return null;

  // Derive state from events
  const lastEvent    = events[events.length - 1];
  const isDone       = lastEvent.event === 'done';
  const isError      = lastEvent.event === 'error';
  const isRunning    = !isDone && !isError;

  const progress     = lastEvent.data?.progress ?? 0;
  const currentLabel = lastEvent.data?.label ?? lastEvent.data?.message ?? '…';

  // Build a deduplicated list of completed stages for the step trail
  const completedStages = [];
  const seen = new Set();
  for (const ev of events) {
    const s = ev.data?.stage;
    if (ev.event === 'stage_done' && s && !seen.has(s)) {
      seen.add(s);
      completedStages.push(s);
    }
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        {/* ── Header ── */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            {isRunning && <PulsingDot />}
            {isDone    && <span style={styles.doneIcon}>✓</span>}
            {isError   && <span style={styles.errorIcon}>✕</span>}
            <span style={styles.title}>
              {isRunning ? 'Generating…' : isDone ? 'Done' : 'Failed'}
            </span>
          </div>
          {(isDone || isError) && (
            <button style={styles.closeBtn} onClick={onClose} title="Dismiss">
              <CloseIcon />
            </button>
          )}
        </div>

        {/* ── Progress bar ── */}
        <div style={styles.progressTrack}>
          <div
            style={{
              ...styles.progressFill,
              width: `${progress}%`,
              background: isError
                ? 'linear-gradient(90deg,#ef4444,#f87171)'
                : 'linear-gradient(90deg,#6366f1,#818cf8)',
            }}
          />
        </div>

        {/* ── Current label ── */}
        <p style={styles.currentLabel}>{currentLabel}</p>

        {/* ── Stage trail ── */}
        {completedStages.length > 0 && (
          <div style={styles.stageTrail}>
            {completedStages.map((s) => (
              <div key={s} style={styles.stagePill}>
                <span style={styles.stagePillIcon}>{STAGE_META[s]?.icon ?? null}</span>
                <span style={styles.stagePillLabel}>{STAGE_META[s]?.label ?? s}</span>
                <span style={styles.stagePillCheck}>✓</span>
              </div>
            ))}
          </div>
        )}

        {/* ── Done summary ── */}
        {isDone && lastEvent.data?.validation && (
          <div style={styles.summary}>
            <span style={styles.summaryLabel}>Validation</span>
            <span
              style={{
                ...styles.summaryBadge,
                background: lastEvent.data.validation.passed
                  ? 'rgba(34,197,94,0.12)'
                  : 'rgba(239,68,68,0.12)',
                color: lastEvent.data.validation.passed ? '#4ade80' : '#f87171',
                borderColor: lastEvent.data.validation.passed
                  ? 'rgba(34,197,94,0.25)'
                  : 'rgba(239,68,68,0.25)',
              }}
            >
              {lastEvent.data.validation.passed ? 'Passed' : 'Failed'}
            </span>
            {lastEvent.data.validation.score != null && (
              <span style={styles.summaryScore}>
                Score: {(lastEvent.data.validation.score * 100).toFixed(0)}%
              </span>
            )}
          </div>
        )}

        {/* ── Error detail ── */}
        {isError && (
          <p style={styles.errorBody}>
            {lastEvent.data?.message ?? 'An unknown error occurred.'}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Small icon components ──────────────────────────────────────────────────

function PulsingDot() {
  return (
    <span style={styles.dot}>
      <span style={styles.dotPulse} />
    </span>
  );
}

function SparkleIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M8 1v14M1 8h14M4.5 4.5l7 7M11.5 4.5l-7 7"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function CubeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5L14 5v6L8 14.5 2 11V5L8 1.5z"
        stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 1.5v13M2 5l6 3.5L14 5"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function BrushIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M10.5 2.5l3 3-7 7H3.5v-3l7-7z"
        stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M3.5 12.5c0 1 .5 1.5 1.5 1.5s1-.5 1-1.5"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M2.5 8l4 4 7-7"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PinIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5C5.515 1.5 3.5 3.515 3.5 6c0 3.5 4.5 8.5 4.5 8.5S12.5 9.5 12.5 6c0-2.485-2.015-4.5-4.5-4.5z"
        stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M2 2l12 12M14 2L2 14"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = {
  overlay: {
    position: 'fixed',
    bottom: 84,          // sits above the prompt bar (which is ~72px tall)
    left: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
    zIndex: 20,
    padding: '0 24px',
  },

  panel: {
    pointerEvents: 'auto',
    background: 'rgba(10,10,16,0.92)',
    border: '1px solid rgba(255,255,255,0.09)',
    borderRadius: 14,
    padding: '14px 16px',
    backdropFilter: 'blur(20px)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    width: '100%',
    maxWidth: 640,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },

  title: {
    fontSize: 13,
    fontWeight: 600,
    color: '#f4f4f5',
  },

  doneIcon: {
    fontSize: 13,
    color: '#4ade80',
    fontWeight: 700,
  },

  errorIcon: {
    fontSize: 13,
    color: '#f87171',
    fontWeight: 700,
  },

  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#52525b',
    cursor: 'pointer',
    padding: 2,
    display: 'flex',
    alignItems: 'center',
  },

  progressTrack: {
    height: 3,
    background: 'rgba(255,255,255,0.06)',
    borderRadius: 2,
    overflow: 'hidden',
  },

  progressFill: {
    height: '100%',
    borderRadius: 2,
    transition: 'width 0.5s ease',
  },

  currentLabel: {
    fontSize: 12,
    color: '#a1a1aa',
    margin: 0,
  },

  stageTrail: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },

  stagePill: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    background: 'rgba(129,140,248,0.08)',
    border: '1px solid rgba(129,140,248,0.18)',
    borderRadius: 20,
    padding: '3px 9px 3px 7px',
    color: '#818cf8',
  },

  stagePillIcon: {
    display: 'flex',
    alignItems: 'center',
  },

  stagePillLabel: {
    fontSize: 11,
    fontWeight: 500,
  },

  stagePillCheck: {
    fontSize: 10,
    color: '#4ade80',
    marginLeft: 2,
  },

  summary: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },

  summaryLabel: {
    fontSize: 12,
    color: '#52525b',
  },

  summaryBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 20,
    border: '1px solid',
  },

  summaryScore: {
    fontSize: 12,
    color: '#71717a',
    marginLeft: 4,
  },

  errorBody: {
    fontSize: 12,
    color: '#f87171',
    margin: 0,
    lineHeight: 1.5,
    wordBreak: 'break-word',
  },

  dot: {
    position: 'relative',
    display: 'inline-flex',
    width: 8,
    height: 8,
  },

  dotPulse: {
    position: 'absolute',
    inset: 0,
    borderRadius: '50%',
    background: '#818cf8',
    animation: 'pulse 1.4s ease-in-out infinite',
  },
};
