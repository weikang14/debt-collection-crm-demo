# A-Group Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four low-risk UI improvements: a task status bar, debtor/agent list filters, and a Users edit page (pencil icon).

**Architecture:** Small edits to existing routes/views plus one new users edit view/route. Filters build scoped WHERE clauses with `?` params; the task bar is a view-derived count. No schema change.

**Tech Stack:** Node.js, `node:sqlite`, Express, EJS, `node:test`.

## Global Constraints

- Node ≥ 22.5; run with `node --no-warnings`. Zero new dependencies.
- Spec: `docs/superpowers/specs/2026-07-05-quick-wins-A-design.md`.
- Row-level scope preserved: debtors via `reachableDebtorIds(user)` (null=unrestricted, [] = none, else id list); tasks already scoped in the route; agents/users are admin/manager/auditor views (unscoped).
- All new SQL filters use `?` bind params — never string-concatenate user input. The only interpolation allowed is the dynamic `IN (?,?,…)` placeholder list (values still passed as params).
- `parseActive(v)` (from `src/utils/forms.js`) returns 0 only when `v === '0'`, else 1. Reuse it for the user active field.
- Users management is admin-only (`requireRole('admin')`). Self-protection: an admin editing their own account cannot change their role away from `admin` and cannot set themselves inactive.
- Reuse existing CSS classes (`.filters`, `.btn`, `.btn-sm`, `.badge` + `is-red`/`is-gold`/`is-green`/`is-neutral`, `table.data`, `.card`, `.form`, `.form-actions`, `.page-head`). `h.icon(name)` renders inline SVG; `h.daysOverdue(iso) > 0` means overdue.
- Tests use the isolated DB via `process.env.CRM_DB_PATH` set at the top of a test file before requiring `../src/db`.
- Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- `src/views/tasks/index.ejs` — add a status bar above the collapsible form.
- `public/css/style.css` — `.taskbar` style.
- `src/routes/debtors.js` — GET `/` builds scoped WHERE + risk/q filters; pass `query`.
- `src/views/debtors/list.ejs` — filter bar.
- `src/routes/agents.js` — GET `/` adds department/status filters; pass `departments`, `query`.
- `src/views/agents/list.ejs` — filter bar.
- `src/utils/helpers.js` — add an `edit` (pencil) icon.
- `src/routes/users.js` — add GET `/:id/edit` + POST `/:id` (update).
- `src/views/users/edit.ejs` — NEW edit form.
- `src/views/users/index.ejs` — add pencil Edit link per row.
- `test/filters.test.js` — NEW, unit tests for the debtor filter WHERE builder.
- `test/users_edit.test.js` — NEW, unit test for the self-protection guard.

---

### Task 1: Task status bar

**Files:**
- Modify: `src/views/tasks/index.ejs`
- Modify: `public/css/style.css`

**Interfaces:** none (view derives counts from the existing `tasks` array; `h.daysOverdue` already available).

- [ ] **Step 1: Add the status bar to `src/views/tasks/index.ejs`**

Immediately after `<div class="page-head"><h1>Tasks</h1></div>` and BEFORE the `<% if (['admin','manager','agent']...` new-task block, insert:

```ejs
<% const pending = tasks.filter(t => t.status === 'pending');
   const overdue = pending.filter(t => t.due_date && h.daysOverdue(t.due_date) > 0);
   const barCls = overdue.length ? 'is-red' : pending.length ? 'is-gold' : 'is-green'; %>
<div class="taskbar <%= barCls %>">
  <% if (!pending.length) { %>All tasks handled — nothing pending.
  <% } else { %><strong><%= pending.length %></strong> pending<% if (overdue.length) { %> · <strong><%= overdue.length %></strong> overdue<% } %><% } %>
</div>
```

- [ ] **Step 2: Add `.taskbar` styles to `public/css/style.css`**

Append:

```css
/* Task status bar */
.taskbar {
  padding: 10px 14px;
  border-radius: var(--radius);
  margin-bottom: 16px;
  font-size: 13.5px;
  border: 1px solid transparent;
}
.taskbar.is-red { background: #f7e9e8; color: var(--red); border-color: #edc7c4; }
.taskbar.is-gold { background: #f7ecd9; color: var(--gold); border-color: #ecd8b3; }
.taskbar.is-green { background: #e8f3ec; color: var(--green); border-color: #c3e0cd; }
```

- [ ] **Step 3: Compile check**

Run: `node -e "const ejs=require('ejs'),fs=require('fs'); ejs.compile(fs.readFileSync('src/views/tasks/index.ejs','utf8'),{filename:'t'}); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 4: Live smoke**

```bash
npm run seed
PORT=4101 node --no-warnings src/app.js & sleep 2
B=http://localhost:4101
curl -s -c /tmp/a -b /tmp/a -o /dev/null -d "username=manager&password=manager123" $B/login
curl -s -b /tmp/a "$B/tasks" | grep -oE 'class="taskbar (is-red|is-gold|is-green)"' | head -1
```
Expected: prints a `taskbar` class (the seed has pending+overdue tasks, so likely `is-red`). Kill server, `npm run seed`.

- [ ] **Step 5: Commit**

```bash
git add src/views/tasks/index.ejs public/css/style.css
git commit -m "$(printf 'feat: task status bar (pending/overdue summary)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Debtor list filters

**Files:**
- Create: `src/utils/debtorFilter.js`
- Create: `test/filters.test.js`
- Modify: `src/routes/debtors.js`
- Modify: `src/views/debtors/list.ejs`

**Interfaces:**
- Produces: `debtorFilter(ids, query)` → `{ where: string, params: any[] }` where `ids` is the reachable-id array or `null` (unrestricted). Builds the scope + risk + q clause. `null` ids → scope `1=1`; empty array → `1=0` (match nothing).

- [ ] **Step 1: Write the failing test `test/filters.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { debtorFilter } = require('../src/utils/debtorFilter');

test('unrestricted, no filters -> 1=1 no params', () => {
  const r = debtorFilter(null, {});
  assert.strictEqual(r.where, '1=1');
  assert.deepStrictEqual(r.params, []);
});
test('scoped ids -> IN clause', () => {
  const r = debtorFilter([2, 5], {});
  assert.match(r.where, /id IN \(\?,\?\)/);
  assert.deepStrictEqual(r.params, [2, 5]);
});
test('empty scope -> 1=0', () => {
  const r = debtorFilter([], {});
  assert.strictEqual(r.where, '1=0');
});
test('risk + q filters append params', () => {
  const r = debtorFilter(null, { risk: 'high', q: 'ali' });
  assert.match(r.where, /risk_level = \?/);
  assert.match(r.where, /name LIKE \?/);
  assert.deepStrictEqual(r.params, ['high', '%ali%', '%ali%', '%ali%']);
});
test('invalid risk is ignored', () => {
  const r = debtorFilter(null, { risk: 'bogus' });
  assert.strictEqual(r.where, '1=1');
  assert.deepStrictEqual(r.params, []);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `node --no-warnings --test test/filters.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Create `src/utils/debtorFilter.js`**

```js
// Build the WHERE clause + params for the debtors list: row-level scope
// (reachable ids) plus optional risk / text filters. All user values are
// bound as ? params; only the dynamic IN placeholder list is interpolated.
const RISKS = ['low', 'medium', 'high'];

function debtorFilter(ids, query = {}) {
  const parts = [];
  const params = [];
  if (ids === null) parts.push('1=1');
  else if (!ids.length) parts.push('1=0');
  else { parts.push(`id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }

  if (RISKS.includes(query.risk)) { parts.push('risk_level = ?'); params.push(query.risk); }
  if (query.q) {
    const like = '%' + query.q + '%';
    parts.push('(name LIKE ? OR ic_passport LIKE ? OR phone LIKE ?)');
    params.push(like, like, like);
  }
  return { where: parts.join(' AND '), params };
}
module.exports = { debtorFilter };
```

- [ ] **Step 4: Run it — expect PASS**

Run: `node --no-warnings --test test/filters.test.js`
Expected: PASS.

- [ ] **Step 5: Use it in `src/routes/debtors.js`**

Add the import near the top (after the existing requires):

```js
const { debtorFilter } = require('../utils/debtorFilter');
```

Replace the entire GET `/` handler body:

```js
router.get('/', requireLogin, canView, (req, res) => {
  const ids = reachableDebtorIds(req.session.user); // null = unrestricted
  let debtors;
  if (ids === null) debtors = all('SELECT * FROM debtors ORDER BY name');
  else if (ids.length === 0) debtors = [];
  else debtors = all(`SELECT * FROM debtors WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY name`, ids);
  res.render('debtors/list', { title: 'Debtors', debtors });
});
```
with:

```js
router.get('/', requireLogin, canView, (req, res) => {
  const ids = reachableDebtorIds(req.session.user); // null = unrestricted
  const f = debtorFilter(ids, req.query);
  const debtors = all(`SELECT * FROM debtors WHERE ${f.where} ORDER BY name`, f.params);
  res.render('debtors/list', { title: 'Debtors', debtors });
});
```

- [ ] **Step 6: Add the filter bar to `src/views/debtors/list.ejs`**

After the `.page-head` div and before the `<% if (!debtors.length)` line, insert:

```ejs
<form class="card filters" method="get" action="/debtors">
  <label>Risk <select name="risk">
    <option value="" <%= !query.risk?'selected':'' %>>All</option>
    <option value="low" <%= query.risk==='low'?'selected':'' %>>Low</option>
    <option value="medium" <%= query.risk==='medium'?'selected':'' %>>Medium</option>
    <option value="high" <%= query.risk==='high'?'selected':'' %>>High</option>
  </select></label>
  <label>Search <input name="q" value="<%= query.q||'' %>" placeholder="Name, IC, or phone"></label>
  <button class="btn btn-gold" type="submit">Filter</button>
</form>
```

(`query` is already exposed to all views via `res.locals.query`.)

- [ ] **Step 7: Load + full suite**

Run: `node -e "require('./src/routes/debtors'); const ejs=require('ejs'),fs=require('fs'); ejs.compile(fs.readFileSync('src/views/debtors/list.ejs','utf8'),{filename:'d'}); console.log('OK')"` then `npm test`
Expected: `OK`; all tests pass.

- [ ] **Step 8: Live smoke (filters + scope)**

```bash
npm run seed
PORT=4102 node --no-warnings src/app.js & sleep 2
B=http://localhost:4102
curl -s -c /tmp/m -b /tmp/m -o /dev/null -d "username=manager&password=manager123" $B/login
echo "all: $(curl -s -b /tmp/m "$B/debtors" | grep -c '/debtors/')"
echo "high: $(curl -s -b /tmp/m "$B/debtors?risk=high" | grep -c '/debtors/')"
# agent still scoped
curl -s -c /tmp/a -b /tmp/a -o /dev/null -d "username=agent1&password=agent123" $B/login
echo "agent1 all: $(curl -s -b /tmp/a "$B/debtors" | grep -c '/debtors/')"
```
Expected: `high` < `all`; `agent1 all` < manager's `all` (scope intact). Kill server, `npm run seed`.

- [ ] **Step 9: Commit**

```bash
git add src/utils/debtorFilter.js test/filters.test.js src/routes/debtors.js src/views/debtors/list.ejs
git commit -m "$(printf 'feat: debtor list filters (risk + text search), scope preserved\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Agent list filters

**Files:**
- Modify: `src/routes/agents.js`
- Modify: `src/views/agents/list.ejs`

**Interfaces:** none new (filters built inline in the route; small, agents view is unscoped/admin-manager-auditor).

- [ ] **Step 1: Add filters to the GET `/` handler in `src/routes/agents.js`**

Replace:

```js
router.get('/', requireLogin, canView, (req, res) => {
  const agents = all(`${STAT} FROM agents a ORDER BY collected DESC`);
  res.render('agents/list', { title: 'Agents', agents });
});
```
with:

```js
router.get('/', requireLogin, canView, (req, res) => {
  const where = [];
  const params = [];
  if (req.query.department) { where.push('a.department = ?'); params.push(req.query.department); }
  if (req.query.status === 'active') where.push('a.active = 1');
  else if (req.query.status === 'inactive') where.push('a.active = 0');
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const agents = all(`${STAT} FROM agents a ${clause} ORDER BY collected DESC`, params);
  const departments = all("SELECT DISTINCT department FROM agents WHERE department IS NOT NULL AND department <> '' ORDER BY department").map(r => r.department);
  res.render('agents/list', { title: 'Agents', agents, departments });
});
```

- [ ] **Step 2: Add the filter bar to `src/views/agents/list.ejs`**

After the `.page-head` div and before `<% if (!agents.length)`, insert:

```ejs
<form class="card filters" method="get" action="/agents">
  <label>Department <select name="department">
    <option value="" <%= !query.department?'selected':'' %>>All</option>
    <% departments.forEach(d => { %><option value="<%= d %>" <%= query.department===d?'selected':'' %>><%= d %></option><% }) %>
  </select></label>
  <label>Status <select name="status">
    <option value="" <%= !query.status?'selected':'' %>>All</option>
    <option value="active" <%= query.status==='active'?'selected':'' %>>Active</option>
    <option value="inactive" <%= query.status==='inactive'?'selected':'' %>>Inactive</option>
  </select></label>
  <button class="btn btn-gold" type="submit">Filter</button>
</form>
```

- [ ] **Step 3: Load + compile check**

Run: `node -e "require('./src/routes/agents'); const ejs=require('ejs'),fs=require('fs'); ejs.compile(fs.readFileSync('src/views/agents/list.ejs','utf8'),{filename:'a'}); console.log('OK')"` then `npm test`
Expected: `OK`; all pass.

- [ ] **Step 4: Live smoke**

```bash
npm run seed
PORT=4103 node --no-warnings src/app.js & sleep 2
B=http://localhost:4103
curl -s -c /tmp/m -b /tmp/m -o /dev/null -d "username=manager&password=manager123" $B/login
echo "all: $(curl -s -b /tmp/m "$B/agents" | grep -c '/agents/')"
echo "Consumer dept: $(curl -s -b /tmp/m "$B/agents?department=Consumer" | grep -c '/agents/')"
```
Expected: `Consumer dept` < `all` (seed has 4 agents, 2 Consumer). Kill server, `npm run seed`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/agents.js src/views/agents/list.ejs
git commit -m "$(printf 'feat: agent list filters (department + status)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Users edit page (pencil icon)

**Files:**
- Modify: `src/utils/helpers.js`
- Create: `src/views/users/edit.ejs`
- Create: `test/users_edit.test.js`
- Modify: `src/routes/users.js`
- Modify: `src/views/users/index.ejs`

**Interfaces:**
- Consumes: `parseActive` (from `src/utils/forms.js`); existing `ROLES`, `adminOnly`, `bcrypt`, `logAction` in users.js.
- Produces: `userEditGuard(session, targetId, newRole, newActive)` → `string | null` — returns an error message if the edit would lock the current admin out (editing self: role changed away from 'admin', or active set to 0); else `null`. GET `/:id/edit` + POST `/:id` routes.

- [ ] **Step 1: Write the failing test `test/users_edit.test.js`**

```js
// isolate the DB the users route opens at module load, so this never touches data/crm.db
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-uedit-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const { userEditGuard } = require('../src/routes/users');

const meAdmin = { id: 1, role: 'admin' };

test('blocks self-demotion from admin', () => {
  assert.match(userEditGuard(meAdmin, 1, 'manager', 1) || '', /role/i);
});
test('blocks self-deactivation', () => {
  assert.match(userEditGuard(meAdmin, 1, 'admin', 0) || '', /deactivat|disable|inactive/i);
});
test('allows editing self while staying admin+active', () => {
  assert.strictEqual(userEditGuard(meAdmin, 1, 'admin', 1), null);
});
test('allows editing another user freely', () => {
  assert.strictEqual(userEditGuard(meAdmin, 2, 'manager', 0), null);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `node --no-warnings --test test/users_edit.test.js`
Expected: FAIL (`userEditGuard` not exported).

- [ ] **Step 3: Add `userEditGuard` + routes in `src/routes/users.js`**

Add this helper near the top (after `const adminOnly = ...`):

```js
// Prevent an admin from locking themselves out when editing their own account.
function userEditGuard(sessionUser, targetId, newRole, newActive) {
  if (sessionUser.id !== Number(targetId)) return null;
  if (newRole !== 'admin') return 'You cannot change your own admin role';
  if (Number(newActive) === 0) return 'You cannot deactivate your own account';
  return null;
}
```

Add the two routes before `module.exports` (which must be changed — see below):

```js
router.get('/:id/edit', requireLogin, adminOnly, (req, res) => {
  const u = get('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!u) return res.redirect('/users?err=User+not+found');
  res.render('users/edit', {
    title: 'Edit User', u, roles: ROLES,
    agents: all('SELECT id,name FROM agents WHERE active=1 ORDER BY name'),
    clients: all('SELECT id,company_name FROM clients ORDER BY company_name'),
  });
});

router.post('/:id', requireLogin, adminOnly, (req, res) => {
  const u = get('SELECT id FROM users WHERE id=?', [req.params.id]);
  if (!u) return res.redirect('/users?err=User+not+found');
  const b = req.body;
  const username = (b.username || '').trim();
  const full_name = (b.full_name || '').trim();
  const role = ROLES.includes(b.role) ? b.role : null;
  const active = parseActive(b.active);
  if (!username || !full_name || !role) {
    return res.redirect(`/users/${u.id}/edit?err=Username,+full+name+and+role+are+required`);
  }
  const guard = userEditGuard(req.session.user, u.id, role, active);
  if (guard) return res.redirect(`/users/${u.id}/edit?err=${encodeURIComponent(guard)}`);
  const agent_id = role === 'agent' ? (Number(b.agent_id) || null) : null;
  const client_id = role === 'client' ? (Number(b.client_id) || null) : null;
  if (role === 'agent' && !agent_id) return res.redirect(`/users/${u.id}/edit?err=Agent+accounts+must+be+linked+to+an+agent`);
  if (role === 'client' && !client_id) return res.redirect(`/users/${u.id}/edit?err=Client+accounts+must+be+linked+to+a+client`);
  try {
    run('UPDATE users SET username=?,full_name=?,role=?,agent_id=?,client_id=?,active=? WHERE id=?',
      [username, full_name, role, agent_id, client_id, active, u.id]);
    logAction(req, 'update', 'user', u.id, `Updated user ${username} (${role})`);
    res.redirect('/users?ok=User+updated');
  } catch (e) {
    res.redirect(`/users/${u.id}/edit?err=Could+not+save+(username+may+already+exist)`);
  }
});
```

Change the last line from `module.exports = router;` to:

```js
module.exports = router;
module.exports.userEditGuard = userEditGuard;
```

(Express routers are functions, so attaching a property is safe and lets the test import `userEditGuard`.)

Also add the import near the top (after the other requires):

```js
const { parseActive } = require('../utils/forms');
```

- [ ] **Step 4: Run the users_edit test — expect PASS**

Run: `node --no-warnings --test test/users_edit.test.js`
Expected: PASS.

- [ ] **Step 5: Add the `edit` pencil icon in `src/utils/helpers.js`**

In the `ICONS` object, after the `demo:` entry (before the closing `};`), add:

```js
  edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
```

- [ ] **Step 6: Create `src/views/users/edit.ejs`**

```ejs
<% layout('layout') -%>
<div class="page-head"><h1>Edit User</h1></div>
<form class="card form" method="post" action="/users/<%= u.id %>">
  <label>Username <input name="username" value="<%= u.username %>" required autocomplete="off"></label>
  <label>Full Name <input name="full_name" value="<%= u.full_name %>" required></label>
  <label>Role
    <select name="role" id="role-select">
      <% roles.forEach(r => { %><option value="<%= r %>" <%= u.role===r?'selected':'' %>><%= r %></option><% }) %>
    </select>
  </label>
  <label id="agent-field" style="display:none">Linked Agent
    <select name="agent_id">
      <option value="">— select agent —</option>
      <% agents.forEach(a => { %><option value="<%= a.id %>" <%= u.agent_id===a.id?'selected':'' %>><%= a.name %></option><% }) %>
    </select>
  </label>
  <label id="client-field" style="display:none">Linked Client
    <select name="client_id">
      <option value="">— select client —</option>
      <% clients.forEach(c => { %><option value="<%= c.id %>" <%= u.client_id===c.id?'selected':'' %>><%= c.company_name %></option><% }) %>
    </select>
  </label>
  <label>Status <select name="active">
    <option value="1" <%= u.active===0 ? '' : 'selected' %>>Active</option>
    <option value="0" <%= u.active===0 ? 'selected' : '' %>>Inactive</option>
  </select></label>
  <div class="form-actions">
    <button class="btn btn-gold" type="submit">Save</button>
    <a class="btn" href="/users">Cancel</a>
    <a class="btn" href="/users/<%= u.id %>/password">Reset password</a>
  </div>
</form>
<script>
  (function () {
    var sel = document.getElementById('role-select');
    var af = document.getElementById('agent-field');
    var cf = document.getElementById('client-field');
    function sync() {
      af.style.display = sel.value === 'agent' ? '' : 'none';
      cf.style.display = sel.value === 'client' ? '' : 'none';
    }
    sel.addEventListener('change', sync);
    sync();
  })();
</script>
```

- [ ] **Step 7: Add the pencil Edit link in `src/views/users/index.ejs`**

In the Action cell, the current block is:

```ejs
        <div style="display:flex; gap:0.5rem; align-items:center;">
          <a class="btn btn-sm" href="/users/<%= u.id %>/password">Reset PW</a>
          <% if (u.id !== currentUser.id) { %>
          <form method="post" action="/users/<%= u.id %>/toggle" style="margin:0;">
            <button class="btn btn-sm" type="submit"><%= u.active ? 'Disable' : 'Enable' %></button>
          </form>
          <% } %>
        </div>
```

Add the Edit link as the FIRST action inside the flex div (before Reset PW):

```ejs
          <a class="btn btn-sm" href="/users/<%= u.id %>/edit" title="Edit"><%- h.icon('edit') %></a>
```

- [ ] **Step 8: Full suite + compile check**

Run: `node -e "require('./src/routes/users'); const ejs=require('ejs'),fs=require('fs'); for(const f of ['src/views/users/edit.ejs','src/views/users/index.ejs']) ejs.compile(fs.readFileSync(f,'utf8'),{filename:f}); console.log('OK')"` then `npm test`
Expected: `OK`; all tests pass.

- [ ] **Step 9: Live smoke (edit works; self-protection)**

```bash
npm run seed
PORT=4104 node --no-warnings src/app.js & sleep 2
B=http://localhost:4104
curl -s -c /tmp/a -b /tmp/a -o /dev/null -d "username=admin&password=admin123" $B/login
# edit manager's full name
MID=$(node -e "const d=require('./src/db');d.init();console.log(d.get(\"SELECT id FROM users WHERE username='manager'\").id)")
curl -s -b /tmp/a -o /dev/null -d "username=manager&full_name=Boss+Manager&role=manager&active=1" "$B/users/$MID"
node -e "const d=require('./src/db');d.init();console.log('manager full_name =', d.get(\"SELECT full_name FROM users WHERE username='manager'\").full_name)"
# self-protection: admin tries to demote self -> redirected with err, unchanged
AID=$(node -e "const d=require('./src/db');d.init();console.log(d.get(\"SELECT id FROM users WHERE username='admin'\").id)")
curl -s -b /tmp/a -o /dev/null -D - -d "username=admin&full_name=System+Admin&role=manager&active=1" "$B/users/$AID" | grep -i "location:" | grep -c "err="
node -e "const d=require('./src/db');d.init();console.log('admin role still =', d.get(\"SELECT role FROM users WHERE username='admin'\").role)"
```
Expected: `manager full_name = Boss Manager`; the self-demote returns a redirect with `err=` (count 1) and `admin role still = admin`. Kill server, `npm run seed`.

- [ ] **Step 10: Commit**

```bash
git add src/utils/helpers.js src/views/users/edit.ejs test/users_edit.test.js src/routes/users.js src/views/users/index.ejs
git commit -m "$(printf 'feat: Users edit page (pencil) with self-lockout guard\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- Task status bar (pending/overdue, colored, scoped via existing tasks) → Task 1. ✓
- Debtor filters (risk + text) preserving scope → Task 2 (`debtorFilter`). ✓
- Agent filters (department + status) → Task 3. ✓
- Users edit page (pencil icon; username/full_name/role/link/active; password via existing reset link; self-protection) → Task 4 (`userEditGuard`). ✓
- Reuse existing CSS/scope/parseActive; no schema change → all tasks. ✓
- client role still present in edit (B group removes later) → Task 4 keeps ROLES as-is. ✓

**Placeholder scan:** none — every code step shows the exact change.

**Type consistency:** `debtorFilter(ids, query)→{where,params}` used in Task 2 route matches the test. `userEditGuard(sessionUser, targetId, newRole, newActive)→string|null` matches Task 4 test import (`require('../src/routes/users').userEditGuard`) and the route call. `parseActive` reused from forms.js. `.filters`/`.taskbar`/`.btn-sm` class names consistent between routes and views. `query` available in views via res.locals. `h.icon('edit')` matches the ICONS key added in Task 4 Step 5.
