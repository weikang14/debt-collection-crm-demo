// Role 2 — "settlement discount" workaround: no waiver function, so a discount can only be
// faked by editing principal. Shows what trail it leaves.  node --no-warnings tests/qa/calc/discount.qa.js
'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Client, parseCase, m1 } = require('./client.qa.js');
const ro = new DatabaseSync(path.join(__dirname, '..', '..', '..', 'data', 'qa', 'business.db'), { readOnly: true });
(async () => {
  const a = await new Client().login('admin', 'admin123');
  const did = ro.prepare("SELECT max(id) id FROM debtors WHERE name='QA 业务计算专用'").get().id;
  const base = { debtor_id: did, agent_id: '', interest_mode: 'fixed', interest_amount: '500', loan_start_date: '', tenure: '', priority: 'medium', remark: 'discount' };
  const cid = Number(m1(/\/cases\/(\d+)/, (await a.post('/cases', { ...base, principal_amount: '5000', status: 'negotiation' })).location));
  await a.post(`/cases/${cid}/payments`, { payment_date: '2026-10-20', amount: '4000', method: 'cash' });
  const before = parseCase((await a.get('/cases/' + cid)).body);
  // negotiated settlement: debtor pays 4,000 in full and final; write off the remaining 1,500 by editing principal
  await a.post(`/cases/${cid}`, { ...base, principal_amount: '3500' });
  const after = parseCase((await a.get('/cases/' + cid)).body);
  const audit = ro.prepare("SELECT action, details FROM audit_logs WHERE entity_type='case' AND entity_id=? ORDER BY id").all(cid);
  const tl = after.timeline.map((t) => `${t.type}: ${t.text}`);
  console.log(JSON.stringify({ cid, before: { principal: before.principal, outstanding: before.outstanding, status: before.status },
    after: { principal: after.principal, outstanding: after.outstanding, status: after.status, recovered: after.recoveredPct }, audit, timeline: tl }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
