const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  next();
}
router.use(requireAdmin);

// GET /api/users
router.get('/', (req, res) => {
  try {
    res.json(db.prepare('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id ASC').all());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/users — crear usuario
router.post('/', (req, res) => {
  try {
    const { username, password, full_name, role } = req.body;
    if (!username || !username.trim()) return res.status(400).json({ error: 'Usuario requerido' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
    if (exists) return res.status(400).json({ error: 'El nombre de usuario ya existe' });
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role)
      VALUES (?, ?, ?, ?)
    `).run(username.trim(), hash, (full_name || '').trim(), ['admin','subadmin'].includes(role) ? role : 'vendedor');
    const user = db.prepare('SELECT id, username, full_name, role, active, created_at FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
    res.status(201).json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/users/:id — editar
router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });
    const { password, full_name, role, active } = req.body;

    // Protecciones
    if (id === req.session.userId && active === 0)
      return res.status(400).json({ error: 'No podés desactivarte a vos mismo' });
    if (id === req.session.userId && role === 'vendedor') {
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin' AND active=1").get().c;
      if (adminCount <= 1) return res.status(400).json({ error: 'Debe quedar al menos un administrador activo' });
    }

    const newHash = password && password.length >= 4 ? bcrypt.hashSync(password, 10) : existing.password_hash;
    db.prepare(`
      UPDATE users SET password_hash=?, full_name=?, role=?, active=? WHERE id=?
    `).run(
      newHash,
      full_name !== undefined ? full_name.trim() : existing.full_name,
      role !== undefined ? (['admin','subadmin'].includes(role) ? role : 'vendedor') : existing.role,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      id
    );
    res.json(db.prepare('SELECT id, username, full_name, role, active, created_at FROM users WHERE id = ?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
