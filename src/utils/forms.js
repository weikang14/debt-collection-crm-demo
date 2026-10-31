const dayjs = require('dayjs');

// Parse an "active" form value. A <select> sends the string "0" or "1"; note
// that "0" is truthy in JS, so a naive `v?1:0` would wrongly mark Inactive as
// active. Only an explicit "0" means inactive; anything else defaults to active.
function parseActive(v) {
  return v === '0' ? 0 : 1;
}

// A real calendar date written as YYYY-MM-DD — the only shape that compares
// correctly as a string (payment, due and effective dates).
const isISODate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && dayjs(s).format('YYYY-MM-DD') === s;

// A money amount as typed: plain digits with at most 2 decimals (sen). Number()
// alone would accept '0x10', '1e2' and sub-sen '0.001'. NaN when malformed.
function parseMoney(raw) {
  const s = String(raw ?? '').trim();
  return /^(\d+(\.\d{1,2})?|\.\d{1,2})$/.test(s) ? Number(s) : NaN;
}

// Validate a payment amount against the case's current outstanding balance.
// Returns { amount } (exact, never rounded — this is a collection system) or
// { error }. Overpayment is blocked; a sub-cent tolerance absorbs float noise.
function validatePayment(rawAmount, outstanding) {
  const n = parseMoney(rawAmount);
  if (!(n > 0)) return { error: 'Invalid amount' };
  if (n > Number(outstanding) + 0.005) return { error: 'Amount exceeds outstanding' };
  return { amount: n };
}

// K-11: what the user typed into a refused form, over the record it edits;
// *_id fields back to numbers so the form's selects match them.
function refill(res, record) {
  const f = res.locals && res.locals.flash && res.locals.flash.form;
  if (!f) return record;
  const typed = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, /_id$/.test(k) && /^\d+$/.test(v) ? Number(v) : v]));
  return { ...record, ...typed };
}

const PAYMENT_METHODS = ['bank_transfer', 'cash', 'cheque', 'online'];
// Blank means the default method; anything else must be one of the form's options.
const methodError = m => (m && !PAYMENT_METHODS.includes(m) ? 'Invalid payment method' : null);

const MAX_NAME = 200;
// Password policy, shared by new users, password resets, the seed and login.
const MIN_PASSWORD = 8;
const HASH_COST = 10;

module.exports = { parseActive, isISODate, parseMoney, validatePayment, refill, PAYMENT_METHODS, methodError, MAX_NAME, MIN_PASSWORD, HASH_COST };
