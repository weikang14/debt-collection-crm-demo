// Sum outstanding amounts into debt-age buckets by days since a case opened:
// 0–30 / 31–60 / 61–90 / 90+. Input rows: { age, amt }. Returns 4 sums in order.
const BUCKET_LABELS = ['0–30', '31–60', '61–90', '90+'];
function bucketAging(rows) {
  const out = [0, 0, 0, 0];
  for (const r of rows) {
    const age = Number(r.age) || 0;
    const i = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3;
    out[i] += Number(r.amt) || 0;
  }
  return out.map(n => Math.round(n * 100) / 100);
}
module.exports = { bucketAging, BUCKET_LABELS };

// ponytail: runnable self-check — `node src/utils/aging.js`
if (require.main === module) {
  const assert = require('node:assert');
  assert.deepStrictEqual(
    bucketAging([{ age: 0, amt: 10 }, { age: 30, amt: 5 }, { age: 31, amt: 7 }, { age: 90, amt: 3 }, { age: 91, amt: 100 }]),
    [15, 7, 3, 100]);
  console.log('aging ok');
}
