process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-tlmigration-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');

// A pre-migration timeline_events whose CHECK list has no 'restructure',
// created before init() so schema.sql's CREATE TABLE IF NOT EXISTS skips it.
db.exec(`
  CREATE TABLE clients (id INTEGER PRIMARY KEY, company_name TEXT);
  CREATE TABLE debtors (id INTEGER PRIMARY KEY, name TEXT);
  INSERT INTO clients VALUES (1, 'C');
  INSERT INTO debtors VALUES (1, 'D');
  CREATE TABLE cases (id INTEGER PRIMARY KEY AUTOINCREMENT, case_no TEXT UNIQUE NOT NULL,
    client_id INTEGER NOT NULL, debtor_id INTEGER NOT NULL, agent_id INTEGER, status TEXT NOT NULL DEFAULT 'new');
  INSERT INTO cases (id, case_no, client_id, debtor_id) VALUES (1, 'OLD-1', 1, 1);
  CREATE TABLE timeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES cases(id),
    event_type TEXT NOT NULL CHECK (event_type IN
      ('call','whatsapp','email','payment','ptp_created','ptp_fulfilled','ptp_broken','note','status_change','legal')),
    content TEXT NOT NULL, created_by TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO timeline_events (id, case_id, event_type, content, created_by, is_demo, created_at)
    VALUES (7, 1, 'note', 'kept', 'Tester', 1, '2026-01-02 03:04:05');
`);
db.init();

test('existing timeline rows survive the rebuild unchanged', () => {
  assert.deepStrictEqual({ ...db.get('SELECT * FROM timeline_events WHERE id=7') },
    { id: 7, case_id: 1, event_type: 'note', content: 'kept', created_by: 'Tester', is_demo: 1, created_at: '2026-01-02 03:04:05' });
});

test("event_type 'restructure' is accepted and unknown types still rejected", () => {
  db.run("INSERT INTO timeline_events (case_id,event_type,content) VALUES (1,'restructure','Restructure: x')");
  assert.throws(() => db.run("INSERT INTO timeline_events (case_id,event_type,content) VALUES (1,'bogus','x')"), /CHECK/);
});
