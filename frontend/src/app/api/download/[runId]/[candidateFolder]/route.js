/**
 * GET /api/download/[runId]/[candidateFolder]
 *
 * Proxies the GLB file from the Modal /download endpoint to the browser.
 * Keeps the Modal URL server-side and avoids CORS issues.
 */

const MODAL_BASE = process.env.MODAL_API_URL ?? 'http://localhost:8000';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { runId, candidateFolder } = await params;

  let upstream;
  try {
    upstream = await fetch(`${MODAL_BASE}/download/${runId}/${candidateFolder}`);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Cannot reach pipeline: ${err.message}` }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (!upstream.ok) {
    return new Response(await upstream.text(), { status: upstream.status });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'model/gltf-binary',
      'Content-Disposition': `attachment; filename="asset_${runId}.glb"`,
      'Cache-Control': 'no-store',
    },
  });
}
