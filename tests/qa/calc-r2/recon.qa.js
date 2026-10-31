// Role 2 round 2 — reconciliation: every case's figures recomputed independently from its
// INPUT terms (read-only DB: terms, payments, restructure terms), then compared with the case
// page, statement, dashboard, reports, the three CSVs, commissions, agents and leaderboard.
// Run after run.qa.js:  node --no-warnings tests/qa/calc-r2/recon.qa.js  → data/qa/calc-r2-recon.{json,md}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const E = require('./expected.qa.js');
const C = require('./client.qa.js');
const { F, ZERO, ledger, settlementOn, schedule, arrears, addMonths, days, commission, r2 } = E;

const T = C.todayMYT();
const results = [];
const rec = (g, id, scenario, formula, expected, actual, note = '') =>
  results.push({ g, id, scenario, formula, expected: String(expected), actual: String(actual), result: String(expected) === String(actual) ? 'PASS' : 'FAIL', note });
const chk = (g, id, scenario, expected, cond, actual, note = '') =>
  results.push({ g, id, scenario, formula: '', expected, actual: String(actual).slice(0, 400), result: cond ? 'PASS' : 'FAIL', note });
const TERMINAL = ['legal', 'closed', 'cancelled', 'bankruptcy', 'deceased'];
const LABEL = { new: 'New', assigned: 'Assigned', negotiation: 'Negotiation', ptp: 'PTP', partial_paid: 'Partial Paid', fully_paid: 'Fully Paid', legal: 'Legal', closed: 'Closed', cancelled: 'Cancelled', bankruptcy: 'Bankruptcy', deceased: 'Deceased' };
// stored UTC datetime / local demo datetime → MYT calendar date, the way the SQL does date(x,'+8 hours')
const mytDate = s => { const t = new Date(String(s).replace(' ', 'T') + 'Z'); return new Date(t.getTime() + 8 * 3600000).toISOString().slice(0, 10); };
const d10 = s => String(s).slice(0, 10);

// Independent figures for one stored case (inputs only).
function expected(c, pays, rss) {
  const accr = c.interest_mode === 'monthly' || c.interest_mode === 'daily';
  const start = accr ? (c.interest_from || mytDate(c.opened_at)) : (c.loan_start_date || mytDate(c.opened_at));
  const maturity = c.tenure && c.loan_start_date ? (c.tenure_unit === 'months' || !c.tenure_unit ? addMonths(c.loan_start_date, c.tenure) : c.maturity_date) : null;
  const loan = { principal: c.principal_amount, mode: c.interest_mode, rate: c.interest_rate || 0, lump: c.interest_amount || 0, start, maturity };
  const P = pays.map(p => ({ date: d10(p.payment_date), amount: String(p.amount) }));
  const R = rss.map(r => ({ effective: r.effective_date, mode: r.interest_mode, rate: r.interest_rate || 0, lump: r.interest_amount || 0, maturity: addMonths(r.effective_date, r.tenure), tenure: r.tenure }));
  const L = ledger(loan, P, { restructures: R, today: T });
  const settled = !F.of(L.outstanding).isPos();
  let rows = [];
  if (R.length) {
    const last = R[R.length - 1], cut = L.cuts[L.cuts.length - 1];
    rows = schedule({ principal: cut.principal, mode: last.mode, rate: last.rate, lump: last.lump, start: last.effective, tenure: last.tenure },
      P.filter(p => p.date > last.effective), { today: T, arrears: cut.arrears, settled });
  } else if (c.tenure && c.loan_start_date && (c.tenure_unit || 'months') === 'months') {
    rows = schedule({ principal: c.principal_amount, mode: c.interest_mode, rate: c.interest_rate || 0, lump: c.interest_amount || 0, start: c.loan_start_date, tenure: c.tenure, origin: start }, P, { today: T, settled });
  }
  const ar = arrears(rows, T);
  const settlement = settlementOn(loan, P, T, { restructures: R });
  const capped = E.capOverdue(ar, settlement); // G-12
  return { exact: L.outstandingExact, paidAny: P.length > 0, outstanding: L.outstanding, interest: L.interest, paid: L.paid, settlement, dpd: capped.dpd, overdue: capped.overdue, cuts: L.cuts };
}

async function main() {
  const s = await C.login('admin', 'admin123');
  const state = JSON.parse(fs.readFileSync(path.join(C.DB_PATH, '..', 'calc-r2-run-state.json'), 'utf8'));
  const known = new Set(state.created.filter(x => /P=10(15|79)|P=1001|P=3001/.test(x.label)).map(x => x.id)); // K-01 float rows
  const cases = C.qa('SELECT * FROM cases ORDER BY id');
  const exp = {};
  let pageMismatch = [], stmtMismatch = [], cutMismatch = [];
  for (const c of cases) {
    const pays = C.qa('SELECT amount, payment_date, agent_id FROM payments WHERE case_id=? ORDER BY payment_date, id', c.id);
    const rss = C.qa('SELECT * FROM case_restructures WHERE case_id=? ORDER BY effective_date, id', c.id);
    const x = exp[c.id] = { ...expected(c, pays, rss), status: c.status, opened: mytDate(c.opened_at), agent: c.agent_id, case_no: c.case_no };
    const v = await C.caseView(s, c.id);
    const e1 = [x.outstanding, x.interest, x.paid, x.settlement, x.dpd, x.overdue].join('/');
    const a1 = [v.outstanding, v.interest, v.paid, v.settlement, v.dpd, v.overdue].join('/');
    rec('CASE', `${c.case_no}`, `案件 ${c.id}（${c.interest_mode}${rss.length ? '，已重组' : ''}，${LABEL[c.status]}）合同欠款/利息/已还/今日结清额/DPD/逾期`, '独立账本（输入条款 + 还款 + 重组条款）',
      e1, a1, known.has(c.id) ? 'K-01 浮点舍入（已知延后）' : '');
    if (e1 !== a1) pageMismatch.push(c.id);
    const st = await C.statementView(s, c.id);
    const sa = [st.outstanding, st.interest, st.paid, st.settlement, st.dpd, st.overdue].join('/');
    if (sa !== a1) stmtMismatch.push(`${c.id}: page ${a1} / stmt ${sa}`);
    rss.forEach((r, k) => { const ec = x.cuts[k]; if (ec && `${ec.principal}/${ec.arrears}` !== `${r.principal_at_cut.toFixed(2)}/${r.arrears_at_cut.toFixed(2)}`) cutMismatch.push(`${c.id}#${k}: 预期 ${ec.principal}/${ec.arrears} 存储 ${r.principal_at_cut}/${r.arrears_at_cut}`); });
    x.cached = c.outstanding_amount; x.page = v.outstanding;
  }
  chk('CASE', 'ALL', `全部 ${cases.length} 个案件：页面 = 独立计算`, '0 个不一致（K-01 浮点行除外）', pageMismatch.filter(id => !known.has(id)).length === 0, `不一致 ${pageMismatch.length} 个：${pageMismatch.join(',')}`);
  chk('CASE', 'STMT', `全部 ${cases.length} 个案件：对账单 = 案件页（6 个数）`, '0 个不一致', stmtMismatch.length === 0, stmtMismatch.slice(0, 5).join('; ') || '全部一致');
  chk('CASE', 'CUT', '全部重组记录：存储的截点本金/挂账 = 独立计算（D-04）', '0 个不一致', cutMismatch.length === 0, cutMismatch.join('; ') || '全部一致');

  // ---------- dashboard ----------
  const all = Object.values(exp);
  const sumIf = f => all.filter(f).reduce((a, x) => a.add(x.outstanding), ZERO).r2();
  const setIf = f => all.filter(f).reduce((a, x) => a.add(x.settlement), ZERO).r2(); // v1.12.0 (G-24 / N-07)
  const d = await C.dashboard(s);
  rec('DASH', 'total', 'Total Outstanding · settlement today（不含 Closed/Cancelled，D-09，G-24）', 'Σ 独立今日结清额', setIf(x => !['closed', 'cancelled'].includes(x.status)), d.total);
  rec('DASH', 'contract', '同卡片的 contract balance', 'Σ 独立合同欠款', sumIf(x => !['closed', 'cancelled'].includes(x.status)), d.contract);
  const kd = f => Object.entries(exp).filter(([id, x]) => known.has(Number(id)) && f(x)).reduce((a, [, x]) => a.add(F.of(x.outstanding).sub(x.page)), ZERO);
  rec('DASH', 'special', '其中 Legal/Bankruptcy/Deceased', 'Σ 三种状态的今日结清额', setIf(x => ['legal', 'bankruptcy', 'deceased'].includes(x.status)), d.special);
  const open = all.filter(x => !TERMINAL.includes(x.status) && F.of(x.outstanding).isPos());
  const bucket = (lbl, fn) => open.filter(fn).reduce((a, x) => a.add(x.settlement), ZERO).r2(); // settlement amounts (G-24)
  for (const lbl of ['Current', '1–30', '31–60', '61–90', '90+', 'No schedule']) rec('DASH', `dpd.${lbl}`, `Aging（DPD）“${lbl}”`, 'Σ 非终态且欠款>0 的案件，按独立 DPD 分档', bucket(lbl, x => E.dpdBucket(x.dpd) === lbl), d.dpd[lbl]);
  for (const lbl of ['0–30', '31–60', '61–90', '90+']) rec('DASH', `age.${lbl}`, `Case Age “${lbl}”`, 'Σ 同上，按开案天数', bucket(lbl, x => E.ageBucket(days(x.opened, T)) === lbl), d.age[lbl]);
  rec('DASH', 'agingTie', 'Aging 合计 + Legal/Bankruptcy/Deceased = Total Outstanding', '口径勾稽', d.total, r2(Object.values(d.dpd).reduce((a, v) => a.add(v), ZERO).add(d.special)));
  rec('DASH', 'active', 'active 案件数（不含终态、不含 Fully Paid）', 'count', all.filter(x => !TERMINAL.includes(x.status) && x.status !== 'fully_paid').length, d.active);
  rec('DASH', 'legal', 'legal 案件数', 'count', all.filter(x => x.status === 'legal').length, d.legal);
  rec('DASH', 'opened', '今日新开', 'count(开案 MYT 日期 = 今天)', all.filter(x => x.opened === T).length, d.opened);
  rec('DASH', 'closed', '今日结案（含自动 Fully Paid，D-09）', '今天开案且独立账本已还清（精确余额 ≤ 0.005）的案件数', all.filter(x => x.opened === T && x.exact.cmp('0.005') <= 0 && x.paidAny).length, d.closed);
  const paysAll = C.qa('SELECT p.amount, p.payment_date, p.agent_id, c.status FROM payments p JOIN cases c ON c.id = p.case_id');
  const today = paysAll.filter(p => d10(p.payment_date) === T);
  rec('DASH', 'collected', 'Collected Today / 笔数', 'Σ 今天日期的还款', `${E.sum2(today.map(p => String(p.amount)))}/${today.length}`, `${d.collectedToday}/${d.paymentsToday}`);
  const ptps = C.qa('SELECT status, due_date FROM ptps');
  rec('DASH', 'ptp', 'PTP due / overdue / broken', 'pending 今天到期 / pending 已过期 / broken（partially_kept 不计入）',
    `${ptps.filter(p => p.status === 'pending' && p.due_date === T).length}/${ptps.filter(p => p.status === 'pending' && p.due_date < T).length}/${ptps.filter(p => p.status === 'broken').length}`, `${d.ptpDue}/${d.ptpOverdue}/${d.ptpBroken}`);
  const agents = C.qa('SELECT id, name, commission_rate FROM agents');
  const byAgent = (id, f = () => true) => E.sum2(paysAll.filter(p => p.agent_id === id && f(p)).map(p => String(p.amount)));
  const board = agents.map(a => [a.name, byAgent(a.id)]).sort((a, b) => F.of(b[1]).cmp(a[1])).slice(0, 5);
  rec('DASH', 'board', 'Agent Leaderboard 前 5（累计，按 payments.agent_id）', 'Σ 每位催收员名下还款', board.map(b => b.join(':')).join(', '), d.board.map(b => b.join(':')).join(', '));

  // ---------- reports + CSV ----------
  const rp = await C.reports(s);
  const statuses = [...new Set(all.map(x => x.status))];
  for (const st of statuses) {
    const row = rp.byStatus.find(r => r.status === LABEL[st]);
    rec('RPT', `status.${st}`, `Outstanding by Status：${LABEL[st]}`, 'count / Σ 独立今日结清额 / Σ 独立合同欠款', `${all.filter(x => x.status === st).length}/${setIf(x => x.status === st)}/${sumIf(x => x.status === st)}`, row ? `${row.cnt}/${row.total}/${row.contract}` : 'n/a');
  }
  rec('RPT', 'foot', 'Outstanding by Status 合计', 'Σ 全部案件：count / 今日结清额 / 合同欠款', `${all.length}/${setIf(() => true)}/${sumIf(() => true)}`, `${rp.footCnt}/${rp.footTotal}/${rp.footContract}`);
  const closedCancelled = rp.byStatus.filter(r => ['Closed', 'Cancelled'].includes(r.status)).reduce((a, r) => a.add(r.total), ZERO);
  rec('RPT', 'dashTie', 'DASH-05：Reports 合计 − Closed − Cancelled = 仪表盘 Total Outstanding', '勾稽', d.total, r2(F.of(rp.footTotal).sub(closedCancelled)));
  const obs = await C.csv(s, '/reports?export=outstanding');
  rec('CSV', 'obs', 'outstanding-by-status.csv = Reports 表', '逐行', rp.byStatus.map(r => `${r.status}:${r.cnt}:${Number(r.total)}:${Number(r.contract)}`).join(','), obs.rows.map(r => `${r[0]}:${r[1]}:${r[2]}:${r[3]}`).join(','));
  // cases.csv (G-23): Case No, Debtor, Debtor Phone, Agent, Settlement Today, Overdue, DPD, Contract Balance, Paid, Priority, Status, Opened
  const cc = await C.csv(s, '/cases?format=csv');
  rec('CSV', 'cases.settle', 'cases.csv Σ Settlement Today', 'Σ 独立今日结清额（全部案件）', setIf(() => true), E.sum2(cc.rows.map(r => r[4])));
  rec('CSV', 'cases.out', 'cases.csv Σ Contract Balance', 'Σ 独立合同欠款（全部案件）', sumIf(() => true), E.sum2(cc.rows.map(r => r[7])));
  rec('CSV', 'cases.paid', 'cases.csv Σ Paid', 'Σ 全部已入账还款', E.sum2(paysAll.map(p => String(p.amount))), E.sum2(cc.rows.map(r => r[8])));
  const byNo = Object.fromEntries(all.map(x => [x.case_no, x]));
  const rowBad = cc.rows.filter(r => { const x = byNo[r[0]]; return !x || r2(F.of(r[4])) !== x.settlement || (r[5] === '' ? null : r2(F.of(r[5]))) !== x.overdue || (r[6] === '' ? null : Number(r[6])) !== x.dpd; });
  chk('CSV', 'cases.rows', `cases.csv 逐行 Settlement Today / Overdue / DPD = 独立计算（${cc.rows.length} 行，G-23）`, '0 行不一致', rowBad.length === 0, rowBad.slice(0, 5).map(r => `${r[0]} ${r[4]}/${r[5]}/${r[6]} vs ${byNo[r[0]] ? [byNo[r[0]].settlement, byNo[r[0]].overdue, byNo[r[0]].dpd].join('/') : '?'}`).join('; ') || '全部一致');
  // cases-detailed.csv: Case No, Debtor, Agent, Principal, Interest, Paid, Settlement Today, Overdue, DPD, Contract Balance, Status, Opened
  const det = await C.csv(s, '/reports?export=cases');
  rec('CSV', 'det.settle', 'cases-detailed.csv Σ Settlement Today', '同上', setIf(() => true), E.sum2(det.rows.map(r => r[6])));
  rec('CSV', 'det.out', 'cases-detailed.csv Σ Contract Balance', 'Σ 独立合同欠款', sumIf(() => true), E.sum2(det.rows.map(r => r[9])));
  const bad = det.rows.filter(r => r2(F.of(r[3]).add(r[4]).sub(r[5])) !== r2(F.of(r[9])));
  chk('CSV', 'det.ident', `cases-detailed.csv 逐行 Principal + Interest − Paid = Contract Balance（${det.rows.length} 行）`, '0 行不平', bad.length === 0,
    `${bad.length} 行不平：${bad.map(r => `${r[0]} ${r[3]}+${r[4]}−${r[5]}≠${r[9]}`).join('; ')}`);
  const fmtBad = det.rows.filter(r => [3, 4, 5, 6, 7, 9].some(i => /\.\d{3,}/.test(r[i])));
  chk('CSV', 'det.2dp', 'cases-detailed.csv 金额最多 2 位小数（RPT-06）', '0 个单元格超过 2 位小数', fmtBad.length === 0, fmtBad.map(r => r[0]).join(',') || '全部 ≤ 2 位');

  // ---------- commissions / reports perf / agents (this month) ----------
  const month = T.slice(0, 7);
  const com = await C.commissions(s, month);
  const perfCsv = await C.csv(s, '/reports?export=performance');
  const ag = await C.agentsList(s);
  const settled = C.qa('SELECT agent_id, SUM(amount) s FROM commission_settlements WHERE period=? GROUP BY agent_id', month);
  for (const a of agents) {
    const coll = byAgent(a.id, p => d10(p.payment_date).slice(0, 7) === month);
    const earned = commission(coll, a.commission_rate);
    const set = (settled.find(x => x.agent_id === a.id) || { s: 0 }).s;
    const row = com.find(x => x.name === a.name), pr = rp.perf.find(x => x.name === a.name), pc = perfCsv.rows.find(x => x[0] === a.name), al = ag.find(x => x.name === a.name);
    rec('COM', `${a.name}.com`, `Commissions ${month}：${a.name} Collected/Earned/Pending`, `Σ 本月 payments.agent_id；× ${a.commission_rate}%；− 已结算 ${set}`, `${coll}/${earned}/${r2(F.of(earned).sub(String(set)))}`, row ? `${row.collected}/${row.earned}/${row.pending}` : 'n/a');
    rec('COM', `${a.name}.rpt`, `Reports 本月业绩 = Commissions：${a.name}`, '同一口径', `${coll}/${earned}`, pr ? `${pr.collected}/${pr.commission}` : 'n/a');
    rec('COM', `${a.name}.csv`, `agent-performance.csv：${a.name}`, '同一口径（数值）', `${Number(coll)}/${Number(earned)}`, pc ? `${pc[1]}/${pc[3]}` : 'n/a');
    rec('COM', `${a.name}.agents`, `Agents 页累计 Collected/Commission：${a.name}`, 'Σ 全部 payments.agent_id', `${byAgent(a.id)}/${commission(byAgent(a.id), a.commission_rate)}`, al ? `${al.collected}/${al.commission}` : 'n/a');
  }

  // ---------- demo data (B-03 / F-11) ----------
  const demo5 = C.q1('SELECT amount, payment_date FROM payments WHERE case_id=5');
  const ptp5 = C.q1("SELECT amount, status FROM ptps WHERE case_id=5");
  rec('DEMO', 'case5', '演示案件 5：fulfilled PTP 金额 = 实收', 'B-03', `${demo5.amount}/fulfilled`, `${ptp5.amount}/${ptp5.status}`);
  const tl5 = C.q1("SELECT content FROM timeline_events WHERE case_id=5 AND event_type='ptp_fulfilled'");
  chk('DEMO', 'case5.tl', '演示案件 5 时间线 PTP 日期不带时分秒', '“PTP RM … due YYYY-MM-DD”', /due \d{4}-\d{2}-\d{2}$/.test(tl5.content), tl5.content);
  const v14 = await C.caseView(s, 14);
  chk('DEMO', 'case14', '演示案件 14（10 天前重组，未还款）：重组后即显示逾期', '记录现状', true, `DPD ${v14.dpd}（${v14.dpdText}）；Overdue ${v14.overdue}；首行 ${v14.schedule[0] && [v14.schedule[0].due, v14.schedule[0].kind, v14.schedule[0].expected, v14.schedule[0].status].join('|')}`);
  results[results.length - 1].result = 'INFO';

  // ---------- agent scope (D-12) — numbers only ----------
  const s1 = await C.login('agent1', 'agent123');
  const d1 = await C.dashboard(s1);
  const mine = all.filter((x, i) => x.agent === 1);
  rec('DASH', 'agent1', 'agent1 的仪表盘 Total Outstanding（只含名下案件，今日结清额）', 'Σ agent_id=1 且非 Closed/Cancelled', mine.filter(x => !['closed', 'cancelled'].includes(x.status)).reduce((a, x) => a.add(x.settlement), ZERO).r2(), d1.total);
}

function report() {
  const out = path.join(C.DB_PATH, '..');
  fs.writeFileSync(path.join(out, 'calc-r2-recon.json'), JSON.stringify(results, null, 1));
  const esc = x => String(x).replace(/\|/g, '/').replace(/\n/g, ' ');
  const lines = [`# calc-r2 recon ${T}`, '', '| ID | 场景 | 算式 | 预期 | 实际 | 结果 | 备注 |', '|---|---|---|---|---|---|---|',
    ...results.map(r => `| ${r.g}#${esc(r.id)} | ${esc(r.scenario)} | ${esc(r.formula)} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.result} | ${esc(r.note)} |`)];
  fs.writeFileSync(path.join(out, 'calc-r2-recon.md'), lines.join('\n'));
  const tot = results.filter(r => r.result !== 'INFO');
  console.log(`recon items ${tot.length}, pass ${tot.filter(r => r.result === 'PASS').length}, fail ${tot.filter(r => r.result === 'FAIL').length}`);
  for (const r of results.filter(x => x.result === 'FAIL')) console.log('FAIL', `${r.g}#${r.id}`, '|', r.scenario, '| exp', r.expected, '| act', r.actual, '|', r.note);
}
main().then(report, e => { report(); console.error(e); process.exit(1); });
