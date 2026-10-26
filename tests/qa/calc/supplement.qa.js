// Role 2 — supplementary business checks on demo data + manual E2E-01 flow.
//   node --no-warnings tests/qa/calc/supplement.qa.js     (server on 3302, after run.qa.js)
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const X = require('./expected.qa.js');
const { Client, parseCase, num, m1 } = require('./client.qa.js');
const ROOT = path.join(__dirname, '..', '..', '..');
const ro = new DatabaseSync(path.join(ROOT, 'data', 'qa', 'business.db'), { readOnly: true });
const q1 = (s, ...p) => ro.prepare(s).get(...p); const q = (s, ...p) => ro.prepare(s).all(...p);
const TODAY = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const out = {};

(async () => {
  const a = await new Client().login('admin', 'admin123');
  // 1) demo accrual cases: to-maturity Total Outstanding vs accrued-to-today payoff
  out.demoAccrual = [];
  for (const id of [2, 4, 14, 20]) {
    const c = q1('SELECT * FROM cases WHERE id=?', id);
    const rs = q('SELECT * FROM case_restructures WHERE case_id=? ORDER BY effective_date', id)
      .map((r) => ({ effective: r.effective_date, mode: r.interest_mode, rate: r.interest_rate, lump: r.interest_amount, maturity: r.maturity_date }));
    const loan = { principal: c.principal_amount, mode: c.interest_mode, rate: c.interest_rate, lump: 0, start: c.interest_from, maturity: c.maturity_date };
    const pays = q('SELECT payment_date date, amount FROM payments WHERE case_id=?', id).map((p) => ({ date: p.date.slice(0, 10), amount: p.amount }));
    const toMat = X.ledger(loan, pays, { restructures: rs, today: TODAY });
    const now = X.payoffAsOf(loan, pays, TODAY, { restructures: rs });
    const pg = parseCase((await a.get('/cases/' + id)).body);
    out.demoAccrual.push({ case: c.case_no, terms: `${c.interest_mode} ${c.interest_rate}% ${c.loan_start_date} ${c.tenure}m${rs.length ? ' +RS' : ''}`,
      expectedToMaturity: toMat.outstanding, systemTotalOutstanding: pg.outstanding.toFixed(2), payMax: pg.payMax.toFixed(2),
      expectedPayoffToday: now.outstanding, systemRestructureDialogToday: (pg.rsPrincipal + pg.rsArrears).toFixed(2),
      unearnedInterestInTotal: X.F.of(toMat.outstanding).sub(now.outstanding).r2() });
  }
  out.demoUnearnedSum = out.demoAccrual.reduce((s, r) => s.add(r.unearnedInterestInTotal), X.F.of(0)).r2();

  // 2) demo commissions this month: Pending for agents with seeded settlements
  const ch = (await a.get('/commissions')).body; const tbl = ch.slice(0, ch.indexOf('Settlement history'));
  out.demoCommission = [...tbl.matchAll(/<tr>\s*<td>([^<]+)<\/td>([\s\S]*?)<\/tr>/g)].map((m) => {
    const v = [...m[2].matchAll(/<td class="num([^"]*)">([^<]*)<\/td>/g)];
    return { agent: m[1].trim(), collected: v[0][2], earned: v[2][2], settled: v[3][2], pending: v[4][2], red: v[4][1].includes('is-red') };
  }).filter((r) => !r.agent.startsWith('QA'));

  // 3) demo case 5: fulfilled PTP vs actual payment
  const p5 = parseCase((await a.get('/cases/5')).body);
  out.demoCase5 = { ptps: p5.ptps, payments: p5.payments, timeline: p5.timeline.map((t) => t.text) };

  // 4) manual E2E-01 on an accrual loan starting today: PTP → Pay first period → pay max
  await a.post('/debtors', { name: 'QA E2E-01', risk_level: 'medium' });
  const did = q1("SELECT max(id) id FROM debtors WHERE name='QA E2E-01'").id;
  const r = await a.post('/cases', { debtor_id: did, agent_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: TODAY, tenure: '12', priority: 'medium', status: 'assigned' });
  const cid = Number(m1(/\/cases\/(\d+)/, r.location));
  await a.post(`/cases/${cid}/ptps`, { amount: '1000', due_date: TODAY, remark: 'E2E-01' });
  let pg = parseCase((await a.get('/cases/' + cid)).body);
  await a.post(`/ptps/${pg.ptps[0].id}/fulfill`, { amount: '1000', payment_date: TODAY, method: 'cash' });
  pg = parseCase((await a.get('/cases/' + cid)).body);
  const payRow = pg.schedule.find((x) => x.pay != null);
  await a.post(`/cases/${cid}/payments`, { payment_date: TODAY, amount: String(payRow.pay), method: 'cash' });
  pg = parseCase((await a.get('/cases/' + cid)).body);
  const maxBefore = pg.payMax;
  const fin = await a.post(`/cases/${cid}/payments`, { payment_date: TODAY, amount: String(maxBefore), method: 'cash' });
  pg = parseCase((await a.get('/cases/' + cid)).body);
  const pays = q('SELECT payment_date date, amount FROM payments WHERE case_id=?', cid);
  const loan = { principal: 10000, mode: 'monthly', rate: 1.5, start: TODAY, maturity: X.addMonths(TODAY, 12) };
  const e = X.ledger(loan, pays);
  out.e2e01 = { caseId: cid, payments: pays.map((p) => p.amount), firstPayPrefill: payRow.pay, payMaxBeforeFinal: maxBefore, finalResult: fin.ok || fin.err,
    payoffTodayExpected: X.payoffAsOf(loan, pays.slice(0, 2), TODAY).outstanding,
    system: { outstanding: pg.outstanding, principal: pg.principal, interest: pg.interest, paid: pg.paid, recovered: pg.recoveredPct, status: pg.status },
    expected: { interest: e.interest, excessDropped: e.excess } };

  // 5) future-dated payment case: restructure window
  const ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'qa', 'calc-results.json'), 'utf8')).ids;
  const fh = (await a.get('/cases/' + ids.cF)).body;
  out.futurePayCase = { rsMin: m1(/name="effective_date" min="([^"]*)"/, fh), rsMax: m1(/max="(\d{4}-\d{2}-\d{2})" value/, fh), blocked: fh.includes('No valid effective date') };
  out.futurePayCommission = q("SELECT substr(payment_date,1,7) m, SUM(amount) s FROM payments WHERE case_id=? GROUP BY m", ids.cF);

  // 6) terminal statuses inside Dashboard Total Outstanding
  out.terminalOutstanding = q("SELECT status, COUNT(*) n, SUM(outstanding_amount) s FROM cases WHERE status IN ('legal','closed','cancelled','bankruptcy','deceased') GROUP BY status");

  // 7) demo case 14: schedule rows vs pending PTP (two instalment systems)
  const p14 = parseCase((await a.get('/cases/14')).body);
  out.case14 = { scheduleFirst3: p14.schedule.slice(0, 3), ptps: p14.ptps, status: p14.status };

  fs.writeFileSync(path.join(ROOT, 'data', 'qa', 'calc-supplement.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((err) => { console.error(err); process.exit(1); });
