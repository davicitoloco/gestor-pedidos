// Backfill único: products.stock = prod_terminadas.cantidad - total entregado (delivery_items),
// para los artículos que tienen historial en Producción. Corre por fuera del arranque del
// servidor — nunca se ejecuta automáticamente en un deploy ni en cada reinicio.
//
// Uso (contra Railway):
//   railway run node scripts/backfill-stock-armado.js            → dry-run, solo muestra el diff
//   railway run node scripts/backfill-stock-armado.js --apply    → aplica los cambios
//   railway run node scripts/backfill-stock-armado.js --apply --force  → re-aplica aunque ya se haya corrido
//
// Uso local (DB de desarrollo):
//   node scripts/backfill-stock-armado.js [--apply] [--force]
//
// Es idempotente: una vez aplicado, guarda una marca en `settings` y se niega a
// volver a aplicar (salvo --force). Cada cambio queda registrado en stock_movements
// con type='ajuste' para que sea auditable y reversible manualmente si hace falta.

const { db, withTransaction } = require('../db');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const MARKER_KEY = 'backfill_stock_armado_done';

function main() {
  const already = db.prepare('SELECT value FROM settings WHERE key = ?').get(MARKER_KEY);
  if (already && !FORCE) {
    console.log(`Ya se aplicó este backfill el ${already.value}. Usá --force si realmente querés re-aplicarlo.`);
    process.exit(1);
  }

  const rows = db.prepare(`
    SELECT pt.product_id, p.name, pt.cantidad AS armado, p.stock AS stock_actual,
      COALESCE((
        SELECT SUM(di.quantity_delivered)
        FROM delivery_items di
        JOIN order_items oi ON oi.id = di.order_item_id
        WHERE oi.product_id = pt.product_id
      ), 0) AS entregado
    FROM prod_terminadas pt
    JOIN products p ON p.id = pt.product_id
    ORDER BY p.name
  `).all();

  if (rows.length === 0) {
    console.log('No hay artículos con historial en prod_terminadas. Nada para hacer.');
    return;
  }

  const plan = rows.map(r => ({
    ...r,
    stock_real: Math.max(0, r.armado - r.entregado),
    diff: Math.max(0, r.armado - r.entregado) - r.stock_actual,
  }));

  console.log('\nArtículo'.padEnd(30), 'Armado'.padStart(8), 'Entregado'.padStart(10), 'Stock actual'.padStart(13), '→ Stock real'.padStart(13), 'Diff'.padStart(8));
  for (const r of plan) {
    console.log(
      r.name.slice(0, 29).padEnd(30),
      String(r.armado).padStart(8),
      String(r.entregado).padStart(10),
      String(r.stock_actual).padStart(13),
      String(r.stock_real).padStart(13),
      (r.diff >= 0 ? '+' : '') + r.diff.toString().padStart(7),
    );
  }

  if (!APPLY) {
    console.log('\nDRY-RUN: no se modificó nada. Volvé a correr con --apply para aplicar estos cambios.\n');
    return;
  }

  withTransaction(() => {
    for (const r of plan) {
      if (r.diff === 0) continue;
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(r.stock_real, r.product_id);
      db.prepare(`
        INSERT INTO stock_movements (product_id, type, quantity, reference, notes, previous_qty, new_qty)
        VALUES (?, 'ajuste', ?, 'Backfill armado-entregado', ?, ?, ?)
      `).run(
        r.product_id,
        r.diff,
        `Ajuste inicial: stock = armado(${r.armado}) - entregado(${r.entregado})`,
        r.stock_actual,
        r.stock_real,
      );
    }
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, datetime('now','localtime'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(MARKER_KEY);
  });

  console.log(`\nAplicado. ${plan.filter(r => r.diff !== 0).length} artículo(s) actualizado(s).\n`);
}

main();
