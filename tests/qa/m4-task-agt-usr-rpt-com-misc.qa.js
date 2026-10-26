// Manual chapters 4.11 TASK … 4.19 DEMO.
// Run: node --test tests/qa/m4-task-agt-usr-rpt-com-misc.qa.js
const { test, before, after } = require('node:test');
const C = require('./_client');
const { Session, as, check, rec, q1, qa, has, strip, today, addDays, newDebtor, newCase, money } = C;

before(() => C.reseed());
after(() => C.saveResults('m4'));
const S = {}; let D;
const caseRow = id => q1('SELECT * FROM cases WHERE id=?', id);
test('setup', async () => {
  for (const u of ['admin', 'manager', 'agent1', 'agent2', 'finance', 'auditor']) S[u] = await as(u);
  D = await newDebtor(S.admin, 'QA misc 债务人');
});
const taskIds = t => [...t.matchAll(/onclick="editTask\(this\)"\s*data-id="(\d+)"/g)].map(m => Number(m[1]));

// ---------------- TASK ----------------
test('TASK-01 列表与筛选', async () => {
  await S.admin.post('/tasks/new', { title: 'QA t+5', type: 'reminder', due_date: addDays(today(), 5), agent_id: '1' });
  await S.admin.post('/tasks/new', { title: 'QA t+20', type: 'visit', due_date: addDays(today(), 20), agent_id: '1' });
  await S.admin.post('/tasks/new', { title: 'QA t-3', type: 'legal', due_date: addDays(today(), -3), agent_id: '2' });
  const rows = sql => qa(`SELECT id FROM tasks WHERE ${sql} ORDER BY id`).map(r => r.id).join();
  const got = async qs => taskIds((await S.admin.get('/tasks?' + qs)).text).sort((a, b) => a - b).join();
  const T = today();
  const res = {
    status: [await got('status=done'), rows("status='done'")],
    type: [await got('type=visit'), rows("type='visit'")],
    overdue: [await got('overdue=1'), rows(`status='pending' AND due_date IS NOT NULL AND date(due_date) < '${T}'`)],
    w1_Today: [await got('window=1'), rows(`due_date IS NOT NULL AND date(due_date) <= '${T}'`)], // 标签是 “Today”，期望不含明天
    w7: [await got('window=7'), rows(`due_date IS NOT NULL AND date(due_date) <= '${addDays(T, 7)}'`)],
    w14: [await got('window=14'), rows(`due_date IS NOT NULL AND date(due_date) <= '${addDays(T, 14)}'`)],
    w30: [await got('window=30'), rows(`due_date IS NOT NULL AND date(due_date) <= '${addDays(T, 30)}'`)],
  };
  const page = (await S.admin.get('/tasks')).text;
  const red = has(page, `<span class="badge is-red">${addDays(T, -3)} · overdue</span>`);
  const ok = Object.values(res).every(([a, b]) => a === b) && red;
  check('TASK-01', '各筛选结果符合；逾期待办红色 · overdue', ok, JSON.stringify(res) + ` 红色逾期=${red}`, 'Due within “Today” = window=1，SQL 为 ≤ 今天+1 天（src/routes/tasks.js:18-22），会把明天到期的任务也列入');
});
let T2;
test('TASK-02 新建（关联案件，Agent 跟随案件）', async () => {
  const p = (await S.admin.get('/tasks')).text;
  const r = await S.admin.post('/tasks/new', { case_id: '2', agent_id: '1', title: 'QA case task', type: 'follow_up', due_date: addDays(today(), 2) });
  const t = q1("SELECT * FROM tasks WHERE title='QA case task'"); T2 = t.id;
  check('TASK-02', 'Agent 自动带出案件催收员并锁定；Task created', r.ok === 'Task created' && t.agent_id === 2 && has(p, 'agentSel.disabled = !!agentId') && has(p, 'data-agent="2"'), `${r.ok}; 提交 agent_id=1 → 实际 ${t.agent_id}（案件 2 属 agent2）; 前端锁定脚本存在=${has(p, 'agentSel.disabled')}`);
});
test('TASK-03 新建（不关联案件）', async () => {
  await S.admin.post('/tasks/new', { title: 'QA nocase admin', type: 'follow_up', agent_id: '3' });
  await S.agent1.post('/tasks/new', { title: 'QA nocase agent1', type: 'follow_up', agent_id: '3' });
  const a = q1("SELECT agent_id FROM tasks WHERE title='QA nocase admin'").agent_id; const b = q1("SELECT agent_id FROM tasks WHERE title='QA nocase agent1'").agent_id;
  check('TASK-03', '① 归所选催收员；② 归 agent1 自己', a === 3 && b === 1, `admin 选 3 → ${a}; agent1（提交 agent_id=3）→ ${b}`);
});
test('TASK-04 标题必填', async () => {
  const p = (await S.admin.get('/tasks')).text;
  check('TASK-04', '浏览器拦截', has(p, '<label>Title <input type="text" name="title" required></label>'), `required=${has(p, 'name="title" required')}`);
});
test('TASK-05 编辑', async () => {
  const r = await S.admin.post(`/tasks/${T2}`, { title: 'QA case task v2', type: 'visit', due_date: addDays(today(), 4), notes: 'n2' });
  const t = q1('SELECT * FROM tasks WHERE id=?', T2);
  check('TASK-05', 'Task updated', r.ok === 'Task updated' && t.title === 'QA case task v2' && t.type === 'visit' && t.notes === 'n2', `${r.ok}; ${t.title}/${t.type}/${t.due_date}/${t.notes}`);
});
test('TASK-06 完成', async () => {
  const r = await S.admin.post(`/tasks/${T2}/complete`, {});
  const p = (await S.admin.get('/tasks')).text;
  check('TASK-06', 'Task completed；done；Complete 消失', r.ok === 'Task completed' && q1('SELECT status FROM tasks WHERE id=?', T2).status === 'done' && !has(p, `/tasks/${T2}/complete`), `${r.ok}; status=${q1('SELECT status FROM tasks WHERE id=?', T2).status}`);
});
test('TASK-07 催收员范围', async () => {
  const ids = taskIds((await S.agent1.get('/tasks')).text).sort((a, b) => a - b).join();
  const own = qa('SELECT id FROM tasks WHERE agent_id=1 ORDER BY id').map(r => r.id).join();
  const other = q1('SELECT id, title FROM tasks WHERE agent_id=2 AND status=\'pending\' LIMIT 1');
  const c = await S.agent1.post(`/tasks/${other.id}/complete`, {});
  const e = await S.agent1.post(`/tasks/${other.id}`, { title: 'hacked' });
  const after_ = q1('SELECT title, status FROM tasks WHERE id=?', other.id);
  check('TASK-07', '只看自己的任务；越权提示 Forbidden', ids === own && c.err === 'Forbidden' && e.err === 'Forbidden' && after_.title === other.title && after_.status === 'pending', `列表 ${ids}（本人 ${own}）; complete→${c.err}; edit→${e.err}`);
});
test('TASK-08 越权关联案件', async () => {
  const r = await S.agent1.post('/tasks/new', { case_id: '2', title: 'QA x', type: 'follow_up' });
  check('TASK-08', 'Invalid case', r.err === 'Invalid case' && !q1("SELECT 1 x FROM tasks WHERE title='QA x'"), r.err);
});
test('TASK-09 只读角色', async () => {
  const out = [];
  for (const u of ['finance', 'auditor']) { const t = (await S[u].get('/tasks')).text; out.push(`${u}: new=${has(t, '+ New Task')} edit=${has(t, 'onclick="editTask(this)"')} dash=${/<td>\s*—\s*<\/td>\s*<\/tr>/.test(t)}`); }
  check('TASK-09', '没有 + New Task；Actions 列显示 —', out.every(x => /new=false edit=false dash=true/.test(x)), out.join('; '));
});
test('TASK-10 与仪表盘联动', async () => {
  await S.admin.post('/tasks/new', { case_id: '13', title: 'QA in3d', type: 'follow_up', due_date: addDays(today(), 3) });
  const t = (await S.admin.get('/')).text;
  check('TASK-10', 'Upcoming Follow-ups 出现，徽章 in 3d', /<span class="badge is-neutral">in 3d<\/span> QA in3d/.test(t), `${/in 3d<\/span> QA in3d/.test(t)}`);
});

// ---------------- AGT ----------------
test('AGT-01 列表', async () => {
  const t = (await S.admin.get('/agents')).text;
  const rows = [...t.matchAll(/<a href="\/agents\/(\d+)">[^<]+<\/a><\/td><td>[^<]*<\/td>\s*<td class="num">\d+<\/td><td class="num">([\d,.]+)<\/td>\s*<td class="num">([\d.]+)<\/td><td class="num">([\d,.]+)<\/td>\s*<td class="num">[\d,.]+<\/td>\s*<td><div class="bar"><div class="fill ([^"]*)" style="width: (\d+)%/g)]
    .map(m => ({ id: m[1], col: Number(m[2].replace(/,/g, '')), rate: Number(m[3]), com: m[4], cls: m[5].trim(), pct: Number(m[6]) }));
  const ok = rows.length === 4 && rows.every((r, i) => (i === 0 || r.col <= rows[i - 1].col) && r.com === money(r.col * r.rate / 100) && (r.pct >= 100 ? r.cls === 'is-green' : r.pct < 50 ? r.cls === 'is-red' : r.cls === ''));
  check('AGT-01', 'Collected 降序；Commission=Collected×Rate%；达成率颜色', ok, JSON.stringify(rows));
});
test('AGT-02 筛选', async () => {
  const ids = async qs => [...(await S.admin.get('/agents?' + qs)).text.matchAll(/<a href="\/agents\/(\d+)">/g)].map(m => Number(m[1])).sort().join();
  const a = await ids('department=Consumer'); const b = await ids('status=active'); const c = await ids('status=inactive');
  check('AGT-02', '结果符合条件', a === '1,2' && b === '1,2,3,4' && c === '', `Consumer→${a}; active→${b}; inactive→${c || '空'}`);
});
let AG;
test('AGT-03 新建', async () => {
  const f = (await S.admin.get('/agents/new')).text;
  const blank = await S.admin.post('/agents', { name: '  ' });
  const r = await S.admin.post('/agents', { name: 'QA 新催收员', department: 'QA', target_amount: '1000', commission_rate: '5', active: '1' });
  AG = q1("SELECT * FROM agents WHERE name='QA 新催收员'");
  check('AGT-03', 'Name is required；Commission 默认 5；Status 默认 Active；Agent created', blank.err === 'Name is required' && /name="commission_rate" type="number" step="0.1" value="5"/.test(f) && /<option value="1" selected>Active/.test(f) && r.ok === 'Agent created' && AG, `${blank.err}; 默认 5=${/value="5"/.test(f)}; Active 默认=${/<option value="1" selected>Active/.test(f)}; ${r.ok}`);
});
test('AGT-04 停用', async () => {
  const r = await S.admin.post(`/agents/${AG.id}`, { name: AG.name, department: 'QA', target_amount: '1000', commission_rate: '5', active: '0' });
  const d = (await S.admin.get(`/agents/${AG.id}`)).text;
  const inNew = has((await S.admin.get('/cases/new')).text, `>QA 新催收员<`); const inEdit = has((await S.admin.get('/cases/2/edit')).text, `>QA 新催收员<`); const inUser = has((await S.admin.get('/users/new')).text, `>QA 新催收员<`);
  check('AGT-04', '详情 Active=No；新建/编辑案件、新建用户下拉不出现', r.ok === 'Saved' && has(d, '<span>Active</span>No') && !inNew && !inEdit && !inUser, `${r.ok}; Active No=${has(d, '<span>Active</span>No')}; 下拉 new=${inNew} edit=${inEdit} user=${inUser}`);
});
test('AGT-05 详情', async () => {
  const t = strip((await S.admin.get('/agents/1')).text);
  const ok = ['Contact 012-3456789', 'Department Consumer', 'Target 500,000.00', 'Collected', 'Case Count 4', 'Commission 5%', 'Active Yes', 'Target Attainment', 'Assigned Cases', 'CASE-2026-D005'].every(s => t.includes(s));
  check('AGT-05', '联系方式、部门、目标、已收、案件数、佣金率、达成率与进度条、名下案件', ok, t.slice(t.indexOf('Lim Wei Sheng'), t.indexOf('Lim Wei Sheng') + 220));
});
test('AGT-06 权限', async () => {
  const a = await S.auditor.get('/agents'); const a2 = await S.auditor.get('/agents/1');
  const b = await S.agent1.get('/agents'); const c = await S.finance.get('/agents');
  const ae = await S.auditor.post('/agents', { name: 'x' });
  check('AGT-06', 'auditor 只读；agent1/finance 403', a.status === 200 && !has(a.text, '+ New Agent') && !has(a2.text, '/agents/1/edit') && ae.status === 403 && b.status === 403 && c.status === 403, `auditor ${a.status} new=${has(a.text, '+ New Agent')} POST=${ae.status}; agent1 ${b.status}; finance ${c.status}`);
});

// ---------------- USR ----------------
test('USR-01 新建员工账号', async () => {
  const r = await S.admin.post('/users', { username: 'qa_fin', full_name: 'QA Finance', password: 'qa1234', role: 'finance' });
  const l = await new Session().login('qa_fin', 'qa1234');
  check('USR-01', 'User xxx created；可立即登录', r.ok === 'User qa_fin created' && l.status === 302 && l.location === '/', `${r.ok}; login ${l.status}→${l.location}`);
});
test('USR-02 必填', async () => {
  const msgs = [];
  for (const f of [{ full_name: 'a', password: 'abcd', role: 'finance' }, { username: 'u2', password: 'abcd', role: 'finance' }, { username: 'u2', full_name: 'a', role: 'finance' }, { username: 'u2', full_name: 'a', password: 'abcd', role: 'client' }]) msgs.push((await S.admin.post('/users', f)).err);
  check('USR-02', 'Username, full name, password and role are required', msgs.every(m => m === 'Username, full name, password and role are required'), msgs.join(' | '));
});
test('USR-03 角色列表', async () => {
  const t = (await S.admin.get('/users/new')).text;
  const roles = [...t.slice(t.indexOf('id="role-select"'), t.indexOf('</select>', t.indexOf('id="role-select"'))).matchAll(/<option value="(\w+)">/g)].map(m => m[1]);
  check('USR-03', '只有 admin、manager、agent、finance、auditor', roles.join() === 'admin,manager,agent,finance,auditor', roles.join());
});
test('USR-04 催收员账号', async () => {
  const t = (await S.admin.get('/users/new')).text;
  const r = await S.admin.post('/users', { username: 'qa_ag', full_name: 'QA Ag', password: 'abcd', role: 'agent' });
  check('USR-04', '出现 Linked Agent；不选提示 Agent accounts must be linked to an agent', has(t, "af.style.display = sel.value === 'agent'") && has(t, 'Linked Agent') && r.err === 'Agent accounts must be linked to an agent', r.err);
});
test('USR-05 用户名重复', async () => {
  const r = await S.admin.post('/users', { username: 'agent1', full_name: 'dup', password: 'abcd', role: 'finance' });
  check('USR-05', 'Could not create user (username may already exist)', r.err === 'Could not create user (username may already exist)', r.err);
});
test('USR-06 编辑', async () => {
  const u = q1("SELECT id FROM users WHERE username='qa_fin'");
  const r = await S.admin.post(`/users/${u.id}`, { username: 'qa_fin', full_name: 'QA Agent Now', role: 'agent', agent_id: '4', active: '1' });
  const x = q1('SELECT * FROM users WHERE id=?', u.id);
  check('USR-06', 'User updated', r.ok === 'User updated' && x.full_name === 'QA Agent Now' && x.role === 'agent' && x.agent_id === 4, `${r.ok}; ${x.full_name}/${x.role}/${x.agent_id}/${x.active}`);
});
test('USR-07 防止锁死自己', async () => {
  const me = q1("SELECT id FROM users WHERE username='admin'").id;
  const a = await S.admin.post(`/users/${me}`, { username: 'admin', full_name: 'System Admin', role: 'manager', active: '1' });
  const b = await S.admin.post(`/users/${me}`, { username: 'admin', full_name: 'System Admin', role: 'admin', active: '0' });
  const t = await S.admin.post(`/users/${me}/toggle`, {});
  check('USR-07', '分别提示 You cannot change your own admin role / You cannot deactivate your own account', a.err === 'You cannot change your own admin role' && b.err === 'You cannot deactivate your own account' && q1('SELECT role, active FROM users WHERE id=?', me).active === 1, `${a.err} | ${b.err} | toggle→${t.err}`);
});
test('USR-08 重置密码', async () => {
  const u = q1("SELECT id FROM users WHERE username='qa_fin'");
  const f = (await S.admin.get(`/users/${u.id}/password`)).text;
  const a = await S.admin.post(`/users/${u.id}/password`, { password: 'abc' });
  const b = await S.admin.post(`/users/${u.id}/password`, { password: 'newpass9' });
  const l = await new Session().login('qa_fin', 'newpass9');
  check('USR-08', '3 位：浏览器拦截+服务端提示；4 位以上 Password updated for xxx 且立即生效', has(f, 'minlength="4"') && a.err === 'Password must be at least 4 characters' && b.ok === 'Password updated for qa_fin' && l.location === '/', `minlength=${has(f, 'minlength="4"')}; 3位→${a.err}; ${b.ok}; 新密码登录→${l.location}`);
});
test('USR-09 停用账号', async () => {
  await S.admin.post('/users', { username: 'qa_off', full_name: 'QA Off', password: 'abcd', role: 'auditor' });
  const u = q1("SELECT id FROM users WHERE username='qa_off'");
  await S.admin.post(`/users/${u.id}`, { username: 'qa_off', full_name: 'QA Off', role: 'auditor', active: '0' });
  const t = (await S.admin.get('/users')).text;
  const order = [...t.matchAll(/<td class="mono">([^<]+)<\/td>/g)].map(m => m[1]);
  const l = await new Session().login('qa_off', 'abcd');
  check('USR-09', '列表 disabled 并排到后面；无法登录', order[order.length - 1] === 'qa_off' && has(t, '<span class="badge is-neutral">disabled</span>') && l.status === 401, `顺序末尾=${order[order.length - 1]}; login ${l.status}`);
});
test('USR-10 停用后的已登录会话（期望立即失效）', async () => {
  await S.admin.post('/users', { username: 'qa_sess', full_name: 'QA Sess', password: 'abcd', role: 'finance' });
  const s = await as('qa_sess', 'abcd');
  const u = q1("SELECT id FROM users WHERE username='qa_sess'");
  await S.admin.post(`/users/${u.id}`, { username: 'qa_sess', full_name: 'QA Sess', role: 'finance', active: '0' });
  const r = await s.get('/cases');
  const w = await s.post('/cases/13/payments', { payment_date: today(), amount: '1' });
  check('USR-10', 'A 的会话立即失效', r.status === 302 && r.location === '/login', `停用后 GET /cases → ${r.status}; 仍可记账 POST → ${w.ok || w.err || w.status}`);
});
test('USR-11 角色变更生效时间', async () => {
  await S.admin.post('/users', { username: 'qa_role', full_name: 'QA Role', password: 'abcd', role: 'finance' });
  const s = await as('qa_role', 'abcd'); const u = q1("SELECT id FROM users WHERE username='qa_role'");
  await S.admin.post(`/users/${u.id}`, { username: 'qa_role', full_name: 'QA Role', role: 'auditor', active: '1' });
  const still = await s.post('/cases/13/payments', { payment_date: today(), amount: '1' });
  const s2 = await as('qa_role', 'abcd'); const after_ = await s2.post('/cases/13/payments', { payment_date: today(), amount: '1' });
  check('USR-11', '需要重新登录才生效（手册描述的现状，E-03）', !!still.ok && after_.status === 403, `改为 auditor 后旧会话记账 → ${still.ok}; 重新登录后 → ${after_.status}`, '行为与手册描述一致；风险并入 E-03 发现');
});
test('USR-12 新建时的密码长度（期望至少 4 位）', async () => {
  const r = await S.admin.post('/users', { username: 'qa_pw1', full_name: 'QA pw1', password: 'x', role: 'auditor' });
  check('USR-12', '1 位密码被拒绝', !!r.err, `${r.ok || r.err}; 1 位密码登录 → ${(await new Session().login('qa_pw1', 'x')).location}`);
});
test('USR-13 审计', async () => {
  const c = qa("SELECT details FROM audit_logs WHERE entity_type='user' AND action='create'").map(x => x.details);
  const u = qa("SELECT details FROM audit_logs WHERE entity_type='user' AND action='update'").map(x => x.details);
  check('USR-13', 'create、update user 有记录，含 Reset password for xxx', c.some(x => x.includes('qa_fin')) && u.some(x => x === 'Reset password for qa_fin') && u.some(x => x.includes('Updated user qa_off')), `create ${c.length} 条; update ${u.length} 条: ${u.slice(0, 4).join(' | ')}`);
});

// ---------------- RPT ----------------
test('RPT-01 默认日期', async () => {
  const t = (await S.admin.get('/reports')).text;
  const f = (t.match(/name="from" value="([\d-]+)"/) || [])[1], to = (t.match(/name="to" value="([\d-]+)"/) || [])[1];
  check('RPT-01', 'From=本月 1 日，To=今天', f === today().slice(0, 8) + '01' && to === today(), `${f} ~ ${to}`);
});
const outTable = t => [...t.slice(t.indexOf('Outstanding by Status')).matchAll(/<span class="badge [^"]+">([^<]+)<\/span><\/td>\s*<td class="num">(\d+)<\/td><td class="num">([\d,.]+)<\/td>\s*<td><div class="bar"><div class="fill is-green" style="width: (\d+)%/g)].map(m => ({ s: m[1], n: Number(m[2]), v: m[3], w: Number(m[4]) }));
test('RPT-02 欠款按状态', async () => {
  const a = outTable((await S.admin.get('/reports')).text);
  const b = outTable((await S.admin.get('/reports?from=2020-01-01&to=2020-01-31')).text);
  const db = qa('SELECT status, COUNT(*) n, SUM(outstanding_amount) v FROM cases GROUP BY status');
  const tot = (strip((await S.admin.get('/reports')).text).match(/Total (\d+) ([\d,.]+)/) || []);
  const ok = a.length === db.length && a.every(r => db.some(d => d.n === r.n && money(d.v) === r.v)) && Math.max(...a.map(r => r.w)) === 100 && JSON.stringify(a) === JSON.stringify(b) && Number(tot[1]) === db.reduce((s, d) => s + d.n, 0);
  check('RPT-02', '按状态分组+合计；最大组满格；不受日期影响', ok, `${a.map(r => `${r.s}:${r.n}/${r.v}/${r.w}%`).join(' ')}; Total ${tot[1]} ${tot[2]}; 日期改变后一致=${JSON.stringify(a) === JSON.stringify(b)}`);
});
test('RPT-03 催收员业绩（日期范围）', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '3', principal_amount: '5000', interest_mode: 'fixed', interest_amount: '0' });
  await S.admin.post(`/cases/${id}/payments`, { payment_date: '2026-09-15', amount: '1000' });
  await S.admin.post(`/cases/${id}/payments`, { payment_date: '2026-10-05', amount: '234.56' });
  const perf = t => Object.fromEntries([...t.slice(t.indexOf('Agent Performance')).matchAll(/<tr><td>([^<]+)<\/td><td class="num">([\d,.]+)<\/td>\s*<td class="num">([\d.]+)<\/td><td class="num">([\d,.]+)<\/td>/g)].map(m => [m[1], { col: m[2], rate: m[3], com: m[4] }]));
  const oct = perf((await S.admin.get('/reports?from=2026-10-01&to=2026-10-31')).text)['Rajesh Kumar'];
  const sep = perf((await S.admin.get('/reports?from=2026-09-01&to=2026-09-30')).text)['Rajesh Kumar'];
  const exp = q1("SELECT SUM(p.amount) s FROM payments p JOIN cases c ON c.id=p.case_id WHERE c.agent_id=3 AND date(p.payment_date) BETWEEN '2026-10-01' AND '2026-10-31'").s;
  const t = (await S.admin.get('/reports?from=2026-10-01&to=2026-10-31')).text;
  check('RPT-03', 'Collected 只统计范围内；Commission=Collected×Rate%；有达成率条', oct.col === money(exp) && sep.col === '1,000.00' && oct.com === money(exp * 6 / 100) && has(t, '<div class="bar"><div class="fill'), `10 月 ${JSON.stringify(oct)}（库 ${exp}）; 9 月 ${JSON.stringify(sep)}`);
});
test('RPT-04 催收员视图', async () => {
  const t = (await S.agent1.get('/reports')).text;
  const e = await S.agent1.get('/reports?export=performance');
  const own = qa('SELECT status, COUNT(*) n FROM cases WHERE agent_id=1 GROUP BY status');
  const rows = outTable(t);
  check('RPT-04', '只看自己范围欠款；无 Agent Performance；导出地址只显示页面', !has(t, 'Agent Performance') && rows.length === own.length && rows.every(r => own.some(o => o.n === r.n)) && /text\/html/.test(e.headers.get('content-type')) && !e.headers.get('content-disposition'), `分组 ${rows.map(r => r.s + ':' + r.n)}（库 ${own.map(o => o.status + ':' + o.n)}）; export → ${e.headers.get('content-type')}`);
});
let csvs = {};
test('RPT-05 CSV 导出', async () => {
  for (const [k, q] of [['cases', 'export=cases'], ['outstanding', 'export=outstanding'], ['performance', 'export=performance&from=2026-10-01&to=2026-10-31']]) {
    const r = await S.admin.get('/reports?' + q);
    csvs[k] = { fn: (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)[1], body: r.text, head: r.text.replace(/^﻿/, '').split('\r\n')[0] };
  }
  const ok = csvs.cases.fn === 'cases-detailed.csv' && csvs.cases.head === 'Case No,Debtor,Agent,Principal,Interest,Paid,Outstanding,Status,Opened'
    && csvs.outstanding.fn === 'outstanding-by-status.csv' && csvs.performance.fn === 'agent-performance.csv' && csvs.performance.head === 'Agent,Collected,Rate %,Commission,Target';
  check('RPT-05', '三个文件名与列正确', ok, Object.entries(csvs).map(([k, v]) => `${v.fn}: ${v.head}`).join(' || '));
});
test('RPT-06 Excel 兼容（BOM + 无小数尾差）', async () => {
  // fetch().text() strips a UTF-8 BOM, so check raw bytes.
  let bom = true;
  for (const q of ['export=cases', 'export=outstanding', 'export=performance']) { const r = await fetch(C.BASE + '/reports?' + q, { headers: { cookie: S.admin.cookie } }); const b = Buffer.from(await r.arrayBuffer()); if (!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) bom = false; }
  const tails = [];
  for (const [k, v] of Object.entries(csvs)) v.body.replace(/^﻿/, '').split('\r\n').slice(1).forEach(l => l.split(',').forEach(c => { if (/^-?\d+\.\d{3,}$/.test(c)) tails.push(`${k}:${c}`); }));
  check('RPT-06', '带 BOM；金额无多余小数尾差', bom && tails.length === 0, `BOM=${bom}; 尾差单元格: ${tails.join(', ') || '无'}`, 'Excel 实际打开未执行（本机自动化不驱动 Excel），以文件内容判定');
});

// ---------------- COM ----------------
const comRows = t => Object.fromEntries([...t.matchAll(/<tr>\s*<td>([^<]+)<\/td>\s*<td class="num">([\d,.-]+)<\/td>\s*<td class="num">([\d.]+)<\/td>\s*<td class="num">([\d,.-]+)<\/td>\s*<td class="num">([\d,.-]+)<\/td>\s*<td class="num ?([^"]*)">([\d,.-]+)<\/td>/g)].map(m => [m[1], { col: m[2], rate: m[3], earned: m[4], settled: m[5], cls: m[6].trim(), pending: m[7] }]));
test('COM-01 月份', async () => {
  const t = (await S.finance.get('/commissions')).text;
  const m = (t.match(/name="month" value="([\d-]+)"/) || [])[1];
  const raj = comRows(t)['Rajesh Kumar'];
  const sep = comRows((await S.finance.get('/commissions?month=2026-09')).text)['Rajesh Kumar'];
  const exp = q1("SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN cases c ON c.id=p.case_id WHERE c.agent_id=3 AND substr(p.payment_date,1,7)='2026-10'").s;
  check('COM-01', '默认当前月（MYT）；Collected 只统计该月', m === today().slice(0, 7) && raj.col === money(exp) && sep.col === '1,000.00', `默认月 ${m}; 10 月 ${raj.col}（库 ${exp}）; 9 月 ${sep.col}`);
});
test('COM-02 计算（含负数红色）', async () => {
  const t = (await S.finance.get('/commissions')).text; const rows = comRows(t);
  const n = s => Number(s.replace(/,/g, ''));
  const ok = Object.values(rows).every(r => money(n(r.col) * n(r.rate) / 100) === r.earned && money(n(r.earned) - n(r.settled)) === r.pending && (n(r.pending) < 0 ? r.cls === 'is-red' : r.cls === ''));
  const neg = Object.entries(rows).filter(([, r]) => n(r.pending) < 0).map(([k, r]) => `${k}:${r.pending}(${r.cls})`);
  check('COM-02', 'Earned=Collected×Rate%；Pending=Earned−Settled；负数红色', ok && neg.length > 0, `${JSON.stringify(rows)}; 负数行 ${neg}`);
});
test('COM-03 结算', async () => {
  const t = (await S.finance.get('/commissions')).text; const raj = comRows(t)['Rajesh Kumar'];
  const btn = t.match(/data-agent-id="3" data-name="Rajesh Kumar" data-pending="([\d.-]+)"/);
  const pre = has(t, "amt.value = p > 0 ? p.toFixed(2) : '';");
  const r = await S.finance.post('/commissions/settle', { agent_id: '3', period: today().slice(0, 7), amount: '10.50', note: 'QA settle' });
  const t2 = (await S.finance.get('/commissions')).text; const a = q1("SELECT * FROM audit_logs WHERE action='commission_settle' ORDER BY id DESC");
  check('COM-03', 'Pending>0 时预填；Settlement recorded；出现在历史；audit commission_settle', !!btn && pre && r.ok === 'Settlement recorded' && has(t2, '<td class="num">10.50</td>') && has(t2, 'QA settle') && !!a, `data-pending=${btn && btn[1]}（页面 Pending ${raj.pending}）; 预填逻辑=${pre}; ${r.ok}; audit=${a && a.details}`);
});
test('COM-04 金额校验', async () => {
  const t = (await S.finance.get('/commissions')).text;
  const a = await S.finance.post('/commissions/settle', { agent_id: '3', amount: '0' }); const b = await S.finance.post('/commissions/settle', { agent_id: '3', amount: '-1' });
  check('COM-04', '浏览器 min 拦截；服务端 Invalid amount', has(t, 'min="0.01" name="amount" id="st-amount" required') && a.err === 'Invalid amount' && b.err === 'Invalid amount', `${a.err} | ${b.err}`);
});
test('COM-05 作废结算', async () => {
  const s = q1("SELECT * FROM commission_settlements WHERE note='QA settle'");
  const before_ = comRows((await S.finance.get('/commissions')).text)['Rajesh Kumar'];
  const t0 = (await S.finance.get('/commissions')).text;
  const r = await S.finance.post(`/commissions/${s.id}/void`, {});
  const after_ = comRows((await S.finance.get('/commissions')).text)['Rajesh Kumar'];
  const a = q1("SELECT * FROM audit_logs WHERE action='commission_void' ORDER BY id DESC");
  const n = x => Number(x.replace(/,/g, ''));
  check('COM-05', 'Settlement voided；Settled/Pending 回退；audit commission_void', r.ok === 'Settlement voided' && Math.abs(n(before_.settled) - n(after_.settled) - 10.5) < 0.001 && Math.abs(n(after_.pending) - n(before_.pending) - 10.5) < 0.001 && !!a && has(t0, "return confirm('Void this settlement?')"), `${r.ok}; settled ${before_.settled}→${after_.settled}; pending ${before_.pending}→${after_.pending}`);
});
test('COM-06 催收员视图', async () => {
  const t = (await S.agent1.get('/commissions')).text; const rows = comRows(t);
  const hist = t.slice(t.indexOf('Settlement history')); const names = [...hist.matchAll(/<tr>\s*<td>([^<]+)<\/td><td class="num">/g)].map(m => m[1]);
  const st = await S.agent1.post('/commissions/settle', { agent_id: '1', amount: '1' });
  check('COM-06', '只看到自己一行和自己的结算记录；没有 Settle/Void', Object.keys(rows).join() === 'Lim Wei Sheng' && names.every(n => n === 'Lim Wei Sheng') && !has(t, '>Settle</button>') && !has(t, '/void"') && st.status === 403, `行 ${Object.keys(rows)}; 历史 ${names}; POST settle → ${st.status}`);
});
test('COM-07 只读角色', async () => {
  const t = (await S.auditor.get('/commissions')).text;
  const st = await S.auditor.post('/commissions/settle', { agent_id: '1', amount: '1' });
  check('COM-07', 'auditor 可查看，没有 Settle/Void', Object.keys(comRows(t)).length === q1('SELECT COUNT(*) c FROM agents').c && !has(t, '>Settle</button>') && !has(t, '/void"') && st.status === 403, `${Object.keys(comRows(t)).length} 行; POST → ${st.status}`);
});

// ---------------- SRCH ----------------
const sres = t => [...t.matchAll(/<a class="mono" href="\/cases\/(\d+)">/g)].map(m => Number(m[1]));
test('SRCH-01 多字段搜索', async () => {
  const r = {};
  for (const [k, q] of [['caseNo', 'D010'], ['name', 'Ravi'], ['ic', '780612'], ['phone', '018-2022']]) r[k] = sres((await S.admin.get('/search?q=' + encodeURIComponent(q))).text);
  const exp = { caseNo: [10], name: qa("SELECT c.id FROM cases c JOIN debtors d ON d.id=c.debtor_id WHERE d.name LIKE '%Ravi%'").map(x => x.id), ic: qa("SELECT c.id FROM cases c JOIN debtors d ON d.id=c.debtor_id WHERE d.ic_passport LIKE '%780612%'").map(x => x.id), phone: qa("SELECT c.id FROM cases c JOIN debtors d ON d.id=c.debtor_id WHERE d.phone LIKE '%018-2022%'").map(x => x.id) };
  const ok = Object.keys(exp).every(k => r[k].slice().sort().join() === exp[k].slice().sort().join() && r[k].length > 0);
  check('SRCH-01', '列出匹配的案件', ok, JSON.stringify(r));
});
test('SRCH-02 催收员范围', async () => {
  const r = sres((await S.agent1.get('/search?q=Sarah')).text);
  check('SRCH-02', '没有结果', r.length === 0, `结果 ${r.length}`);
});
test('SRCH-03 空搜索', async () => {
  const a = await S.admin.get('/search?q='); const b = await S.admin.get('/search?q=%20%20');
  check('SRCH-03', '没有结果，不报错', a.status === 200 && b.status === 200 && has(a.text, 'Enter a search term above.') && sres(b.text).length === 0, `${a.status}/${b.status}`);
});
test('SRCH-04 结果上限', async () => {
  const d = await newDebtor(S.admin, 'QA bulk aaa');
  for (let i = 0; i < 55; i++) await newCase(S.admin, { debtor_id: String(d), principal_amount: '10', interest_mode: 'fixed', interest_amount: '0' });
  const t = (await S.admin.get('/search?q=a')).text;
  check('SRCH-04', '最多显示 50 条', sres(t).length === 50 && has(t, '<strong>50</strong> results found.'), `${sres(t).length} 条`);
});
test('SRCH-05 特殊字符', async () => {
  const out = [];
  for (const q of ["'", '"', '%', '_', '<script>alert(1)</script>']) { const r = await S.admin.get('/search?q=' + encodeURIComponent(q)); out.push(`${q}:${r.status}:${sres(r.text).length}:${has(r.text, '<script>alert(1)') ? 'RAW' : 'esc'}`); }
  check('SRCH-05', '不报错，不执行脚本', out.every(x => /:200:\d+:esc$/.test(x)), out.join(' '));
});

// ---------------- AUD ----------------
test('AUD-01 访问权限', async () => {
  const out = {};
  for (const u of ['admin', 'auditor', 'manager', 'agent1', 'finance']) out[u] = (await S[u].get('/audit-log')).status;
  check('AUD-01', 'admin/auditor 可看；其他 403', out.admin === 200 && out.auditor === 200 && out.manager === 403 && out.agent1 === 403 && out.finance === 403, JSON.stringify(out));
});
test('AUD-02 内容', async () => {
  const t = (await S.auditor.get('/audit-log')).text;
  const n = (t.match(/<td class="mono">/g) || []).length;
  const times = [...t.matchAll(/<tr>\s*<td>(\d{4}-\d{2}-\d{2} \d{2}:\d{2})<\/td>/g)].map(m => m[1]);
  const total = q1('SELECT COUNT(*) c FROM audit_logs').c;
  const cols = /<th>Time<\/th>\s*<th>User<\/th>\s*<th>Action<\/th>\s*<th>Entity<\/th>\s*<th>Details<\/th>\s*<th>IP<\/th>/.test(t);
  check('AUD-02', '最近 200 条，倒序；列 Time/User/Action/Entity/Details/IP', n === Math.min(200, total) && times.every((v, i) => i === 0 || v <= times[i - 1]) && cols, `显示 ${n} 条（库 ${total}）; 列正确=${cols}`);
});
test('AUD-03 筛选', async () => {
  const t = (await S.auditor.get('/audit-log?action=payment')).text;
  const acts = [...t.matchAll(/<td><span class="badge">([^<]+)<\/span><\/td>/g)].map(m => m[1]);
  check('AUD-03', '只显示该动作', acts.length > 0 && acts.every(a => a === 'payment'), `${acts.length} 条，动作 ${[...new Set(acts)]}`);
});
test('AUD-05 不可修改', async () => {
  const t = (await S.admin.get('/audit-log')).text;
  const forms = [...t.slice(t.indexOf('<h1>Audit Log')).matchAll(/<form[^>]*method="post"/g)].length;
  const p = await S.admin.post('/audit-log', {}); const d = await S.admin.req('DELETE', '/audit-log');
  check('AUD-05', '没有修改或删除入口', forms === 0 && p.status === 404 && d.status === 404, `POST 表单 ${forms}; POST /audit-log → ${p.status}; DELETE → ${d.status}`);
});

// ---------------- SET ----------------
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const form = (fields, file) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); if (file) f.append('logo', new Blob([file.buf], { type: file.type }), file.name); return f; };
const company = { company_name: 'QA 放贷有限公司', address: 'QA 地址 1', phone: '03-1234567', email: 'qa@lender.my', reg_no: 'KPKT/QA/001' };
test('SET-01 保存公司信息', async () => {
  const r = await S.admin.req('POST', '/settings', form(company));
  const a = q1("SELECT * FROM audit_logs WHERE action='update' AND entity_type='settings' ORDER BY id DESC");
  check('SET-01', 'Company settings saved；audit update settings', r.ok === 'Company settings saved' && q1('SELECT company_name FROM settings').company_name === company.company_name && !!a, `${r.ok}; audit=${a && a.details}`);
});
test('SET-02 上传 Logo', async () => {
  const r = await S.admin.req('POST', '/settings', form(company, { buf: PNG, type: 'image/png', name: 'l.png' }));
  const s = (await S.admin.get('/settings')).text; const st = (await S.admin.get('/cases/5/statement')).text;
  check('SET-02', '设置页预览；对账单抬头显示 Logo', r.ok === 'Company settings saved' && has(s, '<img src="data:image/png;base64,') && has(st, '<img src="data:image/png;base64,'), `${r.ok}; 预览=${has(s, 'data:image/png')}; 对账单=${has(st, 'data:image/png')}`);
});
test('SET-03 Logo 格式', async () => {
  const a = await S.admin.req('POST', '/settings', form(company, { buf: Buffer.from('%PDF-1.4'), type: 'application/pdf', name: 'a.pdf' }));
  const b = await S.admin.req('POST', '/settings', form(company, { buf: Buffer.from('GIF89a'), type: 'image/gif', name: 'a.gif' }));
  check('SET-03', 'Logo must be PNG, JPEG, SVG or WebP', a.err === 'Logo must be PNG, JPEG, SVG or WebP' && b.err === a.err, `${a.err} | ${b.err}`);
});
test('SET-04 Logo 大小', async () => {
  const r = await S.admin.req('POST', '/settings', form(company, { buf: Buffer.alloc(600 * 1024, 1), type: 'image/png', name: 'big.png' }));
  check('SET-04', '保存失败并显示错误（File too large）', r.err === 'File too large', r.err);
});
test('SET-05 移除 Logo', async () => {
  const r = await S.admin.req('POST', '/settings', form({ ...company, remove_logo: '1' }));
  check('SET-05', 'Logo 被移除', r.ok && q1('SELECT logo FROM settings').logo === '', `logo='${q1('SELECT logo FROM settings').logo}'`);
});
test('SET-06 对账单内容', async () => {
  await S.admin.req('POST', '/settings', form(company, { buf: PNG, type: 'image/png', name: 'l.png' }));
  const t = (await S.admin.get('/cases/5/statement')).text; const c = caseRow(5); const d = q1('SELECT * FROM debtors WHERE id=?', c.debtor_id); const rc = q1('SELECT receipt_no FROM payments WHERE case_id=5').receipt_no;
  const need = [company.company_name, company.address, 'Tel: ' + company.phone, company.email, 'Reg No: ' + company.reg_no, c.case_no, today(), d.name, d.ic_passport, d.phone, 'Principal</span>RM ' + money(c.principal_amount), 'Interest</span>RM', 'Paid</span>RM', 'Outstanding</span>RM ' + money(c.outstanding_amount), 'Payment History', rc];
  const ok = need.every(s => t.includes(s)); const missing = need.filter(s => !t.includes(s));
  const link = has((await S.admin.get('/cases/5')).text, `href="/cases/5/statement" target="_blank"`);
  check('SET-06', '新标签页；公司抬头、案件号、当天日期、债务人、本金/利息/已还/欠款、还款历史', ok && link, `内容完整=${ok} 缺失=${missing}; target=_blank=${link}`);
});
test('SET-07 打印（CSS 层）', async () => {
  const t = (await S.admin.get('/cases/5/statement')).text;
  check('SET-07', '打印时不出现按钮', has(t, '@media print { .stmt-actions { display: none; }') && has(t, 'onclick="window.print()"'), 'print CSS 隐藏 .stmt-actions；PDF 生成见 ui.qa.py');
});
test('SET-08 未设置公司名', async () => {
  await S.admin.req('POST', '/settings', form({ ...company, company_name: '' }));
  const t = (await S.admin.get('/cases/5/statement')).text;
  check('SET-08', '标题显示 Debt Collection CRM', has(t, '<h1>Debt Collection CRM</h1>'), (t.match(/<h1>[^<]*<\/h1>/) || [])[0]);
});

// ---------------- DEMO ----------------
let own;
test('DEMO-01 删除演示数据', async () => {
  own = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '777', interest_mode: 'fixed', interest_amount: '0' });
  const t0 = (await S.admin.get('/demo-tools')).text;
  const r = await S.admin.post('/demo-tools/delete-demo', {});
  const demo = q1('SELECT COUNT(*) c FROM cases WHERE is_demo=1').c;
  const a = q1("SELECT 1 x FROM audit_logs WHERE action='demo_delete'");
  check('DEMO-01', 'Demo data deleted - your trial data is kept；演示案件消失；自建保留；audit demo_delete', r.status === 302 && r.ok === 'Demo data deleted - your trial data is kept' && !!caseRow(own) && !!a && has(t0, "return confirm('Delete the demo sample data?"),
    `HTTP ${r.status} ${r.ok || r.text.slice(0, 120)}; 剩余演示案件 ${demo}（被自建数据引用而保留）; 自建案件保留=${!!caseRow(own)}`);
});
test('DEMO-02 重新载入', async () => {
  const before_ = q1('SELECT COUNT(*) c FROM cases WHERE is_demo=0').c;
  const r = await S.admin.post('/demo-tools/reload-demo', {});
  const nos = qa('SELECT case_no FROM cases WHERE is_demo=1 ORDER BY id').map(x => x.case_no);
  const a = q1("SELECT 1 x FROM audit_logs WHERE action='demo_reload'");
  check('DEMO-02', 'Demo data reloaded；CASE-年份-D001…；自建数据不变；audit demo_reload', r.ok === 'Demo data reloaded' && nos.length === 20 && nos[0] === 'CASE-2026-D001' && q1('SELECT COUNT(*) c FROM cases WHERE is_demo=0').c === before_ && !!a, `HTTP ${r.status} ${r.ok || r.text.slice(0, 120)}; 演示案件 ${nos.length}`);
});
test('DEMO-03 编号不冲突', async () => {
  const r1 = await S.admin.post('/demo-tools/delete-demo', {});
  const id = await newCase(S.admin, { debtor_id: String(D), principal_amount: '1', interest_mode: 'fixed', interest_amount: '0' });
  const r2 = await S.admin.post('/demo-tools/reload-demo', {});
  const dup = q1('SELECT COUNT(*) c FROM (SELECT case_no FROM cases GROUP BY case_no HAVING COUNT(*)>1)').c;
  check('DEMO-03', '不报错；编号互不冲突', r1.status === 302 && r2.ok === 'Demo data reloaded' && dup === 0, `delete ${r1.status}; 新案 ${caseRow(id).case_no}; reload ${r2.ok || r2.status}; 重复号 ${dup}`);
});
test('DEMO-04 被使用过的演示案件', async () => {
  await S.admin.post('/cases/13/payments', { payment_date: today(), amount: '5' });
  const r = await S.admin.post('/demo-tools/delete-demo', {});
  check('DEMO-04', '该案件及相关数据保留，不报错', r.status === 302 && !!caseRow(13) && q1('SELECT COUNT(*) c FROM payments WHERE case_id=13').c >= 1, `HTTP ${r.status}; 案件 13 保留=${!!caseRow(13)}`);
  await S.admin.post('/demo-tools/reload-demo', {});
});
test('DEMO-05 权限', async () => {
  const out = [];
  for (const u of ['manager', 'agent1', 'finance', 'auditor']) { const g = await S[u].get('/demo-tools'); const p = await S[u].post('/demo-tools/delete-demo', {}); out.push(`${u}:${g.status}/${p.status}`); }
  check('DEMO-05', '非 admin 403', out.every(x => /:403\/403$/.test(x)), out.join(' '));
});

// AUD-04 last: needs every appendix-C action to have happened in this run.
test('AUD-04 覆盖范围', async () => {
  // fill the few actions this file has not produced yet
  const s = await as('manager'); await s.get('/logout');
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '1000', interest_mode: 'monthly', interest_rate: '1', loan_start_date: '2026-01-01', tenure: '6' });
  await S.admin.post(`/debtors/${D}`, { name: 'QA misc 债务人' });
  await S.admin.post(`/cases/${id}`, { debtor_id: String(D), agent_id: '1', principal_amount: '1000', interest_mode: 'monthly', interest_rate: '1', loan_start_date: '2026-01-01', tenure: '6', priority: 'low' });
  await S.admin.post(`/cases/${id}/payments`, { payment_date: '2026-02-01', amount: '10' });
  const p = q1('SELECT id FROM payments WHERE case_id=?', id).id;
  await S.admin.post(`/cases/${id}/payments/${p}`, { payment_date: '2026-02-01', amount: '11' });
  await S.admin.post(`/cases/${id}/ptps`, { amount: '10', due_date: today() });
  const pp = q1("SELECT id FROM ptps WHERE case_id=? AND status='pending'", id).id; await S.admin.post(`/ptps/${pp}/fulfill`, { amount: '10', payment_date: today() });
  await S.admin.post(`/cases/${id}/ptps`, { amount: '10', due_date: today() });
  const pb = q1("SELECT id FROM ptps WHERE case_id=? AND status='pending'", id).id; await S.admin.post(`/ptps/${pb}/break`, {});
  await S.admin.post(`/cases/${id}/ptp-plans`, { total_amount: '100', num_installments: '2', first_due_date: today() });
  const plan = q1('SELECT plan_id FROM ptps WHERE case_id=? AND plan_id IS NOT NULL', id).plan_id; await S.admin.post(`/cases/${id}/ptp-plans/${plan}/cancel`, {});
  await S.admin.post(`/cases/${id}/calls`, { result: 'busy' });
  await S.admin.post(`/cases/${id}/status`, { status: 'negotiation' });
  await S.admin.post(`/cases/${id}/payments/${p}/void`, {});
  const id2 = await newCase(S.admin, { debtor_id: String(D), principal_amount: '1000', interest_mode: 'monthly', interest_rate: '1', loan_start_date: '2026-01-01', tenure: '6' });
  await S.admin.post(`/cases/${id2}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1', tenure: '6', reason: 'aud' });
  const rid = q1('SELECT id FROM case_restructures WHERE case_id=?', id2).id; await S.admin.post(`/cases/${id2}/restructures/${rid}/undo`, {});
  await S.admin.post(`/agents/1`, { name: 'Lim Wei Sheng', contact: '012-3456789', department: 'Consumer', target_amount: '500000', commission_rate: '5', active: '1' });
  const need = ['login', 'logout', 'create:debtor', 'create:agent', 'create:case', 'create:user', 'update:debtor', 'update:agent', 'update:case', 'update:user', 'update:settings', 'payment', 'payment_edit', 'payment_void', 'ptp_create', 'ptp_fulfilled', 'ptp_broken', 'ptp_plan_create', 'ptp_plan_cancel', 'call', 'status_change', 'restructure', 'restructure_undo', 'commission_settle', 'commission_void', 'demo_delete', 'demo_reload', 'seed'];
  const have = new Set(qa('SELECT DISTINCT action, entity_type FROM audit_logs').flatMap(r => [r.action, `${r.action}:${r.entity_type}`]));
  const miss = need.filter(n => !have.has(n));
  const noteTask = qa("SELECT action FROM audit_logs WHERE details LIKE '%note%' OR entity_type='task'").length;
  check('AUD-04', '附录 C 各项操作均产生审计记录', miss.length === 0, `缺失: ${miss.join(',') || '无'}；备注/任务相关审计 ${noteTask} 条（E-11 现状）`);
});
