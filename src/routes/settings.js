const express = require('express');
const multer = require('multer');
const { db, get, all, run } = require('../db');
const { LEGAL_MAX_RATE, maxAnnualRate, nominalAnnualRate } = require('../services/payments');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { LOGO_MIME, MAX_LOGO_BYTES, toDataUrl } = require('../utils/logo');
const router = express.Router();

const adminOnly = requireRole('admin');

// The rate cap may only be set at or below the Act 400 ceiling (N-03); blank keeps it.
function parseMaxRate(raw, current) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: current ?? LEGAL_MAX_RATE };
  const n = Number(s);
  if (!/^\d+(\.\d+)?$/.test(s) || !(n > 0) || n > LEGAL_MAX_RATE) {
    return { error: `Max annual interest rate must be above 0 and at most ${LEGAL_MAX_RATE}% (the legal limit)` };
  }
  return { value: n };
}
// Audit text for what changed, old → new (the logo is reported, not dumped).
const settingsChanges = (old, next) => Object.keys(next)
  .filter(k => String(old[k] ?? '') !== String(next[k] ?? ''))
  .map(k => (k === 'logo' ? 'logo changed' : `${k}: ${old[k] ?? '—'} → ${next[k] ?? '—'}`));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES },
  fileFilter: (req, file, cb) => {
    if (LOGO_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Logo must be PNG, JPEG, SVG or WebP'));
  },
}).single('logo');

router.get('/', requireLogin, adminOnly, (req, res) => {
  const s = get('SELECT * FROM settings WHERE id=1') || {};
  // Open loans whose terms are above the current cap (after it was lowered).
  const cap = maxAnnualRate();
  const overCap = all(`SELECT id, case_no, principal_amount, interest_mode, interest_rate, interest_amount, tenure FROM cases
    WHERE status NOT IN ('closed','cancelled') AND outstanding_amount > 0`)
    .map(c => ({ ...c, rate: nominalAnnualRate(c, c.principal_amount) }))
    .filter(c => c.rate !== null && c.rate > cap + 1e-9);
  res.render('settings/form', { title: 'Company Settings', s, cap, overCap });
});

router.post('/', requireLogin, adminOnly, (req, res) => {
  upload(req, res, (err) => {
    if (err) return res.redirect('/settings?err=' + encodeURIComponent(err.message));
    const b = req.body;
    const company_name = (b.company_name || '').trim();
    const address = (b.address || '').trim();
    const phone = (b.phone || '').trim();
    const email = (b.email || '').trim();
    const reg_no = (b.reg_no || '').trim();
    const old = get('SELECT * FROM settings WHERE id=1') || {};
    const rate = parseMaxRate(b.max_annual_rate, old.max_annual_rate);
    if (rate.error) return res.redirect('/settings?err=' + encodeURIComponent(rate.error));
    const max_annual_rate = rate.value;

    // Logo precedence: remove wins, then a new upload, else keep the existing.
    let logo;
    if (b.remove_logo) {
      logo = '';
    } else if (req.file) {
      logo = toDataUrl(req.file.mimetype, req.file.buffer);
    } else {
      logo = (get('SELECT logo FROM settings WHERE id=1') || {}).logo || '';
    }

    const changes = settingsChanges(old, { company_name, address, phone, email, reg_no, logo, max_annual_rate });
    // The upload callback runs after the per-request transaction (app.js) closed.
    db.transaction(() => {
      run(`UPDATE settings SET company_name=?, address=?, phone=?, email=?, reg_no=?, logo=?, max_annual_rate=?, updated_at=datetime('now') WHERE id=1`,
        [company_name, address, phone, email, reg_no, logo, max_annual_rate]);
      logAction(req, 'update', 'settings', 1, `Updated company settings${changes.length ? ': ' + changes.join('; ') : ' (no changes)'}`);
    })();
    res.redirect('/settings?ok=' + encodeURIComponent('Company settings saved'));
  });
});

module.exports = router;
module.exports.parseMaxRate = parseMaxRate;
module.exports.settingsChanges = settingsChanges;
