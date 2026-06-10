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

const CATEGORIAS = ['','C/Frnts','Frentes','Cremallera','Sup. Cremallera','Cajas','Tapas','Palanca','Combinaciones','Ac. Inox / Varios'];
const PIEZAS_CIRCUITO = ['cajas','tapas','cremalleras','combinaciones','contrafrentes'];
const PIEZAS_DIRECTAS = ['llaves','nueces','pestillos'];
const COL_PULIDAS  = { cajas:'cajas_pulidas', tapas:'tapas_pulidas', cremalleras:'cremalleras_pulidas', combinaciones:'combinaciones_pulidas', contrafrentes:'contrafrentes_pulidos' };
const COL_SINCADAS = { cajas:'cajas_sincadas', tapas:'tapas_sincadas', cremalleras:'cremalleras_sincadas', combinaciones:'combinaciones_sincadas', contrafrentes:'contrafrentes_sincados' };

const VALID_PROCESO_CAMPOS = [
  'cajas_pulidas','cajas_sincadas','tapas_pulidas','tapas_sincadas',
  'cremalleras_pulidas','cremalleras_sincadas','combinaciones_pulidas','combinaciones_sincadas',
  'contrafrentes_pulidos','contrafrentes_sincados','llaves','nueces','pestillos'
];

function ensureRow(table, product_id) {
  db.prepare(`INSERT INTO ${table} (product_id) VALUES (?) ON CONFLICT(product_id) DO NOTHING`).run(product_id);
}

// ── GET /api/produccion/chapa ─────────────────────────────────

router.get('/chapa', (req, res) => {
  try {
    const rows = db.prepare('SELECT categoria, kilos, updated_at FROM prod_chapa ORDER BY categoria').all();
    res.json(rows.map(r => ({ ...r, nombre: CATEGORIAS[r.categoria] || `Categoría ${r.categoria}` })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/produccion/mp-proceso ────────────────────────────

router.get('/mp-proceso', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id AS product_id, p.name,
             COALESCE(c.cajas_pulidas,           0) AS cajas_pulidas,
             COALESCE(c.cajas_sincadas,          0) AS cajas_sincadas,
             COALESCE(c.tapas_pulidas,           0) AS tapas_pulidas,
             COALESCE(c.tapas_sincadas,          0) AS tapas_sincadas,
             COALESCE(c.cremalleras_pulidas,     0) AS cremalleras_pulidas,
             COALESCE(c.cremalleras_sincadas,    0) AS cremalleras_sincadas,
             COALESCE(c.combinaciones_pulidas,   0) AS combinaciones_pulidas,
             COALESCE(c.combinaciones_sincadas,  0) AS combinaciones_sincadas,
             COALESCE(c.contrafrentes_pulidos,   0) AS contrafrentes_pulidos,
             COALESCE(c.contrafrentes_sincados,  0) AS contrafrentes_sincados,
             COALESCE(c.llaves,                  0) AS llaves,
             COALESCE(c.nueces,                  0) AS nueces,
             COALESCE(c.pestillos,               0) AS pestillos,
             COALESCE(c.observaciones,          '') AS observaciones,
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

// ── GET /api/produccion/movimientos (UNION chapa + piezas) ────

router.get('/movimientos', (req, res) => {
  try {
    const { product_id, tipo, desde, hasta } = req.query;
    const lim = Math.min(Number(req.query.limit) || 300, 1000);

    let where = 'WHERE 1=1';
    const params = [];
    if (tipo)  { where += ' AND tipo = ?';                  params.push(tipo); }
    if (desde) { where += ' AND DATE(created_at) >= ?';     params.push(desde); }
    if (hasta) { where += ' AND DATE(created_at) <= ?';     params.push(hasta); }
    // product_id filter applies only to piece-level rows (NULL rows pass through if no filter)
    const prodFilter = product_id ? ' AND (product_id = ? OR product_id IS NULL)' : '';
    if (product_id) params.push(Number(product_id));

    const sql = `
      SELECT created_at, tipo,
             product_id, product_name,
             categoria, pieza, cantidad, kg_usados, notas,
             created_by_name, purchase_doc
      FROM (
        SELECT c.created_at, c.tipo,
               NULL AS product_id, NULL AS product_name,
               c.categoria, NULL AS pieza, c.cantidad, 0.0 AS kg_usados, c.notas,
               COALESCE(u.full_name, u.username) AS created_by_name,
               printf('C-%04d', pu.purchase_sequence) AS purchase_doc
        FROM prod_chapa_movs c
        LEFT JOIN users u ON c.created_by = u.id
        LEFT JOIN purchases pu ON c.purchase_id = pu.id
        UNION ALL
        SELECT m.created_at, m.tipo,
               m.product_id, p.name AS product_name,
               m.categoria, m.pieza, m.cantidad, m.kg_usados, m.notas,
               COALESCE(u.full_name, u.username) AS created_by_name,
               printf('C-%04d', pu.purchase_sequence) AS purchase_doc
        FROM prod_movimientos m
        JOIN products p ON m.product_id = p.id
        LEFT JOIN users u ON m.created_by = u.id
        LEFT JOIN purchases pu ON m.purchase_id = pu.id
      ) all_movs
      ${where}${prodFilter}
      ORDER BY created_at DESC
      LIMIT ?
    `;
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

// ── POST /api/produccion/chapa/ingreso ────────────────────────

router.post('/chapa/ingreso', (req, res) => {
  try {
    const { categoria, kilos, notas = '', purchase_id, mp_order_id } = req.body;
    const cat = Number(categoria);
    const kg  = Number(kilos) || 0;
    if (!cat || cat < 1 || cat > 9) return res.status(400).json({ error: 'Categoría inválida (1-9)' });
    if (kg <= 0) return res.status(400).json({ error: 'Los kilos deben ser mayores a 0' });

    withTransaction(() => {
      db.prepare(`UPDATE prod_chapa SET kilos=kilos+?, updated_at=datetime('now','localtime') WHERE categoria=?`).run(kg, cat);
      db.prepare(`INSERT INTO prod_chapa_movs (tipo, categoria, cantidad, notas, purchase_id, mp_order_id, created_by) VALUES ('ingreso_chapa',?,?,?,?,?,?)`).run(cat, kg, notas, purchase_id || null, mp_order_id || null, req.session.userId);
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/produccion/chapa/ajuste ────────────────────────

router.post('/chapa/ajuste', (req, res) => {
  try {
    const { categoria, delta, notas = '' } = req.body;
    const cat = Number(categoria);
    const d   = Number(delta);
    if (!cat || cat < 1 || cat > 9) return res.status(400).json({ error: 'Categoría inválida' });
    if (isNaN(d) || d === 0) return res.status(400).json({ error: 'Delta inválido' });

    withTransaction(() => {
      const row = db.prepare('SELECT kilos FROM prod_chapa WHERE categoria=?').get(cat);
      const newVal = (row ? row.kilos : 0) + d;
      if (newVal < 0) throw Object.assign(new Error('El ajuste resultaría en kilos negativos'), { status: 400 });
      db.prepare(`UPDATE prod_chapa SET kilos=?, updated_at=datetime('now','localtime') WHERE categoria=?`).run(newVal, cat);
      db.prepare(`INSERT INTO prod_chapa_movs (tipo, categoria, cantidad, notas, created_by) VALUES ('ajuste_chapa',?,?,?,?)`).run(cat, d, notas || `Ajuste ${CATEGORIAS[cat]}`, req.session.userId);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── POST /api/produccion/procesado ───────────────────────────
// Convierte kg de chapa en piezas pulidas para un artículo

router.post('/procesado', (req, res) => {
  try {
    const { product_id, categoria, pieza, kg_usados, piezas_resultado, notas = '' } = req.body;
    if (!product_id)      return res.status(400).json({ error: 'Artículo requerido' });
    if (!pieza || !PIEZAS_CIRCUITO.includes(pieza)) return res.status(400).json({ error: 'Pieza inválida' });
    const pid  = Number(product_id);
    const cat  = Number(categoria);
    const kg   = Number(kg_usados)  || 0;
    const pzas = Number(piezas_resultado) || 0;
    if (cat < 1 || cat > 9) return res.status(400).json({ error: 'Categoría inválida' });
    if (kg  <= 0) return res.status(400).json({ error: 'Los kg usados deben ser mayores a 0' });
    if (pzas <= 0) return res.status(400).json({ error: 'Las piezas resultantes deben ser mayores a 0' });

    withTransaction(() => {
      const chapa = db.prepare('SELECT kilos FROM prod_chapa WHERE categoria=?').get(cat);
      if (!chapa || chapa.kilos < kg)
        throw Object.assign(new Error(`Stock insuficiente: hay ${chapa ? chapa.kilos : 0} kg de ${CATEGORIAS[cat]}`), { status: 400 });

      db.prepare(`UPDATE prod_chapa SET kilos=kilos-?, updated_at=datetime('now','localtime') WHERE categoria=?`).run(kg, cat);

      ensureRow('prod_mp_proceso', pid);
      const col = COL_PULIDAS[pieza];
      db.prepare(`UPDATE prod_mp_proceso SET ${col}=${col}+?, updated_at=datetime('now','localtime') WHERE product_id=?`).run(pzas, pid);

      db.prepare(`INSERT INTO prod_movimientos (tipo,product_id,pieza,cantidad,kg_usados,categoria,notas,created_by) VALUES ('procesado',?,?,?,?,?,?,?)`).run(pid, pieza, pzas, kg, cat, notas, req.session.userId);
      db.prepare(`INSERT INTO prod_chapa_movs  (tipo,categoria,cantidad,notas,created_by) VALUES ('procesado',?,?,?,?)`).run(cat, -kg, `Procesado → ${piezas_resultado} ${pieza} para artículo #${pid}. ${notas}`.trim(), req.session.userId);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── POST /api/produccion/sincar ───────────────────────────────
// Mueve piezas de pulidas a sincadas

router.post('/sincar', (req, res) => {
  try {
    const { product_id, pieza, cantidad, notas = '' } = req.body;
    if (!product_id)                         return res.status(400).json({ error: 'Artículo requerido' });
    if (!pieza || !PIEZAS_CIRCUITO.includes(pieza)) return res.status(400).json({ error: 'Pieza inválida' });
    const pid = Number(product_id);
    const qty = Number(cantidad) || 0;
    if (qty <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });

    withTransaction(() => {
      ensureRow('prod_mp_proceso', pid);
      const proc = db.prepare('SELECT * FROM prod_mp_proceso WHERE product_id=?').get(pid);
      const pulCol = COL_PULIDAS[pieza];
      if (proc[pulCol] < qty)
        throw Object.assign(new Error(`Solo hay ${proc[pulCol]} ${pieza} pulidas para este artículo`), { status: 400 });

      const sinCol = COL_SINCADAS[pieza];
      db.prepare(`UPDATE prod_mp_proceso SET ${pulCol}=${pulCol}-?, ${sinCol}=${sinCol}+?, updated_at=datetime('now','localtime') WHERE product_id=?`).run(qty, qty, pid);
      db.prepare(`INSERT INTO prod_movimientos (tipo,product_id,pieza,cantidad,notas,created_by) VALUES ('sincado',?,?,?,?,?)`).run(pid, pieza, qty, notas, req.session.userId);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── POST /api/produccion/ingreso-componentes ─────────────────
// Entrada manual de piezas (sin pasar por chapa)

router.post('/ingreso-componentes', (req, res) => {
  try {
    const { product_id, pieza, cantidad, notas = '' } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Artículo requerido' });
    const pid = Number(product_id);
    const qty = Number(cantidad) || 0;
    if (qty <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });

    // Valid piezas for ingreso: circuit pulidas + direct
    const VALID_ING_PIEZAS = Object.values(COL_PULIDAS).concat(PIEZAS_DIRECTAS);
    if (!VALID_ING_PIEZAS.includes(pieza)) return res.status(400).json({ error: 'Pieza inválida' });

    withTransaction(() => {
      ensureRow('prod_mp_proceso', pid);
      db.prepare(`UPDATE prod_mp_proceso SET ${pieza}=${pieza}+?, updated_at=datetime('now','localtime') WHERE product_id=?`).run(qty, pid);
      db.prepare(`INSERT INTO prod_movimientos (tipo,product_id,pieza,cantidad,notas,created_by) VALUES ('ingreso_componentes',?,?,?,?,?)`).run(pid, pieza, qty, notas, req.session.userId);
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/produccion/armar ────────────────────────────────
// Ensambla cerraduras consumiendo piezas sincadas + directas

router.post('/armar', (req, res) => {
  try {
    const { product_id, cantidad = 1, consumo = {}, notas = '' } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Artículo requerido' });
    const pid = Number(product_id);
    const qty = Number(cantidad) || 0;
    if (qty <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });

    // Normalize consumo
    const cons = {};
    [...PIEZAS_CIRCUITO, ...PIEZAS_DIRECTAS].forEach(p => { cons[p] = Math.max(0, Number(consumo[p]) || 0); });

    withTransaction(() => {
      ensureRow('prod_mp_proceso', pid);
      const proc = db.prepare('SELECT * FROM prod_mp_proceso WHERE product_id=?').get(pid);

      // Validate circuit pieces (use sincadas)
      for (const pieza of PIEZAS_CIRCUITO) {
        if (cons[pieza] <= 0) continue;
        const col   = COL_SINCADAS[pieza];
        const need  = qty * cons[pieza];
        if ((proc[col] || 0) < need)
          throw Object.assign(new Error(`Stock insuficiente de ${pieza} sincadas: hay ${proc[col] || 0}, se necesitan ${need}`), { status: 400 });
      }
      // Validate direct pieces
      for (const pieza of PIEZAS_DIRECTAS) {
        if (cons[pieza] <= 0) continue;
        const need = qty * cons[pieza];
        if ((proc[pieza] || 0) < need)
          throw Object.assign(new Error(`Stock insuficiente de ${pieza}: hay ${proc[pieza] || 0}, se necesitan ${need}`), { status: 400 });
      }

      // Build SET clause
      const sets = [];
      const vals = [];
      for (const pieza of PIEZAS_CIRCUITO) {
        if (cons[pieza] <= 0) continue;
        const col = COL_SINCADAS[pieza];
        sets.push(`${col}=${col}-?`);
        vals.push(qty * cons[pieza]);
      }
      for (const pieza of PIEZAS_DIRECTAS) {
        if (cons[pieza] <= 0) continue;
        sets.push(`${pieza}=${pieza}-?`);
        vals.push(qty * cons[pieza]);
      }
      if (sets.length === 0) throw Object.assign(new Error('Debe consumir al menos una pieza'), { status: 400 });
      sets.push(`updated_at=datetime('now','localtime')`);
      db.prepare(`UPDATE prod_mp_proceso SET ${sets.join(',')} WHERE product_id=?`).run(...vals, pid);

      ensureRow('prod_terminadas', pid);
      db.prepare(`UPDATE prod_terminadas SET cantidad=cantidad+?, updated_at=datetime('now','localtime') WHERE product_id=?`).run(qty, pid);

      const consumoDesc = [...PIEZAS_CIRCUITO, ...PIEZAS_DIRECTAS]
        .filter(p => cons[p] > 0)
        .map(p => `${p}×${cons[p]}`)
        .join(', ');
      db.prepare(`INSERT INTO prod_movimientos (tipo,product_id,pieza,cantidad,notas,created_by) VALUES ('armado',?,?,?,?,?)`).run(pid, 'cerradura', qty, `[${consumoDesc}] ${notas}`.trim(), req.session.userId);
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
    if (isNaN(d) || d === 0) return res.status(400).json({ error: 'Delta inválido' });

    const VALID = { proceso: VALID_PROCESO_CAMPOS, terminadas: ['cantidad'] };
    if (!VALID[etapa] || !VALID[etapa].includes(campo))
      return res.status(400).json({ error: 'Parámetro inválido' });

    const TABLE = { proceso: 'prod_mp_proceso', terminadas: 'prod_terminadas' };
    const table = TABLE[etapa];

    withTransaction(() => {
      ensureRow(table, pid);
      const row    = db.prepare(`SELECT ${campo} AS val FROM ${table} WHERE product_id=?`).get(pid);
      const newVal = (row ? row.val : 0) + d;
      if (newVal < 0) throw Object.assign(new Error('El ajuste resultaría en stock negativo'), { status: 400 });
      db.prepare(`UPDATE ${table} SET ${campo}=?, updated_at=datetime('now','localtime') WHERE product_id=?`).run(newVal, pid);
      db.prepare(`INSERT INTO prod_movimientos (tipo,product_id,pieza,cantidad,etapa,notas,created_by) VALUES ('ajuste_manual',?,?,?,?,?,?)`).run(pid, campo, d, etapa, notas || `Ajuste ${campo}`, req.session.userId);
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
