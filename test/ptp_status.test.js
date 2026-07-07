process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-ptpstatus-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
seed.seedDemo();
const { breakPtp } = require('../src/routes/ptps');

const req = { session: { user: { full_name: 'Tester', username: 'tester' } }, ip: '127.0.0.1' };

test('breaking the only pending PTP reverts case status ptp -> negotiation', () => {
  const c = db.get('SELECT id FROM cases LIMIT 1');
  db.run("UPDATE cases SET status='ptp' WHERE id=?", [c.id]);
  const p = db.run("INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (?,?,?,?,?)", [c.id, 100, '2026-08-01', 'pending', 'Tester']);
  const r = breakPtp(p.lastInsertRowid, req);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [p.lastInsertRowid]).status, 'broken');
  assert.strictEqual(db.get('SELECT status FROM cases WHERE id=?', [c.id]).status, 'negotiation');
});

test('breaking one PTP while another is still pending keeps status ptp', () => {
  const c = db.get('SELECT id FROM cases WHERE id NOT IN (SELECT id FROM cases LIMIT 1) LIMIT 1');
  db.run("UPDATE cases SET status='ptp' WHERE id=?", [c.id]);
  const p1 = db.run("INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (?,?,?,?,?)", [c.id, 100, '2026-08-01', 'pending', 'Tester']);
  db.run("INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (?,?,?,?,?)", [c.id, 200, '2026-09-01', 'pending', 'Tester']);
  breakPtp(p1.lastInsertRowid, req);
  assert.strictEqual(db.get('SELECT status FROM cases WHERE id=?', [c.id]).status, 'ptp');
});
