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
