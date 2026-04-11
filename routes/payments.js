const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}
router.use(requireAuth);

const VALID_METHODS = ['efectivo', 'cheque', 'transferencia', 'tarjeta', 'otros'];

// ── GET /api/payments/customer/:customerId ─────────────────────────────────────
router.get('/customer/:customerId', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM payments p
      LEFT JOIN users u ON p.created_by = u.id
      WHERE p.customer_id = ?
      ORDER BY p.created_at DESC
    `).all(Number(req.params.customerId));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/payments ─────────────────────────────────────────────────────────
router.post('/', requireAdmin, (req, res) => {
  try {
    const { customer_id, amount, method, reference, bank, notes, payment_date } = req.body;
    if (!customer_id)                    return res.status(400).json({ error: 'Cliente requerido' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Monto inválido' });
    if (!VALID_METHODS.includes(method)) return res.status(400).json({ error: 'Método de pago inválido' });

    const r = db.prepare(`
      INSERT INTO payments (customer_id, amount, method, reference, bank, notes, payment_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(Number(customer_id), parseFloat(amount), method, reference || '', bank || '', notes || '', payment_date || null, req.session.userId);
    res.status(201).json(db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(r.lastInsertRowid)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/payments/:id ───────────────────────────────────────────────────
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM payments WHERE id = ?').get(id))
      return res.status(404).json({ error: 'Pago no encontrado' });
    db.prepare('DELETE FROM payments WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
