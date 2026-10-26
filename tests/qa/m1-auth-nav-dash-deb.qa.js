// Manual chapters 4.1 AUTH, 4.2 NAV (HTTP part), 4.3 DASH, 4.4 DEB.
// Run: node --test tests/qa/m1-auth-nav-dash-deb.qa.js   (server on :3301, DB data/qa/tester.db)
const { test, before, after } = require('node:test');
const C = require('./_client');
const { Session, as, check, rec, q1, qa, has, strip, today, addDays, newDebtor, newCase } = C;

before(() => C.reseed());
after(() => C.saveResults('m1'));

const S = {};
test('setup sessions', async () => {
  for (const u of ['admin', 'manager', 'agent1', 'finance', 'auditor']) S[u] = await as(u);
});

// ---------------- AUTH ----------------
test('AUTH-01 正确账号登录', async () => {
  const s = new Session();
  const r = await s.login('admin', 'admin123');
  const home = await s.get('/');
  const audit = q1("SELECT * FROM audit_logs WHERE action='login' AND username='admin' ORDER BY id DESC LIMIT 1");
  check('AUTH-01', '进入 Dashboard；显示 System Admin/admin；audit login', r.status === 302 && r.location === '/' && has(home.text, '<strong>System Admin</strong><small>admin</small>') && has(home.text, '<h1>Dashboard</h1>') && !!audit,
    `login ${r.status}→${r.location}; sidebar who=${has(home.text, '<strong>System Admin</strong><small>admin</small>')}; audit=${audit && audit.details}`);
});
test('AUTH-02 密码错误', async () => {
  const r = await new Session().login('admin', 'wrong');
  check('AUTH-02', '停留登录页，红色 Invalid username or password', r.status === 401 && has(r.text, 'alert is-red">Invalid username or password'), `HTTP ${r.status}; ${has(r.text, 'Invalid username or password')}`);
});
test('AUTH-03 用户名不存在', async () => {
  const a = await new Session().login('admin', 'wrong');
  const t0 = Date.now(); const b = await new Session().login('no_such_user_qa', 'x'); const dt = Date.now() - t0;
  check('AUTH-03', '提示与 AUTH-02 完全相同', a.status === b.status && a.text === b.text, `status ${a.status}/${b.status}, body identical=${a.text === b.text}, 耗时 ${dt}ms`);
});
test('AUTH-04 停用账号登录', async () => {
  await S.admin.post('/users', { username: 'qa_inactive', full_name: 'QA Inactive', password: 'pass1234', role: 'finance' });
  const u = q1("SELECT id FROM users WHERE username='qa_inactive'");
  const e = await S.admin.post(`/users/${u.id}`, { username: 'qa_inactive', full_name: 'QA Inactive', role: 'finance', active: '0' });
  const r = await new Session().login('qa_inactive', 'pass1234');
  check('AUTH-04', 'Invalid username or password', e.ok === 'User updated' && r.status === 401 && has(r.text, 'Invalid username or password'), `deactivate=${e.ok}; login HTTP ${r.status}`);
});
test('AUTH-05 登录失败限流（使用 [::1] 来源地址，避免锁住主测试 IP 127.0.0.1）', async () => {
  const s = new Session('http://[::1]:3301');
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await s.login('admin', 'bad' + i)).status);
  const sixth = await s.login('admin', 'admin123');
  const other = await new Session().login('admin', 'admin123'); // 127.0.0.1 unaffected
  check('AUTH-05', '第 6 次提示 Too many attempts. Try again later.', sixth.status === 429 && has(sixth.text, 'Too many attempts. Try again later.'),
    `前5次 ${codes.join(',')}；第6次(正确密码) HTTP ${sixth.status}；另一 IP 正常登录=${other.status === 302}。15 分钟锁定由代码 LOCK_MS=15*60*1000 确认；重启清零见 m1-restart 步骤`);
});
test('AUTH-06 已登录访问登录页', async () => {
  const r = await S.admin.get('/login');
  check('AUTH-06', '跳回 Dashboard', r.status === 302 && r.location === '/', `${r.status}→${r.location}`);
});
test('AUTH-07 未登录访问受保护页面', async () => {
  const s = new Session(); const out = [];
  for (const p of ['/cases', '/reports', '/cases/2']) { const r = await s.get(p); out.push(`${p}:${r.status}→${r.location}`); }
  check('AUTH-07', '全部重定向 /login', out.every(x => x.endsWith('302→/login')), out.join(' '));
});
test('AUTH-08 退出登录', async () => {
  const s = await as('manager');
  const old = s.cookie;
  const r = await s.get('/logout');
  const a = q1("SELECT * FROM audit_logs WHERE action='logout' AND username='manager' ORDER BY id DESC LIMIT 1");
  const replay = new Session(); replay.cookie = old; const back = await replay.get('/');
  check('AUTH-08', '回登录页；audit logout；旧会话需重新登录', r.location === '/login' && !!a && back.status === 302 && back.location === '/login', `logout→${r.location}; audit=${!!a}; 旧cookie访问 / → ${back.status} ${back.location}`);
});
test('AUTH-09 演示账号页', async () => {
  const r = await new Session().get('/demo-accounts');
  const rows = (r.text.match(/<tr>\s*<td class="mono">/g) || []).length;
  const login = await new Session().get('/login');
  check('AUTH-09', '无需登录，列 5 个账号；登录页无链接', r.status === 200 && rows === 5 && !has(login.text, 'demo-accounts'), `HTTP ${r.status}, 账号行 ${rows}, 登录页含链接=${has(login.text, 'demo-accounts')}`);
});
test('AUTH-10 版本信息', async () => {
  const login = await new Session().get('/login');
  const v = await new Session().get('/version');
  const vers = [...v.text.matchAll(/<strong>v([\d.]+)<\/strong>\s*<small/g)].map(m => m[1]);
  const sorted = vers.every((x, i) => i === 0 || x.localeCompare(vers[i - 1], undefined, { numeric: true }) < 0);
  check('AUTH-10', '登录页 v1.8.0；/version 最新在上', has(login.text, 'v1.8.0') && has(login.text, 'href="/version"') && vers[0] === '1.8.0' && sorted, `登录页 v1.8.0=${has(login.text, 'v1.8.0')}; 版本顺序 ${vers.join(' > ')}`);
});
test('AUTH-11 健康检查', async () => {
  const r = await new Session().get('/health');
  check('AUTH-11', '纯文本 ok', r.status === 200 && r.text === 'ok' && /text\/plain/.test(r.headers.get('content-type')), `${r.status} "${r.text}" ${r.headers.get('content-type')}`);
});
test('AUTH-12 越权 URL（agent1）', async () => {
  const out = [];
  for (const p of ['/users', '/settings', '/demo-tools', '/audit-log', '/agents', '/cases/new']) { const r = await S.agent1.get(p); out.push(`${p}:${r.status}${has(r.text, '<p>Forbidden</p>') ? '' : '(无Forbidden)'}`); }
  check('AUTH-12', '全部 403 Forbidden', out.every(x => /:403$/.test(x)), out.join(' '));
});

// ---------------- NAV (HTTP 部分；NAV-02/04 见 ui.qa.py) ----------------
function menu(html) {
  const side = html.slice(html.indexOf('<aside class="sidebar">'), html.indexOf('</aside>'));
  return [...side.matchAll(/<span class="lbl">([A-Za-z ]+)<\/span>/g)].map(m => m[1]).filter(x => !['Debt Collection ', 'Logout'].includes(x));
}
test('NAV-01 菜单按角色显示', async () => {
  const exp = {
    admin: 'Dashboard,Debtors,Cases,Tasks,Team,Agents,Users,Reports,Commissions,Admin,Settings,Demo Data,Audit Log,Search',
    manager: 'Dashboard,Debtors,Cases,Tasks,Team,Agents,Reports,Commissions,Search',
    agent1: 'Dashboard,Debtors,Cases,Tasks,Reports,Commissions,Search',
    finance: 'Dashboard,Debtors,Cases,Tasks,Reports,Commissions,Search',
    auditor: 'Dashboard,Debtors,Cases,Tasks,Team,Agents,Reports,Commissions,Admin,Audit Log,Search',
  };
  const got = {}; let ok = true;
  for (const u of Object.keys(exp)) { got[u] = menu((await S[u].get('/')).text).join(','); if (got[u] !== exp[u]) ok = false; }
  check('NAV-01', '与第 3 章侧边栏对照一致', ok, JSON.stringify(got));
});
test('NAV-03 当前页高亮', async () => {
  const pages = { '/': 'Dashboard', '/debtors': 'Debtors', '/cases': 'Cases', '/tasks': 'Tasks', '/agents': 'Agents', '/users': 'Users', '/reports': 'Reports', '/commissions': 'Commissions', '/settings': 'Settings', '/demo-tools': 'Demo Data', '/audit-log': 'Audit Log', '/search': 'Search', '/cases/2': 'Cases' };
  const bad = [];
  for (const [p, lbl] of Object.entries(pages)) {
    const t = (await S.admin.get(p)).text;
    const re = new RegExp(`class="active">(?:<svg[\\s\\S]*?</svg>)?<span class="lbl">${lbl}</span>`);
    if (!re.test(t)) bad.push(p);
  }
  check('NAV-03', '对应菜单项高亮', bad.length === 0, bad.length ? '未高亮: ' + bad.join(',') : '13 个页面均高亮');
});
test('NAV-05 操作结果提示（HTTP 层）', async () => {
  const okR = await S.admin.post('/debtors', { name: 'QA nav ok' });
  const okPage = await S.admin.get(okR.location);
  const badR = await S.admin.post('/debtors', { name: '   ' });
  const badPage = await S.admin.get(badR.location);
  check('NAV-05', '成功绿色、失败红色提示条', has(okPage.text, 'alert is-green">Debtor created') && has(badPage.text, 'alert is-red">Name is required'), `成功=${C.flash(okPage.text)}；失败=${C.flash(badPage.text)}`);
});
test('NAV-06 浏览器标签标题', async () => {
  const pages = ['/', '/debtors', '/cases', '/cases/2', '/tasks', '/agents', '/users', '/reports', '/commissions', '/settings', '/demo-tools', '/audit-log', '/search', '/cases/new', '/debtors/1', '/agents/1', '/users/new', '/cases/2/statement', '/cases/99999', '/login', '/version', '/demo-accounts'];
  const out = [];
  for (const p of pages) {
    const s = ['/login', '/version', '/demo-accounts'].includes(p) ? new Session() : S.admin;
    const t = ((await s.get(p)).text.match(/<title>([^<]*)<\/title>/) || [])[1];
    if (!/^.+ — Debt Collection CRM$/.test(t || '')) out.push(`${p} → "${t}"`);
  }
  check('NAV-06', '标题格式“页面名 — Debt Collection CRM”', out.length === 0, out.length ? '不符合: ' + out.join('; ') : '全部符合');
});

// ---------------- DASH ----------------
function kpi(html) {
  const t = strip(html); const n = s => Number(String(s).replace(/,/g, ''));
  const m1 = t.match(/Collected Today RM ([\d,.]+) (\d+) payments? today/);
  const m2 = t.match(/Cases (\d+) active · (\d+) legal/);
  const m3 = t.match(/PTP (\d+) due · (\d+) overdue · (\d+) broken/);
  const m4 = t.match(/Total Outstanding RM ([\d,.]+)/);
  const m5 = t.match(/Case Activity (\d+) opened · (\d+) closed · (\d+) overdue · (\d+) upcoming/);
  return { collected: n(m1[1]), payments: n(m1[2]), active: n(m2[1]), legal: n(m2[2]), ptpDue: n(m3[1]), ptpOverdue: n(m3[2]), ptpBroken: n(m3[3]),
    outstanding: n(m4[1]), opened: n(m5[1]), closed: n(m5[2]), overdueTasks: n(m5[3]), upcoming: n(m5[4]) };
}
const dash = async (s = S.admin) => kpi((await s.get('/')).text);
let dashCase;
test('DASH-01 今日收款', async () => {
  const before = await dash();
  dashCase = 13; // Assigned demo case (agent1), outstanding > 0
  const r = await S.admin.post(`/cases/${dashCase}/payments`, { payment_date: today(), amount: '100', method: 'cash' });
  const afterK = await dash();
  check('DASH-01', 'Collected Today +100，payments +1', afterK.collected - before.collected === 100 && afterK.payments - before.payments === 1, `${r.ok}; collected ${before.collected}→${afterK.collected}; count ${before.payments}→${afterK.payments}`);
});
test('DASH-02 非今日还款', async () => {
  const before = await dash();
  const r = await S.admin.post(`/cases/${dashCase}/payments`, { payment_date: addDays(today(), -1), amount: '50', method: 'cash' });
  const afterK = await dash();
  check('DASH-02', '不计入 Collected Today', afterK.collected === before.collected && afterK.payments === before.payments, `${r.ok}; collected ${before.collected}→${afterK.collected}`);
});
test('DASH-03 案件数', async () => {
  const k = await dash();
  const act = q1("SELECT COUNT(*) c FROM cases WHERE status NOT IN ('legal','closed','cancelled','bankruptcy','deceased')").c;
  const fp = q1("SELECT COUNT(*) c FROM cases WHERE status='fully_paid'").c;
  const legal = q1("SELECT COUNT(*) c FROM cases WHERE status='legal'").c;
  check('DASH-03', 'active=非终态（含 Fully Paid）；legal=Legal 数', k.active === act && k.legal === legal, `页面 active=${k.active} legal=${k.legal}；库 active=${act}（含 fully_paid ${fp}）legal=${legal}`);
});
test('DASH-04 PTP 指标', async () => {
  const before = await dash();
  const r1 = await S.admin.post('/cases/15/ptps', { amount: '10', due_date: today(), remark: 'qa due today' });
  const p4 = q1("SELECT id FROM ptps WHERE case_id=4 AND status='pending'");
  const r2 = await S.admin.post(`/ptps/${p4.id}/break`, {});
  const afterK = await dash();
  const overdue = q1("SELECT COUNT(*) c FROM ptps WHERE status='pending' AND date(due_date) < date('now','+8 hours')").c;
  check('DASH-04', 'due+1；broken+1；overdue=已过期 pending 数', afterK.ptpDue - before.ptpDue === 1 && afterK.ptpBroken - before.ptpBroken === 1 && afterK.ptpOverdue === overdue,
    `${r1.ok}/${r2.ok}; due ${before.ptpDue}→${afterK.ptpDue}; broken ${before.ptpBroken}→${afterK.ptpBroken}; overdue 页面${afterK.ptpOverdue}/库${overdue}`);
});
test('DASH-05 总欠款与报表一致', async () => {
  const k = await dash();
  const rep = strip((await S.admin.get('/reports')).text).match(/Total (\d+) ([\d,.]+)/);
  check('DASH-05', '两者相等', rep && Number(rep[2].replace(/,/g, '')) === k.outstanding, `dashboard ${k.outstanding}；reports Total ${rep && rep[2]}`);
});
test('DASH-06 今日新开 / 结案', async () => {
  const before = await dash();
  const did = await newDebtor(S.admin, 'QA dash debtor');
  const cid = await newCase(S.admin, { debtor_id: did, principal_amount: '500', interest_mode: 'fixed', interest_amount: '0' });
  const r = await S.admin.post('/cases/19/status', { status: 'closed' });
  const afterK = await dash();
  check('DASH-06', 'opened+1，closed+1', afterK.opened - before.opened === 1 && afterK.closed - before.closed === 1, `新案 ${cid}; ${r.ok}; opened ${before.opened}→${afterK.opened}; closed ${before.closed}→${afterK.closed}`);
});
test('DASH-07 逾期与即将到期任务', async () => {
  const before = await dash();
  await S.admin.post('/tasks/new', { title: 'QA overdue task', type: 'follow_up', due_date: addDays(today(), -1), agent_id: '1' });
  await S.admin.post('/tasks/new', { title: 'QA in 10d', type: 'follow_up', due_date: addDays(today(), 10), case_id: '13' });
  const afterK = await dash();
  const up = q1(`SELECT COUNT(*) c FROM tasks JOIN cases ON cases.id=tasks.case_id WHERE tasks.status='pending' AND tasks.due_date IS NOT NULL AND date(tasks.due_date) <= date('now','+8 hours','+14 days') AND cases.status NOT IN ('legal','closed','cancelled','bankruptcy','deceased')`).c;
  check('DASH-07', 'overdue+1；upcoming=14 天内（含逾期）关联未终结案件的待办', afterK.overdueTasks - before.overdueTasks === 1 && afterK.upcoming - before.upcoming === 1 && afterK.upcoming === up,
    `overdue ${before.overdueTasks}→${afterK.overdueTasks}; upcoming ${before.upcoming}→${afterK.upcoming}（库 ${up}）`);
});
test('DASH-08 账龄分布', async () => {
  const html = (await S.admin.get('/')).text;
  const lines = [...html.matchAll(/<span>([^<]+)d<\/span><span class="tr"><i style="width:(\d+)%"><\/i><\/span><span class="v">RM ([\d,.]+)/g)].map(m => ({ lbl: m[1], w: Number(m[2]), v: Number(m[3].replace(/,/g, '')) }));
  const rows = qa("SELECT CAST(julianday('now','+8 hours') - julianday(opened_at) AS INTEGER) age, outstanding_amount amt FROM cases WHERE outstanding_amount > 0 AND status NOT IN ('legal','closed','cancelled','bankruptcy','deceased')");
  const exp = [0, 0, 0, 0]; rows.forEach(r => { exp[r.age <= 30 ? 0 : r.age <= 60 ? 1 : r.age <= 90 ? 2 : 3] += r.amt; });
  const expR = exp.map(x => Math.round(x * 100) / 100); const maxI = expR.indexOf(Math.max(...expR));
  const ok = lines.length === 4 && lines.map(l => l.lbl).join('|') === '0–30|31–60|61–90|90+' && lines.every((l, i) => Math.abs(l.v - expR[i]) < 0.005) && lines[maxI].w === 100;
  check('DASH-08', '四档；只计欠款>0 未终结；最大档满格', ok, JSON.stringify(lines) + ' 期望 ' + JSON.stringify(expR));
});
test('DASH-09 待跟进列表', async () => {
  await S.admin.post('/tasks/new', { title: 'QA today task', type: 'follow_up', due_date: today(), case_id: '15' });
  const html = (await S.admin.get('/')).text;
  const sec = html.slice(html.indexOf('Upcoming Follow-ups'), html.indexOf('Agent Leaderboard'));
  const rows = [...sec.matchAll(/<a href="\/cases\/(\d+)">[^<]+<\/a>[\s\S]*?<span class="badge (is-\w+)">([^<]+)<\/span>/g)].map(m => ({ id: m[1], cls: m[2], lbl: m[3] }));
  const badgeOk = rows.every(r => (/d late$/.test(r.lbl) && r.cls === 'is-red') || (r.lbl === 'Today' && r.cls === 'is-gold') || (/^in \d+d$/.test(r.lbl) && r.cls === 'is-neutral'));
  const order = rows.map(r => r.lbl.endsWith('late') ? Number(r.lbl.split('d')[0]) : r.lbl === 'Today' ? 0 : -Number(r.lbl.match(/\d+/)[0]));
  const sorted = order.every((v, i) => i === 0 || v <= order[i - 1]);
  check('DASH-09', '≤10 条；按到期排序；徽章 late红/Today金/in Nd灰；链接案件', rows.length > 0 && rows.length <= 10 && badgeOk && sorted && rows.some(r => r.lbl === 'Today') && rows.some(r => r.cls === 'is-red'), JSON.stringify(rows));
});
test('DASH-10 排行榜可见性', async () => {
  const out = {};
  for (const u of ['admin', 'manager', 'finance', 'auditor', 'agent1']) {
    const t = (await S[u].get('/')).text; const vis = has(t, '<h2>Agent Leaderboard</h2>');
    const vals = [...t.slice(t.indexOf('Agent Leaderboard')).matchAll(/<div class="row"><span>[^<]+<\/span><span class="num">RM ([\d,.]+)/g)].map(m => Number(m[1].replace(/,/g, '')));
    out[u] = vis ? `可见${vals.length}行${vals.every((v, i) => i === 0 || v <= vals[i - 1]) ? '降序' : '非降序'}` : '不可见';
  }
  check('DASH-10', '前四角色可见（≤5，按收款降序）；agent 不可见', ['admin', 'manager', 'finance', 'auditor'].every(u => /^可见[1-5]行降序$/.test(out[u])) && out.agent1 === '不可见', JSON.stringify(out));
});
test('DASH-11 最近动态', async () => {
  // created_at 只到秒；同一秒内的多条事件按插入升序排列（见手册外 X-ORDER）。人工操作间隔 >1s，这里等 1.1s 模拟。
  await new Promise(r => setTimeout(r, 1100));
  await S.admin.post('/cases/13/calls', { result: 'answered', duration_seconds: '30', notes: 'QA recent activity call' });
  const t = (await S.admin.get('/')).text;
  const feed = t.slice(t.indexOf('<ul class="feed">'), t.indexOf('</ul>', t.indexOf('<ul class="feed">')));
  const items = (feed.match(/<li>/g) || []).length;
  const first = feed.slice(0, feed.indexOf('</li>'));
  check('DASH-11', '新记录在最上；≤12 条；可点进案件', items <= 12 && has(first, 'QA recent activity call') && has(first, 'href="/cases/13"'), `条数 ${items}; 首条=${strip(first).trim().slice(0, 80)}`);
});
test('DASH-12 催收员数据范围（agent1）', async () => {
  const k = await dash(S.agent1);
  const W = 'agent_id=1';
  const exp = {
    outstanding: Math.round(q1(`SELECT COALESCE(SUM(outstanding_amount),0) s FROM cases WHERE ${W}`).s * 100) / 100,
    active: q1(`SELECT COUNT(*) c FROM cases WHERE ${W} AND status NOT IN ('legal','closed','cancelled','bankruptcy','deceased')`).c,
    legal: q1(`SELECT COUNT(*) c FROM cases WHERE ${W} AND status='legal'`).c,
    collected: q1(`SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN cases c ON c.id=p.case_id WHERE c.agent_id=1 AND date(p.payment_date)=date('now','+8 hours')`).s,
    ptpBroken: q1(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE c.agent_id=1 AND t.status='broken'`).c,
    overdueTasks: q1(`SELECT COUNT(*) c FROM tasks WHERE agent_id=1 AND status='pending' AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')`).c,
  };
  const t = (await S.agent1.get('/')).text;
  const feedCases = [...t.slice(t.indexOf('<ul class="feed">')).matchAll(/href="\/cases\/(\d+)"/g)].map(m => Number(m[1]));
  const own = qa('SELECT id FROM cases WHERE agent_id=1').map(r => r.id);
  const ok = Object.keys(exp).every(k2 => Math.abs(k[k2] - exp[k2]) < 0.005) && feedCases.every(id => own.includes(id)) && !has(t, 'Agent Leaderboard');
  check('DASH-12', '所有数字/列表/动态只含 agent1 名下', ok, `页面 ${JSON.stringify(k)}；期望 ${JSON.stringify(exp)}；动态案件 ${[...new Set(feedCases)]}（本人 ${own}）`);
});

// ---------------- DEB ----------------
test('DEB-01 列表与筛选', async () => {
  const names = t => [...t.matchAll(/<tr><td><a href="\/debtors\/\d+">([^<]+)<\/a><\/td><td class="mono">([^<]*)<\/td>\s*<td class="mono">([^<]*)<\/td>[\s\S]*?<span class="badge [^"]+">(\w+)<\/span>/g)].map(m => ({ n: m[1], ic: m[2], ph: m[3], risk: m[4] }));
  const high = names((await S.admin.get('/debtors?risk=high')).text);
  const byName = names((await S.admin.get('/debtors?q=' + encodeURIComponent('Lim'))).text);
  const byIc = names((await S.admin.get('/debtors?q=850320')).text);
  const byPhone = names((await S.admin.get('/debtors?q=017-4445')).text);
  const all = names((await S.admin.get('/debtors')).text).map(x => x.n);
  const sortedOk = all.every((v, i) => i === 0 || all[i - 1].localeCompare(v, 'en', { sensitivity: 'base' }) <= 0 || all[i - 1] <= v);
  const ok = high.length > 0 && high.every(x => x.risk === 'high') && byName.every(x => /lim/i.test(x.n)) && byName.length >= 1 && byIc.length === 1 && byIc[0].ic.includes('850320') && byPhone.length === 1 && byPhone[0].ph.includes('017-4445') && sortedOk;
  check('DEB-01', '结果符合条件；按姓名排序', ok, `high ${high.length} 条; 'Lim' → ${byName.map(x => x.n)}; IC → ${byIc.map(x => x.n)}; phone → ${byPhone.map(x => x.n)}; 排序=${sortedOk}`);
});
test('DEB-02 新建必填', async () => {
  const form = (await S.admin.get('/debtors/new')).text;
  const r = await S.admin.post('/debtors', { name: '    ' });
  check('DEB-02', '留空被浏览器拦截；只填空格服务端提示 Name is required', /name="name" value="" required/.test(form) && r.err === 'Name is required', `required 属性=${/name="name" value="" required/.test(form)}; 空格提交 → ${r.err}`);
});
let debId;
test('DEB-03 新建成功', async () => {
  const r = await S.admin.post('/debtors', { name: 'QA 债务人甲', ic_passport: '900101-01-1234', phone: '011-1111222', email: 'qa@x.my', address: 'QA addr', employer: 'QA Co', salary: '3000', risk_level: 'low', guarantor_name: 'QA 担保人', guarantor_phone: '011-9999000', remark: 'r' });
  debId = q1("SELECT id, guarantor_name FROM debtors WHERE name='QA 债务人甲'");
  const a = q1("SELECT * FROM audit_logs WHERE action='create' AND entity_type='debtor' ORDER BY id DESC LIMIT 1");
  check('DEB-03', '回列表并提示 Debtor created；audit create debtor', r.location.startsWith('/debtors?ok=Debtor+created') && debId.guarantor_name === 'QA 担保人' && a && a.entity_id === debId.id, `${r.location}; guarantor=${debId.guarantor_name}; audit=${a && a.details}`);
  debId = debId.id;
});
test('DEB-04 编辑', async () => {
  const r = await S.admin.post(`/debtors/${debId}`, { name: 'QA 债务人甲', phone: '011-2222333', risk_level: 'high', guarantor_name: 'QA 担保人' });
  const show = (await S.admin.get(`/debtors/${debId}`)).text;
  const a = q1("SELECT * FROM audit_logs WHERE action='update' AND entity_type='debtor' AND entity_id=? ORDER BY id DESC LIMIT 1", debId);
  check('DEB-04', '提示 Saved，详情为新值；audit update debtor', r.ok === 'Saved' && has(show, '011-2222333') && has(show, '>high</span>') && !!a, `${r.ok}; 新电话=${has(show, '011-2222333')}; risk high=${has(show, '>high</span>')}; audit=${!!a}`);
});
test('DEB-05 详情页案件列表', async () => {
  const t = (await S.admin.get('/debtors/2')).text; // Sarah Lim: cases 2, 14
  const rows = [...t.matchAll(/<a href="\/cases\/(\d+)" class="mono">(CASE-[^<]+)<\/a><\/td>\s*<td class="num">([\d,.]+)<\/td><td><span class="badge/g)].map(m => `${m[1]}:${m[2]}:${m[3]}`);
  const exp = qa('SELECT id FROM cases WHERE debtor_id=2').map(r => String(r.id));
  check('DEB-05', '列出该债务人案件（号/欠款/状态），可点进', rows.length === exp.length && rows.length > 0, rows.join(' | '));
});
test('DEB-06 催收员数据范围', async () => {
  const t = (await S.agent1.get('/debtors')).text;
  const listed = [...t.matchAll(/href="\/debtors\/(\d+)"/g)].map(m => Number(m[1])).sort((a, b) => a - b);
  const exp = qa('SELECT DISTINCT debtor_id d FROM cases WHERE agent_id=1 ORDER BY d').map(r => r.d);
  const other = q1('SELECT debtor_id d FROM cases WHERE agent_id=2 AND debtor_id NOT IN (SELECT debtor_id FROM cases WHERE agent_id=1) LIMIT 1').d;
  const r = await S.agent1.get(`/debtors/${other}`);
  check('DEB-06', '列表只含本人案件债务人；越权 403', JSON.stringify(listed) === JSON.stringify(exp) && r.status === 403, `列表 ${listed}（期望 ${exp}）；/debtors/${other} → ${r.status}`);
});
test('DEB-07 只读角色', async () => {
  const out = [];
  for (const u of ['finance', 'auditor']) {
    const l = await S[u].get('/debtors'); const d = await S[u].get('/debtors/1');
    out.push(`${u}: list ${l.status} new=${has(l.text, '+ New Debtor')} detail ${d.status} edit=${has(d.text, '/debtors/1/edit')}`);
  }
  check('DEB-07', '可以查看；没有 + New Debtor 与 Edit', out.every(x => /list 200 new=false detail 200 edit=false/.test(x)), out.join('; '));
});
test('DEB-08 催收员新建债务人', async () => {
  const r = await S.agent1.post('/debtors', { name: 'QA agent1 新债务人' });
  const t = (await S.agent1.get('/debtors')).text;
  check('DEB-08', '提示 Debtor created，但列表里看不到（E-06 现状）', r.ok === 'Debtor created' && !has(t, 'QA agent1 新债务人'), `${r.ok}; 列表可见=${has(t, 'QA agent1 新债务人')}`, '行为与手册描述一致；E-06 体验问题另列发现');
});
test('DEB-09 特殊字符', async () => {
  await S.admin.post('/debtors', { name: '<b>测试</b>' });
  const id = q1("SELECT id FROM debtors WHERE name='<b>测试</b>'").id;
  const l = (await S.admin.get('/debtors')).text; const d = (await S.admin.get(`/debtors/${id}`)).text;
  check('DEB-09', '原样显示为文本', has(l, '&lt;b&gt;测试&lt;/b&gt;') && !has(l, '<b>测试</b>') && has(d, '<h1>&lt;b&gt;测试&lt;/b&gt;</h1>'), `列表转义=${has(l, '&lt;b&gt;测试&lt;/b&gt;')}; 详情转义=${has(d, '&lt;b&gt;测试&lt;/b&gt;')}`);
});
