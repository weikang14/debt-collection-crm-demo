# Debt Collection CRM Demo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable, offline, full-stack debt-collection CRM demo (real frontend + backend + SQLite) that a customer can operate and enter test data into.

**Architecture:** Single Express server rendering EJS server-side templates on one port. Data persists in a file-based SQLite database via Node's built-in `node:sqlite`. Session auth with role-based access control and row-level scoping. Pure business-logic units (numbering, outstanding recompute, payment↔status linkage, scope filters) are isolated in `src/utils` / `src/services` and unit-tested with the built-in `node:test` runner.

**Tech Stack:** Node.js ≥ 22.5 (`node:sqlite`, `node:test`), Express 4, EJS + ejs-mate, express-session, bcryptjs, dayjs, hand-written CSS. No Docker, no cloud, no CDN, no build step.

## Global Constraints

- **Node ≥ 22.5**; verified machine is v22.20.0 where `node:sqlite` loads flag-free. Start with `node --no-warnings` to silence the experimental warning.
- **Zero external runtime dependencies beyond:** `bcryptjs`, `dayjs`, `ejs`, `ejs-mate`, `express`, `express-session`. No `uuid`. No test framework — use built-in `node:test` + `node:assert`.
- **Fully offline:** no CDN, no Google Fonts, no icon fonts. System font stack + hand-drawn inline SVG icons only.
- **Cross-platform scripts:** never use `rm`; the `reset` script uses `node -e "require('fs').rmSync('data/crm.db',{force:true})"`.
- **Single command to run:** `npm install && npm run seed && npm start`.
- **Money:** store as SQLite `REAL`; display 2-dp with thousands separators.
- **Time:** store UTC via `datetime('now')`; display via dayjs in MYT (UTC+8).
- **Terminal/special case statuses** (never auto-overwritten by payment): `legal, closed, cancelled, bankruptcy, deceased`.
- **Numbering:** `case_no` = `CASE-YYYY-####`, `receipt_no` = `RCPT-YYYY-####`, year-sequential zero-padded to 4.
- **Row-level scope:** `agent` → only `cases.agent_id = user.agent_id`; `client` → only `cases.client_id = user.client_id`; other roles unrestricted. Debtors/Clients/Search/Dashboard for agent & client are filtered through their reachable cases; leaderboard hidden for them.
- **CSS variables (verbatim):** `--ink:#10151f; --paper:#faf6ee; --gold:#b7842a; --green:#1e7a4c; --red:#a8342c; --blue:#395a80;` fonts: display `Georgia,'Iowan Old Style',serif`; body `-apple-system,'Segoe UI',Roboto,sans-serif`; mono `ui-monospace,'SF Mono','Roboto Mono',monospace`.
- **Audit triggers:** login/logout; create+update of client/debtor/case/agent; payment; status change; PTP create/fulfill/break.
- **Source spec:** `debt-collection-crm-demo-spec.md` (see §4.1 for resolved business rules). This plan implements it.

---

## File Structure

```
debt-collection-crm/
├── package.json              # scripts + deps (Task 1)
├── .gitignore                # ignore node_modules, data/ (Task 1)
├── README.md                 # run instructions, demo accounts (Task 24)
├── data/                     # crm.db lives here (gitignored)
├── src/
│   ├── app.js                # Express entry: session, ejs-mate, static, route mounting (Task 1, extended per module)
│   ├── db/
│   │   ├── schema.sql        # DDL from spec §4 (Task 1)
│   │   ├── index.js          # DatabaseSync wrapper: get/all/run/exec (Task 1)
│   │   └── seed.js           # demo data generator (Task 9)
│   ├── middleware/
│   │   └── auth.js           # requireLogin, requireRole, current-user locals (Task 3)
│   ├── utils/
│   │   ├── helpers.js        # money/date fmt, status labels+classes, icon(name) SVG (Task 2)
│   │   ├── numbering.js      # nextCaseNo, nextReceiptNo (Task 6)
│   │   ├── scope.js          # caseScopeClause, reachableDebtorIds/ClientIds (Task 5)
│   │   └── audit.js          # logAction (Task 8)
│   ├── services/
│   │   └── payments.js       # recomputeOutstanding, applyPayment (Task 7)
│   ├── routes/
│   │   ├── auth.js dashboard.js clients.js debtors.js cases.js
│   │   ├── agents.js tasks.js reports.js audit.js search.js
│   └── views/
│       ├── layout.ejs
│       ├── partials/ (sidebar.ejs, flash.ejs, pagination.ejs, empty.ejs, statusBadge.ejs)
│       ├── auth/login.ejs
│       ├── dashboard/index.ejs
│       ├── clients/ (list.ejs form.ejs show.ejs)
│       ├── debtors/ (list.ejs form.ejs show.ejs)
│       ├── cases/ (list.ejs form.ejs show.ejs)
│       ├── agents/ (list.ejs form.ejs show.ejs)
│       ├── tasks/index.ejs reports/index.ejs audit/index.ejs search/index.ejs
│       └── demo-accounts.ejs
├── public/css/style.css      # all styling (Task 4, extended)
└── test/                     # node:test files for utils/services (Tasks 5-7)
```

Convention for every route file: `export default function(router){...}` is NOT used; instead each exports an Express `Router` via `module.exports = router` (CommonJS). Use CommonJS (`require`/`module.exports`) throughout for simplicity and `node:sqlite` compatibility.

---

## Task 1: Project scaffold + DB layer

**Files:**
- Create: `package.json`, `.gitignore`, `src/app.js`, `src/db/index.js`, `src/db/schema.sql`

**Interfaces:**
- Produces: `db` module exporting `{ db, get(sql,params), all(sql,params), run(sql,params), exec(sql), init() }` where `get` returns one row or `undefined`, `all` returns array, `run` returns `{ changes, lastInsertRowid }`.
- Produces: running Express app on port 3000 serving `GET /health` → `"ok"`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "debt-collection-crm",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "node --no-warnings src/app.js",
    "seed": "node --no-warnings src/db/seed.js",
    "reset": "node -e \"require('fs').rmSync('data/crm.db',{force:true})\" && npm run seed",
    "test": "node --no-warnings --test"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "dayjs": "^1.11.13",
    "ejs": "^3.1.10",
    "ejs-mate": "^4.0.0",
    "express": "^4.21.2",
    "express-session": "^1.18.1"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
data/
*.log
```

- [ ] **Step 3: Create `src/db/schema.sql`** — copy the full DDL from spec §4 verbatim (all 11 `CREATE TABLE` statements), then append the indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_agent ON cases(agent_id);
CREATE INDEX IF NOT EXISTS idx_cases_client ON cases(client_id);
CREATE INDEX IF NOT EXISTS idx_cases_debtor ON cases(debtor_id);
CREATE INDEX IF NOT EXISTS idx_timeline_case ON timeline_events(case_id);
CREATE INDEX IF NOT EXISTS idx_payments_case ON payments(case_id);
CREATE INDEX IF NOT EXISTS idx_ptps_case_status ON ptps(case_id, status);
```
Wrap each `CREATE TABLE` with `IF NOT EXISTS`.

- [ ] **Step 4: Create `src/db/index.js`**

```js
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'crm.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }
function exec(sql) { return db.exec(sql); }

module.exports = { db, init, get, all, run, exec };
```

- [ ] **Step 5: Create `src/app.js` (skeleton)**

```js
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const engine = require('ejs-mate');
const { init } = require('./db');

init();

const app = express();
app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: 'debt-collection-crm-demo-secret',
  resave: false,
  saveUninitialized: false,
}));

app.get('/health', (req, res) => res.type('text').send('ok'));

// ROUTE MOUNT POINT — later tasks insert app.use(...) here

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CRM demo running: http://localhost:${PORT}`));
```

- [ ] **Step 6: Install & smoke-test**

Run: `npm install`
Then: `npm start` (background), then `curl -s http://localhost:3000/health`
Expected: `ok`, and `data/crm.db` created. Stop the server.

- [ ] **Step 7: Commit**

```bash
git init && git add -A && git commit -m "feat: scaffold express + node:sqlite skeleton"
```

---

## Task 2: Presentation helpers

**Files:**
- Create: `src/utils/helpers.js`, `test/helpers.test.js`

**Interfaces:**
- Produces: `money(n)`, `dateFmt(iso)`, `dateTimeFmt(iso)`, `daysOverdue(iso)`, `statusLabel(s)`, `statusClass(s)`, `caseStatusLabel(s)`, `caseStatusClass(s)`, `icon(name)`. `money(1234.5)` → `"1,234.50"`. `statusClass` maps to CSS classes `is-green|is-gold|is-red|is-blue|is-neutral`.

- [ ] **Step 1: Write failing test `test/helpers.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const h = require('../src/utils/helpers');

test('money formats with 2dp and thousands', () => {
  assert.strictEqual(h.money(1234.5), '1,234.50');
  assert.strictEqual(h.money(0), '0.00');
  assert.strictEqual(h.money(1000000), '1,000,000.00');
});
test('caseStatusClass maps semantics', () => {
  assert.strictEqual(h.caseStatusClass('fully_paid'), 'is-green');
  assert.strictEqual(h.caseStatusClass('legal'), 'is-red');
  assert.strictEqual(h.caseStatusClass('ptp'), 'is-gold');
  assert.strictEqual(h.caseStatusClass('new'), 'is-neutral');
});
test('icon returns inline svg string', () => {
  assert.match(h.icon('dashboard'), /^<svg/);
});
```

- [ ] **Step 2: Run to verify fail** — `npm test` → FAIL (cannot find module helpers).

- [ ] **Step 3: Implement `src/utils/helpers.js`**

```js
const dayjs = require('dayjs');

const money = (n) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const toMYT = (iso) => dayjs(iso + (iso && iso.endsWith('Z') ? '' : 'Z')).add(8, 'hour');
const dateFmt = (iso) => (iso ? dayjs(iso).format('YYYY-MM-DD') : '');
const dateTimeFmt = (iso) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '');
const daysOverdue = (iso) => (iso ? Math.max(0, dayjs().diff(dayjs(iso), 'day')) : 0);

const CASE_STATUS = {
  new: ['New', 'is-neutral'], assigned: ['Assigned', 'is-blue'],
  negotiation: ['Negotiation', 'is-blue'], ptp: ['PTP', 'is-gold'],
  partial_paid: ['Partial Paid', 'is-gold'], fully_paid: ['Fully Paid', 'is-green'],
  legal: ['Legal', 'is-red'], closed: ['Closed', 'is-neutral'],
  cancelled: ['Cancelled', 'is-neutral'], bankruptcy: ['Bankruptcy', 'is-red'],
  deceased: ['Deceased', 'is-red'],
};
const caseStatusLabel = (s) => (CASE_STATUS[s] || [s, 'is-neutral'])[0];
const caseStatusClass = (s) => (CASE_STATUS[s] || [s, 'is-neutral'])[1];
// generic aliases for ptp/task/call statuses
const statusLabel = caseStatusLabel;
const statusClass = caseStatusClass;

const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
  clients: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="9" cy="7" r="3"/></svg>',
  debtors: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  cases: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
  agents: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="7" r="4"/><path d="M6 21v-2a6 6 0 0 1 12 0v2"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  reports: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  audit: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>',
  logout: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
};
const icon = (name) => ICONS[name] || '';

module.exports = { money, dateFmt, dateTimeFmt, daysOverdue, statusLabel, statusClass, caseStatusLabel, caseStatusClass, icon };
```

- [ ] **Step 4: Run to verify pass** — `npm test` → all pass.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: presentation helpers + tests"`

---

## Task 3: Auth (login/logout, middleware, password hashing)

**Files:**
- Create: `src/middleware/auth.js`, `src/routes/auth.js`, `src/views/auth/login.ejs`
- Modify: `src/app.js` (mount auth routes + global user locals)

**Interfaces:**
- Consumes: `db.get`, helpers, `logAction` (Task 8 — for login/logout audit; until Task 8 exists, guard with `try{}catch{}` no — instead: implement audit calls here referencing `require('../utils/audit')`, and Task 8 must be done before Task 3 runs; reorder: **do Task 8 before Task 3**). See ordering note below.
- Produces: `requireLogin(req,res,next)`, `requireRole(...roles)`, and `req.session.user = { id, username, full_name, role, agent_id, client_id }`.

> **Ordering:** Task 8 (audit) has no dependencies; execute Task 8 before Task 3 so login/logout auditing works. The plan lists Task 8 later for grouping but the executor should build `src/utils/audit.js` first if doing Task 3.

- [ ] **Step 1: Create `src/middleware/auth.js`**

```js
function attachUser(req, res, next) {
  res.locals.currentUser = req.session.user || null;
  next();
}
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    if (!roles.includes(u.role)) return res.status(403).render('error', { message: 'Forbidden' });
    next();
  };
}
module.exports = { attachUser, requireLogin, requireRole };
```
Also create `src/views/error.ejs`:
```ejs
<% layout('layout') -%>
<div class="card"><h1>Error</h1><p><%= message %></p><a href="/">Back</a></div>
```

- [ ] **Step 2: Create `src/routes/auth.js`**

```js
const express = require('express');
const bcrypt = require('bcryptjs');
const { get } = require('../db');
const { logAction } = require('../utils/audit');
const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const u = get('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    return res.status(401).render('auth/login', { error: 'Invalid username or password' });
  }
  req.session.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role, agent_id: u.agent_id, client_id: u.client_id };
  logAction(req, 'login', 'user', u.id, `User ${u.username} logged in`);
  res.redirect('/');
});

router.get('/logout', (req, res) => {
  if (req.session.user) logAction(req, 'logout', 'user', req.session.user.id, `User ${req.session.user.username} logged out`);
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
```

- [ ] **Step 3: Create `src/views/auth/login.ejs`** (standalone, no sidebar)

```ejs
<!doctype html><html><head><meta charset="utf-8"><title>Login — Debt Collection CRM</title>
<link rel="stylesheet" href="/css/style.css"></head>
<body class="login-page">
  <form class="login-card" method="post" action="/login">
    <h1 class="brand">Debt Collection <span>CRM</span></h1>
    <% if (error) { %><div class="alert is-red"><%= error %></div><% } %>
    <label>Username <input name="username" autofocus required></label>
    <label>Password <input name="password" type="password" required></label>
    <button type="submit">Sign in</button>
    <p class="hint"><a href="/demo-accounts">View demo accounts</a></p>
  </form>
</body></html>
```

- [ ] **Step 4: Wire into `src/app.js`** — after session middleware add:
```js
const { attachUser } = require('./middleware/auth');
app.use(attachUser);
app.use(require('./routes/auth'));
```

- [ ] **Step 5: Manual smoke** — after Task 9 seed exists you can log in; for now verify `GET /login` renders (200) via curl. Expected: HTML containing "Sign in".

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: session auth, login/logout, rbac middleware"`

---

## Task 4: Layout, sidebar, base CSS

**Files:**
- Create: `src/views/layout.ejs`, `src/views/partials/sidebar.ejs`, `src/views/partials/flash.ejs`, `src/views/partials/statusBadge.ejs`, `src/views/partials/empty.ejs`, `public/css/style.css`

**Interfaces:**
- Consumes: `res.locals.currentUser`, helpers exposed as `res.locals.h`.
- Produces: every page uses `<% layout('layout') %>`; `h` helper object and `icon` available in all views.

- [ ] **Step 1: Expose helpers to all views** — in `src/app.js` after `attachUser`:
```js
const h = require('./utils/helpers');
app.use((req, res, next) => { res.locals.h = h; res.locals.query = req.query; res.locals.path = req.path; next(); });
```

- [ ] **Step 2: Create `src/views/layout.ejs`**

```ejs
<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title><%= typeof title !== 'undefined' ? title + ' — ' : '' %>Debt Collection CRM</title>
<link rel="stylesheet" href="/css/style.css">
</head><body class="app">
  <%- include('partials/sidebar') %>
  <main class="content">
    <%- include('partials/flash') %>
    <%- body %>
  </main>
</body></html>
```

- [ ] **Step 3: Create `src/views/partials/sidebar.ejs`** — role-based nav. Visibility per spec §5:

```ejs
<% const u = currentUser; const can = (roles) => roles.includes(u.role); %>
<aside class="sidebar">
  <div class="brand">Debt Collection <span>CRM</span></div>
  <nav>
    <a href="/" class="<%= path==='/'?'active':'' %>"><%- h.icon('dashboard') %> Dashboard</a>
    <% if (can(['admin','manager','finance','auditor'])) { %><a href="/clients" class="<%= path.startsWith('/clients')?'active':'' %>"><%- h.icon('clients') %> Clients</a><% } %>
    <% if (can(['admin','manager','agent','finance','auditor'])) { %><a href="/debtors" class="<%= path.startsWith('/debtors')?'active':'' %>"><%- h.icon('debtors') %> Debtors</a><% } %>
    <a href="/cases" class="<%= path.startsWith('/cases')?'active':'' %>"><%- h.icon('cases') %> Cases</a>
    <% if (can(['admin','manager','auditor'])) { %><a href="/agents" class="<%= path.startsWith('/agents')?'active':'' %>"><%- h.icon('agents') %> Agents</a><% } %>
    <a href="/tasks" class="<%= path.startsWith('/tasks')?'active':'' %>"><%- h.icon('tasks') %> Tasks</a>
    <a href="/reports" class="<%= path.startsWith('/reports')?'active':'' %>"><%- h.icon('reports') %> Reports</a>
    <% if (can(['admin','auditor'])) { %><a href="/audit-log" class="<%= path.startsWith('/audit')?'active':'' %>"><%- h.icon('audit') %> Audit Log</a><% } %>
    <a href="/search" class="<%= path.startsWith('/search')?'active':'' %>"><%- h.icon('search') %> Search</a>
  </nav>
  <div class="sidebar-foot">
    <div class="who"><strong><%= u.full_name %></strong><small><%= u.role %></small></div>
    <a class="logout" href="/logout"><%- h.icon('logout') %> Logout</a>
  </div>
</aside>
```

- [ ] **Step 4: Create `src/views/partials/flash.ejs`**
```ejs
<% if (query && query.ok) { %><div class="alert is-green"><%= query.ok %></div><% } %>
<% if (query && query.err) { %><div class="alert is-red"><%= query.err %></div><% } %>
```

- [ ] **Step 5: Create `src/views/partials/statusBadge.ejs`**
```ejs
<span class="badge <%= h.caseStatusClass(status) %>"><span class="dot"></span><%= h.caseStatusLabel(status) %></span>
```
And `src/views/partials/empty.ejs`:
```ejs
<div class="empty"><p><%= typeof msg !== 'undefined' ? msg : 'No records yet.' %></p></div>
```

- [ ] **Step 6: Create `public/css/style.css`** — implement the full design system. Include: CSS variables (verbatim from Global Constraints), `body.app{display:flex}`, `.sidebar` (bg `--ink`, width 240px, fixed, gold brand accent), `.content{flex:1;background:var(--paper);padding:28px}`, serif `h1/h2` via `--font-display`, mono for `.mono`/amounts, `table.data` (dense, right-aligned numeric cells `.num{font-family:var(--font-mono);text-align:right}`), `.badge`/`.dot` pills with `.is-green/.is-gold/.is-red/.is-blue/.is-neutral` color variants, `.card`, `.btn`/`.btn-gold`, `.alert`, `.login-page`/`.login-card`, form controls, `.kpi` grid for dashboard, `.bar` progress bars for reports, `.empty` state. Use only system fonts. (Full CSS ~250 lines — implementer writes complete styles matching these class names; no placeholders.)

- [ ] **Step 7: Manual smoke** — deferred until dashboard (Task 20) renders through layout. Verify CSS file served: `curl -s http://localhost:3000/css/style.css | head`.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat: layout, role-based sidebar, base CSS design system"`

---

## Task 5: Scope utility (row-level access) + tests

**Files:**
- Create: `src/utils/scope.js`, `test/scope.test.js`

**Interfaces:**
- Produces:
  - `caseWhere(user, alias='cases')` → `{ clause: string, params: any[] }`. For agent: `clause = 'cases.agent_id = ?'`, params `[user.agent_id]`; client: `'cases.client_id = ?'`, `[user.client_id]`; else `{ clause: '1=1', params: [] }`.
  - `reachableDebtorIds(user)` → array of debtor ids (all for unrestricted roles → returns `null` meaning "no restriction"); for agent/client returns `SELECT DISTINCT debtor_id FROM cases WHERE <scope>`.
  - `reachableClientIds(user)` → same for client_id; `null` = unrestricted.
  - `isScoped(user)` → boolean (true for agent/client).

- [ ] **Step 1: Write failing test `test/scope.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const scope = require('../src/utils/scope');

test('caseWhere unrestricted for admin', () => {
  const r = scope.caseWhere({ role: 'admin' });
  assert.strictEqual(r.clause, '1=1');
  assert.deepStrictEqual(r.params, []);
});
test('caseWhere for agent filters agent_id', () => {
  const r = scope.caseWhere({ role: 'agent', agent_id: 7 });
  assert.match(r.clause, /agent_id = \?/);
  assert.deepStrictEqual(r.params, [7]);
});
test('caseWhere for client filters client_id', () => {
  const r = scope.caseWhere({ role: 'client', client_id: 3 });
  assert.match(r.clause, /client_id = \?/);
  assert.deepStrictEqual(r.params, [3]);
});
test('isScoped', () => {
  assert.strictEqual(scope.isScoped({ role: 'agent' }), true);
  assert.strictEqual(scope.isScoped({ role: 'manager' }), false);
});
```

- [ ] **Step 2: Run to verify fail** — `npm test` → FAIL.

- [ ] **Step 3: Implement `src/utils/scope.js`**

```js
const { all } = require('../db');

const isScoped = (user) => user && (user.role === 'agent' || user.role === 'client');

function caseWhere(user, alias = 'cases') {
  if (!user) return { clause: '1=0', params: [] };
  if (user.role === 'agent') return { clause: `${alias}.agent_id = ?`, params: [user.agent_id] };
  if (user.role === 'client') return { clause: `${alias}.client_id = ?`, params: [user.client_id] };
  return { clause: '1=1', params: [] };
}
function reachableDebtorIds(user) {
  if (!isScoped(user)) return null;
  const w = caseWhere(user);
  return all(`SELECT DISTINCT debtor_id FROM cases WHERE ${w.clause}`, w.params).map((r) => r.debtor_id);
}
function reachableClientIds(user) {
  if (!isScoped(user)) return null;
  const w = caseWhere(user);
  return all(`SELECT DISTINCT client_id FROM cases WHERE ${w.clause}`, w.params).map((r) => r.client_id);
}
module.exports = { isScoped, caseWhere, reachableDebtorIds, reachableClientIds };
```

- [ ] **Step 4: Run to verify pass** — `npm test` → pass.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: row-level scope utility + tests"`

---

## Task 6: Numbering utility + tests

**Files:**
- Create: `src/utils/numbering.js`, `test/numbering.test.js`

**Interfaces:**
- Produces: `nextCaseNo()` → `CASE-YYYY-####`, `nextReceiptNo()` → `RCPT-YYYY-####`. Sequence = (count of rows whose no starts with prefix for current year) + 1, zero-padded to 4.

- [ ] **Step 1: Write failing test `test/numbering.test.js`** (uses in-memory-ish real db; seed a temp row)

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { init, run, exec } = require('../src/db');
init();
const numbering = require('../src/utils/numbering');

test('nextCaseNo format and increment', () => {
  const year = new Date().getFullYear();
  const first = numbering.nextCaseNo();
  assert.match(first, new RegExp(`^CASE-${year}-\\d{4}$`));
});
test('nextReceiptNo format', () => {
  const year = new Date().getFullYear();
  assert.match(numbering.nextReceiptNo(), new RegExp(`^RCPT-${year}-\\d{4}$`));
});
```
> Note: tests run against the real `data/crm.db`; they assert format, not absolute counts (count depends on seed state).

- [ ] **Step 2: Run to verify fail** — `npm test` → FAIL.

- [ ] **Step 3: Implement `src/utils/numbering.js`**

```js
const { get } = require('../db');
function pad(n) { return String(n).padStart(4, '0'); }
function nextCaseNo() {
  const year = new Date().getFullYear();
  const prefix = `CASE-${year}-`;
  const row = get('SELECT COUNT(*) AS c FROM cases WHERE case_no LIKE ?', [prefix + '%']);
  return prefix + pad(row.c + 1);
}
function nextReceiptNo() {
  const year = new Date().getFullYear();
  const prefix = `RCPT-${year}-`;
  const row = get('SELECT COUNT(*) AS c FROM payments WHERE receipt_no LIKE ?', [prefix + '%']);
  return prefix + pad(row.c + 1);
}
module.exports = { nextCaseNo, nextReceiptNo };
```

- [ ] **Step 4: Run to verify pass** — `npm test` → pass.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: year-sequential case/receipt numbering + tests"`

---

## Task 7: Payment service (outstanding recompute + status linkage) + tests

**Files:**
- Create: `src/services/payments.js`, `test/payments.test.js`

**Interfaces:**
- Consumes: `db`, `numbering.nextReceiptNo`, `helpers`, timeline insert.
- Produces:
  - `TERMINAL_STATUSES` (array).
  - `recomputeOutstanding(caseId)` → number: `max(0, principal+interest - SUM(payments))`, writes it to `cases.outstanding_amount`, returns it.
  - `statusAfterPayment(currentStatus, outstanding, paymentCount)` → new status string (pure, testable): if current in TERMINAL → unchanged; else outstanding===0 → 'fully_paid'; else paymentCount>0 → 'partial_paid'; else unchanged.
  - `applyPayment(caseId, { payment_date, amount, method, reference, bank, remark }, req)` → inserts payment row (with generated receipt_no), recomputes outstanding, updates status per `statusAfterPayment`, writes timeline `event_type='payment'`, audits. Returns `{ receipt_no, outstanding, status }`.

- [ ] **Step 1: Write failing test `test/payments.test.js`** — focus on the pure function (no DB needed):

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { statusAfterPayment, TERMINAL_STATUSES } = require('../src/services/payments');

test('terminal statuses are not overwritten', () => {
  for (const s of ['legal', 'closed', 'cancelled', 'bankruptcy', 'deceased']) {
    assert.strictEqual(statusAfterPayment(s, 0, 1), s);
  }
});
test('outstanding zero -> fully_paid', () => {
  assert.strictEqual(statusAfterPayment('negotiation', 0, 2), 'fully_paid');
});
test('outstanding remaining with payments -> partial_paid', () => {
  assert.strictEqual(statusAfterPayment('assigned', 500, 1), 'partial_paid');
});
test('no payments yet -> unchanged', () => {
  assert.strictEqual(statusAfterPayment('new', 1000, 0), 'new');
});
```

- [ ] **Step 2: Run to verify fail** — `npm test` → FAIL.

- [ ] **Step 3: Implement `src/services/payments.js`**

```js
const { get, run } = require('../db');
const { nextReceiptNo } = require('../utils/numbering');
const { logAction } = require('../utils/audit');

const TERMINAL_STATUSES = ['legal', 'closed', 'cancelled', 'bankruptcy', 'deceased'];

function statusAfterPayment(current, outstanding, paymentCount) {
  if (TERMINAL_STATUSES.includes(current)) return current;
  if (outstanding === 0) return 'fully_paid';
  if (paymentCount > 0) return 'partial_paid';
  return current;
}
function recomputeOutstanding(caseId) {
  const c = get('SELECT principal_amount, interest_amount FROM cases WHERE id = ?', [caseId]);
  const paid = get('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE case_id = ?', [caseId]).s;
  const outstanding = Math.max(0, (c.principal_amount + c.interest_amount) - paid);
  run('UPDATE cases SET outstanding_amount = ?, updated_at = datetime(\'now\') WHERE id = ?', [outstanding, caseId]);
  return outstanding;
}
function applyPayment(caseId, p, req) {
  const receipt_no = nextReceiptNo();
  const by = req.session.user.full_name;
  run(`INSERT INTO payments (case_id, receipt_no, payment_date, amount, method, reference, bank, remark, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    [caseId, receipt_no, p.payment_date, Number(p.amount), p.method || 'bank_transfer', p.reference || null, p.bank || null, p.remark || null, by]);
  const outstanding = recomputeOutstanding(caseId);
  const cnt = get('SELECT COUNT(*) AS c FROM payments WHERE case_id = ?', [caseId]).c;
  const cur = get('SELECT status FROM cases WHERE id = ?', [caseId]).status;
  const next = statusAfterPayment(cur, outstanding, cnt);
  if (next !== cur) run('UPDATE cases SET status = ? WHERE id = ?', [next, caseId]);
  run(`INSERT INTO timeline_events (case_id, event_type, content, created_by) VALUES (?,?,?,?)`,
    [caseId, 'payment', `Payment ${receipt_no}: RM ${Number(p.amount).toFixed(2)} via ${p.method || 'bank_transfer'}`, by]);
  logAction(req, 'payment', 'case', caseId, `Recorded payment ${receipt_no} amount ${p.amount}`);
  return { receipt_no, outstanding, status: next };
}
module.exports = { TERMINAL_STATUSES, statusAfterPayment, recomputeOutstanding, applyPayment };
```

- [ ] **Step 4: Run to verify pass** — `npm test` → pass.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: payment service with outstanding recompute + status linkage + tests"`

---

## Task 8: Audit utility

**Files:**
- Create: `src/utils/audit.js`

**Interfaces:**
- Produces: `logAction(req, action, entityType, entityId, details)` → inserts into `audit_logs` with `username` from `req.session.user` (or null), `ip_address` from `req.ip`. Never throws (wrap in try/catch, log to console on error).

> Build this before Task 3 and Task 7 (they require it).

- [ ] **Step 1: Implement `src/utils/audit.js`**

```js
const { run } = require('../db');
function logAction(req, action, entityType, entityId, details) {
  try {
    const username = req && req.session && req.session.user ? req.session.user.username : null;
    const ip = req ? req.ip : null;
    run(`INSERT INTO audit_logs (username, action, entity_type, entity_id, details, ip_address)
         VALUES (?,?,?,?,?,?)`, [username, action, entityType, entityId || null, details || null, ip]);
  } catch (e) { console.error('audit failed:', e.message); }
}
module.exports = { logAction };
```

- [ ] **Step 2: Verify require works** — `node -e "require('./src/utils/audit')"` → no error.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: audit logAction utility"`

---

## Task 9: Seed data

**Files:**
- Create: `src/db/seed.js`

**Interfaces:**
- Consumes: `db`, `bcryptjs`, `dayjs`.
- Produces: `npm run seed` populating: 6 users (admin/manager/agent1-3/finance/auditor/client1), 5 clients, 12 debtors, 4 agents, 20 cases covering all 11 statuses, plus payments/ptps/call_logs/tasks/timeline_events/audit_logs. Idempotent-ish: it DROPs & recreates or clears tables first.

- [ ] **Step 1: Implement `src/db/seed.js`**

```js
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const { db, init, run, get } = require('./index');

init();
// Clear (respect FK order)
for (const t of ['audit_logs','call_logs','tasks','ptps','payments','timeline_events','cases','debtors','agents','clients','users']) {
  db.exec(`DELETE FROM ${t}`);
  db.exec(`DELETE FROM sqlite_sequence WHERE name='${t}'`);
}
const hash = (pw) => bcrypt.hashSync(pw, 8);
const ago = (d) => dayjs().subtract(d, 'day').format('YYYY-MM-DD HH:mm:ss');
const inDays = (d) => dayjs().add(d, 'day').format('YYYY-MM-DD');

// --- Agents (4) ---
const agents = [
  ['Lim Wei Sheng', '012-3456789', 'Consumer', 500000, 5],
  ['Nurul Ain', '013-2233445', 'Consumer', 450000, 5],
  ['Rajesh Kumar', '016-7788990', 'Commercial', 700000, 6],
  ['Tan Mei Ling', '017-5566778', 'Legal', 300000, 4],
];
agents.forEach((a) => run('INSERT INTO agents (name,contact,department,target_amount,commission_rate) VALUES (?,?,?,?,?)', a));

// --- Clients (5, multi-industry) ---
const clients = [
  ['Sinar Consumer Credit Sdn Bhd','Ms. Chong','03-77001122','ar@sinar.my','AGR-2023-001',15],
  ['DriveMax Auto Financing','Mr. Fauzi','03-88002233','collections@drivemax.my','AGR-2023-002',12],
  ['CardOne Bank Berhad','Ms. Priya','03-99003344','recovery@cardone.my','AGR-2022-118',18],
  ['GreenVista Property Mgmt','Mr. Lee','03-66004455','admin@greenvista.my','AGR-2024-045',10],
  ['QuickCash Microloans','Ms. Siti','03-55005566','ops@quickcash.my','AGR-2024-060',20],
];
clients.forEach((c) => run('INSERT INTO clients (company_name,pic_name,phone,email,agreement_no,commission_rate) VALUES (?,?,?,?,?,?)', c));

// --- Debtors (12, with guarantors, mixed risk) ---
const debtors = [
  ['Ahmad bin Ismail','880101-14-5501','','019-1112223','ahmad@mail.my','12 Jln Bunga, KL','ABC Sdn Bhd',4200,'high','Ismail bin Omar','019-9990001'],
  ['Sarah Lim','900215-10-5522','','012-2223334','sarah.l@mail.my','8 Jln Mawar, PJ','Retail Co',3500,'medium','Lim Ah Kow','012-8880002'],
  ['Ravi Chandran','850320-08-5533','','016-3334445','ravi@mail.my','5 Lorong Melur, Ipoh','Tech Sol',6800,'low','',''],
  ['Nadia Hassan','920510-14-5544','','017-4445556','nadia@mail.my','21 Jln Kenanga, KL','','2800','high','Hassan bin Ali','017-7770003'],
  ['Wong Kar Wai','780612-05-5555','','013-5556667','wong@mail.my','3 Jln Cempaka, JB','WKW Trading',9500,'medium','',''],
  ['Farah Aziz','950701-14-5566','','018-6667778','farah@mail.my','7 Jln Teratai, KL','Clinic MY',5200,'low','Aziz bin Rahman','018-6660004'],
  ['Tan Boon Huat','830825-07-5577','','019-7778889','tanbh@mail.my','15 Jln Anggerik, Penang','',4000,'high','',''],
  ['Kavitha Nair','890903-10-5588','','012-8889990','kavitha@mail.my','9 Jln Seroja, PJ','Nair Ent',7100,'medium','Nair Suresh','012-5550005'],
  ['Muhammad Faiz','910128-14-5599','','016-9990001','faiz@mail.my','2 Jln Dahlia, KL','',3300,'high','Zainab bt Yusof','016-3330006'],
  ['Lee Chong Wei','870417-05-5610','','017-1011121','lcw@mail.my','18 Jln Melati, JB','LCW Sports',12000,'low','',''],
  ['Aisyah Rahman','930922-14-5621','','018-2022232','aisyah@mail.my','6 Jln Kemuning, KL','',2600,'medium','Rahman bin Salleh','018-2220007'],
  ['Ganesh Pillai','800511-08-5632','','019-3033343','ganesh@mail.my','11 Jln Cendana, Ipoh','GP Logistics',8800,'high','',''],
];
debtors.forEach((d) => run('INSERT INTO debtors (name,ic_passport,company,phone,email,address,employer,salary,risk_level,guarantor_name,guarantor_phone) VALUES (?,?,?,?,?,?,?,?,?,?,?)', d));

// --- Cases (20 covering all 11 statuses) ---
const statuses = ['new','assigned','negotiation','ptp','partial_paid','fully_paid','legal','closed','cancelled','bankruptcy','deceased','new','assigned','negotiation','ptp','partial_paid','legal','fully_paid','assigned','negotiation'];
const prios = ['low','medium','high','urgent'];
let caseId = 1;
statuses.forEach((st, i) => {
  const year = dayjs().year();
  const case_no = `CASE-${year}-${String(i + 1).padStart(4, '0')}`;
  const client_id = (i % 5) + 1;
  const debtor_id = (i % 12) + 1;
  const agent_id = st === 'new' ? null : (i % 4) + 1;
  const principal = 2000 + (i * 850) % 15000;
  const interest = Math.round(principal * 0.08);
  let outstanding = principal + interest;
  if (st === 'fully_paid') outstanding = 0;
  else if (st === 'partial_paid') outstanding = Math.round((principal + interest) * 0.5);
  run(`INSERT INTO cases (case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,priority,status,opened_at,closed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [case_no, client_id, debtor_id, agent_id, principal, interest, outstanding, prios[i % 4], st, ago(60 - i),
     ['fully_paid','closed','cancelled'].includes(st) ? ago(5) : null]);
  // timeline seed
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)', [caseId,'note',`Case opened, status ${st}`,'System']);
  caseId++;
});

// --- Payments (for partial_paid + fully_paid cases) ---
db.prepare("SELECT id,principal_amount,interest_amount,status FROM cases WHERE status IN ('partial_paid','fully_paid')").all().forEach((c, idx) => {
  const total = c.principal_amount + c.interest_amount;
  const amt = c.status === 'fully_paid' ? total : Math.round(total * 0.5);
  const year = dayjs().year();
  run('INSERT INTO payments (case_id,receipt_no,payment_date,amount,method,reference,bank,created_by) VALUES (?,?,?,?,?,?,?,?)',
    [c.id, `RCPT-${year}-${String(idx + 1).padStart(4, '0')}`, ago(10), amt, 'bank_transfer', 'TXN' + (1000 + idx), 'Maybank', 'Finance Officer']);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)', [c.id,'payment',`Payment received RM ${amt.toFixed(2)}`,'Finance Officer']);
});

// --- PTPs (pending + fulfilled + broken) ---
const ptpSeed = [[4,3000,inDays(5),'pending'],[3,2500,ago(3),'broken'],[5,4000,ago(15),'fulfilled'],[14,1800,inDays(10),'pending']];
ptpSeed.forEach((p) => {
  run('INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (?,?,?,?,?)', [...p,'Agent']);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)', [p[0], p[3]==='broken'?'ptp_broken':p[3]==='fulfilled'?'ptp_fulfilled':'ptp_created', `PTP RM ${p[1]} due ${p[2]}`, 'Agent']);
});

// --- Call logs ---
const callSeed = [[2,1,180,'answered'],[3,2,0,'no_answer'],[4,1,60,'refused'],[7,3,240,'answered'],[13,2,0,'busy'],[16,4,90,'answered']];
callSeed.forEach((c) => run('INSERT INTO call_logs (case_id,agent_id,duration_seconds,result,notes) VALUES (?,?,?,?,?)', [...c,'Follow-up call']));

// --- Tasks ---
const taskSeed = [[2,1,'follow_up','Call debtor re: overdue',inDays(1),'pending'],[3,2,'visit','Field visit to address',ago(1),'pending'],[7,3,'legal','Prepare LOD',inDays(3),'pending'],[5,1,'reminder','Send WhatsApp reminder',inDays(0),'done']];
taskSeed.forEach((t) => run('INSERT INTO tasks (case_id,agent_id,type,title,due_date,status) VALUES (?,?,?,?,?,?)', t));

// --- Users (6 roles) ---
run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['admin',hash('admin123'),'System Admin','admin',null,null]);
run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['manager',hash('manager123'),'Collection Manager','manager',null,null]);
['agent1','agent2','agent3'].forEach((u,i)=>run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', [u,hash('agent123'),agents[i][0],'agent',i+1,null]));
run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['finance',hash('finance123'),'Finance Officer','finance',null,null]);
run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['auditor',hash('auditor123'),'Compliance Auditor','auditor',null,null]);
run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['client1',hash('client123'),'Sinar Consumer Credit','client',null,1]);

// --- Audit sample ---
run("INSERT INTO audit_logs (username,action,entity_type,entity_id,details) VALUES ('admin','seed','system',NULL,'Demo data seeded')");
console.log('Seed complete: 6 users, 5 clients, 12 debtors, 4 agents, 20 cases + related data.');
```

- [ ] **Step 2: Run seed** — `npm run seed`
Expected: "Seed complete..." and no errors. Verify: `node -e "const{get}=require('./src/db');require('./src/db').init();console.log(get('SELECT COUNT(*) c FROM cases').c)"` → 20.

- [ ] **Step 3: Verify all 11 statuses present** — `node -e "const d=require('./src/db');d.init();console.log(d.all('SELECT DISTINCT status FROM cases').map(r=>r.status).sort().join(','))"` → contains all 11.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: demo seed data (all modules populated)"`

---

## Task 10: Clients module (CRUD) — CRUD template for the app

**Files:**
- Create: `src/routes/clients.js`, `src/views/clients/list.ejs`, `src/views/clients/form.ejs`, `src/views/clients/show.ejs`
- Modify: `src/app.js` (mount)

**Interfaces:**
- Consumes: `db`, `requireLogin`, `requireRole`, `logAction`, helpers.
- Produces: routes `GET /clients`, `/clients/new`, `POST /clients`, `GET /clients/:id`, `/clients/:id/edit`, `POST /clients/:id`. Visible to admin/manager/finance/auditor. auditor is read-only (hide/deny create+edit).

- [ ] **Step 1: Implement `src/routes/clients.js`**

```js
const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const router = express.Router();

const canView = requireRole('admin', 'manager', 'finance', 'auditor');
const canEdit = requireRole('admin', 'manager');

router.get('/', requireLogin, canView, (req, res) => {
  const clients = all(`SELECT c.*, (SELECT COUNT(*) FROM cases WHERE client_id=c.id) AS case_count
                       FROM clients c ORDER BY c.company_name`);
  res.render('clients/list', { title: 'Clients', clients });
});
router.get('/new', requireLogin, canEdit, (req, res) => res.render('clients/form', { title: 'New Client', client: {}, action: '/clients' }));
router.post('/', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  const r = run(`INSERT INTO clients (company_name,pic_name,phone,email,agreement_no,commission_rate,remark)
                 VALUES (?,?,?,?,?,?,?)`, [b.company_name, b.pic_name, b.phone, b.email, b.agreement_no, Number(b.commission_rate)||15, b.remark]);
  logAction(req, 'create', 'client', r.lastInsertRowid, `Created client ${b.company_name}`);
  res.redirect('/clients?ok=Client+created');
});
router.get('/:id', requireLogin, canView, (req, res) => {
  const client = get('SELECT * FROM clients WHERE id=?', [req.params.id]);
  if (!client) return res.status(404).render('error', { message: 'Client not found' });
  const cases = all('SELECT * FROM cases WHERE client_id=? ORDER BY opened_at DESC', [req.params.id]);
  res.render('clients/show', { title: client.company_name, client, cases });
});
router.get('/:id/edit', requireLogin, canEdit, (req, res) => {
  const client = get('SELECT * FROM clients WHERE id=?', [req.params.id]);
  if (!client) return res.status(404).render('error', { message: 'Client not found' });
  res.render('clients/form', { title: 'Edit Client', client, action: `/clients/${client.id}` });
});
router.post('/:id', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  run(`UPDATE clients SET company_name=?,pic_name=?,phone=?,email=?,agreement_no=?,commission_rate=?,remark=? WHERE id=?`,
    [b.company_name, b.pic_name, b.phone, b.email, b.agreement_no, Number(b.commission_rate)||15, b.remark, req.params.id]);
  logAction(req, 'update', 'client', Number(req.params.id), `Updated client ${b.company_name}`);
  res.redirect(`/clients/${req.params.id}?ok=Saved`);
});
module.exports = router;
```

- [ ] **Step 2: Create `src/views/clients/list.ejs`**

```ejs
<% layout('layout') -%>
<div class="page-head"><h1>Clients</h1>
  <% if (['admin','manager'].includes(currentUser.role)) { %><a class="btn btn-gold" href="/clients/new">+ New Client</a><% } %>
</div>
<% if (!clients.length) { %><%- include('../partials/empty', { msg: 'No clients yet.' }) %><% } else { %>
<table class="data"><thead><tr><th>Company</th><th>PIC</th><th>Phone</th><th class="num">Commission %</th><th class="num">Cases</th></tr></thead>
<tbody><% clients.forEach(c => { %>
<tr><td><a href="/clients/<%= c.id %>"><%= c.company_name %></a></td><td><%= c.pic_name||'' %></td><td class="mono"><%= c.phone||'' %></td>
<td class="num"><%= c.commission_rate %></td><td class="num"><%= c.case_count %></td></tr>
<% }) %></tbody></table><% } %>
```

- [ ] **Step 3: Create `src/views/clients/form.ejs`**

```ejs
<% layout('layout') -%>
<div class="page-head"><h1><%= title %></h1></div>
<form class="card form" method="post" action="<%= action %>">
  <label>Company Name <input name="company_name" value="<%= client.company_name||'' %>" required></label>
  <label>PIC Name <input name="pic_name" value="<%= client.pic_name||'' %>"></label>
  <label>Phone <input name="phone" value="<%= client.phone||'' %>"></label>
  <label>Email <input name="email" type="email" value="<%= client.email||'' %>"></label>
  <label>Agreement No <input name="agreement_no" value="<%= client.agreement_no||'' %>"></label>
  <label>Commission % <input name="commission_rate" type="number" step="0.1" value="<%= client.commission_rate!=null?client.commission_rate:15 %>"></label>
  <label>Remark <textarea name="remark"><%= client.remark||'' %></textarea></label>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Save</button><a class="btn" href="/clients">Cancel</a></div>
</form>
```

- [ ] **Step 4: Create `src/views/clients/show.ejs`**

```ejs
<% layout('layout') -%>
<div class="page-head"><h1><%= client.company_name %></h1>
  <% if (['admin','manager'].includes(currentUser.role)) { %><a class="btn" href="/clients/<%= client.id %>/edit">Edit</a><% } %>
</div>
<div class="card kv">
  <div><span>PIC</span><%= client.pic_name||'—' %></div><div><span>Phone</span><span class="mono"><%= client.phone||'—' %></span></div>
  <div><span>Email</span><%= client.email||'—' %></div><div><span>Agreement</span><%= client.agreement_no||'—' %></div>
  <div><span>Commission</span><%= client.commission_rate %>%</div>
</div>
<h2>Cases</h2>
<% if (!cases.length) { %><%- include('../partials/empty', { msg: 'No cases for this client.' }) %><% } else { %>
<table class="data"><thead><tr><th>Case No</th><th class="num">Outstanding</th><th>Status</th></tr></thead><tbody>
<% cases.forEach(c => { %><tr><td><a href="/cases/<%= c.id %>" class="mono"><%= c.case_no %></a></td>
<td class="num"><%= h.money(c.outstanding_amount) %></td><td><%- include('../partials/statusBadge', { status: c.status }) %></td></tr><% }) %>
</tbody></table><% } %>
```

- [ ] **Step 5: Mount in `src/app.js`** — at route mount point:
```js
const { requireLogin } = require('./middleware/auth');
app.use('/clients', require('./routes/clients'));
```

- [ ] **Step 6: Manual smoke** — start server, log in as `manager/manager123`, visit `/clients`, create one, edit it, view detail. Expected: list shows 5 seeded + new one; audit row written.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: clients CRUD module"`

---

## Task 11: Debtors module (CRUD, with guarantor)

**Files:**
- Create: `src/routes/debtors.js`, `src/views/debtors/list.ejs`, `src/views/debtors/form.ejs`, `src/views/debtors/show.ejs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `scope.reachableDebtorIds`, requireRole('admin','manager','agent','finance','auditor'), edit limited to admin/manager/agent.
- Produces: `GET /debtors` (list, scoped for agent), `/debtors/new`, `POST /debtors`, `/debtors/:id`, `/debtors/:id/edit`, `POST /debtors/:id`. Fields include guarantor_name, guarantor_phone, risk_level, salary, employer.

- [ ] **Step 1: Implement `src/routes/debtors.js`**

```js
const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { reachableDebtorIds } = require('../utils/scope');
const router = express.Router();

const canView = requireRole('admin','manager','agent','finance','auditor');
const canEdit = requireRole('admin','manager','agent');

router.get('/', requireLogin, canView, (req, res) => {
  const ids = reachableDebtorIds(req.session.user); // null = unrestricted
  let debtors;
  if (ids === null) debtors = all('SELECT * FROM debtors ORDER BY name');
  else if (ids.length === 0) debtors = [];
  else debtors = all(`SELECT * FROM debtors WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY name`, ids);
  res.render('debtors/list', { title: 'Debtors', debtors });
});
router.get('/new', requireLogin, canEdit, (req, res) => res.render('debtors/form', { title: 'New Debtor', debtor: {}, action: '/debtors' }));
router.post('/', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  const r = run(`INSERT INTO debtors (name,ic_passport,company,phone,email,address,employer,salary,risk_level,guarantor_name,guarantor_phone,remark)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.name,b.ic_passport,b.company,b.phone,b.email,b.address,b.employer,Number(b.salary)||null,b.risk_level||'medium',b.guarantor_name,b.guarantor_phone,b.remark]);
  logAction(req,'create','debtor',r.lastInsertRowid,`Created debtor ${b.name}`);
  res.redirect('/debtors?ok=Debtor+created');
});
router.get('/:id', requireLogin, canView, (req, res) => {
  const debtor = get('SELECT * FROM debtors WHERE id=?', [req.params.id]);
  if (!debtor) return res.status(404).render('error', { message: 'Debtor not found' });
  const ids = reachableDebtorIds(req.session.user);
  if (ids !== null && !ids.includes(debtor.id)) return res.status(403).render('error', { message: 'Forbidden' });
  const cases = all('SELECT * FROM cases WHERE debtor_id=? ORDER BY opened_at DESC', [req.params.id]);
  res.render('debtors/show', { title: debtor.name, debtor, cases });
});
router.get('/:id/edit', requireLogin, canEdit, (req, res) => {
  const debtor = get('SELECT * FROM debtors WHERE id=?', [req.params.id]);
  if (!debtor) return res.status(404).render('error', { message: 'Debtor not found' });
  res.render('debtors/form', { title: 'Edit Debtor', debtor, action: `/debtors/${debtor.id}` });
});
router.post('/:id', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  run(`UPDATE debtors SET name=?,ic_passport=?,company=?,phone=?,email=?,address=?,employer=?,salary=?,risk_level=?,guarantor_name=?,guarantor_phone=?,remark=? WHERE id=?`,
    [b.name,b.ic_passport,b.company,b.phone,b.email,b.address,b.employer,Number(b.salary)||null,b.risk_level||'medium',b.guarantor_name,b.guarantor_phone,b.remark,req.params.id]);
  logAction(req,'update','debtor',Number(req.params.id),`Updated debtor ${b.name}`);
  res.redirect(`/debtors/${req.params.id}?ok=Saved`);
});
module.exports = router;
```

- [ ] **Step 2: Create `src/views/debtors/list.ejs`** — table: Name (link), IC/Passport (mono), Phone (mono), Employer, Salary (num), Risk (badge). Risk badge: `<span class="badge <%= debtor.risk_level==='high'?'is-red':debtor.risk_level==='low'?'is-green':'is-gold' %>">`. Empty state via partial. New button for admin/manager/agent.

- [ ] **Step 3: Create `src/views/debtors/form.ejs`** — inputs for all fields; risk_level as `<select>` (low/medium/high); a fieldset "Guarantor" grouping guarantor_name + guarantor_phone; salary as number. Save/Cancel actions. (Follow clients/form.ejs structure exactly.)

- [ ] **Step 4: Create `src/views/debtors/show.ejs`** — `.kv` card with all debtor fields incl. guarantor block and risk badge; then "Cases" table (case_no link, outstanding, status badge) like clients/show.ejs.

- [ ] **Step 5: Mount** — `app.use('/debtors', require('./routes/debtors'));`

- [ ] **Step 6: Manual smoke** — log in as `agent1/agent123`, visit `/debtors` → sees only debtors from agent1's cases; log in as manager → sees all 12. Create/edit as manager works.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: debtors CRUD with guarantor + scope"`

---

## Task 12: Cases module — list+filter, new, edit, detail shell

**Files:**
- Create: `src/routes/cases.js`, `src/views/cases/list.ejs`, `src/views/cases/form.ejs`, `src/views/cases/show.ejs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `scope.caseWhere`, `numbering.nextCaseNo`, `payments.recomputeOutstanding` (for edit), helpers, `TERMINAL_STATUSES`.
- Produces: `GET /cases` (filter by status/priority/q via querystring, scoped), `/cases/new`, `POST /cases`, `GET /cases/:id` (detail shell — timeline/payments/ptps/tasks assembled here), `/cases/:id/edit`, `POST /cases/:id`. Detail-page action routes (payments/ptps/calls/notes/status) added in Tasks 13-16, mounted on this same router.
- Produces (for Tasks 13-16): a shared `loadCase(req,res)` helper that fetches the case with joined client/debtor/agent names and enforces scope (403 if out of scope); returns the case row or null after responding.

- [ ] **Step 1: Implement `src/routes/cases.js` (list/new/edit/show)**

```js
const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { caseWhere } = require('../utils/scope');
const { nextCaseNo, nextReceiptNo } = require('../utils/numbering');
const { recomputeOutstanding, TERMINAL_STATUSES } = require('../services/payments');
const router = express.Router();

const CASE_STATUSES = ['new','assigned','negotiation','ptp','partial_paid','fully_paid','legal','closed','cancelled','bankruptcy','deceased'];
const PRIORITIES = ['low','medium','high','urgent'];
const noAgentCreate = requireRole('admin','manager'); // who can create/edit cases

// shared loader with scope enforcement
function loadCase(req, res) {
  const w = caseWhere(req.session.user);
  const c = get(`SELECT cases.*, clients.company_name AS client_name, debtors.name AS debtor_name,
    debtors.phone AS debtor_phone, debtors.ic_passport, agents.name AS agent_name
    FROM cases JOIN clients ON clients.id=cases.client_id JOIN debtors ON debtors.id=cases.debtor_id
    LEFT JOIN agents ON agents.id=cases.agent_id WHERE cases.id=? AND ${w.clause}`, [req.params.id, ...w.params]);
  if (!c) { res.status(404).render('error', { message: 'Case not found or access denied' }); return null; }
  return c;
}

router.get('/', requireLogin, (req, res) => {
  const w = caseWhere(req.session.user);
  const filters = [w.clause]; const params = [...w.params];
  if (req.query.status) { filters.push('cases.status = ?'); params.push(req.query.status); }
  if (req.query.priority) { filters.push('cases.priority = ?'); params.push(req.query.priority); }
  if (req.query.q) { filters.push('(cases.case_no LIKE ? OR debtors.name LIKE ?)'); params.push('%'+req.query.q+'%','%'+req.query.q+'%'); }
  const cases = all(`SELECT cases.*, clients.company_name AS client_name, debtors.name AS debtor_name, agents.name AS agent_name
    FROM cases JOIN clients ON clients.id=cases.client_id JOIN debtors ON debtors.id=cases.debtor_id
    LEFT JOIN agents ON agents.id=cases.agent_id WHERE ${filters.join(' AND ')} ORDER BY cases.opened_at DESC`, params);
  res.render('cases/list', { title: 'Cases', cases, statuses: CASE_STATUSES, priorities: PRIORITIES });
});

router.get('/new', requireLogin, noAgentCreate, (req, res) => {
  res.render('cases/form', { title: 'New Case', c: {}, action: '/cases',
    clients: all('SELECT id,company_name FROM clients ORDER BY company_name'),
    debtors: all('SELECT id,name FROM debtors ORDER BY name'),
    agents: all('SELECT id,name FROM agents WHERE active=1 ORDER BY name'),
    statuses: CASE_STATUSES, priorities: PRIORITIES });
});
router.post('/', requireLogin, noAgentCreate, (req, res) => {
  const b = req.body;
  const principal = Number(b.principal_amount)||0, interest = Number(b.interest_amount)||0;
  const case_no = nextCaseNo();
  const r = run(`INSERT INTO cases (case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,priority,status,remark)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [case_no, b.client_id, b.debtor_id, b.agent_id||null, principal, interest, principal+interest, b.priority||'medium', b.status||'new', b.remark]);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)', [r.lastInsertRowid,'note',`Case ${case_no} created`,req.session.user.full_name]);
  logAction(req,'create','case',r.lastInsertRowid,`Created case ${case_no}`);
  res.redirect(`/cases/${r.lastInsertRowid}?ok=Case+created`);
});
router.get('/:id/edit', requireLogin, noAgentCreate, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  res.render('cases/form', { title: 'Edit Case', c, action: `/cases/${c.id}`,
    clients: all('SELECT id,company_name FROM clients ORDER BY company_name'),
    debtors: all('SELECT id,name FROM debtors ORDER BY name'),
    agents: all('SELECT id,name FROM agents WHERE active=1 ORDER BY name'),
    statuses: CASE_STATUSES, priorities: PRIORITIES });
});
router.post('/:id', requireLogin, noAgentCreate, (req, res) => {
  const b = req.body;
  const principal = Number(b.principal_amount)||0, interest = Number(b.interest_amount)||0;
  run(`UPDATE cases SET client_id=?,debtor_id=?,agent_id=?,principal_amount=?,interest_amount=?,priority=?,remark=?,updated_at=datetime('now') WHERE id=?`,
    [b.client_id,b.debtor_id,b.agent_id||null,principal,interest,b.priority,b.remark,req.params.id]);
  recomputeOutstanding(Number(req.params.id));
  logAction(req,'update','case',Number(req.params.id),`Updated case ${req.params.id}`);
  res.redirect(`/cases/${req.params.id}?ok=Saved`);
});

router.get('/:id', requireLogin, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const timeline = all('SELECT * FROM timeline_events WHERE case_id=? ORDER BY created_at DESC', [c.id]);
  const payments = all('SELECT * FROM payments WHERE case_id=? ORDER BY payment_date DESC', [c.id]);
  const ptps = all('SELECT * FROM ptps WHERE case_id=? ORDER BY due_date DESC', [c.id]);
  const tasks = all('SELECT * FROM tasks WHERE case_id=? ORDER BY due_date', [c.id]);
  const calls = all('SELECT * FROM call_logs WHERE case_id=? ORDER BY call_time DESC', [c.id]);
  res.render('cases/show', { title: c.case_no, c, timeline, payments, ptps, tasks, calls,
    statuses: CASE_STATUSES, terminal: TERMINAL_STATUSES,
    readOnly: ['auditor','client'].includes(req.session.user.role) });
});

module.exports = { router, loadCase };
```
> Note: this module exports `{ router, loadCase }` so Tasks 13-16 can `require('./cases').loadCase`. Update the mount accordingly.

- [ ] **Step 2: Create `src/views/cases/list.ejs`** — filter bar (GET form with status `<select>`, priority `<select>`, text `q`), then table: Case No (mono link), Client, Debtor, Agent, Outstanding (num), Priority (badge), Status (statusBadge partial). Preserve current filter values from `query`. Empty state partial. "New Case" button for admin/manager only.

- [ ] **Step 3: Create `src/views/cases/form.ejs`** — selects for client_id/debtor_id/agent_id (options from passed arrays, mark selected when editing), number inputs principal_amount/interest_amount, priority select, status select (only shown on new; on edit status changed via detail page), remark textarea. Save/Cancel.

- [ ] **Step 4: Create `src/views/cases/show.ejs` (detail shell)** — Header: case_no + status badge + Edit button (admin/manager). Two-column: left `.kv` card (client_name link, debtor_name link + phone + IC, agent_name, principal/interest/outstanding money, priority, opened_at). Right column contains **action panels** that Tasks 13-16 fill in: sections with ids `#panel-payment`, `#panel-ptp`, `#panel-call`, `#panel-note`, `#panel-status`. For this task, render **read-only lists** already: Timeline (event_type badge + content + created_by + dateTimeFmt), Payments table, PTPs table (with fulfill/break buttons stubbed—added Task 14), Tasks list, Calls list. Guard all action forms with `<% if (!readOnly) { %>`.

- [ ] **Step 5: Update mount in `src/app.js`**
```js
app.use('/cases', require('./routes/cases').router);
```

- [ ] **Step 6: Manual smoke** — as manager: `/cases` lists 20, filters by status work, create a case (gets `CASE-YYYY-####`), open detail. As agent1: `/cases` shows only own; opening another agent's case id → 404/forbidden.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: cases list/filter/new/edit/detail shell with scope"`

---

## Task 13: Case detail — record payment

**Files:**
- Modify: `src/routes/cases.js` (add POST), `src/views/cases/show.ejs` (payment form panel)

**Interfaces:**
- Consumes: `payments.applyPayment`, `loadCase`.
- Produces: `POST /cases/:id/payments`. Allowed roles: admin/manager/finance/agent (agent only own — enforced by loadCase scope).

- [ ] **Step 1: Add route to `src/routes/cases.js`** (before `module.exports`)

```js
const { applyPayment } = require('../services/payments');
router.post('/:id/payments', requireLogin, requireRole('admin','manager','finance','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const r = applyPayment(c.id, req.body, req);
  res.redirect(`/cases/${c.id}?ok=Payment+${r.receipt_no}+recorded`);
});
```

- [ ] **Step 2: Add payment panel to `src/views/cases/show.ejs`** (inside `#panel-payment`, guarded by `!readOnly` and role in admin/manager/finance/agent)

```ejs
<% if (!readOnly && ['admin','manager','finance','agent'].includes(currentUser.role)) { %>
<form class="inline-form" method="post" action="/cases/<%= c.id %>/payments">
  <h3>Record Payment</h3>
  <label>Date <input type="date" name="payment_date" required></label>
  <label>Amount (RM) <input type="number" step="0.01" name="amount" required></label>
  <label>Method <select name="method"><option>bank_transfer</option><option>cash</option><option>cheque</option><option>online</option></select></label>
  <label>Reference <input name="reference"></label>
  <label>Bank <input name="bank"></label>
  <button class="btn btn-gold" type="submit">Add Payment</button>
</form>
<% } %>
```

- [ ] **Step 3: Manual smoke** — as finance, record a payment on a `negotiation` case → outstanding drops, status becomes partial_paid or fully_paid, timeline gets a payment row, audit logged. Record on a `legal` case → status stays `legal`, outstanding still updates.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: record payment on case detail (linkage verified)"`

---

## Task 14: Case detail — PTP create/fulfill/break

**Files:**
- Modify: `src/routes/cases.js`, `src/views/cases/show.ejs`

**Interfaces:**
- Consumes: `loadCase`, `TERMINAL_STATUSES`.
- Produces: `POST /cases/:id/ptps`, `POST /ptps/:id/fulfill`, `POST /ptps/:id/break`. Note the last two are on a **separate router** mounted at root (`/ptps`), or add them to cases router with absolute-ish paths — cleaner: create `src/routes/ptps.js`.

- [ ] **Step 1: Add create-PTP to `src/routes/cases.js`**

```js
router.post('/:id/ptps', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const by = req.session.user.full_name;
  run('INSERT INTO ptps (case_id,amount,due_date,remark,created_by) VALUES (?,?,?,?,?)', [c.id, Number(req.body.amount), req.body.due_date, req.body.remark||null, by]);
  if (!TERMINAL_STATUSES.includes(c.status)) run("UPDATE cases SET status='ptp' WHERE id=?", [c.id]);
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id,'ptp_created',`PTP RM ${Number(req.body.amount).toFixed(2)} due ${req.body.due_date}`,by]);
  logAction(req,'ptp_create','case',c.id,`PTP created for case ${c.case_no}`);
  res.redirect(`/cases/${c.id}?ok=PTP+created`);
});
```

- [ ] **Step 2: Create `src/routes/ptps.js`**

```js
const express = require('express');
const { get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { caseWhere } = require('../utils/scope');
const router = express.Router();

function transition(req, res, newStatus, eventType, verb) {
  const ptp = get('SELECT * FROM ptps WHERE id=?', [req.params.id]);
  if (!ptp) return res.status(404).render('error', { message: 'PTP not found' });
  const w = caseWhere(req.session.user);
  const c = get(`SELECT * FROM cases WHERE id=? AND ${w.clause}`, [ptp.case_id, ...w.params]);
  if (!c) return res.status(403).render('error', { message: 'Forbidden' });
  run('UPDATE ptps SET status=? WHERE id=?', [newStatus, ptp.id]);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)', [ptp.case_id, eventType, `PTP ${verb} (RM ${ptp.amount.toFixed(2)})`, req.session.user.full_name]);
  logAction(req, 'ptp_' + verb, 'case', ptp.case_id, `PTP ${ptp.id} ${verb}`);
  res.redirect(`/cases/${ptp.case_id}?ok=PTP+${verb}`);
}
router.post('/:id/fulfill', requireLogin, requireRole('admin','manager','agent'), (req, res) => transition(req, res, 'fulfilled', 'ptp_fulfilled', 'fulfilled'));
router.post('/:id/break', requireLogin, requireRole('admin','manager','agent'), (req, res) => transition(req, res, 'broken', 'ptp_broken', 'broken'));
module.exports = router;
```

- [ ] **Step 3: Add PTP panel + list actions to `src/views/cases/show.ejs`** — create form (amount, due_date, remark) guarded by role; PTP list rows show status badge and, for pending PTPs when `!readOnly`, two small forms posting to `/ptps/<id>/fulfill` and `/ptps/<id>/break`.

- [ ] **Step 4: Mount ptps router in `src/app.js`** — `app.use('/ptps', require('./routes/ptps'));`

- [ ] **Step 5: Manual smoke** — create PTP on a `negotiation` case → status becomes `ptp`; fulfill it → ptp row fulfilled, case status unchanged (stays `ptp`), timeline updated.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: PTP create/fulfill/break"`

---

## Task 15: Case detail — call log

**Files:**
- Modify: `src/routes/cases.js`, `src/views/cases/show.ejs`

**Interfaces:**
- Consumes: `loadCase`.
- Produces: `POST /cases/:id/calls` → inserts call_logs + timeline `event_type='call'`.

- [ ] **Step 1: Add route to `src/routes/cases.js`**

```js
router.post('/:id/calls', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const by = req.session.user.full_name;
  const dur = Number(req.body.duration_seconds)||0;
  run('INSERT INTO call_logs (case_id,agent_id,duration_seconds,result,notes) VALUES (?,?,?,?,?)',
    [c.id, req.session.user.agent_id||c.agent_id||null, dur, req.body.result||'no_answer', req.body.notes||null]);
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
    [c.id,'call',`Call: ${req.body.result||'no_answer'} (${dur}s)${req.body.notes?' — '+req.body.notes:''}`, by]);
  logAction(req,'call','case',c.id,`Logged call for ${c.case_no}`);
  res.redirect(`/cases/${c.id}?ok=Call+logged`);
});
```

- [ ] **Step 2: Add call panel to `show.ejs`** — form: result `<select>` (answered/no_answer/busy/wrong_number/refused), duration_seconds number, notes text; guarded by role + `!readOnly`. Calls list shows result badge + duration + notes + time.

- [ ] **Step 3: Manual smoke** — log a call as agent1 on own case → call_logs row + timeline `call` entry appear.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: call logging on case detail"`

---

## Task 16: Case detail — note + status change

**Files:**
- Modify: `src/routes/cases.js`, `src/views/cases/show.ejs`

**Interfaces:**
- Consumes: `loadCase`, `CASE_STATUSES`.
- Produces: `POST /cases/:id/notes` (timeline note), `POST /cases/:id/status` (update status + timeline status_change + audit). Status change allowed for admin/manager/agent.

- [ ] **Step 1: Add routes to `src/routes/cases.js`**

```js
router.post('/:id/notes', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id,'note',req.body.content||'',req.session.user.full_name]);
  res.redirect(`/cases/${c.id}?ok=Note+added`);
});
router.post('/:id/status', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const ns = req.body.status;
  if (!CASE_STATUSES.includes(ns)) return res.redirect(`/cases/${c.id}?err=Invalid+status`);
  run("UPDATE cases SET status=?, closed_at=CASE WHEN ? IN ('closed','fully_paid','cancelled') THEN datetime('now') ELSE closed_at END, updated_at=datetime('now') WHERE id=?", [ns, ns, c.id]);
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id,'status_change',`Status changed ${c.status} → ${ns}`,req.session.user.full_name]);
  logAction(req,'status_change','case',c.id,`Status ${c.status} → ${ns}`);
  res.redirect(`/cases/${c.id}?ok=Status+updated`);
});
```

- [ ] **Step 2: Add note + status panels to `show.ejs`** — note: textarea + submit; status: `<select>` of all statuses (current selected) + submit. Both guarded role + `!readOnly`.

- [ ] **Step 3: Manual smoke** — add a note; change status new→assigned; verify timeline shows both, audit for status logged.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: notes and status change on case detail"`

---

## Task 17: Case detail view polish (assemble panels cleanly)

**Files:**
- Modify: `src/views/cases/show.ejs`, `public/css/style.css`

**Interfaces:** none new — visual assembly only.

- [ ] **Step 1: Reorganize `show.ejs`** into a clean two-column layout: left = case facts `.kv` + timeline feed; right = tab(simple stacked cards) of Payments / PTPs / Calls / Tasks lists + the action forms. Ensure every list has the empty-state partial when zero rows. Ensure `readOnly` (auditor/client) sees data but no forms.

- [ ] **Step 2: Add CSS** for `.timeline` (vertical feed with event-type colored dots reusing badge classes), `.kv`, `.inline-form`, `.two-col` grid.

- [ ] **Step 3: Manual smoke** — open a rich case (e.g. case 5 partial_paid with payment + ptp) as manager: all panels populated & aligned; as client1 (its own case) → read-only, no forms.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "polish: case detail two-column layout + timeline feed"`

---

## Task 18: Agents module + performance stats

**Files:**
- Create: `src/routes/agents.js`, `src/views/agents/list.ejs`, `src/views/agents/form.ejs`, `src/views/agents/show.ejs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: requireRole('admin','manager','auditor') view; edit admin/manager.
- Produces: `GET /agents`, `/agents/new`, `POST /agents`, `/agents/:id` (with perf: collected amount = SUM(payments on cases assigned to agent), case_count, target attainment %), `/agents/:id/edit`, `POST /agents/:id`.

- [ ] **Step 1: Implement `src/routes/agents.js`** — list with per-agent stats via subqueries:

```js
const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const router = express.Router();
const canView = requireRole('admin','manager','auditor');
const canEdit = requireRole('admin','manager');

const STAT = `SELECT a.*,
  (SELECT COUNT(*) FROM cases WHERE agent_id=a.id) AS case_count,
  (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN cases c ON c.id=p.case_id WHERE c.agent_id=a.id) AS collected`;

router.get('/', requireLogin, canView, (req, res) => {
  const agents = all(`${STAT} FROM agents a ORDER BY collected DESC`);
  res.render('agents/list', { title: 'Agents', agents });
});
router.get('/new', requireLogin, canEdit, (req, res) => res.render('agents/form', { title: 'New Agent', agent: {}, action: '/agents' }));
router.post('/', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  const r = run('INSERT INTO agents (name,contact,department,target_amount,commission_rate,active) VALUES (?,?,?,?,?,?)',
    [b.name,b.contact,b.department,Number(b.target_amount)||0,Number(b.commission_rate)||5, b.active?1:1]);
  logAction(req,'create','agent',r.lastInsertRowid,`Created agent ${b.name}`);
  res.redirect('/agents?ok=Agent+created');
});
router.get('/:id', requireLogin, canView, (req, res) => {
  const agent = get(`${STAT} FROM agents a WHERE a.id=?`, [req.params.id]);
  if (!agent) return res.status(404).render('error', { message: 'Agent not found' });
  const cases = all(`SELECT cases.*, debtors.name AS debtor_name FROM cases JOIN debtors ON debtors.id=cases.debtor_id WHERE agent_id=? ORDER BY opened_at DESC`, [req.params.id]);
  const attainment = agent.target_amount ? Math.round((agent.collected / agent.target_amount) * 100) : 0;
  res.render('agents/show', { title: agent.name, agent, cases, attainment });
});
router.get('/:id/edit', requireLogin, canEdit, (req, res) => {
  const agent = get('SELECT * FROM agents WHERE id=?', [req.params.id]);
  if (!agent) return res.status(404).render('error', { message: 'Agent not found' });
  res.render('agents/form', { title: 'Edit Agent', agent, action: `/agents/${agent.id}` });
});
router.post('/:id', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  run('UPDATE agents SET name=?,contact=?,department=?,target_amount=?,commission_rate=?,active=? WHERE id=?',
    [b.name,b.contact,b.department,Number(b.target_amount)||0,Number(b.commission_rate)||5, b.active?1:0, req.params.id]);
  logAction(req,'update','agent',Number(req.params.id),`Updated agent ${b.name}`);
  res.redirect(`/agents/${req.params.id}?ok=Saved`);
});
module.exports = router;
```

- [ ] **Step 2: Views** — `list.ejs`: table Name(link), Department, Case count(num), Collected(num money), Target(num money), a `.bar` attainment bar. `form.ejs`: name/contact/department/target_amount/commission_rate/active checkbox. `show.ejs`: `.kv` stats + attainment `.bar` + assigned cases table.

- [ ] **Step 3: Mount** — `app.use('/agents', require('./routes/agents'));`

- [ ] **Step 4: Manual smoke** — as manager `/agents` shows 4 ranked by collected; open one → attainment % + case list.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: agents module with performance stats"`

---

## Task 19: Tasks module

**Files:**
- Create: `src/routes/tasks.js`, `src/views/tasks/index.ejs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `caseWhere` (agent sees tasks on own cases; client has no tasks nav but route guarded).
- Produces: `GET /tasks` (?mine=1 toggle, else all for privileged), `POST /tasks/new`, `POST /tasks/:id/complete`.

- [ ] **Step 1: Implement `src/routes/tasks.js`**

```js
const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { caseWhere, isScoped } = require('../utils/scope');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const u = req.session.user;
  const where = []; const params = [];
  if (u.role === 'agent') { where.push('tasks.agent_id = ?'); params.push(u.agent_id); }
  else if (u.role === 'client') { const w = caseWhere(u); where.push(`tasks.case_id IN (SELECT id FROM cases WHERE ${w.clause})`); params.push(...w.params); }
  if (req.query.status) { where.push('tasks.status=?'); params.push(req.query.status); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const tasks = all(`SELECT tasks.*, cases.case_no FROM tasks LEFT JOIN cases ON cases.id=tasks.case_id ${clause} ORDER BY tasks.status, tasks.due_date`, params);
  const cases = all('SELECT id,case_no FROM cases ORDER BY case_no');
  const agents = all('SELECT id,name FROM agents ORDER BY name');
  res.render('tasks/index', { title: 'Tasks', tasks, cases, agents });
});
router.post('/new', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const b = req.body;
  run('INSERT INTO tasks (case_id,agent_id,type,title,due_date,notes) VALUES (?,?,?,?,?,?)',
    [b.case_id||null, b.agent_id||req.session.user.agent_id||null, b.type||'follow_up', b.title, b.due_date||null, b.notes||null]);
  res.redirect('/tasks?ok=Task+created');
});
router.post('/:id/complete', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  run("UPDATE tasks SET status='done' WHERE id=?", [req.params.id]);
  res.redirect('/tasks?ok=Task+completed');
});
module.exports = router;
```

- [ ] **Step 2: Create `src/views/tasks/index.ejs`** — new-task form (case select, agent select, type select, title, due_date, notes) for admin/manager/agent; tasks table: Title, Case No (link), Type, Due (date + overdue red if past & pending), Status badge, Complete button for pending. Empty state.

- [ ] **Step 3: Mount** — `app.use('/tasks', require('./routes/tasks'));`

- [ ] **Step 4: Manual smoke** — as agent1, `/tasks` shows own tasks; create one; complete one.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: tasks module"`

---

## Task 20: Dashboard

**Files:**
- Create: `src/routes/dashboard.js`, `src/views/dashboard/index.ejs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `caseWhere`, `isScoped`, helpers.
- Produces: `GET /` → KPI stats scoped by role: today's collections, today's PTPs due, total outstanding, cases opened/closed today, legal cases, broken PTPs, today's + overdue tasks, agent leaderboard (**hidden for agent/client**), recent timeline. Uses the case scope clause everywhere counts touch cases.

- [ ] **Step 1: Implement `src/routes/dashboard.js`**

```js
const express = require('express');
const { get, all } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { caseWhere, isScoped } = require('../utils/scope');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const u = req.session.user;
  const w = caseWhere(u); // clause on `cases`
  const cq = (extra, params = []) => get(`SELECT COUNT(*) c, COALESCE(SUM(outstanding_amount),0) s FROM cases WHERE ${w.clause} ${extra}`, [...w.params, ...params]);
  const outstanding = cq('').s;
  const legalCount = cq("AND status='legal'").c;
  const openedToday = cq("AND date(opened_at)=date('now')").c;
  const closedToday = cq("AND date(closed_at)=date('now')").c;
  // payments today (join to scoped cases)
  const collectedToday = get(`SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN cases c ON c.id=p.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND date(p.payment_date)=date('now')`, w.params).s;
  const ptpToday = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='pending' AND date(t.due_date)=date('now')`, w.params).c;
  const brokenPtp = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='broken'`, w.params).c;
  const overdueTasks = get(`SELECT COUNT(*) c FROM tasks t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='pending' AND t.due_date < date('now')`, w.params).c;
  const recent = all(`SELECT e.*, c.case_no FROM timeline_events e JOIN cases c ON c.id=e.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} ORDER BY e.created_at DESC LIMIT 12`, w.params);
  let leaderboard = null;
  if (!isScoped(u)) {
    leaderboard = all(`SELECT a.name, COALESCE(SUM(p.amount),0) collected FROM agents a
      LEFT JOIN cases c ON c.agent_id=a.id LEFT JOIN payments p ON p.case_id=c.id
      GROUP BY a.id ORDER BY collected DESC LIMIT 5`);
  }
  res.render('dashboard/index', { title: 'Dashboard', kpi: { outstanding, legalCount, openedToday, closedToday, collectedToday, ptpToday, brokenPtp, overdueTasks }, leaderboard, recent });
});
module.exports = router;
```
> Note: `w.clause.replace(/cases\./g,'c.')` re-aliases the scope clause for joined queries. For unrestricted roles clause is `1=1` (unaffected).

- [ ] **Step 2: Create `src/views/dashboard/index.ejs`** — `.kpi` grid of stat tiles (label + big mono number): Collected Today (RM), Outstanding (RM), PTP Due Today, Broken PTP, Legal Cases, Opened Today, Closed Today, Overdue Tasks. Then leaderboard table (only `<% if (leaderboard) { %>`) with `.bar`. Then recent activity feed (timeline).

- [ ] **Step 3: Mount at root** — `app.use('/', require('./routes/dashboard'));` (mount AFTER auth routes but the `/` GET requires login).

- [ ] **Step 4: Manual smoke** — login each of admin, agent1, client1: admin sees leaderboard + global numbers; agent1 sees own scoped numbers, NO leaderboard; client1 sees only its company numbers.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: role-scoped dashboard"`

---

## Task 21: Reports

**Files:**
- Create: `src/routes/reports.js`, `src/views/reports/index.ejs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `caseWhere`. Date range via `?from=&to=` (default: month-to-date).
- Produces: `GET /reports` with three reports: Collection (payments in range by client), Outstanding (open cases grouped by status), Agent Performance (collected vs target in range).

- [ ] **Step 1: Implement `src/routes/reports.js`**

```js
const express = require('express');
const { all } = require('../db');
const dayjs = require('dayjs');
const { requireLogin } = require('../middleware/auth');
const { caseWhere } = require('../utils/scope');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const from = req.query.from || dayjs().startOf('month').format('YYYY-MM-DD');
  const to = req.query.to || dayjs().format('YYYY-MM-DD');
  const w = caseWhere(req.session.user); const cAlias = w.clause.replace(/cases\./g,'c.');
  const collection = all(`SELECT cl.company_name, COUNT(p.id) cnt, COALESCE(SUM(p.amount),0) total
    FROM payments p JOIN cases c ON c.id=p.case_id JOIN clients cl ON cl.id=c.client_id
    WHERE ${cAlias} AND date(p.payment_date) BETWEEN ? AND ? GROUP BY cl.id ORDER BY total DESC`, [...w.params, from, to]);
  const outstanding = all(`SELECT c.status, COUNT(*) cnt, COALESCE(SUM(c.outstanding_amount),0) total
    FROM cases c WHERE ${cAlias} GROUP BY c.status ORDER BY total DESC`, w.params);
  const performance = all(`SELECT a.name, a.target_amount, COALESCE(SUM(CASE WHEN date(p.payment_date) BETWEEN ? AND ? THEN p.amount ELSE 0 END),0) collected
    FROM agents a LEFT JOIN cases c ON c.agent_id=a.id LEFT JOIN payments p ON p.case_id=c.id
    GROUP BY a.id ORDER BY collected DESC`, [from, to]);
  res.render('reports/index', { title: 'Reports', from, to, collection, outstanding, performance });
});
module.exports = router;
```

- [ ] **Step 2: Create `src/views/reports/index.ejs`** — date-range GET form (from/to), then three `.card` sections with tables. Collection: company/cnt/total. Outstanding: status badge/cnt/total + `.bar` proportion. Performance: name/collected/target + attainment `.bar`. Totals row where sensible.

- [ ] **Step 3: Mount** — `app.use('/reports', require('./routes/reports'));`

- [ ] **Step 4: Manual smoke** — `/reports` renders with default MTD range; change range; numbers reconcile with seed.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: reports (collection/outstanding/performance)"`

---

## Task 22: Global search

**Files:**
- Create: `src/routes/search.js`, `src/views/search/index.ejs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `caseWhere` (scoped for agent/client).
- Produces: `GET /search?q=` matching case_no / debtor name / IC / phone; results are cases the user may see.

- [ ] **Step 1: Implement `src/routes/search.js`**

```js
const express = require('express');
const { all } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { caseWhere } = require('../utils/scope');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const q = (req.query.q || '').trim();
  let results = [];
  if (q) {
    const w = caseWhere(req.session.user);
    const like = '%' + q + '%';
    results = all(`SELECT cases.*, clients.company_name AS client_name, debtors.name AS debtor_name, debtors.ic_passport, debtors.phone AS debtor_phone
      FROM cases JOIN clients ON clients.id=cases.client_id JOIN debtors ON debtors.id=cases.debtor_id
      WHERE ${w.clause} AND (cases.case_no LIKE ? OR debtors.name LIKE ? OR debtors.ic_passport LIKE ? OR debtors.phone LIKE ?)
      ORDER BY cases.opened_at DESC LIMIT 50`, [...w.params, like, like, like, like]);
  }
  res.render('search/index', { title: 'Search', q, results });
});
module.exports = router;
```

- [ ] **Step 2: Create `src/views/search/index.ejs`** — search box (GET, value=q), results table (case_no link, debtor, IC mono, phone mono, client, status badge). Empty-state when q present but no results; prompt when no q.

- [ ] **Step 3: Mount** — `app.use('/search', require('./routes/search'));`

- [ ] **Step 4: Manual smoke** — search "Ahmad" as manager → finds cases; as agent1 → only own; search an IC number works.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: scoped global search"`

---

## Task 23: Audit log view

**Files:**
- Create: `src/routes/audit.js`, `src/views/audit/index.ejs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: requireRole('admin','auditor').
- Produces: `GET /audit-log` read-only paginated-ish (LIMIT 200) list newest first, optional `?action=` filter.

- [ ] **Step 1: Implement `src/routes/audit.js`**

```js
const express = require('express');
const { all } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireLogin, requireRole('admin','auditor'), (req, res) => {
  const where = []; const params = [];
  if (req.query.action) { where.push('action = ?'); params.push(req.query.action); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const logs = all(`SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC LIMIT 200`, params);
  const actions = all('SELECT DISTINCT action FROM audit_logs ORDER BY action');
  res.render('audit/index', { title: 'Audit Log', logs, actions });
});
module.exports = router;
```

- [ ] **Step 2: Create `src/views/audit/index.ejs`** — action filter `<select>` (GET), table: Time (dateTimeFmt), User, Action, Entity (type#id), Details, IP (mono). Empty state.

- [ ] **Step 3: Mount** — `app.use('/audit-log', require('./routes/audit'));`

- [ ] **Step 4: Manual smoke** — as auditor `/audit-log` shows entries incl. logins & the actions taken in earlier smokes; as manager → 403.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: audit log viewer"`

---

## Task 24: Polish — demo accounts page, validation, empty states, README

**Files:**
- Create: `src/routes/misc.js` (or add to app.js) for `GET /demo-accounts`, `src/views/demo-accounts.ejs`, `README.md`
- Modify: `src/app.js`, various views for empty-state consistency + basic required-field validation feedback.

- [ ] **Step 1: `GET /demo-accounts`** (public, no login) route in `src/app.js`:
```js
app.get('/demo-accounts', (req, res) => res.render('demo-accounts', { accounts: [
  ['admin','admin123','Full access + user mgmt + audit'],
  ['manager','manager123','Cases/clients/debtors/agents + reports'],
  ['agent1','agent123','Only own cases (agent2/agent3 too)'],
  ['finance','finance123','Record payments, view reports'],
  ['auditor','auditor123','Read-only everything + audit log'],
  ['client1','client123','Only own company cases (read-only)'],
] }));
```
`demo-accounts.ejs` standalone page: styled table of accounts + "Back to login" link.

- [ ] **Step 2: Validation feedback** — ensure all create/edit POST handlers, on missing required fields, redirect back with `?err=...`. Add `required` attributes already present; add server-side guard for cases (client_id, debtor_id, principal) redirecting with err if absent.

- [ ] **Step 3: Empty-state audit** — verify every list view uses `partials/empty` when zero rows (clients, debtors, cases, agents, tasks, search, audit, reports sections).

- [ ] **Step 4: Write `README.md`** — sections: What it is; Requirements (Node ≥ 22.5); Setup (`npm install`, `npm run seed`, `npm start`, open http://localhost:3000); Demo accounts table; Reset data (`npm run reset`); Run tests (`npm test`); Deferred/out-of-scope items (copy spec §10 summary); Note it's a demo (money as float, no compliance features).

- [ ] **Step 5: Full manual run-through** — `npm run reset && npm start`; log in as each role; touch every module; confirm no 500s. Run `npm test` → all pass.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "polish: demo accounts page, validation, README"`

---

## Self-Review

**1. Spec coverage:**
- §1 scope (full runnable system) → all tasks. ✓
- §2 tech stack → Task 1 (deps, node:sqlite), reset fix in Global Constraints + Task 1. ✓
- §3 RBAC (6 roles, row-level) → Tasks 3 (roles), 5 (scope), enforced across 10-23. ✓
- §4 schema (11 tables + indexes) → Task 1. ✓
- §4.1 business rules ① outstanding recompute (Task 7), ② payment↔status no-overwrite (Task 7), ③ PTP↔status (Task 14), ④ numbering (Task 6), ⑤ scope non-case tables + hidden leaderboard (Tasks 5,11,20,22), ⑥ audit triggers (Task 8 + calls in 3,7,10-16,18), ⑦ money/time fmt (Task 2), ⑧ free status machine (Task 16). ✓
- §5 routes: login/logout(3), dashboard(20), clients(10), debtors(11), cases + sub-actions(12-16), agents(18), tasks(19), reports(21), audit(23), search(22). ✓
- §6 seed (5/12/4/20 + related) → Task 9. ✓
- §7 visual direction → Task 4 CSS + Task 2 icons; refined in 17. ✓
- §8 structure → File Structure section matches. ✓
- §9 priority order → task ordering mirrors phases 1-6. ✓
- §10 deferred → not implemented (correct); documented in README (Task 24). ✓

**2. Placeholder scan:** Task 4 Step 6 and several view steps say "implementer writes complete styles/views matching these class names." These describe concrete class names and columns rather than giving every CSS line — acceptable for view/CSS boilerplate but the executor must produce complete files (no TODOs in code). All logic/route/service steps contain full code. No "TBD/TODO" remain.

**3. Type consistency:** `cases.js` exports `{ router, loadCase }` — mount uses `.router` (Task 12 Step 5) and Tasks 13-16 add routes on the same `router` object in-file (not via the export), so no cross-file signature mismatch. `applyPayment(caseId, body, req)`, `statusAfterPayment(current, outstanding, count)`, `caseWhere(user)→{clause,params}`, `reachableDebtorIds(user)→array|null`, `logAction(req,action,type,id,details)`, `nextCaseNo()/nextReceiptNo()` — all used consistently across tasks. Scope re-alias trick `w.clause.replace(/cases\./g,'c.')` used consistently in dashboard/reports/search where the query aliases cases as `c`.

Ordering caveat surfaced: **Task 8 (audit) must be built before Tasks 3 and 7.** Noted inline.
