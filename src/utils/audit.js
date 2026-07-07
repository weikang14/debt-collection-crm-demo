const { run } = require('../db');
function logAction(req, action, entityType, entityId, details) {
  // node:sqlite rejects `undefined` bindings, so coerce every optional value to
  // null. A req missing a field (username, ip) must still log, not silently drop.
  const username = req && req.session && req.session.user && req.session.user.username != null
    ? req.session.user.username : null;
  const ip = req && req.ip != null ? req.ip : null;
  try {
    run(`INSERT INTO audit_logs (username, action, entity_type, entity_id, details, ip_address)
         VALUES (?,?,?,?,?,?)`, [username, action, entityType, entityId != null ? entityId : null, details != null ? details : null, ip]);
  } catch (e) { console.error('audit failed:', e.message); }
}
module.exports = { logAction };
