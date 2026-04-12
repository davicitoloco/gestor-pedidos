const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// DATABASE_PATH permite montar un volumen persistente en Railway/Docker.
// Sin esa variable intenta /data/pedidos.db (volumen Railway por convención).
// Si /data no es accesible (desarrollo local), cae al directorio ./data.
let DB_FILE  = process.env.DATABASE_PATH || '/data/pedidos.db';
let DATA_DIR = path.dirname(DB_FILE);
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  DB_FILE  = path.join(__dirname, 'data', 'pedidos.db');
  DATA_DIR = path.dirname(DB_FILE);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbIsNew = !fs.existsSync(DB_FILE);
const db = new DatabaseSync(DB_FILE);
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
  CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    type TEXT NOT NULL,
    quantity REAL NOT NULL,
    reference TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS remitos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    remito_sequence INTEGER UNIQUE NOT NULL,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    delivery_id INTEGER UNIQUE NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id),
    customer_name TEXT NOT NULL,
    customer_iva TEXT NOT NULL DEFAULT 'Consumidor Final',
    total REAL NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS remito_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    remito_id INTEGER NOT NULL REFERENCES remitos(id) ON DELETE CASCADE,
    product_name TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    unit_price REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    method TEXT NOT NULL DEFAULT 'efectivo',
    reference TEXT DEFAULT '',
    bank TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    payment_date TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cuit TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address TEXT DEFAULT '',
    iva_condition TEXT NOT NULL DEFAULT 'Responsable Inscripto',
    notes TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_sequence INTEGER UNIQUE NOT NULL,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    doc_type TEXT NOT NULL DEFAULT 'Factura B',
    doc_number TEXT DEFAULT '',
    doc_date TEXT,
    total REAL NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    product_name TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    unit_price REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS supplier_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    method TEXT NOT NULL DEFAULT 'efectivo',
    reference TEXT DEFAULT '',
    bank TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    payment_date TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS cash_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT DEFAULT '',
    ref_type TEXT DEFAULT '',
    ref_id INTEGER,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    bank TEXT NOT NULL DEFAULT '',
    account_number TEXT DEFAULT '',
    initial_balance REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS bank_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT DEFAULT '',
    ref_type TEXT DEFAULT '',
    ref_id INTEGER,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS cheques (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,
    bank TEXT NOT NULL,
    cheque_number TEXT NOT NULL,
    amount REAL NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'en_cartera',
    holder_name TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    customer_id INTEGER REFERENCES customers(id),
    supplier_id INTEGER REFERENCES suppliers(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    subtype TEXT NOT NULL DEFAULT '',
    accepts_movements INTEGER NOT NULL DEFAULT 1,
    parent_code TEXT DEFAULT NULL,
    bank_account_id INTEGER REFERENCES bank_accounts(id),
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    ref_type TEXT NOT NULL DEFAULT '',
    ref_id INTEGER DEFAULT NULL,
    is_reversed INTEGER NOT NULL DEFAULT 0,
    reversal_of INTEGER REFERENCES journal_entries(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS journal_entry_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    debit REAL NOT NULL DEFAULT 0,
    credit REAL NOT NULL DEFAULT 0
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
addColIfMissing('products', 'stock',     'INTEGER NOT NULL DEFAULT 0');
addColIfMissing('products', 'stock_min', 'INTEGER NOT NULL DEFAULT 0');
addColIfMissing('order_items', 'product_id', 'INTEGER REFERENCES products(id)');
addColIfMissing('customers', 'iva_condition', "TEXT NOT NULL DEFAULT 'Consumidor Final'");
addColIfMissing('payments',          'bank_account_id', 'INTEGER REFERENCES bank_accounts(id)');
addColIfMissing('payments',          'cheque_id',       'INTEGER REFERENCES cheques(id)');
addColIfMissing('supplier_payments', 'bank_account_id', 'INTEGER REFERENCES bank_accounts(id)');
addColIfMissing('supplier_payments', 'cheque_id',       'INTEGER REFERENCES cheques(id)');
addColIfMissing('cheques',           'deposited_to',    'INTEGER REFERENCES bank_accounts(id)');
addColIfMissing('supplier_payments', 'purchase_id',     'INTEGER REFERENCES purchases(id)');
addColIfMissing('journal_entries',    'reference',        "TEXT NOT NULL DEFAULT ''");
addColIfMissing('journal_entry_lines','line_description', "TEXT NOT NULL DEFAULT ''");

// Seed plan de cuentas
{
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
  if (cnt === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO accounts (code,name,type,subtype,accepts_movements,parent_code) VALUES (?,?,?,?,?,?)');
    // Groups
    ins.run('1',    'ACTIVO',                     'Activo',    '',            0, null);
    ins.run('1.1',  'Activo Corriente',            'Activo',    '',            0, '1');
    ins.run('2',    'PASIVO',                      'Pasivo',    '',            0, null);
    ins.run('2.1',  'Pasivo Corriente',            'Pasivo',    '',            0, '2');
    ins.run('3',    'PATRIMONIO NETO',             'Patrimonio','',            0, null);
    ins.run('3.1',  'Patrimonio Neto',             'Patrimonio','',            0, '3');
    ins.run('4',    'INGRESOS',                    'Ingreso',   '',            0, null);
    ins.run('4.1',  'Ingresos operativos',         'Ingreso',   '',            0, '4');
    ins.run('5',    'COSTOS',                      'Costo',     '',            0, null);
    ins.run('5.1',  'Costo de ventas',             'Costo',     '',            0, '5');
    ins.run('6',    'GASTOS',                      'Gasto',     '',            0, null);
    ins.run('6.1',  'Gastos operativos',           'Gasto',     '',            0, '6');
    // Leaf accounts
    ins.run('1.1.01','Caja',                       'Activo','Caja',        1,'1.1');
    ins.run('1.1.02','Banco',                      'Activo','BancoGrupo',  0,'1.1');
    ins.run('1.1.03','Cheques en cartera',         'Activo','Cheques',     1,'1.1');
    ins.run('1.1.04','Deudores por ventas',        'Activo','Clientes',    1,'1.1');
    ins.run('1.1.05','Mercaderías',                'Activo','Stock',       1,'1.1');
    ins.run('2.1.01','Proveedores',                'Pasivo','Proveedores', 1,'2.1');
    ins.run('2.1.02','Otras deudas',               'Pasivo','',            1,'2.1');
    ins.run('3.1.01','Capital',                    'Patrimonio','',        1,'3.1');
    ins.run('3.1.02','Resultados acumulados',      'Patrimonio','',        1,'3.1');
    ins.run('4.1.01','Ventas',                     'Ingreso','',           1,'4.1');
    ins.run('5.1.01','Costo de mercadería vendida','Costo',  '',           1,'5.1');
    ins.run('6.1.01','Gastos administrativos',     'Gasto',  '',           1,'6.1');
    ins.run('6.1.02','Gastos financieros',         'Gasto',  '',           1,'6.1');
  }
  // Create accounting accounts for existing bank_accounts
  try {
    const bankAccts = db.prepare('SELECT * FROM bank_accounts').all();
    for (const ba of bankAccts) {
      const exists = db.prepare('SELECT id FROM accounts WHERE bank_account_id=?').get(ba.id);
      if (!exists) {
        db.prepare('INSERT OR IGNORE INTO accounts (code,name,type,subtype,accepts_movements,parent_code,bank_account_id) VALUES (?,?,?,?,?,?,?)')
          .run(`1.1.02.${ba.id}`, `Banco: ${ba.name}`, 'Activo', 'Banco', 1, '1.1.02', ba.id);
      }
    }
  } catch(e) {}
}

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

module.exports = { db, withTransaction, DB_FILE, dbIsNew };
