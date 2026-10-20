const encoder = new TextEncoder();

export const MAX_CHUNK_BYTES = 650 * 1024;

export function planRowChunks(rows, maxChunkBytes = MAX_CHUNK_BYTES) {
  if (!Array.isArray(rows)) throw new TypeError('Dataset rows must be an array.');
  const chunks = [];
  let current = [];
  let currentBytes = 2;
  rows.forEach((row, index) => {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength;
    if (rowBytes + 2 > maxChunkBytes) {
      throw new Error(`Dataset row ${index + 1} exceeds the ${Math.floor(maxChunkBytes / 1024)} KiB chunk limit.`);
    }
    const addedBytes = rowBytes + (current.length ? 1 : 0);
    if (current.length && currentBytes + addedBytes > maxChunkBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes + (current.length > 1 ? 1 : 0);
  });
  if (current.length) chunks.push(current);
  return chunks;
}

export function planOperationBatches(operations, maxOperations = 100, maxBytes = 2 * 1024 * 1024) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  operations.forEach(operation => {
    const bytes = operation.bytes ?? 256;
    if (bytes > maxBytes) throw new Error('A Firestore operation exceeds the safe batch payload limit.');
    if (current.length && (current.length >= maxOperations || currentBytes + bytes > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(operation);
    currentBytes += bytes;
  });
  if (current.length) batches.push(current);
  return batches;
}
