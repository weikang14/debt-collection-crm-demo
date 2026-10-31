// Role 2 round 2 — HTTP client for the QA server on :3302 + page/CSV parsers.
// Only talks to localhost:3302; reads data/qa/business-r2.db READ-ONLY (ids, stored inputs).
// ponytail: regex parsing of the server-rendered HTML, no DOM library.
'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const BASE = 'http://127.0.0.1:3302';
const DB_PATH = path.join(__dirname, '..', '..', '..', 'data', 'qa', 'business-r2.db');
if (!DB_PATH.endsWith(path.join('data', 'qa', 'business-r2.db'))) throw new Error('refusing: not the role-2 DB');
let _db; const db = () => (_db ||= new DatabaseSync(DB_PATH, { readOnly: true }));
const q1 = (sql, ...p) => db().prepare(sql).get(...p);
const qa = (sql, ...p) => db().prepare(sql).all(...p);

const ent = s => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const num = s => (s == null ? null : Number(String(s).replace(/[^\d.-]/g, '')));
const fx = n => (n == null ? null : Number(n).toFixed(2));

class Session {
  constructor() { this.cookie = ''; }
  async raw(method, url, form) {
    const headers = {}; if (this.cookie) headers.cookie = this.cookie;
    let body; if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(BASE + url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; if (kv.startsWith('connect.sid=')) this.cookie = kv; }
    return { status: res.status, location: res.headers.get('location') || '', text: await res.text(), headers: res.headers };
  }
  get(url) { return this.raw('GET', url); }
  // POST then follow one redirect to read the flash banner (v1.9.0+: flash lives in the session).
  async post(url, form = {}) {
    const r = await this.raw('POST', url, form);
    if (r.status !== 302) return { ...r, ok: null, err: null };
    const next = await this.get(r.location);
    // only the flash banners right after <main> — page bodies can carry their own red alerts
    const top = ((next.text.split('<main class="content">')[1] || '').match(/^\s*((?:<div class="alert is-(?:green|red)">[^<]*<\/div>\s*)*)/) || [, ''])[1];
    const ok = (top.match(/class="alert is-green">([^<]*)</) || [])[1] || null;
    const err = (top.match(/class="alert is-red">([^<]*)</) || [])[1] || null;
    return { status: r.status, location: r.location, ok: ok && ent(ok), err: err && ent(err), html: next.text };
  }
}
async function login(user = 'admin', pw = 'admin123') {
  const s = new Session(); const r = await s.raw('POST', '/login', { username: user, password: pw });
  if (r.status !== 302 || r.location !== '/') throw new Error('login failed ' + user);
  return s;
}

// ---------- entity helpers ----------
async function newDebtor(s, name) {
  const r = await s.post('/debtors', { name, risk_level: 'medium' });
  if (r.ok !== 'Debtor created') throw new Error('debtor ' + JSON.stringify([r.ok, r.err]));
  return q1('SELECT id FROM debtors WHERE name=? ORDER BY id DESC LIMIT 1', name).id;
}
async function newAgent(s, name, rate) {
  const r = await s.post('/agents', { name, commission_rate: String(rate), target_amount: '10000', active: '1' });
  if (r.ok !== 'Agent created') throw new Error('agent ' + JSON.stringify([r.ok, r.err]));
  return q1('SELECT id FROM agents WHERE name=? ORDER BY id DESC LIMIT 1', name).id;
}
// returns { id } or { err }
async function newCase(s, debtorId, f) {
  const form = { debtor_id: String(debtorId), priority: 'medium', status: 'new', interest_mode: 'fixed', ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)])) };
  const r = await s.post('/cases', form);
  const m = r.location.match(/^\/cases\/(\d+)$/);
  return m ? { id: Number(m[1]), ok: r.ok } : { err: r.err, location: r.location };
}
// Edit Case needs every field resent (blank = cleared); start from the stored row.
async function editCase(s, id, changes) {
  const c = q1('SELECT * FROM cases WHERE id=?', id);
  const form = { debtor_id: c.debtor_id, agent_id: c.agent_id ?? '', principal_amount: c.principal_amount, interest_mode: c.interest_mode,
    interest_rate: c.interest_mode === 'fixed' ? '' : c.interest_rate, interest_amount: c.interest_amount ?? '', loan_start_date: c.loan_start_date ?? '',
    tenure: c.tenure ?? '', priority: c.priority, remark: c.remark ?? '', ...changes };
  return s.post(`/cases/${id}`, Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v ?? '')])));
}
const pay = (s, id, date, amount, extra = {}) => s.post(`/cases/${id}/payments`, { payment_date: date, amount: String(amount), method: 'bank_transfer', ...extra });
const lastPaymentId = id => (q1('SELECT id FROM payments WHERE case_id=? ORDER BY id DESC LIMIT 1', id) || {}).id;

// ---------- page parsers ----------
const lval = (h, lbl) => { const m = h.match(new RegExp(`ledger-lbl">${lbl}</div><div class="ledger-val[^"]*">([^<]+)<`)); return m ? m[1].trim() : null; };
function parseSchedule(html) { // rows of every scheduleTable in order, split by table
  return [...html.matchAll(/<table class="data"><thead><tr><th>Due Date<\/th>[\s\S]*?<\/table>/g)].map(t =>
    [...t[0].matchAll(/<tr>\s*<td>(\d{4}-\d{2}-\d{2})(\s*<small[^>]*>· Arrears)?[\s\S]*?<td class="num">([\d,.-]+)<\/td>\s*<td class="num">([\d,.-]+)<\/td>\s*<td class="num">([\d,.-]+)<\/td>\s*<td><span class="badge [^"]*">([^<]+)<\/span><\/td>(?:\s*<td>([\s\S]*?)<\/td>)?/g)]
      .map(m => ({ due: m[1], kind: m[2] ? 'arrears' : 'regular', expected: fx(num(m[3])), paid: fx(num(m[4])), outstanding: fx(num(m[5])), status: m[6],
        pay: m[7] && m[7].includes('payInstallment(') ? fx(num(m[7].match(/payInstallment\(([\d.]+)\)/)[1])) : null })));
}
async function caseView(s, id) {
  const r = await s.get(`/cases/${id}`); const h = r.text;
  if (r.status !== 200) return { status: r.status };
  const od = h.match(/ledger-lbl">Overdue<\/div><div class="ledger-val[^"]*">([^<]+)<\/div>\s*<small[^>]*>([^<]+)<\/small>/);
  const tables = parseSchedule(h);
  const hasSched = h.includes('<h2>Repayment Schedule');
  const cut = h.match(/Remaining principal RM ([\d,.]+) · unpaid interest RM ([\d,.]+) as of today/);
  const rng = h.match(/name="effective_date" min="([^"]*)" max="([^"]*)"/);
  const rsHist = [...h.matchAll(/Principal at cut RM ([\d,.]+) · Arrears carried RM ([\d,.]+)/g)].map(m => ({ principal: fx(num(m[1])), arrears: fx(num(m[2])) }));
  const ptps = [...h.matchAll(/<tr><td>([^<]*)<\/td>\s*<td class="num">([\d,.]+)<\/td><td>(\d{4}-\d{2}-\d{2})<\/td>\s*<td><span class="badge [^"]*">([^<]+)<\/span>/g)]
    .map(m => ({ inst: m[1], amount: fx(num(m[2])), due: m[3], status: m[4] }));
  const planHeads = [...h.matchAll(/<b>Installment Plan<\/b> · RM ([\d,.]+) · (\d+)\/(\d+) kept/g)].map(m => ({ total: fx(num(m[1])), kept: +m[2], size: +m[3] }));
  const payMax = (h.match(/· max ([\d,.]+) \(settles the loan today\)<\/small> <input type="number" step="0.01" min="0.01" max="([^"]*)" name="amount" id="pay-amount"/) || []);
  const timeline = [...h.matchAll(/<li><span class="badge [^"]*">([a-z_]+)<\/span>\s*([\s\S]*?)<span class="meta">/g)].map(m => ({ type: m[1], text: ent(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) }));
  const lead = (h.match(/ledger-amt"><span class="ledger-cur">RM<\/span>([\d,.-]+)/) || [])[1];
  const v111 = /ledger-lbl">Settlement Today <small>/.test(h);
  return {
    status: (h.match(/<h1>[^<]*<span class="badge [^"]*"><span class="dot"><\/span>([^<]+)<\/span>/) || [])[1],
    // v1.11.0 compat (G-24, added 2026-10-26): lead figure is Settlement Today; contract figure is "Contract Balance".
    outstanding: fx(num(v111 ? lval(h, 'Contract Balance') : lead)),
    recovered: num((h.match(/<b>(\d+)% recovered<\/b>/) || [])[1]),
    principal: fx(num(lval(h, 'Principal'))), interest: fx(num(lval(h, 'Interest'))), paid: fx(num(lval(h, 'Paid'))),
    settlement: fx(num(v111 ? lead : lval(h, 'Settlement Today'))),
    overdue: od ? fx(num(od[1])) : null, dpdText: od ? od[2].trim() : null,
    dpd: od ? (/(\d+) days? past due/.test(od[2]) ? Number(od[2].match(/(\d+) days? past due/)[1]) : 0) : null,
    maturity: lval(h, 'Maturity Date'),
    schedule: hasSched ? tables[0] || [] : [], superseded: hasSched ? tables.slice(1) : tables,
    cut: cut ? { principal: fx(num(cut[1])), arrears: fx(num(cut[2])) } : null, range: rng ? { min: rng[1], max: rng[2] } : null,
    rsHist, ptps, planHeads, timeline,
    payMaxLabel: payMax[1] ? fx(num(payMax[1])) : null, payMaxAttr: payMax[2] || null, html: h,
  };
}
async function statementView(s, id) {
  const h = (await s.get(`/cases/${id}/statement`)).text;
  const g = lbl => { const m = h.match(new RegExp(`<div><span>${lbl}</span>([^<]*)</div>`)); return m ? ent(m[1]).trim() : null; };
  const sett = h.match(/<div><span>Settlement Amount as of ([\d-]+)<\/span>RM ([\d,.]+)<\/div>/);
  const od = h.match(/<div><span>Overdue<\/span>RM ([\d,.]+)([^<]*)<\/div>/);
  return { principal: fx(num(g('Principal'))), interest: fx(num(g('Interest'))), paid: fx(num(g('Paid'))),
    outstanding: fx(num(g('Contract Balance \\(incl\\. interest not yet due\\)'))), settlementDate: sett && sett[1], settlement: sett ? fx(num(sett[2])) : null,
    overdue: od ? fx(num(od[1])) : null, dpd: od ? (/(\d+) days? past due/.test(od[2]) ? Number(od[2].match(/(\d+) days?/)[1]) : 0) : null, html: h };
}
async function dashboard(s) {
  const h = (await s.get('/')).text;
  const lines = [...h.matchAll(/<div class="al"><span>([^<]+)<\/span><span class="tr">[\s\S]*?<span class="v">RM ([\d,.-]+)<\/span>/g)].map(m => [m[1], fx(num(m[2]))]);
  const tot = h.match(/Total Outstanding(?: <small>[^<]*<\/small>)?<\/div><div class="v2">RM ([\d,.-]+)<\/div>\s*<div class="sub2">[^·]*· RM ([\d,.-]+) in legal[^<]*?contract balance RM ([\d,.-]+)/);
  const coll = h.match(/Collected Today<\/div>\s*<div class="v2">RM ([\d,.-]+)<\/div>\s*<div class="sub2">(\d+) payment/);
  const cases = h.match(/<div class="v2">(\d+) <small>active<\/small> · (\d+) <small>legal<\/small>/);
  const ptp = h.match(/<div class="v2">(\d+) <small>due<\/small> · (\d+) <small>overdue<\/small> · (\d+) <small>broken<\/small>/);
  const act = h.match(/<div class="v2">(\d+) <small>opened<\/small> · (\d+) <small>closed<\/small>/);
  const board = [...h.matchAll(/<div class="row"><span>([^<]+)<\/span><span class="num">RM ([\d,.-]+)<\/span><\/div>/g)].map(m => [ent(m[1]), fx(num(m[2]))]);
  return { total: tot && fx(num(tot[1])), special: tot && fx(num(tot[2])), contract: tot && fx(num(tot[3])), collectedToday: coll && fx(num(coll[1])), paymentsToday: coll && +coll[2],
    active: cases && +cases[1], legal: cases && +cases[2], ptpDue: ptp && +ptp[1], ptpOverdue: ptp && +ptp[2], ptpBroken: ptp && +ptp[3],
    opened: act && +act[1], closed: act && +act[2],
    dpd: Object.fromEntries(lines.slice(0, 6)), age: Object.fromEntries(lines.slice(6).map(([k, v]) => [k.replace(/d$/, ''), v])), board, html: h };
}
async function reports(s, qs = '') {
  const h = (await s.get('/reports' + qs)).text;
  const byStatus = [...h.matchAll(/<tr><td><span class="badge [^"]*">([^<]+)<\/span><\/td>\s*<td class="num">(\d+)<\/td><td class="num">([\d,.-]+)<\/td><td class="num">([\d,.-]+)<\/td>/g)].map(m => ({ status: m[1], cnt: +m[2], total: fx(num(m[3])), contract: fx(num(m[4])) }));
  const foot = h.match(/<tfoot><tr><td>Total<\/td><td class="num">(\d+)<\/td><td class="num">([\d,.-]+)<\/td><td class="num">([\d,.-]+)<\/td>/);
  const perf = [...h.matchAll(/<tr><td>([^<]+)<\/td><td class="num">([\d,.-]+)<\/td>\s*<td class="num">([\d.]+)<\/td><td class="num">([\d,.-]+)<\/td>/g)].map(m => ({ name: ent(m[1]), collected: fx(num(m[2])), rate: +m[3], commission: fx(num(m[4])) }));
  return { byStatus, footCnt: foot && +foot[1], footTotal: foot && fx(num(foot[2])), footContract: foot && fx(num(foot[3])), perf, html: h };
}
async function commissions(s, month) {
  const h = (await s.get('/commissions' + (month ? '?month=' + month : ''))).text;
  return [...h.matchAll(/<tr>\s*<td>([^<]+)<\/td>\s*<td class="num">([\d,.-]+)<\/td>\s*<td class="num">([\d.]+)<\/td>\s*<td class="num">([\d,.-]+)<\/td>\s*<td class="num">([\d,.-]+)<\/td>\s*<td class="num ?([^"]*)">([\d,.-]+)<\/td>/g)]
    .map(m => ({ name: ent(m[1]), collected: fx(num(m[2])), rate: +m[3], earned: fx(num(m[4])), settled: fx(num(m[5])), pendingRed: m[6].includes('is-red'), pending: fx(num(m[7])) }));
}
async function agentsList(s) {
  const h = (await s.get('/agents')).text;
  return [...h.matchAll(/<tr><td><a href="\/agents\/(\d+)">([^<]+)<\/a><\/td><td>[^<]*<\/td>\s*<td class="num">(\d+)<\/td><td class="num">([\d,.-]+)<\/td>\s*<td class="num">([\d.]+)<\/td><td class="num">([\d,.-]+)<\/td>/g)]
    .map(m => ({ id: +m[1], name: ent(m[2]), cases: +m[3], collected: fx(num(m[4])), rate: +m[5], commission: fx(num(m[6])) }));
}
async function csv(s, url) {
  const t = (await s.get(url)).text.replace(/^﻿/, '');
  const parseLine = l => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i];
    if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const lines = t.split(/\r\n/).filter(Boolean).map(parseLine);
  return { head: lines[0], rows: lines.slice(1), raw: t };
}
const todayMYT = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

module.exports = { BASE, DB_PATH, q1, qa, Session, login, newDebtor, newAgent, newCase, editCase, pay, lastPaymentId,
  caseView, statementView, dashboard, reports, commissions, agentsList, csv, parseSchedule, num, fx, todayMYT };
