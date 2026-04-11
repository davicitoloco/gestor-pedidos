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

// GET /api/finance/summary — financial dashboard
router.get('/summary', (req, res) => {
  try {
    // Cash balance
    const { cash_in  } = db.prepare("SELECT COALESCE(SUM(amount),0) AS cash_in  FROM cash_movements WHERE type='ingreso'").get();
    const { cash_out } = db.prepare("SELECT COALESCE(SUM(amount),0) AS cash_out FROM cash_movements WHERE type='egreso'").get();
    const cash_balance = cash_in - cash_out;

    // Bank balance (all active accounts)
    const accounts = db.prepare('SELECT * FROM bank_accounts WHERE active=1').all();
    let bank_balance = 0;
    for (const acc of accounts) {
      const { ing } = db.prepare("SELECT COALESCE(SUM(amount),0) AS ing FROM bank_movements WHERE bank_account_id=? AND type='ingreso'").get(acc.id);
      const { eg  } = db.prepare("SELECT COALESCE(SUM(amount),0) AS eg  FROM bank_movements WHERE bank_account_id=? AND type='egreso'").get(acc.id);
      bank_balance += acc.initial_balance + ing - eg;
    }

    // Client debtors (total balance owed by all customers)
    const { client_debt } = db.prepare(`
      SELECT COALESCE(
        (SELECT SUM(total) FROM remitos) - (SELECT SUM(amount) FROM payments), 0
      ) AS client_debt
    `).get();

    // Supplier debt (total owed to suppliers)
    const { supplier_debt } = db.prepare(`
      SELECT COALESCE(
        (SELECT SUM(total) FROM purchases) - (SELECT SUM(amount) FROM supplier_payments), 0
      ) AS supplier_debt
    `).get();

    // Cheques próximos 30 días
    const { cheques_cobrar } = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS cheques_cobrar FROM cheques
      WHERE direction='recibido' AND status='en_cartera'
        AND due_date BETWEEN date('now') AND date('now', '+30 days')
    `).get();
    const { cheques_pagar } = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS cheques_pagar FROM cheques
      WHERE direction='emitido' AND status='emitido'
        AND due_date BETWEEN date('now') AND date('now', '+30 days')
    `).get();

    res.json({
      cash_balance,
      bank_balance,
      total_balance: cash_balance + bank_balance,
      client_debt,
      supplier_debt,
      cheques_cobrar,
      cheques_pagar
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
