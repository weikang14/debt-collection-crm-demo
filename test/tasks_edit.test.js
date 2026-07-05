process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-tasksedit-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
seed.seedDemo();

test('task update changes editable fields', () => {
  const t = db.get('SELECT id FROM tasks LIMIT 1');
  db.run('UPDATE tasks SET title=?, type=?, due_date=?, notes=? WHERE id=?',
    ['Edited title', 'visit', '2026-08-01', 'edited notes', t.id]);
  const row = db.get('SELECT * FROM tasks WHERE id=?', [t.id]);
  assert.strictEqual(row.title, 'Edited title');
  assert.strictEqual(row.type, 'visit');
  assert.strictEqual(row.notes, 'edited notes');
});
