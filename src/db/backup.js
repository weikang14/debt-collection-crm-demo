// One-command backup: a consistent copy of the database (CRM_DB_PATH, default
// data/crm.db) to backups/<name>-<timestamp>.db beside it.
// Usage: npm run backup   (restore = stop the app, copy a backup over the database file)
// VACUUM INTO takes a transaction-consistent snapshot, so it is safe while the
// app is running — a plain file copy could catch a half-written page (K-08).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const src = path.resolve(process.env.CRM_DB_PATH || path.join(__dirname, '..', '..', 'data', 'crm.db'));
const dir = path.join(path.dirname(src), 'backups');

if (!fs.existsSync(src)) {
  console.error(`No database found at ${src} — nothing to back up. Run \`npm run seed\` first.`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // e.g. 2026-07-03T12-30-45
const dest = path.join(dir, `${path.basename(src, '.db')}-${stamp}.db`);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
console.log('Backup created: ' + dest);
