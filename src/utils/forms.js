// Parse an "active" form value. A <select> sends the string "0" or "1"; note
// that "0" is truthy in JS, so a naive `v?1:0` would wrongly mark Inactive as
// active. Only an explicit "0" means inactive; anything else defaults to active.
function parseActive(v) {
  return v === '0' ? 0 : 1;
}
module.exports = { parseActive };
