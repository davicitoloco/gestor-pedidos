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

// GET /api/products — todos los autenticados pueden listar
router.get('/', (req, res) => {
  try {
    const isVendor = req.session.role === 'vendedor';
    const all = req.query.all === '1';
    const rows = all
      ? db.prepare('SELECT * FROM products ORDER BY name ASC').all()
      : db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name ASC').all();
    if (isVendor) rows.forEach(r => { r.stock = null; r.stock_min = null; });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/products — solo admin
router.post('/', requireAdmin, (req, res) => {
  try {
    const { name, base_price, stock_min } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    const result = db.prepare('INSERT INTO products (name, base_price, stock_min) VALUES (?, ?, ?)').run(
      name.trim(), parseFloat(base_price) || 0, parseInt(stock_min) || 0
    );
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
    const { name, base_price, active, stock_min } = req.body;
    db.prepare('UPDATE products SET name = ?, base_price = ?, active = ?, stock_min = ? WHERE id = ?').run(
      name !== undefined ? name.trim() : existing.name,
      base_price !== undefined ? parseFloat(base_price) : existing.base_price,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      stock_min !== undefined ? (parseInt(stock_min) || 0) : existing.stock_min,
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

// POST /api/products/import — solo admin (upsert por nombre)
router.post('/import', requireAdmin, (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || !products.length)
      return res.status(400).json({ error: 'No hay productos para importar' });

    let imported = 0, updated = 0;
    const errors = [];
    const ins  = db.prepare('INSERT INTO products (name, base_price) VALUES (?, ?)');
    const upd  = db.prepare('UPDATE products SET base_price=?, active=1 WHERE id=?');
    const find = db.prepare('SELECT id FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1');

    withTransaction(() => {
      for (let i = 0; i < products.length; i++) {
        const p = products[i];
        const name = String(p.nombre || p.name || '').trim();
        if (!name) { errors.push(`Fila ${i + 2}: nombre requerido`); continue; }
        const rawPrice = String(p.precio || p.price || p.base_price || p.precio_base || 0);
        const price = parseFloat(rawPrice.replace(',', '.')) || 0;
        const existing = find.get(name);
        if (existing) {
          upd.run(price, existing.id);
          updated++;
        } else {
          ins.run(name, price);
          imported++;
        }
      }
    });

    res.json({ imported, updated, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/products/duplicates — vista previa de duplicados
router.get('/duplicates', requireAdmin, (req, res) => {
  try {
    const groups = db.prepare(`
      SELECT name, COUNT(*) AS qty,
             MIN(base_price) AS min_price, MAX(base_price) AS max_price,
             MIN(id) AS keep_id
      FROM products WHERE active = 1
      GROUP BY LOWER(TRIM(name))
      HAVING COUNT(*) > 1
      ORDER BY name
    `).all();
    res.json(groups);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/products/deduplicate — conserva el de menor precio, elimina el resto
router.post('/deduplicate', requireAdmin, (req, res) => {
  try {
    const groups = db.prepare(`
      SELECT LOWER(TRIM(name)) AS norm_name
      FROM products WHERE active = 1
      GROUP BY LOWER(TRIM(name))
      HAVING COUNT(*) > 1
    `).all();

    if (!groups.length) return res.json({ removed: 0 });

    let removed = 0;

    withTransaction(() => {
      for (const { norm_name } of groups) {
        const dupes = db.prepare(`
          SELECT * FROM products
          WHERE LOWER(TRIM(name)) = ? AND active = 1
          ORDER BY base_price ASC, id ASC
        `).all(norm_name);

        if (dupes.length < 2) continue;

        const keep = dupes[0];
        for (const dup of dupes.slice(1)) {
          // Reasignar referencias en order_items
          db.prepare('UPDATE order_items SET product_id=? WHERE product_id=?').run(keep.id, dup.id);
          // Reasignar referencias en stock_movements
          db.prepare('UPDATE stock_movements SET product_id=? WHERE product_id=?').run(keep.id, dup.id);
          // En price_list_items: eliminar los del duplicado donde ya existe el producto a conservar
          db.prepare(`
            DELETE FROM price_list_items
            WHERE product_id=? AND price_list_id IN (
              SELECT price_list_id FROM price_list_items WHERE product_id=?
            )
          `).run(dup.id, keep.id);
          // Reasignar los restantes
          db.prepare('UPDATE price_list_items SET product_id=? WHERE product_id=?').run(keep.id, dup.id);
          // Desactivar el duplicado
          db.prepare('UPDATE products SET active=0 WHERE id=?').run(dup.id);
          removed++;
        }
      }
    });

    res.json({ removed, groups: groups.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
