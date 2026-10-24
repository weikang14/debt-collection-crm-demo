// Tiny CSV helper. No dependency — quote only when needed, escape quotes.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  // A text cell starting with = + - @ (or tab/CR) runs as a formula in Excel;
  // prefix a quote. Numbers stay numbers, so a negative amount is untouched.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return lines.join('\r\n');
}
// Send as a downloadable file. Prepend a UTF-8 BOM (﻿) so Excel opens
// Chinese / UTF-8 text correctly.
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csv);
}
module.exports = { toCsv, sendCsv };
