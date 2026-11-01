// First admin for a database that starts empty (a customer server without the
// demo data): `npm run create-admin -- <username>`. Prints a one-time random
// password; change it after the first login (Users → Reset PW).
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { init, get, run } = require('./index');
const { HASH_COST } = require('../utils/forms');
const { logAction } = require('../utils/audit');

init();
const username = (process.argv[2] || '').trim();
if (!username) { console.error('Usage: npm run create-admin -- <username>'); process.exit(1); }
if (get('SELECT 1 x FROM users WHERE username=?', [username])) { console.error(`User "${username}" already exists`); process.exit(1); }
const password = crypto.randomBytes(12).toString('base64url');
const r = run("INSERT INTO users (username,password_hash,full_name,role) VALUES (?,?,'System Admin','admin')", [username, bcrypt.hashSync(password, HASH_COST)]);
logAction(null, 'create', 'user', r.lastInsertRowid, `Created admin ${username} from the command line`);
console.log(`Admin "${username}" created. One-time password: ${password}\nLog in and change it under Users → Reset PW.`);
