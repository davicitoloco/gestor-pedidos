'use strict';
const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
router.use(requireAuth);

function isAdmin(req)   { return req.session.role === 'admin'; }
function isFabrica(req) { return req.session.role === 'mp'; }
function canAccessMP(req) { return isAdmin(req) || isFabrica(req); }

function requireMP(req, res, next) {
  if (!canAccessMP(req)) return res.status(403).json({ error: 'Sin acceso' });
  next();
}
router.use(requireMP);

const ORDER_SELECT = `
  SELECT o.*,
    COALESCE(u.full_name, u.username) AS created_by_name,
    s.name AS supplier_name
  FROM mp_orders o
  LEFT JOIN users u ON o.created_by = u.id
  LEFT JOIN suppliers s ON o.supplier_id = s.id
`;

// GET /api/mp-orders
router.get('/', (req, res) => {
  try {
    const { estado } = req.query;
    const estadoFilter = (estado && estado !== 'todos') ? `AND o.estado = ?` : '';
    const ownerFilter  = isFabrica(req) ? `AND o.created_by = ${req.session.userId}` : '';
    const params = [];
    if (estado && estado !== 'todos') params.push(estado);
    const rows = db.prepare(`${ORDER_SELECT} WHERE 1=1 ${estadoFilter} ${ownerFilter} ORDER BY o.id DESC`).all(...params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/mp-orders/report  — admin only
router.get('/report', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Solo el admin puede ver reportes' });
    const { desde, hasta, supplier_id } = req.query;
    const params = [];
    let filters = `AND o.estado = 'entregado'`;
    if (desde) { filters += ` AND o.fecha >= ?`; params.push(desde); }
    if (hasta) { filters += ` AND o.fecha <= ?`; params.push(hasta); }
    if (supplier_id) { filters += ` AND o.supplier_id = ?`; params.push(Number(supplier_id)); }

    const orders = db.prepare(`${ORDER_SELECT} WHERE 1=1 ${filters} ORDER BY o.fecha DESC`).all(...params);
    const result = orders.map(o => {
      const items = db.prepare('SELECT * FROM mp_order_items WHERE mp_order_id=? ORDER BY seccion,id').all(o.id);
      const seccionMap = {};
      for (const it of items) {
        if (!seccionMap[it.seccion]) seccionMap[it.seccion] = 0;
        seccionMap[it.seccion]++;
      }
      return { ...o, items, seccionMap };
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/mp-orders/:id
router.get('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (isFabrica(req) && order.created_by !== req.session.userId)
      return res.status(403).json({ error: 'Sin acceso' });
    const items = db.prepare('SELECT * FROM mp_order_items WHERE mp_order_id = ? ORDER BY seccion, id').all(id);
    res.json({ ...order, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/mp-orders
router.post('/', (req, res) => {
  try {
    const { fecha, supplier_id, notas, items } = req.body;
    if (!fecha) return res.status(400).json({ error: 'La fecha es requerida' });
    if (!supplier_id) return res.status(400).json({ error: 'El proveedor es requerido' });
    const supplier = db.prepare('SELECT id, name FROM suppliers WHERE id=? AND active=1').get(Number(supplier_id));
    if (!supplier) return res.status(400).json({ error: 'Proveedor no encontrado' });

    const newId = withTransaction(() => {
      const { lastInsertRowid } = db.prepare(
        `INSERT INTO mp_orders (fecha, proveedor, supplier_id, notas, estado, created_by) VALUES (?,?,?,?,?,?)`
      ).run(fecha, supplier.name, Number(supplier_id), notas || '', 'pendiente', req.session.userId);
      const oid = Number(lastInsertRowid);
      if (Array.isArray(items) && items.length) {
        const ins = db.prepare(
          `INSERT INTO mp_order_items (mp_order_id, seccion, descripcion, cantidad, unidad, notas) VALUES (?,?,?,?,?,?)`
        );
        for (const it of items) {
          if (it.cantidad != null && it.cantidad !== '' && it.descripcion) {
            ins.run(oid, it.seccion, it.descripcion, parseFloat(it.cantidad) || 0, it.unidad || 'kg', it.notas || '');
          }
        }
      }
      return oid;
    });

    const order = db.prepare(`${ORDER_SELECT} WHERE o.id=?`).get(newId);
    const savedItems = db.prepare('SELECT * FROM mp_order_items WHERE mp_order_id=? ORDER BY seccion, id').all(newId);
    res.status(201).json({ ...order, items: savedItems });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/mp-orders/:id/estado  — admin only
router.put('/:id/estado', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Solo el admin puede cambiar el estado' });
    const id = Number(req.params.id);
    const { estado } = req.body;
    const VALID = ['pendiente', 'realizado', 'entregado'];
    if (!VALID.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    if (!db.prepare('SELECT id FROM mp_orders WHERE id=?').get(id))
      return res.status(404).json({ error: 'Pedido no encontrado' });
    db.prepare(`UPDATE mp_orders SET estado=? WHERE id=?`).run(estado, id);
    res.json(db.prepare(`${ORDER_SELECT} WHERE o.id=?`).get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/mp-orders/:id  — admin only
router.delete('/:id', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Solo el admin puede eliminar pedidos' });
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM mp_orders WHERE id=?').get(id))
      return res.status(404).json({ error: 'Pedido no encontrado' });
    // mp_order_items se eliminan por ON DELETE CASCADE
    db.prepare('DELETE FROM mp_orders WHERE id=?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/mp-orders/:id/print  — PDF individual
router.get('/:id/print', (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare(`${ORDER_SELECT} WHERE o.id=?`).get(id);
    if (!order) return res.status(404).send('Pedido no encontrado');
    if (isFabrica(req) && order.created_by !== req.session.userId)
      return res.status(403).send('Sin acceso');
    const items = db.prepare('SELECT * FROM mp_order_items WHERE mp_order_id=? ORDER BY seccion, id').all(id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildPrintHtml([{ ...order, items }], `Pedido MP #${order.id}`));
  } catch (err) { res.status(500).send(err.message); }
});

// GET /api/mp-orders/report/print  — PDF reporte (admin only)
router.get('/report/print', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).send('Sin acceso');
    const { desde, hasta, supplier_id } = req.query;
    const params = [];
    let filters = `AND o.estado = 'entregado'`;
    if (desde) { filters += ` AND o.fecha >= ?`; params.push(desde); }
    if (hasta) { filters += ` AND o.fecha <= ?`; params.push(hasta); }
    if (supplier_id) { filters += ` AND o.supplier_id = ?`; params.push(Number(supplier_id)); }
    const orders = db.prepare(`${ORDER_SELECT} WHERE 1=1 ${filters} ORDER BY o.fecha DESC`).all(...params);
    const full = orders.map(o => ({
      ...o,
      items: db.prepare('SELECT * FROM mp_order_items WHERE mp_order_id=? ORDER BY seccion,id').all(o.id)
    }));
    const title = `Reporte MP Entregados${desde||hasta ? ` (${desde||''}${hasta?' al '+hasta:''})` : ''}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildPrintHtml(full, title, true));
  } catch (err) { res.status(500).send(err.message); }
});

/* ── helpers ── */
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(d) { if (!d) return '—'; const [y,m,day] = String(d).split('-'); return `${day}/${m}/${y}`; }

const SECTION_NAMES = [
  'C/Frnts', 'Frentes', 'Cremallera', 'Sup. Cremallera', 'Cajas',
  'Tapas', 'Palanca', 'Combinaciones', 'Ac. Inox / Varios', 'Varios',
  'Bronce — Nuez', 'Bronce — Pestillo', 'Bronce — Llaves'
];
const BRONCE_SUBSECTIONS = { 11: 'Nuez', 12: 'Pestillo', 13: 'Llaves' };
const ESTADO_LABELS = { pendiente: 'Pendiente', realizado: 'Realizado', entregado: 'Entregado' };

function buildPrintHtml(orders, title, isReport = false) {
  const ordersHtml = orders.map(order => {
    const grouped = {};
    for (const it of (order.items || [])) {
      if (!grouped[it.seccion]) grouped[it.seccion] = [];
      grouped[it.seccion].push(it);
    }
    let sectionsHtml = '';
    const bronceNums = new Set([11, 12, 13]);
    let bronceAdded = false;
    for (const [secNum, secItems] of Object.entries(grouped)) {
      const n = Number(secNum);
      if (bronceNums.has(n)) {
        if (!bronceAdded) {
          bronceAdded = true;
          const bronceSubs = [11, 12, 13].map(bn => {
            const items = grouped[bn] || [];
            if (!items.length) return '';
            return `<div style="margin-bottom:8px">
              <div style="font-size:10px;font-weight:700;padding:3px 0 3px 4px;color:#555;border-left:2px solid #bbb;margin-bottom:3px">${BRONCE_SUBSECTIONS[bn]}</div>
              <table><thead><tr><th>Modelo</th><th class="qty">Cantidad</th></tr></thead>
              <tbody>${items.map(it => `<tr><td>${esc(it.descripcion)}</td><td class="qty">${it.cantidad != null ? it.cantidad : '—'}</td></tr>`).join('')}</tbody></table>
            </div>`;
          }).join('');
          sectionsHtml += `<div class="section"><div class="section-title">Bronce</div>${bronceSubs}</div>`;
        }
        continue;
      }
      const name = SECTION_NAMES[n - 1] || `Sección ${secNum}`;
      sectionsHtml += `<div class="section">
        <div class="section-title">${esc(name)}</div>
        <table><thead><tr><th>Descripción</th><th class="qty">Cantidad</th><th class="qty">Unidad</th></tr></thead>
        <tbody>${secItems.map(it => `<tr>
          <td>${esc(it.descripcion)}</td>
          <td class="qty">${it.cantidad != null ? it.cantidad : '—'}</td>
          <td class="qty">${esc(it.unidad)}</td>
        </tr>`).join('')}</tbody></table></div>`;
    }
    const provName = order.supplier_name || order.proveedor || '—';
    return `${isReport ? `<div class="order-block">` : ''}
      <div class="meta">
        <div><label>N° Pedido</label><p>#${order.id}</p></div>
        <div><label>Fecha</label><p>${fmtDate(order.fecha)}</p></div>
        <div><label>Proveedor</label><p>${esc(provName)}</p></div>
        <div><label>Estado</label><p>${ESTADO_LABELS[order.estado] || esc(order.estado)}</p></div>
        <div><label>Creado por</label><p>${esc(order.created_by_name||'—')}</p></div>
      </div>
      ${sectionsHtml}
      ${order.notas ? `<div class="notes"><strong>Notas:</strong> ${esc(order.notas)}</div>` : ''}
      ${isReport ? `</div><hr class="page-sep">` : ''}`;
  }).join('');

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>${esc(title)}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:11px;margin:0;padding:16px;color:#111}
  h1{font-size:18px;margin:0 0 4px;text-align:center}
  h2{font-size:13px;margin:0 0 14px;text-align:center;font-weight:normal;color:#555}
  .meta{display:flex;gap:20px;margin-bottom:12px;flex-wrap:wrap;border-bottom:1px solid #ddd;padding-bottom:10px}
  .meta div{min-width:100px} .meta label{font-size:9px;text-transform:uppercase;color:#888;display:block} .meta p{margin:0;font-weight:600}
  .section{margin-bottom:12px;page-break-inside:avoid}
  .section-title{background:#f0f0f0;padding:4px 8px;font-weight:700;font-size:11px;border-left:3px solid #333;margin-bottom:4px}
  table{width:100%;border-collapse:collapse;font-size:10px}
  th{background:#e8e8e8;padding:3px 6px;text-align:left;border:1px solid #ccc}
  td{padding:3px 6px;border:1px solid #ddd}
  .qty{width:70px;text-align:right}
  .notes{margin-top:10px;padding:8px;border:1px solid #ddd;font-size:10px}
  .order-block{margin-bottom:20px}
  .page-sep{border:none;border-top:2px dashed #bbb;margin:16px 0}
  .footer{margin-top:16px;font-size:9px;color:#888;border-top:1px solid #ddd;padding-top:6px;text-align:right}
  .no-print{text-align:center;margin-bottom:12px}
  .print-btn{padding:8px 20px;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px}
  .summary{background:#f8f8f8;border:1px solid #ddd;padding:8px 12px;margin-bottom:14px;font-size:11px}
  @media print{.no-print{display:none}}
</style></head><body>
<div class="no-print"><button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
<h1>${esc(title)}</h1>
<h2>Gestión de Pedidos</h2>
${isReport ? `<div class="summary"><strong>Total pedidos entregados:</strong> ${orders.length}</div>` : ''}
${ordersHtml}
<div class="footer">Generado el ${new Date().toLocaleString('es-AR')}</div>
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400));<\/script>
</body></html>`;
}

module.exports = router;
