const express = require('express');
const router = express.Router();
const { db, withTransaction } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
router.use(requireAuth);

function isVendor(req) { return req.session.role === 'vendedor'; }

// GET /api/customers
router.get('/', (req, res) => {
  try {
    const vc = isVendor(req) ? `AND c.created_by = ${req.session.userId}` : '';
    const rows = db.prepare(`
      SELECT c.*, COALESCE(u.full_name, u.username) AS vendor_name
      FROM customers c
      LEFT JOIN users u ON c.created_by = u.id
      WHERE 1=1 ${vc}
      ORDER BY c.name ASC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customers
router.post('/', (req, res) => {
  try {
    const { name, phone, email, address, notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
    const result = db.prepare(`
      INSERT INTO customers (name, phone, email, address, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name.trim(), phone||'', email||'', address||'', notes||'', req.session.userId);
    res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/customers/:id
router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!ex) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (isVendor(req) && ex.created_by !== req.session.userId)
      return res.status(403).json({ error: 'No podés editar clientes de otros vendedores' });
    const { name, phone, email, address, notes } = req.body;
    db.prepare(`UPDATE customers SET name=?, phone=?, email=?, address=?, notes=? WHERE id=?`).run(
      name !== undefined ? name.trim() : ex.name,
      phone !== undefined ? phone : ex.phone,
      email !== undefined ? email : ex.email,
      address !== undefined ? address : ex.address,
      notes !== undefined ? notes : ex.notes,
      id
    );
    res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/customers/:id
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!ex) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (isVendor(req) && ex.created_by !== req.session.userId)
      return res.status(403).json({ error: 'No podés eliminar clientes de otros vendedores' });
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customers/import
router.post('/import', (req, res) => {
  try {
    const { customers } = req.body;
    if (!Array.isArray(customers) || !customers.length)
      return res.status(400).json({ error: 'No hay clientes para importar' });

    let imported = 0;
    const errors = [];
    const ins = db.prepare(
      'INSERT INTO customers (name, phone, email, address, created_by) VALUES (?, ?, ?, ?, ?)'
    );

    withTransaction(() => {
      for (let i = 0; i < customers.length; i++) {
        const c = customers[i];
        const name = String(c.nombre || c.name || c.cliente || c.customer || '').trim();
        if (!name) { errors.push(`Fila ${i + 2}: nombre requerido`); continue; }
        const phone   = String(c.telefono || c.teléfono || c.phone || c.tel || c.celular || '').trim();
        const email   = String(c.email || c.correo || c.mail || '').trim();
        const address = String(c.direccion || c.dirección || c.address || c.domicilio || '').trim();
        ins.run(name, phone, email, address, req.session.userId);
        imported++;
      }
    });

    res.json({ imported, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
