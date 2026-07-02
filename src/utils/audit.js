const { run } = require('../db');
function logAction(req, action, entityType, entityId, details) {
  try {
    const username = req && req.session && req.session.user ? req.session.user.username : null;
    const ip = req ? req.ip : null;
    run(`INSERT INTO audit_logs (username, action, entity_type, entity_id, details, ip_address)
         VALUES (?,?,?,?,?,?)`, [username, action, entityType, entityId || null, details || null, ip]);
  } catch (e) { console.error('audit failed:', e.message); }
}
module.exports = { logAction };
