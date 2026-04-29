'use strict';
const { db } = require('../db');

// Returns { clause, params } for WHERE splicing.
// alias: table alias prefix, e.g. 'o' → 'o.sucursal_id'
// If active_sucursal_id is set in session → filter to that branch.
// If null (admin "ver todo") → no filter.
function getSucursalFilter(req, alias) {
  const col = alias ? `${alias}.sucursal_id` : 'sucursal_id';
  const sid = req.session.active_sucursal_id;
  if (!sid) return { clause: '', params: [] };
  return { clause: `AND ${col} = ?`, params: [sid] };
}

// Returns the sucursal_id to stamp on INSERT.
// Uses active_sucursal_id; non-admin must always have one set.
function getInsertSucursalId(req) {
  return req.session.active_sucursal_id || null;
}

// Returns the sucursales assigned to a user.
function getUserSucursales(userId) {
  return db.prepare(`
    SELECT s.id, s.name, s.active
    FROM sucursales s
    JOIN user_sucursales us ON us.sucursal_id = s.id
    WHERE us.user_id = ?
    ORDER BY s.id ASC
  `).all(userId);
}

module.exports = { getSucursalFilter, getInsertSucursalId, getUserSucursales };
