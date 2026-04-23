const express = require('express');
const router = express.Router();
const { db, withTransaction } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
router.use(requireAuth);

function isVendor(req) { return req.session.role === 'vendedor'; }

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtMoney(v) {
  return '$ ' + (v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(s) {
  if (!s) return '-';
  const d = s.split(' ')[0].split('-');
  return `${d[2]}/${d[1]}/${d[0]}`;
}
function fmtDateTime(s) {
  if (!s) return '-';
  const [date, time] = s.split(' ');
  const d = date.split('-');
  return `${d[2]}/${d[1]}/${d[0]}${time ? ' ' + time.substring(0, 5) : ''}`;
}
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function getCompanyName() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get();
  return row ? row.value : 'Mi Empresa';
}

// ── GET /api/orders ───────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { status, search } = req.query;
    const vendorFilter = isVendor(req) ? `AND o.created_by = ${req.session.userId}` : '';
    const statusFilter = (status && status !== 'Todos') ? `AND o.status = ?` : '';
    const searchFilter = search ? `AND (LOWER(o.customer_name) LIKE ? OR printf('%03d', o.order_sequence) LIKE ?)` : '';
    const params = [];
    if (status && status !== 'Todos') params.push(status);
    if (search) { const q = `%${search.toLowerCase()}%`; params.push(q, q); }

    const sql = `
      SELECT
        o.id,
        printf('%03d', o.order_sequence) AS order_number,
        o.customer_name, o.notes, o.delivery_date, o.status,
        o.discount, o.discount2, o.discount3, o.discount4,
        o.created_at, o.updated_at,
        COALESCE(u.full_name, u.username)        AS vendor_name,
        COUNT(oi.id)                              AS item_count,
        COALESCE(SUM(oi.quantity * oi.unit_price * (1.0 - oi.discount/100.0)), 0) AS subtotal,
        COALESCE(SUM(oi.quantity * oi.unit_price * (1.0 - oi.discount/100.0)), 0)
          * (1.0 - o.discount/100.0)
          * (1.0 - COALESCE(o.discount2,0)/100.0)
          * (1.0 - COALESCE(o.discount3,0)/100.0)
          * (1.0 - COALESCE(o.discount4,0)/100.0) AS total
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN users u ON o.created_by = u.id
      WHERE 1=1 ${vendorFilter} ${statusFilter} ${searchFilter}
      GROUP BY o.id
      ORDER BY o.order_sequence DESC
    `;
    res.json(db.prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/orders/:id ───────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare(`
      SELECT o.*, printf('%03d', o.order_sequence) AS order_number,
             COALESCE(u.full_name, u.username) AS vendor_name
      FROM orders o LEFT JOIN users u ON o.created_by = u.id
      WHERE o.id = ?
    `).get(id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (isVendor(req) && order.created_by !== req.session.userId)
      return res.status(403).json({ error: 'Acceso denegado' });
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
    res.json({ ...order, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/orders/:id/print ─────────────────────────────────────────────────
router.get('/:id/print', (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare(`
      SELECT o.*, printf('%03d', o.order_sequence) AS order_number,
             COALESCE(u.full_name, u.username) AS vendor_name
      FROM orders o LEFT JOIN users u ON o.created_by = u.id
      WHERE o.id = ?
    `).get(id);
    if (!order) return res.status(404).send('Pedido no encontrado');
    if (isVendor(req) && order.created_by !== req.session.userId)
      return res.status(403).send('Acceso denegado');

    const items    = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
    const company  = getCompanyName();
    const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price * (1 - i.discount / 100), 0);
    const d1 = order.discount  || 0;
    const d2 = order.discount2 || 0;
    const d3 = order.discount3 || 0;
    const d4 = order.discount4 || 0;
    const base1 = subtotal;
    const amt1  = base1 * d1 / 100;
    const base2 = base1 - amt1;
    const amt2  = base2 * d2 / 100;
    const base3 = base2 - amt2;
    const amt3  = base3 * d3 / 100;
    const base4 = base3 - amt3;
    const amt4  = base4 * d4 / 100;
    const totalDisc  = amt1 + amt2 + amt3 + amt4;
    const netTotal   = subtotal - totalDisc;
    const ivaExempt  = !!order.iva_exempt;
    const iva        = ivaExempt ? 0 : netTotal * 0.21;
    const finalTotal = netTotal + iva;

    // Historial de entregas
    const deliveries = db.prepare(`
      SELECT d.id, d.notes, d.created_at,
             COALESCE(u.full_name, u.username) AS delivered_by
      FROM deliveries d
      LEFT JOIN users u ON d.created_by = u.id
      WHERE d.order_id = ? ORDER BY d.created_at ASC
    `).all(id);
    for (const d of deliveries) {
      d.items = db.prepare(`
        SELECT oi.product_name, di.quantity_delivered, oi.quantity AS quantity_ordered
        FROM delivery_items di
        JOIN order_items oi ON di.order_item_id = oi.id
        WHERE di.delivery_id = ?
      `).all(d.id);
    }
    // Totales entregados por ítem
    const deliveredMap = {};
    for (const d of deliveries)
      for (const di of d.items)
        deliveredMap[di.product_name] = (deliveredMap[di.product_name] || 0) + di.quantity_delivered;

    const statusColor = { 'Pendiente':'#92400e','En preparación':'#1e40af','Entregado':'#166534','Cancelado':'#475569' };
    const statusBg    = { 'Pendiente':'#fef3c7','En preparación':'#dbeafe','Entregado':'#dcfce7','Cancelado':'#f1f5f9' };

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Pedido #${esc(order.order_number)} — ${esc(company)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1e293b;background:#fff}
.page{padding:32px 40px;max-width:820px;margin:0 auto}
.no-print{text-align:right;margin-bottom:18px}
.print-btn{padding:9px 22px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600}
.header{text-align:center;padding-bottom:18px;border-bottom:2px solid #2563eb;margin-bottom:22px}
.header h1{font-size:26px;color:#2563eb;letter-spacing:.01em}
.header h2{font-size:13px;color:#64748b;margin-top:4px;font-weight:normal;text-transform:uppercase;letter-spacing:.08em}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 30px;margin-bottom:26px}
.info-item label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:3px}
.info-item p{font-size:13px;font-weight:500}
.badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:10px}
table{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:12.5px}
thead th{background:#2563eb;color:#fff;padding:8px 10px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
thead th.r{text-align:right}
tbody td{padding:8px 10px;border-bottom:1px solid #e2e8f0}
tbody td.r{text-align:right}
tbody tr:nth-child(even) td{background:#f8fafc}
.totals-wrap{display:flex;justify-content:flex-end}
.totals{width:300px;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden}
.totals tr td{padding:8px 14px;border-bottom:1px solid #e2e8f0;font-size:13px}
.totals tr:last-child td{border-bottom:none}
.totals .t-final td{font-weight:700;font-size:15px;color:#2563eb;background:#eff6ff;border-top:2px solid #2563eb}
.t-label{color:#64748b}
.t-val{text-align:right;font-weight:600}
.notes-box{margin-top:20px;padding:14px 16px;background:#f8fafc;border-left:3px solid #2563eb;border-radius:0 6px 6px 0}
.notes-box strong{display:block;margin-bottom:5px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b}
.delivery-section{margin-top:28px}
.delivery-entry{border:1px solid #e2e8f0;border-radius:6px;margin-bottom:12px;overflow:hidden}
.delivery-entry-hdr{background:#f8fafc;padding:8px 12px;display:flex;gap:16px;align-items:center;font-size:11px;border-bottom:1px solid #e2e8f0}
.delivery-entry-hdr strong{font-size:12px;color:#1e293b}
.delivery-entry-hdr span{color:#64748b}
.delivery-entry-hdr .d-type{margin-left:auto;font-weight:700;padding:2px 8px;border-radius:10px;font-size:10px}
.d-total{background:#dcfce7;color:#166534}
.d-partial{background:#fef3c7;color:#92400e}
.delivery-entry table{margin:0}
.delivery-entry td,.delivery-entry th{font-size:11.5px}
.delivery-notes-pdf{padding:7px 12px;font-size:11px;color:#475569;background:#fffbeb;border-top:1px solid #fde68a}
.summary-section{margin-top:24px}
.footer{margin-top:36px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:14px}
@media print{
  .no-print{display:none}
  body{print-color-adjust:exact;-webkit-print-color-adjust:exact}
  .page{padding:20px}
}
</style></head><body>
<div class="page">
  <div class="no-print">
    <button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
  </div>
  <div class="header">
    <h1>${esc(company)}</h1>
    <h2>Pedido de Venta</h2>
  </div>
  <div class="info-grid">
    <div class="info-item"><label>Número</label><p>#${esc(order.order_number)}</p></div>
    <div class="info-item"><label>Fecha de creación</label><p>${fmtDateTime(order.created_at)}</p></div>
    <div class="info-item"><label>Cliente</label><p>${esc(order.customer_name)}</p></div>
    <div class="info-item"><label>Fecha de entrega</label><p>${fmtDate(order.delivery_date)}</p></div>
    <div class="info-item"><label>Vendedor</label><p>${esc(order.vendor_name || 'Sin asignar')}</p></div>
    <div class="info-item"><label>Estado</label>
      <p><span class="badge" style="background:${statusBg[order.status]||'#f1f5f9'};color:${statusColor[order.status]||'#475569'}">${esc(order.status)}</span></p>
    </div>
  </div>
  <h3>Detalle del pedido</h3>
  <table>
    <thead><tr>
      <th>Producto / Descripción</th>
      <th class="r">Cantidad</th>
      <th class="r">Precio unit.</th>
      <th class="r">Desc. %</th>
      <th class="r">Subtotal</th>
    </tr></thead>
    <tbody>
      ${items.map(item => {
        const sub = item.quantity * item.unit_price * (1 - item.discount / 100);
        return `<tr>
          <td>${esc(item.product_name)}</td>
          <td class="r">${item.quantity}</td>
          <td class="r">${fmtMoney(item.unit_price)}</td>
          <td class="r">${item.discount > 0 ? item.discount + '%' : '—'}</td>
          <td class="r">${fmtMoney(sub)}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  <div class="totals-wrap">
    <table class="totals">
      <tr><td class="t-label">Subtotal ítems</td><td class="t-val">${fmtMoney(subtotal)}</td></tr>
      ${d1 > 0 ? `<tr><td class="t-label">Desc. 1 (${d1}%)</td><td class="t-val" style="color:#ef4444">−${fmtMoney(amt1)}</td></tr>` : ''}
      ${d2 > 0 ? `<tr><td class="t-label">Desc. 2 (${d2}%)</td><td class="t-val" style="color:#ef4444">−${fmtMoney(amt2)}</td></tr>` : ''}
      ${d3 > 0 ? `<tr><td class="t-label">Desc. 3 (${d3}%)</td><td class="t-val" style="color:#ef4444">−${fmtMoney(amt3)}</td></tr>` : ''}
      ${d4 > 0 ? `<tr><td class="t-label">Desc. 4 (${d4}%)</td><td class="t-val" style="color:#ef4444">−${fmtMoney(amt4)}</td></tr>` : ''}
      ${totalDisc > 0 ? `<tr><td class="t-label" style="font-weight:600">Total descuentos</td><td class="t-val" style="color:#ef4444;font-weight:600">−${fmtMoney(totalDisc)}</td></tr>` : ''}
      <tr><td class="t-label">Total neto</td><td class="t-val">${fmtMoney(netTotal)}</td></tr>
      ${ivaExempt
        ? `<tr><td class="t-label">IVA</td><td class="t-val" style="color:#16a34a;font-weight:600">Exento</td></tr>`
        : `<tr><td class="t-label">IVA 21%</td><td class="t-val">${fmtMoney(iva)}</td></tr>`
      }
      <tr class="t-final"><td>TOTAL FINAL</td><td class="t-val">${fmtMoney(finalTotal)}</td></tr>
    </table>
  </div>
  ${order.notes ? `<div class="notes-box"><strong>Observaciones</strong>${esc(order.notes)}</div>` : ''}

  ${deliveries.length ? `
  <div class="delivery-section">
    <h3>Historial de entregas</h3>
    ${deliveries.map((d, i) => {
      const totalDelivered = d.items.reduce((s, it) => s + it.quantity_delivered, 0);
      const totalOrdered   = d.items.reduce((s, it) => s + it.quantity_ordered, 0);
      const isComplete     = totalDelivered >= totalOrdered;
      return `<div class="delivery-entry">
        <div class="delivery-entry-hdr">
          <strong>Entrega #${i + 1}</strong>
          <span>${fmtDateTime(d.created_at)}</span>
          ${d.delivered_by ? `<span>por ${esc(d.delivered_by)}</span>` : ''}
          <span class="d-type ${isComplete ? 'd-total' : 'd-partial'}">${isComplete ? 'TOTAL' : 'PARCIAL'}</span>
        </div>
        <table>
          <thead><tr>
            <th>Producto</th>
            <th class="r">Pedido</th>
            <th class="r">Entregado</th>
          </tr></thead>
          <tbody>
            ${d.items.map(it => `<tr>
              <td>${esc(it.product_name)}</td>
              <td class="r">${it.quantity_ordered}</td>
              <td class="r" style="font-weight:600;color:#166534">${it.quantity_delivered}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${d.notes ? `<div class="delivery-notes-pdf">📝 ${esc(d.notes)}</div>` : ''}
      </div>`;
    }).join('')}
  </div>

  <div class="summary-section">
    <h3>Resumen de entregas por ítem</h3>
    <table>
      <thead><tr>
        <th>Producto</th>
        <th class="r">Pedido</th>
        <th class="r">Total entregado</th>
        <th class="r">Pendiente</th>
      </tr></thead>
      <tbody>
        ${items.map(item => {
          const delivered = deliveredMap[item.product_name] || 0;
          const pending   = Math.max(0, item.quantity - delivered);
          return `<tr>
            <td>${esc(item.product_name)}</td>
            <td class="r">${item.quantity}</td>
            <td class="r" style="font-weight:600;color:${delivered >= item.quantity ? '#166534' : '#92400e'}">${delivered}</td>
            <td class="r" style="color:${pending > 0 ? '#ef4444' : '#94a3b8'}">${pending > 0 ? pending : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
  ` : ''}

  <div class="footer">Generado el ${fmtDateTime(new Date().toISOString().replace('T',' ').substring(0,19))} — ${esc(company)}</div>
</div>
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400));</script>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).send(err.message); }
});

// ── GET /api/orders/:id/print-deposito ───────────────────────────────────────
router.get('/:id/print-deposito', (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare(`
      SELECT o.*, printf('%03d', o.order_sequence) AS order_number,
             COALESCE(u.full_name, u.username) AS vendor_name
      FROM orders o LEFT JOIN users u ON o.created_by = u.id
      WHERE o.id = ?
    `).get(id);
    if (!order) return res.status(404).send('Pedido no encontrado');
    if (isVendor(req) && order.created_by !== req.session.userId)
      return res.status(403).send('Acceso denegado');

    const items   = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
    const company = getCompanyName();
    const cust    = db.prepare("SELECT address FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))").get(order.customer_name);
    const address = cust && cust.address ? cust.address : null;

    const statusColor = { 'Pendiente':'#92400e','En preparación':'#1e40af','Entregado':'#166534','Cancelado':'#475569' };
    const statusBg    = { 'Pendiente':'#fef3c7','En preparación':'#dbeafe','Entregado':'#dcfce7','Cancelado':'#f1f5f9' };

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Pedido #${esc(order.order_number)} — Depósito</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1e293b;background:#fff}
.page{padding:32px 40px;max-width:820px;margin:0 auto;position:relative}
.no-print{text-align:right;margin-bottom:18px}
.print-btn{padding:9px 22px;background:#475569;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600}
.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-35deg);font-size:72px;font-weight:900;color:rgba(71,85,105,0.07);white-space:nowrap;pointer-events:none;z-index:0;letter-spacing:.04em}
.content{position:relative;z-index:1}
.banner{background:#475569;color:#fff;text-align:center;padding:10px 16px;border-radius:6px;margin-bottom:22px;font-size:14px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.header{text-align:center;padding-bottom:18px;border-bottom:2px solid #475569;margin-bottom:22px}
.header h1{font-size:26px;color:#475569;letter-spacing:.01em}
.header h2{font-size:13px;color:#64748b;margin-top:4px;font-weight:normal;text-transform:uppercase;letter-spacing:.08em}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 30px;margin-bottom:26px}
.info-item label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:3px}
.info-item p{font-size:13px;font-weight:500}
.info-item.full{grid-column:1/-1}
.badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:10px}
table{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:12.5px}
thead th{background:#475569;color:#fff;padding:8px 10px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
thead th.r{text-align:right}
tbody td{padding:8px 10px;border-bottom:1px solid #e2e8f0}
tbody td.r{text-align:right;font-weight:600}
tbody tr:nth-child(even) td{background:#f8fafc}
.notes-box{margin-top:20px;padding:14px 16px;background:#f8fafc;border-left:3px solid #475569;border-radius:0 6px 6px 0}
.notes-box strong{display:block;margin-bottom:5px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b}
.footer{margin-top:36px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:14px}
@media print{
  .no-print{display:none}
  body{print-color-adjust:exact;-webkit-print-color-adjust:exact}
  .page{padding:20px}
  .watermark{position:fixed}
}
</style></head><body>
<div class="page">
  <div class="watermark">USO INTERNO — DEPÓSITO</div>
  <div class="content">
    <div class="no-print">
      <button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
    </div>
    <div class="banner">USO INTERNO — DEPÓSITO</div>
    <div class="header">
      <h1>${esc(company)}</h1>
      <h2>Orden de Preparación</h2>
    </div>
    <div class="info-grid">
      <div class="info-item"><label>Número de pedido</label><p>#${esc(order.order_number)}</p></div>
      <div class="info-item"><label>Fecha de creación</label><p>${fmtDateTime(order.created_at)}</p></div>
      <div class="info-item"><label>Cliente</label><p>${esc(order.customer_name)}</p></div>
      <div class="info-item"><label>Fecha de entrega</label><p>${fmtDate(order.delivery_date)}</p></div>
      ${address ? `<div class="info-item full"><label>Dirección de entrega</label><p>${esc(address)}</p></div>` : ''}
      <div class="info-item"><label>Estado</label>
        <p><span class="badge" style="background:${statusBg[order.status]||'#f1f5f9'};color:${statusColor[order.status]||'#475569'}">${esc(order.status)}</span></p>
      </div>
    </div>
    <h3>Productos a preparar</h3>
    <table>
      <thead><tr>
        <th>Producto / Descripción</th>
        <th class="r">Cantidad</th>
      </tr></thead>
      <tbody>
        ${items.map(item => `<tr>
          <td>${esc(item.product_name)}</td>
          <td class="r">${item.quantity}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${order.notes ? `<div class="notes-box"><strong>Observaciones</strong>${esc(order.notes)}</div>` : ''}
    <div class="footer">Generado el ${fmtDateTime(new Date().toISOString().replace('T',' ').substring(0,19))} — ${esc(company)}</div>
  </div>
</div>
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400));</script>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).send(err.message); }
});

// ── POST /api/orders ──────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const { customer_name, notes, delivery_date, status, discount, discount2, discount3, discount4, iva_exempt, items } = req.body;
    if (!customer_name || !customer_name.trim())
      return res.status(400).json({ error: 'El nombre del cliente es requerido' });

    const orderId = withTransaction(() => {
      const { next } = db.prepare('SELECT COALESCE(MAX(order_sequence), 0) + 1 AS next FROM orders').get();
      const result = db.prepare(`
        INSERT INTO orders (order_sequence, customer_name, notes, delivery_date, status, discount, discount2, discount3, discount4, iva_exempt, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(next, customer_name.trim(), notes || '', delivery_date || null,
             status || 'Pendiente',
             parseFloat(discount)  || 0, parseFloat(discount2) || 0,
             parseFloat(discount3) || 0, parseFloat(discount4) || 0,
             iva_exempt ? 1 : 0,
             req.session.userId);
      const oid = Number(result.lastInsertRowid);
      if (items && items.length > 0) {
        const ins = db.prepare('INSERT INTO order_items (order_id, product_name, quantity, unit_price, discount, product_id) VALUES (?, ?, ?, ?, ?, ?)');
        for (const it of items) {
          if (it.product_name && it.product_name.trim()) {
            const prod = db.prepare('SELECT id FROM products WHERE name = ?').get(it.product_name.trim());
            ins.run(oid, it.product_name.trim(), parseFloat(it.quantity)||1, parseFloat(it.unit_price)||0, parseFloat(it.discount)||0, prod ? prod.id : null);
          }
        }
      }
      return oid;
    });

    const order = db.prepare(`SELECT o.*, printf('%03d', o.order_sequence) AS order_number, COALESCE(u.full_name, u.username) AS vendor_name FROM orders o LEFT JOIN users u ON o.created_by = u.id WHERE o.id = ?`).get(orderId);
    const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
    res.status(201).json({ ...order, items: orderItems });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /api/orders/:id ───────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (isVendor(req) && existing.created_by !== req.session.userId)
      return res.status(403).json({ error: 'No podés editar pedidos de otros vendedores' });

    const { customer_name, notes, delivery_date, status, discount, discount2, discount3, discount4, iva_exempt, items } = req.body;
    withTransaction(() => {
      db.prepare(`UPDATE orders SET customer_name=?, notes=?, delivery_date=?, status=?, discount=?, discount2=?, discount3=?, discount4=?, iva_exempt=?, updated_at=datetime('now','localtime') WHERE id=?`).run(
        customer_name !== undefined ? customer_name.trim() : existing.customer_name,
        notes !== undefined ? notes : existing.notes,
        delivery_date !== undefined ? (delivery_date || null) : existing.delivery_date,
        status || existing.status,
        discount  !== undefined ? (parseFloat(discount)  || 0) : existing.discount,
        discount2 !== undefined ? (parseFloat(discount2) || 0) : (existing.discount2 || 0),
        discount3 !== undefined ? (parseFloat(discount3) || 0) : (existing.discount3 || 0),
        discount4 !== undefined ? (parseFloat(discount4) || 0) : (existing.discount4 || 0),
        iva_exempt !== undefined ? (iva_exempt ? 1 : 0) : (existing.iva_exempt || 0),
        id
      );
      if (items !== undefined) {
        db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
        if (items.length > 0) {
          const ins = db.prepare('INSERT INTO order_items (order_id, product_name, quantity, unit_price, discount, product_id) VALUES (?, ?, ?, ?, ?, ?)');
          for (const it of items) {
            if (it.product_name && it.product_name.trim()) {
              const prod = db.prepare('SELECT id FROM products WHERE name = ?').get(it.product_name.trim());
              ins.run(id, it.product_name.trim(), parseFloat(it.quantity)||1, parseFloat(it.unit_price)||0, parseFloat(it.discount)||0, prod ? prod.id : null);
            }
          }
        }
      }
    });

    const order = db.prepare(`SELECT o.*, printf('%03d', o.order_sequence) AS order_number, COALESCE(u.full_name, u.username) AS vendor_name FROM orders o LEFT JOIN users u ON o.created_by = u.id WHERE o.id = ?`).get(id);
    const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
    res.json({ ...order, items: orderItems });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/orders/:id/deliveries ───────────────────────────────────────────
router.get('/:id/deliveries', (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (isVendor(req) && order.created_by !== req.session.userId)
      return res.status(403).json({ error: 'Acceso denegado' });

    const deliveries = db.prepare(
      'SELECT * FROM deliveries WHERE order_id = ? ORDER BY created_at ASC'
    ).all(id);
    const result = deliveries.map(d => {
      const items = db.prepare(`
        SELECT di.order_item_id, di.quantity_delivered,
               oi.product_name, oi.quantity AS quantity_ordered
        FROM delivery_items di
        JOIN order_items oi ON di.order_item_id = oi.id
        WHERE di.delivery_id = ?
      `).all(d.id);
      const rem = db.prepare('SELECT id, remito_sequence FROM remitos WHERE delivery_id = ?').get(d.id);
      const remito = rem ? { id: rem.id, number: `R-${String(rem.remito_sequence).padStart(3,'0')}` } : null;
      return { ...d, items, remito };
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/orders/:id/deliveries ──────────────────────────────────────────
router.post('/:id/deliveries', (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (isVendor(req) && order.created_by !== req.session.userId)
      return res.status(403).json({ error: 'Acceso denegado' });

    const { notes, items } = req.body;
    const validItems = (items || []).filter(i => parseFloat(i.quantity_delivered) > 0);
    if (!validItems.length)
      return res.status(400).json({ error: 'Ingresá al menos una cantidad mayor a 0' });

    withTransaction(() => {
      const dr = db.prepare(
        'INSERT INTO deliveries (order_id, notes, created_by) VALUES (?, ?, ?)'
      ).run(id, notes || '', req.session.userId);
      const delivId = Number(dr.lastInsertRowid);

      const ins = db.prepare(
        'INSERT INTO delivery_items (delivery_id, order_item_id, quantity_delivered) VALUES (?, ?, ?)'
      );
      for (const item of validItems)
        ins.run(delivId, item.order_item_id, parseFloat(item.quantity_delivered));

      // Descontar stock por entrega
      const ref = `Pedido #${String(order.order_sequence).padStart(3, '0')}`;
      for (const item of validItems) {
        const oi = db.prepare('SELECT product_id, product_name FROM order_items WHERE id = ?').get(item.order_item_id);
        let productId = oi && oi.product_id;
        if (!productId && oi) {
          const prod = db.prepare('SELECT id FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))').get(oi.product_name);
          if (prod) productId = prod.id;
        }
        if (productId) {
          const qty = parseFloat(item.quantity_delivered);
          db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?').run(qty, productId);
          db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, reference, created_by) VALUES (?, 'egreso', ?, ?, ?)`)
            .run(productId, qty, ref, req.session.userId);
        }
      }

      // Recalcular estado automáticamente
      const summary = db.prepare(`
        SELECT oi.quantity, COALESCE(SUM(di.quantity_delivered), 0) AS total_delivered
        FROM order_items oi
        LEFT JOIN delivery_items di ON di.order_item_id = oi.id
        WHERE oi.order_id = ?
        GROUP BY oi.id
      `).all(id);

      const allDone  = summary.length > 0 && summary.every(r => r.total_delivered >= r.quantity);
      const anyDone  = summary.some(r => r.total_delivered > 0);
      const newStatus = allDone ? 'Entregado' : anyDone ? 'Entrega parcial' : 'Pendiente';
      db.prepare("UPDATE orders SET status=?, updated_at=datetime('now','localtime') WHERE id=?")
        .run(newStatus, id);

      // Auto-crear remito
      const remitoItems = validItems.map(item => {
        const oi = db.prepare('SELECT product_name, unit_price, discount FROM order_items WHERE id = ?').get(item.order_item_id);
        return { product_name: oi.product_name, quantity: parseFloat(item.quantity_delivered), unit_price: oi.unit_price, discount: oi.discount };
      });
      const rSubtotal = remitoItems.reduce((s, i) => s + i.quantity * i.unit_price * (1 - i.discount / 100), 0);
      const rTotal    = rSubtotal * (1 - (order.discount || 0) / 100);
      const cust      = db.prepare("SELECT id, iva_condition FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))").get(order.customer_name);
      const { nextR } = db.prepare('SELECT COALESCE(MAX(remito_sequence), 0) + 1 AS nextR FROM remitos').get();
      const rr = db.prepare(
        'INSERT INTO remitos (remito_sequence, order_id, delivery_id, customer_id, customer_name, customer_iva, total, iva_exempt, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(nextR, id, delivId, cust ? cust.id : null, order.customer_name, cust ? (cust.iva_condition || 'Consumidor Final') : 'Consumidor Final', rTotal, order.iva_exempt ? 1 : 0, req.session.userId);
      const remitoId = Number(rr.lastInsertRowid);
      const insRI = db.prepare('INSERT INTO remito_items (remito_id, product_name, quantity, unit_price, discount) VALUES (?, ?, ?, ?, ?)');
      for (const it of remitoItems) insRI.run(remitoId, it.product_name, it.quantity, it.unit_price, it.discount);
    });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/orders/:id/deliveries/:delivId ───────────────────────────────
router.delete('/:id/deliveries/:delivId', (req, res) => {
  try {
    const orderId  = Number(req.params.id);
    const delivId  = Number(req.params.delivId);
    const order    = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (isVendor(req) && order.created_by !== req.session.userId)
      return res.status(403).json({ error: 'Acceso denegado' });
    const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ? AND order_id = ?').get(delivId, orderId);
    if (!delivery) return res.status(404).json({ error: 'Entrega no encontrada' });

    withTransaction(() => {
      // Restaurar stock
      const delivItems = db.prepare(`
        SELECT di.quantity_delivered, oi.product_id, oi.product_name
        FROM delivery_items di JOIN order_items oi ON di.order_item_id = oi.id
        WHERE di.delivery_id = ?
      `).all(delivId);

      const ref = `Pedido #${String(order.order_sequence).padStart(3, '0')} (cancelación entrega)`;
      for (const item of delivItems) {
        let productId = item.product_id;
        if (!productId) {
          const prod = db.prepare('SELECT id FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))').get(item.product_name);
          if (prod) productId = prod.id;
        }
        if (productId) {
          db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity_delivered, productId);
          db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, reference, created_by) VALUES (?, 'ingreso', ?, ?, ?)`)
            .run(productId, item.quantity_delivered, ref, req.session.userId);
        }
      }

      db.prepare('DELETE FROM deliveries WHERE id = ?').run(delivId);

      // Recalcular estado
      const summary = db.prepare(`
        SELECT oi.quantity, COALESCE(SUM(di.quantity_delivered), 0) AS total_delivered
        FROM order_items oi
        LEFT JOIN delivery_items di ON di.order_item_id = oi.id
        WHERE oi.order_id = ?
        GROUP BY oi.id
      `).all(orderId);

      const allDone  = summary.length > 0 && summary.every(r => r.total_delivered >= r.quantity);
      const anyDone  = summary.some(r => r.total_delivered > 0);
      const newStatus = allDone ? 'Entregado' : anyDone ? 'Entrega parcial' : 'Pendiente';
      db.prepare("UPDATE orders SET status=?, updated_at=datetime('now','localtime') WHERE id=?")
        .run(newStatus, orderId);
    });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/orders/:id ────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (isVendor(req) && order.created_by !== req.session.userId)
      return res.status(403).json({ error: 'No podés eliminar pedidos de otros vendedores' });
    db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
