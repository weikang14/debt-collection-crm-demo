const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.CRM_DB_PATH || path.join(DATA_DIR, 'crm.db');
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

// Transaction wrapper: returns a function that executes fn within a transaction
db.transaction = function(fn) {
  return () => {
    try {
      this.exec('BEGIN TRANSACTION');
      fn();
      this.exec('COMMIT');
    } catch (e) {
      this.exec('ROLLBACK');
      throw e;
    }
  };
};

function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Single-row company profile for statement branding (see routes/settings.js)
  db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();

  // Migration: add is_demo columns to existing tables if missing
  const tables = ['agents', 'clients', 'debtors', 'cases', 'timeline_events', 'payments', 'ptps', 'tasks', 'call_logs'];
  for (const t of tables) {
    try {
      db.prepare(`ALTER TABLE ${t} ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`).run();
    } catch (e) {
      // Column already exists, ignore
    }
  }
  // Migration: fold next_action_at (a bare date on the case) into a
  // follow_up task per case, then drop the column. tasks is now the single
  // source of truth for follow-ups. One-time: once the column is gone, the
  // SELECT below throws "no such column" and the whole block is a no-op,
  // same idiom as the ALTERs above.
  try {
    const rows = db.prepare(
      "SELECT id, agent_id, case_no, next_action_at FROM cases WHERE next_action_at IS NOT NULL"
    ).all();
    for (const r of rows) {
      db.prepare(
        `INSERT INTO tasks (case_id, agent_id, type, title, due_date, status) VALUES (?, ?, 'follow_up', ?, ?, 'pending')`
      ).run(r.id, r.agent_id, `跟进 ${r.case_no}`, r.next_action_at);
    }
    db.prepare('ALTER TABLE cases DROP COLUMN next_action_at').run();
  } catch (e) { /* already migrated, or column never existed */ }
  // Migration: installment-plan grouping on ptps (nullable; NULL = standalone PTP)
  try { db.prepare('ALTER TABLE ptps ADD COLUMN plan_id TEXT').run(); } catch (e) { /* exists */ }
  try { db.prepare('ALTER TABLE ptps ADD COLUMN installment_no INTEGER').run(); } catch (e) { /* exists */ }
  try { db.prepare('ALTER TABLE ptps ADD COLUMN plan_size INTEGER').run(); } catch (e) { /* exists */ }
  // Migration: per-case interest model (see schema.sql). Default keeps old cases fixed.
  try { db.prepare("ALTER TABLE cases ADD COLUMN interest_mode TEXT NOT NULL DEFAULT 'fixed'").run(); } catch (e) { /* exists */ }
  try { db.prepare('ALTER TABLE cases ADD COLUMN interest_rate REAL NOT NULL DEFAULT 0').run(); } catch (e) { /* exists */ }
  try { db.prepare('ALTER TABLE cases ADD COLUMN interest_from TEXT').run(); } catch (e) { /* exists */ }
  // Migration: loan tenure & maturity date on cases (nullable; both start_date and
  // tenure must be present for maturity_date to be computed — see tenureFields()).
  try { db.prepare('ALTER TABLE cases ADD COLUMN loan_start_date TEXT').run(); } catch (e) { /* exists */ }
  try { db.prepare('ALTER TABLE cases ADD COLUMN tenure INTEGER').run(); } catch (e) { /* exists */ }
  try { db.prepare("ALTER TABLE cases ADD COLUMN tenure_unit TEXT NOT NULL DEFAULT 'months'").run(); } catch (e) { /* exists */ }
  try { db.prepare('ALTER TABLE cases ADD COLUMN maturity_date TEXT').run(); } catch (e) { /* exists */ }
  // Migration: allow timeline event_type 'restructure'. SQLite can't alter a
  // CHECK list, so the table is rebuilt once (rows copied as-is, ids kept);
  // skipped when the stored definition already lists the type.
  const tl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='timeline_events'").get();
  if (tl && !tl.sql.includes("'restructure'")) {
    db.exec(`BEGIN;
      CREATE TABLE timeline_events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL REFERENCES cases(id),
        event_type TEXT NOT NULL CHECK (event_type IN
          ('call','whatsapp','email','payment','ptp_created','ptp_fulfilled','ptp_broken','note','status_change','legal','restructure')),
        content TEXT NOT NULL, created_by TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO timeline_events_new (id, case_id, event_type, content, created_by, is_demo, created_at)
        SELECT id, case_id, event_type, content, created_by, is_demo, created_at FROM timeline_events;
      DROP TABLE timeline_events;
      ALTER TABLE timeline_events_new RENAME TO timeline_events;
      CREATE INDEX IF NOT EXISTS idx_timeline_case ON timeline_events(case_id);
      COMMIT;`);
  }
  // Migration: interest_charged = cached total interest (see schema.sql). The
  // one-time backfill copies interest_amount, which held that cache for accrual
  // cases and the charged lump for fixed ones — correct either way. Runs only
  // when the ALTER succeeds.
  try {
    db.prepare('ALTER TABLE cases ADD COLUMN interest_charged REAL NOT NULL DEFAULT 0').run();
    db.prepare('UPDATE cases SET interest_charged = interest_amount').run();
  } catch (e) { /* exists */ }
  // Migration: payments.agent_id = collector of record (commission follows it).
  // One-time backfill with each case's current agent — the best history we have.
  try {
    db.prepare('ALTER TABLE payments ADD COLUMN agent_id INTEGER REFERENCES agents(id)').run();
    db.prepare('UPDATE payments SET agent_id = (SELECT agent_id FROM cases WHERE cases.id = payments.case_id)').run();
  } catch (e) { /* exists */ }
  // Migration: legal rate cap setting (default 18% p.a.).
  try { db.prepare('ALTER TABLE settings ADD COLUMN max_annual_rate REAL NOT NULL DEFAULT 18').run(); } catch (e) { /* exists */ }
  // Migration: PTP status 'partially_kept'. Same one-time rebuild as the
  // timeline above (SQLite can't alter a CHECK list); rows and ids kept.
  const pt = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ptps'").get();
  if (pt && !pt.sql.includes("'partially_kept'")) {
    db.exec(`BEGIN;
      CREATE TABLE ptps_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL REFERENCES cases(id),
        amount REAL NOT NULL, due_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fulfilled','partially_kept','broken')),
        remark TEXT, created_by TEXT,
        plan_id TEXT, installment_no INTEGER, plan_size INTEGER,
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO ptps_new (id, case_id, amount, due_date, status, remark, created_by, plan_id, installment_no, plan_size, is_demo, created_at)
        SELECT id, case_id, amount, due_date, status, remark, created_by, plan_id, installment_no, plan_size, is_demo, created_at FROM ptps;
      DROP TABLE ptps;
      ALTER TABLE ptps_new RENAME TO ptps;
      CREATE INDEX IF NOT EXISTS idx_ptps_case_status ON ptps(case_id, status);
      COMMIT;`);
  }
}
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }
function exec(sql) { return db.exec(sql); }

module.exports = { db, init, get, all, run, exec };
