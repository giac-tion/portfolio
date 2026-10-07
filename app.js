import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { collection, doc, getDoc, getDocs, getFirestore } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCjrpdzRYFcnvGMoFg8PHY3EppYS7eTYCc',
  authDomain: 'portfolio-36344.firebaseapp.com',
  projectId: 'portfolio-36344',
  storageBucket: 'portfolio-36344.firebasestorage.app',
  messagingSenderId: '13344479629',
  appId: '1:13344479629:web:1e9a9c95f855d2d71685c4'
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const database = getFirestore(firebaseApp);
const provider = new GoogleAuthProvider();
const chartInstances = {};
const accountColors = ['#235c48', '#56b98a', '#e8896b', '#82b7c5', '#f5c85d', '#4776d0', '#b86f4b', '#609b79', '#8a9e47', '#637b8a'];
const sectorColors = ['#235c48', '#e8896b', '#4776d0', '#d19a28', '#56b98a', '#b86f4b', '#82b7c5', '#8a9e47', '#637b8a', '#b86b83'];
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const moneyExact = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value ?? 0);
const valueOrNull = value => Number.isFinite(value) ? value : null;

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function rowDate(row) {
  const value = row.date ?? row.Date;
  if (!value) return null;
  const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function orderedRows(rows) {
  return rows.map(row => ({ row, date: rowDate(row) }))
    .filter(item => item.date)
    .sort((left, right) => left.date - right.date);
}

function getField(row, ...names) {
  for (const name of names) {
    if (row[name] !== undefined) return row[name];
  }
  const normalizedNames = new Set(names.map(name => name.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const match = Object.entries(row).find(([name]) => normalizedNames.has(name.toLowerCase().replace(/[^a-z0-9]/g, '')));
  return match?.[1] ?? null;
}

function portfolioModel(rows) {
  let previousCumulativeReturn = null;
  return orderedRows(rows ?? []).map(({ row, date }) => {
    const cumulativeReturn = numeric(getField(row, 'cumulative_return', 'Cumulative Return $'));
    const reportedDailyReturn = numeric(getField(row,
      'cb_adj_daily_return', 'CB-Adj Daily return', 'CB-Adj Daily Return', 'daily_return', 'Daily Return'));
    const point = {
      date,
      value: numeric(getField(row, 'portfolio_value', 'Portfolio Value')),
      cumulativeReturn,
      cbAdjReturn: numeric(getField(row, 'cb_adj_return', 'CB-adj. Return')),
      spy: numeric(getField(row, 'spy', 'Spy')),
      alpha: numeric(getField(row, 'alpha', 'Alpha')),
      dailyAlpha: numeric(getField(row, 'alpha_daily_cbadj', 'Alpha Daily - cbadj')),
      dailyReturn: reportedDailyReturn ?? (cumulativeReturn !== null && previousCumulativeReturn !== null
        ? cumulativeReturn - previousCumulativeReturn
        : null)
    };
    previousCumulativeReturn = cumulativeReturn;
    return point;
  });
}

async function fetchSpyPrices(portfolio) {
  if (!portfolio.length) return [];
  const firstDate = portfolio[0].date;
  const lastDate = portfolio[portfolio.length - 1].date;
  const start = Math.floor((firstDate.getTime() - 86400000) / 1000);
  const end = Math.ceil((lastDate.getTime() + 86400000) / 1000);
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=${start}&period2=${end}&interval=1d`;

  try {
    const response = await fetch(yahooUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Yahoo Finance returned ${response.status}`);
    const result = (await response.json()).chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const prices = (result?.timestamp ?? []).flatMap((timestamp, index) => {
      const close = numeric(closes[index]);
      return close === null ? [] : [{ date: new Date(timestamp * 1000), close }];
    });
    if (prices.length) return prices;
  } catch (error) {
    console.warn('Unable to load SPY prices from Yahoo Finance; using the local price file.', error);
  }

  try {
    const response = await fetch('./data/process_data/symbol_prices.csv');
    if (!response.ok) throw new Error(`Local price file returned ${response.status}`);
    const [header, ...lines] = (await response.text()).trim().split(/\r?\n/);
    const columns = header.split(',');
    const dateColumn = columns.indexOf('Date');
    const spyColumn = columns.indexOf('SPY');
    if (dateColumn < 0 || spyColumn < 0) return [];
    return lines.flatMap(line => {
      const fields = line.split(',');
      const close = numeric(fields[spyColumn]);
      const date = new Date(`${fields[dateColumn]}T00:00:00Z`);
      return close === null || Number.isNaN(date.getTime()) ? [] : [{ date, close }];
    });
  } catch (error) {
    console.warn('Unable to load the local SPY price file.', error);
    return [];
  }
}

function spyCumulativeReturns(portfolio, prices) {
  if (!prices.length) return portfolio.map(point => point.spy);
  const orderedPrices = [...prices].sort((left, right) => left.date - right.date);
  let priceIndex = 0;
  let latestClose = null;
  let baseClose = null;
  return portfolio.map(point => {
    while (priceIndex < orderedPrices.length && orderedPrices[priceIndex].date <= point.date) {
      latestClose = orderedPrices[priceIndex].close;
      priceIndex += 1;
    }
    if (latestClose === null) return null;
    if (baseClose === null) baseClose = latestClose;
    return baseClose > 0 ? (latestClose / baseClose - 1) * 100 : null;
  });
}

function accountPositions(row) {
  return Object.entries(row).flatMap(([key, value]) => {
    if (key.endsWith('_px')) {
      const symbol = key.slice(0, -3);
      return [{
        symbol,
        shares: numeric(row[symbol]),
        price: numeric(value),
        averageCost: numeric(row[`${symbol}_cb`])
      }];
    }
    if (value && typeof value === 'object' && !Array.isArray(value)
      && ('shares' in value || 'px' in value || 'avg_cb' in value)) {
      return [{
        symbol: key,
        shares: numeric(value.shares),
        price: numeric(value.px),
        averageCost: numeric(value.avg_cb)
      }];
    }
    return [];
  });
}

function positionValues(row) {
  return accountPositions(row).reduce((values, holding) => {
    if (holding.shares !== null && holding.shares !== 0 && holding.price !== null) {
      values[holding.symbol] = holding.shares * holding.price;
    }
    return values;
  }, {});
}

function accountModel(name, rows) {
  const ordered = orderedRows(rows).map(({ row, date }) => ({
    row,
    date,
    value: numeric(row.daily_acct_total)
  }));
  const latest = ordered[ordered.length - 1] ?? { row: {}, date: null, value: null };
  const holdings = accountPositions(latest.row)
    .map(({ symbol, shares, price, averageCost }) => ({
      symbol,
      shares,
      averageCost,
      price,
      marketValue: shares !== null && price !== null ? shares * price : null,
      gain: shares !== null && price !== null && averageCost !== null ? shares * (price - averageCost) : null
    }))
    .filter(holding => holding.shares !== null && holding.shares !== 0)
    .sort((left, right) => right.marketValue - left.marketValue);
  const currentValue = latest.value ?? (holdings.length && holdings.every(item => item.marketValue !== null)
    ? holdings.reduce((total, item) => total + item.marketValue, 0)
    : null);
  const costBasis = numeric(latest.row.daily_acct_total_cb) ?? (holdings.length && holdings.every(item => item.averageCost !== null)
    ? holdings.reduce((total, item) => total + item.shares * item.averageCost, 0)
    : null);

  return {
    id: name,
    displayName: name.replace('_', ' '),
    brokerage: '',
    accountType: '',
    latestDate: latest.date,
    currentValue,
    costBasis,
    returnPercent: currentValue !== null && costBasis > 0 ? (currentValue / costBasis - 1) * 100 : null,
    history: ordered.map(point => ({ date: point.date, value: valueOrNull(point.value), positionValues: positionValues(point.row) })),
    holdings
  };
}

async function readDataset(uid, name) {
  const reference = doc(database, 'users', uid, 'datasets', name);
  const snapshot = await getDoc(reference);
  if (!snapshot.exists()) return null;
  const dataset = snapshot.data();
  let rows = Array.isArray(dataset.rows) ? dataset.rows : [];
  if (dataset.chunked) {
    const chunkSnapshots = await getDocs(collection(reference, 'chunks'));
    rows = chunkSnapshots.docs
      .map(chunk => chunk.data())
      .sort((left, right) => left.chunkIndex - right.chunkIndex)
      .flatMap(chunk => Array.isArray(chunk.rows) ? chunk.rows : []);
  }
  return {
    rows,
    updatedAt: dataset.updatedAt?.toDate?.() ?? snapshot.updateTime?.toDate?.() ?? null
  };
}

function normalizeSectorDefinitions(rows = []) {
  const definitions = {};
  rows.forEach(row => {
    if (!row || typeof row !== 'object') return;
    const sector = row.sector ?? row.name;
    if (typeof sector === 'string' && Array.isArray(row.symbols)) {
      definitions[sector] = row.symbols.filter(symbol => typeof symbol === 'string' && symbol.trim()).map(symbol => symbol.trim());
      return;
    }
    Object.entries(row).forEach(([name, symbols]) => {
      if (Array.isArray(symbols)) {
        definitions[name] = symbols.filter(symbol => typeof symbol === 'string' && symbol.trim()).map(symbol => symbol.trim());
      }
    });
  });
  if (!Array.isArray(definitions.Other)) definitions.Other = [];
  return definitions;
}

async function loadData(uid) {
  const [portfolioTotal, accountMetadata, sectorDefinitions] = await Promise.all(
    ['portfolio_total', 'account_metadata', 'sector_definitions'].map(name => readDataset(uid, name))
  );
  const metadataRows = accountMetadata?.rows ?? [];
  const metadataById = Object.fromEntries(metadataRows.map(row => [row.id ?? row.accountId, row]));
  const accountNames = Object.keys(metadataById).filter(Boolean);
  const accountDatasets = await Promise.all(
    accountNames.map(async name => [name, await readDataset(uid, name)])
  );
  const accounts = accountDatasets
    .filter(([, dataset]) => dataset)
    .map(([name, dataset]) => {
      const account = accountModel(name, dataset.rows);
      const metadata = metadataById[name] ?? {};
      return {
        ...account,
        displayName: metadata.accountName ?? metadata.name ?? account.displayName,
        brokerage: metadata.brokerage ?? '',
        accountType: metadata.accountType ?? metadata.type ?? ''
      };
    });
  const allDatasets = [portfolioTotal, accountMetadata, sectorDefinitions, ...accountDatasets.map(([, dataset]) => dataset)];
  const portfolio = portfolioModel(portfolioTotal?.rows);
  const spyPrices = await fetchSpyPrices(portfolio);
  return {
    portfolio,
    spyPrices,
    accounts,
    sectorDefinitions: normalizeSectorDefinitions(sectorDefinitions?.rows),
    updatedAt: allDatasets.map(dataset => dataset?.updatedAt).filter(Boolean).sort((a, b) => b - a)[0] ?? null
  };
}

function setNotice(message = '') {
  const notice = document.querySelector('#notice');
  notice.textContent = message;
  notice.hidden = !message;
}

function setPrivateValue(element, value) {
  if (value === '') {
    delete element.dataset.privateValue;
    element.textContent = '';
    return;
  }
  element.dataset.privateValue = value;
  element.textContent = state.hideAmounts ? '••••••' : value;
}

function applyPrivateValues() {
  document.querySelectorAll('[data-private-value]:not([data-private-value=""])').forEach(element => {
    element.textContent = state.hideAmounts ? '••••••' : element.dataset.privateValue;
  });
}

function updateAmountVisibility() {
  applyPrivateValues();
  const toggle = document.querySelector('#amount-visibility-toggle');
  toggle.setAttribute('aria-pressed', String(state.hideAmounts));
  toggle.setAttribute('aria-label', `${state.hideAmounts ? 'Show' : 'Hide'} dollar amounts`);
  toggle.title = `${state.hideAmounts ? 'Show' : 'Hide'} dollar amounts`;
  Object.values(chartInstances).forEach(chart => chart.update());
}

function destroyChart(name) {
  if (chartInstances[name]) {
    chartInstances[name].destroy();
    delete chartInstances[name];
  }
}

function chartOptions(formatter, extra = {}, type = 'line') {
  const formatValue = value => state.hideAmounts && formatter === moneyExact ? '••••••' : formatter(value);
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', align: 'start', labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8 } },
      tooltip: { callbacks: { label: context => `${context.dataset.label}: ${formatValue(context.parsed.y)}` } }
    }
  };
  if (type !== 'doughnut') {
    options.scales = {
      x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, color: '#748078' } },
      y: { grid: { color: '#e4e9e4' }, ticks: { color: '#748078', callback: value => formatValue(value) } }
    };
  }
  return { ...options, ...extra };
}

function makeChart(name, canvasId, type, labels, datasets, formatter, extra = {}) {
  destroyChart(name);
  if (!labels.length || !datasets.some(dataset => dataset.data.some(value => Number.isFinite(value)))) return;
  const canvas = document.getElementById(canvasId);
  chartInstances[name] = new Chart(canvas, {
    type,
    data: { labels, datasets },
    options: chartOptions(formatter, extra, type),
    plugins: type === 'doughnut' ? [centerTextPlugin] : []
  });
}

const centerTextPlugin = {
  id: 'accountTotal',
  beforeDraw(chart) {
    const values = chart.data.datasets[0]?.data ?? [];
    const total = values.reduce((sum, value) => sum + (numeric(value) ?? 0), 0);
    const { ctx, chartArea } = chart;
    if (!chartArea || !total) return;
    const x = (chartArea.left + chartArea.right) / 2;
    const y = (chartArea.top + chartArea.bottom) / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#17211c';
    ctx.font = '700 15px Manrope, sans-serif';
    ctx.fillText(state.hideAmounts ? '••••••' : moneyExact(total), x, y);
    ctx.restore();
  }
};

function lineDataset(label, data, color, extra = {}) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    pointRadius: 0,
    pointHitRadius: 8,
    tension: 0.16,
    spanGaps: false,
    ...extra
  };
}

function barDataset(label, data, color) {
  return { label, data, backgroundColor: color, borderColor: color, borderWidth: 0, barPercentage: 0.85, categoryPercentage: 0.95 };
}

function aggregateHoldings(accounts, portfolioValue) {
  const holdingsBySymbol = new Map();
  accounts.forEach(account => account.holdings.forEach(holding => {
    const item = holdingsBySymbol.get(holding.symbol) ?? {
      symbol: holding.symbol,
      shares: 0,
      accountShares: {},
      costBasis: 0,
      marketValue: 0,
      costBasisComplete: true,
      marketValueComplete: true
    };
    item.shares += holding.shares;
    item.accountShares[account.id] = holding.shares;
    if (holding.averageCost === null) item.costBasisComplete = false;
    else item.costBasis += holding.shares * holding.averageCost;
    if (holding.marketValue === null) item.marketValueComplete = false;
    else item.marketValue += holding.marketValue;
    holdingsBySymbol.set(holding.symbol, item);
  }));
  return [...holdingsBySymbol.values()].map(item => {
    const costBasis = item.costBasisComplete ? item.costBasis : null;
    const marketValue = item.marketValueComplete ? item.marketValue : null;
    return {
      ...item,
      costBasis,
      marketValue,
      gain: marketValue !== null && costBasis !== null ? marketValue - costBasis : null,
      portfolioPercent: marketValue !== null && portfolioValue > 0 ? marketValue / portfolioValue * 100 : null
    };
  }).sort((left, right) => (right.marketValue ?? -Infinity) - (left.marketValue ?? -Infinity));
}

function renderHoldingsTable(accounts, holdings) {
  document.querySelector('#holdings-header').innerHTML = `<tr><th>Symbol</th>${accounts.map(account => `<th>${account.displayName}</th>`).join('')}<th>Total shares</th><th>Cost basis</th><th>Current value</th><th><div class="gain-heading"><span>Gain / loss</span><div class="gain-toggle" role="group" aria-label="Gain or loss display"><button type="button" data-gain-mode="dollars" aria-pressed="${state.holdingsGainMode === 'dollars'}" title="Show gain or loss in dollars">$</button><button type="button" data-gain-mode="percent" aria-pressed="${state.holdingsGainMode === 'percent'}" title="Show gain or loss as a percentage">%</button></div></div></th><th>Portfolio %</th></tr>`;
  document.querySelector('#holdings-table').innerHTML = holdings.map((holding, index) => {
    const gainPercent = holding.gain !== null && holding.costBasis > 0 ? holding.gain / holding.costBasis * 100 : null;
    const gainText = state.holdingsGainMode === 'percent'
      ? (gainPercent === null ? '' : `${gainPercent > 0 ? '+' : ''}${gainPercent.toFixed(1)}%`)
      : (holding.gain === null ? '' : moneyExact(holding.gain));
    const accountShareCells = accounts.map(account => {
      const shares = holding.accountShares[account.id] ?? 0;
      return `<td>${shares ? numberFormat.format(shares) : '-'}</td>`;
    }).join('');
    const portfolioPercent = holding.portfolioPercent === null ? '' : `${holding.portfolioPercent.toFixed(1)}%`;
    const gainSortValue = state.holdingsGainMode === 'percent' ? gainPercent ?? '' : holding.gain ?? '';
    return `<tr data-original-index="${index}"><td class="ticker">${holding.symbol}</td>${accountShareCells}<td data-sort-value="${holding.shares}">${numberFormat.format(holding.shares)}</td><td>${holding.costBasis === null ? '' : moneyExact(holding.costBasis)}</td><td>${holding.marketValue === null ? '' : moneyExact(holding.marketValue)}</td><td data-sort-value="${gainSortValue}">${gainText}</td><td data-sort-value="${holding.portfolioPercent ?? ''}">${portfolioPercent}</td></tr>`;
  }).join('');
  resetTableSort(document.querySelector('#holdings-table-view'));
}

function buildSectorData(portfolio, accounts, holdings, sectorDefinitions) {
  const sectorBySymbol = new Map(Object.entries(sectorDefinitions).flatMap(([sector, symbols]) => symbols.map(symbol => [symbol, sector])));
  const portfolioValue = [...portfolio].reverse().find(point => point.value !== null)?.value ?? null;
  const currentValues = Object.fromEntries(Object.keys(sectorDefinitions).map(sector => [sector, {}]));
  holdings.forEach(holding => {
    if (holding.marketValue === null) return;
    const sector = sectorBySymbol.get(holding.symbol) ?? 'Other';
    currentValues[sector][holding.symbol] = holding.marketValue;
  });
  const pricedHoldingsValue = holdings.reduce((total, holding) => total + (holding.marketValue ?? 0), 0);
  if (portfolioValue !== null && portfolioValue > pricedHoldingsValue) {
    currentValues.Other['Unallocated'] = portfolioValue - pricedHoldingsValue;
  }

  const sectors = Object.entries(sectorDefinitions).map(([name, symbols], index) => {
    const symbolValues = currentValues[name];
    const displaySymbols = name === 'Other'
      ? Object.keys(symbolValues).sort((left, right) => (symbolValues[right] ?? 0) - (symbolValues[left] ?? 0))
      : symbols;
    const rows = displaySymbols.map(symbol => ({ symbol, value: symbolValues[symbol] ?? 0 }));
    const marketValue = rows.reduce((total, row) => total + row.value, 0);
    return { name, color: sectorColors[index], symbols: displaySymbols, rows, marketValue };
  });

  const historyIndexes = accounts.map(() => -1);
  const history = portfolio.filter(point => point.value !== null).map(point => {
    const values = Object.fromEntries(Object.keys(sectorDefinitions).map(sector => [sector, 0]));
    let pricedValue = 0;
    accounts.forEach((account, accountIndex) => {
      const accountHistory = account.history;
      while (historyIndexes[accountIndex] + 1 < accountHistory.length
        && accountHistory[historyIndexes[accountIndex] + 1].date <= point.date) {
        historyIndexes[accountIndex] += 1;
      }
      const accountPoint = accountHistory[historyIndexes[accountIndex]];
      if (!accountPoint) return;
      Object.entries(accountPoint.positionValues).forEach(([symbol, value]) => {
        const sector = sectorBySymbol.get(symbol) ?? 'Other';
        values[sector] += value;
        pricedValue += value;
      });
    });
    if (point.value > pricedValue) values.Other += point.value - pricedValue;
    const total = Object.values(values).reduce((sum, value) => sum + value, 0);
    return { date: point.date, total, values };
  });

  return { portfolioValue, sectors, history };
}

function renderSectorBreakdowns(sectors, portfolioValue) {
  document.querySelector('#sector-detail-grid').innerHTML = sectors.map((sector, index) => `
    <article class="panel sector-detail-panel">
      <div class="panel-heading"><div><h3>${sector.name}</h3></div><strong class="sector-total">${moneyExact(sector.marketValue)}</strong></div>
      <div class="sector-detail-body">
        <div class="sector-symbol-chart-wrap"><canvas id="sector-symbol-chart-${index}" role="img" aria-label="${sector.name} symbol allocation"></canvas></div>
        <div class="table-scroll"><table><thead><tr><th>Symbol</th><th>Total value</th><th>Sector %</th><th>Portfolio %</th></tr></thead><tbody>
          ${sector.rows.map(row => {
            const sectorPercent = sector.marketValue > 0 ? row.value / sector.marketValue * 100 : 0;
            const portfolioPercent = portfolioValue > 0 ? row.value / portfolioValue * 100 : 0;
            return `<tr><td class="ticker">${row.symbol}</td><td>${moneyExact(row.value)}</td><td>${sectorPercent.toFixed(1)}%</td><td>${portfolioPercent.toFixed(1)}%</td></tr>`;
          }).join('')}
        </tbody></table></div>
      </div>
    </article>`).join('');
}

function renderSectorCharts(sectorData) {
  const { sectors, history, portfolioValue } = sectorData;
  makeChart('sectorPortfolio', 'sector-portfolio-chart', 'doughnut', sectors.map(sector => sector.name), [
    { data: sectors.map(sector => sector.marketValue), backgroundColor: sectors.map(sector => sector.color), borderWidth: 0, hoverOffset: 4 }
  ], moneyExact, { cutout: '68%', plugins: { legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8, padding: 12 } } } });

  const historyLabels = history.map(point => point.date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }));
  makeChart('sectorHistory', 'sector-history-chart', 'line', historyLabels, sectors.map(sector => lineDataset(
    sector.name,
    history.map(point => point.total > 0 ? point.values[sector.name] / point.total * 100 : 0),
    sector.color,
    { fill: 'stack', borderWidth: 1, pointRadius: 0, stack: 'sectors' }
  )), value => `${Number(value).toFixed(1)}%`, {
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, color: '#748078' } },
      y: { stacked: true, min: 0, max: 100, grid: { color: '#e4e9e4' }, ticks: { color: '#748078', callback: value => `${value}%` } }
    },
    elements: { line: { tension: 0 } }
  });

  sectors.forEach((sector, index) => makeChart(`sectorSymbols${index}`, `sector-symbol-chart-${index}`, 'doughnut',
    sector.rows.map(row => row.symbol), [
      { data: sector.rows.map(row => row.value), backgroundColor: sector.rows.map((_, symbolIndex) => sectorColors[(index + symbolIndex) % sectorColors.length]), borderWidth: 0, hoverOffset: 3 }
    ], moneyExact, { cutout: '68%', plugins: { legend: { display: false } } }));
}

function resetTableSort(table) {
  if (!table) return;
  delete table.dataset.sortColumn;
  delete table.dataset.sortDirection;
  table.querySelectorAll('thead th').forEach(header => {
    header.tabIndex = 0;
    header.setAttribute('aria-sort', 'none');
  });
  const body = table.tBodies[0];
  if (body) [...body.rows].sort((left, right) => Number(left.dataset.originalIndex) - Number(right.dataset.originalIndex)).forEach(row => body.append(row));
}

function applyTableSort(table, column, direction) {
  const body = table.tBodies[0];
  if (!body) return;
  const rows = [...body.rows];
  rows.forEach((row, index) => {
    if (row.dataset.originalIndex === undefined) row.dataset.originalIndex = String(index);
  });
  const multiplier = direction === 'ascending' ? 1 : -1;
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  rows.sort((left, right) => {
    const leftCell = left.cells[column];
    const rightCell = right.cells[column];
    const leftValue = leftCell?.dataset.sortValue ?? leftCell?.textContent.trim() ?? '';
    const rightValue = rightCell?.dataset.sortValue ?? rightCell?.textContent.trim() ?? '';
    const leftNumber = leftValue && leftValue !== '-' ? Number(leftValue.replace(/[$,%\s,]/g, '')) : NaN;
    const rightNumber = rightValue && rightValue !== '-' ? Number(rightValue.replace(/[$,%\s,]/g, '')) : NaN;
    const leftEmpty = !leftValue || leftValue === '-';
    const rightEmpty = !rightValue || rightValue === '-';
    if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
    const comparison = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
      ? leftNumber - rightNumber
      : collator.compare(leftValue, rightValue);
    return comparison ? comparison * multiplier : Number(left.dataset.originalIndex) - Number(right.dataset.originalIndex);
  });
  rows.forEach(row => body.append(row));
}

function sortTableByHeader(table, header) {
  const column = header.cellIndex;
  const currentColumn = Number(table.dataset.sortColumn);
  if (currentColumn === column && table.dataset.sortDirection === 'ascending') {
    resetTableSort(table);
    return;
  }
  const direction = currentColumn !== column || table.dataset.sortDirection !== 'descending' ? 'descending' : 'ascending';
  table.dataset.sortColumn = String(column);
  table.dataset.sortDirection = direction;
  table.querySelectorAll('thead th').forEach(item => item.setAttribute('aria-sort', item === header ? direction : 'none'));
  applyTableSort(table, column, direction);
}

function renderPortfolio(data) {
  const { portfolio, accounts, sectorDefinitions } = data;
  const aggregateRows = portfolio.filter(point => point.value !== null);
  const latestPortfolio = aggregateRows[aggregateRows.length - 1];
  const marketValue = latestPortfolio?.value ?? null;
  const totalGain = latestPortfolio?.cumulativeReturn ?? null;
  const contributions = marketValue !== null && totalGain !== null ? marketValue - totalGain : null;
  const totalReturn = latestPortfolio?.cbAdjReturn ?? null;
  const moneyText = value => value === null ? '' : moneyExact(value);
  const percentText = value => value === null ? '' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;

  document.querySelector('#account-count').textContent = accounts.length ? `${accounts.length} accounts` : '';
  setPrivateValue(document.querySelector('#metric-market-value'), moneyText(marketValue));
  setPrivateValue(document.querySelector('#metric-contributions'), moneyText(contributions));
  setPrivateValue(document.querySelector('#metric-total-gain'), moneyText(totalGain));
  document.querySelector('#metric-total-gain').classList.toggle('negative', totalGain !== null && totalGain < 0);
  document.querySelector('#metric-blended-return').textContent = percentText(totalReturn);
  document.querySelector('#metric-blended-return').classList.toggle('negative', totalReturn !== null && totalReturn < 0);
  document.querySelector('#summary-note').textContent = data.updatedAt
    ? `Updated ${data.updatedAt.toISOString().slice(0, 10)}`
    : '';

  const historyLabels = aggregateRows.map(point => point.date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }));
  makeChart('portfolioValue', 'portfolio-value-chart', 'line', historyLabels, [
    lineDataset('Portfolio value', aggregateRows.map(point => point.value), '#235c48', {
      borderWidth: 2.5,
      fill: true,
      backgroundColor: 'rgba(86, 185, 138, .14)'
    })
  ], moneyExact, { plugins: { legend: { display: false } } });

  const accountsWithValue = accounts.filter(account => account.currentValue !== null);
  makeChart('accounts', 'accounts-chart', 'doughnut', accountsWithValue.map(account => account.displayName), [
    { data: accountsWithValue.map(account => account.currentValue), backgroundColor: accountsWithValue.map((_, index) => accountColors[index % accountColors.length]), borderWidth: 0, hoverOffset: 4 }
  ], moneyExact, { cutout: '68%', plugins: { legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8, padding: 12 } } } });

  const labels = portfolio.map(point => point.date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }));
  const spyReturns = spyCumulativeReturns(portfolio, data.spyPrices ?? []);
    const firstReturnPoint = portfolio.find(point => point.value !== null && point.cumulativeReturn !== null);
    const initialPortfolioValue = firstReturnPoint ? firstReturnPoint.value - firstReturnPoint.cumulativeReturn : null;
  makeChart('returns', 'returns-chart', 'line', labels, [
      lineDataset('Cumulative return', portfolio.map(point => initialPortfolioValue && point.cumulativeReturn !== null ? point.cumulativeReturn / initialPortfolioValue * 100 : null), '#4776d0'),
    lineDataset('CB-adjusted return', portfolio.map(point => point.cbAdjReturn), '#235c48'),
    lineDataset('S&P 500', spyReturns, '#e8896b')
  ], value => `${Number(value).toFixed(1)}%`);
  makeChart('alpha', 'alpha-chart', 'line', labels, [
    lineDataset('Cumulative alpha', portfolio.map(point => point.alpha), '#4776d0')
  ], value => `${Number(value).toFixed(1)}%`, { plugins: { legend: { display: false } } });
  makeChart('dailyAlpha', 'daily-alpha-chart', 'bar', labels, [
    barDataset('Daily alpha', portfolio.map(point => point.dailyAlpha), '#56b98a')
  ], value => `${Number(value).toFixed(2)}%`, { plugins: { legend: { display: false } } });
  makeChart('dailyReturn', 'daily-return-chart', 'bar', labels, [
    barDataset('Daily return', portfolio.map(point => point.dailyReturn), '#e8896b')
  ], moneyExact, { plugins: { legend: { display: false } } });

  const accountSelect = document.querySelector('#account-select');
  accountSelect.innerHTML = accounts.map(account => `<option value="${account.id}">${account.displayName}</option>`).join('');
  document.querySelector('#account-summary').innerHTML = accounts.map((account, index) => {
    const accountGain = account.currentValue !== null && account.costBasis !== null ? account.currentValue - account.costBasis : null;
    const returnValue = state.accountSummaryReturnMode === 'dollars' ? accountGain : account.returnPercent;
    const returnText = state.accountSummaryReturnMode === 'dollars'
      ? (accountGain === null ? '' : moneyExact(accountGain))
      : percentText(account.returnPercent);
    return `<tr data-original-index="${index}" data-account-id="${account.id}" tabindex="0" aria-label="Open ${account.displayName} account details"><td>${account.displayName}</td><td>${account.accountType || '-'}</td><td data-sort-value="${account.holdings.length}">${account.holdings.length ? `${account.holdings.length} positions` : ''}</td><td data-private-value="${moneyText(account.currentValue)}">${moneyText(account.currentValue)}</td><td data-summary-return-dollars="${accountGain ?? ''}" data-summary-return-percent="${account.returnPercent ?? ''}" data-private-value="${state.accountSummaryReturnMode === 'dollars' ? returnText : ''}" data-sort-value="${returnValue ?? ''}">${returnText}</td></tr>`;
  }).join('');
  applyPrivateValues();
  resetTableSort(document.querySelector('#account-summary-table'));
  const holdings = aggregateHoldings(accounts, marketValue);
  renderHoldingsTable(accounts, holdings);
  state.data.holdings = holdings;
  state.data.sectors = buildSectorData(portfolio, accounts, holdings, sectorDefinitions);
  renderSectorBreakdowns(state.data.sectors.sectors, state.data.sectors.portfolioValue);
  if (accounts.length) renderAccount(accounts[0]);
}

function renderAccount(account) {
  if (!account) return;
  document.querySelector('#account-name').textContent = account.displayName;
  document.querySelector('#account-brokerage-type').textContent = [account.brokerage, account.accountType].filter(Boolean).join(' · ');
  document.querySelector('#account-date').textContent = account.latestDate
    ? `Updated ${account.latestDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';
  setPrivateValue(document.querySelector('#account-value'), account.currentValue === null ? '' : moneyExact(account.currentValue));
  setPrivateValue(document.querySelector('#account-contributions'), account.costBasis === null ? '' : moneyExact(account.costBasis));
  const accountGain = account.currentValue !== null && account.costBasis !== null ? account.currentValue - account.costBasis : null;
  setPrivateValue(document.querySelector('#account-gain'), accountGain === null ? '' : moneyExact(accountGain));
  const totalShares = account.holdings.reduce((total, holding) => total + holding.shares, 0);
  document.querySelector('#account-holding-count').textContent = account.holdings.length
    ? `${account.holdings.length} positions · ${numberFormat.format(totalShares)} total shares`
    : '';
  const formattedReturn = account.returnPercent === null ? '' : `${account.returnPercent > 0 ? '+' : ''}${account.returnPercent.toFixed(1)}%`;
  document.querySelector('#account-return').textContent = formattedReturn;
  document.querySelector('#account-performance-return').textContent = formattedReturn;
  document.querySelector('#account-holdings').innerHTML = account.holdings.map((holding, index) => {
    const holdingCostBasis = holding.averageCost === null ? null : holding.shares * holding.averageCost;
    const holdingReturn = holding.gain !== null && holdingCostBasis > 0 ? holding.gain / holdingCostBasis * 100 : null;
    const holdingReturnText = holdingReturn === null ? '' : `${holdingReturn > 0 ? '+' : ''}${holdingReturn.toFixed(1)}%`;
    const gainText = state.accountHoldingsGainMode === 'percent' ? holdingReturnText : holding.gain === null ? '' : moneyExact(holding.gain);
    const gainSortValue = state.accountHoldingsGainMode === 'percent' ? holdingReturn ?? '' : holding.gain ?? '';
    return `<tr data-original-index="${index}"><td class="ticker">${holding.symbol}</td><td>${numberFormat.format(holding.shares)}</td><td data-private-value="${holdingCostBasis === null ? '' : moneyExact(holdingCostBasis)}">${holdingCostBasis === null ? '' : moneyExact(holdingCostBasis)}</td><td data-private-value="${holding.marketValue === null ? '' : moneyExact(holding.marketValue)}">${holding.marketValue === null ? '' : moneyExact(holding.marketValue)}</td><td data-gain-dollars="${holding.gain ?? ''}" data-gain-percent="${holdingReturn ?? ''}" data-private-value="${state.accountHoldingsGainMode === 'dollars' && holding.gain !== null ? moneyExact(holding.gain) : ''}" data-sort-value="${gainSortValue}">${gainText}</td></tr>`;
  }).join('');
  applyPrivateValues();
  resetTableSort(document.querySelector('#current-positions-table'));
  if (document.querySelector('#accounts-panel').classList.contains('is-visible')) renderAccountChart(account);
}

function renderAccountChart(account) {
  const labels = account.history.map(point => point.date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }));
  makeChart('accountValue', 'account-value-chart', 'line', labels, [
    lineDataset(account.displayName, account.history.map(point => point.value), '#235c48', { borderWidth: 2.5, fill: true, backgroundColor: 'rgba(86, 185, 138, .14)' })
  ], moneyExact, { plugins: { legend: { display: false } } });
}

function setView(view) {
  document.querySelectorAll('.tab, .tab-panel').forEach(element => {
    const active = element.dataset.tab === view || element.dataset.panel === view;
    element.classList.toggle('is-active', active);
    if (element.classList.contains('tab')) element.setAttribute('aria-selected', String(active));
    if (element.classList.contains('tab-panel')) element.classList.toggle('is-visible', active);
  });
  if (view === 'accounts' && state.data) {
    const account = state.data.accounts.find(item => item.id === document.querySelector('#account-select').value);
    renderAccountChart(account);
  }
  if (view === 'sectors' && state.data) renderSectorCharts(state.data.sectors);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const state = { data: null, hideAmounts: false, holdingsGainMode: 'dollars', accountHoldingsGainMode: 'dollars', accountSummaryReturnMode: 'percent' };
const dashboard = document.querySelector('#dashboard');
const authGate = document.querySelector('#auth-gate');
const signIn = async () => {
  setNotice();
  try {
    const result = await signInWithPopup(auth, provider);
    setNotice(`Google sign-in completed for ${result.user.email ?? 'your account'}; waiting for Firebase session…`);
  } catch (error) {
    setNotice(error.code === 'auth/unauthorized-domain'
      ? `This site (${window.location.hostname}) is not authorized for Firebase Authentication. Add this hostname in Firebase Console under Authentication > Settings > Authorized domains.`
      : `Sign-in failed (${error.code ?? 'unknown'}): ${error.message}`);
  }
};

document.querySelector('#sign-in-button').addEventListener('click', signIn);
document.querySelector('#gate-sign-in-button').addEventListener('click', signIn);
document.querySelector('#amount-visibility-toggle').addEventListener('click', () => {
  state.hideAmounts = !state.hideAmounts;
  updateAmountVisibility();
});
document.querySelector('#sign-out-button').addEventListener('click', () => {
  setNotice();
  signOut(auth).catch(error => setNotice(`Sign-out failed (${error.code ?? 'unknown'}): ${error.message}`));
});
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => setView(tab.dataset.tab)));
document.querySelectorAll('[data-sortable-table]').forEach(table => {
  table.querySelectorAll('thead th').forEach(header => {
    header.tabIndex = 0;
    header.setAttribute('aria-sort', 'none');
  });
  table.addEventListener('click', event => {
    const header = event.target.closest('th');
    if (!header || !table.contains(header) || event.target.closest('button')) return;
    sortTableByHeader(table, header);
  });
  table.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const header = event.target.closest('th');
    if (!header || !table.contains(header) || event.target.closest('button')) return;
    event.preventDefault();
    sortTableByHeader(table, header);
  });
});
document.querySelector('#holdings-header').addEventListener('click', event => {
  const button = event.target.closest('[data-gain-mode]');
  if (!button || !state.data) return;
  state.holdingsGainMode = button.dataset.gainMode;
  renderHoldingsTable(state.data.accounts, state.data.holdings);
});
document.querySelector('#current-positions-table').addEventListener('click', event => {
  const button = event.target.closest('[data-account-gain-mode]');
  if (!button) return;
  state.accountHoldingsGainMode = button.dataset.accountGainMode;
  document.querySelectorAll('[data-account-gain-mode]').forEach(toggle => {
    toggle.setAttribute('aria-pressed', String(toggle.dataset.accountGainMode === state.accountHoldingsGainMode));
  });
  document.querySelectorAll('#account-holdings [data-gain-dollars]').forEach(cell => {
    const value = state.accountHoldingsGainMode === 'percent' ? cell.dataset.gainPercent : cell.dataset.gainDollars;
    const number = numeric(value);
    cell.dataset.sortValue = value;
    const text = number === null ? '' : state.accountHoldingsGainMode === 'percent'
      ? `${number > 0 ? '+' : ''}${number.toFixed(1)}%`
      : moneyExact(number);
    if (state.accountHoldingsGainMode === 'percent') {
      delete cell.dataset.privateValue;
      cell.textContent = text;
    } else {
      setPrivateValue(cell, text);
    }
  });
  const table = document.querySelector('#current-positions-table');
  const sortedColumn = Number(table.dataset.sortColumn);
  if (sortedColumn === 4) applyTableSort(table, sortedColumn, table.dataset.sortDirection);
});
document.querySelector('#account-summary-table').addEventListener('click', event => {
  const button = event.target.closest('[data-summary-return-mode]');
  if (!button) return;
  state.accountSummaryReturnMode = button.dataset.summaryReturnMode;
  document.querySelectorAll('[data-summary-return-mode]').forEach(toggle => {
    toggle.setAttribute('aria-pressed', String(toggle.dataset.summaryReturnMode === state.accountSummaryReturnMode));
  });
  document.querySelectorAll('#account-summary [data-summary-return-dollars]').forEach(cell => {
    const value = state.accountSummaryReturnMode === 'dollars' ? cell.dataset.summaryReturnDollars : cell.dataset.summaryReturnPercent;
    const number = numeric(value);
    cell.dataset.sortValue = value;
    const text = number === null ? '' : state.accountSummaryReturnMode === 'dollars'
      ? moneyExact(number)
      : `${number > 0 ? '+' : ''}${number.toFixed(1)}%`;
    if (state.accountSummaryReturnMode === 'dollars') {
      setPrivateValue(cell, text);
    } else {
      delete cell.dataset.privateValue;
      cell.textContent = text;
    }
  });
  const table = document.querySelector('#account-summary-table');
  const sortedColumn = Number(table.dataset.sortColumn);
  if (sortedColumn === 4) applyTableSort(table, sortedColumn, table.dataset.sortDirection);
});
document.querySelector('#account-summary').addEventListener('click', event => {
  const row = event.target.closest('tr[data-account-id]');
  const account = state.data?.accounts.find(item => item.id === row?.dataset.accountId);
  if (!account) return;
  document.querySelector('#account-select').value = account.id;
  setView('accounts');
  renderAccount(account);
});
document.querySelector('#account-summary').addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('tr[data-account-id]');
  if (!row) return;
  event.preventDefault();
  row.click();
});
document.querySelector('#account-select').addEventListener('change', event => {
  const account = state.data?.accounts.find(item => item.id === event.target.value);
  renderAccount(account);
});

onAuthStateChanged(auth, async user => {
  document.querySelector('#sign-in-button').hidden = Boolean(user);
  document.querySelector('#sign-out-button').hidden = !user;
  document.querySelector('#signed-in-email').textContent = user?.email ?? '';
  authGate.hidden = Boolean(user);
  dashboard.hidden = !user;
  state.data = null;
  Object.keys(chartInstances).forEach(destroyChart);
  if (!user) {
    return;
  }

  setNotice('Loading portfolio data from Firestore…');
  try {
    state.data = await loadData(user.uid);
    setNotice();
    renderPortfolio(state.data);
  } catch (error) {
    setNotice(error.code === 'permission-denied'
      ? 'Firestore denied access. Check that this Google account is allowed by your Firestore rules.'
      : error.message);
  }
}, error => {
  setNotice(`Firebase Auth state failed (${error.code ?? 'unknown'}): ${error.message}`);
});