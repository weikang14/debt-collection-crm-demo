// QA role 3 (compliance), round 2. Not a node --test file (name avoids discovery).
// Talks HTTP to the QA server on :3303 (DB data/qa/compliance-r2.db) and reads that
// DB read-only. Never touches data/crm.db.
// Run: CRM_DB_PATH=data/qa/compliance-r2.db node --no-warnings tests/qa/compliance-r2/compliance-r2.qa.js
// ponytail: regex HTML checks, no DOM lib; one flat script, results to data/qa/compliance-r2-results.json.
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..', '..', '..');
const QA_DB = path.join(ROOT, 'data', 'qa', 'compliance-r2.db');
if (!process.env.CRM_DB_PATH || path.resolve(ROOT, process.env.CRM_DB_PATH) !== QA_DB) throw new Error('refusing: CRM_DB_PATH must be data/qa/compliance-r2.db');
const { DatabaseSync } = require('node:sqlite');
const dayjs = require(path.join(ROOT, 'node_modules', 'dayjs'));
// Pure ledger functions only (no writes): caseBalance, monthsSince, nominalAnnualRate.
const P = require(path.join(ROOT, 'src', 'services', 'payments'));

const BASE = 'http://127.0.0.1:3303';
const ro = new DatabaseSync(QA_DB, { readOnly: true });
const q1 = (sql, ...p) => ro.prepare(sql).get(...p);
const qa = (sql, ...p) => ro.prepare(sql).all(...p);
const TODAY = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const ago = n => dayjs(TODAY).subtract(n, 'day').format('YYYY-MM-DD');

class S {
  constructor() { this.cookie = ''; this.setCookie = []; }
  async req(method, url, form, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(BASE + url, { method, headers: h, body, redirect: 'manual' });
    this.setCookie = res.headers.getSetCookie();
    for (const c of this.setCookie) if (c.startsWith('connect.sid=')) this.cookie = c.split(';')[0];
    return { status: res.status, location: res.headers.get('location') || '', text: await res.text(), type: res.headers.get('content-type') || '' };
  }
  get(u) { return this.req('GET', u); }
  // POST then follow one redirect to read the flash banner (flash lives in the session).
  async act(u, form, headers) {
    const r = await this.req('POST', u, form, headers);
    let flash = null, page = null;
    if (r.status === 302 && r.location) {
      page = await this.get(r.location);
      const m = page.text.match(/class="alert is-(green|red)">([^<]*)</);
      flash = m ? `${m[1]}:${m[2].replace(/&#3[49];|&quot;/g, "'")}` : null;
    }
    return { ...r, flash, page };
  }
}
const PW = { admin: 'admin123', manager: 'manager123', agent1: 'agent123', agent2: 'agent123', agent3: 'agent123', finance: 'finance123', auditor: 'auditor123' };
async function as(u) {
  const s = new S();
  const r = await s.req('POST', '/login', { username: u, password: PW[u] });
  if (r.status !== 302 || r.location !== '/') throw new Error('login failed ' + u);
  s.loginCookie = s.setCookie.join(' | ');
  return s;
}

const results = [];
function rec(id, expect, actual, verdict, note = '') {
  results.push({ id, expect, actual: String(actual).slice(0, 500), verdict, note });
  console.log(`[${verdict}] ${id}: ${String(actual).slice(0, 200)}`);
}
const lastAudit = () => q1('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1') || {};
const auditCount = () => q1('SELECT COUNT(*) n FROM audit_logs').n;
const caseRow = id => q1('SELECT * FROM cases WHERE id=?', id);
const num = s => Number(String(s).replace(/,/g, ''));

async function newCase(mgr, f) {
  const form = { debtor_id: 12, agent_id: 1, priority: 'medium', status: 'new', interest_mode: 'monthly', interest_rate: '', interest_amount: '', loan_start_date: '', tenure: '', ...f };
  const r = await mgr.act('/cases', form);
  const m = r.location.match(/^\/cases\/(\d+)/);
  return { id: m ? Number(m[1]) : null, flash: r.flash, location: r.location };
}
// Settlement Today value shown on the case page.
async function settlementShown(s, id) {
  const t = (await s.get(`/cases/${id}`)).text;
  const m = t.match(/Settlement Today<\/div><div class="ledger-val">([\d,\.]+)/);
  return m ? num(m[1]) : null;
}

(async () => {
  const admin = await as('admin'), mgr = await as('manager'), fin = await as('finance'), aud = await as('auditor');
  const ag1 = await as('agent1'), ag2 = await as('agent2'), ag3 = await as('agent3');

  // ---------- A. D-01 / D-03 interest and caps ----------
  let c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: '2026-01-01', tenure: 12 });
  rec('A1 monthly 1.5% x12 from 2026-01-01', 'accepted; interest 1,800 (18.00%)', `id=${c.id} interest_charged=${c.id && caseRow(c.id).interest_charged}`, c.id && caseRow(c.id).interest_charged === 1800 ? 'PASS' : 'FAIL');

  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: '2026-01-31', tenure: 12 });
  const m1 = P.monthsSince('2026-01-31', '2026-02-28'), m2 = P.monthsSince('2026-01-31', '2026-03-01');
  const feb = 10000 * 0.015 * m2;
  rec('A2 monthly from 2026-01-31: whole month in a 28-day Feb', '12 months = 1,800; note per-day effect of whole-month convention',
    `interest_charged=${caseRow(c.id).interest_charged}; months(01-31→02-28)=${m1}; settlement interest on 2026-03-01=${feb.toFixed(2)} for 29 days = ${(feb / 10000 / 29 * 365 * 100).toFixed(2)}% p.a. on actual/365`,
    caseRow(c.id).interest_charged === 1800 ? 'PASS' : 'FAIL', 'whole-month convention: 1.5% for a 28-day month');

  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'daily', interest_rate: 18, loan_start_date: '2027-03-01', tenure: 12 });
  rec('A3 annual 18% x12 from 2027-03-01 (contains 2028-02-29)', 'lawyer item: ≤1,800 if cap is strict per calendar year',
    `accepted=${!!c.id}; interest_charged=${c.id && caseRow(c.id).interest_charged} (${c.id && (caseRow(c.id).interest_charged / 100).toFixed(3)}%)`, c.id && caseRow(c.id).interest_charged > 1800 ? 'OBSERVE' : 'PASS');

  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.6, loan_start_date: TODAY, tenure: 12 });
  rec('A5 monthly 1.6% rejected', 'rejected: exceeds 18% p.a.', `id=${c.id} flash=${c.flash}`, !c.id && /exceeds the 18% p\.a\. limit/.test(c.flash) ? 'PASS' : 'FAIL');
  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'daily', interest_rate: 18.5, loan_start_date: TODAY, tenure: 12 });
  rec('A6 annual 18.5% rejected', 'rejected', `id=${c.id} flash=${c.flash}`, !c.id ? 'PASS' : 'FAIL');
  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'fixed', interest_amount: 2000, loan_start_date: TODAY, tenure: 12 });
  rec('A7 fixed 2,000 / 10,000 / 12m rejected', 'rejected (20% p.a.)', `id=${c.id} flash=${c.flash}`, !c.id ? 'PASS' : 'FAIL');

  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'fixed', interest_amount: 9000 });
  rec('A8 fixed 9,000 / 10,000 with no tenure', 'should be refused or rate made assessable', `accepted=${!!c.id} id=${c.id} flash=${c.flash}; nominalAnnualRate=${P.nominalAnnualRate({ interest_mode: 'fixed', interest_amount: 9000, tenure: null }, 10000)}`, c.id ? 'FAIL' : 'PASS', 'cap skipped when tenure blank');
  const a8 = c.id;

  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'fixed', interest_amount: 1800, loan_start_date: TODAY, tenure: 30, tenure_unit: 'days' });
  const a9 = c.id && caseRow(c.id);
  rec('A9 crafted POST: fixed 1,800 / 10,000, tenure 30 DAYS', 'should be refused (≈219% p.a.)',
    `accepted=${!!c.id}; stored tenure=${a9 && a9.tenure} ${a9 && a9.tenure_unit}, maturity=${a9 && a9.maturity_date}; cap saw ${P.nominalAnnualRate({ interest_mode: 'fixed', interest_amount: 1800, tenure: 30 }, 10000)}% p.a.; actual ${(1800 / 10000 / (30 / 365) * 100).toFixed(1)}% p.a.`,
    c.id ? 'FAIL' : 'PASS', 'nominalAnnualRate assumes months; form has no unit field but server accepts tenure_unit');

  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: '2021-06-01' });
  const a10 = c.id && caseRow(c.id);
  const fut = a10 && P.caseBalance(a10, [], '2027-12-31');
  rec('A10 monthly 1.5%, NO tenure, start 2021-06-01', 'interest ≤ principal at all times',
    `accepted=${!!c.id}; interest today=${a10 && a10.interest_charged}; projected interest at 2027-12-31=${fut && fut.interest} vs principal 10,000`,
    c.id && fut.interest > 10000 ? 'FAIL' : 'PASS', 'open-ended accrual has no cap; check runs once at creation');

  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: TODAY, tenure: 120 });
  rec('A11 monthly 1.5% x120 rejected (interest > principal)', 'rejected', `id=${c.id} flash=${c.flash}`, !c.id && /cannot exceed the principal/.test(c.flash) ? 'PASS' : 'FAIL');

  // Cap setting
  let r = await mgr.req('POST', '/settings', { company_name: 'X', max_annual_rate: 100 });
  rec('A12a manager cannot change cap', '403', r.status, r.status === 403 ? 'PASS' : 'FAIL');
  r = await admin.act('/settings', { company_name: 'QA Lender Sdn Bhd', address: '1 Jalan QA', phone: '03-0000', email: 'qa@x.my', reg_no: '202601000001', max_annual_rate: 100 });
  const capAudit = lastAudit();
  rec('A12b admin raises cap 18→100', 'saved; audit should record old→new cap', `flash=${r.flash}; audit="${capAudit.action} ${capAudit.details}"`, /100|18/.test(capAudit.details || '') ? 'PASS' : 'FAIL', 'audit text lacks the rate values');
  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 8, loan_start_date: TODAY, tenure: 12 });
  const a12 = c.id;
  rec('A12c with cap 100: monthly 8% x12 (96% p.a.)', 'accepted (shows the setting is the only guard)', `accepted=${!!c.id} interest=${c.id && caseRow(c.id).interest_charged}`, c.id ? 'OBSERVE' : 'PASS');
  r = await admin.act('/settings', { company_name: 'QA Lender Sdn Bhd', address: '1 Jalan QA', phone: '03-0000', email: 'qa@x.my', reg_no: '202601000001', max_annual_rate: 18 });
  const page12 = a12 && (await mgr.get(`/cases/${a12}`)).text;
  rec('A12d cap back to 18: existing 96% loan flagged?', 'case page or list should flag terms above current cap', `restored=${q1('SELECT max_annual_rate m FROM settings').m}; page mentions limit/exceeds=${a12 ? /limit|exceeds/i.test(page12) : 'n/a'}`, a12 && !/limit|exceeds/i.test(page12) ? 'FAIL' : 'PASS');

  // ---------- B. D-02 early settlement ----------
  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: ago(92), tenure: 12, agent_id: 1 });
  const b1 = c.id;
  const set1 = await settlementShown(fin, b1);
  r = await fin.act(`/cases/${b1}/payments`, { amount: 11800, payment_date: TODAY, method: 'bank_transfer' });
  rec('B1a monthly loan, day 92: pay contract total 11,800', 'refused', `settlement shown=${set1}; flash=${r.flash}`, /exceeds what is owed/.test(r.flash || '') ? 'PASS' : 'FAIL');
  r = await fin.act(`/cases/${b1}/payments`, { amount: set1.toFixed(2), payment_date: TODAY, method: 'bank_transfer' });
  const b1r = caseRow(b1);
  rec('B1b pay settlement amount', 'fully paid; interest = accrued only', `flash=${r.flash}; status=${b1r.status}; interest_charged=${b1r.interest_charged}; outstanding=${b1r.outstanding_amount}`, b1r.status === 'fully_paid' && b1r.interest_charged < 1800 ? 'PASS' : 'FAIL');

  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'fixed', interest_amount: 1800, loan_start_date: ago(30), tenure: 12, agent_id: 1 });
  const b2 = c.id, set2 = await settlementShown(fin, b2);
  r = await fin.act(`/cases/${b2}/payments`, { amount: set2.toFixed(2), payment_date: TODAY, method: 'bank_transfer' });
  rec('B2 fixed 1,800/12m settled on day 30', 'D-02: Fixed keeps full interest (pending lawyer)', `settlement=${set2}; ${r.flash}; interest kept=${caseRow(b2).interest_charged} ≈ ${(1800 / 10000 / (30 / 365) * 100).toFixed(0)}% p.a. over the 30 days actually lent`, 'OBSERVE');

  // ---------- C. restructure limits ----------
  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.2, loan_start_date: ago(60), tenure: 12, agent_id: 1 });
  r = await mgr.act(`/cases/${c.id}/restructures`, { effective_date: TODAY, interest_mode: 'monthly', interest_rate: 1.5, tenure: 12, reason: 'qa raise' });
  rec('C1 restructure 1.2%→1.5%/month', 'refused', r.flash, /cannot raise/.test(r.flash || '') ? 'PASS' : 'FAIL');

  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: ago(180), tenure: 12, agent_id: 1 });
  r = await mgr.act(`/cases/${c.id}/restructures`, { effective_date: TODAY, interest_mode: 'fixed', interest_amount: 1800, tenure: 12, reason: 'qa switch to fixed' });
  // Effective annual rate of 12 equal instalments of 11,800/12 on 10,000 (monthly IRR × 12).
  const inst = 11800 / 12; let lo = 0, hi = 0.1;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; const pv = Array.from({ length: 12 }, (_, k) => inst / (1 + mid) ** (k + 1)).reduce((a, b) => a + b); pv > 10000 ? (lo = mid) : (hi = mid); }
  rec('C2 restructure monthly 1.5% (reducing) → fixed 1,800 flat over 12m', 'lawyer item: same nominal 18% but higher effective cost',
    `flash=${r.flash}; effective rate of equal instalments=${(lo * 12 * 100).toFixed(2)}% p.a. vs 18% on the interest-first basis`, /Restructured/.test(r.flash || '') ? 'OBSERVE' : 'PASS');

  c = await newCase(mgr, { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: '2025-09-20', tenure: 12, agent_id: 1 });
  const c3 = c.id;
  r = await fin.act(`/cases/${c3}/payments`, { amount: 8000, payment_date: '2026-09-25', method: 'bank_transfer' });
  const cut = P.caseBalance(caseRow(c3), qa('SELECT amount,payment_date FROM payments WHERE case_id=? ORDER BY payment_date', c3));
  r = await mgr.act(`/cases/${c3}/restructures`, { effective_date: TODAY, interest_mode: 'monthly', interest_rate: 1.5, tenure: 120, reason: 'qa long extension' });
  const rs = q1('SELECT * FROM case_restructures WHERE case_id=?', c3);
  const proj = rs && P.caseBalance(caseRow(c3), qa('SELECT amount,payment_date FROM payments WHERE case_id=? ORDER BY payment_date', c3), rs.maturity_date, [rs]);
  rec('C3 s.17A(2): restructure 3,800 remaining principal over 120 months', 'unpaid interest should not exceed the principal then due',
    `remaining principal=${cut.principalRemaining}; restructure ${r.flash}; unpaid interest at ${rs && rs.maturity_date} if unpaid=${proj && proj.interestUnpaid} vs principal due ${proj && proj.principalRemaining}`,
    rs && proj.interestUnpaid > proj.principalRemaining ? 'FAIL' : 'PASS', 'check compares lifetime interest with ORIGINAL principal');

  // ---------- D. ledger, audit ----------
  const payBefore = qa('SELECT id FROM payments WHERE case_id=5');
  r = await mgr.act('/cases/5', { debtor_id: 6, agent_id: 1, principal_amount: 6000, interest_mode: 'fixed', interest_amount: 432, priority: 'medium', remark: '' });
  const d1 = lastAudit();
  rec('D1 edit principal & debtor of a case with payments', 'should be locked (F-24); audit has old→new', `flash=${r.flash}; payments=${payBefore.length}; audit="${d1.details}"`, /principal_amount: 5400 → 6000/.test(d1.details) ? 'PARTIAL' : 'FAIL', 'audit fixed, lock not');
  const p16 = q1('SELECT * FROM payments WHERE case_id=16 ORDER BY id LIMIT 1');
  r = await fin.act(`/cases/16/payments/${p16.id}`, { amount: (p16.amount - 1).toFixed(2), payment_date: String(p16.payment_date).slice(0, 10), method: 'cash', reference: 'QA-NEW-REF', bank: '' });
  const d2 = lastAudit();
  rec('D2 edit payment', 'audit old→new incl. date/method/reference', `flash=${r.flash}; audit="${d2.details}"`, /amount .* → .*method .* → cash/.test(d2.details) ? 'PASS' : 'FAIL');
  r = await fin.act('/cases/16/payments', { amount: '2.00', payment_date: TODAY, method: 'cash' });
  const lastPay = q1('SELECT * FROM payments ORDER BY id DESC LIMIT 1');
  r = await fin.act(`/cases/16/payments/${lastPay.id}/void`, {});
  const gone = !q1('SELECT 1 FROM payments WHERE id=?', lastPay.id);
  const voidFlash = r.flash;
  r = await fin.act('/cases/16/payments', { amount: '1.00', payment_date: TODAY, method: 'cash' });
  const newRc = q1('SELECT receipt_no FROM payments ORDER BY id DESC LIMIT 1').receipt_no;
  rec('D3 void newest payment then record another', 'receipt number never reused; void should keep the row (F-24)', `void ${lastPay.receipt_no}: ${voidFlash}; row deleted=${gone}; next receipt=${newRc}`, newRc !== lastPay.receipt_no ? (gone ? 'PARTIAL' : 'PASS') : 'FAIL', 'hard delete remains');

  r = await mgr.act('/cases/5/notes', { content: 'Manager note QA' });
  const mNote = q1("SELECT id FROM timeline_events WHERE case_id=5 AND event_type='note' AND content='Manager note QA'").id;
  r = await ag1.act(`/cases/5/notes/${mNote}`, { content: 'agent overwrite' });
  rec('D4a agent edits manager note', 'refused', r.flash, /only change your own/.test(r.flash || '') ? 'PASS' : 'FAIL');
  r = await ag1.act('/cases/5/notes', { content: 'Agent note QA to delete' });
  const aNote = q1("SELECT id FROM timeline_events WHERE content='Agent note QA to delete'").id;
  r = await ag1.act(`/cases/5/notes/${aNote}/delete`, {});
  const d4 = lastAudit();
  rec('D4b agent deletes own note', 'audited with text; row soft-deleted ideally', `audit="${d4.action}: ${d4.details}"; row still exists=${!!q1('SELECT 1 FROM timeline_events WHERE id=?', aNote)}`, d4.action === 'note_delete' ? 'PASS' : 'FAIL', 'hard delete; text survives only in audit');

  r = await ag1.act('/tasks/new', { case_id: 5, type: 'visit', title: 'Field visit', due_date: TODAY });
  rec('D5a task type visit', 'refused', r.flash, /Invalid task type/.test(r.flash || '') ? 'PASS' : 'FAIL');
  r = await ag1.act('/tasks/new', { case_id: 5, type: 'follow_up', title: 'Visit debtor at home address', due_date: TODAY });
  rec('D5b follow_up task titled "Visit debtor at home address"', 'no system control (free text); audited', `flash=${r.flash}; audit=${lastAudit().action}`, 'OBSERVE');

  r = await aud.get(`/audit-log?from=${TODAY}&to=${TODAY}&entity=case`);
  const n0 = auditCount();
  const csv = await aud.get(`/audit-log?format=csv&from=${TODAY}&to=${TODAY}`);
  rec('D6 audit filter + CSV export', '200 + text/csv; export itself logged ideally', `page=${r.status}; csv=${csv.status} ${csv.type}; lines=${csv.text.split('\n').length}; audit rows added by export=${auditCount() - n0}`, csv.status === 200 && /csv/.test(csv.type) ? 'PASS' : 'FAIL');

  const deb5 = q1('SELECT * FROM debtors WHERE id=5');
  r = await ag1.act('/debtors/5', { ...Object.fromEntries(['name', 'ic_passport', 'company', 'email', 'address', 'employer', 'salary', 'risk_level', 'guarantor_name', 'guarantor_phone', 'remark'].map(k => [k, deb5[k] ?? ''])), phone: '011-0000000' });
  const d7 = lastAudit();
  rec('D7 agent changes debtor phone', 'audit should record old→new contact data', `flash=${r.flash}; audit="${d7.details}"`, /013-5556667|011-0000000/.test(d7.details || '') ? 'PASS' : 'FAIL');

  // ---------- E. session / security ----------
  const ag3b = await as('agent3');
  // express-session sends Expires (not Max-Age); rolling:true pushes it 2h out on each response.
  const exp = (ag3b.loginCookie.match(/Expires=([^;|]+)/) || [])[1];
  const mins = exp ? Math.round((Date.parse(exp) - Date.now()) / 60000) : null;
  rec('E0 session cookie lifetime', 'expires ~120 min after last request', `Expires=${exp} (~${mins} min)`, mins !== null && Math.abs(mins - 120) <= 2 ? 'PASS' : 'FAIL');
  r = await admin.act('/users/5/toggle', {});
  const e1 = await ag3b.get('/cases');
  rec('E1 deactivated user existing session', 'redirect to /login', `${e1.status} ${e1.location}`, e1.status === 302 && e1.location === '/login' ? 'PASS' : 'FAIL');
  await admin.act('/users/5/toggle', {});
  r = await mgr.req('POST', '/cases/2/status', { status: 'closed' }, { origin: 'http://evil.example' });
  rec('E2 cross-origin POST', '403', r.status, r.status === 403 ? 'PASS' : 'FAIL');
  r = await admin.act('/users', { username: 'qa_short', full_name: 'QA Short', password: '1234567', role: 'finance' });
  rec('E3 7-char password', 'refused', r.flash, /at least 8/.test(r.flash || '') ? 'PASS' : 'FAIL');
  r = await fin.act('/cases/16/payments', { amount: '1.00', payment_date: TODAY, method: 'cash', reference: `x'"><script>alert(1)</script>` });
  const show16 = (await fin.get('/cases/16')).text;
  rec('E4 payment reference with script payload', 'escaped in page', `raw <script>alert(1) present=${show16.includes('<script>alert(1)</script>')}`, show16.includes('<script>alert(1)</script>') ? 'FAIL' : 'PASS');

  // ---------- F. personal data visibility / access log ----------
  let n1 = auditCount();
  const dl = await fin.get('/debtors'); const dd = await fin.get('/debtors/1');
  const sr = await fin.get('/search?q=880101');
  const cv = await ag1.get('/cases?format=csv');
  const st = await fin.get('/cases/2/statement');
  rec('F1 finance sees IC/salary/guarantor; searches by IC; agent exports CSV; statement printed', 'minimum-necessary + access log (F-30/F-31 known open)',
    `list has IC=${dl.text.includes('880101-14-5501')} salary col=${/Salary/.test(dl.text)}; guarantor phone shown=${dd.text.includes('019-9990001')}; IC search hit=${sr.text.includes('Ahmad')}; csv phone=${/01\d-\d+/.test(cv.text)}; audit rows added=${auditCount() - n1}`,
    auditCount() - n1 === 0 ? 'FAIL' : 'PASS', 'known unfixed F-30/F-31');

  // ---------- G. D-13 bankrupt / deceased ----------
  r = await ag2.act('/cases/10/ptps', { amount: 100, due_date: TODAY });
  const g1 = r.flash;
  r = await ag2.act('/cases/10/calls', { result: 'answered', duration_seconds: 30 });
  const g2 = r.flash;
  r = await mgr.act('/cases/10/restructures', { effective_date: TODAY, interest_mode: 'monthly', interest_rate: 1, tenure: 12, reason: 'x' });
  const g3 = r.flash;
  r = await fin.act('/cases/10/payments', { amount: 100, payment_date: TODAY, method: 'cash' });
  const g4 = r.flash;
  r = await fin.act('/cases/10/payments', { amount: 100, payment_date: TODAY, method: 'cash', remark: 'Payment from estate per DGI letter (QA)' });
  rec('G1 bankrupt case 10: PTP / call / restructure / payment without & with reason', 'first four refused, last accepted',
    `ptp=${g1} | call=${g2} | rs=${g3} | pay no reason=${g4} | pay with reason=${r.flash}`,
    /Not allowed/.test(g1) && /Not allowed/.test(g2) && /cannot be restructured/.test(g3) && /reason is required/.test(g4) && /recorded/.test(r.flash) ? 'PASS' : 'FAIL');
  r = await ag2.act('/cases/10/status', { status: 'negotiation' });
  const g5 = caseRow(10).status;
  const p5 = await ag2.act('/cases/10/ptps', { amount: 100, due_date: TODAY });
  const c5 = await ag2.act('/cases/10/calls', { result: 'answered', duration_seconds: 30 });
  rec('G2 agent moves bankrupt case back to Negotiation, then PTP + call', 'agent should not be able to lift the bankruptcy freeze',
    `status flash=${r.flash}; status now=${g5}; then PTP=${p5.flash}; call=${c5.flash}`, g5 === 'bankruptcy' ? 'PASS' : 'FAIL');
  r = await mgr.act('/cases/4/status', { status: 'bankruptcy' });
  const ptp1 = q1('SELECT status FROM ptps WHERE id=1').status;
  const ag3c = await as('agent3');
  r = await ag3c.act('/tasks/new', { case_id: 11, type: 'follow_up', title: 'Call next of kin for payment', due_date: TODAY });
  rec('G3 case 4 set bankrupt with a pending PTP; agent3 adds call task on deceased case 11', 'pending PTPs closed / collection tasks blocked',
    `PTP#1 status after bankruptcy=${ptp1}; task on deceased case: ${r.flash}`, ptp1 === 'pending' || /created/.test(r.flash || '') ? 'FAIL' : 'PASS');

  // ---------- H. D-12 agent limits ----------
  const h1 = await ag1.get('/debtors/new');
  r = await ag1.act('/cases/5/status', { status: 'fully_paid' });
  const h2 = r.flash;
  r = await ag1.act('/cases/5/status', { status: 'closed' });
  rec('H1 agent: new debtor / Fully Paid / Closed', '403 / refused / refused', `new debtor=${h1.status}; fully_paid=${h2}; closed=${r.flash}`, h1.status === 403 && /Only a manager/.test(h2) && /Only a manager/.test(r.flash) ? 'PASS' : 'FAIL');

  // ---------- I. statement ----------
  const stm = (await admin.get(`/cases/${b1}/statement`)).text + (await admin.get('/cases/14/statement')).text;
  const want = { 'Loan Start Date': /Loan Start Date/, 'Interest Terms': /Interest Terms/, 'Tenure': /<span>Tenure/, 'Maturity': /Maturity Date/, 'Settlement': /Settlement Amount as of/, 'Overdue': /Overdue/, 'Restructured': /Restructured<\/span>/, 'Payment history': /Payment History/ };
  const gaps = { 'rate per annum wording for monthly loans': /% ?p\.?a\.?|per annum/i, 'licence no.': /Licen[cs]e/i, 'signature': /Sign/i, 'borrower address': /Address/i, 'instalments due & unpaid with due dates': /Due Date/i, 'title Statement of Account': /Statement of Account/i };
  rec('I1 statement elements present', 'all present', Object.entries(want).map(([k, re]) => `${k}=${re.test(stm)}`).join('; '), Object.values(want).every(re => re.test(stm)) ? 'PASS' : 'FAIL');
  rec('I2 statement elements still missing (s.19(1)/First Schedule)', 'present', Object.entries(gaps).map(([k, re]) => `${k}=${re.test(stm)}`).join('; '), 'OBSERVE');

  // ---------- K/L. receipts, demo data ----------
  const k1 = await fin.get(`/cases/16/payments/${q1('SELECT id FROM payments WHERE case_id=16 LIMIT 1').id}/receipt`);
  rec('K1 receipt page', 'exists (s.19(4)) — known F-25', k1.status, k1.status === 200 ? 'PASS' : 'FAIL', 'known unfixed');
  const ics = qa('SELECT name, ic_passport FROM debtors WHERE id<=12').map(d => `${d.name}:${d.ic_passport}`);
  rec('L1 demo debtors', 'fictional names; IC visibly invalid', ics.join(', '), ics.some(s => /\d{6}-\d{2}-\d{4}/.test(s)) ? 'PARTIAL' : 'PASS', 'names replaced; IC still realistic format');

  fs.writeFileSync(path.join(ROOT, 'data', 'qa', 'compliance-r2-results.json'), JSON.stringify({ run_at: new Date().toISOString(), today_myt: TODAY, results }, null, 1));
  console.log('saved', results.length, 'results');
})().catch(e => { console.error(e); process.exit(1); });
