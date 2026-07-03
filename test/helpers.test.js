const { test } = require('node:test');
const assert = require('node:assert');
const h = require('../src/utils/helpers');

test('money formats with 2dp and thousands', () => {
  assert.strictEqual(h.money(1234.5), '1,234.50');
  assert.strictEqual(h.money(0), '0.00');
  assert.strictEqual(h.money(1000000), '1,000,000.00');
});
test('caseStatusClass maps semantics', () => {
  assert.strictEqual(h.caseStatusClass('fully_paid'), 'is-green');
  assert.strictEqual(h.caseStatusClass('legal'), 'is-red');
  assert.strictEqual(h.caseStatusClass('ptp'), 'is-gold');
  assert.strictEqual(h.caseStatusClass('new'), 'is-neutral');
});
test('icon returns inline svg string', () => {
  assert.match(h.icon('dashboard'), /^<svg/);
});
test('dateTimeFmt converts stored UTC to MYT (+8)', () => {
  // SQLite stores UTC; Malaysia is UTC+8
  assert.strictEqual(h.dateTimeFmt('2026-07-03 14:30:00'), '2026-07-03 22:30');
});
test('dateFmt of a UTC datetime rolls to the correct MYT date', () => {
  // 20:00 UTC = 04:00 next day in MYT
  assert.strictEqual(h.dateFmt('2026-07-03 20:00:00'), '2026-07-04');
});
test('dateFmt of a date-only value is unchanged by the +8 shift', () => {
  assert.strictEqual(h.dateFmt('2026-07-10'), '2026-07-10');
});
test('date helpers return empty string for null/undefined', () => {
  assert.strictEqual(h.dateFmt(null), '');
  assert.strictEqual(h.dateTimeFmt(undefined), '');
});
