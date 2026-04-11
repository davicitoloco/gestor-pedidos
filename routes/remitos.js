const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
router.use(requireAuth);

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtMoney(n) {
  return '$\u202f' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDateTime(s) { if (!s) return '—'; return String(s).replace('T', ' ').substring(0, 16); }
function getCompanyName() {
  const r = db.prepare("SELECT value FROM settings WHERE key='company_name'").get();
  return r ? r.value : 'Mi Empresa';
}

// ── GET /api/remitos/customer/:customerId ──────────────────────────────────────
router.get('/customer/:customerId', (req, res) => {
  try {
    const cid  = Number(req.params.customerId);
    const rows = db.prepare(`
      SELECT r.*, printf('R-%03d', r.remito_sequence) AS remito_number,
             printf('%03d', o.order_sequence) AS order_number
      FROM remitos r
      JOIN orders o ON r.order_id = o.id
      WHERE r.customer_id = ?
      ORDER BY r.remito_sequence DESC
    `).all(cid);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/remitos/:id/print ─────────────────────────────────────────────────
router.get('/:id/print', (req, res) => {
  try {
    const id     = Number(req.params.id);
    const remito = db.prepare(`
      SELECT r.*, printf('R-%03d', r.remito_sequence) AS remito_number,
             printf('%03d', o.order_sequence) AS order_number,
             o.discount AS order_discount
      FROM remitos r
      JOIN orders o ON r.order_id = o.id
      WHERE r.id = ?
    `).get(id);
    if (!remito) return res.status(404).send('Remito no encontrado');

    const items   = db.prepare('SELECT * FROM remito_items WHERE remito_id = ? ORDER BY id').all(id);
    const company = getCompanyName();
    const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price * (1 - i.discount / 100), 0);
    const discAmt  = subtotal * (remito.order_discount || 0) / 100;

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>${esc(remito.remito_number)} — ${esc(company)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1e293b;background:#fff}
.page{padding:32px 40px;max-width:820px;margin:0 auto}
.no-print{text-align:right;margin-bottom:18px}
.print-btn{padding:9px 22px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600}
.header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:18px;border-bottom:2px solid #2563eb;margin-bottom:22px}
.header-left h1{font-size:22px;color:#2563eb;font-weight:700}
.header-left p{font-size:12px;color:#64748b;margin-top:2px;text-transform:uppercase;letter-spacing:.06em}
.header-right{text-align:right}
.remito-num{font-size:26px;font-weight:700;color:#1e293b;letter-spacing:.02em}
.remito-date{font-size:12px;color:#64748b;margin-top:4px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 30px;margin-bottom:26px;padding:14px 16px;background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0}
.info-item label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:3px}
.info-item p{font-size:13px;font-weight:500}
h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:10px}
table{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:12.5px}
thead th{background:#2563eb;color:#fff;padding:8px 10px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
thead th.r{text-align:right}
tbody td{padding:8px 10px;border-bottom:1px solid #e2e8f0}
tbody td.r{text-align:right}
tbody tr:nth-child(even) td{background:#f8fafc}
.totals-wrap{display:flex;justify-content:flex-end}
.totals{width:280px;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden}
.totals tr td{padding:8px 14px;border-bottom:1px solid #e2e8f0;font-size:13px}
.totals tr:last-child td{border-bottom:none}
.totals .t-final td{font-weight:700;font-size:15px;color:#2563eb;background:#eff6ff;border-top:2px solid #2563eb}
.t-label{color:#64748b}
.t-val{text-align:right;font-weight:600}
.firma-row{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:50px}
.firma-box{border-top:1px solid #94a3b8;padding-top:8px;font-size:11px;color:#64748b;text-align:center}
.footer{margin-top:32px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:14px}
@media print{.no-print{display:none}body{print-color-adjust:exact;-webkit-print-color-adjust:exact}.page{padding:20px}}
</style></head><body>
<div class="page">
  <div class="no-print">
    <button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
  </div>
  <div class="header">
    <div class="header-left">
      <h1>${esc(company)}</h1>
      <p>Remito de entrega</p>
    </div>
    <div class="header-right">
      <div class="remito-num">${esc(remito.remito_number)}</div>
      <div class="remito-date">${fmtDateTime(remito.created_at)}</div>
    </div>
  </div>
  <div class="info-grid">
    <div class="info-item"><label>Cliente</label><p>${esc(remito.customer_name)}</p></div>
    <div class="info-item"><label>Condición IVA</label><p>${esc(remito.customer_iva)}</p></div>
    <div class="info-item"><label>Pedido de referencia</label><p>#${esc(remito.order_number)}</p></div>
    <div class="info-item"><label>Fecha de emisión</label><p>${fmtDateTime(remito.created_at)}</p></div>
  </div>
  <h3>Detalle de mercadería entregada</h3>
  <table>
    <thead><tr>
      <th>Producto / Descripción</th>
      <th class="r" style="width:80px">Cant.</th>
      <th class="r" style="width:120px">Precio unit.</th>
      <th class="r" style="width:70px">Dto.</th>
      <th class="r" style="width:120px">Subtotal</th>
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
      ${remito.order_discount > 0 ? `
      <tr><td class="t-label">Subtotal</td><td class="t-val">${fmtMoney(subtotal)}</td></tr>
      <tr><td class="t-label">Descuento (${remito.order_discount}%)</td><td class="t-val" style="color:#ef4444">−${fmtMoney(discAmt)}</td></tr>
      ` : ''}
      <tr class="t-final"><td>TOTAL</td><td class="t-val">${fmtMoney(remito.total)}</td></tr>
    </table>
  </div>
  <div class="firma-row">
    <div class="firma-box">Firma y aclaración — Receptor</div>
    <div class="firma-box">Firma y aclaración — ${esc(company)}</div>
  </div>
  <div class="footer">Generado el ${fmtDateTime(new Date().toISOString().replace('T',' ').substring(0,19))} — ${esc(company)}</div>
</div>
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400));</script>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).send(err.message); }
});

module.exports = router;
