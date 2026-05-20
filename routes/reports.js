const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { getSucursalFilter } = require('../lib/sucursal');

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  if (!['admin','subadmin'].includes(req.session.role)) return res.status(403).json({ error: 'Solo los administradores pueden ver los reportes' });
  next();
}
router.use(requireAdmin);

function isVendor(req) { return req.session.role === 'vendedor'; }
function vendorClause(req) { return isVendor(req) ? `AND o.created_by = ${req.session.userId}` : ''; }
function sucursalClause(req) { const sf = getSucursalFilter(req, 'o'); return { clause: sf.clause, params: sf.params }; }

function fmtMoney(v) { return '$ ' + (v||0).toLocaleString('es-AR', { minimumFractionDigits:2, maximumFractionDigits:2 }); }
function fmtDate(s) { if(!s) return '-'; const d=s.split(' ')[0].split('-'); return `${d[2]}/${d[1]}/${d[0]}`; }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function localDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function getCompanyName() {
  const r = db.prepare("SELECT value FROM settings WHERE key='company_name'").get();
  return r ? r.value : 'Mi Empresa';
}

// Factor de descuento encadenado para usar en SQL
const DF = "(1.0 - o.discount/100.0) * (1.0 - COALESCE(o.discount2,0)/100.0) * (1.0 - COALESCE(o.discount3,0)/100.0) * (1.0 - COALESCE(o.discount4,0)/100.0)";

// ── GET /api/reports/stats ───────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  try {
    const vc = vendorClause(req);
    const sc = sucursalClause(req);
    const now = new Date();

    // Accept from/to for month filter; default to current month
    const fromQ = validateDate(req.query.from);
    const toQ   = validateDate(req.query.to);
    const monthStart = fromQ || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const monthEnd   = toQ ? toQ + ' 23:59:59' : null;
    const endClause  = monthEnd ? 'AND o.created_at <= ?' : '';
    const endParam   = monthEnd ? [monthEnd] : [];

    const total = db.prepare(`SELECT COUNT(*) AS c FROM orders o WHERE 1=1 ${vc} ${sc.clause}`).get(...sc.params).c;

    const monthData = db.prepare(`
      SELECT COUNT(DISTINCT o.id) AS cnt, COALESCE(SUM(sub.t),0) AS sales
      FROM orders o
      LEFT JOIN (
        SELECT order_id, SUM(quantity*unit_price*(1.0-discount/100.0)) AS t
        FROM order_items GROUP BY order_id
      ) sub ON sub.order_id = o.id
      WHERE o.created_at >= ? ${endClause}
        AND o.status != 'Cancelado' ${vc} ${sc.clause}
    `).get(monthStart, ...endParam, ...sc.params);

    const byStatus = db.prepare(`
      SELECT status, COUNT(*) AS cnt FROM orders o
      WHERE o.created_at >= ? ${endClause} ${vc} ${sc.clause}
      GROUP BY status
    `).all(monthStart, ...endParam, ...sc.params);

    const monthSales  = monthData.sales;
    const monthOrders = monthData.cnt;

    const unitsData = db.prepare(`
      SELECT COALESCE(SUM(oi.quantity), 0) AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.created_at >= ? ${endClause}
        AND o.status != 'Cancelado' ${vc} ${sc.clause}
    `).get(monthStart, ...endParam, ...sc.params);

    const totalUnitsData = db.prepare(`
      SELECT COALESCE(SUM(oi.quantity), 0) AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status != 'Cancelado' ${vc} ${sc.clause}
    `).get(...sc.params);

    const deliveredUnitsData = db.prepare(`
      SELECT COALESCE(SUM(oi.quantity), 0) AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.created_at >= ? ${endClause}
        AND o.status IN ('Entregado', 'Entrega parcial') ${vc} ${sc.clause}
    `).get(monthStart, ...endParam, ...sc.params);

    res.json({
      total_orders:           total,
      month_orders:           monthOrders,
      month_sales:            monthSales,
      month_units:            unitsData.units,
      total_units:            totalUnitsData.units,
      month_units_delivered:  deliveredUnitsData.units,
      avg_order:              monthOrders > 0 ? monthSales / monthOrders : 0,
      by_status:              byStatus
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/daily-units ────────────────────────────────────────────
router.get('/daily-units', (req, res) => {
  try {
    const vc = vendorClause(req);
    const sc = sucursalClause(req);
    const now = new Date();
    const days = [];
    const DAY_NAMES = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

    for (let i = 27; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const dateStr = localDateStr(d);
      const label = i === 0 ? 'Hoy' : `${DAY_NAMES[d.getDay()]} ${d.getDate()}/${d.getMonth()+1}`;

      const row = db.prepare(`
        SELECT COALESCE(SUM(oi.quantity), 0) AS units
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at >= ? AND o.created_at <= ?
          AND o.status != 'Cancelado' ${vc} ${sc.clause}
      `).get(dateStr, dateStr + ' 23:59:59', ...sc.params);

      days.push({ date: dateStr, label, units: row.units });
    }
    res.json(days);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/top-products ────────────────────────────────────────────
router.get('/top-products', (req, res) => {
  try {
    const vc   = vendorClause(req);
    const sc   = sucursalClause(req);
    const from = validateDate(req.query.from);
    const to   = validateDate(req.query.to);
    const rows = db.prepare(`
      SELECT
        oi.product_name,
        SUM(oi.quantity)                                            AS total_qty,
        COUNT(DISTINCT oi.order_id)                                AS order_count,
        SUM(oi.quantity * oi.unit_price * (1.0-oi.discount/100.0)) AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status != 'Cancelado'
        ${rangeClause('o', 'created_at', from, to)}
        ${vc} ${sc.clause}
      GROUP BY LOWER(TRIM(oi.product_name))
      ORDER BY total_qty DESC
      LIMIT 15
    `).all(...rangeParams(from, to), ...sc.params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Helpers rankings ─────────────────────────────────────────────────────────
function validateDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null; }

function rangeClause(alias, col, from, to) {
  const parts = [];
  if (from) parts.push(`${alias}.${col} >= ?`);
  if (to)   parts.push(`${alias}.${col} <= ?`);
  return parts.length ? 'AND ' + parts.join(' AND ') : '';
}
function rangeParams(from, to) {
  const p = [];
  if (from) p.push(from);
  if (to)   p.push(to + ' 23:59:59');
  return p;
}
function rankingLimit(req) { return Math.min(parseInt(req.query.limit) || 10, 100); }

// ── GET /api/reports/top-customers ───────────────────────────────────────────
router.get('/top-customers', (req, res) => {
  try {
    const from  = validateDate(req.query.from);
    const to    = validateDate(req.query.to);
    const limit = rankingLimit(req);
    const sc = sucursalClause(req);
    const rows = db.prepare(`
      SELECT TRIM(o.customer_name) AS customer_name,
             COUNT(DISTINCT o.id)   AS order_count,
             COALESCE(SUM(sub.t * ${DF}), 0) AS total,
             COALESCE(AVG(sub.t * ${DF}), 0) AS avg_ticket
      FROM orders o
      LEFT JOIN (
        SELECT order_id, SUM(quantity*unit_price*(1.0-discount/100.0)) AS t
        FROM order_items GROUP BY order_id
      ) sub ON sub.order_id = o.id
      WHERE o.status != 'Cancelado'
        ${rangeClause('o', 'created_at', from, to)} ${sc.clause}
      GROUP BY LOWER(TRIM(o.customer_name))
      ORDER BY total DESC
      LIMIT ?
    `).all(...rangeParams(from, to), ...sc.params, limit);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/top-delivered ───────────────────────────────────────────
router.get('/top-delivered', (req, res) => {
  try {
    const from  = validateDate(req.query.from);
    const to    = validateDate(req.query.to);
    const limit = rankingLimit(req);
    const rows = db.prepare(`
      SELECT TRIM(oi.product_name) AS product_name,
             SUM(di.quantity_delivered) AS total_delivered,
             SUM(di.quantity_delivered * oi.unit_price * (1.0 - oi.discount/100.0)) AS revenue
      FROM delivery_items di
      JOIN order_items oi ON di.order_item_id = oi.id
      JOIN deliveries d   ON di.delivery_id = d.id
      WHERE 1=1 ${rangeClause('d', 'created_at', from, to)}
      GROUP BY LOWER(TRIM(oi.product_name))
      ORDER BY total_delivered DESC
      LIMIT ?
    `).all(...rangeParams(from, to), limit);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/top-stocked ─────────────────────────────────────────────
router.get('/top-stocked', (req, res) => {
  try {
    const from  = validateDate(req.query.from);
    const to    = validateDate(req.query.to);
    const limit = rankingLimit(req);
    const rows = db.prepare(`
      SELECT p.name AS product_name,
             SUM(sm.quantity) AS total_ingresado
      FROM stock_movements sm
      JOIN products p ON sm.product_id = p.id
      WHERE sm.type = 'ingreso'
        ${rangeClause('sm', 'created_at', from, to)}
      GROUP BY sm.product_id
      ORDER BY total_ingresado DESC
      LIMIT ?
    `).all(...rangeParams(from, to), limit);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/top-discounts ───────────────────────────────────────────
router.get('/top-discounts', (req, res) => {
  try {
    const from  = validateDate(req.query.from);
    const to    = validateDate(req.query.to);
    const limit = rankingLimit(req);
    const sc = sucursalClause(req);
    const rows = db.prepare(`
      SELECT printf('%03d', o.order_sequence) AS order_number,
             o.customer_name,
             ROUND((1.0 - ${DF}) * 100.0, 2) AS discount_pct,
             COALESCE(sub.t, 0) AS subtotal,
             COALESCE(sub.t * (1.0 - ${DF}), 0) AS discount_amount
      FROM orders o
      LEFT JOIN (
        SELECT order_id, SUM(quantity*unit_price*(1.0-discount/100.0)) AS t
        FROM order_items GROUP BY order_id
      ) sub ON sub.order_id = o.id
      WHERE (o.discount > 0 OR COALESCE(o.discount2,0) > 0 OR COALESCE(o.discount3,0) > 0 OR COALESCE(o.discount4,0) > 0)
        AND o.status != 'Cancelado'
        ${rangeClause('o', 'created_at', from, to)} ${sc.clause}
      ORDER BY discount_amount DESC
      LIMIT ?
    `).all(...rangeParams(from, to), ...sc.params, limit);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/top-vendors ─────────────────────────────────────────────
router.get('/top-vendors', (req, res) => {
  try {
    const from  = validateDate(req.query.from);
    const to    = validateDate(req.query.to);
    const limit = rankingLimit(req);
    const sc = sucursalClause(req);
    const rows = db.prepare(`
      SELECT COALESCE(u.full_name, u.username, 'Sin asignar') AS vendor_name,
             COUNT(DISTINCT o.id) AS order_count,
             COALESCE(SUM(sub.t * ${DF}), 0) AS total,
             COALESCE(AVG(sub.t * ${DF}), 0) AS avg_ticket
      FROM orders o
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN (
        SELECT order_id, SUM(quantity*unit_price*(1.0-discount/100.0)) AS t
        FROM order_items GROUP BY order_id
      ) sub ON sub.order_id = o.id
      WHERE o.status != 'Cancelado'
        ${rangeClause('o', 'created_at', from, to)} ${sc.clause}
      GROUP BY o.created_by
      ORDER BY total DESC
      LIMIT ?
    `).all(...rangeParams(from, to), ...sc.params, limit);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/excel ────────────────────────────────────────────────────
router.get('/excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const vc = vendorClause(req);
    const sc = sucursalClause(req);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Gestor de Pedidos';

    const hdrFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF2563EB' } };
    const hdrFont = { bold:true, color:{ argb:'FFFFFFFF' }, size:11 };
    const currency = '"$ "#,##0.00';

    // Hoja 1: Pedidos
    const ws1 = workbook.addWorksheet('Pedidos');
    ws1.columns = [
      { header:'Nº',         key:'num',      width:8  },
      { header:'Cliente',    key:'customer', width:28 },
      { header:'Estado',     key:'status',   width:16 },
      { header:'Vendedor',   key:'vendor',   width:22 },
      { header:'Ítems',      key:'items',    width:8  },
      { header:'Subtotal',   key:'subtotal', width:16 },
      { header:'Desc %',     key:'disc',     width:10 },
      { header:'Total',      key:'total',    width:16 },
      { header:'Entrega',    key:'delivery', width:14 },
      { header:'Creado',     key:'created',  width:18 },
      { header:'Notas',      key:'notes',    width:35 }
    ];
    const orders = db.prepare(`
      SELECT printf('%03d', o.order_sequence) AS order_number,
             o.customer_name, o.status,
             COALESCE(u.full_name, u.username, '—') AS vendor_name,
             COUNT(oi.id) AS item_count,
             COALESCE(SUM(oi.quantity*oi.unit_price*(1.0-oi.discount/100.0)),0) AS subtotal,
             o.discount, o.discount2, o.discount3, o.discount4,
             COALESCE(SUM(oi.quantity*oi.unit_price*(1.0-oi.discount/100.0)),0)*(1.0-o.discount/100.0)*(1.0-COALESCE(o.discount2,0)/100.0)*(1.0-COALESCE(o.discount3,0)/100.0)*(1.0-COALESCE(o.discount4,0)/100.0) AS total,
             o.delivery_date, o.created_at, o.notes
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN users u ON o.created_by = u.id
      WHERE 1=1 ${vc} ${sc.clause}
      GROUP BY o.id ORDER BY o.order_sequence DESC
    `).all(...sc.params);

    orders.forEach(o => {
      const row = ws1.addRow({
        num: '#' + o.order_number, customer: o.customer_name,
        status: o.status, vendor: o.vendor_name,
        items: o.item_count, subtotal: o.subtotal,
        disc: [o.discount, o.discount2, o.discount3, o.discount4].filter(d => d > 0).join('+') + '%' || '0%', total: o.total,
        delivery: o.delivery_date || '', created: o.created_at, notes: o.notes || ''
      });
      row.getCell('subtotal').numFmt = currency;
      row.getCell('total').numFmt    = currency;
    });
    ws1.getRow(1).eachCell(c => { c.fill = hdrFill; c.font = hdrFont; c.alignment = { horizontal:'center' }; });
    ws1.views = [{ state:'frozen', ySplit:1 }];

    // Hoja 2: Top productos
    const ws2 = workbook.addWorksheet('Productos más vendidos');
    ws2.columns = [
      { header:'Producto',       key:'name',    width:34 },
      { header:'Cant. vendida',  key:'qty',     width:16 },
      { header:'Pedidos',        key:'orders',  width:12 },
      { header:'Total generado', key:'revenue', width:18 }
    ];
    const prods = db.prepare(`
      SELECT oi.product_name,
             SUM(oi.quantity) AS total_qty,
             COUNT(DISTINCT oi.order_id) AS order_count,
             SUM(oi.quantity*oi.unit_price*(1.0-oi.discount/100.0)) AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status != 'Cancelado' ${vc}
      GROUP BY LOWER(TRIM(oi.product_name))
      ORDER BY revenue DESC LIMIT 30
    `).all();
    prods.forEach(p => {
      const row = ws2.addRow({ name:p.product_name, qty:p.total_qty, orders:p.order_count, revenue:p.revenue });
      row.getCell('revenue').numFmt = currency;
    });
    ws2.getRow(1).eachCell(c => { c.fill = hdrFill; c.font = hdrFont; c.alignment = { horizontal:'center' }; });
    ws2.views = [{ state:'frozen', ySplit:1 }];

    // Hoja 3: Por vendedor (solo admin)
    if (!isVendor(req)) {
      const ws3 = workbook.addWorksheet('Por vendedor');
      ws3.columns = [
        { header:'Vendedor', key:'vendor',  width:26 },
        { header:'Pedidos',  key:'orders',  width:12 },
        { header:'Total',    key:'total',   width:18 }
      ];
      const vendors = db.prepare(`
        SELECT COALESCE(u.full_name, u.username, 'Sin asignar') AS vendor_name,
               COUNT(DISTINCT o.id) AS order_count,
               COALESCE(SUM(sub.t*(1.0-o.discount/100.0)*(1.0-COALESCE(o.discount2,0)/100.0)*(1.0-COALESCE(o.discount3,0)/100.0)*(1.0-COALESCE(o.discount4,0)/100.0)),0) AS total
        FROM orders o
        LEFT JOIN users u ON o.created_by = u.id
        LEFT JOIN (SELECT order_id, SUM(quantity*unit_price*(1.0-discount/100.0)) AS t FROM order_items GROUP BY order_id) sub ON sub.order_id = o.id
        WHERE o.status != 'Cancelado'
        GROUP BY o.created_by ORDER BY total DESC
      `).all();
      vendors.forEach(v => {
        const row = ws3.addRow({ vendor:v.vendor_name, orders:v.order_count, total:v.total });
        row.getCell('total').numFmt = currency;
      });
      ws3.getRow(1).eachCell(c => { c.fill = hdrFill; c.font = hdrFont; c.alignment = { horizontal:'center' }; });
    }

    const d = new Date();
    const dateStr = `${d.getDate()}-${d.getMonth()+1}-${d.getFullYear()}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reporte-${dateStr}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/print ────────────────────────────────────────────────────
router.get('/print', (req, res) => {
  try {
    const vc = vendorClause(req);
    const company  = getCompanyName();
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    const total = db.prepare(`SELECT COUNT(*) AS c FROM orders o WHERE 1=1 ${vc}`).get().c;
    const monthData = db.prepare(`
      SELECT COUNT(DISTINCT o.id) AS cnt,
             COALESCE(SUM(sub.t*(1.0-o.discount/100.0)*(1.0-COALESCE(o.discount2,0)/100.0)*(1.0-COALESCE(o.discount3,0)/100.0)*(1.0-COALESCE(o.discount4,0)/100.0)),0) AS sales
      FROM orders o
      LEFT JOIN (SELECT order_id, SUM(quantity*unit_price*(1.0-discount/100.0)) AS t FROM order_items GROUP BY order_id) sub ON sub.order_id=o.id
      WHERE o.created_at >= ? AND o.status != 'Cancelado' ${vc}
    `).get(monthStart);

    const topProds = db.prepare(`
      SELECT oi.product_name,
             SUM(oi.quantity) AS qty,
             COUNT(DISTINCT oi.order_id) AS orders,
             SUM(oi.quantity*oi.unit_price*(1.0-oi.discount/100.0)) AS revenue
      FROM order_items oi JOIN orders o ON o.id=oi.order_id
      WHERE o.status!='Cancelado' ${vc}
      GROUP BY LOWER(TRIM(oi.product_name)) ORDER BY revenue DESC LIMIT 15
    `).all();

    const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const monthName = `${months[now.getMonth()]} ${now.getFullYear()}`;
    const genDate   = `${now.getDate()}/${now.getMonth()+1}/${now.getFullYear()}`;

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Reporte — ${esc(company)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1e293b}
.page{padding:32px 40px;max-width:820px;margin:0 auto}
.no-print{text-align:right;margin-bottom:18px}
.print-btn{padding:9px 22px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600}
.header{text-align:center;padding-bottom:16px;border-bottom:2px solid #2563eb;margin-bottom:22px}
.header h1{font-size:24px;color:#2563eb}
.header p{color:#64748b;margin-top:4px}
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
.stat{border:1px solid #e2e8f0;border-radius:8px;padding:16px;text-align:center}
.stat-val{font-size:22px;font-weight:700;color:#2563eb}
.stat-lbl{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-top:4px}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:10px}
table{width:100%;border-collapse:collapse}
thead th{background:#2563eb;color:#fff;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;text-align:left}
th.r,td.r{text-align:right}
td{padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12.5px}
tr:nth-child(even) td{background:#f8fafc}
.footer{margin-top:32px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px}
@media print{.no-print{display:none}body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
</style></head><body>
<div class="page">
  <div class="no-print"><button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
  <div class="header">
    <h1>${esc(company)}</h1>
    <p>Reporte de ventas — ${esc(monthName)}</p>
  </div>
  <div class="stats-grid">
    <div class="stat"><div class="stat-val">${total}</div><div class="stat-lbl">Total pedidos</div></div>
    <div class="stat"><div class="stat-val">${monthData.cnt}</div><div class="stat-lbl">Pedidos en ${months[now.getMonth()]}</div></div>
    <div class="stat"><div class="stat-val">${fmtMoney(monthData.sales)}</div><div class="stat-lbl">Ventas en ${months[now.getMonth()]}</div></div>
  </div>
  <h3 style="margin-bottom:12px">Productos más vendidos</h3>
  <table>
    <thead><tr>
      <th>#</th><th>Producto</th>
      <th class="r">Cant.</th><th class="r">Pedidos</th><th class="r">Total</th>
    </tr></thead>
    <tbody>
      ${topProds.map((p,i) => `<tr>
        <td>${i+1}</td><td>${esc(p.product_name)}</td>
        <td class="r">${p.qty}</td><td class="r">${p.orders}</td>
        <td class="r"><strong>${fmtMoney(p.revenue)}</strong></td>
      </tr>`).join('')}
      ${topProds.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:20px">Sin datos</td></tr>' : ''}
    </tbody>
  </table>
  <div class="footer">Generado el ${genDate} — ${esc(company)}</div>
</div>
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400));</script>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).send(err.message); }
});

// ── GET /api/reports/units ── Unidades vendidas/entregadas por período ────────
// mode=sold (default) → status != Cancelado
// mode=delivered      → status IN ('Entregado','Entrega parcial')
function unitsStatusClause(mode) {
  return mode === 'delivered'
    ? "o.status IN ('Entregado','Entrega parcial')"
    : "o.status != 'Cancelado'";
}
function unitsReportLabel(mode) {
  return mode === 'delivered' ? 'Cantidades entregadas' : 'Cantidades vendidas';
}
function unitsColLabel(mode) {
  return mode === 'delivered' ? 'Unidades entregadas' : 'Unidades vendidas';
}

router.get('/units', (req, res) => {
  try {
    const vc   = vendorClause(req);
    const sc   = sucursalClause(req);
    const from = validateDate(req.query.from);
    const to   = validateDate(req.query.to);
    const mode = req.query.mode === 'delivered' ? 'delivered' : 'sold';
    const rows = db.prepare(`
      SELECT oi.product_name,
             SUM(oi.quantity) AS total_qty,
             COUNT(DISTINCT oi.order_id) AS order_count
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE ${unitsStatusClause(mode)}
        ${rangeClause('o', 'created_at', from, to)}
        ${vc} ${sc.clause}
      GROUP BY LOWER(TRIM(oi.product_name))
      ORDER BY total_qty DESC
    `).all(...rangeParams(from, to), ...sc.params);
    const totalUnits = rows.reduce((s, r) => s + (r.total_qty || 0), 0);
    const products = rows.map(r => ({
      ...r,
      pct: totalUnits > 0 ? Math.round(r.total_qty / totalUnits * 1000) / 10 : 0
    }));
    res.json({ products, total_units: totalUnits });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/units/excel ─────────────────────────────────────────────
router.get('/units/excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const vc   = vendorClause(req);
    const sc   = sucursalClause(req);
    const from = validateDate(req.query.from);
    const to   = validateDate(req.query.to);
    const mode = req.query.mode === 'delivered' ? 'delivered' : 'sold';
    const rows = db.prepare(`
      SELECT oi.product_name,
             SUM(oi.quantity) AS total_qty,
             COUNT(DISTINCT oi.order_id) AS order_count
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE ${unitsStatusClause(mode)}
        ${rangeClause('o', 'created_at', from, to)}
        ${vc} ${sc.clause}
      GROUP BY LOWER(TRIM(oi.product_name))
      ORDER BY total_qty DESC
    `).all(...rangeParams(from, to), ...sc.params);
    const totalUnits = rows.reduce((s, r) => s + (r.total_qty || 0), 0);
    const colLabel   = unitsColLabel(mode);
    const sheetName  = mode === 'delivered' ? 'Unidades entregadas' : 'Unidades vendidas';
    const fileSlug   = mode === 'delivered' ? 'entregadas' : 'vendidas';

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Gestor de Pedidos';
    const hdrFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF2563EB' } };
    const hdrFont = { bold:true, color:{ argb:'FFFFFFFF' }, size:11 };

    const ws = workbook.addWorksheet(sheetName);
    ws.columns = [
      { header:'#',        key:'rank',   width:6  },
      { header:'Producto', key:'name',   width:36 },
      { header:colLabel,   key:'qty',    width:22 },
      { header:'% del total', key:'pct', width:14 },
      { header:'Pedidos',  key:'orders', width:12 },
    ];
    rows.forEach((r, i) => {
      const pct = totalUnits > 0 ? Math.round(r.total_qty / totalUnits * 1000) / 10 : 0;
      ws.addRow({ rank: i+1, name: r.product_name, qty: r.total_qty, pct: pct + '%', orders: r.order_count });
    });
    ws.addRow({});
    const totRow = ws.addRow({ name: 'TOTAL', qty: totalUnits, pct: '100%' });
    totRow.font = { bold: true };
    ws.getRow(1).eachCell(c => { c.fill = hdrFill; c.font = hdrFont; c.alignment = { horizontal:'center' }; });
    ws.views = [{ state:'frozen', ySplit:1 }];

    const d = new Date();
    const dateStr = `${d.getDate()}-${d.getMonth()+1}-${d.getFullYear()}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="unidades-${fileSlug}-${dateStr}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/units/print ─────────────────────────────────────────────
router.get('/units/print', (req, res) => {
  try {
    const vc      = vendorClause(req);
    const sc      = sucursalClause(req);
    const from    = validateDate(req.query.from);
    const to      = validateDate(req.query.to);
    const mode    = req.query.mode === 'delivered' ? 'delivered' : 'sold';
    const company = getCompanyName();
    const rows = db.prepare(`
      SELECT oi.product_name,
             SUM(oi.quantity) AS total_qty,
             COUNT(DISTINCT oi.order_id) AS order_count
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE ${unitsStatusClause(mode)}
        ${rangeClause('o', 'created_at', from, to)}
        ${vc} ${sc.clause}
      GROUP BY LOWER(TRIM(oi.product_name))
      ORDER BY total_qty DESC
    `).all(...rangeParams(from, to), ...sc.params);
    const totalUnits  = rows.reduce((s, r) => s + (r.total_qty || 0), 0);
    const reportLabel = unitsReportLabel(mode);
    const colLabel    = unitsColLabel(mode);
    const periodLabel = from || to ? `${fmtDate(from) || '…'} al ${fmtDate(to) || '…'}` : 'Todo el período';
    const genDate = (() => { const d = new Date(); return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`; })();

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>${esc(reportLabel)} — ${esc(company)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1e293b}
.page{padding:32px 40px;max-width:720px;margin:0 auto}
.no-print{text-align:right;margin-bottom:18px}
.print-btn{padding:9px 22px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600}
.header{text-align:center;padding-bottom:16px;border-bottom:2px solid #2563eb;margin-bottom:22px}
.header h1{font-size:22px;color:#2563eb}
.header p{color:#64748b;margin-top:4px}
table{width:100%;border-collapse:collapse}
thead th{background:#2563eb;color:#fff;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;text-align:left}
th.r,td.r{text-align:right}
td{padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12.5px}
tr:nth-child(even) td{background:#f8fafc}
tfoot td{font-weight:700;border-top:2px solid #2563eb;padding-top:10px}
.footer{margin-top:28px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px}
@media print{.no-print{display:none}body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
</style></head><body>
<div class="page">
  <div class="no-print"><button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
  <div class="header">
    <h1>${esc(company)}</h1>
    <p>${esc(reportLabel)} — ${esc(periodLabel)}</p>
  </div>
  <table>
    <thead><tr>
      <th style="width:36px">#</th>
      <th>Producto</th>
      <th class="r" style="width:160px">${esc(colLabel)}</th>
      <th class="r" style="width:90px">% del total</th>
      <th class="r" style="width:80px">Pedidos</th>
    </tr></thead>
    <tbody>
      ${rows.map((r,i) => {
        const pct = totalUnits > 0 ? (r.total_qty / totalUnits * 100).toFixed(1) : '0.0';
        const qty = r.total_qty % 1 === 0 ? r.total_qty : r.total_qty.toFixed(2);
        return `<tr>
          <td>${i+1}</td>
          <td>${esc(r.product_name)}</td>
          <td class="r">${qty}</td>
          <td class="r">${pct}%</td>
          <td class="r">${r.order_count}</td>
        </tr>`;
      }).join('')}
      ${rows.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:20px">Sin datos</td></tr>' : ''}
    </tbody>
    <tfoot><tr>
      <td colspan="2" class="r">Total</td>
      <td class="r">${totalUnits % 1 === 0 ? totalUnits : totalUnits.toFixed(2)}</td>
      <td class="r">100%</td>
      <td class="r">${rows.reduce((s,r)=>s+r.order_count,0)}</td>
    </tr></tfoot>
  </table>
  <div class="footer">Generado el ${genDate} — ${esc(company)}</div>
</div>
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400));</script>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).send(err.message); }
});

// ── GET /api/reports/purchases ── Reporte de compras de materia prima ─────────
router.get('/purchases', (req, res) => {
  try {
    const from = validateDate(req.query.from);
    const to   = validateDate(req.query.to);

    const dateClause = [];
    const params = [];
    if (from) { dateClause.push("p.created_at >= ?"); params.push(from); }
    if (to)   { dateClause.push("p.created_at <= ?"); params.push(to + ' 23:59:59'); }
    const where = dateClause.length ? 'WHERE ' + dateClause.join(' AND ') : '';

    const purchases = db.prepare(`
      SELECT p.*, printf('C-%04d', p.purchase_sequence) AS purchase_number,
             s.name AS supplier_name
      FROM purchases p JOIN suppliers s ON p.supplier_id = s.id
      ${where}
      ORDER BY p.purchase_sequence DESC
    `).all(...params);

    const bySupplier = db.prepare(`
      SELECT s.name AS supplier_name, COUNT(*) AS qty, SUM(p.total) AS total
      FROM purchases p JOIN suppliers s ON p.supplier_id = s.id
      ${where}
      GROUP BY p.supplier_id ORDER BY total DESC
    `).all(...params);

    const byProduct = db.prepare(`
      SELECT pi.product_name, SUM(pi.quantity) AS total_qty, SUM(pi.quantity * pi.unit_price) AS total_amount
      FROM purchase_items pi
      JOIN purchases p ON pi.purchase_id = p.id
      ${where}
      GROUP BY LOWER(TRIM(pi.product_name))
      ORDER BY total_amount DESC
      LIMIT 50
    `).all(...params);

    const total      = purchases.reduce((s, p) => s + p.total, 0);
    const supplierCount = new Set(purchases.map(p => p.supplier_id)).size;
    const productCount  = byProduct.length;

    res.json({ purchases, bySupplier, byProduct, total, count: purchases.length, supplierCount, productCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/purchases/excel ── Excel de compras ─────────────────────
router.get('/purchases/excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const from = validateDate(req.query.from);
    const to   = validateDate(req.query.to);

    const dateClause = [];
    const params = [];
    if (from) { dateClause.push("p.created_at >= ?"); params.push(from); }
    if (to)   { dateClause.push("p.created_at <= ?"); params.push(to + ' 23:59:59'); }
    const where = dateClause.length ? 'WHERE ' + dateClause.join(' AND ') : '';

    const purchases = db.prepare(`
      SELECT p.*, printf('C-%04d', p.purchase_sequence) AS purchase_number,
             s.name AS supplier_name
      FROM purchases p JOIN suppliers s ON p.supplier_id = s.id
      ${where} ORDER BY p.purchase_sequence DESC
    `).all(...params);

    const items = db.prepare(`
      SELECT pi.*, p.purchase_sequence, printf('C-%04d', p.purchase_sequence) AS purchase_number,
             s.name AS supplier_name, p.doc_date, p.doc_type
      FROM purchase_items pi
      JOIN purchases p ON pi.purchase_id = p.id
      JOIN suppliers s ON p.supplier_id = s.id
      ${where} ORDER BY p.purchase_sequence DESC, pi.id ASC
    `).all(...params);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Candex Pro';
    const hdrFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF2563EB' } };
    const hdrFont = { color:{ argb:'FFFFFFFF' }, bold:true };

    // Hoja 1: Comprobantes
    const ws1 = workbook.addWorksheet('Comprobantes');
    ws1.columns = [
      { header:'N°',          key:'num',      width:10 },
      { header:'Proveedor',   key:'supplier', width:30 },
      { header:'Tipo',        key:'doc_type', width:14 },
      { header:'N° Doc.',     key:'doc_num',  width:16 },
      { header:'Fecha',       key:'date',     width:14 },
      { header:'Total ($)',   key:'total',    width:16 },
    ];
    ws1.getRow(1).eachCell(c => { c.fill = hdrFill; c.font = hdrFont; c.alignment = { horizontal:'center' }; });
    for (const p of purchases) {
      ws1.addRow({ num: p.purchase_number, supplier: p.supplier_name, doc_type: p.doc_type,
        doc_num: p.doc_number || '', date: p.doc_date || p.created_at?.slice(0,10) || '', total: p.total });
    }
    // Totals row
    ws1.addRow({});
    const totRow = ws1.addRow({ supplier: 'TOTAL', total: purchases.reduce((s,p)=>s+p.total,0) });
    totRow.font = { bold: true };
    ws1.getColumn('total').numFmt = '#,##0.00';

    // Hoja 2: Detalle ítems
    const ws2 = workbook.addWorksheet('Ítems de compra');
    ws2.columns = [
      { header:'Comprobante', key:'num',      width:12 },
      { header:'Proveedor',   key:'supplier', width:28 },
      { header:'Fecha',       key:'date',     width:14 },
      { header:'Producto',    key:'product',  width:32 },
      { header:'Cantidad',    key:'qty',      width:12 },
      { header:'Precio unit.',key:'price',    width:16 },
      { header:'Subtotal',    key:'subtotal', width:16 },
    ];
    ws2.getRow(1).eachCell(c => { c.fill = hdrFill; c.font = hdrFont; c.alignment = { horizontal:'center' }; });
    for (const it of items) {
      ws2.addRow({ num: it.purchase_number, supplier: it.supplier_name,
        date: it.doc_date || '', product: it.product_name,
        qty: it.quantity, price: it.unit_price, subtotal: it.quantity * it.unit_price });
    }
    ws2.getColumn('price').numFmt   = '#,##0.00';
    ws2.getColumn('subtotal').numFmt = '#,##0.00';

    const d = new Date();
    const dateStr = `${d.getDate()}-${d.getMonth()+1}-${d.getFullYear()}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="compras-${dateStr}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
