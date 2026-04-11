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

const DOC_TYPES = ['Factura A', 'Factura B', 'Factura C', 'Remito', 'Nota de Crédito', 'Otros'];

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
    res.json({ ...purchase, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/purchases
router.post('/', (req, res) => {
  try {
    const { supplier_id, doc_type, doc_number, doc_date, notes, items } = req.body;
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
        INSERT INTO purchases (purchase_sequence, supplier_id, doc_type, doc_number, doc_date, total, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nextSeq, Number(supplier_id), doc_type||'Factura B', doc_number||'', doc_date||null, total, notes||'', req.session.userId);

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
      <div class="info"><b>Condición IVA:</b> ${p.supplier_iva}</div>
      <table><thead><tr><th>Producto</th><th>Cantidad</th><th>Precio Unit.</th><th>Subtotal</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="total">Total: $${p.total.toFixed(2)}</div>
      ${p.notes ? `<div style="margin-top:12px"><b>Notas:</b> ${p.notes}</div>` : ''}
    </body></html>`;
    res.send(html);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
