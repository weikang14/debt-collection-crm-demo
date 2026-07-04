const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.CRM_DB_PATH || path.join(DATA_DIR, 'crm.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Migration: add is_demo columns to existing tables if missing
  const tables = ['agents', 'clients', 'debtors', 'cases', 'timeline_events', 'payments', 'ptps', 'tasks', 'call_logs'];
  for (const t of tables) {
    try {
      db.prepare(`ALTER TABLE ${t} ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`).run();
    } catch (e) {
      // Column already exists, ignore
    }
  }
}
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }
function exec(sql) { return db.exec(sql); }

module.exports = { db, init, get, all, run, exec };
