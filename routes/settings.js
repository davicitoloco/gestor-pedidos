const express = require('express');
const router = express.Router();
const { db } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}

router.get('/', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    res.json(obj);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/', requireAuth, (req, res) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  try {
    const { company_name } = req.body;
    if (company_name !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('company_name', company_name.trim() || 'Mi Empresa');
    }
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    res.json(obj);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
