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
function isFabrica(req) { return req.session.role === 'fabrica'; }
function canAccessMP(req) { return isAdmin(req) || isFabrica(req); }

function requireMP(req, res, next) {
  if (!canAccessMP(req)) return res.status(403).json({ error: 'Sin acceso' });
  next();
}
router.use(requireMP);

// GET /api/mp-orders
router.get('/', (req, res) => {
  try {
    const { estado } = req.query;
    const estadoFilter = (estado && estado !== 'todos') ? `AND o.estado = '${estado.replace(/'/g,"''")}' ` : '';
    const ownerFilter  = isFabrica(req) ? `AND o.created_by = ${req.session.userId}` : '';
    const rows = db.prepare(`
      SELECT o.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM mp_orders o
      LEFT JOIN users u ON o.created_by = u.id
      WHERE 1=1 ${estadoFilter} ${ownerFilter}
      ORDER BY o.id DESC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/mp-orders/:id
router.get('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare(`
      SELECT o.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM mp_orders o LEFT JOIN users u ON o.created_by = u.id
      WHERE o.id = ?
    `).get(id);
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
    const { fecha, proveedor, notas, items } = req.body;
    if (!fecha)    return res.status(400).json({ error: 'La fecha es requerida' });
    if (!proveedor || !proveedor.trim()) return res.status(400).json({ error: 'El proveedor es requerido' });

    const newId = withTransaction(() => {
      const { lastInsertRowid } = db.prepare(
        `INSERT INTO mp_orders (fecha, proveedor, notas, estado, created_by) VALUES (?,?,?,?,?)`
      ).run(fecha, proveedor.trim(), notas || '', 'pendiente', req.session.userId);
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

    const order = db.prepare('SELECT * FROM mp_orders WHERE id=?').get(newId);
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
    const order = db.prepare('SELECT id FROM mp_orders WHERE id=?').get(id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    db.prepare(`UPDATE mp_orders SET estado=? WHERE id=?`).run(estado, id);
    res.json(db.prepare('SELECT * FROM mp_orders WHERE id=?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/mp-orders/:id  — admin only
router.delete('/:id', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Solo el admin puede eliminar pedidos' });
    const id = Number(req.params.id);
    db.prepare('DELETE FROM mp_orders WHERE id=?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/mp-orders/:id/print  — PDF
router.get('/:id/print', (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare(`
      SELECT o.*, COALESCE(u.full_name, u.username) AS created_by_name
      FROM mp_orders o LEFT JOIN users u ON o.created_by = u.id WHERE o.id=?
    `).get(id);
    if (!order) return res.status(404).send('Pedido no encontrado');
    if (isFabrica(req) && order.created_by !== req.session.userId)
      return res.status(403).send('Sin acceso');
    const items = db.prepare('SELECT * FROM mp_order_items WHERE mp_order_id=? ORDER BY seccion, id').all(id);

    const SECTION_NAMES = [
      'C/Frnts', 'Frentes', 'Cremallera', 'Sup. Cremallera', 'Cajas',
      'Tapas', 'Palanca', 'Combinaciones', 'Ac. Inox / Varios', 'Varios'
    ];
    const ESTADO_LABELS = { pendiente: 'Pendiente', realizado: 'Realizado', entregado: 'Entregado' };

    const grouped = {};
    for (const it of items) {
      if (!grouped[it.seccion]) grouped[it.seccion] = [];
      grouped[it.seccion].push(it);
    }

    function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function fmtDate(d) { if (!d) return '—'; const [y,m,day] = String(d).split('-'); return `${day}/${m}/${y}`; }

    let sectionsHtml = '';
    for (const [secNum, secItems] of Object.entries(grouped)) {
      const name = SECTION_NAMES[Number(secNum) - 1] || `Sección ${secNum}`;
      sectionsHtml += `
        <div class="section">
          <div class="section-title">${esc(name)}</div>
          <table>
            <thead><tr><th>Descripción</th><th class="qty">Cantidad</th><th class="qty">Unidad</th></tr></thead>
            <tbody>
              ${secItems.map(it => `<tr>
                <td>${esc(it.descripcion)}</td>
                <td class="qty">${it.cantidad != null ? it.cantidad : '—'}</td>
                <td class="qty">${esc(it.unidad)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Pedido MP #${order.id}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; margin: 0; padding: 16px; color: #111; }
  .header { text-align: center; margin-bottom: 16px; border-bottom: 2px solid #333; padding-bottom: 10px; }
  .header h1 { font-size: 18px; margin: 0 0 4px; }
  .header h2 { font-size: 13px; margin: 0; font-weight: normal; color: #555; }
  .meta { display: flex; gap: 24px; margin-bottom: 14px; flex-wrap: wrap; }
  .meta div { min-width: 120px; }
  .meta label { font-size: 9px; text-transform: uppercase; color: #888; display: block; }
  .meta p { margin: 0; font-weight: 600; }
  .section { margin-bottom: 14px; page-break-inside: avoid; }
  .section-title { background: #f0f0f0; padding: 4px 8px; font-weight: 700; font-size: 11px; border-left: 3px solid #333; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th { background: #e8e8e8; padding: 3px 6px; text-align: left; border: 1px solid #ccc; }
  td { padding: 3px 6px; border: 1px solid #ddd; }
  .qty { width: 70px; text-align: right; }
  .notes { margin-top: 12px; padding: 8px; border: 1px solid #ddd; font-size: 10px; }
  .footer { margin-top: 16px; font-size: 9px; color: #888; border-top: 1px solid #ddd; padding-top: 6px; text-align: right; }
  .no-print { text-align: center; margin-bottom: 12px; }
  .print-btn { padding: 8px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
  @media print { .no-print { display: none; } }
</style></head><body>
<div class="no-print"><button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
<div class="header">
  <h1>Pedido de Materia Prima</h1>
  <h2>Gestión de Pedidos</h2>
</div>
<div class="meta">
  <div><label>N° Pedido</label><p>#${order.id}</p></div>
  <div><label>Fecha</label><p>${fmtDate(order.fecha)}</p></div>
  <div><label>Proveedor</label><p>${esc(order.proveedor)}</p></div>
  <div><label>Estado</label><p>${ESTADO_LABELS[order.estado] || esc(order.estado)}</p></div>
  <div><label>Creado por</label><p>${esc(order.created_by_name)}</p></div>
</div>
${sectionsHtml}
${order.notas ? `<div class="notes"><strong>Notas:</strong> ${esc(order.notas)}</div>` : ''}
<div class="footer">Generado el ${new Date().toLocaleString('es-AR')}</div>
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400));<\/script>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).send(err.message); }
});

module.exports = router;
