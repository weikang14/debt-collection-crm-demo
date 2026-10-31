// Regression tests for the QA findings fixed without a business decision
// (docs/qa-reports/2026-10-24/04-final-assessment.md, F-xx numbers).
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-qafix-' + process.pid + '.db');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const ejs = require('ejs');
const bcrypt = require('bcryptjs');
const db = require('../src/db');
db.init();
const h = require('../src/utils/helpers');
const { todayMYT } = h;
const { router: casesRouter } = require('../src/routes/cases');
const ptpsRouter = require('../src/routes/ptps');
const tasksRouter = require('../src/routes/tasks');
const reportsRouter = require('../src/routes/reports');
const dashboardRouter = require('../src/routes/dashboard');
const auditRouter = require('../src/routes/audit');
const usersRouter = require('../src/routes/users');
const agentsRouter = require('../src/routes/agents');
const debtorsRouter = require('../src/routes/debtors');
const authRouter = require('../src/routes/auth');
const { router: commissionsRouter } = require('../src/routes/commissions');
const { nextReceiptNo } = require('../src/utils/numbering');
const { validatePayment } = require('../src/utils/forms');
const { toCsv } = require('../src/utils/csv');
const { attachUser } = require('../src/middleware/auth');
const { sameOrigin, securityHeaders, flash, errorHandler } = require('../src/middleware/security');
const { recomputeOutstanding, refreshStaleAccruals } = require('../src/services/payments');

const ADMIN = { id: 1, username: 'admin', full_name: 'Admin', role: 'admin' };
const days = n => new Date(Date.now() + 8 * 3600000 + n * 86400000).toISOString().slice(0, 10);

db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'自营业务',0)");
db.run("INSERT INTO debtors (id,name) VALUES (1,'D1')");
db.run("INSERT INTO agents (id,name,commission_rate,target_amount) VALUES (1,'A1',5.5,0)");
db.run("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'admin','x','Admin','admin')");
db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,interest_charged,outstanding_amount,status)
  VALUES (1,'QA-1',1,1,1,1000,0,0,1000,'negotiation')`);

// Run a route's final handler and capture what it did.
function call(router, method, routePath, { params = {}, body = {}, query = {}, user = ADMIN } = {}) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method} ${routePath} exists`);
  const out = { headers: {} };
  const res = {
    status(c) { out.status = c; return this; },
    redirect(u) { out.redirect = u; },
    render(v, l) { out.view = v; out.locals = l; },
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    send(b) { out.body = b; },
  };
  const req = { params, body, query, session: { user }, ip: '127.0.0.1' };
  layer.route.stack[layer.route.stack.length - 1].handle(req, res);
  out.req = req;
  return out;
}
const isErr = out => /[?&]err=/.test(out.redirect || '');
const count = (sql, p = []) => db.get(sql, p).n;
const lastAudit = action => db.get('SELECT * FROM audit_logs WHERE action=? ORDER BY id DESC LIMIT 1', [action]);

// ── Demo-blocking ────────────────────────────────────────────────

test('F-03: voiding the newest receipt never frees its number', () => {
  const n1 = nextReceiptNo();
  db.run('INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (1,?,?,1)', [n1, '2026-01-01']);
  const n2 = nextReceiptNo();
  db.run('INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (1,?,?,1)', [n2, '2026-01-01']);
  db.run('DELETE FROM payments WHERE receipt_no IN (?,?)', [n1, n2]);
  const n3 = nextReceiptNo();
  assert.notStrictEqual(n3, n2);
  assert.strictEqual(Number(n3.slice(-4)), Number(n2.slice(-4)) + 1);
});

function renderShow(extra = {}) {
  const c = { id: 1, case_no: 'QA-1', status: 'ptp', outstanding_amount: 500, principal_amount: 1000, interest_charged: 0, opened_at: '2026-01-01 00:00:00',
    debtor_id: 1, debtor_name: 'D1', priority: 'medium', interest_mode: 'fixed' };
  return ejs.renderFile(path.join(__dirname, '../src/views/cases/show.ejs'), {
    layout: () => {}, h, c, timeline: [], tasks: [], calls: [], schedule: [], scheduleHistory: [], lastRestructure: null, lock: null, lockMin: null,
    settlement: 500, arrears: { dpd: null, overdue: null }, frozen: false,
    restructureForm: null, canUndo: false, statuses: ['new'], terminal: [], readOnly: false, currentUser: { role: 'admin' },
    payments: [{ id: 7, receipt_no: 'R-7', payment_date: '2026-10-01', amount: 10, method: 'cash', reference: "O'Brien');alert(1);//", bank: '' }],
    ptps: [{ id: 3, amount: 5, due_date: '2026-11-01', status: 'pending' }], ...extra });
}

test('F-04: payment Edit passes values through data-* attributes, never inline script', async () => {
  const html = await renderShow();
  assert.doesNotMatch(html, /openEditPayment\(7/);
  assert.match(html, /data-ref="O&#39;Brien&#39;\);alert\(1\);\/\/"/);
});

test('F-57: PTP Break asks for confirmation', async () => {
  assert.match(await renderShow(), /action="\/ptps\/3\/break"[^>]*onsubmit="return confirm\(/);
});

test('F-07 / F-58: statement shows the loan terms and a standard page title', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/cases/statement.ejs'), {
    h, today: '2026-10-24', company: {}, payments: [], paid: 0, settlement: 1030, arrears: { dpd: 12, overdue: 15 },
    c: { id: 1, case_no: 'QA-1', debtor_name: 'D1', status: 'negotiation', principal_amount: 1000, interest_charged: 90, outstanding_amount: 1090,
      loan_start_date: '2026-01-01', interest_mode: 'monthly', interest_rate: 1.5, interest_amount: 0, tenure: 12, tenure_unit: 'months', maturity_date: '2027-01-01' },
    restructures: [{ effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: 1.2, interest_amount: 0, tenure: 18, maturity_date: '2027-10-01', arrears_at_cut: 139.5 }],
  });
  assert.match(html, /<title>Statement QA-1 — Debt Collection CRM<\/title>/);
  for (const s of ['Loan Start Date', '2026-01-01', '1.5%/month', '2027-10-01', 'Restructured', '1.2%/month', '139.50']) assert.ok(html.includes(s), s);
  // v1.13.0 (G-26, the parts that need no decision): title, p.a. wording, address, signature; no internal status.
  for (const s of ['Statement of Account', '1.5%/month (18% p.a.)', 'Address', 'Authorised signature']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('<span>Status</span>'));
});

test('F-09: a new accrual case shows its interest without opening the case page', () => {
  const out = call(casesRouter, 'post', '/', { body: { debtor_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12' } });
  const id = Number(out.redirect.match(/\/cases\/(\d+)/)[1]);
  assert.ok(db.get('SELECT outstanding_amount o FROM cases WHERE id=?', [id]).o > 10000);
});

test('F-09: open-ended accrual balances are refreshed without a page visit', () => {
  db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,principal_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from)
    VALUES (90,'QA-90',1,1,3000,3000,'negotiation','monthly',3,?)`, [days(-10)]);
  refreshStaleAccruals();
  assert.ok(db.get('SELECT outstanding_amount o FROM cases WHERE id=90').o > 3000);
});

test('F-15: same-second timeline events list newest first', () => {
  for (const t of ['first', 'second']) db.run("INSERT INTO timeline_events (case_id,event_type,content,created_at) VALUES (1,'note',?,'2030-01-01 00:00:00')", [t]);
  const out = call(casesRouter, 'get', '/:id', { params: { id: '1' } });
  assert.deepStrictEqual(out.locals.timeline.slice(0, 2).map(e => e.content), ['second', 'first']);
  const dash = call(dashboardRouter, 'get', '/');
  assert.deepStrictEqual(dash.locals.recent.slice(0, 2).map(e => e.content), ['second', 'first']);
});

test('F-16: "Due within: Today" stops at today', () => {
  db.run("INSERT INTO tasks (case_id,agent_id,title,due_date) VALUES (1,1,'due-today',?),(1,1,'due-tomorrow',?)", [days(0), days(1)]);
  const titles = call(tasksRouter, 'get', '/', { query: { window: '1' } }).locals.tasks.map(t => t.title);
  assert.ok(titles.includes('due-today'));
  assert.ok(!titles.includes('due-tomorrow'));
});

test('F-18: agent-performance CSV rounds money to sen', () => {
  db.run('INSERT INTO payments (case_id,receipt_no,payment_date,amount,agent_id) VALUES (1,?,?,100.01,1)', ['QA-R-18', todayMYT()]);
  const out = call(reportsRouter, 'get', '/', { query: { export: 'performance' } });
  assert.match(out.body, /A1,100\.01,5\.5,5\.5,0/);
});

// ── Pre-launch: High ─────────────────────────────────────────────

test('F-20: payment amounts must be plain sen amounts', () => {
  for (const bad of ['0x10', '1e2', '0.001', '100.005', '', 'abc', '-5']) assert.ok(validatePayment(bad, 1e6).error, bad);
  for (const ok of ['100', '100.5', '100.55', 100, '.5']) assert.ok(!validatePayment(ok, 1e6).error, String(ok));
});

test('F-20: future payment dates and unknown methods are refused', () => {
  const before = count('SELECT COUNT(*) n FROM payments WHERE case_id=1');
  assert.ok(isErr(call(casesRouter, 'post', '/:id/payments', { params: { id: '1' }, body: { payment_date: days(1), amount: '10', method: 'cash' } })));
  assert.ok(isErr(call(casesRouter, 'post', '/:id/payments', { params: { id: '1' }, body: { payment_date: days(0), amount: '10', method: 'bitcoin<b>' } })));
  assert.strictEqual(count('SELECT COUNT(*) n FROM payments WHERE case_id=1'), before);
});

test('F-24: payment and case edits record old and new values', () => {
  const out = call(casesRouter, 'post', '/:id/payments', { params: { id: '1' }, body: { payment_date: days(0), amount: '20', method: 'cash' } });
  const pid = db.get('SELECT id FROM payments WHERE case_id=1 ORDER BY id DESC LIMIT 1').id;
  assert.ok(!isErr(out));
  call(casesRouter, 'post', '/:id/payments/:pid', { params: { id: '1', pid: String(pid) }, body: { payment_date: days(0), amount: '15', method: 'cash' } });
  assert.match(lastAudit('payment_edit').details, /20\.00 → 15\.00/);
  call(casesRouter, 'post', '/:id', { params: { id: '1' }, body: { debtor_id: '1', agent_id: '1', principal_amount: '1000', priority: 'high' } });
  assert.match(lastAudit('update').details, /priority: medium → high/);
});

test('F-26: notes and tasks leave an audit trail', () => {
  call(casesRouter, 'post', '/:id/notes', { params: { id: '1' }, body: { content: 'hello' } });
  const nid = db.get("SELECT id FROM timeline_events WHERE content='hello'").id;
  call(casesRouter, 'post', '/:id/notes/:noteId', { params: { id: '1', noteId: String(nid) }, body: { content: 'hello2' } });
  call(casesRouter, 'post', '/:id/notes/:noteId/delete', { params: { id: '1', noteId: String(nid) } });
  assert.match(lastAudit('note_add').details, /hello/);
  assert.match(lastAudit('note_edit').details, /hello → hello2/);
  assert.match(lastAudit('note_delete').details, /hello2/);
  call(tasksRouter, 'post', '/new', { body: { case_id: '1', type: 'follow_up', title: 'audited task' } });
  const tid = db.get("SELECT id FROM tasks WHERE title='audited task'").id;
  call(tasksRouter, 'post', '/:id', { params: { id: String(tid) }, body: { title: 'audited task 2', type: 'follow_up' } });
  call(tasksRouter, 'post', '/:id/complete', { params: { id: String(tid) } });
  for (const a of ['task_create', 'task_update', 'task_complete']) assert.ok(lastAudit(a), a);
});

test('F-27: a deactivated or re-roled account takes effect on the next request', () => {
  db.run("INSERT INTO users (id,username,password_hash,full_name,role,active) VALUES (10,'fin','x','Fin','finance',1)");
  const req = { session: { user: { id: 10, username: 'fin', role: 'finance' } } };
  const res = { locals: {} };
  db.run("UPDATE users SET role='auditor' WHERE id=10");
  attachUser(req, res, () => {});
  assert.strictEqual(req.session.user.role, 'auditor');
  db.run('UPDATE users SET active=0 WHERE id=10');
  attachUser(req, res, () => {});
  assert.strictEqual(req.session.user, null);
  assert.strictEqual(res.locals.currentUser, null);
});

// ── Pre-launch: Medium ───────────────────────────────────────────

function mw(fn, req) {
  const out = { headers: {}, next: false };
  const res = { locals: {}, status(c) { out.status = c; return this; }, type() { return this; }, send(b) { out.body = b; },
    set(o) { Object.assign(out.headers, o); }, redirect(s, u) { out.redirect = u === undefined ? s : u; },
    render(v, l, cb) { out.view = v; out.locals = l; if (cb) cb(null, 'html'); } };
  fn(req, res, () => { out.next = true; });
  out.res = res;
  return out;
}
const reqWith = (method, headers) => ({ method, get: k => headers[k.toLowerCase()] });

test('F-28: cross-site form posts are blocked, same-site ones pass', () => {
  assert.strictEqual(mw(sameOrigin, reqWith('POST', { host: 'crm.test', origin: 'http://evil.example' })).status, 403);
  assert.strictEqual(mw(sameOrigin, reqWith('POST', { host: 'crm.test', referer: 'http://evil.example/x' })).status, 403);
  assert.ok(mw(sameOrigin, reqWith('POST', { host: 'crm.test', origin: 'https://crm.test' })).next);
  assert.ok(mw(sameOrigin, reqWith('POST', { host: 'crm.test' })).next);
  assert.ok(mw(sameOrigin, reqWith('GET', { host: 'crm.test', origin: 'http://evil.example' })).next);
});

test('F-29: new and reset passwords share an 8-character minimum', () => {
  assert.ok(isErr(call(usersRouter, 'post', '/', { body: { username: 'short', full_name: 'S', password: 'seven77', role: 'auditor' } })));
  assert.ok(!isErr(call(usersRouter, 'post', '/', { body: { username: 'long', full_name: 'L', password: 'eight888', role: 'auditor' } })));
  const id = String(db.get("SELECT id FROM users WHERE username='long'").id);
  assert.ok(isErr(call(usersRouter, 'post', '/:id/password', { params: { id }, body: { password: 'seven77' } })));
  assert.ok(bcrypt.getRounds(db.get('SELECT password_hash p FROM users WHERE id=?', [id]).p) >= 10);
});

test('F-32: audit log filters by date and entity and exports CSV', () => {
  db.run("INSERT INTO audit_logs (username,action,entity_type,details,created_at) VALUES ('u','old','case','old row','2020-01-01 00:00:00')");
  const out = call(auditRouter, 'get', '/', { query: { from: '2021-01-01', entity: 'case' } });
  assert.ok(out.locals.logs.length > 0);
  assert.ok(out.locals.logs.every(l => l.entity_type === 'case' && l.details !== 'old row'));
  const csv = call(auditRouter, 'get', '/', { query: { to: '2020-12-31', format: 'csv' } });
  assert.match(csv.body, /old row/);
  assert.match(csv.headers['content-disposition'], /audit-log\.csv/);
});

test('F-38: PTP dates are parsed strictly and double submits create one PTP', () => {
  const ptps = () => count('SELECT COUNT(*) n FROM ptps WHERE case_id=1');
  const before = ptps();
  assert.ok(isErr(call(casesRouter, 'post', '/:id/ptps', { params: { id: '1' }, body: { amount: '5' } })));
  assert.ok(isErr(call(casesRouter, 'post', '/:id/ptps', { params: { id: '1' }, body: { amount: '5', due_date: 'abc' } })));
  assert.ok(isErr(call(casesRouter, 'post', '/:id/ptp-plans', { params: { id: '1' }, body: { total_amount: '30', num_installments: '3', first_due_date: '2026-02-30' } })));
  const body = { amount: '7', due_date: days(5) };
  call(casesRouter, 'post', '/:id/ptps', { params: { id: '1' }, body });
  call(casesRouter, 'post', '/:id/ptps', { params: { id: '1' }, body });
  assert.strictEqual(ptps(), before + 1);
});

test('F-40: a resolved PTP cannot be broken', () => {
  const id = Number(db.run("INSERT INTO ptps (case_id,amount,due_date,status) VALUES (1,5,'2026-11-01','fulfilled')").lastInsertRowid);
  assert.strictEqual(ptpsRouter.breakPtp(id, { session: { user: ADMIN }, ip: '' }).ok, false);
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [id]).status, 'fulfilled');
});

test('F-44 / F-45: case terms and enums are validated server-side', () => {
  const before = count('SELECT COUNT(*) n FROM cases');
  const base = { debtor_id: '1', principal_amount: '1000' };
  for (const bad of [{ principal_amount: '-1000' }, { principal_amount: 'abc' }, { principal_amount: '1e309' }, { debtor_id: '999' }, { agent_id: '999' },
    { interest_mode: 'monthly', interest_rate: '-5' }, { interest_amount: '-300' }, { loan_start_date: '2026-13-45' },
    { tenure: '1.5' }, { tenure: '20000' }, { priority: 'bogus' }, { status: 'bogus' }]) {
    assert.ok(isErr(call(casesRouter, 'post', '/', { body: { ...base, ...bad } })), JSON.stringify(bad));
  }
  assert.strictEqual(count('SELECT COUNT(*) n FROM cases'), before);
  assert.ok(isErr(call(debtorsRouter, 'post', '/', { body: { name: 'X', risk_level: 'bogus' } })));
  assert.ok(isErr(call(casesRouter, 'post', '/:id/calls', { params: { id: '1' }, body: { result: 'bogus' } })));
  assert.ok(isErr(call(tasksRouter, 'post', '/new', { body: { title: 'x', type: 'bogus' } })));
});

test('F-45: unexpected errors render a friendly page without the stack', () => {
  const err = new Error('FOREIGN KEY constraint failed at C:\\secret\\path.js');
  const out = mw((req, res, next) => errorHandler(err, req, res, next), {});
  assert.strictEqual(out.status, 500);
  assert.strictEqual(out.view, 'error');
  assert.doesNotMatch(out.locals.message, /FOREIGN|secret/);
  const big = mw((req, res, next) => errorHandler(Object.assign(new Error('too large'), { status: 413 }), req, res, next), {});
  assert.strictEqual(big.status, 413);
});

test('F-46: CSV text cells cannot start a formula; numbers stay numbers', () => {
  const csv = toCsv(['a', 'b', 'c'], [['=HYPERLINK("x")', -5, '@sum']]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)",-5,'@sum/);
});

// ── Pre-launch: Low ──────────────────────────────────────────────

test('F-52: login upgrades a weak password hash', () => {
  db.run("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (20,'weak',?,'W','auditor')", [bcrypt.hashSync('pw-weak-1', 8)]);
  const req = { body: { username: 'weak', password: 'pw-weak-1' }, session: {}, ip: '10.0.0.52' };
  const layer = authRouter.stack.find(l => l.route && l.route.path === '/login' && l.route.methods.post);
  layer.route.stack[0].handle(req, { redirect() {}, status() { return this; }, render() {} });
  assert.ok(req.session.user);
  assert.strictEqual(bcrypt.getRounds(db.get('SELECT password_hash p FROM users WHERE id=20').p), 10);
});

test('F-53: responses carry basic security headers', () => {
  const out = mw(securityHeaders, {});
  assert.strictEqual(out.headers['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(out.headers['X-Frame-Options'], 'DENY');
  assert.ok(out.next);
});

test('F-54: flash messages travel in the session, not the URL', () => {
  const req = { session: {} };
  const out = mw(flash, req);
  out.res.redirect('/cases/1?ok=Saved&tab=x');
  assert.strictEqual(out.redirect, '/cases/1?tab=x');
  assert.deepStrictEqual(req.session.flash, { ok: 'Saved', err: null });
  const next = mw(flash, req);
  assert.strictEqual(next.res.locals.flash.ok, 'Saved');
  assert.strictEqual(req.session.flash, undefined);
  assert.strictEqual(mw(flash, { session: {}, query: { err: 'forged' } }).res.locals.flash, null);
});

test('F-55: "opened today" uses the Malaysia date of opened_at', () => {
  const before = call(dashboardRouter, 'get', '/').locals.kpi.openedToday;
  // 00:30 MYT today = 16:30 UTC the day before.
  const utc = new Date(Date.parse(todayMYT() + 'T00:30:00+08:00')).toISOString().replace('T', ' ').slice(0, 19);
  db.run("INSERT INTO cases (case_no,client_id,debtor_id,principal_amount,outstanding_amount,opened_at) VALUES ('QA-55',1,1,1,1,?)", [utc]);
  assert.strictEqual(call(dashboardRouter, 'get', '/').locals.kpi.openedToday, before + 1);
  const rep = call(reportsRouter, 'get', '/');
  assert.strictEqual(rep.locals.from, todayMYT().slice(0, 8) + '01');
  assert.strictEqual(rep.locals.to, todayMYT());
});

test('F-56: assorted input checks', () => {
  call(agentsRouter, 'post', '/', { body: { name: 'Zero Rate', commission_rate: '0' } });
  assert.strictEqual(db.get("SELECT commission_rate r FROM agents WHERE name='Zero Rate'").r, 0);
  assert.ok(isErr(call(agentsRouter, 'post', '/', { body: { name: 'Neg', commission_rate: '-1' } })));
  assert.ok(isErr(call(agentsRouter, 'post', '/', { body: { name: 'Neg', target_amount: '-5' } })));
  assert.ok(isErr(call(usersRouter, 'post', '/', { body: { username: 'ghost', full_name: 'G', password: 'eight888', role: 'agent', agent_id: '99999' } })));
  assert.ok(isErr(call(commissionsRouter, 'post', '/settle', { body: { agent_id: '1', period: 'bogus', amount: '10' } })));
  assert.ok(isErr(call(commissionsRouter, 'post', '/settle', { body: { agent_id: '1', amount: '1e20' } })));
  assert.ok(isErr(call(commissionsRouter, 'post', '/:id/void', { params: { id: '99999' } })));
  assert.ok(isErr(call(tasksRouter, 'post', '/:id/complete', { params: { id: '99999' } })));
  assert.ok(isErr(call(casesRouter, 'post', '/:id/calls', { params: { id: '1' }, body: { result: 'answered', duration_seconds: '-60' } })));
  assert.ok(isErr(call(casesRouter, 'post', '/:id/notes', { params: { id: '1' }, body: { content: '   ' } })));
  const tid = String(db.get('SELECT id FROM tasks LIMIT 1').id);
  assert.ok(isErr(call(tasksRouter, 'post', '/:id', { params: { id: tid }, body: { title: '', type: 'follow_up' } })));
  assert.ok(isErr(call(debtorsRouter, 'post', '/', { body: { name: 'Neg Salary', salary: '-1' } })));
  assert.ok(isErr(call(debtorsRouter, 'post', '/', { body: { name: 'x'.repeat(201) } })));
});
