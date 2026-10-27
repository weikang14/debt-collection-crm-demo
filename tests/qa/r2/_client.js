// QA round 2 helper (role 1 / system tester). Not a test file (no .qa.js suffix).
// HTTP against the tester server on :3301; reads data/qa/tester-r2.db read-only.
// v1.9.0+: banners live in the session and show once as `.alert` on the next page,
// so act() follows the redirect and reads the banner from there.
// ponytail: regex HTML checks, no DOM lib — enough for presence/absence assertions.
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..', '..', '..');
const DB_PATH = path.join(ROOT, 'data', 'qa', 'tester-r2.db');
const BASE = process.env.QA_BASE || 'http://127.0.0.1:3301';
const RESULTS_DIR = path.join(__dirname, 'results');
if (!DB_PATH.endsWith(path.join('data', 'qa', 'tester-r2.db'))) throw new Error('refusing: not the tester-r2 DB');

let _db;
function db() { if (!_db) _db = new DatabaseSync(DB_PATH, { readOnly: true }); return _db; }
const q1 = (sql, ...p) => db().prepare(sql).get(...p);
const qa = (sql, ...p) => db().prepare(sql).all(...p);

const alertOf = (html) => {
  const m = String(html).match(/class="alert is-(green|red)">([^<]*)</);
  return m ? { type: m[1] === 'green' ? 'ok' : 'err', text: decode(m[2]) } : null;
};
const decode = (s) => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#34;/g, '"').replace(/&amp;/g, '&');

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
    return { status: res.status, location: res.headers.get('location') || '', text, headers: res.headers };
  }
  get(url) { return this.req('GET', url); }
  post(url, form = {}, h) { return this.req('POST', url, form, h); }
  // POST, then follow one redirect and read the banner shown there.
  async act(url, form = {}, h) {
    const r = await this.post(url, form, h);
    if (r.status === 302 && r.location && !/^https?:/.test(r.location)) {
      const g = await this.get(r.location);
      const a = alertOf(g.text);
      return { status: r.status, location: r.location, ok: a && a.type === 'ok' ? a.text : null, err: a && a.type === 'err' ? a.text : null, html: g.text, pageStatus: g.status };
    }
    return { status: r.status, location: r.location, ok: null, err: null, html: r.text, pageStatus: r.status };
  }
  async login(username, password) { return this.post('/login', { username, password }); }
}

const PW = { admin: 'admin123', manager: 'manager123', agent1: 'agent123', agent2: 'agent123', agent3: 'agent123', finance: 'finance123', auditor: 'auditor123' };
async function as(user, password = PW[user], base) {
  const s = new Session(base);
  const r = await s.login(user, password);
  if (r.status !== 302 || r.location !== '/') throw new Error(`login ${user} failed: ${r.status} ${r.location} ${r.text.slice(0, 200)}`);
  return s;
}

// ---- result recording ----------------------------------------------------
let results = [];
function rec(id, expected, actual, result, note = '') {
  results.push({ id, expected, actual: String(actual).slice(0, 600), result, note });
}
// check(): record only (no throw) so one failing case doesn't hide the rest; the
// file's final test asserts that nothing FAILed.
function check(id, expected, cond, actual, note) {
  rec(id, expected, actual, cond ? 'PASS' : 'FAIL', note);
  return !!cond;
}
function saveResults(name) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, name + '.json'), JSON.stringify(results, null, 1));
  return results;
}

// ---- HTML helpers -----------------------------------------------------------
const has = (html, s) => String(html).includes(s);
const strip = (html) => decode(String(html).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
// v1.11.0 (G-24/N-07): the big number is now Settlement Today and the contract balance
// moved to a "Contract Balance" cell. ledgerAmt() keeps meaning "contract outstanding"
// and ledgerVal(h, 'Settlement Today') keeps meaning the settlement figure, on both layouts.
const bigAmt = (html) => { const m = html.match(/ledger-amt"><span class="ledger-cur">RM<\/span>([\d,.-]+)/); return m ? m[1] : null; };
const cellVal = (html, lbl) => { const m = html.match(new RegExp(`ledger-lbl">${lbl}</div><div class="ledger-val[^"]*">([^<]+)<`)); return m ? m[1].trim() : null; };
const isV111 = (html) => /ledger-lbl">Settlement Today/.test(html);
const ledgerAmt = (html) => (isV111(html) ? cellVal(html, 'Contract Balance') : bigAmt(html));
const ledgerVal = (html, lbl) => (lbl === 'Settlement Today' && isV111(html) ? bigAmt(html) : cellVal(html, lbl));
const ledgerSmall = (html, lbl) => { const m = html.match(new RegExp(`ledger-lbl">${lbl}</div><div class="ledger-val[^"]*">[^<]+</div>\\s*<small[^>]*>([^<]+)<`)); return m ? m[1].trim() : null; };
const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (s) => (s == null ? NaN : Number(String(s).replace(/,/g, '')));
// Schedule rows of the current Repayment Schedule (first table after the heading).
function scheduleRows(html) {
  const i = html.indexOf('<h2>Repayment Schedule');
  if (i < 0) return [];
  const t = html.slice(i, html.indexOf('</table>', i));
  return [...t.matchAll(/<tr>\s*<td>([^<]*)(<small[^>]*>[^<]*<\/small>)?<\/td>\s*<td class="num">([^<]*)<\/td>\s*<td class="num">([^<]*)<\/td>\s*<td class="num">([^<]*)<\/td>\s*<td><span class="badge [^"]*">([^<]*)<\/span><\/td>(\s*<td>([\s\S]*?)<\/td>)?/g)]
    .map(m => ({ due: m[1].trim(), arrears: !!m[2], expected: num(m[3]), paid: num(m[4]), outstanding: num(m[5]), status: m[6], action: m[8] || null }));
}

// ---- fixtures ---------------------------------------------------------------
async function newDebtor(s, name, extra = {}) {
  const r = await s.act('/debtors', { name, risk_level: 'medium', ...extra });
  assert.equal(r.ok, 'Debtor created', 'debtor create ' + JSON.stringify({ ok: r.ok, err: r.err }));
  return q1('SELECT id FROM debtors WHERE name=? ORDER BY id DESC LIMIT 1', name).id;
}
async function newCase(s, fields) {
  const r = await s.post('/cases', { priority: 'medium', status: 'new', ...fields });
  const m = r.location.match(/^\/cases\/(\d+)$/);
  if (!m) {
    const g = r.location ? await s.get(r.location) : r;
    throw new Error('case create failed ' + r.status + ' ' + r.location + ' ' + JSON.stringify(alertOf(g.text)));
  }
  return Number(m[1]);
}
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

module.exports = { ROOT, DB_PATH, BASE, Session, as, PW, db, q1, qa, rec, check, saveResults, get results() { return results; },
  alertOf, has, strip, ledgerAmt, ledgerVal, ledgerSmall, money, num, scheduleRows, newDebtor, newCase, today, addDays };
