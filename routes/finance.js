const express = require('express');
const router  = express.Router();
const { db } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}
router.use(requireAuth, requireAdmin);

function getBalanceData() {
  // Cash
  const { cash_in  } = db.prepare("SELECT COALESCE(SUM(amount),0) AS cash_in  FROM cash_movements WHERE type='ingreso'").get();
  const { cash_out } = db.prepare("SELECT COALESCE(SUM(amount),0) AS cash_out FROM cash_movements WHERE type='egreso'").get();
  const cash_balance = cash_in - cash_out;

  // Banks
  const bank_accounts = db.prepare('SELECT * FROM bank_accounts ORDER BY name').all();
  const banks = bank_accounts.map(acc => {
    const { ing } = db.prepare("SELECT COALESCE(SUM(amount),0) AS ing FROM bank_movements WHERE bank_account_id=? AND type='ingreso'").get(acc.id);
    const { eg  } = db.prepare("SELECT COALESCE(SUM(amount),0) AS eg  FROM bank_movements WHERE bank_account_id=? AND type='egreso'").get(acc.id);
    return { ...acc, balance: acc.initial_balance + ing - eg };
  });
  const bank_total = banks.filter(b => b.active).reduce((s, b) => s + b.balance, 0);

  // Cheques en cartera
  const { cheques_cartera } = db.prepare("SELECT COALESCE(SUM(amount),0) AS cheques_cartera FROM cheques WHERE direction='recibido' AND status='en_cartera'").get();
  const { cheques_count  } = db.prepare("SELECT COUNT(*) AS cheques_count FROM cheques WHERE direction='recibido' AND status='en_cartera'").get();

  // Total disponible
  const total_disponible = cash_balance + bank_total + cheques_cartera;

  // Deudores
  const { client_debt } = db.prepare(`SELECT COALESCE((SELECT COALESCE(SUM(total),0) FROM remitos) - (SELECT COALESCE(SUM(amount),0) FROM payments), 0) AS client_debt`).get();

  // Proveedores
  const { supplier_debt } = db.prepare(`SELECT COALESCE((SELECT COALESCE(SUM(total),0) FROM purchases) - (SELECT COALESCE(SUM(amount),0) FROM supplier_payments), 0) AS supplier_debt`).get();

  // Posición neta
  const net_position = total_disponible + client_debt - supplier_debt;

  // Cheques próximos 30 días
  const { cheques_cobrar } = db.prepare("SELECT COALESCE(SUM(amount),0) AS cheques_cobrar FROM cheques WHERE direction='recibido' AND status='en_cartera' AND due_date BETWEEN date('now') AND date('now','+30 days')").get();
  const { cheques_pagar  } = db.prepare("SELECT COALESCE(SUM(amount),0) AS cheques_pagar  FROM cheques WHERE direction='emitido'  AND status='emitido'      AND due_date BETWEEN date('now') AND date('now','+30 days')").get();
  const upcoming_cheques   = db.prepare(`
    SELECT c.*, cust.name AS customer_name, sup.name AS supplier_name
    FROM cheques c
    LEFT JOIN customers cust ON c.customer_id = cust.id
    LEFT JOIN suppliers sup  ON c.supplier_id  = sup.id
    WHERE c.due_date BETWEEN date('now') AND date('now','+30 days')
      AND c.status NOT IN ('depositado','rechazado','debitado')
    ORDER BY c.due_date ASC
  `).all();

  return { cash_balance, banks, bank_total, cheques_cartera, cheques_count, total_disponible, client_debt, supplier_debt, net_position, cheques_cobrar, cheques_pagar, upcoming_cheques };
}

// GET /api/finance/summary  (kept for backwards compat)
router.get('/summary', (req, res) => {
  try {
    const d = getBalanceData();
    res.json({
      cash_balance:   d.cash_balance,
      bank_balance:   d.bank_total,
      total_balance:  d.cash_balance + d.bank_total,
      client_debt:    d.client_debt,
      supplier_debt:  d.supplier_debt,
      cheques_cobrar: d.cheques_cobrar,
      cheques_pagar:  d.cheques_pagar
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/finance/balance  (full balance)
router.get('/balance', (req, res) => {
  try { res.json(getBalanceData()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/finance/balance-print  (HTML for printing)
router.get('/balance-print', (req, res) => {
  try {
    const d = getBalanceData();
    const company = db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value || 'Mi Empresa';
    const fmt = v => '$ ' + (v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const color = v => v >= 0 ? '#166534' : '#991b1b';
    const today = new Date().toLocaleDateString('es-AR');

    const bankRows = d.banks.filter(b => b.active).map(b =>
      `<tr><td style="padding-left:24px">${b.name}${b.bank ? ' — ' + b.bank : ''}</td><td class="num" style="color:${color(b.balance)}">${fmt(b.balance)}</td></tr>`
    ).join('');

    const upcomingRows = d.upcoming_cheques.map(c =>
      `<tr><td>${c.direction === 'recibido' ? 'A cobrar' : 'A pagar'}</td><td>${c.bank} ${c.cheque_number}</td><td>${c.customer_name || c.supplier_name || '—'}</td><td class="num">${fmt(c.amount)}</td><td>${c.due_date}</td></tr>`
    ).join('');

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Balance — ${company}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:13px;margin:24px;color:#1e293b}
  h1{font-size:18px;margin-bottom:4px}
  h2{font-size:13px;font-weight:700;margin:20px 0 6px;padding:6px 10px;background:#f1f5f9;border-left:3px solid #2563eb}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  td{padding:5px 8px;border-bottom:1px solid #e2e8f0}
  .num{text-align:right;font-weight:600}
  .total-row td{font-weight:700;border-top:2px solid #1e293b;background:#f8fafc}
  .net-row td{font-weight:700;font-size:14px;background:#eff6ff;color:#1d4ed8}
  @media print{button{display:none}}
</style></head><body>
<button onclick="window.print()" style="margin-bottom:16px;padding:6px 16px;cursor:pointer">Imprimir / Guardar PDF</button>
<h1>${company} — Balance General</h1>
<p style="color:#64748b;margin-bottom:4px">Fecha: ${today}</p>

<h2>DISPONIBLE</h2>
<table>
  <tr><td>Caja</td><td class="num" style="color:${color(d.cash_balance)}">${fmt(d.cash_balance)}</td></tr>
  ${bankRows || '<tr><td style="color:#94a3b8;padding-left:24px">Sin cuentas bancarias</td><td></td></tr>'}
  <tr><td style="padding-left:12px;color:#64748b">Subtotal banco</td><td class="num">${fmt(d.bank_total)}</td></tr>
  <tr><td>Cheques en cartera (${d.cheques_count})</td><td class="num">${fmt(d.cheques_cartera)}</td></tr>
  <tr class="total-row"><td>TOTAL DISPONIBLE</td><td class="num" style="color:${color(d.total_disponible)}">${fmt(d.total_disponible)}</td></tr>
</table>

<h2>DEUDAS Y ACREENCIAS</h2>
<table>
  <tr><td>Deudores — clientes nos deben</td><td class="num" style="color:#166534">${fmt(d.client_debt)}</td></tr>
  <tr><td>Proveedores — debemos</td><td class="num" style="color:#991b1b">${fmt(d.supplier_debt)}</td></tr>
</table>

<h2>POSICIÓN NETA</h2>
<table>
  <tr class="net-row"><td>Disponible + Deudores − Proveedores</td><td class="num" style="color:${color(d.net_position)}">${fmt(d.net_position)}</td></tr>
</table>

${d.upcoming_cheques.length ? `
<h2>CHEQUES A VENCER (próximos 30 días)</h2>
<table>
  <thead><tr style="background:#f1f5f9"><td>Tipo</td><td>Cheque</td><td>Cliente/Proveedor</td><td class="num">Monto</td><td>Vencimiento</td></tr></thead>
  <tbody>${upcomingRows}</tbody>
</table>` : ''}
</body></html>`;
    res.send(html);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
