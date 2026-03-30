const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'pedidos.db'));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// Tablas base
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_sequence INTEGER UNIQUE NOT NULL,
    customer_name TEXT NOT NULL,
    notes TEXT DEFAULT '',
    delivery_date TEXT,
    status TEXT NOT NULL DEFAULT 'Pendiente',
    discount REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_price REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    notes TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS delivery_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    order_item_id INTEGER NOT NULL REFERENCES order_items(id),
    quantity_delivered REAL NOT NULL DEFAULT 0
  );
`);

// Migraciones seguras (agrega columnas si no existen)
function addColIfMissing(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColIfMissing('users', 'role',      "TEXT NOT NULL DEFAULT 'vendedor'");
addColIfMissing('users', 'full_name', "TEXT NOT NULL DEFAULT ''");
addColIfMissing('users', 'active',    "INTEGER NOT NULL DEFAULT 1");
addColIfMissing('orders', 'created_by', "INTEGER REFERENCES users(id)");

// Settings por defecto
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run('company_name', 'Mi Empresa');

// Usuario admin por defecto
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (userCount.c === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare("INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, 'admin', 'Administrador')").run('admin', hash);
  console.log('\n  Usuario por defecto → admin / admin123\n');
}
// Asegurar que admin tenga rol admin
db.exec("UPDATE users SET role = 'admin' WHERE username = 'admin' AND role = 'vendedor'");

function withTransaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, withTransaction };
