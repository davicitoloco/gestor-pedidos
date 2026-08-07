const express = require('express');
const router = express.Router();
const { db, withTransaction } = require('../db');
const { getSucursalFilter, getInsertSucursalId } = require('../lib/sucursal');
const { acctBySubtype, recordJournal } = require('../lib/accounting');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
router.use(requireAuth);

function isVendor(req) { return req.session.role === 'vendedor'; }
function isAdminLike(req) { return ['admin','subadmin'].includes(req.session.role); }
function checkPeriodClosed(date) {
  const period = (date || new Date().toISOString().slice(0,10)).slice(0,7);
  const closed = db.prepare('SELECT id FROM accounting_closes WHERE period=?').get(period);
  if (closed) throw new Error(`El período ${period} está cerrado. No se pueden crear ni modificar asientos en períodos cerrados.`);
}

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
function fmtCuit(c) {
  const d = String(c || '').replace(/\D/g, '');
  if (d.length !== 11) return d || '';
  return `${d.slice(0,2)}-${d.slice(2,10)}-${d.slice(10)}`;
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
    const sf = getSucursalFilter(req, 'o');
    const params = [];
    if (status && status !== 'Todos') params.push(status);
    if (search) { const q = `%${search.toLowerCase()}%`; params.push(q, q); }
    params.push(...sf.params);

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
          * (1.0 - COALESCE(o.discount4,0)/100.0) AS total,
        EXISTS(SELECT 1 FROM order_returns r WHERE r.order_id = o.id AND r.return_type = 'rechazo') AS has_rechazo,
        EXISTS(SELECT 1 FROM repair_stock rs WHERE rs.origin_order_id = o.id AND rs.status = 'en_reparacion') AS has_repair_pending
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN users u ON o.created_by = u.id
      WHERE 1=1 ${vendorFilter} ${statusFilter} ${searchFilter} ${sf.clause}
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
    const custRow  = db.prepare("SELECT cuit FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))").get(order.customer_name);
    const custCuit = custRow && custRow.cuit ? custRow.cuit : null;
    const totalUnits = items.reduce((s, i) => s + i.quantity, 0);
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

    const statusColor = { 'Pendiente':'#92400e','En preparación':'#1e40af','Entregado':'#166534','Entregado con devolución':'#c2410c','Cancelado':'#475569' };
    const statusBg    = { 'Pendiente':'#fef3c7','En preparación':'#dbeafe','Entregado':'#dcfce7','Entregado con devolución':'#ffedd5','Cancelado':'#f1f5f9' };

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
    ${custCuit ? `<div class="info-item"><label>CUIT</label><p>${esc(fmtCuit(custCuit))}</p></div>` : ''}
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
    <tfoot>
      <tr style="background:#f1f5f9">
        <td colspan="5" style="padding:8px 10px;text-align:right;font-weight:700;font-size:13px;border-top:2px solid #e2e8f0;color:#1e293b">
          Total unidades: <span style="color:#2563eb">${totalUnits}</span>
        </td>
      </tr>
    </tfoot>
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
    const cust     = db.prepare("SELECT address, localidad, provincia FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))").get(order.customer_name);
    const address  = cust && cust.address   ? cust.address   : null;
    const localidad = cust && cust.localidad ? cust.localidad : null;
    const provincia = cust && cust.provincia ? cust.provincia : null;
    const totalUnits = items.reduce((s, i) => s + i.quantity, 0);

    // Descuento y medio de pago para el PDF depósito
    const medioPago = order.payment_efectivo ? 'Efectivo' : order.payment_cheque ? 'Cheque' : null;
    const depSubtotal = items.reduce((s, i) => s + i.quantity * i.unit_price * (1 - i.discount / 100), 0);
    const dd1 = order.discount  || 0;
    const dd2 = order.discount2 || 0;
    const dd3 = order.discount3 || 0;
    const dd4 = order.discount4 || 0;
    const dBase2 = depSubtotal * (1 - dd1/100);
    const dBase3 = dBase2 * (1 - dd2/100);
    const dBase4 = dBase3 * (1 - dd3/100);
    const depTotalDisc = depSubtotal - dBase4 * (1 - dd4/100);
    const discParts = [dd1, dd2, dd3, dd4].filter(v => v > 0).map(v => `${v}%`);
    const hasDiscount = discParts.length > 0;

    const statusColor = { 'Pendiente':'#92400e','En preparación':'#1e40af','Entregado':'#166534','Entregado con devolución':'#c2410c','Cancelado':'#475569' };
    const statusBg    = { 'Pendiente':'#fef3c7','En preparación':'#dbeafe','Entregado':'#dcfce7','Entregado con devolución':'#ffedd5','Cancelado':'#f1f5f9' };

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
      <div class="info-item"><label>Vendedor</label><p>${esc(order.vendor_name || 'Sin asignar')}</p></div>
      <div class="info-item"><label>Estado</label>
        <p><span class="badge" style="background:${statusBg[order.status]||'#f1f5f9'};color:${statusColor[order.status]||'#475569'}">${esc(order.status)}</span></p>
      </div>
      ${address    ? `<div class="info-item full"><label>Dirección de entrega</label><p>${esc(address)}</p></div>` : ''}
      ${localidad  ? `<div class="info-item"><label>Localidad</label><p>${esc(localidad)}</p></div>` : ''}
      ${provincia  ? `<div class="info-item"><label>Provincia</label><p>${esc(provincia)}</p></div>` : ''}
      ${medioPago  ? `<div class="info-item"><label>Medio de pago</label><p style="font-weight:700">${esc(medioPago)}</p></div>` : ''}
      ${hasDiscount ? `<div class="info-item"><label>Descuento otorgado</label><p style="font-weight:700">${discParts.join(' + ')}</p></div>` : ''}
    </div>
    <h3>Productos a preparar</h3>
    <table>
      <thead><tr>
        <th>Producto / Descripción</th>
      </tr></thead>
      <tbody>
        ${items.map(item => `<tr>
          <td style="padding:14px 10px;line-height:1.8"><strong>${esc(item.product_name)}</strong> — ${item.quantity}u</td>
        </tr>`).join('')}
      </tbody>
      <tfoot>
        <tr style="background:#f1f5f9">
          <td style="padding:10px;font-weight:700;font-size:13px;text-align:right;border-top:2px solid #e2e8f0">
            Total unidades: <span style="color:#475569">${totalUnits}</span>
          </td>
        </tr>
      </tfoot>
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
    const { customer_name, notes, delivery_date, status, discount, discount2, discount3, discount4, iva_exempt, payment_efectivo, payment_cheque, items } = req.body;
    if (!customer_name || !customer_name.trim())
      return res.status(400).json({ error: 'El nombre del cliente es requerido' });

    const orderId = withTransaction(() => {
      const { next } = db.prepare('SELECT COALESCE(MAX(order_sequence), 0) + 1 AS next FROM orders').get();
      const efe = payment_efectivo ? 1 : 0;
      const chq = efe ? 0 : (payment_cheque ? 1 : 0);
      const sucursalId = getInsertSucursalId(req);
      const result = db.prepare(`
        INSERT INTO orders (order_sequence, customer_name, notes, delivery_date, status, discount, discount2, discount3, discount4, iva_exempt, payment_efectivo, payment_cheque, created_by, sucursal_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(next, customer_name.trim(), notes || '', delivery_date || null,
             status || 'Pendiente',
             parseFloat(discount)  || 0, parseFloat(discount2) || 0,
             parseFloat(discount3) || 0, parseFloat(discount4) || 0,
             iva_exempt ? 1 : 0, efe, chq,
             req.session.userId, sucursalId);
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

    const { customer_name, notes, delivery_date, status, discount, discount2, discount3, discount4, iva_exempt, payment_efectivo, payment_cheque, items } = req.body;
    withTransaction(() => {
      const efe = payment_efectivo !== undefined ? (payment_efectivo ? 1 : 0) : (existing.payment_efectivo || 0);
      const chq = payment_cheque  !== undefined ? (payment_cheque  ? 1 : 0) : (existing.payment_cheque  || 0);
      db.prepare(`UPDATE orders SET customer_name=?, notes=?, delivery_date=?, status=?, discount=?, discount2=?, discount3=?, discount4=?, iva_exempt=?, payment_efectivo=?, payment_cheque=?, updated_at=datetime('now','localtime') WHERE id=?`).run(
        customer_name !== undefined ? customer_name.trim() : existing.customer_name,
        notes !== undefined ? notes : existing.notes,
        delivery_date !== undefined ? (delivery_date || null) : existing.delivery_date,
        status || existing.status,
        discount  !== undefined ? (parseFloat(discount)  || 0) : existing.discount,
        discount2 !== undefined ? (parseFloat(discount2) || 0) : (existing.discount2 || 0),
        discount3 !== undefined ? (parseFloat(discount3) || 0) : (existing.discount3 || 0),
        discount4 !== undefined ? (parseFloat(discount4) || 0) : (existing.discount4 || 0),
        iva_exempt !== undefined ? (iva_exempt ? 1 : 0) : (existing.iva_exempt || 0),
        efe, chq,
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
          db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, reference, created_by, sucursal_id) VALUES (?, 'egreso', ?, ?, ?, ?)`)
            .run(productId, qty, ref, req.session.userId, getInsertSucursalId(req));
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
        'INSERT INTO remitos (remito_sequence, order_id, delivery_id, customer_id, customer_name, customer_iva, total, iva_exempt, created_by, sucursal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(nextR, id, delivId, cust ? cust.id : null, order.customer_name, cust ? (cust.iva_condition || 'Consumidor Final') : 'Consumidor Final', rTotal, order.iva_exempt ? 1 : 0, req.session.userId, getInsertSucursalId(req));
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
          db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, reference, created_by, sucursal_id) VALUES (?, 'ingreso', ?, ?, ?, ?)`)
            .run(productId, item.quantity_delivered, ref, req.session.userId, getInsertSucursalId(req));
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

// ── GET /api/orders/:id/returns ──────────────────────────────────────────────
router.get('/:id/returns', (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (isVendor(req) && order.created_by !== req.session.userId)
      return res.status(403).json({ error: 'Acceso denegado' });

    const returns = db.prepare(`
      SELECT r.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM order_returns r LEFT JOIN users u ON r.created_by = u.id
      WHERE r.order_id = ? ORDER BY r.created_at ASC
    `).all(id);
    for (const r of returns) {
      r.items = db.prepare('SELECT * FROM order_return_items WHERE return_id = ? ORDER BY id').all(r.id);
    }
    res.json(returns);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/orders/:id/returns ─────────────────────────────────────────────
router.post('/:id/returns', (req, res) => {
  try {
    if (!isAdminLike(req)) return res.status(403).json({ error: 'Acceso denegado' });
    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!['Entregado', 'Entrega parcial', 'Entregado con devolución'].includes(order.status))
      return res.status(400).json({ error: 'El pedido debe estar entregado (total o parcial) para registrar una devolución' });

    const { return_type, notes, items } = req.body;
    if (!['rechazo', 'reparacion'].includes(return_type))
      return res.status(400).json({ error: "return_type debe ser 'rechazo' o 'reparacion'" });
    const requestedItems = (items || []).filter(i => parseFloat(i.quantity_returned) > 0);
    if (!requestedItems.length)
      return res.status(400).json({ error: 'Ingresá al menos una cantidad mayor a 0' });

    const today = new Date().toISOString().slice(0, 10);
    checkPeriodClosed(today);

    const customer = db.prepare("SELECT id, name FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))").get(order.customer_name);
    if (!customer)
      return res.status(400).json({ error: `No se encontró un cliente registrado como "${order.customer_name}". Vinculá el pedido a un cliente existente antes de registrar la devolución.` });

    const netRows = db.prepare(`
      SELECT oi.id AS order_item_id, oi.product_id, oi.product_name, oi.unit_price,
        COALESCE((SELECT SUM(di.quantity_delivered) FROM delivery_items di
                  JOIN deliveries d ON di.delivery_id = d.id
                  WHERE d.order_id = ? AND di.order_item_id = oi.id), 0) AS delivered,
        COALESCE((SELECT SUM(ori.quantity_returned) FROM order_return_items ori
                  JOIN order_returns r ON ori.return_id = r.id
                  WHERE r.order_id = ? AND ori.order_item_id = oi.id), 0) AS already_returned
      FROM order_items oi WHERE oi.order_id = ?
    `).all(id, id, id);
    const netMap = {};
    for (const row of netRows) netMap[row.order_item_id] = { ...row, net_available: row.delivered - row.already_returned };

    const returnItems = [];
    for (const it of requestedItems) {
      const oiId = Number(it.order_item_id);
      const qty  = parseFloat(it.quantity_returned);
      const row  = netMap[oiId];
      if (!row) return res.status(400).json({ error: 'Ítem de pedido inválido' });
      if (qty > row.net_available + 0.0001)
        return res.status(400).json({ error: `No se puede devolver más de lo entregado neto para "${row.product_name}" (disponible: ${row.net_available})` });
      returnItems.push({
        order_item_id: oiId, product_id: row.product_id, product_name: row.product_name,
        unit_price: row.unit_price, quantity_returned: qty, subtotal_returned: qty * row.unit_price
      });
    }
    const totalReturned = returnItems.reduce((s, i) => s + i.subtotal_returned, 0);

    const result = withTransaction(() => {
      const { max } = db.prepare("SELECT MAX(CAST(SUBSTR(credit_note_number, 4) AS INTEGER)) AS max FROM order_returns").get();
      const creditNoteNumber = `NC-${String((max || 0) + 1).padStart(3, '0')}`;
      const sucursalId = getInsertSucursalId(req);

      const rr = db.prepare(`
        INSERT INTO order_returns (order_id, return_type, total_returned, credit_note_number, notes, created_by, sucursal_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, return_type, totalReturned, creditNoteNumber, notes || '', req.session.userId, sucursalId);
      const returnId = Number(rr.lastInsertRowid);

      const insItem = db.prepare(`
        INSERT INTO order_return_items (return_id, order_item_id, product_id, product_name, quantity_returned, unit_price, subtotal_returned)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const it of returnItems)
        insItem.run(returnId, it.order_item_id, it.product_id, it.product_name, it.quantity_returned, it.unit_price, it.subtotal_returned);

      const orderNumber = String(order.order_sequence).padStart(3, '0');
      if (return_type === 'rechazo') {
        const ref = `Devolución pedido #${orderNumber} (rechazo)`;
        for (const it of returnItems) {
          let productId = it.product_id;
          if (!productId) {
            const prod = db.prepare('SELECT id FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))').get(it.product_name);
            if (prod) productId = prod.id;
          }
          if (productId) {
            db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(it.quantity_returned, productId);
            db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, reference, created_by, sucursal_id) VALUES (?, 'ingreso', ?, ?, ?, ?)`)
              .run(productId, it.quantity_returned, ref, req.session.userId, sucursalId);
          }
        }
      } else {
        const insRepair = db.prepare(`
          INSERT INTO repair_stock (product_id, product_name, quantity, origin_return_id, origin_order_id, status, sucursal_id)
          VALUES (?, ?, ?, ?, ?, 'en_reparacion', ?)
        `);
        for (const it of returnItems) {
          let productId = it.product_id;
          if (!productId) {
            const prod = db.prepare('SELECT id FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))').get(it.product_name);
            if (prod) productId = prod.id;
          }
          insRepair.run(productId, it.product_name, it.quantity_returned, returnId, id, sucursalId);
        }
      }

      db.prepare("UPDATE orders SET status='Entregado con devolución', updated_at=datetime('now','localtime') WHERE id=?").run(id);

      const ventasDevolAcct = db.prepare("SELECT id FROM accounts WHERE code='4.1.02' LIMIT 1").get();
      const clientesAcct    = acctBySubtype('Clientes');
      if (!ventasDevolAcct || !clientesAcct) throw new Error('No se encontraron las cuentas contables necesarias (4.1.02 / Deudores por ventas).');

      const desc = `Devolución pedido #${orderNumber} - Cliente: ${order.customer_name}`;
      const entryId = recordJournal({
        date: today, desc, reference: creditNoteNumber, ref_type: 'order_return', ref_id: returnId,
        lines: [
          { account_id: ventasDevolAcct.id, debit: totalReturned, credit: 0, description: desc },
          { account_id: clientesAcct.id, debit: 0, credit: totalReturned, description: desc }
        ],
        userId: req.session.userId
      });

      const noteDesc = `Devolución pedido #${orderNumber} - ${return_type === 'rechazo' ? 'rechazo' : 'reparación'}`;
      db.prepare(`
        INSERT INTO credit_debit_notes (entity_type, entity_id, note_type, date, description, amount, reference, journal_entry_id, created_by)
        VALUES ('customer', ?, 'credito', ?, ?, ?, ?, ?, ?)
      `).run(customer.id, today, noteDesc, totalReturned, creditNoteNumber, entryId, req.session.userId);

      return returnId;
    });

    const created = db.prepare(`
      SELECT r.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM order_returns r LEFT JOIN users u ON r.created_by = u.id WHERE r.id = ?
    `).get(result);
    created.items = db.prepare('SELECT * FROM order_return_items WHERE return_id = ? ORDER BY id').all(result);
    res.status(201).json(created);
  } catch (err) { res.status(err.message.includes('cerrado') ? 409 : 500).json({ error: err.message }); }
});

// ── GET /api/orders/:orderId/returns/:returnId/nota-credito ─────────────────
router.get('/:orderId/returns/:returnId/nota-credito', (req, res) => {
  try {
    const orderId  = Number(req.params.orderId);
    const returnId = Number(req.params.returnId);
    const order = db.prepare(`
      SELECT o.*, printf('%03d', o.order_sequence) AS order_number
      FROM orders o WHERE o.id = ?
    `).get(orderId);
    if (!order) return res.status(404).send('Pedido no encontrado');
    const ret = db.prepare(`
      SELECT r.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM order_returns r LEFT JOIN users u ON r.created_by = u.id
      WHERE r.id = ? AND r.order_id = ?
    `).get(returnId, orderId);
    if (!ret) return res.status(404).send('Devolución no encontrada');

    const items    = db.prepare('SELECT * FROM order_return_items WHERE return_id = ? ORDER BY id').all(returnId);
    const company  = getCompanyName();
    const custRow  = db.prepare("SELECT cuit, address, iva_condition FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))").get(order.customer_name);
    const subtotal  = items.reduce((s, i) => s + i.subtotal_returned, 0);
    const ivaExempt = !!order.iva_exempt;
    const iva       = ivaExempt ? 0 : subtotal * 0.21;
    const total     = subtotal + iva;
    const typeLabel = ret.return_type === 'rechazo' ? 'Devolución por rechazo' : 'Devolución por reparación';
    const typeColor = ret.return_type === 'rechazo' ? { bg: '#ffedd5', txt: '#c2410c' } : { bg: '#fef3c7', txt: '#92400e' };

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>${esc(ret.credit_note_number)} — ${esc(company)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1e293b;background:#fff}
.page{padding:32px 40px;max-width:820px;margin:0 auto}
.no-print{text-align:right;margin-bottom:18px}
.print-btn{padding:9px 22px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600}
.header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:18px;border-bottom:2px solid #dc2626;margin-bottom:22px}
.header-left h1{font-size:22px;color:#dc2626;font-weight:700}
.header-left p{font-size:12px;color:#64748b;margin-top:2px;text-transform:uppercase;letter-spacing:.06em}
.header-right{text-align:right}
.nc-num{font-size:26px;font-weight:700;color:#1e293b;letter-spacing:.02em}
.nc-date{font-size:12px;color:#64748b;margin-top:4px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 30px;margin-bottom:18px;padding:14px 16px;background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0}
.info-item label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:3px}
.info-item p{font-size:13px;font-weight:500}
.badge{display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;margin-bottom:18px}
h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:10px}
table{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:12.5px}
thead th{background:#dc2626;color:#fff;padding:8px 10px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
thead th.r{text-align:right}
tbody td{padding:8px 10px;border-bottom:1px solid #e2e8f0}
tbody td.r{text-align:right}
tbody tr:nth-child(even) td{background:#f8fafc}
.totals-wrap{display:flex;justify-content:flex-end}
.totals{width:280px;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden}
.totals tr td{padding:8px 14px;border-bottom:1px solid #e2e8f0;font-size:13px}
.totals tr:last-child td{border-bottom:none}
.totals .t-final td{font-weight:700;font-size:15px;color:#dc2626;background:#fef2f2;border-top:2px solid #dc2626}
.t-label{color:#64748b}
.t-val{text-align:right;font-weight:600}
.notes-box{margin-top:20px;padding:14px 16px;background:#f8fafc;border-left:3px solid #dc2626;border-radius:0 6px 6px 0}
.notes-box strong{display:block;margin-bottom:5px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b}
.footer{margin-top:32px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:14px}
.footer-note{margin-top:20px;font-size:11px;color:#64748b;text-align:center;font-style:italic}
@media print{.no-print{display:none}body{print-color-adjust:exact;-webkit-print-color-adjust:exact}.page{padding:20px}}
</style></head><body>
<div class="page">
  <div class="no-print">
    <button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
  </div>
  <div class="header">
    <div class="header-left">
      <h1>${esc(company)}</h1>
      <p>NOTA DE CRÉDITO</p>
    </div>
    <div class="header-right">
      <div class="nc-num">${esc(ret.credit_note_number)}</div>
      <div class="nc-date">${fmtDateTime(ret.created_at)}</div>
    </div>
  </div>
  <span class="badge" style="background:${typeColor.bg};color:${typeColor.txt}">${esc(typeLabel)}</span>
  <div class="info-grid">
    <div class="info-item"><label>Cliente</label><p>${esc(order.customer_name)}</p></div>
    <div class="info-item"><label>Condición IVA</label><p>${esc(custRow ? custRow.iva_condition : 'Consumidor Final')}</p></div>
    <div class="info-item"><label>Pedido de referencia</label><p>#${esc(order.order_number)}</p></div>
    <div class="info-item"><label>Registrado por</label><p>${esc(ret.created_by_name || '—')}</p></div>
    ${custRow && custRow.cuit ? `<div class="info-item"><label>CUIT</label><p>${esc(fmtCuit(custRow.cuit))}</p></div>` : ''}
  </div>
  <h3>Ítems devueltos</h3>
  <table>
    <thead><tr>
      <th>Producto / Descripción</th>
      <th class="r" style="width:80px">Cant.</th>
      <th class="r" style="width:120px">Precio unit.</th>
      <th class="r" style="width:120px">Subtotal</th>
    </tr></thead>
    <tbody>
      ${items.map(item => `<tr>
        <td>${esc(item.product_name)}</td>
        <td class="r">${item.quantity_returned}</td>
        <td class="r">${fmtMoney(item.unit_price)}</td>
        <td class="r">${fmtMoney(item.subtotal_returned)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <div class="totals-wrap">
    <table class="totals">
      <tr><td class="t-label">Subtotal</td><td class="t-val">${fmtMoney(subtotal)}</td></tr>
      ${ivaExempt
        ? `<tr><td class="t-label">IVA</td><td class="t-val" style="color:#16a34a;font-weight:600">Exento</td></tr>`
        : `<tr><td class="t-label">IVA 21%</td><td class="t-val">${fmtMoney(iva)}</td></tr>`
      }
      <tr class="t-final"><td>TOTAL NC</td><td class="t-val">${fmtMoney(total)}</td></tr>
    </table>
  </div>
  ${ret.notes ? `<div class="notes-box"><strong>Observaciones</strong>${esc(ret.notes)}</div>` : ''}
  <div class="footer-note">Este comprobante acredita la devolución de mercadería del pedido referenciado.</div>
  <div class="footer">Generado el ${fmtDateTime(new Date().toISOString().replace('T',' ').substring(0,19))} — ${esc(company)}</div>
</div>
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400));</script>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).send(err.message); }
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
