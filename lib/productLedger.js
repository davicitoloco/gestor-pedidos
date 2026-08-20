'use strict';
const { db } = require('../db');
const { cobroStatus } = require('./cobro');

// Remitos de pedidos hechos 100% de un producto dado (al menos un ítem lo
// matchea y NINGÚN ítem del pedido queda afuera del filtro — los pedidos de
// un producto puntual no se mezclan con otros), con lo entregado/cobrado por
// remito ya calculado. Es la fuente única para la Ficha de Producto
// (routes/reports.js) y para el saldo por producto en la Lista de Clientes
// (routes/customers.js) — evita recalcular esto dos veces.
//
// sucursalFilter: { clause, params } como devuelve lib/sucursal.getSucursalFilter(req, 'r').
function getProductRemitos(product, sucursalFilter) {
  const like = `%${product.toLowerCase()}%`;
  const sf = sucursalFilter || { clause: '', params: [] };
  const rows = db.prepare(`
    SELECT r.id, r.customer_id, r.customer_name, r.order_id,
           printf('R-%03d', r.remito_sequence) AS remito_number,
           printf('#%03d', o.order_sequence) AS order_number,
           r.created_at, r.total,
           COALESCE((SELECT SUM(pra.amount) FROM payment_remito_allocations pra WHERE pra.remito_id = r.id), 0) AS paid
    FROM remitos r
    JOIN orders o ON r.order_id = o.id
    WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND LOWER(oi.product_name) LIKE ?)
      AND NOT EXISTS (SELECT 1 FROM order_items oi2 WHERE oi2.order_id = o.id AND LOWER(oi2.product_name) NOT LIKE ?)
      ${sf.clause}
    ORDER BY r.remito_sequence ASC
  `).all(like, like, ...sf.params);

  return rows.map(r => ({
    ...r,
    balance: Math.round((r.total - r.paid) * 100) / 100,
    status: cobroStatus(r.total, r.paid),
  }));
}

// Saldo pendiente de un producto, agrupado por customer_id — Map<customer_id, balance>.
function getProductBalanceByCustomer(product, sucursalFilter) {
  const remitos = getProductRemitos(product, sucursalFilter);
  const byCustomer = new Map();
  for (const r of remitos) {
    if (!r.customer_id) continue;
    byCustomer.set(r.customer_id, Math.round(((byCustomer.get(r.customer_id) || 0) + r.balance) * 100) / 100);
  }
  return byCustomer;
}

module.exports = { getProductRemitos, getProductBalanceByCustomer };
