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

const VALID_METHODS = ['efectivo', 'cheque', 'transferencia', 'otros'];

// GET /api/supplier-payments/supplier/:supplierId
router.get('/supplier/:supplierId', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT sp.*, COALESCE(u.full_name, u.username) AS created_by_name,
             ba.name AS bank_account_name
      FROM supplier_payments sp
      LEFT JOIN users u ON sp.created_by = u.id
      LEFT JOIN bank_accounts ba ON sp.bank_account_id = ba.id
      WHERE sp.supplier_id = ?
      ORDER BY sp.created_at DESC
    `).all(Number(req.params.supplierId));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/supplier-payments
router.post('/', (req, res) => {
  try {
    const {
      supplier_id, amount, method, reference, bank, bank_account_id, notes, payment_date,
      cheque_bank, cheque_number, cheque_due_date
    } = req.body;
    if (!supplier_id)                       return res.status(400).json({ error: 'Proveedor requerido' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Monto inválido' });
    if (!VALID_METHODS.includes(method))    return res.status(400).json({ error: 'Método de pago inválido' });

    const result = withTransaction(() => {
      const amt     = parseFloat(amount);
      const sid     = Number(supplier_id);
      const supplier = db.prepare('SELECT name FROM suppliers WHERE id=?').get(sid);
      const desc    = `Pago a proveedor: ${supplier?.name || sid}`;

      // If cheque propio, create emitido cheque record
      let chequeId = null;
      if (method === 'cheque') {
        const cr = db.prepare(`
          INSERT INTO cheques (direction, bank, cheque_number, amount, due_date, status, holder_name, supplier_id, created_by)
          VALUES ('emitido', ?, ?, ?, ?, 'emitido', ?, ?, ?)
        `).run(
          cheque_bank || bank || '',
          cheque_number || reference || 'Sin nro',
          amt,
          cheque_due_date || payment_date || null,
          supplier?.name || '',
          sid,
          req.session.userId
        );
        chequeId = Number(cr.lastInsertRowid);
      }

      const r = db.prepare(`
        INSERT INTO supplier_payments (supplier_id, amount, method, reference, bank, bank_account_id, cheque_id, notes, payment_date, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sid, amt, method,
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
          .run('egreso', amt, desc, 'supplier_payment', paymentId, req.session.userId);
      } else if (method === 'transferencia' && bank_account_id) {
        db.prepare(`INSERT INTO bank_movements (bank_account_id,type,amount,description,ref_type,ref_id,created_by) VALUES (?,?,?,?,?,?,?)`)
          .run(Number(bank_account_id), 'egreso', amt, desc, 'supplier_payment', paymentId, req.session.userId);
      }
      // cheque emitido → bank movement happens when status → debitado

      return paymentId;
    });

    res.status(201).json(db.prepare('SELECT * FROM supplier_payments WHERE id=?').get(result));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/supplier-payments/:id
router.delete('/:id', (req, res) => {
  try {
    const id  = Number(req.params.id);
    const pmt = db.prepare('SELECT * FROM supplier_payments WHERE id=?').get(id);
    if (!pmt) return res.status(404).json({ error: 'Pago no encontrado' });

    withTransaction(() => {
      if (pmt.cheque_id) {
        const ch = db.prepare('SELECT status FROM cheques WHERE id=?').get(pmt.cheque_id);
        if (ch && ch.status === 'emitido') {
          db.prepare('DELETE FROM cheques WHERE id=?').run(pmt.cheque_id);
        }
      }
      db.prepare("DELETE FROM cash_movements WHERE ref_type='supplier_payment' AND ref_id=?").run(id);
      db.prepare("DELETE FROM bank_movements WHERE ref_type='supplier_payment' AND ref_id=?").run(id);
      db.prepare('DELETE FROM supplier_payments WHERE id=?').run(id);
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
