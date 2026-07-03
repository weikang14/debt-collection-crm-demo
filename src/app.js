const path = require('node:path');
const express = require('express');
const session = require('express-session');
const engine = require('ejs-mate');
const { init } = require('./db');

init();

const app = express();
app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'debt-collection-crm-demo-secret',
  resave: false,
  saveUninitialized: false,
}));

app.get('/health', (req, res) => res.type('text').send('ok'));

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
app.use('/tasks', require('./routes/tasks'));
app.use('/reports', require('./routes/reports'));
app.use('/search', require('./routes/search'));
app.use('/audit-log', require('./routes/audit'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CRM demo running: http://localhost:${PORT}`));
