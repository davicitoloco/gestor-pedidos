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

// GET /api/bank/accounts
router.get('/accounts', (req, res) => {
  try {
    const accounts = db.prepare('SELECT * FROM bank_accounts WHERE active=1 ORDER BY name').all();
    const result = accounts.map(acc => {
      const { ingreso } = db.prepare("SELECT COALESCE(SUM(amount),0) AS ingreso FROM bank_movements WHERE bank_account_id=? AND type='ingreso'").get(acc.id);
      const { egreso  } = db.prepare("SELECT COALESCE(SUM(amount),0) AS egreso  FROM bank_movements WHERE bank_account_id=? AND type='egreso'").get(acc.id);
      return { ...acc, balance: acc.initial_balance + ingreso - egreso };
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/bank/accounts/all — includes inactive
router.get('/accounts/all', (req, res) => {
  try {
    const accounts = db.prepare('SELECT * FROM bank_accounts ORDER BY name').all();
    const result = accounts.map(acc => {
      const { ingreso } = db.prepare("SELECT COALESCE(SUM(amount),0) AS ingreso FROM bank_movements WHERE bank_account_id=? AND type='ingreso'").get(acc.id);
      const { egreso  } = db.prepare("SELECT COALESCE(SUM(amount),0) AS egreso  FROM bank_movements WHERE bank_account_id=? AND type='egreso'").get(acc.id);
      return { ...acc, balance: acc.initial_balance + ingreso - egreso };
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bank/accounts
router.post('/accounts', (req, res) => {
  try {
    const { name, bank, account_number, initial_balance } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
    const r = db.prepare(`
      INSERT INTO bank_accounts (name, bank, account_number, initial_balance)
      VALUES (?, ?, ?, ?)
    `).run(name.trim(), bank||'', account_number||'', parseFloat(initial_balance)||0);
    res.status(201).json(db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(Number(r.lastInsertRowid)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/bank/accounts/:id
router.put('/accounts/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id);
    if (!ex) return res.status(404).json({ error: 'Cuenta no encontrada' });
    const { name, bank, account_number, initial_balance, active } = req.body;
    db.prepare('UPDATE bank_accounts SET name=?,bank=?,account_number=?,initial_balance=?,active=? WHERE id=?').run(
      name            !== undefined ? name.trim()             : ex.name,
      bank            !== undefined ? bank                    : ex.bank,
      account_number  !== undefined ? account_number          : ex.account_number,
      initial_balance !== undefined ? parseFloat(initial_balance) : ex.initial_balance,
      active          !== undefined ? active                  : ex.active,
      id
    );
    res.json(db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/bank/accounts/:id
router.delete('/accounts/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM bank_accounts WHERE id = ?').get(id))
      return res.status(404).json({ error: 'Cuenta no encontrada' });
    db.prepare('UPDATE bank_accounts SET active=0 WHERE id=?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/bank/accounts/:id/movements
router.get('/accounts/:id/movements', (req, res) => {
  try {
    const id  = Number(req.params.id);
    const acc = db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(id);
    if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada' });
    const rows = db.prepare(`
      SELECT bm.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM bank_movements bm
      LEFT JOIN users u ON bm.created_by = u.id
      WHERE bm.bank_account_id = ?
      ORDER BY bm.created_at ASC, bm.id ASC
    `).all(id);

    let running = acc.initial_balance;
    const withBalance = rows.map(r => {
      running += r.type === 'ingreso' ? r.amount : -r.amount;
      return { ...r, running_balance: running };
    });
    withBalance.reverse();

    res.json({ account: acc, movements: withBalance, balance: running });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bank/accounts/:id/movements — manual entry
router.post('/accounts/:id/movements', (req, res) => {
  try {
    const bank_account_id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM bank_accounts WHERE id=?').get(bank_account_id))
      return res.status(404).json({ error: 'Cuenta no encontrada' });
    const { type, amount, description } = req.body;
    if (!['ingreso','egreso'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });
    if (!amount || parseFloat(amount) <= 0)   return res.status(400).json({ error: 'Monto inválido' });
    const r = db.prepare(`
      INSERT INTO bank_movements (bank_account_id, type, amount, description, ref_type, created_by)
      VALUES (?, ?, ?, ?, 'manual', ?)
    `).run(bank_account_id, type, parseFloat(amount), description||'', req.session.userId);
    res.status(201).json(db.prepare('SELECT * FROM bank_movements WHERE id=?').get(Number(r.lastInsertRowid)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/bank/movements/:id
router.delete('/movements/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const mv = db.prepare('SELECT * FROM bank_movements WHERE id=?').get(id);
    if (!mv) return res.status(404).json({ error: 'Movimiento no encontrado' });
    if (mv.ref_type !== 'manual') return res.status(400).json({ error: 'Solo se pueden eliminar movimientos manuales' });
    db.prepare('DELETE FROM bank_movements WHERE id=?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
