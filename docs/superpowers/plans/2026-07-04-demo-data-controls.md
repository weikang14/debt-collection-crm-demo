# Demo Data Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admin two buttons — "Delete demo data" and "Reload demo data" — that operate ONLY on seed-generated demo rows, never on data a customer creates during a trial.

**Architecture:** Tag every seed row with `is_demo=1` (a new column, default 0 so app-created rows are automatically `is_demo=0`). "Delete demo" removes `is_demo=1` rows but keeps any demo parent still referenced by customer data (so no FK breakage). "Reload demo" runs delete-demo then re-inserts the demo set idempotently (demo parents use fixed IDs + `INSERT OR IGNORE`), leaving customer rows untouched.

**Tech Stack:** Node.js, `node:sqlite` (SQLite), Express, EJS, `node:test`.

## Global Constraints

- Node ≥ 22.5; run with `node --no-warnings`. Zero new dependencies.
- Spec: `docs/superpowers/specs/2026-07-04-demo-data-controls-design.md`.
- Tagged tables (get `is_demo`): `clients, agents, debtors, cases, payments, ptps, tasks, call_logs, timeline_events`. NOT tagged / never auto-deleted: `users`, `audit_logs`.
- App-created rows must stay `is_demo=0` **without changing any business route** — rely on the column default.
- Demo parent rows (clients, agents, debtors, cases) use fixed IDs (clients 1–5, agents 1–4, debtors 1–12, cases 1–20). Demo child rows attach ONLY to demo cases.
- `deleteDemo` / reload must NOT reset `sqlite_sequence` (keeps customer IDs above the demo ID range). Only the full `seedDemo` (CLI/deploy) resets it.
- Commit-message footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- This replaces the current `src/routes/demo.js` / `src/views/demo/tools.ejs` (the old "clear all / reload overwrite" version).

---

## File Structure

- `src/db/index.js` — add `CRM_DB_PATH` env override so tests use an isolated DB.
- `src/db/schema.sql` — add `is_demo` column to the 9 tagged tables.
- `src/db/seed.js` — refactor into `clearAllTables()`, `insertDemoRows()`, `deleteDemo()`, `seedDemo()`; export them; tag demo rows; fixed parent IDs; idempotent.
- `src/routes/demo.js` — replace body: admin-only `GET /demo-tools`, `POST /demo-tools/delete-demo`, `POST /demo-tools/reload-demo`.
- `src/views/demo/tools.ejs` — two buttons with new copy.
- `test/demo.test.js` — new test file (isolated DB) covering tagging, idempotency, delete-keeps-referenced, reload-keeps-new.

---

### Task 1: Configurable DB path + `is_demo` schema column

**Files:**
- Modify: `src/db/index.js`
- Modify: `src/db/schema.sql`
- Test: `test/demo.test.js` (new)

**Interfaces:**
- Produces: DB file path honors `process.env.CRM_DB_PATH`. All 9 tagged tables have `is_demo INTEGER NOT NULL DEFAULT 0`.

- [ ] **Step 1: Add the DB-path override in `src/db/index.js`**

Change the DB_PATH line (currently `const DB_PATH = path.join(DATA_DIR, 'crm.db');`) to:

```js
const DB_PATH = process.env.CRM_DB_PATH || path.join(DATA_DIR, 'crm.db');
```

Leave the rest of the file unchanged.

- [ ] **Step 2: Add `is_demo` to the 9 tables in `src/db/schema.sql`**

Add `is_demo INTEGER NOT NULL DEFAULT 0,` to each of: `clients, agents, debtors, cases, payments, ptps, tasks, call_logs, timeline_events`. Put it right before each table's `created_at` line. Example for `clients`:

```sql
  commission_rate REAL NOT NULL DEFAULT 15,
  remark TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
```

Do the same in `agents`, `debtors`, `cases`, `payments`, `ptps`, `tasks`, `call_logs`, `timeline_events`. Do NOT add it to `users` or `audit_logs`.

- [ ] **Step 3: Write the failing test `test/demo.test.js`**

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-demo-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const db = require('../src/db');
db.init();

test('is_demo defaults to 0 for app-created rows', () => {
  const r = db.run("INSERT INTO clients (company_name, commission_rate) VALUES ('T', 0)");
  const row = db.get('SELECT is_demo FROM clients WHERE id=?', [r.lastInsertRowid]);
  assert.strictEqual(row.is_demo, 0);
});
```

- [ ] **Step 4: Run it — expect PASS**

Run: `node --no-warnings --test test/demo.test.js`
Expected: PASS (the column exists with default 0). If it FAILS with "no such column: is_demo", the schema edit was missed — fix Step 2.

- [ ] **Step 5: Confirm the whole suite still passes**

Run: `npm test`
Expected: all tests pass (existing 17 + the new one).

- [ ] **Step 6: Commit**

```bash
git add src/db/index.js src/db/schema.sql test/demo.test.js
git commit -m "$(printf 'feat: is_demo column + configurable DB path for tests\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Refactor seed — tag demo rows, fixed parent IDs, idempotent insert

**Files:**
- Modify: `src/db/seed.js`
- Test: `test/demo.test.js`

**Interfaces:**
- Produces: `src/db/seed.js` exports `{ seedDemo, clearAllTables, insertDemoRows }`.
  - `clearAllTables()` — `DELETE` from all tables (incl. users) + reset `sqlite_sequence`.
  - `insertDemoRows()` — idempotent insert of demo business data (agents/clients/debtors/cases/timeline/payments/ptps/calls/tasks), all `is_demo=1`; parents via `INSERT OR IGNORE` with fixed IDs; children attach only to demo cases. Does NOT touch users or reset sequences.
  - `seedDemo()` = `clearAllTables()` + `insertDemoRows()` + demo users + audit sample. Used by `npm run seed` / `reset` / deploy. CLI behavior unchanged.

- [ ] **Step 1: Rewrite `src/db/seed.js`**

Replace the whole file with:

```js
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const { db, init, run } = require('./index');

const hash = (pw) => bcrypt.hashSync(pw, 8);
const ago = (d) => dayjs().subtract(d, 'day').format('YYYY-MM-DD HH:mm:ss');
const inDays = (d) => dayjs().add(d, 'day').format('YYYY-MM-DD');

const AGENTS = [
  ['Lim Wei Sheng', '012-3456789', 'Consumer', 500000, 5],
  ['Nurul Ain', '013-2233445', 'Consumer', 450000, 5],
  ['Rajesh Kumar', '016-7788990', 'Commercial', 700000, 6],
  ['Tan Mei Ling', '017-5566778', 'Legal', 300000, 4],
];
const CLIENTS = [
  ['Sinar Consumer Credit Sdn Bhd','Ms. Chong','03-77001122','ar@sinar.my','AGR-2023-001',15],
  ['DriveMax Auto Financing','Mr. Fauzi','03-88002233','collections@drivemax.my','AGR-2023-002',12],
  ['CardOne Bank Berhad','Ms. Priya','03-99003344','recovery@cardone.my','AGR-2022-118',18],
  ['GreenVista Property Mgmt','Mr. Lee','03-66004455','admin@greenvista.my','AGR-2024-045',10],
  ['QuickCash Microloans','Ms. Siti','03-55005566','ops@quickcash.my','AGR-2024-060',20],
];
const DEBTORS = [
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
const STATUSES = ['new','assigned','negotiation','ptp','partial_paid','fully_paid','legal','closed','cancelled','bankruptcy','deceased','new','assigned','negotiation','ptp','partial_paid','legal','fully_paid','assigned','negotiation'];
const PRIOS = ['low','medium','high','urgent'];

function clearAllTables() {
  init();
  for (const t of ['audit_logs','call_logs','tasks','ptps','payments','timeline_events','cases','debtors','agents','clients','users']) {
    db.exec(`DELETE FROM ${t}`);
    db.exec(`DELETE FROM sqlite_sequence WHERE name='${t}'`);
  }
}

// Idempotent: safe to call when some demo rows already exist (parents use fixed
// IDs + INSERT OR IGNORE). Never touches users or is_demo=0 (customer) rows.
function insertDemoRows() {
  init();
  AGENTS.forEach((a, i) => run('INSERT OR IGNORE INTO agents (id,name,contact,department,target_amount,commission_rate,is_demo) VALUES (?,?,?,?,?,?,1)', [i + 1, ...a]));
  CLIENTS.forEach((c, i) => run('INSERT OR IGNORE INTO clients (id,company_name,pic_name,phone,email,agreement_no,commission_rate,is_demo) VALUES (?,?,?,?,?,?,?,1)', [i + 1, ...c]));
  DEBTORS.forEach((d, i) => run('INSERT OR IGNORE INTO debtors (id,name,ic_passport,company,phone,email,address,employer,salary,risk_level,guarantor_name,guarantor_phone,is_demo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)', [i + 1, ...d]));

  const year = dayjs().year();
  STATUSES.forEach((st, i) => {
    const id = i + 1;
    const case_no = `CASE-${year}-${String(id).padStart(4, '0')}`;
    const client_id = (i % 5) + 1;
    const debtor_id = (i % 12) + 1;
    const agent_id = st === 'new' ? null : (i % 4) + 1;
    const principal = 2000 + (i * 850) % 15000;
    const interest = Math.round(principal * 0.08);
    let outstanding = principal + interest;
    if (st === 'fully_paid') outstanding = 0;
    else if (st === 'partial_paid') outstanding = Math.round((principal + interest) * 0.5);
    run(`INSERT OR IGNORE INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,priority,status,opened_at,closed_at,is_demo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      [id, case_no, client_id, debtor_id, agent_id, principal, interest, outstanding, PRIOS[i % 4], st, ago(60 - i),
       ['fully_paid','closed','cancelled'].includes(st) ? ago(5) : null]);
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by,is_demo) VALUES (?,?,?,?,1)', [id, 'note', `Case opened, status ${st}`, 'System']);
  });

  // Payments for demo partial_paid / fully_paid cases only (is_demo=1 guard)
  db.prepare("SELECT id,principal_amount,interest_amount,status FROM cases WHERE is_demo=1 AND status IN ('partial_paid','fully_paid')").all().forEach((c, idx) => {
    const total = c.principal_amount + c.interest_amount;
    const amt = c.status === 'fully_paid' ? total : Math.round(total * 0.5);
    run('INSERT INTO payments (case_id,receipt_no,payment_date,amount,method,reference,bank,created_by,is_demo) VALUES (?,?,?,?,?,?,?,?,1)',
      [c.id, `RCPT-${year}-${String(idx + 1).padStart(4, '0')}`, ago(10), amt, 'bank_transfer', 'TXN' + (1000 + idx), 'Maybank', 'Finance Officer']);
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by,is_demo) VALUES (?,?,?,?,1)', [c.id, 'payment', `Payment received RM ${amt.toFixed(2)}`, 'Finance Officer']);
  });

  const ptpSeed = [[4,3000,inDays(5),'pending'],[3,2500,ago(3),'broken'],[5,4000,ago(15),'fulfilled'],[14,1800,inDays(10),'pending']];
  ptpSeed.forEach((p) => {
    run('INSERT INTO ptps (case_id,amount,due_date,status,created_by,is_demo) VALUES (?,?,?,?,?,1)', [...p, 'Agent']);
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by,is_demo) VALUES (?,?,?,?,1)', [p[0], p[3] === 'broken' ? 'ptp_broken' : p[3] === 'fulfilled' ? 'ptp_fulfilled' : 'ptp_created', `PTP RM ${p[1]} due ${p[2]}`, 'Agent']);
  });

  const callSeed = [[2,1,180,'answered'],[3,2,0,'no_answer'],[4,1,60,'refused'],[7,3,240,'answered'],[13,2,0,'busy'],[16,4,90,'answered']];
  callSeed.forEach((c) => run('INSERT INTO call_logs (case_id,agent_id,duration_seconds,result,notes,is_demo) VALUES (?,?,?,?,?,1)', [...c, 'Follow-up call']));

  const taskSeed = [[2,1,'follow_up','Call debtor re: overdue',inDays(1),'pending'],[3,2,'visit','Field visit to address',ago(1),'pending'],[7,3,'legal','Prepare LOD',inDays(3),'pending'],[5,1,'reminder','Send WhatsApp reminder',inDays(0),'done']];
  taskSeed.forEach((t) => run('INSERT INTO tasks (case_id,agent_id,type,title,due_date,status,is_demo) VALUES (?,?,?,?,?,?,1)', t));
}

function insertDemoUsers() {
  init();
  run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['admin',hash('admin123'),'System Admin','admin',null,null]);
  run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['manager',hash('manager123'),'Collection Manager','manager',null,null]);
  ['agent1','agent2','agent3'].forEach((u,i)=>run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', [u,hash('agent123'),AGENTS[i][0],'agent',i+1,null]));
  run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['finance',hash('finance123'),'Finance Officer','finance',null,null]);
  run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['auditor',hash('auditor123'),'Compliance Auditor','auditor',null,null]);
  run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['client1',hash('client123'),'Sinar Consumer Credit','client',null,1]);
  run("INSERT INTO audit_logs (username,action,entity_type,entity_id,details) VALUES ('admin','seed','system',NULL,'Demo data seeded')");
}

function seedDemo() {
  clearAllTables();
  insertDemoRows();
  insertDemoUsers();
}

module.exports = { seedDemo, clearAllTables, insertDemoRows };

if (require.main === module) {
  seedDemo();
  console.log('Seed complete: 6 users, 5 clients, 12 debtors, 4 agents, 20 cases + related data.');
}
```

- [ ] **Step 2: Verify the CLI seed still works**

Run: `node --no-warnings src/db/seed.js`
Expected: prints `Seed complete: 6 users, 5 clients, 12 debtors, 4 agents, 20 cases + related data.` with no error.

- [ ] **Step 3: Add tagging + idempotency tests to `test/demo.test.js`**

Append:

```js
const seed = require('../src/db/seed');

test('seedDemo tags all demo rows is_demo=1 with fixed parent ids', () => {
  seed.seedDemo();
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM cases').c, 20);
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM cases WHERE is_demo=1').c, 20);
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM debtors WHERE is_demo=1').c, 12);
  // fixed ids: case ids are 1..20
  assert.strictEqual(db.get('SELECT MIN(id) lo, MAX(id) hi FROM cases').lo, 1);
  assert.strictEqual(db.get('SELECT MAX(id) hi FROM cases').hi, 20);
});

test('insertDemoRows is idempotent (no duplicate parents)', () => {
  seed.seedDemo();
  const before = db.get('SELECT COUNT(*) c FROM debtors').c;
  seed.insertDemoRows();
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM debtors').c, before);
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM cases').c, 20);
});
```

- [ ] **Step 4: Run the demo tests — expect PASS**

Run: `node --no-warnings --test test/demo.test.js`
Expected: PASS. If "duplicate" counts appear, the `INSERT OR IGNORE` / fixed-id logic is wrong — recheck Step 1.

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/db/seed.js test/demo.test.js
git commit -m "$(printf 'feat: tag demo rows is_demo=1; idempotent seed with fixed parent ids\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: `deleteDemo()` — remove demo, keep customer data and referenced demo parents

**Files:**
- Modify: `src/db/seed.js`
- Test: `test/demo.test.js`

**Interfaces:**
- Consumes: the `is_demo` column and fixed demo IDs from Tasks 1–2.
- Produces: `src/db/seed.js` additionally exports `deleteDemo()` — deletes `is_demo=1` rows child→parent, skipping demo parents still referenced by non-demo rows. Does not reset `sqlite_sequence`. Adds `deleteDemo` to `module.exports`.

- [ ] **Step 1: Write failing tests in `test/demo.test.js`**

Append:

```js
test('deleteDemo removes demo data but keeps customer rows', () => {
  seed.seedDemo();
  // a customer (is_demo=0) debtor + case, independent of demo data
  const d = db.run("INSERT INTO debtors (name,risk_level) VALUES ('My Debtor','low')");
  const c = db.run("INSERT INTO cases (case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status) VALUES ('CASE-9999-0001',1,?,100,0,100,'new')", [d.lastInsertRowid]);
  seed.deleteDemo();
  // demo gone
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM cases WHERE is_demo=1').c > 0, false);
  // customer case + debtor survive
  assert.ok(db.get('SELECT id FROM cases WHERE id=?', [c.lastInsertRowid]));
  assert.ok(db.get('SELECT id FROM debtors WHERE id=?', [d.lastInsertRowid]));
});

test('deleteDemo keeps a demo case referenced by customer data', () => {
  seed.seedDemo();
  // customer (is_demo=0) payment on demo case 5
  db.run("INSERT INTO payments (case_id,receipt_no,payment_date,amount,is_demo) VALUES (5,'RCPT-9999-0001','2026-07-04',50,0)");
  seed.deleteDemo();
  // demo case 5 kept because a customer payment references it
  assert.ok(db.get('SELECT id FROM cases WHERE id=5'));
  // an unreferenced demo case (e.g. 1) is gone
  assert.strictEqual(db.get('SELECT id FROM cases WHERE id=1'), undefined);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --no-warnings --test test/demo.test.js`
Expected: FAIL — `seed.deleteDemo is not a function`.

- [ ] **Step 3: Implement `deleteDemo()` in `src/db/seed.js`**

Add this function (before `module.exports`) and add `deleteDemo` to the exports:

```js
// Delete demo (is_demo=1) rows child->parent, but keep any demo parent still
// referenced by non-demo (customer) rows so nothing breaks. Does NOT reset
// sqlite_sequence, so customer IDs stay above the demo ID range.
function deleteDemo() {
  init();
  for (const t of ['timeline_events', 'call_logs', 'tasks', 'ptps', 'payments']) {
    run(`DELETE FROM ${t} WHERE is_demo=1`);
  }
  run(`DELETE FROM cases WHERE is_demo=1
    AND id NOT IN (SELECT case_id FROM payments)
    AND id NOT IN (SELECT case_id FROM ptps)
    AND id NOT IN (SELECT case_id FROM tasks WHERE case_id IS NOT NULL)
    AND id NOT IN (SELECT case_id FROM call_logs)
    AND id NOT IN (SELECT case_id FROM timeline_events)`);
  run(`DELETE FROM debtors WHERE is_demo=1 AND id NOT IN (SELECT debtor_id FROM cases)`);
  run(`DELETE FROM agents  WHERE is_demo=1 AND id NOT IN (SELECT agent_id FROM cases WHERE agent_id IS NOT NULL)`);
  run(`DELETE FROM clients WHERE is_demo=1 AND id NOT IN (SELECT client_id FROM cases)`);
}
```

Update the exports line to:

```js
module.exports = { seedDemo, clearAllTables, insertDemoRows, deleteDemo };
```

- [ ] **Step 4: Run the demo tests — expect PASS**

Run: `node --no-warnings --test test/demo.test.js`
Expected: PASS (both new tests). If a FK error appears, the child-before-parent order or the `IS NOT NULL` guards were changed — restore them exactly.

- [ ] **Step 5: Add the reload-keeps-new test**

Append to `test/demo.test.js`:

```js
test('reload (deleteDemo + insertDemoRows) restores demo and keeps customer data', () => {
  seed.seedDemo();
  const d = db.run("INSERT INTO debtors (name,risk_level) VALUES ('Keep Me','low')");
  seed.deleteDemo();
  seed.insertDemoRows();               // = reload
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM cases WHERE is_demo=1').c, 20);   // demo back
  assert.ok(db.get('SELECT id FROM debtors WHERE id=?', [d.lastInsertRowid]));         // customer row kept
  // no duplicate demo debtors
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM debtors WHERE is_demo=1').c, 12);
});
```

- [ ] **Step 6: Run demo tests + full suite**

Run: `node --no-warnings --test test/demo.test.js` then `npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/seed.js test/demo.test.js
git commit -m "$(printf 'feat: deleteDemo keeps customer data and referenced demo parents\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Wire the Demo Data page to delete/reload

**Files:**
- Modify: `src/routes/demo.js` (replace body)
- Modify: `src/views/demo/tools.ejs` (replace body)

**Interfaces:**
- Consumes: `seedDemo`, `insertDemoRows`, `deleteDemo` from `src/db/seed.js`; `requireLogin`, `requireRole` from `src/middleware/auth`; `logAction` from `src/utils/audit`.
- Produces: admin-only `GET /demo-tools`, `POST /demo-tools/delete-demo`, `POST /demo-tools/reload-demo`. (`/demo-tools` is already mounted in `src/app.js` and linked in the sidebar — no change there.)

- [ ] **Step 1: Replace `src/routes/demo.js`**

```js
const express = require('express');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { deleteDemo, insertDemoRows } = require('../db/seed');
const router = express.Router();

// Demo-only tools (admin). "Delete demo data" removes only seed-generated rows
// (keeping anything a trial user created); "Reload demo data" restores the demo
// set without touching customer rows. Remove this module for production.
const adminOnly = requireRole('admin');

router.get('/', requireLogin, adminOnly, (req, res) => {
  res.render('demo/tools', { title: 'Demo Data' });
});

router.post('/delete-demo', requireLogin, adminOnly, (req, res) => {
  deleteDemo();
  logAction(req, 'demo_delete', 'system', null, 'Deleted demo data (kept trial data)');
  res.redirect('/demo-tools?ok=Demo+data+deleted+-+your+trial+data+is+kept');
});

router.post('/reload-demo', requireLogin, adminOnly, (req, res) => {
  deleteDemo();
  insertDemoRows();
  logAction(req, 'demo_reload', 'system', null, 'Reloaded demo data (kept trial data)');
  res.redirect('/demo-tools?ok=Demo+data+reloaded');
});

module.exports = router;
```

- [ ] **Step 2: Replace `src/views/demo/tools.ejs`**

```ejs
<% layout('layout') -%>
<div class="page-head"><h1>Demo Data</h1></div>

<div class="card">
  <p>Manage the sample data separately from anything you create while trying the
  system. <strong>Your trial data is never touched by these buttons, and the demo
  data can always be reloaded.</strong></p>

  <h3 style="margin-top:8px">Delete demo data</h3>
  <p class="hint">Removes the sample clients, debtors, cases, payments and history
  so you see only what you create. Anything you added during the trial stays.</p>
  <form method="post" action="/demo-tools/delete-demo"
        onsubmit="return confirm('Delete the demo sample data? Your own trial data is kept, and demo data can be reloaded anytime.')">
    <button class="btn" type="submit">Delete demo data</button>
  </form>

  <h3 style="margin-top:22px">Reload demo data</h3>
  <p class="hint">Restores the standard demo dataset. Your trial data is left as-is.</p>
  <form method="post" action="/demo-tools/reload-demo"
        onsubmit="return confirm('Reload the standard demo data? Your trial data is kept.')">
    <button class="btn btn-gold" type="submit">Reload demo data</button>
  </form>
</div>
```

- [ ] **Step 3: Module load + view compile check**

Run:
```bash
node -e "require('./src/routes/demo'); const ejs=require('ejs'),fs=require('fs'); ejs.compile(fs.readFileSync('src/views/demo/tools.ejs','utf8'),{filename:'d'}); console.log('OK')"
```
Expected: `OK`.

- [ ] **Step 4: Live smoke**

Reseed and start a server on an unused port:
```bash
npm run seed
PORT=4080 node --no-warnings src/app.js &
sleep 2
B=http://localhost:4080
curl -s -c /tmp/a -b /tmp/a -o /dev/null -d "username=admin&password=admin123" $B/login
# create a trial debtor via the app
curl -s -b /tmp/a -o /dev/null -d "name=Trial+Person&risk_level=low" $B/debtors
# delete demo -> demo debtors gone, trial debtor kept
curl -s -b /tmp/a -o /dev/null -d "" $B/demo-tools/delete-demo
node -e "const d=require('./src/db');d.init();console.log('after delete: demo debtors='+d.get('SELECT COUNT(*) c FROM debtors WHERE is_demo=1').c+' trial debtors='+d.get('SELECT COUNT(*) c FROM debtors WHERE is_demo=0').c)"
# reload -> demo back, trial kept
curl -s -b /tmp/a -o /dev/null -d "" $B/demo-tools/reload-demo
node -e "const d=require('./src/db');d.init();console.log('after reload: demo debtors='+d.get('SELECT COUNT(*) c FROM debtors WHERE is_demo=1').c+' trial debtors='+d.get('SELECT COUNT(*) c FROM debtors WHERE is_demo=0').c)"
```
Expected: after delete → `demo debtors=0 trial debtors=1`; after reload → `demo debtors=12 trial debtors=1`. Kill the server and `npm run seed` to leave a clean DB afterward.

- [ ] **Step 5: Commit**

```bash
git add src/routes/demo.js src/views/demo/tools.ejs
git commit -m "$(printf 'feat: Demo Data page deletes/reloads demo without touching trial data\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- `is_demo` tagging (9 tables, users/audit excluded) → Task 1. ✓
- Seed tags demo rows, fixed parent IDs, idempotent → Task 2. ✓
- deleteDemo keeps customer + referenced demo parents; child→parent order; NULL-in-NOT-IN guards; no sequence reset → Task 3. ✓
- Reload = deleteDemo + insertDemoRows, keeps customer data, no duplicates → Task 3 test + Task 4 route. ✓
- Children attach only to demo cases (payments `WHERE is_demo=1`) → Task 2. ✓
- Replace old demo-tools UI/routes → Task 4. ✓
- Users/audit untouched by delete/reload → Tasks 2–3 (functions never touch them). ✓
- Tests for tagging, idempotency, delete-keeps-referenced, reload-keeps-new → Tasks 2–3. ✓

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `seedDemo` / `clearAllTables` / `insertDemoRows` / `deleteDemo` names match across seed.js exports, tests, and the route. Fixed IDs (cases 1–20, debtors 1–12) consistent between Task 2 insert and Task 3 tests. `is_demo` column name consistent throughout.
