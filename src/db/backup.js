// One-command backup: copies data/crm.db to data/backups/crm-<timestamp>.db
// Usage: npm run backup   (restore = copy a file from data/backups back to data/crm.db)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const src = path.join(root, 'data', 'crm.db');
const dir = path.join(root, 'data', 'backups');

if (!fs.existsSync(src)) {
  console.error('No database found at data/crm.db — nothing to back up. Run `npm run seed` first.');
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // e.g. 2026-07-03T12-30-45
const dest = path.join(dir, `crm-${stamp}.db`);
fs.copyFileSync(src, dest);
console.log('Backup created: ' + path.relative(root, dest));
