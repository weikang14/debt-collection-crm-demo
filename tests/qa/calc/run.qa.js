// Role 2 (business manager) — end-to-end calculation comparison.
// Usage (server must already run on 3302 with CRM_DB_PATH=data/qa/business.db):
//   node tests/qa/calc/run.qa.js
// Writes data/qa/calc-results.json and prints markdown tables.
// Expected values come ONLY from ./expected.qa.js (independent rules); actual values
// come from the running system (HTML pages / CSV) and read-only SQLite cache columns.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const X = require('./expected.qa.js');
const { Client, parseCase, parseCsv, txt, num, m1 } = require('./client.qa.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const DBP = path.join(ROOT, 'data', 'qa', 'business.db');
const ro = new DatabaseSync(DBP, { readOnly: true });
const q = (sql, ...p) => ro.prepare(sql).all(...p);
const q1 = (sql, ...p) => ro.prepare(sql).get(...p);
const TODAY = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);

const results = [];
const f2 = (v) => (v == null || Number.isNaN(v) ? String(v) : typeof v === 'number' ? v.toFixed(2) : String(v));
function check(sec, scen, formula, expected, actual, o = {}) {
  const e = f2(expected), a = f2(actual);
  const pass = o.pass !== undefined ? o.pass : e === a;
  results.push({ sec, id: `${sec}#${String(results.filter((r) => r.sec === sec).length + 1).padStart(2, '0')}`, scen, formula, expected: e, actual: a, pass, note: o.note || '' });
}

const admin = new Client();
const tracked = []; // every payment the system accepted: {cid, date, amount}
let debtorId, agentA, agentB;

async function mkCase(f) {
  const r = await admin.post('/cases', { debtor_id: debtorId, agent_id: f.agent_id || '', principal_amount: f.principal, interest_mode: f.mode || 'fixed',
    interest_rate: f.rate ?? '', interest_amount: f.lump ?? '', loan_start_date: f.start || '', tenure: f.tenure || '', priority: 'medium', status: f.status || 'assigned', remark: f.label || '' });
  const id = Number(m1(/\/cases\/(\d+)/, r.location)); if (!id) throw new Error('case create failed ' + JSON.stringify(r)); return id;
}
async function page(cid) { return parseCase((await admin.get('/cases/' + cid)).body); }
async function pay(cid, date, amount, extra = {}) {
  const r = await admin.post(`/cases/${cid}/payments`, { payment_date: date, amount: String(amount), method: 'bank_transfer', reference: '', bank: '', ...extra });
  if (r.ok) tracked.push({ cid, date, amount: Number(amount), receipt: (r.ok.match(/RCPT-\S+/) || [])[0] });
  return r;
}
const lastPayId = (cid) => q1('SELECT id FROM payments WHERE case_id=? ORDER BY id DESC LIMIT 1', cid).id;
async function voidPay(cid, pid) { const p = q1('SELECT * FROM payments WHERE id=?', pid); const r = await admin.post(`/cases/${cid}/payments/${pid}/void`, {});
  if (r.ok) { const i = tracked.findIndex((t) => t.receipt === p.receipt_no && t.cid === cid); if (i >= 0) tracked.splice(i, 1); } return r; }
const restructure = (cid, b) => admin.post(`/cases/${cid}/restructures`, { reason: 'QA business test', ...b });
const loanOf = (f) => ({ principal: f.principal, mode: f.mode || 'fixed', rate: f.rate || 0, lump: f.lump || 0, start: f.start, maturity: f.start && f.tenure ? X.addMonths(f.start, f.tenure) : null });
const paysOf = (cid) => tracked.filter((t) => t.cid === cid).map((t) => ({ date: t.date, amount: t.amount }));
const cache = (cid) => q1('SELECT outstanding_amount o, interest_charged i, status s FROM cases WHERE id=?', cid);

function schedCompare(sec, label, exp, act) {
  check(sec, `${label}: 计划行数`, '期数(+挂账行)', String(exp.length), String(act.length));
  exp.forEach((e, i) => { const a = act[i] || {};
    check(sec, `${label}: 第${i + 1}行 ${e.kind === 'arrears' ? '挂账 ' : ''}${e.due}`, `到期日/应还/已还/未还/状态`,
      `${e.due} | ${e.expected} | ${e.paid} | ${e.outstanding} | ${e.status}`,
      `${a.due} | ${f2(a.expected)} | ${f2(a.paid)} | ${f2(a.outstanding)} | ${a.status}`); });
}

async function main() {
  await admin.login('admin', 'admin123');
  // ---------- fixtures ----------
  await admin.post('/debtors', { name: 'QA 业务计算专用', phone: '010-0000000', risk_level: 'medium' });
  debtorId = q1("SELECT max(id) id FROM debtors WHERE name='QA 业务计算专用'").id;
  await admin.post('/agents', { name: 'QA Agent A', department: 'QA', target_amount: '10000', commission_rate: '5', active: '1' });
  await admin.post('/agents', { name: 'QA Agent B', department: 'QA', target_amount: '0', commission_rate: '7.5', active: '1' });
  agentA = q1("SELECT id FROM agents WHERE name='QA Agent A'").id; agentB = q1("SELECT id FROM agents WHERE name='QA Agent B'").id;
  q('SELECT case_id cid, payment_date date, amount, receipt_no receipt FROM payments').forEach((p) => tracked.push({ cid: p.cid, date: p.date.slice(0, 10), amount: p.amount, receipt: p.receipt }));

  // ================= S1 计息与余额（手册 5.1–5.7） =================
  const S = 'INT';
  const fx = { principal: 1000, lump: 200, label: 'INT-03' };
  const cFx = await mkCase(fx); let p = await page(cFx); let e = X.ledger(loanOf(fx), []);
  check(S, 'Fixed 本金1,000 利息200（INT-03）', '1000+200', e.outstanding, p.outstanding);

  const A = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-01-01', tenure: 12, label: 'INT-04 示例A' };
  const cA = await mkCase(A); p = await page(cA); e = X.ledger(loanOf(A), []);
  check(S, 'Monthly 10,000×1.5%/月 2026-01-01 12个月：利息', '10000×1.5%÷30×365', e.interest, p.interest);
  check(S, '同上：Total Outstanding', '10000+1825', e.outstanding, p.outstanding);
  check(S, '同上：到期日', '2026-01-01+12个月', X.addMonths(A.start, 12), p.maturity);
  check(S, '同上：Record Payment 弹窗 max', '= Total Outstanding', e.outstanding, p.payMax);
  check(S, '同上：建案后 DB 缓存 outstanding_amount（打开详情后）', '应与页面一致', e.outstanding, cache(cA).o);

  const D = { principal: 36500, mode: 'daily', rate: 18, start: '2026-01-01', tenure: 12, label: 'INT-05' };
  const cD = await mkCase(D); p = await page(cD); e = X.ledger(loanOf(D), []);
  check(S, 'Annual 36,500×18%/年 12个月（INT-05）', '36500×18%÷365×365=6570', e.outstanding, p.outstanding);

  let r = await pay(cA, '2026-03-02', 1000); p = await page(cA); e = X.ledger(loanOf(A), paysOf(cA));
  check(S, '示例A 2026-03-02 还1,000（INT-06）：Outstanding', '先冲60天利息300，700冲本金；9300×0.0005×305', e.outstanding, p.outstanding);
  check(S, '同上：总利息', '300+1418.25', e.interest, p.interest);
  check(S, '同上：Paid', 'Σpayments', e.paid, p.paid);
  check(S, '同上：x% recovered', 'round(1000÷(10000+1718.25)×100)', String(Math.round(1000 / 11718.25 * 100)), String(p.recoveredPct));
  check(S, '同上：PAY-15 降幅', '11825−10718.25', '1106.75', (11825 - p.outstanding).toFixed(2));

  const T7 = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-01-31', tenure: 1, label: 'CASE-07' };
  const c7 = await mkCase(T7); p = await page(c7); e = X.ledger(loanOf(T7), []);
  check(S, '起始 2026-01-31 期限1个月（CASE-07）：到期日', '月末对齐', '2026-02-28', p.maturity);
  check(S, '同上：利息（28天）', '10000×0.0005×28', e.interest, p.interest);

  // 无到期日：计到今天
  const N = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-10-01', label: '无期限' };
  const cN = await mkCase(N); p = await page(cN); e = X.ledger(loanOf(N), [], { today: TODAY });
  check(S, `无期限 Monthly 起始 2026-10-01：利息计到今天 ${TODAY}`, `10000×0.0005×${X.days(N.start, TODAY)}天`, e.interest, p.interest);
  const N0 = { principal: 5000, mode: 'monthly', rate: 1.5, start: TODAY, label: 'INT-07' };
  const cN0 = await mkCase(N0); p = await page(cN0);
  check(S, '起始日=今天、无期限（INT-07）：当天利息', '0 天', '0.00', p.interest);

  // ================= S2 还款计划（SCH） =================
  const SC = 'SCH';
  const C = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-01-01', tenure: 3, label: 'SCH-03 示例C' };
  const cC = await mkCase(C); p = await page(cC);
  schedCompare(SC, '示例C Monthly 3期', X.schedule(C, [], { today: TODAY }), p.schedule);
  check(SC, '示例C：Outstanding（90天）', '10000+10000×0.0005×90', X.ledger(loanOf(C), []).outstanding, p.outstanding);

  const D4 = { principal: 1000, lump: 0, start: '2026-01-31', tenure: 3, label: 'SCH-02/04' };
  const c4 = await mkCase(D4); p = await page(c4);
  schedCompare(SC, 'Fixed 1,000/3期 起始01-31（SCH-02/04）', X.schedule(D4, [], { today: TODAY }), p.schedule);

  const D5 = { principal: 10000, lump: 1200, start: '2026-01-01', tenure: 12, label: 'SCH-05' };
  const c5 = await mkCase(D5); await pay(c5, TODAY, 2000); p = await page(c5);
  schedCompare(SC, 'Fixed 10,000+1,200/12期 还2,000（SCH-05）', X.schedule(D5, paysOf(c5), { today: TODAY }), p.schedule);
  const firstOpen = p.schedule.find((x) => x.outstanding > 0);
  check(SC, 'SCH-07 Pay 预填（最早未还期）', 'min(该期未还, 案件欠款)', '799.99', firstOpen && firstOpen.pay);
  check(SC, 'SCH-07 只有一行有 Pay', '仅最早未还期', '1', String(p.schedule.filter((x) => x.pay != null).length));

  // 计息模式：提前部分还本后计划 vs 账面（已知延后：按提前还款自动重算计划）
  p = await page(cA);
  const schedSum = p.schedule.reduce((s, x) => s + x.outstanding, 0);
  check(SC, '示例A 提前还本后：计划未还合计 vs 账面 Outstanding', '计划未改按新本金重算', p.outstanding.toFixed(2), schedSum.toFixed(2), { note: '已知延后：按提前还款自动重算计划' });

  // ================= S3 边界：闰年 / 月末 =================
  const B = 'EDGE';
  const L1 = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2027-12-01', tenure: 12, label: '闰年 monthly' };
  const cL1 = await mkCase(L1); p = await page(cL1); e = X.ledger(loanOf(L1), []);
  check(B, 'Monthly 2027-12-01 起 12个月（跨 2028-02-29，366天）：利息', '10000×0.0005×366', e.interest, p.interest);
  const febRow = X.schedule(L1, [], { today: TODAY }).find((x) => x.due === '2028-03-01');
  check(B, '同上：计划 2028-03-01 行（2月29天）', '10000×0.0005×29', febRow.expected, (p.schedule.find((x) => x.due === '2028-03-01') || {}).expected);
  const L2 = { principal: 36500, mode: 'daily', rate: 18, start: '2027-12-01', tenure: 12, label: '闰年 daily' };
  const cL2 = await mkCase(L2); p = await page(cL2); e = X.ledger(loanOf(L2), []);
  check(B, 'Annual 18% 36,500 跨闰年 366天：利息（÷365 不变）', '36500×18%÷365×366', e.interest, p.interest);
  const L3 = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2024-01-31', tenure: 1, label: '2024-01-31+1' };
  const cL3 = await mkCase(L3); p = await page(cL3);
  check(B, '起始 2024-01-31 +1个月 → 到期日', '闰年2月末', '2024-02-29', p.maturity);
  check(B, '同上：利息 29天', '10000×0.0005×29', X.ledger(loanOf(L3), []).interest, p.interest);
  const L4 = { principal: 36500, mode: 'daily', rate: 18, start: '2024-02-29', tenure: 12, label: '2/29 起' };
  const cL4 = await mkCase(L4); p = await page(cL4);
  check(B, '起始 2024-02-29 +12个月 → 到期日', '非闰年无2/29→2/28', '2025-02-28', p.maturity);
  schedCompare(B, '起始 2024-02-29 Annual 12期', X.schedule(L4, [], { today: TODAY }), p.schedule);
  check(B, '同上：利息（365天）', '36500×18%÷365×365', X.ledger(loanOf(L4), []).interest, p.interest);
  const L5 = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2028-02-29', tenure: 1, label: '2028-02-29+1' };
  const cL5 = await mkCase(L5); p = await page(cL5);
  check(B, '起始 2028-02-29 +1个月 → 到期日', '', '2028-03-29', p.maturity);
  const L6 = { principal: 3000, lump: 0, start: '2026-01-30', tenure: 3, label: '01-30 起' };
  const cL6 = await mkCase(L6); p = await page(cL6);
  check(B, '起始 2026-01-30 3期：到期日序列（不漂移）', '02-28, 03-30, 04-30', X.schedule(L6, [], { today: TODAY }).map((x) => x.due).join(', '), p.schedule.map((x) => x.due).join(', '));

  // ================= S4 四舍五入到分 =================
  const RD = 'ROUND';
  for (const [P, start, ten, why] of [[1470, '2026-01-01', 12, '1470×0.0005×365=268.275'], [2290, '2026-01-01', 1, '2290×0.0005×31=35.495'], [10, '2026-01-01', 1, '10×0.0005×31=0.155'], [1010, '2026-01-01', 1, '1010×0.0005×31=15.655']]) {
    const f = { principal: P, mode: 'monthly', rate: 1.5, start, tenure: ten, label: 'ROUND ' + P };
    const cid = await mkCase(f); p = await page(cid); e = X.ledger(loanOf(f), []);
    check(RD, `Monthly 1.5% 本金 ${P} ${ten}个月：利息（0.005 边界，四舍五入）`, why, e.interest, p.interest, { note: 'half-up' });
    check(RD, `同上：Total Outstanding`, `${P}+利息`, e.outstanding, p.outstanding);
    check(RD, `同上：页面恒等式 Principal+Interest = Outstanding`, '无还款时应恒等', (p.principal + p.interest).toFixed(2), p.outstanding);
  }
  const R3 = { principal: 10, mode: 'monthly', rate: 1.5, start: '2026-01-01', tenure: 3, label: 'ROUND sched' };
  const cR3 = await mkCase(R3); p = await page(cR3);
  const rsum = p.schedule.reduce((s, x) => s + x.expected, 0);
  check(RD, '本金10 Monthly 3期：计划应还合计 vs 账面欠款', '逐期四舍五入 vs 整体四舍五入', X.ledger(loanOf(R3), []).outstanding, rsum.toFixed(2), { note: '逐期取整造成计划比账面多 1 分' });
  check(RD, '同上：最后一期 Pay 预填被封顶为账面欠款', 'min(行未还, 欠款)', X.ledger(loanOf(R3), []).outstanding, null, { pass: true, note: '封顶逻辑见 show.ejs:116-119，此处只核对差额' });
  results.pop();

  // ================= S5 还款金额校验（0、负、超额、sub-sen） =================
  const PV = 'PAYV';
  const fV = { principal: 100, lump: 0, label: 'PAY 校验' };
  const cV = await mkCase(fV);
  for (const [amt, exp] of [['0', 'Invalid amount'], ['-5', 'Invalid amount'], ['abc', 'Invalid amount'], ['100.01', 'Amount exceeds outstanding']]) {
    r = await pay(cV, TODAY, amt); check(PV, `还款金额 ${amt}`, '服务端校验', exp, r.err || r.ok);
  }
  r = await pay(cV, TODAY, '0.001');
  const stored = q1('SELECT amount, receipt_no FROM payments WHERE case_id=? ORDER BY id DESC LIMIT 1', cV);
  check(PV, '还款金额 0.001（不足 1 分）', '业务预期：拒绝（最小单位 sen）', 'rejected', r.err ? 'rejected' : `accepted ${stored.receipt_no} amount=${stored.amount}`);
  p = await page(cV);
  check(PV, '同上：页面 Payments 显示金额', '0.001 显示为', '0.00', (p.payments[0] || {}).amount, { note: '产生一张 RM 0.00 的收据' });
  const cV2 = await mkCase({ principal: 100, lump: 0, label: 'PAY 0.004 容差' });
  r = await pay(cV2, TODAY, '100.004'); p = await page(cV2);
  check(PV, '欠款100.00 还 100.004（容差 0.005 内）', '业务预期：拒绝或按 100.00 入账', 'rejected/100.00', r.err ? 'rejected' : `accepted, stored ${q1('SELECT amount FROM payments WHERE case_id=?', cV2).amount}`);
  check(PV, '同上：Outstanding / 状态', '', '0.00 Fully Paid', `${f2(p.outstanding)} ${p.status}`);

  const cNeg = await mkCase({ principal: 1000, lump: -100, label: '负利息' }); p = await page(cNeg);
  check(PV, 'Fixed 利息填 -100 建案', '业务预期：拒绝负利息', 'rejected', `accepted, Outstanding ${f2(p.outstanding)}`, { pass: false });
  const cHi = await mkCase({ principal: 10000, mode: 'monthly', rate: 10, start: '2026-01-01', tenure: 12, label: '高利率' }); p = await page(cHi);
  check(PV, 'Monthly 10%/月 建案（年化 121.67%）', '业务预期：超出放贷人法定上限应拦截/警示（待确认）', 'rejected/warned', `accepted, Interest ${f2(p.interest)}`, { pass: false });

  // ================= S6 冲销顺序（先息后本） =================
  const AL = 'ALLOC';
  const fP = { ...A, label: '部分还款<利息' };
  const cP = await mkCase(fP); await pay(cP, '2026-03-02', 200); p = await page(cP); e = X.ledger(loanOf(fP), paysOf(cP));
  check(AL, '还款200 < 已计利息300：全部冲利息，剩余利息不复利', '300−200=100 挂着；10000×0.0005×305=1525', e.outstanding, p.outstanding);
  check(AL, '同上：总利息不变（不复利）', '1825', e.interest, p.interest);
  const fO = { ...A, label: '乱序录入' };
  const cO = await mkCase(fO); await pay(cO, '2026-05-01', 500); await pay(cO, '2026-03-02', 1000); p = await page(cO); e = X.ledger(loanOf(fO), paysOf(cO));
  check(AL, '先录 05-01 还500、后补录 03-02 还1,000：按日期重排', '与按时间顺序录入结果相同', e.outstanding, p.outstanding);
  const fM = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-01-01', tenure: 3, label: '到期后还款' };
  const cM = await mkCase(fM); await pay(cM, '2026-10-01', 500); p = await page(cM); e = X.ledger(loanOf(fM), paysOf(cM));
  check(AL, '到期(04-01)后 10-01 还500：利息封顶在到期日', '450 利息封顶；500 先冲450，50 冲本金', e.outstanding, p.outstanding);
  const fB = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-06-01', tenure: 12, label: '起息前还款' };
  const cB = await mkCase(fB); r = await pay(cB, '2026-05-01', 1000); p = await page(cB); e = X.ledger(loanOf(fB), paysOf(cB));
  check(AL, '起息日(06-01)之前的还款(05-01)', '业务预期：拒绝；系统按全额冲本金', 'rejected', r.err ? 'rejected' : `accepted, Outstanding ${f2(p.outstanding)} (本规则计算 ${e.outstanding})`);
  const fF = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-10-01', label: '未来日期还款' };
  const cF = await mkCase(fF); p = await page(cF); const before = p.outstanding;
  r = await pay(cF, '2026-12-31', 100); p = await page(cF);
  const eToday = X.ledger(loanOf(fF), [], { today: TODAY });
  check(AL, '无期限案件，记一笔未来日期 2026-12-31 的还款 100', `业务预期：拒绝；若接受应为 ${before.toFixed(2)}−100`, X.F.of(eToday.outstanding).sub(100).r2(), p.outstanding,
    { note: r.err ? 'rejected' : `系统接受（${r.ok}）；利息被计到 2026-12-31` });
  const futureInterest = X.ledger(loanOf(fF), [{ date: '2026-12-31', amount: 100 }], { today: '2026-12-31' });
  check(AL, '同上：系统利息 vs 计到 2026-12-31 的利息', '10000×0.0005×91=455', futureInterest.interest, p.interest, { note: '证明系统把利息算到了未来还款日' });

  // ================= S7 提前结清 =================
  const ES = 'EARLY';
  const fE = { ...A, label: '提前结清 max' };
  const cE = await mkCase(fE); p = await page(cE);
  const payoff = X.payoffAsOf(loanOf(fE), [], '2026-03-02');
  check(ES, '2026-03-02 结清所需金额（利息计到当天）', '10000 + 10000×0.0005×60', payoff.outstanding, '（系统无此显示）', { pass: false, note: '系统只显示到期总额 11,825.00' });
  r = await pay(cE, '2026-03-02', p.payMax); p = await page(cE); e = X.ledger(loanOf(fE), paysOf(cE));
  check(ES, '按弹窗 max 11,825.00 于 2026-03-02 还款：是否接受', '业务预期：只应收 10,300.00', 'reject or cap 10300.00', r.ok ? `accepted ${r.ok}` : r.err);
  check(ES, '同上：Outstanding', '', '0.00', p.outstanding);
  check(ES, '同上：Interest 显示', '只计到 03-02', e.interest, p.interest);
  check(ES, '同上：多收金额（Paid − 本金 − 利息）', '11825 − 10000 − 300', e.excess, (p.paid - p.principal - p.interest).toFixed(2), { pass: false, note: '超额 1,525.00 被静默丢弃，无退款/挂账记录' });
  check(ES, '同上：x% recovered', '11825÷10300', String(Math.round(11825 / 10300 * 100)), String(p.recoveredPct));
  check(ES, '同上：状态', '', 'Fully Paid', p.status);
  const fE2 = { ...A, label: '提前结清 正确金额' };
  const cE2 = await mkCase(fE2); await pay(cE2, '2026-03-02', payoff.outstanding); p = await page(cE2);
  check(ES, '于 2026-03-02 还 10,300.00：结清', '', '0.00 Fully Paid', `${f2(p.outstanding)} ${p.status}`);
  check(ES, '同上：计划全部 Paid', '', 'all Paid', p.schedule.every((x) => x.status === 'Paid' && x.outstanding === 0) ? 'all Paid' : 'not');
  const fE3 = { principal: 10000, lump: 1200, start: '2026-09-01', tenure: 12, label: 'Fixed 提前结清' };
  const cE3 = await mkCase(fE3); p = await page(cE3);
  check(ES, 'Fixed 10,000+1,200 12期，第2个月提前结清所需', '固定利息一次性全额计入，无提前还款回扣', '11200.00', p.payMax, { note: '业务待确认：合同是否约定 rebate' });

  // ================= S8 重组 =================
  const RS = 'RS';
  r = await restructure(cA, { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18' });
  const rsA = [{ effective: '2026-04-01', mode: 'monthly', rate: 1.2, maturity: X.addMonths('2026-04-01', 18) }];
  p = await page(cA); e = X.ledger(loanOf(A), paysOf(cA), { restructures: rsA });
  check(RS, '示例B 2026-04-01 重组 1.2%/月 18个月：结果', '', 'Restructured', r.ok || r.err);
  check(RS, '示例B：截点本金', '10000−700', e.cuts[0].principal, num(m1(/Principal at cut RM ([\d,.]+)/, p.history[0] ? p.history[0].cut : '')));
  check(RS, '示例B：挂账欠息', '9300×0.0005×30', e.cuts[0].arrears, num(m1(/Arrears carried RM ([\d,.]+)/, p.history[0] ? p.history[0].cut : '')));
  check(RS, '示例B：Total Outstanding', '9300+139.50+9300×0.0004×548', e.outstanding, p.outstanding);
  check(RS, '示例B：总利息', '300+139.50+2038.56', e.interest, p.interest);
  check(RS, '示例B：新到期日', '2026-04-01+18个月', '2027-10-01', p.maturity);
  schedCompare(RS, '示例B 新计划', X.schedule({ principal: 9300, mode: 'monthly', rate: 1.2, start: '2026-04-01', tenure: 18 }, paysOf(cA).filter((x) => x.date >= '2026-04-01'), { today: TODAY, arrears: e.cuts[0].arrears }), p.schedule);
  check(RS, '示例B：旧还款锁定', '03-02 的还款显示 Locked', 'true', String(p.payments.every((x) => x.locked)));
  r = await pay(cA, '2026-03-15', 50);
  check(RS, '生效日前的还款日期 03-15', 'RS-13', 'Payment date must be on or after the restructure date (2026-04-01)', r.err || r.ok);
  await pay(cA, '2026-05-01', 500); p = await page(cA); e = X.ledger(loanOf(A), paysOf(cA), { restructures: rsA });
  check(RS, '重组后 05-01 还500：先冲挂账+新息 251.10，余冲本金', '139.50+9300×0.0004×30', e.outstanding, p.outstanding);
  schedCompare(RS, '重组后还500 计划 FIFO（挂账行优先）', X.schedule({ principal: 9300, mode: 'monthly', rate: 1.2, start: '2026-04-01', tenure: 18 }, paysOf(cA).filter((x) => x.date >= '2026-04-01'), { today: TODAY, arrears: e.cuts[0].arrears }).slice(0, 5), p.schedule.slice(0, 5));
  const rid = q1('SELECT id FROM case_restructures WHERE case_id=? ORDER BY id DESC', cA).id;
  r = await admin.post(`/cases/${cA}/restructures/${rid}/undo`, {});
  check(RS, '生效日后有还款时撤销（RS-16）', '', 'Payments exist on or after the effective date; void them first', r.err || r.ok);
  await voidPay(cA, lastPayId(cA)); r = await admin.post(`/cases/${cA}/restructures/${rid}/undo`, {}); p = await page(cA);
  check(RS, '作废 05-01 还款后撤销：欠款回到示例A', 'E2E-03', X.ledger(loanOf(A), paysOf(cA)).outstanding, p.outstanding, { note: r.ok || r.err });

  // 已到期贷款重组（RS-21）
  const fMat = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2025-01-01', tenure: 6, label: 'RS-21' };
  const cMat = await mkCase(fMat); p = await page(cMat);
  check(RS, '2025-01-01 起 6个月（到期 2025-07-01，181天）：欠款', '10000+10000×0.0005×181', X.ledger(loanOf(fMat), []).outstanding, p.outstanding);
  r = await restructure(cMat, { effective_date: TODAY, interest_mode: 'monthly', interest_rate: '1', tenure: '12' });
  const rsM = [{ effective: TODAY, mode: 'monthly', rate: 1, maturity: X.addMonths(TODAY, 12) }];
  p = await page(cMat); e = X.ledger(loanOf(fMat), [], { restructures: rsM });
  check(RS, '已到期贷款今天重组：挂账欠息只计到原到期日', '905.00', e.cuts[0].arrears, num(m1(/Arrears carried RM ([\d,.]+)/, p.history[0] ? p.history[0].cut : '')));
  check(RS, '同上：重组后 Outstanding', `10000+905+10000×(1%÷30)×${X.days(TODAY, X.addMonths(TODAY, 12))}`, e.outstanding, p.outstanding);

  // 同日还款 + 重组
  const fSD = { ...A, label: '同日还款重组' };
  const cSD = await mkCase(fSD); await pay(cSD, '2026-06-01', 5000);
  r = await restructure(cSD, { effective_date: '2026-06-01', interest_mode: 'monthly', interest_rate: '1.5', tenure: '12' });
  const rsSD = [{ effective: '2026-06-01', mode: 'monthly', rate: 1.5, maturity: X.addMonths('2026-06-01', 12) }];
  p = await page(cSD); e = X.ledger(loanOf(fSD), paysOf(cSD), { restructures: rsSD });
  const truePrin = X.ledger(loanOf(fSD), paysOf(cSD), { asOf: '2026-06-01', today: '2026-06-01' });
  check(RS, '06-01 还5,000 后以 06-01 为生效日重组：截点本金（业务预期含当天还款）', '10000−(5000−755)', truePrin.principalRemaining, num(m1(/Principal at cut RM ([\d,.]+)/, p.history[0] ? p.history[0].cut : '')), { note: r.ok || r.err });
  check(RS, '同上：账面 Outstanding（账本本身正确）', '', e.outstanding, p.outstanding);
  const sdSum = p.schedule.reduce((s, x) => s + x.outstanding, 0);
  check(RS, '同上：新计划未还合计 vs 账面 Outstanding', '计划按截点本金 10,000 推算', e.outstanding, sdSum.toFixed(2));

  // 两次重组 + Fixed（RS-17/18）
  const fT = { ...A, label: '两次重组' };
  const cT = await mkCase(fT); await pay(cT, '2026-03-02', 1000);
  await restructure(cT, { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18' });
  r = await restructure(cT, { effective_date: '2026-06-01', interest_mode: 'fixed', interest_amount: '500', tenure: '12' });
  const rsT = [{ effective: '2026-04-01', mode: 'monthly', rate: 1.2, maturity: X.addMonths('2026-04-01', 18) }, { effective: '2026-06-01', mode: 'fixed', lump: 500, maturity: X.addMonths('2026-06-01', 12) }];
  p = await page(cT); e = X.ledger(loanOf(fT), paysOf(cT), { restructures: rsT });
  check(RS, '第二次重组 06-01 Fixed 500 12期：挂账欠息', '139.50+9300×0.0004×61', e.cuts[1].arrears, num(m1(/Arrears carried RM ([\d,.]+)/, p.history[0] ? p.history[0].cut : '')), { note: r.ok || r.err });
  check(RS, '同上：Outstanding', '9300+366.42+500', e.outstanding, p.outstanding);
  schedCompare(RS, '同上：新计划（挂账行 + (9300+500)/12 等额）', X.schedule({ principal: 9300, lump: 500, mode: 'fixed', start: '2026-06-01', tenure: 12 }, [], { today: TODAY, arrears: e.cuts[1].arrears }), p.schedule);

  // ================= S9 PTP / 分期计划 =================
  const PT = 'PTP';
  const fPT = { principal: 5000, lump: 0, label: 'PTP 专用', agent_id: agentA };
  const cPT = await mkCase(fPT);
  r = await admin.post(`/cases/${cPT}/ptp-plans`, { total_amount: '1000', num_installments: '3', first_due_date: '2026-01-31' }); p = await page(cPT);
  let plan = p.ptps.filter((x) => x.inst.endsWith('/3'));
  check(PT, '分期 1,000/3期 首期 2026-01-31（示例E）：金额', 'floor 到分，末期吸收零头', X.splitEqual(1000, 3).join(' / '), plan.map((x) => f2(x.amount)).join(' / '));
  check(PT, '同上：到期日', '月末对齐', X.planDates('2026-01-31', 3).join(', '), plan.map((x) => x.due).join(', '));
  r = await admin.post(`/cases/${cPT}/ptp-plans`, { total_amount: '100', num_installments: '7', first_due_date: '2026-11-30' }); p = await page(cPT);
  plan = p.ptps.filter((x) => x.inst.endsWith('/7'));
  check(PT, '分期 100/7期：金额', '14.28×6 + 14.32', X.splitEqual(100, 7).join(' / '), plan.map((x) => f2(x.amount)).join(' / '));
  check(PT, '同上：到期日（11-30 起，2月对齐）', '', X.planDates('2026-11-30', 7).join(', '), plan.map((x) => x.due).join(', '));
  check(PT, '同上：合计', '=100.00', '100.00', plan.reduce((s, x) => s + x.amount, 0).toFixed(2));
  r = await admin.post(`/cases/${cPT}/ptp-plans`, { total_amount: '1000', num_installments: '3', first_due_date: '2024-01-31' }); p = await page(cPT);
  plan = p.ptps.filter((x) => x.inst.endsWith('/3') && x.due.startsWith('2024'));
  check(PT, '分期首期 2024-01-31（闰年）：到期日', '', X.planDates('2024-01-31', 3).join(', '), plan.map((x) => x.due).join(', '));
  r = await admin.post(`/cases/${cPT}/ptp-plans`, { total_amount: '0.01', num_installments: '2', first_due_date: '2026-11-01' });
  check(PT, '分期 0.01/2期（PTP-08）', '', 'Total too small for the number of installments', r.err || r.ok);
  r = await admin.post(`/cases/${cPT}/ptp-plans`, { total_amount: '300', num_installments: '3', first_due_date: '2026-02-30' }); p = await page(cPT);
  const bad = q('SELECT due_date FROM ptps WHERE case_id=? AND amount=100 ORDER BY id', cPT).map((x) => x.due_date);
  check(PT, '分期首期日期非法 2026-02-30', '业务预期：拒绝', 'rejected', r.err ? 'rejected' : `accepted; 生成到期日 ${bad.join(', ')}`);
  r = await admin.post(`/cases/${cPT}/ptps`, { amount: '100', due_date: '', remark: 'no date' });
  check(PT, '单笔 PTP 不填到期日', '业务预期：拒绝', 'rejected', r.err ? 'rejected' : `accepted (${r.ok})；到期日存为 '${(q1('SELECT due_date FROM ptps WHERE case_id=? ORDER BY id DESC', cPT) || {}).due_date}'`);
  r = await admin.post(`/cases/${cPT}/ptp-plans`, { total_amount: '5000', num_installments: '2', first_due_date: '2026-11-15' });
  const promised = q1("SELECT SUM(amount) s FROM ptps WHERE case_id=? AND status='pending'", cPT).s;
  check(PT, '同一案件多次建计划：pending 承诺合计 vs 欠款', '业务预期：承诺合计 ≤ 欠款', '≤ 5000.00', f2(promised), { pass: promised <= 5000.005 });
  const fPT2 = { principal: 2000, lump: 0, label: 'PTP 部分履行', agent_id: agentA };
  const cPT2 = await mkCase(fPT2);
  await admin.post(`/cases/${cPT2}/ptps`, { amount: '1000', due_date: TODAY, remark: 'today' });
  p = await page(cPT2); const ptpId = p.ptps[0].id;
  r = await admin.post(`/ptps/${ptpId}/fulfill`, { amount: '600', payment_date: TODAY, method: 'cash' });
  if (r.ok) tracked.push({ cid: cPT2, date: TODAY, amount: 600, receipt: q1('SELECT receipt_no r FROM payments WHERE case_id=? ORDER BY id DESC', cPT2).r });
  p = await page(cPT2);
  check(PT, 'PTP 1,000 只履行 600：PTP 状态', '业务预期：部分履行应区分', 'partial/pending 400', p.ptps[0].status);
  check(PT, '同上：时间线 ptp_fulfilled 金额', '应显示实收 600.00', 'PTP fulfilled (RM 600.00)', (p.timeline.find((x) => x.type === 'ptp_fulfilled') || {}).text);
  check(PT, '同上：Outstanding', '2000−600', '1400.00', p.outstanding);

  await admin.post(`/cases/${cPT2}/ptps`, { amount: '100', due_date: '2026-10-01', remark: 'overdue' });
  const ptpRaw = q('SELECT t.status, t.due_date FROM ptps t');
  const dashP = (await admin.get('/')).body;
  const kp = dashP.match(/(\d+) <small>due<\/small> · (\d+) <small>overdue<\/small> · (\d+) <small>broken<\/small>/);
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}/.test(d || '');
  check(PT, 'Dashboard PTP 指标 due / overdue / broken', 'pending 且到期=今天 / pending 且到期<今天 / broken',
    `${ptpRaw.filter((x) => x.status === 'pending' && String(x.due_date).slice(0, 10) === TODAY).length} / ${ptpRaw.filter((x) => x.status === 'pending' && isDate(x.due_date) && String(x.due_date).slice(0, 10) < TODAY).length} / ${ptpRaw.filter((x) => x.status === 'broken').length}`,
    kp ? `${kp[1]} / ${kp[2]} / ${kp[3]}` : null);
  const ghost = ptpRaw.filter((x) => x.status === 'pending' && !isDate(x.due_date)).length;
  check(PT, '无到期日的 pending PTP 是否出现在任何 PTP 指标中', '业务预期：不应存在此类 PTP', '0', String(ghost), { note: '空到期日的承诺既不算 due 也不算 overdue' });

  // ================= S10 编辑 / 作废 / 收据号 =================
  const ED = 'EDIT';
  const fEd = { principal: 1000, lump: 0, label: '编辑作废' };
  const cEd = await mkCase(fEd); await pay(cEd, TODAY, 300); await pay(cEd, TODAY, 200);
  const pidB = lastPayId(cEd);
  r = await admin.post(`/cases/${cEd}/payments/${pidB}`, { amount: '700.01', payment_date: TODAY, method: 'cash' });
  check(ED, '编辑第2笔为 700.01（上限=欠款500+原200）', 'PAY-09', 'Amount exceeds outstanding', r.err || r.ok);
  r = await admin.post(`/cases/${cEd}/payments/${pidB}`, { amount: '700', payment_date: TODAY, method: 'cash' });
  tracked.find((t) => t.cid === cEd && t.amount === 200).amount = 700; p = await page(cEd);
  check(ED, '编辑为 700：结清', '1000−300−700', '0.00 Fully Paid', `${f2(p.outstanding)} ${p.status}`);
  const recBefore = q1('SELECT receipt_no FROM payments WHERE id=?', pidB).receipt_no;
  await voidPay(cEd, pidB); await pay(cEd, TODAY, 100);
  const recAfter = q1('SELECT receipt_no FROM payments WHERE case_id=? ORDER BY id DESC', cEd).receipt_no;
  check(ED, `作废最新一笔 ${recBefore} 后再记一笔：收据号`, '业务预期：不复用（E-01）', `≠ ${recBefore}`, recAfter, { pass: recAfter !== recBefore });
  p = await page(cEd);
  check(ED, '作废后 Outstanding', '1000−300−100', '600.00', p.outstanding);

  // ================= S11 佣金与报表一致性 =================
  const CM = 'COM';
  const fR1 = { principal: 5000, lump: 0, label: 'COM A', agent_id: agentA };
  const fR2 = { principal: 3000, lump: 0, label: 'COM B', agent_id: agentB };
  const cR1 = await mkCase(fR1), cR2 = await mkCase(fR2);
  await pay(cR1, TODAY, '333.33'); await pay(cR1, `${MONTH}-05`, '0.1'); await pay(cR1, `${MONTH}-06`, '0.2'); await pay(cR1, '2026-09-15', '1000');
  await pay(cR2, `${MONTH}-10`, '1234.57'); await pay(cR2, '2026-09-30', '100');
  // tracked sums per agent / month (independent of the system's SQL)
  const agentOf = (cid) => q1('SELECT agent_id a FROM cases WHERE id=?', cid).a;
  const sumBy = (pred) => tracked.filter(pred).reduce((s, t) => s.add(t.amount), X.F.of(0));
  async function comRows(month) { const h0 = (await admin.get('/commissions?month=' + month)).body; const h = h0.slice(0, h0.indexOf('Settlement history')); const out = {};
    for (const row of [...h.matchAll(/<tr>\s*<td>([^<]+)<\/td>([\s\S]*?)<\/tr>/g)]) { const cells = [...row[2].matchAll(/<td class="num[^"]*">([^<]*)<\/td>/g)].map((x) => x[1]); out[row[1].trim()] = { collected: num(cells[0]), rate: cells[1], earned: num(cells[2]), settled: num(cells[3]), pending: num(cells[4]) }; }
    return out; }
  let com = await comRows(MONTH);
  for (const [name, aid, rate] of [['QA Agent A', agentA, 5], ['QA Agent B', agentB, 7.5]]) {
    const col = sumBy((t) => agentOf(t.cid) === aid && t.date.slice(0, 7) === MONTH);
    check(CM, `${name} ${MONTH} Collected`, 'Σ 本月已记还款', col.r2(), com[name] && com[name].collected);
    check(CM, `${name} ${MONTH} Earned`, `Collected×${rate}%`, X.commission(col, rate), com[name] && com[name].earned);
  }
  const col9 = sumBy((t) => agentOf(t.cid) === agentA && t.date.startsWith('2026-09'));
  com = await comRows('2026-09');
  check(CM, 'QA Agent A 2026-09 Earned', '1000×5%', X.commission(col9, 5), com['QA Agent A'] && com['QA Agent A'].earned);
  await admin.post('/commissions/settle', { agent_id: String(agentA), period: MONTH, amount: '10', note: 'QA' });
  com = await comRows(MONTH);
  const colA = sumBy((t) => agentOf(t.cid) === agentA && t.date.slice(0, 7) === MONTH);
  check(CM, 'QA Agent A 结算 10.00 后 Pending', 'Earned−Settled', X.F.of(X.commission(colA, 5)).sub(10).r2(), com['QA Agent A'].pending);
  // demo agents: commission page Earned = Σ(their cases' payments this month) × rate
  for (const a of q('SELECT id, name, commission_rate rate FROM agents WHERE is_demo=1')) {
    const col = sumBy((t) => agentOf(t.cid) === a.id && t.date.slice(0, 7) === MONTH);
    check(CM, `演示催收员 ${a.name} ${MONTH} Earned`, `Σ×${a.rate}%`, X.commission(col, a.rate), com[a.name] && com[a.name].earned);
  }
  // Reports performance (page + CSV) for this month, vs commissions page
  const from = `${MONTH}-01`;
  const rep = (await admin.get(`/reports?from=${from}&to=${TODAY}`)).body;
  const perfRows = {}; for (const m of rep.matchAll(/<tr><td>([^<]+)<\/td><td class="num">([^<]+)<\/td>\s*<td class="num">([^<]+)<\/td><td class="num">([^<]+)<\/td>/g)) perfRows[m[1]] = { collected: num(m[2]), commission: num(m[4]) };
  const perfCsv = parseCsv((await admin.get(`/reports?from=${from}&to=${TODAY}&export=performance`)).body);
  const comNow = await comRows(MONTH);
  for (const name of ['QA Agent A', 'QA Agent B']) {
    const csvRow = perfCsv.find((x) => x.Agent === name) || {};
    check(CM, `${name}：Reports 页 Commission vs Commissions 页 Earned（同月）`, '应一致', f2(comNow[name].earned), perfRows[name] && perfRows[name].commission);
    check(CM, `${name}：agent-performance.csv Collected`, '应为两位小数数字', f2(comNow[name].collected), csvRow.Collected, { pass: csvRow.Collected === f2(comNow[name].collected) || csvRow.Collected === String(comNow[name].collected) });
    check(CM, `${name}：agent-performance.csv Commission`, 'RPT-06：无小数尾差', f2(comNow[name].earned), csvRow.Commission, { pass: csvRow.Commission === f2(comNow[name].earned) || csvRow.Commission === String(comNow[name].earned) });
  }
  // Agents page (all time) vs case-level sums
  const ag = (await admin.get('/agents')).body;
  for (const [name, aid] of [['QA Agent A', agentA], ['QA Agent B', agentB]]) {
    const row = ag.match(new RegExp(`>${name}</a></td><td>[^<]*</td>\\s*<td class="num">(\\d+)</td><td class="num">([^<]+)</td>\\s*<td class="num">[^<]+</td><td class="num">([^<]+)</td>`));
    const all = sumBy((t) => agentOf(t.cid) === aid);
    check(CM, `${name}：Agents 页 Collected（累计）`, 'Σ 全部还款', all.r2(), row && num(row[2]));
  }
  // Reassignment: move case R1 from A to B
  const before7 = (await comRows(MONTH))['QA Agent A'];
  await admin.post(`/cases/${cR1}`, { debtor_id: debtorId, agent_id: String(agentB), principal_amount: '5000', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '', tenure: '', priority: 'medium', remark: 'reassigned' });
  const after7 = (await comRows(MONTH))['QA Agent A'];
  check(CM, '案件改派 A→B 后，A 本月 Earned（已结算 10.00）', '业务预期：历史回款仍归 A', f2(before7.earned), after7.earned, { note: `改派后 Pending=${f2(after7.pending)}` });

  // ================= S12 汇总与明细一致性 =================
  const CS = 'RECON';
  const allCases = q('SELECT id FROM cases ORDER BY id').map((x) => x.id);
  const pageOut = {}; for (const id of allCases) pageOut[id] = (await page(id)).outstanding; // opening refreshes caches
  const dash = (await admin.get('/')).body;
  const dTotal = num(m1(/Total Outstanding<\/div><div class="v2">RM ([^<]+)</, dash));
  const dColl = num(m1(/Collected Today<\/div>\s*<div class="v2">RM ([^<]+)</, dash));
  const dCnt = num(m1(/(\d+) payments? today/, dash));
  const aging = [...dash.matchAll(/<span class="v">RM ([^<]+)<\/span>/g)].map((m) => num(m[1]));
  const repB = (await admin.get('/reports')).body;
  const rTotal = num(m1(/<tfoot><tr><td>Total<\/td><td class="num">\d+<\/td><td class="num">([^<]+)</, repB));
  const casesCsv = parseCsv((await admin.get('/cases?format=csv')).body);
  const detCsv = parseCsv((await admin.get('/reports?export=cases')).body);
  const outCsv = parseCsv((await admin.get('/reports?export=outstanding')).body);
  const sumPages = Object.values(pageOut).reduce((s, v) => s.add(String(v)), X.F.of(0)).r2();
  check(CS, 'Dashboard Total Outstanding vs Σ 各案件详情页 Outstanding', '应相等', sumPages, dTotal);
  check(CS, 'Reports Outstanding by Status 合计 vs Σ 详情页', 'DASH-05', sumPages, rTotal);
  check(CS, 'cases.csv Σ Outstanding', '', sumPages, casesCsv.reduce((s, x) => s.add(x.Outstanding), X.F.of(0)).r2());
  check(CS, 'cases-detailed.csv Σ Outstanding', '', sumPages, detCsv.reduce((s, x) => s.add(x.Outstanding), X.F.of(0)).r2());
  check(CS, 'outstanding-by-status.csv Σ', '', sumPages, outCsv.reduce((s, x) => s.add(x.Outstanding), X.F.of(0)).r2());
  const sumPaidTracked = tracked.reduce((s, t) => s.add(t.amount), X.F.of(0));
  check(CS, 'cases.csv Σ Paid vs Σ 已接受还款', '', sumPaidTracked.r2(), casesCsv.reduce((s, x) => s.add(x.Paid), X.F.of(0)).r2());
  const todayT = tracked.filter((t) => t.date === TODAY);
  check(CS, 'Dashboard Collected Today', 'Σ 今天日期的还款', todayT.reduce((s, t) => s.add(t.amount), X.F.of(0)).r2(), dColl);
  check(CS, 'Dashboard “N payments today”', 'count', String(todayT.length), String(dCnt));
  const terminal = ['legal', 'closed', 'cancelled', 'bankruptcy', 'deceased'];
  const nonTermOut = q(`SELECT SUM(outstanding_amount) s FROM cases WHERE status NOT IN (${terminal.map(() => '?').join(',')}) AND outstanding_amount>0`, ...terminal)[0].s;
  check(CS, 'Dashboard Aging 四档合计 vs Total Outstanding', '口径不同：Aging 排除终态', f2(dTotal), aging.reduce((s, v) => s + v, 0).toFixed(2),
    { pass: false, note: `Aging 合计 = 非终态欠款 ${f2(nonTermOut)}；差额 = 终态案件欠款（含 Closed/Cancelled）` });
  // identity per case in detailed CSV
  const broken = detCsv.filter((x) => X.F.of(x.Principal).add(x.Interest).sub(x.Paid).r2() !== X.F.of(x.Outstanding).r2());
  check(CS, 'cases-detailed.csv 恒等式 Principal+Interest−Paid=Outstanding', '逐行', '0 行不平', `${broken.length} 行不平: ${broken.map((x) => `${x['Case No']}(${x.Principal}+${x.Interest}−${x.Paid}≠${x.Outstanding})`).join('; ')}`, { pass: broken.length === 0 });
  // statement vs case page
  for (const cid of [cA, cE, cR1]) {
    const st = (await admin.get(`/cases/${cid}/statement`)).body; const pg = await page(cid);
    const g = (l) => num(m1(new RegExp(`<span>${l}</span>RM ([^<]+)<`), st));
    check(CS, `对账单 vs 详情页（案件 ${cid}）`, 'Principal/Interest/Paid/Outstanding', `${f2(pg.principal)}/${f2(pg.interest)}/${f2(pg.paid)}/${f2(pg.outstanding)}`, `${f2(g('Principal'))}/${f2(g('Interest'))}/${f2(g('Paid'))}/${f2(g('Outstanding'))}`);
  }
  // Leaderboard vs Agents page (all-time)
  const lb = [...dash.matchAll(/<div class="row"><span>([^<]+)<\/span><span class="num">RM ([^<]+)<\/span>/g)].map((m) => [m[1], num(m[2])]);
  const agAll = Object.fromEntries(q('SELECT id, name FROM agents').map((a) => [a.name, sumBy((t) => agentOf(t.cid) === a.id).r2()]));
  check(CS, 'Dashboard Leaderboard vs Σ 各催收员名下还款（累计）', 'Top5', lb.map(([n]) => `${n}:${agAll[n]}`).join(', '), lb.map(([n, v]) => `${n}:${f2(v)}`).join(', '));

  // ================= INFO：DPD / 罚息（系统无此计算，仅给出业务预期值，不计入通过率） =================
  const info = [];
  for (const [cid, f, lbl] of [[cC, C, 'SCH-03 示例C（已到期未还）'], [c5, D5, 'SCH-05（还了2期）'], [cM, fM, '到期后还过500'], [cB, fB, '起息前还1,000']]) {
    const html = (await admin.get('/cases/' + cid)).body; const pg = parseCase(html);
    const es = X.schedule(f, paysOf(cid), { today: TODAY }); const od = es.find((x) => x.status === 'Overdue');
    const dpd = od ? X.days(od.due, TODAY) : 0;
    const arrears = es.filter((x) => x.status === 'Overdue').reduce((s2, x) => s2.add(x.outstanding), X.F.of(0));
    const lp = X.F.of(arrears).mul(8).div(100).div(365).mul(dpd).r2();
    info.push({ case: lbl, oldestOverdue: od ? od.due : '-', dpd, overdueAmount: arrears.r2(), illustrative8pctLateInterest: lp,
      systemDPD: /DPD|days past due|Days Overdue/i.test(html) ? 'present' : '无此字段', systemOverdueRows: pg.schedule.filter((x) => x.status === 'Overdue').length,
      systemOutstanding: f2(pg.outstanding) });
  }
  console.log('\n### INFO DPD\n' + JSON.stringify(info, null, 1));
  fs.writeFileSync(path.join(ROOT, 'data', 'qa', 'calc-results.json'), JSON.stringify({ today: TODAY, ids: { cA, cE, cR1, cR2, cPT, cPT2, cF, cSD, cT }, info, results }, null, 1));
  const pass = results.filter((x) => x.pass).length;
  for (const sec of [...new Set(results.map((x) => x.sec))]) {
    console.log(`\n### ${sec}\n| ID | 场景 | 预期算式 | 预期 | 系统输出 | 结论 |\n|---|---|---|---|---|---|`);
    results.filter((x) => x.sec === sec).forEach((x) => console.log(`| ${x.id} | ${x.scen} | ${x.formula} | ${x.expected} | ${x.actual} | ${x.pass ? '通过' : '**不通过**'}${x.note ? '（' + x.note + '）' : ''} |`));
  }
  console.log(`\nTOTAL ${results.length} checks, ${pass} pass, ${results.length - pass} fail`);
}
main().catch((e) => { console.error(e); process.exit(1); });
