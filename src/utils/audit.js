const { run } = require('../db');
// One row of a log table. node:sqlite rejects `undefined` bindings, so every
// optional value is coerced to null: a req missing a field must still log.
function write(table, req, action, entityType, entityId, details) {
  const username = req && req.session && req.session.user && req.session.user.username != null
    ? req.session.user.username : null;
  const ip = req && req.ip != null ? req.ip : null;
  run(`INSERT INTO ${table} (username, action, entity_type, entity_id, details, ip_address)
       VALUES (?,?,?,?,?,?)`, [username, action, entityType, entityId != null ? entityId : null, details != null ? details : null, ip]);
}
// A change. Throws when the row can't be written: every POST runs in one
// transaction (app.js), so the change it records is rolled back with it —
// nothing changes without a trace (G-25).
const logAction = (req, action, entityType, entityId, details) => write('audit_logs', req, action, entityType, entityId, details);
// A look at personal data (F-31): a case or debtor page, a search, a printout.
const logAccess = (req, action, entityType, entityId, details) => write('access_logs', req, action, entityType, entityId, details);
// "field: old → new" for each field an edit changed — the audit text of an update.
const changeList = (old, next) => Object.keys(next)
  .filter(k => String(old[k] ?? '') !== String(next[k] ?? ''))
  .map(k => `${k}: ${old[k] ?? '—'} → ${next[k] ?? '—'}`);
module.exports = { logAction, logAccess, changeList };
