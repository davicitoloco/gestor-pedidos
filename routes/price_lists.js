'use strict';
const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}
router.use(requireAuth);

// GET /api/price-lists  — todas las listas (id, nombre, fecha, active)
router.get('/', (req, res) => {
  try {
    const lists = db.prepare('SELECT * FROM price_lists ORDER BY id DESC').all();
    res.json(lists);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/price-lists/active  — lista vigente con sus items
router.get('/active', (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM price_lists WHERE active=1 ORDER BY id DESC LIMIT 1').get();
    if (!list) return res.json(null);
    const items = db.prepare(`
      SELECT pli.product_id, pli.precio, p.name
      FROM price_list_items pli JOIN products p ON pli.product_id = p.id
      WHERE pli.price_list_id = ?
    `).all(list.id);
    res.json({ ...list, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/price-lists/:id  — lista específica con items
router.get('/:id', (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM price_lists WHERE id=?').get(Number(req.params.id));
    if (!list) return res.status(404).json({ error: 'Lista no encontrada' });
    const items = db.prepare(`
      SELECT pli.product_id, pli.precio, p.name
      FROM price_list_items pli JOIN products p ON pli.product_id = p.id
      WHERE pli.price_list_id = ?
    `).all(list.id);
    res.json({ ...list, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/price-lists  — crear nueva lista y activarla
router.post('/', requireAdmin, (req, res) => {
  try {
    const { nombre, fecha_vigencia, items } = req.body;
    if (!nombre || !nombre.trim())       return res.status(400).json({ error: 'El nombre es requerido' });
    if (!fecha_vigencia)                 return res.status(400).json({ error: 'La fecha de vigencia es requerida' });
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'La lista debe tener al menos un producto' });

    const newId = withTransaction(() => {
      // Desactivar todas las listas previas
      db.prepare('UPDATE price_lists SET active=0').run();
      // Crear nueva lista activa
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO price_lists (nombre, fecha_vigencia, active) VALUES (?,?,1)'
      ).run(nombre.trim(), fecha_vigencia);
      const listId = Number(lastInsertRowid);
      // Insertar items y actualizar base_price en products
      const ins = db.prepare('INSERT INTO price_list_items (price_list_id, product_id, precio) VALUES (?,?,?)');
      const upd = db.prepare('UPDATE products SET base_price=? WHERE id=?');
      for (const it of items) {
        const precio = parseFloat(it.precio) || 0;
        ins.run(listId, Number(it.product_id), precio);
        upd.run(precio, Number(it.product_id));
      }
      return listId;
    });

    const list = db.prepare('SELECT * FROM price_lists WHERE id=?').get(newId);
    const savedItems = db.prepare(`
      SELECT pli.product_id, pli.precio, p.name
      FROM price_list_items pli JOIN products p ON pli.product_id = p.id
      WHERE pli.price_list_id = ?
    `).all(newId);
    res.status(201).json({ ...list, items: savedItems });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
