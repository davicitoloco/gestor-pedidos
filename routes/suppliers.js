const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}
router.use(requireAuth, requireAdmin);

const IVA_CONDITIONS = ['Responsable Inscripto', 'Monotributista', 'Exento', 'Consumidor Final'];

// GET /api/suppliers
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.*,
        COALESCE((SELECT SUM(p.total) FROM purchases p WHERE p.supplier_id = s.id), 0)
        - COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.supplier_id = s.id), 0)
        - COALESCE((SELECT SUM(CASE WHEN n.note_type='credito' THEN n.amount ELSE -n.amount END) FROM credit_debit_notes n WHERE n.entity_type='supplier' AND n.entity_id = s.id), 0) AS balance
      FROM suppliers s
      ORDER BY s.name ASC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/suppliers/:id
router.get('/:id', (req, res) => {
  try {
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(req.params.id));
    if (!s) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json(s);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/suppliers/:id/account
router.get('/:id/account', (req, res) => {
  try {
    const sid = Number(req.params.id);
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(sid);
    if (!supplier) return res.status(404).json({ error: 'Proveedor no encontrado' });

    const purchases = db.prepare(`
      SELECT p.*, printf('C-%04d', p.purchase_sequence) AS purchase_number,
             COALESCE(u.full_name, u.username) AS created_by_name
      FROM purchases p
      LEFT JOIN users u ON p.created_by = u.id
      WHERE p.supplier_id = ?
      ORDER BY p.purchase_sequence DESC
    `).all(sid);

    const payments = db.prepare(`
      SELECT sp.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM supplier_payments sp
      LEFT JOIN users u ON sp.created_by = u.id
      WHERE sp.supplier_id = ?
      ORDER BY sp.created_at DESC
    `).all(sid);

    const notes = db.prepare(`
      SELECT n.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM credit_debit_notes n LEFT JOIN users u ON n.created_by = u.id
      WHERE n.entity_type='supplier' AND n.entity_id=?
      ORDER BY n.date DESC, n.id DESC
    `).all(sid);

    const total_debt = purchases.reduce((s, p) => s + p.total, 0);
    const total_paid = payments.reduce((s, p) => s + p.amount, 0);
    // For supplier: credito note reduces what we owe, debito increases it
    const notes_delta = notes.reduce((s, n) => s + (n.note_type === 'credito' ? -n.amount : n.amount), 0);
    const balance    = total_debt - total_paid + notes_delta;

    res.json({ supplier, purchases, payments, notes, total_debt, total_paid, balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/suppliers
router.post('/', (req, res) => {
  try {
    const { name, cuit, phone, email, address, iva_condition, notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
    const r = db.prepare(`
      INSERT INTO suppliers (name, cuit, phone, email, address, iva_condition, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), cuit||'', phone||'', email||'', address||'', iva_condition||'Responsable Inscripto', notes||'');
    res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(r.lastInsertRowid)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/suppliers/:id
router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!ex) return res.status(404).json({ error: 'Proveedor no encontrado' });
    const { name, cuit, phone, email, address, iva_condition, notes, active } = req.body;
    db.prepare(`UPDATE suppliers SET name=?,cuit=?,phone=?,email=?,address=?,iva_condition=?,notes=?,active=? WHERE id=?`).run(
      name          !== undefined ? name.trim()   : ex.name,
      cuit          !== undefined ? cuit          : ex.cuit,
      phone         !== undefined ? phone         : ex.phone,
      email         !== undefined ? email         : ex.email,
      address       !== undefined ? address       : ex.address,
      iva_condition !== undefined ? iva_condition : ex.iva_condition,
      notes         !== undefined ? notes         : ex.notes,
      active        !== undefined ? active        : ex.active,
      id
    );
    res.json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/suppliers/:id
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM suppliers WHERE id = ?').get(id))
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
