/**
 * Intent parser — converts a free-text NL command + active ROI into a
 * structured action JSON matching the spec schema (layer_4_nl_intent).
 *
 * Currently a local keyword-matching mock. Swap `parseIntent` for a fetch()
 * to the Modal `intent_parse` endpoint (Llama 3.1 8B via vLLM) without
 * touching any UI code — the returned shape is identical.
 *
 * Output schema:
 *   { action, target, effect?, params, async, raw }
 */

// ─── Effect parameter presets ────────────────────────────────────────────────

const EFFECT_PARAMS = {
  sway: {
    amplitude:    0.05,
    frequency:    0.8,
    windDirection: [1, 0],
    turbulence:   0.2,
    gustFrequency: 0.15,
  },
  ripple: {
    waveHeight:    0.03,
    waveFrequency: 1.2,
    waveDirection: [1, 0],
    waveCount:     3,
    specularIntensity: 0.4,
  },
  flicker: {
    baseIntensity:        1.0,
    flickerAmplitude:     0.4,
    flickerSpeed:         8,
    colorTemperatureShift: 200,
  },
  pulse: {
    pulseRate:      1.5,
    minOpacity:     0.4,
    maxOpacity:     1.0,
    scaleVariation: 0.1,
  },
  drift: {
    driftSpeed:  0.02,
    driftRadius: 0.5,
    gravity:    -0.01,
    fadeDistance: 2.0,
  },
};

// ─── Keyword dictionaries ────────────────────────────────────────────────────

const ANIMATE_KEYWORDS = {
  sway:    /\b(sway|swing|wave|waver|blow|flutter|rustle|bend)\b/i,
  ripple:  /\b(ripple|splash|water|undulate|shimmer|flow)\b/i,
  flicker: /\b(flicker|flame|fire|flare|candle|lamp|glow|light)\b/i,
  pulse:   /\b(pulse|throb|breathe|beat|pulsate|glow)\b/i,
  drift:   /\b(drift|float|smoke|fog|mist|hover|waft)\b/i,
};

const INSERT_KEYWORDS    = /\b(add|insert|place|put|create|generate|spawn)\b/i;
const EDIT_KEYWORDS      = /\b(change|edit|modify|make.*look|repaint|recolor|texture|turn.*into|convert)\b/i;
const DESELECT_KEYWORDS  = /\b(deselect|clear|unselect|cancel selection)\b/i;
const EXPORT_KEYWORDS    = /\b(export|download|save|render)\b/i;

// ─── Main entry ──────────────────────────────────────────────────────────────

/**
 * Parse a natural-language command against the active ROI.
 *
 * @param {string} text  - Raw user input
 * @param {object} roi   - Current ROI descriptor (may be null)
 * @returns {Promise<object>} Action JSON
 */
export async function parseIntent(text, roi) {
  // Simulate a small network delay so the UI loading state is visible
  await new Promise((r) => setTimeout(r, 120));

  const lower = text.toLowerCase().trim();

  // ── Deselect / clear ──────────────────────────────────────────────────────
  if (DESELECT_KEYWORDS.test(lower)) {
    return { action: 'deselect', target: roi?.id ?? 'selection', params: {}, async: false, raw: text };
  }

  // ── Export ────────────────────────────────────────────────────────────────
  if (EXPORT_KEYWORDS.test(lower)) {
    return { action: 'export', target: 'scene', params: {}, async: true, raw: text };
  }

  // ── Object insertion ──────────────────────────────────────────────────────
  if (INSERT_KEYWORDS.test(lower)) {
    const objectMatch = lower.match(/(?:add|insert|place|put|create|generate|spawn)\s+(?:a\s+|an\s+)?(.+?)(?:\s+(?:here|there|in|at|on|near|by).*)?$/i);
    const objectLabel = objectMatch?.[1]?.trim() ?? 'object';
    return {
      action: 'insert_object',
      target: roi?.id ?? 'scene',
      params: {
        prompt:   objectLabel,
        position: roi?.worldCenter ?? { x: 0, y: 0, z: 0 },
        mode:     'fast',
      },
      async: true,
      raw:  text,
    };
  }

  // ── Appearance editing ────────────────────────────────────────────────────
  if (EDIT_KEYWORDS.test(lower)) {
    return {
      action: 'edit_appearance',
      target: roi?.id ?? 'selection',
      params: { prompt: text, roi_bounds: roi?.bounds },
      async: true,
      raw:   text,
    };
  }

  // ── Procedural animation ──────────────────────────────────────────────────
  // Find the best matching effect
  let effect = null;
  for (const [name, re] of Object.entries(ANIMATE_KEYWORDS)) {
    if (re.test(lower)) { effect = name; break; }
  }
  // Default to sway if no effect matched but the intent looks like animation
  if (!effect) effect = 'sway';

  // Allow inline param overrides: "sway fast", "flicker slowly", etc.
  const params = { ...EFFECT_PARAMS[effect] };
  if (/\b(fast|quick|rapid|strong|hard)\b/i.test(lower)) {
    params.amplitude  = (params.amplitude  ?? 0.05) * 2;
    params.frequency  = (params.frequency  ?? 1)    * 1.5;
    params.flickerSpeed = (params.flickerSpeed ?? 8) * 2;
  }
  if (/\b(slow|gentle|soft|subtle|slight)\b/i.test(lower)) {
    params.amplitude  = (params.amplitude  ?? 0.05) * 0.4;
    params.frequency  = (params.frequency  ?? 1)    * 0.5;
    params.flickerSpeed = (params.flickerSpeed ?? 8) * 0.4;
  }

  return {
    action: 'animate',
    target: roi?.id ?? 'selection',
    effect,
    params,
    async:  false,
    raw:    text,
  };
}
