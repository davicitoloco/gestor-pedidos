'use strict';
const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');
const { recordJournal } = require('../lib/accounting');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}
router.use(requireAuth, requireAdmin);

// GET /api/accounting/accounts
router.get('/accounts', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*,
        COALESCE(SUM(l.debit),0)  AS total_debit,
        COALESCE(SUM(l.credit),0) AS total_credit,
        CASE WHEN a.type IN ('Activo','Costo','Gasto')
          THEN COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0)
          ELSE COALESCE(SUM(l.credit),0) - COALESCE(SUM(l.debit),0)
        END AS balance
      FROM accounts a
      LEFT JOIN journal_entry_lines l ON l.account_id = a.id
      GROUP BY a.id
      ORDER BY a.code
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounting/accounts
router.post('/accounts', (req, res) => {
  try {
    const { code, name, type, subtype, accepts_movements, parent_code } = req.body;
    if (!code || !name || !type) return res.status(400).json({ error: 'Código, nombre y tipo son requeridos' });
    const r = db.prepare('INSERT INTO accounts (code,name,type,subtype,accepts_movements,parent_code) VALUES (?,?,?,?,?,?)')
      .run(code.trim(), name.trim(), type, subtype||'', accepts_movements ? 1 : 0, parent_code||null);
    res.status(201).json(db.prepare('SELECT * FROM accounts WHERE id=?').get(Number(r.lastInsertRowid)));
  } catch (err) { res.status(err.message.includes('UNIQUE') ? 409 : 500).json({ error: err.message }); }
});

// PUT /api/accounting/accounts/:id
router.put('/accounts/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    if (!ex) return res.status(404).json({ error: 'Cuenta no encontrada' });
    const { name, type, subtype, accepts_movements, parent_code } = req.body;
    db.prepare('UPDATE accounts SET name=?,type=?,subtype=?,accepts_movements=?,parent_code=? WHERE id=?').run(
      name !== undefined ? name.trim() : ex.name,
      type !== undefined ? type : ex.type,
      subtype !== undefined ? subtype : ex.subtype,
      accepts_movements !== undefined ? (accepts_movements ? 1 : 0) : ex.accepts_movements,
      parent_code !== undefined ? parent_code : ex.parent_code,
      id
    );
    res.json(db.prepare('SELECT * FROM accounts WHERE id=?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/accounting/journal
router.get('/journal', (req, res) => {
  try {
    const { date_from, date_to, ref_type, page = 1, per_page = 50 } = req.query;
    let where = '1=1';
    const params = [];
    if (date_from) { where += ' AND e.date >= ?'; params.push(date_from); }
    if (date_to)   { where += ' AND e.date <= ?'; params.push(date_to); }
    if (ref_type)  { where += ' AND e.ref_type = ?'; params.push(ref_type); }
    const total = db.prepare(`SELECT COUNT(*) AS c FROM journal_entries e WHERE ${where}`).get(...params).c;
    const offset = (Number(page) - 1) * Number(per_page);
    const entries = db.prepare(`
      SELECT e.*, COALESCE(u.full_name, u.username) AS created_by_name,
        (SELECT COALESCE(SUM(debit),0) FROM journal_entry_lines WHERE entry_id=e.id) AS total_debit
      FROM journal_entries e
      LEFT JOIN users u ON e.created_by = u.id
      WHERE ${where}
      ORDER BY e.date DESC, e.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(per_page), offset);
    res.json({ total, page: Number(page), per_page: Number(per_page), entries });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/accounting/journal/:id
router.get('/journal/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const entry = db.prepare(`
      SELECT e.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM journal_entries e LEFT JOIN users u ON e.created_by = u.id
      WHERE e.id=?
    `).get(id);
    if (!entry) return res.status(404).json({ error: 'Asiento no encontrado' });
    const lines = db.prepare(`
      SELECT l.*, a.code AS account_code, a.name AS account_name, a.type AS account_type
      FROM journal_entry_lines l JOIN accounts a ON l.account_id = a.id
      WHERE l.entry_id=? ORDER BY l.id
    `).all(id);
    res.json({ ...entry, lines });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function checkPeriodClosed(date) {
  const period = (date || new Date().toISOString().slice(0,10)).slice(0,7);
  const closed = db.prepare('SELECT id FROM accounting_closes WHERE period=?').get(period);
  if (closed) throw new Error(`El período ${period} está cerrado. No se pueden crear ni modificar asientos en períodos cerrados.`);
}

// POST /api/accounting/journal — manual entry
router.post('/journal', (req, res) => {
  try {
    const { date, description, reference, lines } = req.body;
    if (!description?.trim()) return res.status(400).json({ error: 'Descripción requerida' });
    if (!Array.isArray(lines) || lines.length < 2) return res.status(400).json({ error: 'Se requieren al menos 2 líneas' });
    checkPeriodClosed(date);
    const parsedLines = lines.map(l => ({
      account_id:  Number(l.account_id),
      debit:       parseFloat(l.debit)  || 0,
      credit:      parseFloat(l.credit) || 0,
      description: l.description || ''
    }));
    const id = withTransaction(() => recordJournal({
      date, desc: description.trim(), reference: reference || '', ref_type: 'manual', ref_id: null,
      lines: parsedLines, userId: req.session.userId
    }));
    const entry = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(id);
    const entryLines = db.prepare(`SELECT l.*,a.code AS account_code,a.name AS account_name FROM journal_entry_lines l JOIN accounts a ON l.account_id=a.id WHERE l.entry_id=?`).all(id);
    res.status(201).json({ ...entry, lines: entryLines });
  } catch (err) { res.status(err.message.includes('cerrado') ? 409 : 500).json({ error: err.message }); }
});

// POST /api/accounting/journal/:id/reverse
router.post('/journal/:id/reverse', (req, res) => {
  try {
    const id = Number(req.params.id);
    const entry = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(id);
    if (!entry) return res.status(404).json({ error: 'Asiento no encontrado' });
    if (entry.is_reversed) return res.status(400).json({ error: 'El asiento ya fue anulado' });
    const lines = db.prepare('SELECT * FROM journal_entry_lines WHERE entry_id=?').all(id);
    const today = new Date().toISOString().slice(0,10);
    checkPeriodClosed(today);
    const reversalId = withTransaction(() => {
      const rid = recordJournal({
        date: today, desc: `ANULACIÓN: ${entry.description}`,
        ref_type: 'reversal', ref_id: id,
        lines: lines.map(l => ({ account_id: l.account_id, debit: l.credit, credit: l.debit })),
        userId: req.session.userId
      });
      db.prepare('UPDATE journal_entries SET is_reversed=1, reversal_of=? WHERE id=?').run(rid, id);
      return rid;
    });
    res.status(201).json({ reversal_id: reversalId });
  } catch (err) { res.status(err.message.includes('cerrado') ? 409 : 500).json({ error: err.message }); }
});

// GET /api/accounting/trial-balance?date_from=&date_to=
router.get('/trial-balance', (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    // Opening: all transactions strictly BEFORE date_from
    // Period:  transactions in [date_from, date_to]
    const rows = db.prepare(`
      SELECT a.id, a.code, a.name, a.type, a.subtype, a.parent_code, a.accepts_movements,
        COALESCE(SUM(CASE WHEN ? IS NULL OR e.date < ? THEN
          CASE WHEN a.type IN ('Activo','Costo','Gasto') THEN l.debit - l.credit ELSE l.credit - l.debit END
          ELSE 0 END), 0) AS opening_balance,
        COALESCE(SUM(CASE WHEN (? IS NULL OR e.date >= ?) AND (? IS NULL OR e.date <= ?) THEN l.debit  ELSE 0 END), 0) AS period_debit,
        COALESCE(SUM(CASE WHEN (? IS NULL OR e.date >= ?) AND (? IS NULL OR e.date <= ?) THEN l.credit ELSE 0 END), 0) AS period_credit
      FROM accounts a
      LEFT JOIN journal_entry_lines l ON l.account_id = a.id
      LEFT JOIN journal_entries e ON e.id = l.entry_id
      GROUP BY a.id
      ORDER BY a.code
    `).all(date_from||null, date_from||null, date_from||null, date_from||null, date_to||null, date_to||null, date_from||null, date_from||null, date_to||null, date_to||null);

    const result = rows.map(r => ({
      ...r,
      closing_balance: r.opening_balance + (
        ['Activo','Costo','Gasto'].includes(r.type)
          ? r.period_debit - r.period_credit
          : r.period_credit - r.period_debit
      )
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/accounting/income-statement?date_from=&date_to=
router.get('/income-statement', (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    const rows = db.prepare(`
      SELECT a.id, a.code, a.name, a.type, a.parent_code,
        COALESCE(SUM(CASE WHEN (? IS NULL OR e.date >= ?) AND (? IS NULL OR e.date <= ?) THEN
          CASE WHEN a.type = 'Ingreso' THEN l.credit - l.debit ELSE l.debit - l.credit END
          ELSE 0 END), 0) AS amount
      FROM accounts a
      LEFT JOIN journal_entry_lines l ON l.account_id = a.id
      LEFT JOIN journal_entries e ON e.id = l.entry_id
      WHERE a.type IN ('Ingreso','Costo','Gasto')
      GROUP BY a.id
      ORDER BY a.code
    `).all(date_from||null, date_from||null, date_to||null, date_to||null);
    const ingresos = rows.filter(r => r.type === 'Ingreso').reduce((s,r) => s + r.amount, 0);
    const costos   = rows.filter(r => r.type === 'Costo').reduce((s,r) => s + r.amount, 0);
    const gastos   = rows.filter(r => r.type === 'Gasto').reduce((s,r) => s + r.amount, 0);
    res.json({ rows, ingresos, costos, gastos, resultado: ingresos - costos - gastos });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/accounting/ledger?account_id=&date_from=&date_to=
router.get('/ledger', (req, res) => {
  try {
    const { account_id, date_from, date_to } = req.query;
    if (!account_id) return res.status(400).json({ error: 'account_id requerido' });
    const acct = db.prepare('SELECT * FROM accounts WHERE id=?').get(Number(account_id));
    if (!acct) return res.status(404).json({ error: 'Cuenta no encontrada' });

    // Opening balance: everything strictly before date_from
    let openingBalance = 0;
    if (date_from) {
      const ob = db.prepare(`
        SELECT COALESCE(SUM(
          CASE WHEN a.type IN ('Activo','Costo','Gasto') THEN l.debit - l.credit ELSE l.credit - l.debit END
        ), 0) AS bal
        FROM journal_entry_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        JOIN accounts a ON a.id = l.account_id
        WHERE l.account_id=? AND e.date < ?
      `).get(Number(account_id), date_from);
      openingBalance = ob.bal;
    }

    let where = 'l.account_id=?';
    const params = [Number(account_id)];
    if (date_from) { where += ' AND e.date >= ?'; params.push(date_from); }
    if (date_to)   { where += ' AND e.date <= ?'; params.push(date_to); }

    const lines = db.prepare(`
      SELECT e.date, e.description, e.reference, e.ref_type, l.debit, l.credit, l.line_description
      FROM journal_entry_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      WHERE ${where}
      ORDER BY e.date ASC, e.id ASC, l.id ASC
    `).all(...params);

    // Build running balance
    let running = openingBalance;
    const isDebitNormal = ['Activo','Costo','Gasto'].includes(acct.type);
    const rows = lines.map(l => {
      const delta = isDebitNormal ? (l.debit - l.credit) : (l.credit - l.debit);
      running += delta;
      return { ...l, balance: running };
    });

    res.json({ account: acct, opening_balance: openingBalance, closing_balance: running, rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CIERRES CONTABLES ──────────────────────────────────────────────────────────

// GET /api/accounting/closes
router.get('/closes', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.*, COALESCE(u.full_name, u.username) AS closed_by_name
      FROM accounting_closes c LEFT JOIN users u ON c.closed_by = u.id
      ORDER BY c.period DESC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounting/closes
router.post('/closes', (req, res) => {
  try {
    const { period } = req.body;
    if (!period || !/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Período inválido. Formato: YYYY-MM' });
    const r = db.prepare('INSERT INTO accounting_closes (period, closed_by) VALUES (?,?)').run(period, req.session.userId);
    const row = db.prepare(`
      SELECT c.*, COALESCE(u.full_name, u.username) AS closed_by_name
      FROM accounting_closes c LEFT JOIN users u ON c.closed_by = u.id WHERE c.id=?
    `).get(Number(r.lastInsertRowid));
    res.status(201).json(row);
  } catch (err) { res.status(err.message.includes('UNIQUE') ? 409 : 500).json({ error: err.message.includes('UNIQUE') ? 'El período ya está cerrado' : err.message }); }
});

// DELETE /api/accounting/closes/:id
router.delete('/closes/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM accounting_closes WHERE id=?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CONCILIACIÓN BANCARIA ──────────────────────────────────────────────────────

// GET /api/accounting/reconciliation?bank_account_id=&year=&month=
router.get('/reconciliation', (req, res) => {
  try {
    const { bank_account_id, year, month } = req.query;
    if (!bank_account_id || !year || !month) return res.status(400).json({ error: 'bank_account_id, year y month son requeridos' });
    const ba = db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(Number(bank_account_id));
    if (!ba) return res.status(404).json({ error: 'Cuenta bancaria no encontrada' });

    let rec = db.prepare('SELECT * FROM bank_reconciliations WHERE bank_account_id=? AND year=? AND month=?')
      .get(Number(bank_account_id), Number(year), Number(month));
    if (!rec) {
      const r = db.prepare('INSERT INTO bank_reconciliations (bank_account_id,year,month,bank_balance,created_by) VALUES (?,?,?,0,?)')
        .run(Number(bank_account_id), Number(year), Number(month), req.session.userId);
      rec = db.prepare('SELECT * FROM bank_reconciliations WHERE id=?').get(Number(r.lastInsertRowid));
    }

    const paddedMonth = String(month).padStart(2,'0');
    const dateFrom = `${year}-${paddedMonth}-01`;
    const dateTo   = `${year}-${paddedMonth}-31`;

    const systemMovements = db.prepare(`
      SELECT m.*, 1 AS is_system,
        CASE WHEN rm.id IS NOT NULL THEN 1 ELSE 0 END AS is_reconciled
      FROM bank_movements m
      LEFT JOIN bank_reconciliation_marks rm ON rm.reconciliation_id=? AND rm.movement_id=m.id
      WHERE m.bank_account_id=? AND DATE(m.created_at) BETWEEN ? AND ?
      ORDER BY m.created_at ASC
    `).all(rec.id, Number(bank_account_id), dateFrom, dateTo);

    const bankLines = db.prepare('SELECT * FROM bank_reconciliation_lines WHERE reconciliation_id=? ORDER BY date ASC, id ASC')
      .all(rec.id);

    const systemBalance = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN type='ingreso' THEN amount ELSE -amount END), 0) + ? AS bal
      FROM bank_movements WHERE bank_account_id=? AND DATE(created_at) <= ?
    `).get(ba.initial_balance, Number(bank_account_id), dateTo).bal;

    res.json({ reconciliation: rec, bank_account: ba, system_movements: systemMovements, bank_lines: bankLines, system_balance: systemBalance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/accounting/reconciliation/:id
router.put('/reconciliation/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { bank_balance } = req.body;
    db.prepare('UPDATE bank_reconciliations SET bank_balance=? WHERE id=?').run(parseFloat(bank_balance)||0, id);
    res.json(db.prepare('SELECT * FROM bank_reconciliations WHERE id=?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounting/reconciliation/:id/mark
router.post('/reconciliation/:id/mark', (req, res) => {
  try {
    const recId = Number(req.params.id);
    const { movement_id, mark } = req.body;
    if (mark) {
      db.prepare('INSERT OR IGNORE INTO bank_reconciliation_marks (reconciliation_id,movement_id) VALUES (?,?)').run(recId, Number(movement_id));
    } else {
      db.prepare('DELETE FROM bank_reconciliation_marks WHERE reconciliation_id=? AND movement_id=?').run(recId, Number(movement_id));
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounting/reconciliation/:id/bank-line
router.post('/reconciliation/:id/bank-line', (req, res) => {
  try {
    const recId = Number(req.params.id);
    const { date, description, amount, is_reconciled } = req.body;
    if (!date || amount === undefined) return res.status(400).json({ error: 'Fecha y monto requeridos' });
    const r = db.prepare('INSERT INTO bank_reconciliation_lines (reconciliation_id,date,description,amount,is_reconciled) VALUES (?,?,?,?,?)')
      .run(recId, date, description||'', parseFloat(amount)||0, is_reconciled ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM bank_reconciliation_lines WHERE id=?').get(Number(r.lastInsertRowid)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/accounting/reconciliation/:id/bank-line/:lineId
router.put('/reconciliation/:id/bank-line/:lineId', (req, res) => {
  try {
    const lineId = Number(req.params.lineId);
    const { is_reconciled } = req.body;
    db.prepare('UPDATE bank_reconciliation_lines SET is_reconciled=? WHERE id=?').run(is_reconciled ? 1 : 0, lineId);
    res.json(db.prepare('SELECT * FROM bank_reconciliation_lines WHERE id=?').get(lineId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/accounting/reconciliation/:id/bank-line/:lineId
router.delete('/reconciliation/:id/bank-line/:lineId', (req, res) => {
  try {
    db.prepare('DELETE FROM bank_reconciliation_lines WHERE id=? AND reconciliation_id=?').run(Number(req.params.lineId), Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CALENDARIO DE PAGOS Y COBROS ───────────────────────────────────────────────

// GET /api/accounting/calendar?days=90&type=all
router.get('/calendar', (req, res) => {
  try {
    const days = Number(req.query.days) || 90;
    const type = req.query.type || 'all';
    const today = new Date().toISOString().slice(0,10);
    const end   = new Date(Date.now() + days * 86400000).toISOString().slice(0,10);

    const events = [];

    // Cheques a vencer
    if (type === 'all' || type === 'cobros') {
      const chCobrar = db.prepare(`
        SELECT 'cheque_cobrar' AS event_type, due_date AS date, amount,
          'Cheque a cobrar: ' || bank || ' #' || cheque_number AS description,
          COALESCE((SELECT name FROM customers WHERE id=cheques.customer_id),'') AS entity_name
        FROM cheques WHERE direction='recibido' AND status='en_cartera' AND due_date BETWEEN ? AND ?
      `).all(today, end);
      events.push(...chCobrar);
    }
    if (type === 'all' || type === 'pagos') {
      const chPagar = db.prepare(`
        SELECT 'cheque_pagar' AS event_type, due_date AS date, amount,
          'Cheque a pagar: ' || bank || ' #' || cheque_number AS description,
          COALESCE((SELECT name FROM suppliers WHERE id=cheques.supplier_id),'') AS entity_name
        FROM cheques WHERE direction='emitido' AND status='en_cartera' AND due_date BETWEEN ? AND ?
      `).all(today, end);
      events.push(...chPagar);
    }

    // Saldos de clientes vencidos (deuda > 0)
    if (type === 'all' || type === 'cobros') {
      const clientDebts = db.prepare(`
        SELECT * FROM (
          SELECT 'cliente_deuda' AS event_type, ? AS date,
            (COALESCE((SELECT SUM(total) FROM remitos WHERE customer_id=c.id),0) -
             COALESCE((SELECT SUM(amount) FROM payments WHERE customer_id=c.id),0) +
             COALESCE((SELECT SUM(CASE WHEN note_type='debito' THEN amount ELSE -amount END) FROM credit_debit_notes WHERE entity_type='customer' AND entity_id=c.id),0)
            ) AS amount,
            'Saldo deudor: ' || c.name AS description, c.name AS entity_name
          FROM customers c
        ) WHERE amount > 0.005
        ORDER BY amount DESC
        LIMIT 50
      `).all(today);
      events.push(...clientDebts);
    }

    // Saldos de proveedores pendientes
    if (type === 'all' || type === 'pagos') {
      const supDebts = db.prepare(`
        SELECT * FROM (
          SELECT 'proveedor_deuda' AS event_type, ? AS date,
            (COALESCE((SELECT SUM(total) FROM purchases WHERE supplier_id=s.id),0) -
             COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id=s.id),0) -
             COALESCE((SELECT SUM(CASE WHEN note_type='credito' THEN amount ELSE -amount END) FROM credit_debit_notes WHERE entity_type='supplier' AND entity_id=s.id),0)
            ) AS amount,
            'Deuda proveedor: ' || s.name AS description, s.name AS entity_name
          FROM suppliers s WHERE s.active=1
        ) WHERE amount > 0.005
        ORDER BY amount DESC
        LIMIT 50
      `).all(today);
      events.push(...supDebts);
    }

    events.sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    res.json({ events, today, end_date: end });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── NOTAS DE DÉBITO Y CRÉDITO ──────────────────────────────────────────────────

// GET /api/accounting/notes?entity_type=customer&entity_id=X
router.get('/notes', (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;
    if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type y entity_id requeridos' });
    const rows = db.prepare(`
      SELECT n.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM credit_debit_notes n LEFT JOIN users u ON n.created_by = u.id
      WHERE n.entity_type=? AND n.entity_id=?
      ORDER BY n.date DESC, n.id DESC
    `).all(entity_type, Number(entity_id));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounting/notes
router.post('/notes', (req, res) => {
  try {
    const { entity_type, entity_id, note_type, date, description, amount, reference } = req.body;
    if (!entity_type || !entity_id || !note_type || !description?.trim() || !amount)
      return res.status(400).json({ error: 'Campos requeridos: entity_type, entity_id, note_type, description, amount' });
    if (!['customer','supplier'].includes(entity_type)) return res.status(400).json({ error: 'entity_type debe ser customer o supplier' });
    if (!['debito','credito'].includes(note_type)) return res.status(400).json({ error: 'note_type debe ser debito o credito' });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Monto inválido' });

    const noteDate = date || new Date().toISOString().slice(0,10);
    checkPeriodClosed(noteDate);

    // Build journal entry lines based on entity type and note type
    const clientesAcct  = db.prepare("SELECT id FROM accounts WHERE subtype='Clientes' AND accepts_movements=1 LIMIT 1").get();
    const provAcct      = db.prepare("SELECT id FROM accounts WHERE subtype='Proveedores' AND accepts_movements=1 LIMIT 1").get();
    const ventasAcct    = db.prepare("SELECT id FROM accounts WHERE code='4.1.01' LIMIT 1").get();
    const comprasAcct   = db.prepare("SELECT id FROM accounts WHERE code='5.1.01' LIMIT 1").get();

    let journalLines = [];
    if (entity_type === 'customer') {
      const counterparty = ventasAcct?.id;
      const debtorAcct   = clientesAcct?.id;
      if (!counterparty || !debtorAcct) return res.status(400).json({ error: 'No se encontraron cuentas contables para clientes. Configure el plan de cuentas.' });
      if (note_type === 'debito') {
        // Debito: aumenta deuda del cliente → débito Clientes, crédito Ventas
        journalLines = [{ account_id: debtorAcct, debit: amt, credit: 0, description: description.trim() }, { account_id: counterparty, debit: 0, credit: amt, description: description.trim() }];
      } else {
        // Credito: disminuye deuda del cliente → crédito Clientes, débito Ventas
        journalLines = [{ account_id: counterparty, debit: amt, credit: 0, description: description.trim() }, { account_id: debtorAcct, debit: 0, credit: amt, description: description.trim() }];
      }
    } else {
      const counterparty  = comprasAcct?.id;
      const proveedorAcct = provAcct?.id;
      if (!counterparty || !proveedorAcct) return res.status(400).json({ error: 'No se encontraron cuentas contables para proveedores. Configure el plan de cuentas.' });
      if (note_type === 'debito') {
        // Debito proveedor: disminuye lo que le debemos (el proveedor nos carga) → débito Compras, crédito Proveedores
        journalLines = [{ account_id: counterparty, debit: amt, credit: 0, description: description.trim() }, { account_id: proveedorAcct, debit: 0, credit: amt, description: description.trim() }];
      } else {
        // Credito proveedor: el proveedor nos devuelve → débito Proveedores, crédito Compras
        journalLines = [{ account_id: proveedorAcct, debit: amt, credit: 0, description: description.trim() }, { account_id: counterparty, debit: 0, credit: amt, description: description.trim() }];
      }
    }

    const noteTypeLabel = note_type === 'debito' ? 'Nota de Débito' : 'Nota de Crédito';
    const entryId = withTransaction(() => recordJournal({
      date: noteDate,
      desc: `${noteTypeLabel}: ${description.trim()}`,
      reference: reference || '',
      ref_type: `note_${entity_type}`,
      ref_id: Number(entity_id),
      lines: journalLines,
      userId: req.session.userId
    }));

    const r = db.prepare('INSERT INTO credit_debit_notes (entity_type,entity_id,note_type,date,description,amount,reference,journal_entry_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(entity_type, Number(entity_id), note_type, noteDate, description.trim(), amt, reference||'', entryId, req.session.userId);
    const note = db.prepare(`
      SELECT n.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM credit_debit_notes n LEFT JOIN users u ON n.created_by=u.id WHERE n.id=?
    `).get(Number(r.lastInsertRowid));
    res.status(201).json(note);
  } catch (err) { res.status(err.message.includes('cerrado') ? 409 : 500).json({ error: err.message }); }
});

// DELETE /api/accounting/notes/:id
router.delete('/notes/:id', (req, res) => {
  try {
    const note = db.prepare('SELECT * FROM credit_debit_notes WHERE id=?').get(Number(req.params.id));
    if (!note) return res.status(404).json({ error: 'Nota no encontrada' });
    checkPeriodClosed(note.date);
    withTransaction(() => {
      if (note.journal_entry_id) {
        const entry = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(note.journal_entry_id);
        if (entry && !entry.is_reversed) {
          const lines = db.prepare('SELECT * FROM journal_entry_lines WHERE entry_id=?').all(note.journal_entry_id);
          const today = new Date().toISOString().slice(0,10);
          const rid = recordJournal({
            date: today, desc: `ANULACIÓN NOTA: ${note.description}`,
            ref_type: 'reversal', ref_id: note.journal_entry_id,
            lines: lines.map(l => ({ account_id: l.account_id, debit: l.credit, credit: l.debit })),
            userId: req.session.userId
          });
          db.prepare('UPDATE journal_entries SET is_reversed=1, reversal_of=? WHERE id=?').run(rid, note.journal_entry_id);
        }
      }
      db.prepare('DELETE FROM credit_debit_notes WHERE id=?').run(note.id);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.message.includes('cerrado') ? 409 : 500).json({ error: err.message }); }
});

module.exports = router;
