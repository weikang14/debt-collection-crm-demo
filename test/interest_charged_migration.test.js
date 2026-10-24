process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-intcharged-migration-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');

// A pre-migration cases table (no interest_charged), created before init()
// runs schema.sql, whose CREATE TABLE IF NOT EXISTS then leaves it alone.
db.exec(`
  CREATE TABLE clients (id INTEGER PRIMARY KEY, company_name TEXT);
  CREATE TABLE debtors (id INTEGER PRIMARY KEY, name TEXT);
  INSERT INTO clients VALUES (1, 'C');
  INSERT INTO debtors VALUES (1, 'D');
  CREATE TABLE cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, case_no TEXT UNIQUE NOT NULL,
    client_id INTEGER NOT NULL, debtor_id INTEGER NOT NULL, agent_id INTEGER,
    principal_amount REAL NOT NULL DEFAULT 0, interest_amount REAL NOT NULL DEFAULT 0,
    outstanding_amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new');
  INSERT INTO cases (case_no, client_id, debtor_id, principal_amount, interest_amount, outstanding_amount)
    VALUES ('OLD-1', 1, 1, 1000, 250, 1250);
`);
db.init();

test('interest_charged is added and backfilled from interest_amount', () => {
  const r = db.get("SELECT interest_amount, interest_charged FROM cases WHERE case_no='OLD-1'");
  assert.strictEqual(r.interest_charged, 250);
  assert.strictEqual(r.interest_amount, 250);
});

test('case_restructures table exists', () => {
  assert.ok(db.all('PRAGMA table_info(case_restructures)').some(c => c.name === 'arrears_at_cut'));
});
