const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.CRM_DB_PATH || path.join(DATA_DIR, 'crm.db');

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
  // Migration: next follow-up date on cases (nullable, no default)
  try { db.prepare('ALTER TABLE cases ADD COLUMN next_action_at TEXT').run(); } catch (e) { /* exists */ }
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
}
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }
function exec(sql) { return db.exec(sql); }

module.exports = { db, init, get, all, run, exec };
