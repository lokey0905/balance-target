'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const inline = html.match(/<script\b[^>]*\bid=["']calculation-engine["'][^>]*>([\s\S]*?)<\/script>/i);
assert.ok(inline, 'index.html must contain the embedded calculation engine');
const source = inline[1];
const context = vm.createContext({});
vm.runInContext(source, context, { filename: 'index.html#calculation-engine' });
const engine = context.BalanceEngine;
const basic = (changes = {}) => ({ mode: 'custom', checkMonth: '2026-11', months: 1, target: 300000, initial: 300000, method: 'daily', snapshotDates: {}, transactions: [], cardSpend: '', ...changes });
const tx = (date, type, amount) => ({ date, type, amount, note: '' });
const plain = value => JSON.parse(JSON.stringify(value));

test('T01–T02 — exact specification calendar periods', () => {
  const single = engine.period('2026-11', 1);
  assert.equal(single.start, '2026-10-01');
  assert.equal(single.end, '2026-10-31');
  assert.equal(single.days, 31);
  const triple = engine.period('2026-12', 3);
  assert.equal(triple.start, '2026-09-01');
  assert.equal(triple.end, '2026-11-30');
  assert.equal(triple.days, 91);
});

test('T03 — full month at target qualifies exactly and requires zero top-up', () => {
  const result = engine.calculate(basic());
  assert.equal(result.sampleCount, 31);
  assert.equal(result.sum, 9300000);
  assert.equal(result.average, 300000);
  assert.equal(result.met, true);
  assert.equal(result.gap, 0);
  assert.equal(result.achievement, 100);
  assert.equal(result.segments.length, 1);
  assert.equal(Object.isFrozen(engine), true);
  assert.equal(engine.plan(result, '2026-10-20').amount, 0);
});

test('T04–T06, T11 — core debit example and independent date comparisons', () => {
  const input = basic({ transactions: [tx('2026-10-10', 'card', 30000)] });
  const result = engine.calculate(input);
  const before = JSON.stringify(result);
  assert.equal(result.sum, 8640000);
  assert.equal(result.average.toFixed(2), '278709.68');
  const plans = ['2026-10-10', '2026-10-20', '2026-10-25'].map(date => engine.plan(result, date));
  assert.deepEqual(plans.map(plan => plan.amount), [30000, 55000, 94286]);
  assert.deepEqual(plans.map(plan => plan.eligibleCount), [22, 12, 7]);
  assert.equal(plans[1].after, 325000);
  assert.equal(plans[1].average, 300000);
  assert.equal(JSON.stringify(result), before);
  const underfunded = engine.calculate({ ...input, transactions: [...input.transactions, tx('2026-10-20', 'deposit', 30000)] });
  assert.equal(underfunded.average.toFixed(2), '290322.58');
  assert.equal(underfunded.met, false);
});

test('T07 — exact three-month daily versus month-end sample example', () => {
  const input = basic({ checkMonth: '2026-12', months: 3, initial: 0, target: 500000, transactions: [tx('2026-11-01', 'deposit', 1500000)] });
  const daily = engine.calculate(input);
  const snapshot = engine.calculate({ ...input, method: 'snapshot' });
  assert.equal(daily.average.toFixed(2), '494505.49');
  assert.equal(daily.met, false);
  assert.equal(snapshot.average, 500000);
  assert.equal(snapshot.met, true);
});

test('T08 — January through March 2024 includes leap day and totals 91 days', () => {
  const result = engine.calculate(basic({ checkMonth: '2024-04', months: 3 }));
  assert.equal(result.period.days, 91);
  assert.equal(result.daily.filter(day => day.date === '2024-02-29').length, 1);
});

test('T09 — omitted card spend stays unknown rather than being coerced to zero', () => {
  assert.equal(engine.calculate(basic({ mode: 'unicard', cardSpend: '' })).config.cardSpend, '');
  assert.equal(engine.calculate(basic({ mode: 'unicard', cardSpend: undefined })).config.cardSpend, '');
});

test('daily balance — debit changes that same day end-of-day balance', () => {
  const result = engine.calculate(basic({ transactions: [tx('2026-10-11', 'withdrawal', 100000)] }));
  assert.equal(result.sum, 10 * 300000 + 21 * 200000);
  assert.equal(result.daily[9].balance, 300000);
  assert.equal(result.daily[10].balance, 200000);
  assert.equal(result.met, false);
});

test('daily balance — first and last days are both included', () => {
  const result = engine.calculate(basic({ initial: 0, transactions: [tx('2026-10-01', 'deposit', 100), tx('2026-10-31', 'increase', 200)] }));
  assert.equal(result.sum, 100 * 31 + 200);
  assert.equal(result.daily[30].balance, 300);
});

test('top-up — remaining inclusive calendar days and minimum integer amount', () => {
  const result = engine.calculate(basic({ initial: 200000 }));
  const plan = engine.plan(result, '2026-10-21');
  assert.equal(plan.eligibleCount, 11);
  assert.equal(plan.amount, 281819);
  assert.equal(plan.before, 200000);
  assert.equal(plan.after, 481819);
  assert.ok(plan.average >= 300000);
  assert.equal(plan.met, true);
  assert.ok((result.sum + (plan.amount - 1) * plan.eligibleCount) / result.sampleCount < 300000);
});

test('sampling — snapshot average and monthly daily average remain distinct', () => {
  const changes = { checkMonth: '2026-04', months: 2, initial: 100, target: 150, transactions: [tx('2026-03-31', 'deposit', 100)] };
  const daily = engine.calculate(basic(changes));
  const snapshot = engine.calculate(basic({ ...changes, method: 'snapshot' }));
  assert.equal(daily.sampleCount, 59);
  assert.equal(daily.sum, 6000);
  assert.equal(snapshot.sampleCount, 2);
  assert.equal(snapshot.sum, 300);
  assert.equal(snapshot.average, 150);
  assert.equal(snapshot.months[1].average, 3200 / 31);
  assert.equal(snapshot.met, true);
  assert.equal(daily.met, false);
});

test('sampling — selected snapshot dates govern top-up eligibility', () => {
  const result = engine.calculate(basic({ checkMonth: '2026-04', months: 2, initial: 100, target: 300, method: 'snapshot', snapshotDates: { '2026-02': '2026-02-15', '2026-03': '2026-03-10' } }));
  const plan = engine.plan(result, '2026-02-16');
  assert.equal(plan.eligibleCount, 1);
  assert.equal(plan.amount, 400);
  assert.equal(plan.average, 300);
  assert.equal(engine.plan(result, '2026-03-10').eligibleCount, 1);
  assert.equal(engine.plan(result, '2026-03-11').possible, false);
});

test('top-up — existing deposit on top-up day is counted exactly once', () => {
  const result = engine.calculate(basic({ initial: 100000, transactions: [tx('2026-10-16', 'deposit', 100000)] }));
  const plan = engine.plan(result, '2026-10-16');
  assert.equal(result.sum, 15 * 100000 + 16 * 200000);
  assert.equal(plan.before, 200000);
  assert.equal(plan.amount, 287500);
  assert.equal(plan.after, 487500);
  assert.equal(plan.average, 300000);
});

test('top-up — one-day remainder rounds upward, even if displayed average looks met', () => {
  const result = engine.calculate(basic({ initial: 300000, transactions: [tx('2026-10-31', 'decrease', 1)] }));
  assert.equal(Math.round(result.average), 300000);
  assert.equal(result.met, false);
  assert.equal(engine.plan(result, '2026-10-31').amount, 1);
  assert.equal(engine.plan(result, '2026-10-01').amount, 1);
});

test('top-up — after period cannot rescue a deficit; already met needs zero', () => {
  const failed = engine.plan(engine.calculate(basic({ initial: 299999 })), '2026-11-01');
  assert.equal(failed.eligibleCount, 0);
  assert.equal(failed.amount, null);
  assert.equal(failed.average, null);
  assert.equal(failed.possible, false);
  assert.equal(failed.met, false);
  const passed = engine.plan(engine.calculate(basic()), '2027-01-01');
  assert.equal(passed.eligibleCount, 0);
  assert.equal(passed.amount, 0);
  assert.equal(passed.average, 300000);
  assert.equal(passed.possible, true);
  assert.equal(passed.met, true);
});

test('T10 — same-day aggregation ignores row ordering, rejects negative day end', () => {
  const events = [tx('2026-10-01', 'card', 500), tx('2026-10-01', 'deposit', 500)];
  const a = engine.calculate(basic({ initial: 0, transactions: events }));
  const b = engine.calculate(basic({ initial: 0, transactions: events.slice().reverse() }));
  assert.equal(a.sum, b.sum);
  assert.equal(a.sum, 0);
  assert.equal(a.daily[0].events.length, 2);
  assert.throws(() => engine.calculate(basic({ initial: 0, transactions: [tx('2026-10-02', 'card', 1)] })), /日終餘額為負數/);
});

test('preset — Unicard locks month count, target and daily sampling; card spend is separate', () => {
  const result = engine.calculate(basic({ mode: 'unicard', months: 12, target: 1, method: 'snapshot', cardSpend: 10000 }));
  assert.equal(result.config.months, 1);
  assert.equal(result.config.target, 300000);
  assert.equal(result.config.method, 'daily');
  assert.equal(result.config.cardSpend, 10000);
  assert.equal(result.average, 300000);
});

test('calendar — leap years, cross-year periods and all 1–12 month durations', () => {
  assert.deepEqual(plain(engine.period('2024-03', 1)), { start: '2024-02-01', end: '2024-02-29', days: 29, monthKeys: ['2024-02'] });
  assert.equal(engine.period('2100-03', 1).days, 28);
  assert.equal(engine.period('2000-03', 1).days, 29);
  assert.deepEqual(plain(engine.period('2026-02', 3)), { start: '2025-11-01', end: '2026-01-31', days: 92, monthKeys: ['2025-11', '2025-12', '2026-01'] });
  for (let months = 1; months <= 12; months += 1) {
    const result = engine.calculate(basic({ checkMonth: '2025-01', months }));
    assert.equal(result.months.length, months);
    assert.equal(result.average, 300000);
    assert.equal(result.period.days, result.daily.length);
  }
  assert.equal(engine.period('2025-01', 12).days, 366);
});

test('validation — missing, nonfinite, fractional, unsafe and out-of-range amounts', () => {
  for (const initial of [-1, 0.1, NaN, Infinity, '300000', 1000000000001, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => engine.calculate(basic({ initial })), /期初餘額/);
  }
  for (const target of [0, -1, 0.5, NaN, Infinity, undefined]) {
    assert.throws(() => engine.calculate(basic({ target })), /目標平均餘額/);
  }
  for (const value of [0, -1, 0.5, NaN, Infinity, '1']) {
    assert.throws(() => engine.calculate(basic({ transactions: [tx('2026-10-01', 'deposit', value)] })), /金額/);
  }
  assert.throws(() => engine.calculate(basic({ cardSpend: -1 })), /信用卡消費額/);
  assert.throws(() => engine.calculate(basic({ mode: 'unknown' })), /模式/);
  assert.throws(() => engine.calculate(basic({ method: 'unknown' })), /每日平均/);
  assert.throws(() => engine.calculate(basic({ transactions: {} })), /格式/);
  assert.throws(() => engine.calculate(basic({ transactions: [tx('2026-10-01', 'unknown', 1)] })), /類型/);
});

test('validation — real dates, strict ISO shape and valid selected snapshot months', () => {
  for (const checkMonth of ['2026-13', '2026-00', '0000-01', '2026-1', 'bad']) assert.throws(() => engine.period(checkMonth, 1));
  for (const months of [0, 13, 1.5, '1', NaN]) assert.throws(() => engine.period('2026-11', months));
  for (const date of ['2026-10-32', '2026-09-31', '2026-10-00', '2026-1-01', '2026-09-30', '2026-11-01']) {
    assert.throws(() => engine.calculate(basic({ transactions: [tx(date, 'deposit', 1)] })));
  }
  assert.throws(() => engine.calculate(basic({ checkMonth: '2025-03', transactions: [tx('2025-02-29', 'deposit', 1)] })), /真實存在/);
  assert.throws(() => engine.calculate(basic({ method: 'snapshot', snapshotDates: { '2026-10': '2026-09-30' } })), /該月份/);
  assert.throws(() => engine.plan(engine.calculate(basic()), '2026-09-30'), /不可早於/);
  assert.throws(() => engine.plan(engine.calculate(basic()), '2026-11-31'), /真實存在/);
});

test('precision — safe integer sum limit is enforced', () => {
  const deposits = Array.from({ length: 30 }, (_, i) => ({ id: i, ...tx('2024-01-01', 'deposit', 1000000000000) }));
  assert.throws(() => engine.calculate(basic({ checkMonth: '2025-01', months: 12, initial: 0, transactions: deposits })), /精確計算/);
});

test('purity — caller configuration and transaction order remain unchanged', () => {
  const input = basic({ transactions: [tx('2026-10-20', 'deposit', 300), tx('2026-10-01', 'deposit', 100)] });
  const original = JSON.stringify(input);
  engine.calculate(input);
  assert.equal(JSON.stringify(input), original);
});
