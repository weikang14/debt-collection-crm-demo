const { run } = require('../db');
// Throws when the row can't be written. Every POST runs in one transaction
// (app.js), so the change it records is rolled back with it: nothing changes
// without a trace (G-25).
function logAction(req, action, entityType, entityId, details) {
  // node:sqlite rejects `undefined` bindings, so coerce every optional value to
  // null. A req missing a field (username, ip) must still log, not silently drop.
  const username = req && req.session && req.session.user && req.session.user.username != null
    ? req.session.user.username : null;
  const ip = req && req.ip != null ? req.ip : null;
  run(`INSERT INTO audit_logs (username, action, entity_type, entity_id, details, ip_address)
       VALUES (?,?,?,?,?,?)`, [username, action, entityType, entityId != null ? entityId : null, details != null ? details : null, ip]);
}
// "field: old → new" for each field an edit changed — the audit text of an update.
const changeList = (old, next) => Object.keys(next)
  .filter(k => String(old[k] ?? '') !== String(next[k] ?? ''))
  .map(k => `${k}: ${old[k] ?? '—'} → ${next[k] ?? '—'}`);
module.exports = { logAction, changeList };
