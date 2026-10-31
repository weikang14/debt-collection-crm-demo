const express = require('express');
const multer = require('multer');
const { db, get, all, run } = require('../db');
const { LEGAL_MAX_RATE, maxAnnualRate, nominalAnnualRate } = require('../services/payments');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { LOGO_MIME, MAX_LOGO_BYTES, toDataUrl } = require('../utils/logo');
const { dueForRemoval, anonymizeDebtor } = require('../services/retention');
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
// F-35: whole years, not below the 6-year limitation period; blank keeps it.
function parseRetention(raw, current) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: current ?? 7 };
  if (!/^\d+$/.test(s) || Number(s) < 6 || Number(s) > 99) return { error: 'Retention period must be a whole number of years from 6 (the limitation period) to 99' };
  return { value: Number(s) };
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
  res.render('settings/form', { title: 'Company Settings', s, cap, overCap, due: dueForRemoval() });
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
    const licence_no = (b.licence_no || '').trim().slice(0, 60);
    const old = get('SELECT * FROM settings WHERE id=1') || {};
    const rate = parseMaxRate(b.max_annual_rate, old.max_annual_rate);
    if (rate.error) return res.redirect('/settings?err=' + encodeURIComponent(rate.error));
    const max_annual_rate = rate.value;
    const keep = parseRetention(b.retention_years, old.retention_years);
    if (keep.error) return res.redirect('/settings?err=' + encodeURIComponent(keep.error));
    const retention_years = keep.value;

    // Logo precedence: remove wins, then a new upload, else keep the existing.
    let logo;
    if (b.remove_logo) {
      logo = '';
    } else if (req.file) {
      logo = toDataUrl(req.file.mimetype, req.file.buffer);
    } else {
      logo = (get('SELECT logo FROM settings WHERE id=1') || {}).logo || '';
    }

    const changes = settingsChanges(old, { company_name, address, phone, email, reg_no, licence_no, logo, max_annual_rate, retention_years });
    // The upload callback runs after the per-request transaction (app.js) closed.
    db.transaction(() => {
      run(`UPDATE settings SET company_name=?, address=?, phone=?, email=?, reg_no=?, licence_no=?, logo=?, max_annual_rate=?, retention_years=?, updated_at=datetime('now') WHERE id=1`,
        [company_name, address, phone, email, reg_no, licence_no, logo, max_annual_rate, retention_years]);
      logAction(req, 'update', 'settings', 1, `Updated company settings${changes.length ? ': ' + changes.join('; ') : ' (no changes)'}`);
    })();
    res.redirect('/settings?ok=' + encodeURIComponent('Company settings saved'));
  });
});

// F-35: remove the personal data of every debtor past the retention period.
router.post('/anonymize', requireLogin, adminOnly, (req, res) => {
  if (req.body.confirm !== '1') return res.redirect('/settings?err=' + encodeURIComponent('Tick the box to confirm the removal'));
  const { years, list } = dueForRemoval();
  for (const d of list) {
    anonymizeDebtor(d.id);
    // The audit log keeps who the debtor was (name and IC, decided 2026-11-01), so it stays known they were on file.
    logAction(req, 'anonymize', 'debtor', d.id, `Removed the personal data of debtor #${d.id} ${d.name}${d.ic ? ` (IC ${d.ic})` : ''} — ${years}-year retention period; last activity ${d.last}`);
  }
  res.redirect('/settings?ok=' + encodeURIComponent(list.length ? `Personal data removed for ${list.length} debtor(s)` : 'No debtor is past the retention period'));
});

module.exports = router;
module.exports.parseMaxRate = parseMaxRate;
module.exports.parseRetention = parseRetention;
module.exports.settingsChanges = settingsChanges;
