const express = require('express');
const router = express.Router();
const { db } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  next();
}

router.use(requireAuth);

// GET /api/products — todos los autenticados pueden listar
router.get('/', (req, res) => {
  try {
    const all = req.query.all === '1';
    const rows = all
      ? db.prepare('SELECT * FROM products ORDER BY name ASC').all()
      : db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name ASC').all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/products — solo admin
router.post('/', requireAdmin, (req, res) => {
  try {
    const { name, base_price } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    const result = db.prepare('INSERT INTO products (name, base_price) VALUES (?, ?)').run(name.trim(), parseFloat(base_price) || 0);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(result.lastInsertRowid));
    res.status(201).json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/products/:id — solo admin
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Producto no encontrado' });
    const { name, base_price, active } = req.body;
    db.prepare('UPDATE products SET name = ?, base_price = ?, active = ? WHERE id = ?').run(
      name !== undefined ? name.trim() : existing.name,
      base_price !== undefined ? parseFloat(base_price) : existing.base_price,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      id
    );
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/products/:id — desactiva (no elimina)
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: 'Producto no encontrado' });
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
