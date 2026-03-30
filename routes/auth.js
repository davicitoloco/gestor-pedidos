const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.role     = user.role;

  res.json({ success: true, username: user.username, role: user.role });
});

router.post('/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  // Siempre leer role fresco desde DB por si fue cambiado
  const user = db.prepare('SELECT username, role FROM users WHERE id = ? AND active = 1').get(req.session.userId);
  if (!user) { req.session.destroy(); return res.status(401).json({ error: 'No autenticado' }); }
  req.session.role = user.role;
  res.json({ username: user.username, role: user.role });
});

module.exports = router;
