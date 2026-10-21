import {
  collection, deleteField, doc, getDoc, getDocs, runTransaction, serverTimestamp, setDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { planOperationBatches, planRowChunks } from './dataset-chunks.mjs';

const MAX_BATCH_OPERATIONS = 100;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const PORTFOLIO_BUILD_LOCK_MS = 2 * 60 * 60 * 1000;

function collectionReference(database, uid, collectionName, datasetId) {
  if (!uid || !collectionName || !datasetId || [uid, collectionName, datasetId].some(value => value.includes('/'))) {
    throw new Error('A valid user, collection, and dataset ID are required.');
  }
  return doc(database, 'users', uid, collectionName, datasetId);
}

function estimateBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength * 3 + 512;
}

async function commitOperations(database, operations) {
  for (const batchOperations of planOperationBatches(operations, MAX_BATCH_OPERATIONS, MAX_BATCH_BYTES)) {
    const batch = writeBatch(database);
    batchOperations.forEach(operation => {
      if (operation.type === 'delete') batch.delete(operation.reference);
      else batch.set(operation.reference, operation.data);
    });
    await batch.commit();
  }
}

async function removeVersion(database, versionReference) {
  const chunksSnapshot = await getDocs(collection(versionReference, 'chunks'));
  const operations = chunksSnapshot.docs.map(snapshot => ({
    type: 'delete',
    reference: snapshot.ref,
    bytes: 256
  }));
  operations.push({ type: 'delete', reference: versionReference, bytes: 256 });
  await commitOperations(database, operations);
}

async function cleanupOldStorage(database, datasetReference, activeVersionId, activeVersion) {
  const versionSnapshot = await getDocs(collection(datasetReference, 'versions'));
  const legacyChunks = await getDocs(collection(datasetReference, 'chunks'));
  const operations = legacyChunks.docs.map(snapshot => ({
    type: 'delete',
    reference: snapshot.ref,
    bytes: 256
  }));
  await commitOperations(database, operations);
  for (const version of versionSnapshot.docs) {
    const versionNumber = version.data().version;
    if (version.id !== activeVersionId && Number.isSafeInteger(versionNumber) && versionNumber < activeVersion) {
      await removeVersion(database, version.ref);
    }
  }
}

function newVersionId(version) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `v${String(version).padStart(6, '0')}-${suffix}`;
}

export async function readVersionedDataset(database, uid, collectionName, datasetId, requestedVersionId = null, expectedVersion = null) {
  const reference = collectionReference(database, uid, collectionName, datasetId);
  const snapshot = await getDoc(reference);
  if (!snapshot.exists()) return { exists: false, rows: [], headers: [], metadata: {}, reference };
  const metadata = snapshot.data();
  const activeVersionId = requestedVersionId ?? metadata.activeVersionId;
  if (!activeVersionId) {
    if (!metadata.chunked) {
      return {
        exists: true,
        rows: Array.isArray(metadata.rows) ? metadata.rows : [],
        headers: Array.isArray(metadata.headers) ? metadata.headers : [],
        metadata,
        reference
      };
    }
    const legacyChunks = await getDocs(collection(reference, 'chunks'));
    const chunks = legacyChunks.docs
      .map(chunk => ({ id: chunk.id, ...chunk.data() }))
      .sort((left, right) => (left.chunkIndex ?? 0) - (right.chunkIndex ?? 0));
    return {
      exists: true,
      rows: chunks.flatMap(chunk => Array.isArray(chunk.rows) ? chunk.rows : []),
      headers: Array.isArray(metadata.headers) ? metadata.headers : [],
      metadata,
      reference
    };
  }

  const versionReference = doc(reference, 'versions', activeVersionId);
  const versionSnapshot = await getDoc(versionReference);
  if (!versionSnapshot.exists()) throw new Error(`${datasetId} is not ready: its Firestore version ${activeVersionId} is missing.`);
  const versionData = versionSnapshot.data();
  if ((!requestedVersionId && versionData.version !== metadata.version)
    || (expectedVersion !== null && versionData.version !== expectedVersion)
    || versionData.chunkCount < 0 || !Number.isInteger(versionData.chunkCount)) {
    throw new Error(`${datasetId} is not ready: its published version metadata does not match its chunks.`);
  }
  const chunkSnapshot = await getDocs(collection(versionReference, 'chunks'));
  const chunks = chunkSnapshot.docs
    .map(chunk => ({ id: chunk.id, ...chunk.data() }))
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
  if (chunks.length !== versionData.chunkCount) {
    throw new Error(`${datasetId} is not ready: expected ${versionData.chunkCount} chunks but found ${chunks.length}.`);
  }
  chunks.forEach((chunk, index) => {
    if (chunk.version !== versionData.version || chunk.chunkIndex !== index) {
      throw new Error(`${datasetId} is not ready: chunk ${index} does not match the published version.`);
    }
  });
  const rows = chunks.flatMap(chunk => Array.isArray(chunk.rows) ? chunk.rows : []);
  if (rows.length !== versionData.rowCount) {
    throw new Error(`${datasetId} is not ready: expected ${versionData.rowCount} rows but found ${rows.length}.`);
  }
  return {
    exists: true,
    rows,
    headers: Array.isArray(versionData.headers) ? versionData.headers : [],
    metadata,
    version: versionData.version,
    versionId: activeVersionId,
    reference
  };
}

export async function readDatasetMetadata(database, uid, collectionName, datasetId) {
  const reference = collectionReference(database, uid, collectionName, datasetId);
  const snapshot = await getDoc(reference);
  return snapshot.exists() ? snapshot.data() : {};
}

export async function readInputDataNotes(database, uid) {
  const reference = collectionReference(database, uid, 'account_notes', 'input_data');
  const snapshot = await getDoc(reference);
  const notes = snapshot.exists() ? snapshot.data().notes ?? '' : '';
  if (typeof notes !== 'string') throw new TypeError('Input Data notes must be stored as text.');
  return notes;
}

export async function writeInputDataNotes(database, uid, notes) {
  if (typeof notes !== 'string') throw new TypeError('Input Data notes must be a string.');
  const reference = collectionReference(database, uid, 'account_notes', 'input_data');
  await setDoc(reference, { notes, updatedAt: serverTimestamp() });
}

export async function acquirePortfolioBuildLock(database, uid, owner) {
  const reference = collectionReference(database, uid, 'datasets', 'portfolio_total');
  await runTransaction(database, async transaction => {
    const snapshot = await transaction.get(reference);
    const metadata = snapshot.exists() ? snapshot.data() : {};
    if (metadata.buildLockId && Number(metadata.buildLockUntil) > Date.now()) {
      throw new Error('Another portfolio build is already in progress. Wait for it to finish, then try again.');
    }
    transaction.set(reference, {
      buildLockId: owner,
      buildLockUntil: Date.now() + PORTFOLIO_BUILD_LOCK_MS
    }, { merge: true });
  });
}

export async function releasePortfolioBuildLock(database, uid, owner) {
  const reference = collectionReference(database, uid, 'datasets', 'portfolio_total');
  await runTransaction(database, async transaction => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists() || snapshot.data().buildLockId !== owner) return;
    transaction.set(reference, {
      buildLockId: deleteField(),
      buildLockUntil: deleteField()
    }, { merge: true });
  });
}

export async function writeVersionedDataset(database, uid, collectionName, datasetId, rows, options = {}) {
  const reference = collectionReference(database, uid, collectionName, datasetId);
  if (!Array.isArray(rows)) throw new TypeError('Dataset rows must be an array.');
  const previousSnapshot = await getDoc(reference);
  const previousData = previousSnapshot.exists() ? previousSnapshot.data() : {};
  const version = (Number.isSafeInteger(previousData.version) ? previousData.version : 0) + 1;
  const previousVersion = Number.isSafeInteger(previousData.version) ? previousData.version : 0;
  const previousVersionId = previousData.activeVersionId ?? null;
  const versionId = newVersionId(version);
  const versionReference = doc(reference, 'versions', versionId);
  const chunks = planRowChunks(rows);
  const chunkOperations = chunks.map((chunkRows, chunkIndex) => {
    const data = { chunkIndex, version, rows: chunkRows };
    return {
      type: 'set',
      reference: doc(collection(versionReference, 'chunks'), `chunk_${String(chunkIndex).padStart(4, '0')}`),
      data,
      bytes: estimateBytes(data)
    };
  });

  let publicationStarted = false;
  try {
    await commitOperations(database, chunkOperations);
    await setDoc(versionReference, {
      version,
      chunkCount: chunks.length,
      rowCount: rows.length,
      headers: options.headers ?? [],
      preparedAt: serverTimestamp()
    });
    publicationStarted = true;
    await runTransaction(database, async transaction => {
      const currentSnapshot = await transaction.get(reference);
      const currentData = currentSnapshot.exists() ? currentSnapshot.data() : {};
      const currentVersion = Number.isSafeInteger(currentData.version) ? currentData.version : 0;
      const currentVersionId = currentData.activeVersionId ?? null;
      if (currentVersion !== previousVersion || currentVersionId !== previousVersionId) {
        throw new Error(`${datasetId} changed while saving. Reload it and submit your edits again.`);
      }
      transaction.set(reference, {
        ...options.metadata,
        rows: deleteField(),
        headers: options.headers ?? [],
        rowCount: rows.length,
        chunkCount: chunks.length,
        chunked: true,
        version,
        activeVersionId: versionId,
        updatedAt: serverTimestamp()
      }, { merge: true });
    });
  } catch (error) {
    if (!publicationStarted) {
      try {
        await removeVersion(database, versionReference);
      } catch (cleanupError) {
        throw new Error(`Could not stage ${datasetId} (${error.code ?? 'unknown'}). Staged data cleanup also failed (${cleanupError.code ?? cleanupError.message}).`);
      }
    }
    throw error;
  }

  let cleanupWarning = '';
  if (!options.deferCleanup) {
    try {
      await cleanupOldStorage(database, reference, versionId, version);
    } catch (error) {
      cleanupWarning = `Saved version ${version}, but old Firestore chunks could not be cleaned up: ${error.code ?? error.message}`;
    }
  }
  return { version, versionId, rowCount: rows.length, cleanupWarning };
}

export async function cleanupDatasetVersions(database, uid, collectionName, datasetId, activeVersionId) {
  const reference = collectionReference(database, uid, collectionName, datasetId);
  const activeVersionSnapshot = await getDoc(doc(reference, 'versions', activeVersionId));
  if (!activeVersionSnapshot.exists()) throw new Error(`${datasetId} cannot clean up versions: active version ${activeVersionId} is missing.`);
  await cleanupOldStorage(database, reference, activeVersionId, activeVersionSnapshot.data().version);
}
