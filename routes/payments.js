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
router.use(requireAuth);

const VALID_METHODS = ['efectivo', 'cheque', 'transferencia', 'tarjeta', 'otros'];

// GET /api/payments/customer/:customerId
router.get('/customer/:customerId', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.*, COALESCE(u.full_name, u.username) AS created_by_name,
             ba.name AS bank_account_name
      FROM payments p
      LEFT JOIN users u ON p.created_by = u.id
      LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
      WHERE p.customer_id = ?
      ORDER BY p.created_at DESC
    `).all(Number(req.params.customerId));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/payments
router.post('/', requireAdmin, (req, res) => {
  try {
    const {
      customer_id, amount, method, reference, bank, bank_account_id, notes, payment_date,
      cheque_bank, cheque_number, cheque_due_date
    } = req.body;
    if (!customer_id)                       return res.status(400).json({ error: 'Cliente requerido' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Monto inválido' });
    if (!VALID_METHODS.includes(method))    return res.status(400).json({ error: 'Método de pago inválido' });

    const result = withTransaction(() => {
      const amt  = parseFloat(amount);
      const cid  = Number(customer_id);
      const cust = db.prepare('SELECT name FROM customers WHERE id=?').get(cid);
      const desc = `Cobro cliente: ${cust?.name || cid}`;

      // If cheque, create cheque record in en_cartera
      let chequeId = null;
      if (method === 'cheque') {
        const cr = db.prepare(`
          INSERT INTO cheques (direction, bank, cheque_number, amount, due_date, status, holder_name, customer_id, created_by)
          VALUES ('recibido', ?, ?, ?, ?, 'en_cartera', ?, ?, ?)
        `).run(
          cheque_bank || bank || '',
          cheque_number || reference || 'Sin nro',
          amt,
          cheque_due_date || payment_date || null,
          cust?.name || '',
          cid,
          req.session.userId
        );
        chequeId = Number(cr.lastInsertRowid);
      }

      const r = db.prepare(`
        INSERT INTO payments (customer_id, amount, method, reference, bank, bank_account_id, cheque_id, notes, payment_date, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cid, amt, method,
        reference || '',
        bank || '',
        bank_account_id ? Number(bank_account_id) : null,
        chequeId,
        notes || '',
        payment_date || null,
        req.session.userId
      );
      const paymentId = Number(r.lastInsertRowid);

      // Auto cash/bank movements
      if (method === 'efectivo') {
        db.prepare(`INSERT INTO cash_movements (type,amount,description,ref_type,ref_id,created_by) VALUES (?,?,?,?,?,?)`)
          .run('ingreso', amt, desc, 'payment', paymentId, req.session.userId);
      } else if (['transferencia', 'tarjeta'].includes(method) && bank_account_id) {
        db.prepare(`INSERT INTO bank_movements (bank_account_id,type,amount,description,ref_type,ref_id,created_by) VALUES (?,?,?,?,?,?,?)`)
          .run(Number(bank_account_id), 'ingreso', amt, `${desc} (${method})`, 'payment', paymentId, req.session.userId);
      }
      // cheque → goes to cartera, bank movement happens on deposit

      return paymentId;
    });

    res.status(201).json(db.prepare('SELECT * FROM payments WHERE id=?').get(result));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/payments/:id
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const id  = Number(req.params.id);
    const pmt = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
    if (!pmt) return res.status(404).json({ error: 'Pago no encontrado' });

    withTransaction(() => {
      // Remove linked cheque if still en_cartera
      if (pmt.cheque_id) {
        const ch = db.prepare('SELECT status FROM cheques WHERE id=?').get(pmt.cheque_id);
        if (ch && ch.status === 'en_cartera') {
          db.prepare('DELETE FROM cheques WHERE id=?').run(pmt.cheque_id);
        }
      }
      db.prepare("DELETE FROM cash_movements WHERE ref_type='payment' AND ref_id=?").run(id);
      db.prepare("DELETE FROM bank_movements WHERE ref_type='payment' AND ref_id=?").run(id);
      db.prepare('DELETE FROM payments WHERE id=?').run(id);
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
