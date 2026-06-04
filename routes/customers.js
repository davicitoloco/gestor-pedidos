const express = require('express');
const router = express.Router();
const { db, withTransaction } = require('../db');
const PDFDocument = require('pdfkit');

function fmtDatePdf(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-');
  return `${day}/${m}/${y}`;
}

function fmtArs(v) {
  const n = Math.abs(parseFloat(v) || 0);
  const parts = n.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return '$ ' + parts[0] + ',' + parts[1];
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
router.use(requireAuth);

function isVendor(req) { return req.session.role === 'vendedor'; }

function normalizeCuit(raw) { return String(raw || '').replace(/\D/g, ''); }
function isValidCuit(c)     { return /^\d{11}$/.test(c); }

// GET /api/customers
router.get('/', (req, res) => {
  try {
    const vc = isVendor(req) ? `AND c.vendor_id = ${req.session.userId}` : '';
    const rows = db.prepare(`
      SELECT c.*,
        COALESCE(uv.full_name, uv.username) AS vendor_name,
        COALESCE((SELECT SUM(r.total)  FROM remitos  r WHERE r.customer_id = c.id), 0)
        - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id = c.id), 0)
        + COALESCE((SELECT SUM(CASE WHEN n.note_type='debito' THEN n.amount ELSE -n.amount END) FROM credit_debit_notes n WHERE n.entity_type='customer' AND n.entity_id = c.id), 0) AS balance
      FROM customers c
      LEFT JOIN users uv ON c.vendor_id = uv.id
      WHERE 1=1 ${vc}
      ORDER BY c.name ASC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/customers/:id/account
router.get('/:id/account', (req, res) => {
  try {
    const cid      = Number(req.params.id);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cid);
    if (!customer) return res.status(404).json({ error: 'Cliente no encontrado' });

    const remitos = db.prepare(`
      SELECT r.*, printf('R-%03d', r.remito_sequence) AS remito_number,
             printf('%03d', o.order_sequence) AS order_number
      FROM remitos r
      JOIN orders o ON r.order_id = o.id
      WHERE r.customer_id = ?
      ORDER BY r.remito_sequence DESC
    `).all(cid);

    const payments = db.prepare(`
      SELECT p.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM payments p
      LEFT JOIN users u ON p.created_by = u.id
      WHERE p.customer_id = ?
      ORDER BY p.created_at DESC
    `).all(cid);

    const notes = db.prepare(`
      SELECT n.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM credit_debit_notes n LEFT JOIN users u ON n.created_by = u.id
      WHERE n.entity_type='customer' AND n.entity_id=?
      ORDER BY n.date DESC, n.id DESC
    `).all(cid);

    const total_debt = remitos.reduce((s, r) => s + r.total, 0);
    const total_paid = payments.reduce((s, p) => s + p.amount, 0);
    // Notes: debito increases what the customer owes, credito decreases it
    const notes_delta = notes.reduce((s, n) => s + (n.note_type === 'debito' ? n.amount : -n.amount), 0);
    const balance    = total_debt - total_paid + notes_delta;

    res.json({ customer, remitos, payments, notes, total_debt, total_paid, balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/customers/:id/pending-remitos — remitos con saldo > 0
router.get('/:id/pending-remitos', (req, res) => {
  try {
    const cid = Number(req.params.id);
    const rows = db.prepare(`
      SELECT r.id, r.remito_sequence, r.order_id, r.total, r.created_at,
             printf('R-%03d', r.remito_sequence)  AS remito_number,
             printf('#%03d', o.order_sequence)    AS order_number,
             COALESCE(SUM(pra.amount), 0)         AS total_paid,
             r.total - COALESCE(SUM(pra.amount), 0) AS balance
      FROM remitos r
      JOIN orders o ON r.order_id = o.id
      LEFT JOIN payment_remito_allocations pra ON pra.remito_id = r.id
      WHERE r.customer_id = ?
      GROUP BY r.id
      HAVING balance > 0.005
      ORDER BY r.created_at ASC
    `).all(cid);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customers
router.post('/', (req, res) => {
  try {
    const { name, phone, email, address, localidad, provincia, notes, iva_condition, cuit, vendor_id } = req.body;
    if (!name || !name.trim())       return res.status(400).json({ error: 'El nombre es requerido' });
    if (!phone || !phone.trim())     return res.status(400).json({ error: 'El teléfono es requerido' });
    if (!email || !email.trim())     return res.status(400).json({ error: 'El email es requerido' });
    if (!address || !address.trim()) return res.status(400).json({ error: 'La dirección es requerida' });
    if (!localidad || !localidad.trim()) return res.status(400).json({ error: 'La localidad es requerida' });
    if (!provincia || !provincia.trim()) return res.status(400).json({ error: 'La provincia es requerida' });
    if (req.session.role === 'admin' && !vendor_id)
      return res.status(400).json({ error: 'El vendedor es requerido' });
    const normalizedCuit = normalizeCuit(cuit);
    if (!normalizedCuit) return res.status(400).json({ error: 'El CUIT es requerido' });
    if (!isValidCuit(normalizedCuit)) return res.status(400).json({ error: 'El CUIT debe tener 11 dígitos (formato: XX-XXXXXXXX-X)' });
    const dup = db.prepare("SELECT id FROM customers WHERE cuit = ?").get(normalizedCuit);
    if (dup) return res.status(409).json({ error: 'El CUIT ingresado ya corresponde a otro cliente' });
    const result = db.prepare(`
      INSERT INTO customers (name, cuit, phone, email, address, localidad, provincia, notes, iva_condition, vendor_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), normalizedCuit, phone.trim(), email.trim(), address.trim(), localidad.trim(), provincia.trim(),
           notes||'', iva_condition||'Consumidor Final',
           vendor_id ? Number(vendor_id) : (isVendor(req) ? req.session.userId : null),
           req.session.userId);
    res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/customers/:id
router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!ex) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (isVendor(req) && ex.created_by !== req.session.userId)
      return res.status(403).json({ error: 'No podés editar clientes de otros vendedores' });
    const { name, phone, email, address, localidad, provincia, notes, iva_condition, cuit, vendor_id } = req.body;
    let finalCuit = ex.cuit || '';
    if (cuit !== undefined) {
      if (!cuit || cuit.trim() === '') {
        finalCuit = '';
      } else {
        finalCuit = normalizeCuit(cuit);
        if (!isValidCuit(finalCuit)) return res.status(400).json({ error: 'El CUIT debe tener 11 dígitos (formato: XX-XXXXXXXX-X)' });
        const dup = db.prepare("SELECT id FROM customers WHERE cuit = ? AND id != ?").get(finalCuit, id);
        if (dup) return res.status(409).json({ error: 'El CUIT ingresado ya corresponde a otro cliente' });
      }
    }
    const newVendorId = req.session.role === 'admin' && vendor_id !== undefined
      ? (vendor_id ? Number(vendor_id) : null)
      : ex.vendor_id;
    db.prepare(`UPDATE customers SET name=?, cuit=?, phone=?, email=?, address=?, localidad=?, provincia=?, notes=?, iva_condition=?, vendor_id=? WHERE id=?`).run(
      name          !== undefined ? name.trim()    : ex.name,
      finalCuit,
      phone         !== undefined ? phone          : ex.phone,
      email         !== undefined ? email          : ex.email,
      address       !== undefined ? address        : ex.address,
      localidad     !== undefined ? localidad      : (ex.localidad || ''),
      provincia     !== undefined ? provincia      : (ex.provincia || ''),
      notes         !== undefined ? notes          : ex.notes,
      iva_condition !== undefined ? iva_condition  : ex.iva_condition,
      newVendorId,
      id
    );
    res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/customers/:id
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!ex) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (isVendor(req) && ex.created_by !== req.session.userId)
      return res.status(403).json({ error: 'No podés eliminar clientes de otros vendedores' });
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customers/import
router.post('/import', (req, res) => {
  try {
    const { customers } = req.body;
    if (!Array.isArray(customers) || !customers.length)
      return res.status(400).json({ error: 'No hay clientes para importar' });

    let imported = 0;
    const errors = [];
    const ins = db.prepare(
      'INSERT INTO customers (name, phone, email, address, created_by) VALUES (?, ?, ?, ?, ?)'
    );

    withTransaction(() => {
      for (let i = 0; i < customers.length; i++) {
        const c = customers[i];
        const name = String(c.nombre || c.name || c.cliente || c.customer || '').trim();
        if (!name) { errors.push(`Fila ${i + 2}: nombre requerido`); continue; }
        const phone   = String(c.telefono || c.teléfono || c.phone || c.tel || c.celular || '').trim();
        const email   = String(c.email || c.correo || c.mail || '').trim();
        const address = String(c.direccion || c.dirección || c.address || c.domicilio || '').trim();
        ins.run(name, phone, email, address, req.session.userId);
        imported++;
      }
    });

    res.json({ imported, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/customers/:id/composicion-saldos — PDF composición de saldos
router.get('/:id/composicion-saldos', (req, res) => {
  try {
    const cid = Number(req.params.id);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cid);
    if (!customer) return res.status(404).json({ error: 'Cliente no encontrado' });

    const remitos = db.prepare(`
      SELECT r.created_at, r.total,
             printf('R-%03d', r.remito_sequence) AS remito_number,
             printf('%03d', o.order_sequence)    AS order_number
      FROM remitos r
      JOIN orders o ON r.order_id = o.id
      WHERE r.customer_id = ?
      ORDER BY r.created_at ASC, r.remito_sequence ASC
    `).all(cid);

    const payments = db.prepare(`
      SELECT amount, method, notes, reference,
             COALESCE(payment_date, DATE(created_at)) AS date
      FROM payments
      WHERE customer_id = ?
      ORDER BY COALESCE(payment_date, DATE(created_at)) ASC, id ASC
    `).all(cid);

    const notes = db.prepare(`
      SELECT note_type, date, description, amount
      FROM credit_debit_notes
      WHERE entity_type='customer' AND entity_id=?
      ORDER BY date ASC, id ASC
    `).all(cid);

    const movements = [];

    remitos.forEach(r => movements.push({
      date: String(r.created_at).slice(0, 10),
      comprobante: `Remito ${r.remito_number} (Pedido #${r.order_number})`,
      debe: r.total,
      haber: 0,
    }));

    payments.forEach(p => {
      const methodMap = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', tarjeta: 'Tarjeta' };
      const methodLabel = methodMap[p.method] || p.method;
      const detail = (p.notes || p.reference || '').trim();
      movements.push({
        date: String(p.date).slice(0, 10),
        comprobante: detail ? `Pago - ${methodLabel} - ${detail}` : `Pago - ${methodLabel}`,
        debe: 0,
        haber: p.amount,
      });
    });

    notes.forEach(n => movements.push({
      date: String(n.date).slice(0, 10),
      comprobante: `${n.note_type === 'debito' ? 'Nota de Débito' : 'Nota de Crédito'} - ${n.description}`,
      debe: n.note_type === 'debito' ? n.amount : 0,
      haber: n.note_type === 'credito' ? n.amount : 0,
    }));

    movements.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    let running = 0;
    movements.forEach(m => { running += m.debe - m.haber; m.saldo = running; });

    const totalDebe  = movements.reduce((s, m) => s + m.debe,  0);
    const totalHaber = movements.reduce((s, m) => s + m.haber, 0);
    const saldoFinal = totalDebe - totalHaber;

    const today    = new Date();
    const todayStr = fmtDatePdf(today.toISOString().slice(0, 10));
    const fileDate = today.toISOString().slice(0, 10).replace(/-/g, '');
    const safeName = customer.name.replace(/[^\w\s]/g, '').trim().replace(/\s+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="ComposicionSaldos_${safeName}_${fileDate}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    doc.pipe(res);

    const pageW   = doc.page.width;
    const mL      = 40;
    const mR      = 40;
    const cW      = pageW - mL - mR;   // 515

    // Column x positions and widths
    const COL = {
      fecha:       { x: mL,           w: 70  },
      comprobante: { x: mL + 70,      w: 210 },
      debe:        { x: mL + 280,     w: 75  },
      haber:       { x: mL + 355,     w: 75  },
      saldo:       { x: mL + 430,     w: 85  },
    };
    const ROW_H = 16;

    function drawTableHeader(y) {
      doc.rect(mL, y, cW, 18).fill('#1a4731');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff');
      doc.text('Fecha',       COL.fecha.x + 3,      y + 5, { width: COL.fecha.w,       lineBreak: false });
      doc.text('Comprobante', COL.comprobante.x + 3, y + 5, { width: COL.comprobante.w,  lineBreak: false });
      doc.text('Debe',        COL.debe.x,            y + 5, { width: COL.debe.w,  align: 'right', lineBreak: false });
      doc.text('Haber',       COL.haber.x,           y + 5, { width: COL.haber.w, align: 'right', lineBreak: false });
      doc.text('Saldo',       COL.saldo.x,           y + 5, { width: COL.saldo.w - 3, align: 'right', lineBreak: false });
      return y + 18;
    }

    // ── HEADER ────────────────────────────────────────────────────────────────
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#1a1a1a')
       .text('Candex', mL, 40, { width: cW / 3, lineBreak: false });

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a1a1a')
       .text('COMPOSICIÓN DE SALDOS', mL, 45, { width: cW, align: 'center', lineBreak: false });

    doc.moveTo(mL, 78).lineTo(pageW - mR, 78).strokeColor('#cccccc').lineWidth(0.5).stroke();

    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a1a')
       .text(customer.name, mL, 86, { lineBreak: false });

    const ivaLabel = customer.iva_condition || 'Consumidor Final';
    doc.fontSize(9).font('Helvetica').fillColor('#555555')
       .text(`${ivaLabel}  |  Fecha de emisión: ${todayStr}`, mL, 102, { lineBreak: false });

    doc.moveTo(mL, 118).lineTo(pageW - mR, 118).strokeColor('#cccccc').lineWidth(0.5).stroke();

    // ── TABLE ─────────────────────────────────────────────────────────────────
    let rowY = drawTableHeader(126);

    if (movements.length === 0) {
      doc.fontSize(9).font('Helvetica').fillColor('#888888')
         .text('Sin movimientos registrados', mL + 3, rowY + 5);
      rowY += ROW_H;
    }

    movements.forEach((m, i) => {
      if (i % 2 === 0) doc.rect(mL, rowY, cW, ROW_H).fill('#f5f9f7');

      const comp = m.comprobante.length > 45 ? m.comprobante.slice(0, 44) + '…' : m.comprobante;

      doc.fontSize(8).font('Helvetica').fillColor('#1a1a1a');
      doc.text(fmtDatePdf(m.date), COL.fecha.x + 3,      rowY + 4, { width: COL.fecha.w,      lineBreak: false });
      doc.text(comp,               COL.comprobante.x + 3, rowY + 4, { width: COL.comprobante.w, lineBreak: false });
      if (m.debe  > 0) doc.text(fmtArs(m.debe),  COL.debe.x,  rowY + 4, { width: COL.debe.w,  align: 'right', lineBreak: false });
      if (m.haber > 0) doc.text(fmtArs(m.haber), COL.haber.x, rowY + 4, { width: COL.haber.w, align: 'right', lineBreak: false });

      const saldoColor = m.saldo > 0.005 ? '#c0392b' : m.saldo < -0.005 ? '#27ae60' : '#1a1a1a';
      doc.fillColor(saldoColor)
         .text(fmtArs(Math.abs(m.saldo)), COL.saldo.x, rowY + 4, { width: COL.saldo.w - 3, align: 'right', lineBreak: false });

      doc.moveTo(mL, rowY + ROW_H).lineTo(pageW - mR, rowY + ROW_H)
         .strokeColor('#e0e0e0').lineWidth(0.3).stroke();

      rowY += ROW_H;

      if (rowY > doc.page.height - 110) {
        doc.addPage();
        rowY = drawTableHeader(40);
      }
    });

    // ── FOOTER ────────────────────────────────────────────────────────────────
    const footerY = rowY + 14;

    doc.moveTo(mL, footerY).lineTo(pageW - mR, footerY)
       .strokeColor('#1a4731').lineWidth(1).stroke();

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#1a1a1a')
       .text('Total Facturado:', mL, footerY + 10, { lineBreak: false });
    doc.font('Helvetica').text(fmtArs(totalDebe), mL + 105, footerY + 10, { lineBreak: false });

    doc.font('Helvetica-Bold').text('Total Pagado:', mL + 215, footerY + 10, { lineBreak: false });
    doc.font('Helvetica').text(fmtArs(totalHaber), mL + 305, footerY + 10, { lineBreak: false });

    doc.font('Helvetica-Bold').fillColor(saldoFinal > 0.005 ? '#c0392b' : '#1a1a1a')
       .text('Saldo Deudor:', mL + 390, footerY + 10, { lineBreak: false });
    doc.font('Helvetica').fillColor(saldoFinal > 0.005 ? '#c0392b' : '#1a1a1a')
       .text(fmtArs(saldoFinal), mL + 470, footerY + 10, { lineBreak: false });

    doc.fontSize(7).font('Helvetica').fillColor('#999999')
       .text(
         `Documento no válido como factura. Emitido el ${todayStr} por el sistema Candex.`,
         mL, footerY + 30, { width: cW, align: 'center', lineBreak: false }
       );

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
