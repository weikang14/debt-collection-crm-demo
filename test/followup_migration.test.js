process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-followupmigration-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');

// Simulate a pre-migration database: a minimal `cases` table that still has
// the old next_action_at column, seeded BEFORE init() ever runs schema.sql
// (which, after this change, no longer declares that column) or the
// migration block. `CREATE TABLE IF NOT EXISTS` in schema.sql will not
// touch this table since it already exists.
db.exec(`
  CREATE TABLE clients (id INTEGER PRIMARY KEY, company_name TEXT);
  CREATE TABLE debtors (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT);
  INSERT INTO clients VALUES (1, 'Test Client');
  INSERT INTO debtors VALUES (1, 'Test Debtor');
  INSERT INTO agents VALUES (7, 'Test Agent');
`);

db.exec(`CREATE TABLE cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no TEXT UNIQUE NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  debtor_id INTEGER NOT NULL REFERENCES debtors(id),
  agent_id INTEGER REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'new',
  next_action_at TEXT
)`);
db.run('INSERT INTO cases (case_no, client_id, debtor_id, agent_id, next_action_at) VALUES (?,?,?,?,?)', ['DC-TEST-0001', 1, 1, 7, '2026-08-01']);
db.run('INSERT INTO cases (case_no, client_id, debtor_id, agent_id, next_action_at) VALUES (?,?,?,?,?)', ['DC-TEST-0002', 1, 1, null, null]);

db.init();

test('next_action_at backfills into a follow_up task', () => {
  const row = db.get("SELECT id FROM cases WHERE case_no='DC-TEST-0001'");
  const t = db.get('SELECT * FROM tasks WHERE case_id=?', [row.id]);
  assert.ok(t, 'expected a task to be created for the case');
  assert.strictEqual(t.type, 'follow_up');
  assert.strictEqual(t.due_date, '2026-08-01');
  assert.strictEqual(t.status, 'pending');
  assert.strictEqual(t.agent_id, 7);
  assert.strictEqual(t.title, '跟进 DC-TEST-0001');
});

test('a case with no next_action_at gets no task', () => {
  const row = db.get("SELECT id FROM cases WHERE case_no='DC-TEST-0002'");
  const t = db.get('SELECT * FROM tasks WHERE case_id=?', [row.id]);
  assert.strictEqual(t, undefined);
});

test('next_action_at column is dropped from cases', () => {
  const cols = db.all('PRAGMA table_info(cases)');
  assert.ok(!cols.some((c) => c.name === 'next_action_at'));
});
