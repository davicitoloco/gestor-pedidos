'use strict';
const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');

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
              AND o.status NOT IN ('Entregado', 'Cancelado')
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
    let where = '1=1';
    const params = [];
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
        INSERT INTO stock_movements (product_id, type, quantity, notes, previous_qty, new_qty, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, type, delta, note, prevQty, newQty, req.session.userId);
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
        INSERT INTO stock_movements (product_id, type, quantity, notes, previous_qty, new_qty, created_by)
        VALUES (?, 'ingreso', ?, ?, ?, ?, ?)
      `).run(Number(product_id), qty, notes || '', prevQty, newQty, req.session.userId);
    });

    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(product_id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
