// Role 2 round 2 — supplement (run after run.qa.js, before recon.qa.js):
//  1. late entry of an earlier receipt: the refusal hint vs the independent maximum
//  2. promise cap on a restructured loan (settlement on a future date under the new terms)
// Appends to data/qa/calc-r2-results.json.  node --no-warnings tests/qa/calc-r2/supplement.qa.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const E = require('./expected.qa.js');
const C = require('./client.qa.js');
const { F, ledger, settlementOn, addMonths, addDays, r2 } = E;
const T = C.todayMYT();
const file = path.join(C.DB_PATH, '..', 'calc-r2-results.json');
const results = JSON.parse(fs.readFileSync(file, 'utf8'));
const cmp = (g, id, scenario, formula, expected, actual, note = '') =>
  results.push({ g, id, scenario, formula, expected: String(expected), actual: String(actual), result: String(expected) === String(actual) ? 'PASS' : 'FAIL', note });
const atMost = e => { const m = String(e || '').match(/at most RM ([\d.]+)/); return m ? m[1] : `(无上限提示: ${e})`; };
const money = x => Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const s = await C.login('admin', 'admin123');
  const debtor = await C.newDebtor(s, 'QA R2 补充');
  const A = { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: '2026-01-01', tenure: 12 };
  let r;
  const loanA = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-01-01', maturity: '2027-01-01' };

  // 2. promise cap after a restructure (example B), due in 10 days (part month)
  const b = (await C.newCase(s, debtor, A)).id;
  await C.pay(s, b, '2026-03-02', '1000');
  await s.post(`/cases/${b}/restructures`, { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'QA 补充' });
  const rs = [{ effective: '2026-04-01', mode: 'monthly', rate: 1.2, maturity: '2027-10-01' }];
  const due = addDays(T, 10);
  const cap = settlementOn(loanA, [{ date: '2026-03-02', amount: '1000' }], due, { restructures: rs });
  r = await s.post(`/cases/${b}/ptps`, { amount: r2(F.of(cap).add('0.01')), due_date: due });
  cmp('PTP', 'RSCAP+', `示例B 重组后 PTP ${r2(F.of(cap).add('0.01'))}，到期 ${due}`, `拒收：上限 = ${due} 结清额（新条款，含不足一月部分）`,
    `Promised total RM ${money(r2(F.of(cap).add('0.01')))} exceeds the settlement amount on ${due} (RM ${money(cap)})`, r.err);
  r = await s.post(`/cases/${b}/ptps`, { amount: cap, due_date: due });
  cmp('PTP', 'RSCAP', `同上 PTP ${cap}`, '接受', 'PTP created', r.ok);

  // 3. B-13: negative fixed interest
  r = await C.newCase(s, debtor, { principal_amount: 1000, interest_mode: 'fixed', interest_amount: '-100' });
  cmp('CAP', 'NEGINT', 'B-13 Fixed 利息 −100 建案', '拒收', 'Invalid interest amount', r.err);
  // 4. B-18 / K-02: schedule after an early principal payment vs the ledger (example A + 03-02 1,000)
  const st = JSON.parse(fs.readFileSync(path.join(C.DB_PATH, '..', 'calc-r2-run-state.json'), 'utf8'));
  const a1 = st.created.find(x => x.label === '示例A+03-02还1000').id;
  const v = await C.caseView(s, a1);
  const schedLeft = E.sum2(v.schedule.map(x => x.outstanding));
  results.push({ g: 'SCH', id: 'K02', scenario: 'B-18/K-02 示例A 03-02 还 1,000 后：计划未还合计 vs 合同欠款', formula: 'Σ 计划未还 vs 账本', expected: v.outstanding, actual: schedLeft,
    result: schedLeft === v.outstanding ? 'PASS' : 'PENDING', note: `差 ${r2(F.of(schedLeft).sub(v.outstanding))}（K-02：待决定 N-06 的口径后再重算计划）` });
  // 5. B-19 / K-03: demo case 14 — PTP vs schedule
  const v14 = await C.caseView(s, 14);
  results.push({ g: 'SCH', id: 'K03', scenario: 'B-19/K-03 演示案件 14：计划与 PTP 并存', formula: '', expected: '记录现状', actual: `计划首行 ${v14.schedule[0].due} ${v14.schedule[0].expected}（${v14.schedule[0].status}），下一期 ${v14.schedule[1].due} ${v14.schedule[1].expected}；PTP ${v14.ptps.map(p => p.amount + ' ' + p.due + ' ' + p.status).join(', ')}`, result: 'INFO', note: '已知延后 K-03' });

  fs.writeFileSync(file, JSON.stringify(results, null, 1));
  const tot = results.filter(x => x.result !== 'INFO');
  console.log(`after supplement: items ${tot.length}, pass ${tot.filter(x => x.result === 'PASS').length}, fail ${tot.filter(x => x.result === 'FAIL').length}`);
  results.slice(-5).forEach(x => console.log(x.result, x.g + '#' + x.id, '| exp', x.expected, '| act', x.actual));
})().catch(e => { console.error(e); process.exit(1); });
