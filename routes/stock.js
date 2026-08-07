'use strict';
const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');
const { getSucursalFilter, getInsertSucursalId } = require('../lib/sucursal');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (!['admin','subadmin'].includes(req.session.role)) return res.status(403).json({ error: 'Acceso denegado' });
  next();
}
router.use(requireAuth);

// GET /api/stock/alerts — productos en o por debajo del mínimo (todos los autenticados)
router.get('/alerts', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, name, stock, stock_min
      FROM products
      WHERE active = 1 AND stock_min > 0 AND stock <= stock_min
      ORDER BY stock ASC, name ASC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stock — artículos con stock actual, pedidos pendientes y diferencia (admin only)
router.get('/', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT *, (stock - pending_orders) AS difference FROM (
        SELECT p.id, p.name, p.stock, p.stock_min, p.active,
          COALESCE((
            SELECT SUM(oi.quantity)
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE oi.product_id = p.id
              AND o.status NOT IN ('Entregado', 'Entregado con devolución', 'Cancelado')
          ), 0) AS pending_orders,
          (SELECT sm.created_at
           FROM stock_movements sm
           WHERE sm.product_id = p.id
           ORDER BY sm.created_at DESC LIMIT 1) AS last_updated,
          (SELECT COALESCE(u.full_name, u.username)
           FROM stock_movements sm
           LEFT JOIN users u ON sm.created_by = u.id
           WHERE sm.product_id = p.id
           ORDER BY sm.created_at DESC LIMIT 1) AS last_updated_by
        FROM products p
        WHERE p.active = 1
      )
      ORDER BY difference ASC, name ASC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stock/movements — historial global filtrable (admin only)
router.get('/movements', requireAdmin, (req, res) => {
  try {
    const { product_id, date_from, date_to, page = 1, per_page = 50 } = req.query;
    const sf = getSucursalFilter(req, 'sm');
    let where = `1=1 ${sf.clause}`;
    const params = [...sf.params];
    if (product_id) { where += ' AND sm.product_id = ?'; params.push(Number(product_id)); }
    if (date_from)  { where += " AND DATE(sm.created_at) >= ?"; params.push(date_from); }
    if (date_to)    { where += " AND DATE(sm.created_at) <= ?"; params.push(date_to); }

    const total  = db.prepare(`SELECT COUNT(*) AS c FROM stock_movements sm WHERE ${where}`).get(...params).c;
    const offset = (Number(page) - 1) * Number(per_page);
    const movements = db.prepare(`
      SELECT sm.*, p.name AS product_name,
        COALESCE(u.full_name, u.username) AS user_name
      FROM stock_movements sm
      JOIN products p ON sm.product_id = p.id
      LEFT JOIN users u ON sm.created_by = u.id
      WHERE ${where}
      ORDER BY sm.created_at DESC, sm.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(per_page), offset);

    res.json({ total, page: Number(page), per_page: Number(per_page), movements });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stock/movements/:productId — historial de un producto (admin only)
router.get('/movements/:productId', requireAdmin, (req, res) => {
  try {
    const productId = Number(req.params.productId);
    const product   = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
    const movements = db.prepare(`
      SELECT sm.*, COALESCE(u.full_name, u.username) AS user_name
      FROM stock_movements sm
      LEFT JOIN users u ON sm.created_by = u.id
      WHERE sm.product_id = ?
      ORDER BY sm.created_at DESC
    `).all(productId);
    res.json({ product, movements });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/stock/:article_id — ajuste manual de stock (admin only)
router.put('/:article_id', requireAdmin, (req, res) => {
  try {
    const id      = Number(req.params.article_id);
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(id);
    if (!product) return res.status(404).json({ error: 'Artículo no encontrado' });

    const newQty = parseFloat(req.body.quantity);
    if (isNaN(newQty) || newQty < 0) return res.status(400).json({ error: 'Cantidad inválida' });

    const prevQty = product.stock;
    const delta   = Math.abs(newQty - prevQty);
    const type    = newQty >= prevQty ? 'ajuste_entrada' : 'ajuste_salida';
    const note    = (req.body.note || '').trim();

    withTransaction(() => {
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newQty, id);
      db.prepare(`
        INSERT INTO stock_movements (product_id, type, quantity, notes, previous_qty, new_qty, created_by, sucursal_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, type, delta, note, prevQty, newQty, req.session.userId, getInsertSucursalId(req));
    });

    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/stock/ingresos — registrar ingreso de mercadería (admin only)
router.post('/ingresos', requireAdmin, (req, res) => {
  try {
    const { product_id, quantity, notes } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Producto requerido' });
    const qty = parseFloat(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });

    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(Number(product_id));
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

    const prevQty = product.stock;
    const newQty  = prevQty + qty;

    withTransaction(() => {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, Number(product_id));
      db.prepare(`
        INSERT INTO stock_movements (product_id, type, quantity, notes, previous_qty, new_qty, created_by, sucursal_id)
        VALUES (?, 'ingreso', ?, ?, ?, ?, ?, ?)
      `).run(Number(product_id), qty, notes || '', prevQty, newQty, req.session.userId, getInsertSucursalId(req));
    });

    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(product_id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stock/repairs — ítems en reparación + historial + resumen (admin only)
router.get('/repairs', requireAdmin, (req, res) => {
  try {
    const sf = getSucursalFilter(req, 'rs');
    const rows = db.prepare(`
      SELECT rs.*, printf('%03d', o.order_sequence) AS order_number,
        COALESCE(ru.full_name, ru.username) AS repaired_by_name
      FROM repair_stock rs
      JOIN orders o ON rs.origin_order_id = o.id
      LEFT JOIN users ru ON rs.repaired_by = ru.id
      WHERE 1=1 ${sf.clause}
      ORDER BY (rs.status = 'en_reparacion') DESC, rs.created_at DESC
    `).all(...sf.params);

    const pending = rows.filter(r => r.status === 'en_reparacion');
    const monthPrefix = new Date().toISOString().slice(0, 7);
    const repairedThisMonth = rows.filter(r => r.status === 'reparado' && (r.repaired_at || '').startsWith(monthPrefix));

    res.json({
      items: rows,
      summary: {
        pending_count: pending.length,
        pending_qty: pending.reduce((s, r) => s + r.quantity, 0),
        repaired_month_count: repairedThisMonth.length,
        repaired_month_qty: repairedThisMonth.reduce((s, r) => s + r.quantity, 0)
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/stock/repairs/:id/complete — marcar ítem como reparado y sumar al stock (admin only)
router.put('/repairs/:id/complete', requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const repair = db.prepare('SELECT * FROM repair_stock WHERE id = ?').get(id);
    if (!repair) return res.status(404).json({ error: 'Registro de reparación no encontrado' });
    if (repair.status === 'reparado') return res.status(400).json({ error: 'Este ítem ya fue marcado como reparado' });

    const notes = (req.body.notes_repair || '').trim();
    withTransaction(() => {
      if (repair.product_id) {
        const order = db.prepare('SELECT order_sequence FROM orders WHERE id = ?').get(repair.origin_order_id);
        const orderNumber = order ? String(order.order_sequence).padStart(3, '0') : String(repair.origin_order_id).padStart(3, '0');
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(repair.quantity, repair.product_id);
        db.prepare(`
          INSERT INTO stock_movements (product_id, type, quantity, reference, notes, created_by, sucursal_id)
          VALUES (?, 'ingreso', ?, ?, ?, ?, ?)
        `).run(repair.product_id, repair.quantity, `Reparación completada (pedido #${orderNumber})`, notes, req.session.userId, getInsertSucursalId(req));
      }
      db.prepare(`
        UPDATE repair_stock SET status='reparado', repaired_at=datetime('now','localtime'), repaired_by=?, notes_repair=?
        WHERE id=?
      `).run(req.session.userId, notes, id);
    });

    res.json(db.prepare('SELECT * FROM repair_stock WHERE id = ?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
