import test from 'node:test';
import assert from 'node:assert/strict';
import { planOperationBatches, planRowChunks } from '../dataset-chunks.mjs';

test('splits dataset rows below the configured document payload size', () => {
  const rows = [{ value: 'a'.repeat(25) }, { value: 'b'.repeat(25) }, { value: 'c'.repeat(5) }];
  const chunks = planRowChunks(rows, 60);
  assert.deepEqual(chunks.flat(), rows);
  assert.equal(chunks.length, 2);
  chunks.forEach(chunk => assert.ok(new TextEncoder().encode(JSON.stringify(chunk)).byteLength <= 60));
});

test('rejects a row larger than a Firestore chunk', () => {
  assert.throws(() => planRowChunks([{ value: 'x'.repeat(100) }], 32), /exceeds/);
});

test('bounds Firestore write batches by operation count and payload', () => {
  const operations = [
    { bytes: 20 },
    { bytes: 20 },
    { bytes: 60 },
    { bytes: 20 }
  ];
  const batches = planOperationBatches(operations, 2, 70);
  assert.deepEqual(batches.map(batch => batch.length), [2, 1, 1]);
  batches.forEach(batch => {
    assert.ok(batch.length <= 2);
    assert.ok(batch.reduce((total, operation) => total + operation.bytes, 0) <= 70);
  });
});
