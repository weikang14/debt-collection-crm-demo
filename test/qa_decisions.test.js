// Behaviour chosen in the 2026-10-25 decisions (D-01 … D-13) on the QA findings
// in docs/qa-reports/2026-10-24/04-final-assessment.md.
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-qadec-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const dayjs = require('dayjs');
const db = require('../src/db');
db.init();
const { todayMYT } = require('../src/utils/helpers');
const { router: casesRouter } = require('../src/routes/cases');
const ptpsRouter = require('../src/routes/ptps');
const tasksRouter = require('../src/routes/tasks');
const debtorsRouter = require('../src/routes/debtors');
const dashboardRouter = require('../src/routes/dashboard');
const { commissionRows } = require('../src/routes/commissions');
const { caseBalance, recomputeOutstanding } = require('../src/services/payments');
const { repaymentSchedule } = require('../src/utils/schedule');
const { createRestructure, undoRestructure, arrearsOf } = require('../src/services/restructure');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);
const ADMIN = { id: 1, username: 'admin', full_name: 'Admin', role: 'admin' };
const AGENT = { id: 2, username: 'ag', full_name: 'Agent One', role: 'agent', agent_id: 1 };
const today = todayMYT();
const ymd = d => d.format('YYYY-MM-DD');
const ago = n => ymd(dayjs(today).subtract(n, 'day'));

db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'自营业务',0)");
db.run("INSERT INTO debtors (id,name) VALUES (1,'D1')");
db.run("INSERT INTO agents (id,name,commission_rate) VALUES (1,'Agent One',10),(2,'Agent Two',10)");
db.run("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'admin','x','Admin','admin')");
db.run("INSERT INTO users (id,username,password_hash,full_name,role,agent_id) VALUES (2,'ag','x','Agent One','agent',1)");

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
let nextId = 100;
// A monthly-rate case created through the real form, starting `months` ago.
function monthlyCase({ months = 2, rate = '1.5', tenure = '12', principal = '10000', agent = '1', status } = {}) {
  const out = call(casesRouter, 'post', '/', { body: { debtor_id: '1', agent_id: agent, principal_amount: principal, interest_mode: 'monthly',
    interest_rate: rate, loan_start_date: ymd(dayjs(today).subtract(months, 'month')), tenure, ...(status ? { status } : {}) } });
  assert.ok(!isErr(out), errText(out));
  return Number(out.redirect.match(/\/cases\/(\d+)/)[1]);
}
const caseRow = id => db.get('SELECT * FROM cases WHERE id=?', [id]);
const pay = (id, amount, date = today, extra = {}) =>
  call(casesRouter, 'post', '/:id/payments', { params: { id: String(id) }, body: { payment_date: date, amount: String(amount), method: 'cash', ...extra } });

// ── D-01 · monthly rate accrues by whole months ───────────────────

const loan = (o = {}) => ({ interest_mode: 'monthly', interest_rate: 1.5, principal_amount: 10000, interest_from: '2026-01-01',
  opened_at: '2026-01-01', maturity_date: '2027-01-01', ...o });

test('D-01: 1.5%/month for 12 months is exactly 18% of principal', () => {
  const b = caseBalance(loan(), []);
  near(b.interest, 1800, 'interest');
  near(b.outstanding, 11800, 'outstanding');
});

test('D-01: a part month accrues its share of that month', () => {
  // 31 Jan → 14 Feb: half of the 31 Jan–28 Feb month (14 of 28 days).
  near(caseBalance(loan({ interest_from: '2026-01-31', maturity_date: null }), [], '2026-02-14').interest, 75, 'half month');
});

test('D-01: interest-first payments with whole-month accrual', () => {
  const m1 = 2 + 1 / 31;                       // 1 Jan → 2 Mar = 2 months + 1 day of March's 31
  const int1 = 10000 * 0.015 * m1;
  const remP = 10000 - (1000 - int1);
  const int2 = remP * 0.015 * (12 - m1);
  const b = caseBalance(loan(), [{ amount: 1000, payment_date: '2026-03-02' }]);
  near(b.interest, int1 + int2, 'total interest');
  near(b.principalRemaining, remP, 'principal after payment');
});

test('D-01: the schedule charges principal × monthly rate per month', () => {
  const rows = repaymentSchedule({ interest_mode: 'monthly', interest_rate: 1.5, principal_amount: 10000, tenure: 3, tenure_unit: 'months',
    loan_start_date: '2026-01-01', interest_from: '2026-01-01', outstanding_amount: 1 }, []);
  assert.deepStrictEqual(rows.map(r => r.expected_amount), [150, 150, 10150]);
});

// ── D-02 · early settlement = principal + interest to the payment date ─

test('D-02: an early payoff is capped at the settlement amount of that day', () => {
  const id = monthlyCase();                    // started exactly 2 months ago → 2 months of interest
  near(caseRow(id).outstanding_amount, 11800, 'contract balance');
  assert.ok(isErr(pay(id, 11800)), 'contract total is more than is owed today');
  assert.ok(isErr(pay(id, 10300.01)), 'one sen over the settlement amount');
  assert.ok(!isErr(pay(id, 10300)));
  const c = caseRow(id);
  near(c.outstanding_amount, 0, 'settled');
  assert.strictEqual(c.status, 'fully_paid');
});

test('D-02: the case page shows the contract balance, settlement today and arrears', () => {
  const id = monthlyCase();
  const l = call(casesRouter, 'get', '/:id', { params: { id: String(id) } }).locals;
  near(l.settlement, 10300, 'settlement today');
  near(l.c.outstanding_amount, 11800, 'contract balance');
  assert.ok(l.arrears && l.arrears.dpd > 0, 'two missed monthly instalments');
});

// ── D-03 · legal rate cap (single configurable cap, default 18% p.a.) ─

test('D-03: rates above the annual cap are refused; the cap is a setting', () => {
  assert.match(errText(call(casesRouter, 'post', '/', { body: { debtor_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.6' } })), /18% p\.a\./);
  assert.ok(isErr(call(casesRouter, 'post', '/', { body: { debtor_id: '1', principal_amount: '10000', interest_mode: 'daily', interest_rate: '18.5' } })));
  assert.ok(isErr(call(casesRouter, 'post', '/', { body: { debtor_id: '1', principal_amount: '10000', interest_amount: '2000', tenure: '12', loan_start_date: ago(1) } })));
  db.run('UPDATE settings SET max_annual_rate=24 WHERE id=1');
  assert.ok(!isErr(call(casesRouter, 'post', '/', { body: { debtor_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.6' } })));
  db.run('UPDATE settings SET max_annual_rate=18 WHERE id=1');
});

test('D-03: total interest may not exceed the principal', () => {
  // 1.5%/month is within 18% p.a., but over 120 months it is 180% of principal.
  assert.match(errText(call(casesRouter, 'post', '/', { body: { debtor_id: '1', principal_amount: '10000', interest_mode: 'monthly',
    interest_rate: '1.5', loan_start_date: ago(1), tenure: '120' } })), /exceed the principal/);
});

test('D-03: a restructure cannot raise the rate', () => {
  const id = monthlyCase({ rate: '1.2' });
  const r = createRestructure(id, { effective_date: today, interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', reason: 'r' }, { session: { user: ADMIN }, ip: '' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /raise the interest rate/);
});

// ── D-04 · a payment on the effective date belongs before the restructure ─

test('D-04: same-day payment is inside the cut; later payments must be after the date', () => {
  const id = monthlyCase();
  assert.ok(!isErr(pay(id, 5000)));
  const req = { session: { user: ADMIN }, ip: '' };
  assert.ok(createRestructure(id, { effective_date: today, interest_mode: 'monthly', interest_rate: '1.0', tenure: '12', reason: 'r' }, req).ok);
  const rs = db.get('SELECT * FROM case_restructures WHERE case_id=?', [id]);
  near(rs.principal_at_cut, 10000 - (5000 - 300), 'cut principal includes today\'s payment');
  near(rs.arrears_at_cut, 0, 'interest to date was paid');
  assert.match(errText(pay(id, 10)), /after the restructure date/);
  assert.ok(undoRestructure(id, rs.id, req).ok, 'a same-day payment does not block undo');
});

// ── D-05 · no field-visit task type in the moneylender edition ─────

test('D-05: new tasks cannot be field visits', () => {
  assert.ok(isErr(call(tasksRouter, 'post', '/new', { body: { title: 'Visit', type: 'visit' } })));
});

// ── D-12 · agent permissions ────────────────────────────────────────

test('D-12: agents cannot create debtors', () => {
  const layer = debtorsRouter.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post);
  let passed = false;
  layer.route.stack[1].handle({ session: { user: AGENT } }, { status() { return this; }, render() {} }, () => { passed = true; });
  assert.strictEqual(passed, false);
});

test('D-12: agents cannot close a case by hand; nobody marks an owing case Fully Paid', () => {
  const id = monthlyCase();
  for (const s of ['fully_paid', 'closed', 'cancelled', 'legal', 'bankruptcy', 'deceased']) {
    assert.ok(isErr(call(casesRouter, 'post', '/:id/status', { params: { id: String(id) }, body: { status: s }, user: AGENT })), s);
  }
  assert.ok(!isErr(call(casesRouter, 'post', '/:id/status', { params: { id: String(id) }, body: { status: 'negotiation' }, user: AGENT })));
  assert.ok(isErr(call(casesRouter, 'post', '/:id/status', { params: { id: String(id) }, body: { status: 'fully_paid' } })));
});

test('D-12: agents edit and delete only their own notes', () => {
  const id = monthlyCase();
  const nid = Number(db.run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,'note','by manager','Manager')", [id]).lastInsertRowid);
  assert.ok(isErr(call(casesRouter, 'post', '/:id/notes/:noteId/delete', { params: { id: String(id), noteId: String(nid) }, user: AGENT })));
  assert.ok(db.get('SELECT 1 FROM timeline_events WHERE id=?', [nid]));
});

test('D-12: "Due within: Today" lists only tasks due today', () => {
  db.run("INSERT INTO tasks (agent_id,title,due_date) VALUES (1,'t-overdue',?),(1,'t-today',?)", [ago(3), today]);
  const titles = call(tasksRouter, 'get', '/', { query: { window: '1' } }).locals.tasks.map(t => t.title);
  assert.ok(titles.includes('t-today'));
  assert.ok(!titles.includes('t-overdue'));
});

// ── D-09 · dashboard definitions, DPD ──────────────────────────────

test('D-09: arrears = overdue schedule amount and days past the oldest missed due date', () => {
  const c = { interest_mode: 'fixed', principal_amount: 1200, interest_amount: 0, tenure: 12, tenure_unit: 'months',
    loan_start_date: ymd(dayjs(today).subtract(3, 'month')), outstanding_amount: 1200 };
  const a = arrearsOf(c, [], []);
  near(a.overdue, 200, 'two instalments of 100 past due');
  assert.strictEqual(a.dpd, dayjs(today).diff(dayjs(today).subtract(2, 'month'), 'day'));
  assert.deepStrictEqual(arrearsOf({ ...c, tenure: null }, [], []), { dpd: null, overdue: null });
});

test('D-09: Fully Paid is not active; a payoff by payment counts as closed today', () => {
  const id = monthlyCase();
  const before = call(dashboardRouter, 'get', '/').locals.kpi;
  pay(id, 10300);
  const after = call(dashboardRouter, 'get', '/').locals.kpi;
  assert.strictEqual(after.activeCases, before.activeCases - 1);
  assert.strictEqual(after.closedToday, before.closedToday + 1);
  assert.ok(db.get("SELECT 1 FROM timeline_events WHERE case_id=? AND event_type='status_change' AND content LIKE '%fully_paid%'", [id]));
});

test('D-09: total outstanding leaves out closed and cancelled cases', () => {
  const id = monthlyCase();
  const before = call(dashboardRouter, 'get', '/').locals.kpi.outstanding;
  db.run("UPDATE cases SET status='cancelled' WHERE id=?", [id]);
  near(call(dashboardRouter, 'get', '/').locals.kpi.outstanding, before - caseRow(id).outstanding_amount, 'cancelled excluded');
});

// ── D-10 · PTP rules ───────────────────────────────────────────────

test('D-10: a partly paid promise is "partially kept"', () => {
  const id = monthlyCase();
  const pid = Number(db.run("INSERT INTO ptps (case_id,amount,due_date,status) VALUES (?,500,?, 'pending')", [id, today]).lastInsertRowid);
  call(ptpsRouter, 'post', '/:id/fulfill', { params: { id: String(pid) }, body: { amount: '200', payment_date: today, method: 'cash' } });
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [pid]).status, 'partially_kept');
});

test('D-10: promises are dated from today and stay within the settlement amount', () => {
  const id = monthlyCase();
  assert.ok(isErr(call(casesRouter, 'post', '/:id/ptps', { params: { id: String(id) }, body: { amount: '100', due_date: ago(1) } })));
  assert.ok(isErr(call(casesRouter, 'post', '/:id/ptp-plans', { params: { id: String(id) }, body: { total_amount: '300', num_installments: '3', first_due_date: ago(1) } })));
  assert.ok(!isErr(call(casesRouter, 'post', '/:id/ptps', { params: { id: String(id) }, body: { amount: '10000', due_date: today } })));
  assert.match(errText(call(casesRouter, 'post', '/:id/ptps', { params: { id: String(id) }, body: { amount: '400', due_date: today } })), /settlement/);
});

// ── D-11 · reassignment ────────────────────────────────────────────

test('D-11: commission follows the agent who collected; open tasks follow the case', () => {
  const id = monthlyCase({ agent: '1' });
  pay(id, 1000);
  db.run("INSERT INTO tasks (case_id,agent_id,title,status) VALUES (?,1,'open',  'pending'),(?,1,'closed','done')", [id, id]);
  call(casesRouter, 'post', '/:id', { params: { id: String(id) }, body: { debtor_id: '1', agent_id: '2', principal_amount: '10000',
    interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: caseRow(id).loan_start_date, tenure: '12' } });
  const month = today.slice(0, 7);
  const rows = commissionRows({ role: 'admin' }, month);
  near(rows.find(r => r.name === 'Agent Two').collected, 0, 'new agent did not collect it');
  assert.ok(rows.find(r => r.name === 'Agent One').collected >= 1000);
  assert.strictEqual(db.get("SELECT agent_id FROM tasks WHERE case_id=? AND title='open'", [id]).agent_id, 2);
  assert.strictEqual(db.get("SELECT agent_id FROM tasks WHERE case_id=? AND title='closed'", [id]).agent_id, 1);
});

// ── D-13 · bankruptcy / deceased ───────────────────────────────────

test('D-13: no promises, calls or restructures on bankrupt / deceased cases; payments need a reason', () => {
  const id = monthlyCase();
  db.run("UPDATE cases SET status='bankruptcy' WHERE id=?", [id]);
  const p = { id: String(id) };
  assert.ok(isErr(call(casesRouter, 'post', '/:id/ptps', { params: p, body: { amount: '100', due_date: today } })));
  assert.ok(isErr(call(casesRouter, 'post', '/:id/calls', { params: p, body: { result: 'answered' } })));
  assert.ok(isErr(call(casesRouter, 'post', '/:id/restructures', { params: p, body: { effective_date: today, interest_mode: 'monthly', interest_rate: '1', tenure: '12', reason: 'r' } })));
  assert.ok(isErr(pay(id, 100)), 'no reason given');
  assert.ok(!isErr(pay(id, 100, today, { remark: 'Paid by estate administrator' })));
  assert.strictEqual(db.get('SELECT remark FROM payments WHERE case_id=? ORDER BY id DESC', [id]).remark, 'Paid by estate administrator');
  assert.strictEqual(caseRow(id).status, 'bankruptcy');
});
