const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');
const { acctBySubtype, acctByBankId, recordJournal } = require('../lib/accounting');
const { getInsertSucursalId } = require('../lib/sucursal');
const PDFDocument = require('pdfkit');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (!['admin','subadmin'].includes(req.session.role)) return res.status(403).json({ error: 'Solo administradores' });
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
      cheque_bank, cheque_number, cheque_due_date, purchase_id
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

      const sucursalId = getInsertSucursalId(req);
      const r = db.prepare(`
        INSERT INTO supplier_payments (supplier_id, purchase_id, amount, method, reference, bank, bank_account_id, cheque_id, notes, payment_date, created_by, sucursal_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sid,
        purchase_id ? Number(purchase_id) : null,
        amt, method,
        reference || '',
        bank || '',
        bank_account_id ? Number(bank_account_id) : null,
        chequeId,
        notes || '',
        payment_date || null,
        req.session.userId,
        sucursalId
      );
      const paymentId = Number(r.lastInsertRowid);

      // Auto cash/bank movements
      if (method === 'efectivo') {
        db.prepare(`INSERT INTO cash_movements (type,amount,description,ref_type,ref_id,created_by,sucursal_id) VALUES (?,?,?,?,?,?,?)`)
          .run('egreso', amt, desc, 'supplier_payment', paymentId, req.session.userId, sucursalId);
      } else if (method === 'transferencia' && bank_account_id) {
        db.prepare(`INSERT INTO bank_movements (bank_account_id,type,amount,description,ref_type,ref_id,created_by,sucursal_id) VALUES (?,?,?,?,?,?,?,?)`)
          .run(Number(bank_account_id), 'egreso', amt, desc, 'supplier_payment', paymentId, req.session.userId, sucursalId);
      }
      // cheque emitido → bank movement happens when status → debitado

      // Journal entry
      try {
        const today = payment_date || new Date().toISOString().slice(0,10);

        // Descripción con datos del comprobante si viene asociado a una compra
        let jDesc = `Pago proveedor ${supplier?.name || sid}`;
        if (purchase_id) {
          const pur = db.prepare('SELECT doc_type, doc_number FROM purchases WHERE id=?').get(Number(purchase_id));
          if (pur) jDesc = `Pago proveedor ${supplier?.name || sid} - ${pur.doc_type}${pur.doc_number ? ' ' + pur.doc_number : ''}`;
        }

        const proveedores = acctBySubtype('Proveedores')
            || db.prepare("SELECT id FROM accounts WHERE code='2.1.01' LIMIT 1").get();

        let creditAcct = null;
        if (method === 'efectivo') {
          creditAcct = acctBySubtype('Caja')
              || db.prepare("SELECT id FROM accounts WHERE code='1.1.01' LIMIT 1").get();
        } else if (method === 'transferencia') {
          creditAcct = (bank_account_id ? acctByBankId(Number(bank_account_id)) : null)
              || db.prepare("SELECT id FROM accounts WHERE code='1115' AND accepts_movements=1 LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE code='1115' LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE code LIKE '1.1.02%' AND accepts_movements=1 LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE subtype='BancoGrupo' LIMIT 1").get();
        } else if (method === 'cheque') {
          // Cheque emitido propio: acreditar cuenta de cheques diferidos/documentos a pagar
          creditAcct = db.prepare("SELECT id FROM accounts WHERE code='21124' AND accepts_movements=1 LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE code='21124' LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE LOWER(name) LIKE '%cheque%difer%' AND accepts_movements=1 LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE code='1.1.03' AND accepts_movements=1 LIMIT 1").get()
              || acctBySubtype('Cheques');
        }

        if (proveedores && creditAcct) {
          recordJournal({ date: today, desc: jDesc, ref_type: 'supplier_payment', ref_id: paymentId,
            lines: [
              { account_id: proveedores.id, debit: amt,  credit: 0   },
              { account_id: creditAcct.id,  debit: 0,    credit: amt },
            ],
            userId: req.session.userId });
        } else {
          console.error('[SupPayment Journal] Cuentas no encontradas — proveedores:', !!proveedores, 'creditAcct:', !!creditAcct);
        }
      } catch(e) { console.error('Journal sup-payment error:', e.message); }

      return paymentId;
    });

    res.status(201).json(db.prepare('SELECT * FROM supplier_payments WHERE id=?').get(result));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/supplier-payments/batch — aplica un pago a múltiples comprobantes
router.post('/batch', (req, res) => {
  try {
    const {
      supplier_id, method, reference, bank, bank_account_id, notes, payment_date,
      cheque_bank, cheque_number, cheque_due_date, allocations
    } = req.body;
    if (!supplier_id)                       return res.status(400).json({ error: 'Proveedor requerido' });
    if (!VALID_METHODS.includes(method))    return res.status(400).json({ error: 'Método inválido' });
    if (!Array.isArray(allocations) || !allocations.length)
      return res.status(400).json({ error: 'Se requiere al menos una asignación' });

    const validAllocs = allocations.map(a => {
      const amt = parseFloat(a.amount);
      if (isNaN(amt) || amt <= 0) throw new Error('Monto inválido en asignación');
      return { purchase_id: a.purchase_id ? Number(a.purchase_id) : null, amount: amt };
    });
    const totalAmt = Math.round(validAllocs.reduce((s, a) => s + a.amount, 0) * 100) / 100;

    const result = withTransaction(() => {
      const sid      = Number(supplier_id);
      const supplier = db.prepare('SELECT name FROM suppliers WHERE id=?').get(sid);
      const sucId    = getInsertSucursalId(req);
      const today    = payment_date || new Date().toISOString().slice(0, 10);

      // Crear cheque único para el total (si aplica)
      let chequeId = null;
      if (method === 'cheque') {
        const cr = db.prepare(`
          INSERT INTO cheques (direction, bank, cheque_number, amount, due_date, status, holder_name, supplier_id, created_by)
          VALUES ('emitido', ?, ?, ?, ?, 'emitido', ?, ?, ?)
        `).run(
          cheque_bank || bank || '',
          cheque_number || reference || 'Sin nro',
          totalAmt,
          cheque_due_date || payment_date || null,
          supplier?.name || '', sid, req.session.userId
        );
        chequeId = Number(cr.lastInsertRowid);
      }

      // Crear un registro de pago por cada asignación
      const paymentIds = [];
      for (const alloc of validAllocs) {
        const r = db.prepare(`
          INSERT INTO supplier_payments
            (supplier_id, purchase_id, amount, method, reference, bank, bank_account_id, cheque_id, notes, payment_date, created_by, sucursal_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          sid, alloc.purchase_id, alloc.amount, method,
          reference || '', bank || '',
          bank_account_id ? Number(bank_account_id) : null,
          chequeId, notes || '', payment_date || null,
          req.session.userId, sucId
        );
        paymentIds.push(Number(r.lastInsertRowid));
      }
      const firstId = paymentIds[0];

      // Movimiento de caja/banco ÚNICO para el total
      const desc = `Pago proveedor ${supplier?.name || sid}`;
      if (method === 'efectivo') {
        db.prepare(`INSERT INTO cash_movements (type,amount,description,ref_type,ref_id,created_by,sucursal_id) VALUES (?,?,?,?,?,?,?)`)
          .run('egreso', totalAmt, desc, 'supplier_payment', firstId, req.session.userId, sucId);
      } else if (method === 'transferencia' && bank_account_id) {
        db.prepare(`INSERT INTO bank_movements (bank_account_id,type,amount,description,ref_type,ref_id,created_by,sucursal_id) VALUES (?,?,?,?,?,?,?,?)`)
          .run(Number(bank_account_id), 'egreso', totalAmt, desc, 'supplier_payment', firstId, req.session.userId, sucId);
      }

      // Asiento contable ÚNICO para el total
      try {
        const purInfos = validAllocs
          .filter(a => a.purchase_id)
          .map(a => {
            const p = db.prepare('SELECT doc_type, doc_number FROM purchases WHERE id=?').get(a.purchase_id);
            return p ? `${p.doc_type}${p.doc_number ? ' ' + p.doc_number : ''}` : '';
          })
          .filter(Boolean);
        let jDesc = `Pago proveedor ${supplier?.name || sid}`;
        if (purInfos.length) jDesc += ` - ${purInfos.join(', ')}`;

        const provAcct = acctBySubtype('Proveedores')
            || db.prepare("SELECT id FROM accounts WHERE code='2.1.01' LIMIT 1").get();
        let creditAcct = null;
        if (method === 'efectivo') {
          creditAcct = acctBySubtype('Caja')
              || db.prepare("SELECT id FROM accounts WHERE code='1.1.01' LIMIT 1").get();
        } else if (method === 'transferencia') {
          creditAcct = (bank_account_id ? acctByBankId(Number(bank_account_id)) : null)
              || db.prepare("SELECT id FROM accounts WHERE code='1115' AND accepts_movements=1 LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE code='1115' LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE code LIKE '1.1.02%' AND accepts_movements=1 LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE subtype='BancoGrupo' LIMIT 1").get();
        } else if (method === 'cheque') {
          creditAcct = db.prepare("SELECT id FROM accounts WHERE code='21124' AND accepts_movements=1 LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE code='21124' LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE LOWER(name) LIKE '%cheque%difer%' AND accepts_movements=1 LIMIT 1").get()
              || db.prepare("SELECT id FROM accounts WHERE code='1.1.03' AND accepts_movements=1 LIMIT 1").get()
              || acctBySubtype('Cheques');
        }
        if (provAcct && creditAcct) {
          recordJournal({
            date: today, desc: jDesc, ref_type: 'supplier_payment', ref_id: firstId,
            lines: [
              { account_id: provAcct.id,   debit: totalAmt, credit: 0        },
              { account_id: creditAcct.id, debit: 0,        credit: totalAmt },
            ],
            userId: req.session.userId,
          });
        } else {
          console.error('[SupBatch Journal] Cuentas no encontradas — prov:', !!provAcct, 'credit:', !!creditAcct);
        }
      } catch (e) { console.error('Journal batch-payment error:', e.message); }

      return paymentIds;
    });

    res.status(201).json({ ids: result, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/supplier-payments/:id/orden-pago — PDF de un pago individual
router.get('/:id/orden-pago', (req, res) => {
  try {
    const id  = Number(req.params.id);
    const pmt = db.prepare(`
      SELECT sp.*, s.name AS supplier_name
      FROM supplier_payments sp JOIN suppliers s ON sp.supplier_id = s.id
      WHERE sp.id = ?
    `).get(id);
    if (!pmt) return res.status(404).json({ error: 'Pago no encontrado' });

    // Comprobante asociado (si existe)
    const pur = pmt.purchase_id
      ? db.prepare(`SELECT pu.*, printf('C-%04d', pu.purchase_sequence) AS purchase_number,
                          COALESCE(SUM(sp2.amount), 0) AS total_paid
                   FROM purchases pu
                   LEFT JOIN supplier_payments sp2 ON sp2.purchase_id = pu.id
                   WHERE pu.id = ?
                   GROUP BY pu.id`).get(pmt.purchase_id)
      : null;

    const company  = db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value || 'Candex';
    const fmtMoney = v => '$ ' + (v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtDate  = s => { if (!s) return '-'; const [y, m, d] = (s.split(' ')[0]).split('-'); return `${d}/${m}/${y}`; };
    const opNum    = String(id).padStart(4, '0');
    const metodoCap = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque emitido', otros: 'Otros' }[pmt.method] || pmt.method;

    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `OP-${opNum}` } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="OP-${opNum}.pdf"`);
    doc.pipe(res);

    const pageW = doc.page.width - 80;

    // Encabezado
    doc.fontSize(14).font('Helvetica-Bold').text(company, 40, 40);
    doc.fontSize(16).font('Helvetica-Bold').text('ORDEN DE PAGO', 40, 40, { align: 'center', width: pageW });
    doc.fontSize(10).font('Helvetica')
      .text(`OP-${opNum}`, 40, 58, { align: 'right', width: pageW })
      .text(`Fecha: ${fmtDate(new Date().toISOString())}`, 40, 70, { align: 'right', width: pageW });
    doc.moveTo(40, 88).lineTo(555, 88).strokeColor('#888').lineWidth(0.5).stroke();

    let y = 100;
    const label = (l, v) => {
      doc.fontSize(10).font('Helvetica-Bold').text(l, 40, y, { width: 120, continued: false });
      doc.fontSize(10).font('Helvetica').text(String(v), 160, y, { width: pageW - 120 });
      y += 16;
    };

    label('Proveedor:', pmt.supplier_name);
    label('Método de pago:', metodoCap);
    label('Fecha del pago:', fmtDate(pmt.payment_date || pmt.created_at));
    label('Importe:', fmtMoney(pmt.amount));
    if (pmt.notes) label('Notas:', pmt.notes);
    if (pmt.reference) label('Referencia:', pmt.reference);

    if (pur) {
      y += 8;
      doc.moveTo(40, y).lineTo(555, y).strokeColor('#ccc').lineWidth(0.5).stroke();
      y += 10;
      doc.fontSize(10).font('Helvetica-Bold').text('Comprobante aplicado:', 40, y); y += 16;
      label('Número:', pur.purchase_number);
      label('Tipo:', `${pur.doc_type}${pur.doc_number ? '  ' + pur.doc_number : ''}`);
      label('Fecha comp.:', fmtDate(pur.doc_date));
      label('Total facturado:', fmtMoney(pur.total));
      label('Total pagado:', fmtMoney(pur.total_paid));
      label('Saldo restante:', fmtMoney(pur.total - pur.total_paid));
    }

    y += 24;
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#ccc').lineWidth(0.5).stroke();
    y += 8;
    doc.fontSize(8).fillColor('#666').font('Helvetica')
      .text('Documento interno. Emitido por el sistema Candex.', 40, y, { align: 'center', width: pageW });

    doc.end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
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
