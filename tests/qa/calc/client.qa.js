// Role 2 — HTTP client + HTML parsers for the system's real outputs (port 3302 only).
'use strict';
const BASE = process.env.QA_BASE || 'http://localhost:3302';
if (!/localhost:3302|127\.0\.0\.1:3302/.test(BASE)) throw new Error('role-2 harness must only hit port 3302');

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, form) {
    const opt = { method, redirect: 'manual', headers: { cookie: this.cookie } };
    if (form) { opt.body = new URLSearchParams(form).toString(); opt.headers['content-type'] = 'application/x-www-form-urlencoded'; }
    const r = await fetch(BASE + path, opt);
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const loc = r.headers.get('location') || '';
    const q = new URLSearchParams(loc.split('?')[1] || '');
    return { status: r.status, location: loc, ok: q.get('ok'), err: q.get('err'), body: await r.text() };
  }
  get(p) { return this.req('GET', p); }
  post(p, f) { return this.req('POST', p, f); }
  async login(u, p) { const r = await this.post('/login', { username: u, password: p }); if (r.status !== 302 || r.location.includes('login')) throw new Error('login failed ' + u); return this; }
}

const txt = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));
const m1 = (re, s) => { const m = s.match(re); return m ? m[1] : null; };

function tableRows(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]));
}
function section(html, h2) {
  const i = html.indexOf('<h2>' + h2); if (i < 0) return null;
  const j = html.indexOf('</section>', i); return html.slice(i, j < 0 ? undefined : j);
}
function parseSchedule(sec) {
  if (!sec) return [];
  const t = sec.slice(0, sec.indexOf('</table>') + 8);
  return tableRows(t).filter((r) => r.length >= 5).map((r) => ({
    due: m1(/(\d{4}-\d{2}-\d{2})/, r[0]), arrears: r[0].includes('Arrears'), expected: num(txt(r[1])), paid: num(txt(r[2])),
    outstanding: num(txt(r[3])), status: txt(r[4]), pay: r[5] ? num(m1(/payInstallment\(([-\d.e]+)\)/, r[5])) : null,
  }));
}
function parseCase(html) {
  const c = {};
  c.status = txt(m1(/<h1>[^<]*<span class="badge[^"]*"><span class="dot"><\/span>([^<]+)<\/span>/, html) || '');
  c.outstanding = num(m1(/<div class="ledger-amt"><span class="ledger-cur">RM<\/span>([^<]+)<\/div>/, html));
  c.recoveredPct = num(m1(/<b>(-?\d+)% recovered<\/b>/, html));
  c.metaPaid = num(m1(/RM ([\d,.\-]+) of [\d,.\-]+ paid/, html));
  c.metaTotal = num(m1(/RM [\d,.\-]+ of ([\d,.\-]+) paid/, html));
  c.principal = num(m1(/Principal<\/div><div class="ledger-val">([^<]+)</, html));
  c.interest = num(m1(/Interest<\/div><div class="ledger-val">([^<]+)</, html));
  c.paid = num(m1(/Paid<\/div><div class="ledger-val pos">([^<]+)</, html));
  c.maturity = m1(/Maturity Date<\/div><div class="ledger-val">([^<]+)</, html);
  c.payMax = num(m1(/id="dlg-payment"[\s\S]*?max ([\d,.]+)<\/small>/, html));
  const rs = m1(/Remaining principal RM ([\d,.]+) · unpaid interest RM ([\d,.]+)/, html);
  if (rs) { const mm = html.match(/Remaining principal RM ([\d,.]+) · unpaid interest RM ([\d,.]+)/); c.rsPrincipal = num(mm[1]); c.rsArrears = num(mm[2]); }
  c.rsMin = m1(/name="effective_date" min="([^"]*)"/, html); c.rsMax = m1(/name="effective_date" min="[^"]*" max="([^"]*)"/, html);
  c.schedule = parseSchedule(section(html, 'Repayment Schedule'));
  const hist = section(html, 'Restructure History');
  c.history = hist ? [...hist.matchAll(/<div class="card"[\s\S]*?(?=<div class="card"|$)/g)].map((m) => ({
    head: txt(m1(/<div><b>([\s\S]*?)<\/div>/, m[0]) || ''), cut: txt(m1(/(Principal at cut[\s\S]*?)<\/div>/, m[0]) || ''),
    rows: parseSchedule(m[0].includes('<table') ? m[0].slice(m[0].indexOf('<table')) : null),
  })) : [];
  const pays = section(html, 'Payments');
  c.payments = pays ? tableRows(pays).filter((r) => r.length >= 4).map((r) => ({ receipt: txt(r[0]), date: txt(r[1]), amount: num(txt(r[2])), locked: (r[4] || '').includes('Locked') })) : [];
  const ptp = section(html, 'Promise to Pay');
  c.ptps = ptp ? tableRows(ptp).filter((r) => r.length >= 4).map((r) => ({ inst: txt(r[0]), amount: num(txt(r[1])), due: txt(r[2]), status: txt(r[3]),
    id: num(m1(/openFulfill\((\d+)/, r[4] || '')) })) : [];
  c.planHeads = [...html.matchAll(/<b>Installment Plan<\/b> · RM ([\d,.]+) · (\d+)\/(\d+) paid/g)].map((m) => ({ total: num(m[1]), paid: +m[2], size: +m[3] }));
  c.planIds = [...html.matchAll(/ptp-plans\/([0-9a-f-]{36})\/cancel/g)].map((m) => m[1]);
  c.timeline = [...html.matchAll(/<li><span class="badge [^"]*">([^<]+)<\/span>([\s\S]*?)<span class="meta">/g)].map((m) => ({ type: m[1], text: txt(m[2]) }));
  return c;
}
function parseCsv(body) {
  const s = body.replace(/^﻿/, ''); const lines = s.split('\r\n');
  const split = (l) => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i];
    if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const [h, ...rows] = lines.map(split); return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

module.exports = { Client, parseCase, parseCsv, tableRows, txt, num, m1, section, BASE };
