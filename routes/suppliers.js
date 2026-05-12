const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (!['admin','subadmin'].includes(req.session.role)) return res.status(403).json({ error: 'Solo administradores' });
  next();
}

// GET /api/suppliers/for-mp — proveedores visibles al usuario actual (mp ve solo los asignados)
// Registrado ANTES de requireAdmin para que mp pueda acceder
router.get('/for-mp', requireAuth, (req, res) => {
  try {
    const { userId, role } = req.session;
    let rows;
    if (role === 'admin' || role === 'subadmin') {
      rows = db.prepare('SELECT id, name FROM suppliers WHERE active=1 ORDER BY name ASC').all();
    } else if (role === 'mp') {
      rows = db.prepare(`
        SELECT s.id, s.name FROM suppliers s
        INNER JOIN supplier_visibility sv ON sv.supplier_id = s.id AND sv.user_id = ?
        WHERE s.active = 1 ORDER BY s.name ASC
      `).all(userId);
    } else {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    const id = Number(req.params.id);
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!s) return res.status(404).json({ error: 'Proveedor no encontrado' });
    const mp_user_ids = db.prepare('SELECT user_id FROM supplier_visibility WHERE supplier_id=?').all(id).map(r => r.user_id);
    res.json({ ...s, mp_user_ids });
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
    const { name, cuit, phone, email, address, iva_condition, notes, mp_user_ids } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
    const sid = withTransaction(() => {
      const r = db.prepare(`
        INSERT INTO suppliers (name, cuit, phone, email, address, iva_condition, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(name.trim(), cuit||'', phone||'', email||'', address||'', iva_condition||'Responsable Inscripto', notes||'');
      const newId = Number(r.lastInsertRowid);
      if (Array.isArray(mp_user_ids)) {
        const ins = db.prepare('INSERT OR IGNORE INTO supplier_visibility (supplier_id, user_id) VALUES (?,?)');
        for (const uid of mp_user_ids) ins.run(newId, Number(uid));
      }
      return newId;
    });
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(sid);
    const saved_mp_user_ids = db.prepare('SELECT user_id FROM supplier_visibility WHERE supplier_id=?').all(sid).map(r => r.user_id);
    res.status(201).json({ ...s, mp_user_ids: saved_mp_user_ids });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/suppliers/:id
router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!ex) return res.status(404).json({ error: 'Proveedor no encontrado' });
    const { name, cuit, phone, email, address, iva_condition, notes, active, mp_user_ids } = req.body;
    withTransaction(() => {
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
      if (Array.isArray(mp_user_ids)) {
        db.prepare('DELETE FROM supplier_visibility WHERE supplier_id=?').run(id);
        const ins = db.prepare('INSERT OR IGNORE INTO supplier_visibility (supplier_id, user_id) VALUES (?,?)');
        for (const uid of mp_user_ids) ins.run(id, Number(uid));
      }
    });
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    const saved_mp_user_ids = db.prepare('SELECT user_id FROM supplier_visibility WHERE supplier_id=?').all(id).map(r => r.user_id);
    res.json({ ...s, mp_user_ids: saved_mp_user_ids });
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
