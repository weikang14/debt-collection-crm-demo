// Manual chapters 4.9 PTP and 4.10 RS.
// Run: node --test tests/qa/m3-ptp-rs.qa.js
const { test, before, after } = require('node:test');
const C = require('./_client');
const { as, check, q1, qa, has, strip, ledgerAmt, ledgerVal, today, addDays, newDebtor, newCase, money } = C;

before(() => C.reseed());
after(() => C.saveResults('m3'));

const S = {}; let D;
const page = async (id, s = S.admin) => (await s.get(`/cases/${id}`)).text;
const caseRow = id => q1('SELECT * FROM cases WHERE id=?', id);
function schedule(html) {
  const i = html.indexOf('<h2>Repayment Schedule'); if (i < 0) return null;
  const sec = html.slice(i, html.indexOf('</table>', i));
  return [...sec.matchAll(/<tr>\s*<td>([\d-]+)( <small[^>]*>· Arrears \(carried\)<\/small>)?<\/td>\s*<td class="num">([\d,.]+)<\/td>\s*<td class="num">([\d,.]+)<\/td>\s*<td class="num">([\d,.]+)<\/td>\s*<td><span class="badge [^"]*">([^<]+)<\/span><\/td>/g)]
    .map(m => ({ due: m[1], arrears: !!m[2], exp: m[3], paid: m[4], out: m[5], status: m[6] }));
}
const ptpRows = t => { const i = t.indexOf('<h2>Promise to Pay</h2>'); const sec = t.slice(i, t.indexOf('</section>', i)); return sec; };
test('setup', async () => {
  for (const u of ['admin', 'manager', 'agent1', 'agent2', 'finance', 'auditor']) S[u] = await as(u);
  D = await newDebtor(S.admin, 'QA PTP 债务人');
});
const mk = o => newCase(S.admin, { debtor_id: String(D), agent_id: '1', interest_mode: 'fixed', interest_amount: '0', status: 'assigned', ...o });

// ---------------- PTP ----------------
let P1;
test('PTP-01 新建 PTP（agent1 本人案件）', async () => {
  P1 = await mk({ principal_amount: '3000' });
  const r = await S.agent1.post(`/cases/${P1}/ptps`, { amount: '500', due_date: addDays(today(), 7), remark: 'QA ptp' });
  const t = await page(P1, S.agent1);
  const a = q1("SELECT * FROM audit_logs WHERE action='ptp_create' AND entity_id=?", P1);
  check('PTP-01', 'PTP created；状态 PTP；金色时间线；audit ptp_create', r.ok === 'PTP created' && caseRow(P1).status === 'ptp' && has(t, '<span class="badge is-gold">ptp_created</span>') && has(t, `PTP RM 500.00 due ${addDays(today(), 7)}`) && !!a, `${r.ok}; status=${caseRow(P1).status}; audit=${!!a}`);
});
test('PTP-02 金额上限', async () => {
  const t = await page(P1, S.agent1);
  const attr = new RegExp(`<h3>New PTP</h3>\\s*<label>Amount \\(RM\\)[^<]*<small[^>]*>[^<]*</small> <input type="number" step="0.01" min="0.01" max="3000" name="amount" required>`).test(t);
  const r = await S.agent1.post(`/cases/${P1}/ptps`, { amount: '3000.01', due_date: today() });
  check('PTP-02', '浏览器 max；服务端 Amount exceeds outstanding', attr && r.err === 'Amount exceeds outstanding', `max 属性=${attr}; ${r.err}`);
});
test('PTP-03 履行', async () => {
  const p = q1("SELECT * FROM ptps WHERE case_id=? AND status='pending'", P1);
  const t = await page(P1, S.agent1);
  const pre = has(t, `onclick="openFulfill(${p.id}, 500)"`);
  const r = await S.agent1.post(`/ptps/${p.id}/fulfill`, { amount: '500', payment_date: today(), method: 'cash' });
  const pay = q1('SELECT * FROM payments WHERE case_id=? ORDER BY id DESC', P1);
  const a1 = q1("SELECT 1 x FROM audit_logs WHERE action='payment' AND entity_id=?", P1); const a2 = q1("SELECT 1 x FROM audit_logs WHERE action='ptp_fulfilled' AND entity_id=?", P1);
  check('PTP-03', 'PTP fulfilled and payment recorded；fulfilled；自动还款备注 PTP fulfilled；欠款减少；audit 两条', pre && r.ok === 'PTP fulfilled and payment recorded' && q1('SELECT status FROM ptps WHERE id=?', p.id).status === 'fulfilled' && pay.remark === 'PTP fulfilled' && pay.amount === 500 && caseRow(P1).outstanding_amount === 2500 && a1 && a2,
    `金额预填=${pre}; ${r.ok}; payment ${pay.receipt_no} remark=${pay.remark}; 欠款=${caseRow(P1).outstanding_amount}; status=${caseRow(P1).status}`);
});
test('PTP-05 重复履行', async () => {
  const p = q1("SELECT * FROM ptps WHERE case_id=? AND status='fulfilled'", P1);
  const n0 = q1('SELECT COUNT(*) c FROM payments WHERE case_id=?', P1).c;
  const r = await S.agent1.post(`/ptps/${p.id}/fulfill`, { amount: '500', payment_date: today() });
  check('PTP-05', 'PTP already resolved，不重复记账', r.err === 'PTP already resolved' && q1('SELECT COUNT(*) c FROM payments WHERE case_id=?', P1).c === n0, `${r.err}; 还款笔数 ${n0}→${q1('SELECT COUNT(*) c FROM payments WHERE case_id=?', P1).c}`);
});
test('PTP-04 违约', async () => {
  const id = await mk({ principal_amount: '1000', status: 'negotiation' });
  await S.agent1.post(`/cases/${id}/ptps`, { amount: '100', due_date: today() });
  const p = q1('SELECT id FROM ptps WHERE case_id=?', id);
  const t = await page(id, S.agent1);
  const noConfirm = has(t, `<form method="post" action="/ptps/${p.id}/break" style="margin:0;"><button`);
  const s1 = caseRow(id).status;
  const r = await S.agent1.post(`/ptps/${p.id}/break`, {});
  check('PTP-04', 'PTP broken；broken；无其他 pending 时回 Negotiation（无确认框 E-12）', r.ok === 'PTP broken' && q1('SELECT status FROM ptps WHERE id=?', p.id).status === 'broken' && s1 === 'ptp' && caseRow(id).status === 'negotiation' && noConfirm, `${r.ok}; 状态 ${s1}→${caseRow(id).status}; Break 无确认框=${noConfirm}`);
});
let PL, planId;
test('PTP-06 新建分期计划', async () => {
  PL = await mk({ principal_amount: '5000' });
  const r = await S.agent1.post(`/cases/${PL}/ptp-plans`, { total_amount: '1000', num_installments: '3', first_due_date: '2026-01-31' });
  const rows = qa('SELECT * FROM ptps WHERE case_id=? ORDER BY installment_no', PL); planId = rows[0].plan_id;
  const t = await page(PL, S.agent1);
  check('PTP-06', '3 条 333.33/333.33/333.34，到期日按月顺延（月末对齐）；标题 0/3 paid；状态 PTP', r.ok === 'Installment plan created' && rows.map(x => x.amount).join() === '333.33,333.33,333.34' && rows.map(x => x.due_date).join() === '2026-01-31,2026-02-28,2026-03-31' && has(t, '<b>Installment Plan</b> · RM 1,000.00 · 0/3 paid') && caseRow(PL).status === 'ptp',
    `${r.ok}; ${rows.map(x => `${x.amount}@${x.due_date}`).join(' ')}; 标题=${has(t, '0/3 paid')}; status=${caseRow(PL).status}`);
});
test('PTP-07 期数校验', async () => {
  const t = await page(PL, S.agent1);
  const a = await S.agent1.post(`/cases/${PL}/ptp-plans`, { total_amount: '100', num_installments: '1', first_due_date: today() });
  const b = await S.agent1.post(`/cases/${PL}/ptp-plans`, { total_amount: '100', num_installments: '61', first_due_date: today() });
  check('PTP-07', '浏览器拦截；服务端 Installments must be 2–60', /min="2" max="60" step="1" name="num_installments"/.test(t) && a.err === 'Installments must be 2–60' && b.err === a.err, `1→${a.err}; 61→${b.err}`);
});
test('PTP-08 总额过小', async () => {
  const r = await S.agent1.post(`/cases/${PL}/ptp-plans`, { total_amount: '0.01', num_installments: '2', first_due_date: today() });
  check('PTP-08', 'Total too small for the number of installments', r.err === 'Total too small for the number of installments', r.err);
});
test('PTP-09 逐期履行', async () => {
  const p = q1('SELECT * FROM ptps WHERE plan_id=? AND installment_no=1', planId);
  const r = await S.agent1.post(`/ptps/${p.id}/fulfill`, { amount: String(p.amount), payment_date: today(), method: 'cash' });
  const t = await page(PL, S.agent1);
  check('PTP-09', '标题 1/3 paid；状态保持 PTP', r.ok && has(t, '· 1/3 paid') && caseRow(PL).status === 'ptp', `${r.ok}; 1/3=${has(t, '· 1/3 paid')}; status=${caseRow(PL).status}`);
});
test('PTP-10 取消计划', async () => {
  const t0 = await page(PL, S.agent1);
  const confirm = has(t0, "onsubmit=\"return confirm('Cancel this installment plan?");
  const r = await S.agent1.post(`/cases/${PL}/ptp-plans/${planId}/cancel`, {});
  const rows = qa('SELECT status FROM ptps WHERE plan_id=? ORDER BY installment_no', planId).map(x => x.status);
  const t = await page(PL, S.agent1);
  const a = q1("SELECT * FROM audit_logs WHERE action='ptp_plan_cancel' AND entity_id=?", PL);
  check('PTP-10', 'pending 期变 broken；时间线 Installment plan cancelled (N…)；回 Negotiation；audit', r.ok === 'Installment plan cancelled' && rows.join() === 'fulfilled,broken,broken' && has(t, 'Installment plan cancelled (2 pending installment(s) broken)') && caseRow(PL).status === 'negotiation' && !!a && confirm,
    `${r.ok}; ${rows}; status=${caseRow(PL).status}; 确认框=${confirm}; audit=${!!a}`);
});
test('PTP-11 权限与范围', async () => {
  const id = 14; // agent2 case with pending demo PTP
  const p = q1("SELECT id FROM ptps WHERE case_id=14 AND status='pending'");
  const out = [];
  for (const u of ['finance', 'auditor']) { const t = await page(id, S[u]); out.push(`${u}: fulfill=${has(t, 'onclick="openFulfill(')} break=${has(t, '/break"')} cancel=${has(t, 'Cancel plan</button>')}`); }
  const f = await S.agent1.post(`/ptps/${p.id}/fulfill`, { amount: '1', payment_date: today() });
  const b = await S.agent1.post(`/ptps/${p.id}/break`, {});
  const st = q1('SELECT status FROM ptps WHERE id=?', p.id).status;
  check('PTP-11', 'finance/auditor 无按钮；agent1 越权 403', out.every(x => /fulfill=false break=false cancel=false/.test(x)) && f.status === 403 && b.status === 403 && st === 'pending', `${out.join('; ')}; agent1 fulfill ${f.status} break ${b.status}; PTP 仍 ${st}`);
});

// ---------------- RS ----------------
let R; // manual 5.2/5.3 example case
test('RS-01 按钮可见性', async () => {
  R = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12', status: 'assigned' });
  await S.admin.post(`/cases/${R}/payments`, { payment_date: '2026-03-02', amount: '1000' });
  const vis = {};
  for (const u of ['admin', 'manager', 'agent1', 'finance', 'auditor']) vis[u] = has(await page(R, S[u]), '>Restructure</button>');
  const closed = await mk({ principal_amount: '100' }); await S.admin.post(`/cases/${closed}/status`, { status: 'closed' });
  const canc = await mk({ principal_amount: '100' }); await S.admin.post(`/cases/${canc}/status`, { status: 'cancelled' });
  const paid = await mk({ principal_amount: '100' }); await S.admin.post(`/cases/${paid}/payments`, { payment_date: today(), amount: '100' });
  for (const [k, id] of Object.entries({ closed, canc, paid })) vis[k] = has(await page(id), '>Restructure</button>');
  check('RS-01', '仅 admin/manager 打开未结清案件可见', vis.admin && vis.manager && !vis.agent1 && !vis.finance && !vis.auditor && !vis.closed && !vis.canc && !vis.paid, JSON.stringify(vis));
});
test('RS-02 弹窗信息', async () => {
  const t = await page(R);
  const m = t.match(/Remaining principal RM ([\d,.]+) · unpaid interest RM ([\d,.]+) as of today/);
  const d = t.match(/name="effective_date" min="([\d-]+)" max="([\d-]+)" value="([\d-]+)"/);
  const days = (Date.parse(today()) - Date.parse('2026-03-02')) / 86400000; const expInt = money(9300 * 0.0005 * days);
  check('RS-02', '显示截至今天剩余本金/未付利息；默认今天；下限=起算日/最近还款日/上次重组次日最晚者；上限今天', m && m[1] === '9,300.00' && m[2] === expInt && d && d[1] === '2026-03-02' && d[2] === today() && d[3] === today(), `本金 ${m && m[1]} 利息 ${m && m[2]}（期望 ${expInt}）; min=${d && d[1]} max=${d && d[2]} value=${d && d[3]}`);
});
test('RS-05 必填校验（含留空利率不当 0%）', async () => {
  const base = { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'qa' };
  const r = {};
  r.rate = (await S.admin.post(`/cases/${R}/restructures`, { ...base, interest_rate: '' })).err;
  r.amt = (await S.admin.post(`/cases/${R}/restructures`, { ...base, interest_mode: 'fixed', interest_rate: '', interest_amount: '' })).err;
  r.tenure = (await S.admin.post(`/cases/${R}/restructures`, { ...base, tenure: '' })).err;
  r.reason = (await S.admin.post(`/cases/${R}/restructures`, { ...base, reason: '   ' })).err;
  const n = q1('SELECT COUNT(*) c FROM case_restructures WHERE case_id=?', R).c;
  check('RS-05', '依次提示 Interest rate is required / Interest amount is required / Tenure must be 1–120 months / Reason is required；未建重组', r.rate === 'Interest rate is required' && r.amt === 'Interest amount is required' && r.tenure === 'Tenure must be 1–120 months' && r.reason === 'Reason is required' && n === 0, JSON.stringify(r) + ` 重组数=${n}`);
});
test('RS-06 期限范围', async () => {
  const base = { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', reason: 'qa' };
  const e = [];
  for (const t of ['0', '121', '1.5']) e.push((await S.admin.post(`/cases/${R}/restructures`, { ...base, tenure: t })).err);
  check('RS-06', '0/121/1.5 均提示 Tenure must be 1–120 months', e.every(x => x === 'Tenure must be 1–120 months'), e.join(' | '));
});
test('RS-07 生效日越界', async () => {
  const base = { interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'qa' };
  const a = (await S.admin.post(`/cases/${R}/restructures`, { ...base, effective_date: '2026-03-01' })).err;
  const b = (await S.admin.post(`/cases/${R}/restructures`, { ...base, effective_date: addDays(today(), 1) })).err;
  const exp = `Effective date must be between 2026-03-02 and ${today()}`;
  check('RS-07', 'Effective date must be between 下限 and 今天', a === exp && b === exp, `${a} | ${b}`);
});
let rid;
test('RS-08 重组成功', async () => {
  const r = await S.manager.post(`/cases/${R}/restructures`, { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'QA 降低月供' });
  rid = q1('SELECT id FROM case_restructures WHERE case_id=?', R).id;
  const t = await page(R);
  const tl = has(t, '<span class="badge is-gold">restructure</span>') && has(t, 'Restructure: from 2026-04-01, 1.2%/month, 18 months. Principal RM 9,300.00, arrears RM 139.50 carried. Reason: QA 降低月供');
  const a = q1("SELECT * FROM audit_logs WHERE action='restructure' AND entity_id=?", R);
  check('RS-08', 'Restructured；Maturity=生效日+18 月；Restructured on；金色时间线；audit', r.ok === 'Restructured' && ledgerVal(t, 'Maturity Date') === '2027-10-01' && has(t, 'Restructured on 2026-04-01') && tl && !!a, `${r.ok}; Maturity=${ledgerVal(t, 'Maturity Date')}; 时间线=${tl}; audit=${a && a.details}`);
});
test('RS-09 新还款计划', async () => {
  const t = await page(R); const s = schedule(t);
  check('RS-09', '标题 since restructure on 日期；首行挂账 2026-04-01 139.50；之后 18 期', has(t, '<h2>Repayment Schedule <small style="color:var(--muted)">· since restructure on 2026-04-01</small>') && s[0].arrears && s[0].due === '2026-04-01' && s[0].exp === '139.50' && s.length === 19 && s[1].due === '2026-05-01',
    `首行 ${JSON.stringify(s[0])}; 行数 ${s.length}; 第2行 ${s[1].due} ${s[1].exp}`);
});
test('RS-10 重组历史', async () => {
  const t = await page(R);
  const sec = t.slice(t.indexOf('<h2>Restructure History</h2>'), t.indexOf('<h2>Payments</h2>'));
  const ok = has(sec, '<b>2026-04-01</b> · 1.2%/month · 18 months · by Collection Manager') && has(sec, 'Principal at cut RM 9,300.00 · Arrears carried RM 139.50') && has(sec, 'Reason: QA 降低月供') && has(sec, 'Superseded schedule (12 rows)') && has(sec, '>Restructured</span>');
  check('RS-10', '卡片显示生效日/新条款/期限/操作人/截点本金/挂账欠息/原因；Superseded 未还期显示 Restructured', ok, strip(sec).slice(0, 260));
});
test('RS-11 欠息不再生息', async () => {
  const t = await page(R);
  check('RS-11', '挂账 139.50；Total 11,478.06；总利息 2,478.06', ledgerAmt(t) === '11,478.06' && ledgerVal(t, 'Interest') === '2,478.06' && q1('SELECT arrears_at_cut a FROM case_restructures WHERE id=?', rid).a === 139.5, `Total=${ledgerAmt(t)} Interest=${ledgerVal(t, 'Interest')}`);
});
test('RS-12 旧还款锁定', async () => {
  const t = await page(R, S.finance); const p = q1('SELECT id FROM payments WHERE case_id=?', R);
  const e = await S.finance.post(`/cases/${R}/payments/${p.id}`, { amount: '900', payment_date: '2026-03-02' });
  const v = await S.finance.post(`/cases/${R}/payments/${p.id}/void`, {});
  const msg = 'This payment belongs to a restructured period; undo the restructure first';
  check('RS-12', 'Locked · restructured，无 Edit/Void；直接提交提示锁定', has(t, 'Locked · restructured') && !has(t, 'onclick="openEditPayment(') && e.err === msg && v.err === msg && q1('SELECT amount FROM payments WHERE id=?', p.id).amount === 1000, `edit→${e.err}; void→${v.err}`);
});
test('RS-13 新还款日期下限', async () => {
  const t = await page(R, S.finance);
  const r = await S.finance.post(`/cases/${R}/payments`, { payment_date: '2026-03-15', amount: '10' });
  check('RS-13', '日期框 min=生效日；绕过提示 Payment date must be on or after the restructure date (日期)', has(t, '<input type="date" name="payment_date" required min="2026-04-01">') && r.err === 'Payment date must be on or after the restructure date (2026-04-01)', r.err);
});
test('RS-14 案件条款锁定', async () => {
  const t = (await S.admin.get(`/cases/${R}/edit`)).text; const c0 = caseRow(R);
  const ui = has(t, 'Loan terms are locked after a restructure') && /name="principal_amount"[^>]*readonly/.test(t) && /name="loan_start_date"[^>]*readonly/.test(t) && /id="tenure"[^>]*readonly/.test(t) && /name="interest_rate"[^>]*readonly/.test(t) && /id="interest_mode" disabled/.test(t) && !has(t, 'class="chip-row"');
  const r = await S.admin.post(`/cases/${R}`, { debtor_id: String(c0.debtor_id), agent_id: '2', principal_amount: '1', interest_mode: 'fixed', interest_amount: '0', interest_rate: '0', loan_start_date: '2020-01-01', tenure: '1', priority: 'urgent', remark: 'QA 篡改' });
  const c1 = caseRow(R);
  const same = ['principal_amount', 'interest_mode', 'interest_rate', 'interest_amount', 'loan_start_date', 'tenure', 'maturity_date'].every(k => c1[k] === c0[k]);
  check('RS-14', '提示锁定；条款只读/禁用；快捷按钮隐藏；其他字段可保存；篡改不改条款', ui && r.ok === 'Saved' && same && c1.priority === 'urgent' && c1.agent_id === 2, `UI 锁定=${ui}; ${r.ok}; 条款未变=${same}; priority=${c1.priority} agent=${c1.agent_id}; Total=${ledgerAmt(await page(R))}`);
});
test('PTP-12 重组后的履行日期', async () => {
  await S.admin.post(`/cases/${R}/ptps`, { amount: '100', due_date: today() });
  const p = q1("SELECT id FROM ptps WHERE case_id=? AND status='pending'", R);
  const t = await page(R);
  const r = await S.admin.post(`/ptps/${p.id}/fulfill`, { amount: '100', payment_date: '2026-03-20', method: 'cash' });
  check('PTP-12', '日期框不能早于生效日；绕过提示 Payment date must be on or after the restructure date (日期)', /<h3>Fulfill PTP[\s\S]*?<input type="date" name="payment_date" required min="2026-04-01">/.test(t) && r.err === 'Payment date must be on or after the restructure date (2026-04-01)' && q1('SELECT status FROM ptps WHERE id=?', p.id).status === 'pending', r.err);
  await S.admin.post(`/ptps/${p.id}/break`, {});
});
let payToday;
test('RS-16 撤销受限', async () => {
  await S.finance.post(`/cases/${R}/payments`, { payment_date: today(), amount: '100' });
  payToday = q1('SELECT id FROM payments WHERE case_id=? ORDER BY id DESC', R).id;
  const t = await page(R);
  const u = await S.manager.post(`/cases/${R}/restructures/${rid}/undo`, {});
  await S.finance.post(`/cases/${R}/payments/${payToday}/void`, {});
  const t2 = await page(R);
  check('RS-16', '生效日后有还款时 Undo 消失；直接提交提示 Payments exist…；作废后可撤销', !has(t, '>Undo</button>') && u.err === 'Payments exist on or after the effective date; void them first' && has(t2, '>Undo</button>'), `有还款时 Undo=${has(t, '>Undo</button>')}; 提交→${u.err}; 作废后 Undo=${has(t2, '>Undo</button>')}`);
});
test('RS-15 撤销重组', async () => {
  const t0 = await page(R); const confirm = has(t0, `onsubmit="return confirm('Undo this restructure?')"`);
  const r = await S.manager.post(`/cases/${R}/restructures/${rid}/undo`, {});
  const t = await page(R); const e = (await S.admin.get(`/cases/${R}/edit`)).text;
  const a = q1("SELECT * FROM audit_logs WHERE action='restructure_undo' AND entity_id=?", R);
  check('RS-15', 'Restructure undone；恢复原条款；时间线 Restructure undone: from 日期；audit；Edit Case 解锁', confirm && r.ok === 'Restructure undone' && ledgerAmt(t) === '10,718.25' && has(t, 'Restructure undone: from 2026-04-01') && !!a && !has(e, 'Loan terms are locked') && has(e, 'class="chip-row"'),
    `${r.ok}; Total=${ledgerAmt(t)}; 解锁=${!has(e, 'Loan terms are locked')}; audit=${!!a}`);
});
test('RS-17 多次重组', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), principal_amount: '5000', interest_mode: 'monthly', interest_rate: '1', loan_start_date: '2026-01-01', tenure: '12' });
  const b = { interest_mode: 'monthly', interest_rate: '1', tenure: '6', reason: 'qa' };
  await S.admin.post(`/cases/${id}/restructures`, { ...b, effective_date: '2026-05-01' });
  const same = (await S.admin.post(`/cases/${id}/restructures`, { ...b, effective_date: '2026-05-01' })).err;
  const ok2 = (await S.admin.post(`/cases/${id}/restructures`, { ...b, effective_date: '2026-06-01', interest_rate: '0.8' })).ok;
  const [r1, r2] = qa('SELECT id, effective_date FROM case_restructures WHERE case_id=? ORDER BY effective_date', id);
  const t = await page(id);
  const sec = t.slice(t.indexOf('<h2>Restructure History</h2>'), t.indexOf('<h2>Payments</h2>'));
  const undoCnt = (sec.match(/>Undo<\/button>/g) || []).length;
  const top = sec.indexOf('<b>2026-06-01</b>') < sec.indexOf('<b>2026-05-01</b>');
  const old = (await S.admin.post(`/cases/${id}/restructures/${r1.id}/undo`, {})).err;
  check('RS-17', '新生效日≥上次次日；新的在上；只有最新有 Undo；撤销较早提示 Only the latest restructure can be undone', same === `Effective date must be between 2026-05-02 and ${today()}` && ok2 === 'Restructured' && top && undoCnt === 1 && has(sec, `/restructures/${r2.id}/undo`) && old === 'Only the latest restructure can be undone',
    `同日→${same}; 第二次→${ok2}; 新在上=${top}; Undo 数=${undoCnt}; 撤销旧→${old}`);
});
test('RS-03 没有可选日期（当天已重组）', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), principal_amount: '5000', interest_mode: 'monthly', interest_rate: '1', loan_start_date: '2026-01-01', tenure: '12' });
  await S.admin.post(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1', tenure: '6', reason: 'qa' });
  const t = await page(id);
  check('RS-03', '红色提示 No valid effective date today — it must be on or after …', has(t, `<div class="alert is-red">No valid effective date today — it must be on or after ${addDays(today(), 1)}.</div>`), (t.match(/No valid effective date[^<]*/) || ['无'])[0]);
});
test('RS-18 Fixed 重组', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), principal_amount: '10000', interest_mode: 'fixed', interest_amount: '1200', loan_start_date: '2026-01-01', tenure: '12' });
  const r = await S.admin.post(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'fixed', interest_amount: '500', tenure: '12', reason: 'qa fixed' });
  const s = schedule(await page(id));
  check('RS-18', '（截点本金+500）/12 等额；挂账行最前', r.ok === 'Restructured' && s[0].arrears && s[0].exp === '1,200.00' && s.length === 13 && s.slice(1).every(x => x.exp === '875.00') && ledgerAmt(await page(id)) === '11,700.00', `首行 ${s[0].exp}(arrears=${s[0].arrears}); 其余 ${[...new Set(s.slice(1).map(x => x.exp))]}; 行数 ${s.length}`);
});
test('RS-19 权限', async () => {
  const id = R; const out = [];
  for (const u of ['agent1', 'finance']) {
    const a = await S[u].post(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1', tenure: '6', reason: 'x' });
    const b = await S[u].post(`/cases/${id}/restructures/1/undo`, {});
    out.push(`${u}:${a.status}/${b.status}`);
  }
  check('RS-19', 'agent、finance 返回 403', out.every(x => /:403\/403$/.test(x)) && q1('SELECT COUNT(*) c FROM case_restructures WHERE case_id=?', id).c === 0, out.join(' '));
});
test('RS-20 不可重组', async () => {
  const b = { effective_date: today(), interest_mode: 'monthly', interest_rate: '1', tenure: '6', reason: 'x' };
  const out = [];
  for (const st of ['closed', 'cancelled']) { const id = await mk({ principal_amount: '100' }); await S.admin.post(`/cases/${id}/status`, { status: st }); out.push((await S.admin.post(`/cases/${id}/restructures`, b)).err); }
  const z = await mk({ principal_amount: '100' }); await S.admin.post(`/cases/${z}/payments`, { payment_date: today(), amount: '100' });
  out.push((await S.admin.post(`/cases/${z}/restructures`, b)).err);
  check('RS-20', 'This case cannot be restructured', out.every(x => x === 'This case cannot be restructured'), out.join(' | '));
});
test('RS-21 已到期贷款重组', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2025-01-01', tenure: '6' });
  await page(id);
  await S.admin.post(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1', tenure: '12', reason: 'matured' });
  const r = q1('SELECT * FROM case_restructures WHERE case_id=?', id);
  check('RS-21', '截点欠息只计到原到期日（2025-07-01，181 天 = 905.00）', r.arrears_at_cut === 905 && r.principal_at_cut === 10000, `arrears_at_cut=${r.arrears_at_cut} principal_at_cut=${r.principal_at_cut}`);
});
test('RS-22 演示案件 14', async () => {
  const t = await page(14); const s = schedule(t); const eff = addDays(today(), -10);
  const sec = t.slice(t.indexOf('<h2>Restructure History</h2>'), t.indexOf('<h2>Payments</h2>'));
  check('RS-22', '挂账行、新计划、重组历史（10 天前、1.2%/月、18 个月、原因）', s[0].arrears && s[0].due === eff && s.length === 19 && has(sec, `<b>${eff}</b> · 1.2%/month · 18 months`) && has(sec, 'Reason: Debtor requested lower instalments'), `首行 ${JSON.stringify(s[0])}; 行数 ${s.length}`);
});
