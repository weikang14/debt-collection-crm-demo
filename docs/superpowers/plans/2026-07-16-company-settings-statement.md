# Company Settings + Configurable Statement Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only Settings page for a single global company profile (name, address, phone, email, reg no, uploaded logo), and render it on the printed case statement header instead of the hardcoded `Debt Collection CRM`.

**Architecture:** A single-row `settings` table (id=1) holds the company profile. The logo is uploaded via multer (memory storage), stored as a base64 `data:` URL in the DB (survives redeploys/backups, embeds in printed PDFs). An admin route `/settings` edits the row; the statement route loads it and the statement view renders it with a fallback to the old hardcoded name.

**Tech Stack:** Node 22, Express 4, ejs-mate, `node:sqlite`, multer (new dependency).

## Global Constraints

- DB layer is `node:sqlite` via `src/db`; use `get`/`all`/`run` helpers, never raw driver calls.
- Migrations live in `src/db/index.js` `init()`; schema in `src/db/schema.sql` uses `CREATE TABLE IF NOT EXISTS`.
- Flash messages are query-string based: redirect with `?ok=...` / `?err=...` (URL-encoded); `partials/flash.ejs` renders `query.ok`/`query.err`.
- Admin-only routes use `requireLogin` + `requireRole('admin')`.
- Audit every mutation with `logAction(req, action, entity_type, entity_id, details)` from `src/utils/audit`.
- Views use `<% layout('layout') -%>`, `.card.form` forms, `.btn`/`.btn-gold` buttons.
- Tests are `node:test` (`npm test`), pure-function style where possible.
- Logo limits: max 512×1024 bytes (512KB), MIME in `image/png,image/jpeg,image/svg+xml,image/webp`.

---

### Task 1: `settings` table + default row

**Files:**
- Modify: `src/db/schema.sql` (append settings table)
- Modify: `src/db/index.js:26-49` (`init()` — insert default row after schema exec)
- Test: `test/settings.test.js`

**Interfaces:**
- Produces: table `settings(id, company_name, address, phone, email, reg_no, logo, updated_at)` guaranteed to always have a row with `id=1`. Read via `get('SELECT * FROM settings WHERE id=1')`.

- [ ] **Step 1: Write the failing test**

Create `test/settings.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Use a throwaway DB file so we don't touch the real one.
const tmp = path.join(os.tmpdir(), `crm-settings-${process.pid}-${Date.now()}.db`);
process.env.CRM_DB_PATH = tmp;
const db = require('../src/db');
db.init();
test.after(() => { try { fs.rmSync(tmp, { force: true }); } catch (e) {} });

test('settings has a default row id=1 with empty fields', () => {
  const s = db.get('SELECT * FROM settings WHERE id=1');
  assert.ok(s, 'default settings row exists');
  assert.strictEqual(s.company_name, '');
  assert.strictEqual(s.logo, '');
});

test('settings update round-trips', () => {
  db.run("UPDATE settings SET company_name=?, phone=? WHERE id=1", ['Acme Recovery', '03-1234']);
  const s = db.get('SELECT * FROM settings WHERE id=1');
  assert.strictEqual(s.company_name, 'Acme Recovery');
  assert.strictEqual(s.phone, '03-1234');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/settings.test.js`
Expected: FAIL — `no such table: settings` (or default row assertion fails).

- [ ] **Step 3: Add the table to schema**

Append to `src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  reg_no TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Seed the default row in init()**

In `src/db/index.js`, inside `init()`, immediately after `db.exec(schema);` (currently line 28), add:

```js
  // Single-row company profile for statement branding (see routes/settings.js)
  db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/settings.test.js`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/index.js test/settings.test.js
git commit -m "feat: settings table with single-row company profile"
```

---

### Task 2: logo helper (data URL + allowed types)

**Files:**
- Create: `src/utils/logo.js`
- Test: `test/settings.test.js` (append)

**Interfaces:**
- Produces:
  - `LOGO_MIME: string[]` — allowed MIME types.
  - `MAX_LOGO_BYTES: number` — 512*1024.
  - `toDataUrl(mimetype: string, buffer: Buffer): string` — returns `data:<mime>;base64,<...>`.

- [ ] **Step 1: Write the failing test**

Append to `test/settings.test.js`:

```js
const logo = require('../src/utils/logo');

test('toDataUrl builds a base64 data URL', () => {
  const url = logo.toDataUrl('image/png', Buffer.from('hi'));
  assert.strictEqual(url, 'data:image/png;base64,aGk=');
});

test('LOGO_MIME allows png/jpeg/svg/webp only', () => {
  assert.deepStrictEqual(
    [...logo.LOGO_MIME].sort(),
    ['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp']);
  assert.strictEqual(logo.MAX_LOGO_BYTES, 512 * 1024);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/settings.test.js`
Expected: FAIL — `Cannot find module '../src/utils/logo'`.

- [ ] **Step 3: Write the helper**

Create `src/utils/logo.js`:

```js
// Logo upload constraints + data-URL encoding, shared by the settings route's
// multer config and its POST handler. Stored as a data: URL in the DB so it
// travels with backups and embeds directly when the statement is printed.
const LOGO_MIME = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const MAX_LOGO_BYTES = 512 * 1024;

function toDataUrl(mimetype, buffer) {
  return `data:${mimetype};base64,${buffer.toString('base64')}`;
}

module.exports = { LOGO_MIME, MAX_LOGO_BYTES, toDataUrl };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/settings.test.js`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/logo.js test/settings.test.js
git commit -m "feat: logo helper (data URL + allowed types)"
```

---

### Task 3: Settings route + view + nav (admin-only)

**Files:**
- Create: `src/routes/settings.js`
- Create: `src/views/settings/form.ejs`
- Modify: `src/app.js:58` (mount route)
- Modify: `src/utils/helpers.js:57` (add `settings` icon to ICONS)
- Modify: `src/views/partials/sidebar.ejs:10` (add nav link in admin block)
- Modify: `package.json` (add multer dependency)

**Interfaces:**
- Consumes: `settings` row (Task 1), `LOGO_MIME`/`MAX_LOGO_BYTES`/`toDataUrl` (Task 2).
- Produces: `GET /settings` (form), `POST /settings` (update). No downstream code depends on these.

- [ ] **Step 1: Install multer**

Run: `npm install multer`
Expected: adds `multer` to `package.json` dependencies and updates `package-lock.json`.

- [ ] **Step 2: Write the route**

Create `src/routes/settings.js`:

```js
const express = require('express');
const multer = require('multer');
const { get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { LOGO_MIME, MAX_LOGO_BYTES, toDataUrl } = require('../utils/logo');
const router = express.Router();

const adminOnly = requireRole('admin');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES },
  fileFilter: (req, file, cb) => {
    if (LOGO_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Logo must be PNG, JPEG, SVG or WebP'));
  },
}).single('logo');

router.get('/', requireLogin, adminOnly, (req, res) => {
  const s = get('SELECT * FROM settings WHERE id=1') || {};
  res.render('settings/form', { title: 'Company Settings', s });
});

router.post('/', requireLogin, adminOnly, (req, res) => {
  upload(req, res, (err) => {
    if (err) return res.redirect('/settings?err=' + encodeURIComponent(err.message));
    const b = req.body;
    const company_name = (b.company_name || '').trim();
    const address = (b.address || '').trim();
    const phone = (b.phone || '').trim();
    const email = (b.email || '').trim();
    const reg_no = (b.reg_no || '').trim();

    // Logo precedence: remove wins, then a new upload, else keep the existing.
    let logo;
    if (b.remove_logo) {
      logo = '';
    } else if (req.file) {
      logo = toDataUrl(req.file.mimetype, req.file.buffer);
    } else {
      logo = (get('SELECT logo FROM settings WHERE id=1') || {}).logo || '';
    }

    run(`UPDATE settings SET company_name=?, address=?, phone=?, email=?, reg_no=?, logo=?, updated_at=datetime('now') WHERE id=1`,
      [company_name, address, phone, email, reg_no, logo]);
    logAction(req, 'update', 'settings', 1, `Updated company settings (${company_name || 'unnamed'})`);
    res.redirect('/settings?ok=' + encodeURIComponent('Company settings saved'));
  });
});

module.exports = router;
```

- [ ] **Step 3: Write the view**

Create `src/views/settings/form.ejs`:

```ejs
<% layout('layout') -%>
<div class="page-head"><h1>Company Settings</h1></div>
<p class="hint">This company info appears on the printed case statement header.</p>
<form class="card form" method="post" action="/settings" enctype="multipart/form-data">
  <label>Company Name <input name="company_name" value="<%= s.company_name || '' %>"></label>
  <label>Address <textarea name="address" rows="2"><%= s.address || '' %></textarea></label>
  <label>Phone <input name="phone" value="<%= s.phone || '' %>"></label>
  <label>Email <input name="email" type="email" value="<%= s.email || '' %>"></label>
  <label>Registration No <input name="reg_no" value="<%= s.reg_no || '' %>"></label>
  <label>Logo <span class="hint">(PNG/JPEG/SVG/WebP, max 512KB)</span>
    <input name="logo" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp">
  </label>
  <% if (s.logo) { %>
    <div>
      <img src="<%= s.logo %>" alt="Current logo" style="max-height:64px;display:block;margin:6px 0">
      <label class="inline"><input type="checkbox" name="remove_logo" value="1"> Remove current logo</label>
    </div>
  <% } %>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Save</button><a class="btn" href="/">Cancel</a></div>
</form>
```

- [ ] **Step 4: Mount the route**

In `src/app.js`, after line 58 (`app.use('/audit-log', ...)`), add:

```js
app.use('/settings', require('./routes/settings'));
```

- [ ] **Step 5: Add the settings icon**

In `src/utils/helpers.js`, inside the `ICONS` object (after the `edit:` entry, line 57), add:

```js
  settings: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
```

- [ ] **Step 6: Add the sidebar link**

In `src/views/partials/sidebar.ejs`, after line 10 (the Demo Data link, also inside `can(['admin'])`), add:

```ejs
    <% if (can(['admin'])) { %><a href="/settings" class="<%= path.startsWith('/settings')?'active':'' %>"><%- h.icon('settings') %> Settings</a><% } %>
```

- [ ] **Step 7: Manual verification**

Run: `npm start`, log in as `admin`/`admin123`, open `/settings`.
Expected: form renders; save text fields → redirect with green "Company settings saved"; upload a small PNG → reload shows preview; check "Remove current logo" + save → preview gone. Upload a >512KB file → red error flash, no change. Non-admin (e.g. `agent1`) hitting `/settings` is blocked.

- [ ] **Step 8: Commit**

```bash
git add src/routes/settings.js src/views/settings/form.ejs src/app.js src/utils/helpers.js src/views/partials/sidebar.ejs package.json package-lock.json
git commit -m "feat: admin company settings page with logo upload"
```

---

### Task 4: Render company profile on the statement

**Files:**
- Modify: `src/routes/cases.js:102-108` (statement route loads settings)
- Modify: `src/views/cases/statement.ejs:19-22` (header renders company)

**Interfaces:**
- Consumes: `settings` row (Task 1). `get` is already imported in `cases.js:2`.

- [ ] **Step 1: Pass company into the statement view**

In `src/routes/cases.js`, in the `GET /:id/statement` handler, add a company load and pass it to render. Replace lines 102-108:

```js
router.get('/:id/statement', requireLogin, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const payments = all('SELECT * FROM payments WHERE case_id=? ORDER BY payment_date', [c.id]);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const company = get('SELECT * FROM settings WHERE id=1') || {};
  res.render('cases/statement', { c, payments, paid, today, company });
});
```

- [ ] **Step 2: Render company in the header**

In `src/views/cases/statement.ejs`, replace the `.stmt-head` left `<div>` (line 20):

```ejs
<div><h1>Debt Collection <span style="color:var(--gold)">CRM</span></h1><div>Case Statement</div></div>
```

with:

```ejs
    <div>
      <% if (company.logo) { %><img src="<%= company.logo %>" alt="" style="max-height:48px;display:block;margin-bottom:6px"><% } %>
      <h1><%= company.company_name || 'Debt Collection CRM' %></h1>
      <% if (company.address) { %><div><%= company.address %></div><% } %>
      <% if (company.phone) { %><div>Tel: <%= company.phone %></div><% } %>
      <% if (company.email) { %><div><%= company.email %></div><% } %>
      <% if (company.reg_no) { %><div>Reg No: <%= company.reg_no %></div><% } %>
      <div style="margin-top:4px">Case Statement</div>
    </div>
```

- [ ] **Step 3: Manual verification**

Run: `npm start`. With empty settings, open any case → `/cases/:id/statement` → header still reads "Debt Collection CRM". Fill settings (name + logo), reload the statement → header shows the company name, address, phone, email, reg no, and logo. Click "Print / Save as PDF" → logo is embedded in the PDF (data URL, no broken image).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass (existing + `test/settings.test.js`).

- [ ] **Step 5: Commit**

```bash
git add src/routes/cases.js src/views/cases/statement.ejs
git commit -m "feat: render company profile on case statement header"
```

---

## Self-Review

**Spec coverage:**
- settings table (single row) → Task 1. ✓
- logo as base64 data URL in DB → Task 2 (helper) + Task 3 (POST stores it). ✓
- admin-only settings page + sidebar entry → Task 3. ✓
- multer memoryStorage, image-only, 512KB → Task 3 config using Task 2 constants. ✓
- statement header resolves company with fallback to hardcoded text → Task 4. ✓
- audit logging → Task 3 POST `logAction`. ✓
- test/settings.test.js (default row, round-trip, data URL) → Tasks 1–2. ✓
- app.js mount, remove-logo option, empty-field handling → Task 3. ✓

**Placeholder scan:** none — every code step contains full code.

**Type consistency:** `toDataUrl(mimetype, buffer)`, `LOGO_MIME`, `MAX_LOGO_BYTES` defined in Task 2 and consumed identically in Task 3. `settings` columns defined in Task 1 match SELECT/UPDATE column lists in Tasks 3–4 and view field names.
