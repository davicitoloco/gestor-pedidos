'use strict';
const express = require('express');
const router  = express.Router();
const { db, withTransaction } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (!['admin','subadmin'].includes(req.session.role)) return res.status(403).json({ error: 'Solo administradores' });
  next();
}
router.use(requireAuth, requireAdmin);

function ensureRow(table, product_id) {
  db.prepare(`INSERT INTO ${table} (product_id) VALUES (?) ON CONFLICT(product_id) DO NOTHING`).run(product_id);
}

// ── GET /api/produccion/mp-cruda ──────────────────────────────

router.get('/mp-cruda', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id AS product_id, p.name,
             COALESCE(c.cajas,     0) AS cajas,
             COALESCE(c.llaves,    0) AS llaves,
             COALESCE(c.nueces,    0) AS nueces,
             COALESCE(c.pestillos, 0) AS pestillos,
             c.updated_at
      FROM products p
      LEFT JOIN prod_mp_cruda c ON c.product_id = p.id
      WHERE p.active = 1
      ORDER BY p.name
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/produccion/mp-proceso ────────────────────────────

router.get('/mp-proceso', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id AS product_id, p.name,
             COALESCE(c.cajas_disponibles, 0) AS cajas_disponibles,
             COALESCE(c.cajas_estanteria,  0) AS cajas_estanteria,
             COALESCE(c.llaves,    0) AS llaves,
             COALESCE(c.nueces,    0) AS nueces,
             COALESCE(c.pestillos, 0) AS pestillos,
             COALESCE(c.observaciones, '') AS observaciones,
             c.updated_at
      FROM products p
      LEFT JOIN prod_mp_proceso c ON c.product_id = p.id
      WHERE p.active = 1
      ORDER BY p.name
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/produccion/terminadas ────────────────────────────

router.get('/terminadas', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id AS product_id, p.name,
             COALESCE(t.cantidad, 0) AS cantidad,
             t.updated_at
      FROM products p
      LEFT JOIN prod_terminadas t ON t.product_id = p.id
      WHERE p.active = 1
      ORDER BY p.name
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/produccion/movimientos ───────────────────────────

router.get('/movimientos', (req, res) => {
  try {
    const { product_id, tipo, desde, hasta } = req.query;
    const lim = Math.min(Number(req.query.limit) || 300, 1000);
    let sql = `
      SELECT m.*, p.name AS product_name,
             COALESCE(u.full_name, u.username) AS created_by_name,
             printf('C-%04d', pu.purchase_sequence) AS purchase_doc
      FROM prod_movimientos m
      JOIN products p ON m.product_id = p.id
      LEFT JOIN users u ON m.created_by = u.id
      LEFT JOIN purchases pu ON m.purchase_id = pu.id
      WHERE 1=1
    `;
    const params = [];
    if (product_id) { sql += ' AND m.product_id = ?'; params.push(Number(product_id)); }
    if (tipo)       { sql += ' AND m.tipo = ?';        params.push(tipo); }
    if (desde)      { sql += ' AND DATE(m.created_at) >= ?'; params.push(desde); }
    if (hasta)      { sql += ' AND DATE(m.created_at) <= ?'; params.push(hasta); }
    sql += ' ORDER BY m.id DESC LIMIT ?';
    params.push(lim);
    res.json(db.prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/produccion/purchases-for-mp ─────────────────────

router.get('/purchases-for-mp', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id, printf('C-%04d', p.purchase_sequence) AS purchase_number,
             s.name AS supplier_name, p.doc_date, p.total
      FROM purchases p
      JOIN suppliers s ON p.supplier_id = s.id
      ORDER BY p.purchase_sequence DESC
      LIMIT 100
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/produccion/ingreso-mp ───────────────────────────

router.post('/ingreso-mp', (req, res) => {
  try {
    const { product_id, cajas = 0, llaves = 0, nueces = 0, pestillos = 0, notas = '', purchase_id } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Artículo requerido' });
    const pid = Number(product_id);
    if (!db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(pid))
      return res.status(404).json({ error: 'Artículo no encontrado' });

    const q = {
      cajas:     Math.max(0, Number(cajas)     || 0),
      llaves:    Math.max(0, Number(llaves)    || 0),
      nueces:    Math.max(0, Number(nueces)    || 0),
      pestillos: Math.max(0, Number(pestillos) || 0)
    };
    if (Object.values(q).every(v => v === 0))
      return res.status(400).json({ error: 'Ingrese al menos una cantidad mayor a 0' });

    withTransaction(() => {
      ensureRow('prod_mp_cruda', pid);
      db.prepare(`
        UPDATE prod_mp_cruda
        SET cajas=cajas+?, llaves=llaves+?, nueces=nueces+?, pestillos=pestillos+?,
            updated_at=datetime('now','localtime')
        WHERE product_id=?
      `).run(q.cajas, q.llaves, q.nueces, q.pestillos, pid);

      db.prepare(`
        INSERT INTO prod_movimientos (tipo,product_id,cajas,llaves,nueces,pestillos,notas,purchase_id,created_by)
        VALUES ('entrada_mp',?,?,?,?,?,?,?,?)
      `).run(pid, q.cajas, q.llaves, q.nueces, q.pestillos, notas, purchase_id || null, req.session.userId);
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/produccion/procesar ─────────────────────────────

router.post('/procesar', (req, res) => {
  try {
    const { product_id, cajas = 0, llaves = 0, nueces = 0, pestillos = 0, notas = '' } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Artículo requerido' });
    const pid = Number(product_id);
    const q = {
      cajas:     Math.max(0, Number(cajas)     || 0),
      llaves:    Math.max(0, Number(llaves)    || 0),
      nueces:    Math.max(0, Number(nueces)    || 0),
      pestillos: Math.max(0, Number(pestillos) || 0)
    };
    if (Object.values(q).every(v => v === 0))
      return res.status(400).json({ error: 'Ingrese al menos una cantidad mayor a 0' });

    withTransaction(() => {
      ensureRow('prod_mp_cruda', pid);
      const cruda = db.prepare('SELECT * FROM prod_mp_cruda WHERE product_id=?').get(pid);
      if (q.cajas     > cruda.cajas)     throw Object.assign(new Error(`Stock insuficiente: hay ${cruda.cajas} cajas en MP sin procesar`),     { status: 400 });
      if (q.llaves    > cruda.llaves)    throw Object.assign(new Error(`Stock insuficiente: hay ${cruda.llaves} llaves en MP sin procesar`),    { status: 400 });
      if (q.nueces    > cruda.nueces)    throw Object.assign(new Error(`Stock insuficiente: hay ${cruda.nueces} nueces en MP sin procesar`),    { status: 400 });
      if (q.pestillos > cruda.pestillos) throw Object.assign(new Error(`Stock insuficiente: hay ${cruda.pestillos} pestillos en MP sin procesar`), { status: 400 });

      db.prepare(`
        UPDATE prod_mp_cruda
        SET cajas=cajas-?, llaves=llaves-?, nueces=nueces-?, pestillos=pestillos-?,
            updated_at=datetime('now','localtime')
        WHERE product_id=?
      `).run(q.cajas, q.llaves, q.nueces, q.pestillos, pid);

      ensureRow('prod_mp_proceso', pid);
      db.prepare(`
        UPDATE prod_mp_proceso
        SET cajas_disponibles=cajas_disponibles+?, llaves=llaves+?, nueces=nueces+?, pestillos=pestillos+?,
            updated_at=datetime('now','localtime')
        WHERE product_id=?
      `).run(q.cajas, q.llaves, q.nueces, q.pestillos, pid);

      db.prepare(`
        INSERT INTO prod_movimientos (tipo,product_id,cajas,llaves,nueces,pestillos,notas,created_by)
        VALUES ('proceso',?,?,?,?,?,?,?)
      `).run(pid, q.cajas, q.llaves, q.nueces, q.pestillos, notas, req.session.userId);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── POST /api/produccion/armar ────────────────────────────────

router.post('/armar', (req, res) => {
  try {
    const { product_id, cantidad = 1, notas = '' } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Artículo requerido' });
    const pid = Number(product_id);
    const qty = Number(cantidad) || 0;
    if (qty <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });

    withTransaction(() => {
      ensureRow('prod_mp_proceso', pid);
      const p = db.prepare('SELECT * FROM prod_mp_proceso WHERE product_id=?').get(pid);
      const totalCajas = p.cajas_disponibles + p.cajas_estanteria;
      if (totalCajas  < qty) throw Object.assign(new Error(`Stock insuficiente: hay ${totalCajas} caja(s) en proceso`),     { status: 400 });
      if (p.llaves    < qty) throw Object.assign(new Error(`Stock insuficiente: hay ${p.llaves} llave(s) en proceso`),    { status: 400 });
      if (p.nueces    < qty) throw Object.assign(new Error(`Stock insuficiente: hay ${p.nueces} nuez/nueces en proceso`),  { status: 400 });
      if (p.pestillos < qty) throw Object.assign(new Error(`Stock insuficiente: hay ${p.pestillos} pestillo(s) en proceso`), { status: 400 });

      // Consumir cajas: primero de disponibles, luego de estantería
      const fromDisp = Math.min(p.cajas_disponibles, qty);
      const fromEst  = qty - fromDisp;

      db.prepare(`
        UPDATE prod_mp_proceso
        SET cajas_disponibles=cajas_disponibles-?, cajas_estanteria=cajas_estanteria-?,
            llaves=llaves-?, nueces=nueces-?, pestillos=pestillos-?,
            updated_at=datetime('now','localtime')
        WHERE product_id=?
      `).run(fromDisp, fromEst, qty, qty, qty, pid);

      ensureRow('prod_terminadas', pid);
      db.prepare(`
        UPDATE prod_terminadas
        SET cantidad=cantidad+?, updated_at=datetime('now','localtime')
        WHERE product_id=?
      `).run(qty, pid);

      db.prepare(`
        INSERT INTO prod_movimientos (tipo,product_id,cajas,cajas_est,llaves,nueces,pestillos,terminadas,notas,created_by)
        VALUES ('armado',?,?,?,?,?,?,?,?,?)
      `).run(pid, fromDisp, fromEst, qty, qty, qty, qty, notas, req.session.userId);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── POST /api/produccion/ajuste ───────────────────────────────

router.post('/ajuste', (req, res) => {
  try {
    const { etapa, product_id, campo, delta, notas = '' } = req.body;
    if (!etapa || !product_id || !campo) return res.status(400).json({ error: 'Faltan parámetros' });
    const pid = Number(product_id);
    const d   = Number(delta);
    if (isNaN(d)) return res.status(400).json({ error: 'Cantidad inválida' });
    if (d === 0)  return res.status(400).json({ error: 'El delta no puede ser cero' });

    const VALID = {
      cruda:     ['cajas', 'llaves', 'nueces', 'pestillos'],
      proceso:   ['cajas_disponibles', 'cajas_estanteria', 'llaves', 'nueces', 'pestillos'],
      terminadas:['cantidad']
    };
    if (!VALID[etapa] || !VALID[etapa].includes(campo))
      return res.status(400).json({ error: 'Parámetro inválido' });

    const TABLE = { cruda: 'prod_mp_cruda', proceso: 'prod_mp_proceso', terminadas: 'prod_terminadas' };
    const table = TABLE[etapa];

    withTransaction(() => {
      ensureRow(table, pid);
      const row    = db.prepare(`SELECT ${campo} AS val FROM ${table} WHERE product_id=?`).get(pid);
      const newVal = (row ? row.val : 0) + d;
      if (newVal < 0) throw Object.assign(new Error('El ajuste resultaría en stock negativo'), { status: 400 });
      db.prepare(`UPDATE ${table} SET ${campo}=?, updated_at=datetime('now','localtime') WHERE product_id=?`).run(newVal, pid);

      // Map campo → columna en prod_movimientos
      const COL_MAP = {
        cajas: 'cajas', cajas_disponibles: 'cajas', cajas_estanteria: 'cajas_est',
        llaves: 'llaves', nueces: 'nueces', pestillos: 'pestillos', cantidad: 'terminadas'
      };
      const movCol = COL_MAP[campo] || 'cajas';
      const vals   = { cajas: 0, cajas_est: 0, llaves: 0, nueces: 0, pestillos: 0, terminadas: 0 };
      vals[movCol] = d;

      db.prepare(`
        INSERT INTO prod_movimientos (tipo,product_id,cajas,cajas_est,llaves,nueces,pestillos,terminadas,etapa,notas,created_by)
        VALUES ('ajuste',?,?,?,?,?,?,?,?,?,?)
      `).run(pid, vals.cajas, vals.cajas_est, vals.llaves, vals.nueces, vals.pestillos, vals.terminadas, etapa, notas || `Ajuste ${campo}`, req.session.userId);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── PUT /api/produccion/mp-proceso/:pid/obs ───────────────────

router.put('/mp-proceso/:pid/obs', (req, res) => {
  try {
    const pid = Number(req.params.pid);
    if (!db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(pid))
      return res.status(404).json({ error: 'Artículo no encontrado' });
    ensureRow('prod_mp_proceso', pid);
    db.prepare(`UPDATE prod_mp_proceso SET observaciones=?, updated_at=datetime('now','localtime') WHERE product_id=?`).run(req.body.observaciones || '', pid);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
