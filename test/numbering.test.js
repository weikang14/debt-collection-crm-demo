process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-numbering-' + process.pid + '.db'); // never the real data/crm.db
const { test } = require('node:test');
const assert = require('node:assert');
const { init, run, exec } = require('../src/db');
init();
const numbering = require('../src/utils/numbering');

test('nextCaseNo format and increment', () => {
  const year = new Date().getFullYear();
  const first = numbering.nextCaseNo();
  assert.match(first, new RegExp(`^CASE-${year}-\\d{4}$`));
});
test('nextReceiptNo format', () => {
  const year = new Date().getFullYear();
  assert.match(numbering.nextReceiptNo(), new RegExp(`^RCPT-${year}-\\d{4}$`));
});
