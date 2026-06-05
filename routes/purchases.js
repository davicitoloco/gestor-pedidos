const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');
const { acctBySubtype, recordJournal } = require('../lib/accounting');
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

const DOC_TYPES = [
  'Factura A', 'Factura B', 'Factura C',
  'Nota de Débito A', 'Nota de Débito B',
  'Nota de Crédito A', 'Nota de Crédito B',
  'Nota de Crédito', 'Remito', 'Otros',
];

// GET /api/purchases
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.*, printf('C-%04d', p.purchase_sequence) AS purchase_number,
             s.name AS supplier_name,
             COALESCE(u.full_name, u.username) AS created_by_name
      FROM purchases p
      JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN users u ON p.created_by = u.id
      ORDER BY p.purchase_sequence DESC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/purchases/:id
router.get('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const purchase = db.prepare(`
      SELECT p.*, printf('C-%04d', p.purchase_sequence) AS purchase_number,
             s.name AS supplier_name, s.cuit AS supplier_cuit,
             s.iva_condition AS supplier_iva, s.address AS supplier_address,
             COALESCE(u.full_name, u.username) AS created_by_name
      FROM purchases p
      JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN users u ON p.created_by = u.id
      WHERE p.id = ?
    `).get(id);
    if (!purchase) return res.status(404).json({ error: 'Comprobante no encontrado' });
    const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(id);
    const payments = db.prepare(`
      SELECT sp.*, COALESCE(ba.name,'') AS bank_account_name
      FROM supplier_payments sp
      LEFT JOIN bank_accounts ba ON sp.bank_account_id = ba.id
      WHERE sp.purchase_id = ?
      ORDER BY sp.created_at ASC
    `).all(id);
    const total_paid = payments.reduce((s, p) => s + p.amount, 0);
    const balance    = purchase.total - total_paid;
    res.json({ ...purchase, items, payments, total_paid, balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/purchases
router.post('/', (req, res) => {
  try {
    const { supplier_id, doc_type, doc_number, doc_date, notes, iva_condition, items } = req.body;
    if (!supplier_id)                        return res.status(400).json({ error: 'Proveedor requerido' });
    if (!db.prepare('SELECT id FROM suppliers WHERE id = ?').get(Number(supplier_id)))
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'Se necesita al menos un ítem' });

    const parsedItems = items.map((it, i) => {
      const qty   = parseFloat(it.quantity);
      const price = parseFloat(it.unit_price);
      if (!it.product_name || !it.product_name.trim()) throw new Error(`Ítem ${i+1}: nombre requerido`);
      if (isNaN(qty)   || qty   <= 0) throw new Error(`Ítem ${i+1}: cantidad inválida`);
      if (isNaN(price) || price < 0)  throw new Error(`Ítem ${i+1}: precio inválido`);
      return { product_name: it.product_name.trim(), product_id: it.product_id || null, quantity: qty, unit_price: price };
    });

    const total = parsedItems.reduce((s, it) => s + it.quantity * it.unit_price, 0);

    const result = withTransaction(() => {
      const { nextSeq } = db.prepare('SELECT COALESCE(MAX(purchase_sequence),0)+1 AS nextSeq FROM purchases').get();
      const r = db.prepare(`
        INSERT INTO purchases (purchase_sequence, supplier_id, doc_type, doc_number, doc_date, total, notes, iva_condition, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nextSeq, Number(supplier_id), doc_type||'Factura B', doc_number||'', doc_date||null, total, notes||'', iva_condition||'', req.session.userId);

      const purchaseId = Number(r.lastInsertRowid);
      const insItem = db.prepare('INSERT INTO purchase_items (purchase_id, product_id, product_name, quantity, unit_price) VALUES (?,?,?,?,?)');
      const insStock = db.prepare("INSERT INTO stock_movements (product_id, type, quantity, reference, notes, created_by) VALUES (?,?,?,?,?,?)");
      const updStock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');

      for (const it of parsedItems) {
        insItem.run(purchaseId, it.product_id, it.product_name, it.quantity, it.unit_price);
        // increment stock if product linked
        if (it.product_id) {
          updStock.run(it.quantity, it.product_id);
          insStock.run(it.product_id, 'entrada', it.quantity, `Compra C-${String(nextSeq).padStart(4,'0')}`, notes||'', req.session.userId);
        } else {
          // try to match by name
          const prod = db.prepare("SELECT id FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))").get(it.product_name);
          if (prod) {
            updStock.run(it.quantity, prod.id);
            insStock.run(prod.id, 'entrada', it.quantity, `Compra C-${String(nextSeq).padStart(4,'0')}`, notes||'', req.session.userId);
            db.prepare('UPDATE purchase_items SET product_id = ? WHERE purchase_id = ? AND product_name = ?').run(prod.id, purchaseId, it.product_name);
          }
        }
      }
      // Journal entry: Mercaderías / Proveedores
      try {
        const mercs = acctBySubtype('Stock');
        const provs = acctBySubtype('Proveedores');
        if (mercs && provs && total > 0) {
          recordJournal({ date: doc_date || new Date().toISOString().slice(0,10),
            desc: `Compra C-${String(nextSeq).padStart(4,'0')}`,
            ref_type: 'purchase', ref_id: purchaseId,
            lines: [{ account_id: mercs.id, debit: total, credit: 0 }, { account_id: provs.id, debit: 0, credit: total }],
            userId: req.session.userId });
        }
      } catch(e) { console.error('Journal purchase error:', e.message); }

      return purchaseId;
    });

    res.status(201).json({ id: result, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/purchases/:id
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
    if (!purchase) return res.status(404).json({ error: 'Comprobante no encontrado' });

    withTransaction(() => {
      const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?').all(id);
      const updStock = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?');
      for (const it of items) {
        if (it.product_id) updStock.run(it.quantity, it.product_id);
      }
      db.prepare('DELETE FROM purchases WHERE id = ?').run(id);
    });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/purchases/:id/print — HTML receipt
router.get('/:id/print', (req, res) => {
  try {
    const id = Number(req.params.id);
    const p = db.prepare(`
      SELECT pu.*, printf('C-%04d', pu.purchase_sequence) AS purchase_number,
             s.name AS supplier_name, s.cuit AS supplier_cuit,
             s.iva_condition AS supplier_iva, s.address AS supplier_address
      FROM purchases pu JOIN suppliers s ON pu.supplier_id = s.id WHERE pu.id = ?
    `).get(id);
    if (!p) return res.status(404).json({ error: 'Comprobante no encontrado' });
    const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(id);
    const company = db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value || 'Mi Empresa';

    const rows = items.map(it => `
      <tr>
        <td>${it.product_name}</td>
        <td style="text-align:right">${it.quantity}</td>
        <td style="text-align:right">$${it.unit_price.toFixed(2)}</td>
        <td style="text-align:right">$${(it.quantity * it.unit_price).toFixed(2)}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>${p.purchase_number}</title>
      <style>
        body{font-family:Arial,sans-serif;margin:20px;font-size:13px}
        h2{margin:0}table{width:100%;border-collapse:collapse;margin-top:16px}
        th,td{border:1px solid #ccc;padding:6px 8px}th{background:#f0f0f0}
        .total{text-align:right;font-weight:bold;font-size:15px;margin-top:8px}
        .header{display:flex;justify-content:space-between;margin-bottom:16px}
        .info{margin-bottom:4px}
        @media print{button{display:none}}
      </style>
    </head><body>
      <button onclick="window.print()" style="margin-bottom:12px">Imprimir</button>
      <div class="header">
        <div><h2>${company}</h2><div class="info">Comprobante de Compra</div></div>
        <div style="text-align:right">
          <h2>${p.purchase_number}</h2>
          <div class="info">${p.doc_type} ${p.doc_number ? '– ' + p.doc_number : ''}</div>
          <div class="info">Fecha: ${p.doc_date || p.created_at?.slice(0,10) || ''}</div>
        </div>
      </div>
      <div class="info"><b>Proveedor:</b> ${p.supplier_name}</div>
      ${p.supplier_cuit ? `<div class="info"><b>CUIT:</b> ${p.supplier_cuit}</div>` : ''}
      <div class="info"><b>Condición IVA:</b> ${p.iva_condition || p.supplier_iva || '—'}</div>
      <table><thead><tr><th>Producto</th><th>Cantidad</th><th>Precio Unit.</th><th>Subtotal</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="total">Total: $${p.total.toFixed(2)}</div>
      ${p.notes ? `<div style="margin-top:12px"><b>Notas:</b> ${p.notes}</div>` : ''}
    </body></html>`;
    res.send(html);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/purchases/:id/orden-pago  — PDF orden de pago
router.get('/:id/orden-pago', (req, res) => {
  try {
    const id = Number(req.params.id);
    const p = db.prepare(`
      SELECT pu.*, printf('C-%04d', pu.purchase_sequence) AS purchase_number,
             s.name AS supplier_name
      FROM purchases pu JOIN suppliers s ON pu.supplier_id = s.id WHERE pu.id = ?
    `).get(id);
    if (!p) return res.status(404).json({ error: 'Comprobante no encontrado' });

    const payments = db.prepare(`
      SELECT sp.*, COALESCE(ba.name,'') AS bank_account_name
      FROM supplier_payments sp
      LEFT JOIN bank_accounts ba ON sp.bank_account_id = ba.id
      WHERE sp.purchase_id = ? ORDER BY sp.created_at ASC
    `).all(id);
    if (!payments.length) return res.status(400).json({ error: 'Sin pagos registrados' });

    const total_paid = payments.reduce((s, pmt) => s + pmt.amount, 0);
    const balance    = p.total - total_paid;
    const company    = db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value || 'Candex';

    const fmtMoney = v => '$ ' + (v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtDate  = s => { if (!s) return '-'; const [y,m,d] = (s.split(' ')[0]).split('-'); return `${d}/${m}/${y}`; };
    const opNum    = String(id).padStart(4, '0');

    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `OP-${opNum}` } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="OP-${opNum}.pdf"`);
    doc.pipe(res);

    // ── Encabezado ───────────────────────────────────────────────────────────
    const pageW = doc.page.width - 80; // usable width (margins 40 each side)
    doc.fontSize(14).font('Helvetica-Bold').text(company, 40, 40, { continued: false });
    doc.fontSize(16).font('Helvetica-Bold').text('ORDEN DE PAGO', 40, 40, { align: 'center', width: pageW });
    doc.fontSize(10).font('Helvetica')
      .text(`OP-${opNum}`, 40, 58, { align: 'right', width: pageW })
      .text(`Fecha: ${fmtDate(new Date().toISOString())}`, 40, 70, { align: 'right', width: pageW });

    doc.moveTo(40, 88).lineTo(555, 88).strokeColor('#888').lineWidth(0.5).stroke();

    // ── Datos del comprobante ─────────────────────────────────────────────────
    let y = 100;
    const labelW = 110;
    const row = (label, value) => {
      doc.fontSize(10).font('Helvetica-Bold').text(label, 40, y, { width: labelW, continued: false });
      doc.fontSize(10).font('Helvetica').text(String(value), 40 + labelW, y, { width: pageW - labelW });
      y += 16;
    };
    row('Proveedor:',    p.supplier_name);
    row('Comprobante:',  `${p.doc_type}${p.doc_number ? '  ' + p.doc_number : ''}`);
    row('Fecha comp.:',  fmtDate(p.doc_date));
    row('Total fact.:',  fmtMoney(p.total));

    y += 10;
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#888').lineWidth(0.5).stroke();
    y += 10;

    // ── Tabla de pagos ───────────────────────────────────────────────────────
    doc.fontSize(10).font('Helvetica-Bold').text('Pagos aplicados', 40, y);
    y += 16;

    const colX  = [40, 115, 185, 340, 460];
    const colW  = [75,  70, 155, 120, 95];
    const heads = ['Fecha', 'Método', 'Notas', 'Referencia', 'Monto'];

    // Header row
    doc.fillColor('#e8e8e8').rect(40, y, pageW, 16).fill();
    doc.fillColor('#000');
    heads.forEach((h, i) => {
      const align = i === 4 ? 'right' : 'left';
      doc.fontSize(9).font('Helvetica-Bold').text(h, colX[i], y + 3, { width: colW[i], align });
    });
    y += 16;

    payments.forEach((pmt, idx) => {
      if (idx % 2 === 1) { doc.fillColor('#f8f8f8').rect(40, y, pageW, 15).fill(); doc.fillColor('#000'); }
      const metodoCap = pmt.method.charAt(0).toUpperCase() + pmt.method.slice(1);
      const rowData   = [
        fmtDate(pmt.payment_date || pmt.created_at),
        metodoCap,
        pmt.notes || '-',
        pmt.reference || (pmt.bank_account_name || '-'),
        fmtMoney(pmt.amount),
      ];
      rowData.forEach((v, i) => {
        const align = i === 4 ? 'right' : 'left';
        doc.fontSize(9).font('Helvetica').text(v, colX[i], y + 2, { width: colW[i], align });
      });
      y += 15;
    });

    // Línea de cierre de tabla
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#aaa').lineWidth(0.5).stroke();
    y += 14;

    // ── Totales ───────────────────────────────────────────────────────────────
    const totalX = 370;
    const amtX   = 460;
    const totW   = 95;
    const totRow = (label, value, bold) => {
      doc.fontSize(10).font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .text(label, totalX, y, { width: 90, align: 'right' });
      doc.fontSize(10).font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .text(value, amtX, y, { width: totW, align: 'right' });
      y += 15;
    };
    totRow('Total pagado:', fmtMoney(total_paid), false);
    totRow('Saldo pendiente:', fmtMoney(balance), true);

    // ── Pie ───────────────────────────────────────────────────────────────────
    y += 20;
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#ccc').lineWidth(0.5).stroke();
    y += 8;
    doc.fontSize(8).fillColor('#666').font('Helvetica')
      .text('Documento interno. Emitido por el sistema Candex.', 40, y, { align: 'center', width: pageW });

    doc.end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

module.exports = router;
