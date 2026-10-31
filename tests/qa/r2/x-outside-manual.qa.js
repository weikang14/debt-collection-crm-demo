// 手册外 (outside the manual): RBAC matrix on every write route, input validation,
// boundaries, duplicate / concurrent submits, error handling, and the edges of
// v1.10.0's new rules (rate cap 18.00/18.01, 0.005 settlement edge, same-day
// restructure, reassignment, bankrupt/deceased, partially_kept).
const { test } = require('node:test');
const c = require('./_client');
const { reseed, step, finish, assert } = require('./_run');
const { check, rec, has, strip, today, addDays, q1, qa, ledgerAmt, ledgerVal, num, scheduleRows } = c;

const show = async (s, id) => (await s.get(`/cases/${id}`)).text;
const M = (extra = {}) => ({ principal_amount: '10000', interest_mode: 'monthly', interest_rate: '1.5', loan_start_date: '2026-01-01', tenure: '12', ...extra });
// Same day n months on, clamped to month end (31 Oct → 30 Nov), as the app's due dates are.
const addMonths = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const last = new Date(Date.UTC(y, m + n - 1 + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10); };

test('r2 X: outside the manual', { timeout: 400000 }, async () => {
  reseed();
  const S = { admin: await c.as('admin'), manager: await c.as('manager'), agent1: await c.as('agent1'), finance: await c.as('finance'), auditor: await c.as('auditor'), anon: new c.Session() };
  const { admin, manager: man, agent1: a1, finance: fin } = S;

  // ---------------- X-RBAC: every role × every write route ----------------
  await step('X-RBAC', 'role matrix on all POST routes', async () => {
    const fulfilledPtp = q1("SELECT id FROM ptps WHERE status='fulfilled' AND case_id=5").id; // agent1's case
    const foreignPtp = q1("SELECT id FROM ptps WHERE status='pending' AND case_id=14").id;      // agent2's case
    const ownPay = q1('SELECT id FROM payments WHERE case_id=5').id;
    // [route, body, allowed roles]; bodies are deliberately invalid so an allowed
    // request ends in a validation error instead of changing data.
    const own = [
      ['/debtors', { name: '' }, ['admin', 'manager']],
      ['/debtors/5', { name: '' }, ['admin', 'manager', 'agent1']],
      ['/debtors/2', { name: '' }, ['admin', 'manager']],
      ['/cases', { principal_amount: '' }, ['admin', 'manager']],
      ['/cases/5', { principal_amount: '' }, ['admin', 'manager']],
      ['/cases/5/payments', { amount: '0' }, ['admin', 'manager', 'finance', 'agent1']],
      ['/cases/2/payments', { amount: '0' }, ['admin', 'manager', 'finance']],
      [`/cases/5/payments/${ownPay}`, { amount: '1', method: 'bogus', payment_date: today() }, ['admin', 'manager', 'finance']],
      ['/cases/5/payments/999999/void', {}, ['admin', 'manager', 'finance']],
      ['/cases/5/ptps', { amount: '0' }, ['admin', 'manager', 'agent1']],
      ['/cases/2/ptps', { amount: '0' }, ['admin', 'manager']],
      ['/cases/5/ptp-plans', { total_amount: '0' }, ['admin', 'manager', 'agent1']],
      ['/cases/5/ptp-plans/nope/cancel', {}, ['admin', 'manager', 'agent1']],
      ['/cases/2/ptp-plans/nope/cancel', {}, ['admin', 'manager']],
      ['/cases/5/calls', { duration_seconds: '-1' }, ['admin', 'manager', 'agent1']],
      ['/cases/2/calls', { duration_seconds: '-1' }, ['admin', 'manager']],
      ['/cases/5/notes', { content: '' }, ['admin', 'manager', 'agent1']],
      ['/cases/5/notes/999999', { content: 'x' }, ['admin', 'manager', 'agent1']],
      ['/cases/5/notes/999999/delete', {}, ['admin', 'manager', 'agent1']],
      ['/cases/5/status', { status: 'bogus' }, ['admin', 'manager', 'agent1']],
      ['/cases/2/status', { status: 'bogus' }, ['admin', 'manager']],
      ['/cases/5/restructures', { effective_date: 'bad' }, ['admin', 'manager']],
      ['/cases/14/restructures/999999/undo', {}, ['admin', 'manager']],
      [`/ptps/${fulfilledPtp}/fulfill`, {}, ['admin', 'manager', 'agent1']],
      [`/ptps/${fulfilledPtp}/break`, {}, ['admin', 'manager', 'agent1']],
      [`/ptps/${foreignPtp}/fulfill`, { amount: '0' }, ['admin', 'manager']],
      ['/agents', { name: '' }, ['admin', 'manager']],
      ['/agents/1', { name: '' }, ['admin', 'manager']],
      ['/users', { username: '' }, ['admin']],
      ['/users/999999', {}, ['admin']],
      ['/users/999999/password', {}, ['admin']],
      ['/users/999999/toggle', {}, ['admin']],
      ['/tasks/new', { title: '' }, ['admin', 'manager', 'agent1']],
      ['/tasks/999999', { title: 'x' }, ['admin', 'manager', 'agent1']],
      ['/tasks/999999/complete', {}, ['admin', 'manager', 'agent1']],
      ['/commissions/settle', { amount: '0' }, ['admin', 'manager', 'finance']],
      ['/commissions/999999/void', {}, ['admin', 'manager', 'finance']],
      ['/settings', { max_annual_rate: '0' }, ['admin']],
      ['/demo-tools/delete-demo', {}, ['admin']],
      ['/demo-tools/reload-demo', {}, ['admin']],
    ];
    const noTs = rows => rows.map(({ updated_at, ...r }) => r); // loadCase() touches cases.updated_at on every read
    const snap = () => JSON.stringify([noTs(qa('SELECT * FROM cases ORDER BY id')), qa('SELECT * FROM payments ORDER BY id'), qa('SELECT id,status FROM ptps ORDER BY id'), qa('SELECT * FROM debtors ORDER BY id'), qa('SELECT * FROM agents ORDER BY id'), qa('SELECT id,role,active FROM users ORDER BY id'), qa('SELECT * FROM tasks ORDER BY id'), qa('SELECT * FROM settings')]);
    const before = snap();
    const bad = []; let n = 0;
    for (const [route, body, allowed] of own) {
      for (const role of Object.keys(S)) {
        if (role === 'admin' && route.startsWith('/demo-tools')) continue; // allowed + destructive; covered by DEMO-01/02
        const r = await S[role].post(route, body);
        n++;
        const denied = role === 'anon' ? (r.status === 302 && r.location === '/login') : (r.status === 403 || r.status === 404);
        const should = role === 'anon' ? true : !allowed.includes(role);
        if (should !== denied) bad.push(`${role} ${route} → ${r.status} ${r.location}`);
      }
    }
    const after = snap();
    check('X-RBAC', `${own.length} routes × 6 roles: denied ⇔ not allowed; no data changed`, bad.length === 0 && before === after, `${n} requests; mismatches=${bad.length ? bad.join(' | ') : 'none'}; data unchanged=${before === after}`);
  });

  // ---------------- X-STATUS: agent can lift a terminal / frozen status ----------------
  await step('X-STATUS', 'agent un-terminals a case (Legal/Cancelled/Bankruptcy → Negotiation)', async () => {
    const a2 = await c.as('agent2');
    const r1 = await a1.act('/cases/17/status', { status: 'negotiation' }); // Legal → negotiation
    const r2 = await a1.act('/cases/9/status', { status: 'new' });         // Cancelled → new
    const r3 = await a2.act('/cases/10/status', { status: 'negotiation' }); // Bankruptcy → negotiation
    const p = await a2.act('/cases/10/ptps', { amount: '50', due_date: today() });
    const call = await a2.act('/cases/10/calls', { result: 'answered', duration_seconds: '30' });
    const st = qa('SELECT id, status FROM cases WHERE id IN (9,10,17) ORDER BY id').map(x => `${x.id}:${x.status}`).join(' ');
    // Expected per D-12/D-13: an agent should not be able to take a case out of a terminal status set by a manager.
    check('X-STATUS', 'agent cannot leave Legal/Cancelled/Bankruptcy (D-12/D-13 intent)', !r1.ok && !r2.ok && !r3.ok, `${r1.ok || r1.err} / ${r2.ok || r2.err} / ${r3.ok || r3.err}; then PTP=${p.ok || p.err}, call=${call.ok || call.err}; now ${st}`);
  });

  // ---------------- X-CAP: rate cap 18.00 / 18.01 boundaries ----------------
  await step('X-CAP', 'cap edges', async () => {
    const deb = await c.newDebtor(admin, 'QA Cap');
    const t = async (f) => { const r = await admin.post('/cases', { debtor_id: String(deb), priority: 'medium', status: 'new', ...f }); if (/^\/cases\/\d+$/.test(r.location)) return 'OK'; return c.alertOf((await admin.get(r.location)).text)?.text; };
    const out = {
      'monthly 1.5 (18.00)': await t(M()), 'annual 18.00': await t(M({ interest_mode: 'daily', interest_rate: '18' })),
      'annual 18.01': await t(M({ interest_mode: 'daily', interest_rate: '18.01' })), 'monthly 1.501 (18.012)': await t(M({ interest_rate: '1.501' })),
      'monthly 1.5004 (18.0048)': await t(M({ interest_rate: '1.5004' })), 'annual 18.004': await t(M({ interest_mode: 'daily', interest_rate: '18.004' })),
      'fixed 1800/10000/12m (18.00)': await t({ principal_amount: '10000', interest_mode: 'fixed', interest_amount: '1800', tenure: '12', loan_start_date: '2026-01-01' }),
      'fixed 1801/10000/12m (18.01)': await t({ principal_amount: '10000', interest_mode: 'fixed', interest_amount: '1801', tenure: '12', loan_start_date: '2026-01-01' }),
      'fixed 5000/10000 no tenure (≈?)': await t({ principal_amount: '10000', interest_mode: 'fixed', interest_amount: '5000' }),
      'fixed 9000/10000 tenure 1m (1080%)': await t({ principal_amount: '10000', interest_mode: 'fixed', interest_amount: '9000', tenure: '1', loan_start_date: '2026-01-01' }),
      'monthly 1.25 × 80m (=100%)': await t(M({ interest_rate: '1.25', tenure: '80' })), 'monthly 1.5 × 67m (100.5%)': await t(M({ tenure: '67' })),
    };
    rec('X-CAP-1', '18.00 allowed; 18.01 refused (monthly, annual, fixed)', JSON.stringify(out),
      out['monthly 1.5 (18.00)'] === 'OK' && out['annual 18.00'] === 'OK' && out['fixed 1800/10000/12m (18.00)'] === 'OK' && /18\.01% p\.a\./.test(out['annual 18.01']) && /18\.01% p\.a\./.test(out['monthly 1.501 (18.012)']) && /18\.01% p\.a\./.test(out['fixed 1801/10000/12m (18.01)']) ? 'PASS' : 'FAIL');
    rec('X-CAP-2', 'rates above 18% but < 18.005% should be refused', `monthly 1.5004 → ${out['monthly 1.5004 (18.0048)']}; annual 18.004 → ${out['annual 18.004']}`,
      out['monthly 1.5004 (18.0048)'] !== 'OK' && out['annual 18.004'] !== 'OK' ? 'PASS' : 'FAIL', 'nominalAnnualRate() rounds to 2 dp before the compare (payments.js:157-166)');
    rec('X-CAP-3', 'Fixed loan without tenure must still be capped', `fixed 5000 no tenure → ${out['fixed 5000/10000 no tenure (≈?)']}`, out['fixed 5000/10000 no tenure (≈?)'] !== 'OK' ? 'PASS' : 'FAIL', 'nominalAnnualRate returns null without tenure → rateCapError skips (payments.js:159)');
    rec('X-CAP-4', 'fixed short tenure annualised (1080% p.a.) refused', out['fixed 9000/10000 tenure 1m (1080%)'], /exceeds the 18% p\.a\. limit/.test(out['fixed 9000/10000 tenure 1m (1080%)'] || '') ? 'PASS' : 'FAIL');
    rec('X-CAP-5', 'interest = principal allowed, > principal refused', `${out['monthly 1.25 × 80m (=100%)']} / ${out['monthly 1.5 × 67m (100.5%)']}`, out['monthly 1.25 × 80m (=100%)'] === 'OK' && out['monthly 1.5 × 67m (100.5%)'] === 'Total interest cannot exceed the principal' ? 'PASS' : 'FAIL');
    // open-ended accrual loan: the interest ≤ principal check only looks up to today
    const r0 = await t(M({ loan_start_date: '2021-01-01', tenure: '' }));
    const r = await t(M({ loan_start_date: '2021-06-01', tenure: '' }));
    const id = q1("SELECT MAX(id) m FROM cases").m;
    const intNow = num(ledgerVal(await show(admin, id), 'Interest'));
    rec('X-CAP-6', '(design) no-tenure accrual loan: total interest bounded by principal over its life', `start 2021-01-01 → ${r0}; start 2021-06-01 → created=${r}; interest today=${intNow} on 10,000 (start 2021-06-01, no maturity) — keeps accruing 150/month with no stop`, 'FAIL', 'loanLimitError checks interest only up to "now" when there is no maturity (cases.js:32-37); nothing stops it passing the principal later');
    // settings 18.01 accepted as cap
    const s = await admin.act('/settings', { company_name: '', max_annual_rate: '18.5' });
    const cap = await t(M({ interest_mode: 'daily', interest_rate: '18.5' }));
    await admin.act('/settings', { company_name: '', max_annual_rate: '18' });
    rec('X-CAP-7', 'decimal cap 18.5 honoured', `${s.ok}; annual 18.5 → ${cap}`, s.ok === 'Company settings saved' && cap === 'OK' ? 'PASS' : 'FAIL');
  });

  // ---------------- X-HALF: settlement 0.005 edge ----------------
  await step('X-HALF', 'settlement with a half-cent', async () => {
    const deb = await c.newDebtor(admin, 'QA Half');
    const out = [];
    for (const [label, f] of [
      ['monthly 1001 × 0.5% × 1 month = 5.005', { principal_amount: '1001', interest_mode: 'monthly', interest_rate: '0.5', loan_start_date: addMonths(today(), -1), tenure: '12' }],
      ['annual 365 × 0.5% / 365 × 1 day = 0.005', { principal_amount: '365', interest_mode: 'daily', interest_rate: '0.5', loan_start_date: addDays(today(), -1), tenure: '12' }],
      ['annual 1000.50 × 18% × 1 day = 0.49340', { principal_amount: '1000.5', interest_mode: 'daily', interest_rate: '18', loan_start_date: addDays(today(), -1), tenure: '12' }],
    ]) {
      const id = await c.newCase(admin, { debtor_id: String(deb), ...f });
      const h = await show(admin, id);
      const shown = ledgerVal(h, 'Settlement Today'); const maxAttr = (h.match(/max="([\d.]+)" name="amount" id="pay-amount"/) || [])[1];
      const over = await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: (Number(maxAttr) + 0.01).toFixed(2), method: 'cash' });
      const pay = await admin.act(`/cases/${id}/payments`, { payment_date: today(), amount: Number(maxAttr).toFixed(2), method: 'cash' });
      const row = q1('SELECT status, outstanding_amount o FROM cases WHERE id=?', id);
      out.push({ label, shown, maxAttr, over: over.err, pay: pay.ok || pay.err, status: row.status, left: row.o, ok: !!over.err && /recorded/.test(pay.ok || '') && row.status === 'fully_paid' && row.o === 0 });
    }
    for (const o of out) rec('X-HALF', `pay the displayed max (${o.label}) → Fully Paid; max+0.01 refused`, JSON.stringify(o), o.ok ? 'PASS' : 'FAIL', o.ok ? '' : 'K-01 整数分金额迁移（已知延后）的表现');
  });

  // ---------------- X-DUP: duplicate / concurrent submits ----------------
  await step('X-DUP', 'double / concurrent PTP, plan, fulfil, payments', async () => {
    const deb = await c.newDebtor(admin, 'QA Dup');
    const id = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M({ principal_amount: '2000' }) });
    // same PTP twice in a row (resubmit)
    await a1.post(`/cases/${id}/ptps`, { amount: '100', due_date: addDays(today(), 3) });
    const second = await a1.act(`/cases/${id}/ptps`, { amount: '100', due_date: addDays(today(), 3) });
    const n1 = q1("SELECT COUNT(*) n FROM ptps WHERE case_id=? AND status='pending'", id).n;
    rec('X-DUP-1', 'resubmitted identical PTP → one row (banner still "PTP created")', `rows=${n1}; second banner=${second.ok}`, n1 === 1 ? 'PASS' : 'FAIL');
    // five concurrent identical PTPs from five sessions
    const ss = await Promise.all([1, 2, 3, 4, 5].map(() => c.as('agent1')));
    await Promise.all(ss.map(s => s.post(`/cases/${id}/ptps`, { amount: '77', due_date: addDays(today(), 4) })));
    const n2 = q1("SELECT COUNT(*) n FROM ptps WHERE case_id=? AND amount=77", id).n;
    rec('X-DUP-2', '5 concurrent identical PTPs → 1 row', `rows=${n2}`, n2 === 1 ? 'PASS' : 'FAIL');
    // concurrent PTPs that together exceed the settlement cap
    const settle = num(ledgerVal(await show(admin, id), 'Settlement Today'));
    const half = (Math.floor(settle * 0.6 * 100) / 100).toFixed(2);
    const rs = await Promise.all(ss.slice(0, 2).map((s, k) => s.post(`/cases/${id}/ptps`, { amount: half, due_date: addDays(today(), 5 + k) })));
    const n3 = q1('SELECT COUNT(*) n FROM ptps WHERE case_id=? AND amount=?', id, Number(half)).n;
    rec('X-DUP-3', 'two concurrent 60% PTPs → only one accepted (cap)', `rows=${n3}; statuses=${rs.map(r => r.status)}`, n3 === 1 ? 'PASS' : 'FAIL');
    // double plan
    const id2 = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M({ principal_amount: '2000' }) });
    await Promise.all(ss.slice(0, 3).map(s => s.post(`/cases/${id2}/ptp-plans`, { total_amount: '300', num_installments: '3', first_due_date: today() })));
    const plans = q1('SELECT COUNT(DISTINCT plan_id) n FROM ptps WHERE case_id=? AND plan_id IS NOT NULL', id2).n;
    rec('X-DUP-4', '3 concurrent identical plans → 1 plan', `plans=${plans}`, plans === 1 ? 'PASS' : 'FAIL');
    // concurrent fulfil of one PTP
    const p = q1("SELECT id, amount FROM ptps WHERE case_id=? AND installment_no=1", id2);
    await Promise.all(ss.slice(0, 4).map(s => s.post(`/ptps/${p.id}/fulfill`, { amount: String(p.amount), payment_date: today(), method: 'cash' })));
    const pays = q1('SELECT COUNT(*) n FROM payments WHERE case_id=?', id2).n;
    rec('X-DUP-5', '4 concurrent fulfils → 1 payment', `payments=${pays}`, pays === 1 ? 'PASS' : 'FAIL');
    // concurrent payments over the settlement
    const id3 = await c.newCase(admin, { debtor_id: String(deb), principal_amount: '1000', interest_mode: 'fixed', interest_amount: '0' });
    const fs = await Promise.all([1, 2].map(() => c.as('finance')));
    await Promise.all(fs.map(s => s.post(`/cases/${id3}/payments`, { payment_date: today(), amount: '600', method: 'cash' })));
    const sum = q1('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE case_id=?', id3).s;
    rec('X-DUP-6', 'two concurrent 600 payments on a 1,000 balance → one refused', `paid=${sum}`, sum === 600 ? 'PASS' : 'FAIL');
    // double payment (same amount/date twice) — no idempotency
    await fin.post(`/cases/${id3}/payments`, { payment_date: today(), amount: '10', method: 'cash', reference: 'DUP' });
    await fin.post(`/cases/${id3}/payments`, { payment_date: today(), amount: '10', method: 'cash', reference: 'DUP' });
    const dup = q1("SELECT COUNT(*) n FROM payments WHERE case_id=? AND reference='DUP'", id3).n;
    rec('X-DUP-7', '(info) resubmitted payment form → recorded twice (no idempotency key)', `rows=${dup}`, dup === 1 ? 'PASS' : 'FAIL', '浏览器后退重提或双击“Add Payment”会记两笔；PTP 有 10 秒去重，还款没有');
  });

  // ---------------- X-VAL: input validation ----------------
  await step('X-VAL', 'server-side validation', async () => {
    const deb = await c.newDebtor(admin, 'QA Val');
    const id = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M({ principal_amount: '5000' }) });
    const caseErr = async (f) => (await admin.act('/cases', { debtor_id: String(deb), priority: 'medium', status: 'new', ...M(), ...f })).err;
    const v = {};
    for (const [k, f] of Object.entries({ 'principal abc': { principal_amount: 'abc' }, 'principal -1': { principal_amount: '-1' }, 'principal 1e309': { principal_amount: '1e309' }, 'principal 0x10': { principal_amount: '0x10' }, 'principal 1.234': { principal_amount: '1.234' },
      'rate -1': { interest_rate: '-1' }, 'rate abc': { interest_rate: 'abc' }, 'rate 1e1': { interest_rate: '1e1' }, 'tenure 0': { tenure: '0' }, 'tenure 121': { tenure: '121' }, 'tenure 1.5': { tenure: '1.5' }, 'start 2026-02-30': { loan_start_date: '2026-02-30' },
      'priority bogus': { priority: 'bogus' }, 'status bogus': { status: 'bogus' }, 'agent 999': { agent_id: '999' }, 'debtor 999': { debtor_id: '999' }, 'fixed interest -5': { interest_mode: 'fixed', interest_amount: '-5' } })) v[k] = await caseErr(f);
    rec('X-VAL-CASE', 'case form rejects malformed terms', JSON.stringify(v), Object.values(v).every(Boolean) ? 'PASS' : 'FAIL');
    const pay = {};
    for (const [k, f] of Object.entries({ 'amount 1.005': { amount: '1.005' }, 'amount 0x10': { amount: '0x10' }, 'amount 1e2': { amount: '1e2' }, 'amount 0.001': { amount: '0.001' }, 'method bitcoin': { amount: '1', method: 'bitcoin' }, 'date 2026/10/01': { amount: '1', payment_date: '2026/10/01' }, 'date missing': { amount: '1', payment_date: '' } }))
      pay[k] = (await fin.act(`/cases/${id}/payments`, { payment_date: today(), method: 'cash', ...f })).err;
    rec('X-VAL-PAY', 'payment rejects malformed input', JSON.stringify(pay), Object.values(pay).every(Boolean) ? 'PASS' : 'FAIL');
    const misc = {
      'ptp due abc': (await a1.act(`/cases/${id}/ptps`, { amount: '1', due_date: 'abc' })).err, 'ptp due missing': (await a1.act(`/cases/${id}/ptps`, { amount: '1' })).err,
      'ptp amount 1e2': (await a1.act(`/cases/${id}/ptps`, { amount: '1e2', due_date: today() })).err,
      'plan first 2026-11-31': (await a1.act(`/cases/${id}/ptp-plans`, { total_amount: '30', num_installments: '3', first_due_date: '2026-11-31' })).err,
      'call -1': (await a1.act(`/cases/${id}/calls`, { duration_seconds: '-1' })).err, 'call 1.5': (await a1.act(`/cases/${id}/calls`, { duration_seconds: '1.5' })).err, 'call result bogus': (await a1.act(`/cases/${id}/calls`, { result: 'bogus' })).err,
      'note 5001': (await a1.act(`/cases/${id}/notes`, { content: 'x'.repeat(5001) })).err, 'task title 201': (await a1.act('/tasks/new', { title: 'x'.repeat(201) })).err,
      'task due abc': (await a1.act('/tasks/new', { title: 'x', due_date: 'abc' })).err, 'task type visit': (await a1.act('/tasks/new', { title: 'x', type: 'visit' })).err,
      'debtor name 201': (await admin.act('/debtors', { name: 'x'.repeat(201) })).err, 'debtor salary -1': (await admin.act('/debtors', { name: 'x', salary: '-1' })).err, 'debtor risk bogus': (await admin.act('/debtors', { name: 'x', risk_level: 'bogus' })).err,
      'agent rate 101': (await admin.act('/agents', { name: 'x', commission_rate: '101' })).err, 'agent rate -1': (await admin.act('/agents', { name: 'x', commission_rate: '-1' })).err, 'agent target -1': (await admin.act('/agents', { name: 'x', target_amount: '-1' })).err,
      'settle 1e10': (await fin.act('/commissions/settle', { agent_id: '1', amount: '1e10' })).err, 'settle period bogus': (await fin.act('/commissions/settle', { agent_id: '1', amount: '1', period: 'bogus' })).err, 'settle agent 999': (await fin.act('/commissions/settle', { agent_id: '999', amount: '1' })).err,
      'user full_name 201': (await admin.act('/users', { username: 'u201', full_name: 'x'.repeat(201), password: 'Passw0rd!', role: 'finance' })).err,
      'settings rate abc': (await admin.act('/settings', { max_annual_rate: 'abc' })).err,
      'restructure rate -1': (await admin.act(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '-1', tenure: '6', reason: 'x' })).err,
    };
    rec('X-VAL-MISC', 'other forms reject malformed input', JSON.stringify(misc), Object.values(misc).every(Boolean) ? 'PASS' : 'FAIL');
    const loose = {
      'agent rate 0 kept as 0': (await admin.act('/agents', { name: 'QA zero rate', commission_rate: '0' })).ok && q1("SELECT commission_rate r FROM agents WHERE name='QA zero rate'").r,
      'settle amount 0x10': (await fin.act('/commissions/settle', { agent_id: '2', amount: '0x10', note: 'hex' })).ok && q1("SELECT amount a FROM commission_settlements WHERE note='hex'")?.a,
      'restructure rate "1e0"': (await admin.act(`/cases/${id}/restructures`, { effective_date: today(), interest_mode: 'monthly', interest_rate: '1e0', tenure: '6', reason: 'sci' })).ok,
    };
    rec('X-VAL-LOOSE', '(info) loose numeric parsing outside payments', JSON.stringify(loose), loose['agent rate 0 kept as 0'] === 0 && !loose['settle amount 0x10'] && !loose['restructure rate "1e0"'] ? 'PASS' : 'FAIL', 'commissions.js:139 Number(); restructure.js:63-64 Number() — accept 0x10 / 1e0, unlike parseMoney');
  });

  // ---------------- X-ERR: error handling ----------------
  await step('X-ERR', 'friendly errors, no stack', async () => {
    const r = {
      unknown: await admin.get('/no-such-page'), caseAbc: await admin.get('/cases/abc'), case999: await admin.get('/cases/999999'), debAbc: await admin.get('/debtors/abc'), agentAbc: await admin.get('/agents/abc'),
      ptp999: await admin.post('/ptps/999999/fulfill', {}), payNaN: await admin.act('/cases/2/payments/abc', { amount: '1', payment_date: today() }),
      big: await admin.post('/cases/1/notes', { content: 'x'.repeat(200 * 1024) }), badEnc: await admin.req('POST', '/cases/1/notes', null, { 'content-type': 'application/x-www-form-urlencoded' }),
    };
    const raw = await fetch(c.BASE + '/cases/1/notes', { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'content=%E0%A4%A' });
    const rawText = await raw.text();
    const stack = Object.values(r).some(x => /at .*\.js:\d+|node_modules|C:\\\\|\/src\//.test(x.text || x.html || '')) || /at .*\.js:\d+/.test(rawText);
    const encNote = q1("SELECT content FROM timeline_events WHERE instr(content, '%E0') > 0 ORDER BY id DESC");
    const out = `unknown=${r.unknown.status} caseAbc=${r.caseAbc.status} case999=${r.case999.status} debAbc=${r.debAbc.status} agentAbc=${r.agentAbc.status} ptp999=${r.ptp999.status} payNaN=${r.payNaN.err} big=${r.big.status} badEnc=${raw.status} (malformed %-encoding kept as text: note=${JSON.stringify(encNote && encNote.content)}) stack=${stack}`;
    rec('X-ERR', '404/400/413 friendly pages, no stack traces', out, r.unknown.status === 404 && r.case999.status === 404 && r.ptp999.status === 404 && r.payNaN.err === 'Payment not found' && r.big.status === 413 && raw.status < 500 && !stack ? 'PASS' : 'FAIL');
    const sec = await admin.get('/');
    rec('X-HDR', 'security headers, no X-Powered-By', ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'x-powered-by'].map(h => `${h}=${sec.headers.get(h)}`).join(' '),
      sec.headers.get('x-content-type-options') === 'nosniff' && sec.headers.get('x-frame-options') === 'DENY' && !sec.headers.get('x-powered-by') ? 'PASS' : 'FAIL');
    const sc = (await new c.Session().req('POST', '/login', { username: 'admin', password: 'admin123' })).headers.getSetCookie().join(';');
    rec('X-COOKIE', '(info) session cookie flags', sc.replace(/connect\.sid=[^;]+/, 'connect.sid=…'), /HttpOnly/i.test(sc) ? 'PASS' : 'FAIL', 'Secure/SameSite 未设置属 K-06（已知延后）');
  });

  // ---------------- X-REASSIGN edges ----------------
  await step('X-REASSIGN', 'unassign / reassign with tasks, PTPs, commission', async () => {
    await man.act('/tasks/new', { case_id: '13', type: 'follow_up', title: 'XR open', due_date: addDays(today(), 3) });
    const cs = q1('SELECT * FROM cases WHERE id=13');
    const r = await man.act('/cases/13', { debtor_id: String(cs.debtor_id), agent_id: '', principal_amount: String(cs.principal_amount), interest_mode: cs.interest_mode, interest_amount: String(cs.interest_amount), priority: cs.priority });
    const t = q1("SELECT agent_id FROM tasks WHERE title='XR open'");
    const a1Tasks = has((await a1.get('/tasks')).text, 'XR open');
    rec('X-REASSIGN-1', '(info) unassigning a case orphans its open tasks (agent_id NULL)', `${r.ok}; task agent=${t.agent_id}; still on agent1 list=${a1Tasks}`, r.ok === 'Saved' ? 'PASS' : 'FAIL', '任务归属变为空，管理员列表 Agent 显示“—”；是否应保留原催收员待业务确认');
  });

  // ---------------- X-FROZEN: bankrupt / deceased edges ----------------
  await step('X-FROZEN', 'pending PTP left on a bankrupt case', async () => {
    const deb = await c.newDebtor(admin, 'QA Frozen');
    const id = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M({ principal_amount: '3000' }) });
    await admin.act(`/cases/${id}/ptps`, { amount: '100', due_date: today() });
    const d0 = strip((await admin.get('/')).text).match(/PTP (\d+) due/)[1];
    await admin.act(`/cases/${id}/status`, { status: 'deceased' });
    const d1 = strip((await admin.get('/')).text).match(/PTP (\d+) due/)[1];
    const h = await show(admin, id);
    rec('X-FROZEN-1', '(info) pending PTP on a deceased case keeps counting as "due" and shows Fulfill (server refuses)', `dash due ${d0}→${d1}; Fulfill button=${has(h, 'onclick="openFulfill(')}; PTP status=${q1('SELECT status FROM ptps WHERE case_id=?', id).status}`,
      d1 === d0 && !has(h, 'onclick="openFulfill(') ? 'PASS' : 'FAIL', '改为破产/已故时未处理在途 PTP');
    const task = await admin.act('/tasks/new', { case_id: String(id), type: 'follow_up', title: 'call the estate', due_date: today() });
    rec('X-FROZEN-2', '(info) follow_up task can still be created on a deceased case', task.ok || task.err, 'PASS', 'D-13 只禁通话/PTP/重组；任务未限制，仅记录');
  });

  // ---------------- X-PARTIAL: partially_kept and indicators ----------------
  await step('X-PARTIAL', 'partially_kept in plan header and dashboard', async () => {
    const deb = await c.newDebtor(admin, 'QA Partial');
    const id = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M({ principal_amount: '3000' }) });
    await a1.act(`/cases/${id}/ptp-plans`, { total_amount: '300', num_installments: '3', first_due_date: today() });
    const p = q1('SELECT id FROM ptps WHERE case_id=? AND installment_no=1', id).id;
    const d0 = strip((await admin.get('/')).text);
    const r = await a1.act(`/ptps/${p}/fulfill`, { amount: '1.00', payment_date: today(), method: 'cash' });
    const head = strip(r.html).match(/Installment Plan · RM [\d,.]+ · (\d+\/\d+) kept/);
    const d1 = strip((await admin.get('/')).text);
    const g = (t, re) => (t.match(re) || [])[1];
    rec('X-PARTIAL-1', 'plan header should not count a RM 1 of RM 100 partial as "kept"', `header=${head && head[1]}; ptp=${q1('SELECT status FROM ptps WHERE id=?', p).status}`, head && head[1] === '0/3' ? 'PASS' : 'FAIL', 'show.ejs:179 counts partially_kept as kept');
    rec('X-PARTIAL-2', '(info) dashboard PTP card after a partial: due −1, broken unchanged, no "partial" metric', `due ${g(d0, /PTP (\d+) due/)}→${g(d1, /PTP (\d+) due/)}; broken ${g(d0, /(\d+) broken/)}→${g(d1, /(\d+) broken/)}`, 'PASS', '部分履行在仪表盘上没有单独指标，只体现为 due 减少');
    // PTP dialog max vs settlement cap
    const h = await show(a1, id);
    const dlgMax = (h.match(/New PTP<\/h3>\s*<label>Amount \(RM\) <small[^>]*>· max ([\d,.]+)/) || [])[1];
    const tryMax = await a1.act(`/cases/${id}/ptps`, { amount: String(num(dlgMax)), due_date: addDays(today(), 1) });
    rec('X-PTPMAX', 'New PTP dialog "max" should be accepted', `dialog max=${dlgMax}; submit → ${tryMax.ok || tryMax.err}`, tryMax.ok ? 'PASS' : 'FAIL', 'show.ejs:265 shows contract outstanding, server caps at settlement (D-10)');
  });

  // ---------------- X-RS-ARREARS: restructure arrears immediately overdue ----------------
  await step('X-RS-ARREARS', 'fresh restructure shows DPD', async () => {
    const deb = await c.newDebtor(admin, 'QA RS DPD');
    const id = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', ...M({ loan_start_date: addMonths(today(), -2) }) });
    const eff = addDays(today(), -1);
    await man.act(`/cases/${id}/restructures`, { effective_date: eff, interest_mode: 'monthly', interest_rate: '1.2', tenure: '12', reason: 'reschedule' });
    const h = await show(man, id);
    const d14 = await show(man, 14);
    rec('X-RS-ARREARS', 'a case restructured yesterday should not be "past due" on day 1', `this case: Overdue ${ledgerVal(h, 'Overdue')} (${(strip(h).match(/\d+ days past due|up to date/) || [])[0]}); demo case 14: ${ledgerVal(d14, 'Overdue')} (${(strip(d14).match(/\d+ days past due|up to date/) || [])[0]})`,
      /up to date/.test(strip(h)) ? 'PASS' : 'FAIL', '挂账行到期日 = 生效日（schedule.js:252），生效日次日起即计入 DPD 与 Aging 1–30');
  });

  // ---------------- X-DEMO-FK: delete demo after D-11 ----------------
  await step('X-DEMO-FK', 'Delete demo data when a trial payment is credited to a demo agent', async () => {
    reseed(); // isolate: no other trial rows may point at demo agent 1
    const deb = await c.newDebtor(admin, 'QA FK');
    await admin.act('/agents', { name: 'QA Owner', commission_rate: '5' });
    const ag = q1("SELECT id FROM agents WHERE name='QA Owner'").id;
    const id = await c.newCase(admin, { debtor_id: String(deb), agent_id: '1', principal_amount: '500', interest_mode: 'fixed', interest_amount: '0' });
    await fin.act(`/cases/${id}/payments`, { payment_date: today(), amount: '50', method: 'cash' }); // credited to demo agent 1 (payments.agent_id)
    await man.act(`/cases/${id}`, { debtor_id: String(deb), agent_id: String(ag), principal_amount: '500', interest_mode: 'fixed', interest_amount: '0', priority: 'medium' });
    // make sure no other trial row pins agent 1
    const pins = q1('SELECT (SELECT COUNT(*) FROM cases WHERE agent_id=1 AND is_demo=0) + (SELECT COUNT(*) FROM tasks WHERE agent_id=1 AND is_demo=0) + (SELECT COUNT(*) FROM call_logs WHERE agent_id=1 AND is_demo=0) + (SELECT COUNT(*) FROM commission_settlements WHERE agent_id=1 AND is_demo=0) n').n;
    const r = await admin.post('/demo-tools/delete-demo');
    const page = r.location ? await admin.get(r.location) : r;
    const demoLeft = q1('SELECT COUNT(*) n FROM cases WHERE is_demo=1').n;
    rec('X-DEMO-FK', 'Delete demo data succeeds (or keeps the demo agent) after a trial payment credited to it', `other pins on agent 1=${pins}; POST → ${r.status} ${r.location}; banner=${JSON.stringify(c.alertOf(page.text))}; demo cases left=${demoLeft}; agent 1 exists=${!!q1('SELECT 1 x FROM agents WHERE id=1')}`,
      r.status === 302 && c.alertOf(page.text)?.type === 'ok' ? 'PASS' : 'FAIL', 'seed.js:194-198 keeps a demo agent for cases/tasks/settlements/calls but not for payments.agent_id (D-11, v1.10.0)');
  });

  finish('x-outside-manual');
  assert.ok(true);
});
