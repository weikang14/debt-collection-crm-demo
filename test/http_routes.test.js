// K-12: the app over real HTTP — middleware, sessions and the per-request
// transaction included, which the router-level tests bypass.
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `crm-http-${process.pid}-${Date.now()}.db`);
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { seedDemo } = require('../src/db/seed');
seedDemo();
const db = require('../src/db');
const app = require('../src/app');
const { todayMYT } = require('../src/utils/helpers');

let server, base;
before(() => new Promise(ok => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; ok(); }); }));
after(() => new Promise(ok => server.close(ok)));

// A logged-in browser: keeps the session cookie, sends same-origin POSTs.
async function login(username, password) {
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username, password }) });
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  const req = (method, path, body) => fetch(base + path, { method, redirect: 'manual',
    headers: { cookie, origin: base, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: body && new URLSearchParams(body) });
  return { status: r.status, setCookie, get: p => req('GET', p), post: (p, b) => req('POST', p, b) };
}
const count = (sql, ...p) => db.get(sql, p).n;

test('login sets an HttpOnly, SameSite=Lax session cookie (not Secure over plain http)', async () => {
  const s = await login('admin', 'admin123');
  assert.strictEqual(s.status, 302);
  assert.match(s.setCookie, /HttpOnly/i);
  assert.match(s.setCookie, /SameSite=Lax/i);
  assert.doesNotMatch(s.setCookie, /Secure/i);
  assert.strictEqual((await s.get('/')).status, 200);
});

test('a cross-site POST is refused', async () => {
  const s = await login('admin', 'admin123');
  const cookie = s.setCookie.split(';')[0];
  const r = await fetch(base + '/cases/2/notes', { method: 'POST', redirect: 'manual', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'content=x' });
  assert.strictEqual(r.status, 403);
});

test('viewing a case, searching and printing land in the access log (F-31)', async () => {
  const s = await login('manager', 'manager123');
  const before = count('SELECT COUNT(*) n FROM access_logs');
  assert.strictEqual((await s.get('/cases/2')).status, 200);
  assert.strictEqual((await s.get('/search?q=Sarah')).status, 200);
  assert.strictEqual((await s.get('/cases/2/statement')).status, 200);
  const rows = db.all('SELECT action, entity_type FROM access_logs ORDER BY id DESC LIMIT 3').map(r => `${r.action}:${r.entity_type}`);
  assert.strictEqual(count('SELECT COUNT(*) n FROM access_logs'), before + 3);
  assert.deepStrictEqual(rows, ['print:case', 'search:case', 'view:case']);
});

test('a payment and its audit row commit together; a failed audit row rolls the request back (G-25)', async () => {
  const s = await login('finance', 'finance123');
  const r = await s.post('/cases/19/payments', { amount: '5.00', payment_date: todayMYT(), method: 'cash', reference: 'HTTP-1' });
  assert.strictEqual(r.status, 302);
  const p = db.get("SELECT receipt_no FROM payments WHERE reference='HTTP-1'");
  assert.ok(p, 'payment recorded');
  assert.ok(db.get("SELECT 1 x FROM audit_logs WHERE action='payment' AND details LIKE ?", [`%${p.receipt_no}%`]));
  const m = await login('manager', 'manager123');
  const calls = count('SELECT COUNT(*) n FROM call_logs WHERE case_id=2');
  db.exec("CREATE TRIGGER t_audit_down BEFORE INSERT ON audit_logs WHEN NEW.action='call' BEGIN SELECT RAISE(ABORT, 'audit store down'); END");
  try {
    const fail = await m.post('/cases/2/calls', { result: 'answered', duration_seconds: '10' });
    assert.strictEqual(fail.status, 500);
    assert.strictEqual(count('SELECT COUNT(*) n FROM call_logs WHERE case_id=2'), calls, 'call rolled back with its audit row');
  } finally { db.exec('DROP TRIGGER t_audit_down'); }
  assert.strictEqual((await m.post('/cases/2/calls', { result: 'answered', duration_seconds: '10', channel: 'whatsapp', contact: 'guarantor', phone: '019-0000000' })).status, 302);
  const call = db.get('SELECT * FROM call_logs WHERE case_id=2 ORDER BY id DESC LIMIT 1');
  assert.deepStrictEqual([call.channel, call.contact, call.phone, call.created_by, call.agent_id], ['whatsapp', 'guarantor', '019-0000000', 'Collection Manager', null]);
});

test('a refused New Case form comes back filled in (K-11)', async () => {
  const s = await login('manager', 'manager123');
  const r = await s.post('/cases', { debtor_id: '3', principal_amount: '4321', interest_mode: 'monthly', interest_rate: '1.2', agreement_no: 'AGR-K11' });
  assert.match(r.headers.get('location'), /^\/cases\/new/);
  const html = await (await s.get('/cases/new')).text();
  assert.match(html, /Tenure is required/);
  assert.match(html, /name="principal_amount"[^>]*value="4321"/);
  assert.match(html, /value="AGR-K11"/);
  assert.match(html, /<option value="3" selected>/);
  assert.doesNotMatch(await (await s.get('/cases/new')).text(), /value="4321"/, 'only on the page right after');
});

test('npm run backup snapshots the database CRM_DB_PATH names, while the app has it open (K-08)', () => {
  const path = require('node:path'), fs = require('node:fs');
  const out = require('node:child_process').execFileSync(process.execPath, ['--no-warnings', 'src/db/backup.js'],
    { cwd: path.join(__dirname, '..'), env: { ...process.env }, encoding: 'utf8' });
  const file = out.match(/Backup created: (.+)/)[1].trim();
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    assert.strictEqual(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.strictEqual(copy.prepare('SELECT COUNT(*) n FROM cases').get().n, count('SELECT COUNT(*) n FROM cases'));
  } finally { copy.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('each payment has a printable receipt, within the agent’s scope (F-25)', async () => {
  const s = await login('agent1', 'agent123');
  const p = db.get('SELECT id FROM payments WHERE case_id=5 LIMIT 1');
  const r = await s.get(`/cases/5/payments/${p.id}/receipt`);
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /Payment Receipt/);
  assert.strictEqual((await s.get(`/cases/2/payments/${p.id}/receipt`)).status, 404, 'other agents’ cases stay out of scope');
});
