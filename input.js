import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { auth, authPersistenceReady, database } from './firebase.js';
import {
  acquirePortfolioBuildLock, cleanupDatasetVersions, readVersionedDataset,
  readInputDataNotes, releasePortfolioBuildLock, writeInputDataNotes, writeVersionedDataset
} from './firestore-datasets.js';
import { aggregatePortfolio, parseDelimited, parseSymbolPricesCsv, processAccountCsv } from './ledger-processing.mjs';

const DATASETS = [
  { id: 'account_metadata', label: 'account_metadata', collection: 'datasets' },
  { id: 'sector_definitions', label: 'sector_definitions', collection: 'datasets' },
  { id: 'account_instantiations', label: 'account_instantiations', collection: 'datasets' }
];
const DEFAULT_HEADERS = {
  account_metadata: ['id', 'accountName', 'brokerage', 'accountType'],
  sector_definitions: ['sector', 'symbols'],
  account_instantiations: ['accountId', 'symbol', 'mode', 'shares', 'total_cost_basis', 'effective_date']
};
const BROKER_HEADERS = {
  charles: ['Date', 'Action', 'Symbol', 'Description', 'Quantity', 'Price', 'Fees & Comm', 'Amount'],
  robinhood: ['Activity Date', 'Process Date', 'Settle Date', 'Instrument', 'Description', 'Trans Code', 'Quantity', 'Price', 'Amount'],
  trp: ['Date', 'Activity Type', 'Investment', 'Amount', 'Shares', 'Price']
};

const state = {
  user: null,
  metadataRows: [],
  selectedKey: '',
  datasetId: '',
  collectionName: '',
  accountId: '',
  brokerage: '',
  headers: [],
  rows: [],
  metadata: {},
  dirty: false,
  saving: false,
  loadingDataset: false,
  notesDirty: false,
  notesSaving: false,
  notesLoaded: false
};

const statusElement = document.querySelector('#input-status');
const datasetSelect = document.querySelector('#dataset-select');
const gridHeader = document.querySelector('#input-grid-header');
const gridBody = document.querySelector('#input-grid-body');
const saveButton = document.querySelector('#save-grid');
const buildButton = document.querySelector('#build-portfolio-button');
const dirtyIndicator = document.querySelector('#grid-dirty-indicator');
const notesTextarea = document.querySelector('#account-notes');
const notesSaveButton = document.querySelector('#save-notes');
const notesDirtyIndicator = document.querySelector('#notes-dirty-indicator');

function setStatus(message = '', isError = false) {
  statusElement.textContent = message;
  statusElement.hidden = !message;
  statusElement.classList.toggle('notice-error', isError);
}

function errorMessage(error) {
  if (error.code === 'permission-denied' || error.code === 'firestore/permission-denied') {
    return 'Firestore denied access. Publish owner-only rules for users/{uid}/datasets, users/{uid}/account_sources, and users/{uid}/account_notes, including nested versions and chunks where applicable, with request.auth.uid == uid.';
  }
  return `${error.code ? `${error.code}: ` : ''}${error.message}`;
}

function accountIdFromKey(key) {
  return key.slice('account:'.length);
}

function preferredDatasetKey(uid) {
  try {
    return localStorage.getItem(`portfolio-input-dataset:${uid}`) ?? 'dataset:account_metadata';
  } catch (error) {
    console.warn('Could not restore the previously selected Input Data dataset.', error);
    return 'dataset:account_metadata';
  }
}

function rememberDatasetKey(uid, key) {
  try {
    localStorage.setItem(`portfolio-input-dataset:${uid}`, key);
  } catch (error) {
    console.warn('Could not remember the selected Input Data dataset.', error);
  }
}

function objectRowsToGrid(rows, headers, datasetId) {
  return rows.map(row => headers.map(header => {
    let value = row?.[header] ?? '';
    if (datasetId === 'sector_definitions' && !['sector', 'name'].includes(header) && Array.isArray(value)) value = value.join(', ');
    if (value && typeof value === 'object') value = JSON.stringify(value);
    return value == null ? '' : String(value);
  }));
}

function inferHeaders(rows, preferred = []) {
  const headers = [...preferred];
  rows.forEach(row => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      Object.keys(row).forEach(key => {
        if (!headers.includes(key)) headers.push(key);
      });
    }
  });
  return headers;
}

function accountHeaders(brokerage = '') {
  const normalized = String(brokerage).toLowerCase();
  if (normalized.includes('rowe') || normalized.includes('trp')) return BROKER_HEADERS.trp;
  if (normalized.includes('robinhood') || normalized.includes('ubs')) return BROKER_HEADERS.robinhood;
  return BROKER_HEADERS.charles;
}

function setDirty(dirty) {
  state.dirty = dirty;
  dirtyIndicator.textContent = dirty ? 'Unsaved edits' : 'No unsaved edits';
  dirtyIndicator.classList.toggle('is-dirty', dirty);
  saveButton.disabled = !dirty || state.saving;
  buildButton.disabled = state.saving;
}

function setSaving(saving) {
  state.saving = saving;
  saveButton.disabled = saving || !state.dirty;
  buildButton.disabled = saving;
  saveButton.textContent = saving ? 'Saving…' : 'Submit changes';
  datasetSelect.disabled = saving || state.notesSaving || state.loadingDataset;
  document.querySelector('#add-grid-row').disabled = saving;
  document.querySelector('#add-grid-column').disabled = saving;
  document.querySelectorAll('#input-grid input').forEach(input => { input.disabled = saving; });
}

function setNotesDirty(dirty) {
  state.notesDirty = dirty;
  notesDirtyIndicator.textContent = dirty ? 'Unsaved notes' : 'No unsaved notes';
  notesDirtyIndicator.classList.toggle('is-dirty', dirty);
  notesSaveButton.disabled = !dirty || state.notesSaving || !state.notesLoaded;
}

function setNotesSaving(saving) {
  state.notesSaving = saving;
  notesSaveButton.disabled = saving || !state.notesDirty || !state.notesLoaded;
  notesSaveButton.textContent = saving ? 'Saving…' : 'Submit changes';
  datasetSelect.disabled = saving || state.saving || state.loadingDataset;
  notesTextarea.disabled = saving || !state.notesLoaded;
}

function setInputTab(tab) {
  const datasetActive = tab === 'dataset';
  document.querySelector('#dataset-tab').classList.toggle('is-active', datasetActive);
  document.querySelector('#dataset-tab').setAttribute('aria-selected', String(datasetActive));
  document.querySelector('#notes-tab').classList.toggle('is-active', !datasetActive);
  document.querySelector('#notes-tab').setAttribute('aria-selected', String(!datasetActive));
  document.querySelector('#dataset-tab-panel').hidden = !datasetActive;
  document.querySelector('#notes-tab-panel').hidden = datasetActive;
}

function resetInputDataNotes() {
  state.notesLoaded = false;
  state.notesDirty = false;
  notesTextarea.value = '';
  notesTextarea.disabled = true;
  document.querySelector('#notes-help').textContent =
    'Shared notes for Input Data. These notes are saved to Firebase and are available across devices.';
  setNotesDirty(false);
}

async function loadInputDataNotes() {
  resetInputDataNotes();
  const uid = state.user.uid;
  const notes = await readInputDataNotes(database, uid);
  if (state.user?.uid !== uid) return;
  state.notesLoaded = true;
  notesTextarea.disabled = false;
  notesTextarea.value = notes;
  setNotesDirty(false);
}

async function submitNotes() {
  if (state.notesSaving || !state.notesDirty || !state.notesLoaded) return;
  setNotesSaving(true);
  setStatus('Saving Input Data notes to Firebase…');
  try {
    await writeInputDataNotes(database, state.user.uid, notesTextarea.value);
    setNotesDirty(false);
    setStatus('Input Data notes saved to Firebase.');
  } catch (error) {
    setStatus(`Could not save Input Data notes: ${errorMessage(error)}`, true);
  } finally {
    setNotesSaving(false);
  }
}

function renderInputDataNotesError(error) {
  resetInputDataNotes();
  document.querySelector('#notes-help').textContent =
    `Could not load shared notes: ${errorMessage(error)}. Check the owner-only Firestore rule for users/{uid}/account_notes/{noteId}.`;
}

function renderGrid() {
  gridHeader.replaceChildren();
  gridBody.replaceChildren();
  const headingRow = document.createElement('tr');
  const rowNumberHeading = document.createElement('th');
  rowNumberHeading.textContent = '#';
  headingRow.append(rowNumberHeading);

  state.headers.forEach((header, columnIndex) => {
    const cell = document.createElement('th');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input-grid-header';
    input.value = header;
    input.setAttribute('aria-label', `Column ${columnIndex + 1} name`);
    input.addEventListener('input', () => {
      state.headers[columnIndex] = input.value;
      setDirty(true);
    });
    cell.append(input);
    headingRow.append(cell);
  });
  gridHeader.append(headingRow);

  state.rows.forEach((row, rowIndex) => {
    const tableRow = document.createElement('tr');
    const rowNumber = document.createElement('th');
    rowNumber.scope = 'row';
    rowNumber.textContent = String(rowIndex + 1);
    tableRow.append(rowNumber);
    state.headers.forEach((_, columnIndex) => {
      const cell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'input-grid-cell';
      input.value = row[columnIndex] ?? '';
      input.dataset.rowIndex = String(rowIndex);
      input.dataset.columnIndex = String(columnIndex);
      input.setAttribute('aria-label', `Row ${rowIndex + 1}, column ${columnIndex + 1}`);
      input.addEventListener('input', () => {
        state.rows[rowIndex][columnIndex] = input.value;
        setDirty(true);
      });
      cell.append(input);
      tableRow.append(cell);
    });
    gridBody.append(tableRow);
  });
  setDirty(state.dirty);
}

function populateDatasetOptions(preferredKey = state.selectedKey) {
  datasetSelect.replaceChildren();
  DATASETS.forEach(dataset => {
    const option = document.createElement('option');
    option.value = `dataset:${dataset.id}`;
    option.textContent = dataset.label;
    datasetSelect.append(option);
  });
  state.metadataRows.forEach(row => {
    const id = row.id ?? row.accountId;
    if (!id) return;
    const option = document.createElement('option');
    option.value = `account:${id}`;
    option.textContent = `${row.accountName ?? row.name ?? id} (${id})`;
    datasetSelect.append(option);
  });
  const exists = [...datasetSelect.options].some(option => option.value === preferredKey);
  datasetSelect.value = exists ? preferredKey : 'dataset:account_metadata';
}

async function readGridDataset(key) {
  if (key.startsWith('account:')) {
    const accountId = accountIdFromKey(key);
    state.accountId = accountId;
    const result = await readVersionedDataset(database, state.user.uid, 'account_sources', accountId);
    state.datasetId = accountId;
    state.collectionName = 'account_sources';
    state.metadata = result.metadata;
    state.brokerage = state.metadataRows.find(row => (row.id ?? row.accountId) === accountId)?.brokerage ?? '';
    state.headers = inferHeaders(result.rows, result.headers.length ? result.headers : accountHeaders(state.brokerage));
    state.rows = objectRowsToGrid(result.rows, state.headers, accountId);
    return;
  }
  const datasetId = key.slice('dataset:'.length);
  const result = await readVersionedDataset(database, state.user.uid, 'datasets', datasetId);
  state.datasetId = datasetId;
  state.collectionName = 'datasets';
  state.accountId = '';
  state.metadata = result.metadata;
  state.headers = inferHeaders(result.rows, result.headers.length ? result.headers : DEFAULT_HEADERS[datasetId]);
  state.rows = objectRowsToGrid(result.rows, state.headers, datasetId);
}

async function loadDataset(key, allowDiscard = false) {
  if (!allowDiscard && state.dirty && !window.confirm('Discard unsaved grid edits?')) {
    datasetSelect.value = state.selectedKey;
    return;
  }
  state.selectedKey = key;
  state.loadingDataset = true;
  datasetSelect.disabled = true;
  rememberDatasetKey(state.user.uid, key);
  state.datasetId = '';
  state.collectionName = '';
  state.accountId = '';
  state.brokerage = '';
  state.metadata = {};
  state.headers = [];
  state.rows = [];
  setDirty(false);
  renderGrid();
  setStatus(`Loading ${key.startsWith('account:') ? accountIdFromKey(key) : key.slice(8)}…`);
  try {
    await readGridDataset(key);
    if (!state.rows.length) state.rows.push(state.headers.map(() => ''));
    renderGrid();
    setDirty(false);
    const label = key.startsWith('account:') ? accountIdFromKey(key) : key.slice(8);
    const storedVersion = state.metadata.version ?? 0;
    setStatus(`${label}: ${state.rows.filter(row => row.some(value => value !== '')).length} rows · Firebase version ${storedVersion}.`);
    const isAccount = key.startsWith('account:');
    document.querySelector('#dataset-help').textContent = isAccount
      ? 'Paste CSV or tab-separated transactions from Excel or Google Sheets. Edit cells, add rows or columns, then submit to save this account source in Firebase.'
      : 'Edit cells directly or paste a range from Excel or Google Sheets. Add rows or columns as needed, then submit to save changes in Firebase.';
  } catch (error) {
    state.headers = [];
    state.rows = [];
    renderGrid();
    setDirty(false);
    const accountDenied = key.startsWith('account:')
      && (error.code === 'permission-denied' || error.code === 'firestore/permission-denied');
    setStatus(accountDenied
      ? `Could not load dataset: Firestore denied read access to users/${state.user.uid}/account_sources/${accountIdFromKey(key)} or its version/chunk documents. Publish owner-only rules for users/{uid}/account_sources (including nested versions/chunks) with request.auth.uid == uid.`
      : `Could not load dataset: ${errorMessage(error)}`, true);
  } finally {
    state.loadingDataset = false;
    datasetSelect.disabled = state.saving || state.notesSaving;
  }
}

function addColumn() {
  state.headers.push(`Column ${state.headers.length + 1}`);
  state.rows.forEach(row => row.push(''));
  setDirty(true);
  renderGrid();
  gridHeader.querySelectorAll('input').at(-1)?.focus();
}

function addRow() {
  state.rows.push(state.headers.map(() => ''));
  setDirty(true);
  renderGrid();
  gridBody.querySelector('tr:last-child input')?.focus();
}

function removeCompletelyBlankRows(rows) {
  return rows.filter(row => row.some(value => String(value ?? '').trim() !== ''));
}

function symbolsValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.every(symbol => typeof symbol === 'string')) return parsed;
    } catch {
      throw new Error('Symbols must be comma-separated, or a valid JSON array of strings.');
    }
  }
  return text.split(',').map(symbol => symbol.trim()).filter(Boolean);
}

function gridRowsForSave() {
  const rows = removeCompletelyBlankRows(state.rows);
  const savedRows = rows.map(cells => {
    const row = Object.fromEntries(state.headers.map((header, index) => [
      header.trim(),
      String(cells[index] ?? '').trim()
    ]));
    if (state.datasetId === 'sector_definitions') {
      Object.keys(row).forEach(key => {
        if (key !== 'sector' && key !== 'name') row[key] = symbolsValue(row[key]);
      });
    }
    if (state.datasetId === 'account_instantiations') {
      if (!row.accountId || !row.symbol || !row.mode) throw new Error('Each instantiation needs an accountId, symbol, and mode.');
      if (!['add', 'replace', 'set'].includes(row.mode)) throw new Error(`Invalid mode for ${row.accountId} ${row.symbol}; use add, replace, or set.`);
      for (const field of ['shares', 'total_cost_basis']) {
        const value = Number(row[field]);
        if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a nonnegative number for ${row.accountId} ${row.symbol}.`);
        row[field] = value;
      }
      if (row.shares === 0 && row.total_cost_basis !== 0) throw new Error(`Zero-share position ${row.accountId} ${row.symbol} must have zero cost basis.`);
      if (!row.effective_date) delete row.effective_date;
    }
    return row;
  });
  if (state.datasetId === 'account_metadata') {
    const ids = savedRows.map(row => row.id ?? row.accountId);
    if (ids.some(id => !id || id.includes('/'))) throw new Error('Each account metadata row needs an id without slashes.');
    if (new Set(ids).size !== ids.length) throw new Error('Account metadata IDs must be unique.');
    const reserved = new Set(['account_metadata', 'sector_definitions', 'account_instantiations', 'portfolio_total']);
    const collision = ids.find(id => reserved.has(id));
    if (collision) throw new Error(`${collision} is reserved and cannot be an account ID.`);
  }
  return savedRows;
}

function parsePastedRange(event) {
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!text.includes('\n') && !text.includes('\t')) return false;
  const records = parseDelimited(text);
  if (!records.length) return false;
  event.preventDefault();
  const target = event.target;
  const startRow = Number(target.dataset.rowIndex);
  const startColumn = Number(target.dataset.columnIndex);
  const firstRow = records[0].map(value => value.trim());
  const headersLikelyIncluded = startRow === 0 && startColumn === 0
    && firstRow.length > 1
    && (firstRow.some(value => ['Activity Date', 'Activity Type', 'Date', 'id', 'sector', 'accountId', 'mode'].includes(value))
      || firstRow.every((value, index) => normalizeHeader(value) === normalizeHeader(state.headers[index] ?? '')));
  const pastedRows = headersLikelyIncluded ? records.slice(1) : records;
  if (headersLikelyIncluded) {
    state.headers = firstRow;
    state.rows = [];
  }
  const width = Math.max(state.headers.length, startColumn + Math.max(...pastedRows.map(row => row.length), 0));
  while (state.headers.length < width) state.headers.push(`Column ${state.headers.length + 1}`);
  pastedRows.forEach((values, offset) => {
    const rowIndex = startRow + offset;
    while (state.rows.length <= rowIndex) state.rows.push(state.headers.map(() => ''));
    values.forEach((value, offsetColumn) => {
      state.rows[rowIndex][startColumn + offsetColumn] = value;
    });
  });
  state.rows.forEach(row => {
    while (row.length < state.headers.length) row.push('');
  });
  setDirty(true);
  renderGrid();
  gridBody.querySelector(`input[data-row-index="${startRow}"][data-column-index="${startColumn}"]`)?.focus();
  return true;
}

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function submitGrid() {
  if (state.saving || !state.dirty) return;
  const headers = state.headers.map(header => header.trim());
  if (!headers.length || headers.some(header => !header)) {
    setStatus('Column headers must not be blank.', true);
    return;
  }
  if (new Set(headers.map(normalizeHeader)).size !== headers.length) {
    setStatus('Column headers must be unique.', true);
    return;
  }
  setSaving(true);
  setStatus('Saving dataset to Firebase…');
  try {
    const rows = gridRowsForSave();
    const isSource = Boolean(state.accountId);
    const result = await writeVersionedDataset(
      database,
      state.user.uid,
      state.collectionName,
      state.datasetId,
      rows,
      {
        headers,
        metadata: isSource ? { brokerage: state.brokerage } : {}
      }
    );
    state.metadata = {
      ...state.metadata,
      version: result.version,
      activeVersionId: result.versionId,
      rowCount: result.rowCount
    };
    setDirty(false);
    const label = state.accountId || state.datasetId;
    setStatus(result.cleanupWarning
      ? `${label} saved as version ${result.version}. ${result.cleanupWarning}`
      : `${label} saved to Firebase as version ${result.version}.`);
    if (state.datasetId === 'account_metadata') {
      try {
        await refreshDatasetOptions();
      } catch (error) {
        setStatus(`${label} was saved, but account options could not be refreshed: ${errorMessage(error)}`, true);
      }
    }
  } catch (error) {
    setStatus(`Could not save dataset: ${errorMessage(error)}`, true);
  } finally {
    setSaving(false);
  }
}

async function refreshDatasetOptions() {
  const result = await readVersionedDataset(database, state.user.uid, 'datasets', 'account_metadata');
  state.metadataRows = result.rows;
  const selected = state.selectedKey;
  populateDatasetOptions(selected);
  if (![...datasetSelect.options].some(option => option.value === selected)) {
    state.selectedKey = datasetSelect.value;
    await loadDataset(state.selectedKey, true);
  }
}

function sourceVersion(data) {
  return { version: data.metadata.version ?? 0, versionId: data.metadata.activeVersionId ?? null };
}

function sameVersion(left, right) {
  return left.version === right.version && left.versionId === right.versionId;
}

async function readSourceDataset(accountId) {
  return readVersionedDataset(database, state.user.uid, 'account_sources', accountId);
}

async function getCurrentSources(accountRows, rulesDataset, metadataDataset) {
  const versions = {
    account_metadata: sourceVersion(metadataDataset),
    account_instantiations: sourceVersion(rulesDataset)
  };
  const sources = {};
  for (const account of accountRows) {
    const accountId = account.id ?? account.accountId;
    if (!accountId) continue;
    const source = await readSourceDataset(accountId);
    if (!source.exists || !source.rows.length) throw new Error(`No transaction CSV rows are saved for account ${accountId}. Paste and submit its transaction history first.`);
    sources[accountId] = source;
    versions[`account:${accountId}`] = sourceVersion(source);
  }
  return { versions, sources };
}

async function loadSymbolPrices() {
  const response = await fetch('./data/process_data/symbol_prices.csv');
  if (!response.ok) throw new Error(`Could not load the checked-in symbol price CSV (${response.status}).`);
  return parseSymbolPricesCsv(await response.text());
}

function makeBuildId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function verifySourcesUnchanged(expected, accountRows) {
  const currentMetadata = await readVersionedDataset(database, state.user.uid, 'datasets', 'account_metadata');
  const currentRules = await readVersionedDataset(database, state.user.uid, 'datasets', 'account_instantiations');
  if (!sameVersion(sourceVersion(currentMetadata), expected.account_metadata)
    || !sameVersion(sourceVersion(currentRules), expected.account_instantiations)) {
    throw new Error('Source datasets changed while aggregation was running. No portfolio summary was published; run Build portfolio data again.');
  }
  for (const account of accountRows) {
    const accountId = account.id ?? account.accountId;
    const current = await readSourceDataset(accountId);
    if (!sameVersion(sourceVersion(current), expected[`account:${accountId}`])) {
      throw new Error(`The ${accountId} transaction source changed while aggregation was running. No portfolio summary was published; run the build again.`);
    }
  }
}

async function buildPortfolioData() {
  if (state.saving) return;
  if (state.dirty && !window.confirm('You have unsaved grid edits. Build using the last saved Firebase data?')) return;
  setSaving(true);
  setStatus('Loading source data and prices…');
  const buildId = makeBuildId();
  let buildLockAcquired = false;
  try {
    await acquirePortfolioBuildLock(database, state.user.uid, buildId);
    buildLockAcquired = true;
    const metadataDataset = await readVersionedDataset(database, state.user.uid, 'datasets', 'account_metadata');
    const accountRows = metadataDataset.rows.filter(row => row && typeof row === 'object' && (row.id ?? row.accountId));
    if (!accountRows.length) throw new Error('Add account rows to account_metadata before building portfolio data.');
    const rulesDataset = await readVersionedDataset(database, state.user.uid, 'datasets', 'account_instantiations');
    const accountIds = new Set(accountRows.map(row => row.id ?? row.accountId));
    const orphanRule = rulesDataset.rows.find(rule => rule.accountId && !accountIds.has(rule.accountId));
    if (orphanRule) throw new Error(`Instantiation rule for ${orphanRule.accountId} is not listed in account_metadata.`);
    const { versions, sources } = await getCurrentSources(accountRows, rulesDataset, metadataDataset);
    const priceRows = await loadSymbolPrices();
    const accountLedgers = {};
    const accountOutputVersions = {};
    const rules = rulesDataset.rows;
    for (const account of accountRows) {
      const accountId = account.id ?? account.accountId;
      setStatus(`Processing ${account.accountName ?? accountId}…`);
      accountLedgers[accountId] = processAccountCsv(
        accountId,
        {
          headers: sources[accountId].headers,
          rows: sources[accountId].rows,
          brokerage: account.brokerage ?? sources[accountId].metadata.brokerage
        },
        priceRows,
        rules
      );
    }

    setStatus('Aggregating portfolio performance…');
    const portfolioRows = aggregatePortfolio(accountLedgers, priceRows);
    for (const accountId of Object.keys(accountLedgers)) {
      setStatus(`Uploading generated ledger for ${accountId}…`);
      const rows = accountLedgers[accountId];
      const result = await writeVersionedDataset(
        database,
        state.user.uid,
        'datasets',
        accountId,
        rows,
        {
          headers: [...new Set(rows.flatMap(row => Object.keys(row)))],
          deferCleanup: true,
          metadata: { buildId, sourceDatasetVersions: versions }
        }
      );
      accountOutputVersions[accountId] = { version: result.version, versionId: result.versionId };
    }

    await verifySourcesUnchanged(versions, accountRows);
    setStatus('Publishing portfolio summary…');
    const portfolioResult = await writeVersionedDataset(
      database,
      state.user.uid,
      'datasets',
      'portfolio_total',
      portfolioRows,
      {
        headers: Object.keys(portfolioRows[0] ?? {}),
        deferCleanup: true,
        metadata: { buildId, sourceDatasetVersions: versions, accountOutputVersions }
      }
    );

    const cleanupIds = [...Object.keys(accountOutputVersions), 'portfolio_total'];
    const cleanupResults = await Promise.allSettled(cleanupIds.map(datasetId =>
      cleanupDatasetVersions(database, state.user.uid, 'datasets', datasetId,
        datasetId === 'portfolio_total' ? portfolioResult.versionId : accountOutputVersions[datasetId].versionId)));
    const cleanupFailures = cleanupResults.filter(result => result.status === 'rejected');
    setStatus(cleanupFailures.length
      ? `Portfolio built successfully, but cleanup of ${cleanupFailures.length} old dataset version(s) failed. ${errorMessage(cleanupFailures[0].reason)}`
      : `Portfolio data built successfully for ${Object.keys(accountLedgers).length} accounts. Return to the portfolio overview to see the updated data.`);
  } catch (error) {
    setStatus(`Portfolio build failed: ${errorMessage(error)}`, true);
  } finally {
    if (buildLockAcquired) {
      try {
        await releasePortfolioBuildLock(database, state.user.uid, buildId);
      } catch (error) {
        setStatus(`${statusElement.textContent} Firestore build lock could not be released: ${errorMessage(error)}`, true);
      }
    }
    setSaving(false);
  }
}

document.querySelector('#add-grid-row').addEventListener('click', addRow);
document.querySelector('#add-grid-column').addEventListener('click', addColumn);
saveButton.addEventListener('click', submitGrid);
buildButton.addEventListener('click', buildPortfolioData);
datasetSelect.addEventListener('change', () => loadDataset(datasetSelect.value));
document.querySelector('#dataset-tab').addEventListener('click', () => setInputTab('dataset'));
document.querySelector('#notes-tab').addEventListener('click', () => setInputTab('notes'));
notesTextarea.addEventListener('input', () => setNotesDirty(true));
notesSaveButton.addEventListener('click', submitNotes);
document.querySelector('#input-grid').addEventListener('paste', event => {
  if (!event.target.matches('.input-grid-cell')) return;
  try {
    parsePastedRange(event);
  } catch (error) {
    event.preventDefault();
    setStatus(`Could not paste spreadsheet cells: ${error.message}`, true);
  }
});
document.querySelector('#sign-out-button').addEventListener('click', () => {
  setStatus();
  signOut(auth).catch(error => setStatus(`Sign-out failed: ${errorMessage(error)}`, true));
});

async function onUser(user) {
  state.user = user;
  document.querySelector('#sign-out-button').hidden = !user;
  document.querySelector('#signed-in-email').textContent = user?.email ?? '';
  document.querySelector('#auth-gate').hidden = Boolean(user);
  document.querySelector('#input-page').hidden = !user;
  if (!user) {
    resetInputDataNotes();
    setStatus('No active portfolio session was found. Sign in on the overview page, then open Input Data.', true);
    return;
  }
  let notesLoadError;
  try {
    await loadInputDataNotes();
  } catch (error) {
    notesLoadError = error;
    renderInputDataNotesError(error);
  }
  try {
    const metadata = await readVersionedDataset(database, user.uid, 'datasets', 'account_metadata');
    state.metadataRows = metadata.rows;
    populateDatasetOptions(preferredDatasetKey(user.uid));
    await loadDataset(datasetSelect.value, true);
  } catch (error) {
    setStatus(`Could not load datasets: ${errorMessage(error)}`, true);
  }
  if (notesLoadError) setStatus(`Could not load Input Data notes: ${errorMessage(notesLoadError)}`, true);
}

setStatus('Restoring portfolio sign-in…');
authPersistenceReady.then(() => onAuthStateChanged(auth, onUser, error => {
  setStatus(`Firebase Auth state failed: ${errorMessage(error)}`, true);
})).catch(error => {
  document.querySelector('#auth-gate').hidden = false;
  setStatus(`Firebase Auth persistence failed: ${errorMessage(error)}`, true);
});
