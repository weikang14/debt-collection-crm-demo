const { test, before } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.CRM_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-comm-')), 'crm.db');
const { init, run, get } = require('../src/db');
const { commissionRows } = require('../src/routes/commissions');

// Seed: 2 agents (rate 5% and 6%), each a case, agent A has 2 payments in
// 2026-07 (10000 total), agent B one payment in 2026-07 (5000).
before(() => {
  init();
  run("INSERT INTO agents (id,name,commission_rate,active) VALUES (1,'Agent A',5,1)");
  run("INSERT INTO agents (id,name,commission_rate,active) VALUES (2,'Agent B',6,1)");
  run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'C',0)");
  run("INSERT INTO debtors (id,name) VALUES (1,'D')");
  run("INSERT INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,status) VALUES (1,'K1',1,1,1,10000,0,0,'partial_paid')");
  run("INSERT INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,status) VALUES (2,'K2',1,1,2,5000,0,0,'partial_paid')");
  run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (1,'R1','2026-07-03',6000)");
  run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (1,'R2','2026-07-20 10:00:00',4000)");
  run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (2,'R3','2026-07-10',5000)");
  run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (1,'R4','2026-06-30',9999)"); // out of month
});

const admin = { role: 'admin' };
const agentA = { role: 'agent', agent_id: 1 };

test('earned = collected-in-month * rate, rounded', () => {
  const rows = commissionRows(admin, '2026-07');
  const a = rows.find(r => r.agent_id === 1);
  assert.strictEqual(a.collected, 10000);      // 6000+4000, June payment excluded
  assert.strictEqual(a.earned, 500);           // 10000 * 5%
  assert.strictEqual(a.settled, 0);
  assert.strictEqual(a.pending, 500);
});

test('all agents visible to admin, ordered by name', () => {
  const rows = commissionRows(admin, '2026-07');
  assert.deepStrictEqual(rows.map(r => r.name), ['Agent A', 'Agent B']);
  assert.strictEqual(rows.find(r => r.agent_id === 2).earned, 300); // 5000 * 6%
});

test('agent sees only own row', () => {
  const rows = commissionRows(agentA, '2026-07');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].agent_id, 1);
});

test('settled + pending reflect a recorded settlement', () => {
  run("INSERT INTO commission_settlements (agent_id,period,amount) VALUES (1,'2026-07',300)");
  const a = commissionRows(admin, '2026-07').find(r => r.agent_id === 1);
  assert.strictEqual(a.settled, 300);
  assert.strictEqual(a.pending, 200);
});
