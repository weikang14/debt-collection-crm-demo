process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-money-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();

const { round2 } = require('../src/utils/helpers');

test('round2 snaps to whole cents and absorbs float residue', () => {
  assert.strictEqual(round2(0.1 + 0.2), 0.3);   // 0.30000000000000004 -> 0.3
  assert.strictEqual(round2(12.345), 12.35);
  assert.strictEqual(round2('7.1'), 7.1);
  assert.strictEqual(round2(null), 0);
});

const { recordSettlement } = require('../src/routes/commissions');

test('commission settlement amount is parsed like a payment: whole sen only (G-28)', () => {
  db.run("INSERT INTO agents (id,name,commission_rate) VALUES (1,'A',10)");
  const req = { session: { user: { full_name: 'T' } }, ip: '127.0.0.1' };
  for (const bad of ['10.005', '0x10', '1e2']) {
    assert.deepStrictEqual(recordSettlement({ agent_id: 1, period: '2026-07', amount: bad }, req), { ok: false, error: 'Invalid amount' }, bad);
  }
  const r = recordSettlement({ agent_id: 1, period: '2026-07', amount: '10.01' }, req);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.get('SELECT amount FROM commission_settlements WHERE id=?', [r.id]).amount, 10.01);
});

const { toCsv } = require('../src/utils/csv');

test('CSV money cells carry no sub-cent float noise', () => {
  const paidRaw = 0.1 + 0.2;                     // 0.30000000000000004
  assert.ok(/0\.30000000000000004/.test(toCsv(['Paid'], [[paidRaw]])), 'sanity: raw float is noisy');
  const csv = toCsv(['Paid'], [[round2(paidRaw)]]);
  assert.ok(!/0\.30000000000000004/.test(csv), 'raw float leaked into CSV');
  assert.ok(/0\.3(\D|$)/.test(csv), 'expected 0.3 in CSV');
});
