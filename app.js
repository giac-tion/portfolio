import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { doc, getDoc, getFirestore } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

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
const accountNames = Array.from({ length: 10 }, (_, index) => `account_${index + 1}`);
const accountColors = ['#235c48', '#56b98a', '#e8896b', '#82b7c5', '#f5c85d', '#4776d0', '#b86f4b', '#609b79', '#8a9e47', '#637b8a'];
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
  return null;
}

function portfolioModel(rows) {
  return orderedRows(rows ?? []).map(({ row, date }) => ({
    date,
    value: numeric(getField(row, 'portfolio_value', 'Portfolio Value')),
    cumulativeReturn: numeric(getField(row, 'cumulative_return', 'Cumulative Return $')),
    cbAdjReturn: numeric(getField(row, 'cb_adj_return', 'CB-adj. Return')),
    spy: numeric(getField(row, 'spy', 'Spy')),
    alpha: numeric(getField(row, 'alpha', 'Alpha')),
    dailyAlpha: numeric(getField(row, 'alpha_daily_cbadj', 'Alpha Daily - cbadj')),
    dailyReturn: numeric(getField(row, 'cb_adj_daily_return', 'CB-Adj Daily return'))
  }));
}

function accountModel(name, rows) {
  const ordered = orderedRows(rows).map(({ row, date }) => ({
    row,
    date,
    value: numeric(row.daily_acct_total)
  }));
  const latest = ordered[ordered.length - 1] ?? { row: {}, date: null, value: null };
  const holdings = Object.keys(latest.row)
    .filter(key => key.endsWith('_px'))
    .map(key => {
      const symbol = key.slice(0, -3);
      const shares = numeric(latest.row[symbol]);
      const price = numeric(latest.row[key]);
      const averageCost = numeric(latest.row[`${symbol}_cb`]);
      return {
        symbol,
        shares,
        averageCost,
        price,
        marketValue: shares !== null && price !== null ? shares * price : null,
        gain: shares !== null && price !== null && averageCost !== null ? shares * (price - averageCost) : null
      };
    })
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
    history: ordered.map(point => ({ date: point.date, value: valueOrNull(point.value) })),
    holdings
  };
}

async function readDataset(uid, name) {
  const snapshot = await getDoc(doc(database, 'users', uid, 'datasets', name));
  if (!snapshot.exists()) return null;
  const dataset = snapshot.data();
  return {
    rows: Array.isArray(dataset.rows) ? dataset.rows : [],
    updatedAt: dataset.updatedAt?.toDate?.() ?? snapshot.updateTime?.toDate?.() ?? null
  };
}

async function loadData(uid) {
  const names = [...accountNames, 'portfolio_total', 'account_metadata'];
  const datasets = Object.fromEntries(await Promise.all(names.map(async name => [name, await readDataset(uid, name)])));
  const metadataById = Object.fromEntries((datasets.account_metadata?.rows ?? []).map(row => [row.id ?? row.accountId, row]));
  const accounts = accountNames
    .filter(name => datasets[name])
    .map(name => {
      const account = accountModel(name, datasets[name].rows);
      const metadata = metadataById[name] ?? {};
      return {
        ...account,
        displayName: metadata.accountName ?? metadata.name ?? account.displayName,
        brokerage: metadata.brokerage ?? '',
        accountType: metadata.accountType ?? metadata.type ?? ''
      };
    });
  return {
    portfolio: portfolioModel(datasets.portfolio_total?.rows),
    accounts,
    updatedAt: Object.values(datasets).map(dataset => dataset?.updatedAt).filter(Boolean).sort((a, b) => b - a)[0] ?? null
  };
}

function setNotice(message = '') {
  const notice = document.querySelector('#notice');
  notice.textContent = message;
  notice.hidden = !message;
}

function destroyChart(name) {
  if (chartInstances[name]) {
    chartInstances[name].destroy();
    delete chartInstances[name];
  }
}

function chartOptions(formatter, extra = {}, type = 'line') {
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', align: 'start', labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8 } },
      tooltip: { callbacks: { label: context => `${context.dataset.label}: ${formatter(context.parsed.y)}` } }
    }
  };
  if (type !== 'doughnut') {
    options.scales = {
      x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, color: '#748078' } },
      y: { grid: { color: '#e4e9e4' }, ticks: { color: '#748078', callback: value => formatter(value) } }
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
    ctx.fillText(moneyExact(total), x, y);
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
      costBasis: 0,
      marketValue: 0,
      costBasisComplete: true,
      marketValueComplete: true
    };
    item.shares += holding.shares;
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

function renderPortfolio(data) {
  const { portfolio, accounts } = data;
  const aggregateRows = portfolio.filter(point => point.value !== null);
  const latestPortfolio = aggregateRows[aggregateRows.length - 1];
  const marketValue = latestPortfolio?.value ?? null;
  const totalGain = latestPortfolio?.cumulativeReturn ?? null;
  const contributions = marketValue !== null && totalGain !== null ? marketValue - totalGain : null;
  const totalReturn = latestPortfolio?.cbAdjReturn ?? null;
  const moneyText = value => value === null ? '' : moneyExact(value);
  const percentText = value => value === null ? '' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;

  document.querySelector('#account-count').textContent = accounts.length ? `${accounts.length} accounts` : '';
  document.querySelector('#metric-market-value').textContent = moneyText(marketValue);
  document.querySelector('#metric-contributions').textContent = moneyText(contributions);
  document.querySelector('#metric-total-gain').textContent = moneyText(totalGain);
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
    const firstReturnPoint = portfolio.find(point => point.value !== null && point.cumulativeReturn !== null);
    const initialPortfolioValue = firstReturnPoint ? firstReturnPoint.value - firstReturnPoint.cumulativeReturn : null;
  makeChart('returns', 'returns-chart', 'line', labels, [
      lineDataset('Cumulative return', portfolio.map(point => initialPortfolioValue && point.cumulativeReturn !== null ? point.cumulativeReturn / initialPortfolioValue * 100 : null), '#4776d0'),
    lineDataset('CB-adjusted return', portfolio.map(point => point.cbAdjReturn), '#235c48'),
    lineDataset('S&P 500', portfolio.map(point => point.spy), '#e8896b')
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
  document.querySelector('#account-summary').innerHTML = accounts.map(account => `<tr data-account-id="${account.id}" tabindex="0" aria-label="Open ${account.displayName} account details"><td>${account.displayName}</td><td>${account.accountType || '-'}</td><td>${account.holdings.length ? `${account.holdings.length} positions` : ''}</td><td>${moneyText(account.currentValue)}</td><td>${percentText(account.returnPercent)}</td></tr>`).join('');
  const holdings = aggregateHoldings(accounts, marketValue);
  document.querySelector('#holdings-table').innerHTML = holdings.map(holding => `<tr><td class="ticker">${holding.symbol}</td><td>${numberFormat.format(holding.shares)}</td><td>${moneyText(holding.costBasis)}</td><td>${moneyText(holding.marketValue)}</td><td>${moneyText(holding.gain)}</td><td>${percentText(holding.portfolioPercent)}</td></tr>`).join('');
  state.data.holdings = holdings;
  if (accounts.length) renderAccount(accounts[0]);
}

function renderAccount(account) {
  if (!account) return;
  document.querySelector('#account-name').textContent = account.displayName;
  document.querySelector('#account-brokerage-type').textContent = [account.brokerage, account.accountType].filter(Boolean).join(' · ');
  document.querySelector('#account-date').textContent = account.latestDate
    ? `Updated ${account.latestDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';
  document.querySelector('#account-value').textContent = account.currentValue === null ? '' : moneyExact(account.currentValue);
  const totalShares = account.holdings.reduce((total, holding) => total + holding.shares, 0);
  document.querySelector('#account-holding-count').textContent = account.holdings.length
    ? `${account.holdings.length} positions · ${numberFormat.format(totalShares)} total shares`
    : '';
  const formattedReturn = account.returnPercent === null ? '' : `${account.returnPercent > 0 ? '+' : ''}${account.returnPercent.toFixed(1)}%`;
  document.querySelector('#account-return').textContent = formattedReturn ? `${formattedReturn} return` : '';
  document.querySelector('#account-performance-return').textContent = formattedReturn;
  document.querySelector('#account-holdings').innerHTML = account.holdings.map(holding => `<tr><td class="ticker">${holding.symbol}</td><td>${numberFormat.format(holding.shares)}</td><td>${holding.averageCost === null ? '' : moneyExact(holding.shares * holding.averageCost)}</td><td>${holding.marketValue === null ? '' : moneyExact(holding.marketValue)}</td><td>${holding.gain === null ? '' : moneyExact(holding.gain)}</td></tr>`).join('');
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
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const state = { data: null };
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
document.querySelector('#sign-out-button').addEventListener('click', () => {
  setNotice();
  signOut(auth).catch(error => setNotice(`Sign-out failed (${error.code ?? 'unknown'}): ${error.message}`));
});
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => setView(tab.dataset.tab)));
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