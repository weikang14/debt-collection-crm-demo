// Manual v1.1 §4.1 AUTH, §4.2 NAV, §4.3 DASH, §4.4 DEB — HTTP level.
// Browser-only parts (NAV-02, NAV-04, DEB-02 browser block) are in ui.qa.py.
const { test } = require('node:test');
const c = require('./_client');
const { reseed, step, finish, assert } = require('./_run');
const { check, rec, has, strip, today, addDays, q1, qa } = c;

// Dashboard KPI parser (stripped text).
function kpi(html) {
  const t = strip(html);
  const n = (re) => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : NaN; };
  const ageOf = (lbl) => n(new RegExp(lbl.replace(/[+]/g, '\\+') + ' RM ([\\d,.]+)'));
  return {
    collected: n(/Collected Today RM ([\d,.]+)/), payments: n(/([\d]+) payments? today/),
    active: n(/Cases (\d+) active/), legal: n(/active · (\d+) legal/),
    due: n(/PTP (\d+) due/), overdue: n(/due · (\d+) overdue/), broken: n(/overdue · (\d+) broken/),
    // v1.12.0: "Total Outstanding · settlement today", contract balance beside it (G-24).
    outstanding: n(/Total Outstanding (?:· settlement today )?RM ([\d,.]+)/), special: n(/RM ([\d,.]+) in legal/), contract: n(/contract balance RM ([\d,.]+)/),
    opened: n(/(\d+) opened/), closed: n(/opened · (\d+) closed/), overdueTasks: n(/closed · (\d+) overdue/), upcoming: n(/overdue · (\d+) upcoming/),
    dpd: ['Current', '1–30', '31–60', '61–90', '90\\+', 'No schedule'].map(l => n(new RegExp('(?:^|\\s)' + l + ' RM ([\\d,.]+)'))),
    age: ['0–30d', '31–60d', '61–90d', '90\\+d'].map(l => n(new RegExp(l + ' RM ([\\d,.]+)'))),
    leaderboard: has(html, 'Agent Leaderboard'), text: t,
  };
  void ageOf;
}
const TERM = ['legal', 'closed', 'cancelled', 'bankruptcy', 'deceased'];

test('r2 A: AUTH / NAV / DASH / DEB', { timeout: 300000 }, async () => {
  reseed();
  const admin = await c.as('admin');

  // ---------------- AUTH ----------------
  await step('AUTH-01', 'Dashboard; System Admin/admin; audit login', async () => {
    const s = new c.Session();
    const r = await s.login('admin', 'admin123');
    const d = await s.get('/');
    const log = q1("SELECT * FROM audit_logs WHERE action='login' AND username='admin' ORDER BY id DESC LIMIT 1");
    check('AUTH-01', 'Dashboard; System Admin/admin; audit login', r.status === 302 && r.location === '/' && has(d.text, '<strong>System Admin</strong><small>admin</small>') && !!log,
      `${r.status} ${r.location}; footer=${has(d.text, '<strong>System Admin</strong><small>admin</small>')}; audit=${log && log.details}`);
  });
  await step('AUTH-02', 'stay on login, "Invalid username or password"', async () => {
    const r = await new c.Session().login('admin', 'wrong-pass');
    check('AUTH-02', 'stay on login, red "Invalid username or password"', r.status === 401 && has(r.text, 'alert is-red">Invalid username or password'), `${r.status} ${c.alertOf(r.text)?.text}`);
  });
  await step('AUTH-03', 'same message as AUTH-02', async () => {
    const r1 = await new c.Session().login('admin', 'nope');
    const r2 = await new c.Session().login('no_such_user_x', 'nope');
    check('AUTH-03', 'identical response for unknown user', r1.status === r2.status && c.alertOf(r1.text)?.text === c.alertOf(r2.text)?.text, `${r1.status}/${r2.status} "${c.alertOf(r2.text)?.text}"`);
    await c.as('admin'); // reset fail counter for this IP
  });
  await step('AUTH-04', 'inactive account → Invalid username or password', async () => {
    await admin.act('/users', { username: 'qa_inact', full_name: 'QA Inactive', password: 'qa-pass-123', role: 'finance' });
    const u = q1("SELECT id FROM users WHERE username='qa_inact'");
    await admin.act(`/users/${u.id}/toggle`);
    const r = await new c.Session().login('qa_inact', 'qa-pass-123');
    check('AUTH-04', 'inactive → Invalid username or password', r.status === 401 && has(r.text, 'Invalid username or password'), `${r.status} ${c.alertOf(r.text)?.text}`);
    await c.as('admin');
  });
  await step('AUTH-06', 'logged in GET /login → /', async () => {
    const r = await admin.get('/login');
    check('AUTH-06', 'redirect to Dashboard', r.status === 302 && r.location === '/', `${r.status} ${r.location}`);
  });
  await step('AUTH-07', 'logged out → /login', async () => {
    const s = new c.Session();
    const rs = await Promise.all(['/cases', '/reports', '/cases/2', '/', '/tasks', '/commissions'].map(u => s.get(u)));
    check('AUTH-07', 'all 302 → /login', rs.every(r => r.status === 302 && r.location === '/login'), rs.map(r => `${r.status}→${r.location}`).join(', '));
  });
  await step('AUTH-08', 'logout → /login, audit logout, session gone', async () => {
    const s = await c.as('manager');
    const r = await s.get('/logout');
    const after = await s.get('/');
    const log = q1("SELECT * FROM audit_logs WHERE action='logout' AND username='manager' ORDER BY id DESC LIMIT 1");
    check('AUTH-08', 'logout → /login; audit logout; back+refresh needs login', r.status === 302 && r.location === '/login' && !!log && after.status === 302 && after.location === '/login',
      `${r.status}→${r.location}; audit=${!!log}; reuse cookie → ${after.status} ${after.location}`);
  });
  await step('AUTH-09', '/demo-accounts public, 5 accounts, no link on login', async () => {
    const r = await new c.Session().get('/demo-accounts');
    const login = await new c.Session().get('/login');
    const rows = (r.text.match(/<td class="mono">/g) || []).length / 2;
    check('AUTH-09', 'opens without login, 5 accounts, login page has no link', r.status === 200 && rows === 5 && !has(login.text, 'demo-accounts'), `${r.status} rows=${rows} loginLink=${has(login.text, 'demo-accounts')}`);
  });
  await step('AUTH-10', 'login footer version + /version newest first', async () => {
    const login = await new c.Session().get('/login');
    const v = (login.text.match(/v(\d+\.\d+\.\d+) · <a href="\/version">/) || [])[1];
    const ver = await new c.Session().get('/version');
    const list = [...ver.text.matchAll(/<strong>v(\d+\.\d+\.\d+)<\/strong>/g)].map(m => m[1]);
    // Manual v1.2: footer = the newest /version entry = the version the code ships.
    const want = c.appVersion();
    check('AUTH-10', 'footer shows current version; /version newest first', v === want && list[0] === want,
      `footer v${v}; /version first=${list[0]} (${list.slice(0, 3).join(',')}); src/version.js ${want}`);
  });
  await step('AUTH-11', '/health text ok', async () => {
    const r = await new c.Session().get('/health');
    check('AUTH-11', 'plain text ok', r.status === 200 && r.text === 'ok' && /text\/plain/.test(r.headers.get('content-type')), `${r.status} "${r.text}" ${r.headers.get('content-type')}`);
  });
  await step('AUTH-12', 'agent1 forbidden URLs → 403 Forbidden', async () => {
    const a1 = await c.as('agent1');
    const urls = ['/users', '/settings', '/demo-tools', '/audit-log', '/agents', '/cases/new'];
    const rs = await Promise.all(urls.map(u => a1.get(u)));
    check('AUTH-12', 'all 403 Forbidden page', rs.every(r => r.status === 403 && has(r.text, '<p>Forbidden</p>')), urls.map((u, i) => `${u}:${rs[i].status}`).join(' '));
  });

  // ---------------- NAV ----------------
  await step('NAV-01', 'sidebar per role = §3 table', async () => {
    const expect = {
      admin: ['/debtors', '/cases', '/tasks', '/agents', '/users', '/reports', '/commissions', '/settings', '/demo-tools', '/audit-log', '/search'],
      manager: ['/debtors', '/cases', '/tasks', '/agents', '/reports', '/commissions', '/search'],
      agent1: ['/debtors', '/cases', '/tasks', '/reports', '/commissions', '/search'],
      finance: ['/debtors', '/cases', '/tasks', '/reports', '/commissions', '/search'],
      auditor: ['/debtors', '/cases', '/tasks', '/agents', '/reports', '/commissions', '/audit-log', '/search'],
    };
    const all = ['/debtors', '/cases', '/tasks', '/agents', '/users', '/reports', '/commissions', '/settings', '/demo-tools', '/audit-log', '/search'];
    const bad = [];
    for (const [u, want] of Object.entries(expect)) {
      const s = await c.as(u);
      const html = (await s.get('/')).text;
      const nav = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'));
      const got = all.filter(p => nav.includes(`href="${p}"`));
      if (got.join() !== want.join()) bad.push(`${u}: ${got.join(' ')}`);
      if (!nav.includes('href="/"')) bad.push(`${u}: no Dashboard`);
    }
    check('NAV-01', 'menus match role table', bad.length === 0, bad.join(' | ') || 'all 5 roles match');
  });
  await step('NAV-03', 'current menu highlighted', async () => {
    const pages = ['/debtors', '/cases', '/tasks', '/agents', '/users', '/reports', '/commissions', '/settings', '/demo-tools', '/audit-log', '/search'];
    const bad = [];
    for (const p of pages) {
      const html = (await admin.get(p)).text;
      if (!new RegExp(`href="${p}" class="active"`).test(html)) bad.push(p);
    }
    const dash = (await admin.get('/')).text;
    if (!/href="\/" class="active"/.test(dash)) bad.push('/');
    check('NAV-03', 'active class on current item', bad.length === 0, bad.length ? 'not highlighted: ' + bad.join(' ') : 'all 12 pages highlight their item');
  });
  await step('NAV-05', 'green on success, red on failure', async () => {
    const okr = await admin.act('/cases/1/notes', { content: 'NAV-05 note' });
    const er = await admin.act('/cases/1/notes', { content: '   ' });
    check('NAV-05', 'green + red banners', okr.ok === 'Note added' && /alert is-green/.test(okr.html) && !!er.err && /alert is-red/.test(er.html), `ok="${okr.ok}" err="${er.err}"`);
  });
  await step('NAV-06', 'title "页面名 — Debt Collection CRM"', async () => {
    const pages = ['/', '/debtors', '/debtors/1', '/debtors/new', '/cases', '/cases/1', '/cases/new', '/cases/1/edit', '/cases/1/statement', '/tasks', '/agents', '/agents/1', '/agents/new', '/users', '/users/new', '/reports', '/commissions', '/search', '/audit-log', '/settings', '/demo-tools', '/nope-404'];
    const bad = [];
    const seen = [];
    for (const p of pages) {
      const r = await admin.get(p);
      const t = (r.text.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
      seen.push(`${p}=${t}`);
      if (!/^.+ — Debt Collection CRM$/.test(t.trim())) bad.push(`${p}="${t}"`);
    }
    for (const p of ['/login', '/version', '/demo-accounts']) {
      const t = ((await new c.Session().get(p)).text.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
      if (!/^.+ — Debt Collection CRM$/.test(t.trim())) bad.push(`${p}="${t}"`);
    }
    check('NAV-06', 'all titles follow pattern', bad.length === 0, bad.length ? bad.join(' ; ') : `${pages.length + 3} pages ok, e.g. ${seen[5]}`);
  });

  // ---------------- DASH ----------------
  const D = async (s = admin) => kpi((await s.get('/')).text);
  await step('DASH-01', 'today payment +100, count +1', async () => {
    const b = await D();
    const r = await admin.act('/cases/13/payments', { payment_date: today(), amount: '100', method: 'cash', reference: 'D1', bank: 'MBB' });
    const a = await D();
    check('DASH-01', 'Collected Today +100.00, payments +1', /recorded/.test(r.ok || '') && Math.abs(a.collected - b.collected - 100) < 0.001 && a.payments === b.payments + 1, `${r.ok || r.err}; collected ${b.collected}→${a.collected}; n ${b.payments}→${a.payments}`);
  });
  await step('DASH-02', 'yesterday payment not counted', async () => {
    const b = await D();
    const r = await admin.act('/cases/13/payments', { payment_date: addDays(today(), -1), amount: '50', method: 'cash' });
    const a = await D();
    check('DASH-02', 'Collected Today unchanged', /recorded/.test(r.ok || '') && a.collected === b.collected && a.payments === b.payments, `${r.ok || r.err}; ${b.collected}→${a.collected}`);
  });
  await step('DASH-03', 'active / legal counts', async () => {
    const d = await D();
    const active = q1(`SELECT COUNT(*) n FROM cases WHERE status NOT IN ('legal','closed','cancelled','bankruptcy','deceased','fully_paid')`).n;
    const legal = q1("SELECT COUNT(*) n FROM cases WHERE status='legal'").n;
    check('DASH-03', 'active excl. terminal & Fully Paid; legal count', d.active === active && d.legal === legal, `dash active=${d.active} legal=${d.legal}; db ${active}/${legal}`);
  });
  await step('DASH-04', 'PTP due/broken/overdue', async () => {
    const b = await D();
    const r1 = await admin.act('/cases/19/ptps', { amount: '100', due_date: today(), remark: 'DASH-04' });
    const p = q1("SELECT id FROM ptps WHERE case_id=4 AND status='pending'");
    const r2 = await admin.act(`/ptps/${p.id}/break`);
    const a = await D();
    const od = q1(`SELECT COUNT(*) n FROM ptps WHERE status='pending' AND due_date < ?`, today()).n;
    check('DASH-04', 'due +1, broken +1, overdue = past-due pending', r1.ok === 'PTP created' && r2.ok === 'PTP broken' && a.due === b.due + 1 && a.broken === b.broken + 1 && a.overdue === od,
      `${r1.ok}/${r2.ok}; due ${b.due}→${a.due}; broken ${b.broken}→${a.broken}; overdue ${a.overdue} (db ${od})`);
  });
  // v1.12.0 (G-24 / N-07): totals are today's settlement amounts; the contract balance is shown beside them.
  await step('DASH-05', 'Total Outstanding = Reports − Closed − Cancelled; special = Legal+Bankruptcy+Deceased', async () => {
    const d = await D();
    const rep = strip((await admin.get('/reports')).text);
    const rowOf = (lbl) => { const m = rep.match(new RegExp(lbl + ' (\\d+) ([\\d,.]+) ([\\d,.]+)')); return m ? Number(m[2].replace(/,/g, '')) : 0; };
    const repTotal = Number(((rep.match(/Total (\d+) ([\d,.]+) ([\d,.]+)/) || [])[2] || 'NaN').replace(/,/g, ''));
    const exp = repTotal - rowOf('Closed') - rowOf('Cancelled');
    const sp = rowOf('Legal') + rowOf('Bankruptcy') + rowOf('Deceased');
    const dbContract = q1("SELECT COALESCE(SUM(outstanding_amount),0) s FROM cases WHERE status NOT IN ('closed','cancelled')").s;
    check('DASH-05', 'matches Reports minus closed/cancelled (settlement today); contract balance = DB', Math.abs(d.outstanding - exp) < 0.01 && Math.abs(d.special - sp) < 0.01 && Math.abs(d.contract - dbContract) < 0.01,
      `dash ${d.outstanding} vs report ${exp.toFixed(2)}; special ${d.special} vs ${sp.toFixed(2)}; contract ${d.contract} vs db ${dbContract.toFixed(2)}`);
  });
  await step('DASH-06', 'opened +1, closed +1 (manual + auto payoff)', async () => {
    const b = await D();
    const deb = await c.newDebtor(admin, 'QA Dash06');
    await c.newCase(admin, { debtor_id: deb, principal_amount: '500', interest_mode: 'fixed', interest_amount: '0' });
    const r1 = await admin.act('/cases/19/status', { status: 'closed' });
    const m = await D();
    // auto payoff: case 12 (fixed, new) paid in full
    const due12 = q1('SELECT outstanding_amount o FROM cases WHERE id=12').o;
    const r2 = await admin.act('/cases/12/payments', { payment_date: today(), amount: String(due12), method: 'cash' });
    const a = await D();
    const st12 = q1('SELECT status, closed_at FROM cases WHERE id=12');
    check('DASH-06', 'opened +1, manual Closed +1, auto Fully Paid +1', m.opened === b.opened + 1 && m.closed === b.closed + 1 && a.closed === m.closed + 1 && st12.status === 'fully_paid' && !!st12.closed_at,
      `opened ${b.opened}→${m.opened}; closed ${b.closed}→${m.closed}→${a.closed}; ${r1.ok}; ${r2.ok || r2.err}; c12=${st12.status}/${st12.closed_at}`);
  });
  await step('DASH-07', 'overdue tasks +1; upcoming 14d incl. overdue, open cases only', async () => {
    const b = await D();
    await admin.act('/tasks/new', { case_id: '13', type: 'follow_up', title: 'DASH-07 yesterday', due_date: addDays(today(), -1) });
    await admin.act('/tasks/new', { case_id: '13', type: 'follow_up', title: 'DASH-07 in10', due_date: addDays(today(), 10) });
    await admin.act('/tasks/new', { case_id: '17', type: 'legal', title: 'DASH-07 terminal case', due_date: addDays(today(), 2) });
    const a = await D();
    check('DASH-07', 'overdue +1, upcoming +2 (terminal-case task excluded)', a.overdueTasks === b.overdueTasks + 1 && a.upcoming === b.upcoming + 2,
      `overdue ${b.overdueTasks}→${a.overdueTasks}; upcoming ${b.upcoming}→${a.upcoming}`);
  });
  await step('DASH-08', 'Aging (DPD) + Case Age: open balances only, max bar full', async () => {
    const html = (await admin.get('/')).text;
    const d = kpi(html);
    // v1.12.0 (G-24): the buckets hold settlement amounts of the cases still being worked.
    const open = c.sumOf((await c.caseFigures(admin)).filter(r => r.contract > 0 && !['Legal', 'Closed', 'Cancelled', 'Bankruptcy', 'Deceased'].includes(r.status)));
    const sumD = d.dpd.reduce((a, b) => a + b, 0), sumA = d.age.reduce((a, b) => a + b, 0);
    const widths = [...html.matchAll(/class="tr"><i style="width:(\d+)%/g)].map(m => Number(m[1]));
    const dpdW = widths.slice(0, 6), ageW = widths.slice(6, 10);
    check('DASH-08', 'both sections sum to open balance; largest bar 100%', Math.abs(sumD - open) < 0.02 && Math.abs(sumA - open) < 0.02 && Math.max(...dpdW) === 100 && Math.max(...ageW) === 100,
      `dpd=${d.dpd.join('/')} age=${d.age.join('/')} open=${open.toFixed(2)} widths=${dpdW.join(',')}|${ageW.join(',')}`);
  });
  await step('DASH-09', '≤10 rows, by due date, badges', async () => {
    for (let i = 0; i < 9; i++) await admin.act('/tasks/new', { case_id: '13', type: 'reminder', title: `DASH-09 #${i}`, due_date: addDays(today(), i % 3) });
    const html = (await admin.get('/')).text;
    const sec = html.slice(html.indexOf('Upcoming Follow-ups'), html.indexOf('Agent Leaderboard'));
    const rows = [...sec.matchAll(/<tr><td><a href="\/cases\/(\d+)">[^<]+<\/a><\/td>[\s\S]*?<span class="badge (is-\w+)">([^<]+)<\/span>/g)].map(m => ({ cls: m[2], label: m[3] }));
    const order = rows.map(r => (/late/.test(r.label) ? -Number(r.label.match(/\d+/)[0]) : r.label === 'Today' ? 0 : Number(r.label.match(/\d+/)[0])));
    const sorted = order.every((v, i) => i === 0 || order[i - 1] <= v);
    const badgesOk = rows.every(r => (/late/.test(r.label) ? r.cls === 'is-red' : r.label === 'Today' ? r.cls === 'is-gold' : r.cls === 'is-neutral'));
    check('DASH-09', '≤10, sorted, badge colours', rows.length === 10 && sorted && badgesOk, `rows=${rows.length} labels=${rows.map(r => r.label).join(',')}`);
  });
  await step('DASH-10', 'leaderboard: admin/manager/finance/auditor yes, agent no', async () => {
    const vis = {};
    for (const u of ['admin', 'manager', 'finance', 'auditor', 'agent1']) vis[u] = kpi((await (await c.as(u)).get('/')).text).leaderboard;
    const html = (await admin.get('/')).text;
    const lb = [...html.slice(html.indexOf('Agent Leaderboard')).matchAll(/<div class="row"><span>([^<]+)<\/span><span class="num">RM ([\d,.]+)/g)].map(m => Number(m[2].replace(/,/g, '')));
    const sorted = lb.every((v, i) => i === 0 || lb[i - 1] >= v);
    check('DASH-10', 'visibility + top 5 by collected', vis.admin && vis.manager && vis.finance && vis.auditor && !vis.agent1 && lb.length <= 5 && sorted, `${JSON.stringify(vis)} lb=${lb.join(',')}`);
  });
  await step('DASH-11', 'newest activity on top, ≤12, links', async () => {
    await admin.act('/cases/13/calls', { result: 'answered', duration_seconds: '30', notes: 'DASH-11 call' });
    const html = (await admin.get('/')).text;
    const feed = html.slice(html.indexOf('<ul class="feed">'), html.indexOf('</ul>', html.indexOf('<ul class="feed">')));
    const items = feed.split('<li>').length - 1;
    const first = strip(feed.split('<li>')[1] || '');
    check('DASH-11', 'call on top, ≤12 items, case link', items <= 12 && /DASH-11 call/.test(first) && /href="\/cases\/13"/.test(feed.split('<li>')[1] || ''), `items=${items} first="${first.slice(0, 90)}"`);
  });
  await step('DASH-12', 'agent1 dashboard scoped', async () => {
    const a1 = await c.as('agent1');
    const html = (await a1.get('/')).text;
    const d = kpi(html);
    const W = 'agent_id = 1';
    const out = c.sumOf((await c.caseFigures(a1)).filter(r => !['Closed', 'Cancelled'].includes(r.status))); // v1.12.0: settlement today (G-24)
    const active = q1(`SELECT COUNT(*) n FROM cases WHERE ${W} AND status NOT IN ('legal','closed','cancelled','bankruptcy','deceased','fully_paid')`).n;
    const coll = q1(`SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN cases c ON c.id=p.case_id WHERE c.agent_id=1 AND date(p.payment_date)=?`, today()).s;
    const recentCases = [...html.slice(html.indexOf('<ul class="feed">')).matchAll(/href="\/cases\/(\d+)"/g)].map(m => Number(m[1]));
    const followCases = [...html.slice(html.indexOf('Upcoming Follow-ups'), html.indexOf('Recent Activity')).matchAll(/href="\/cases\/(\d+)"/g)].map(m => Number(m[1]));
    const mine = new Set(qa('SELECT id FROM cases WHERE agent_id=1').map(r => r.id));
    const foreign = [...recentCases, ...followCases].filter(id => !mine.has(id));
    check('DASH-12', 'all figures/lists only agent1 cases', Math.abs(d.outstanding - out) < 0.01 && d.active === active && Math.abs(d.collected - coll) < 0.01 && foreign.length === 0 && !d.leaderboard,
      `out ${d.outstanding}/${out}; active ${d.active}/${active}; collected ${d.collected}/${coll}; foreign links=${foreign.join(',') || 'none'}`);
  });

  // ---------------- DEB ----------------
  await step('DEB-01', 'risk filter + search name/IC/phone; sorted by name', async () => {
    const names = (h) => [...h.matchAll(/<tr><td><a href="\/debtors\/\d+">([^<]+)<\/a>/g)].map(m => m[1]);
    const high = names((await admin.get('/debtors?risk=high')).text);
    const highDb = qa("SELECT name FROM debtors WHERE risk_level='high' ORDER BY name").map(r => r.name);
    const byName = names((await admin.get('/debtors?q=' + encodeURIComponent('Ravi'))).text);
    const byIc = names((await admin.get('/debtors?q=' + q1('SELECT ic_passport FROM debtors WHERE id=3').ic_passport.slice(0, 6))).text); // G-10: demo ICs use the 00 month
    const byPhone = names((await admin.get('/debtors?q=016-3334')).text);
    const all = names((await admin.get('/debtors')).text);
    const sortedOk = all.join('|') === qa('SELECT name FROM debtors ORDER BY name').map(r => r.name).join('|');
    check('DEB-01', 'filters correct, sorted', high.join('|') === highDb.join('|') && byName.join() === 'Ravi Chandran' && byIc.join() === 'Ravi Chandran' && byPhone.join() === 'Ravi Chandran' && sortedOk,
      `high=${high.length}/${highDb.length}; name=${byName}; ic=${byIc}; phone=${byPhone}; sorted=${sortedOk}`);
  });
  await step('DEB-02', 'spaces-only name → Name is required (server)', async () => {
    const r = await admin.act('/debtors', { name: '   ', risk_level: 'medium' });
    check('DEB-02', 'server says "Name is required"', r.err === 'Name is required', `err="${r.err}" (browser-side required: see ui.qa.py)`);
  });
  let debId;
  await step('DEB-03', 'create with guarantor → "Debtor created", audit', async () => {
    const r = await admin.act('/debtors', { name: 'QA Deb03', ic_passport: '000000-00-0003', phone: '011-0000003', email: 'q@x.my', address: 'Addr', employer: 'Emp', salary: '3000', risk_level: 'low', guarantor_name: 'G Name', guarantor_phone: '011-9', remark: 'r' });
    debId = q1("SELECT id FROM debtors WHERE name='QA Deb03'")?.id;
    const log = q1("SELECT * FROM audit_logs WHERE action='create' AND entity_type='debtor' AND entity_id=?", debId);
    check('DEB-03', 'back to list + banner + audit create debtor', r.location === '/debtors' && r.ok === 'Debtor created' && !!log && q1('SELECT guarantor_name g FROM debtors WHERE id=?', debId).g === 'G Name', `${r.location} "${r.ok}" audit=${!!log}`);
  });
  await step('DEB-04', 'edit phone+risk → Saved; audit update', async () => {
    const r = await admin.act(`/debtors/${debId}`, { name: 'QA Deb03', phone: '011-7777777', risk_level: 'high' });
    const d = q1('SELECT phone, risk_level FROM debtors WHERE id=?', debId);
    const log = q1("SELECT * FROM audit_logs WHERE action='update' AND entity_type='debtor' AND entity_id=?", debId);
    check('DEB-04', 'Saved; new values; audit', r.ok === 'Saved' && d.phone === '011-7777777' && d.risk_level === 'high' && has(r.html, '011-7777777') && !!log, `"${r.ok}" ${d.phone}/${d.risk_level} audit=${!!log}`);
  });
  await step('DEB-05', 'debtor detail lists cases', async () => {
    const html = (await admin.get('/debtors/1')).text;
    const ids = [...html.matchAll(/href="\/cases\/(\d+)" class="mono">/g)].map(m => Number(m[1])).sort((a, b) => a - b);
    const db = qa('SELECT id FROM cases WHERE debtor_id=1 ORDER BY id').map(r => r.id);
    check('DEB-05', 'cases with no/settlement today/status, clickable', ids.join() === db.join() && /Settlement Today/.test(html), `page=${ids} db=${db}`); // v1.12.0: amount column is Settlement Today (N-07)
  });
  await step('DEB-06', 'agent1 sees only own debtors; foreign → 403', async () => {
    const a1 = await c.as('agent1');
    const ids = [...(await a1.get('/debtors')).text.matchAll(/href="\/debtors\/(\d+)"/g)].map(m => Number(m[1])).sort((a, b) => a - b);
    const mine = qa('SELECT DISTINCT debtor_id d FROM cases WHERE agent_id=1 ORDER BY d').map(r => r.d);
    const f = await a1.get('/debtors/2');
    const fe = await a1.get('/debtors/2/edit');
    const fp = await a1.post('/debtors/2', { name: 'hacked' });
    check('DEB-06', 'list scoped; GET/edit/POST foreign → 403', ids.join() === mine.join() && f.status === 403 && fe.status === 403 && fp.status === 403 && q1('SELECT name FROM debtors WHERE id=2').name !== 'hacked',
      `list=${ids} mine=${mine}; show=${f.status} edit=${fe.status} post=${fp.status}`);
  });
  await step('DEB-07', 'finance/auditor view, no New/Edit', async () => {
    const out = [];
    for (const u of ['finance', 'auditor']) {
      const s = await c.as(u);
      const l = await s.get('/debtors'); const d = await s.get('/debtors/1');
      out.push({ u, list: l.status, show: d.status, newBtn: has(l.text, '+ New Debtor'), edit: has(d.text, '/debtors/1/edit'), post: (await s.post('/debtors/1', { name: 'x' })).status });
    }
    check('DEB-07', 'can view; no buttons; POST 403', out.every(o => o.list === 200 && o.show === 200 && !o.newBtn && !o.edit && o.post === 403), JSON.stringify(out));
  });
  await step('DEB-08', 'agent cannot create debtor', async () => {
    const a1 = await c.as('agent1');
    const l = await a1.get('/debtors');
    const n = await a1.get('/debtors/new');
    const p = await a1.post('/debtors', { name: 'QA agent debtor' });
    check('DEB-08', 'no button; /debtors/new 403; POST 403', !has(l.text, '+ New Debtor') && n.status === 403 && p.status === 403 && !q1("SELECT 1 x FROM debtors WHERE name='QA agent debtor'"), `btn=${has(l.text, '+ New Debtor')} new=${n.status} post=${p.status}`);
  });
  await step('DEB-09', '<b>测试</b> shown as text', async () => {
    const r = await admin.act('/debtors', { name: '<b>测试</b>', risk_level: 'medium' });
    const id = q1("SELECT id FROM debtors WHERE name='<b>测试</b>'").id;
    const html = (await admin.get(`/debtors/${id}`)).text;
    const list = (await admin.get('/debtors')).text;
    check('DEB-09', 'escaped everywhere', r.ok === 'Debtor created' && has(html, '&lt;b&gt;测试&lt;/b&gt;') && !has(html, '<b>测试</b>') && !has(list, '<b>测试</b>'), `detail escaped=${has(html, '&lt;b&gt;测试&lt;/b&gt;')}`);
  });

  const res = finish('a-auth-nav-dash-deb');
  assert.ok(true, res.length);
});
