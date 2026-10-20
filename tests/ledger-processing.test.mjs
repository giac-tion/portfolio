import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregatePortfolio, parseDelimited, parseSymbolPricesCsv, parseTransactionCsv, processAccountCsv
} from '../ledger-processing.mjs';

test('parses quoted CSV and pasted tab-separated spreadsheet rows', () => {
  assert.deepEqual(parseDelimited('Symbol,Description\nABC,"Company, Inc."\n'), [
    ['Symbol', 'Description'],
    ['ABC', 'Company, Inc.']
  ]);
  const source = parseTransactionCsv([
    'Date\tActivity Type\tInvestment\tAmount\tShares\tPrice',
    '1/2/2025\tContribution\tABC\t(100.00)\t10\t10'
  ].join('\n'));
  assert.equal(source.broker, 'TRP');
  assert.deepEqual(source.rows[0], {
    Date: '1/2/2025',
    'Activity Type': 'Contribution',
    Investment: 'ABC',
    Amount: '(100.00)',
    Shares: '10',
    Price: '10'
  });
});

test('processes Robinhood CSV into daily holdings and average-cost rows matching Python rules', () => {
  const source = parseTransactionCsv([
    'Activity Date,Process Date,Settle Date,Instrument,Description,Trans Code,Quantity,Price,Amount',
    '1/2/2025,1/2/2025,1/3/2025,abc,Buy ABC,Buy,10,10,(100.00)',
    '1/3/2025,1/3/2025,1/6/2025,ABC,Buy ABC,Buy,5,20,(100.00)',
    '1/4/2025,1/4/2025,1/7/2025,ABC,Sell ABC,Sell,3,25,75.00'
  ].join('\n'));
  const prices = new Map([
    ['2025-01-02', { ABC: 10 }],
    ['2025-01-03', { ABC: 20 }],
    ['2025-01-04', { ABC: 25 }]
  ]);

  const ledger = processAccountCsv('test_account', source, prices);
  assert.deepEqual(ledger, [
    { date: '2025-01-02T00:00:00.000Z', ABC: { shares: 10, avg_cb: 10, px: 10 }, daily_acct_total: 100, daily_acct_total_cb: 100 },
    { date: '2025-01-03T00:00:00.000Z', ABC: { shares: 15, avg_cb: 13.3333, px: 20 }, daily_acct_total: 300, daily_acct_total_cb: 200 },
    { date: '2025-01-04T00:00:00.000Z', ABC: { shares: 12, avg_cb: 13.3333, px: 25 }, daily_acct_total: 300, daily_acct_total_cb: 160 }
  ]);
});

test('maps TRP activities and applies set and replace instantiations', () => {
  const source = parseTransactionCsv([
    'Date,Activity Type,Investment,Amount,Shares,Price',
    '1/2/2025,Contribution,ABC,(50.00),5,10',
    '1/3/2025,Exchange Out,ABC,10.00,1,10'
  ].join('\n'));
  const prices = new Map([['2025-01-02', { ABC: 10 }], ['2025-01-03', { ABC: 10 }]]);
  const setLedger = processAccountCsv('test_account', source, prices, [
    { accountId: 'test_account', symbol: 'ABC', mode: 'set', shares: 8, total_cost_basis: 120, effective_date: '1/3/2025' }
  ]);
  assert.equal(setLedger[0].ABC.shares, 5);
  assert.equal(setLedger[1].ABC.shares, 8);
  assert.equal(setLedger[1].ABC.avg_cb, 15);

  const replaceLedger = processAccountCsv('test_account', source, prices, [
    { accountId: 'test_account', symbol: 'ABC', mode: 'replace', shares: 2, total_cost_basis: 20 }
  ]);
  assert.equal(replaceLedger.at(-1).ABC.shares, 2);
  assert.equal(replaceLedger.at(-1).ABC.avg_cb, 10);
});

test('applies add instantiations at account_end and preserves same-day source order', () => {
  const source = parseTransactionCsv([
    'Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount',
    '01/02/2025,Buy,ABC,Buy ABC,1,10,0,-10',
    ...Array.from({ length: 8 }, () => 'not-a-date,Transfer,ABC,Transfer ABC,1,0,0,0'),
    '01/02/2025,Sell,ABC,Sell ABC,1,10,0,10'
  ].join('\n'));
  const prices = new Map([
    ['2025-01-02', { ABC: 10 }],
    ['2025-01-03', { ABC: 10 }],
    ['2025-01-04', { ABC: 10 }]
  ]);
  const ledger = processAccountCsv('test_account', source, prices, [
    { accountId: 'test_account', symbol: 'ABC', mode: 'add', shares: 1, total_cost_basis: 20, effective_date: 'account_end' }
  ], { toDate: '01/04/2025' });

  assert.equal(ledger.length, 3);
  assert.equal(ledger[0].ABC.shares, 0);
  assert.equal(ledger[0].ABC.avg_cb, 10);
  assert.equal(ledger.at(-1).ABC.shares, 1);
  assert.equal(ledger.at(-1).ABC.avg_cb, 15);

  const sameDayLedger = processAccountCsv('test_account', source, prices, [
    { accountId: 'test_account', symbol: 'ABC', mode: 'add', shares: 1, total_cost_basis: 20 }
  ], { toDate: '01/04/2025' });
  assert.equal(sameDayLedger[0].ABC.shares, 1);
  assert.equal(sameDayLedger[0].ABC.avg_cb, 10);
});

test('processes Schwab CSV fees and unrecognized actions as the Python generic logic does', () => {
  const source = parseTransactionCsv([
    'Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount',
    '01/02/2025,Buy,ABC,Buy ABC,2,10,1,-21',
    '01/03/2025,Transfer,ABC,Transfer ABC,1,0,0,0'
  ].join('\n'));
  const prices = new Map([['2025-01-02', { ABC: 10 }], ['2025-01-03', { ABC: 10 }]]);
  const ledger = processAccountCsv('test_account', source, prices);
  assert.equal(ledger[0].daily_acct_total_cb, 20);
  assert.equal(ledger[1].ABC.shares, 3);
  assert.equal(ledger[1].ABC.avg_cb, 6.6667);
  assert.equal(ledger[1].daily_acct_total_cb, 20);
});

test('represents undefined zero-baseline portfolio returns as null', () => {
  const portfolio = aggregatePortfolio({
    test_account: [
      { date: '2025-01-01T00:00:00.000Z', daily_acct_total: 0, daily_acct_total_cb: 0 },
      { date: '2025-01-02T00:00:00.000Z', daily_acct_total: 10, daily_acct_total_cb: 5 }
    ]
  }, new Map([
    ['2025-01-01', { SPY: 100 }],
    ['2025-01-02', { SPY: 101 }]
  ]), { startDate: '2025-01-01', endDate: '2025-01-02' });

  assert.equal(portfolio[0]['CB-adj. Return'], null);
  assert.equal(portfolio[1]['CB-adj. Return'], null);
  assert.equal(portfolio[1].Alpha, null);
  assert.equal(portfolio[1]['Alpha Daily - cbadj'], null);
  assert.equal(portfolio[1]['Return Daily - cbadj'], 5);
});

test('aggregates daily account ledgers with Python portfolio field names and rounding', () => {
  const accountLedgers = {
    test_account: [
      { date: '2025-01-01T00:00:00.000Z', daily_acct_total: 100, daily_acct_total_cb: 80 },
      { date: '2025-01-03T00:00:00.000Z', daily_acct_total: 120, daily_acct_total_cb: 90 }
    ]
  };
  const prices = parseSymbolPricesCsv([
    'Date,SPY',
    '2025-01-01,100',
    '2025-01-02,101',
    '2025-01-03,102.01'
  ].join('\n'));
  const portfolio = aggregatePortfolio(accountLedgers, prices, {
    startDate: '2025-01-01',
    endDate: '2025-01-03'
  });

  assert.deepEqual(portfolio, [
    {
      Date: '2025-01-01T00:00:00.000Z',
      'Portfolio Value': 100,
      'Cumulative Return $': 0,
      'CB-adj. Return': 0,
      'Spy % return': 0,
      Alpha: 0,
      'Alpha Daily - cbadj': 0,
      'Return Daily - cbadj': 0
    },
    {
      Date: '2025-01-02T00:00:00.000Z',
      'Portfolio Value': 100,
      'Cumulative Return $': 0,
      'CB-adj. Return': 0,
      'Spy % return': 1,
      Alpha: -1,
      'Alpha Daily - cbadj': -1,
      'Return Daily - cbadj': 0
    },
    {
      Date: '2025-01-03T00:00:00.000Z',
      'Portfolio Value': 120,
      'Cumulative Return $': 20,
      'CB-adj. Return': 10,
      'Spy % return': 2.01,
      Alpha: 7.99,
      'Alpha Daily - cbadj': 9,
      'Return Daily - cbadj': 10
    }
  ]);
});
