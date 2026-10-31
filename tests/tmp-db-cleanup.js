// Preloaded by `npm test` into every test file: each file points CRM_DB_PATH at a throwaway
// database in the temp folder; delete it (and a crm-* folder made for it) when the file exits,
// so test runs no longer pile up files in the temp folder.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.on('exit', () => {
  const p = process.env.CRM_DB_PATH && path.resolve(process.env.CRM_DB_PATH);
  const tmp = path.resolve(os.tmpdir());
  if (!p || !p.startsWith(tmp + path.sep)) return;
  const mod = require.cache[require.resolve('../src/db')];
  try { if (mod) mod.exports.db.close(); } catch { /* already closed */ }
  try {
    for (const f of [p, `${p}-wal`, `${p}-shm`, `${p}-journal`]) fs.rmSync(f, { force: true });
    // only a crm-* folder made directly in the temp folder (mkdtemp), never the temp folder itself
    const dir = path.dirname(p);
    if (path.dirname(dir) === tmp && path.basename(dir).startsWith('crm-')) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* still open elsewhere: leave it, never fail the test run */ }
});
