// Print a results file: node tests/qa/r2/show.js <name> [filter]
const r = require('./results/' + process.argv[2] + '.json');
for (const x of r) if (!process.argv[3] || new RegExp(process.argv[3]).test(x.id + x.result)) console.log(x.result, x.id, '|', x.actual.slice(0, 260), x.note ? '| note: ' + x.note : '');
