const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db, withTransaction } = require('../db');
const { getUserSucursales } = require('../lib/sucursal');

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  next();
}
router.use(requireAdmin);

// GET /api/users/sucursales
router.get('/sucursales', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM sucursales ORDER BY id ASC').all());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/users
router.get('/', (req, res) => {
  try {
    const users = db.prepare('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id ASC').all();
    const vis = db.prepare('SELECT user_id, supplier_id FROM supplier_visibility').all();
    const visMap = {};
    for (const r of vis) { if (!visMap[r.user_id]) visMap[r.user_id] = []; visMap[r.user_id].push(r.supplier_id); }
    const result = users.map(u => ({ ...u, sucursales: getUserSucursales(u.id), mp_supplier_ids: visMap[u.id] || [] }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/users — crear usuario
router.post('/', (req, res) => {
  try {
    const { username, password, full_name, role, sucursal_ids, mp_supplier_ids } = req.body;
    if (!username || !username.trim()) return res.status(400).json({ error: 'Usuario requerido' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
    if (exists) return res.status(400).json({ error: 'El nombre de usuario ya existe' });
    const hash = bcrypt.hashSync(password, 10);

    const userId = withTransaction(() => {
      const result = db.prepare(`
        INSERT INTO users (username, password_hash, full_name, role)
        VALUES (?, ?, ?, ?)
      `).run(username.trim(), hash, (full_name || '').trim(), ['admin','subadmin','mp'].includes(role) ? role : 'vendedor');
      const uid = Number(result.lastInsertRowid);
      const ids = Array.isArray(sucursal_ids) ? sucursal_ids : [];
      const ins = db.prepare('INSERT OR IGNORE INTO user_sucursales (user_id, sucursal_id) VALUES (?,?)');
      for (const sid of ids) ins.run(uid, Number(sid));
      if (Array.isArray(mp_supplier_ids)) {
        const insV = db.prepare('INSERT OR IGNORE INTO supplier_visibility (supplier_id, user_id) VALUES (?,?)');
        for (const sid of mp_supplier_ids) insV.run(Number(sid), uid);
      }
      return uid;
    });

    const user = db.prepare('SELECT id, username, full_name, role, active, created_at FROM users WHERE id = ?').get(userId);
    res.status(201).json({ ...user, sucursales: getUserSucursales(userId) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/users/:id — editar
router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });
    const { password, full_name, role, active, sucursal_ids, mp_supplier_ids } = req.body;

    if (id === req.session.userId && active === 0)
      return res.status(400).json({ error: 'No podés desactivarte a vos mismo' });
    if (id === req.session.userId && role === 'vendedor') {
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin' AND active=1").get().c;
      if (adminCount <= 1) return res.status(400).json({ error: 'Debe quedar al menos un administrador activo' });
    }

    withTransaction(() => {
      const newHash = password && password.length >= 4 ? bcrypt.hashSync(password, 10) : existing.password_hash;
      db.prepare(`
        UPDATE users SET password_hash=?, full_name=?, role=?, active=? WHERE id=?
      `).run(
        newHash,
        full_name !== undefined ? full_name.trim() : existing.full_name,
        role !== undefined ? (['admin','subadmin','mp'].includes(role) ? role : 'vendedor') : existing.role,
        active !== undefined ? (active ? 1 : 0) : existing.active,
        id
      );
      if (Array.isArray(sucursal_ids)) {
        db.prepare('DELETE FROM user_sucursales WHERE user_id=?').run(id);
        const ins = db.prepare('INSERT OR IGNORE INTO user_sucursales (user_id, sucursal_id) VALUES (?,?)');
        for (const sid of sucursal_ids) ins.run(id, Number(sid));
      }
      if (Array.isArray(mp_supplier_ids)) {
        db.prepare('DELETE FROM supplier_visibility WHERE user_id=?').run(id);
        const insV = db.prepare('INSERT OR IGNORE INTO supplier_visibility (supplier_id, user_id) VALUES (?,?)');
        for (const sid of mp_supplier_ids) insV.run(Number(sid), id);
      }
    });

    const user = db.prepare('SELECT id, username, full_name, role, active, created_at FROM users WHERE id = ?').get(id);
    res.json({ ...user, sucursales: getUserSucursales(id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
