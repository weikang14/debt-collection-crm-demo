# Authorization Boundary Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove with real seeded data that an `agent` user can never retrieve another agent's cases/debtors/tasks through the actual scope loaders — not just that the `caseWhere` string looks right.

**Architecture:** One DB-isolated test file seeds two agents' data plus a manager, then runs the same scoped queries the routes use (`caseWhere`, `reachableDebtorIds`, `reachableClientIds`, plus the tasks predicate) and asserts agent A sees only A's rows while a manager sees both.

**Tech Stack:** Node.js ≥22.5, node:sqlite (DatabaseSync), node:test.

## Global Constraints

- Node.js ≥22.5; no new npm dependencies; no supertest / HTTP harness.
- Test isolates the DB via `process.env.CRM_DB_PATH` set BEFORE requiring `../src/db`.
- No production code changes. This task adds a test only. If it surfaces a real scope leak, STOP and report it (fixing is out of this task's scope).
- Assert against `src/utils/scope.js` (`caseWhere`, `reachableDebtorIds`, `reachableClientIds`) and the same SQL the routes run — the loader layer where leaks actually occur.

---

## File Structure

- **Create** `test/scope_boundary.test.js` — the entire deliverable.

---

### Task 1: End-to-end agent scope isolation test

**Files:**
- Create: `test/scope_boundary.test.js`

**Interfaces:**
- Consumes: `src/db` (`init`, `run`, `all`), `src/utils/scope.js` (`caseWhere`, `reachableDebtorIds`, `reachableClientIds`).

- [ ] **Step 1: Write the test**

Create `test/scope_boundary.test.js`:

```js
const { test, before } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.CRM_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-scope-')), 'crm.db');
const { init, run, all } = require('../src/db');
const { caseWhere, reachableDebtorIds, reachableClientIds } = require('../src/utils/scope');

// Two agents, each with their own client/debtor/case/task/payment.
before(() => {
  init();
  run("INSERT INTO agents (id,name) VALUES (1,'A'),(2,'B')");
  run("INSERT INTO clients (id,company_name,commission_rate) VALUES (10,'CliA',0),(20,'CliB',0)");
  run("INSERT INTO debtors (id,name) VALUES (100,'DebA'),(200,'DebB')");
  run("INSERT INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,status) VALUES (1000,'KA',10,100,1,1000,0,1000,'new')");
  run("INSERT INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,status) VALUES (2000,'KB',20,200,2,2000,0,2000,'new')");
  run("INSERT INTO tasks (id,case_id,agent_id,title,status) VALUES (1,1000,1,'TA','pending'),(2,2000,2,'TB','pending')");
});

const userA = { role: 'agent', agent_id: 1 };
const userB = { role: 'agent', agent_id: 2 };
const manager = { role: 'manager' };

// Run the same case query shape the routes use, with a given user's scope clause.
function casesFor(user) {
  const w = caseWhere(user);
  return all(`SELECT id FROM cases WHERE ${w.clause}`, w.params).map(r => r.id);
}

test('agent A case query returns only A cases', () => {
  assert.deepStrictEqual(casesFor(userA), [1000]);
});

test('single-case load (loadCase clause) denies B case to agent A', () => {
  const w = caseWhere(userA);
  const own = all(`SELECT id FROM cases WHERE id=? AND ${w.clause}`, [1000, ...w.params]);
  const foreign = all(`SELECT id FROM cases WHERE id=? AND ${w.clause}`, [2000, ...w.params]);
  assert.strictEqual(own.length, 1);
  assert.strictEqual(foreign.length, 0); // the 404 / access-denied path
});

test('reachable debtor/client ids exclude the other agent', () => {
  assert.deepStrictEqual(reachableDebtorIds(userA), [100]);
  assert.deepStrictEqual(reachableClientIds(userA), [10]);
  assert.deepStrictEqual(reachableDebtorIds(userB), [200]);
});

test('tasks scope (agent predicate) returns only own tasks', () => {
  const rows = all('SELECT id FROM tasks WHERE agent_id = ?', [userA.agent_id]).map(r => r.id);
  assert.deepStrictEqual(rows, [1]);
});

test('manager (unscoped) sees BOTH cases — proves scope is the only filter', () => {
  assert.deepStrictEqual(casesFor(manager).sort((x, y) => x - y), [1000, 2000]);
});
```

- [ ] **Step 2: Run the test**

Run: `npx node --no-warnings --test test/scope_boundary.test.js`
Expected: PASS — 5 tests. (If the `foreign.length === 0` or `manager sees both` assertions fail, that is a real scope leak — STOP and report; do not "fix" the test to pass.)

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: all tests pass (existing + these 5), 0 fail.

- [ ] **Step 4: Commit**

```bash
git add test/scope_boundary.test.js
git commit -m "test: end-to-end agent scope isolation (cases/debtors/clients/tasks)"
```

---

## Self-Review Notes

- **Spec coverage:** case-load clause (test 2), cases-list scope (test 1), reachable debtor/client (test 3), tasks scope (test 4), manager-sees-both control (test 5). All five spec assertions mapped. No production changes, per spec.
- **Placeholder scan:** none.
- **Note:** this is a single-task plan because the whole deliverable is one cohesive test file with one review gate. Not decomposed further per the right-sizing guidance.
