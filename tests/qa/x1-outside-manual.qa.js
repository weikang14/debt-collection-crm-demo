// 手册外用例：RBAC 越权矩阵、输入校验与边界、错误处理、并发/重复提交、数据一致性。
// Run: node --test tests/qa/x1-outside-manual.qa.js
const { test, before, after } = require('node:test');
const C = require('./_client');
const { Session, as, check, rec, q1, qa, has, strip, ledgerAmt, ledgerVal, today, addDays, newDebtor, newCase, money } = C;

before(() => C.reseed());
after(() => C.saveResults('x1'));
const S = {}; let D, A, B, PA;
const caseRow = id => q1('SELECT * FROM cases WHERE id=?', id);
const page = async (id, s = S.admin) => (await s.get(`/cases/${id}`)).text;
test('setup', async () => {
  for (const u of ['admin', 'manager', 'agent1', 'agent2', 'finance', 'auditor']) S[u] = await as(u);
  D = await newDebtor(S.admin, 'QA RBAC 债务人');
  A = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '100000', interest_mode: 'fixed', interest_amount: '0', status: 'assigned' });
  const D2 = await newDebtor(S.admin, 'QA RBAC 债务人B');
  B = await newCase(S.admin, { debtor_id: String(D2), agent_id: '2', principal_amount: '100000', interest_mode: 'fixed', interest_amount: '0', status: 'assigned' });
  await S.admin.post(`/cases/${A}/payments`, { payment_date: today(), amount: '1' });
  PA = q1('SELECT id FROM payments WHERE case_id=?', A).id;
});

// ---------------- X-RBAC：逐角色 × 逐写操作路由直接 POST ----------------
test('X-RBAC 写操作越权矩阵', async () => {
  const freshPtp = async cid => { await S.admin.post(`/cases/${cid}/ptps`, { amount: '1', due_date: today() }); return q1("SELECT id FROM ptps WHERE case_id=? AND status='pending' ORDER BY id DESC", cid).id; };
  const freshNote = async cid => { await S.admin.post(`/cases/${cid}/notes`, { content: 'rbac note' }); return q1("SELECT id FROM timeline_events WHERE case_id=? AND event_type='note' ORDER BY id DESC", cid).id; };
  const freshTask = async (cid, ag) => { await S.admin.post('/tasks/new', { case_id: String(cid), title: 'rbac task', due_date: today() }); return q1('SELECT id FROM tasks ORDER BY id DESC').id; };
  const sacrificial = async () => { await S.admin.post('/users', { username: 'rb_' + Math.random().toString(36).slice(2, 8), full_name: 'RB', password: 'abcd', role: 'auditor' }); return q1('SELECT id, username FROM users ORDER BY id DESC'); };
  const W = ['admin', 'manager'], WA = ['admin', 'manager', 'agent'], WF = ['admin', 'manager', 'finance'], WAF = ['admin', 'manager', 'finance', 'agent'];
  const routes = [
    ['POST /debtors', WA, async () => ['/debtors', { name: 'rbac debtor' }]],
    ['POST /debtors/:id', WA, async c => ['/debtors/' + caseRow(c).debtor_id, { name: caseRow(c).debtor_id === D ? 'QA RBAC 债务人' : 'QA RBAC 债务人B' }], true],
    ['POST /cases', W, async () => ['/cases', { debtor_id: String(D), principal_amount: '1', interest_mode: 'fixed' }]],
    ['POST /cases/:id', W, async c => [`/cases/${c}`, { debtor_id: String(caseRow(c).debtor_id), agent_id: String(caseRow(c).agent_id), principal_amount: '100000', interest_mode: 'fixed', interest_amount: '0', priority: 'medium' }], true],
    ['POST /cases/:id/payments', WAF, async c => [`/cases/${c}/payments`, { payment_date: today(), amount: '1' }], true],
    ['POST /cases/:id/payments/:pid', WF, async c => [`/cases/${c}/payments/${c === A ? PA : 999999}`, { payment_date: today(), amount: '1' }], true],
    ['POST /cases/:id/payments/:pid/void', WF, async c => [`/cases/${c}/payments/999999/void`, {}], true],
    ['POST /cases/:id/ptps', WA, async c => [`/cases/${c}/ptps`, { amount: '1', due_date: today() }], true],
    ['POST /cases/:id/ptp-plans', WA, async c => [`/cases/${c}/ptp-plans`, { total_amount: '2', num_installments: '2', first_due_date: today() }], true],
    ['POST /cases/:id/ptp-plans/:plan/cancel', WA, async c => [`/cases/${c}/ptp-plans/nonexistent/cancel`, {}], true],
    ['POST /ptps/:id/fulfill', WA, async c => [`/ptps/${await freshPtp(c)}/fulfill`, { amount: '1', payment_date: today() }], true],
    ['POST /ptps/:id/break', WA, async c => [`/ptps/${await freshPtp(c)}/break`, {}], true],
    ['POST /cases/:id/calls', WA, async c => [`/cases/${c}/calls`, { result: 'busy' }], true],
    ['POST /cases/:id/notes', WA, async c => [`/cases/${c}/notes`, { content: 'x' }], true],
    ['POST /cases/:id/notes/:nid', WA, async c => [`/cases/${c}/notes/${await freshNote(c)}`, { content: 'y' }], true],
    ['POST /cases/:id/notes/:nid/delete', WA, async c => [`/cases/${c}/notes/${await freshNote(c)}/delete`, {}], true],
    ['POST /cases/:id/status', WA, async c => [`/cases/${c}/status`, { status: 'assigned' }], true],
    ['POST /cases/:id/restructures', W, async c => [`/cases/${c}/restructures`, { effective_date: '2000-01-01', interest_mode: 'monthly', interest_rate: '1', tenure: '6', reason: 'x' }], true],
    ['POST /cases/:id/restructures/:rid/undo', W, async c => [`/cases/${c}/restructures/999999/undo`, {}], true],
    ['POST /tasks/new', WA, async c => ['/tasks/new', { case_id: String(c), title: 'rbac t' }], true],
    ['POST /tasks/:id', WA, async c => [`/tasks/${await freshTask(c)}`, { title: 'rbac t2' }], true],
    ['POST /tasks/:id/complete', WA, async c => [`/tasks/${await freshTask(c)}/complete`, {}], true],
    ['POST /agents', W, async () => ['/agents', { name: 'rbac agent' }]],
    ['POST /agents/:id', W, async () => ['/agents/4', { name: 'Tan Mei Ling', contact: '017-5566778', department: 'Legal', target_amount: '300000', commission_rate: '4', active: '1' }]],
    ['POST /users', ['admin'], async () => ['/users', { username: 'rb_new_' + Math.random().toString(36).slice(2, 7), full_name: 'x', password: 'abcd', role: 'auditor' }]],
    ['POST /users/:id', ['admin'], async () => { const u = await sacrificial(); return [`/users/${u.id}`, { username: u.username, full_name: 'RB2', role: 'auditor', active: '1' }]; }],
    ['POST /users/:id/password', ['admin'], async () => { const u = await sacrificial(); return [`/users/${u.id}/password`, { password: 'abcdef' }]; }],
    ['POST /users/:id/toggle', ['admin'], async () => { const u = await sacrificial(); return [`/users/${u.id}/toggle`, {}]; }],
    ['POST /commissions/settle', WF, async () => ['/commissions/settle', { agent_id: '1', amount: '1' }]],
    ['POST /commissions/:id/void', WF, async () => ['/commissions/999999/void', {}]],
    ['POST /settings', ['admin'], async () => ['/settings', { company_name: 'RBAC Co' }]],
    ['POST /demo-tools/delete-demo', ['admin'], async () => ['/demo-tools/delete-demo', {}], false, 'skipAdmin'],
    ['POST /demo-tools/reload-demo', ['admin'], async () => ['/demo-tools/reload-demo', {}], false, 'skipAdmin'],
  ];
  const roleOf = u => (u === 'agent1' ? 'agent' : u);
  const denied = r => r.status === 403 || r.status === 404 || r.err === 'Forbidden' || r.err === 'Invalid case' || (r.status === 302 && r.location === '/login');
  const bad = []; let n = 0;
  for (const [name, allow, mk, scoped, flag] of routes) {
    for (const u of ['admin', 'manager', 'agent1', 'finance', 'auditor']) {
      if (flag === 'skipAdmin' && u === 'admin') continue;
      const targets = scoped && u === 'agent1' ? [[A, true], [B, false]] : [[A, true]];
      for (const [cid, inScope] of targets) {
        const [url, body] = await mk(cid);
        const r = await S[u].post(url, body); n++;
        const expectAllowed = allow.includes(roleOf(u)) && inScope;
        const got = !denied(r);
        if (got !== expectAllowed) bad.push(`${u}${scoped && u === 'agent1' ? (inScope ? '(本人)' : '(他人)') : ''} ${name} → ${r.status} ${r.location.slice(0, 60)} ${r.err || ''}`);
      }
    }
  }
  check('X-RBAC', '与第 3 章权限矩阵一致（允许的通过，不允许的 403/404/Forbidden）', bad.length === 0, `${n} 个请求；不一致 ${bad.length}：${bad.join(' || ')}`);
});
test('X-RBAC-GET 只读页面越权', async () => {
  const pages = { '/agents': ['admin', 'manager', 'auditor'], '/agents/1': ['admin', 'manager', 'auditor'], '/agents/new': ['admin', 'manager'], '/agents/1/edit': ['admin', 'manager'], '/users': ['admin'], '/users/new': ['admin'], '/users/1/edit': ['admin'], '/users/1/password': ['admin'], '/settings': ['admin'], '/demo-tools': ['admin'], '/audit-log': ['admin', 'auditor'], '/cases/new': ['admin', 'manager'], [`/cases/${A}/edit`]: ['admin', 'manager'], '/debtors/new': ['admin', 'manager', 'agent'], [`/debtors/${D}/edit`]: ['admin', 'manager', 'agent'], '/commissions': ['admin', 'manager', 'finance', 'auditor', 'agent'], '/reports': ['admin', 'manager', 'finance', 'auditor', 'agent'] };
  const bad = [];
  for (const [p, allow] of Object.entries(pages)) for (const u of ['admin', 'manager', 'agent1', 'finance', 'auditor']) {
    const r = await S[u].get(p); const ok = r.status === 200; const exp = allow.includes(u === 'agent1' ? 'agent' : u);
    if (ok !== exp) bad.push(`${u} GET ${p} → ${r.status}`);
  }
  check('X-RBAC-GET', 'GET 页面权限与矩阵一致', bad.length === 0, bad.join(' | ') || `${Object.keys(pages).length * 5} 个请求全部一致`);
});
test('X-SCOPE agent 写他人债务人 / 他人任务 / 他人案件状态', async () => {
  const r1 = await S.agent1.post(`/debtors/${caseRow(B).debtor_id}`, { name: 'hacked' });
  const r2 = await S.agent1.get(`/debtors/${caseRow(B).debtor_id}/edit`);
  const r3 = await S.agent1.post(`/cases/${B}/status`, { status: 'closed' });
  check('X-SCOPE', '全部拒绝且数据不变', r1.status === 403 && r2.status === 403 && r3.status === 404 && q1('SELECT name FROM debtors WHERE id=?', caseRow(B).debtor_id).name === 'QA RBAC 债务人B' && caseRow(B).status !== 'closed', `${r1.status}/${r2.status}/${r3.status}`);
});

test('X-STALE 新建计息案件在列表/仪表盘显示的欠款未含利息（打开详情才重算）', async () => {
  const before_ = strip((await S.admin.get('/')).text).match(/Total Outstanding RM ([\d,.]+)/)[1];
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12' });
  const no = caseRow(id).case_no;
  const listAmt = async () => ((await S.admin.get('/cases?q=' + no)).text.match(/<td class="num">([\d,.]+)<\/td>/) || [])[1];
  const csv1 = (await S.admin.get('/reports?export=cases')).text.split('\r\n').find(l => l.startsWith(no));
  const l1 = await listAmt(); const d1 = strip((await S.admin.get('/')).text).match(/Total Outstanding RM ([\d,.]+)/)[1];
  await page(id);
  const l2 = await listAmt(); const d2 = strip((await S.admin.get('/')).text).match(/Total Outstanding RM ([\d,.]+)/)[1];
  check('X-STALE', '列表/仪表盘/CSV 与详情页欠款一致', l1 === l2, `建案后：列表 ${l1}，仪表盘 ${before_}→${d1}，CSV「${csv1}」；打开详情后：列表 ${l2}，仪表盘 ${d2}`);
});

// ---------------- X-VAL：输入校验与边界 ----------------
const probes = [];
async function probe(id, desc, expected, fn, judge) {
  const r = await fn(); const pass = judge(r);
  rec(id, expected, typeof r === 'string' ? r : JSON.stringify(r).slice(0, 300), pass ? 'PASS' : 'FAIL', desc);
  probes.push([id, pass]);
}
const mkRaw = async (s, f) => { const r = await s.post('/cases', { debtor_id: String(D), agent_id: '1', ...f }); const id = Number((r.location.match(/cases\/(\d+)\?/) || [])[1]); return { r, id }; };
test('X-VAL 非数字 / 不存在的 id', async () => {
  const out = [];
  for (const p of ['/cases/abc', '/cases/99999', '/cases/-1', '/cases/1.5', '/cases/0', '/cases/abc/statement', '/cases/abc/edit', '/debtors/abc', '/debtors/99999', '/agents/abc', '/agents/99999']) out.push(`${p}:${(await S.admin.get(p)).status}`);
  const u = await S.admin.get('/users/abc/edit');
  const t = await S.admin.post('/tasks/99999/complete', {}); const t2 = await S.admin.post('/tasks/abc', { title: 'x' });
  const cv = await S.admin.post('/commissions/99999/void', {});
  const pf = await S.admin.post('/ptps/abc/fulfill', {});
  check('X-VAL-ID', '非数字/不存在 id 返回 404 或明确错误，不 500，不误报成功', out.every(x => /:404$/.test(x)) && u.err === 'User not found' && t.err && cv.err && pf.status === 404,
    `${out.join(' ')}; /users/abc/edit→${u.err}; 完成不存在任务→ok="${t.ok}"; 编辑不存在任务→${t2.err}; 作废不存在结算→ok="${cv.ok}"; /ptps/abc/fulfill→${pf.status}`);
});
test('X-VAL 案件金额 / 日期 / 期限边界（绕过前端）', async () => {
  const res = {};
  for (const [k, f] of Object.entries({
    负本金: { principal_amount: '-1000', interest_mode: 'fixed', interest_amount: '0' },
    非数字本金: { principal_amount: 'abc', interest_mode: 'fixed', interest_amount: '0' },
    溢出本金1e309: { principal_amount: '1e309', interest_mode: 'fixed', interest_amount: '0' },
    负利率: { principal_amount: '1000', interest_mode: 'monthly', interest_rate: '-5', loan_start_date: '2026-01-01', tenure: '12' },
    负固定利息: { principal_amount: '1000', interest_mode: 'fixed', interest_amount: '-300' },
    非法起始日: { principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-13-45', tenure: '12' },
    超长期限20000月: { principal_amount: '1000', interest_mode: 'monthly', interest_rate: '1', loan_start_date: '2026-01-01', tenure: '20000' },
    小数期限: { principal_amount: '900', interest_mode: 'fixed', interest_amount: '0', loan_start_date: '2026-01-01', tenure: '1.5' },
  })) {
    const t0 = Date.now(); const { r, id } = await mkRaw(S.admin, f);
    const p = id ? await S.admin.get(`/cases/${id}`) : null; const c = id ? caseRow(id) : null;
    res[k] = id ? `已创建#${id} P=${c.principal_amount} I=${c.interest_charged} 欠款=${p && ledgerAmt(p.text)} 到期=${c.maturity_date} 耗时${Date.now() - t0}ms` : `拒绝 ${r.err || r.status}`;
  }
  const d = strip((await S.admin.get('/')).text).match(/Total Outstanding RM (\S+)/)[1];
  const rp = strip((await S.admin.get('/reports')).text).match(/Total \d+ (\S+)/)[1];
  res['仪表盘总欠款'] = d; res['报表合计'] = rp;
  const rejectedAll = Object.entries(res).filter(([k]) => !['仪表盘总欠款', '报表合计'].includes(k)).every(([, v]) => v.startsWith('拒绝'));
  check('X-VAL-CASE', '服务端拒绝负数/非数字/溢出/非法日期/超范围期限', rejectedAll, JSON.stringify(res));
});
test('X-VAL 还款输入边界', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0' });
  const res = {};
  for (const [k, f] of Object.entries({
    '金额 0.001（不足 1 分）': { amount: '0.001', payment_date: today() },
    '金额 100.005（3 位小数）': { amount: '100.005', payment_date: today() },
    '金额十六进制 0x10': { amount: '0x10', payment_date: today() },
    '金额 Infinity': { amount: 'Infinity', payment_date: today() },
    '金额科学计数 1e2': { amount: '1e2', payment_date: today() },
    '未来日期 2099-01-01': { amount: '1', payment_date: '2099-01-01' },
    '早于放款 2000-01-01': { amount: '1', payment_date: '2000-01-01' },
    '日期带时间 2026-10-01T10:00': { amount: '1', payment_date: '2026-10-01T10:00' },
    '方式任意字符串': { amount: '1', payment_date: today(), method: 'bitcoin<b>' },
    '超长 Reference 5000 字': { amount: '1', payment_date: today(), reference: 'R'.repeat(5000) },
  })) { const r = await S.admin.post(`/cases/${id}/payments`, f); res[k] = r.ok || r.err || r.status; }
  const pays = qa('SELECT amount, payment_date, method FROM payments WHERE case_id=?', id);
  const rangeAfter = (await page(id)).match(/name="effective_date" min="([\d-]+)" max="([\d-]+)"/);
  res['作为结果：重组可选日期'] = rangeAfter ? `${rangeAfter[1]}~${rangeAfter[2]}` : '无表单';
  const good = res['金额 Infinity'] === 'Invalid amount' && res['日期带时间 2026-10-01T10:00'] === 'Invalid payment date';
  const loose = ['金额 0.001（不足 1 分）', '金额 100.005（3 位小数）', '金额十六进制 0x10', '未来日期 2099-01-01', '方式任意字符串'].filter(k => /recorded/.test(String(res[k])));
  check('X-VAL-PAY', '拒绝不足 1 分/超过 2 位小数/十六进制/未来日期/非白名单方式', good && loose.length === 0, `${JSON.stringify(res)}；库内金额 ${pays.map(p => p.amount).join(',')}`);
});
test('X-VAL PTP / 计划 / 通话 / 任务 / 债务人 / 催收员 输入', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0' });
  const st = async (s, url, body) => { const r = await s.post(url, body); return r.status === 500 ? `500(${(r.text.match(/(?:Error|TypeError): [^<]{0,60}/) || [''])[0]})` : (r.ok || r.err || r.status); };
  const res = {
    'PTP 缺到期日': await st(S.agent1, `/cases/${id}/ptps`, { amount: '10' }),
    'PTP 到期日 abc': await st(S.agent1, `/cases/${id}/ptps`, { amount: '10', due_date: 'abc' }),
    'PTP 到期日为过去 2020-01-01': await st(S.agent1, `/cases/${id}/ptps`, { amount: '10', due_date: '2020-01-01' }),
    '计划首期 abc': await st(S.agent1, `/cases/${id}/ptp-plans`, { total_amount: '10', num_installments: '2', first_due_date: 'abc' }),
    '通话 result=bogus': await st(S.agent1, `/cases/${id}/calls`, { result: 'bogus' }),
    '通话时长 -60': await st(S.agent1, `/cases/${id}/calls`, { result: 'busy', duration_seconds: '-60' }),
    '空备注': await st(S.agent1, `/cases/${id}/notes`, { content: '' }),
    '任务缺标题': await st(S.agent1, '/tasks/new', { type: 'follow_up' }),
    '任务 type=bogus': await st(S.agent1, '/tasks/new', { title: 'x', type: 'bogus' }),
    '任务编辑空标题': await st(S.admin, `/tasks/${q1('SELECT id FROM tasks ORDER BY id LIMIT 1').id}`, { title: '' }),
    '债务人 risk=bogus': await st(S.agent1, '/debtors', { name: 'x', risk_level: 'bogus' }),
    '债务人负薪资': await st(S.admin, '/debtors', { name: 'neg salary', salary: '-5000' }),
    '债务人名 5 万字': await st(S.admin, '/debtors', { name: 'N'.repeat(50000) }),
    '债务人名 20 万字（超 body 限制）': await st(S.admin, '/debtors', { name: 'N'.repeat(200000) }),
    '催收员佣金率 0': await (async () => { await S.admin.post('/agents', { name: 'QA zero rate', commission_rate: '0' }); return 'rate=' + q1("SELECT commission_rate r FROM agents WHERE name='QA zero rate'").r; })(),
    '催收员佣金率 -10': await (async () => { await S.admin.post('/agents', { name: 'QA neg rate', commission_rate: '-10', target_amount: '-1' }); const a = q1("SELECT commission_rate r, target_amount t FROM agents WHERE name='QA neg rate'"); return `rate=${a.r} target=${a.t}`; })(),
    '用户关联不存在的催收员 99999': await st(S.admin, '/users', { username: 'qa_ghost', full_name: 'g', password: 'abcd', role: 'agent', agent_id: '99999' }),
    '结算 period=bogus': await st(S.finance, '/commissions/settle', { agent_id: '1', amount: '1', period: 'bogus' }),
    '结算 1e20': await st(S.finance, '/commissions/settle', { agent_id: '1', amount: '1e20' }),
    '状态 bogus': await st(S.agent1, `/cases/${id}/status`, { status: 'bogus' }),
  };
  const n500 = Object.values(res).filter(v => String(v).startsWith('500')).length;
  check('X-VAL-MISC', '非法输入给出友好错误，不出现 500；业务上不合理值被拒绝', n500 === 0, `500 次数 ${n500}；${JSON.stringify(res)}`);
});

// ---------------- X-ERR：错误处理 ----------------
test('X-ERR 500 页面泄露堆栈 / 服务存活', async () => {
  const r = await S.admin.post('/cases', { debtor_id: '99999', principal_amount: '100' });
  const leak = /at run \(.*src[\\/]db[\\/]index\.js/.test(r.text.replace(/&#39;/g, "'")) || /[A-Z]:\\\\Users|C:\\Users/.test(r.text);
  const h = await new Session().get('/health');
  const unknown = await S.admin.get('/no-such-page');
  check('X-ERR', '异常返回友好错误页，不泄露堆栈/绝对路径；服务不崩溃', !leak && r.status !== 500 && h.text === 'ok', `HTTP ${r.status}; 泄露堆栈与路径=${leak}（片段: ${(r.text.match(/Error: [^<]{0,50}<br> &nbsp; &nbsp;at [^<]{0,90}/) || [''])[0]}）; 之后 /health=${h.text}; 未知路由 ${unknown.status} “${unknown.text.slice(0, 40)}”`);
});

// ---------------- X-CONC：并发与重复提交 ----------------
test('X-CONC-1 同一 PTP 并发 5 个 fulfill', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '5000', interest_mode: 'fixed', interest_amount: '0' });
  await S.agent1.post(`/cases/${id}/ptps`, { amount: '500', due_date: today() });
  const p = q1('SELECT id FROM ptps WHERE case_id=?', id).id;
  const rs = await Promise.all([...Array(5)].map(() => S.agent1.post(`/ptps/${p}/fulfill`, { amount: '500', payment_date: today() })));
  const n = q1('SELECT COUNT(*) c FROM payments WHERE case_id=?', id).c;
  check('X-CONC-1', '只记 1 笔还款，其余提示 PTP already resolved', n === 1 && rs.filter(r => r.err === 'PTP already resolved').length === 4, `还款 ${n} 笔；响应 ${rs.map(r => r.ok ? 'ok' : r.err).join(' / ')}`);
});
test('X-CONC-2 并发两笔全额还款', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '700', interest_mode: 'fixed', interest_amount: '0' });
  const rs = await Promise.all([S.admin.post(`/cases/${id}/payments`, { payment_date: today(), amount: '700' }), S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: '700' })]);
  const s = q1('SELECT COUNT(*) c, SUM(amount) s FROM payments WHERE case_id=?', id);
  check('X-CONC-2', '只有一笔成功，另一笔 Amount exceeds outstanding', s.c === 1 && s.s === 700, `${rs.map(r => r.ok || r.err).join(' / ')}; 库 ${s.c} 笔 ${s.s}`);
});
test('X-CONC-3 双击/并发创建 PTP 与分期计划', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0' });
  await Promise.all([1, 2].map(() => S.agent1.post(`/cases/${id}/ptps`, { amount: '1000', due_date: today(), remark: 'dbl' })));
  await Promise.all([1, 2].map(() => S.agent1.post(`/cases/${id}/ptp-plans`, { total_amount: '1000', num_installments: '4', first_due_date: today() })));
  const ptps = q1("SELECT COUNT(*) c, SUM(amount) s FROM ptps WHERE case_id=? AND status='pending'", id);
  const plans = q1('SELECT COUNT(DISTINCT plan_id) c FROM ptps WHERE case_id=? AND plan_id IS NOT NULL', id).c;
  check('X-CONC-3', '重复提交不应生成重复 PTP/计划；承诺总额不应超过欠款', ptps.s <= 1000 && plans <= 1, `pending PTP ${ptps.c} 条合计 RM ${ptps.s}（欠款 RM 1,000）；计划 ${plans} 个`);
});
test('X-CONC-4 收据号并发唯一', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '100000', interest_mode: 'fixed', interest_amount: '0' });
  const rs = await Promise.all([...Array(10)].map(() => S.finance.post(`/cases/${id}/payments`, { payment_date: today(), amount: '1' })));
  const nos = rs.map(r => (r.ok || '').match(/RCPT-\S+/)?.[0]);
  check('X-CONC-4', '10 笔并发还款收据号唯一、无 500', new Set(nos).size === 10 && rs.every(r => r.status === 302), nos.join(','));
});

// ---------------- X-DATA：数据一致性（手册外） ----------------
test('X-OVERPAY 计息案件提前按 max 还清，多收部分被静默丢弃', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-09-01', tenure: '12' });
  await page(id); const max = caseRow(id).outstanding_amount;
  await S.admin.post(`/cases/${id}/payments`, { payment_date: today(), amount: String(max) });
  const t = await page(id); const c = caseRow(id); const paid = q1('SELECT SUM(amount) s FROM payments WHERE case_id=?', id).s;
  const gap = Math.round((paid - c.principal_amount - c.interest_charged) * 100) / 100;
  check('X-OVERPAY', '恒等式 Outstanding = Principal + Interest − Paid 成立；或 max 只允许当日结清额', gap === 0, `弹窗 max=${money(max)}（按合同期计到到期日）；今天还 max 后：Principal ${money(c.principal_amount)} + Interest ${money(c.interest_charged)} − Paid ${money(paid)} = ${money(-gap)}，页面 Outstanding ${ledgerAmt(t)}；多收 RM ${money(gap)} 无任何记录；回收率 ${(t.match(/<b>(\d+)% recovered/) || [])[1]}%`);
});
test('X-EDITCAP 编辑计息案件还款的上限可超过真实应还', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12' });
  await S.admin.post(`/cases/${id}/payments`, { payment_date: '2026-03-02', amount: '1000' });
  await page(id); const cap = caseRow(id).outstanding_amount + 1000;
  const p = q1('SELECT id FROM payments WHERE case_id=?', id).id;
  const r = await S.finance.post(`/cases/${id}/payments/${p}`, { amount: String(cap), payment_date: '2026-03-02' });
  const c = caseRow(id); await page(id);
  check('X-EDITCAP', '编辑后金额不应超过该日真实应还（10,300.00）', cap <= 10300, `编辑上限=${money(cap)}，${r.ok}；结果 Principal ${money(c.principal_amount)} Interest ${money(caseRow(id).interest_charged)} Paid ${money(cap)} Outstanding ${money(caseRow(id).outstanding_amount)}`);
});
test('X-BREAK-FULFILLED 已履行的 PTP 仍可被 Break', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0' });
  await S.agent1.post(`/cases/${id}/ptps`, { amount: '100', due_date: today() });
  const p = q1('SELECT id FROM ptps WHERE case_id=?', id).id;
  await S.agent1.post(`/ptps/${p}/fulfill`, { amount: '100', payment_date: today() });
  const r = await S.agent1.post(`/ptps/${p}/break`, {}); const r2 = await S.agent1.post(`/ptps/${p}/break`, {});
  const st = q1('SELECT status FROM ptps WHERE id=?', p).status; const pay = q1('SELECT COUNT(*) c FROM payments WHERE case_id=?', id).c;
  const tl = qa("SELECT content FROM timeline_events WHERE case_id=? AND event_type='ptp_broken'", id).length;
  check('X-BREAK-FULFILLED', '已履行/已违约的 PTP 再 Break 应被拒绝（PTP already resolved）', st === 'fulfilled', `Break 已履行 PTP → ${r.ok}；再 Break → ${r2.ok}；PTP 状态 ${st}；还款仍 ${pay} 笔；ptp_broken 时间线 ${tl} 条`);
});
test('X-DEMO-FK 演示催收员有自建数据时删除演示数据', async () => {
  // Tan Mei Ling (agent 4, demo) gets a customer-side settlement + case-less task; her demo cases have no customer rows.
  await S.finance.post('/commissions/settle', { agent_id: '4', amount: '12', note: 'customer settlement' });
  await S.admin.post('/tasks/new', { title: 'customer task for agent 4', agent_id: '4' });
  const r = await S.admin.post('/demo-tools/delete-demo', {});
  const ok = r.status === 302 && r.ok;
  check('X-DEMO-FK', 'Delete demo data 不报错，自建数据保留', ok, `HTTP ${r.status} ${r.ok || (r.text.match(/Error: [^<]{0,80}/) || [''])[0]}；失败后演示案件剩余 ${q1('SELECT COUNT(*) c FROM cases WHERE is_demo=1').c}、演示还款剩余 ${q1('SELECT COUNT(*) c FROM payments WHERE is_demo=1').c}（deleteDemo 无事务，半删除）`);
  await S.admin.post('/demo-tools/reload-demo', {});
});
test('X-CSV-INJ CSV 公式注入', async () => {
  await S.admin.post('/debtors', { name: '=HYPERLINK("http://evil.example","点我")' });
  const did = q1("SELECT id FROM debtors WHERE name LIKE '=HYPERLINK%'").id;
  await newCase(S.admin, { debtor_id: String(did), principal_amount: '1', interest_mode: 'fixed', interest_amount: '0' });
  const line = (await S.admin.get('/cases?format=csv')).text.split('\r\n').find(l => l.includes('HYPERLINK'));
  check('X-CSV-INJ', '以 = + - @ 开头的单元格应被转义（加前导单引号）', !/,"?=HYPERLINK/.test(line), line);
});
test('X-TIMING 登录用户名枚举（响应时间）', async () => {
  // 每 2 次失败插入一次成功登录清零计数，避免触发限流（限流后直接 429，测不到 bcrypt 时间）。
  const base = C.BASE;
  const t = async (u, p) => { const a = process.hrtime.bigint(); const r = await new Session(base).login(u, p); return [Number(process.hrtime.bigint() - a) / 1e6, r.status]; };
  const A_ = [], B_ = [], codes = [];
  for (let i = 0; i < 8; i++) {
    const [a, ca] = await t('auditor', 'wrong' + i); const [b, cb] = await t('ghost_user_' + i, 'wrong'); A_.push(a); B_.push(b); codes.push(ca, cb);
    await new Session(base).login('auditor', 'auditor123');
  }
  const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const ratio = med(B_) / med(A_);
  check('X-TIMING', '已存在用户错密码与不存在用户耗时相近（比值 0.67–1.5）', ratio > 0.67 && ratio < 1.5 && codes.every(c => c === 401), `已存在用户中位 ${med(A_).toFixed(1)}ms；不存在用户中位 ${med(B_).toFixed(1)}ms；比值 ${ratio.toFixed(2)}；状态码 ${[...new Set(codes)]}（DUMMY_HASH 代价 10，用户哈希代价 8）`);
});
test('X-HEADERS 会话 Cookie 与安全响应头', async () => {
  const r = await new Session().login('auditor', 'auditor123');
  const sc = (r.headers.getSetCookie() || []).join(';'); const h = await S.admin.get('/');
  const hdr = ['x-frame-options', 'content-security-policy', 'x-content-type-options', 'strict-transport-security'].map(k => `${k}=${h.headers.get(k) || '无'}`);
  check('X-HEADERS', 'Cookie 带 SameSite/Secure；有防点击劫持等安全头', /SameSite/i.test(sc) && !!h.headers.get('x-frame-options'), `Set-Cookie 属性: ${sc.replace(/connect\.sid=[^;]+/, 'connect.sid=…')}; ${hdr.join(', ')}; x-powered-by=${h.headers.get('x-powered-by')}`);
});
test('X-FLASH 任意 URL 参数显示为系统提示', async () => {
  const t = (await S.admin.get('/cases?err=' + encodeURIComponent('账号已被冻结，请致电 012-3456789 解锁'))).text;
  check('X-FLASH', 'ok/err 提示不应来自任意 URL 参数（内容伪造）', !has(t, '账号已被冻结'), C.flash(t));
});
test('X-STATUS 手动把有欠款的案件标为 Fully Paid / agent 删除他人备注', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '5000', interest_mode: 'fixed', interest_amount: '0' });
  const r = await S.agent1.post(`/cases/${id}/status`, { status: 'fully_paid' });
  await S.manager.post(`/cases/${id}/notes`, { content: 'manager 重要备注' });
  const nid = q1("SELECT id FROM timeline_events WHERE content='manager 重要备注'").id;
  const d = await S.agent1.post(`/cases/${id}/notes/${nid}/delete`, {});
  const gone = !q1('SELECT 1 x FROM timeline_events WHERE id=?', nid); const audit = q1("SELECT COUNT(*) c FROM audit_logs WHERE details LIKE '%note%'").c;
  check('X-STATUS', '欠款 > 0 时不应可手动标 Fully Paid；agent 不应能删除他人备注且应留审计', caseRow(id).status !== 'fully_paid' && !gone, `agent1 标 Fully Paid → ${r.ok}（欠款 ${caseRow(id).outstanding_amount}，closed_at=${caseRow(id).closed_at}）；agent1 删除 manager 备注 → ${d.ok}，已删除=${gone}，备注审计 ${audit} 条`);
});
test('X-ORDER 同一秒内的时间线事件顺序', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '5000', interest_mode: 'fixed', interest_amount: '0', status: 'assigned' });
  await S.admin.post(`/cases/${id}/payments`, { payment_date: today(), amount: '10' }); // payment + status_change? (status change is silent here)
  await S.admin.post(`/cases/${id}/notes`, { content: 'second' }); await S.admin.post(`/cases/${id}/notes`, { content: 'third' });
  const t = await page(id);
  const order = [...t.slice(t.indexOf('<ul class="timeline">')).matchAll(/<li><span class="badge [^"]+">(\w+)<\/span>\s*(?:\s*)([^<]{0,40})/g)].map(m => m[2].trim() || m[1]);
  check('X-ORDER', '最新事件在最上（third → second → payment → created）', order[0].startsWith('third'), `页面顺序: ${order.join(' > ')}（created_at 只精确到秒，同秒按插入先后升序）`);
});
test('X-AUTOCLOSE 还款自动 Fully Paid 不写 status_change 时间线与 closed_at（E-08 复核）', async () => {
  const id = await newCase(S.admin, { debtor_id: String(D), agent_id: '1', principal_amount: '100', interest_mode: 'fixed', interest_amount: '0', status: 'assigned' });
  await S.admin.post(`/cases/${id}/payments`, { payment_date: today(), amount: '100' });
  const c = caseRow(id); const sc = q1("SELECT COUNT(*) n FROM timeline_events WHERE case_id=? AND event_type='status_change'", id).n;
  check('X-AUTOCLOSE', '自动还清时记录结案时间并写状态变更', !!c.closed_at && sc > 0, `status=${c.status} closed_at=${c.closed_at} status_change 事件=${sc}`);
});
