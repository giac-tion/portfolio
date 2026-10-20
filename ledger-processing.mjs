const TRP_ACTIONS = new Map([
  ['CONTRIBUTION', 'Buy'],
  ['EXCHANGE IN', 'Buy'],
  ['EXCHANGE OUT', 'Sell'],
  ['FEE', 'Sell'],
  ['MISC. RECEIPT', 'Buy'],
  ['MARKET FLUCTUATION', 'Hold']
]);

const CSV_FORMATS = [
  {
    broker: 'TRP',
    headers: { date: 'Date', symbol: 'Investment', action: 'Activity Type', quantity: 'Shares', price: 'Price', amount: 'Amount' }
  },
  {
    broker: 'Robinhood/UBS',
    headers: { date: 'Activity Date', symbol: 'Instrument', action: 'Trans Code', quantity: 'Quantity', price: 'Price', amount: 'Amount' }
  },
  {
    broker: 'Charles Schwab',
    headers: { date: 'Date', symbol: 'Symbol', action: 'Action', quantity: 'Quantity', price: 'Price', amount: 'Amount' }
  }
];

function normalizeHeader(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function delimiterFor(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = [...firstLine].filter(character => character === '\t').length;
  const commas = [...firstLine].filter(character => character === ',').length;
  return tabs > commas ? '\t' : ',';
}

export function parseDelimited(text, delimiter = delimiterFor(text)) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field === '') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some(value => value !== '')) records.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some(value => value !== '')) records.push(row);
  }
  return records;
}

export function parseTransactionCsv(text) {
  const records = parseDelimited(text);
  if (!records.length) throw new Error('The transaction CSV is empty.');
  const candidates = records.slice(0, 10).map((values, index) => ({
    index,
    headers: values.map(value => String(value).trim()),
    normalized: new Set(values.map(normalizeHeader))
  }));
  const format = CSV_FORMATS.find(candidate => candidates.some(record =>
    Object.values(candidate.headers).every(header => record.normalized.has(normalizeHeader(header)))));
  if (!format) {
    throw new Error(`Unsupported transaction CSV headers. Expected Robinhood/UBS, TRP, or Charles Schwab columns.`);
  }
  const headerRecord = candidates.find(record =>
    Object.values(format.headers).every(header => record.normalized.has(normalizeHeader(header))));
  const headers = headerRecord.headers;
  const rows = records.slice(headerRecord.index + 1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
  return { broker: format.broker, headers, rows, delimiter: delimiterFor(text) };
}

export function parseSymbolPricesCsv(text) {
  const records = parseDelimited(text, ',');
  if (records.length < 2 || normalizeHeader(records[0][0]) !== 'date') {
    throw new Error('The symbol-price CSV must start with a Date column.');
  }
  const dates = new Map();
  records.slice(1).forEach(fields => {
    const date = parseDate(fields[0]);
    if (!date) return;
    const dateKey = dateKeyOf(date);
    const prices = {};
    records[0].slice(1).forEach((symbol, index) => {
      const value = parseNumber(fields[index + 1]);
      if (value !== null) prices[String(symbol).trim().toUpperCase()] = value;
    });
    dates.set(dateKey, prices);
  });
  return dates;
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  let text = String(value).trim();
  if (!text || /^nan$/i.test(text)) return null;
  const negative = /^\(.*\)$/.test(text);
  text = text.replace(/[,$()\s]/g, '');
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return negative ? -Math.abs(number) : number;
}

function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    const [, month, day, year] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
    return date;
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    if (date.getUTCMonth() !== Number(iso[2]) - 1 || date.getUTCDate() !== Number(iso[3])) return null;
    return date;
  }
  return null;
}

function dateKeyOf(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateKey, days) {
  const date = parseDate(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKeyOf(date);
}

function dateRange(start, end) {
  const dates = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function roundHalfEven(value, digits) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  const scaled = Math.abs(value) * scale;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const rounded = Math.abs(fraction - 0.5) < 1e-8
    ? (lower % 2 === 0 ? lower : lower + 1)
    : Math.floor(scaled + 0.5);
  return Math.sign(value) * rounded / scale;
}

function transactionRows(source) {
  const parsed = typeof source === 'string' ? parseTransactionCsv(source) : source;
  if (!parsed || !Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) {
    throw new Error('Transaction source must contain headers and rows.');
  }
  const indexes = new Map(parsed.headers.map((header, index) => [normalizeHeader(header), index]));
  const locate = names => {
    for (const name of names) {
      const index = indexes.get(normalizeHeader(name));
      if (index !== undefined) return parsed.headers[index];
    }
    return null;
  };
  const fields = {
    date: locate(['Activity Date', 'Date']),
    symbol: locate(['Instrument', 'Investment', 'Symbol']),
    action: locate(['Trans Code', 'Activity Type', 'Action']),
    quantity: locate(['Quantity', 'Shares']),
    price: locate(['Price']),
    amount: locate(['Amount'])
  };
  const missing = Object.entries(fields).filter(([, header]) => !header).map(([name]) => name);
  if (missing.length) throw new Error(`Transaction source is missing required fields: ${missing.join(', ')}.`);

  return parsed.rows.flatMap((row, index) => {
    const date = parseDate(row[fields.date]);
    if (!date) return [];
    let action = String(row[fields.action] ?? '').trim();
    if (parsed.broker === 'TRP' || String(parsed.brokerage ?? '').toLowerCase().includes('rowe')) {
      action = TRP_ACTIONS.get(action.toUpperCase()) ?? action;
    }
    return [{
      date: dateKeyOf(date),
      symbol: String(row[fields.symbol] ?? '').trim().toUpperCase(),
      action,
      quantity: parseNumber(row[fields.quantity]) ?? 0,
      price: parseNumber(row[fields.price]) ?? 0,
      amount: parseNumber(row[fields.amount]) ?? 0,
      sourceIndex: index
    }];
  });
}

function normalizeRules(accountId, rules) {
  return rules.filter(rule => !rule.accountId || rule.accountId === accountId).map(rule => {
    const symbol = String(rule.symbol ?? '').trim().toUpperCase();
    const mode = String(rule.mode ?? '');
    const shares = parseNumber(rule.shares);
    const totalCostBasis = parseNumber(rule.total_cost_basis ?? rule.totalCostBasis);
    if (!symbol) throw new Error(`Account ${accountId} has an instantiation with an empty symbol.`);
    if (!['add', 'replace', 'set'].includes(mode)) throw new Error(`Invalid instantiation mode "${mode}" for ${accountId} ${symbol}.`);
    if (shares === null || shares < 0) throw new Error(`Invalid share quantity for ${accountId} ${symbol}.`);
    if (totalCostBasis === null || totalCostBasis < 0) throw new Error(`Invalid cost basis for ${accountId} ${symbol}.`);
    if (shares === 0 && totalCostBasis !== 0) throw new Error(`A zero-share position must have zero cost basis: ${accountId} ${symbol}.`);
    return { ...rule, symbol, mode, shares, totalCostBasis };
  });
}

function effectiveRuleDate(rule, transactions, toDate, accountId) {
  const date = rule.effective_date ?? rule.effectiveDate;
  if (date && date !== 'account_end') {
    const parsed = parseDate(date);
    if (!parsed) throw new Error(`Invalid effective date for ${accountId} ${rule.symbol}: ${date}.`);
    return dateKeyOf(parsed);
  }
  if (!transactions.length) throw new Error(`No dated transactions available to seed ${accountId} ${rule.symbol}.`);
  const dates = transactions.map(transaction => transaction.date).sort();
  if (date === 'account_end') {
    const parsedToDate = toDate ? parseDate(toDate) : null;
    if (toDate && !parsedToDate) throw new Error(`Invalid account end date for ${accountId}: ${toDate}.`);
    const end = parsedToDate ? dateKeyOf(parsedToDate) : dates.at(-1);
    return end > dates.at(-1) ? end : dates.at(-1);
  }
  return dates[0];
}

function applyInstantiations(accountId, sourceTransactions, rules, toDate) {
  const transactions = sourceTransactions.map(transaction => ({ ...transaction }));
  const overrides = [];
  normalizeRules(accountId, rules).forEach(rule => {
    if (rule.mode === 'replace') {
      transactions.forEach(transaction => {
        if (transaction.symbol === rule.symbol) {
          transaction.symbol = '';
          transaction.action = 'Hold';
          transaction.quantity = 0;
          transaction.price = 0;
          transaction.amount = 0;
        }
      });
    }
    const effectiveDate = effectiveRuleDate(rule, transactions, toDate, accountId);
    if (rule.mode === 'set') {
      overrides.push({ symbol: rule.symbol, shares: rule.shares, totalCostBasis: rule.totalCostBasis, effectiveDate });
    }
    const sourceIndex = transactions.reduce((max, transaction) => Math.max(max, transaction.sourceIndex), -1) + 1;
    transactions.push({
      date: effectiveDate,
      symbol: rule.symbol,
      action: rule.mode !== 'set' && rule.shares ? 'Buy' : 'Hold',
      quantity: rule.mode === 'set' ? 0 : rule.shares,
      price: rule.mode !== 'set' && rule.shares ? rule.totalCostBasis / rule.shares : 0,
      amount: rule.mode === 'set' ? 0 : -rule.totalCostBasis,
      sourceIndex
    });
  });
  return { transactions, overrides };
}

function alignedPricesForSymbol(symbol, dates, priceRows, transactionRowsForSymbol) {
  const available = new Map();
  priceRows.forEach((prices, priceDate) => {
    if (prices[symbol] !== undefined) available.set(priceDate, prices[symbol]);
  });
  if (!available.size) {
    transactionRowsForSymbol.forEach(transaction => {
      if (transaction.price > 0) available.set(transaction.date, transaction.price);
    });
  }
  const ordered = [...available.entries()].sort(([left], [right]) => left.localeCompare(right));
  let priceIndex = 0;
  let latest = null;
  return dates.map(date => {
    while (priceIndex < ordered.length && ordered[priceIndex][0] <= date) {
      latest = ordered[priceIndex][1];
      priceIndex += 1;
    }
    return roundHalfEven(latest ?? ordered[0]?.[1] ?? 0, 4);
  });
}

export function processAccountCsv(accountId, source, priceRows, rules = [], options = {}) {
  const sourceTransactions = transactionRows(source);
  if (!sourceTransactions.length) throw new Error(`${accountId} has no dated transactions.`);
  const toDate = options.toDate ?? source.toDate;
  const { transactions, overrides } = applyInstantiations(accountId, sourceTransactions, rules, toDate);
  const symbols = [...new Set(transactions.map(transaction => transaction.symbol).filter(Boolean))].sort();
  const lastTransactionDate = transactions.reduce((last, transaction) => transaction.date > last ? transaction.date : last, transactions[0].date);
  const parsedToDate = toDate ? parseDate(toDate) : null;
  const endDate = parsedToDate && dateKeyOf(parsedToDate) > lastTransactionDate ? dateKeyOf(parsedToDate) : lastTransactionDate;
  const dates = dateRange(transactions.reduce((first, transaction) => transaction.date < first ? transaction.date : first, transactions[0].date), endDate);
  const sharesBySymbol = new Map(symbols.map(symbol => [symbol, new Map()]));
  const averageCostBySymbol = new Map(symbols.map(symbol => [symbol, new Map()]));
  const heldShares = new Map(symbols.map(symbol => [symbol, 0]));
  const averageCost = new Map(symbols.map(symbol => [symbol, 0]));
  const orderedTransactions = [...transactions].sort((left, right) =>
    left.date.localeCompare(right.date) || right.sourceIndex - left.sourceIndex);
  const costBasisAtDate = new Map();
  const dailyByDate = new Map();
  orderedTransactions.forEach(transaction => {
    if (!dailyByDate.has(transaction.date)) dailyByDate.set(transaction.date, []);
    dailyByDate.get(transaction.date).push(transaction);
  });
  [...dailyByDate.keys()].sort().forEach(date => {
    const otherShareChanges = new Map();
    dailyByDate.get(date).forEach(transaction => {
      const { symbol } = transaction;
      const quantity = Math.abs(transaction.quantity);
      const action = String(transaction.action ?? '').toUpperCase();
      if (!symbol || quantity === 0) return;
      if (action.includes('SELL')) {
        heldShares.set(symbol, heldShares.get(symbol) - quantity);
        if (heldShares.get(symbol) <= 1e-10) {
          heldShares.set(symbol, 0);
          averageCost.set(symbol, 0);
        }
      } else if (action.includes('BUY') || action.includes('REINVEST')) {
        const purchasePrice = transaction.price || (quantity ? Math.abs(transaction.amount) / quantity : 0);
        const oldCost = heldShares.get(symbol) * averageCost.get(symbol);
        heldShares.set(symbol, heldShares.get(symbol) + quantity);
        averageCost.set(symbol, (oldCost + quantity * purchasePrice) / heldShares.get(symbol));
      } else {
        otherShareChanges.set(symbol, (otherShareChanges.get(symbol) ?? 0) + (transaction.quantity || 0));
      }
    });
    otherShareChanges.forEach((shareChange, symbol) => {
      const oldShares = heldShares.get(symbol);
      heldShares.set(symbol, oldShares + shareChange);
      if (heldShares.get(symbol) <= 1e-10) {
        heldShares.set(symbol, 0);
        averageCost.set(symbol, 0);
      } else if (oldShares > 0) {
        averageCost.set(symbol, averageCost.get(symbol) * oldShares / heldShares.get(symbol));
      }
    });
    costBasisAtDate.set(date, new Map(averageCost));
  });

  const shareTotals = new Map(symbols.map(symbol => [symbol, 0]));
  const latestCostBasis = new Map(symbols.map(symbol => [symbol, 0]));
  const priceHistory = new Map();
  const sortedCostDates = [...costBasisAtDate.keys()].sort();
  let costDateIndex = 0;
  symbols.forEach(symbol => {
    const symbolTransactions = transactions.filter(transaction => transaction.symbol === symbol);
    const dailyChanges = new Map();
    symbolTransactions.forEach(transaction => {
      const action = String(transaction.action ?? '').toUpperCase();
      let change = transaction.quantity;
      if (action.includes('SELL')) change = -Math.abs(transaction.quantity);
      else if (action.includes('BUY') || action.includes('REINVEST')) change = Math.abs(transaction.quantity);
      dailyChanges.set(transaction.date, (dailyChanges.get(transaction.date) ?? 0) + change);
    });
    const prices = alignedPricesForSymbol(symbol, dates, priceRows, symbolTransactions);
    const symbolPrices = new Map();
    dates.forEach((date, dateIndex) => {
      const shareTotal = shareTotals.get(symbol) + (dailyChanges.get(date) ?? 0);
      shareTotals.set(symbol, shareTotal);
      sharesBySymbol.get(symbol).set(date, Math.max(0, roundHalfEven(shareTotal, 6)));
      symbolPrices.set(date, prices[dateIndex]);
    });
    priceHistory.set(symbol, symbolPrices);
  });

  dates.forEach(date => {
    while (costDateIndex < sortedCostDates.length && sortedCostDates[costDateIndex] <= date) {
      const snapshot = costBasisAtDate.get(sortedCostDates[costDateIndex]);
      symbols.forEach(symbol => latestCostBasis.set(symbol, snapshot.get(symbol) ?? 0));
      costDateIndex += 1;
    }
    symbols.forEach(symbol => {
      averageCostBySymbol.get(symbol).set(date, roundHalfEven(latestCostBasis.get(symbol), 4));
    });
  });

  overrides.forEach(override => {
    if (!sharesBySymbol.has(override.symbol)) throw new Error(`Cannot override missing position column "${override.symbol}".`);
    dates.filter(date => date >= override.effectiveDate).forEach(date => {
      sharesBySymbol.get(override.symbol).set(date, override.shares);
      averageCostBySymbol.get(override.symbol).set(date, override.shares ? override.totalCostBasis / override.shares : 0);
    });
  });

  return dates.map(date => {
    const row = { date: `${date}T00:00:00.000Z` };
    let accountValue = 0;
    let accountCostBasis = 0;
    symbols.forEach(symbol => {
      const shares = sharesBySymbol.get(symbol).get(date);
      const average = averageCostBySymbol.get(symbol).get(date);
      const price = priceHistory.get(symbol).get(date);
      row[symbol] = { shares, avg_cb: average, px: price };
      accountValue += shares * price;
      accountCostBasis += shares * average;
    });
    row.daily_acct_total = roundHalfEven(accountValue, 2);
    row.daily_acct_total_cb = roundHalfEven(accountCostBasis, 2);
    return row;
  });
}

function roundOrNull(value, digits) {
  return Number.isFinite(value) ? roundHalfEven(value, digits) : null;
}

export function aggregatePortfolio(accountLedgers, priceRows, options = {}) {
  const startDate = options.startDate ?? '2025-01-01';
  const today = options.endDate ?? dateKeyOf(new Date());
  const ledgers = Object.entries(accountLedgers ?? {}).map(([accountId, rows]) => {
    if (!Array.isArray(rows) || !rows.length) return null;
    const daily = new Map();
    rows.forEach(row => {
      const date = parseDate(row.date);
      if (!date) throw new Error(`${accountId} contains an invalid ledger date: ${row.date}.`);
      const key = dateKeyOf(date);
      const value = parseNumber(row.daily_acct_total);
      const costBasis = parseNumber(row.daily_acct_total_cb);
      if (value === null || costBasis === null) throw new Error(`${accountId} is missing daily account value or cost basis for ${key}.`);
      daily.set(key, { value, costBasis });
    });
    return { accountId, daily };
  }).filter(Boolean);
  if (!ledgers.length) throw new Error('At least one dated account ledger is required.');

  const lastAccountDate = ledgers.reduce((latest, ledger) => {
    const dates = [...ledger.daily.keys()].sort();
    return dates.at(-1) > latest ? dates.at(-1) : latest;
  }, startDate);
  const end = today > lastAccountDate ? today : lastAccountDate;
  const dates = dateRange(startDate, end);
  const values = [];
  const costBases = [];
  ledgers.forEach(ledger => {
    const ordered = [...ledger.daily.keys()].sort();
    let index = 0;
    let current = null;
    const aligned = dates.map(date => {
      while (index < ordered.length && ordered[index] <= date) {
        current = ledger.daily.get(ordered[index]);
        index += 1;
      }
      return current ?? { value: 0, costBasis: 0 };
    });
    values.push(aligned.map(item => item.value));
    costBases.push(aligned.map(item => item.costBasis));
  });
  const portfolioValue = dates.map((_, index) => values.reduce((sum, row) => sum + row[index], 0));
  const portfolioCostBasis = dates.map((_, index) => costBases.reduce((sum, row) => sum + row[index], 0));
  const spyPrices = dates.map(date => {
    const available = [...priceRows.entries()]
      .filter(([priceDate, row]) => priceDate <= date && row.SPY !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return available.at(-1)?.[1].SPY ?? null;
  });
  if (!spyPrices[0] || !Number.isFinite(spyPrices[0])) {
    throw new Error(`No valid SPY close price is available on or before ${startDate}.`);
  }

  const baselineValue = portfolioValue[0];
  const baselineCostBasis = portfolioCostBasis[0];
  const cumulative = portfolioValue.map(value => value - baselineValue);
  const adjustedDollars = cumulative.map((value, index) => value - (portfolioCostBasis[index] - baselineCostBasis));
  const adjustedReturns = adjustedDollars.map(value => baselineValue === 0 ? null : value / baselineValue * 100);
  const spyReturns = spyPrices.map(value => (value / spyPrices[0] - 1) * 100);
  const dailySpyReturns = spyPrices.map((value, index) => index === 0 ? 0 : (value / spyPrices[index - 1] - 1) * 100);

  return dates.map((date, index) => {
    const dailyAdjustedReturn = index === 0
      ? 0
      : adjustedReturns[index] === null || adjustedReturns[index - 1] === null
        ? null
        : adjustedReturns[index] - adjustedReturns[index - 1];
    return {
      Date: `${date}T00:00:00.000Z`,
      'Portfolio Value': roundHalfEven(portfolioValue[index], 2),
      'Cumulative Return $': roundHalfEven(cumulative[index], 2),
      'CB-adj. Return': roundOrNull(adjustedReturns[index], 4),
      'Spy % return': roundHalfEven(spyReturns[index], 4),
      Alpha: roundOrNull(adjustedReturns[index] === null ? null : adjustedReturns[index] - spyReturns[index], 4),
      'Alpha Daily - cbadj': roundOrNull(dailyAdjustedReturn === null ? null : dailyAdjustedReturn - dailySpyReturns[index], 4),
      'Return Daily - cbadj': roundHalfEven(
        (portfolioValue[index] - (portfolioValue[index - 1] ?? portfolioValue[index]))
        - (portfolioCostBasis[index] - (portfolioCostBasis[index - 1] ?? portfolioCostBasis[index])), 2)
    };
  });
}
