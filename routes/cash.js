const express = require('express');
const router  = express.Router();
const { db } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}
router.use(requireAuth, requireAdmin);

// GET /api/cash — movements with running balance
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT cm.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM cash_movements cm
      LEFT JOIN users u ON cm.created_by = u.id
      ORDER BY cm.created_at ASC, cm.id ASC
    `).all();

    let running = 0;
    const withBalance = rows.map(r => {
      running += r.type === 'ingreso' ? r.amount : -r.amount;
      return { ...r, running_balance: running };
    });
    withBalance.reverse(); // newest first for display

    res.json({ movements: withBalance, balance: running });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/cash/summary
router.get('/summary', (req, res) => {
  try {
    const { ingreso } = db.prepare("SELECT COALESCE(SUM(amount),0) AS ingreso FROM cash_movements WHERE type='ingreso'").get();
    const { egreso  } = db.prepare("SELECT COALESCE(SUM(amount),0) AS egreso  FROM cash_movements WHERE type='egreso'").get();
    res.json({ ingreso, egreso, balance: ingreso - egreso });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/cash — manual movement
router.post('/', (req, res) => {
  try {
    const { type, amount, description } = req.body;
    if (!['ingreso','egreso'].includes(type)) return res.status(400).json({ error: 'Tipo inválido (ingreso/egreso)' });
    if (!amount || parseFloat(amount) <= 0)   return res.status(400).json({ error: 'Monto inválido' });
    const r = db.prepare(`
      INSERT INTO cash_movements (type, amount, description, ref_type, created_by)
      VALUES (?, ?, ?, 'manual', ?)
    `).run(type, parseFloat(amount), description||'', req.session.userId);
    res.status(201).json(db.prepare('SELECT * FROM cash_movements WHERE id = ?').get(Number(r.lastInsertRowid)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/cash/:id — only manual movements
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const mv = db.prepare('SELECT * FROM cash_movements WHERE id = ?').get(id);
    if (!mv) return res.status(404).json({ error: 'Movimiento no encontrado' });
    if (mv.ref_type !== 'manual') return res.status(400).json({ error: 'Solo se pueden eliminar movimientos manuales' });
    db.prepare('DELETE FROM cash_movements WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
