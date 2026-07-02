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
  secret: 'debt-collection-crm-demo-secret',
  resave: false,
  saveUninitialized: false,
}));

app.get('/health', (req, res) => res.type('text').send('ok'));

// ROUTE MOUNT POINT — later tasks insert app.use(...) here

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CRM demo running: http://localhost:${PORT}`));
