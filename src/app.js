const path = require('node:path');
const express = require('express');
const session = require('express-session');
const engine = require('ejs-mate');
const { init } = require('./db');
const { sameOrigin, securityHeaders, flash, errorHandler, notFound } = require('./middleware/security');
const { refreshStaleAccruals } = require('./services/payments');

init();

const app = express();
app.disable('x-powered-by');
// On Render (it sets RENDER=true) requests arrive through its proxies, so req.ip —
// which the login throttle and audit log use — must be read from
// X-Forwarded-For, trusting exactly that many hops; more would let a client
// spoof its IP. TRUST_PROXY overrides the default if the hop count changes.
if (process.env.RENDER) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 3);
app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(securityHeaders);
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// In production a real secret is mandatory; the demo fallback is dev-only.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}
app.use(session({
  secret: process.env.SESSION_SECRET || 'debt-collection-crm-demo-secret',
  resave: false,
  saveUninitialized: false,
  // Idle timeout: each response pushes expiry 2h out; 2h without a request logs out.
  rolling: true,
  cookie: { maxAge: 2 * 60 * 60 * 1000 },
}));
app.use(sameOrigin);

app.get('/health', (req, res) => res.type('text').send('ok'));

const { VERSION, CHANGELOG } = require('./version');
app.get('/version', (req, res) => res.render('version', { version: VERSION, changelog: CHANGELOG }));

app.get('/demo-accounts', (req, res) => res.render('demo-accounts', { accounts: [
  ['admin','admin123','Full access + user mgmt + audit'],
  ['manager','manager123','Cases/debtors/agents + reports'],
  ['agent1','agent123','Only own cases (agent2/agent3 too)'],
  ['finance','finance123','Record payments, view reports'],
  ['auditor','auditor123','Read-only everything + audit log'],
] }));

// ROUTE MOUNT POINT — later tasks insert app.use(...) here
const { attachUser } = require('./middleware/auth');
app.use(attachUser);
app.use(flash);
app.use((req, res, next) => { if (req.session.user) refreshStaleAccruals(); next(); });
const h = require('./utils/helpers');
app.use((req, res, next) => { res.locals.h = h; res.locals.query = req.query; res.locals.path = req.path; next(); });
app.use(require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
// Clients module is retired for internal-only business (cases auto-use a built-in
// "自营" client). Re-add this mount + the sidebar link to bring it back.
// app.use('/clients', require('./routes/clients'));
app.use('/debtors', require('./routes/debtors'));
app.use('/cases', require('./routes/cases').router);
app.use('/ptps', require('./routes/ptps'));
app.use('/agents', require('./routes/agents'));
app.use('/users', require('./routes/users'));
app.use('/demo-tools', require('./routes/demo'));
app.use('/tasks', require('./routes/tasks'));
app.use('/reports', require('./routes/reports'));
app.use('/commissions', require('./routes/commissions').router);
app.use('/search', require('./routes/search'));
app.use('/audit-log', require('./routes/audit'));
app.use('/settings', require('./routes/settings'));
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CRM demo running: http://localhost:${PORT}`));
