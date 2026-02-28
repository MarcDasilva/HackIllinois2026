/**
 * POST /api/generate
 *
 * Proxies the request to the Modal SSE endpoint and re-streams the
 * Server-Sent Events back to the browser.  Having this thin proxy avoids
 * CORS issues and lets us keep the Modal URL server-side.
 */

// The deployed Modal web endpoint URL.
// Set MODAL_API_URL in .env.local (no trailing slash).
// e.g. MODAL_API_URL=https://your-workspace--world-asset-pipeline-web-api.modal.run
const MODAL_BASE = process.env.MODAL_API_URL ?? 'http://localhost:8000';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const body = await request.json();

  // Forward the request to Modal
  let upstream;
  try {
    upstream = await fetch(`${MODAL_BASE}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Node 18+ fetch supports streaming
      duplex: 'half',
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Cannot reach pipeline: ${err.message}` }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(text, { status: upstream.status });
  }

  // Stream the SSE body straight through to the browser
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
