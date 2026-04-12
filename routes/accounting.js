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

// POST /api/accounting/journal — manual entry
router.post('/journal', (req, res) => {
  try {
    const { date, description, reference, lines } = req.body;
    if (!description?.trim()) return res.status(400).json({ error: 'Descripción requerida' });
    if (!Array.isArray(lines) || lines.length < 2) return res.status(400).json({ error: 'Se requieren al menos 2 líneas' });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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

module.exports = router;
