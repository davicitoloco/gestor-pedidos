const express = require('express');
const router = express.Router();
const { db, withTransaction } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  next();
}
router.use(requireAuth);

// GET /api/stock/alerts — products at or below minimum (todos los autenticados)
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

// GET /api/stock — lista de productos con stock (admin only)
router.get('/', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, name, base_price, stock, stock_min, active
      FROM products
      WHERE active = 1
      ORDER BY name ASC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stock/movements/:productId — historial de un producto (admin only)
router.get('/movements/:productId', requireAdmin, (req, res) => {
  try {
    const productId = Number(req.params.productId);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
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

// POST /api/stock/ingresos — registrar ingreso de mercadería (admin only)
router.post('/ingresos', requireAdmin, (req, res) => {
  try {
    const { product_id, quantity, notes } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Producto requerido' });
    const qty = parseFloat(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });

    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(Number(product_id));
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

    withTransaction(() => {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, Number(product_id));
      db.prepare(`
        INSERT INTO stock_movements (product_id, type, quantity, notes, created_by)
        VALUES (?, 'ingreso', ?, ?, ?)
      `).run(Number(product_id), qty, notes || '', req.session.userId);
    });

    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(product_id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
