// Demo-data findings from the 2026-10-24 QA (F-10, F-11, F-13, F-14).
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-qademo-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const db = require('../src/db');
const { seedDemo, deleteDemo } = require('../src/db/seed');
const { commissionRows } = require('../src/routes/commissions');

seedDemo();

test('F-11: demo commissions never start with a negative pending amount', () => {
  const rows = commissionRows({ role: 'admin' }, dayjs().format('YYYY-MM'));
  assert.ok(rows.some(r => r.settled > 0), 'demo still shows settlements');
  for (const r of rows) assert.ok(r.pending >= 0, `${r.name} pending ${r.pending}`);
});

test('F-11: the fulfilled demo PTP matches the payment actually received', () => {
  const ptp = db.get("SELECT amount, due_date FROM ptps WHERE case_id=5 AND status='fulfilled'");
  const pay = db.get('SELECT amount, payment_date FROM payments WHERE case_id=5');
  assert.strictEqual(ptp.amount, pay.amount);
  assert.strictEqual(ptp.due_date, pay.payment_date);
});

test('F-11: demo dates carry no time of day', () => {
  assert.ok(db.all('SELECT due_date FROM ptps').every(p => /^\d{4}-\d{2}-\d{2}$/.test(p.due_date)));
  assert.ok(db.all("SELECT content FROM timeline_events WHERE is_demo=1").every(e => !/\d{2}:\d{2}:\d{2}/.test(e.content)));
});

test('F-13: demo debtors are not named after public figures', () => {
  const names = db.all('SELECT name FROM debtors').map(d => d.name);
  for (const real of ['Wong Kar Wai', 'Lee Chong Wei']) assert.ok(!names.includes(real), real);
});

test('F-14: each demo task belongs to its case\'s agent', () => {
  const bad = db.all('SELECT t.title FROM tasks t JOIN cases c ON c.id=t.case_id WHERE t.agent_id IS NOT c.agent_id');
  assert.deepStrictEqual(bad, []);
});

test('demo accounts use the same bcrypt cost as new accounts', () => {
  assert.strictEqual(bcrypt.getRounds(db.get("SELECT password_hash p FROM users WHERE username='admin'").p), 10);
});

test('G-10 / N-04: demo IC numbers are obviously invalid (month 00)', () => {
  for (const d of db.all('SELECT ic_passport FROM debtors')) assert.match(d.ic_passport, /^\d{2}00\d{2}-00-\d{4}$/);
});

test('N-02: every demo loan that charges interest has a term', () => {
  const bad = db.all("SELECT case_no FROM cases WHERE tenure IS NULL AND (interest_amount > 0 OR interest_rate > 0)");
  assert.deepStrictEqual(bad, []);
});

test('F-10: delete demo data keeps a demo agent still referenced by trial rows', () => {
  db.run("INSERT INTO commission_settlements (agent_id,period,amount,is_demo) VALUES (4,'2026-10',10,0)");
  db.run("INSERT INTO tasks (agent_id,title,is_demo) VALUES (4,'trial task',0)");
  // G-06: a trial payment collected by demo agent 3 on a trial case.
  db.run("INSERT INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,outstanding_amount,is_demo) VALUES (900,'TRIAL-1',1,1,1,100,100,0)");
  db.run("INSERT INTO payments (case_id,receipt_no,payment_date,amount,agent_id,is_demo) VALUES (900,'TRIAL-R1','2026-10-01',10,3,0)");
  assert.doesNotThrow(() => deleteDemo());
  assert.ok(db.get('SELECT 1 FROM agents WHERE id=4'), 'agent 4 kept');
  assert.ok(db.get('SELECT 1 FROM agents WHERE id=3'), 'agent 3 kept (collected a trial payment)');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM cases WHERE is_demo=1').n, 0);
});
