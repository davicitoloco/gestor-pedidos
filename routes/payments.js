const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');
const { acctBySubtype, acctByBankId, recordJournal } = require('../lib/accounting');
const { getSucursalFilter, getInsertSucursalId } = require('../lib/sucursal');
const PDFDocument = require('pdfkit');

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
      cheque_bank, cheque_number, cheque_due_date, cuit_librador, allocations
    } = req.body;
    if (!customer_id)                       return res.status(400).json({ error: 'Cliente requerido' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Monto inválido' });
    if (!VALID_METHODS.includes(method))    return res.status(400).json({ error: 'Método de pago inválido' });
    if (!payment_date)                      return res.status(400).json({ error: 'La fecha de cobro es requerida' });

    const result = withTransaction(() => {
      const amt  = parseFloat(amount);
      const cid  = Number(customer_id);
      const cust = db.prepare('SELECT name FROM customers WHERE id=?').get(cid);
      const desc = `Cobro cliente ${cust?.name || cid} - ${method}`;

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

      const sucursalId = getInsertSucursalId(req);
      const r = db.prepare(`
        INSERT INTO payments
          (customer_id, amount, method, reference, bank, bank_account_id, cheque_id, notes,
           payment_date, cuit_librador, fecha_vencimiento_cheque, created_by, sucursal_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cid, amt, method,
        reference || '',
        bank || '',
        bank_account_id ? Number(bank_account_id) : null,
        chequeId,
        notes || '',
        payment_date || null,
        (method === 'cheque' ? (cuit_librador || '') : ''),
        (method === 'cheque' ? (cheque_due_date || null) : null),
        req.session.userId,
        sucursalId
      );
      const paymentId = Number(r.lastInsertRowid);

      // Guardar asignaciones a remitos (si se proveen)
      if (Array.isArray(allocations) && allocations.length) {
        const insAlloc = db.prepare(
          'INSERT INTO payment_remito_allocations (payment_id, remito_id, amount) VALUES (?,?,?)'
        );
        for (const a of allocations) {
          const aAmt = parseFloat(a.amount);
          if (a.remito_id && aAmt > 0) insAlloc.run(paymentId, Number(a.remito_id), aAmt);
        }
      }

      // Auto cash/bank movements
      if (method === 'efectivo') {
        db.prepare(`INSERT INTO cash_movements (type,amount,description,ref_type,ref_id,created_by,sucursal_id) VALUES (?,?,?,?,?,?,?)`)
          .run('ingreso', amt, desc, 'payment', paymentId, req.session.userId, sucursalId);
      } else if (['transferencia', 'tarjeta'].includes(method) && bank_account_id) {
        db.prepare(`INSERT INTO bank_movements (bank_account_id,type,amount,description,ref_type,ref_id,created_by,sucursal_id) VALUES (?,?,?,?,?,?,?,?)`)
          .run(Number(bank_account_id), 'ingreso', amt, `${desc} (${method})`, 'payment', paymentId, req.session.userId, sucursalId);
      }
      // cheque → goes to cartera, bank movement happens on deposit

      // Asiento contable
      try {
        const today    = payment_date || new Date().toISOString().slice(0, 10);
        const deudores = acctBySubtype('Clientes')
            || db.prepare("SELECT id FROM accounts WHERE code='1.1.04' LIMIT 1").get();
        let debitAcct  = null;
        if (method === 'efectivo') {
          debitAcct = acctBySubtype('Caja')
              || db.prepare("SELECT id FROM accounts WHERE code='1.1.01' LIMIT 1").get();
        } else if (method === 'cheque') {
          debitAcct = acctBySubtype('Cheques')
              || db.prepare("SELECT id FROM accounts WHERE code='1.1.03' LIMIT 1").get();
        } else if (['transferencia', 'tarjeta'].includes(method)) {
          debitAcct = (bank_account_id ? acctByBankId(Number(bank_account_id)) : null)
              || db.prepare("SELECT id FROM accounts WHERE code='1115' AND accepts_movements=1 LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE code='1115' LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE code LIKE '1.1.02%' AND accepts_movements=1 LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE subtype='BancoGrupo' LIMIT 1").get();
        }
        if (debitAcct && deudores) {
          recordJournal({
            date: today, desc, ref_type: 'customer_payment', ref_id: paymentId,
            lines: [
              { account_id: debitAcct.id,  debit: amt, credit: 0   },
              { account_id: deudores.id,   debit: 0,   credit: amt },
            ],
            userId: req.session.userId,
          });
        } else {
          console.error('[Payment Journal] Cuentas no encontradas — debitAcct:', !!debitAcct, 'deudores:', !!deudores);
        }
      } catch (e) { console.error('Journal payment error:', e.message); }

      return paymentId;
    });

    res.status(201).json(db.prepare('SELECT * FROM payments WHERE id=?').get(result));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payments/:id/recibo — PDF recibo de cobro
router.get('/:id/recibo', (req, res) => {
  try {
    const id  = Number(req.params.id);
    const pmt = db.prepare(`
      SELECT p.*, c.name AS customer_name, c.cuit AS customer_cuit
      FROM payments p JOIN customers c ON p.customer_id = c.id
      WHERE p.id = ?
    `).get(id);
    if (!pmt) return res.status(404).json({ error: 'Pago no encontrado' });

    const allocs = db.prepare(`
      SELECT pra.amount, pra.remito_id,
             printf('R-%03d', r.remito_sequence) AS remito_number,
             printf('#%03d', o.order_sequence)   AS order_number
      FROM payment_remito_allocations pra
      JOIN remitos r ON pra.remito_id = r.id
      JOIN orders  o ON r.order_id   = o.id
      WHERE pra.payment_id = ?
      ORDER BY r.remito_sequence ASC
    `).all(id);

    const company   = db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value || 'Candex';
    const fmtMoney  = v => '$ ' + (v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtDate   = s => { if (!s) return '-'; const [y, m, d] = (s.split(' ')[0]).split('-'); return `${d}/${m}/${y}`; };
    const metodoCap = { efectivo:'Efectivo', transferencia:'Transferencia', tarjeta:'Tarjeta', cheque:'Cheque', otros:'Otros' }[pmt.method] || pmt.method;
    const recNum    = String(id).padStart(4, '0');

    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `REC-${recNum}` } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="REC-${recNum}.pdf"`);
    doc.pipe(res);

    const pageW = doc.page.width - 80;

    // ── Encabezado ─────────────────────────────────────────────────────────────
    doc.fontSize(14).font('Helvetica-Bold').text(company, 40, 40);
    doc.fontSize(18).font('Helvetica-Bold').text('RECIBO', 40, 40, { align: 'center', width: pageW });
    doc.fontSize(10).font('Helvetica')
      .text(`REC-${recNum}`, 40, 58, { align: 'right', width: pageW })
      .text(`Fecha: ${fmtDate(new Date().toISOString())}`, 40, 70, { align: 'right', width: pageW });
    doc.moveTo(40, 88).lineTo(555, 88).strokeColor('#888').lineWidth(0.5).stroke();

    // ── Datos del cliente ───────────────────────────────────────────────────────
    let y = 100;
    const row = (label, value) => {
      doc.fontSize(10).font('Helvetica-Bold').text(label, 40, y, { width: 130 });
      doc.fontSize(10).font('Helvetica').text(String(value), 170, y, { width: pageW - 130 });
      y += 16;
    };
    row('Cliente:', pmt.customer_name);
    if (pmt.customer_cuit) row('CUIT cliente:', pmt.customer_cuit);
    row('Fecha de cobro:', fmtDate(pmt.payment_date || pmt.created_at));
    row('Método de pago:', metodoCap);
    if (pmt.method === 'cheque' && pmt.cuit_librador)           row('CUIT librador:', pmt.cuit_librador);
    if (pmt.method === 'cheque' && pmt.fecha_vencimiento_cheque) row('Vencimiento cheque:', fmtDate(pmt.fecha_vencimiento_cheque));
    if (pmt.notes) row('Notas:', pmt.notes);

    y += 8;
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#ccc').lineWidth(0.5).stroke();
    y += 10;

    // ── Detalle ─────────────────────────────────────────────────────────────────
    doc.fontSize(10).font('Helvetica-Bold').text('Detalle', 40, y); y += 16;

    if (allocs.length) {
      // Cabecera tabla
      doc.fillColor('#e8e8e8').rect(40, y, pageW, 16).fill();
      doc.fillColor('#000');
      doc.fontSize(9).font('Helvetica-Bold')
        .text('Remito',  44, y + 3, { width: 80 })
        .text('Pedido',  130, y + 3, { width: 80 })
        .text('Monto aplicado', 370, y + 3, { width: 140, align: 'right' });
      y += 16;

      allocs.forEach((a, idx) => {
        if (idx % 2 === 1) { doc.fillColor('#f8f8f8').rect(40, y, pageW, 15).fill(); doc.fillColor('#000'); }
        doc.fontSize(9).font('Helvetica')
          .text(a.remito_number, 44, y + 2, { width: 80 })
          .text(a.order_number,  130, y + 2, { width: 80 })
          .text(fmtMoney(a.amount), 370, y + 2, { width: 140, align: 'right' });
        y += 15;
      });
      doc.moveTo(40, y).lineTo(555, y).strokeColor('#aaa').lineWidth(0.5).stroke();
      y += 8;
    } else {
      doc.fontSize(10).font('Helvetica').fillColor('#555').text('Pago a cuenta', 44, y);
      doc.fillColor('#000'); y += 18;
    }

    // ── Total ───────────────────────────────────────────────────────────────────
    y += 6;
    doc.fontSize(12).font('Helvetica-Bold')
      .text('TOTAL RECIBIDO:', 40, y, { width: pageW - 120, align: 'right' });
    doc.fontSize(12).font('Helvetica-Bold')
      .text(fmtMoney(pmt.amount), 40, y, { width: pageW, align: 'right' });
    y += 30;

    // ── Pie ─────────────────────────────────────────────────────────────────────
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#ccc').lineWidth(0.5).stroke(); y += 8;
    doc.fontSize(8).fillColor('#666').font('Helvetica')
      .text('Documento no válido como factura. Emitido por el sistema Candex.', 40, y, { align: 'center', width: pageW });

    doc.end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
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
