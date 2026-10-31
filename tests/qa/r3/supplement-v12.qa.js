// QA 手册 v1.2 补测：r2 脚本（按 v1.10.0 写）因 v1.11.0 规则变更而 BLOCKED / FAIL 的用例，
// 按手册 v1.2 的写法重测；外加 v1.2 新增、冒烟清单没覆盖的 CASE-25、INT-17、RS-27、TASK-13。
// 只对本地 tester 服务：CRM_DB_PATH=data/qa/tester-r2.db PORT=3301 node --no-warnings src/app.js
// Run: node --no-warnings tests/qa/r3/supplement-v12.qa.js   （开头重新 seed tester-r2.db；QA_OUT=<目录> 指定结果位置）
const fs = require('node:fs');
const path = require('node:path');
const c = require('../r2/_client');
const { reseed, step } = require('../r2/_run');
const { q1, qa, check, rec, strip, has, ledgerVal, ledgerSmall, num, scheduleRows, newDebtor, newCase, today, addDays } = c;

if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(c.BASE)) throw new Error('local only');
const lead = (h) => ledgerVal(h, 'Settlement Today');
const addMonths = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(d, last)); return t.toISOString().slice(0, 10); };
const badge = (h) => (h.match(/<h1>[^<]*<span class="badge[^"]*"><span class="dot"><\/span>([^<]+)<\/span>/) || [])[1];
const M = (o = {}) => ({ principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12', ...o });
// 浏览器提交 Edit Case 时会带上表单的全部字段（r2 脚本少带了期限等字段，所以在 N-02 下被拒）
const editForm = (id, o = {}) => {
  const cs = q1('SELECT * FROM cases WHERE id=?', id);
  return { debtor_id: String(cs.debtor_id), agent_id: cs.agent_id ? String(cs.agent_id) : '', principal_amount: String(cs.principal_amount),
    loan_start_date: cs.loan_start_date || '', tenure: cs.tenure ? String(cs.tenure) : '', interest_mode: cs.interest_mode,
    interest_amount: cs.interest_amount == null ? '' : String(cs.interest_amount), interest_rate: cs.interest_rate == null ? '' : String(cs.interest_rate),
    priority: cs.priority, remark: cs.remark || '', ...o };
};
const pay = (s, id, amount, ref, date = today()) => s.act(`/cases/${id}/payments`, { payment_date: date, amount: String(amount), method: 'cash', reference: ref, bank: '' });
const rcpt = (r) => ((r.ok || '').match(/RCPT-\d{4}-(\d{4})/) || [])[1];

(async () => {
  reseed();
  const admin = await c.as('admin'), man = await c.as('manager'), fin = await c.as('finance');
  const deb = await newDebtor(admin, 'QA v1.2 补测（虚构）');

  // 设置页：带上现有公司信息一起提交（直接 POST 缺的字段会被清空）
  const setCap = (v) => {
    const s = q1('SELECT * FROM settings WHERE id=1'), f = new FormData();
    for (const k of ['company_name', 'address', 'phone', 'email', 'reg_no']) f.append(k, s[k] || '');
    f.append('max_annual_rate', String(v));
    return admin.act('/settings', f);
  };

  await step('S-INT-03', 'Fixed 1,000 + 150、12 个月（15% p.a.）→ 合同欠款 1,150.00', async () => {
    const id = await newCase(admin, { debtor_id: String(deb), principal_amount: '1000', interest_mode: 'fixed', interest_amount: '150', loan_start_date: addDays(today(), -10), tenure: '12' });
    const h = (await admin.get(`/cases/${id}`)).text;
    check('S-INT-03', 'INT-03（v1.2）：Total Outstanding = 1,150.00（v1.11.0 起标签为 Contract Balance）', ledgerVal(h, 'Contract Balance') === '1,150.00',
      `Contract Balance ${ledgerVal(h, 'Contract Balance')}；Settlement Today ${lead(h)}`);
  });

  await step('S-INT-07', '起始日为今天、12 个月 → 今日结清额 = 本金', async () => {
    const id = await newCase(admin, { debtor_id: String(deb), ...M({ loan_start_date: today() }) });
    const h1 = (await admin.get(`/cases/${id}`)).text, h2 = (await admin.get(`/cases/${id}`)).text;
    check('S-INT-07', 'INT-07（v1.2）：Settlement Today = 本金 10,000.00，刷新不变', lead(h1) === '10,000.00' && lead(h2) === '10,000.00', `Settlement Today ${lead(h1)} / 刷新后 ${lead(h2)}`);
  });

  await step('S-INT-09', '计息案件不填起始日 → 取开案日并注明', async () => {
    const id = await newCase(admin, { debtor_id: String(deb), ...M({ loan_start_date: '' }) });
    const h = (await admin.get(`/cases/${id}`)).text;
    check('S-INT-09', 'INT-09（v1.2）：Loan Start Date 注明“(unset, defaults to opened)”', has(h, '(unset, defaults to opened)'), strip(h).match(/Loan Start Date[^|]{0,80}/)?.[0]);
  });

  await step('S-INT-17', '篡改 tenure_unit=days → 存为 months', async () => {
    const r = await admin.post('/cases', { debtor_id: String(deb), principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.0', loan_start_date: today(), tenure: '12', tenure_unit: 'days', priority: 'medium', status: 'new' });
    const id = Number((r.location.match(/^\/cases\/(\d+)$/) || [])[1]);
    const cs = id && q1('SELECT tenure, tenure_unit, maturity_date FROM cases WHERE id=?', id);
    check('S-INT-17', 'INT-17：保存后期限单位仍是 months', cs && cs.tenure_unit === 'months', JSON.stringify(cs));
  });

  let c04;
  await step('S-CASE-04', 'Fixed 带期限新建 → Case created、编号、时间线、审计', async () => {
    // 手册原例 Fixed 1,000 + 200：期限 < 14 个月就超过 18% p.a.，这里用 14 个月（17.14%）
    const r = await admin.act('/cases', { debtor_id: String(deb), agent_id: '1', principal_amount: '1000', interest_mode: 'fixed', interest_amount: '200', loan_start_date: today(), tenure: '14', priority: 'medium', status: 'new' });
    c04 = Number((r.location.match(/^\/cases\/(\d+)$/) || [])[1]);
    const cs = q1('SELECT case_no FROM cases WHERE id=?', c04);
    const aud = q1("SELECT 1 x FROM audit_logs WHERE action='create' AND entity_type='case' AND entity_id=?", c04);
    check('S-CASE-04', 'CASE-04：提示“Case created”；CASE-年份-四位序号；时间线“Case … created”；审计 create case',
      r.ok === 'Case created' && /^CASE-\d{4}-\d{4}$/.test(cs.case_no) && /Case \S+ created/.test(strip(r.html)) && !!aud, `${r.ok}；${cs.case_no}；审计=${!!aud}`);
  });

  await step('S-CASE-08', 'Edit Case 改催收员、优先级、备注（完整表单）', async () => {
    const r = await man.act(`/cases/${c04}`, editForm(c04, { agent_id: '2', priority: 'high', remark: 'S-CASE-08' }));
    const cs = q1('SELECT agent_id, priority, remark FROM cases WHERE id=?', c04);
    const aud = q1("SELECT details FROM audit_logs WHERE action='update' AND entity_type='case' AND entity_id=? ORDER BY id DESC", c04);
    check('S-CASE-08', 'CASE-08：提示“Saved”，详情更新；审计 update case', r.ok === 'Saved' && cs.agent_id === 2 && cs.priority === 'high' && cs.remark === 'S-CASE-08' && !!aud, `${r.ok || r.err}；${JSON.stringify(cs)}；审计 "${aud && aud.details}"`);
  });

  await step('S-INT-12/14', '上限 24 被拒、12 可存；12 时旧案件只改催收员可以保存（INT-14）', async () => {
    const formCase = await newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M({ loan_start_date: today() }) }); // 18% p.a.，在调低上限之前建
    try {
      const r0 = await setCap('0'), r24 = await setCap('24'), r12 = await setCap('12');
      const st = (await admin.get('/settings')).text;
      const box = strip(st).match(/Open loans above the 12% p\.a\. cap:[^—]*/);
      const aud = q1("SELECT details FROM audit_logs WHERE entity_type='settings' ORDER BY id DESC").details;
      const r11 = await admin.act('/cases', { debtor_id: String(deb), ...M({ interest_rate: '1.1', loan_start_date: today() }), priority: 'medium', status: 'new' });
      const msg = 'Max annual interest rate must be above 0 and at most 18% (the legal limit)';
      check('S-SET-09', 'SET-09（v1.2）：0 和 24 提示“…above 0 and at most 18% (the legal limit)”；12 可以保存', r0.err === msg && r24.err === msg && r12.ok === 'Company settings saved', `0 → ${r0.err}；24 → ${r24.err}；12 → ${r12.ok || r12.err}`);
      check('S-INT-12', 'INT-12（v1.2）：24 被拒；12 保存，审计“max_annual_rate: 18 → 12”，设置页列出超限在办贷款；1.1%/月（13.2%）被拒',
        r24.err === msg && r12.ok && /max_annual_rate: 18 → 12/.test(aud) && !!box && /exceeds the 12% p\.a\. limit/.test(r11.err || ''), `审计 "${aud}"；红框 "${box && box[0].slice(0, 160)}"；1.1% → ${r11.err || r11.ok}`);
      // INT-14：只改催收员可以保存；改条款才检查上限
      const a = await man.act(`/cases/${formCase}`, editForm(formCase, { agent_id: '2' }));
      const b = await man.act('/cases/2', editForm(2, { agent_id: '1', remark: 'S-INT-14 只改催收员' }));
      const t = await man.act(`/cases/${formCase}`, editForm(formCase, { tenure: '24' }));
      check('S-INT-14a', 'INT-14：表单新建的 18% 旧案件（上限 12 时）只改催收员 → Saved；改期限 → 被拒', a.ok === 'Saved' && /exceeds the 12% p\.a\. limit/.test(t.err || ''), `只改催收员 → ${a.ok || a.err}；改期限 → ${t.err || t.ok}`);
      check('S-INT-14b', 'INT-14：演示案件 2（18%，上限 12 时）只改催收员和备注 → 可以保存', b.ok === 'Saved', `→ ${b.ok || b.err}；存储 ${JSON.stringify(q1('SELECT interest_mode, interest_rate, interest_amount FROM cases WHERE id=2'))}`,
        b.ok ? '' : '演示种子给计息贷款存了非零 interest_amount，编辑时服务端按 0 比较（src/routes/cases.js:200-207），被当成改了条款');
    } finally {
      const r18 = await setCap('18');
      const r = await admin.act('/cases', { debtor_id: String(deb), ...M({ interest_rate: '1.1', loan_start_date: today() }), priority: 'medium', status: 'new' });
      rec('S-INT-12-restore', '改回 18 后 1.1%/月可以建案', `18 → ${r18.ok || r18.err}；1.1% → ${r.ok || r.err}`, r18.ok && r.ok === 'Case created' ? 'PASS' : 'FAIL');
    }
  });

  await step('S-PAY-12/18', '收据号连续；同一表单 10 秒内重复提交只记一笔', async () => {
    const id = await newCase(admin, { debtor_id: String(deb), ...M({ loan_start_date: addMonths(today(), -2) }) });
    const p1 = await pay(man, id, 100, 'S-PAY-12 a'), p2 = await pay(man, id, 100, 'S-PAY-12 b');
    check('S-PAY-12', 'PAY-12：连续记两笔（Reference 不同）→ 收据号递增 1', Number(rcpt(p2)) === Number(rcpt(p1)) + 1, `${p1.ok} / ${p2.ok}`);
    const d1 = await pay(man, id, 50, 'S-PAY-18 dup'), d2 = await pay(man, id, 50, 'S-PAY-18 dup'), d3 = await pay(man, id, 50, 'S-PAY-18 other');
    const n = q1("SELECT COUNT(*) n FROM payments WHERE case_id=? AND reference LIKE 'S-PAY-18%'", id).n;
    check('S-PAY-18', 'PAY-18：前两次只记一笔、一个收据号；Reference 不同的记为第二笔', rcpt(d1) === rcpt(d2) && rcpt(d3) !== rcpt(d1) && n === 2, `${d1.ok} / ${d2.ok} / ${d3.ok}；入账 ${n} 笔`,
      d2.ok && /recorded/.test(d2.ok) ? '第二次提交仍显示“Payment … recorded”（同一收据号），没有提示是重复提交' : '');
  });

  await step('S-SCH-06', '计划各期状态 Paid / Overdue / Partially Paid / Pending', async () => {
    const start = addDays(addMonths(today(), -1), -5); // 第一期 5 天前到期
    const a = await newCase(admin, { debtor_id: String(deb), ...M({ loan_start_date: start }) });
    const b = await newCase(admin, { debtor_id: String(deb), ...M({ loan_start_date: start }) });
    const first = scheduleRows((await admin.get(`/cases/${a}`)).text)[0].expected;
    await pay(man, a, first, 'S-SCH-06 a'); await pay(man, a, 50, 'S-SCH-06 b');
    const ra = scheduleRows((await admin.get(`/cases/${a}`)).text).slice(0, 3).map(r => r.status);
    const rb = scheduleRows((await admin.get(`/cases/${b}`)).text).slice(0, 2).map(r => r.status);
    check('S-SCH-06', 'SCH-06：Paid = 已还清；Overdue = 过期未还清；Partially Paid = 未到期已部分还；Pending = 未到期未还', ra.join() === 'Paid,Partially Paid,Pending' && rb.join() === 'Overdue,Pending',
      `还第一期 ${first} + 50 → ${ra}；未还的案件 → ${rb}`);
  });

  await step('S-DEB-01/SRCH-01', '用新的演示证件号片段搜索', async () => {
    const ic = q1('SELECT ic_passport FROM debtors WHERE id=3').ic_passport; // 850020-00-5533（G-10 改为无效号段）
    const frag = ic.slice(0, 6);
    const dl = (await admin.get('/debtors?q=' + frag)).text, sr = (await admin.get('/search?q=' + frag)).text;
    const caseIds = qa('SELECT id FROM cases WHERE debtor_id=3').map(r => r.id);
    check('S-DEB-01', 'DEB-01：证件号片段搜索结果符合条件', has(dl, 'Ravi Chandran'), `Debtors 搜索 "${frag}" 含 Ravi Chandran=${has(dl, 'Ravi Chandran')}`);
    check('S-SRCH-01', 'SRCH-01：证件号搜索列出匹配的案件', caseIds.every(id => has(sr, `/cases/${id}"`)), `全局搜索 "${frag}"；债务人 3 的案件 ${caseIds} 都在结果里=${caseIds.every(id => has(sr, `/cases/${id}"`))}`);
  });

  await step('S-TASK-11', '改派后未完成任务随案件转移（完整表单）', async () => {
    await man.act('/tasks/new', { case_id: '19', type: 'follow_up', title: 'S11 open', due_date: addDays(today(), 2) });
    await man.act('/tasks/new', { case_id: '19', type: 'follow_up', title: 'S11 done', due_date: addDays(today(), 2) });
    await man.act(`/tasks/${q1("SELECT id FROM tasks WHERE title='S11 done'").id}/complete`);
    const from = q1('SELECT agent_id FROM cases WHERE id=19').agent_id;
    const r = await man.act('/cases/19', editForm(19, { agent_id: '1' }));
    const t = Object.fromEntries(qa("SELECT title, agent_id FROM tasks WHERE title LIKE 'S11 %'").map(x => [x.title, x.agent_id]));
    const log = q1("SELECT details FROM audit_logs WHERE action='update' AND entity_type='case' AND entity_id=19 ORDER BY id DESC").details;
    check('S-TASK-11', 'TASK-11：未完成任务转给新催收员；已完成的保留原归属；审计“N open task(s) reassigned”', r.ok === 'Saved' && t['S11 open'] === 1 && t['S11 done'] === from && /\d+ open task\(s\) reassigned/.test(log),
      `${r.ok || r.err}；任务 ${JSON.stringify(t)}（原催收员 ${from}）；审计 "${log}"`);
  });

  await step('S-TASK-13', '改为未分派时任务不转移', async () => {
    const id = await newCase(admin, { debtor_id: String(deb), agent_id: '2', ...M({ loan_start_date: today() }) });
    await man.act('/tasks/new', { case_id: String(id), type: 'follow_up', title: 'S13 open', due_date: addDays(today(), 2) });
    const r = await man.act(`/cases/${id}`, editForm(id, { agent_id: '' }));
    const t = q1("SELECT agent_id FROM tasks WHERE title='S13 open'");
    check('S-TASK-13', 'TASK-13：manager 把有未完成任务的案件改为未分派 → 任务仍在原催收员名下', r.ok === 'Saved' && t.agent_id === 2, `${r.ok || r.err}；任务 agent_id=${t.agent_id}`);
  });

  await step('S-E2E-04', '新员工入职与离职（完整表单改派）', async () => {
    await admin.act('/agents', { name: 'QA 新人', commission_rate: '5' });
    const ag = q1("SELECT id FROM agents WHERE name='QA 新人'").id;
    const u = await admin.act('/users', { username: 'qa_newbie', full_name: 'QA 新人', password: 'Newbie123', role: 'agent', agent_id: String(ag) });
    await man.act('/tasks/new', { case_id: '19', type: 'follow_up', title: 'S-E2E-04 open', due_date: addDays(today(), 2) });
    const r = await man.act('/cases/19', editForm(19, { agent_id: String(ag) }));
    const s2 = r.ok === 'Saved' && qa("SELECT agent_id FROM tasks WHERE case_id=19 AND status='pending'").every(t => t.agent_id === ag);
    const nb = await c.as('qa_newbie', 'Newbie123');
    const cases = [...(await nb.get('/cases')).text.matchAll(/<a class="mono" href="\/cases\/(\d+)">/g)].map(m => +m[1]);
    const debs = [...new Set([...(await nb.get('/debtors')).text.matchAll(/href="\/debtors\/(\d+)"/g)].map(m => +m[1]))];
    const s3 = cases.join() === '19' && debs.join() === String(q1('SELECT debtor_id FROM cases WHERE id=19').debtor_id) && has((await nb.get('/tasks')).text, 'S-E2E-04 open') && (await nb.get('/cases/2')).status === 404;
    await admin.act(`/users/${q1("SELECT id FROM users WHERE username='qa_newbie'").id}/toggle`);
    await nb.get('/logout');
    const s4 = (await new c.Session().login('qa_newbie', 'Newbie123')).status === 401;
    await admin.act(`/agents/${ag}`, { name: 'QA 新人', commission_rate: '5', target_amount: '0', active: '0' });
    const s5 = !has((await man.get('/cases/new')).text, 'QA 新人');
    check('S-E2E-04', 'E2E-04：建档建号 → 改派（任务随转）→ 只看到自己的案件 → 停用后不能登录 → 停用档案后下拉不出现', u.ok === 'User qa_newbie created' && s2 && s3 && s4 && s5,
      [u.ok === 'User qa_newbie created', s2, s3, s4, s5].map(x => (x ? 'Y' : 'N')).join('') + ` 改派 ${r.ok || r.err}；cases=${cases} debtors=${debs}`);
  });

  await step('S-RS-18', 'Fixed 贷款重组为 Fixed 500 / 12 个月', async () => {
    const id = await newCase(admin, { debtor_id: String(deb), principal_amount: '10000', interest_mode: 'fixed', interest_amount: '1500', loan_start_date: addMonths(today(), -2), tenure: '12' });
    await pay(man, id, 1000, 'S-RS-18');
    const h0 = (await man.get(`/cases/${id}`)).text;
    const eff = h0.match(/name="effective_date" min="[\d-]+" max="[\d-]+" value="([\d-]+)"/)[1];
    const r = await man.act(`/cases/${id}/restructures`, { effective_date: eff, interest_mode: 'fixed', interest_rate: '', interest_amount: '500', tenure: '12', reason: 'S-RS-18' });
    const rs = q1('SELECT * FROM case_restructures WHERE case_id=? ORDER BY id DESC', id) || {};
    const rows = scheduleRows(r.html); const reg = rows.filter(x => !x.arrears), arr = rows.filter(x => x.arrears);
    const sum = Math.round(reg.reduce((s, x) => s + x.expected, 0) * 100) / 100;
    const want = Math.round(((rs.principal_at_cut || 0) + 500) * 100) / 100;
    check('S-RS-18', 'RS-18：新计划 =（截点本金 + 500）按 12 期等额拆分，挂账行排在最前', r.ok === 'Restructured' && reg.length === 12 && Math.abs(sum - want) < 0.005 && Math.max(...reg.map(x => x.expected)) - Math.min(...reg.map(x => x.expected)) <= 0.011 && (!arr.length || rows[0].arrears),
      `${r.ok || r.err}；截点本金 ${rs.principal_at_cut}，挂账 ${rs.arrears_carried ?? JSON.stringify(arr.map(x => x.expected))}；12 期合计 ${sum}（应为 ${want}），每期 ${[...new Set(reg.map(x => x.expected))]}；首行挂账=${rows[0] && rows[0].arrears}`);
  });

  await step('S-RS-27', '重组后新增利息 + 挂账不超过剩余本金', async () => {
    const id = await newCase(admin, { debtor_id: String(deb), ...M({ loan_start_date: addMonths(today(), -1) }) });
    const p = await pay(man, id, 6350, 'S-RS-27'); // 先冲 1 个月利息 150，余 6,200 还本 → 剩余本金 3,800
    const r120 = await man.act(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1.5', interest_amount: '', tenure: '120', reason: 'S-RS-27 120' });
    const r24 = await man.act(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1.5', interest_amount: '', tenure: '24', reason: 'S-RS-27 24' });
    check('S-RS-27', 'RS-27：120 个月（新增利息 6,840）被拒，提示“Interest after the restructure plus carried arrears cannot exceed the remaining principal”；24 个月（1,368）可以',
      r120.err === 'Interest after the restructure plus carried arrears cannot exceed the remaining principal' && r24.ok === 'Restructured', `还款 ${p.ok}；120 → ${r120.err || r120.ok}；24 → ${r24.ok || r24.err}`);
  });

  await step('S-SET-06', '对账单内容（有逾期的案件 2）', async () => {
    const t = strip((await admin.get('/cases/2/statement')).text);
    const want = ['CASE-2026-D002', today(), 'Principal', 'Interest', 'Paid', 'Settlement', 'Overdue', 'days past due', 'Loan Start Date', 'Tenure', 'Maturity'];
    const miss = want.filter(w => !t.includes(w));
    const t14 = strip((await admin.get('/cases/14/statement')).text);
    check('S-SET-06', 'SET-06：抬头、案件号、当天日期、本金、利息、已还、欠款、结清额、逾期金额与天数、起始日、期限、到期日；重组信息', !miss.length && /restructure|Restructured|From \d{4}-\d{2}-\d{2}/i.test(t14),
      `案件 2 缺：${miss.length ? miss : '无'}；${(t.match(/Overdue[^A-Z]{0,40}/) || [''])[0]}；案件 14 重组信息=${/From \d{4}-\d{2}-\d{2}/.test(t14)}；案件 14 逾期 "${(t14.match(/Overdue[^A-Z]{0,30}/) || [''])[0].trim()}"`);
  });

  await step('S-PTP-16', 'Bankruptcy 案件直接提交 New PTP、New Plan、Fulfill', async () => {
    const id = await newCase(admin, { debtor_id: String(deb), agent_id: '1', status: 'negotiation', ...M({ loan_start_date: addMonths(today(), -2) }) });
    await man.act(`/cases/${id}/ptps`, { amount: '100', due_date: addDays(today(), 3), remark: 'S-PTP-16' });
    const ptp = q1('SELECT id FROM ptps WHERE case_id=? ORDER BY id DESC', id).id;
    await admin.act(`/cases/${id}/status`, { status: 'bankruptcy' });
    const a = await man.act(`/cases/${id}/ptps`, { amount: '100', due_date: addDays(today(), 3) });
    const b = await man.act(`/cases/${id}/ptp-plans`, { total_amount: '300', num_installments: '3', first_due_date: addDays(today(), 3) });
    const f = await man.act(`/ptps/${ptp}/fulfill`, { amount: '100', payment_date: today(), method: 'cash' });
    const st = q1('SELECT status FROM ptps WHERE id=?', ptp).status;
    check('S-PTP-16', 'PTP-16（v1.2）：新建都被拒；Fulfill 提示改用 Record Payment 并填原因', !!a.err && !!b.err && /Record this payment with a reason/.test(f.err || ''),
      `New PTP → ${a.err}；New Plan → ${b.err}；Fulfill → ${f.err || f.ok}（原 PTP 已被自动置为 ${st}）`,
      '转为 Bankruptcy 时 pending PTP 已自动变为 broken（G-19），fulfill 先判断“已结束”（src/routes/ptps.js:16），所以“改用 Record Payment”的提示到不了');
  });

  await step('S-PAY-10', '作废还款：Fully Paid 且作废后无还款 → 回到 Negotiation', async () => {
    const id = await newCase(admin, { debtor_id: String(deb), ...M({ loan_start_date: addMonths(today(), -2) }), status: 'negotiation' });
    const s = num(lead((await admin.get(`/cases/${id}`)).text));
    await pay(fin, id, s.toFixed(2), 'S-PAY-10');
    const fp = badge((await admin.get(`/cases/${id}`)).text);
    const v = await fin.act(`/cases/${id}/payments/${q1('SELECT id FROM payments WHERE case_id=?', id).id}/void`);
    const tl = strip(v.html).includes('voided');
    const aud = !!q1("SELECT 1 x FROM audit_logs WHERE action='payment_void' AND entity_id IN (?, ?) ORDER BY id DESC", id, id) || /payment_void/.test(JSON.stringify(qa("SELECT action FROM audit_logs ORDER BY id DESC LIMIT 3")));
    check('S-PAY-10', 'PAY-10：“Payment voided”；欠款恢复；时间线“Payment … voided”；审计 payment_void；原 Fully Paid 作废后回到 Negotiation', v.ok === 'Payment voided' && fp === 'Fully Paid' && badge(v.html) === 'Negotiation' && tl && aud,
      `作废前 ${fp}；${v.ok || v.err}；作废后 ${badge(v.html)}；结清额 ${lead(v.html)}；时间线=${tl}；审计=${aud}`);
  });

  await step('S-PTP-10', '取消分期计划：没有其他 pending PTP 时状态回到 Negotiation', async () => {
    const id = await newCase(admin, { debtor_id: String(deb), agent_id: '1', status: 'negotiation', ...M({ loan_start_date: addMonths(today(), -2) }) });
    await man.act(`/cases/${id}/ptp-plans`, { total_amount: '300', num_installments: '3', first_due_date: addDays(today(), 3) });
    const h = (await man.get(`/cases/${id}`)).text; const mid = badge(h);
    const plan = h.match(/\/ptp-plans\/([\w-]+)\/cancel/)[1];
    const r = await man.act(`/cases/${id}/ptp-plans/${plan}/cancel`);
    const tl = (strip(r.html).match(/Installment plan cancelled \(\d+ pending installment\(s\) broken\)/) || [])[0];
    const aud = !!q1("SELECT 1 x FROM audit_logs WHERE action='ptp_plan_cancel' ORDER BY id DESC");
    check('S-PTP-10', 'PTP-10：各期变 broken；时间线“Installment plan cancelled (N pending installment(s) broken)”；状态回到 Negotiation；审计 ptp_plan_cancel', r.ok === 'Installment plan cancelled' && badge(r.html) === 'Negotiation' && !!tl && aud,
      `建计划后 ${mid}；${r.ok || r.err}；取消后 ${badge(r.html)}；时间线 "${tl}"；审计=${aud}`);
  });

  await step('S-CASE-25', '重开已结案案件 → 结案时间清除', async () => {
    const id = q1("SELECT id FROM cases WHERE status='closed' ORDER BY id").id;
    const before = q1('SELECT closed_at FROM cases WHERE id=?', id).closed_at;
    const r = await man.act(`/cases/${id}/status`, { status: 'negotiation', reason: 'S-CASE-25 reopen' });
    const after = q1('SELECT status, closed_at FROM cases WHERE id=?', id);
    check('S-CASE-25', 'CASE-25：manager 把 Closed 案件改回 Negotiation → 结案时间被清除', r.ok === 'Status updated' && after.status === 'negotiation' && !after.closed_at, `案件 ${id}：closed_at ${before} → ${after.closed_at}；${r.ok || r.err}`);
  });

  const out = process.env.QA_OUT || path.join(__dirname, 'results');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'supplement-v12.json'), JSON.stringify(c.results, null, 1));
  const tally = c.results.reduce((m, r) => ((m[r.result] = (m[r.result] || 0) + 1), m), {});
  console.log('supplement-v12', JSON.stringify(tally));
  for (const r of c.results) console.log(`${r.result.padEnd(7)} ${r.id} :: ${r.actual.slice(0, 300)}`);
})().catch(e => { console.error(e); process.exit(1); });
