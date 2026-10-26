// 角色 3 合规审查 · 实测脚本（只针对 data/qa/compliance.db + 端口 3303）
// 运行：CRM_DB_PATH=data/qa/compliance.db node --no-warnings tests/qa/compliance/compliance.qa.js
// 前提：已用同一 CRM_DB_PATH seed，并在 3303 启动服务。
if (!process.env.CRM_DB_PATH || !/compliance\.db$/.test(process.env.CRM_DB_PATH)) {
  console.error('Refusing to run: CRM_DB_PATH must point to data/qa/compliance.db'); process.exit(1);
}
const BASE = 'http://localhost:3303';
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.CRM_DB_PATH);
const q1 = (sql, p = []) => db.prepare(sql).get(...p);
const qa = (sql, p = []) => db.prepare(sql).all(...p);
const out = {};

async function login(u, p) {
  const r = await fetch(BASE + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: u, password: p }) });
  const ck = (r.headers.get('set-cookie') || '').split(';')[0];
  if (r.status !== 302 || !ck) throw new Error('login failed ' + u);
  return ck;
}
async function post(ck, path, data) {
  const r = await fetch(BASE + path, { method: 'POST', redirect: 'manual',
    headers: { cookie: ck, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  return { status: r.status, loc: r.headers.get('location') || '' };
}
async function get(ck, path) {
  const r = await fetch(BASE + path, { redirect: 'manual', headers: ck ? { cookie: ck } : {} });
  return { status: r.status, text: await r.text(), type: r.headers.get('content-type') };
}
const caseIdFrom = loc => Number((loc.match(/\/cases\/(\d+)/) || [])[1]);
const caseRow = id => q1('SELECT principal_amount, interest_charged, outstanding_amount, status FROM cases WHERE id=?', [id]);

(async () => {
  const admin = await login('admin', 'admin123');
  await post(admin, '/debtors', { name: 'QA 合规测试', ic_passport: '000000-00-0000', phone: '000-0000000' });
  const debtorId = q1("SELECT id FROM debtors WHERE name='QA 合规测试' ORDER BY id DESC").id;
  const mk = async (label, f) => {
    const r = await post(admin, '/cases', { debtor_id: debtorId, agent_id: 1, principal_amount: 10000, priority: 'medium', status: 'assigned', ...f });
    const id = caseIdFrom(r.loc);
    await get(admin, `/cases/${id}`); // 打开详情页才会 recomputeOutstanding（与真实操作一致）
    const c = caseRow(id);
    out[label] = { http: r.status, loc: r.loc, id, ...c,
      interestPctOfPrincipal: +(c.interest_charged / c.principal_amount * 100).toFixed(4) };
    return id;
  };

  // A. 1.5%/月、12 个月：法定上限 18%/年 = 1,800；系统算出多少？
  const a = await mk('A_monthly_1.5pct_12m', { interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: '2026-01-01', tenure: 12 });
  // B. 50%/年 是否被接受
  await mk('B_annual_50pct_12m', { interest_mode: 'daily', interest_rate: 50, loan_start_date: '2026-01-01', tenure: 12 });
  // C. 5%/月
  await mk('C_monthly_5pct_12m', { interest_mode: 'monthly', interest_rate: 5, loan_start_date: '2026-01-01', tenure: 12 });
  // D. Fixed：本金 10,000、利息 50,000、1 个月
  await mk('D_fixed_interest_50000_1m', { interest_mode: 'fixed', interest_amount: 50000, loan_start_date: '2026-01-01', tenure: 1 });
  // E. 18%/年、120 个月：利息总额 > 本金（s.17A(2)）
  await mk('E_annual_18pct_120m', { interest_mode: 'daily', interest_rate: 18, loan_start_date: '2026-01-01', tenure: 120 });
  // F. 闰年：18%/年、2027-03-01 起 12 个月（含 2028-02-29）
  await mk('F_annual_18pct_leap', { interest_mode: 'daily', interest_rate: 18, loan_start_date: '2027-03-01', tenure: 12 });

  // H. 还款计划每期利息（1.5%/月，31/28/31 天）
  const { repaymentSchedule } = require('../../../src/utils/schedule');
  const cA = q1('SELECT * FROM cases WHERE id=?', [a]);
  out.H_schedule_first3 = repaymentSchedule(cA, []).slice(0, 3).map(r => ({ due: r.due_date, expected: r.expected_amount }));

  // G. 提前全额结清：起始 2026-07-24、1.5%/月、12 个月，今天（2026-10-24）按 max 还清
  const g = await mk('G_before_early_settle', { interest_mode: 'monthly', interest_rate: 1.5, loan_start_date: '2026-07-24', tenure: 12 });
  await get(admin, `/cases/${g}`);
  const maxAmt = caseRow(g).outstanding_amount; // = 弹窗里的 max
  const pay = await post(admin, `/cases/${g}/payments`, { amount: maxAmt, payment_date: '2026-10-24', method: 'cash', reference: 'QA' });
  await get(admin, `/cases/${g}`);
  const afterG = caseRow(g);
  const paidG = q1('SELECT SUM(amount) s FROM payments WHERE case_id=?', [g]).s;
  out.G_early_settle = { maxAmt, payHttp: pay.loc, after: afterG, paid: paidG,
    paidMinusPrincipalMinusInterest: +(paidG - afterG.principal_amount - afterG.interest_charged).toFixed(2) };
  const stmtG = await get(admin, `/cases/${g}/statement`);
  out.G_statement_fields = [...stmtG.text.matchAll(/<span>([^<]+)<\/span>([^<]*)/g)].map(m => `${m[1]}: ${m[2].trim()}`);

  // Q. 违约后重组为更高利率（3%/月、120 个月）
  const rq = await post(admin, `/cases/${a}/restructures`, { effective_date: '2026-10-24', interest_mode: 'monthly', interest_rate: 3, tenure: 120, reason: 'QA higher rate after default' });
  out.Q_restructure_higher_rate = { loc: rq.loc, after: caseRow(a) };

  // I. 备注增改删是否写审计
  const auditBefore = q1('SELECT COUNT(*) n FROM audit_logs').n;
  await post(admin, `/cases/${a}/notes`, { content: 'QA note: debtor said will pay' });
  const nid = q1("SELECT id FROM timeline_events WHERE case_id=? AND event_type='note' ORDER BY id DESC", [a]).id;
  await post(admin, `/cases/${a}/notes/${nid}`, { content: 'QA note EDITED' });
  await post(admin, `/cases/${a}/notes/${nid}/delete`, {});
  out.I_notes = { noteRowStillExists: !!q1('SELECT 1 FROM timeline_events WHERE id=?', [nid]),
    auditRowsAdded: q1('SELECT COUNT(*) n FROM audit_logs').n - auditBefore };

  // J. 还款编辑 / 作废：原值是否保留
  const j = await mk('J_case', { interest_mode: 'fixed', interest_amount: 0 });
  await post(admin, `/cases/${j}/payments`, { amount: 100, payment_date: '2026-10-24', method: 'cash', reference: 'ORIG-REF' });
  const p = q1('SELECT * FROM payments WHERE case_id=?', [j]);
  await post(admin, `/cases/${j}/payments/${p.id}`, { amount: 90, payment_date: '2026-10-20', method: 'bank_transfer', reference: 'NEW-REF' });
  const pEdited = q1('SELECT amount,payment_date,method,reference FROM payments WHERE id=?', [p.id]);
  await post(admin, `/cases/${j}/payments/${p.id}/void`, {});
  out.J_payment = { receipt: p.receipt_no, edited: pEdited, rowAfterVoid: q1('SELECT * FROM payments WHERE id=?', [p.id]) || null,
    timeline: qa("SELECT content FROM timeline_events WHERE case_id=? AND event_type='payment'", [j]).map(r => r.content),
    audit: qa("SELECT action,details FROM audit_logs WHERE entity_id=? AND action LIKE 'payment%'", [j]) };
  await post(admin, `/cases/${j}/payments`, { amount: 50, payment_date: '2026-10-24', method: 'cash' });
  out.J_receipt_reused = q1('SELECT receipt_no FROM payments WHERE case_id=?', [j]).receipt_no;

  // K. 停用账号后原会话
  const ag3 = await login('agent3', 'agent123');
  const uid = q1("SELECT id FROM users WHERE username='agent3'").id;
  await post(admin, `/users/${uid}/toggle`, {});
  out.K_deactivated_session = { active: q1('SELECT active FROM users WHERE id=?', [uid]).active, casesStatus: (await get(ag3, '/cases')).status,
    debtorStatus: (await get(ag3, '/debtors/3')).status };
  await post(admin, `/users/${uid}/toggle`, {});

  // L. /demo-accounts 未登录
  const da = await get(null, '/demo-accounts');
  out.L_demo_accounts = { status: da.status, containsAdminPassword: da.text.includes('admin123') };

  // M. agent1 导出 CSV
  const ag1 = await login('agent1', 'agent123');
  const csv = await get(ag1, '/cases?format=csv');
  out.M_agent_csv = { type: csv.type, header: csv.text.replace(/^﻿/, '').split(/\r?\n/)[0] };

  // O. visit 类型任务 + 是否审计
  const ab = q1('SELECT COUNT(*) n FROM audit_logs').n;
  const t = await post(ag1, '/tasks/new', { case_id: 5, type: 'visit', title: 'QA visit debtor workplace', due_date: '2026-10-25' });
  out.O_visit_task = { loc: t.loc, saved: !!q1("SELECT 1 FROM tasks WHERE title='QA visit debtor workplace' AND type='visit'"),
    auditRowsAdded: q1('SELECT COUNT(*) n FROM audit_logs').n - ab };

  // P. 查看债务人资料是否留访问记录
  const fin = await login('finance', 'finance123');
  const pb = q1('SELECT COUNT(*) n FROM audit_logs').n;
  const dv = await get(fin, '/debtors/1');
  out.P_view_access_log = { status: dv.status, showsSalaryLabel: dv.text.includes('Salary'), showsGuarantor: dv.text.includes('Guarantor Phone'),
    auditRowsAdded: q1('SELECT COUNT(*) n FROM audit_logs').n - pb };

  // R. 破产 / 已故案件仍可新建 PTP、记还款
  const rp = await post(admin, '/cases/10/ptps', { amount: 100, due_date: '2026-11-01', remark: 'QA' });
  const rd = await post(admin, '/cases/11/payments', { amount: 10, payment_date: '2026-10-24', method: 'cash' });
  out.R_terminal = { bankruptcyCaseStatus: q1('SELECT status FROM cases WHERE id=10').status, ptp: rp.loc,
    deceasedCaseStatus: q1('SELECT status FROM cases WHERE id=11').status, payment: rd.loc };

  // S. 创建弱密码用户
  const su = await post(admin, '/users', { username: 'qa_weak', full_name: 'QA Weak', password: '1', role: 'finance' });
  out.S_weak_password_user = su.loc;

  // T. 审计日志页面能看到多少条
  const al = await get(admin, '/audit-log');
  out.T_audit_rows_rendered = (al.text.match(/<tr>/g) || []).length - 1;
  out.T_audit_rows_in_db = q1('SELECT COUNT(*) n FROM audit_logs').n;

  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
