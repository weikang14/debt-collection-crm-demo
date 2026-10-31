// v1.14.0: the decisions of 2026-10-31 (1A, 2, 3A, 5A, 6A, 7A, 11B, 14A).
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `crm-qar4-${process.pid}-${Date.now()}.db`);
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const dayjs = require('dayjs');
const db = require('../src/db');
db.init();
const { todayMYT, amountInWords } = require('../src/utils/helpers');
const { router: casesRouter } = require('../src/routes/cases');
const debtorsRouter = require('../src/routes/debtors');
const usersRouter = require('../src/routes/users');
const reportsRouter = require('../src/routes/reports');
const { recordSettlement } = require('../src/routes/commissions');
const { arrearsOf } = require('../src/services/restructure');
const { permsFor, requirePerm, saveUserPerms, seedRoleDefaults } = require('../src/utils/permissions');

const ADMIN = { id: 1, username: 'admin', full_name: 'Admin', role: 'admin' };
const today = todayMYT();
const monthsAgo = n => dayjs(today).subtract(n, 'month').format('YYYY-MM-DD');
db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'自营业务',0)");
db.run("INSERT INTO debtors (id,name,salary,guarantor_name) VALUES (1,'D1',5000,'G1')");
db.run("INSERT INTO agents (id,name,commission_rate) VALUES (1,'Agent A',10),(2,'Agent B',10)");
db.run("INSERT INTO users (id,username,password_hash,full_name,role,agent_id) VALUES (1,'admin','x','Admin','admin',NULL),(4,'fin','x','Fin','finance',NULL),(5,'aud','x','Aud','auditor',NULL),(6,'ag','x','Ag','agent',1)");

function call(router, method, routePath, { params = {}, body = {}, query = {}, user = ADMIN } = {}) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method} ${routePath} exists`);
  const out = {};
  const res = { status(c) { out.status = c; return this; }, redirect(u) { out.redirect = u; }, render(v, l) { out.view = v; out.locals = l; }, setHeader() {}, send(b) { out.body = b; } };
  layer.route.stack[layer.route.stack.length - 1].handle({ params, body, query, session: { user }, ip: '127.0.0.1' }, res);
  return out;
}
const guard = (router, method, routePath, user) => {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  let passed = false;
  layer.route.stack[1].handle({ session: { user } }, { status() { return this; }, render() {}, redirect() {} }, () => { passed = true; });
  return passed;
};
const isErr = out => /[?&]err=/.test(out.redirect || '');
const text = (out, k) => decodeURIComponent(((out.redirect || '').match(new RegExp(k + '=([^&]*)')) || [, ''])[1].replace(/\+/g, ' '));
const newCase = body => {
  const out = call(casesRouter, 'post', '/', { body: { debtor_id: '1', agent_id: '1', principal_amount: '10000', ...body } });
  assert.ok(!isErr(out), text(out, 'err'));
  return Number(out.redirect.match(/\/cases\/(\d+)/)[1]);
};
const pay = (id, amount, date = today, ref = String(Math.random())) =>
  call(casesRouter, 'post', '/:id/payments', { params: { id: String(id) }, body: { amount: String(amount), payment_date: date, method: 'cash', reference: ref } });
const caseRow = id => db.get('SELECT * FROM cases WHERE id=?', [id]);

test('1A / N-06: a rate-based loan is overdue by its unpaid interest on the ledger', () => {
  const A = { principal_amount: 10000, interest_amount: 0, interest_mode: 'monthly', interest_rate: 1.5, interest_from: '2026-01-01', loan_start_date: '2026-01-01',
    opened_at: '2026-01-01 00:00:00', tenure: 12, tenure_unit: 'months', maturity_date: '2027-01-01' };
  // Interest paid every month on time → up to date.
  const monthly = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(m => ({ amount: 150, payment_date: `2026-${String(m + 1).padStart(2, '0')}-01` }));
  if (today > '2026-10-01' && today <= '2026-11-01') assert.deepStrictEqual(arrearsOf(A, monthly, []), { dpd: 0, overdue: 0 });
  // A principal prepayment lowers later interest but does not stand in for it.
  const pre = { ...A, loan_start_date: monthsAgo(6), interest_from: monthsAgo(6) };
  const a = arrearsOf(pre, [{ amount: 1000, payment_date: monthsAgo(6) }], []);
  const firstDue = require('../src/utils/installments').dueDates(monthsAgo(6), 2)[1];   // the first instalment date
  assert.strictEqual(a.dpd, dayjs(today).diff(dayjs(firstDue), 'day'));
  assert.ok(a.overdue > 800 && a.overdue < 820, String(a.overdue)); // 9,000 × 1.5% × 6 months = 810
  // Fixed loans keep the instalment schedule.
  const F = { ...A, interest_mode: 'fixed', interest_rate: 0, interest_amount: 1200, interest_from: null, loan_start_date: monthsAgo(3) };
  const passed = require('../src/utils/installments').dueDates(monthsAgo(3), 13).slice(1).filter(d => d < today).length;
  assert.strictEqual(arrearsOf(F, [], []).overdue, Math.round(passed * 933.33 * 100) / 100); // instalments of 933.33 already due
});

test('2: role defaults are the old rules; admin edits roles; a user gets personal changes', () => {
  // Defaults = the shipped rules.
  assert.ok(permsFor({ id: 4, role: 'finance' }).has('payments.correct'));
  assert.ok(!permsFor({ id: 6, role: 'agent' }).has('cases.status_any'));
  assert.ok(!permsFor({ id: 5, role: 'auditor' }).has('notes.write'));
  assert.strictEqual(guard(casesRouter, 'post', '/:id/payments/:pid/void', { id: 4, role: 'finance' }), true);
  // Admin takes "edit and void payments" away from finance.
  call(usersRouter, 'post', '/permissions', { body: { rp_finance: ['debtors.view', 'payments.record'], rp_manager: [], rp_agent: [], rp_auditor: ['audit.view'] } });
  assert.strictEqual(guard(casesRouter, 'post', '/:id/payments/:pid/void', { id: 4, role: 'finance' }), false);
  assert.match(db.get("SELECT details FROM audit_logs WHERE entity_type='permissions' ORDER BY id DESC").details, /finance: .*-payments\.correct/);
  // A single auditor may write notes; the role itself still may not.
  saveUserPerms(5, 'auditor', ['audit.view', 'notes.write']);
  assert.ok(permsFor({ id: 5, role: 'auditor' }).has('notes.write'));
  assert.deepStrictEqual(db.all('SELECT permission, granted FROM user_permissions WHERE user_id=5').map(r => [r.permission, r.granted]), [['notes.write', 1]]);
  assert.ok(!permsFor({ id: 99, role: 'auditor' }).has('notes.write'));
  // admin always has everything, whatever the table says.
  assert.ok(permsFor({ id: 1, role: 'admin' }).has('payments.correct'));
  // Restoring the defaults brings finance's right back.
  call(usersRouter, 'post', '/permissions/reset');
  assert.strictEqual(guard(casesRouter, 'post', '/:id/payments/:pid/void', { id: 4, role: 'finance' }), true);
  db.run('DELETE FROM user_permissions');
});

test('2 / F-30: without debtors.sensitive, salary and guarantor are hidden and kept as stored', () => {
  call(usersRouter, 'post', '/permissions', { body: { rp_manager: ['debtors.view', 'debtors.edit'], rp_finance: [], rp_agent: [], rp_auditor: [] } });
  const mgr = { id: 7, username: 'mgr', full_name: 'Mgr', role: 'manager' };
  call(debtorsRouter, 'post', '/:id', { params: { id: '1' }, body: { name: 'D1', phone: '011' }, user: mgr });
  const d = db.get('SELECT salary, guarantor_name, phone FROM debtors WHERE id=1');
  assert.deepStrictEqual([d.salary, d.guarantor_name, d.phone], [5000, 'G1', '011']);
  seedRoleDefaults(true);
});

test('3A / O-10: voiding the only payment of a Partial Paid case puts it back to Negotiation', () => {
  const id = newCase({ interest_amount: '1200', tenure: '12', loan_start_date: monthsAgo(1) });
  assert.ok(!isErr(pay(id, 100)));
  assert.strictEqual(caseRow(id).status, 'partial_paid');
  const p = db.get('SELECT id FROM payments WHERE case_id=?', [id]);
  call(casesRouter, 'post', '/:id/payments/:pid/void', { params: { id: String(id), pid: String(p.id) }, body: { reason: 'x' } });
  assert.strictEqual(caseRow(id).status, 'negotiation');
});

test('5A / K-04: each payment is split into interest and principal, and later ones are re-split', () => {
  const id = newCase({ interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', loan_start_date: monthsAgo(3) });
  assert.ok(!isErr(pay(id, 1000, today)));
  let p = db.get('SELECT interest_part, principal_part, amount FROM payments WHERE case_id=?', [id]);
  assert.strictEqual(p.interest_part, 450);                 // 3 months × 150
  assert.strictEqual(p.principal_part, 550);
  assert.ok(!isErr(pay(id, 300, monthsAgo(1))));            // a backdated payment takes the interest first
  const rows = db.all('SELECT payment_date, interest_part, principal_part FROM payments WHERE case_id=? ORDER BY payment_date', [id]);
  assert.deepStrictEqual(rows.map(r => r.interest_part), [300, 150]);
  assert.strictEqual(rows[1].principal_part, 850);
  const csv = call(reportsRouter, 'get', '/', { query: { export: 'cases' } }).body;
  assert.match(csv.split('\r\n')[0], /,Paid Principal,Paid Interest$/);
  const rep = call(reportsRouter, 'get', '/', { query: { from: monthsAgo(2), to: today } }).locals.collected;
  assert.ok(rep.interest >= 450 && rep.principal >= 850);
});

test('6A / K-05: no settlement above what is pending; a void that over-settles a month says so', () => {
  const id = newCase({ interest_amount: '0' });
  db.run('UPDATE case_assignments SET agent_id=2 WHERE case_id=?', [id]);
  db.run('UPDATE cases SET agent_id=2 WHERE id=?', [id]);
  assert.ok(!isErr(pay(id, 1000)));                          // agent B earns 100
  const req = { session: { user: ADMIN }, ip: '' };
  assert.match(recordSettlement({ agent_id: 2, period: today.slice(0, 7), amount: '100.01' }, req).error, /exceeds the pending commission/);
  assert.strictEqual(recordSettlement({ agent_id: 2, period: today.slice(0, 7), amount: '100' }, req).ok, true);
  const p = db.get('SELECT id FROM payments WHERE case_id=?', [id]);
  const out = call(casesRouter, 'post', '/:id/payments/:pid/void', { params: { id: String(id), pid: String(p.id) }, body: { reason: 'bounced' } });
  assert.match(text(out, 'ok'), /Payment voided — note: commission for Agent B in \d{4}-\d{2} is now over-settled by RM 100\.00/);
});

test('7A / K-07: a production deploy without DEMO_MODE has no demo accounts page or demo tools', () => {
  const run = env => JSON.parse(require('node:child_process').execFileSync(process.execPath, ['--no-warnings', '-e', `
    const app = require('./src/app');
    const s = app.listen(0, async () => {
      const b = 'http://127.0.0.1:' + s.address().port;
      const r = await Promise.all(['/demo-accounts', '/demo-tools'].map(p => fetch(b + p, { redirect: 'manual' }).then(x => x.status)));
      console.log(JSON.stringify(r)); s.close();
    });`], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...env, CRM_DB_PATH: process.env.CRM_DB_PATH + '-' + Object.keys(env).join('') }, encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepStrictEqual(run({ NODE_ENV: 'production', SESSION_SECRET: 's', RENDER: '', DEMO_MODE: undefined }), [404, 404]); // the default off Render
  assert.deepStrictEqual(run({ NODE_ENV: 'production', SESSION_SECRET: 's', RENDER: '', DEMO_MODE: '1' }), [200, 302]);
  assert.deepStrictEqual(run({ NODE_ENV: 'production', SESSION_SECRET: 's', RENDER: 'true' }), [200, 302]); // the Render demo keeps them
});

test('11B / G-31: a payment is credited to the agent responsible on its payment date', () => {
  const id = newCase({ interest_amount: '0', loan_start_date: monthsAgo(2) });   // agent A from today
  db.run("UPDATE case_assignments SET from_date=? WHERE case_id=?", [monthsAgo(2), id]); // A held it from the start
  const c = caseRow(id);
  call(casesRouter, 'post', '/:id', { params: { id: String(id) }, body: { debtor_id: '1', agent_id: '2', principal_amount: String(c.principal_amount), interest_mode: 'fixed', interest_amount: '0', loan_start_date: c.loan_start_date } });
  assert.ok(!isErr(pay(id, 100, monthsAgo(1))));            // collected while A held the case
  assert.ok(!isErr(pay(id, 200, today)));                   // after the reassignment
  const by = Object.fromEntries(db.all('SELECT amount, agent_id FROM payments WHERE case_id=?', [id]).map(r => [r.amount, r.agent_id]));
  assert.deepStrictEqual(by, { 100: 1, 200: 2 });
  // Moving a payment's date moves its credit.
  const p = db.get('SELECT id FROM payments WHERE case_id=? AND amount=200', [id]);
  call(casesRouter, 'post', '/:id/payments/:pid', { params: { id: String(id), pid: String(p.id) }, body: { amount: '200', payment_date: monthsAgo(1), method: 'cash' } });
  assert.strictEqual(db.get('SELECT agent_id FROM payments WHERE id=?', [p.id]).agent_id, 1);
});

test('14A / D-08: receipts carry the amount in words and the balance after it', () => {
  assert.strictEqual(amountInWords(1242.5), 'Ringgit Malaysia One Thousand Two Hundred Forty-Two and Sen Fifty Only');
  assert.strictEqual(amountInWords(1000000.01), 'Ringgit Malaysia One Million and Sen One Only');
  const id = newCase({ interest_amount: '0' });
  assert.ok(!isErr(pay(id, 2500)));
  const p = db.get('SELECT id FROM payments WHERE case_id=?', [id]);
  const out = call(casesRouter, 'get', '/:id/payments/:pid/receipt', { params: { id: String(id), pid: String(p.id) } });
  assert.deepStrictEqual(out.locals.balance, { date: today, settlement: 7500 });
});

test('2: a user form without the permission boxes leaves the user on the role defaults', () => {
  const out = call(usersRouter, 'post', '/', { body: { username: 'api_fin', full_name: 'API Fin', password: 'Password1', role: 'finance' } });
  assert.match(out.redirect, /ok=/);
  const u = db.get("SELECT id FROM users WHERE username='api_fin'");
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM user_permissions WHERE user_id=?', [u.id]).n, 0);
  assert.ok(permsFor({ id: u.id, role: 'finance' }).has('payments.record'));
  // With the boxes, an unticked one is a revocation.
  call(usersRouter, 'post', '/:id', { params: { id: String(u.id) }, body: { username: 'api_fin', full_name: 'API Fin', role: 'finance', active: '1', perms_form: '1', perms: ['debtors.view'] } });
  assert.ok(!permsFor({ id: u.id, role: 'finance' }).has('payments.record'));
  assert.match(db.get("SELECT details FROM audit_logs WHERE entity_type='user' ORDER BY id DESC").details, /permissions removed: .*payments\.record/);
});
