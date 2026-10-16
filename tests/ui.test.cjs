'use strict';

// DOM integration tests for our local HTML. No browser, remote resources, or network requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function app(t, options = {}) {
  const errors = [];
  const copied = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    virtualConsole,
    // Deliberately omit resources: jsdom must not load subresources.
    beforeParse(window) {
      const OriginalDate = window.Date;
      window.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : ['2026-10-16T04:00:00.000Z'])); }
        static now() { return OriginalDate.parse('2026-10-16T04:00:00.000Z'); }
      };
      window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
      if (options.clipboard !== 'missing') {
        Object.defineProperty(window.navigator, 'clipboard', {
          value: {
            async writeText(value) {
              if (options.clipboard === 'reject') throw new Error('Clipboard permission rejected');
              copied.push(value);
            }
          }
        });
      }
    }
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const document = window.document;
  const q = selector => {
    const element = document.querySelector(selector);
    assert.ok(element, 'Expected element: ' + selector);
    return element;
  };
  const text = selector => q(selector).textContent.trim();
  const click = selector => q(selector).click();
  const set = (selector, value, eventName = 'input') => {
    const element = q(selector);
    element.value = String(value);
    element.dispatchEvent(new window.Event(eventName, { bubbles: true }));
  };
  const calculate = () => q('#calculator').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const example = kind => { click(`[data-example="${kind}"]`); click('#confirm-ok'); };
  assert.deepEqual(errors, [], 'Initial application evaluation must succeed');
  assert.equal(q('#errors').hidden, true);
  return { window, document, q, text, click, set, calculate, example, copied, errors };
}

test('initial sample renders actual calculated values, chart and accessible details', t => {
  const a = app(t);
  assert.equal(a.text('#average-value'), '278,709.68');
  assert.equal(a.text('#topup-amount'), '55,000');
  assert.equal(a.text('#before-value'), '270,000');
  assert.equal(a.text('#after-value'), '325,000');
  assert.equal(a.text('#after-average'), '300,000.00');
  assert.equal(a.text('#topup-count'), '可計入 12 天');
  assert.match(a.text('#spending-check'), /達標/);
  assert.match(a.text('#bank-conclusion'), /尚未同時達成/);
  assert.equal(a.q('#result-content').hidden, false);
  assert.equal(a.q('#result-placeholder').hidden, true);
  assert.equal(a.q('#month-count').disabled, true);
  assert.equal(a.q('#target').disabled, true);
  assert.equal(a.document.querySelectorAll('#chart svg[role="img"]').length, 1);
  assert.equal(a.document.querySelectorAll('#month-rows tr').length, 1);
  assert.equal(a.document.querySelectorAll('#segment-rows tr').length, 2);
  a.click('#open-details');
  assert.equal(a.q('#detail-panel').open, true);
});

test('editing hides stale results and copy is gated until recalculation', async t => {
  const a = app(t);
  a.set('#initial', 400000);
  assert.equal(a.q('#result-content').hidden, true);
  assert.equal(a.q('#result-placeholder').hidden, false);
  assert.match(a.text('#placeholder-title'), /資料已修改/);
  a.click('#copy-summary');
  await Promise.resolve();
  assert.equal(a.copied.length, 0);
  a.click('#recalculate');
  assert.equal(a.text('#average-value'), '378,709.68');
  assert.equal(a.text('#topup-amount'), '0');
  assert.equal(a.q('#result-content').hidden, false);
  assert.match(a.text('#bank-conclusion'), /預估達到兩項數值門檻/);
});

test('blank required amounts and dates produce errors without displaying previous results', t => {
  for (const selector of ['#initial', '#topup-date', '[data-record] [data-key="amount"]', '[data-record] [data-key="date"]']) {
    const a = app(t);
    a.set(selector, '');
    a.calculate();
    assert.equal(a.q('#errors').hidden, false, selector);
    assert.equal(a.q('#result-content').hidden, true, selector);
    assert.ok(a.text('#errors').length > 0, selector);
  }
  const a = app(t);
  a.click('[data-mode="custom"]');
  a.set('#target', '');
  a.calculate();
  assert.match(a.text('#errors'), /目標平均/);
  assert.equal(a.q('#result-content').hidden, true);
});

test('blank card spend stays unknown, including when the deposit average qualifies', t => {
  const a = app(t);
  a.set('#card-spend', '');
  a.set('#initial', 400000);
  a.calculate();
  assert.equal(a.q('#errors').hidden, true);
  assert.match(a.text('#deposit-check'), /達標/);
  assert.match(a.text('#spending-check'), /未提供資料/);
  assert.match(a.text('#bank-conclusion'), /無法判斷雙門檻/);
});

test('custom mode ignores a hidden invalid card-spend field', t => {
  const a = app(t);
  a.set('#card-spend', -1);
  a.click('[data-mode="custom"]');
  a.calculate();
  assert.equal(a.q('#card-field').hidden, true);
  assert.equal(a.q('#bank-check').hidden, true);
  assert.equal(a.q('#errors').hidden, true);
  assert.equal(a.text('#average-value'), '278,709.68');
});

test('three-month example distinguishes weighted daily average and selected-date average', t => {
  const a = app(t);
  a.example('triple');
  assert.equal(a.q('#month-count').value, '3');
  assert.equal(a.q('#month-count').disabled, false);
  assert.match(a.text('#period-days'), /91 天/);
  assert.equal(a.text('#average-value'), '494,505.49');
  assert.equal(a.text('#topup-amount'), '16,667');
  assert.equal(a.document.querySelectorAll('#month-rows tr').length, 3);
  a.set('#method', 'snapshot', 'change');
  assert.equal(a.q('#snapshot-block').hidden, false);
  assert.deepEqual(Array.from(a.document.querySelectorAll('[data-snapshot]'), node => node.value), ['2026-09-30', '2026-10-31', '2026-11-30']);
  a.calculate();
  assert.equal(a.text('#average-value'), '500,000.00');
  assert.equal(a.text('#topup-amount'), '0');
  assert.equal(a.q('#snapshot-detail').hidden, false);
  assert.equal(a.document.querySelectorAll('#snapshot-rows tr').length, 3);
  assert.match(a.text('#formula'), /3 次/);
});

test('empty snapshot is rejected and is preserved through method updates', t => {
  const a = app(t);
  a.click('[data-mode="custom"]');
  a.set('#method', 'snapshot', 'change');
  a.set('[data-snapshot="2026-10"]', '');
  a.calculate();
  assert.equal(a.q('#errors').hidden, false);
  assert.match(a.text('#errors'), /2026-10.*採計日期/);
  a.set('#method', 'daily', 'change');
  a.calculate();
  assert.equal(a.q('#errors').hidden, true);
  a.set('#method', 'snapshot', 'change');
  assert.equal(a.q('[data-snapshot="2026-10"]').value, '');
  a.calculate();
  assert.equal(a.q('#errors').hidden, false);
});

test('selected snapshot dates affect eligibility while monthly averages remain daily', t => {
  const a = app(t);
  a.example('triple');
  a.set('[data-key="date"]', '2026-11-15');
  a.set('#topup-date', '2026-11-15');
  a.set('#method', 'snapshot', 'change');
  a.set('[data-snapshot="2026-11"]', '2026-11-14');
  a.calculate();
  assert.equal(a.text('#average-value'), '0.00');
  assert.equal(a.text('#topup-amount'), '無法達標');
  assert.match(a.text('#topup-count'), /0 次採計/);
  a.set('[data-snapshot="2026-11"]', '2026-11-16');
  a.set('#target', 600000);
  a.calculate();
  assert.equal(a.text('#average-value'), '500,000.00');
  assert.equal(a.text('#topup-amount'), '300,000');
  assert.equal(a.text('#after-average'), '600,000.00');
  assert.match(a.text('#month-rows tr:last-child'), /800,000.00/);
  assert.match(a.text('#snapshot-rows tr:last-child'), /2026\/11\/16/);
});

test('records can be added, edited and deleted with real recalculation', t => {
  const a = app(t);
  a.click('#add-record');
  assert.equal(a.text('#record-count'), '2 筆紀錄');
  a.set('[data-record]:last-child [data-key="amount"]', 10000);
  a.calculate();
  assert.equal(a.text('#average-value'), '288,709.68');
  a.set('[data-record]:last-child [data-key="type"]', 'withdrawal', 'change');
  a.calculate();
  assert.equal(a.text('#average-value'), '268,709.68');
  a.click('[data-record]:last-child [data-delete]');
  assert.equal(a.text('#record-count'), '1 筆紀錄');
  a.calculate();
  assert.equal(a.text('#average-value'), '278,709.68');
});

test('changing period preserves and flags out-of-period records', t => {
  const a = app(t);
  const original = a.q('[data-key="date"]').value;
  a.set('#check-month', '2026-12');
  assert.equal(a.document.querySelectorAll('[data-record]').length, 1);
  assert.equal(a.q('[data-key="date"]').value, original);
  assert.equal(a.q('[data-record]').classList.contains('outside'), true);
  assert.equal(a.q('[data-key="date"]').getAttribute('aria-invalid'), 'true');
  assert.match(a.text('.record-error'), /資料已保留/);
  a.calculate();
  assert.equal(a.q('#errors').hidden, false);
  assert.match(a.text('#errors'), /日期必須在/);
  a.set('#check-month', '2026-11');
  assert.equal(a.q('[data-record]').classList.contains('outside'), false);
  a.calculate();
  assert.equal(a.q('#errors').hidden, true);
});

test('example replacement supports cancel, Escape cancellation and explicit acceptance', t => {
  const a = app(t);
  a.set('#initial', 345678);
  a.click('[data-example="triple"]');
  assert.equal(a.q('#confirm-dialog').open, true);
  assert.equal(a.q('#initial').value, '345678');
  a.click('#confirm-cancel');
  assert.equal(a.q('#confirm-dialog').open, false);
  assert.equal(a.q('#initial').value, '345678');
  a.click('[data-example="triple"]');
  const cancel = new a.window.Event('cancel', { cancelable: true });
  a.q('#confirm-dialog').dispatchEvent(cancel);
  if (!cancel.defaultPrevented) a.q('#confirm-dialog').close();
  // A native Escape closes the dialog; stale callbacks must also have been discarded.
  a.click('#confirm-ok');
  assert.equal(a.q('#initial').value, '345678');
  a.example('triple');
  assert.equal(a.q('#initial').value, '0');
  assert.equal(a.q('#confirm-dialog').open, false);
  assert.equal(a.text('#average-value'), '494,505.49');
});

test('reset requires acceptance and clears inputs into a fresh local calculation', t => {
  const a = app(t);
  a.click('#reset');
  assert.match(a.text('#confirm-title'), /清空/);
  a.click('#confirm-cancel');
  assert.equal(a.text('#record-count'), '1 筆紀錄');
  a.click('#reset');
  a.click('#confirm-ok');
  assert.equal(a.text('#record-count'), '0 筆紀錄');
  assert.equal(a.q('#initial').value, '0');
  assert.equal(a.q('#card-spend').value, '');
  assert.equal(a.q('#check-month').value, '2026-11');
  assert.equal(a.q('#topup-date').value, '2026-10-16');
  assert.equal(a.q('#result-content').hidden, true);
  assert.match(a.text('#placeholder-title'), /從第一筆資產/);
});

test('three comparisons are independent and changing one does not change base results', t => {
  const a = app(t);
  const amounts = () => Array.from(a.document.querySelectorAll('.compare-output strong'), node => node.textContent);
  assert.deepEqual(amounts(), ['30,000', '55,000', '94,286']);
  const comparisonInput = a.q('#compare-0');
  comparisonInput.focus();
  a.set('#compare-0', '2026-10-20', 'change');
  assert.equal(a.q('#compare-0'), comparisonInput);
  assert.equal(a.document.activeElement, comparisonInput);
  assert.deepEqual(amounts(), ['55,000', '55,000', '94,286']);
  assert.equal(a.text('#average-value'), '278,709.68');
  assert.equal(a.text('#topup-amount'), '55,000');
  assert.equal(a.text('#record-count'), '1 筆紀錄');
  a.set('#compare-1', '', 'change');
  assert.deepEqual(amounts(), ['55,000', '—', '94,286']);
  assert.match(a.text('.comparison-card:nth-child(2)'), /選擇日期開始比較/);
});

test('zero-influence dates clearly show impossible plan and no invented average', t => {
  const a = app(t);
  a.set('#topup-date', '2026-11-01');
  a.calculate();
  assert.equal(a.q('#errors').hidden, true);
  assert.equal(a.text('#topup-amount'), '無法達標');
  assert.equal(a.text('#topup-count'), '可計入 0 天');
  assert.equal(a.text('#after-value'), '—');
  assert.equal(a.text('#after-average'), '—');
  assert.match(a.text('#topup-footnote'), /沒有可影響的採計日/);
  a.set('#compare-0', '2026-11-01', 'change');
  assert.match(a.text('.comparison-card:first-child'), /無法達標/);
});

test('historical dates and closed periods have distinct labels', t => {
  const a = app(t);
  assert.equal(a.text('#average-label'), '預估平均資產');
  assert.match(a.text('.comparison-card:first-child .history'), /歷史假設/);
  a.set('#topup-date', '2026-10-10');
  a.calculate();
  assert.match(a.text('#topup-heading'), /歷史假設/);
  a.set('#check-month', '2026-10');
  a.set('[data-key="date"]', '2026-09-10');
  a.set('#topup-date', '2026-09-20');
  a.calculate();
  assert.equal(a.text('#average-label'), '歷史平均資產試算');
  assert.match(a.text('#projection-note'), /無法現在補存修復過去平均/);
  assert.match(a.text('#topup-footnote'), /採計期間已結束/);
});

test('copy success emits the actual result, independent comparisons and qualification scope', async t => {
  const a = app(t);
  a.click('#copy-summary');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.copied.length, 1);
  assert.match(a.copied[0], /原有平均資產：NT\$ 278,709.68/);
  assert.match(a.copied[0], /最低追加 NT\$ 55,000/);
  assert.match(a.copied[0], /獨立比較方案（非同時補存）/);
  assert.match(a.copied[0], /不代表銀行正式資格認定/);
  assert.equal(a.text('#toast'), '試算摘要已複製');
  assert.equal(a.q('#copy-dialog').open, false);
});

test('missing or rejected clipboard falls back to selectable local text', async t => {
  for (const clipboard of ['missing', 'reject']) {
    const a = app(t, { clipboard });
    a.click('#copy-summary');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(a.q('#copy-dialog').open, true);
    assert.match(a.q('#summary-text').value, /55,000/);
    a.click('#select-summary');
    assert.equal(a.q('#summary-text').selectionStart, 0);
    assert.equal(a.q('#summary-text').selectionEnd, a.q('#summary-text').value.length);
    a.click('[data-close="copy-dialog"]');
    assert.equal(a.q('#copy-dialog').open, false);
  }
});

test('a hostile note remains literal after record rerender and never creates active elements', t => {
  const a = app(t);
  const hostile = '\"><img src=x onerror="window.noteExecuted=1"><script>window.noteExecuted=2</script>';
  a.set('[data-key="note"]', hostile);
  a.click('#add-record'); // Renders the original note back into an HTML attribute.
  assert.equal(a.q('[data-record]:first-child [data-key="note"]').value, hostile);
  assert.equal(a.document.querySelectorAll('#records img, #records script').length, 0);
  assert.equal(a.window.noteExecuted, undefined);
  assert.deepEqual(a.errors, []);
  a.click('[data-record]:last-child [data-delete]');
  a.calculate();
  assert.equal(a.text('#average-value'), '278,709.68');
});

test('guide opens and closes, while preset switches keep required fields consistent', t => {
  const a = app(t);
  a.click('#show-guide');
  assert.equal(a.q('#guide-dialog').open, true);
  a.click('[data-close="guide-dialog"]');
  assert.equal(a.q('#guide-dialog').open, false);
  a.click('[data-mode="custom"]');
  a.click('[data-months="3"]');
  a.click('[data-target="500000"]');
  assert.equal(a.q('#month-count').value, '3');
  assert.equal(a.q('#target').value, '500000');
  a.click('[data-mode="unicard"]');
  assert.equal(a.q('#month-count').value, '1');
  assert.equal(a.q('#target').value, '300000');
  assert.equal(a.q('#method').value, 'daily');
  assert.equal(a.q('#month-count').disabled, true);
  a.calculate();
  assert.equal(a.text('#topup-amount'), '55,000');
});
