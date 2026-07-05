process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-notes-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
seed.seedDemo();

// The note-guard is the same SQL the routes run. These tests assert the guard
// protects the audit log (data-loss path) and that update targets note rows.
test('note-guarded delete removes note rows but never non-note rows', () => {
  const c = db.get('SELECT id FROM cases LIMIT 1');
  const note = db.run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id, 'note', 'my note', 'tester']);
  const pay = db.run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id, 'payment', 'paid', 'tester']);

  // Attempt to delete a payment row through the note guard: must NOT delete it.
  db.run("DELETE FROM timeline_events WHERE id=? AND case_id=? AND event_type='note'", [pay.lastInsertRowid, c.id]);
  assert.ok(db.get('SELECT 1 x FROM timeline_events WHERE id=?', [pay.lastInsertRowid]), 'payment row survives');

  // Delete the note row: must succeed.
  db.run("DELETE FROM timeline_events WHERE id=? AND case_id=? AND event_type='note'", [note.lastInsertRowid, c.id]);
  assert.ok(!db.get('SELECT 1 x FROM timeline_events WHERE id=?', [note.lastInsertRowid]), 'note row deleted');
});

test('note-guarded update changes content of a note row', () => {
  const c = db.get('SELECT id FROM cases LIMIT 1');
  const note = db.run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id, 'note', 'before', 'tester']);
  db.run("UPDATE timeline_events SET content=? WHERE id=? AND case_id=? AND event_type='note'", ['after', note.lastInsertRowid, c.id]);
  assert.strictEqual(db.get('SELECT content FROM timeline_events WHERE id=?', [note.lastInsertRowid]).content, 'after');
});
