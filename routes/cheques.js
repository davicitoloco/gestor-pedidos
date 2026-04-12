const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');
const { acctBySubtype, acctByBankId, recordJournal } = require('../lib/accounting');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}
router.use(requireAuth, requireAdmin);

// GET /api/cheques
router.get('/', (req, res) => {
  try {
    const { direction, status } = req.query;
    let where = '1=1';
    const params = [];
    if (direction) { where += ' AND c.direction = ?'; params.push(direction); }
    if (status)    { where += ' AND c.status = ?';    params.push(status); }

    const rows = db.prepare(`
      SELECT c.*,
             cust.name AS customer_name,
             sup.name  AS supplier_name,
             COALESCE(u.full_name, u.username) AS created_by_name
      FROM cheques c
      LEFT JOIN customers cust ON c.customer_id = cust.id
      LEFT JOIN suppliers sup  ON c.supplier_id  = sup.id
      LEFT JOIN users u        ON c.created_by    = u.id
      WHERE ${where}
      ORDER BY c.due_date ASC, c.id DESC
    `).all(...params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/cheques/upcoming — due in next 30 days
router.get('/upcoming', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.*,
             cust.name AS customer_name,
             sup.name  AS supplier_name
      FROM cheques c
      LEFT JOIN customers cust ON c.customer_id = cust.id
      LEFT JOIN suppliers sup  ON c.supplier_id  = sup.id
      WHERE c.due_date BETWEEN date('now') AND date('now', '+30 days')
        AND c.status NOT IN ('depositado','rechazado','debitado')
      ORDER BY c.due_date ASC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/cheques
router.post('/', (req, res) => {
  try {
    const { direction, bank, cheque_number, amount, due_date, holder_name, notes, customer_id, supplier_id } = req.body;
    if (!direction || !['recibido','emitido'].includes(direction))
      return res.status(400).json({ error: 'Dirección inválida (recibido/emitido)' });
    if (!bank || !bank.trim())          return res.status(400).json({ error: 'Banco requerido' });
    if (!cheque_number)                 return res.status(400).json({ error: 'Número de cheque requerido' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Monto inválido' });
    if (!due_date)                      return res.status(400).json({ error: 'Fecha de vencimiento requerida' });

    const status = direction === 'recibido' ? 'en_cartera' : 'emitido';
    const r = db.prepare(`
      INSERT INTO cheques (direction, bank, cheque_number, amount, due_date, status, holder_name, notes, customer_id, supplier_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(direction, bank.trim(), cheque_number, parseFloat(amount), due_date, status,
           holder_name||'', notes||'',
           customer_id ? Number(customer_id) : null,
           supplier_id ? Number(supplier_id) : null,
           req.session.userId);
    res.status(201).json(db.prepare('SELECT * FROM cheques WHERE id=?').get(Number(r.lastInsertRowid)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/cheques/:id/status
router.patch('/:id/status', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ch = db.prepare('SELECT * FROM cheques WHERE id=?').get(id);
    if (!ch) return res.status(404).json({ error: 'Cheque no encontrado' });
    const { status, bank_account_id } = req.body;
    const validStatuses = ch.direction === 'recibido'
      ? ['en_cartera', 'depositado', 'rechazado']
      : ['emitido', 'debitado'];
    if (!validStatuses.includes(status))
      return res.status(400).json({ error: `Estado inválido. Válidos: ${validStatuses.join(', ')}` });

    withTransaction(() => {
      if (ch.direction === 'recibido' && status === 'depositado') {
        if (!bank_account_id) throw new Error('Se requiere cuenta bancaria para depositar');
        const accId = Number(bank_account_id);
        db.prepare('UPDATE cheques SET status=?, deposited_to=? WHERE id=?').run(status, accId, id);
        db.prepare(`INSERT INTO bank_movements (bank_account_id,type,amount,description,ref_type,ref_id,created_by) VALUES (?,?,?,?,?,?,?)`)
          .run(accId, 'ingreso', ch.amount, `Depósito cheque ${ch.bank} Nro ${ch.cheque_number}`, 'cheque_deposit', id, req.session.userId);
        // Journal: Banco / Cheques en cartera
        try {
          const bancoAcct  = acctByBankId(accId);
          const chequesAcct = acctBySubtype('Cheques');
          if (bancoAcct && chequesAcct) {
            recordJournal({ date: new Date().toISOString().slice(0,10),
              desc: `Depósito cheque ${ch.bank} Nro ${ch.cheque_number}`,
              ref_type: 'cheque_deposit', ref_id: id,
              lines: [{ account_id: bancoAcct.id, debit: ch.amount, credit: 0 }, { account_id: chequesAcct.id, debit: 0, credit: ch.amount }],
              userId: req.session.userId });
          }
        } catch(e) { console.error('Journal cheque deposit error:', e.message); }
      } else if (ch.direction === 'emitido' && status === 'debitado') {
        if (!bank_account_id) throw new Error('Se requiere cuenta bancaria');
        const accId = Number(bank_account_id);
        db.prepare('UPDATE cheques SET status=?, deposited_to=? WHERE id=?').run(status, accId, id);
        db.prepare(`INSERT INTO bank_movements (bank_account_id,type,amount,description,ref_type,ref_id,created_by) VALUES (?,?,?,?,?,?,?)`)
          .run(accId, 'egreso', ch.amount, `Débito cheque ${ch.bank} Nro ${ch.cheque_number}`, 'cheque_debit', id, req.session.userId);
        // Journal: Otras deudas / Banco
        try {
          const otrasDeudasAcct = db.prepare("SELECT id FROM accounts WHERE code='2.1.02'").get();
          const bancoAcct = acctByBankId(accId);
          if (otrasDeudasAcct && bancoAcct) {
            recordJournal({ date: new Date().toISOString().slice(0,10),
              desc: `Débito cheque ${ch.bank} Nro ${ch.cheque_number}`,
              ref_type: 'cheque_debit', ref_id: id,
              lines: [{ account_id: otrasDeudasAcct.id, debit: ch.amount, credit: 0 }, { account_id: bancoAcct.id, debit: 0, credit: ch.amount }],
              userId: req.session.userId });
          }
        } catch(e) { console.error('Journal cheque debit error:', e.message); }
      } else {
        db.prepare('UPDATE cheques SET status=? WHERE id=?').run(status, id);
        // Journal recibido rechazado: Deudores / Cheques en cartera
        if (ch.direction === 'recibido' && status === 'rechazado') {
          try {
            const deudores = acctBySubtype('Clientes');
            const cheques  = acctBySubtype('Cheques');
            if (deudores && cheques) {
              recordJournal({ date: new Date().toISOString().slice(0,10),
                desc: `Cheque rechazado ${ch.bank} Nro ${ch.cheque_number}`,
                ref_type: 'cheque_rechazado', ref_id: id,
                lines: [{ account_id: deudores.id, debit: ch.amount, credit: 0 }, { account_id: cheques.id, debit: 0, credit: ch.amount }],
                userId: req.session.userId });
            }
          } catch(e) { console.error('Journal cheque rechazado error:', e.message); }
        }
      }
    });

    res.json(db.prepare('SELECT * FROM cheques WHERE id=?').get(id));
  } catch (err) { res.status(err.message.includes('requier') ? 400 : 500).json({ error: err.message }); }
});

// DELETE /api/cheques/:id
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM cheques WHERE id=?').get(id))
      return res.status(404).json({ error: 'Cheque no encontrado' });
    db.prepare('DELETE FROM cheques WHERE id=?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
