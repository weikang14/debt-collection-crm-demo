// Role 2 — extra checks: restructure dialog "as of today" vs same-day payment; aging vs DPD.
//   node --no-warnings tests/qa/calc/extra.qa.js     (after run.qa.js; server on 3302)
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const X = require('./expected.qa.js');
const { Client, parseCase, num, m1 } = require('./client.qa.js');
const ROOT = path.join(__dirname, '..', '..', '..');
const ro = new DatabaseSync(path.join(ROOT, 'data', 'qa', 'business.db'), { readOnly: true });
const q = (s, ...p) => ro.prepare(s).all(...p);
const TODAY = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const out = {};
(async () => {
  const a = await new Client().login('admin', 'admin123');
  const did = q("SELECT max(id) id FROM debtors WHERE name='QA 业务计算专用'")[0].id;
  // (a) pay today, then look at the Restructure dialog's "as of today" figures
  const r = await a.post('/cases', { debtor_id: did, agent_id: '', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-10-01', tenure: '12', priority: 'medium', status: 'assigned' });
  const cid = Number(m1(/\/cases\/(\d+)/, r.location));
  await a.post(`/cases/${cid}/payments`, { payment_date: TODAY, amount: '5000', method: 'cash' });
  const pg = parseCase((await a.get('/cases/' + cid)).body);
  const loan = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-10-01', maturity: '2027-10-01' };
  const e = X.payoffAsOf(loan, [{ date: TODAY, amount: 5000 }], TODAY);
  out.rsDialogSameDay = { caseId: cid, expected: { principal: e.principalRemaining, arrears: e.interestUnpaid },
    system: { principal: pg.rsPrincipal, arrears: pg.rsArrears }, ledgerOutstanding: pg.outstanding };
  // (b) Aging buckets vs DPD: cases opened today but long overdue
  const dash = (await a.get('/')).body;
  const aging = [...dash.matchAll(/<span>([^<]+)d<\/span><span class="tr">[\s\S]*?<span class="v">RM ([^<]+)<\/span>/g)].map((m) => [m[1], num(m[2])]);
  const ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'qa', 'calc-results.json'), 'utf8'));
  const mat = q("SELECT id, case_no, loan_start_date, maturity_date, outstanding_amount, opened_at FROM cases WHERE remark='RS-21' OR remark='SCH-03 示例C'");
  out.aging = { buckets: aging, overdueButOpenedToday: mat.map((c) => ({ ...c, openedDaysAgo: 0, dpdFromSchedule: X.days(X.addMonths(c.loan_start_date, 1), TODAY) })) };
  // (c) statement outstanding vs payoff today for example-A case
  const cA = ids.ids.cA;
  const st = (await a.get(`/cases/${cA}/statement`)).body;
  const A = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-01-01', maturity: '2027-01-01' };
  out.statementA = { statementOutstanding: num(m1(/<span>Outstanding<\/span>RM ([^<]+)</, st)),
    payoffToday: X.payoffAsOf(A, [{ date: '2026-03-02', amount: 1000 }], TODAY).outstanding };
  fs.writeFileSync(path.join(ROOT, 'data', 'qa', 'calc-extra.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((err) => { console.error(err); process.exit(1); });
