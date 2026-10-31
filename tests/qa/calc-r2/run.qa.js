// Role 2 round 2 — main comparison run: independent expected values (expected.qa.js)
// vs what the system shows through its real HTTP entry points on :3302.
// Run on a FRESHLY seeded data/qa/business-r2.db:  node --no-warnings tests/qa/calc-r2/run.qa.js
// Writes data/qa/calc-r2-results.json and data/qa/calc-r2-results.md.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const E = require('./expected.qa.js');
const C = require('./client.qa.js');
const { F, ledger, settlementOn, schedule, arrears, capOverdue, addMonths, addDays, days, splitEqual, planDates, nominalRate, commission, sum2, r2 } = E;

const T = C.todayMYT();
const results = [];
const created = [];      // every case this run creates: { id, label }
const paidOffToday = []; // cases this run settled to Fully Paid today
function cmp(g, id, scenario, formula, expected, actual, note = '') {
  const pass = String(expected) === String(actual);
  results.push({ g, id, scenario, formula, expected: String(expected), actual: String(actual), result: pass ? 'PASS' : 'FAIL', note });
  return pass;
}
function chk(g, id, scenario, expectedDesc, cond, actual, note = '') {
  results.push({ g, id, scenario, formula: '', expected: expectedDesc, actual: String(actual).slice(0, 300), result: cond ? 'PASS' : 'FAIL', note });
  return cond;
}
// A business expectation that waits on an outside decision: recorded, not failed.
function pending(g, id, scenario, expectedDesc, actual, decision) {
  results.push({ g, id, scenario, formula: '', expected: expectedDesc, actual: String(actual).slice(0, 300), result: 'PENDING', note: '待决定：' + decision });
}
const loanOf = t => ({ principal: t.principal_amount, mode: t.interest_mode || 'fixed', rate: Number(t.interest_rate || 0), lump: Number(t.interest_amount || 0),
  start: t.loan_start_date, maturity: t.tenure ? addMonths(t.loan_start_date, Number(t.tenure)) : null });
// Expected figures for a case built from its INPUT terms (+ payments/restructures as entered).
function expectCase(t, pays = [], rs = [], today = T) {
  const loan = loanOf(t);
  const rsx = rs.map(r => ({ effective: r.effective, mode: r.mode, rate: Number(r.rate || 0), lump: Number(r.lump || 0), maturity: addMonths(r.effective, r.tenure), tenure: r.tenure }));
  const L = ledger(loan, pays, { restructures: rsx, today });
  const sett = settlementOn(loan, pays, today, { restructures: rsx });
  let rows = [];
  const settled = !F.of(L.outstanding).isPos();
  if (rsx.length) {
    const last = rsx[rsx.length - 1], cut = L.cuts[L.cuts.length - 1];
    rows = schedule({ principal: cut.principalExact.r2(), mode: last.mode, rate: last.rate, lump: last.lump, start: last.effective, tenure: last.tenure },
      pays.filter(p => p.date > last.effective), { today, arrears: cut.arrears, settled });
  } else if (t.tenure && t.loan_start_date) {
    rows = schedule({ principal: t.principal_amount, mode: loan.mode, rate: loan.rate, lump: loan.lump, start: t.loan_start_date, tenure: Number(t.tenure) }, pays, { today, settled });
  }
  const ar = capOverdue(arrears(rows, today), sett); // G-12 cap
  const total = F.of(t.principal_amount).add(L.interest);
  const recovered = total.isPos() ? Number(F.of(L.paid).mul(100).div(total).add(new F(1n, 2n)).floor2().r2().split('.')[0]) : 0;
  return { ...L, settlement: sett, rows, dpd: ar.dpd, overdue: ar.overdue, maturity: rsx.length ? rsx[rsx.length - 1].maturity : loan.maturity, cuts: L.cuts, recovered };
}
function cmpCase(g, id, label, exp, v, fields = ['outstanding', 'interest', 'paid', 'settlement', 'dpd', 'overdue', 'schedule']) {
  const f = {
    outstanding: () => cmp(g, `${id}.outstanding`, `${label}：合同欠款`, '剩余本金 + 合同期利息 − 已还', exp.outstanding, v.outstanding),
    interest: () => cmp(g, `${id}.interest`, `${label}：Interest`, '已收利息 + 未收利息（合同期）', exp.interest, v.interest),
    paid: () => cmp(g, `${id}.paid`, `${label}：Paid`, 'Σ 还款', exp.paid, v.paid),
    settlement: () => cmp(g, `${id}.settlement`, `${label}：Settlement Today (${T})`, '剩余本金 + 截至今天利息（D-02）', exp.settlement, v.settlement),
    dpd: () => cmp(g, `${id}.dpd`, `${label}：DPD`, '最早未还清期到期日 → 今天（D-09）', exp.dpd, v.dpd),
    overdue: () => cmp(g, `${id}.overdue`, `${label}：Overdue`, 'Σ 已到期未还（计划 FIFO）', exp.overdue, v.overdue),
    maturity: () => cmp(g, `${id}.maturity`, `${label}：Maturity`, '起始日 + 期限月（月末对齐）', exp.maturity, v.maturity),
    recovered: () => cmp(g, `${id}.recovered`, `${label}：% recovered`, 'round(已还 ÷ (本金+利息))', exp.recovered, v.recovered),
    schedule: () => {
      const e = exp.rows.map(r => [r.due, r.expected, r.paid, r.outstanding, r.status].join('|'));
      const a = (v.schedule || []).map(r => [r.due, r.expected, r.paid, r.outstanding, r.status].join('|'));
      const diff = e.map((x, i) => (x === a[i] ? null : `#${i + 1} 预期 ${x} / 实际 ${a[i]}`)).filter(Boolean);
      if (a.length !== e.length) diff.push(`行数 预期 ${e.length} / 实际 ${a.length}`);
      return chk(g, `${id}.schedule`, `${label}：还款计划 ${e.length} 行（到期日|应还|已还|未还|状态）`, e.length ? `${e[0]} … ${e[e.length - 1]}` : '无计划', diff.length === 0, diff.length ? diff.slice(0, 4).join('; ') : `一致（${a.length} 行）`);
    },
  };
  fields.forEach(k => f[k]());
}
const errAtMost = e => { const m = String(e || '').match(/at most RM ([\d.]+)/); return m ? m[1] : `(无上限提示: ${e})`; };

async function main() {
  const s = await C.login('admin', 'admin123');
  const debtor = await C.newDebtor(s, 'QA R2 业务验算');
  // newC(): create a case from input terms; remembers the terms for later recomputation.
  const terms = {};
  async function newC(label, t) {
    let r = await C.newCase(s, debtor, t);
    // v1.11.0 compat (N-02, added 2026-10-26): an interest-bearing loan without tenure is refused.
    // Record the refusal, then carry on with tenure 12 so the later scenarios still run.
    if (!r.id && /Tenure is required/.test(r.err || '') && !t.tenure) {
      results.push({ g: 'RULE', id: 'N-02', scenario: `${label}：v1.11.0 起不填期限被拒`, formula: '', expected: 'v1.10.0 允许', actual: r.err, result: 'RULE-CHANGE', note: '改用 tenure=12 继续' });
      t = { ...t, tenure: 12 };
      r = await C.newCase(s, debtor, t);
    }
    if (!r.id) throw new Error(`create ${label}: ${r.err}`);
    terms[r.id] = { principal_amount: Number(t.principal_amount), interest_mode: t.interest_mode || 'fixed', interest_rate: t.interest_rate || 0,
      interest_amount: t.interest_amount || 0, loan_start_date: t.loan_start_date || null, tenure: t.tenure || null };
    created.push({ id: r.id, label });
    return r.id;
  }
  const pays = {}; // id -> [{date, amount}] as accepted
  async function payOk(id, date, amount) {
    const r = await C.pay(s, id, date, amount);
    if (r.ok && /^Payment RCPT/.test(r.ok)) (pays[id] ||= []).push({ date, amount: String(amount) });
    return r;
  }
  const view = id => C.caseView(s, id);
  const A = { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: '2026-01-01', tenure: 12 };

  // ===================== INT: balances, schedules (D-01) =====================
  {
    const g = 'INT';
    const a0 = await newC('示例A', A);
    let v = await view(a0); let x = expectCase(terms[a0]);
    cmp(g, 'A0.interest', '示例A 无还款：合同利息', '10000 × 1.5% × 12 个月', x.interest, v.interest);
    cmpCase(g, 'A0', '示例A 无还款', x, v, ['outstanding', 'settlement', 'dpd', 'overdue', 'maturity', 'schedule']);
    // Written out by hand for today: whole months since 01-01 plus today's share of this month (D-01).
    const [ty, tm, td] = T.split('-').map(Number), dim = new Date(Date.UTC(ty, tm, 0)).getUTCDate(), k = (ty - 2026) * 12 + (tm - 1);
    cmp(g, 'A0.settle.formula', '示例A 今日结清额的算式', `10000 + 10000×1.5%×(${k} + ${td - 1}/${dim})`, r2(F.of(10000).add(F.of(150).mul(new F(BigInt(k * dim + td - 1), BigInt(dim))))), v.settlement);
    const st = await C.statementView(s, a0);
    cmp(g, 'A0.stmt', '示例A 对账单 = 案件页（合同欠款/结清额/逾期/DPD）', '同一案件同一天', [v.outstanding, v.settlement, v.overdue, v.dpd].join('/'), [st.outstanding, st.settlement, st.overdue, st.dpd].join('/'));
    chk(g, 'A0.paymax', '示例A Record Payment 弹窗 max = 今日结清额', x.settlement, v.payMaxLabel === x.settlement && v.payMaxAttr === String(Number(x.settlement)), `label ${v.payMaxLabel} attr ${v.payMaxAttr}`);

    // INT-06 / PAY-15 / 5.2
    const a1 = await newC('示例A+03-02还1000', A);
    let r = await C.pay(s, a1, '2026-03-02', '11800');
    cmp(g, 'A1.reject11800', '示例A 03-02 还合同全额 11,800（PAY-17）', '应拒收；上限 = 10000 + 10000×1.5%×(2+1/31)', settlementOn(loanOf(terms[a1]), [], '2026-03-02'), errAtMost(r.err));
    r = await payOk(a1, '2026-03-02', '1000');
    v = await view(a1); x = expectCase(terms[a1], pays[a1]);
    cmpCase(g, 'A1', '示例A 03-02 还 1,000', x, v, ['outstanding', 'interest', 'paid', 'settlement', 'dpd', 'overdue', 'schedule']);
    cmp(g, 'A1.drop', 'PAY-15 欠款降幅', '11800 − 10696.06', '1103.94', r2(F.of('11800').sub(v.outstanding)));
    r = await C.pay(s, a1, '2026-06-15', v.outstanding); // probe: contract balance on 06-15 is above the settlement → refused with the cap
    cmp(g, 'A1.sett0615', '5.2 示例A 06-15 结清额（用超额拦截提示探测）', '9304.84 + 9304.84×1.5%×(5+14/30−2−1/31)', settlementOn(loanOf(terms[a1]), pays[a1], '2026-06-15'), errAtMost(r.err));

    // 5.4 example C (3-month, matured)
    const c3 = await newC('示例C 3期已到期', { ...A, tenure: 3 });
    v = await view(c3); x = expectCase(terms[c3]);
    cmpCase(g, 'C3', '示例C', x, v, ['outstanding', 'interest', 'settlement', 'dpd', 'overdue', 'maturity', 'schedule']);
    // 5.8 annual
    const g1 = await newC('示例G Annual', { principal_amount: 36500, interest_mode: 'daily', interest_rate: 18, loan_start_date: '2026-01-01', tenure: 12 });
    v = await view(g1); x = expectCase(terms[g1]);
    cmpCase(g, 'G', '示例G Annual 36,500×18%', x, v, ['outstanding', 'interest', 'settlement', 'dpd', 'overdue', 'schedule']);
    // 5.5 fixed
    const d1 = await newC('示例D Fixed 1000/3 起 01-31', { principal_amount: 1000, interest_mode: 'fixed', interest_amount: 0, loan_start_date: '2026-01-31', tenure: 3 });
    v = await view(d1); x = expectCase(terms[d1]);
    cmpCase(g, 'D1', '示例D Fixed 1,000/3 期 起 01-31', x, v, ['outstanding', 'dpd', 'overdue', 'schedule']);
    const d2 = await newC('示例D Fixed 10000+1200/12 还2000', { principal_amount: 10000, interest_mode: 'fixed', interest_amount: 1200, loan_start_date: '2026-01-01', tenure: 12 });
    await payOk(d2, T, '2000');
    v = await view(d2); x = expectCase(terms[d2], pays[d2]);
    cmpCase(g, 'D2', '示例D Fixed 11,200/12 还 2,000', x, v, ['outstanding', 'settlement', 'dpd', 'overdue', 'schedule']);
    const payRow = v.schedule.find(rw => rw.pay);
    cmp(g, 'D2.pay', 'SCH-07 Pay 预填', 'min(最早未还期 799.99, 结清额 9,200)', '799.99', payRow && payRow.pay);
    // 5.6 example E (DPD)
    const e1 = await newC('示例E Fixed 1200/12', { principal_amount: 1200, interest_mode: 'fixed', interest_amount: 0, loan_start_date: '2026-01-01', tenure: 12 });
    v = await view(e1); x = expectCase(terms[e1]);
    cmpCase(g, 'E0', '示例E 未还款（今天）', x, v, ['dpd', 'overdue']);
    await payOk(e1, T, '150');
    v = await view(e1); x = expectCase(terms[e1], pays[e1]);
    cmpCase(g, 'E1', '示例E 再还 150', x, v, ['dpd', 'overdue', 'schedule']);
    // INT-07 (v1.2, N-02): start today with a 12-month term — nothing accrued yet, nothing due yet.
    const z = await newC('起始=今天 12 个月', { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: T, tenure: 12 });
    v = await view(z);
    cmp(g, 'INT07', 'INT-07 起始=今天：今日结清额 = 本金', '同一天 0 天', '10000.00', v.settlement);
    cmp(g, 'INT07.dpd', 'INT-07 第一期未到：DPD 0 / up to date', '0', '0', String(v.dpd));
    // short loan 1 month
    const sh = await newC('1个月短期贷 10-01', { principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: '2026-10-01', tenure: 1 });
    v = await view(sh); x = expectCase(terms[sh]);
    cmpCase(g, 'SHORT', '1 个月贷款 起 10-01', x, v, ['outstanding', 'settlement', 'maturity', 'dpd', 'schedule']);
  }

  // ===================== EDGE: leap year / month end (D-01) =====================
  {
    const g = 'EDGE';
    const M = (start, tenure, extra = {}) => ({ principal_amount: 10000, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: start, tenure, ...extra });
    async function probeSet(label, t, dates) {
      const id = await newC(label, t);
      const v = await view(id); const x = expectCase(terms[id]);
      cmpCase(g, label, label, x, v, ['outstanding', 'interest', 'maturity', 'schedule']);
      for (const d of dates) {
        const r = await C.pay(s, id, d, v.outstanding);
        cmp(g, `${label}@${d}`, `${label}：${d} 结清额（超额拦截提示）`, describe(t, d), settlementOn(loanOf(terms[id]), [], d), errAtMost(r.err));
      }
      return id;
    }
    const describe = (t, d) => `${t.principal_amount} × ${t.interest_rate}% × 月数(${t.loan_start_date}→${d})`;
    await probeSet('闰年 起2024-01-31 3期', M('2024-01-31', 3), ['2024-02-29', '2024-03-01', '2024-03-30', '2024-03-31']);
    await probeSet('平年 起2026-01-31 3期', M('2026-01-31', 3), ['2026-02-28', '2026-03-01', '2026-03-30', '2026-03-31']);
    await probeSet('起2026-01-30 3期', M('2026-01-30', 3), ['2026-02-28', '2026-03-01', '2026-03-29']);
    await probeSet('闰年 起2024-02-29 12期', M('2024-02-29', 12), ['2024-03-28', '2024-03-29', '2025-02-27']);
    await probeSet('跨闰2月 起2023-12-01 12期', M('2023-12-01', 12), ['2024-02-15', '2024-03-01', '2024-03-15']);
    const one = await probeSet('闰年 起2024-01-31 1期', M('2024-01-31', 1), []);
    // daily ÷365 across 2024-02-29
    const D = (start, tenure) => ({ principal_amount: 36500, interest_mode: 'daily', interest_rate: 18, loan_start_date: start, tenure });
    await probeSet('Annual 起2024-01-01 12期（366天）', D('2024-01-01', 12), ['2024-02-29', '2024-12-31']);
    // future leap year (contract projection only — future payments are refused)
    const fm = await newC('未来闰年 Monthly 起2027-12-01', M('2027-12-01', 12));
    let v = await view(fm); let x = expectCase(terms[fm]);
    if (v.status) cmpCase(g, 'FUT-M', '未来闰年 Monthly 起2027-12-01 12期', x, v, ['outstanding', 'interest', 'maturity', 'schedule']);
    const fd = await newC('未来闰年 Annual 起2027-12-01', D('2027-12-01', 12));
    v = await view(fd); x = expectCase(terms[fd]);
    cmpCase(g, 'FUT-D', '未来闰年 Annual 起2027-12-01 12期（366天 ÷365）', x, v, ['outstanding', 'interest', 'maturity']);
    cmp(g, 'FUT-D.eff', '同上：实际年化（366/365×18%）', '6588 ÷ 36500', '18.05', r2(F.of(x.interest).div(36500).mul(100)), '规则如此（闰年 ÷366 待律师确认）');
    const fut = await C.pay(s, fd, addDays(T, 1), '100');
    cmp(g, 'FUTPAY', '明天日期的还款', '拒收', 'Payment date cannot be in the future', fut.err);
    void one;
  }

  // ===================== ROUND: sen rounding, 0.005 boundary (K-01) =====================
  {
    const g = 'ROUND';
    let start = addMonths(T, -1) === T ? T : (() => { const [y, m, d] = T.split('-').map(Number); return `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; })();
    // 2026-10-31 补：上月没有同一天（如 09-31）时日期无效、建案被拒，脚本崩溃。退到上月最后一天（到期日 = 昨天），
    // 预期值仍由独立计算器按同一起始日给出，所以对比照样成立。
    if (new Date(start + 'T00:00:00Z').toISOString().slice(0, 10) !== start) start = addMonths(T, -1);
    // 1-month loans maturing today: settlement today = P + P×1.5% (exact x.xx5 for these P)
    for (const P of [1015, 1079, 1001, 3001]) {
      const id = await newC(`1个月 P=${P}`, { principal_amount: P, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: start, tenure: 1 });
      const v = await view(id); const x = expectCase(terms[id]);
      cmp(g, `P${P}.int`, `P=${P} 1 个月利息`, `${P} × 1.5% = ${F.of(P).mul('0.015').toString()}`, x.interest, v.interest);
      cmp(g, `P${P}.out`, `P=${P} 合同欠款`, `${P} + ${P}×1.5%（half-up）`, x.outstanding, v.outstanding);
      cmp(g, `P${P}.ident`, `P=${P} 恒等式 Principal + Interest = Outstanding（页面）`, '应相等', v.outstanding, r2(F.of(v.principal).add(v.interest)));
      cmp(g, `P${P}.sett`, `P=${P} 今日结清额`, '同上（今天到期）', x.settlement, v.settlement);
    }
    // pay the displayed settlement on P=1015 and the half-up value on a twin case
    const t1 = await newC('P=1015 按页面结清额还款', { principal_amount: 1015, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: start, tenure: 1 });
    let v = await view(t1);
    let r = await payOk(t1, T, v.settlement);
    v = await view(t1);
    chk(g, 'P1015.payShown', `P=1015 按页面显示的结清额 ${v.paid} 还款后应结清`, 'Outstanding 0.00 / Fully Paid', v.outstanding === '0.00' && v.status === 'Fully Paid', `${r.ok || r.err}; Outstanding ${v.outstanding}; ${v.status}`);
    if (v.status === 'Fully Paid') paidOffToday.push(t1);
    const t2 = await newC('P=1015 按 half-up 结清额还款', { principal_amount: 1015, interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: start, tenure: 1 });
    r = await payOk(t2, T, '1030.23');
    v = await view(t2);
    chk(g, 'P1015.payHalfUp', 'P=1015 还 1,030.23（精确 1,030.225 四舍五入）', '接受（超出 0.005 在容差内）并 Fully Paid', !!(r.ok && v.status === 'Fully Paid'), `${r.ok || r.err}; ${v.status}; Outstanding ${v.outstanding}`);
    if (v.status === 'Fully Paid') paidOffToday.push(t2);
  }

  // ===================== PAYV: amount / date validation =====================
  {
    const g = 'PAYV';
    const id = await newC('还款校验 Fixed 1000', { principal_amount: 1000, interest_mode: 'fixed', interest_amount: 0 });
    for (const [amt, exp] of [['0', 'Invalid amount'], ['-5', 'Invalid amount'], ['0.001', 'Invalid amount'], ['100.004', 'Invalid amount'], ['1e2', 'Invalid amount'], ['1000.01', 'Amount exceeds outstanding']]) {
      const r = await C.pay(s, id, T, amt);
      cmp(g, `amt=${amt}`, `还款金额 ${amt}`, '拒收', exp, r.err);
    }
    let r = await C.pay(s, id, '2026-02-30', '10');
    cmp(g, 'date=02-30', '还款日期 2026-02-30', '拒收', 'Invalid payment date', r.err);
    r = await C.pay(s, id, T, '10', { method: 'bitcoin' });
    cmp(g, 'method', '非法还款方式', '拒收', 'Invalid payment method', r.err);
    // settlement + 0.01 on an accrual case (contract > settlement)
    const a = await newC('超额 0.01', A);
    const exp = settlementOn(loanOf(terms[a]), [], T);
    r = await C.pay(s, a, T, r2(F.of(exp).add('0.01')));
    cmp(g, 'sett+0.01', `今日结清额 ${exp} + 0.01`, '拒收，提示上限 = 结清额', exp, errAtMost(r.err));
    // late entry of an earlier receipt: a later payment would then exceed its own date's settlement
    const ch = await newC('补录早期还款 链式超额', A);
    await payOk(ch, '2026-06-01', '10000');
    const loanCh = loanOf(terms[ch]);
    let lo = 0, hi = 1000000; // sen; my max X on 03-02 with no excess anywhere
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); const L = ledger(loanCh, [...pays[ch], { date: '2026-03-02', amount: (mid / 100).toFixed(2) }], { today: T }); if (F.of(L.excess).isPos()) hi = mid - 1; else lo = mid; }
    const maxX = (lo / 100).toFixed(2);
    r = await C.pay(s, ch, '2026-03-02', '800');
    const hint = errAtMost(r.err);
    if (/^\d/.test(hint)) cmp(g, 'chain.hintOk', `按提示金额 ${hint} 补录时 06-01 那笔的超额`, '提示金额本身可接受（超额 0）', '0.00', ledger(loanCh, [...pays[ch], { date: '2026-03-02', amount: hint }], { today: T }).excess);
    cmp(g, 'chain.hint', '已有 06-01 还 10,000，补录 03-02 的 800：拒收提示中的上限', `独立计算：使 06-01 那笔不超过其当日结清额的最大补录额`, maxX, errAtMost(r.err), '提示按线性扣减计算，未考虑补录额变小会增加后续利息');
    r = await payOk(ch, '2026-03-02', maxX);
    chk(g, 'chain.max', `按独立计算的上限 ${maxX} 补录`, '接受', !!(r.ok && /^Payment RCPT/.test(r.ok)), r.ok || r.err);
    // B-16: payment before interest start
    const b = await newC('起息前还款', { ...A, loan_start_date: '2026-06-01' });
    r = await C.pay(s, b, '2026-05-01', '1000');
    chk(g, 'beforeStart', 'B-16 起息日（2026-06-01）之前的还款 05-01', '拒收（业务预期；F-20 范围）', !!r.err, r.ok || r.err);
    if (r.ok) { (pays[b] ||= []).push({ date: '2026-05-01', amount: '1000' }); const v = await view(b); const x = expectCase(terms[b], pays[b]);
      cmp(g, 'beforeStart.out', '若接受：起息前还款全额冲本金后的欠款', '9000 + 9000×1.5%×12', x.outstanding, v.outstanding); }
  }

  // ===================== ALLOC: interest-first order =====================
  {
    const g = 'ALLOC';
    const a = await newC('还 200 < 已计利息', A);
    await payOk(a, '2026-03-02', '200');
    let v = await view(a); let x = expectCase(terms[a], pays[a]);
    cmpCase(g, 'P200', '03-02 还 200（< 已计利息 304.84）', x, v, ['outstanding', 'interest', 'settlement']);
    cmp(g, 'P200.split', '03-02 的 200 全部冲利息', 'toInterest', '200.00', x.perPayment[0].toInterest);
    const b = await newC('乱序录入', A);
    await payOk(b, '2026-05-01', '500'); await payOk(b, '2026-03-02', '1000');
    v = await view(b); x = expectCase(terms[b], pays[b]);
    cmpCase(g, 'ORDER', '先录 05-01 的 500、后补录 03-02 的 1,000', x, v, ['outstanding', 'interest', 'settlement', 'schedule']);
    const c = await newC('到期后还款', { ...A, loan_start_date: '2025-01-01', tenure: 3 });
    await payOk(c, '2026-10-01', '500');
    v = await view(c); x = expectCase(terms[c], pays[c]);
    cmpCase(g, 'AFTERMAT', '到期（2025-04-01）后 2026-10-01 还 500', x, v, ['outstanding', 'interest', 'settlement', 'dpd', 'overdue']);
    const d = await newC('只还利息', A);
    await payOk(d, '2026-03-02', '304.84');
    v = await view(d); x = expectCase(terms[d], pays[d]);
    cmpCase(g, 'INTONLY', '03-02 恰好还已计利息 304.84', x, v, ['outstanding', 'interest', 'settlement']);
  }

  // ===================== EARLY: early settlement (D-02) =====================
  {
    const g = 'EARLY';
    const a = await newC('提前结清 03-02', A);
    let r = await C.pay(s, a, '2026-03-02', '10304.85');
    cmp(g, 'A+0.01', '03-02 还 10,304.85（结清额 + 0.01）', '拒收', '10304.84', errAtMost(r.err));
    r = await payOk(a, '2026-03-02', '10304.84');
    let v = await view(a); let x = expectCase(terms[a], pays[a]);
    cmpCase(g, 'A', '03-02 还 10,304.84 结清', x, v, ['outstanding', 'interest', 'paid', 'recovered', 'schedule']);
    chk(g, 'A.status', '状态', 'Fully Paid', v.status === 'Fully Paid', v.status); if (v.status === 'Fully Paid') paidOffToday.push(a);
    // edit cap (F-01 edit part)
    const e = await newC('编辑还款上限', A);
    await payOk(e, '2026-03-02', '1000');
    const pid = C.lastPaymentId(e);
    r = await s.post(`/cases/${e}/payments/${pid}`, { amount: '10304.85', payment_date: '2026-03-02', method: 'bank_transfer' });
    cmp(g, 'EDIT+0.01', '把 03-02 的 1,000 改为 10,304.85', '拒收（上限 = 当日结清额）', '10304.84', errAtMost(r.err));
    r = await s.post(`/cases/${e}/payments/${pid}`, { amount: '10304.84', payment_date: '2026-03-02', method: 'bank_transfer' });
    v = await view(e);
    chk(g, 'EDIT=sett', '改为 10,304.84', '接受，Fully Paid，Outstanding 0.00', r.ok === 'Payment updated' && v.status === 'Fully Paid' && v.outstanding === '0.00', `${r.ok || r.err}; ${v.status}; ${v.outstanding}`);
    if (v.status === 'Fully Paid') paidOffToday.push(e);
    // E2E-01 flow: start today, PTP 1000 fulfilled, Pay one instalment, then max
    const f = await newC('E2E-01 流程', { ...A, loan_start_date: T });
    r = await s.post(`/cases/${f}/ptps`, { amount: '1000', due_date: T });
    const ptp = C.q1("SELECT id FROM ptps WHERE case_id=? AND status='pending'", f);
    r = await s.post(`/ptps/${ptp.id}/fulfill`, { amount: '1000', payment_date: T, method: 'cash' });
    (pays[f] ||= []).push({ date: T, amount: '1000' });
    v = await view(f);
    cmp(g, 'E2E.afterPtp', 'PTP 1,000 当天履行后今日结清额', '10000 − 1000（当天利息 0）', '9000.00', v.settlement);
    chk(g, 'E2E.status1', '履行后状态', 'Partial Paid', v.status === 'Partial Paid', v.status);
    const row = v.schedule.find(rw => rw.pay);
    x = expectCase(terms[f], pays[f]);
    const firstOpen = x.rows.find(rw => F.of(rw.outstanding).isPos());
    const prefill = F.of(firstOpen.outstanding).min(x.settlement).r2();
    cmp(g, 'E2E.payPrefill', `计划 Pay 预填（最早未还清期 = 第 ${x.rows.indexOf(firstOpen) + 1} 期 ${firstOpen.due}）`, 'min(该期未还, 今日结清额)；PTP 的 1,000 已按 FIFO 冲掉前 6 期', prefill, row && row.pay);
    chk(g, 'E2E.paidAhead', 'PTP 1,000 当天全部冲本金后，计划前 6 期显示 Paid', '记录现状（见 B2 发现：计划 FIFO 与账本口径不一致）', x.rows.slice(0, 6).every(rw => rw.status === 'Paid'), (v.schedule || []).slice(0, 7).map(rw => rw.status).join(','));
    await payOk(f, T, row ? row.pay : prefill);
    v = await view(f);
    cmp(g, 'E2E.max', '再看 max（今日结清额）', `9000 − ${prefill}`, r2(F.of('9000').sub(prefill)), v.payMaxLabel);
    await payOk(f, T, v.payMaxLabel);
    v = await view(f); x = expectCase(terms[f], pays[f]);
    cmpCase(g, 'E2E', 'E2E-01 用 max 还清后', x, v, ['outstanding', 'interest', 'paid', 'recovered', 'schedule']);
    chk(g, 'E2E.status', 'E2E-01 状态', 'Fully Paid', v.status === 'Fully Paid', v.status); if (v.status === 'Fully Paid') paidOffToday.push(f);
    // fixed: settlement = full contract
    const fx1 = await newC('Fixed 提前结清', { principal_amount: 10000, interest_mode: 'fixed', interest_amount: 1200, loan_start_date: '2026-09-01', tenure: 12 });
    v = await view(fx1);
    cmp(g, 'FIXED.sett', 'Fixed 11,200 第 2 个月的今日结清额', 'Fixed 全额（D-02 演示前维持）', '11200.00', v.settlement);
    r = await C.pay(s, fx1, T, '11200.01');
    cmp(g, 'FIXED+0.01', 'Fixed 还 11,200.01', '拒收', 'Amount exceeds outstanding', r.err);
  }

  // ===================== RS: restructure (D-04, D-03) =====================
  {
    const g = 'RS';
    const b = await newC('示例B 重组', A);
    await payOk(b, '2026-03-02', '1000');
    let r = await s.post(`/cases/${b}/restructures`, { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'QA 示例B' });
    const rsB = [{ effective: '2026-04-01', mode: 'monthly', rate: 1.2, tenure: 18 }];
    let v = await view(b); let x = expectCase(terms[b], pays[b], rsB);
    chk(g, 'B.ok', '示例B 重组提交', 'Restructured', r.ok === 'Restructured', r.ok || r.err);
    cmp(g, 'B.cut', '示例B 截点本金 / 挂账欠息', '9304.84 / 9304.84×1.5%×30/31', `${x.cuts[0].principal}/${x.cuts[0].arrears}`, v.rsHist[0] ? `${v.rsHist[0].principal}/${v.rsHist[0].arrears}` : 'n/a');
    cmpCase(g, 'B', '示例B 重组后', x, v, ['outstanding', 'interest', 'maturity', 'settlement', 'dpd', 'overdue', 'schedule']);
    r = await C.pay(s, b, '2026-04-01', '100');
    cmp(g, 'B.payOnEff', '重组后补录生效日当天（04-01）的还款', '拒收（D-04：新还款须晚于生效日）', 'Payment date must be after the restructure date (2026-04-01)', r.err);
    await payOk(b, '2026-05-01', '500');
    v = await view(b); x = expectCase(terms[b], pays[b], rsB);
    cmpCase(g, 'B2', '示例B 重组后 05-01 还 500', x, v, ['outstanding', 'interest', 'settlement', 'dpd', 'overdue', 'schedule']);

    // same-day: pay on 06-01 then restructure effective 06-01
    const sd = await newC('同日先还款后重组 06-01', A);
    await payOk(sd, '2026-06-01', '5000');
    r = await s.post(`/cases/${sd}/restructures`, { effective_date: '2026-06-01', interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', reason: 'QA 同日' });
    const rsS = [{ effective: '2026-06-01', mode: 'monthly', rate: 1.5, tenure: 12 }];
    v = await view(sd); x = expectCase(terms[sd], pays[sd], rsS);
    cmp(g, 'SAME.cut', '06-01 还 5,000 后以 06-01 重组：截点', '本金 10000 −（5000 − 10000×1.5%×5）；挂账 0', `${x.cuts[0].principal}/${x.cuts[0].arrears}`, v.rsHist[0] ? `${v.rsHist[0].principal}/${v.rsHist[0].arrears}` : 'n/a');
    cmpCase(g, 'SAME', '同日还款后重组', x, v, ['outstanding', 'interest', 'settlement', 'dpd', 'overdue', 'schedule']);
    chk(g, 'SAME.undo', 'RS-16 生效日当天的还款不阻止撤销（有 Undo 按钮）', 'Undo 可见', v.html.includes('/undo"'), v.html.includes('/undo"') ? 'Undo 可见' : '无 Undo');

    // today: pay today, dialog, restructure today (RS-25)
    const td = await newC('今天先还款后重组', { ...A, loan_start_date: addMonths(T, -1) });
    await payOk(td, T, '2000');
    v = await view(td); x = ledger(loanOf(terms[td]), pays[td], { asOf: T, today: T });
    cmp(g, 'TODAY.dialog', 'RS-02/25 今天还 2,000 后重组弹窗“截至今天”', '本金 10000 −（2000 − 150）；未付利息 0', `${x.principalRemaining}/${x.interestUnpaid}`, v.cut ? `${v.cut.principal}/${v.cut.arrears}` : 'n/a');
    r = await s.post(`/cases/${td}/restructures`, { effective_date: T, interest_mode: 'monthly', interest_rate: '1.2', tenure: '12', reason: 'QA 今天' });
    const rsT = [{ effective: T, mode: 'monthly', rate: 1.2, tenure: 12 }];
    v = await view(td); x = expectCase(terms[td], pays[td], rsT);
    cmpCase(g, 'TODAY', '今天还款后今天重组', x, v, ['outstanding', 'settlement', 'schedule']);
    // raise / cap on restructure
    r = await s.post(`/cases/${td}/restructures`, { effective_date: T, interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', reason: 'x' });
    chk(g, 'TODAY.again', '同一天再重组', '拒收（下限 = 上次生效日次日）', /Effective date must be between/.test(r.err || ''), r.err || r.ok);
    const up = await newC('重组加息', { ...A, interest_rate: 1.2, loan_start_date: '2026-06-01' });
    r = await s.post(`/cases/${up}/restructures`, { effective_date: T, interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', reason: 'x' });
    cmp(g, 'RAISE', '1.2%/月 → 1.5%/月（RS-23）', '拒收', 'A restructure cannot raise the interest rate (14.4% → 18% p.a.)', r.err);
    r = await s.post(`/cases/${up}/restructures`, { effective_date: T, interest_mode: 'monthly', interest_rate: '2', tenure: '12', reason: 'x' });
    cmp(g, 'CAP', '重组为 2%/月（RS-24）', '拒收（上限优先）', 'Interest rate exceeds the 18% p.a. limit (this loan: 24% p.a.)', r.err);
    // fixed restructure 18.00 vs 18.01 vs 18.004 (cut principal 10,000 + carried)
    const fxr = async (lump, label) => {
      // N-09: only a fixed loan may be restructured to a fixed amount; base 1,800 / 12 months = 18% p.a.
      const id = await newC(`Fixed 重组 ${label}`, { principal_amount: 10000, interest_mode: 'fixed', interest_amount: 1800, loan_start_date: '2026-09-25', tenure: 12 });
      const cut = expectCase(terms[id]); const P = settlementOn(loanOf(terms[id]), [], T); void P; void cut;
      const rr = await s.post(`/cases/${id}/restructures`, { effective_date: T, interest_mode: 'fixed', interest_amount: String(lump), tenure: '12', reason: 'x' });
      return rr;
    };
    // cut principal = 10,000 (no payments) → nominal = lump/10000/(12/12)*100
    for (const [lump, expAccept] of [['1800', true], ['1801', false], ['1800.40', false]]) {
      r = await fxr(lump, lump);
      const nom = nominalRate({ mode: 'fixed', lump, tenure: 12 }, 10000);
      chk(g, `FIXCAP.${lump}`, `重组为 Fixed 利息 ${lump}、12 期（截点本金 10,000）名义年化 ${nom.r2()}…%`, expAccept ? '接受' : '拒收（> 18%）', expAccept ? r.ok === 'Restructured' : !!r.err, r.ok || r.err);
    }
    const rb = await newC('计息贷款重组为 Fixed', { ...A, loan_start_date: '2026-09-25' });
    r = await s.post(`/cases/${rb}/restructures`, { effective_date: T, interest_mode: 'fixed', interest_amount: '1800', tenure: '12', reason: 'x' });
    cmp(g, 'FIX.N09', '计息贷款重组为 Fixed（N-09，待律师）', '拒收', 'A rate-based loan cannot be restructured to a fixed amount (pending legal review)', r.err || r.ok);
    // interest ≤ principal on restructure: 750 (5 months) + 10000×1.25%×n
    for (const [n, expAccept] of [[74, true], [75, false]]) {
      const id = await newC(`重组总利息边界 ${n}期`, { ...A });
      r = await s.post(`/cases/${id}/restructures`, { effective_date: '2026-06-01', interest_mode: 'monthly', interest_rate: '1.25', tenure: String(n), reason: 'x' });
      const tot = ledger(loanOf(terms[id]), [], { restructures: [{ effective: '2026-06-01', mode: 'monthly', rate: 1.25, maturity: addMonths('2026-06-01', n) }] }).interest;
      // Over the line both caps refuse; the N-11 check (new interest + arrears ≤ remaining principal) runs first.
      chk(g, `TOTINT.${n}`, `06-01 重组为 1.25%/月 × ${n} 个月：总利息 ${tot}（本金 10,000）`, expAccept ? '接受（= 本金）' : '拒收（> 本金）', expAccept ? r.ok === 'Restructured'
        : ['Total interest cannot exceed the principal', 'Interest after the restructure plus carried arrears cannot exceed the remaining principal'].includes(r.err), r.ok || r.err);
    }
    // matured loan restructured today (RS-21)
    const mt = await newC('已到期贷款重组', { ...A, loan_start_date: '2025-01-01', tenure: 3 });
    r = await s.post(`/cases/${mt}/restructures`, { effective_date: T, interest_mode: 'monthly', interest_rate: '1', tenure: '12', reason: 'x' });
    v = await view(mt); x = expectCase(terms[mt], [], [{ effective: T, mode: 'monthly', rate: 1, tenure: 12 }]);
    cmp(g, 'MATURED.cut', 'RS-21 已到期贷款今天重组：挂账', '只计到原到期日 10000×1.5%×3', x.cuts[0].arrears, v.rsHist[0] && v.rsHist[0].arrears);
    cmpCase(g, 'MATURED', 'RS-21 重组后', x, v, ['outstanding', 'settlement', 'dpd', 'overdue']);
    // born delinquent: restructure 31 days ago with carried arrears
    const bd = await newC('重组生效日在 31 天前', { ...A });
    const eff = addDays(T, -31);
    r = await s.post(`/cases/${bd}/restructures`, { effective_date: eff, interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', reason: 'x' });
    v = await view(bd); x = expectCase(terms[bd], [], [{ effective: eff, mode: 'monthly', rate: 1.5, tenure: 12 }]);
    cmpCase(g, 'BORN', `生效日 ${eff} 重组（挂账欠息生效日即到期）`, x, v, ['dpd', 'overdue']);
  }

  // ===================== CAP: rate cap & interest ≤ principal at case creation (D-03) =====================
  {
    const g = 'CAP';
    const P = { principal_amount: 10000, loan_start_date: '2026-09-01', tenure: 12 };
    const cases = [
      ['monthly 1.5', { ...P, interest_mode: 'monthly', interest_rate: '1.5' }, true],
      ['monthly 1.5008', { ...P, interest_mode: 'monthly', interest_rate: '1.5008' }, false],
      ['monthly 1.50004', { ...P, interest_mode: 'monthly', interest_rate: '1.50004' }, false],
      ['monthly 1.6', { ...P, interest_mode: 'monthly', interest_rate: '1.6' }, false],
      ['daily 18', { ...P, interest_mode: 'daily', interest_rate: '18' }, true],
      ['daily 18.01', { ...P, interest_mode: 'daily', interest_rate: '18.01' }, false],
      ['daily 18.004', { ...P, interest_mode: 'daily', interest_rate: '18.004' }, false],
      ['fixed 1800/12', { ...P, interest_mode: 'fixed', interest_amount: '1800' }, true],
      ['fixed 1801/12', { ...P, interest_mode: 'fixed', interest_amount: '1801' }, false],
      ['fixed 1800.40/12', { ...P, interest_mode: 'fixed', interest_amount: '1800.40' }, false],
      ['fixed 1800.01/12', { ...P, interest_mode: 'fixed', interest_amount: '1800.01' }, false],
      ['fixed 9000 无期限', { principal_amount: 10000, interest_mode: 'fixed', interest_amount: '9000' }, false],
      // G-15: the unit is always months — 30 months is 6% p.a., so the tampered request is accepted as months.
      ['fixed 1500 期限30 tenure_unit=days（篡改请求）', { principal_amount: 10000, interest_mode: 'fixed', interest_amount: '1500', loan_start_date: '2026-10-01', tenure: '30', tenure_unit: 'days' }, true],
      ['monthly 1.25 × 80 期（总利息 = 本金）', { principal_amount: 10000, interest_mode: 'monthly', interest_rate: '1.25', loan_start_date: '2026-09-01', tenure: '80' }, true],
      ['monthly 1.25 × 81 期（101.25%）', { principal_amount: 10000, interest_mode: 'monthly', interest_rate: '1.25', loan_start_date: '2026-09-01', tenure: '81' }, false],
      ['monthly 1.5 × 120 期（INT-13）', { principal_amount: 10000, interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-09-01', tenure: '120' }, false],
      ['fixed 10000 / 120 期（= 本金，10% p.a.）', { principal_amount: 10000, interest_mode: 'fixed', interest_amount: '10000', loan_start_date: '2026-09-01', tenure: '120' }, true],
      ['fixed 10000.01 / 120 期', { principal_amount: 10000, interest_mode: 'fixed', interest_amount: '10000.01', loan_start_date: '2026-09-01', tenure: '120' }, false],
      ['monthly 1.5 无期限 起2023-01-01（至今 68.66%）', { principal_amount: 10000, interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2023-01-01' }, false],
      ['monthly 1.5 无期限 起2020-06-01（至今 > 本金）', { principal_amount: 10000, interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2020-06-01' }, false],
    ];
    for (const [label, t, expAccept] of cases) {
      const r = await C.newCase(s, debtor, t);
      const nom = nominalRate({ mode: t.interest_mode, rate: t.interest_rate, lump: t.interest_amount, tenure: t.tenure }, 10000);
      const life = t.tenure ? ledger(loanOf({ ...t, principal_amount: 10000 }), []).interest : null;
      chk(g, label, `建案 ${label}；名义年化 ${nom ? nom.r2() : '—'}%；合同总利息 ${life ?? '无期限/无法计算'}`, expAccept ? '接受' : '拒收', expAccept ? !!r.id : !r.id, r.id ? `接受（案件 ${r.id}）` : r.err);
      if (r.id) created.push({ id: r.id, label: 'CAP ' + label });
      if (r.id && t.tenure_unit === 'days') {
        const row = C.q1('SELECT tenure, tenure_unit, maturity_date FROM cases WHERE id=?', r.id);
        chk(g, label + '.stored', '同上：存储的期限单位（G-15）', '30 months，到期日 = 起始日 + 30 个月', row.tenure === 30 && row.tenure_unit === 'months' && row.maturity_date === addMonths('2026-10-01', 30), JSON.stringify(row));
      }
    }
  }

  // ===================== PTP: plans, cap, partial (D-10) =====================
  {
    const g = 'PTP';
    const fx = await newC('PTP 上限 Fixed 10000', { principal_amount: 10000, interest_mode: 'fixed', interest_amount: 0 });
    let r = await s.post(`/cases/${fx}/ptps`, { amount: '6000', due_date: addDays(T, 7) });
    chk(g, 'CAP.1', 'PTP 6,000（7 天后）', '接受', r.ok === 'PTP created', r.ok || r.err);
    r = await s.post(`/cases/${fx}/ptps`, { amount: '4000.01', due_date: addDays(T, 14) });
    cmp(g, 'CAP.2', '再建 4,000.01（14 天后），合计 10,000.01', '拒收：合计 > 最后到期日结清额 10,000', `Promised total RM 10,000.01 exceeds the settlement amount on ${addDays(T, 14)} (RM 10,000.00)`, r.err);
    r = await s.post(`/cases/${fx}/ptps`, { amount: '4000', due_date: addDays(T, 14) });
    chk(g, 'CAP.3', '再建 4,000，合计 10,000.00', '接受', r.ok === 'PTP created', r.ok || r.err);
    r = await s.post(`/cases/${fx}/ptps`, { amount: '10', due_date: addDays(T, -1) });
    cmp(g, 'DATE.past', 'PTP 到期日昨天', '拒收', 'Due date cannot be in the past', r.err);
    r = await s.post(`/cases/${fx}/ptps`, { amount: '10', due_date: '' });
    cmp(g, 'DATE.blank', 'PTP 到期日为空', '拒收', 'Invalid due date', r.err);
    r = await s.post(`/cases/${fx}/ptps`, { amount: '10', due_date: '2027-02-30' });
    cmp(g, 'DATE.bad', 'PTP 到期日 2027-02-30', '拒收', 'Invalid due date', r.err);
    // accrual cap: settlement on the promised date includes interest to that date
    const m = await newC('PTP 上限 Monthly 起今天', { ...A, loan_start_date: T });
    const loanM = loanOf(terms[m]); const d1 = addMonths(T, 1);
    const capToday = settlementOn(loanM, [], T), cap1 = settlementOn(loanM, [], d1);
    r = await s.post(`/cases/${m}/ptps`, { amount: r2(F.of(capToday).add('0.01')), due_date: T });
    cmp(g, 'MCAP.today', `今天到期 PTP ${r2(F.of(capToday).add('0.01'))}`, `拒收：上限 = 今日结清额 ${capToday}`, `Promised total RM ${Number(r2(F.of(capToday).add('0.01'))).toLocaleString('en-US', { minimumFractionDigits: 2 })} exceeds the settlement amount on ${T} (RM ${Number(capToday).toLocaleString('en-US', { minimumFractionDigits: 2 })})`, r.err);
    r = await s.post(`/cases/${m}/ptps`, { amount: r2(F.of(cap1).add('0.01')), due_date: d1 });
    chk(g, 'MCAP.1m+', `一个月后到期 PTP ${r2(F.of(cap1).add('0.01'))}`, `拒收：上限 = ${d1} 结清额 ${cap1}`, /exceeds the settlement amount/.test(r.err || ''), r.err || r.ok);
    r = await s.post(`/cases/${m}/ptps`, { amount: cap1, due_date: d1 });
    chk(g, 'MCAP.1m', `一个月后到期 PTP ${cap1}（= 当日结清额，含 1 个月利息）`, '接受', r.ok === 'PTP created', r.ok || r.err);
    // plans: split + dates + cap
    const pl = await newC('分期计划 Fixed 5000', { principal_amount: 5000, interest_mode: 'fixed', interest_amount: 0 });
    for (const [total, n, first] of [['1000', 3, '2026-11-30'], ['100', 7, '2027-01-31'], ['300', 3, '2028-01-31']]) {
      r = await s.post(`/cases/${pl}/ptp-plans`, { total_amount: total, num_installments: String(n), first_due_date: first });
      const rows = C.qa('SELECT amount, due_date FROM ptps WHERE case_id=? AND plan_id=(SELECT plan_id FROM ptps WHERE case_id=? AND installment_no=1 AND due_date=? ORDER BY id DESC LIMIT 1) ORDER BY installment_no', pl, pl, first);
      cmp(g, `PLAN.${total}/${n}.amt`, `分期 ${total} / ${n} 期`, '前 n−1 期向下取到分，末期吸收零头', splitEqual(total, n).join(','), rows.map(x => x.amount.toFixed(2)).join(','));
      cmp(g, `PLAN.${total}/${n}.dates`, `分期 ${total} / ${n} 期 首期 ${first}：到期日`, '按首期日的对应日逐月（月末对齐）', planDates(first, n).join(','), rows.map(x => x.due_date).join(','));
    }
    r = await s.post(`/cases/${pl}/ptp-plans`, { total_amount: '3600.01', num_installments: '2', first_due_date: addDays(T, 1) });
    chk(g, 'PLAN.cap', '同一案件再建分期 3,600.01（已承诺 1,400，结清额 5,000）', '拒收', /exceeds the settlement amount/.test(r.err || ''), r.err || r.ok);
    r = await s.post(`/cases/${pl}/ptp-plans`, { total_amount: '10', num_installments: '2', first_due_date: addDays(T, -1) });
    cmp(g, 'PLAN.past', '分期首期日期为昨天', '拒收', 'First due date cannot be in the past', r.err);
    const mp = await newC('分期上限 Monthly 起今天', { ...A, loan_start_date: T });
    const cap2 = settlementOn(loanOf(terms[mp]), [], addMonths(T, 2));
    r = await s.post(`/cases/${mp}/ptp-plans`, { total_amount: r2(F.of(cap2).add('0.01')), num_installments: '3', first_due_date: T });
    chk(g, 'PLAN.mcap+', `Monthly 分期 3 期首期今天，总额 ${r2(F.of(cap2).add('0.01'))}`, `拒收：上限 = 末期日 ${addMonths(T, 2)} 结清额 ${cap2}`, /exceeds the settlement amount/.test(r.err || ''), r.err || r.ok);
    r = await s.post(`/cases/${mp}/ptp-plans`, { total_amount: cap2, num_installments: '3', first_due_date: T });
    chk(g, 'PLAN.mcap', `同上总额 ${cap2}`, '接受', r.ok === 'Installment plan created', r.ok || r.err);
    // partially kept
    const pk = await newC('部分履行 Fixed 1000', { principal_amount: 1000, interest_mode: 'fixed', interest_amount: 0 });
    await s.post(`/cases/${pk}/ptps`, { amount: '1000', due_date: T });
    const p1 = C.q1("SELECT id FROM ptps WHERE case_id=? AND status='pending'", pk);
    r = await s.post(`/ptps/${p1.id}/fulfill`, { amount: '600', payment_date: T, method: 'cash' });
    (pays[pk] ||= []).push({ date: T, amount: '600' });
    let v = await view(pk);
    cmp(g, 'PK.status', 'PTP 1,000 只收 600：PTP 状态', 'partially kept（D-10）', 'partially kept', v.ptps[0] && v.ptps[0].status);
    chk(g, 'PK.timeline', '时间线', '“PTP partially kept: RM 600.00 of RM 1000.00”', v.timeline.some(e => e.text.includes('PTP partially kept: RM 600.00 of RM 1000.00')), v.timeline.filter(e => e.type === 'ptp_fulfilled').map(e => e.text).join(' | '));
    cmp(g, 'PK.noNew', '不自动生成新承诺：pending PTP 数', '0', '0', String(C.q1("SELECT COUNT(*) n FROM ptps WHERE case_id=? AND status='pending'", pk).n));
    cmp(g, 'PK.out', '部分履行后欠款', '1000 − 600', '400.00', v.outstanding);
    chk(g, 'PK.caseStatus', '部分履行后案件状态', 'Partial Paid（已无 pending PTP）', v.status === 'Partial Paid', v.status);
    // plan progress counts a partially kept instalment as kept
    const pp = await newC('分期部分履行', { principal_amount: 1000, interest_mode: 'fixed', interest_amount: 0 });
    await s.post(`/cases/${pp}/ptp-plans`, { total_amount: '300', num_installments: '3', first_due_date: T });
    const i1 = C.q1('SELECT id FROM ptps WHERE case_id=? AND installment_no=1', pp);
    await s.post(`/ptps/${i1.id}/fulfill`, { amount: '50', payment_date: T, method: 'cash' });
    (pays[pp] ||= []).push({ date: T, amount: '50' });
    v = await view(pp);
    chk(g, 'PLAN.kept', '分期 3 期，第 1 期 100 只收 50：标题行 “N/3 kept”', '0/3 kept（部分履行不应算 kept）', v.planHeads[0] && v.planHeads[0].kept === 0, v.planHeads[0] ? `${v.planHeads[0].kept}/${v.planHeads[0].size} kept` : 'n/a');
  }

  // ===================== DPD: boundaries & aging buckets (D-09) =====================
  {
    const g = 'DPD';
    for (const N of [0, 1, 30, 31, 60, 61, 90, 91]) {
      const before = await C.dashboard(s);
      const firstDue = addDays(T, -N); const start = addMonths(firstDue, -1);
      const id = await newC(`DPD=${N}`, { principal_amount: 1200, interest_mode: 'fixed', interest_amount: 0, loan_start_date: start, tenure: 12 });
      const v = await view(id); const x = expectCase(terms[id]);
      cmp(g, `N${N}.dpd`, `首期到期 ${firstDue}（起始 ${start}）：DPD`, `${T} − ${firstDue}`, x.dpd, v.dpd);
      cmp(g, `N${N}.overdue`, `同上：逾期金额`, '100 × 已到期期数', x.overdue, v.overdue);
      const after = await C.dashboard(s);
      const bucket = E.dpdBucket(x.dpd);
      const deltas = Object.keys(after.dpd).map(k => [k, r2(F.of(after.dpd[k]).sub(before.dpd[k]))]).filter(([, d]) => d !== '0.00');
      cmp(g, `N${N}.bucket`, `同上：仪表盘 Aging 档位变化`, `+1,200 落在 “${bucket}”`, `${bucket}:1200.00`, deltas.map(([k, d]) => `${k}:${d}`).join(',') || '无变化');
    }
    // prepayment: schedule FIFO vs ledger
    const pre = await newC('提前还本 overdue>结清额', { ...A, loan_start_date: '2025-10-01' });
    await payOk(pre, '2025-10-02', '5000');
    let v = await view(pre); let x = expectCase(terms[pre], pays[pre]);
    cmpCase(g, 'PRE', '2025-10-01 起、次日还 5,000、已到期', x, v, ['outstanding', 'settlement', 'dpd', 'overdue']);
    chk(g, 'PRE.biz', '业务预期：逾期金额不应超过今日结清额（总欠款）', `Overdue ≤ ${x.settlement}`, F.of(v.overdue || '0').cmp(v.settlement) <= 0, `Overdue ${v.overdue} vs Settlement ${v.settlement} / 合同欠款 ${v.outstanding}`);
    const pre2 = await newC('起始日还本 1000 DPD', { ...A, loan_start_date: addMonths(T, -6) });
    await payOk(pre2, addMonths(T, -6), '1000');
    v = await view(pre2); x = expectCase(terms[pre2], pays[pre2]);
    cmpCase(g, 'PRE2', `起始日（${addMonths(T, -6)}）还 1,000 冲本金、之后未付利息`, x, v, ['outstanding', 'settlement', 'dpd', 'overdue']);
    const accruedUnpaid = ledger(loanOf(terms[pre2]), pays[pre2], { asOf: addDays(T, -1), today: T }).interestUnpaid;
    if (v.dpd > 0) chk(g, 'PRE2.biz', '业务预期：账本上已产生且未付的利息 > 0 时，不应显示 up to date', `账本未付利息 ${accruedUnpaid}（截至昨天）→ DPD > 0`, true, `${v.dpdText}; Overdue ${v.overdue}`);
    else pending(g, 'PRE2.biz', '业务预期：账本上已产生且未付的利息 > 0 时，不应显示 up to date', `账本未付利息 ${accruedUnpaid}（截至昨天）→ DPD > 0`, `${v.dpdText}; Overdue ${v.overdue}`, 'N-06（DPD 按账本还是按计划）');
  }

  // ===================== COM: commission attribution (D-11) =====================
  {
    const g = 'COM';
    const aA = await C.newAgent(s, 'QA R2 Agent A', 5), aB = await C.newAgent(s, 'QA R2 Agent B', 7.5);
    // Started a month ago, so yesterday's backdated payment is after the loan start (N-14).
    const id = await newC('改派佣金', { principal_amount: 5000, interest_mode: 'fixed', interest_amount: 0, loan_start_date: addDays(T, -30), agent_id: aA });
    await payOk(id, T, '933.63');
    await s.post('/tasks/new', { case_id: String(id), title: 'QA 待办', type: 'follow_up', due_date: addDays(T, 3) });
    await s.post('/tasks/new', { case_id: String(id), title: 'QA 已完成', type: 'follow_up', due_date: T });
    const done = C.q1("SELECT id FROM tasks WHERE case_id=? AND title='QA 已完成'", id);
    await s.post(`/tasks/${done.id}/complete`, {});
    const r = await C.editCase(s, id, { agent_id: aB });
    chk(g, 'REASSIGN', '改派 A → B', 'Saved', r.ok === 'Saved', r.ok || r.err);
    await payOk(id, T, '1234.57');
    const backdated = addDays(T, -1);
    await payOk(id, backdated, '100');
    const month = T.slice(0, 7);
    const rows = await C.commissions(s, month);
    const rowA = rows.find(x => x.name === 'QA R2 Agent A'), rowB = rows.find(x => x.name === 'QA R2 Agent B');
    cmp(g, 'A.collected', 'A 本月 Collected（改派前收 933.63）', '933.63（D-11 归收款时催收员）', '933.63', rowA && rowA.collected);
    cmp(g, 'A.earned', 'A 本月 Earned', '933.63 × 5%', commission('933.63', 5), rowA && rowA.earned);
    const bBack = backdated.slice(0, 7) === month;
    cmp(g, 'B.collected', 'B 本月 Collected（改派后录入 1,234.57 + 补录昨天 100）', bBack ? '1334.57（系统按录入时的案件催收员）' : '1234.57', bBack ? '1334.57' : '1234.57', rowB && rowB.collected,
      'N-12 A：归录入时的催收员 B（写入使用手册）；G-31 待客户确认是否改为按收款日');
    cmp(g, 'B.earned', 'B 本月 Earned', '1334.57 × 7.5%', commission(bBack ? '1334.57' : '1234.57', 7.5), rowB && rowB.earned);
    const pay100 = C.q1('SELECT agent_id FROM payments WHERE case_id=? AND payment_date=?', id, backdated);
    // N-12 decided "A: the agent when it was entered" — so B; G-31 (by payment date → A) waits on the client.
    const who = !pay100 ? '未入账' : pay100.agent_id === aA ? 'A' : pay100.agent_id === aB ? 'B' : String(pay100.agent_id);
    chk(g, 'BACKDATE', `补录 ${backdated}（改派前那天）的 100 归属`, 'N-12 A：录入时的催收员 B', who === 'B', who);
    pending(g, 'BACKDATE.G31', '同上：若客户要求按收款日归属（G-31）', 'A（收款日负责的催收员）', who, 'N-12 / G-31，问客户');
    const tasks = C.qa('SELECT title, agent_id, status FROM tasks WHERE case_id=? ORDER BY id', id);
    chk(g, 'TASKS', '改派后任务：待办随案件转 B，已完成留 A', 'QA 待办→B；QA 已完成→A', tasks.find(t => t.title === 'QA 待办').agent_id === aB && tasks.find(t => t.title === 'QA 已完成').agent_id === aA, JSON.stringify(tasks));
    const rep = await C.reports(s);
    const pA = rep.perf.find(x => x.name === 'QA R2 Agent A'), pB = rep.perf.find(x => x.name === 'QA R2 Agent B');
    cmp(g, 'RPT.A', 'Reports 本月业绩 A：Collected/Commission', '同 Commissions 页', `${rowA.collected}/${rowA.earned}`, pA && `${pA.collected}/${pA.commission}`);
    cmp(g, 'RPT.B', 'Reports 本月业绩 B：Collected/Commission', '同 Commissions 页', `${rowB.collected}/${rowB.earned}`, pB && `${pB.collected}/${pB.commission}`);
    const perfCsv = await C.csv(s, '/reports?export=performance');
    const cA = perfCsv.rows.find(x => x[0] === 'QA R2 Agent A'), cB = perfCsv.rows.find(x => x[0] === 'QA R2 Agent B');
    cmp(g, 'CSV.A', 'agent-performance.csv A：Collected,Commission', '933.63 / 46.68（RPT-06 无尾差）', '933.63,46.68', cA && `${cA[1]},${cA[3]}`);
    cmp(g, 'CSV.B', 'agent-performance.csv B：Collected,Commission', `${rowB.collected} / ${rowB.earned}`, `${Number(rowB.collected)},${Number(rowB.earned)}`, cB && `${cB[1]},${cB[3]}`);
    const ag = await C.agentsList(s);
    const lA = ag.find(x => x.name === 'QA R2 Agent A'), lB = ag.find(x => x.name === 'QA R2 Agent B');
    cmp(g, 'AGT.A', 'Agents 页 A：案件数/Collected/Commission', '0 件（已改派）/933.63/46.68', '0/933.63/46.68', lA && `${lA.cases}/${lA.collected}/${lA.commission}`);
    cmp(g, 'AGT.B', 'Agents 页 B：案件数/Collected', `1/${rowB.collected}`, `1/${rowB.collected}`, lB && `${lB.cases}/${lB.collected}`);
    // settlement beyond earned → negative pending in red (K-05 known)
    await s.post('/commissions/settle', { agent_id: String(aA), amount: '50', period: month });
    const rows2 = await C.commissions(s, month); const a2 = rows2.find(x => x.name === 'QA R2 Agent A');
    chk(g, 'OVERSETTLE', 'A 结算 50.00 > Earned 46.68', 'Pending −3.32 红字（超额发放无硬拦截，K-05）', a2.pending === '-3.32' && a2.pendingRed, `${a2.pending} red=${a2.pendingRed}`);
    // void the 933.63 payment → A's earned falls retroactively
    const pid = C.q1('SELECT id FROM payments WHERE case_id=? AND amount=933.63', id).id;
    await s.post(`/cases/${id}/payments/${pid}/void`, {});
    pays[id] = pays[id].filter(p => p.amount !== '933.63');
    const rows3 = await C.commissions(s, month); const a3 = rows3.find(x => x.name === 'QA R2 Agent A');
    chk(g, 'VOID', '作废 A 收的 933.63 后 A 的本月 Earned/Pending', '0.00 / −50.00（追溯变动，K-05 快照延后）', a3.earned === '0.00' && a3.pending === '-50.00', `${a3.earned} / ${a3.pending}`);
    // receipt number after voiding the newest
    const lastNo = C.q1('SELECT receipt_no FROM payments ORDER BY id DESC LIMIT 1').receipt_no;
    const lid = C.lastPaymentId(id);
    await s.post(`/cases/${id}/payments/${lid}/void`, {});
    pays[id] = pays[id].filter(p => p.date !== backdated);
    await payOk(id, T, '1');
    const newNo = C.q1('SELECT receipt_no FROM payments ORDER BY id DESC LIMIT 1').receipt_no;
    chk(g, 'RCPT', `作废最新一笔 ${lastNo} 后再记一笔（B-06/F-03）`, '新号 ≠ 作废号', newNo !== lastNo, newNo);
  }

  fs.writeFileSync(path.join(C.DB_PATH, '..', 'calc-r2-run-state.json'), JSON.stringify({ T, created, paidOffToday, terms, pays }, null, 1));
}

function report() {
  const out = path.join(C.DB_PATH, '..');
  fs.writeFileSync(path.join(out, 'calc-r2-results.json'), JSON.stringify(results, null, 1));
  const groups = [...new Set(results.map(r => r.g))];
  const lines = [`# calc-r2 run ${T}`, '', '| 组 | 合计 | PASS | FAIL | INFO |', '|---|---|---|---|---|'];
  for (const g of groups) { const rs = results.filter(r => r.g === g); lines.push(`| ${g} | ${rs.length} | ${rs.filter(r => r.result === 'PASS').length} | ${rs.filter(r => r.result === 'FAIL').length} | ${rs.filter(r => r.result === 'INFO').length} |`); }
  lines.push('', '| ID | 场景 | 算式 | 预期 | 实际 | 结果 | 备注 |', '|---|---|---|---|---|---|---|');
  const esc = x => String(x).replace(/\|/g, '/').replace(/\n/g, ' ');
  for (const r of results) lines.push(`| ${r.g}#${esc(r.id)} | ${esc(r.scenario)} | ${esc(r.formula)} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.result} | ${esc(r.note)} |`);
  fs.writeFileSync(path.join(out, 'calc-r2-results.md'), lines.join('\n'));
  const tot = results.filter(r => r.result !== 'INFO');
  console.log(`items ${tot.length}, pass ${tot.filter(r => r.result === 'PASS').length}, fail ${tot.filter(r => r.result === 'FAIL').length}`);
  for (const r of results.filter(x => x.result === 'FAIL')) console.log('FAIL', `${r.g}#${r.id}`, '|', r.scenario, '| exp', r.expected, '| act', r.actual);
}
main().then(report, e => { report(); console.error(e); process.exit(1); });
