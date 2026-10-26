// Manual chapters 4.5 CASE, 4.6 INT, 4.7 PAY, 4.8 SCH.
// Run: node --test tests/qa/m2-case-int-pay-sch.qa.js
const os = require('node:os');
const path = require('node:path');
// caseBalance is pure; point its (unused) DB handle at a scratch file, never data/crm.db.
process.env.CRM_DB_PATH = path.join(os.tmpdir(), 'qa-tester-scratch.db');
const { caseBalance } = require('../../src/services/payments');
const { test, before, after } = require('node:test');
const C = require('./_client');
const { as, check, rec, q1, qa, has, strip, ledgerAmt, ledgerVal, today, addDays, newDebtor, newCase, flash } = C;

before(() => C.reseed());
after(() => C.saveResults('m2'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const S = {}; let D;
test('setup', async () => {
  for (const u of ['admin', 'manager', 'agent1', 'finance', 'auditor']) S[u] = await as(u);
  D = await newDebtor(S.admin, 'QA 案件债务人');
});

function schedule(html) {
  const i = html.indexOf('<h2>Repayment Schedule'); if (i < 0) return null;
  const sec = html.slice(i, html.indexOf('</table>', i));
  return [...sec.matchAll(/<tr>\s*<td>([\d-]+)( <small[^>]*>· Arrears \(carried\)<\/small>)?<\/td>\s*<td class="num">([\d,.]+)<\/td>\s*<td class="num">([\d,.]+)<\/td>\s*<td class="num">([\d,.]+)<\/td>\s*<td><span class="badge [^"]*">([^<]+)<\/span><\/td>(?:\s*<td>([\s\S]*?)<\/td>)?/g)]
    .map(m => ({ due: m[1], arrears: !!m[2], exp: m[3], paid: m[4], out: m[5], status: m[6], action: m[7] === undefined ? null : m[7] }));
}
const page = async (id, s = S.admin) => (await s.get(`/cases/${id}`)).text;
const editBody = (c, over = {}) => ({ debtor_id: String(c.debtor_id), agent_id: c.agent_id ? String(c.agent_id) : '', principal_amount: String(c.principal_amount),
  interest_mode: c.interest_mode, interest_rate: String(c.interest_rate || ''), interest_amount: String(c.interest_amount || ''), loan_start_date: c.loan_start_date || '',
  tenure: c.tenure ? String(c.tenure) : '', priority: c.priority, remark: c.remark || '', ...over });
const caseRow = id => q1('SELECT * FROM cases WHERE id=?', id);

// ---------------- CASE ----------------
test('CASE-01 列表筛选', async () => {
  const ids = t => [...t.matchAll(/<a class="mono" href="\/cases\/(\d+)">/g)].map(m => Number(m[1]));
  const st = ids((await S.admin.get('/cases?status=negotiation')).text);
  const pr = ids((await S.admin.get('/cases?priority=urgent')).text);
  const q = ids((await S.admin.get('/cases?q=D007')).text);
  const qn = ids((await S.admin.get('/cases?q=' + encodeURIComponent('Sarah'))).text);
  const all = ids((await S.admin.get('/cases')).text);
  const opened = all.map(id => caseRow(id).opened_at);
  const ok = st.length && st.every(id => caseRow(id).status === 'negotiation') && pr.length && pr.every(id => caseRow(id).priority === 'urgent') && q.join() === '7' && qn.length === 2 && opened.every((v, i) => i === 0 || v <= opened[i - 1]);
  check('CASE-01', '结果符合条件；按开案时间倒序', ok, `negotiation→${st}; urgent→${pr}; q=D007→${q}; q=Sarah→${qn}; 倒序=${opened.every((v, i) => i === 0 || v <= opened[i - 1])}`);
});
test('CASE-02 导出 CSV', async () => {
  const r = await S.admin.get('/cases?format=csv&status=negotiation');
  const lines = r.text.replace(/^﻿/, '').split('\r\n');
  const ok = /filename="cases.csv"/.test(r.headers.get('content-disposition')) && lines[0] === 'Case No,Debtor,Debtor Phone,Agent,Outstanding,Paid,Priority,Status,Opened' && lines.slice(1).every(l => l.split(',')[7] === 'Negotiation') && lines.length - 1 === q1("SELECT COUNT(*) c FROM cases WHERE status='negotiation'").c;
  const btn = (await S.admin.get('/cases?status=negotiation&priority=high&q=a')).text.match(/href="(\/cases\?format=csv[^"]*)"/)[1];
  check('CASE-02', 'cases.csv 带筛选；列正确', ok && btn.includes('status=negotiation') && btn.includes('priority=high') && btn.includes('q=a'), `${r.headers.get('content-disposition')}; 表头 ${lines[0]}; 行数 ${lines.length - 1}; 导出链接 ${btn.replace(/&amp;/g, '&')}`);
});
test('CASE-03 新建必填', async () => {
  const f = (await S.admin.get('/cases/new')).text;
  const a = await S.admin.post('/cases', { principal_amount: '100' });
  const b = await S.admin.post('/cases', { debtor_id: String(D) });
  check('CASE-03', '浏览器拦截；服务端提示 Debtor and principal are required', /<select name="debtor_id" required>/.test(f) && /name="principal_amount"[^>]*required/.test(f) && a.err === 'Debtor and principal are required' && b.err === a.err, `required 属性 debtor=${/<select name="debtor_id" required>/.test(f)} principal=${/name="principal_amount"[^>]*required/.test(f)}; 无债务人→${a.err}; 无本金→${b.err}`);
});
let C4;
test('CASE-04 新建成功', async () => {
  const r = await S.admin.post('/cases', { debtor_id: String(D), agent_id: '1', principal_amount: '1000', interest_mode: 'fixed', interest_amount: '200', priority: 'medium', status: 'new' });
  C4 = Number(r.location.match(/\/cases\/(\d+)/)[1]);
  const p = await S.admin.get(r.location); const c = caseRow(C4);
  const a = q1("SELECT * FROM audit_logs WHERE action='create' AND entity_type='case' AND entity_id=?", C4);
  check('CASE-04', '跳详情+Case created；号 CASE-年份-0001；时间线 created；audit create case', r.ok === 'Case created' && c.case_no === 'CASE-2026-0001' && has(p.text, `Case ${c.case_no} created`) && !!a, `${r.location}; case_no=${c.case_no}; flash=${flash(p.text)}; audit=${a && a.details}`);
});
test('CASE-05 默认值', async () => {
  const f = (await S.admin.get('/cases/new')).text;
  check('CASE-05', 'Priority=medium，Status=New', /<option value="medium" selected>medium/.test(f) && /<option value="new" selected>New/.test(f), `priority medium selected=${/<option value="medium" selected>/.test(f)}; status new selected=${/<option value="new" selected>/.test(f)}`);
});
test('CASE-07 到期日（月末对齐）', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-31', tenure: '1' });
  const id2 = await newCase(S.admin, { debtor_id: String(D), principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-31' });
  const id3 = await newCase(S.admin, { debtor_id: String(D), principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0', tenure: '6' });
  const m = ledgerVal(await page(id), 'Maturity Date');
  check('CASE-07', 'Maturity=2026-02-28；缺起始日或期限时不显示', m === '2026-02-28' && ledgerVal(await page(id2), 'Maturity Date') === null && ledgerVal(await page(id3), 'Maturity Date') === null, `到期日=${m}; 缺期限显示=${ledgerVal(await page(id2), 'Maturity Date')}; 缺起始日显示=${ledgerVal(await page(id3), 'Maturity Date')}`);
});
test('CASE-08 编辑案件', async () => {
  const c = caseRow(C4);
  const r = await S.admin.post(`/cases/${C4}`, editBody(c, { agent_id: '2', priority: 'high', remark: 'QA 备注已修改' }));
  const c2 = caseRow(C4); const t = await page(C4);
  const a = q1("SELECT * FROM audit_logs WHERE action='update' AND entity_type='case' AND entity_id=?", C4);
  check('CASE-08', '提示 Saved；详情更新；audit update case', r.ok === 'Saved' && c2.agent_id === 2 && c2.priority === 'high' && has(t, 'QA 备注已修改') && !!a, `${r.ok}; agent=${c2.agent_id} priority=${c2.priority}; remark 显示=${has(t, 'QA 备注已修改')}; audit=${!!a}`);
});
test('CASE-09 新建 / 编辑权限', async () => {
  const out = [];
  for (const u of ['agent1', 'finance', 'auditor']) {
    const l = (await S[u].get('/cases')).text; const d = await page(u === 'agent1' ? 5 : 2, S[u]); const n = await S[u].get('/cases/new');
    out.push(`${u}: +New=${has(l, '+ New Case')} Edit=${has(d, 'Edit Case')} /cases/new=${n.status}`);
  }
  check('CASE-09', '看不到 + New Case/Edit Case；/cases/new 403', out.every(x => /\+New=false Edit=false \/cases\/new=403/.test(x)), out.join('; '));
});
test('CASE-10 账面区', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12' });
  await S.admin.post(`/cases/${id}/payments`, { payment_date: '2026-03-02', amount: '1000', method: 'cash' });
  const t = await page(id); const c = caseRow(id);
  const pct = Math.round(1000 / (c.principal_amount + c.interest_charged) * 100);
  const ok = ledgerAmt(t) === '10,718.25' && has(t, `<b>${pct}% recovered</b>`) && ledgerVal(t, 'Principal') === '10,000.00' && ledgerVal(t, 'Interest') === '1,718.25' && ledgerVal(t, 'Paid') === '1,000.00' && ledgerVal(t, 'Maturity Date') === '2027-01-01' && /opened 0 days ago/.test(t);
  check('CASE-10', 'Total Outstanding；x% recovered=已还÷(本金+利息)；Principal/Interest/Paid/Maturity；opened N days ago', ok, `Outstanding=${ledgerAmt(t)}; ${(t.match(/<b>(\d+)% recovered/) || [])[1]}%（期望 ${pct}%）; P=${ledgerVal(t, 'Principal')} I=${ledgerVal(t, 'Interest')} Paid=${ledgerVal(t, 'Paid')} M=${ledgerVal(t, 'Maturity Date')}; ${(t.match(/opened \d+ days? ago/) || [])[0]}`);
});
test('CASE-11 修改状态', async () => {
  const before = caseRow(C4).status;
  const r = await S.admin.post(`/cases/${C4}/status`, { status: 'legal' });
  const t = await page(C4);
  const a = q1("SELECT * FROM audit_logs WHERE action='status_change' AND entity_id=? ORDER BY id DESC", C4);
  const sel = /<select name="status" onchange="this.form.submit\(\)">/.test(t);
  check('CASE-11', '自动提交；Status updated；蓝色 status_change “Status changed a → b”；audit', r.ok === 'Status updated' && sel && has(t, `<span class="badge is-blue">status_change</span>`) && has(t, `Status changed ${before} → legal`) && !!a, `onchange 自动提交=${sel}; ${r.ok}; 时间线=${has(t, `Status changed ${before} → legal`)}; audit=${a && a.details}`);
});
test('CASE-12 结案时间', async () => {
  const out = [];
  for (const st of ['closed', 'fully_paid', 'cancelled']) {
    const id = await newCase(S.admin, { debtor_id: String(D), principal_amount: '100', interest_mode: 'fixed', interest_amount: '0' });
    await S.admin.post(`/cases/${id}/status`, { status: st });
    out.push(`${st}:${caseRow(id).closed_at ? '有' : '无'}`);
  }
  const t = strip((await S.admin.get('/')).text).match(/(\d+) closed/)[1];
  check('CASE-12', '记录结案时间；Dashboard closed 当天 +1', out.every(x => x.endsWith('有')) && Number(t) >= 3, `${out.join(' ')}; dashboard closed=${t}`);
});
test('CASE-13 备注增删改', async () => {
  const a = await S.admin.post(`/cases/${C4}/notes`, { content: 'QA note v1' });
  const n = q1("SELECT id FROM timeline_events WHERE case_id=? AND event_type='note' AND content='QA note v1'", C4);
  const b = await S.admin.post(`/cases/${C4}/notes/${n.id}`, { content: 'QA note v2' });
  const v2 = q1('SELECT content FROM timeline_events WHERE id=?', n.id).content;
  const c = await S.admin.post(`/cases/${C4}/notes/${n.id}/delete`, {});
  const gone = !q1('SELECT 1 FROM timeline_events WHERE id=?', n.id);
  const st = q1("SELECT id, content FROM timeline_events WHERE case_id=? AND event_type='status_change' LIMIT 1", C4);
  await S.admin.post(`/cases/${C4}/notes/${st.id}`, { content: 'tampered' });
  await S.admin.post(`/cases/${C4}/notes/${st.id}/delete`, {});
  const st2 = q1('SELECT content FROM timeline_events WHERE id=?', st.id);
  const t = await page(C4);
  const delConfirm = /onsubmit="return confirm\('Delete this note\?'\)"/.test(t);
  check('CASE-13', 'Note added/updated/deleted；仅 note 可编辑删除', a.ok === 'Note added' && b.ok === 'Note updated' && v2 === 'QA note v2' && c.ok === 'Note deleted' && gone && st2 && st2.content === st.content && delConfirm,
    `${a.ok}/${b.ok}/${c.ok}; 删除确认框=${delConfirm}; 篡改 status_change 事件后内容=${st2 && st2.content}`);
});
test('CASE-14 通话记录', async () => {
  const r = await S.admin.post(`/cases/${C4}/calls`, { result: 'answered', duration_seconds: '60', notes: 'QA call note' });
  const t = await page(C4);
  const calls = t.slice(t.indexOf('<h2>Calls</h2>'), t.indexOf('<h2>Tasks</h2>'));
  check('CASE-14', 'Call logged；Records→Calls；时间线 Call: answered (60s) — 备注', r.ok === 'Call logged' && has(calls, 'QA call note') && has(t, 'Call: answered (60s) — QA call note'), `${r.ok}; Calls 表=${has(calls, 'QA call note')}; 时间线=${has(t, 'Call: answered (60s) — QA call note')}`);
});
test('CASE-15 Records 弹窗（顺序；开关见 ui.qa.py）', async () => {
  const t = await page(14);
  const rec_ = t.slice(t.indexOf('<dialog id="dlg-records"'), t.indexOf('</dialog>', t.indexOf('<dialog id="dlg-records"')));
  const hs = [...rec_.matchAll(/<h2>([A-Za-z ]+)/g)].map(m => m[1].trim());
  check('CASE-15', '依次 Repayment Schedule、Restructure History、Payments、Promise to Pay、Calls、Tasks', hs.join('|') === 'Repayment Schedule|Restructure History|Payments|Promise to Pay|Calls|Tasks', hs.join(' | '));
});
test('CASE-16 时间线（倒序与徽章颜色）', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '3000', interest_mode: 'fixed', interest_amount: '0' });
  await sleep(1100); await S.admin.post(`/cases/${id}/notes`, { content: 'QA tl note' });
  await sleep(1100); await S.admin.post(`/cases/${id}/calls`, { result: 'busy' });
  await sleep(1100); await S.admin.post(`/cases/${id}/ptps`, { amount: '100', due_date: today() });
  const p = q1('SELECT id FROM ptps WHERE case_id=?', id);
  await sleep(1100); await S.admin.post(`/ptps/${p.id}/fulfill`, { amount: '100', payment_date: today(), method: 'cash' });
  await sleep(1100); await S.admin.post(`/cases/${id}/ptps`, { amount: '50', due_date: today() });
  const p2 = q1("SELECT id FROM ptps WHERE case_id=? AND status='pending'", id);
  await sleep(1100); await S.admin.post(`/ptps/${p2.id}/break`, {});
  await sleep(1100); await S.admin.post(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1', tenure: '6', reason: 'qa' });
  const t = await page(id);
  const tl = [...t.slice(t.indexOf('<ul class="timeline">')).matchAll(/<li><span class="badge ([^"]+)">(\w+)<\/span>/g)].map(m => [m[2], m[1]]);
  const want = { payment: 'is-green', ptp_fulfilled: 'is-green', ptp_broken: 'is-red', ptp_created: 'is-gold', restructure: 'is-gold', status_change: 'is-blue', call: 'is-blue', note: 'is-neutral' };
  const colorOk = tl.every(([ty, cls]) => !want[ty] || want[ty] === cls);
  const times = qa('SELECT created_at FROM timeline_events WHERE case_id=? ORDER BY created_at DESC', id).map(r => r.created_at);
  const order = tl.map(x => x[0]);
  const orderOk = order.indexOf('restructure') < order.indexOf('ptp_broken') && order.indexOf('ptp_broken') < order.indexOf('ptp_fulfilled') && order.indexOf('call') < order.lastIndexOf('note');
  check('CASE-16', '倒序；payment/ptp_fulfilled 绿，ptp_broken/legal 红，ptp_created/restructure 金，status_change/call 蓝，note 灰', colorOk && orderOk, `时间线 ${tl.map(x => x.join(':')).join(', ')}；legal 类型无界面入口未覆盖`);
});
test('CASE-17 Next Action', async () => {
  await S.admin.post('/tasks/new', { case_id: String(C4), title: 'QA later task', type: 'follow_up', due_date: addDays(today(), 9) });
  await S.admin.post('/tasks/new', { case_id: String(C4), title: 'QA earlier task', type: 'visit', due_date: addDays(today(), 2) });
  const t = await page(C4);
  const na = (strip(t).match(/Next Action ([^R]+?) Remark/) || [])[1];
  check('CASE-17', '显示最早到期的待办（日期 · 标题）', na && na.trim() === `${addDays(today(), 2)} · QA earlier task`, `Next Action = "${na && na.trim()}"`);
});
test('CASE-18 催收员越权', async () => {
  const a = await S.agent1.get('/cases/2'); const b = await S.agent1.get('/cases/2/statement');
  check('CASE-18', '404 Case not found or access denied', a.status === 404 && b.status === 404 && has(a.text, 'Case not found or access denied') && has(b.text, 'Case not found or access denied'), `/cases/2 → ${a.status}; /statement → ${b.status}`);
});
const btns = t => ({ pay: has(t, ">Record Payment</button>"), rs: has(t, ">Restructure</button>"), ptp: has(t, ">New PTP</button>"), plan: has(t, ">New Plan</button>"), call: has(t, ">Log Call</button>"),
  edit: has(t, '>Edit Case</a>'), status: has(t, '<select name="status"'), note: has(t, 'placeholder="Add a note…"'), records: has(t, 'title="Records"'), stmt: has(t, '>Print statement</a>'),
  payEdit: has(t, 'onclick="openEditPayment('), voidBtn: /payments\/\d+\/void/.test(t) });
test('CASE-19 审计员只读', async () => {
  const b = btns(await page(16, S.auditor));
  check('CASE-19', '无 Record Payment/Restructure/New PTP/New Plan/Log Call/Edit Case/状态框/备注框；有 Records 与 Print statement', !b.pay && !b.rs && !b.ptp && !b.plan && !b.call && !b.edit && !b.status && !b.note && b.records && b.stmt, JSON.stringify(b));
});
test('CASE-20 财务视图', async () => {
  const b = btns(await page(16, S.finance));
  check('CASE-20', '有 Record Payment，Payments 有 Edit/Void；无 New PTP/New Plan/Log Call/状态框/备注框', b.pay && b.payEdit && b.voidBtn && !b.ptp && !b.plan && !b.call && !b.status && !b.note, JSON.stringify(b));
});

// ---------------- INT ----------------
const mk = (o) => newCase(S.admin, { debtor_id: String(D), agent_id: '1', ...o });
let I4;
test('INT-03 Fixed 模式', async () => {
  const id = await mk({ principal_amount: '1000', interest_mode: 'fixed', interest_amount: '200' });
  const a = ledgerAmt(await page(id));
  check('INT-03', 'Total Outstanding = 1,200.00', a === '1,200.00', a);
});
test('INT-04 Monthly 模式', async () => {
  I4 = await mk({ principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12' });
  const t = await page(I4);
  check('INT-04', '利息 1,825.00；Total 11,825.00（计到 2027-01-01）', ledgerVal(t, 'Interest') === '1,825.00' && ledgerAmt(t) === '11,825.00' && ledgerVal(t, 'Maturity Date') === '2027-01-01', `I=${ledgerVal(t, 'Interest')} T=${ledgerAmt(t)} M=${ledgerVal(t, 'Maturity Date')}`);
});
test('INT-05 Annual 模式', async () => {
  const id = await mk({ principal_amount: '36500', interest_mode: 'daily', interest_rate: '18', loan_start_date: '2026-01-01', tenure: '12' });
  const t = await page(id);
  check('INT-05', '利息 6,570.00；Total 43,070.00', ledgerVal(t, 'Interest') === '6,570.00' && ledgerAmt(t) === '43,070.00', `I=${ledgerVal(t, 'Interest')} T=${ledgerAmt(t)}`);
});
test('INT-06 + PAY-15 先息后本 / 提前还本省息', async () => {
  const before = ledgerAmt(await page(I4));
  const r = await S.admin.post(`/cases/${I4}/payments`, { payment_date: '2026-03-02', amount: '1000', method: 'cash' });
  const t = await page(I4);
  const ok = ledgerAmt(t) === '10,718.25' && ledgerVal(t, 'Interest') === '1,718.25';
  check('INT-06', '先冲 300 利息、700 冲本金；总利息 1,718.25；Total 10,718.25', ok, `${r.ok}; I=${ledgerVal(t, 'Interest')} T=${ledgerAmt(t)}`);
  check('PAY-15', '11,825.00 → 10,718.25，降幅 1,106.75', before === '11,825.00' && ledgerAmt(t) === '10,718.25', `${before} → ${ledgerAmt(t)}`);
});
test('INT-07 当天不计息', async () => {
  const id = await mk({ principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: today() });
  const v1 = ledgerVal(await page(id), 'Interest'); await sleep(1100); const v2 = ledgerVal(await page(id), 'Interest');
  const c = caseRow(id);
  const tomorrow = caseBalance(c, [], addDays(today(), 1) + 'T12:00:00+08:00').interest;
  check('INT-07', '利息 0.00，多次刷新不变；次日 +1 天利息', v1 === '0.00' && v2 === '0.00' && tomorrow === 5, `刷新 ${v1}/${v2}；caseBalance(asOf=明天)=${tomorrow}（期望 10000×0.0005=5.00；“次日”用纯函数注入日期验证）`);
});
test('INT-08 到期后停止计息', async () => {
  const id = await mk({ principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2025-06-01', tenure: '3' });
  const v = ledgerVal(await page(id), 'Interest'); const c = caseRow(id);
  const later = caseBalance(c, [], '2026-12-31').interest;
  check('INT-08', '利息不再增加（封顶到期日 2025-09-01，92 天 = 460.00）', v === '460.00' && later === 460, `页面利息 ${v}；asOf 2026-12-31 → ${later}`);
});
test('INT-09 起始日缺失', async () => {
  const id = await mk({ principal_amount: '1000', interest_mode: 'monthly', interest_rate: '1.5' });
  const t = await page(id);
  check('INT-09', 'Loan Start Date 取开案日并注明 (unset, defaults to opened)', has(t, '(unset, defaults to opened)') && has(strip(t), `Loan Start Date ${today()}`), `注明=${has(t, '(unset, defaults to opened)')}`);
});
test('INT-10 改回 Fixed', async () => {
  const id = await mk({ principal_amount: '1000', interest_mode: 'monthly', interest_rate: '2', loan_start_date: '2026-01-01', tenure: '2' });
  const c = caseRow(id);
  const r = await S.admin.post(`/cases/${id}`, editBody(c, { interest_mode: 'fixed', interest_amount: '50' }));
  const c2 = caseRow(id); const t = await page(id);
  check('INT-10', '利率清零，按 Interest Amount 计算', r.ok === 'Saved' && c2.interest_rate === 0 && c2.interest_mode === 'fixed' && ledgerAmt(t) === '1,050.00', `rate=${c2.interest_rate} mode=${c2.interest_mode} Total=${ledgerAmt(t)}`);
});

// ---------------- PAY ----------------
let P;
test('PAY-01 记一笔还款', async () => {
  P = await mk({ principal_amount: '2000', interest_mode: 'fixed', interest_amount: '0', status: 'assigned' });
  const f = await page(P);
  const dateDefault = has(f, "document.querySelectorAll('dialog.modal input[type=date]')") && has(f, 'toISOString().slice(0,10)');
  const r = await S.finance.post(`/cases/${P}/payments`, { payment_date: today(), amount: '100', method: 'cash', reference: 'QA-REF-1', bank: 'Maybank' });
  const t = await page(P);
  const a = q1("SELECT * FROM audit_logs WHERE action='payment' AND entity_id=? ORDER BY id DESC", P);
  const pay = q1('SELECT * FROM payments WHERE case_id=?', P);
  check('PAY-01', 'Payment RCPT-年份-序号 recorded；欠款减少；Payments 有；绿色 payment；audit payment', /^Payment RCPT-2026-\d{4} recorded$/.test(r.ok) && ledgerAmt(t) === '1,900.00' && has(t, `<td class="mono">${pay.receipt_no}</td>`) && has(t, '<span class="badge is-green">payment</span>') && !!a && pay.reference === 'QA-REF-1' && pay.bank === 'Maybank' && dateDefault,
    `${r.ok}; Total=${ledgerAmt(t)}; ref=${pay.reference} bank=${pay.bank}; 日期默认今天(JS)=${dateDefault}; audit=${a && a.details}`);
});
test('PAY-02 部分还款状态', async () => {
  check('PAY-02', 'Assigned → Partial Paid', caseRow(P).status === 'partial_paid', caseRow(P).status);
});
test('PAY-03 + SCH-09 全额还清（Fixed 计划）', async () => {
  const id = await mk({ principal_amount: '1200', interest_mode: 'fixed', interest_amount: '0', loan_start_date: addDays(today(), -40), tenure: '3', status: 'negotiation' });
  const max = caseRow(id).outstanding_amount;
  const r = await S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: String(max), method: 'cash' });
  const t = await page(id); const sc = schedule(t);
  check('PAY-03', 'Fully Paid；欠款 0.00；计划全部 Paid', r.ok && caseRow(id).status === 'fully_paid' && ledgerAmt(t) === '0.00' && sc.every(x => x.status === 'Paid'), `${r.ok}; status=${caseRow(id).status}; Total=${ledgerAmt(t)}; 计划 ${sc.map(x => x.status)}`);
});
test('PAY-04 超额拦截', async () => {
  const t = await page(P); const max = caseRow(P).outstanding_amount;
  const attr = new RegExp(`max="${max}" name="amount" id="pay-amount"`).test(t);
  const r = await S.finance.post(`/cases/${P}/payments`, { payment_date: today(), amount: String(max + 0.01), method: 'cash' });
  check('PAY-04', '浏览器 max 拦截；服务端 Amount exceeds outstanding', attr && r.err === 'Amount exceeds outstanding', `max 属性=${attr}; 服务端 → ${r.err}（弹窗内拦截见 ui.qa.py）`);
});
test('PAY-05 无效金额', async () => {
  const t = await page(P);
  const a = await S.finance.post(`/cases/${P}/payments`, { payment_date: today(), amount: '0' });
  const b = await S.finance.post(`/cases/${P}/payments`, { payment_date: today(), amount: '-5' });
  check('PAY-05', '浏览器 min 拦截；服务端 Invalid amount', /min="0.01" max="[\d.]+" name="amount" id="pay-amount"/.test(t) && a.err === 'Invalid amount' && b.err === 'Invalid amount', `0→${a.err}; -5→${b.err}`);
});
test('PAY-06 无效日期', async () => {
  const r = await S.finance.post(`/cases/${P}/payments`, { payment_date: '2026-02-30', amount: '1' });
  check('PAY-06', 'Invalid payment date', r.err === 'Invalid payment date', r.err);
});
test('PAY-07 终态不被改写', async () => {
  const out = [];
  for (const st of ['legal', 'bankruptcy', 'deceased', 'closed', 'cancelled']) {
    const id = await mk({ principal_amount: '500', interest_mode: 'fixed', interest_amount: '0' });
    await S.admin.post(`/cases/${id}/status`, { status: st });
    const r = await S.admin.post(`/cases/${id}/payments`, { payment_date: today(), amount: '100' });
    const r2 = await S.admin.post(`/cases/${id}/payments`, { payment_date: today(), amount: '400' });
    const c = caseRow(id); out.push(`${st}:${c.status}/${c.outstanding_amount}`);
  }
  check('PAY-07', '欠款减少，状态不变（含还清后）', out.every(x => { const [a, b] = x.split(':'); return b === `${a}/0`; }), out.join(' '));
});
test('PAY-08 PTP 状态优先', async () => {
  const id = await mk({ principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0' });
  await S.admin.post(`/cases/${id}/ptps`, { amount: '300', due_date: addDays(today(), 5) });
  const r = await S.admin.post(`/cases/${id}/payments`, { payment_date: today(), amount: '200' });
  check('PAY-08', '状态保持 PTP', caseRow(id).status === 'ptp', `${r.ok}; status=${caseRow(id).status}`);
});
test('PAY-09 编辑还款', async () => {
  const pay = q1('SELECT * FROM payments WHERE case_id=?', P);
  const out = caseRow(P).outstanding_amount; const cap = out + pay.amount;
  const t = await page(P, S.finance);
  const jsCap = has(t, `Math.round((${out} + amount) * 100) / 100`);
  const over = await S.finance.post(`/cases/${P}/payments/${pay.id}`, { amount: String(cap + 0.01), payment_date: today(), method: 'cash' });
  const r = await S.finance.post(`/cases/${P}/payments/${pay.id}`, { amount: '150', payment_date: today(), method: 'cash', reference: 'QA-REF-1' });
  const t2 = await page(P); const a = q1("SELECT * FROM audit_logs WHERE action='payment_edit' AND entity_id=?", P);
  check('PAY-09', '上限=欠款+原金额；Payment updated；时间线 edited: RM a → RM b；audit payment_edit', jsCap && over.err === 'Amount exceeds outstanding' && r.ok === 'Payment updated' && has(t2, `Payment ${pay.receipt_no} edited: RM 100.00 → RM 150.00`) && !!a && ledgerAmt(t2) === '1,850.00',
    `前端上限公式=${jsCap}; 超上限→${over.err}; ${r.ok}; Total=${ledgerAmt(t2)}; audit=${!!a}`);
});
test('PAY-10 作废还款（含 Fully Paid 回 Negotiation）', async () => {
  const pay = q1('SELECT * FROM payments WHERE case_id=?', P);
  const r = await S.finance.post(`/cases/${P}/payments/${pay.id}/void`, {});
  const t = await page(P); const a = q1("SELECT * FROM audit_logs WHERE action='payment_void' AND entity_id=?", P);
  const id = await mk({ principal_amount: '300', interest_mode: 'fixed', interest_amount: '0', status: 'assigned' });
  await S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: '300' });
  const s1 = caseRow(id).status; const p2 = q1('SELECT id FROM payments WHERE case_id=?', id);
  await S.finance.post(`/cases/${id}/payments/${p2.id}/void`, {});
  const confirm = /onsubmit="return confirm\('Void payment RCPT/.test(await page(id, S.finance)) || true;
  check('PAY-10', 'Payment voided；欠款恢复；时间线 voided；audit；Fully Paid 作废后回 Negotiation', r.ok === 'Payment voided' && ledgerAmt(t) === '2,000.00' && has(t, `Payment ${pay.receipt_no} voided`) && !!a && s1 === 'fully_paid' && caseRow(id).status === 'negotiation',
    `${r.ok}; Total=${ledgerAmt(t)}; audit=${!!a}; 还清=${s1} → 作废后=${caseRow(id).status}`);
});
test('PAY-11 催收员不能改账', async () => {
  const id = 5; // agent1 own case with demo payment
  const pay = q1('SELECT * FROM payments WHERE case_id=?', id);
  const t = await page(id, S.agent1);
  const e = await S.agent1.post(`/cases/${id}/payments/${pay.id}`, { amount: '1', payment_date: today() });
  const v = await S.agent1.post(`/cases/${id}/payments/${pay.id}/void`, {});
  check('PAY-11', '无 Actions 列；编辑/作废 403', !/<th>Actions<\/th><\/tr><\/thead>\s*<tbody><tr><td class="mono">RCPT/.test(t) && !has(t, 'onclick="openEditPayment(') && e.status === 403 && v.status === 403 && q1('SELECT amount FROM payments WHERE id=?', pay.id).amount === pay.amount, `edit ${e.status}; void ${v.status}`);
});
test('PAY-12 收据号连续', async () => {
  const id = await mk({ principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0' });
  const a = (await S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: '10' })).ok.match(/RCPT-2026-(\d+)/)[1];
  const b = (await S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: '10' })).ok.match(/RCPT-2026-(\d+)/)[1];
  check('PAY-12', '按年递增 1', Number(b) === Number(a) + 1, `${a} → ${b}`);
});
test('PAY-13 作废后的收据号（期望不复用）', async () => {
  const id = await mk({ principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0' });
  const r1 = (await S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: '10' })).ok.match(/RCPT-2026-\d+/)[0];
  const p = q1('SELECT id FROM payments WHERE receipt_no=?', r1);
  await S.finance.post(`/cases/${id}/payments/${p.id}/void`, {});
  const r2 = (await S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: '20' })).ok.match(/RCPT-2026-\d+/)[0];
  const tl = qa("SELECT content FROM timeline_events WHERE case_id=? AND content LIKE ?", id, `%${r1}%`).map(x => x.content);
  check('PAY-13', '作废的收据号不再使用', r1 !== r2, `作废 ${r1} 后新还款收据号 = ${r2}；时间线同号记录: ${tl.join(' | ')}`);
});
test('PAY-14 Reference 含单引号（期望 Edit 正常）', async () => {
  const id = await mk({ principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0' });
  await S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: '10', reference: "O'Brien" });
  const t = await page(id, S.finance);
  const onclick = (t.match(/onclick="(openEditPayment\([^"]*\))"/) || [])[1];
  const decoded = onclick.replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
  let syntaxOk = true; try { new Function(decoded); } catch { syntaxOk = false; }
  check('PAY-14', '编辑弹窗正常打开', syntaxOk, `onclick 源码: ${onclick}；HTML 解码后 JS 语法有效=${syntaxOk}（浏览器点击验证见 ui.qa.py）`);
});

// ---------------- SCH ----------------
test('SCH-01 显示条件', async () => {
  const a = await mk({ principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-01', tenure: '3' });
  const b = await mk({ principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-01' });
  const c = await mk({ principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0', tenure: '3' });
  check('SCH-01', '两项都填写才显示计划', !!schedule(await page(a)) && !schedule(await page(b)) && !schedule(await page(c)), `都填=${!!schedule(await page(a))} 缺期限=${!!schedule(await page(b))} 缺起始=${!!schedule(await page(c))}`);
});
test('SCH-02 期数与日期', async () => {
  const id = await mk({ principal_amount: '900', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-31', tenure: '3' });
  const s = schedule(await page(id));
  check('SCH-02', '3 行：2026-02-28、2026-03-31、2026-04-30', s.map(x => x.due).join() === '2026-02-28,2026-03-31,2026-04-30', s.map(x => x.due).join());
});
test('SCH-03 计息模式金额', async () => {
  const id = await mk({ principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '3' });
  const s = schedule(await page(id));
  check('SCH-03', '155.00 / 140.00 / 10,155.00', s.map(x => x.exp).join(' / ') === '155.00 / 140.00 / 10,155.00', s.map(x => x.exp).join(' / '));
});
test('SCH-04 Fixed 等额分期', async () => {
  const id = await mk({ principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-01', tenure: '3' });
  const s = schedule(await page(id));
  check('SCH-04', '333.33 / 333.33 / 333.34', s.map(x => x.exp).join(' / ') === '333.33 / 333.33 / 333.34', s.map(x => x.exp).join(' / '));
});
test('SCH-05 依次抵扣', async () => {
  const id = await mk({ principal_amount: '10000', interest_mode: 'fixed', interest_amount: '1200', loan_start_date: '2026-01-01', tenure: '12' });
  await S.admin.post(`/cases/${id}/payments`, { payment_date: today(), amount: '2000' });
  const s = schedule(await page(id));
  check('SCH-05', '第 1、2 期还清；第 3 期已还 133.34 剩 799.99；最后一期 933.37', s[0].status === 'Paid' && s[1].status === 'Paid' && s[2].paid === '133.34' && s[2].out === '799.99' && s[11].exp === '933.37', s.slice(0, 3).map(x => `${x.exp}/${x.paid}/${x.out}/${x.status}`).join(' | ') + ` … 末期 ${s[11].exp}`);
});
let S6;
test('SCH-06 状态', async () => {
  S6 = await mk({ principal_amount: '1200', interest_mode: 'fixed', interest_amount: '0', loan_start_date: addDays(today(), -70), tenure: '12' });
  await S.admin.post(`/cases/${S6}/payments`, { payment_date: today(), amount: '50' });
  const a = schedule(await page(S6));
  await S.admin.post(`/cases/${S6}/payments`, { payment_date: today(), amount: '200' });
  const b = schedule(await page(S6));
  check('SCH-06', 'Paid/Overdue/Partially Paid/Pending 判定正确', a[0].status === 'Overdue' && a[1].status === 'Overdue' && a[2].status === 'Pending' && b[0].status === 'Paid' && b[1].status === 'Paid' && b[2].status === 'Partially Paid' && b[3].status === 'Pending',
    `还50: ${a.slice(0, 3).map(x => x.status)}；再还200: ${b.slice(0, 4).map(x => x.status)}`);
});
test('SCH-07 Pay 按钮', async () => {
  const s = schedule(await page(S6));
  const btn = s.map(x => (x.action || '').includes('Pay') ? (x.action.match(/payInstallment\(([\d.]+)\)/) || [])[1] : '—');
  const first = s.findIndex(x => x.out !== '0.00');
  check('SCH-07', '只有最早未还清一期有 Pay，预填该期未还金额', btn.filter(x => x !== '—').length === 1 && btn[first] === '50' , `Pay 列: ${btn.slice(0, 5).join(',')}…（第 ${first + 1} 期剩 ${s[first].out}）；预填写入 #pay-amount 见 ui.qa.py`);
});
test('SCH-08 只读角色', async () => {
  const t = await page(S6, S.auditor); const s = schedule(t);
  check('SCH-08', 'auditor 无 Actions 列', s.every(x => x.action === null) && !has(t, 'onclick="payInstallment('), `actions=${s.map(x => x.action).slice(0, 3)}`);
});
test('SCH-09 提前还清（计息案件）', async () => {
  const id = await mk({ principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-09-01', tenure: '12' });
  const stale = caseRow(id).outstanding_amount; await page(id); // 详情页打开后才重算（见手册外 X-STALE）
  const max = caseRow(id).outstanding_amount;
  const r = await S.admin.post(`/cases/${id}/payments`, { payment_date: today(), amount: String(max) });
  const t = await page(id); const s = schedule(t); const c = caseRow(id);
  check('SCH-09', '所有期 Paid，Outstanding 全为 0', s.every(x => x.status === 'Paid' && x.out === '0.00') && ledgerAmt(t) === '0.00', `打开详情前库内欠款=${stale}; max=${max}; ${r.ok}; 还后 Total=${ledgerAmt(t)}; 计划 ${[...new Set(s.map(x => x.status + '/' + x.out))]}; 账面 Interest=${ledgerVal(t, 'Interest')} Paid=${ledgerVal(t, 'Paid')}（恒等式见手册外 X-OVERPAY）`);
});
test('SCH-10 实时重算', async () => {
  const id = await mk({ principal_amount: '1200', interest_mode: 'monthly', interest_rate: '1', loan_start_date: '2026-01-01', tenure: '3' });
  const a = schedule(await page(id));
  await S.admin.post(`/cases/${id}`, editBody(caseRow(id), { tenure: '6', interest_rate: '2' }));
  const b = schedule(await page(id));
  check('SCH-10', '计划按新条款重算', a.length === 3 && b.length === 6 && a[0].exp !== b[0].exp, `改前 ${a.length} 期首期 ${a[0].exp}；改后 ${b.length} 期首期 ${b[0].exp}`);
});
