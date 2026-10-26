// Manual v1.1 §4.11 TASK … §4.19 DEMO — HTTP level.
const { test } = require('node:test');
const c = require('./_client');
const { reseed, step, finish, assert } = require('./_run');
const { check, rec, has, strip, today, addDays, q1, qa, num } = c;

const taskRows = (h) => [...h.matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td><span class="badge [^"]*">([^<]*)<\/span><\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g)]
  .map(m => ({ title: m[1], case: strip(m[2]).trim(), agent: m[3], type: m[4], due: strip(m[5]).trim(), status: m[6], actions: m[7] }));

test('r2 D: TASK / AGT / USR / RPT / COM / SRCH / AUD / SET / DEMO', { timeout: 300000 }, async () => {
  reseed();
  const admin = await c.as('admin');
  const man = await c.as('manager');
  const fin = await c.as('finance');
  const aud = await c.as('auditor');
  const a1 = await c.as('agent1');

  // ---------------- TASK ----------------
  await step('TASK-02', 'case task: agent from case, 3 types, Task created; visit refused', async () => {
    const page = (await admin.get('/tasks')).text;
    const form = page.slice(page.indexOf('action="/tasks/new"'), page.indexOf('</form>', page.indexOf('action="/tasks/new"')));
    const types = [...form.slice(form.indexOf('name="type"')).matchAll(/<option value="(\w+)">/g)].map(m => m[1]).slice(0, 3);
    const r = await admin.act('/tasks/new', { case_id: '2', agent_id: '3', type: 'follow_up', title: 'TASK-02 t', due_date: addDays(today(), 3) });
    const t = q1("SELECT * FROM tasks WHERE title='TASK-02 t'");
    const v = await admin.act('/tasks/new', { case_id: '2', type: 'visit', title: 'TASK-02 visit' });
    const lock = has(page, 'agentSel.disabled = !!agentId');
    check('TASK-02', 'agent = case agent (2) even if 3 posted; types follow_up/legal/reminder; visit → Invalid task type', r.ok === 'Task created' && t.agent_id === 2 && types.join() === 'follow_up,legal,reminder' && !form.includes('visit') && v.err === 'Invalid task type' && lock,
      `${r.ok}; agent=${t.agent_id}; types=${types}; visit=${v.err}`);
  });
  await step('TASK-03', 'case-less: admin pick / agent self', async () => {
    await admin.act('/tasks/new', { case_id: '', agent_id: '3', type: 'reminder', title: 'TASK-03 admin' });
    await a1.act('/tasks/new', { case_id: '', agent_id: '3', type: 'reminder', title: 'TASK-03 agent' });
    const x = q1("SELECT agent_id FROM tasks WHERE title='TASK-03 admin'").agent_id, y = q1("SELECT agent_id FROM tasks WHERE title='TASK-03 agent'").agent_id;
    check('TASK-03', 'admin → chosen 3; agent1 → own 1', x === 3 && y === 1, `admin task agent=${x}; agent1 task agent=${y}`);
  });
  await step('TASK-04', 'blank title (server side)', async () => {
    const r = await admin.act('/tasks/new', { case_id: '2', type: 'follow_up', title: '  ' });
    const h = (await admin.get('/tasks')).text;
    check('TASK-04', 'input required; server "Title is required"', r.err === 'Title is required' && has(h, 'name="title" required'), r.err, '浏览器拦截见 ui.qa.py');
  });
  await step('TASK-05', 'edit → Task updated', async () => {
    const t = q1("SELECT id FROM tasks WHERE title='TASK-02 t'");
    const r = await admin.act(`/tasks/${t.id}`, { title: 'TASK-05 edited', type: 'legal', due_date: addDays(today(), 5), notes: 'n5' });
    const row = q1('SELECT * FROM tasks WHERE id=?', t.id);
    check('TASK-05', 'Task updated; values saved', r.ok === 'Task updated' && row.title === 'TASK-05 edited' && row.type === 'legal' && row.notes === 'n5', `${r.ok}; ${row.title}/${row.type}`);
  });
  await step('TASK-06', 'complete', async () => {
    const t = q1("SELECT id FROM tasks WHERE title='TASK-05 edited'");
    const r = await admin.act(`/tasks/${t.id}/complete`);
    const row = taskRows(r.html).find(x => x.title === 'TASK-05 edited');
    check('TASK-06', 'Task completed; done; no Complete button', r.ok === 'Task completed' && row.status === 'done' && !/\/complete"/.test(row.actions), `${r.ok}; ${row.status}`);
  });
  await step('TASK-01', 'filters; Today = today only; overdue red', async () => {
    await admin.act('/tasks/new', { case_id: '2', type: 'follow_up', title: 'T01 today', due_date: today() });
    await admin.act('/tasks/new', { case_id: '2', type: 'follow_up', title: 'T01 tomorrow', due_date: addDays(today(), 1) });
    await admin.act('/tasks/new', { case_id: '2', type: 'reminder', title: 'T01 d10', due_date: addDays(today(), 10) });
    await admin.act('/tasks/new', { case_id: '2', type: 'legal', title: 'T01 d20', due_date: addDays(today(), 20) });
    const g = async (q) => taskRows((await admin.get('/tasks?' + q)).text);
    const pend = await g('status=pending'), done = await g('status=done'), legal = await g('type=legal'), od = await g('overdue=1');
    const w1 = await g('window=1'), w7 = await g('window=7'), w14 = await g('window=14'), w30 = await g('window=30');
    const dueOf = t => q1('SELECT due_date FROM tasks WHERE title=? ORDER BY id DESC', t.title).due_date;
    const okWin = (rows, n) => rows.every(t => dueOf(t) && dueOf(t) <= addDays(today(), n));
    const overdueRow = od.find(x => /overdue/.test(x.due));
    const html = (await admin.get('/tasks?overdue=1')).text;
    check('TASK-01', 'status/type/overdue/windows', pend.every(x => x.status === 'pending') && done.every(x => x.status === 'done') && done.length > 0 && legal.every(x => x.type === 'legal')
      && od.length > 0 && od.every(x => x.status === 'pending' && dueOf(x) < today()) && w1.length > 0 && w1.every(x => dueOf(x) === today()) && okWin(w7, 7) && okWin(w14, 14) && okWin(w30, 30) && w30.some(x => x.title === 'T01 d20') && !w14.some(x => x.title === 'T01 d20')
      && !!overdueRow && /badge is-red">[^<]+ · overdue/.test(html),
    `pending=${pend.length} done=${done.length} legal=${legal.length} overdue=${od.map(x => x.title)} today=${w1.map(x => x.title)} 7d=${w7.length} 14d=${w14.length} 30d=${w30.length}`);
  });
  await step('TASK-07', 'agent1 scope + foreign actions Forbidden', async () => {
    const rows = taskRows((await a1.get('/tasks')).text);
    const mineOnly = rows.every(x => x.agent === 'Lim Wei Sheng');
    const foreign = q1('SELECT id FROM tasks WHERE agent_id=3 AND status=\'pending\'');
    const e1 = (await a1.act(`/tasks/${foreign.id}/complete`)).err;
    const e2 = (await a1.act(`/tasks/${foreign.id}`, { title: 'hacked', type: 'follow_up' })).err;
    check('TASK-07', 'only own; "Forbidden" both; unchanged', mineOnly && rows.length === q1('SELECT COUNT(*) n FROM tasks WHERE agent_id=1').n && e1 === 'Forbidden' && e2 === 'Forbidden' && q1('SELECT status, title FROM tasks WHERE id=?', foreign.id).status === 'pending',
      `rows=${rows.length}; ${e1}/${e2}`);
  });
  await step('TASK-08', 'agent1 foreign case_id', async () => {
    const r = await a1.act('/tasks/new', { case_id: '2', type: 'follow_up', title: 'TASK-08' });
    check('TASK-08', '"Invalid case"', r.err === 'Invalid case' && !q1("SELECT 1 x FROM tasks WHERE title='TASK-08'"), r.err);
  });
  await step('TASK-09', 'finance/auditor: no New, Actions "—", POST 403', async () => {
    const out = [];
    for (const [u, s] of [['finance', fin], ['auditor', aud]]) {
      const h = (await s.get('/tasks')).text; const rows = taskRows(h);
      out.push({ u, newBtn: has(h, '+ New Task'), dash: rows.every(r => r.actions.trim() === '—'), post: (await s.post('/tasks/new', { title: 'x' })).status, comp: (await s.post('/tasks/1/complete')).status });
    }
    check('TASK-09', 'read-only', out.every(o => !o.newBtn && o.dash && o.post === 403 && o.comp === 403), JSON.stringify(out));
  });
  await step('TASK-10', 'task in 3 days → dashboard "in 3d"', async () => {
    await admin.act('/tasks/new', { case_id: '20', type: 'follow_up', title: 'TASK-10 three', due_date: addDays(today(), 3) });
    const t = strip((await admin.get('/')).text);
    check('TASK-10', 'Upcoming Follow-ups shows "in 3d TASK-10 three"', /in 3d TASK-10 three/.test(t), (t.match(/[^ ]+ [^ ]+ TASK-10 three/) || ['missing'])[0]);
  });
  await step('TASK-11', 'reassign moves open tasks only; audit', async () => {
    await man.act('/tasks/new', { case_id: '19', type: 'follow_up', title: 'T11 open', due_date: addDays(today(), 2) });
    await man.act('/tasks/new', { case_id: '19', type: 'follow_up', title: 'T11 done', due_date: addDays(today(), 2) });
    const done = q1("SELECT id FROM tasks WHERE title='T11 done'").id;
    await man.act(`/tasks/${done}/complete`);
    const cs = q1('SELECT * FROM cases WHERE id=19');
    const r = await man.act('/cases/19', { debtor_id: String(cs.debtor_id), agent_id: '1', principal_amount: String(cs.principal_amount), interest_mode: cs.interest_mode, interest_amount: String(cs.interest_amount), priority: cs.priority });
    const t = qa("SELECT title, agent_id FROM tasks WHERE case_id=19 ORDER BY id");
    const log = q1("SELECT details FROM audit_logs WHERE action='update' AND entity_type='case' AND entity_id=19 ORDER BY id DESC");
    check('TASK-11', 'open → agent 1; done stays 3; "N open task(s) reassigned"', r.ok === 'Saved' && t.find(x => x.title === 'T11 open').agent_id === 1 && t.find(x => x.title === 'T11 done').agent_id === 3 && /\d+ open task\(s\) reassigned/.test(log.details), `${JSON.stringify(t)}; "${log.details}"`);
  });

  // ---------------- AGT ----------------
  await step('AGT-01', 'sorted by collected; commission; attainment colours', async () => {
    const h = (await man.get('/agents')).text;
    const rows = [...h.matchAll(/<tr><td><a href="\/agents\/(\d+)">([^<]+)<\/a><\/td><td>[^<]*<\/td>\s*<td class="num">(\d+)<\/td><td class="num">([\d,.]+)<\/td>\s*<td class="num">([\d.]+)<\/td><td class="num">([\d,.]+)<\/td>[\s\S]*?<div class="fill ([^"]*)" style="width: (\d+)%"><\/div><\/div> (\d+)%/g)]
      .map(m => ({ id: +m[1], collected: num(m[4]), rate: +m[5], comm: num(m[6]), cls: m[7], pct: +m[9] }));
    const dbColl = Object.fromEntries(qa('SELECT a.id, COALESCE((SELECT SUM(amount) FROM payments p WHERE p.agent_id=a.id),0) s FROM agents a').map(r => [r.id, r.s]));
    const ok = rows.length > 0 && rows.every((r, i) => (i === 0 || rows[i - 1].collected >= r.collected) && Math.abs(r.collected - dbColl[r.id]) < 0.01 && Math.abs(r.comm - Math.round(r.collected * r.rate) / 100) < 0.011
      && (r.pct >= 100 ? r.cls === 'is-green' : r.pct < 50 ? r.cls === 'is-red' : r.cls === ''));
    check('AGT-01', 'by payments.agent_id; desc; commission; colours', ok, rows.map(r => `${r.id}:${r.collected}×${r.rate}%=${r.comm} ${r.pct}%${r.cls}`).join(' | '));
  });
  await step('AGT-02', 'department / status filter', async () => {
    const ids = async (q) => [...(await man.get('/agents?' + q)).text.matchAll(/<tr><td><a href="\/agents\/(\d+)">/g)].map(m => +m[1]).sort();
    const dep = await ids('department=Consumer'), act = await ids('status=active'), ina = await ids('status=inactive');
    check('AGT-02', 'filters', dep.join() === qa("SELECT id FROM agents WHERE department='Consumer' ORDER BY id").map(r => r.id).join() && act.length === q1('SELECT COUNT(*) n FROM agents WHERE active=1').n && ina.length === q1('SELECT COUNT(*) n FROM agents WHERE active=0').n, `Consumer=${dep} active=${act} inactive=${ina}`);
  });
  let newAgent;
  await step('AGT-03', 'name required; defaults 5 / Active; Agent created', async () => {
    const e = await man.act('/agents', { name: ' ', commission_rate: '', target_amount: '' });
    const r = await man.act('/agents', { name: 'QA 新人', contact: '011', department: 'QA', commission_rate: '', target_amount: '' });
    newAgent = q1("SELECT * FROM agents WHERE name='QA 新人'");
    const form = (await man.get('/agents/new')).text;
    check('AGT-03', 'Name is required; Agent created; rate 5; active', e.err === 'Name is required' && r.ok === 'Agent created' && newAgent.commission_rate === 5 && newAgent.active === 1, `${e.err}; ${r.ok}; rate=${newAgent.commission_rate} active=${newAgent.active}; form default rate shown=${/name="commission_rate"[^>]*value="5"/.test(form)}`);
  });
  await step('AGT-04', 'inactive agent hidden from dropdowns', async () => {
    const tmp = (await man.act('/agents', { name: 'QA Inactive Agent', commission_rate: '5' })) && q1("SELECT id FROM agents WHERE name='QA Inactive Agent'").id;
    const r = await man.act(`/agents/${tmp}`, { name: 'QA Inactive Agent', commission_rate: '5', target_amount: '0', active: '0' });
    const show = strip(r.html);
    const caseForm = (await man.get('/cases/new')).text, editForm = (await man.get('/cases/2/edit')).text, userForm = (await admin.get('/users/new')).text;
    check('AGT-04', 'Active No; not in case/edit/user dropdowns', /Active No/.test(show) && !has(caseForm, 'QA Inactive Agent') && !has(editForm, 'QA Inactive Agent') && !has(userForm, 'QA Inactive Agent'), `${r.ok}; activeNo=${/Active No/.test(show)}`);
  });
  await step('AGT-05', 'agent detail', async () => {
    const t = strip((await man.get('/agents/1')).text);
    check('AGT-05', 'contact, department, target, collected, cases, rate, attainment + bar, cases list', /Contact 012-3456789/.test(t) && /Department Consumer/.test(t) && /Target 500,000\.00/.test(t) && /Collected [\d,.]+/.test(t) && /Case Count \d+/.test(t) && /Commission 5%/.test(t) && /Target Attainment: \d+%/.test(t) && /Assigned Cases/.test(t), t.slice(t.indexOf('Contact'), t.indexOf('Contact') + 200));
  });
  await step('AGT-06', 'auditor read-only; agent1/finance 403', async () => {
    const l = (await aud.get('/agents')).text, d = (await aud.get('/agents/1')).text;
    const s = [(await a1.get('/agents')).status, (await fin.get('/agents')).status, (await aud.get('/agents/new')).status, (await aud.post('/agents', { name: 'x' })).status, (await a1.get('/agents/1')).status];
    check('AGT-06', 'auditor sees, no New/Edit; others 403', !has(l, '+ New Agent') && !has(d, '/agents/1/edit') && s.every(x => x === 403), s.join(','));
  });

  // ---------------- USR ----------------
  await step('USR-01', 'create user; can log in', async () => {
    const r = await admin.act('/users', { username: 'qa_fin2', full_name: 'QA Finance 2', password: 'Passw0rd!', role: 'finance' });
    const s = new c.Session(); const l = await s.login('qa_fin2', 'Passw0rd!');
    check('USR-01', '"User qa_fin2 created"; login ok', r.ok === 'User qa_fin2 created' && l.status === 302 && l.location === '/', `${r.ok}; login ${l.status}`);
  });
  await step('USR-02', 'required fields', async () => {
    const e = [];
    for (const f of [{ username: '' }, { full_name: '' }, { password: '' }, { role: '' }]) e.push((await admin.act('/users', { username: 'u2', full_name: 'F', password: 'Passw0rd!', role: 'finance', ...f })).err);
    check('USR-02', '"Username, full name, password and role are required"', e.every(x => x === 'Username, full name, password and role are required'), e.join(' | '));
  });
  await step('USR-03', 'role options', async () => {
    const h = (await admin.get('/users/new')).text;
    const sel = h.slice(h.indexOf('name="role"'), h.indexOf('</select>', h.indexOf('name="role"')));
    const roles = [...sel.matchAll(/<option value="(\w+)"/g)].map(m => m[1]);
    const r = await admin.act('/users', { username: 'qa_client', full_name: 'C', password: 'Passw0rd!', role: 'client' });
    check('USR-03', 'admin, manager, agent, finance, auditor; client refused', roles.join() === 'admin,manager,agent,finance,auditor' && !!r.err, `${roles}; client → ${r.err}`);
  });
  await step('USR-04', 'agent role must link', async () => {
    const h = (await admin.get('/users/new')).text;
    const e = (await admin.act('/users', { username: 'qa_ag', full_name: 'QA Ag', password: 'Passw0rd!', role: 'agent', agent_id: '' })).err;
    check('USR-04', 'Linked Agent field; "Agent accounts must be linked to an agent"', /Linked Agent/.test(h) && e === 'Agent accounts must be linked to an agent', e);
  });
  await step('USR-05', 'duplicate username', async () => {
    const e = (await admin.act('/users', { username: 'manager', full_name: 'Dup', password: 'Passw0rd!', role: 'finance' })).err;
    check('USR-05', '"Could not create user (username may already exist)"', e === 'Could not create user (username may already exist)', e);
  });
  await step('USR-06', 'edit → User updated', async () => {
    const u = q1("SELECT id FROM users WHERE username='qa_fin2'");
    const r = await admin.act(`/users/${u.id}`, { username: 'qa_fin2', full_name: 'QA Finance Two', role: 'agent', agent_id: String(newAgent.id), active: '1' });
    const row = q1('SELECT * FROM users WHERE id=?', u.id);
    check('USR-06', 'User updated', r.ok === 'User updated' && row.full_name === 'QA Finance Two' && row.role === 'agent' && row.agent_id === newAgent.id, `${r.ok}; ${row.role}/${row.agent_id}`);
    await admin.act(`/users/${u.id}`, { username: 'qa_fin2', full_name: 'QA Finance Two', role: 'finance', active: '1' });
  });
  await step('USR-07', 'admin cannot demote/deactivate self', async () => {
    const me = q1("SELECT id FROM users WHERE username='admin'").id;
    const e1 = (await admin.act(`/users/${me}`, { username: 'admin', full_name: 'System Admin', role: 'manager', active: '1' })).err;
    const e2 = (await admin.act(`/users/${me}`, { username: 'admin', full_name: 'System Admin', role: 'admin', active: '0' })).err;
    const e3 = (await admin.act(`/users/${me}/toggle`)).err;
    check('USR-07', 'two messages; toggle also refused', e1 === 'You cannot change your own admin role' && e2 === 'You cannot deactivate your own account' && e3 === 'You cannot deactivate your own account' && q1('SELECT role, active FROM users WHERE id=?', me).active === 1, `${e1} | ${e2} | toggle: ${e3}`);
  });
  await step('USR-08', 'reset password 7 / 8+', async () => {
    const u = q1("SELECT id FROM users WHERE username='qa_fin2'");
    const h = (await admin.get(`/users/${u.id}/password`)).text;
    const e = (await admin.act(`/users/${u.id}/password`, { password: '1234567' })).err;
    const r = await admin.act(`/users/${u.id}/password`, { password: 'NewPass88' });
    const l = await new c.Session().login('qa_fin2', 'NewPass88');
    check('USR-08', 'min 8 (minlength attr + server); "Password updated for qa_fin2"; new works', e === 'Password must be at least 8 characters' && r.ok === 'Password updated for qa_fin2' && l.status === 302 && /minlength="8"/.test(h), `${e}; ${r.ok}; login=${l.status}; minlength=${/minlength="8"/.test(h)}`);
  });
  await step('USR-09', 'deactivate → disabled, sorted last, cannot log in', async () => {
    const u = q1("SELECT id FROM users WHERE username='qa_fin2'");
    const r = await admin.act(`/users/${u.id}/toggle`);
    const names = [...r.html.matchAll(/<td class="mono">([^<]+)<\/td>[\s\S]*?badge is-(green|neutral)">(active|disabled)/g)].map(m => [m[1], m[3]]);
    const lastActive = names.map(n => n[1]).lastIndexOf('active'), firstDisabled = names.map(n => n[1]).indexOf('disabled');
    const l = await new c.Session().login('qa_fin2', 'NewPass88');
    check('USR-09', 'disabled + after actives + login refused', r.ok === 'User updated' && names.find(n => n[0] === 'qa_fin2')[1] === 'disabled' && firstDisabled > lastActive && l.status === 401, `${r.ok}; order ok=${firstDisabled > lastActive}; login=${l.status}`);
    await admin.act(`/users/${u.id}/toggle`); await c.as('admin');
  });
  await step('USR-10', 'deactivated while logged in → next request logged out', async () => {
    const s = await c.as('qa_fin2', 'NewPass88');
    const u = q1("SELECT id FROM users WHERE username='qa_fin2'");
    const before = await s.get('/cases');
    await admin.act(`/users/${u.id}/toggle`);
    const after = await s.get('/cases');
    const post = await s.post('/cases/16/payments', { payment_date: today(), amount: '1', method: 'cash' });
    check('USR-10', 'next GET → /login; POST blocked', before.status === 200 && after.status === 302 && after.location === '/login' && post.status === 302 && post.location === '/login', `${before.status} → ${after.status} ${after.location}; post=${post.status} ${post.location}`);
    await admin.act(`/users/${u.id}/toggle`);
  });
  await step('USR-11', 'role change applies next request', async () => {
    const s = await c.as('qa_fin2', 'NewPass88');
    const u = q1("SELECT id FROM users WHERE username='qa_fin2'");
    const b = (await s.get('/agents')).status;
    await admin.act(`/users/${u.id}`, { username: 'qa_fin2', full_name: 'QA Finance Two', role: 'auditor', active: '1' });
    const a = (await s.get('/agents')).status;
    const pay = (await s.post('/cases/16/payments', { payment_date: today(), amount: '1', method: 'cash' })).status;
    check('USR-11', 'finance 403 → auditor 200; auditor cannot pay', b === 403 && a === 200 && pay === 403, `/agents ${b}→${a}; pay=${pay}`);
  });
  await step('USR-12', 'new user 1-char password', async () => {
    const e = (await admin.act('/users', { username: 'qa_short', full_name: 'S', password: 'x', role: 'finance' })).err;
    check('USR-12', '"Password must be at least 8 characters"', e === 'Password must be at least 8 characters' && !q1("SELECT 1 x FROM users WHERE username='qa_short'"), e);
  });
  await step('USR-13', 'audit create/update/reset', async () => {
    const u = q1("SELECT id FROM users WHERE username='qa_fin2'").id;
    const acts = qa("SELECT action, details FROM audit_logs WHERE entity_type='user' AND entity_id=?", u).map(x => `${x.action}:${x.details}`);
    check('USR-13', 'create, update, "Reset password for qa_fin2", (de)activated', acts.some(a => /^create:/.test(a)) && acts.some(a => /^update:Updated user/.test(a)) && acts.includes('update:Reset password for qa_fin2') && acts.some(a => /Deactivated user qa_fin2/.test(a)), acts.join(' | '));
  });

  // ---------------- RPT ----------------
  await step('RPT-01', 'default From = 1st, To = today (MYT)', async () => {
    const h = (await admin.get('/reports')).text;
    check('RPT-01', 'from/to defaults', has(h, `name="from" value="${today().slice(0, 8)}01"`) && has(h, `name="to" value="${today()}"`), (h.match(/name="from" value="[^"]*"|name="to" value="[^"]*"/g) || []).join(' '));
  });
  await step('RPT-02', 'Outstanding by Status totals, independent of range', async () => {
    const t1 = strip((await admin.get('/reports')).text), t2 = strip((await admin.get('/reports?from=2020-01-01&to=2020-01-31')).text);
    const tot = (t) => (t.match(/Total (\d+) ([\d,.]+)/) || []).slice(1).join('/');
    const db = q1('SELECT COUNT(*) n, SUM(outstanding_amount) s FROM cases');
    check('RPT-02', 'grouped + total = DB; same for any range', tot(t1) === `${db.n}/${c.money(db.s)}` && tot(t1) === tot(t2), `${tot(t1)} vs db ${db.n}/${c.money(db.s)}; other range ${tot(t2)}`);
  });
  await step('RPT-03', 'performance by date range & collector', async () => {
    const from = today().slice(0, 8) + '01';
    const t = strip((await admin.get(`/reports?from=${from}&to=${today()}`)).text);
    const sec = t.slice(t.indexOf('Agent Performance'));
    const out = [];
    for (const a of qa('SELECT id, name, commission_rate r FROM agents')) {
      const m = sec.match(new RegExp(a.name + ' ([\\d,.]+) ([\\d.]+) ([\\d,.]+)'));
      const db = q1('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE agent_id=? AND date(payment_date) BETWEEN ? AND ?', a.id, from, today()).s;
      out.push({ n: a.name, page: m && num(m[1]), db, comm: m && num(m[3]), ok: !!m && Math.abs(num(m[1]) - db) < 0.01 && Math.abs(num(m[3]) - Math.round(db * a.r) / 100) < 0.006 });
    }
    const empty = strip((await admin.get('/reports?from=2020-01-01&to=2020-01-31')).text);
    check('RPT-03', 'collected in range by payments.agent_id; commission = × rate; other range 0', out.every(o => o.ok) && out.some(o => o.db > 0) && /Nurul Ain 0\.00/.test(empty), JSON.stringify(out));
  });
  await step('RPT-04', 'agent view: own scope, no performance, export blocked', async () => {
    const h = (await a1.get('/reports')).text;
    const ex = await a1.get('/reports?export=performance');
    const t = strip(h); const tot = (t.match(/Total (\d+) ([\d,.]+)/) || []).slice(1);
    const db = q1('SELECT COUNT(*) n, SUM(outstanding_amount) s FROM cases WHERE agent_id=1');
    check('RPT-04', 'scoped totals; no Agent Performance; export → page (200 html)', !has(h, 'Agent Performance') && Number(tot[0]) === db.n && num(tot[1]) === Math.round(db.s * 100) / 100 && ex.status === 200 && /text\/html/.test(ex.headers.get('content-type')), `tot=${tot} db=${db.n}/${db.s}; export ${ex.status} ${ex.headers.get('content-type')}`);
    const cs = await a1.get('/reports?export=cases');
    const lines = cs.text.split('\r\n').length - 1;
    rec('RPT-04b', '(手册外) agent cases export scoped', `rows=${lines} own=${db.n}`, lines === db.n ? 'PASS' : 'FAIL');
  });
  await step('RPT-05', 'three CSVs with headers', async () => {
    const a = await admin.get('/reports?export=cases'), b = await admin.get('/reports?export=outstanding'), p = await admin.get('/reports?export=performance');
    const hd = (r) => r.text.replace(/^﻿/, '').split('\r\n')[0];
    check('RPT-05', 'filenames + headers', /cases-detailed\.csv/.test(a.headers.get('content-disposition')) && hd(a) === 'Case No,Debtor,Agent,Principal,Interest,Paid,Outstanding,Status,Opened' && /outstanding-by-status\.csv/.test(b.headers.get('content-disposition')) && hd(b) === 'Status,Cases,Outstanding'
      && /agent-performance\.csv/.test(p.headers.get('content-disposition')) && hd(p) === 'Agent,Collected,Rate %,Commission,Target', `${hd(a)} | ${hd(b)} | ${hd(p)}`);
  });
  await step('RPT-06', 'BOM + no float tails', async () => {
    const files = await Promise.all(['cases', 'outstanding', 'performance'].map(x => admin.get('/reports?export=' + x)));
    const raw = await Promise.all(['cases', 'outstanding', 'performance'].map(async x => Buffer.from(await (await fetch(c.BASE + '/reports?export=' + x, { headers: { cookie: admin.cookie } })).arrayBuffer())));
    const bom = raw.every(b => b.slice(0, 3).toString('hex') === 'efbbbf'); // fetch().text() strips a BOM, so check bytes
    const tails = files.flatMap(f => f.text.match(/\d+\.\d{3,}/g) || []);
    check('RPT-06', 'UTF-8 BOM; ≤2 decimals', bom && tails.length === 0, `bom=${bom}; long decimals=${tails.slice(0, 5).join(',') || 'none'}`, 'Excel 实际打开未执行（无 Excel），只校验文件内容');
  });

  // ---------------- COM ----------------
  const comRow = (h, name) => { const t = strip(h); const m = t.match(new RegExp(name + ' ([\\d,.]+) ([\\d.]+) ([\\d,.]+) ([\\d,.]+) (-?[\\d,.]+)')); return m ? { collected: num(m[1]), rate: +m[2], earned: num(m[3]), settled: num(m[4]), pending: num(m[5]) } : null; };
  await step('COM-01', 'default month MYT; collected by payment month & collector', async () => {
    const h = (await fin.get('/commissions')).text;
    const r = comRow(h, 'Lim Wei Sheng');
    const db = q1("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE agent_id=1 AND substr(payment_date,1,7)=?", today().slice(0, 7)).s;
    const other = comRow((await fin.get('/commissions?month=2020-01')).text, 'Lim Wei Sheng');
    check('COM-01', `month=${today().slice(0, 7)}; Lim collected = db; other month 0`, has(h, `name="month" value="${today().slice(0, 7)}"`) && r && Math.abs(r.collected - db) < 0.01 && other.collected === 0, `${JSON.stringify(r)} db=${db}`);
  });
  await step('COM-02', 'Earned = Collected × Rate; Pending = Earned − Settled; red when negative', async () => {
    const h = (await fin.get('/commissions')).text;
    const rows = ['Lim Wei Sheng', 'Nurul Ain', 'Rajesh Kumar', 'Tan Mei Ling'].map(n => comRow(h, n));
    check('COM-02', 'formula per row', rows.every(r => r && Math.abs(r.earned - Math.round(r.collected * r.rate) / 100) < 0.006 && Math.abs(r.pending - (r.earned - r.settled)) < 0.006), JSON.stringify(rows));
  });
  let sid;
  await step('COM-03', 'settle prefilled Pending → recorded; history; audit', async () => {
    const h = (await fin.get('/commissions')).text;
    const pend = (h.match(/data-agent-id="1" data-name="Lim Wei Sheng" data-pending="([^"]+)"/) || [])[1];
    const r = await fin.act('/commissions/settle', { agent_id: '1', period: today().slice(0, 7), amount: pend, note: 'COM-03' });
    sid = q1("SELECT id FROM commission_settlements WHERE note='COM-03'").id;
    const row = comRow(r.html, 'Lim Wei Sheng');
    check('COM-03', 'Settlement recorded; Pending 0; history row; audit', r.ok === 'Settlement recorded' && row.pending === 0 && has(r.html, 'COM-03') && !!q1("SELECT 1 x FROM audit_logs WHERE action='commission_settle'"), `pending attr=${pend}; ${r.ok}; ${JSON.stringify(row)}`);
  });
  await step('COM-04', 'amount 0 / negative', async () => {
    const e = [];
    for (const a of ['0', '-5']) e.push((await fin.act('/commissions/settle', { agent_id: '1', period: today().slice(0, 7), amount: a })).err);
    check('COM-04', '"Invalid amount"', e.every(x => x === 'Invalid amount'), e.join(' | '));
  });
  await step('COM-05', 'void → rolled back; audit', async () => {
    const r = await fin.act(`/commissions/${sid}/void`);
    const row = comRow(r.html, 'Lim Wei Sheng');
    check('COM-05', 'Settlement voided; Pending restored; audit', r.ok === 'Settlement voided' && row.pending > 0 && !!q1("SELECT 1 x FROM audit_logs WHERE action='commission_void'"), `${r.ok}; ${JSON.stringify(row)}`);
  });
  await step('COM-06', 'agent1: own row, own history, no Settle/Void', async () => {
    const h = (await a1.get('/commissions')).text;
    const names = ['Lim Wei Sheng', 'Nurul Ain', 'Rajesh Kumar', 'Tan Mei Ling'].filter(n => has(h, `<td>${n}</td>`));
    const st = (await a1.post('/commissions/settle', { agent_id: '1', amount: '1' })).status;
    check('COM-06', 'only Lim; no buttons; POST 403', names.join() === 'Lim Wei Sheng' && !has(h, '>Settle</button>') && !has(h, '>Void</button>') && st === 403, `names=${names}; settle POST=${st}`);
  });
  await step('COM-07', 'auditor: view only', async () => {
    const h = (await aud.get('/commissions')).text;
    const st = (await aud.post('/commissions/settle', { agent_id: '1', amount: '1' })).status;
    check('COM-07', 'no Settle/Void; POST 403', !has(h, '>Settle</button>') && !has(h, '>Void</button>') && st === 403 && has(h, 'Nurul Ain'), `post=${st}`);
  });
  await step('COM-08', 'reassignment keeps collected with A', async () => {
    const before = comRow((await fin.get('/commissions')).text, 'Rajesh Kumar');
    const beforeB = comRow((await fin.get('/commissions')).text, 'Tan Mei Ling');
    await fin.act('/cases/3/payments', { payment_date: today(), amount: '200', method: 'cash' }); // case 3 = Rajesh
    const cs = q1('SELECT * FROM cases WHERE id=3');
    await man.act('/cases/3', { debtor_id: String(cs.debtor_id), agent_id: '4', principal_amount: String(cs.principal_amount), interest_mode: cs.interest_mode, interest_amount: String(cs.interest_amount), priority: cs.priority });
    const h = (await fin.get('/commissions')).text;
    const a = comRow(h, 'Rajesh Kumar'), b = comRow(h, 'Tan Mei Ling');
    check('COM-08', 'Rajesh +200, Tan unchanged after reassignment', a.collected === before.collected + 200 && b.collected === beforeB.collected, `Rajesh ${before.collected}→${a.collected}; Tan ${beforeB.collected}→${b.collected}`);
  });

  // ---------------- SRCH ----------------
  const srch = async (s, q) => [...(await s.get('/search?q=' + encodeURIComponent(q))).text.matchAll(/href="\/cases\/(\d+)"/g)].map(m => +m[1]);
  await step('SRCH-01', 'case no / name / IC / phone', async () => {
    const a = await srch(admin, 'D014'), b = await srch(admin, 'Ravi Chandran'), d = await srch(admin, '850320-08'), e = await srch(admin, '016-3334445');
    check('SRCH-01', 'matches', a.join() === '14' && b.length === 2 && d.join() === b.join() && e.join() === b.join(), `case=${a} name=${b} ic=${d} phone=${e}`);
  });
  await step('SRCH-02', 'agent1 cannot find agent2 debtor', async () => {
    const r = await srch(a1, 'Sarah Lim');
    check('SRCH-02', 'no result', r.length === 0, `results=${r}`);
  });
  await step('SRCH-03', 'empty search', async () => {
    const r = await admin.get('/search?q=');
    check('SRCH-03', '200, no results', r.status === 200 && !/href="\/cases\/\d+"/.test(r.text.slice(r.text.indexOf('<main'))), `${r.status}`);
  });
  await step('SRCH-04', 'broad "a" ≤ 50', async () => {
    for (let i = 0; i < 4; i++) {
      const d = await c.newDebtor(admin, `QA Searcha ${i}`);
      for (let k = 0; k < 10; k++) await c.newCase(admin, { debtor_id: String(d), principal_amount: '10', interest_mode: 'fixed', interest_amount: '0' });
    }
    const r = await srch(admin, 'a');
    check('SRCH-04', 'max 50', r.length === 50 && q1("SELECT COUNT(*) n FROM cases JOIN debtors ON debtors.id=cases.debtor_id WHERE debtors.name LIKE '%a%' OR cases.case_no LIKE '%a%'").n > 50, `shown=${r.length}`);
  });
  await step('SRCH-05', "' \" % _ <script>", async () => {
    const out = [];
    for (const q of ["'", '"', '%', '_', '<script>alert(1)</script>']) { const r = await admin.get('/search?q=' + encodeURIComponent(q)); out.push(`${q}:${r.status}:${has(r.text, '<script>alert(1)</script>')}`); }
    check('SRCH-05', 'no error, no raw script', out.every(o => /:200:false$/.test(o)), out.join(' '));
  });

  // ---------------- AUD ----------------
  await step('AUD-01', 'admin/auditor yes; others 403', async () => {
    const s = [(await admin.get('/audit-log')).status, (await aud.get('/audit-log')).status, (await man.get('/audit-log')).status, (await fin.get('/audit-log')).status, (await a1.get('/audit-log')).status, (await man.get('/audit-log?format=csv')).status];
    check('AUD-01', '200,200,403,403,403,403', s.join() === '200,200,403,403,403,403', s.join());
  });
  await step('AUD-02', 'latest 200, desc; columns', async () => {
    const h = (await aud.get('/audit-log')).text;
    const rows = (h.match(/<tr>\s*<td/g) || []).length;
    const hdr = [...h.slice(h.indexOf('<thead>'), h.indexOf('</thead>')).matchAll(/<th>([^<]+)<\/th>/g)].map(m => m[1]);
    check('AUD-02', '≤200; Time, User, Action, Entity, Details, IP', rows === Math.min(200, q1('SELECT COUNT(*) n FROM audit_logs').n) && hdr.join() === 'Time,User,Action,Entity,Details,IP', `rows=${rows} total=${q1('SELECT COUNT(*) n FROM audit_logs').n} hdr=${hdr}`);
  });
  await step('AUD-03', 'action filter', async () => {
    const h = (await aud.get('/audit-log?action=payment')).text;
    const acts = [...h.matchAll(/<td><span class="badge[^"]*">([\w_]+)<\/span><\/td>|<td>(payment\w*|[a-z_]+)<\/td>/g)];
    const t = strip(h.slice(h.indexOf('<tbody>')));
    check('AUD-03', 'only payment rows', !/payment_edit|ptp_create|status_change|login/.test(t) && /payment/.test(t), `rows=${(h.match(/<tr>\s*<td/g) || []).length}; ${acts.length}`);
  });
  await step('AUD-04', 'appendix C coverage', async () => {
    const need = ['login', 'logout', 'create', 'update', 'payment', 'payment_edit', 'payment_void', 'ptp_create', 'ptp_fulfilled', 'ptp_broken', 'ptp_plan_create', 'ptp_plan_cancel', 'call', 'status_change', 'restructure', 'restructure_undo', 'commission_settle', 'commission_void', 'seed', 'note_add', 'note_edit', 'note_delete', 'task_create', 'task_update', 'task_complete'];
    // exercise the ones this file has not produced yet
    await man.act('/cases/2/ptps', { amount: '10', due_date: addDays(today(), 2) });
    const p = q1("SELECT id FROM ptps WHERE case_id=2 AND status='pending'"); await man.act(`/ptps/${p.id}/fulfill`, { amount: '10', payment_date: today(), method: 'cash' });
    await man.act('/cases/2/ptps', { amount: '11', due_date: addDays(today(), 2) });
    const p2 = q1("SELECT id FROM ptps WHERE case_id=2 AND status='pending'"); await man.act(`/ptps/${p2.id}/break`);
    await man.act('/cases/2/ptp-plans', { total_amount: '30', num_installments: '3', first_due_date: today() });
    const plan = q1('SELECT plan_id FROM ptps WHERE case_id=2 AND plan_id IS NOT NULL').plan_id; await man.act(`/cases/2/ptp-plans/${plan}/cancel`);
    await man.act('/cases/2/calls', { result: 'busy' }); await man.act('/cases/2/status', { status: 'negotiation' });
    await man.act('/cases/2/notes', { content: 'aud note' }); const n = q1("SELECT id FROM timeline_events WHERE content='aud note'").id;
    await man.act(`/cases/2/notes/${n}`, { content: 'aud note 2' }); await man.act(`/cases/2/notes/${n}/delete`);
    await man.act('/cases/2/restructures', { effective_date: today(), interest_mode: 'monthly', interest_rate: '1.0', tenure: '12', reason: 'aud' });
    const rid = q1('SELECT id FROM case_restructures WHERE case_id=2').id; await man.act(`/cases/2/restructures/${rid}/undo`);
    await fin.act('/cases/16/payments', { payment_date: today(), amount: '2', method: 'cash' });
    const pay = q1('SELECT id FROM payments WHERE case_id=16 ORDER BY id DESC').id;
    await fin.act(`/cases/16/payments/${pay}`, { amount: '3', payment_date: today(), method: 'cash' }); await fin.act(`/cases/16/payments/${pay}/void`);
    await (await c.as('manager')).get('/logout');
    const have = new Set(qa('SELECT DISTINCT action FROM audit_logs').map(r => r.action));
    const missing = need.filter(a => !have.has(a));
    check('AUD-04', 'every appendix-C action recorded', missing.length === 0, missing.length ? 'missing: ' + missing.join(',') : `all ${need.length} actions present (demo_delete/demo_reload: DEMO-01/02)`);
  });
  await step('AUD-05', 'no edit/delete', async () => {
    const h = (await admin.get('/audit-log')).text;
    const main = h.slice(h.indexOf('<main'));
    const forms = [...main.matchAll(/<form[^>]*method="post"/gi)].length;
    const p = [(await admin.post('/audit-log', {})).status, (await admin.post('/audit-log/1/delete', {})).status];
    check('AUD-05', 'no POST forms; POST routes 404', forms === 0 && p.every(x => x === 404), `post forms=${forms}; POST=${p}`);
  });

  // ---------------- SET ----------------
  await step('SET-01', 'save company → banner; audit', async () => {
    const r = await admin.act('/settings', { company_name: 'QA Kredit Sdn Bhd', address: '1 Jalan QA, KL', phone: '03-1234', email: 'qa@kredit.my', reg_no: 'KPKT-QA-1', max_annual_rate: '18' });
    check('SET-01', '"Company settings saved"; audit update settings', r.ok === 'Company settings saved' && !!q1("SELECT 1 x FROM audit_logs WHERE action='update' AND entity_type='settings'"), r.ok);
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const upload = async (buf, name, type, extra = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ company_name: 'QA Kredit Sdn Bhd', address: '1 Jalan QA, KL', phone: '03-1234', email: 'qa@kredit.my', reg_no: 'KPKT-QA-1', max_annual_rate: '18', ...extra })) fd.append(k, v);
    if (buf) fd.append('logo', new Blob([buf], { type }), name);
    return admin.act('/settings', fd);
  };
  await step('SET-02', 'PNG logo → preview + statement', async () => {
    const r = await upload(png, 'l.png', 'image/png');
    const st = (await admin.get('/cases/2/statement')).text;
    check('SET-02', 'saved; settings preview; statement img', r.ok === 'Company settings saved' && /src="data:image\/png;base64/.test(r.html) && /<img src="data:image\/png;base64/.test(st), r.ok);
  });
  await step('SET-03', 'PDF / GIF refused', async () => {
    const e1 = (await upload(Buffer.from('%PDF-1.4'), 'x.pdf', 'application/pdf')).err;
    const e2 = (await upload(Buffer.from('GIF89a'), 'x.gif', 'image/gif')).err;
    check('SET-03', '"Logo must be PNG, JPEG, SVG or WebP"', e1 === 'Logo must be PNG, JPEG, SVG or WebP' && e2 === e1, `${e1} | ${e2}`);
  });
  await step('SET-04', '> 512KB refused', async () => {
    const r = await upload(Buffer.alloc(513 * 1024, 1), 'big.png', 'image/png');
    check('SET-04', 'error banner (File too large)', r.err === 'File too large', `${r.err}`);
  });
  await step('SET-05', 'remove logo', async () => {
    const r = await upload(null, '', '', { remove_logo: '1' });
    check('SET-05', 'logo cleared', r.ok === 'Company settings saved' && q1('SELECT logo FROM settings WHERE id=1').logo === '', r.ok);
  });
  await step('SET-06', 'statement contents', async () => {
    await upload(png, 'l.png', 'image/png');
    const st = strip((await admin.get('/cases/14/statement')).text);
    const want = ['QA Kredit Sdn Bhd', '1 Jalan QA, KL', 'Tel: 03-1234', 'qa@kredit.my', 'Reg No: KPKT-QA-1', 'CASE-2026-D014', today(), 'Debtor', 'Phone', 'IC/Passport', 'Principal RM', 'Interest RM', 'Paid RM', 'Outstanding (contract, to maturity) RM', `Settlement Amount as of ${today()} RM`, 'Overdue RM', 'days past due', 'Loan Start Date', 'Interest Terms', 'Tenure 12 months', 'Maturity Date', 'Restructured From', 'Payment History'];
    const miss = want.filter(w => !st.includes(w));
    check('SET-06', 'all elements present', miss.length === 0, miss.length ? 'missing: ' + miss.join(' | ') : 'all ' + want.length + ' present');
  });
  await step('SET-07', 'print hides buttons (CSS)', async () => {
    const h = (await admin.get('/cases/14/statement')).text;
    check('SET-07', '@media print hides .stmt-actions', /@media print \{ \.stmt-actions \{ display: none; \}/.test(h) && has(h, 'window.print()'), 'css rule present', '打印预览/PDF 见 ui.qa.py');
  });
  await step('SET-09', 'max rate 0 / 150 refused; 20 ok', async () => {
    const e1 = (await admin.act('/settings', { company_name: 'QA Kredit Sdn Bhd', max_annual_rate: '0' })).err;
    const e2 = (await admin.act('/settings', { company_name: 'QA Kredit Sdn Bhd', max_annual_rate: '150' })).err;
    const ok = (await admin.act('/settings', { company_name: 'QA Kredit Sdn Bhd', max_annual_rate: '20' })).ok;
    await admin.act('/settings', { company_name: 'QA Kredit Sdn Bhd', max_annual_rate: '18' });
    check('SET-09', '"Max annual interest rate must be between 0 and 100"; 20 saved', e1 === 'Max annual interest rate must be between 0 and 100' && e2 === e1 && ok === 'Company settings saved', `${e1} | ${e2} | ${ok}`);
  });
  await step('SET-08', 'blank company → "Debt Collection CRM"', async () => {
    await admin.act('/settings', { company_name: '', max_annual_rate: '18' });
    const h = (await admin.get('/cases/2/statement')).text;
    check('SET-08', 'heading falls back', /<h1>Debt Collection CRM<\/h1>/.test(h), (h.match(/<h1>[^<]*<\/h1>/) || [])[0]);
  });

  // ---------------- DEMO ----------------
  await step('DEMO-05', 'non-admin /demo-tools → 403', async () => {
    const s = [(await man.get('/demo-tools')).status, (await fin.get('/demo-tools')).status, (await aud.get('/demo-tools')).status, (await a1.get('/demo-tools')).status, (await man.post('/demo-tools/delete-demo')).status];
    check('DEMO-05', 'all 403', s.every(x => x === 403), s.join(','));
  });
  let own;
  await step('DEMO-01/04', 'delete demo keeps trial + used demo case', async () => {
    const d = await c.newDebtor(admin, 'QA Trial Debtor');
    own = await c.newCase(admin, { debtor_id: String(d), principal_amount: '777', interest_mode: 'fixed', interest_amount: '0' });
    await fin.act('/cases/13/payments', { payment_date: today(), amount: '5', method: 'cash' }); // DEMO-04: trial payment on demo case 13
    const r = await admin.act('/demo-tools/delete-demo');
    const left = qa('SELECT id FROM cases WHERE is_demo=1').map(x => x.id);
    check('DEMO-01', '"Demo data deleted - your trial data is kept"; demo gone; own kept; audit', r.ok === 'Demo data deleted - your trial data is kept' && !!q1('SELECT 1 x FROM cases WHERE id=?', own) && !!q1("SELECT 1 x FROM audit_logs WHERE action='demo_delete'"), `${r.ok || r.err || r.status}; demo cases left=${left}`);
    check('DEMO-04', 'used demo case 13 kept, no error', left.includes(13) && !!q1('SELECT 1 x FROM payments WHERE case_id=13 AND is_demo=0'), `left=${left}`);
  });
  await step('DEMO-02/03', 'reload: D-numbers back, trial kept, no clash', async () => {
    const own2 = await c.newCase(admin, { debtor_id: String(q1("SELECT id FROM debtors WHERE name='QA Trial Debtor'").id), principal_amount: '888', interest_mode: 'fixed', interest_amount: '0' });
    const r = await admin.act('/demo-tools/reload-demo');
    const nos = qa('SELECT case_no FROM cases WHERE is_demo=1 ORDER BY id').map(x => x.case_no);
    const mine = qa('SELECT case_no FROM cases WHERE id IN (?,?)', own, own2).map(x => x.case_no);
    check('DEMO-02', '"Demo data reloaded"; D001…D020; trial unchanged; audit', r.ok === 'Demo data reloaded' && nos.length === 20 && nos[0].endsWith('-D001') && mine.length === 2 && !!q1("SELECT 1 x FROM audit_logs WHERE action='demo_reload'"), `${r.ok || r.err || r.status}; demo=${nos.length}; mine=${mine}`);
    check('DEMO-03', 'delete → new case → reload: no error, numbers disjoint', r.ok === 'Demo data reloaded' && mine.every(m => !/-D\d{3}$/.test(m)), mine.join(','));
  });

  finish('d-task-agt-usr-rpt-com-misc');
  assert.ok(true);
});
