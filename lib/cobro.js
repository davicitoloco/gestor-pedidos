'use strict';
// Estado de cobro de un remito, calculado a partir de los pagos ya vinculados
// (payment_remito_allocations) — no existe una tabla de "flags" separada.
// Se usa tanto en la lista de pedidos (routes/orders.js) como en la Ficha de
// Producto (routes/reports.js) para que ambas vistas queden consistentes.

const EPS = 0.005;

// total: monto del remito (o suma de remitos). paid: suma de payment_remito_allocations.
// Devuelve 'pendiente' | 'parcial' | 'cobrado', o null si no hay nada que cobrar (total <= 0).
function cobroStatus(total, paid) {
  const t = Number(total) || 0;
  const p = Number(paid) || 0;
  if (t <= EPS) return null;
  if (p <= EPS) return 'pendiente';
  if (p < t - EPS) return 'parcial';
  return 'cobrado';
}

module.exports = { cobroStatus, COBRO_EPS: EPS };
