/**
 * PLY splat deletion utility.
 *
 * Parses the binary PLY header to locate the per-vertex `opacity` field,
 * then sets logit(opacity) = -20 (→ sigmoid ≈ 2e-9) for every vertex whose
 * xyz centre lies inside the supplied AABB.  The modified buffer is returned
 * as a Blob so it can be turned into an object URL and hot-swapped into the
 * viewer via a scene reload.
 *
 * Only `format binary_little_endian` PLY files are supported (which is the
 * universal format for 3DGS exports).  SPLAT / KSPLAT files are not parseable
 * this way — `canDeleteInFormat(fileName)` can be used to guard the button.
 */

// ─── Header parser ────────────────────────────────────────────────────────────

const TYPE_SIZES = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

function parsePlyHeader(buffer) {
  // PLY headers are pure ASCII; 16 KB is more than enough for any 3DGS file.
  const limit      = Math.min(buffer.byteLength, 16384);
  const headerText = new TextDecoder('ascii').decode(new Uint8Array(buffer, 0, limit));

  // Locate the end-of-header marker (tolerate both LF and CRLF line endings)
  let endMarker = 'end_header\n';
  let markerPos = headerText.indexOf(endMarker);
  if (markerPos < 0) {
    endMarker = 'end_header\r\n';
    markerPos = headerText.indexOf(endMarker);
  }
  if (markerPos < 0) throw new Error('Invalid PLY: "end_header" not found in first 16 KB');

  const dataStart = markerPos + endMarker.length;
  const lines     = headerText.slice(0, markerPos).replace(/\r/g, '').split('\n');

  // Check encoding
  const formatLine = lines.find((l) => l.startsWith('format '));
  if (formatLine && !formatLine.includes('binary_little_endian')) {
    throw new Error('Only binary_little_endian PLY files are supported for deletion');
  }

  // Walk property declarations
  let vertexCount  = 0;
  let propOffset   = 0;
  let xOff = -1, yOff = -1, zOff = -1, opacityOff = -1;
  let inVertexElement = false;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('element ')) {
      inVertexElement = t.startsWith('element vertex ');
      if (inVertexElement) vertexCount = parseInt(t.split(' ')[2], 10);
    } else if (inVertexElement && t.startsWith('property ') && !t.startsWith('property list')) {
      const parts = t.split(/\s+/);
      const type  = parts[1];
      const name  = parts[2];
      const size  = TYPE_SIZES[type];
      if (!size) throw new Error(`Unknown PLY property type: ${type}`);
      if (name === 'x')       xOff       = propOffset;
      if (name === 'y')       yOff       = propOffset;
      if (name === 'z')       zOff       = propOffset;
      if (name === 'opacity') opacityOff = propOffset;
      propOffset += size;
    }
  }

  if (xOff < 0 || yOff < 0 || zOff < 0) {
    throw new Error('PLY file is missing x / y / z position properties');
  }

  return {
    vertexCount,
    bytesPerVertex: propOffset,
    dataStart,
    xOff, yOff, zOff, opacityOff,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if the given filename is a PLY file that this utility supports.
 */
export function canDeleteInFormat(fileName) {
  return (fileName ?? '').toLowerCase().endsWith('.ply');
}

/**
 * Build a new PLY Blob with every splat whose centre falls inside `bounds`
 * rendered invisible (opacity logit set to −20 ≈ 0 opacity).
 *
 * @param {File|Blob} file   - Original PLY file object
 * @param {object}    bounds - { min: {x,y,z}, max: {x,y,z} }
 * @returns {Promise<{blob: Blob, deletedCount: number, totalCount: number}>}
 */
export async function buildFilteredPly(file, bounds) {
  const buffer = await file.arrayBuffer();
  const { vertexCount, bytesPerVertex, dataStart, xOff, yOff, zOff, opacityOff } =
    parsePlyHeader(buffer);

  // Work on a copy so the original is not mutated
  const out       = buffer.slice(0);
  const readView  = new DataView(buffer);
  const writeView = new DataView(out);

  const { min, max } = bounds;
  let deletedCount = 0;

  for (let i = 0; i < vertexCount; i++) {
    const base = dataStart + i * bytesPerVertex;
    const x    = readView.getFloat32(base + xOff, true);
    const y    = readView.getFloat32(base + yOff, true);
    const z    = readView.getFloat32(base + zOff, true);

    if (x >= min.x && x <= max.x &&
        y >= min.y && y <= max.y &&
        z >= min.z && z <= max.z) {
      if (opacityOff >= 0) {
        // logit(opacity) = −20  →  sigmoid(−20) ≈ 2e−9  (effectively invisible)
        writeView.setFloat32(base + opacityOff, -20.0, true);
      }
      deletedCount++;
    }
  }

  console.log(
    `[WorldEdit] Deleted ${deletedCount.toLocaleString()} / ${vertexCount.toLocaleString()} splats`,
  );

  return {
    blob:         new Blob([out], { type: 'application/octet-stream' }),
    deletedCount,
    totalCount:   vertexCount,
  };
}
