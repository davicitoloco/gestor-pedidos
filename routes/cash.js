const express = require('express');
const router  = express.Router();
const { db } = require('../db');
const { getSucursalFilter, getInsertSucursalId } = require('../lib/sucursal');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (!['admin','subadmin'].includes(req.session.role)) return res.status(403).json({ error: 'Solo administradores' });
  next();
}
router.use(requireAuth, requireAdmin);

function getCajaBalance() {
  const { balance } = db.prepare(`
    SELECT COALESCE(SUM(jel.debit) - SUM(jel.credit), 0) AS balance
    FROM journal_entry_lines jel
    JOIN accounts a ON jel.account_id = a.id
    WHERE a.code = '1.1.01'
  `).get();
  return balance;
}

// GET /api/cash — movements with running balance
router.get('/', (req, res) => {
  try {
    const sf = getSucursalFilter(req, 'cm');
    const rows = db.prepare(`
      SELECT cm.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM cash_movements cm
      LEFT JOIN users u ON cm.created_by = u.id
      WHERE 1=1 ${sf.clause}
      ORDER BY cm.created_at ASC, cm.id ASC
    `).all(...sf.params);

    let running = 0;
    const withBalance = rows.map(r => {
      running += r.type === 'ingreso' ? r.amount : -r.amount;
      return { ...r, running_balance: running };
    });
    withBalance.reverse();

    res.json({ movements: withBalance, balance: getCajaBalance() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/cash/summary
router.get('/summary', (req, res) => {
  try {
    const sf = getSucursalFilter(req, 'cm');
    const { ingreso } = db.prepare(`SELECT COALESCE(SUM(amount),0) AS ingreso FROM cash_movements cm WHERE type='ingreso' ${sf.clause}`).get(...sf.params);
    const { egreso  } = db.prepare(`SELECT COALESCE(SUM(amount),0) AS egreso  FROM cash_movements cm WHERE type='egreso'  ${sf.clause}`).get(...sf.params);
    res.json({ ingreso, egreso, balance: getCajaBalance() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/cash — manual movement
router.post('/', (req, res) => {
  try {
    const { type, amount, description } = req.body;
    if (!['ingreso','egreso'].includes(type)) return res.status(400).json({ error: 'Tipo inválido (ingreso/egreso)' });
    if (!amount || parseFloat(amount) <= 0)   return res.status(400).json({ error: 'Monto inválido' });
    const r = db.prepare(`
      INSERT INTO cash_movements (type, amount, description, ref_type, created_by, sucursal_id)
      VALUES (?, ?, ?, 'manual', ?, ?)
    `).run(type, parseFloat(amount), description||'', req.session.userId, getInsertSucursalId(req));
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
