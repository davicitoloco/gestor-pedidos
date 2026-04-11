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
      SELECT sp.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM supplier_payments sp
      LEFT JOIN users u ON sp.created_by = u.id
      WHERE sp.supplier_id = ?
      ORDER BY sp.created_at DESC
    `).all(Number(req.params.supplierId));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/supplier-payments
router.post('/', (req, res) => {
  try {
    const { supplier_id, amount, method, reference, bank, notes, payment_date } = req.body;
    if (!supplier_id)                       return res.status(400).json({ error: 'Proveedor requerido' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Monto inválido' });
    if (!VALID_METHODS.includes(method))    return res.status(400).json({ error: 'Método de pago inválido' });

    const result = withTransaction(() => {
      const r = db.prepare(`
        INSERT INTO supplier_payments (supplier_id, amount, method, reference, bank, notes, payment_date, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(Number(supplier_id), parseFloat(amount), method, reference||'', bank||'', notes||'', payment_date||null, req.session.userId);

      const paymentId = Number(r.lastInsertRowid);

      // Auto cash egreso for efectivo
      if (method === 'efectivo') {
        const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(Number(supplier_id));
        db.prepare(`
          INSERT INTO cash_movements (type, amount, description, ref_type, ref_id, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run('egreso', parseFloat(amount), `Pago a proveedor: ${supplier?.name || supplier_id}`, 'supplier_payment', paymentId, req.session.userId);
      }

      // Auto bank egreso for transferencia
      if (method === 'transferencia' && bank) {
        const bankAcc = db.prepare("SELECT id FROM bank_accounts WHERE name = ? AND active = 1").get(bank);
        if (bankAcc) {
          const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(Number(supplier_id));
          db.prepare(`
            INSERT INTO bank_movements (bank_account_id, type, amount, description, ref_type, ref_id, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(bankAcc.id, 'egreso', parseFloat(amount), `Pago a proveedor: ${supplier?.name || supplier_id}`, 'supplier_payment', paymentId, req.session.userId);
        }
      }

      return paymentId;
    });

    res.status(201).json(db.prepare('SELECT * FROM supplier_payments WHERE id = ?').get(result));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/supplier-payments/:id
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM supplier_payments WHERE id = ?').get(id))
      return res.status(404).json({ error: 'Pago no encontrado' });
    // remove related cash/bank movements
    db.prepare("DELETE FROM cash_movements WHERE ref_type = 'supplier_payment' AND ref_id = ?").run(id);
    db.prepare("DELETE FROM bank_movements WHERE ref_type = 'supplier_payment' AND ref_id = ?").run(id);
    db.prepare('DELETE FROM supplier_payments WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
