// K-06: sessions in the app's SQLite file instead of express-session's
// MemoryStore, which leaks and drops every login on restart.
const session = require('express-session');
const { get, run } = require('./index');

class SqliteStore extends session.Store {
  get(sid, cb) {
    const row = get('SELECT sess FROM sessions WHERE sid = ? AND expires > ?', [sid, Date.now()]);
    cb(null, row ? JSON.parse(row.sess) : null);
  }
  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
    run('INSERT INTO sessions (sid, sess, expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires',
      [sid, JSON.stringify(sess), expires]);
    // ponytail: expired rows swept on each save; a timer if the table ever grows large.
    run('DELETE FROM sessions WHERE expires <= ?', [Date.now()]);
    cb && cb(null);
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  destroy(sid, cb) { run('DELETE FROM sessions WHERE sid = ?', [sid]); cb && cb(null); }
}
module.exports = { SqliteStore };
