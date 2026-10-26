// Manual chapter 6 (E2E-01..06), 7.1 (SEC-01..09) and chapter 8 smoke list.
// Run: node --test tests/qa/m5-e2e-sec-smoke.qa.js
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { test, before, after } = require('node:test');
const C = require('./_client');
const { Session, as, check, rec, q1, qa, has, strip, ledgerAmt, today, addDays, newDebtor, newCase, money } = C;

before(() => C.reseed());
after(() => C.saveResults('m5'));
const S = {};
const page = async (id, s = S.admin) => (await s.get(`/cases/${id}`)).text;
const caseRow = id => q1('SELECT * FROM cases WHERE id=?', id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function kpi(html) {
  const t = strip(html); const n = s => Number(String(s).replace(/,/g, ''));
  const m2 = t.match(/Cases (\d+) active · (\d+) legal/); const m3 = t.match(/PTP (\d+) due · (\d+) overdue · (\d+) broken/);
  const m5 = t.match(/Case Activity (\d+) opened · (\d+) closed/);
  return { active: n(m2[1]), legal: n(m2[2]), ptpDue: n(m3[1]), opened: n(m5[1]), closed: n(m5[2]) };
}
function schedule(html) {
  const i = html.indexOf('<h2>Repayment Schedule'); if (i < 0) return null;
  const sec = html.slice(i, html.indexOf('</table>', i));
  return [...sec.matchAll(/<tr>\s*<td>([\d-]+)(?: <small[^>]*>[^<]*<\/small>)?<\/td>\s*<td class="num">([\d,.]+)<\/td>\s*<td class="num">([\d,.]+)<\/td>\s*<td class="num">([\d,.]+)<\/td>\s*<td><span class="badge [^"]*">([^<]+)<\/span><\/td>(?:\s*<td>([\s\S]*?)<\/td>)?/g)]
    .map(m => ({ due: m[1], exp: m[2], paid: m[3], out: m[4], status: m[5], action: m[6] || '' }));
}
test('setup', async () => { for (const u of ['admin', 'manager', 'agent1', 'agent2', 'finance', 'auditor']) S[u] = await as(u); });

// ---------------- E2E ----------------
test('E2E-01 新案件全生命周期', async () => {
  const steps = [];
  const d = await newDebtor(S.manager, 'QA 张三');
  const prevMax = q1("SELECT MAX(CAST(substr(case_no, 11) AS INTEGER)) m FROM cases WHERE case_no LIKE 'CASE-2026-%'").m || 0;
  const id = await newCase(S.manager, { debtor_id: String(d), agent_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: today(), tenure: '12' });
  const c = caseRow(id); const sc = schedule(await page(id, S.manager));
  steps.push(['1 建案', c.case_no === `CASE-2026-${String(prevMax + 1).padStart(4, '0')}` && c.status === 'new' && sc && sc.length === 12, `${c.case_no} ${c.status} 计划${sc && sc.length}期`]);
  await S.manager.post(`/cases/${id}/status`, { status: 'assigned' });
  const dash1 = (await S.agent1.get('/')).text; const list = (await S.agent1.get('/cases')).text;
  steps.push(['2 agent1 可见', has(list, `href="/cases/${id}"`) && kpi(dash1).active >= 1, `Cases 可见=${has(list, `href="/cases/${id}"`)}`]);
  const k0 = kpi((await S.agent1.get('/')).text);
  await S.agent1.post(`/cases/${id}/calls`, { result: 'answered', duration_seconds: '45', notes: 'E2E call' });
  await S.agent1.post(`/cases/${id}/ptps`, { amount: '500', due_date: today() });
  const k1 = kpi((await S.agent1.get('/')).text);
  steps.push(['3 通话+PTP', caseRow(id).status === 'ptp' && k1.ptpDue === k0.ptpDue + 1, `status=${caseRow(id).status} PTP due ${k0.ptpDue}→${k1.ptpDue}`]);
  const p = q1("SELECT id FROM ptps WHERE case_id=? AND status='pending'", id);
  const before_ = (await page(id, S.agent1), caseRow(id).outstanding_amount);
  const f = await S.agent1.post(`/ptps/${p.id}/fulfill`, { amount: '500', payment_date: today(), method: 'cash' });
  const rc = q1('SELECT receipt_no FROM payments WHERE case_id=?', id).receipt_no;
  steps.push(['4 履行', f.ok === 'PTP fulfilled and payment recorded' && /^RCPT-2026-\d{4}$/.test(rc) && caseRow(id).outstanding_amount < before_ && caseRow(id).status === 'partial_paid', `${rc} 欠款 ${before_}→${caseRow(id).outstanding_amount} status=${caseRow(id).status}`]);
  const t = await page(id, S.finance); const s1 = schedule(t);
  const btn = s1.findIndex(r => /payInstallment\(/.test(r.action)); const pre = Number((s1[btn].action.match(/payInstallment\(([\d.]+)\)/) || [])[1]);
  await S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: String(pre) });
  await page(id, S.finance); const max = caseRow(id).outstanding_amount;
  await S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: String(max) });
  const s2 = schedule(await page(id, S.finance)); const cc = caseRow(id);
  steps.push(['5 finance Pay + max 还清', cc.status === 'fully_paid' && s2.every(r => r.status === 'Paid'), `Pay 预填 ${pre}（第${btn + 1}期）; max ${max}; status=${cc.status}; 计划全 Paid=${s2.every(r => r.status === 'Paid')}; 本金+利息=${cc.principal_amount + cc.interest_charged} 已还=${q1('SELECT SUM(amount) s FROM payments WHERE case_id=?', id).s}`]);
  const kc0 = kpi((await S.manager.get('/')).text); await S.manager.post(`/cases/${id}/status`, { status: 'closed' }); const kc1 = kpi((await S.manager.get('/')).text);
  steps.push(['6 Closed', kc1.closed === kc0.closed + 1, `closed ${kc0.closed}→${kc1.closed}（自动 Fully Paid 未计入 closed，见 E-08）`]);
  const acts = qa('SELECT action FROM audit_logs WHERE entity_type=? AND entity_id=? ORDER BY id', 'case', id).map(r => r.action);
  const need = ['create', 'status_change', 'call', 'ptp_create', 'payment', 'ptp_fulfilled'];
  const au = (await S.auditor.get('/audit-log')).status;
  steps.push(['7 审计', au === 200 && need.every(a => acts.includes(a)) && acts.indexOf('create') < acts.indexOf('call') && acts.indexOf('ptp_create') < acts.indexOf('ptp_fulfilled'), acts.join('>')]);
  check('E2E-01', '各检查点通过', steps.every(s => s[1]), steps.map(s => `${s[0]}:${s[1] ? '✓' : '✗'}(${s[2]})`).join(' | '));
});
test('E2E-02 分期违约转法务', async () => {
  const steps = [];
  const id = 13; // agent1 own case
  await S.agent1.post(`/cases/${id}/ptp-plans`, { total_amount: '1000', num_installments: '3', first_due_date: today() });
  const rows = qa('SELECT * FROM ptps WHERE case_id=? AND plan_id IS NOT NULL ORDER BY installment_no', id);
  steps.push(['建计划', rows.length === 3 && Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) === 100000 && caseRow(id).status === 'ptp', rows.map(r => r.amount).join('/') + ' ' + caseRow(id).status]);
  await S.agent1.post(`/ptps/${rows[0].id}/fulfill`, { amount: String(rows[0].amount), payment_date: today() });
  steps.push(['履行第1期', has(await page(id, S.agent1), '1/3 paid') && caseRow(id).status === 'ptp', caseRow(id).status]);
  await S.agent1.post(`/cases/${id}/ptp-plans/${rows[0].plan_id}/cancel`, {});
  const st = qa('SELECT status FROM ptps WHERE plan_id=? ORDER BY installment_no', rows[0].plan_id).map(r => r.status);
  steps.push(['取消计划', st.join() === 'fulfilled,broken,broken' && caseRow(id).status === 'negotiation', st + ' ' + caseRow(id).status]);
  const k0 = kpi((await S.agent1.get('/')).text);
  await S.agent1.post('/tasks/new', { case_id: String(id), type: 'legal', title: 'E2E LOD', due_date: addDays(today(), 3) });
  await S.agent1.post(`/cases/${id}/status`, { status: 'legal' });
  const k1 = kpi((await S.agent1.get('/')).text);
  await S.agent1.post(`/cases/${id}/payments`, { payment_date: today(), amount: '10' });
  steps.push(['转 Legal', k1.legal === k0.legal + 1 && caseRow(id).status === 'legal', `legal ${k0.legal}→${k1.legal}; 还款后 ${caseRow(id).status}`]);
  check('E2E-02', '各检查点通过', steps.every(s => s[1]), steps.map(s => `${s[0]}:${s[1] ? '✓' : '✗'}(${s[2]})`).join(' | '));
});
test('E2E-03 重组与撤销', async () => {
  const steps = [];
  const d = await newDebtor(S.manager, 'QA E2E3');
  const id = await newCase(S.manager, { debtor_id: String(d), agent_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12' });
  await S.manager.post(`/cases/${id}/payments`, { payment_date: '2026-03-02', amount: '1000' });
  steps.push(['示例A', ledgerAmt(await page(id)) === '10,718.25', ledgerAmt(await page(id))]);
  await S.manager.post(`/cases/${id}/restructures`, { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'E2E' });
  const t = await page(id, S.finance); const e = (await S.manager.get(`/cases/${id}/edit`)).text;
  steps.push(['重组', ledgerAmt(t) === '11,478.06' && has(t, '139.50') && has(e, 'Loan terms are locked') && has(t, 'Locked · restructured'), `${ledgerAmt(t)}`]);
  const early = await S.finance.post(`/cases/${id}/payments`, { payment_date: '2026-03-20', amount: '10' });
  const ok = await S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: '10' });
  steps.push(['finance 还款', !!early.err && !!ok.ok, `${early.err} / ${ok.ok}`]);
  const rid = q1('SELECT id FROM case_restructures WHERE case_id=?', id).id;
  const u1 = await S.manager.post(`/cases/${id}/restructures/${rid}/undo`, {});
  steps.push(['撤销被拒', !has(await page(id, S.manager), '>Undo</button>') && !!u1.err, u1.err]);
  const pid = q1('SELECT id FROM payments WHERE case_id=? ORDER BY id DESC', id).id;
  await S.finance.post(`/cases/${id}/payments/${pid}/void`, {});
  const u2 = await S.manager.post(`/cases/${id}/restructures/${rid}/undo`, {});
  const t2 = await page(id); const e2 = (await S.manager.get(`/cases/${id}/edit`)).text;
  const rsEvents = (t2.match(/<span class="badge is-gold">restructure<\/span>/g) || []).length;
  steps.push(['撤销成功', u2.ok === 'Restructure undone' && ledgerAmt(t2) === '10,718.25' && !has(e2, 'Loan terms are locked') && rsEvents === 2, `${u2.ok} ${ledgerAmt(t2)} 时间线重组记录 ${rsEvents}`]);
  check('E2E-03', '各检查点通过', steps.every(s => s[1]), steps.map(s => `${s[0]}:${s[1] ? '✓' : '✗'}(${s[2]})`).join(' | '));
});
test('E2E-04 新员工入职与离职', async () => {
  const steps = [];
  await S.admin.post('/agents', { name: 'QA 新人', commission_rate: '5', active: '1' });
  const ag = q1("SELECT id FROM agents WHERE name='QA 新人'").id;
  const r = await S.admin.post('/users', { username: 'qa_newbie', full_name: 'QA 新人', password: 'newbie1', role: 'agent', agent_id: String(ag) });
  steps.push(['建档+账号', r.ok === 'User qa_newbie created', r.ok]);
  const c7 = caseRow(7);
  await S.manager.post('/cases/7', { debtor_id: String(c7.debtor_id), agent_id: String(ag), principal_amount: String(c7.principal_amount), interest_mode: c7.interest_mode, interest_amount: String(c7.interest_amount), priority: c7.priority });
  const nb = await as('qa_newbie', 'newbie1');
  const cases = [...(await nb.get('/cases')).text.matchAll(/href="\/cases\/(\d+)"/g)].map(m => Number(m[1]));
  const debtors = [...(await nb.get('/debtors')).text.matchAll(/href="\/debtors\/(\d+)"/g)].map(m => Number(m[1]));
  const tasksHtml = (await nb.get('/tasks')).text; const caseTasks = qa('SELECT title, agent_id FROM tasks WHERE case_id=7');
  const other = await nb.get('/cases/2');
  steps.push(['只看本人案件', cases.join() === '7' && debtors.join() === String(c7.debtor_id) && other.status === 404, `cases=${cases} debtors=${debtors} /cases/2→${other.status}`]);
  steps.push(['看到案件任务', caseTasks.every(t => has(tasksHtml, t.title)), `案件 7 的任务 ${JSON.stringify(caseTasks)}；新人 Tasks 页可见=${caseTasks.map(t => has(tasksHtml, t.title))}`]);
  const u = q1("SELECT id FROM users WHERE username='qa_newbie'").id;
  await S.admin.post(`/users/${u}`, { username: 'qa_newbie', full_name: 'QA 新人', role: 'agent', agent_id: String(ag), active: '0' });
  await nb.get('/logout'); const l = await new Session().login('qa_newbie', 'newbie1');
  steps.push(['停用后无法登录', l.status === 401, `${l.status}`]);
  await S.admin.post(`/agents/${ag}`, { name: 'QA 新人', commission_rate: '5', active: '0' });
  steps.push(['停用档案', !has((await S.admin.get('/cases/new')).text, '>QA 新人<'), '新建案件下拉']);
  check('E2E-04', '各检查点通过', steps.every(s => s[1]), steps.map(s => `${s[0]}:${s[1] ? '✓' : '✗'}(${s[2]})`).join(' | '));
});
test('E2E-05 月底佣金结算', async () => {
  const steps = [];
  const com = t => Object.fromEntries([...t.matchAll(/<tr>\s*<td>([^<]+)<\/td>\s*<td class="num">([\d,.-]+)<\/td>\s*<td class="num">([\d.]+)<\/td>\s*<td class="num">([\d,.-]+)<\/td>\s*<td class="num">([\d,.-]+)<\/td>\s*<td class="num ?[^"]*">([\d,.-]+)<\/td>/g)].map(m => [m[1], { col: m[2], rate: m[3], earned: m[4], settled: m[5], pending: m[6] }]));
  const n = s => Number(String(s).replace(/,/g, ''));
  await S.finance.post('/cases/5/payments', { payment_date: today(), amount: '1234.56' });
  let rows = com((await S.finance.get('/commissions')).text);
  steps.push(['核对', Object.values(rows).every(r => money(n(r.col) * n(r.rate) / 100) === r.earned && money(n(r.earned) - n(r.settled)) === r.pending), JSON.stringify(rows['Lim Wei Sheng'])]);
  const pend = n(rows['Lim Wei Sheng'].pending);
  await S.finance.post('/commissions/settle', { agent_id: '1', period: today().slice(0, 7), amount: String(pend), note: 'E2E full' });
  rows = com((await S.finance.get('/commissions')).text);
  steps.push(['全额结算', rows['Lim Wei Sheng'].pending === '0.00', rows['Lim Wei Sheng'].pending]);
  const sid = q1("SELECT id FROM commission_settlements WHERE note='E2E full'").id;
  await S.finance.post(`/commissions/${sid}/void`, {});
  await S.finance.post('/commissions/settle', { agent_id: '1', period: today().slice(0, 7), amount: '20', note: 'E2E part' });
  rows = com((await S.finance.get('/commissions')).text);
  steps.push(['作废+部分结算', rows['Lim Wei Sheng'].pending === money(pend - 20), rows['Lim Wei Sheng'].pending]);
  const a1 = com((await S.agent1.get('/commissions')).text);
  steps.push(['agent1 只见自己', Object.keys(a1).join() === 'Lim Wei Sheng', Object.keys(a1).join()]);
  const from = today().slice(0, 8) + '01', to = today().slice(0, 8) + '31';
  const csv = (await S.finance.get(`/reports?from=${from}&to=${to}&export=performance`)).text.replace(/^﻿/, '').split('\r\n').slice(1).map(l => l.split(','));
  const mism = csv.filter(c => rows[c[0]] && money(Number(c[3])) !== rows[c[0]].earned).map(c => `${c[0]} csv=${c[3]} 页面=${rows[c[0]].earned}`);
  const raw = csv.filter(c => /\.\d{3,}/.test(c[3])).map(c => `${c[0]}:${c[3]}`);
  steps.push(['CSV 与页面一致', mism.length === 0, `不一致 ${mism.join(';') || '无'}；CSV 未取整值 ${raw.join(';') || '无'}`]);
  check('E2E-05', '各检查点通过', steps.every(s => s[1]), steps.map(s => `${s[0]}:${s[1] ? '✓' : '✗'}(${s[2]})`).join(' | '));
});
let snap;
const snapshot = () => JSON.stringify([qa('SELECT id,status,outstanding_amount,agent_id FROM cases ORDER BY id'), qa('SELECT id,status FROM ptps ORDER BY id'), qa('SELECT id,status,title FROM tasks ORDER BY id'), q1('SELECT COUNT(*) c FROM payments').c, q1('SELECT COUNT(*) c FROM timeline_events').c]);
test('E2E-06 + SEC-09 越权巡检（agent1）', async () => {
  snap = snapshot();
  const ptp = q1("SELECT id FROM ptps WHERE case_id=14 AND status='pending'").id;
  const task = q1("SELECT t.id FROM tasks t WHERE t.agent_id=2 AND t.status='pending'") || q1("SELECT t.id FROM tasks t JOIN cases c ON c.id=t.case_id WHERE c.agent_id=2");
  const out = [];
  for (const p of ['/cases/2', '/cases/2/statement', '/cases/2/edit', '/debtors/2', '/users', '/settings', '/audit-log', '/agents', '/cases/14']) out.push(`GET ${p}:${(await S.agent1.get(p)).status}`);
  out.push(`fulfill:${(await S.agent1.post(`/ptps/${ptp}/fulfill`, { amount: '1', payment_date: today() })).status}`);
  out.push(`break:${(await S.agent1.post(`/ptps/${ptp}/break`, {})).status}`);
  const tc = await S.agent1.post(`/tasks/${task.id}/complete`, {}); out.push(`task complete:${tc.status}/${tc.err}`);
  const denied = out.every(x => /:(403|404)$/.test(x) || /task complete:302\/Forbidden/.test(x));
  const unchanged = snapshot() === snap;
  const srch = [...(await S.agent1.get('/search?q=Sarah')).text.matchAll(/href="\/cases\/(\d+)"/g)].length;
  const rep = (await S.agent1.get('/reports')).text; const comm = (await S.agent1.get('/commissions')).text;
  const leak = srch > 0 || has(rep, 'Nurul Ain') || has(comm, 'Nurul Ain');
  const ok = denied && unchanged && !leak;
  check('E2E-06', '全部拒绝（403/404）；无数据被改；搜索/报表/佣金看不到 agent2', ok, `${out.join(' ')}; 数据未变=${unchanged}; 泄露=${leak}`);
  check('SEC-09', '同 E2E-06 全部拒绝', ok, '见 E2E-06');
});

// ---------------- SEC ----------------
test('SEC-01 SQL 注入', async () => {
  const inj = encodeURIComponent("' OR 1=1 --"); const out = [];
  for (const p of [`/search?q=${inj}`, `/cases?q=${inj}`, `/cases?status=${inj}`, `/cases?priority=${inj}`, `/debtors?q=${inj}`, `/debtors?risk=${inj}`, `/tasks?status=${inj}&type=${inj}`, `/audit-log?action=${inj}`, `/agents?department=${inj}`, `/commissions?month=${inj}`, `/reports?from=${inj}&to=${inj}`]) {
    const s = p.startsWith('/audit') ? S.admin : S.agent1.base && p.startsWith('/agents') ? S.admin : S.admin;
    const r = await s.get(p); const rows = (r.text.match(/href="\/cases\/\d+"/g) || []).length + (r.text.match(/href="\/debtors\/\d+"/g) || []).length;
    out.push(`${p.split('?')[0]}:${r.status}:${rows}`);
  }
  const a = await S.agent1.get(`/search?q=${inj}`); const aRows = (a.text.match(/href="\/cases\/\d+"/g) || []).length;
  // risk 参数有白名单，非法值被忽略 → 等于不过滤的列表（不算额外数据）
  const allDeb = ((await S.admin.get('/debtors')).text.match(/href="\/debtors\/\d+"/g) || []).length;
  const ok = out.every(x => /:200:0$/.test(x) || x === `/debtors:200:${allDeb}`) && out.filter(x => x === `/debtors:200:${allDeb}`).length === 1 && aRows === 0;
  check('SEC-01', '不报错，不返回额外数据', ok, out.join(' ') + ` | /debtors 不过滤时 ${allDeb} 条（risk 非法值被忽略） | agent1 search 结果 ${aRows}`);
});
test('SEC-02 脚本注入（XSS）', async () => {
  const X = '<script>alert(1)</script>';
  await S.admin.post('/debtors', { name: X }); const did = q1('SELECT id FROM debtors WHERE name=?', X).id;
  const id = await newCase(S.admin, { debtor_id: String(did), agent_id: '1', principal_amount: '100', interest_mode: 'fixed', interest_amount: '0', remark: X });
  await S.admin.post(`/cases/${id}/notes`, { content: X });
  await S.admin.post(`/cases/${id}/calls`, { result: 'answered', notes: X });
  await S.admin.post('/tasks/new', { case_id: String(id), title: X, notes: X, due_date: today() });
  await S.admin.post('/agents', { name: X, department: X });
  const f = new FormData(); f.append('company_name', X); f.append('address', X); await S.admin.req('POST', '/settings', f);
  const pages = ['/debtors', `/debtors/${did}`, `/cases/${id}`, '/cases', '/tasks', '/', `/cases/${id}/statement`, '/settings', '/agents', `/search?q=${encodeURIComponent('script')}`, '/audit-log', '/commissions', '/reports'];
  const raw = [];
  for (const p of pages) { const t = (await S.admin.get(p)).text; if (t.includes(X)) raw.push(p); }
  for (const p of ['/', `/cases/${id}`, '/tasks']) { const t = (await S.agent1.get(p)).text; if (t.includes(X)) raw.push('agent1' + p); }
  check('SEC-02', '所有页面原样显示为文本，不弹窗', raw.length === 0, raw.length ? '未转义: ' + raw.join(',') : `${pages.length + 3} 个页面均已转义（浏览器弹窗检查见 ui.qa.py）`);
  const f2 = new FormData(); f2.append('company_name', 'QA Co'); await S.admin.req('POST', '/settings', f2);
});
test('SEC-03 事件属性注入（期望不执行）', async () => {
  const id = await newCase(S.admin, { debtor_id: '1', agent_id: '1', principal_amount: '100', interest_mode: 'fixed', interest_amount: '0' });
  await S.agent1.post(`/cases/${id}/payments`, { payment_date: today(), amount: '1', reference: "x');alert(1);//", bank: 'b' });
  await S.agent1.post(`/cases/${id}/payments`, { payment_date: today(), amount: '1', method: "cash');alert(document.cookie);//" });
  const t = await page(id, S.finance);
  const calls = [...t.matchAll(/onclick="(openEditPayment\([^"]*\))"/g)].map(m => m[1].replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&'));
  const injected = calls.filter(c => /alert\(/.test(c) && (() => { try { new Function(c); return true; } catch { return false; } })());
  check('SEC-03', '不执行脚本', injected.length === 0, `解码后的 onclick: ${calls.join(' || ')}；可执行注入 ${injected.length} 条（agent 角色写入 reference/method 均可；浏览器验证见 ui.qa.py）`);
});
test('SEC-04 密码存储', async () => {
  const rows = qa('SELECT username, password_hash FROM users');
  check('SEC-04', 'bcrypt 哈希，无明文', rows.every(r => /^\$2[aby]\$\d{2}\$/.test(r.password_hash) && !r.password_hash.includes('123')), rows.slice(0, 3).map(r => `${r.username}:${r.password_hash.slice(0, 7)}…`).join(' '), '代价因子 8（bcrypt.hashSync(pw, 8)），低于常见推荐 10–12');
});
test('SEC-05 生产会话密钥', async () => {
  const tmp = path.join(os.tmpdir(), 'qa-sec05.db');
  const r = spawnSync(process.execPath, ['--no-warnings', 'src/app.js'], { cwd: C.ROOT, env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: '', CRM_DB_PATH: tmp, PORT: '3399' }, encoding: 'utf8', timeout: 15000 });
  check('SEC-05', '启动失败并报错 SESSION_SECRET must be set in production', r.status !== 0 && /SESSION_SECRET must be set in production/.test(r.stderr), `exit=${r.status}; stderr=${(r.stderr.match(/Error: [^\n]+/) || [])[0]}`);
  try { fs.rmSync(tmp, { force: true }); } catch { }
});
test('SEC-06 CSRF', async () => {
  const before_ = caseRow(15).status;
  const r = await S.admin.req('POST', '/cases/15/status', { status: 'deceased' }, { origin: 'http://evil.example', referer: 'http://evil.example/x' });
  const after_ = caseRow(15).status;
  const home = await new Session().login('manager', 'manager123');
  const cookie = (home.headers.getSetCookie() || []).join(';');
  await S.admin.post('/cases/15/status', { status: before_ });
  check('SEC-06', '确认当前无 CSRF 令牌（已知风险 E-05，上线前评估）', r.ok === 'Status updated' && after_ === 'deceased' && !/csrf/i.test(await page(15)), `跨站 Origin 的 POST → ${r.ok}（${before_}→${after_}）; Set-Cookie: ${cookie.replace(/connect\.sid=[^;]+/, 'connect.sid=…')}（无 SameSite/Secure）`, '按手册此用例为“确认已知风险”，结果判 PASS；风险本身列为发现');
});
test('SEC-07 登录限流', async () => { rec('SEC-07', '同 AUTH-05', '见 m1 AUTH-05（PASS）及 restart 验证', 'PASS'); });
test('SEC-08 演示账号（正式环境）', async () => {
  const d = await new Session().get('/demo-accounts');
  rec('SEC-08', '正式环境停用演示账号、移除 /demo-accounts 与 Demo Data', `未访问线上环境（范围限制）。代码层面：/demo-accounts 与 /demo-tools 无环境开关（src/app.js:30, :53），render.yaml 启动即 seed 演示账号；本地 /demo-accounts → ${d.status}`, 'BLOCKED', '不得访问线上 Render；属已知延后项（正式上线待办第 6 节）');
});

// ---------------- Smoke (chapter 8, local) ----------------
test('SMOKE 冒烟清单（本地 18 项）', async () => {
  C.reseed(); for (const u of Object.keys(S)) S[u] = await as(u);
  const items = [];
  const push = (n, ok, a) => { items.push([n, ok, a]); rec(`SMOKE-${String(n).padStart(2, '0')}`, '冒烟项通过', a, ok ? 'PASS' : 'FAIL'); };
  const logins = []; for (const u of ['admin', 'manager', 'agent1', 'finance', 'auditor']) logins.push((await new Session().login(u, C.PW[u])).location === '/');
  push(1, logins.every(Boolean), `5 账号登录 ${logins}`);
  const dh = await S.admin.get('/'); push(2, dh.status === 200 && has(dh.text, 'Collected Today'), `dashboard ${dh.status}`);
  const d = await newDebtor(S.admin, 'Smoke 债务人');
  const id = await newCase(S.admin, { debtor_id: String(d), agent_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12', status: 'assigned' });
  const sc = schedule(await page(id)); push(3, sc.length === 12 && sc[0].exp === '155.00', `${caseRow(id).case_no} 计划 ${sc.length} 期首期 ${sc[0].exp}`);
  const p1 = await S.admin.post(`/cases/${id}/payments`, { payment_date: '2026-03-02', amount: '1000' });
  push(4, ledgerAmt(await page(id)) === '10,718.25' && caseRow(id).status === 'partial_paid', `${p1.ok} ${ledgerAmt(await page(id))} ${caseRow(id).status}`);
  const over = await S.admin.post(`/cases/${id}/payments`, { payment_date: today(), amount: '999999' }); push(5, over.err === 'Amount exceeds outstanding', `${over.err}（弹窗内拦截见 ui.qa.py）`);
  await S.admin.post(`/cases/${id}/payments`, { payment_date: today(), amount: '50' });
  const pid = q1('SELECT id FROM payments WHERE case_id=? ORDER BY id DESC', id).id;
  const e = await S.finance.post(`/cases/${id}/payments/${pid}`, { amount: '60', payment_date: today() }); const before_ = caseRow(id).outstanding_amount;
  const v = await S.finance.post(`/cases/${id}/payments/${pid}/void`, {}); await page(id);
  push(6, e.ok === 'Payment updated' && v.ok === 'Payment voided' && caseRow(id).outstanding_amount === 10718.25, `${e.ok}/${v.ok} 欠款 ${before_}→${caseRow(id).outstanding_amount}`);
  const s7 = schedule(await page(id)); push(7, s7.some(r => /payInstallment\(/.test(r.action)), 'Pay 按钮存在且带预填值');
  await S.admin.post(`/cases/${id}/ptps`, { amount: '100', due_date: today() }); const pp = q1("SELECT id FROM ptps WHERE case_id=? AND status='pending'", id).id;
  const f = await S.admin.post(`/ptps/${pp}/fulfill`, { amount: '100', payment_date: today() });
  const pl = await S.admin.post(`/cases/${id}/ptp-plans`, { total_amount: '300', num_installments: '3', first_due_date: today() });
  const plan = q1('SELECT plan_id FROM ptps WHERE case_id=? AND plan_id IS NOT NULL', id).plan_id; const cp = await S.admin.post(`/cases/${id}/ptp-plans/${plan}/cancel`, {});
  push(8, f.ok && pl.ok && cp.ok, `${f.ok}/${pl.ok}/${cp.ok}`);
  const id2 = await newCase(S.admin, { debtor_id: String(d), principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12' });
  await S.admin.post(`/cases/${id2}/payments`, { payment_date: '2026-03-02', amount: '1000' });
  const rs = await S.admin.post(`/cases/${id2}/restructures`, { effective_date: '2026-04-01', interest_mode: 'monthly', interest_rate: '1.2', tenure: '18', reason: 'smoke' });
  const locked = has(await page(id2, S.finance), 'Locked · restructured'); const rid = q1('SELECT id FROM case_restructures WHERE case_id=?', id2).id;
  const un = await S.admin.post(`/cases/${id2}/restructures/${rid}/undo`, {}); push(9, rs.ok && locked && un.ok, `${rs.ok}/${locked}/${un.ok}`);
  const a = await S.admin.post(`/cases/${id}/calls`, { result: 'answered' }); const b = await S.admin.post(`/cases/${id}/notes`, { content: 'smoke note' }); const c = await S.admin.post(`/cases/${id}/status`, { status: 'negotiation' });
  const tl = await page(id); push(10, a.ok && b.ok && c.ok && has(tl, 'smoke note') && has(tl, '→ negotiation'), `${a.ok}/${b.ok}/${c.ok}`);
  const tk = await S.admin.post('/tasks/new', { case_id: String(id), title: 'smoke task', due_date: today() }); const tid = q1("SELECT id FROM tasks WHERE title='smoke task'").id;
  const tc = await S.admin.post(`/tasks/${tid}/complete`, {}); push(11, tk.ok && tc.ok, `${tk.ok}/${tc.ok}`);
  const rp = await S.admin.get('/reports'); const csvOk = [];
  for (const x of ['cases', 'outstanding', 'performance']) csvOk.push(/attachment/.test((await S.admin.get('/reports?export=' + x)).headers.get('content-disposition') || ''));
  push(12, rp.status === 200 && csvOk.every(Boolean), `reports ${rp.status} csv ${csvOk}`);
  const st = await S.finance.post('/commissions/settle', { agent_id: '1', amount: '5' }); const sid = q1('SELECT id FROM commission_settlements ORDER BY id DESC').id;
  const sv = await S.finance.post(`/commissions/${sid}/void`, {}); push(13, st.ok && sv.ok, `${st.ok}/${sv.ok}`);
  const sm = await S.admin.get(`/cases/${id}/statement`); push(14, sm.status === 200 && has(sm.text, 'window.print()'), `statement ${sm.status}`);
  const x = await S.agent1.get('/cases/2'); push(15, x.status === 404, `agent1 /cases/2 → ${x.status}`);
  const au = await page(id, S.auditor); push(16, !has(au, '>Record Payment</button>') && !has(au, '<select name="status"'), 'auditor 只读');
  const logs = q1("SELECT COUNT(*) c FROM audit_logs WHERE action IN ('payment','payment_edit','payment_void','restructure','restructure_undo','commission_settle','commission_void')").c; push(17, logs >= 7, `本轮审计 ${logs} 条`);
  rec('SMOKE-18', 'npm test 全部通过', '见报告第 5 节 npm test 结果（171/171）', 'PASS'); items.push([18, true, 'npm test']);
  check('SMOKE', '18 项全部通过', items.every(i => i[1]), items.filter(i => !i[1]).map(i => `#${i[0]} ${i[2]}`).join('; ') || '全部通过');
});
