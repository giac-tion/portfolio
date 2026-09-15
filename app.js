const state = { data: null };
const colors = ['#235c48', '#56b98a', '#f5c85d', '#e8896b', '#82b7c5'];
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const moneyExact = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const percent = value => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
const valueOf = holding => holding.shares * holding.price;
const accountValue = account => account.cash + account.holdings.reduce((sum, holding) => sum + valueOf(holding), 0);
const classFor = value => value >= 0 ? 'positive' : 'negative';

async function loadData() {
  const response = await fetch('dummy_data/accounts.json');
  if (!response.ok) throw new Error('Could not load portfolio data.');
  state.data = await response.json();
  render();
}

function render() {
  const { data } = state;
  document.querySelector('#account-count').textContent = `${data.accounts.length} accounts`;
  renderMetrics(); renderChart(); renderAllocation(); renderAccountSummary(); renderHoldings(); renderSectors(); setupAccountSelect();
}

function renderMetrics() {
  const total = dataTotal();
  const invested = state.data.accounts.reduce((sum, account) => sum + account.contributions, 0);
  const gain = total - invested;
  const averageReturn = state.data.accounts.reduce((sum, account) => sum + account.performance, 0) / state.data.accounts.length;
  const metrics = [
    ['Total portfolio', money(total), 'Current market value'],
    ['Net contributions', money(invested), 'Across all accounts'],
    ['Total gain', money(gain), `${percent((gain / invested) * 100)} since contributions`],
    ['Blended return', percent(averageReturn), 'Weighted account performance']
  ];
  document.querySelector('#metrics').innerHTML = metrics.map(([label, value, note], index) => `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value ${index > 1 ? classFor(index === 3 ? averageReturn : gain) : ''}">${value}</div><div class="metric-note">${note}</div></div>`).join('');
}
function dataTotal() { return state.data.accounts.reduce((sum, account) => sum + accountValue(account), 0); }
function renderChart() {
  const svg = document.querySelector('#performance-chart');
  const points = [0.77, 0.80, 0.78, 0.84, 0.87, 0.85, 0.91, 0.89, 0.94, 0.97, 0.95, 1].map((value, index) => `${45 + index * 61},${220 - value * 135}`);
  const area = `45,220 ${points.join(' ')} 716,220`;
  svg.innerHTML = `<defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#56b98a" stop-opacity=".28"/><stop offset="1" stop-color="#56b98a" stop-opacity="0"/></linearGradient></defs><line x1="45" x2="716" y1="85" y2="85" stroke="#e4e9e4"/><line x1="45" x2="716" y1="153" y2="153" stroke="#e4e9e4"/><polygon points="${area}" fill="url(#chartFill)"/><polyline points="${points.join(' ')}" fill="none" stroke="#235c48" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="716" cy="${220 - 135}" r="5" fill="#d9f06a" stroke="#235c48" stroke-width="3"/>`;
}
function renderAllocation() {
  const accounts = state.data.accounts;
  const total = dataTotal();
  let cursor = 0;
  const stops = accounts.map((account, index) => { const start = cursor; cursor += accountValue(account) / total * 100; return `${colors[index]} ${start}% ${cursor}%`; }).join(', ');
  document.querySelector('#allocation-donut').style.background = `conic-gradient(${stops})`;
  document.querySelector('#donut-total').textContent = money(total).replace('.00', '');
  document.querySelector('#allocation-legend').innerHTML = accounts.map((account, index) => `<div class="legend-item"><span class="legend-dot" style="background:${colors[index]}"></span><span>${account.name}</span><strong>${Math.round(accountValue(account) / total * 100)}%</strong></div>`).join('');
}
function renderAccountSummary() {
  document.querySelector('#summary-note').textContent = `Updated ${state.data.asOf}`;
  document.querySelector('#account-summary').innerHTML = state.data.accounts.map(account => `<tr><td>${account.name}<span class="subtext">${account.provider}</span></td><td>${account.type}</td><td>${account.holdings.length} positions</td><td>${moneyExact(accountValue(account))}</td><td class="return ${classFor(account.performance)}">${percent(account.performance)}</td><td><button class="link-button" data-open-account="${account.id}">View <span aria-hidden="true">→</span></button></td></tr>`).join('');
  document.querySelectorAll('[data-open-account]').forEach(button => button.addEventListener('click', () => { document.querySelector('#account-select').value = button.dataset.openAccount; showTab('accounts'); renderAccount(button.dataset.openAccount); }));
}
function consolidatedHoldings() {
  const map = new Map();
  state.data.accounts.forEach(account => account.holdings.forEach(holding => { const current = map.get(holding.ticker) || { ...holding, shares: 0, costBasis: 0, accounts: {}, total: 0 }; current.accounts[account.id] = holding.shares; current.shares += holding.shares; current.costBasis += holding.costBasis; current.total += valueOf(holding); map.set(holding.ticker, current); }));
  return [...map.values()].sort((a, b) => b.total - a.total);
}
function renderHoldings() {
  const total = dataTotal(); const holdings = consolidatedHoldings();
  document.querySelector('#holding-count').textContent = `${holdings.length} positions`;
  document.querySelector('#holdings-table').innerHTML = holdings.map(holding => { const holdingReturn = holding.costBasis ? ((holding.total - holding.costBasis) / holding.costBasis) * 100 : 0; return `<tr><td><span class="ticker">${holding.ticker}</span><span class="subtext">${holding.name}</span></td><td>${holding.sector}</td>${state.data.accounts.map(account => `<td>${holding.accounts[account.id] !== undefined ? holding.accounts[account.id] : '—'}</td>`).join('')}<td>${holding.shares}</td><td>${moneyExact(holding.costBasis)}</td><td>${moneyExact(holding.total)}</td><td class="return ${classFor(holdingReturn)}">${percent(holdingReturn)}</td><td class="return">${(holding.total / total * 100).toFixed(1)}%</td></tr>`; }).join('');
}
function renderSectors() {
  const totals = {};
  consolidatedHoldings().forEach(holding => { totals[holding.sector] = (totals[holding.sector] || 0) + holding.total; });
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  document.querySelector('#sector-breakdown').innerHTML = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([sector, value]) => `<div class="sector-row"><div class="sector-label"><span>${sector}</span><span>${Math.round(value / total * 100)}% · ${money(value)}</span></div><div class="sector-track"><div class="sector-fill" style="width:${value / total * 100}%"></div></div></div>`).join('');
}
function setupAccountSelect() {
  const select = document.querySelector('#account-select');
  select.innerHTML = state.data.accounts.map(account => `<option value="${account.id}">${account.name}</option>`).join('');
  select.addEventListener('change', event => renderAccount(event.target.value));
  renderAccount(state.data.accounts[0].id);
}
function renderAccount(id) {
  const account = state.data.accounts.find(item => item.id === id); if (!account) return;
  const currentValue = accountValue(account); const invested = account.contributions; const gain = currentValue - invested;
  document.querySelector('#account-hero').innerHTML = `<div><p class="eyebrow">${account.provider} · ${account.type}</p><div class="account-name">${account.name}</div><p class="account-type">${account.holdings.length} positions · ${account.holdings.reduce((sum, holding) => sum + holding.shares, 0)} total shares</p></div><div class="hero-value"><strong>${moneyExact(currentValue)}</strong><span>${percent(account.performance)} return</span></div>`;
  document.querySelector('#account-return').textContent = percent(account.performance);
  document.querySelector('#account-return').className = `big-return ${classFor(account.performance)}`;
  document.querySelector('#account-progress').style.width = `${Math.min(account.performance / 25 * 100, 100)}%`;
  document.querySelector('#account-contributions').textContent = money(invested);
  document.querySelector('#account-cash').textContent = moneyExact(account.cash);
  document.querySelector('#account-holdings').innerHTML = account.holdings.map(holding => { const value = valueOf(holding); const holdingGain = value - holding.costBasis; return `<tr><td><span class="ticker">${holding.ticker}</span><span class="subtext">${holding.name}</span></td><td>${holding.shares}</td><td>${moneyExact(holding.costBasis)}</td><td>${moneyExact(value)}</td><td class="return ${classFor(holdingGain)}">${moneyExact(holdingGain)}</td></tr>`; }).join('');
}
function showTab(tabName) { document.querySelectorAll('.tab, .tab-panel').forEach(element => { const isMatch = element.dataset.tab === tabName || element.dataset.panel === tabName; element.classList.toggle('is-active', isMatch); if (element.classList.contains('tab')) element.setAttribute('aria-selected', isMatch); if (element.classList.contains('tab-panel')) element.classList.toggle('is-visible', isMatch); }); window.scrollTo({ top: 0, behavior: 'smooth' }); }
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
loadData().catch(error => { document.querySelector('#app').innerHTML = `<div class="panel" style="padding:24px">${error.message} Start a local server so the browser can fetch the JSON file.</div>`; });
