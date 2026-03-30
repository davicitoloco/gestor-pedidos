const express = require('express');
const router = express.Router();
const { db } = require('../db');

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo los administradores pueden ver los reportes' });
  next();
}
router.use(requireAdmin);

function isVendor(req) { return req.session.role === 'vendedor'; }
function vendorClause(req) { return isVendor(req) ? `AND o.created_by = ${req.session.userId}` : ''; }

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

// ── GET /api/reports/stats ───────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  try {
    const vc = vendorClause(req);
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    const total = db.prepare(`SELECT COUNT(*) AS c FROM orders o WHERE 1=1 ${vc}`).get().c;

    const monthData = db.prepare(`
      SELECT COUNT(DISTINCT o.id) AS cnt, COALESCE(SUM(sub.t),0) AS sales
      FROM orders o
      LEFT JOIN (
        SELECT order_id, SUM(quantity*unit_price*(1.0-discount/100.0)) AS t
        FROM order_items GROUP BY order_id
      ) sub ON sub.order_id = o.id
      WHERE o.created_at >= ? AND o.status != 'Cancelado' ${vc}
    `).get(monthStart);

    const totalSales = db.prepare(`
      SELECT COALESCE(SUM(sub.t * (1.0 - o.discount/100.0)),0) AS s
      FROM orders o
      LEFT JOIN (
        SELECT order_id, SUM(quantity*unit_price*(1.0-discount/100.0)) AS t
        FROM order_items GROUP BY order_id
      ) sub ON sub.order_id = o.id
      WHERE o.status != 'Cancelado' ${vc}
    `).get().s;

    const monthSales = monthData.sales;
    const monthOrders = monthData.cnt;

    // Pedidos por estado
    const byStatus = db.prepare(`
      SELECT status, COUNT(*) AS cnt FROM orders o WHERE 1=1 ${vc} GROUP BY status
    `).all();

    res.json({
      total_orders: total,
      total_sales: totalSales,
      month_orders: monthOrders,
      month_sales: monthSales,
      avg_order: monthOrders > 0 ? monthSales / monthOrders : 0,
      by_status: byStatus
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/weekly ──────────────────────────────────────────────────
router.get('/weekly', (req, res) => {
  try {
    const vc = vendorClause(req);
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weeks = [];

    for (let i = 7; i >= 0; i--) {
      const mon = new Date(now);
      mon.setDate(now.getDate() - daysToMon - i * 7);
      mon.setHours(0, 0, 0, 0);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      sun.setHours(23, 59, 59);

      const start = localDateStr(mon);
      const end   = localDateStr(sun) + ' 23:59:59';
      const label = i === 0 ? 'Esta sem.' : `${mon.getDate()}/${mon.getMonth()+1}`;

      const row = db.prepare(`
        SELECT COUNT(DISTINCT o.id) AS cnt,
               COALESCE(SUM(sub.t*(1.0-o.discount/100.0)),0) AS total
        FROM orders o
        LEFT JOIN (
          SELECT order_id, SUM(quantity*unit_price*(1.0-discount/100.0)) AS t
          FROM order_items GROUP BY order_id
        ) sub ON sub.order_id = o.id
        WHERE o.created_at >= ? AND o.created_at <= ?
          AND o.status != 'Cancelado' ${vc}
      `).get(start, end);

      weeks.push({ label, count: row.cnt, total: row.total });
    }
    res.json(weeks);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/top-products ────────────────────────────────────────────
router.get('/top-products', (req, res) => {
  try {
    const vc = vendorClause(req);
    const rows = db.prepare(`
      SELECT
        oi.product_name,
        SUM(oi.quantity)                                           AS total_qty,
        COUNT(DISTINCT oi.order_id)                               AS order_count,
        SUM(oi.quantity * oi.unit_price * (1.0-oi.discount/100.0)) AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status != 'Cancelado' ${vc}
      GROUP BY LOWER(TRIM(oi.product_name))
      ORDER BY revenue DESC
      LIMIT 15
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/excel ────────────────────────────────────────────────────
router.get('/excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const vc = vendorClause(req);
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
             o.discount,
             COALESCE(SUM(oi.quantity*oi.unit_price*(1.0-oi.discount/100.0)),0)*(1.0-o.discount/100.0) AS total,
             o.delivery_date, o.created_at, o.notes
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN users u ON o.created_by = u.id
      WHERE 1=1 ${vc}
      GROUP BY o.id ORDER BY o.order_sequence DESC
    `).all();

    orders.forEach(o => {
      const row = ws1.addRow({
        num: '#' + o.order_number, customer: o.customer_name,
        status: o.status, vendor: o.vendor_name,
        items: o.item_count, subtotal: o.subtotal,
        disc: o.discount + '%', total: o.total,
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
               COALESCE(SUM(sub.t*(1.0-o.discount/100.0)),0) AS total
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
             COALESCE(SUM(sub.t*(1.0-o.discount/100.0)),0) AS sales
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

module.exports = router;
