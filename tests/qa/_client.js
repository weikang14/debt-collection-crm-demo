// QA helper (role 1 / system tester). Not a test file: name avoids node --test discovery.
// Talks HTTP to the QA server on :3301 and reads the QA DB (data/qa/tester.db) read-only.
// ponytail: regex HTML checks, no DOM lib — enough for presence/absence assertions.
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = path.join(ROOT, 'data', 'qa', 'tester.db');
const BASE = process.env.QA_BASE || 'http://127.0.0.1:3301';
const RESULTS_DIR = path.join(__dirname, 'results');

if (!DB_PATH.endsWith(path.join('data', 'qa', 'tester.db'))) throw new Error('refusing: not the tester DB');

function reseed() {
  // CRM_DB_PATH is always set explicitly — never touches data/crm.db.
  execFileSync(process.execPath, ['--no-warnings', 'src/db/seed.js'], { cwd: ROOT, env: { ...process.env, CRM_DB_PATH: DB_PATH }, stdio: 'pipe' });
}

let _db;
function db() { if (!_db) _db = new DatabaseSync(DB_PATH, { readOnly: true }); return _db; }
const q1 = (sql, ...p) => db().prepare(sql).get(...p);
const qa = (sql, ...p) => db().prepare(sql).all(...p);

class Session {
  constructor(base = BASE) { this.base = base; this.cookie = ''; }
  _store(res) {
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.startsWith('connect.sid=')) this.cookie = kv; }
  }
  async req(method, url, form, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    let body;
    if (form instanceof FormData) body = form;
    else if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(this.base + url, { method, headers, body, redirect: 'manual' });
    this._store(res);
    const text = await res.text();
    const loc = res.headers.get('location') || '';
    let ok = null, err = null;
    if (loc) { const u = new URL(loc, this.base); ok = u.searchParams.get('ok'); err = u.searchParams.get('err'); }
    return { status: res.status, location: loc, ok, err, text, headers: res.headers };
  }
  get(url) { return this.req('GET', url); }
  post(url, form = {}) { return this.req('POST', url, form); }
  async login(username, password) {
    const r = await this.post('/login', { username, password });
    return r;
  }
}

const PW = { admin: 'admin123', manager: 'manager123', agent1: 'agent123', agent2: 'agent123', agent3: 'agent123', finance: 'finance123', auditor: 'auditor123' };
async function as(user, password = PW[user]) {
  const s = new Session();
  const r = await s.login(user, password);
  if (r.status !== 302 || r.location !== '/') throw new Error(`login ${user} failed: ${r.status} ${r.location}`);
  return s;
}

// ---- result recording ----------------------------------------------------
const results = [];
function rec(id, expected, actual, result, note = '') {
  results.push({ id, expected, actual: String(actual).slice(0, 400), result, note });
}
// check(): record + assert so node:test reports the same verdict.
function check(id, expected, cond, actual, note) {
  rec(id, expected, actual, cond ? 'PASS' : 'FAIL', note);
  assert.ok(cond, `${id}: expected ${expected}; actual ${actual}`);
}
function saveResults(name) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, name + '.json'), JSON.stringify(results, null, 1));
}

// ---- HTML helpers -----------------------------------------------------------
const has = (html, s) => html.includes(s);
const flash = (html) => { const m = html.match(/class="alert is-(green|red)">([^<]*)</); return m ? `${m[1]}:${m[2]}` : null; };
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const ledgerAmt = (html) => { const m = html.match(/ledger-amt"><span class="ledger-cur">RM<\/span>([\d,.-]+)/); return m ? m[1] : null; };
const ledgerVal = (html, lbl) => { const m = html.match(new RegExp(`ledger-lbl">${lbl}</div><div class="ledger-val[^"]*">([^<]+)<`)); return m ? m[1].trim() : null; };
const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Create debtor + case as admin/manager; returns case id.
async function newDebtor(s, name, extra = {}) {
  const r = await s.post('/debtors', { name, risk_level: 'medium', ...extra });
  assert.equal(r.ok, 'Debtor created', 'debtor create ' + JSON.stringify(r));
  return q1('SELECT id FROM debtors WHERE name=? ORDER BY id DESC LIMIT 1', name).id;
}
async function newCase(s, fields) {
  const r = await s.post('/cases', { priority: 'medium', status: 'new', ...fields });
  const m = r.location.match(/^\/cases\/(\d+)\?ok=Case\+created/);
  if (!m) throw new Error('case create failed ' + r.status + ' ' + r.location + ' ' + r.text.slice(0, 300));
  return Number(m[1]);
}
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

module.exports = { ROOT, DB_PATH, BASE, Session, as, PW, reseed, db, q1, qa, rec, check, results, saveResults,
  has, flash, strip, ledgerAmt, ledgerVal, money, newDebtor, newCase, today, addDays };
