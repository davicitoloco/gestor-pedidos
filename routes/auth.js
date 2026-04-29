const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { getUserSucursales } = require('../lib/sucursal');

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

  const sucursales = getUserSucursales(user.id);
  // Admin defaults to null (see all); non-admin defaults to first assigned
  const defaultSucursal = user.role === 'admin' ? null : (sucursales[0]?.id || null);

  req.session.userId             = user.id;
  req.session.username           = user.username;
  req.session.role               = user.role;
  req.session.active_sucursal_id = defaultSucursal;

  res.json({
    success: true,
    username: user.username,
    role: user.role,
    sucursales,
    active_sucursal_id: defaultSucursal,
  });
});

router.post('/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  const user = db.prepare('SELECT username, role FROM users WHERE id = ? AND active = 1').get(req.session.userId);
  if (!user) { req.session.destroy(); return res.status(401).json({ error: 'No autenticado' }); }
  req.session.role = user.role;

  const sucursales = getUserSucursales(req.session.userId);
  res.json({
    username: user.username,
    role: user.role,
    sucursales,
    active_sucursal_id: req.session.active_sucursal_id || null,
  });
});

// POST /api/auth/switch-sucursal  { sucursal_id: 1 | null }
router.post('/switch-sucursal', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  const { sucursal_id } = req.body;

  if (sucursal_id === null || sucursal_id === undefined) {
    // Allow admin to unset (see all)
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores pueden ver todas las sucursales' });
    req.session.active_sucursal_id = null;
    return res.json({ active_sucursal_id: null });
  }

  const sid = Number(sucursal_id);
  // Verify user has access to this sucursal
  const access = db.prepare('SELECT 1 FROM user_sucursales WHERE user_id=? AND sucursal_id=?').get(req.session.userId, sid);
  if (!access && req.session.role !== 'admin') return res.status(403).json({ error: 'Sin acceso a esta sucursal' });

  req.session.active_sucursal_id = sid;
  res.json({ active_sucursal_id: sid });
});

module.exports = router;
