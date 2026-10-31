const express = require('express');
const { all } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { caseWhere } = require('../utils/scope');
const { logAccess } = require('../utils/audit');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const q = (req.query.q || '').trim();
  let results = [];
  if (q) {
    const w = caseWhere(req.session.user);
    const like = '%' + q + '%';
    results = all(`SELECT cases.*, clients.company_name AS client_name, debtors.name AS debtor_name, debtors.ic_passport, debtors.phone AS debtor_phone
      FROM cases JOIN clients ON clients.id=cases.client_id JOIN debtors ON debtors.id=cases.debtor_id
      WHERE ${w.clause} AND (cases.case_no LIKE ? OR debtors.name LIKE ? OR debtors.ic_passport LIKE ? OR debtors.phone LIKE ?)
      ORDER BY cases.opened_at DESC LIMIT 50`, [...w.params, like, like, like, like]);
    logAccess(req, 'search', 'case', null, `q=${q} (${results.length} found)`);
  }
  res.render('search/index', { title: 'Search', q, results });
});
module.exports = router;
