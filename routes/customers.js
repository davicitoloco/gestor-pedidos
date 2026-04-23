const express = require('express');
const router = express.Router();
const { db, withTransaction } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
router.use(requireAuth);

function isVendor(req) { return req.session.role === 'vendedor'; }

function normalizeCuit(raw) { return String(raw || '').replace(/\D/g, ''); }
function isValidCuit(c)     { return /^\d{11}$/.test(c); }

// GET /api/customers
router.get('/', (req, res) => {
  try {
    const vc = isVendor(req) ? `AND c.created_by = ${req.session.userId}` : '';
    const rows = db.prepare(`
      SELECT c.*,
        COALESCE(u.full_name, u.username) AS vendor_name,
        COALESCE((SELECT SUM(r.total)  FROM remitos  r WHERE r.customer_id = c.id), 0)
        - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id = c.id), 0)
        + COALESCE((SELECT SUM(CASE WHEN n.note_type='debito' THEN n.amount ELSE -n.amount END) FROM credit_debit_notes n WHERE n.entity_type='customer' AND n.entity_id = c.id), 0) AS balance
      FROM customers c
      LEFT JOIN users u ON c.created_by = u.id
      WHERE 1=1 ${vc}
      ORDER BY c.name ASC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/customers/:id/account
router.get('/:id/account', (req, res) => {
  try {
    const cid      = Number(req.params.id);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cid);
    if (!customer) return res.status(404).json({ error: 'Cliente no encontrado' });

    const remitos = db.prepare(`
      SELECT r.*, printf('R-%03d', r.remito_sequence) AS remito_number,
             printf('%03d', o.order_sequence) AS order_number
      FROM remitos r
      JOIN orders o ON r.order_id = o.id
      WHERE r.customer_id = ?
      ORDER BY r.remito_sequence DESC
    `).all(cid);

    const payments = db.prepare(`
      SELECT p.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM payments p
      LEFT JOIN users u ON p.created_by = u.id
      WHERE p.customer_id = ?
      ORDER BY p.created_at DESC
    `).all(cid);

    const notes = db.prepare(`
      SELECT n.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM credit_debit_notes n LEFT JOIN users u ON n.created_by = u.id
      WHERE n.entity_type='customer' AND n.entity_id=?
      ORDER BY n.date DESC, n.id DESC
    `).all(cid);

    const total_debt = remitos.reduce((s, r) => s + r.total, 0);
    const total_paid = payments.reduce((s, p) => s + p.amount, 0);
    // Notes: debito increases what the customer owes, credito decreases it
    const notes_delta = notes.reduce((s, n) => s + (n.note_type === 'debito' ? n.amount : -n.amount), 0);
    const balance    = total_debt - total_paid + notes_delta;

    res.json({ customer, remitos, payments, notes, total_debt, total_paid, balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customers
router.post('/', (req, res) => {
  try {
    const { name, phone, email, address, notes, iva_condition, cuit } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
    const normalizedCuit = normalizeCuit(cuit);
    if (!normalizedCuit) return res.status(400).json({ error: 'El CUIT es requerido' });
    if (!isValidCuit(normalizedCuit)) return res.status(400).json({ error: 'El CUIT debe tener 11 dígitos (formato: XX-XXXXXXXX-X)' });
    const dup = db.prepare("SELECT id FROM customers WHERE cuit = ?").get(normalizedCuit);
    if (dup) return res.status(409).json({ error: 'El CUIT ingresado ya corresponde a otro cliente' });
    const result = db.prepare(`
      INSERT INTO customers (name, cuit, phone, email, address, notes, iva_condition, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), normalizedCuit, phone||'', email||'', address||'', notes||'', iva_condition||'Consumidor Final', req.session.userId);
    res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/customers/:id
router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!ex) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (isVendor(req) && ex.created_by !== req.session.userId)
      return res.status(403).json({ error: 'No podés editar clientes de otros vendedores' });
    const { name, phone, email, address, notes, iva_condition, cuit } = req.body;
    let finalCuit = ex.cuit || '';
    if (cuit !== undefined) {
      if (!cuit || cuit.trim() === '') {
        finalCuit = '';
      } else {
        finalCuit = normalizeCuit(cuit);
        if (!isValidCuit(finalCuit)) return res.status(400).json({ error: 'El CUIT debe tener 11 dígitos (formato: XX-XXXXXXXX-X)' });
        const dup = db.prepare("SELECT id FROM customers WHERE cuit = ? AND id != ?").get(finalCuit, id);
        if (dup) return res.status(409).json({ error: 'El CUIT ingresado ya corresponde a otro cliente' });
      }
    }
    db.prepare(`UPDATE customers SET name=?, cuit=?, phone=?, email=?, address=?, notes=?, iva_condition=? WHERE id=?`).run(
      name          !== undefined ? name.trim()    : ex.name,
      finalCuit,
      phone         !== undefined ? phone          : ex.phone,
      email         !== undefined ? email          : ex.email,
      address       !== undefined ? address        : ex.address,
      notes         !== undefined ? notes          : ex.notes,
      iva_condition !== undefined ? iva_condition  : ex.iva_condition,
      id
    );
    res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/customers/:id
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!ex) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (isVendor(req) && ex.created_by !== req.session.userId)
      return res.status(403).json({ error: 'No podés eliminar clientes de otros vendedores' });
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customers/import
router.post('/import', (req, res) => {
  try {
    const { customers } = req.body;
    if (!Array.isArray(customers) || !customers.length)
      return res.status(400).json({ error: 'No hay clientes para importar' });

    let imported = 0;
    const errors = [];
    const ins = db.prepare(
      'INSERT INTO customers (name, phone, email, address, created_by) VALUES (?, ?, ?, ?, ?)'
    );

    withTransaction(() => {
      for (let i = 0; i < customers.length; i++) {
        const c = customers[i];
        const name = String(c.nombre || c.name || c.cliente || c.customer || '').trim();
        if (!name) { errors.push(`Fila ${i + 2}: nombre requerido`); continue; }
        const phone   = String(c.telefono || c.teléfono || c.phone || c.tel || c.celular || '').trim();
        const email   = String(c.email || c.correo || c.mail || '').trim();
        const address = String(c.direccion || c.dirección || c.address || c.domicilio || '').trim();
        ins.run(name, phone, email, address, req.session.userId);
        imported++;
      }
    });

    res.json({ imported, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
