// Parse an "active" form value. A <select> sends the string "0" or "1"; note
// that "0" is truthy in JS, so a naive `v?1:0` would wrongly mark Inactive as
// active. Only an explicit "0" means inactive; anything else defaults to active.
function parseActive(v) {
  return v === '0' ? 0 : 1;
}

// Validate a payment amount against the case's current outstanding balance.
// Returns { amount } (exact, never rounded — this is a collection system) or
// { error }. Overpayment is blocked; a sub-cent tolerance absorbs float noise.
function validatePayment(rawAmount, outstanding) {
  const n = Number(rawAmount);
  if (!Number.isFinite(n) || n <= 0) return { error: 'Invalid amount' };
  if (n > Number(outstanding) + 0.005) return { error: 'Amount exceeds outstanding' };
  return { amount: n };
}
module.exports = { parseActive, validatePayment };
