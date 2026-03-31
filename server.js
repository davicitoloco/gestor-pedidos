const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const { DB_FILE, dbIsNew } = require('./db');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new FileStore({
    path: path.join(DATA_DIR, 'sessions'),
    ttl: 7 * 24 * 60 * 60,
    retries: 0,
    logFn: () => {}
  }),
  secret: process.env.SESSION_SECRET || 'gestor-pedidos-clave-secreta-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',     require('./routes/auth'));
app.use('/api/orders',   require('./routes/orders'));
app.use('/api/products', require('./routes/products'));
app.use('/api/users',    require('./routes/users'));
app.use('/api/reports',  require('./routes/reports'));
app.use('/api/settings',   require('./routes/settings'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/stock',     require('./routes/stock'));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  Gestor de Pedidos → http://localhost:${PORT}`);
  console.log(`  Base de datos      → ${DB_FILE} ${dbIsNew ? '[NUEVA]' : '[existente]'}`);
  if (dbIsNew) console.log('  ⚠  Base de datos creada desde cero. Si esto ocurre en cada deploy, el volumen no está montado correctamente.');
  console.log();
});
