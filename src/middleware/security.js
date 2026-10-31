// App-wide request hardening, mounted in app.js. Kept here (not inline in
// app.js, which starts listening on require) so each piece is unit-testable.

// CSRF: refuse a state-changing request whose Origin (or Referer) names another
// host. Browsers send Origin on every cross-site POST, so a forged form from
// another site is stopped; scripts that send neither header are let through.
// ponytail: origin check instead of per-form tokens; add tokens if old browsers matter.
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const src = req.get('origin') || req.get('referer');
  if (src) {
    let host = null;
    try { host = new URL(src).host; } catch { /* malformed → treated as foreign */ }
    if (host !== req.get('host')) return res.status(403).type('text').send('Cross-site request blocked');
  }
  next();
}

function securityHeaders(req, res, next) {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
}

// Flash messages: a redirect carrying ?ok= / ?err= has them moved into the
// session and shown once on the next page, so a crafted link can't put its own
// text in the app's green/red banner.
function flash(req, res, next) {
  res.locals.flash = (req.session && req.session.flash) || null;
  if (req.session) delete req.session.flash;
  const redirect = res.redirect.bind(res);
  res.redirect = (status, url) => {
    if (url === undefined) { url = status; status = 302; }
    const u = new URL(url, 'http://local');
    const ok = u.searchParams.get('ok'), err = u.searchParams.get('err');
    if ((ok || err) && req.session && u.origin === 'http://local') {
      req.session.flash = { ok, err };
      // K-11: a refused form comes back filled in (passwords are never kept).
      if (err && req.method === 'POST' && req.body && typeof req.body === 'object') {
        req.session.flash.form = Object.fromEntries(Object.entries(req.body).filter(([k, v]) => !/password/i.test(k) && typeof v === 'string'));
      }
      u.searchParams.delete('ok'); u.searchParams.delete('err');
      url = u.pathname + u.search + u.hash;
    }
    return redirect(status, url);
  };
  next();
}

// Last-resort handler: log the error, show a plain message — never the stack
// or server paths.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const message = status === 413 ? 'Request too large' : status >= 500 ? 'Something went wrong. Please try again.' : 'Bad request';
  res.status(status).render('error', { message }, (e, html) => (e ? res.type('text').send(message) : res.send(html)));
}

function notFound(req, res) {
  res.status(404).render('error', { message: 'Page not found' });
}

module.exports = { sameOrigin, securityHeaders, flash, errorHandler, notFound };
