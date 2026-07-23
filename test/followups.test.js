process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-followups-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);
const db = require('../src/db');
db.init();
const { followupTasks } = require('../src/utils/followups');

// Anchor to "today" in Malaysia time (UTC+8), the same reference the SQL
// itself uses (date('now','+8 hours')), so day-boundary math matches exactly.
const todayMYT = dayjs.utc().add(8, 'hour');
const isoDaysFromToday = (n) => todayMYT.add(n, 'day').format('YYYY-MM-DD');

const client = db.run('INSERT INTO clients (company_name) VALUES (?)', ['Test Co']).lastInsertRowid;
const debtor = db.run('INSERT INTO debtors (name) VALUES (?)', ['Test Debtor']).lastInsertRowid;
const agentA = db.run('INSERT INTO agents (name) VALUES (?)', ['Agent A']).lastInsertRowid;
const agentB = db.run('INSERT INTO agents (name) VALUES (?)', ['Agent B']).lastInsertRowid;

function makeCase(agentId, suffix) {
  return db.run('INSERT INTO cases (case_no, client_id, debtor_id, agent_id) VALUES (?,?,?,?)',
    [`DC-TEST-${suffix}`, client, debtor, agentId]).lastInsertRowid;
}

const caseOverdue = makeCase(agentA, '0001');
db.run("INSERT INTO tasks (case_id, agent_id, type, title, due_date, status) VALUES (?,?,'follow_up','Overdue follow-up',?,'pending')",
  [caseOverdue, agentA, isoDaysFromToday(-3)]);

const caseFuture = makeCase(agentA, '0002');
db.run("INSERT INTO tasks (case_id, agent_id, type, title, due_date, status) VALUES (?,?,'follow_up','Far future',?,'pending')",
  [caseFuture, agentA, isoDaysFromToday(20)]);

const caseToday = makeCase(agentB, '0003');
db.run("INSERT INTO tasks (case_id, agent_id, type, title, due_date, status) VALUES (?,?,'follow_up','Due today',?,'pending')",
  [caseToday, agentB, isoDaysFromToday(0)]);

const caseDone = makeCase(agentA, '0004');
db.run("INSERT INTO tasks (case_id, agent_id, type, title, due_date, status) VALUES (?,?,'follow_up','Already done',?,'done')",
  [caseDone, agentA, isoDaysFromToday(1)]);

test('admin sees all pending tasks within the window, excludes done and out-of-window', () => {
  const rows = followupTasks({ role: 'admin' }, 14);
  const titles = rows.map((r) => r.title);
  assert.ok(titles.includes('Overdue follow-up'));
  assert.ok(titles.includes('Due today'));
  assert.ok(!titles.includes('Far future'), 'outside the 14-day window');
  assert.ok(!titles.includes('Already done'), 'done tasks excluded');
});

test('agent only sees own tasks', () => {
  const rows = followupTasks({ role: 'agent', agent_id: agentB }, 14);
  assert.deepStrictEqual(rows.map((r) => r.title), ['Due today']);
});

test('null window means no upper bound', () => {
  const rows = followupTasks({ role: 'admin' }, null);
  assert.ok(rows.map((r) => r.title).includes('Far future'));
});

test('days_over sign matches overdue vs upcoming', () => {
  const rows = followupTasks({ role: 'admin' }, 14);
  const overdue = rows.find((r) => r.title === 'Overdue follow-up');
  const today = rows.find((r) => r.title === 'Due today');
  assert.strictEqual(overdue.days_over, 3);
  assert.strictEqual(today.days_over, 0);
});

test('rows are ordered soonest/most-overdue first', () => {
  const rows = followupTasks({ role: 'admin' }, 14);
  const order = rows.map((r) => r.title);
  assert.deepStrictEqual(order, ['Overdue follow-up', 'Due today']);
});
