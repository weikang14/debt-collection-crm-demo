// v1.12.0: the smoke-test findings (docs/qa-reports/2026-10-25/06-v1.11.0-冒烟测试结果.md,
// D-1 / D-2 / O-x) and the pre-launch items that needed no outside decision
// (05 report §5: G-23, G-24, G-25, G-27, G-28, G-29, K-01, F-24, F-25).
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-qar3-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const dayjs = require('dayjs');
const db = require('../src/db');
db.init();
const { todayMYT, round2 } = require('../src/utils/helpers');
const { router: casesRouter } = require('../src/routes/cases');
const ptpsRouter = require('../src/routes/ptps');
const debtorsRouter = require('../src/routes/debtors');
const usersRouter = require('../src/routes/users');
const dashboardRouter = require('../src/routes/dashboard');
const reportsRouter = require('../src/routes/reports');
const { caseBalance, settlementOn, localDate, rateCapError } = require('../src/services/payments');
const { createRestructure } = require('../src/services/restructure');
const { logAction } = require('../src/utils/audit');

const ADMIN = { id: 1, username: 'admin', full_name: 'Admin', role: 'admin' };
const today = todayMYT();
const ymd = d => d.format('YYYY-MM-DD');
const monthsAgo = n => ymd(dayjs(today).subtract(n, 'month'));

db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'自营业务',0)");
db.run("INSERT INTO debtors (id,name,phone) VALUES (1,'D1','011'),(2,'D2','022')");
db.run("INSERT INTO agents (id,name,commission_rate) VALUES (1,'Agent One',10),(2,'Agent Two',10)");
db.run("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'admin','x','Admin','admin'),(5,'fin','x','Fin','finance')");

function call(router, method, routePath, { params = {}, body = {}, query = {}, user = ADMIN } = {}) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method} ${routePath} exists`);
  const out = {};
  const res = { status(c) { out.status = c; return this; }, redirect(u) { out.redirect = u; },
    render(v, l) { out.view = v; out.locals = l; }, setHeader(k, v) { out[k] = v; }, send(b) { out.body = b; } };
  layer.route.stack[layer.route.stack.length - 1].handle({ params, body, query, session: { user }, ip: '127.0.0.1' }, res);
  return out;
}
const isErr = out => /[?&]err=/.test(out.redirect || '');
const text = (out, k) => decodeURIComponent(((out.redirect || '').match(new RegExp(k + '=([^&]*)')) || [, ''])[1].replace(/\+/g, ' '));
const newCase = body => {
  const out = call(casesRouter, 'post', '/', { body: { debtor_id: '1', agent_id: '1', principal_amount: '10000', ...body } });
  assert.ok(!isErr(out), text(out, 'err'));
  return Number(out.redirect.match(/\/cases\/(\d+)/)[1]);
};
const monthly = () => newCase({ interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', loan_start_date: monthsAgo(3) });
const pay = (id, amount, date = today, extra = {}) =>
  call(casesRouter, 'post', '/:id/payments', { params: { id: String(id) }, body: { amount: String(amount), payment_date: date, method: 'cash', ...extra } });
const caseRow = id => db.get('SELECT * FROM cases WHERE id=?', [id]);
const lastAudit = action => db.get('SELECT * FROM audit_logs WHERE action=? ORDER BY id DESC LIMIT 1', [action]);
const editBody = c => ({ debtor_id: String(c.debtor_id), agent_id: String(c.agent_id || ''), principal_amount: String(c.principal_amount),
  interest_mode: c.interest_mode, interest_rate: String(c.interest_rate), interest_amount: String(c.interest_amount),
  loan_start_date: c.loan_start_date || '', tenure: String(c.tenure || '') });

// ── Smoke-test findings ──────────────────────────────────────────

test('D-1: a stale interest_amount on a rate-based loan is not a term change', () => {
  const id = monthly();
  db.run('UPDATE cases SET interest_amount=228 WHERE id=?', [id]);          // as the v1.11 demo seed stored it
  db.run('UPDATE settings SET max_annual_rate=12 WHERE id=1');
  try {
    const out = call(casesRouter, 'post', '/:id', { params: { id: String(id) }, body: { ...editBody(caseRow(id)), agent_id: '2' } });
    assert.ok(!isErr(out), text(out, 'err'));
    assert.strictEqual(caseRow(id).agent_id, 2);
    // A real term change is still held to the cap.
    const out2 = call(casesRouter, 'post', '/:id', { params: { id: String(id) }, body: { ...editBody(caseRow(id)), interest_rate: '1.4' } });
    assert.match(text(out2, 'err'), /12% p\.a\. limit/);
  } finally { db.run('UPDATE settings SET max_annual_rate=18 WHERE id=1'); }
});

test('D-2: Fulfill on a bankrupt case points to Record Payment, even after its PTP was closed (PTP-16)', () => {
  const id = monthly();
  const pid = Number(db.run("INSERT INTO ptps (case_id,amount,due_date,status) VALUES (?,100,?,'pending')", [id, today]).lastInsertRowid);
  call(casesRouter, 'post', '/:id/status', { params: { id: String(id) }, body: { status: 'bankruptcy' } });
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [pid]).status, 'broken');
  const out = call(ptpsRouter, 'post', '/:id/fulfill', { params: { id: String(pid) }, body: { amount: '100', payment_date: today } });
  assert.match(text(out, 'err'), /Record this payment with a reason/);
});

test('O-1: the cap message shows the rate unrounded enough to see the excess', () => {
  assert.match(rateCapError({ interest_mode: 'monthly', interest_rate: 1.5004 }, 10000), /this loan: 18\.0048% p\.a\./);
});

test('O-5: a duplicate submission says it was ignored', () => {
  const id = monthly();
  assert.ok(!isErr(pay(id, 10, today, { reference: 'R1' })));
  const out = pay(id, 10, today, { reference: 'R1' });
  assert.match(text(out, 'ok'), /Duplicate submission ignored: payment RCPT-\d{4}-\d+ was already recorded/);
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM payments WHERE case_id=?', [id]).n, 1);
});

// ── Pre-launch items ─────────────────────────────────────────────

test('K-01: half a sen rounds up despite float residue', () => {
  assert.strictEqual(round2(1030.225), 1030.23);
  assert.strictEqual(round2(16.185), 16.19);
  assert.strictEqual(round2(0.1 + 0.2), 0.3);
  assert.strictEqual(round2(10.004), 10);
  // P = 1,015 at 1.5%/month for one month: interest 15.225 → 15.23, and outstanding = principal + interest.
  const c = { principal_amount: 1015, interest_mode: 'monthly', interest_rate: 1.5, interest_from: '2026-01-01', opened_at: '2026-01-01', maturity_date: '2026-02-01' };
  const b = caseBalance(c, [], '2026-02-01');
  assert.strictEqual(b.interest, 15.23);
  assert.strictEqual(b.outstanding, 1030.23);
});

test('G-27: the overpayment hint is the largest amount that is accepted', () => {
  const id = newCase({ interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', loan_start_date: monthsAgo(4) });
  assert.ok(!isErr(pay(id, 5000, monthsAgo(1))));
  // A backdated payment that, with the later 5,000, pays more than was owed (old hint: 5,364.50).
  const out = pay(id, 6000, monthsAgo(2));
  const hint = Number(text(out, 'err').match(/at most RM ([\d.]+)/)[1]);
  assert.ok(isErr(pay(id, round2(hint + 0.01), monthsAgo(2))), 'one sen more is refused');
  assert.ok(!isErr(pay(id, hint, monthsAgo(2))), 'the hint itself is accepted');
});

test('G-28: restructure figures and plan cancels are parsed strictly', () => {
  const id = newCase({ interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', loan_start_date: monthsAgo(3) });
  const base = { effective_date: today, tenure: '12', reason: 'x' };
  const req = { session: { user: ADMIN }, ip: '' };
  assert.strictEqual(createRestructure(id, { ...base, interest_mode: 'monthly', interest_rate: '0x1' }, req).error, 'Invalid interest rate');
  assert.strictEqual(createRestructure(id, { ...base, interest_mode: 'monthly', interest_rate: '1e0' }, req).error, 'Invalid interest rate');
  const fixedId = newCase({ interest_amount: '100', tenure: '12', loan_start_date: monthsAgo(3) });
  assert.strictEqual(createRestructure(fixedId, { ...base, interest_mode: 'fixed', interest_amount: '1e2' }, req).error, 'Invalid interest amount');
  assert.match(text(call(casesRouter, 'post', '/:id/ptp-plans/:planId/cancel', { params: { id: String(id), planId: 'nope' } }), 'err'), /plan not found/);
});

test('G-29: a stored UTC datetime is read as UTC whatever the host zone', () => {
  assert.strictEqual(localDate('2026-10-30 20:00:00'), '2026-10-31');   // 20:00 UTC = 04:00 MYT next day
  assert.strictEqual(localDate('2026-10-30 15:59:59'), '2026-10-30');
  assert.strictEqual(localDate('2026-10-30'), '2026-10-30');
});

test('G-23: the case list and cases.csv carry Settlement Today, Overdue and DPD; sort=dpd puts the most overdue first', () => {
  const late = newCase({ interest_amount: '1200', tenure: '12', loan_start_date: monthsAgo(5) });
  const list = call(casesRouter, 'get', '/', { query: { sort: 'dpd' } }).locals.cases;
  const row = list.find(c => c.id === late);
  assert.strictEqual(row.settlement, settlementOn(late, today));
  assert.ok(row.dpd > 0 && row.overdue > 0);
  const dpds = list.map(c => c.dpd ?? -1);
  assert.deepStrictEqual(dpds, [...dpds].sort((a, b) => b - a));
  const csv = call(casesRouter, 'get', '/', { query: { format: 'csv' } }).body;
  assert.match(csv.split('\r\n')[0], /Settlement Today,Overdue,DPD,Contract Balance/);
  assert.match(lastAudit('export').details, /cases\.csv/);
});

test('G-24: dashboard and report totals are settlement amounts, with the contract balance beside them', () => {
  const kpi = call(dashboardRouter, 'get', '/').locals.kpi;
  const open = db.all("SELECT id, outstanding_amount FROM cases WHERE status NOT IN ('closed','cancelled')");
  assert.strictEqual(kpi.outstanding, round2(open.reduce((s, c) => s + settlementOn(c.id, today), 0)));
  assert.strictEqual(kpi.contractOutstanding, round2(open.reduce((s, c) => s + c.outstanding_amount, 0)));
  assert.ok(kpi.contractOutstanding > kpi.outstanding, 'contract balance includes interest not yet due');
  const rep = call(reportsRouter, 'get', '/').locals.outstanding;
  assert.strictEqual(round2(rep.reduce((s, r) => s + r.total, 0)), round2(db.all('SELECT id FROM cases').reduce((s, c) => s + settlementOn(c.id, today), 0)));
  const csv = call(reportsRouter, 'get', '/', { query: { export: 'outstanding' } }).body;
  assert.match(csv.split('\r\n')[0], /Status,Cases,Settlement Today,Contract Balance/);
});

test('G-25: debtor and user edits record old → new; audit rows are never rewritten; a failed audit row rolls the change back', () => {
  call(debtorsRouter, 'post', '/:id', { params: { id: '2' }, body: { name: 'D2', phone: '033' } });
  assert.match(lastAudit('update').details, /phone: 022 → 033/);
  call(usersRouter, 'post', '/:id', { params: { id: '5' }, body: { username: 'fin', full_name: 'Finance Officer', role: 'finance', active: '1' } });
  assert.match(lastAudit('update').details, /full_name: Fin → Finance Officer/);
  assert.throws(() => db.run("UPDATE audit_logs SET details='x'"), /append-only/);
  // An audit row that can't be written (entity_type is NOT NULL) aborts the transaction it is in.
  assert.throws(() => db.db.transaction(() => {
    db.run("UPDATE debtors SET phone='999' WHERE id=2");
    logAction({ session: { user: ADMIN } }, 'update', null, 2, 'x');
  })());
  assert.strictEqual(db.get('SELECT phone FROM debtors WHERE id=2').phone, '033');
  // Transactions nest by joining the open one.
  db.db.transaction(() => db.db.transaction(() => db.run("UPDATE debtors SET remark='nested' WHERE id=2"))())();
  assert.strictEqual(db.get('SELECT remark FROM debtors WHERE id=2').remark, 'nested');
});

test('F-24: an edited or voided payment keeps its earlier row; terms and debtor lock once money is received', () => {
  const id = newCase({ interest_amount: '1200', tenure: '12', loan_start_date: monthsAgo(2) });
  assert.ok(!isErr(pay(id, 100, today, { reference: 'A' })));
  const p = db.get('SELECT * FROM payments WHERE case_id=?', [id]);
  call(casesRouter, 'post', '/:id/payments/:pid', { params: { id: String(id), pid: String(p.id) }, body: { amount: '150', payment_date: today, method: 'cash' } });
  call(casesRouter, 'post', '/:id/payments/:pid/void', { params: { id: String(id), pid: String(p.id) }, body: { reason: 'Bounced cheque' } });
  const hist = db.all('SELECT change, amount, reason FROM payment_history WHERE payment_id=? ORDER BY id', [p.id]);
  assert.deepStrictEqual(hist.map(r => [r.change, r.amount, r.reason]), [['edit', 100, null], ['void', 150, 'Bounced cheque']]);
  assert.throws(() => db.run('UPDATE payment_history SET amount=0'), /append-only/);
  assert.match(lastAudit('payment_void').details, /Bounced cheque/);
  const page = call(casesRouter, 'get', '/:id', { params: { id: String(id) } }).locals;
  assert.strictEqual(page.voided.length, 1);

  assert.ok(!isErr(pay(id, 100, today, { reference: 'B' })));
  const before = caseRow(id);
  call(casesRouter, 'post', '/:id', { params: { id: String(id) }, body: { ...editBody(before), principal_amount: '20000', debtor_id: '2', agent_id: '2' } });
  const after = caseRow(id);
  assert.deepStrictEqual([after.principal_amount, after.debtor_id, after.agent_id], [before.principal_amount, before.debtor_id, 2]);
  assert.strictEqual(call(casesRouter, 'get', '/:id/edit', { params: { id: String(id) } }).locals.termsLocked, true);
});

test('F-25: each live payment has a printable receipt; a voided one does not', () => {
  const id = monthly();
  assert.ok(!isErr(pay(id, 50, today, { reference: 'RC' })));
  const p = db.get('SELECT * FROM payments WHERE case_id=?', [id]);
  const out = call(casesRouter, 'get', '/:id/payments/:pid/receipt', { params: { id: String(id), pid: String(p.id) } });
  assert.strictEqual(out.view, 'cases/receipt');
  assert.strictEqual(out.locals.p.receipt_no, p.receipt_no);
  call(casesRouter, 'post', '/:id/payments/:pid/void', { params: { id: String(id), pid: String(p.id) }, body: {} });
  assert.strictEqual(call(casesRouter, 'get', '/:id/payments/:pid/receipt', { params: { id: String(id), pid: String(p.id) } }).status, 404);
});
