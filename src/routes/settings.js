const express = require('express');
const multer = require('multer');
const { get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { LOGO_MIME, MAX_LOGO_BYTES, toDataUrl } = require('../utils/logo');
const router = express.Router();

const adminOnly = requireRole('admin');

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
  res.render('settings/form', { title: 'Company Settings', s });
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

    // Logo precedence: remove wins, then a new upload, else keep the existing.
    let logo;
    if (b.remove_logo) {
      logo = '';
    } else if (req.file) {
      logo = toDataUrl(req.file.mimetype, req.file.buffer);
    } else {
      logo = (get('SELECT logo FROM settings WHERE id=1') || {}).logo || '';
    }

    run(`UPDATE settings SET company_name=?, address=?, phone=?, email=?, reg_no=?, logo=?, updated_at=datetime('now') WHERE id=1`,
      [company_name, address, phone, email, reg_no, logo]);
    logAction(req, 'update', 'settings', 1, `Updated company settings (${company_name || 'unnamed'})`);
    res.redirect('/settings?ok=' + encodeURIComponent('Company settings saved'));
  });
});

module.exports = router;
