// Second-round QA fixes (docs/qa-reports/2026-10-25/04-final-assessment.md, G-xx)
// with the decisions N-01 … N-14 taken as recommended.
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-qar2-' + process.pid + '.db');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const dayjs = require('dayjs');
const ejs = require('ejs');
const db = require('../src/db');
db.init();
const h = require('../src/utils/helpers');
const { todayMYT } = h;
const { router: casesRouter } = require('../src/routes/cases');
const tasksRouter = require('../src/routes/tasks');
const dashboardRouter = require('../src/routes/dashboard');
const { parseMaxRate, settingsChanges } = require('../src/routes/settings');
const { caseBalance } = require('../src/services/payments');
const { repaymentSchedule } = require('../src/utils/schedule');
const { createRestructure, arrearsOf } = require('../src/services/restructure');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);
const ADMIN = { id: 1, username: 'admin', full_name: 'Admin', role: 'admin' };
const MANAGER = { id: 3, username: 'mgr', full_name: 'Manager', role: 'manager' };
const AGENT = { id: 2, username: 'ag', full_name: 'Agent One', role: 'agent', agent_id: 1 };
const today = todayMYT();
const ymd = d => d.format('YYYY-MM-DD');
const req = user => ({ session: { user }, ip: '' });

db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'自营业务',0)");
db.run("INSERT INTO debtors (id,name) VALUES (1,'D1')");
db.run("INSERT INTO agents (id,name,commission_rate) VALUES (1,'Agent One',10),(2,'Agent Two',10)");

function call(router, method, routePath, { params = {}, body = {}, query = {}, user = ADMIN } = {}) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method} ${routePath} exists`);
  const out = {};
  const res = { status(c) { out.status = c; return this; }, redirect(u) { out.redirect = u; },
    render(v, l) { out.view = v; out.locals = l; }, setHeader() {}, send(b) { out.body = b; } };
  layer.route.stack[layer.route.stack.length - 1].handle({ params, body, query, session: { user }, ip: '127.0.0.1' }, res);
  return out;
}
const isErr = out => /[?&]err=/.test(out.redirect || '');
const errText = out => decodeURIComponent(((out.redirect || '').match(/err=([^&]*)/) || [, ''])[1].replace(/\+/g, ' '));
const newCase = body => {
  const out = call(casesRouter, 'post', '/', { body: { debtor_id: '1', agent_id: '1', principal_amount: '10000', ...body } });
  assert.ok(!isErr(out), errText(out));
  return Number(out.redirect.match(/\/cases\/(\d+)/)[1]);
};
const caseRow = id => db.get('SELECT * FROM cases WHERE id=?', [id]);
const start = n => ymd(dayjs(today).subtract(n, 'month'));

// ── Demo-blocking ────────────────────────────────────────────────

test('G-01 / N-02: a loan that charges interest needs a tenure', () => {
  assert.match(errText(call(casesRouter, 'post', '/', { body: { debtor_id: '1', principal_amount: '10000', interest_amount: '200' } })), /Tenure is required/);
  assert.match(errText(call(casesRouter, 'post', '/', { body: { debtor_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5' } })), /Tenure is required/);
  newCase({ interest_amount: '0' });                                   // principal-only: no term needed
  newCase({ interest_amount: '150', tenure: '12', loan_start_date: start(1) });
  // An older case without a tenure can still be reassigned (terms unchanged).
  db.run("INSERT INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,status) VALUES (50,'OLD',1,1,1,1000,200,1200,'new')");
  assert.ok(!isErr(call(casesRouter, 'post', '/:id', { params: { id: '50' }, body: { debtor_id: '1', agent_id: '2', principal_amount: '1000', interest_amount: '200' } })));
});

test('G-14: the cap compares the unrounded rate', () => {
  assert.ok(isErr(call(casesRouter, 'post', '/', { body: { debtor_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5004', tenure: '12' } })));
  newCase({ interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', loan_start_date: start(1) });
});

test('G-15: the tenure unit is always months', () => {
  const id = newCase({ interest_amount: '100', tenure: '30', tenure_unit: 'days', loan_start_date: start(1) });
  assert.strictEqual(caseRow(id).tenure_unit, 'months');
});

test('G-03 / N-03: the rate cap can only be lowered, and changes are audited', () => {
  assert.match(parseMaxRate('24', 18).error, /18/);
  assert.strictEqual(parseMaxRate('12', 18).value, 12);
  assert.strictEqual(parseMaxRate('', 15).value, 15);
  assert.ok(parseMaxRate('0', 18).error);
  assert.deepStrictEqual(settingsChanges({ company_name: 'A', max_annual_rate: 18 }, { company_name: 'A', max_annual_rate: 12 }), ['max_annual_rate: 18 → 12']);
});

test('G-02 / N-08: only a manager lifts a closed or frozen status, and lifting bankruptcy needs a reason', () => {
  const id = newCase({ interest_amount: '0' });
  const p = { id: String(id) };
  for (const s of ['legal', 'bankruptcy', 'fully_paid']) {
    db.run('UPDATE cases SET status=?, outstanding_amount=? WHERE id=?', [s, s === 'fully_paid' ? 0 : 10000, id]);
    assert.ok(isErr(call(casesRouter, 'post', '/:id/status', { params: p, body: { status: 'negotiation' }, user: AGENT })), s);
  }
  db.run("UPDATE cases SET status='bankruptcy', outstanding_amount=10000 WHERE id=?", [id]);
  assert.match(errText(call(casesRouter, 'post', '/:id/status', { params: p, body: { status: 'negotiation' }, user: MANAGER })), /reason/i);
  assert.ok(!isErr(call(casesRouter, 'post', '/:id/status', { params: p, body: { status: 'negotiation', reason: 'Bankruptcy order annulled' }, user: MANAGER })));
  assert.match(db.get("SELECT details FROM audit_logs WHERE action='status_change' ORDER BY id DESC").details, /Bankruptcy order annulled/);
});

test('G-02: reopening a closed case clears its closing time', () => {
  const id = newCase({ interest_amount: '0' });
  call(casesRouter, 'post', '/:id/status', { params: { id: String(id) }, body: { status: 'closed' } });
  assert.ok(caseRow(id).closed_at);
  call(casesRouter, 'post', '/:id/status', { params: { id: String(id) }, body: { status: 'negotiation' } });
  assert.strictEqual(caseRow(id).closed_at, null);
});

test('N-08: freezing a case breaks its open promises; frozen cases take only legal tasks', () => {
  const id = newCase({ interest_amount: '0' });
  db.run("INSERT INTO ptps (case_id,amount,due_date,status) VALUES (?,100,?,'pending')", [id, today]);
  const before = call(dashboardRouter, 'get', '/').locals.kpi.ptpToday;
  call(casesRouter, 'post', '/:id/status', { params: { id: String(id) }, body: { status: 'bankruptcy' } });
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE case_id=?', [id]).status, 'broken');
  assert.strictEqual(call(dashboardRouter, 'get', '/').locals.kpi.ptpToday, before - 1);
  assert.ok(isErr(call(tasksRouter, 'post', '/new', { body: { case_id: String(id), type: 'follow_up', title: 'Call next of kin' } })));
  assert.ok(!isErr(call(tasksRouter, 'post', '/new', { body: { case_id: String(id), type: 'legal', title: 'File proof of debt' } })));
});

test('G-04 / N-01: carried arrears fall due with the first new instalment', () => {
  const rows = repaymentSchedule({ interest_mode: 'fixed', principal_amount: 1200, interest_amount: 0, loan_start_date: '2026-01-01', tenure: 12,
    tenure_unit: 'months', outstanding_amount: 1240 }, [], { arrears: 40 });
  assert.strictEqual(rows[0].kind, 'arrears');
  assert.strictEqual(rows[0].due_date, rows[1].due_date);
  assert.strictEqual(rows[0].due_date, '2026-02-01');
});

test('G-05: the formula help no longer describes the old ÷30 rule, and its script parses', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/cases/form.ejs'), 'utf8');
  assert.doesNotMatch(src, /÷ ?30/);
  const formulas = src.match(/var F=\{[\s\S]*?\n\s*\};/);
  assert.ok(formulas, 'formula table found');
  assert.doesNotThrow(() => new Function(formulas[0]), 'an unescaped quote would break the page script');
});

test('G-08: a plan header counts only fully kept instalments', async () => {
  const ptps = [1, 2, 3].map(i => ({ id: i, amount: 100, due_date: today, status: ['fulfilled', 'partially_kept', 'pending'][i - 1], plan_id: 'P', installment_no: i, plan_size: 3 }));
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/cases/show.ejs'), {
    layout: () => {}, h, c: { id: 1, case_no: 'X', status: 'ptp', outstanding_amount: 300, principal_amount: 300, interest_charged: 0, opened_at: '2026-01-01', debtor_id: 1, priority: 'low' },
    timeline: [], tasks: [], calls: [], schedule: [], scheduleHistory: [], lastRestructure: null, lock: null, lockMin: null, restructureForm: null, canUndo: false,
    settlement: 300, arrears: { dpd: null, overdue: null }, frozen: false, statuses: ['ptp'], terminal: [], readOnly: false, currentUser: { role: 'admin' }, payments: [], ptps });
  assert.match(html, /1\/3 kept · 1 partial/);
});

// ── Same batch (pre-launch, decided) ─────────────────────────────

test('G-12 / N-06: overdue never exceeds what would settle the loan today', () => {
  // Matured 3-month loan; a 9,000 prepayment half a month in leaves little owed,
  // but the plan's FIFO still shows most of the last instalment as overdue.
  const c = { interest_mode: 'monthly', interest_rate: 1.5, principal_amount: 10000, interest_amount: 0, interest_from: '2026-01-01', opened_at: '2026-01-01',
    loan_start_date: '2026-01-01', tenure: 3, tenure_unit: 'months', maturity_date: '2026-04-01', outstanding_amount: 1 };
  const pays = [{ amount: 9000, payment_date: '2026-01-16' }];
  const settle = caseBalance(c, pays, today).outstanding;
  const a = arrearsOf(c, pays, []);
  assert.ok(a.overdue <= settle + 0.005, `${a.overdue} <= ${settle}`);
});

test('G-20: the reason for a payment on a frozen case is on the timeline and in the audit', () => {
  const id = newCase({ interest_amount: '0' });
  db.run("UPDATE cases SET status='deceased' WHERE id=?", [id]);
  call(casesRouter, 'post', '/:id/payments', { params: { id: String(id) }, body: { payment_date: today, amount: '50', method: 'cash', remark: 'Paid by the estate' } });
  assert.ok(db.get("SELECT 1 FROM timeline_events WHERE case_id=? AND content LIKE '%Paid by the estate%'", [id]));
  assert.match(db.get("SELECT details FROM audit_logs WHERE action='payment' ORDER BY id DESC").details, /Paid by the estate/);
});

test('G-21: resubmitting the same payment form records one payment', () => {
  const id = newCase({ interest_amount: '0' });
  const body = { payment_date: today, amount: '75', method: 'cash', reference: 'TXN-1' };
  call(casesRouter, 'post', '/:id/payments', { params: { id: String(id) }, body });
  call(casesRouter, 'post', '/:id/payments', { params: { id: String(id) }, body });
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM payments WHERE case_id=?', [id]).n, 1);
  call(casesRouter, 'post', '/:id/payments', { params: { id: String(id) }, body: { ...body, reference: 'TXN-2' } });
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM payments WHERE case_id=?', [id]).n, 2, 'a different reference is a different payment');
});

test('N-09: a rate-based loan cannot be restructured to a fixed amount (pending legal review)', () => {
  const id = newCase({ interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', loan_start_date: start(2) });
  const r = createRestructure(id, { effective_date: today, interest_mode: 'fixed', interest_amount: '100', tenure: '12', reason: 'r' }, req(ADMIN));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /fixed/i);
});

test('N-11: interest after a restructure plus carried arrears may not exceed the principal at the cut', () => {
  const id = newCase({ interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', loan_start_date: start(1) });
  // 150 interest + 6,200 principal paid today -> 3,800 left; 1.5% x 120 months = 6,840 > 3,800.
  call(casesRouter, 'post', '/:id/payments', { params: { id: String(id) }, body: { payment_date: today, amount: '6350', method: 'cash' } });
  const r = createRestructure(id, { effective_date: today, interest_mode: 'monthly', interest_rate: '1.5', tenure: '120', reason: 'r' }, req(ADMIN));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /remaining principal/);
  assert.ok(createRestructure(id, { effective_date: today, interest_mode: 'monthly', interest_rate: '1.5', tenure: '24', reason: 'r' }, req(ADMIN)).ok);
});

test('N-13: unassigning a case leaves its open tasks with the previous agent', () => {
  const id = newCase({ interest_amount: '0' });
  db.run("INSERT INTO tasks (case_id,agent_id,title,status) VALUES (?,1,'keep me','pending')", [id]);
  call(casesRouter, 'post', '/:id', { params: { id: String(id) }, body: { debtor_id: '1', agent_id: '', principal_amount: '10000', interest_amount: '0' } });
  assert.strictEqual(db.get("SELECT agent_id FROM tasks WHERE title='keep me'").agent_id, 1);
});

test('N-14 / G-22: a payment dated before interest starts is refused', () => {
  const id = newCase({ interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', loan_start_date: start(1) });
  const before = ymd(dayjs(start(1)).subtract(1, 'day'));
  assert.match(errText(call(casesRouter, 'post', '/:id/payments', { params: { id: String(id) }, body: { payment_date: before, amount: '10', method: 'cash' } })), /before the loan start/);
});
