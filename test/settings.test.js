const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Use a throwaway DB file so we don't touch the real one.
const tmp = path.join(os.tmpdir(), `crm-settings-${process.pid}-${Date.now()}.db`);
process.env.CRM_DB_PATH = tmp;
const db = require('../src/db');
db.init();
test.after(() => { try { fs.rmSync(tmp, { force: true }); } catch (e) {} });

test('settings has a default row id=1 with empty fields', () => {
  const s = db.get('SELECT * FROM settings WHERE id=1');
  assert.ok(s, 'default settings row exists');
  assert.strictEqual(s.company_name, '');
  assert.strictEqual(s.logo, '');
});

test('settings update round-trips', () => {
  db.run("UPDATE settings SET company_name=?, phone=? WHERE id=1", ['Acme Recovery', '03-1234']);
  const s = db.get('SELECT * FROM settings WHERE id=1');
  assert.strictEqual(s.company_name, 'Acme Recovery');
  assert.strictEqual(s.phone, '03-1234');
});

const logo = require('../src/utils/logo');

test('toDataUrl builds a base64 data URL', () => {
  const url = logo.toDataUrl('image/png', Buffer.from('hi'));
  assert.strictEqual(url, 'data:image/png;base64,aGk=');
});

test('LOGO_MIME allows png/jpeg/svg/webp only', () => {
  assert.deepStrictEqual(
    [...logo.LOGO_MIME].sort(),
    ['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp']);
  assert.strictEqual(logo.MAX_LOGO_BYTES, 512 * 1024);
});
