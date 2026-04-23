'use strict';

/* ================================================================ UTILS (primero para que $ esté disponible globalmente) */
const $ = id => document.getElementById(id);
function fmtMoney(v) {
  return '$ ' + (v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(s) {
  if (!s) return '—';
  const d = s.split(' ')[0].split('-');
  return `${d[2]}/${d[1]}/${d[0]}`;
}
function fmtDateTime(s) {
  if (!s) return '—';
  const [date, time] = s.split(' ');
  const d = date.split('-');
  return `${d[2]}/${d[1]}/${d[0]}${time ? ' ' + time.substring(0, 5) : ''}`;
}
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatCuit(c) {
  const d = String(c || '').replace(/\D/g, '');
  if (d.length !== 11) return d || '';
  return `${d.slice(0,2)}-${d.slice(2,10)}-${d.slice(10)}`;
}
function statusBadge(s) {
  const cls = { 'Pendiente':'warning','En preparación':'info','Entregado':'success','Cancelado':'default','Entrega parcial':'partial' };
  return `<span class="badge badge-${cls[s]||'default'}">${esc(s)}</span>`;
}
function isAdmin()      { return state.user && state.user.role === 'admin'; }
function isSubAdmin()   { return state.user && state.user.role === 'subadmin'; }
function isAdminLike()  { return state.user && (state.user.role === 'admin' || state.user.role === 'subadmin'); }

/* ================================================================ STATE */
const state = {
  user:          null,
  filterStatus:  'Todos',
  editingOrderId:  null,
  editingProdId:   null,
  editingUserId:   null,
  editingClientId: null,
  items:           [],
  productCatalog:  [],
  customerList:    [],
  charts:          {}
};

/* ================================================================ API */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(`/api${path}`, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
  return json;
}

/* ================================================================ TOAST */
let toastTimer = null;
function toast(msg, type = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3400);
}

/* ================================================================ MODAL CONFIRM */
function confirm(message) {
  return new Promise(resolve => {
    $('modal-message').textContent = message;
    $('modal-overlay').classList.remove('hidden');
    const yes = $('modal-confirm'), no = $('modal-cancel');
    function cleanup(r) {
      $('modal-overlay').classList.add('hidden');
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      resolve(r);
    }
    function onYes() { cleanup(true); }
    function onNo()  { cleanup(false); }
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
  });
}
$('modal-overlay').addEventListener('click', e => {
  if (e.target === $('modal-overlay')) $('modal-overlay').classList.add('hidden');
});

/* (utils definidos al inicio del archivo) */

/* ================================================================ AUTH */
async function checkAuth() {
  try {
    state.user = await api('GET', '/auth/me');
    showApp();
  } catch { showLogin(); }
}

function showLogin() {
  $('login-view').classList.remove('hidden');
  $('app-view').classList.add('hidden');
}

async function showApp() {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');

  // Aplicar visibilidad según rol
  $('sidebar-username').textContent = state.user.username;
  const roleLabels = { admin: 'Administrador', subadmin: 'Subadmin', vendedor: 'Vendedor' };
  $('sidebar-role').textContent = roleLabels[state.user.role] || 'Vendedor';
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdminLike()));
  document.querySelectorAll('.admin-only-col').forEach(el => el.classList.toggle('hidden', !isAdminLike()));
  document.querySelectorAll('.admin-only-field').forEach(el => el.classList.toggle('hidden', !isAdminLike()));
  document.querySelectorAll('.strict-admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));

  // Cargar settings
  try {
    const cfg = await api('GET', '/settings');
    $('sidebar-company').textContent = cfg.company_name || 'Pedidos';
    $('mobile-company-name').textContent = cfg.company_name || 'Pedidos';
    $('inp-company-name').value = cfg.company_name || '';
  } catch {}

  // Cargar catálogo de productos para el formulario
  await loadProductCatalog();

  navigate('pedidos');
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('login-btn');
  $('login-error').classList.add('hidden');
  btn.disabled = true; btn.textContent = 'Ingresando...';
  try {
    state.user = await api('POST', '/auth/login', {
      username: $('inp-username').value.trim(),
      password: $('inp-password').value
    });
    showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').classList.remove('hidden');
  } finally { btn.disabled = false; btn.textContent = 'Ingresar'; }
});

$('btn-logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  state.user = null;
  showLogin();
});

/* ================================================================ NAVIGATION */
function closeMobileSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  $('sidebar-overlay').classList.remove('open');
}

function navigate(section) {
  if (isSubAdmin() && (section === 'usuarios' || section === 'contable')) {
    toast('Sin acceso a esta sección', 'error');
    return;
  }
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.section === section)
  );
  document.querySelectorAll('.app-section').forEach(el => el.classList.add('hidden'));
  const sec = $(`section-${section}`);
  if (sec) sec.classList.remove('hidden');
  closeMobileSidebar();

  if (section === 'pedidos')   loadOrders();
  if (section === 'clientes')  { showClientsSubview('list'); loadClients(); }
  if (section === 'catalogo')  loadCatalog();
  if (section === 'stock')     loadStock();
  if (section === 'usuarios')  { showUsersSubview('list'); loadUsers(); }
  if (section === 'reportes')  loadReports();
  if (section === 'compras')   { showComprasTab('proveedores'); showProveedoresSubview('list'); loadSuppliers(); }
  if (section === 'contable')  { showContableTab('resumen'); loadFinanceSummary(); }
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', e => { e.preventDefault(); navigate(btn.dataset.section); });
});

$('btn-hamburger').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('open');
  $('sidebar-overlay').classList.toggle('open');
});
$('sidebar-overlay').addEventListener('click', closeMobileSidebar);

/* ================================================================ ORDERS LIST */
let _ordersSearchTimer = null;

async function loadOrders() {
  showOrdersSubview('list');
  document.querySelectorAll('.filter-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.status === state.filterStatus)
  );
  try {
    const params = new URLSearchParams();
    if (state.filterStatus !== 'Todos') params.set('status', state.filterStatus);
    const q = ($('inp-orders-search').value || '').trim();
    if (q) params.set('search', q);
    const qs = params.toString() ? `?${params}` : '';
    const orders = await api('GET', `/orders${qs}`);
    renderOrders(orders, q);
  } catch (err) { toast(err.message, 'error'); }
}

function applyOrderSearch() {
  clearTimeout(_ordersSearchTimer);
  _ordersSearchTimer = setTimeout(loadOrders, 250);
}

function renderOrders(orders, searchQuery = '') {
  const tbody = $('orders-tbody');
  const noEl  = $('no-orders');
  $('list-count').textContent = orders.length === 0 ? 'Sin pedidos' : `${orders.length} pedido${orders.length !== 1 ? 's' : ''}`;

  if (orders.length === 0) {
    tbody.innerHTML = '';
    $('no-orders-msg').textContent = searchQuery ? 'No se encontraron pedidos' : 'No hay pedidos';
    noEl.classList.remove('hidden');
    return;
  }
  noEl.classList.add('hidden');

  tbody.innerHTML = orders.map(o => `
    <tr data-id="${o.id}" style="cursor:pointer">
      <td><span class="order-num">#${esc(o.order_number)}</span></td>
      <td>${esc(o.customer_name)}</td>
      <td>${statusBadge(o.status)}</td>
      ${isAdmin() ? `<td style="color:var(--text-muted);font-size:.83rem">${esc(o.vendor_name||'—')}</td>` : ''}
      <td class="text-center col-mobile-hide">${o.item_count}</td>
      <td class="text-right" style="font-weight:600">${fmtMoney(o.total)}</td>
      <td class="col-mobile-hide">${fmtDate(o.delivery_date)}</td>
      <td class="col-mobile-hide" style="color:var(--text-muted);font-size:.82rem">${fmtDateTime(o.created_at)}</td>
      <td class="text-center" style="white-space:nowrap">
        <button class="btn-icon btn-edit" data-id="${o.id}" onclick="event.stopPropagation()" title="Editar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-icon btn-delete" data-id="${o.id}" data-num="${o.order_number}" onclick="event.stopPropagation()" title="Eliminar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        </button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr[data-id]').forEach(row => row.addEventListener('click', () => openOrderForm(row.dataset.id)));
  tbody.querySelectorAll('.btn-edit').forEach(btn => btn.addEventListener('click', () => openOrderForm(btn.dataset.id)));
  tbody.querySelectorAll('.btn-delete').forEach(btn => btn.addEventListener('click', () => deleteOrder(btn.dataset.id, btn.dataset.num)));
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => { state.filterStatus = btn.dataset.status; loadOrders(); });
});
$('inp-orders-search').addEventListener('input', applyOrderSearch);
$('btn-new-order').addEventListener('click', () => openOrderForm(null));

function showOrdersSubview(view) {
  $('list-view').classList.toggle('hidden', view !== 'list');
  $('form-view').classList.toggle('hidden', view !== 'form');
}

async function deleteOrder(id, num) {
  if (!await confirm(`¿Eliminar el pedido #${num}? Esta acción no se puede deshacer.`)) return;
  try {
    await api('DELETE', `/orders/${id}`);
    toast('Pedido eliminado', 'success');
    loadOrders();
  } catch (err) { toast(err.message, 'error'); }
}

/* ================================================================ ORDER FORM */
async function openOrderForm(orderId, prefillCustomer = null) {
  state.editingOrderId = orderId || null;
  state.items = [];

  $('form-title').textContent = orderId ? 'Editar Pedido' : 'Nuevo Pedido';
  $('inp-order-number').value = '';
  $('inp-customer').value     = '';
  $('inp-status').value       = 'Pendiente';
  $('inp-delivery-date').value = '';
  $('inp-notes').value        = '';
  $('inp-disc1').value = '0'; $('inp-disc2').value = '0';
  $('inp-disc3').value = '0'; $('inp-disc4').value = '0';
  $('inp-iva-exempt').checked = false;
  $('form-status-badge').innerHTML = '';
  $('btn-export-pdf').classList.add('hidden');
  $('btn-export-pdf-deposito').classList.add('hidden');
  if ($('inp-vendor-display')) $('inp-vendor-display').value = '';

  if (orderId) {
    try {
      const o = await api('GET', `/orders/${orderId}`);
      $('inp-order-number').value   = `#${o.order_number}`;
      $('inp-customer').value       = o.customer_name;
      $('inp-status').value         = o.status;
      $('inp-delivery-date').value  = o.delivery_date || '';
      $('inp-notes').value          = o.notes || '';
      $('inp-disc1').value = o.discount  || 0;
      $('inp-disc2').value = o.discount2 || 0;
      $('inp-disc3').value = o.discount3 || 0;
      $('inp-disc4').value = o.discount4 || 0;
      $('inp-iva-exempt').checked = !!o.iva_exempt;
      $('form-status-badge').innerHTML = statusBadge(o.status);
      $('btn-export-pdf').classList.remove('hidden');
      $('btn-export-pdf-deposito').classList.remove('hidden');
      if ($('inp-vendor-display') && isAdmin()) $('inp-vendor-display').value = o.vendor_name || '—';
      state.items = (o.items || []).map(i => ({ ...i }));
    } catch (err) { toast(err.message, 'error'); return; }
  }

  await loadCustomerList();
  if (prefillCustomer) $('inp-customer').value = prefillCustomer;
  renderItems();
  calcTotals();

  // Mostrar/ocultar sección de entregas
  const delivCard = $('deliveries-card');
  if (orderId) {
    delivCard.classList.remove('hidden');
    loadDeliveries(orderId);
  } else {
    delivCard.classList.add('hidden');
  }

  showOrdersSubview('form');
  $('inp-customer').focus();
}

$('btn-back').addEventListener('click', () => loadOrders());
$('btn-cancel-form').addEventListener('click', () => loadOrders());
$('btn-export-pdf').addEventListener('click', () => {
  if (state.editingOrderId) window.open(`/api/orders/${state.editingOrderId}/print`, '_blank');
});
$('btn-export-pdf-deposito').addEventListener('click', () => {
  if (state.editingOrderId) window.open(`/api/orders/${state.editingOrderId}/print-deposito`, '_blank');
});
$('inp-status').addEventListener('change', () => {
  if (state.editingOrderId) $('form-status-badge').innerHTML = statusBadge($('inp-status').value);
});
$('inp-customer').addEventListener('input', () => {
  const hint = $('customer-cuit-hint');
  if (!hint) return;
  const name = $('inp-customer').value.trim().toLowerCase();
  const match = (state.customerList || []).find(c => c.name.toLowerCase() === name);
  if (match && match.cuit) {
    hint.textContent = `CUIT: ${formatCuit(match.cuit)}`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
});

/* ================================================================ ORDER ITEMS */
$('btn-add-item').addEventListener('click', () => {
  state.items.push({ product_name: '', quantity: 1, unit_price: 0, discount: 0 });
  renderItems();
  calcTotals();
  const inputs = document.querySelectorAll('.item-inp-name');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

function renderItems() {
  const tbody = $('items-tbody');
  const noMsg = $('no-items-msg');
  const wrap  = $('items-table-wrap');

  if (state.items.length === 0) {
    noMsg.classList.remove('hidden'); wrap.classList.add('hidden'); tbody.innerHTML = '';
    return;
  }
  noMsg.classList.add('hidden'); wrap.classList.remove('hidden');

  tbody.innerHTML = state.items.map((item, i) => `
    <tr data-index="${i}">
      <td>
        <input type="text" list="products-datalist" class="input item-inp-name" data-i="${i}"
          value="${esc(item.product_name)}" placeholder="Buscar o escribir producto..." required>
      </td>
      <td><input type="number" class="input item-inp-qty" data-i="${i}" value="${item.quantity}" min="0.001" step="any"></td>
      <td><input type="number" class="input item-inp-price" data-i="${i}" value="${item.unit_price}" min="0" step="any"></td>
      <td><input type="number" class="input item-inp-disc" data-i="${i}" value="${item.discount}" min="0" max="100" step="any"></td>
      <td class="item-subtotal-cell" id="item-sub-${i}">${fmtMoney(itemSubtotal(item))}</td>
      <td><button type="button" class="btn-remove item-remove" data-i="${i}">×</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.item-inp-name').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = inp.dataset.i;
      state.items[i].product_name = inp.value;
      // Auto-fill price from catalog when exact match
      const match = state.productCatalog.find(p => p.name.toLowerCase() === inp.value.toLowerCase());
      if (match) {
        const priceInp = inp.closest('tr').querySelector('.item-inp-price');
        state.items[i].unit_price = match.base_price;
        priceInp.value = match.base_price;
        refreshItem(i);
      }
    });
  });
  tbody.querySelectorAll('.item-inp-qty').forEach(inp => {
    inp.addEventListener('input', () => { state.items[inp.dataset.i].quantity = parseFloat(inp.value) || 0; refreshItem(inp.dataset.i); });
  });
  tbody.querySelectorAll('.item-inp-price').forEach(inp => {
    inp.addEventListener('input', () => { state.items[inp.dataset.i].unit_price = parseFloat(inp.value) || 0; refreshItem(inp.dataset.i); });
  });
  tbody.querySelectorAll('.item-inp-disc').forEach(inp => {
    inp.addEventListener('input', () => { state.items[inp.dataset.i].discount = parseFloat(inp.value) || 0; refreshItem(inp.dataset.i); });
  });
  tbody.querySelectorAll('.item-remove').forEach(btn => {
    btn.addEventListener('click', () => { state.items.splice(parseInt(btn.dataset.i), 1); renderItems(); calcTotals(); });
  });
  tbody.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
  });
}

function itemSubtotal(item) {
  return (item.quantity * item.unit_price) * (1 - (item.discount || 0) / 100);
}
function refreshItem(i) {
  const el = $(`item-sub-${i}`);
  if (el) el.textContent = fmtMoney(itemSubtotal(state.items[i]));
  calcTotals();
}
function calcTotals() {
  const subtotal = state.items.reduce((s, it) => s + itemSubtotal(it), 0);
  const d1 = parseFloat($('inp-disc1').value) || 0;
  const d2 = parseFloat($('inp-disc2').value) || 0;
  const d3 = parseFloat($('inp-disc3').value) || 0;
  const d4 = parseFloat($('inp-disc4').value) || 0;

  const base1 = subtotal;
  const amt1  = base1 * d1 / 100;
  const base2 = base1 - amt1;
  const amt2  = base2 * d2 / 100;
  const base3 = base2 - amt2;
  const amt3  = base3 * d3 / 100;
  const base4 = base3 - amt3;
  const amt4  = base4 * d4 / 100;

  const totalDisc  = amt1 + amt2 + amt3 + amt4;
  const netTotal   = subtotal - totalDisc;
  const ivaExempt  = $('inp-iva-exempt').checked;
  const iva        = ivaExempt ? 0 : netTotal * 0.21;
  const finalTotal = netTotal + iva;

  $('calc-disc1-amt').textContent  = amt1 > 0 ? `− ${fmtMoney(amt1)}` : '—';
  $('calc-disc2-amt').textContent  = amt2 > 0 ? `− ${fmtMoney(amt2)}` : '—';
  $('calc-disc3-amt').textContent  = amt3 > 0 ? `− ${fmtMoney(amt3)}` : '—';
  $('calc-disc4-amt').textContent  = amt4 > 0 ? `− ${fmtMoney(amt4)}` : '—';
  $('calc-subtotal').textContent   = fmtMoney(subtotal);
  $('calc-disc-total').textContent = totalDisc > 0 ? `− ${fmtMoney(totalDisc)}` : '—';
  $('calc-net').textContent        = fmtMoney(netTotal);
  $('calc-iva-label').textContent  = ivaExempt ? 'IVA: Exento' : 'IVA 21%:';
  $('calc-iva').textContent        = ivaExempt ? '—' : fmtMoney(iva);
  $('calc-total').textContent      = fmtMoney(finalTotal);
}
['inp-disc1','inp-disc2','inp-disc3','inp-disc4'].forEach(id =>
  $(id).addEventListener('input', calcTotals)
);
$('inp-iva-exempt').addEventListener('change', calcTotals);

/* ================================================================ SAVE ORDER */
$('order-form').addEventListener('submit', async e => {
  e.preventDefault();
  const customer = $('inp-customer').value.trim();
  if (!customer) { toast('El nombre del cliente es requerido', 'error'); $('inp-customer').focus(); return; }

  const data = {
    customer_name: customer,
    status:        $('inp-status').value,
    delivery_date: $('inp-delivery-date').value || null,
    notes:         $('inp-notes').value.trim(),
    discount:  parseFloat($('inp-disc1').value) || 0,
    discount2: parseFloat($('inp-disc2').value) || 0,
    discount3: parseFloat($('inp-disc3').value) || 0,
    discount4: parseFloat($('inp-disc4').value) || 0,
    iva_exempt: $('inp-iva-exempt').checked ? 1 : 0,
    items:         state.items.filter(i => i.product_name.trim())
  };

  const btn = $('btn-save');
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = 'Guardando...';

  try {
    if (state.editingOrderId) {
      await api('PUT', `/orders/${state.editingOrderId}`, data);
      toast('Pedido actualizado', 'success');
    } else {
      await api('POST', '/orders', data);
      toast('Pedido creado', 'success');
    }
    loadOrders();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = orig; }
});

/* ================================================================ PRODUCT CATALOG (autocomplete) */
async function loadProductCatalog() {
  try {
    state.productCatalog = await api('GET', '/products');
    updateDatalist();
  } catch {}
}

function updateDatalist() {
  const dl = $('products-datalist');
  if (!dl) return;
  dl.innerHTML = state.productCatalog
    .filter(p => p.active)
    .map(p => `<option value="${esc(p.name)}">`)
    .join('');
}

async function loadCustomerList() {
  try {
    state.customerList = await api('GET', '/customers');
    const dl = $('customers-datalist');
    if (!dl) return;
    dl.innerHTML = state.customerList.map(c => `<option value="${esc(c.name)}">`).join('');
  } catch {}
}

/* ================================================================ CATALOG SECTION */
async function loadCatalog() {
  try {
    const products = await api('GET', '/products?all=1');
    renderCatalog(products);
  } catch (err) { toast(err.message, 'error'); }
}

function stockBadge(stock, stock_min) {
  if (stock === 0)
    return `<span class="badge badge-stock-out">Sin stock</span>`;
  if (stock_min > 0 && stock <= stock_min)
    return `<span class="badge badge-stock-low">${stock}</span>`;
  return `<span class="badge badge-stock-ok">${stock}</span>`;
}

function renderCatalog(products) {
  const tbody = $('catalog-tbody');
  const noEl  = $('no-catalog');
  $('catalog-count').textContent = `${products.length} producto${products.length !== 1 ? 's' : ''}`;

  if (products.length === 0) { tbody.innerHTML = ''; noEl.classList.remove('hidden'); return; }
  noEl.classList.add('hidden');

  tbody.innerHTML = products.map(p => {
    const stockClass = isAdmin() && p.active && p.stock === 0 ? 'stock-critical'
      : (isAdmin() && p.active && p.stock_min > 0 && p.stock <= p.stock_min ? 'stock-low' : '');
    return `
    <tr class="${stockClass}">
      <td style="${!p.active ? 'opacity:.5;text-decoration:line-through' : ''}">${esc(p.name)}</td>
      <td class="text-right" style="font-weight:600">${fmtMoney(p.base_price)}</td>
      ${isAdmin() ? `<td class="text-center">
        ${p.active ? stockBadge(p.stock, p.stock_min) : '<span class="badge badge-default">—</span>'}
      </td>` : ''}
      <td class="text-center">
        ${p.active
          ? '<span class="badge badge-success">Activo</span>'
          : '<span class="badge badge-default">Inactivo</span>'}
      </td>
      ${isAdmin() ? `<td class="text-center" style="white-space:nowrap">
        <button class="btn-icon" onclick="openProductModal(${p.id})" title="Editar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-icon" onclick="openMovementsModal(${p.id},'${esc(p.name)}')" title="Historial de movimientos">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>
        </button>
        ${p.active ? `<button class="btn-icon btn-delete" onclick="toggleProduct(${p.id},0)" title="Desactivar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>` : `<button class="btn-icon" onclick="toggleProduct(${p.id},1)" title="Activar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        </button>`}
      </td>` : ''}
    </tr>`;
  }).join('');
}

$('btn-new-product').addEventListener('click', () => openProductModal(null));

function openProductModal(id) {
  state.editingProdId = id || null;
  $('product-modal-title').textContent = id ? 'Editar Producto' : 'Nuevo Producto';
  $('product-modal').classList.remove('hidden');
  if (id) {
    api('GET', '/products?all=1').then(list => {
      const prod = list.find(x => x.id === id);
      if (prod) {
        $('inp-prod-name').value = prod.name;
        $('inp-prod-price').value = prod.base_price;
        $('inp-prod-stock-min').value = prod.stock_min || 0;
      }
    });
  } else {
    $('inp-prod-name').value = '';
    $('inp-prod-price').value = '';
    $('inp-prod-stock-min').value = '0';
  }
  setTimeout(() => $('inp-prod-name').focus(), 50);
}

window.openProductModal = openProductModal;

window.toggleProduct = async function(id, active) {
  try {
    await api('PUT', `/products/${id}`, { active });
    await loadProductCatalog();
    loadCatalog();
    toast(active ? 'Producto activado' : 'Producto desactivado', 'success');
  } catch (err) { toast(err.message, 'error'); }
};

$('btn-prod-cancel').addEventListener('click', () => $('product-modal').classList.add('hidden'));
$('product-modal').addEventListener('click', e => { if (e.target === $('product-modal')) $('product-modal').classList.add('hidden'); });

$('btn-prod-save').addEventListener('click', async () => {
  const name      = $('inp-prod-name').value.trim();
  const price     = parseFloat($('inp-prod-price').value) || 0;
  const stock_min = parseInt($('inp-prod-stock-min').value) || 0;
  if (!name) { toast('El nombre es requerido', 'error'); $('inp-prod-name').focus(); return; }
  try {
    if (state.editingProdId) {
      await api('PUT', `/products/${state.editingProdId}`, { name, base_price: price, stock_min });
      toast('Producto actualizado', 'success');
    } else {
      await api('POST', '/products', { name, base_price: price, stock_min });
      toast('Producto creado', 'success');
    }
    $('product-modal').classList.add('hidden');
    await loadProductCatalog();
    loadCatalog();
  } catch (err) { toast(err.message, 'error'); }
});

/* ================================================================ USERS */
function showUsersSubview(view) {
  $('users-list-view').classList.toggle('hidden', view !== 'list');
  $('users-form-view').classList.toggle('hidden', view !== 'form');
}

async function loadUsers() {
  try {
    const users = await api('GET', '/users');
    renderUsers(users);
  } catch (err) { toast(err.message, 'error'); }
}

function renderUsers(users) {
  const tbody = $('users-tbody');
  const noEl  = $('no-users');
  $('users-count').textContent = `${users.length} usuario${users.length !== 1 ? 's' : ''}`;

  if (users.length === 0) { tbody.innerHTML = ''; noEl.classList.remove('hidden'); return; }
  noEl.classList.add('hidden');

  tbody.innerHTML = users.map(u => `
    <tr style="${!u.active ? 'opacity:.55' : ''}">
      <td>${esc(u.full_name || u.username)}</td>
      <td style="color:var(--text-muted);font-size:.88rem">${esc(u.username)}</td>
      <td>${u.role === 'admin'
        ? '<span class="badge badge-admin">Admin</span>'
        : u.role === 'subadmin'
          ? '<span class="badge badge-info">Subadmin</span>'
          : '<span class="badge badge-vendor">Vendedor</span>'}</td>
      <td class="text-center">
        ${u.active
          ? '<span class="badge badge-success">Activo</span>'
          : '<span class="badge badge-default">Inactivo</span>'}
      </td>
      <td class="text-center" style="white-space:nowrap">
        <button class="btn-icon" onclick="openUserForm(${u.id})" title="Editar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        ${u.id !== state.user.id
          ? `<button class="btn-icon ${u.active ? 'btn-delete' : ''}" onclick="toggleUser(${u.id},${u.active ? 0 : 1})" title="${u.active ? 'Desactivar' : 'Activar'}">
              ${u.active
                ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
                : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`}
            </button>`
          : '<span style="width:30px;display:inline-block"></span>'}
      </td>
    </tr>
  `).join('');
}

window.toggleUser = async function(id, active) {
  try {
    await api('PUT', `/users/${id}`, { active });
    loadUsers();
    toast(active ? 'Usuario activado' : 'Usuario desactivado', 'success');
  } catch (err) { toast(err.message, 'error'); }
};

$('btn-new-user').addEventListener('click', () => openUserForm(null));
$('btn-users-back').addEventListener('click', () => { showUsersSubview('list'); loadUsers(); });
$('btn-user-cancel').addEventListener('click', () => { showUsersSubview('list'); loadUsers(); });

window.openUserForm = function(id) {
  state.editingUserId = id || null;
  $('user-form-title').textContent = id ? 'Editar Usuario' : 'Nuevo Usuario';
  $('inp-user-fullname').value  = '';
  $('inp-user-username').value  = '';
  $('inp-user-password').value  = '';
  $('inp-user-role').value      = 'vendedor';
  $('inp-user-username').disabled = false;
  $('pwd-label').textContent = id ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña *';

  if (id) {
    api('GET', '/users').then(list => {
      const u = list.find(x => x.id === id);
      if (u) {
        $('inp-user-fullname').value  = u.full_name;
        $('inp-user-username').value  = u.username;
        $('inp-user-role').value      = u.role;
        $('inp-user-username').disabled = true;
      }
    });
  }
  showUsersSubview('form');
  setTimeout(() => $('inp-user-fullname').focus(), 50);
};

$('user-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fullname = $('inp-user-fullname').value.trim();
  const username = $('inp-user-username').value.trim();
  const password = $('inp-user-password').value;
  const role     = $('inp-user-role').value;

  if (!fullname) { toast('El nombre completo es requerido', 'error'); return; }
  if (!state.editingUserId && !username) { toast('El nombre de usuario es requerido', 'error'); return; }
  if (!state.editingUserId && (!password || password.length < 4))
    { toast('La contraseña debe tener al menos 4 caracteres', 'error'); return; }

  const btn = $('btn-user-save');
  btn.disabled = true;
  try {
    if (state.editingUserId) {
      const body = { full_name: fullname, role };
      if (password) body.password = password;
      await api('PUT', `/users/${state.editingUserId}`, body);
      toast('Usuario actualizado', 'success');
    } else {
      await api('POST', '/users', { username, password, full_name: fullname, role });
      toast('Usuario creado', 'success');
    }
    showUsersSubview('list');
    loadUsers();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

/* ================================================================ REPORTS */

const rankingState = {
  from:     '',
  to:       '',
  expanded: { customers: false, vendors: false, delivered: false, stocked: false, discounts: false }
};

async function loadReports() {
  const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const now = new Date();
  $('reports-period').textContent = `${months[now.getMonth()]} ${now.getFullYear()}`;

  try {
    const [stats, weekly, topProds] = await Promise.all([
      api('GET', '/reports/stats'),
      api('GET', '/reports/weekly'),
      api('GET', '/reports/top-products')
    ]);
    renderStats(stats);
    renderWeeklyChart(weekly);
    renderStatusChart(stats.by_status);
    renderTopProducts(topProds);
  } catch (err) { toast(err.message, 'error'); }

  loadRankings();
}

function rankingQS(key) {
  const limit = rankingState.expanded[key] ? 50 : 10;
  const p = new URLSearchParams({ limit });
  if (rankingState.from) p.set('from', rankingState.from);
  if (rankingState.to)   p.set('to',   rankingState.to);
  return '?' + p.toString();
}

async function loadRankings() {
  const keys = ['customers', 'vendors', 'delivered', 'stocked', 'discounts'];
  const endpoints = {
    customers: '/reports/top-customers',
    vendors:   '/reports/top-vendors',
    delivered: '/reports/top-delivered',
    stocked:   '/reports/top-stocked',
    discounts: '/reports/top-discounts'
  };
  await Promise.allSettled(
    keys.map(k => api('GET', endpoints[k] + rankingQS(k))
      .then(data => renderRanking(k, data))
      .catch(() => {})
    )
  );
}

let _discountsPieChart = null;

function renderDiscountsPieChart(data) {
  const wrap = $('discounts-chart-wrap');
  if (!data.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');

  const labels = data.map(d => `#${d.order_number} ${d.customer_name}`);
  const values = data.map(d => parseFloat(d.discount_amount.toFixed(2)));
  const total  = values.reduce((a, b) => a + b, 0);
  const palette = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1','#84cc16'];

  if (_discountsPieChart) { _discountsPieChart.destroy(); _discountsPieChart = null; }

  _discountsPieChart = new Chart($('discounts-pie-chart'), {
    type: 'pie',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: palette.slice(0, values.length), borderWidth: 2, borderColor: '#fff' }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12, padding: 10 } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${fmtMoney(ctx.parsed)} (${total > 0 ? ((ctx.parsed/total)*100).toFixed(1) : 0}%)`
          }
        }
      }
    }
  });
}

function renderRanking(key, data) {
  const tbody  = $(`rk-${key}-tbody`);
  const noEl   = $(`no-rk-${key}`);
  const moreBtn = document.querySelector(`.ranking-more-btn[data-key="${key}"]`);
  if (!tbody) return;

  if (!data.length) {
    tbody.innerHTML = '';
    noEl.classList.remove('hidden');
    if (moreBtn) moreBtn.classList.add('hidden');
    if (key === 'discounts') renderDiscountsPieChart([]);
    return;
  }
  noEl.classList.add('hidden');
  if (moreBtn) {
    moreBtn.classList.remove('hidden');
    moreBtn.textContent = rankingState.expanded[key] ? 'Ver menos' : 'Ver más';
  }

  const rows = {
    customers: d => `<td style="color:var(--text-muted);font-size:.82rem;font-weight:600">${d._i}</td>
      <td style="font-weight:500">${esc(d.customer_name)}</td>
      <td class="text-center">${d.order_count}</td>
      <td class="text-right" style="font-weight:600;color:var(--primary)">${fmtMoney(d.total)}</td>
      <td class="text-right" style="color:var(--text-muted)">${fmtMoney(d.avg_ticket)}</td>`,

    vendors: d => `<td style="color:var(--text-muted);font-size:.82rem;font-weight:600">${d._i}</td>
      <td style="font-weight:500">${esc(d.vendor_name)}</td>
      <td class="text-center">${d.order_count}</td>
      <td class="text-right" style="font-weight:600;color:var(--primary)">${fmtMoney(d.total)}</td>
      <td class="text-right" style="color:var(--text-muted)">${fmtMoney(d.avg_ticket)}</td>`,

    delivered: d => `<td style="color:var(--text-muted);font-size:.82rem;font-weight:600">${d._i}</td>
      <td>${esc(d.product_name)}</td>
      <td class="text-right" style="font-weight:600">${d.total_delivered}</td>
      <td class="text-right" style="color:var(--primary)">${fmtMoney(d.revenue)}</td>`,

    stocked: d => `<td style="color:var(--text-muted);font-size:.82rem;font-weight:600">${d._i}</td>
      <td>${esc(d.product_name)}</td>
      <td class="text-right" style="font-weight:600">${d.total_ingresado}</td>`,

    discounts: d => `<td><span class="order-num">#${esc(d.order_number)}</span></td>
      <td>${esc(d.customer_name)}</td>
      <td class="text-center" style="font-weight:600">${d.discount_pct}%</td>
      <td class="text-right" style="color:var(--text-muted)">${fmtMoney(d.subtotal)}</td>
      <td class="text-right" style="font-weight:600;color:var(--danger)">${fmtMoney(d.discount_amount)}</td>`
  };

  tbody.innerHTML = data.map((d, i) => `<tr>${rows[key]({ ...d, _i: i + 1 })}</tr>`).join('');

  if (key === 'discounts') renderDiscountsPieChart(data);
}

// Date filter controls
$('btn-ranking-filter').addEventListener('click', () => {
  rankingState.from = $('ranking-from').value;
  rankingState.to   = $('ranking-to').value;
  loadRankings();
});

$('btn-ranking-reset').addEventListener('click', () => {
  rankingState.from = '';
  rankingState.to   = '';
  $('ranking-from').value = '';
  $('ranking-to').value   = '';
  loadRankings();
});

document.querySelectorAll('.ranking-more-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    rankingState.expanded[key] = !rankingState.expanded[key];
    btn.textContent = rankingState.expanded[key] ? 'Ver menos' : 'Ver más';
    const endpoint = {
      customers: '/reports/top-customers', vendors: '/reports/top-vendors',
      delivered: '/reports/top-delivered', stocked: '/reports/top-stocked',
      discounts: '/reports/top-discounts'
    }[key];
    api('GET', endpoint + rankingQS(key))
      .then(data => renderRanking(key, data))
      .catch(err => toast(err.message, 'error'));
  });
});

function renderStats(stats) {
  $('stat-total-orders').textContent  = stats.total_orders;
  $('stat-month-orders').textContent  = stats.month_orders;
  $('stat-month-sales').textContent   = fmtMoney(stats.month_sales);
  $('stat-avg').textContent           = fmtMoney(stats.avg_order);
}

function renderWeeklyChart(weeks) {
  const canvas = $('chart-weekly');
  if (!canvas || typeof Chart === 'undefined') return;
  if (state.charts.weekly) state.charts.weekly.destroy();
  state.charts.weekly = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: weeks.map(w => w.label),
      datasets: [{
        label: 'Pedidos',
        data: weeks.map(w => w.count),
        backgroundColor: 'rgba(37,99,235,0.75)',
        borderRadius: 5,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 }, grid: { color: '#f1f5f9' } },
        x: { grid: { display: false } }
      }
    }
  });
}

function renderStatusChart(byStatus) {
  const canvas = $('chart-status');
  if (!canvas || typeof Chart === 'undefined') return;
  if (state.charts.status) state.charts.status.destroy();

  const colorMap = { 'Pendiente':'#f59e0b','En preparación':'#3b82f6','Entregado':'#10b981','Cancelado':'#94a3b8' };
  const labels = byStatus.map(s => s.status);
  const data   = byStatus.map(s => s.cnt);
  const colors = labels.map(l => colorMap[l] || '#cbd5e1');

  state.charts.status = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { padding: 14, font: { size: 12 } } } }
    }
  });
}

function renderTopProducts(products) {
  const tbody = $('top-products-tbody');
  const noEl  = $('no-top-products');
  if (!products.length) { tbody.innerHTML = ''; noEl.classList.remove('hidden'); return; }
  noEl.classList.add('hidden');
  tbody.innerHTML = products.map((p, i) => `
    <tr>
      <td style="color:var(--text-muted);font-weight:600">${i + 1}</td>
      <td>${esc(p.product_name)}</td>
      <td class="text-right">${p.total_qty}</td>
      <td class="text-center">${p.order_count}</td>
      <td class="text-right" style="font-weight:600;color:var(--primary)">${fmtMoney(p.revenue)}</td>
    </tr>
  `).join('');
}

$('btn-report-pdf').addEventListener('click', () => window.open('/api/reports/print', '_blank'));
$('btn-report-excel').addEventListener('click', () => { window.location.href = '/api/reports/excel'; });

/* ================================================================ CUSTOMERS */
function showClientsSubview(view) {
  $('clients-list-view').classList.toggle('hidden', view !== 'list');
  $('clients-form-view').classList.toggle('hidden', view !== 'form');
  $('clients-account-view').classList.toggle('hidden', view !== 'account');
}

async function loadClients() {
  try {
    const clients = await api('GET', '/customers');
    renderClients(clients);
  } catch (err) { toast(err.message, 'error'); }
}

function renderClients(clients) {
  const tbody = $('clients-tbody');
  const noEl  = $('no-clients');
  $('clients-count').textContent = `${clients.length} cliente${clients.length !== 1 ? 's' : ''}`;

  if (!clients.length) { tbody.innerHTML = ''; noEl.classList.remove('hidden'); return; }
  noEl.classList.add('hidden');

  tbody.innerHTML = clients.map(c => {
    const bal = c.balance || 0;
    const balFmt = bal > 0.005
      ? `<span style="color:var(--danger);font-weight:600">${fmtMoney(bal)}</span>`
      : bal < -0.005
        ? `<span style="color:var(--success-txt);font-weight:600">A favor ${fmtMoney(-bal)}</span>`
        : `<span style="color:var(--text-muted)">Sin deuda</span>`;
    return `<tr>
      <td style="font-weight:500">${esc(c.name)}</td>
      <td style="color:var(--text-muted);font-size:.85rem;font-family:monospace">${esc(formatCuit(c.cuit) || '—')}</td>
      <td style="color:var(--text-muted)">${esc(c.phone || '—')}</td>
      <td style="color:var(--text-muted);font-size:.85rem">${esc(c.email || '—')}</td>
      ${isAdmin() ? `<td style="color:var(--text-muted);font-size:.83rem">${esc(c.vendor_name || '—')}</td>` : ''}
      <td style="color:var(--text-muted);font-size:.85rem">${esc(c.address || '—')}</td>
      <td class="text-right">${balFmt}</td>
      <td class="text-center" style="white-space:nowrap">
        <button class="btn-icon" onclick="openAccountView(${c.id})" title="Cuenta corriente">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
        </button>
        <button class="btn-icon" onclick="newOrderForClient('${esc(c.name)}')" title="Crear pedido">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
        </button>
        <button class="btn-icon" onclick="openClientForm(${c.id})" title="Editar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-icon btn-delete" onclick="deleteClient(${c.id},'${esc(c.name)}')" title="Eliminar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

$('btn-new-client').addEventListener('click', () => openClientForm(null));
$('btn-clients-back').addEventListener('click', () => { showClientsSubview('list'); loadClients(); });
$('btn-client-cancel').addEventListener('click', () => { showClientsSubview('list'); loadClients(); });

window.openClientForm = function(id) {
  state.editingClientId = id || null;
  $('client-form-title').textContent = id ? 'Editar Cliente' : 'Nuevo Cliente';
  $('inp-client-name').value    = '';
  $('inp-client-cuit').value    = '';
  $('inp-client-phone').value   = '';
  $('inp-client-email').value   = '';
  $('inp-client-address').value = '';
  $('inp-client-notes').value   = '';
  $('inp-client-iva').value     = 'Consumidor Final';
  $('lbl-client-cuit').className = id ? 'label' : 'label required';

  if (id) {
    api('GET', '/customers').then(list => {
      const c = list.find(x => x.id === id);
      if (c) {
        $('inp-client-name').value    = c.name;
        $('inp-client-cuit').value    = formatCuit(c.cuit);
        $('inp-client-phone').value   = c.phone || '';
        $('inp-client-email').value   = c.email || '';
        $('inp-client-address').value = c.address || '';
        $('inp-client-notes').value   = c.notes || '';
        $('inp-client-iva').value     = c.iva_condition || 'Consumidor Final';
      }
    });
  }
  showClientsSubview('form');
  setTimeout(() => $('inp-client-name').focus(), 50);
};

/* ================================================================ CUENTA CORRIENTE */
let _accountCustomerId = null;

window.openAccountView = async function(customerId) {
  _accountCustomerId = customerId;
  showClientsSubview('account');
  await loadAccount();
};

$('btn-account-back').addEventListener('click', () => { showClientsSubview('list'); loadClients(); });

async function loadAccount() {
  if (!_accountCustomerId) return;
  try {
    const data = await api('GET', `/customers/${_accountCustomerId}/account`);
    $('account-client-name').textContent = data.customer.name;
    $('account-client-iva').textContent  = data.customer.iva_condition || 'Consumidor Final';

    $('account-total-debt').textContent = fmtMoney(data.total_debt);
    $('account-total-paid').textContent = fmtMoney(data.total_paid);
    const bal = data.balance;
    $('account-balance').textContent = fmtMoney(Math.abs(bal));
    const bc = $('account-balance-card');
    bc.className = 'account-card ' + (bal > 0.005 ? 'account-card-debt' : bal < -0.005 ? 'account-card-credit' : 'account-card-paid');
    $('account-balance-card').querySelector('.account-card-label').textContent =
      bal > 0.005 ? 'Saldo deudor' : bal < -0.005 ? 'Saldo a favor' : 'Sin deuda';

    // Remitos
    const rtbody = $('account-remitos-tbody');
    if (!data.remitos.length) {
      rtbody.innerHTML = '';
      $('no-account-remitos').classList.remove('hidden');
    } else {
      $('no-account-remitos').classList.add('hidden');
      rtbody.innerHTML = data.remitos.map(r => `<tr>
        <td><span class="order-num">${esc(r.remito_number)}</span></td>
        <td style="color:var(--text-muted)">#${esc(r.order_number)}</td>
        <td style="color:var(--text-muted);font-size:.83rem">${fmtDateTime(r.created_at)}</td>
        <td class="text-right" style="font-weight:600">${fmtMoney(r.total)}</td>
        <td class="text-center">
          <a href="/api/remitos/${r.id}/print" target="_blank" class="btn-icon" title="Ver PDF">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </a>
        </td>
      </tr>`).join('');
    }

    // Pagos
    const ptbody = $('account-payments-tbody');
    const methodLabel = { efectivo:'Efectivo', cheque:'Cheque', transferencia:'Transferencia', tarjeta:'Tarjeta', otros:'Otros' };
    if (!data.payments.length) {
      ptbody.innerHTML = '';
      $('no-account-payments').classList.remove('hidden');
    } else {
      $('no-account-payments').classList.add('hidden');
      ptbody.innerHTML = data.payments.map(p => {
        const detail = [p.bank, p.reference, p.notes].filter(Boolean).join(' · ');
        return `<tr>
          <td style="color:var(--text-muted);font-size:.83rem">${fmtDateTime(p.created_at)}</td>
          <td><span class="badge badge-info">${methodLabel[p.method] || p.method}</span></td>
          <td style="color:var(--text-muted);font-size:.85rem">${esc(detail || '—')}</td>
          <td class="text-right" style="font-weight:600;color:var(--success-txt)">${fmtMoney(p.amount)}</td>
          <td class="text-center admin-only">
            <button class="btn-icon btn-delete" onclick="deletePayment(${p.id})" title="Eliminar pago">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
            </button>
          </td>
        </tr>`;
      }).join('');
    }
    // Notas de débito/crédito
    const ntbody = $('account-notes-tbody');
    if (!data.notes || !data.notes.length) {
      ntbody.innerHTML = '';
      $('no-account-notes').classList.remove('hidden');
    } else {
      $('no-account-notes').classList.add('hidden');
      ntbody.innerHTML = data.notes.map(n => `<tr>
        <td>${fmtDate(n.date)}</td>
        <td><span class="badge ${n.note_type==='debito'?'badge-warning':'badge-success'}">${n.note_type==='debito'?'Débito':'Crédito'}</span></td>
        <td>${esc(n.description)}</td>
        <td style="color:var(--text-muted);font-size:.82rem">${esc(n.reference||'—')}</td>
        <td class="text-right" style="font-weight:600;color:${n.note_type==='debito'?'var(--error)':'var(--success)'}">${fmtMoney(n.amount)}</td>
        <td class="text-center">
          <button class="btn-icon btn-delete" onclick="deleteNote(${n.id},'customer',${n.entity_id})" title="Eliminar">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
          </button>
        </td>
      </tr>`).join('');
    }
    // Reapply admin-only visibility
    document.querySelectorAll('#clients-account-view .admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  } catch (err) { toast(err.message, 'error'); }
}

window.deletePayment = async function(id) {
  if (!await confirm('¿Eliminar este pago? El saldo se ajustará automáticamente.')) return;
  try {
    await api('DELETE', `/payments/${id}`);
    toast('Pago eliminado', 'success');
    loadAccount();
  } catch (err) { toast(err.message, 'error'); }
};

/* ── Payment modal ─────────────────────────────────────────────────────────── */

// Load bank accounts into a select element
async function populateBankSelect(selectEl) {
  try {
    const accounts = await api('GET', '/bank/accounts');
    selectEl.innerHTML = '<option value="">— Seleccioná cuenta —</option>' +
      accounts.map(a => `<option value="${a.id}">${esc(a.name)}${a.bank ? ' — ' + a.bank : ''} (${fmtMoney(a.balance)})</option>`).join('');
  } catch(e) { selectEl.innerHTML = '<option value="">Error al cargar cuentas</option>'; }
}

function updatePaymentFields() {
  const method = $('inp-payment-method').value;
  $('payment-bankacct-wrap').classList.toggle('hidden', !['transferencia','tarjeta'].includes(method));
  $('payment-cheque-wrap').classList.toggle('hidden', method !== 'cheque');
  $('payment-reference-wrap').classList.toggle('hidden', method !== 'otros');
}
$('inp-payment-method').addEventListener('change', updatePaymentFields);

$('btn-new-payment').addEventListener('click', () => {
  $('inp-payment-method').value    = 'efectivo';
  $('inp-payment-amount').value    = '';
  $('inp-payment-date').value      = '';
  $('inp-payment-reference').value = '';
  $('inp-payment-notes').value     = '';
  $('inp-payment-cheque-bank').value   = '';
  $('inp-payment-cheque-number').value = '';
  $('inp-payment-cheque-due').value    = '';
  updatePaymentFields();
  populateBankSelect($('inp-payment-bank-account'));
  $('payment-modal').classList.remove('hidden');
});
$('btn-payment-cancel').addEventListener('click', () => $('payment-modal').classList.add('hidden'));
$('payment-modal').addEventListener('click', e => { if (e.target === $('payment-modal')) $('payment-modal').classList.add('hidden'); });

$('btn-payment-confirm').addEventListener('click', async () => {
  const btn  = $('btn-payment-confirm');
  const method = $('inp-payment-method').value;
  btn.disabled = true;
  try {
    const payload = {
      customer_id:  _accountCustomerId,
      amount:       parseFloat($('inp-payment-amount').value),
      method,
      payment_date: $('inp-payment-date').value || null,
      notes:        $('inp-payment-notes').value.trim(),
      reference:    $('inp-payment-reference').value.trim(),
    };
    if (['transferencia','tarjeta'].includes(method)) {
      payload.bank_account_id = $('inp-payment-bank-account').value;
      if (!payload.bank_account_id) { toast('Seleccioná una cuenta bancaria', 'error'); btn.disabled = false; return; }
    }
    if (method === 'cheque') {
      payload.cheque_bank    = $('inp-payment-cheque-bank').value.trim();
      payload.cheque_number  = $('inp-payment-cheque-number').value.trim();
      payload.cheque_due_date= $('inp-payment-cheque-due').value;
      if (!payload.cheque_bank || !payload.cheque_number || !payload.cheque_due_date) {
        toast('Completá los datos del cheque', 'error'); btn.disabled = false; return;
      }
    }
    await api('POST', '/payments', payload);
    $('payment-modal').classList.add('hidden');
    toast('Pago registrado', 'success');
    loadAccount();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

window.deleteClient = async function(id, name) {
  if (!await confirm(`¿Eliminar al cliente "${name}"?`)) return;
  try {
    await api('DELETE', `/customers/${id}`);
    toast('Cliente eliminado', 'success');
    loadClients();
  } catch (err) { toast(err.message, 'error'); }
};

window.newOrderForClient = function(clientName) {
  navigate('pedidos');
  setTimeout(() => openOrderForm(null, clientName), 100);
};

$('client-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('inp-client-name').value.trim();
  if (!name) { toast('El nombre es requerido', 'error'); $('inp-client-name').focus(); return; }
  const rawCuit = $('inp-client-cuit').value.trim();
  const normalizedCuit = rawCuit.replace(/\D/g, '');
  if (!state.editingClientId) {
    if (!normalizedCuit) { toast('El CUIT es requerido', 'error'); $('inp-client-cuit').focus(); return; }
    if (normalizedCuit.length !== 11) { toast('El CUIT debe tener 11 dígitos (formato: XX-XXXXXXXX-X)', 'error'); $('inp-client-cuit').focus(); return; }
  } else if (rawCuit && normalizedCuit.length !== 11) {
    toast('El CUIT debe tener 11 dígitos (formato: XX-XXXXXXXX-X)', 'error'); $('inp-client-cuit').focus(); return;
  }
  const data = {
    name,
    cuit:          normalizedCuit || '',
    phone:         $('inp-client-phone').value.trim(),
    email:         $('inp-client-email').value.trim(),
    address:       $('inp-client-address').value.trim(),
    notes:         $('inp-client-notes').value.trim(),
    iva_condition: $('inp-client-iva').value
  };
  const btn = $('btn-client-save');
  btn.disabled = true;
  try {
    if (state.editingClientId) {
      await api('PUT', `/customers/${state.editingClientId}`, data);
      toast('Cliente actualizado', 'success');
    } else {
      await api('POST', '/customers', data);
      toast('Cliente creado', 'success');
    }
    showClientsSubview('list');
    loadClients();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

/* ================================================================ SETTINGS */
$('btn-settings').addEventListener('click', () => $('settings-modal').classList.remove('hidden'));
$('btn-settings-cancel').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
$('settings-modal').addEventListener('click', e => { if (e.target === $('settings-modal')) $('settings-modal').classList.add('hidden'); });

$('btn-settings-save').addEventListener('click', async () => {
  try {
    const cfg = await api('PUT', '/settings', { company_name: $('inp-company-name').value.trim() });
    $('sidebar-company').textContent = cfg.company_name || 'Pedidos';
    $('mobile-company-name').textContent = cfg.company_name || 'Pedidos';
    $('settings-modal').classList.add('hidden');
    toast('Configuración guardada', 'success');
  } catch (err) { toast(err.message, 'error'); }
});

/* ================================================================ ENTREGAS PARCIALES */

async function loadDeliveries(orderId) {
  try {
    const deliveries = await api('GET', `/orders/${orderId}/deliveries`);
    renderDeliveries(deliveries);
  } catch (err) { toast(err.message, 'error'); }
}

function renderDeliveries(deliveries) {
  const body = $('deliveries-body');

  if (!deliveries.length) {
    body.innerHTML = '<div class="empty-items">Todavía no hay entregas registradas para este pedido.</div>';
    return;
  }

  body.innerHTML = deliveries.map((d, i) => `
    <div class="delivery-entry">
      <div class="delivery-entry-header">
        <span class="delivery-num">Entrega #${i + 1}</span>
        <span class="delivery-date">${fmtDateTime(d.created_at)}</span>
        ${d.remito ? `<a href="/api/remitos/${d.remito.id}/print" target="_blank" class="btn btn-ghost btn-sm" style="margin-left:8px;padding:3px 9px;font-size:.78rem">${esc(d.remito.number)}</a>` : ''}
        ${isAdmin() ? `<button class="btn-icon btn-delete" style="margin-left:auto"
          onclick="deleteDelivery(${state.editingOrderId},${d.id},${i+1})" title="Cancelar esta entrega">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        </button>` : ''}
      </div>
      <div class="delivery-items-list">
        ${d.items.map(it => `
          <span class="delivery-item-chip">
            ${esc(it.product_name)} &times; <strong>${it.quantity_delivered}</strong>
          </span>
        `).join('')}
      </div>
      ${d.notes ? `<div class="delivery-notes">${esc(d.notes)}</div>` : ''}
    </div>
  `).join('');
}

$('btn-register-delivery').addEventListener('click', openDeliveryModal);
$('btn-delivery-cancel').addEventListener('click',  () => $('delivery-modal').classList.add('hidden'));
$('delivery-modal').addEventListener('click', e => { if (e.target === $('delivery-modal')) $('delivery-modal').classList.add('hidden'); });

async function openDeliveryModal() {
  const orderId = state.editingOrderId;
  if (!orderId) return;

  try {
    const [order, deliveries] = await Promise.all([
      api('GET', `/orders/${orderId}`),
      api('GET', `/orders/${orderId}/deliveries`)
    ]);

    // Calcular total entregado por ítem
    const deliveredMap = {};
    for (const d of deliveries) {
      for (const di of d.items) {
        deliveredMap[di.order_item_id] = (deliveredMap[di.order_item_id] || 0) + di.quantity_delivered;
      }
    }

    const modalItems = order.items.map(item => ({
      order_item_id:      item.id,
      product_name:       item.product_name,
      quantity_ordered:   item.quantity,
      quantity_delivered: deliveredMap[item.id] || 0,
      quantity_remaining: Math.max(0, item.quantity - (deliveredMap[item.id] || 0))
    }));

    $('delivery-modal-tbody').innerHTML = modalItems.map(it => `
      <tr>
        <td>${esc(it.product_name)}</td>
        <td class="text-right">${it.quantity_ordered}</td>
        <td class="text-right" style="color:${it.quantity_delivered > 0 ? 'var(--success-txt)' : 'var(--text-muted)'}">
          ${it.quantity_delivered}
        </td>
        <td class="text-right">
          <input type="number" class="input delivery-qty-inp" data-item-id="${it.order_item_id}"
            min="0" max="${it.quantity_remaining}" step="any" value="0"
            style="width:80px;text-align:right;padding:5px 8px"
            ${it.quantity_remaining <= 0 ? 'disabled placeholder="Completo"' : ''}>
        </td>
      </tr>
    `).join('');

    $('inp-delivery-notes').value = '';
    $('chk-delivery-complete').checked = false;
    $('chk-delivery-complete').closest('label').classList.remove('active');
    $('delivery-modal').classList.remove('hidden');
  } catch (err) { toast(err.message, 'error'); }
}

$('chk-delivery-complete').addEventListener('change', function () {
  const checked = this.checked;
  this.closest('label').classList.toggle('active', checked);
  document.querySelectorAll('.delivery-qty-inp').forEach(inp => {
    if (inp.disabled) return;
    inp.value = checked ? (inp.max || 0) : 0;
  });
});

$('btn-delivery-confirm').addEventListener('click', async () => {
  const orderId = state.editingOrderId;
  if (!orderId) return;

  const items = [];
  document.querySelectorAll('.delivery-qty-inp').forEach(inp => {
    const qty = parseFloat(inp.value) || 0;
    if (qty > 0) items.push({ order_item_id: Number(inp.dataset.itemId), quantity_delivered: qty });
  });

  if (!items.length) { toast('Ingresá al menos una cantidad mayor a 0', 'error'); return; }

  const btn = $('btn-delivery-confirm');
  btn.disabled = true;
  try {
    await api('POST', `/orders/${orderId}/deliveries`, {
      notes: $('inp-delivery-notes').value.trim(),
      items
    });
    $('delivery-modal').classList.add('hidden');
    toast('Entrega registrada', 'success');

    // Refrescar estado del pedido en el form
    const updated = await api('GET', `/orders/${orderId}`);
    $('inp-status').value = updated.status;
    $('form-status-badge').innerHTML = statusBadge(updated.status);
    loadDeliveries(orderId);
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

/* ================================================================ IMPORTAR PRODUCTOS */

function parseFileRows(file) {
  return new Promise((resolve, reject) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const reader = new FileReader();

    reader.onerror = () => reject(new Error('No se pudo leer el archivo. Verificá que no esté dañado o abierto en otro programa.'));

    reader.onload = e => {
      try {
        // cellDates:false + cellNF:false evitan que SheetJS intente convertir
        // celdas con formato de fecha/número, que causa "did not match pattern"
        const readOpts = { cellDates: false, cellNF: false, cellStyles: false };
        let wb;
        if (ext === 'csv') {
          wb = XLSX.read(e.target.result, { type: 'string', ...readOpts });
        } else {
          wb = XLSX.read(e.target.result, { type: 'binary', ...readOpts });
        }

        if (!wb.SheetNames.length)
          return reject(new Error('El archivo no contiene hojas de datos.'));

        const ws = wb.Sheets[wb.SheetNames[0]];
        // raw:true devuelve el valor crudo de cada celda sin intentar formatearlo
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });

        if (!rows.length)
          return reject(new Error('El archivo está vacío o solo tiene encabezados. Agregá al menos una fila de datos.'));

        resolve(rows);
      } catch (err) {
        const msg = err.message || '';
        let human;
        if (msg.includes('zip') || msg.includes('PK')) {
          human = 'El archivo no es un Excel válido (.xlsx). Si usás Google Sheets, exportá desde Archivo → Descargar → .xlsx o .csv. Si tenés un .xls antiguo, abrilo y guardalo como .xlsx.';
        } else if (msg.includes('CFB') || msg.includes('BIFF')) {
          human = 'Formato Excel antiguo (.xls) no compatible. Abrí el archivo y guardalo como .xlsx, luego intentá de nuevo.';
        } else {
          human = `No se pudo leer el archivo: ${msg || 'formato no reconocido'}. Descargá la plantilla de ejemplo para ver el formato correcto.`;
        }
        reject(new Error(human));
      }
    };

    if (ext === 'csv') {
      reader.readAsText(file, 'UTF-8');
    } else {
      reader.readAsBinaryString(file);
    }
  });
}

function normalizeKey(obj, variants) {
  const keys = Object.keys(obj);
  for (const v of variants) {
    const k = keys.find(k => k.toLowerCase().trim() === v);
    if (k !== undefined) return String(obj[k] || '').trim();
  }
  return '';
}

// ── Productos ──

let importProductsData = [];

$('btn-import-products').addEventListener('click', () => {
  importProductsData = [];
  $('inp-import-products-file').value = '';
  $('import-products-preview').classList.add('hidden');
  $('btn-import-products-confirm').classList.add('hidden');
  $('import-products-modal').classList.remove('hidden');
});

$('btn-import-products-cancel').addEventListener('click', () => $('import-products-modal').classList.add('hidden'));
$('import-products-modal').addEventListener('click', e => {
  if (e.target === $('import-products-modal')) $('import-products-modal').classList.add('hidden');
});

$('inp-import-products-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const rows = await parseFileRows(file);
    importProductsData = rows.map(r => ({
      nombre: normalizeKey(r, ['nombre','name','producto','product']),
      precio: normalizeKey(r, ['precio','price','base_price','precio_base','valor','value'])
    })).filter(r => r.nombre);

    if (!importProductsData.length) { toast('No se encontraron filas con nombre de producto', 'error'); return; }

    $('import-products-count').textContent = `${importProductsData.length} producto${importProductsData.length !== 1 ? 's' : ''} encontrado${importProductsData.length !== 1 ? 's' : ''}`;
    $('import-products-tbody').innerHTML = importProductsData.map(p => `
      <tr>
        <td>${esc(p.nombre)}</td>
        <td class="text-right">${p.precio ? fmtMoney(parseFloat(String(p.precio).replace(',','.')) || 0) : '—'}</td>
      </tr>
    `).join('');
    $('import-products-preview').classList.remove('hidden');
    $('btn-import-products-confirm').classList.remove('hidden');
  } catch (err) { toast('Error al leer el archivo: ' + err.message, 'error'); }
});

$('btn-import-products-confirm').addEventListener('click', async () => {
  if (!importProductsData.length) return;
  const btn = $('btn-import-products-confirm');
  btn.disabled = true;
  try {
    const result = await api('POST', '/products/import', {
      products: importProductsData.map(p => ({
        nombre: p.nombre,
        precio: parseFloat(String(p.precio).replace(',', '.')) || 0
      }))
    });
    $('import-products-modal').classList.add('hidden');
    toast(`${result.imported} producto${result.imported !== 1 ? 's' : ''} importado${result.imported !== 1 ? 's' : ''} correctamente`, 'success');
    if (result.errors && result.errors.length) console.warn('Errores de importación:', result.errors);
    await loadProductCatalog();
    loadCatalog();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── Clientes ──

let importClientsData = [];

$('btn-import-clients').addEventListener('click', () => {
  importClientsData = [];
  $('inp-import-clients-file').value = '';
  $('import-clients-preview').classList.add('hidden');
  $('btn-import-clients-confirm').classList.add('hidden');
  $('import-clients-error').classList.add('hidden');
  $('import-clients-modal').classList.remove('hidden');
});

$('btn-import-clients-cancel').addEventListener('click', () => $('import-clients-modal').classList.add('hidden'));

$('btn-clients-template').addEventListener('click', () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['nombre', 'telefono', 'email', 'direccion'],
    ['Juan García', '11 1234-5678', 'juan@ejemplo.com', 'Av. Corrientes 1234, CABA'],
    ['María López', '351 555-6789', 'maria@empresa.com', 'San Martín 567, Córdoba'],
    ['Empresa ABC S.A.', '11 9876-5432', 'compras@abc.com', 'Callao 890, CABA']
  ]);
  ws['!cols'] = [{ wch: 32 }, { wch: 18 }, { wch: 30 }, { wch: 38 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Clientes');
  XLSX.writeFile(wb, 'plantilla-clientes.xlsx');
});
$('import-clients-modal').addEventListener('click', e => {
  if (e.target === $('import-clients-modal')) $('import-clients-modal').classList.add('hidden');
});

$('inp-import-clients-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;

  const errEl = $('import-clients-error');
  errEl.classList.add('hidden');
  $('import-clients-preview').classList.add('hidden');
  $('btn-import-clients-confirm').classList.add('hidden');

  try {
    const rows = await parseFileRows(file);
    importClientsData = rows.map(r => ({
      nombre:   normalizeKey(r, ['nombre','name','cliente','customer','razón social','razon social']),
      telefono: normalizeKey(r, ['telefono','teléfono','phone','tel','celular','móvil','movil']),
      email:    normalizeKey(r, ['email','correo','mail','e-mail','correo electrónico']),
      direccion:normalizeKey(r, ['direccion','dirección','address','domicilio'])
    })).filter(r => r.nombre);

    if (!importClientsData.length) {
      errEl.textContent = 'No se encontró ninguna columna "nombre" en el archivo. Revisá que la primera fila tenga los encabezados correctos (nombre, telefono, email, direccion). Descargá la plantilla de ejemplo para ver el formato.';
      errEl.classList.remove('hidden');
      return;
    }

    $('import-clients-count').textContent = `${importClientsData.length} cliente${importClientsData.length !== 1 ? 's' : ''} encontrado${importClientsData.length !== 1 ? 's' : ''}`;
    $('import-clients-tbody').innerHTML = importClientsData.map(c => `
      <tr>
        <td>${esc(c.nombre)}</td>
        <td style="color:var(--text-muted)">${esc(c.telefono || '—')}</td>
        <td style="color:var(--text-muted)">${esc(c.email || '—')}</td>
        <td style="color:var(--text-muted)">${esc(c.direccion || '—')}</td>
      </tr>
    `).join('');
    $('import-clients-preview').classList.remove('hidden');
    $('btn-import-clients-confirm').classList.remove('hidden');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('btn-import-clients-confirm').addEventListener('click', async () => {
  if (!importClientsData.length) return;
  const btn = $('btn-import-clients-confirm');
  btn.disabled = true;
  try {
    const result = await api('POST', '/customers/import', { customers: importClientsData });
    $('import-clients-modal').classList.add('hidden');
    toast(`${result.imported} cliente${result.imported !== 1 ? 's' : ''} importado${result.imported !== 1 ? 's' : ''} correctamente`, 'success');
    if (result.errors && result.errors.length) console.warn('Errores de importación:', result.errors);
    loadClients();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

/* ================================================================ STOCK */

// ── Tab navigation ─────────────────────────────────────────────────────────────
function showStockTab(tab) {
  document.querySelectorAll('.stock-tab').forEach(b => b.classList.toggle('active', b.dataset.stockTab === tab));
  $('stock-tab-lista').classList.toggle('hidden', tab !== 'lista');
  $('stock-tab-historial').classList.toggle('hidden', tab !== 'historial');
}
document.querySelectorAll('.stock-tab').forEach(b => {
  b.addEventListener('click', () => {
    showStockTab(b.dataset.stockTab);
    if (b.dataset.stockTab === 'historial') loadStockHistory(1);
  });
});
$('btn-refresh-stock').addEventListener('click', loadStock);
$('btn-refresh-stock-hist').addEventListener('click', () => loadStockHistory(1));

// ── Helpers ───────────────────────────────────────────────────────────────────
const TYPE_LABEL = {
  ingreso:        { label: 'Ingreso',   cls: 'badge-stock-ok'  },
  ajuste_entrada: { label: 'Ajuste +',  cls: 'badge-info'      },
  ajuste_salida:  { label: 'Ajuste −',  cls: 'badge-stock-low' },
  egreso:         { label: 'Egreso',    cls: 'badge-stock-out' },
  venta:          { label: 'Venta',     cls: 'badge-stock-out' },
};
function movTypeBadge(type) {
  const t = TYPE_LABEL[type] || { label: type, cls: 'badge-default' };
  return `<span class="badge ${t.cls}">${t.label}</span>`;
}

// ── Main list ─────────────────────────────────────────────────────────────────
async function loadStock() {
  try {
    const [products, alerts] = await Promise.all([
      api('GET', '/stock'),
      api('GET', '/stock/alerts')
    ]);
    renderStockAlertsBanner(alerts);
    renderStock(products);
  } catch (err) { toast(err.message, 'error'); }
}

function renderStockAlertsBanner(alerts) {
  const banner = $('stock-alerts-banner');
  if (!banner) return;
  if (!alerts.length) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    <strong>${alerts.length} producto${alerts.length !== 1 ? 's' : ''} con stock bajo:</strong>
    ${alerts.map(a => `<span class="alert-chip">${esc(a.name)} <strong>(${a.stock})</strong></span>`).join('')}
  `;
}

function renderStock(products) {
  const tbody = $('stock-tbody');
  const noEl  = $('no-stock');
  $('stock-count').textContent = `${products.length} artículo${products.length !== 1 ? 's' : ''}`;

  if (!products.length) { tbody.innerHTML = ''; noEl.classList.remove('hidden'); return; }
  noEl.classList.add('hidden');

  tbody.innerHTML = products.map(p => {
    const diff    = p.difference;
    const diffFmt = diff < 0
      ? `<span style="color:var(--error);font-weight:700">${diff}</span>`
      : `<span style="color:var(--success);font-weight:700">${diff >= 0 ? '+' : ''}${diff}</span>`;
    const lastUpd = p.last_updated
      ? `<span style="font-size:.8rem">${fmtDate(p.last_updated)}</span>${p.last_updated_by ? `<br><span style="font-size:.75rem;color:var(--text-muted)">${esc(p.last_updated_by)}</span>` : ''}`
      : '<span style="color:var(--text-muted);font-size:.8rem">—</span>';
    const rowCls = diff < 0 ? 'stock-critical' : (p.stock_min > 0 && p.stock <= p.stock_min && p.stock > 0 ? 'stock-low' : '');
    return `<tr class="${rowCls}">
      <td style="font-weight:500">${esc(p.name)}</td>
      <td class="text-center" style="font-weight:700;font-size:1.05rem">${p.stock}</td>
      <td class="text-center" style="color:var(--text-muted)">${p.pending_orders > 0 ? `<strong>${p.pending_orders}</strong>` : '—'}</td>
      <td class="text-center">${diffFmt}</td>
      <td>${lastUpd}</td>
      <td class="text-center">
        <button class="btn-icon" onclick="openStockEditModal(${p.id},'${esc(p.name)}',${p.stock})" title="Ajustar stock">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

// ── Ingreso modal (kept as-is) ────────────────────────────────────────────────
$('btn-new-ingreso').addEventListener('click', () => openIngresoModal(null));

window.openIngresoModal = async function(productId) {
  try {
    const products = await api('GET', '/stock');
    const sel = $('inp-ingreso-product');
    sel.innerHTML = products.map(p =>
      `<option value="${p.id}" ${p.id === productId ? 'selected' : ''}>${esc(p.name)} (stock: ${p.stock})</option>`
    ).join('');
    $('inp-ingreso-qty').value   = '';
    $('inp-ingreso-notes').value = '';
    $('ingreso-modal').classList.remove('hidden');
    setTimeout(() => (productId ? $('inp-ingreso-qty') : $('inp-ingreso-product')).focus(), 50);
  } catch (err) { toast(err.message, 'error'); }
};

$('btn-ingreso-cancel').addEventListener('click', () => $('ingreso-modal').classList.add('hidden'));
$('ingreso-modal').addEventListener('click', e => { if (e.target === $('ingreso-modal')) $('ingreso-modal').classList.add('hidden'); });

$('btn-ingreso-confirm').addEventListener('click', async () => {
  const product_id = $('inp-ingreso-product').value;
  const quantity   = parseFloat($('inp-ingreso-qty').value);
  const notes      = $('inp-ingreso-notes').value.trim();
  if (!product_id) { toast('Seleccioná un producto', 'error'); return; }
  if (!quantity || quantity <= 0) { toast('Ingresá una cantidad mayor a 0', 'error'); $('inp-ingreso-qty').focus(); return; }
  const btn = $('btn-ingreso-confirm');
  btn.disabled = true;
  try {
    await api('POST', '/stock/ingresos', { product_id, quantity, notes });
    $('ingreso-modal').classList.add('hidden');
    toast('Ingreso registrado correctamente', 'success');
    loadStock();
    await loadProductCatalog();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── Edit (ajuste manual) modal ────────────────────────────────────────────────
let _stockEditId = null;

window.openStockEditModal = function(id, name, currentStock) {
  _stockEditId = id;
  $('stock-edit-product-name').textContent = name;
  $('stock-edit-prev').textContent = `Stock actual: ${currentStock}`;
  $('inp-stock-edit-qty').value  = currentStock;
  $('inp-stock-edit-note').value = '';
  $('stock-edit-modal').classList.remove('hidden');
  setTimeout(() => { $('inp-stock-edit-qty').focus(); $('inp-stock-edit-qty').select(); }, 50);
};

$('btn-stock-edit-cancel').addEventListener('click', () => $('stock-edit-modal').classList.add('hidden'));
$('stock-edit-modal').addEventListener('click', e => { if (e.target === $('stock-edit-modal')) $('stock-edit-modal').classList.add('hidden'); });

$('btn-stock-edit-save').addEventListener('click', async () => {
  if (!_stockEditId) return;
  const quantity = parseFloat($('inp-stock-edit-qty').value);
  const note     = $('inp-stock-edit-note').value.trim();
  if (isNaN(quantity) || quantity < 0) { toast('Ingresá una cantidad válida (≥ 0)', 'error'); return; }
  const btn = $('btn-stock-edit-save');
  btn.disabled = true;
  try {
    await api('PUT', `/stock/${_stockEditId}`, { quantity, note });
    $('stock-edit-modal').classList.add('hidden');
    toast('Stock actualizado', 'success');
    loadStock();
    await loadProductCatalog();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── Per-product movements modal (kept for catalog use) ────────────────────────
window.openMovementsModal = async function(productId, productName) {
  $('movements-modal-title').textContent = `Historial — ${productName}`;
  $('movements-modal').classList.remove('hidden');
  $('movements-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted)">Cargando...</td></tr>';
  $('no-movements').classList.add('hidden');
  try {
    const data = await api('GET', `/stock/movements/${productId}`);
    if (!data.movements.length) {
      $('movements-tbody').innerHTML = '';
      $('no-movements').classList.remove('hidden');
      return;
    }
    $('movements-tbody').innerHTML = data.movements.map(m => `
      <tr>
        <td style="color:var(--text-muted)">${fmtDateTime(m.created_at)}</td>
        <td class="text-center">${movTypeBadge(m.type)}</td>
        <td class="text-center" style="font-weight:600">${m.quantity}</td>
        <td style="font-size:.85rem">${esc(m.notes || '—')}</td>
        <td style="color:var(--text-muted);font-size:.83rem">${esc(m.user_name || '—')}</td>
      </tr>
    `).join('');
  } catch (err) { toast(err.message, 'error'); $('movements-modal').classList.add('hidden'); }
};

$('btn-movements-close').addEventListener('click', () => $('movements-modal').classList.add('hidden'));
$('movements-modal').addEventListener('click', e => { if (e.target === $('movements-modal')) $('movements-modal').classList.add('hidden'); });

// ── Historial global ──────────────────────────────────────────────────────────
let _histPage    = 1;
let _histFilters = {};

async function loadStockHistory(page = 1) {
  _histPage = page;
  // Populate product filter if empty
  const sel = $('hist-product-filter');
  if (sel.options.length <= 1) {
    try {
      const products = await api('GET', '/stock');
      sel.innerHTML = '<option value="">Todos los artículos</option>' +
        products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    } catch(e) {}
  }

  try {
    const params = new URLSearchParams({ page, per_page: 50, ..._histFilters });
    const data   = await api('GET', `/stock/movements?${params}`);
    $('hist-tbody').innerHTML = data.movements.length ? data.movements.map(m => `
      <tr>
        <td style="color:var(--text-muted);font-size:.85rem">${fmtDateTime(m.created_at)}</td>
        <td style="font-weight:500">${esc(m.product_name)}</td>
        <td class="text-center">${movTypeBadge(m.type)}</td>
        <td class="text-right" style="font-weight:600">${m.quantity}</td>
        <td class="text-right" style="color:var(--text-muted)">${m.previous_qty != null ? m.previous_qty : '—'}</td>
        <td class="text-right" style="color:var(--text-muted)">${m.new_qty != null ? m.new_qty : '—'}</td>
        <td style="font-size:.83rem;color:var(--text-muted)">${esc(m.notes || '—')}</td>
        <td style="font-size:.82rem;color:var(--text-muted)">${esc(m.user_name || '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">Sin movimientos en el período</td></tr>';

    const pages = Math.ceil(data.total / data.per_page);
    $('hist-pagination').innerHTML = pages <= 1 ? '' : `
      <button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="loadStockHistory(${page-1})">← Ant.</button>
      <span style="font-size:.85rem;color:var(--text-muted)">Pág. ${page} / ${pages} · ${data.total} registros</span>
      <button class="btn btn-ghost btn-sm" ${page >= pages ? 'disabled' : ''} onclick="loadStockHistory(${page+1})">Sig. →</button>`;
  } catch (err) { toast(err.message, 'error'); }
}

$('btn-hist-filter').addEventListener('click', () => {
  _histFilters = {};
  const pid = $('hist-product-filter').value;
  const df  = $('hist-date-from').value;
  const dt  = $('hist-date-to').value;
  if (pid) _histFilters.product_id = pid;
  if (df)  _histFilters.date_from  = df;
  if (dt)  _histFilters.date_to    = dt;
  loadStockHistory(1);
});
$('btn-hist-clear').addEventListener('click', () => {
  _histFilters = {};
  $('hist-product-filter').value = '';
  $('hist-date-from').value = '';
  $('hist-date-to').value   = '';
  loadStockHistory(1);
});

window.deleteDelivery = async function(orderId, delivId, num) {
  if (!await confirm(`¿Cancelar la Entrega #${num}? El stock de los productos se va a restaurar.`)) return;
  try {
    await api('DELETE', `/orders/${orderId}/deliveries/${delivId}`);
    toast('Entrega cancelada y stock restaurado', 'success');
    const updated = await api('GET', `/orders/${orderId}`);
    $('inp-status').value = updated.status;
    $('form-status-badge').innerHTML = statusBadge(updated.status);
    loadDeliveries(orderId);
  } catch (err) { toast(err.message, 'error'); }
};

/* ================================================================ COMPRAS */

// ── Tab navigation ──────────────────────────────────────────────────────────
function showComprasTab(tab) {
  document.querySelectorAll('.compras-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.compras-pane').forEach(p => p.classList.add('hidden'));
  $(`compras-tab-${tab}`)?.classList.remove('hidden');
}
document.querySelectorAll('.compras-tab').forEach(b => {
  b.addEventListener('click', () => {
    const tab = b.dataset.tab;
    showComprasTab(tab);
    if (tab === 'proveedores')  { showProveedoresSubview('list'); loadSuppliers(); }
    if (tab === 'comprobantes') { currentPurchaseId = null; showComprobantesSubview('list'); loadPurchases(); }
  });
});

// ── CONTABLE Tab navigation ──────────────────────────────────────────────────
function showContableTab(tab) {
  document.querySelectorAll('.contable-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.contable-pane').forEach(p => p.classList.add('hidden'));
  $(`contable-tab-${tab}`)?.classList.remove('hidden');
}
document.querySelectorAll('.contable-tab').forEach(b => {
  b.addEventListener('click', () => {
    const tab = b.dataset.tab;
    showContableTab(tab);
    if (tab === 'resumen') loadFinanceSummary();
    if (tab === 'caja')    loadCash();
    if (tab === 'banco')   { showBancoSubview('list'); loadBankAccounts(); }
    if (tab === 'cheques') loadCheques();
    if (tab === 'cuentas')    loadAccounts();
    if (tab === 'diario')     loadJournal();
    if (tab === 'asientos')   loadManualEntries();
    if (tab === 'balance')    {}
    if (tab === 'resultados') {}
    if (tab === 'libro-mayor')   loadLibroMayorAccounts();
    if (tab === 'cierres')       loadCierres();
    if (tab === 'conciliacion')  loadRecBankAccounts();
    if (tab === 'calendario')    loadCalendar();
  });
});

// ── FINANCE SUMMARY ─────────────────────────────────────────────────────────
async function loadFinanceSummary() {
  try {
    const d = await api('GET', '/finance/balance');
    const fmtColor = (v, el) => {
      el.textContent = fmtMoney(v);
      el.style.color = v >= 0 ? 'var(--success)' : 'var(--error)';
    };
    fmtColor(d.cash_balance,     $('fin-cash'));
    fmtColor(d.bank_total,       $('fin-bank'));
    fmtColor(d.total_disponible, $('fin-disponible'));
    fmtColor(d.net_position,     $('fin-net'));
    $('fin-ch-cartera').textContent  = fmtMoney(d.cheques_cartera);
    $('fin-ch-count').textContent    = d.cheques_count;
    $('fin-clients').textContent     = fmtMoney(d.client_debt);
    $('fin-suppliers').textContent   = fmtMoney(d.supplier_debt);
    $('fin-ch-cobrar').textContent   = fmtMoney(d.cheques_cobrar);
    $('fin-ch-pagar').textContent    = fmtMoney(d.cheques_pagar);
    // Per-bank rows
    $('fin-banks-rows').innerHTML = d.banks.filter(b => b.active).map(b =>
      `<div class="balance-row balance-indent"><span>${esc(b.name)}${b.bank ? ' — ' + b.bank : ''}</span><span class="balance-amount" style="color:${b.balance>=0?'var(--success)':'var(--error)'}">${fmtMoney(b.balance)}</span></div>`
    ).join('') || '<div class="balance-row balance-indent" style="color:var(--text-muted)"><span>Sin cuentas bancarias</span><span></span></div>';
    // Upcoming cheques list
    if (d.upcoming_cheques.length) {
      $('fin-upcoming-list').innerHTML = `<div class="table-wrap"><table class="table" style="margin-top:0"><thead><tr><th>Tipo</th><th>Banco / Nro</th><th>A/De</th><th class="text-right">Monto</th><th>Vence</th></tr></thead><tbody>` +
        d.upcoming_cheques.map(c => `<tr>
          <td>${c.direction==='recibido' ? '<span class="badge badge-stock-ok">A cobrar</span>' : '<span class="badge badge-stock-out">A pagar</span>'}</td>
          <td>${esc(c.bank)} ${esc(c.cheque_number)}</td>
          <td>${esc(c.customer_name || c.supplier_name || '—')}</td>
          <td class="text-right">${fmtMoney(c.amount)}</td>
          <td>${fmtDate(c.due_date)}</td>
        </tr>`).join('') +
        '</tbody></table></div>';
    } else {
      $('fin-upcoming-list').innerHTML = '<p style="color:var(--text-muted);font-size:.85rem;padding:8px 0">No hay cheques a vencer en los próximos 30 días</p>';
    }
  } catch (err) { toast(err.message, 'error'); }
}
$('btn-refresh-finance').addEventListener('click', loadFinanceSummary);

// ── SUPPLIERS ────────────────────────────────────────────────────────────────
let editingSupplierId = null;
let currentSupplierId = null;

function showProveedoresSubview(v) {
  ['proveedores-list-view','supplier-form-view','supplier-account-view'].forEach(id => $(`${id}`)?.classList.add('hidden'));
  $(`${v === 'list' ? 'proveedores-list-view' : v === 'form' ? 'supplier-form-view' : 'supplier-account-view'}`)?.classList.remove('hidden');
}

async function loadSuppliers() {
  try {
    const rows = await api('GET', '/suppliers');
    $('suppliers-tbody').innerHTML = rows.length ? rows.map(s => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${esc(s.cuit || '—')}</td>
        <td>${esc(s.iva_condition)}</td>
        <td>${esc(s.phone || '—')}</td>
        <td class="text-right" style="font-weight:600;color:${s.balance > 0 ? 'var(--error)' : 'var(--success)'}">${fmtMoney(s.balance)}</td>
        <td class="text-center">
          <button class="btn btn-ghost btn-sm" onclick="openSupplierAccount(${s.id})">Cuenta</button>
          <button class="btn btn-ghost btn-sm" onclick="openSupplierForm(${s.id})">Editar</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deleteSupplier(${s.id},'${esc(s.name)}')">Eliminar</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted)">Sin proveedores</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

$('btn-new-supplier').addEventListener('click', () => openSupplierForm(null));
$('btn-back-suppliers').addEventListener('click', () => { showProveedoresSubview('list'); loadSuppliers(); });
$('btn-sup-form-cancel').addEventListener('click', () => showProveedoresSubview('list'));

window.openSupplierForm = function(id) {
  editingSupplierId = id;
  $('supplier-form-title').textContent = id ? 'Editar Proveedor' : 'Nuevo Proveedor';
  $('supplier-form').reset();
  if (id) {
    api('GET', `/suppliers/${id}`).then(s => {
      $('inp-sup-name').value    = s.name;
      $('inp-sup-cuit').value    = s.cuit || '';
      $('inp-sup-iva').value     = s.iva_condition;
      $('inp-sup-phone').value   = s.phone || '';
      $('inp-sup-email').value   = s.email || '';
      $('inp-sup-address').value = s.address || '';
      $('inp-sup-notes').value   = s.notes || '';
    }).catch(err => toast(err.message, 'error'));
  }
  showProveedoresSubview('form');
};

$('supplier-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('btn-sup-form-save');
  btn.disabled = true;
  try {
    const data = {
      name: $('inp-sup-name').value.trim(),
      cuit: $('inp-sup-cuit').value.trim(),
      iva_condition: $('inp-sup-iva').value,
      phone: $('inp-sup-phone').value.trim(),
      email: $('inp-sup-email').value.trim(),
      address: $('inp-sup-address').value.trim(),
      notes: $('inp-sup-notes').value.trim()
    };
    if (editingSupplierId) await api('PUT', `/suppliers/${editingSupplierId}`, data);
    else await api('POST', '/suppliers', data);
    toast('Proveedor guardado', 'success');
    showProveedoresSubview('list');
    loadSuppliers();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

window.deleteSupplier = async function(id, name) {
  if (!await confirm(`¿Eliminar proveedor "${name}"? Se eliminará toda su historia.`)) return;
  try {
    await api('DELETE', `/suppliers/${id}`);
    toast('Proveedor eliminado', 'success');
    loadSuppliers();
  } catch (err) { toast(err.message, 'error'); }
};

window.openSupplierAccount = async function(id) {
  currentSupplierId = id;
  showProveedoresSubview('account');
  try {
    const d = await api('GET', `/suppliers/${id}/account`);
    $('sup-account-title').textContent = `Cuenta: ${d.supplier.name}`;
    $('sup-account-summary').innerHTML = `
      <div class="account-card account-card-debt"><div class="account-card-label">Total compras</div><div class="account-card-val">${fmtMoney(d.total_debt)}</div></div>
      <div class="account-card account-card-paid"><div class="account-card-label">Total pagado</div><div class="account-card-val">${fmtMoney(d.total_paid)}</div></div>
      <div class="account-card ${d.balance > 0 ? 'account-card-debt' : 'account-card-credit'}"><div class="account-card-label">Saldo deuda</div><div class="account-card-val">${fmtMoney(d.balance)}</div></div>`;
    $('sup-purchases-tbody').innerHTML = d.purchases.length ? d.purchases.map(p => `
      <tr>
        <td>${esc(p.purchase_number)}</td>
        <td>${esc(p.doc_type)}</td>
        <td>${fmtDate(p.doc_date || p.created_at)}</td>
        <td class="text-right">${fmtMoney(p.total)}</td>
        <td class="text-center"><a href="/api/purchases/${p.id}/print" target="_blank" class="btn btn-ghost btn-sm">PDF</a></td>
      </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--text-muted)">Sin comprobantes</td></tr>';
    $('sup-payments-tbody').innerHTML = d.payments.length ? d.payments.map(p => `
      <tr>
        <td>${fmtDate(p.payment_date || p.created_at)}</td>
        <td>${esc(p.method)}</td>
        <td class="text-right">${fmtMoney(p.amount)}</td>
        <td>${esc(p.notes || '—')}</td>
        <td class="text-center"><button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deleteSupplierPayment(${p.id})">Eliminar</button></td>
      </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--text-muted)">Sin pagos</td></tr>';
    $('sup-notes-tbody').innerHTML = d.notes && d.notes.length ? d.notes.map(n => `
      <tr>
        <td>${fmtDate(n.date)}</td>
        <td><span class="badge ${n.note_type==='debito'?'badge-warning':'badge-success'}">${n.note_type==='debito'?'Débito':'Crédito'}</span></td>
        <td>${esc(n.description)}</td>
        <td class="text-right" style="font-weight:600;color:${n.note_type==='credito'?'var(--success)':'var(--error)'}">${fmtMoney(n.amount)}</td>
        <td class="text-center"><button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deleteNote(${n.id},'supplier',${n.entity_id})">✕</button></td>
      </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;padding:14px;color:var(--text-muted)">Sin notas</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
};

$('btn-back-sup-account').addEventListener('click', () => { showProveedoresSubview('list'); loadSuppliers(); });

// Supplier payment modal
$('btn-new-sup-payment').addEventListener('click', () => {
  $('inp-sup-pay-amount').value = '';
  $('inp-sup-pay-date').value   = '';
  $('inp-sup-pay-method').value = 'efectivo';
  $('inp-sup-pay-reference').value = '';
  $('inp-sup-pay-notes').value  = '';
  $('inp-sup-pay-cheque-bank').value   = '';
  $('inp-sup-pay-cheque-number').value = '';
  $('inp-sup-pay-cheque-due').value    = '';
  updateSupPayFields();
  populateBankSelect($('inp-sup-pay-bank-account'));
  $('sup-payment-modal').classList.remove('hidden');
});
$('btn-sup-pay-cancel').addEventListener('click', () => $('sup-payment-modal').classList.add('hidden'));
$('sup-payment-modal').addEventListener('click', e => { if (e.target === $('sup-payment-modal')) $('sup-payment-modal').classList.add('hidden'); });

function updateSupPayFields() {
  const method = $('inp-sup-pay-method').value;
  $('sup-pay-bankacct-wrap').classList.toggle('hidden', method !== 'transferencia');
  $('sup-pay-cheque-wrap').classList.toggle('hidden', method !== 'cheque');
  $('sup-pay-ref-wrap').classList.toggle('hidden', method !== 'otros');
}
$('inp-sup-pay-method').addEventListener('change', updateSupPayFields);

$('btn-sup-pay-confirm').addEventListener('click', async () => {
  const btn = $('btn-sup-pay-confirm');
  btn.disabled = true;
  const method = $('inp-sup-pay-method').value;
  try {
    const payload = {
      supplier_id:  currentSupplierId,
      purchase_id:  currentPurchaseId || null,
      amount:       parseFloat($('inp-sup-pay-amount').value),
      method,
      payment_date: $('inp-sup-pay-date').value || null,
      notes:        $('inp-sup-pay-notes').value.trim(),
      reference:    $('inp-sup-pay-reference').value.trim(),
    };
    if (method === 'transferencia') {
      payload.bank_account_id = $('inp-sup-pay-bank-account').value;
      if (!payload.bank_account_id) { toast('Seleccioná una cuenta bancaria', 'error'); btn.disabled = false; return; }
    }
    if (method === 'cheque') {
      payload.cheque_bank    = $('inp-sup-pay-cheque-bank').value.trim();
      payload.cheque_number  = $('inp-sup-pay-cheque-number').value.trim();
      payload.cheque_due_date= $('inp-sup-pay-cheque-due').value;
      if (!payload.cheque_bank || !payload.cheque_number || !payload.cheque_due_date) {
        toast('Completá los datos del cheque', 'error'); btn.disabled = false; return;
      }
    }
    await api('POST', '/supplier-payments', payload);
    toast('Pago registrado', 'success');
    $('sup-payment-modal').classList.add('hidden');
    if (currentPurchaseId) {
      openPurchaseDetail(currentPurchaseId);
    } else {
      openSupplierAccount(currentSupplierId);
    }
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

window.deleteSupplierPayment = async function(id) {
  if (!await confirm('¿Eliminar este pago?')) return;
  try {
    await api('DELETE', `/supplier-payments/${id}`);
    toast('Pago eliminado', 'success');
    if (currentPurchaseId) openPurchaseDetail(currentPurchaseId);
    else openSupplierAccount(currentSupplierId);
  } catch (err) { toast(err.message, 'error'); }
};

// ── PURCHASES (Comprobantes) ─────────────────────────────────────────────────
let purchaseItems = [];
let currentPurchaseId = null;

function showComprobantesSubview(v) {
  $('comprobantes-list-view').classList.toggle('hidden', v !== 'list');
  $('purchase-form-view').classList.toggle('hidden', v !== 'form');
  $('purchase-detail-view').classList.toggle('hidden', v !== 'detail');
}

async function loadPurchases() {
  try {
    const rows = await api('GET', '/purchases');
    $('purchases-tbody').innerHTML = rows.length ? rows.map(p => `
      <tr>
        <td><a href="#" onclick="openPurchaseDetail(${p.id});return false;" style="font-weight:600">${esc(p.purchase_number)}</a></td>
        <td>${esc(p.supplier_name)}</td>
        <td>${esc(p.doc_type)}</td>
        <td>${esc(p.doc_number || '—')}</td>
        <td>${fmtDate(p.doc_date || p.created_at)}</td>
        <td class="text-right">${fmtMoney(p.total)}</td>
        <td class="text-center">
          <button class="btn btn-ghost btn-sm" onclick="openPurchaseDetail(${p.id})">Ver</button>
          <a href="/api/purchases/${p.id}/print" target="_blank" class="btn btn-ghost btn-sm">PDF</a>
          <button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deletePurchase(${p.id},'${esc(p.purchase_number)}')">Eliminar</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">Sin comprobantes</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

window.openPurchaseDetail = async function(id) {
  currentPurchaseId = id;
  try {
    const p = await api('GET', `/purchases/${id}`);
    $('pur-detail-title').textContent = p.purchase_number;
    $('pur-detail-subtitle').textContent = `${p.supplier_name} — ${p.doc_type}${p.doc_number ? ' ' + p.doc_number : ''} ${p.doc_date ? '| ' + fmtDate(p.doc_date) : ''}`;
    $('pur-detail-print-link').href = `/api/purchases/${id}/print`;
    $('pur-detail-total').textContent = fmtMoney(p.total);

    $('pur-detail-items-tbody').innerHTML = (p.items || []).map(it => `
      <tr>
        <td>${esc(it.product_name)}</td>
        <td class="text-right">${it.quantity}</td>
        <td class="text-right">${fmtMoney(it.unit_price)}</td>
        <td class="text-right">${fmtMoney(it.quantity * it.unit_price)}</td>
      </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">Sin ítems</td></tr>';

    renderPurchaseDetailPayments(p);
    showComprobantesSubview('detail');
  } catch (err) { toast(err.message, 'error'); }
};

function renderPurchaseDetailPayments(p) {
  const payments = p.payments || [];
  $('pur-detail-payments-tbody').innerHTML = payments.length ? payments.map(pay => `
    <tr>
      <td>${fmtDate(pay.payment_date || pay.created_at)}</td>
      <td>${esc(pay.method)}</td>
      <td class="text-right">${fmtMoney(pay.amount)}</td>
      <td>${esc(pay.notes || '—')}</td>
      <td class="text-center"><button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deletePurchasePayment(${pay.id})">✕</button></td>
    </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;padding:12px;color:var(--text-muted)">Sin pagos registrados</td></tr>';

  const totalPaid = payments.reduce((s, x) => s + x.amount, 0);
  const balance   = p.total - totalPaid;
  $('pur-detail-balance-total').textContent = fmtMoney(p.total);
  $('pur-detail-paid').textContent          = fmtMoney(totalPaid);
  const balEl = $('pur-detail-balance');
  balEl.textContent  = fmtMoney(balance);
  balEl.style.color  = balance <= 0 ? 'var(--success)' : 'var(--error)';
}

window.deletePurchasePayment = async function(id) {
  if (!await confirm('¿Eliminar este pago del comprobante?')) return;
  try {
    await api('DELETE', `/supplier-payments/${id}`);
    toast('Pago eliminado', 'success');
    openPurchaseDetail(currentPurchaseId);
  } catch (err) { toast(err.message, 'error'); }
};

$('btn-new-purchase').addEventListener('click', async () => {
  $('purchase-form').reset();
  purchaseItems = [];
  renderPurchaseItems();
  addPurchaseItemRow();
  // populate supplier select
  try {
    const suppliers = await api('GET', '/suppliers');
    $('inp-pur-supplier').innerHTML = '<option value="">— Seleccioná —</option>' +
      suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  } catch(e) {}
  $('inp-pur-docdate').value = new Date().toISOString().slice(0,10);
  showComprobantesSubview('form');
});
$('btn-back-purchases').addEventListener('click', () => { showComprobantesSubview('list'); loadPurchases(); });
$('btn-pur-form-cancel').addEventListener('click', () => { showComprobantesSubview('list'); loadPurchases(); });
$('btn-back-purchase-detail').addEventListener('click', () => { currentPurchaseId = null; showComprobantesSubview('list'); loadPurchases(); });

$('btn-new-purchase-payment').addEventListener('click', async () => {
  if (!currentPurchaseId) return;
  try {
    const pur = await api('GET', `/purchases/${currentPurchaseId}`);
    currentSupplierId = pur.supplier_id;
    $('inp-sup-pay-amount').value       = '';
    $('inp-sup-pay-date').value         = new Date().toISOString().slice(0,10);
    $('inp-sup-pay-method').value       = 'efectivo';
    $('inp-sup-pay-reference').value    = '';
    $('inp-sup-pay-notes').value        = '';
    $('inp-sup-pay-cheque-bank').value  = '';
    $('inp-sup-pay-cheque-number').value= '';
    $('inp-sup-pay-cheque-due').value   = '';
    updateSupPayFields();
    await populateBankSelect($('inp-sup-pay-bank-account'));
    $('sup-payment-modal').classList.remove('hidden');
  } catch (err) { toast(err.message, 'error'); }
});

function renderPurchaseItems() {
  const c = $('purchase-items-container');
  if (!purchaseItems.length) { c.innerHTML = ''; updatePurchaseTotal(); return; }
  c.innerHTML = purchaseItems.map((it, i) => `
    <div class="purchase-item-row" data-i="${i}">
      <input type="text"   class="input pi-name"  value="${esc(it.name)}"  placeholder="Producto" style="flex:2">
      <input type="number" class="input pi-qty"   value="${it.qty}"   min="0.001" step="any" placeholder="Cant." style="width:90px">
      <input type="number" class="input pi-price" value="${it.price}" min="0"     step="any" placeholder="Precio unit." style="width:120px">
      <span style="width:90px;text-align:right;font-size:.9rem;color:var(--text-muted)">$${((it.qty||0)*(it.price||0)).toFixed(2)}</span>
      <button type="button" class="btn btn-ghost btn-sm pi-remove" style="color:var(--error);padding:4px 8px">✕</button>
    </div>`).join('');
  // events
  c.querySelectorAll('.pi-name').forEach((el, i) => el.addEventListener('input', () => { purchaseItems[i].name = el.value; updatePurchaseTotal(); }));
  c.querySelectorAll('.pi-qty').forEach((el, i) => el.addEventListener('input', () => { purchaseItems[i].qty = parseFloat(el.value)||0; renderPurchaseItems(); }));
  c.querySelectorAll('.pi-price').forEach((el, i) => el.addEventListener('input', () => { purchaseItems[i].price = parseFloat(el.value)||0; renderPurchaseItems(); }));
  c.querySelectorAll('.pi-remove').forEach((el, i) => el.addEventListener('click', () => { purchaseItems.splice(i,1); renderPurchaseItems(); }));
  updatePurchaseTotal();
}

function addPurchaseItemRow() {
  purchaseItems.push({ name:'', qty:'', price:'' });
  renderPurchaseItems();
}

function updatePurchaseTotal() {
  const total = purchaseItems.reduce((s, it) => s + (it.qty||0)*(it.price||0), 0);
  $('purchase-total-display').textContent = total.toFixed(2);
}

$('btn-add-purchase-item').addEventListener('click', addPurchaseItemRow);

$('purchase-form').addEventListener('submit', async e => {
  e.preventDefault();
  const supplier_id = $('inp-pur-supplier').value;
  if (!supplier_id) { toast('Seleccioná un proveedor', 'error'); return; }
  if (!purchaseItems.length || !purchaseItems.some(it => it.name.trim())) { toast('Agregá al menos un ítem', 'error'); return; }
  const btn = e.submitter;
  btn.disabled = true;
  try {
    await api('POST', '/purchases', {
      supplier_id,
      doc_type:   $('inp-pur-doctype').value,
      doc_number: $('inp-pur-docnum').value.trim(),
      doc_date:   $('inp-pur-docdate').value || null,
      notes:      $('inp-pur-notes').value.trim(),
      items: purchaseItems.filter(it => it.name.trim()).map(it => ({
        product_name: it.name.trim(),
        quantity:     it.qty,
        unit_price:   it.price
      }))
    });
    toast('Comprobante registrado y stock actualizado', 'success');
    showComprobantesSubview('list');
    loadPurchases();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

window.deletePurchase = async function(id, num) {
  if (!await confirm(`¿Eliminar comprobante ${num}? El stock ingresado se va a descontar.`)) return;
  try {
    await api('DELETE', `/purchases/${id}`);
    toast('Comprobante eliminado', 'success');
    loadPurchases();
  } catch (err) { toast(err.message, 'error'); }
};

// ── CAJA ────────────────────────────────────────────────────────────────────
async function loadCash() {
  try {
    const d = await api('GET', '/cash');
    $('cash-balance-display').textContent = fmtMoney(d.balance);
    $('cash-balance-display').style.color = d.balance >= 0 ? 'var(--success)' : 'var(--error)';
    $('cash-tbody').innerHTML = d.movements.length ? d.movements.map(m => `
      <tr>
        <td style="color:var(--text-muted);font-size:.85rem">${fmtDateTime(m.created_at)}</td>
        <td>${m.type === 'ingreso' ? '<span class="badge badge-stock-ok">Ingreso</span>' : '<span class="badge badge-stock-out">Egreso</span>'}</td>
        <td>${esc(m.description || '—')}</td>
        <td class="text-right" style="color:${m.type==='ingreso'?'var(--success)':'var(--error)'};font-weight:600">${fmtMoney(m.amount)}</td>
        <td class="text-right">${fmtMoney(m.running_balance)}</td>
        <td class="text-center">${m.ref_type === 'manual'
          ? `<button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deleteCashMv(${m.id})">✕</button>`
          : '<span style="color:var(--text-muted);font-size:.8rem">auto</span>'}</td>
      </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted)">Sin movimientos</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

$('btn-new-cash-movement').addEventListener('click', () => {
  $('cash-modal-title').textContent = 'Movimiento de Caja';
  $('inp-cash-type').value = 'ingreso';
  $('inp-cash-amount').value = '';
  $('inp-cash-description').value = '';
  $('cash-movement-modal').dataset.mode = 'cash';
  $('cash-movement-modal').classList.remove('hidden');
});
$('btn-cash-mv-cancel').addEventListener('click', () => $('cash-movement-modal').classList.add('hidden'));
$('cash-movement-modal').addEventListener('click', e => { if (e.target === $('cash-movement-modal')) $('cash-movement-modal').classList.add('hidden'); });

$('btn-cash-mv-confirm').addEventListener('click', async () => {
  const btn = $('btn-cash-mv-confirm');
  btn.disabled = true;
  const mode = $('cash-movement-modal').dataset.mode;
  try {
    if (mode === 'bank') {
      await api('POST', `/bank/accounts/${currentBankAccountId}/movements`, {
        type: $('inp-cash-type').value,
        amount: parseFloat($('inp-cash-amount').value),
        description: $('inp-cash-description').value.trim()
      });
      $('cash-movement-modal').classList.add('hidden');
      loadBankMovements(currentBankAccountId);
    } else {
      await api('POST', '/cash', {
        type: $('inp-cash-type').value,
        amount: parseFloat($('inp-cash-amount').value),
        description: $('inp-cash-description').value.trim()
      });
      $('cash-movement-modal').classList.add('hidden');
      loadCash();
    }
    toast('Movimiento registrado', 'success');
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

window.deleteCashMv = async function(id) {
  if (!await confirm('¿Eliminar este movimiento manual?')) return;
  try {
    await api('DELETE', `/cash/${id}`);
    toast('Movimiento eliminado', 'success');
    loadCash();
  } catch (err) { toast(err.message, 'error'); }
};

// ── BANCO ────────────────────────────────────────────────────────────────────
let currentBankAccountId = null;

function showBancoSubview(v) {
  $('banco-list-view').classList.toggle('hidden', v !== 'list');
  $('banco-movements-view').classList.toggle('hidden', v !== 'movements');
}

async function loadBankAccounts() {
  try {
    const accounts = await api('GET', '/bank/accounts');
    $('bank-accounts-grid').innerHTML = accounts.length ? accounts.map(a => `
      <div class="finance-card" style="cursor:pointer" onclick="openBankAccount(${a.id},'${esc(a.name)}')">
        <div class="finance-card-label">${esc(a.name)}</div>
        <div class="finance-card-value" style="color:${a.balance>=0?'var(--success)':'var(--error)'}">${fmtMoney(a.balance)}</div>
        <div style="font-size:.8rem;color:var(--text-muted);margin-top:4px">${esc(a.bank || '')} ${a.account_number ? '– ' + a.account_number : ''}</div>
      </div>`).join('') : '<p style="color:var(--text-muted);padding:20px">Sin cuentas bancarias</p>';
  } catch (err) { toast(err.message, 'error'); }
}

window.openBankAccount = async function(id, name) {
  currentBankAccountId = id;
  $('bank-account-title').textContent = name;
  showBancoSubview('movements');
  loadBankMovements(id);
};

async function loadBankMovements(id) {
  try {
    const d = await api('GET', `/bank/accounts/${id}/movements`);
    $('bank-balance-display').textContent = fmtMoney(d.balance);
    $('bank-movements-tbody').innerHTML = d.movements.length ? d.movements.map(m => `
      <tr>
        <td style="color:var(--text-muted);font-size:.85rem">${fmtDateTime(m.created_at)}</td>
        <td>${m.type === 'ingreso' ? '<span class="badge badge-stock-ok">Ingreso</span>' : '<span class="badge badge-stock-out">Egreso</span>'}</td>
        <td>${esc(m.description || '—')}</td>
        <td class="text-right" style="color:${m.type==='ingreso'?'var(--success)':'var(--error)'};font-weight:600">${fmtMoney(m.amount)}</td>
        <td class="text-right">${fmtMoney(m.running_balance)}</td>
        <td class="text-center">${m.ref_type === 'manual'
          ? `<button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deleteBankMv(${m.id})">✕</button>`
          : '<span style="color:var(--text-muted);font-size:.8rem">auto</span>'}</td>
      </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted)">Sin movimientos</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

$('btn-back-banco').addEventListener('click', () => { showBancoSubview('list'); loadBankAccounts(); });

$('btn-new-bank-movement').addEventListener('click', () => {
  $('cash-modal-title').textContent = 'Movimiento Bancario';
  $('inp-cash-type').value = 'ingreso';
  $('inp-cash-amount').value = '';
  $('inp-cash-description').value = '';
  $('cash-movement-modal').dataset.mode = 'bank';
  $('cash-movement-modal').classList.remove('hidden');
});

window.deleteBankMv = async function(id) {
  if (!await confirm('¿Eliminar este movimiento manual?')) return;
  try {
    await api('DELETE', `/bank/movements/${id}`);
    toast('Movimiento eliminado', 'success');
    loadBankMovements(currentBankAccountId);
  } catch (err) { toast(err.message, 'error'); }
};

$('btn-new-bank-account').addEventListener('click', () => {
  $('bank-account-modal-title').textContent = 'Nueva Cuenta Bancaria';
  $('inp-bank-acc-name').value    = '';
  $('inp-bank-acc-bank').value    = '';
  $('inp-bank-acc-number').value  = '';
  $('inp-bank-acc-initial').value = '0';
  $('bank-account-modal').classList.remove('hidden');
});
$('btn-bank-acc-cancel').addEventListener('click', () => $('bank-account-modal').classList.add('hidden'));
$('bank-account-modal').addEventListener('click', e => { if (e.target === $('bank-account-modal')) $('bank-account-modal').classList.add('hidden'); });

$('btn-bank-acc-confirm').addEventListener('click', async () => {
  const btn = $('btn-bank-acc-confirm');
  btn.disabled = true;
  try {
    await api('POST', '/bank/accounts', {
      name:            $('inp-bank-acc-name').value.trim(),
      bank:            $('inp-bank-acc-bank').value.trim(),
      account_number:  $('inp-bank-acc-number').value.trim(),
      initial_balance: parseFloat($('inp-bank-acc-initial').value) || 0
    });
    toast('Cuenta creada', 'success');
    $('bank-account-modal').classList.add('hidden');
    loadBankAccounts();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── CHEQUES ──────────────────────────────────────────────────────────────────
let chequeFilter = 'all';

async function loadCheques() {
  try {
    const params = chequeFilter !== 'all' ? `?direction=${chequeFilter}` : '';
    const rows = await api('GET', `/cheques${params}`);
    const statusLabel = { en_cartera:'En cartera', depositado:'Depositado', rechazado:'Rechazado', emitido:'Emitido', debitado:'Debitado' };
    const statusClass = { en_cartera:'info', depositado:'success', rechazado:'default', emitido:'warning', debitado:'default' };
    $('cheques-tbody').innerHTML = rows.length ? rows.map(c => {
      const related = c.direction === 'recibido' ? (c.customer_name||'—') : (c.supplier_name||'—');
      const nextStatuses = c.direction === 'recibido'
        ? [['depositado','Depositar'],['rechazado','Rechazar']]
        : [['debitado','Marcar debitado']];
      const statusBtns = c.status === 'en_cartera' || c.status === 'emitido'
        ? nextStatuses.map(([s, l]) => `<button class="btn btn-ghost btn-sm" onclick="updateChequeStatus(${c.id},'${s}','${esc(c.bank)} Nro ${esc(c.cheque_number)} — $${c.amount.toFixed(2)}')">${l}</button>`).join('')
        : '';
      return `<tr>
        <td>${c.direction === 'recibido' ? '<span class="badge badge-stock-ok">Recibido</span>' : '<span class="badge badge-stock-out">Emitido</span>'}</td>
        <td>${esc(c.bank)}</td><td>${esc(c.cheque_number)}</td>
        <td>${fmtDate(c.due_date)}</td><td>${esc(related)}</td>
        <td class="text-right">${fmtMoney(c.amount)}</td>
        <td><span class="badge badge-${statusClass[c.status]||'default'}">${statusLabel[c.status]||c.status}</span></td>
        <td class="text-center">${statusBtns}
          <button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deleteCheque(${c.id})">✕</button>
        </td>
      </tr>`;
    }).join('') : '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted)">Sin cheques</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

document.querySelectorAll('[data-cheque-filter]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-cheque-filter]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    chequeFilter = b.dataset.chequeFilter;
    loadCheques();
  });
});

$('btn-new-cheque').addEventListener('click', async () => {
  $('cheque-modal').querySelectorAll('input,select').forEach(el => { if (el.type !== 'select-one') el.value = ''; });
  $('inp-cheque-direction').value = 'recibido';
  updateChequeDirection();
  // populate customers + suppliers
  try {
    const [customers, suppliers] = await Promise.all([
      api('GET', '/customers'),
      api('GET', '/suppliers')
    ]);
    $('inp-cheque-customer').innerHTML = '<option value="">— ninguno —</option>' +
      customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('inp-cheque-supplier').innerHTML = '<option value="">— ninguno —</option>' +
      suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  } catch(e) {}
  $('cheque-modal').classList.remove('hidden');
});
$('btn-cheque-cancel').addEventListener('click', () => $('cheque-modal').classList.add('hidden'));
$('cheque-modal').addEventListener('click', e => { if (e.target === $('cheque-modal')) $('cheque-modal').classList.add('hidden'); });

$('inp-cheque-direction').addEventListener('change', updateChequeDirection);
function updateChequeDirection() {
  const dir = $('inp-cheque-direction').value;
  $('cheque-customer-wrap').classList.toggle('hidden', dir !== 'recibido');
  $('cheque-supplier-wrap').classList.toggle('hidden', dir !== 'emitido');
  $('lbl-cheque-holder').textContent = dir === 'recibido' ? 'Librador / Titular' : 'Beneficiario';
}

$('btn-cheque-confirm').addEventListener('click', async () => {
  const btn = $('btn-cheque-confirm');
  btn.disabled = true;
  const dir = $('inp-cheque-direction').value;
  try {
    await api('POST', '/cheques', {
      direction:    dir,
      bank:         $('inp-cheque-bank').value.trim(),
      cheque_number:$('inp-cheque-number').value.trim(),
      due_date:     $('inp-cheque-due').value,
      amount:       parseFloat($('inp-cheque-amount').value),
      holder_name:  $('inp-cheque-holder').value.trim(),
      notes:        $('inp-cheque-notes').value.trim(),
      customer_id:  dir === 'recibido' ? ($('inp-cheque-customer').value || null) : null,
      supplier_id:  dir === 'emitido'  ? ($('inp-cheque-supplier').value || null) : null
    });
    toast('Cheque registrado', 'success');
    $('cheque-modal').classList.add('hidden');
    loadCheques();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

let pendingChequeAction = null; // { id, status }

window.updateChequeStatus = async function(id, status, chequeInfo) {
  if (status === 'depositado' || status === 'debitado') {
    pendingChequeAction = { id, status };
    $('deposit-cheque-title').textContent = status === 'depositado' ? 'Depositar Cheque' : 'Registrar Débito Bancario';
    $('deposit-cheque-info').textContent  = chequeInfo || '';
    await populateBankSelect($('inp-deposit-bank-account'));
    $('deposit-cheque-modal').classList.remove('hidden');
  } else {
    try {
      await api('PATCH', `/cheques/${id}/status`, { status });
      toast('Estado actualizado', 'success');
      loadCheques();
    } catch (err) { toast(err.message, 'error'); }
  }
};

$('btn-deposit-cancel').addEventListener('click', () => { $('deposit-cheque-modal').classList.add('hidden'); pendingChequeAction = null; });
$('deposit-cheque-modal').addEventListener('click', e => { if (e.target === $('deposit-cheque-modal')) { $('deposit-cheque-modal').classList.add('hidden'); pendingChequeAction = null; } });

$('btn-deposit-confirm').addEventListener('click', async () => {
  if (!pendingChequeAction) return;
  const bank_account_id = $('inp-deposit-bank-account').value;
  if (!bank_account_id) { toast('Seleccioná una cuenta bancaria', 'error'); return; }
  const btn = $('btn-deposit-confirm');
  btn.disabled = true;
  try {
    await api('PATCH', `/cheques/${pendingChequeAction.id}/status`, { status: pendingChequeAction.status, bank_account_id });
    const msg = pendingChequeAction.status === 'depositado' ? 'Cheque depositado y acreditado en banco' : 'Cheque debitado del banco';
    toast(msg, 'success');
    $('deposit-cheque-modal').classList.add('hidden');
    pendingChequeAction = null;
    loadCheques();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

window.deleteCheque = async function(id) {
  if (!await confirm('¿Eliminar este cheque?')) return;
  try {
    await api('DELETE', `/cheques/${id}`);
    toast('Cheque eliminado', 'success');
    loadCheques();
  } catch (err) { toast(err.message, 'error'); }
};

/* ================================================================ ACCOUNTING */

// ── Plan de cuentas ─────────────────────────────────────────────────────────
let editingAccountId = null;

async function loadAccounts() {
  try {
    const rows = await api('GET', '/accounting/accounts');
    const tbody = $('accounts-tbody');
    tbody.innerHTML = rows.map(a => {
      const indent = (a.code.match(/\./g)||[]).length;
      const isGroup = !a.accepts_movements;
      return `<tr style="${isGroup ? 'background:var(--surface-2,#f8f8f8);font-weight:600' : ''}">
        <td style="padding-left:${8 + indent*14}px;font-family:monospace;font-size:.85rem">${esc(a.code)}</td>
        <td>${esc(a.name)}</td>
        <td style="font-size:.82rem">${esc(a.type)}</td>
        <td style="font-size:.82rem;color:var(--text-muted)">${esc(a.subtype||'')}</td>
        <td class="text-center">${a.accepts_movements ? '✓' : ''}</td>
        <td class="text-right" style="${a.balance < 0 ? 'color:var(--error)' : ''}">${a.accepts_movements ? fmtMoney(a.balance) : ''}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px">Sin cuentas</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

$('btn-new-account').addEventListener('click', () => {
  editingAccountId = null;
  $('account-form-title').textContent = 'Nueva Cuenta';
  $('inp-acct-code').value = '';
  $('inp-acct-name').value = '';
  $('inp-acct-type').value = 'Activo';
  $('inp-acct-subtype').value = '';
  $('inp-acct-parent').value = '';
  $('inp-acct-moves').checked = true;
  $('account-form-wrap').classList.remove('hidden');
  $('inp-acct-code').focus();
});
$('btn-acct-cancel').addEventListener('click', () => $('account-form-wrap').classList.add('hidden'));
$('btn-acct-save').addEventListener('click', async () => {
  const code = $('inp-acct-code').value.trim();
  const name = $('inp-acct-name').value.trim();
  if (!code || !name) { toast('Código y nombre requeridos', 'error'); return; }
  try {
    const payload = { code, name, type: $('inp-acct-type').value, subtype: $('inp-acct-subtype').value.trim(),
      accepts_movements: $('inp-acct-moves').checked, parent_code: $('inp-acct-parent').value.trim() || null };
    if (editingAccountId) await api('PUT', `/accounting/accounts/${editingAccountId}`, payload);
    else await api('POST', '/accounting/accounts', payload);
    toast('Cuenta guardada', 'success');
    $('account-form-wrap').classList.add('hidden');
    loadAccounts();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Libro diario ─────────────────────────────────────────────────────────────
let journalPage = 1;
let journalFilters = {};
let journalAccountsList = [];

async function loadJournal(page = 1) {
  journalPage = page;
  try {
    const params = new URLSearchParams({ page, per_page: 30, ...journalFilters });
    const data = await api('GET', `/accounting/journal?${params}`);
    const tbody = $('journal-tbody');
    tbody.innerHTML = data.entries.map(e => `
      <tr>
        <td class="text-center"><button class="btn btn-ghost btn-sm" onclick="toggleJournalDetail(${e.id},this)" title="Ver líneas">▸</button></td>
        <td>${fmtDate(e.date)}</td>
        <td>${esc(e.description)}</td>
        <td style="font-size:.8rem;color:var(--text-muted)">${esc(e.ref_type||'')}</td>
        <td class="text-center">${e.is_reversed ? '<span class="badge badge-default">Anulado</span>' : '<span class="badge badge-success">Vigente</span>'}</td>
        <td class="text-center">${!e.is_reversed ? `<button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="reverseEntry(${e.id})">Anular</button>` : ''}</td>
      </tr>
      <tr id="jrn-detail-${e.id}" class="hidden" style="background:var(--surface-2,#f9f9f9)">
        <td colspan="6" style="padding:0 12px 10px 36px"><div id="jrn-detail-inner-${e.id}">Cargando...</div></td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted)">Sin asientos en el período</td></tr>';

    // Pagination
    const pages = Math.ceil(data.total / data.per_page);
    $('journal-pagination').innerHTML = pages <= 1 ? '' : `
      <button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="loadJournal(${page-1})">← Ant.</button>
      <span style="font-size:.85rem;color:var(--text-muted)">Pág. ${page} / ${pages} (${data.total} asientos)</span>
      <button class="btn btn-ghost btn-sm" ${page >= pages ? 'disabled' : ''} onclick="loadJournal(${page+1})">Sig. →</button>`;
  } catch (err) { toast(err.message, 'error'); }
}

window.toggleJournalDetail = async function(id, btn) {
  const row = $(`jrn-detail-${id}`);
  const isHidden = row.classList.contains('hidden');
  row.classList.toggle('hidden', !isHidden);
  btn.textContent = isHidden ? '▾' : '▸';
  if (isHidden) {
    try {
      const entry = await api('GET', `/accounting/journal/${id}`);
      $(`jrn-detail-inner-${id}`).innerHTML = `
        <table class="table" style="margin:4px 0">
          <thead><tr><th>Cuenta</th><th class="text-right">Debe</th><th class="text-right">Haber</th></tr></thead>
          <tbody>${entry.lines.map(l => `
            <tr>
              <td><span style="font-family:monospace;font-size:.82rem;color:var(--text-muted)">${esc(l.account_code)}</span> ${esc(l.account_name)}</td>
              <td class="text-right">${l.debit  > 0 ? fmtMoney(l.debit)  : ''}</td>
              <td class="text-right">${l.credit > 0 ? fmtMoney(l.credit) : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
    } catch(e) { $(`jrn-detail-inner-${id}`).textContent = 'Error al cargar'; }
  }
};

window.reverseEntry = async function(id) {
  if (!await confirm('¿Anular este asiento? Se creará un contra-asiento automáticamente.')) return;
  try {
    await api('POST', `/accounting/journal/${id}/reverse`);
    toast('Asiento anulado', 'success');
    loadJournal(journalPage);
  } catch (err) { toast(err.message, 'error'); }
};

$('btn-journal-filter').addEventListener('click', () => {
  journalFilters = {};
  const df = $('journal-date-from').value;
  const dt = $('journal-date-to').value;
  if (df) journalFilters.date_from = df;
  if (dt) journalFilters.date_to   = dt;
  loadJournal(1);
});
$('btn-journal-clear').addEventListener('click', () => {
  journalFilters = {};
  $('journal-date-from').value = '';
  $('journal-date-to').value   = '';
  loadJournal(1);
});

// Manual journal entry form
let jrnLines = [];

async function openJournalForm() {
  // Load account list for selects
  try { journalAccountsList = (await api('GET', '/accounting/accounts')).filter(a => a.accepts_movements); } catch(e) {}
  jrnLines = [{ account_id: '', debit: 0, credit: 0 }, { account_id: '', debit: 0, credit: 0 }];
  $('inp-jrn-date').value = new Date().toISOString().slice(0,10);
  $('inp-jrn-desc').value = '';
  renderJrnLines();
  $('journal-form-wrap').classList.remove('hidden');
}

function renderJrnLines() {
  const opts = journalAccountsList.map(a => `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`).join('');
  $('jrn-lines-container').innerHTML = jrnLines.map((l, i) => `
    <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
      <select class="input select" style="flex:2" onchange="jrnLines[${i}].account_id=this.value">
        <option value="">— Cuenta —</option>${opts}
      </select>
      <input type="number" class="input" style="width:110px" placeholder="Debe" min="0" step="0.01" value="${l.debit||''}" onchange="jrnLines[${i}].debit=parseFloat(this.value)||0;updateJrnTotals()">
      <input type="number" class="input" style="width:110px" placeholder="Haber" min="0" step="0.01" value="${l.credit||''}" onchange="jrnLines[${i}].credit=parseFloat(this.value)||0;updateJrnTotals()">
      <button type="button" class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="jrnLines.splice(${i},1);renderJrnLines()">✕</button>
    </div>`).join('');
  // Restore selected values
  const selects = $('jrn-lines-container').querySelectorAll('select');
  selects.forEach((s, i) => { if (jrnLines[i]?.account_id) s.value = jrnLines[i].account_id; });
  updateJrnTotals();
}

function updateJrnTotals() {
  $('jrn-total-debit').textContent  = jrnLines.reduce((s,l)=>s+(l.debit||0),0).toFixed(2);
  $('jrn-total-credit').textContent = jrnLines.reduce((s,l)=>s+(l.credit||0),0).toFixed(2);
}

$('btn-add-jrn-line').addEventListener('click', () => { jrnLines.push({account_id:'',debit:0,credit:0}); renderJrnLines(); });
$('btn-new-journal').addEventListener('click', openJournalForm);
$('btn-jrn-cancel').addEventListener('click', () => $('journal-form-wrap').classList.add('hidden'));
$('btn-jrn-save').addEventListener('click', async () => {
  const desc = $('inp-jrn-desc').value.trim();
  const date = $('inp-jrn-date').value;
  if (!desc) { toast('Descripción requerida', 'error'); return; }
  const lines = jrnLines.filter(l => l.account_id && (l.debit > 0 || l.credit > 0));
  if (lines.length < 2) { toast('Mínimo 2 líneas con monto', 'error'); return; }
  try {
    await api('POST', '/accounting/journal', { date, description: desc, lines });
    toast('Asiento guardado', 'success');
    $('journal-form-wrap').classList.add('hidden');
    loadJournal(journalPage);
  } catch (err) { toast(err.message, 'error'); }
});

// ── Trial Balance ─────────────────────────────────────────────────────────────
$('btn-load-balance').addEventListener('click', loadTrialBalance);

async function loadTrialBalance() {
  try {
    const df = $('balance-date-from').value;
    const dt = $('balance-date-to').value;
    const params = new URLSearchParams();
    if (df) params.set('date_from', df);
    if (dt) params.set('date_to',   dt);
    const rows = await api('GET', `/accounting/trial-balance?${params}`);
    const tbody = $('trial-balance-tbody');
    tbody.innerHTML = rows.map(r => {
      const isGroup = !r.accepts_movements;
      const indent = (r.code.match(/\./g)||[]).length;
      if (isGroup && r.opening_balance === 0 && r.period_debit === 0 && r.period_credit === 0) return '';
      return `<tr style="${isGroup ? 'font-weight:700;background:var(--surface-2,#f8f8f8)' : ''}">
        <td style="padding-left:${4+indent*10}px;font-family:monospace;font-size:.82rem">${esc(r.code)}</td>
        <td style="padding-left:${indent*8}px">${esc(r.name)}</td>
        <td style="font-size:.8rem">${esc(r.type)}</td>
        <td class="text-right">${r.opening_balance !== 0 ? fmtMoney(r.opening_balance) : ''}</td>
        <td class="text-right">${r.period_debit   !== 0 ? fmtMoney(r.period_debit)    : ''}</td>
        <td class="text-right">${r.period_credit  !== 0 ? fmtMoney(r.period_credit)   : ''}</td>
        <td class="text-right" style="${r.closing_balance < 0 ? 'color:var(--error)' : ''}">${r.closing_balance !== 0 || r.accepts_movements ? fmtMoney(r.closing_balance) : ''}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">Sin movimientos contables</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

// ── Income Statement ──────────────────────────────────────────────────────────
$('btn-load-results').addEventListener('click', loadIncomeStatement);

async function loadIncomeStatement() {
  try {
    const df = $('results-date-from').value;
    const dt = $('results-date-to').value;
    const params = new URLSearchParams();
    if (df) params.set('date_from', df);
    if (dt) params.set('date_to',   dt);
    const d = await api('GET', `/accounting/income-statement?${params}`);

    const renderRows = (type) => d.rows.filter(r => r.type === type && r.amount !== 0).map(r =>
      `<div class="balance-row"><span>${esc(r.code)} ${esc(r.name)}</span><span class="balance-amount">${fmtMoney(r.amount)}</span></div>`
    ).join('') || `<div class="balance-row" style="color:var(--text-muted)"><span>Sin movimientos</span><span>—</span></div>`;

    $('results-ingresos-rows').innerHTML = renderRows('Ingreso');
    $('results-costos-rows').innerHTML   = renderRows('Costo');
    $('results-gastos-rows').innerHTML   = renderRows('Gasto');
    $('results-total-ingresos').textContent = fmtMoney(d.ingresos);
    $('results-total-costos').textContent   = fmtMoney(d.costos);
    $('results-total-gastos').textContent   = fmtMoney(d.gastos);
    const resEl = $('results-resultado');
    resEl.textContent = fmtMoney(d.resultado);
    resEl.style.color = d.resultado >= 0 ? 'var(--success)' : 'var(--error)';
  } catch (err) { toast(err.message, 'error'); }
}

/* ================================================================ ASIENTOS MANUALES */

let amLines         = [];
let amAccountsList  = [];
let amPage          = 1;
let amFilters       = {};

// ── List ─────────────────────────────────────────────────────────────────────
async function loadManualEntries(page = 1) {
  amPage = page;
  try {
    const params = new URLSearchParams({ page, per_page: 30, ref_type: 'manual', ...amFilters });
    const data = await api('GET', `/accounting/journal?${params}`);
    $('am-list-tbody').innerHTML = data.entries.length ? data.entries.map(e => `
      <tr>
        <td class="text-center">
          <button class="btn btn-ghost btn-sm" style="padding:2px 6px" onclick="amToggleDetail(${e.id},this)">▸</button>
        </td>
        <td style="font-family:monospace;font-size:.82rem;color:var(--text-muted)">${e.id}</td>
        <td>${fmtDate(e.date)}</td>
        <td style="font-weight:500">${esc(e.description)}</td>
        <td style="font-size:.85rem;color:var(--text-muted)">${esc(e.reference || '—')}</td>
        <td class="text-right">${fmtMoney(e.total_debit || 0)}</td>
        <td style="font-size:.82rem">${esc(e.created_by_name || '—')}</td>
        <td class="text-center">${e.is_reversed
          ? '<span class="badge badge-default">Anulado</span>'
          : '<span class="badge badge-success">Activo</span>'}</td>
        <td class="text-center">${!e.is_reversed
          ? `<button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="amReverse(${e.id})">Anular</button>`
          : ''}</td>
      </tr>
      <tr id="am-det-${e.id}" class="hidden" style="background:var(--surface-2,#f9f9f9)">
        <td colspan="9" style="padding:0 16px 12px 52px">
          <div id="am-det-inner-${e.id}" style="padding-top:8px">Cargando…</div>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-muted)">Sin asientos manuales</td></tr>';

    const pages = Math.ceil(data.total / data.per_page);
    $('am-pagination').innerHTML = pages <= 1 ? '' : `
      <button class="btn btn-ghost btn-sm" ${page<=1?'disabled':''} onclick="loadManualEntries(${page-1})">← Ant.</button>
      <span style="font-size:.85rem;color:var(--text-muted)">Pág. ${page} / ${pages} · ${data.total} asientos</span>
      <button class="btn btn-ghost btn-sm" ${page>=pages?'disabled':''} onclick="loadManualEntries(${page+1})">Sig. →</button>`;
  } catch (err) { toast(err.message, 'error'); }
}

window.amToggleDetail = async function(id, btn) {
  const row = $(`am-det-${id}`);
  const wasHidden = row.classList.contains('hidden');
  row.classList.toggle('hidden', !wasHidden);
  btn.textContent = wasHidden ? '▾' : '▸';
  if (!wasHidden) return;
  try {
    const e = await api('GET', `/accounting/journal/${id}`);
    $(`am-det-inner-${id}`).innerHTML =
      (e.reference ? `<div style="font-size:.83rem;color:var(--text-muted);margin-bottom:6px"><b>Referencia:</b> ${esc(e.reference)}</div>` : '') +
      `<table class="table" style="max-width:640px;margin:0">
        <thead><tr>
          <th style="width:110px">Código</th><th>Cuenta</th>
          <th>Descripción línea</th>
          <th class="text-right" style="width:120px">Debe</th>
          <th class="text-right" style="width:120px">Haber</th>
        </tr></thead>
        <tbody>${e.lines.map(l => `
          <tr>
            <td style="font-family:monospace;font-size:.82rem">${esc(l.account_code)}</td>
            <td>${esc(l.account_name)}</td>
            <td style="font-size:.83rem;color:var(--text-muted)">${esc(l.line_description || '')}</td>
            <td class="text-right">${l.debit  > 0 ? fmtMoney(l.debit)  : ''}</td>
            <td class="text-right">${l.credit > 0 ? fmtMoney(l.credit) : ''}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr style="font-weight:700">
          <td colspan="3" class="text-right">Totales</td>
          <td class="text-right">${fmtMoney(e.lines.reduce((s,l)=>s+l.debit,0))}</td>
          <td class="text-right">${fmtMoney(e.lines.reduce((s,l)=>s+l.credit,0))}</td>
        </tr></tfoot>
      </table>`;
  } catch(e) { $(`am-det-inner-${id}`).textContent = 'Error al cargar'; }
};

window.amReverse = async function(id) {
  if (!await confirm('¿Anular este asiento?\nSe generará un contra-asiento automáticamente. El asiento original queda como registro histórico.')) return;
  try {
    await api('POST', `/accounting/journal/${id}/reverse`);
    toast('Asiento anulado — se creó el contra-asiento', 'success');
    loadManualEntries(amPage);
  } catch (err) { toast(err.message, 'error'); }
};

// ── Filters ───────────────────────────────────────────────────────────────────
$('am-filter-btn').addEventListener('click', () => {
  amFilters = {};
  const df = $('am-filter-from').value, dt = $('am-filter-to').value;
  if (df) amFilters.date_from = df;
  if (dt) amFilters.date_to   = dt;
  loadManualEntries(1);
});
$('am-filter-clear').addEventListener('click', () => {
  amFilters = {};
  $('am-filter-from').value = '';
  $('am-filter-to').value   = '';
  loadManualEntries(1);
});

// ── Form ──────────────────────────────────────────────────────────────────────
async function amOpenForm() {
  if (!amAccountsList.length) {
    try { amAccountsList = (await api('GET', '/accounting/accounts')).filter(a => a.accepts_movements); }
    catch(e) { toast('Error al cargar cuentas', 'error'); return; }
  }
  amLines = [
    { account_id: '', description: '', debit: 0, credit: 0 },
    { account_id: '', description: '', debit: 0, credit: 0 }
  ];
  $('am-date').value = new Date().toISOString().slice(0,10);
  $('am-desc').value = '';
  $('am-ref').value  = '';
  $('am-error-msg').classList.add('hidden');
  amRenderLines();
  $('am-form-section').classList.remove('hidden');
  $('am-desc').focus();
}

function amRenderLines() {
  const opts = amAccountsList.map(a =>
    `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`).join('');
  $('am-lines-tbody').innerHTML = amLines.map((l, i) => `
    <tr>
      <td>
        <select class="input select" style="min-width:190px" data-am-acct="${i}">
          <option value="">— Cuenta —</option>${opts}
        </select>
      </td>
      <td>
        <input type="text" class="input" placeholder="Opcional" style="min-width:130px"
               value="${esc(l.description || '')}" data-am-desc="${i}">
      </td>
      <td>
        <input type="number" class="input text-right" min="0" step="0.01"
               placeholder="0.00" style="width:120px"
               value="${l.debit || ''}" data-am-debe="${i}">
      </td>
      <td>
        <input type="number" class="input text-right" min="0" step="0.01"
               placeholder="0.00" style="width:120px"
               value="${l.credit || ''}" data-am-haber="${i}">
      </td>
      <td>
        <button type="button" class="btn btn-ghost btn-sm" style="color:var(--error)"
                onclick="amLines.splice(${i},1);amRenderLines()">✕</button>
      </td>
    </tr>`).join('');

  // Restore selected values + wire events
  $('am-lines-tbody').querySelectorAll('[data-am-acct]').forEach(el => {
    const i = Number(el.dataset.amAcct);
    if (amLines[i].account_id) el.value = amLines[i].account_id;
    el.addEventListener('change', () => { amLines[i].account_id = el.value; amUpdateTotals(); });
  });
  $('am-lines-tbody').querySelectorAll('[data-am-desc]').forEach(el => {
    const i = Number(el.dataset.amDesc);
    el.addEventListener('input', () => { amLines[i].description = el.value; });
  });
  $('am-lines-tbody').querySelectorAll('[data-am-debe]').forEach(el => {
    const i = Number(el.dataset.amDebe);
    el.addEventListener('input', () => { amLines[i].debit = parseFloat(el.value) || 0; amUpdateTotals(); });
  });
  $('am-lines-tbody').querySelectorAll('[data-am-haber]').forEach(el => {
    const i = Number(el.dataset.amHaber);
    el.addEventListener('input', () => { amLines[i].credit = parseFloat(el.value) || 0; amUpdateTotals(); });
  });
  amUpdateTotals();
}

function amUpdateTotals() {
  const totalD  = amLines.reduce((s, l) => s + (l.debit  || 0), 0);
  const totalC  = amLines.reduce((s, l) => s + (l.credit || 0), 0);
  const diff    = Math.abs(totalD - totalC);
  const validLines = amLines.filter(l => l.account_id && (l.debit > 0 || l.credit > 0));
  const balanced   = diff < 0.005 && validLines.length >= 2;

  $('am-total-debit').textContent  = totalD.toFixed(2);
  $('am-total-credit').textContent = totalC.toFixed(2);
  $('am-diff').textContent         = diff.toFixed(2);
  $('am-diff').style.color         = diff < 0.005 ? 'var(--success)' : 'var(--error)';
  $('am-balanced-ok').classList.toggle('hidden', !balanced);

  const hasAnyAmount = totalD > 0 || totalC > 0;
  if (!balanced && hasAnyAmount) {
    $('am-error-msg').classList.remove('hidden');
    $('am-error-msg').textContent = diff >= 0.005
      ? `La diferencia de ${diff.toFixed(2)} entre Debe y Haber debe ser cero para poder guardar.`
      : 'Se requieren al menos 2 líneas con cuenta y monto para guardar el asiento.';
  } else {
    $('am-error-msg').classList.add('hidden');
  }
  $('am-save').disabled = !balanced;
}

$('am-new-btn').addEventListener('click', amOpenForm);
$('am-cancel').addEventListener('click', () => $('am-form-section').classList.add('hidden'));
$('am-add-line').addEventListener('click', () => {
  amLines.push({ account_id: '', description: '', debit: 0, credit: 0 });
  amRenderLines();
});

$('am-save').addEventListener('click', async () => {
  const desc = $('am-desc').value.trim();
  const date = $('am-date').value;
  const ref  = $('am-ref').value.trim();
  if (!desc) { toast('Ingresá una descripción', 'error'); return; }
  if (!date) { toast('Ingresá una fecha', 'error'); return; }
  const lines = amLines.filter(l => l.account_id && (l.debit > 0 || l.credit > 0));
  if (lines.length < 2) { toast('Mínimo 2 líneas con cuenta y monto', 'error'); return; }
  const btn = $('am-save');
  btn.disabled = true;
  try {
    await api('POST', '/accounting/journal', { date, description: desc, reference: ref, lines });
    toast('Asiento guardado correctamente', 'success');
    $('am-form-section').classList.add('hidden');
    amAccountsList = []; // Force refresh next open
    loadManualEntries(1);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
});

/* ================================================================ LIBRO MAYOR */

async function loadLibroMayorAccounts() {
  try {
    const accounts = await api('GET', '/accounting/accounts');
    const sel = $('lm-account-select');
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Seleccioná una cuenta —</option>' +
      accounts.filter(a => a.accepts_movements).map(a =>
        `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`
      ).join('');
    if (cur) sel.value = cur;
  } catch (err) { toast(err.message, 'error'); }
}

$('btn-load-lm').addEventListener('click', loadLibroMayor);

async function loadLibroMayor() {
  const accountId = $('lm-account-select').value;
  if (!accountId) { toast('Seleccioná una cuenta', 'error'); return; }
  const df = $('lm-date-from').value;
  const dt = $('lm-date-to').value;
  const params = new URLSearchParams({ account_id: accountId });
  if (df) params.set('date_from', df);
  if (dt) params.set('date_to', dt);
  try {
    const d = await api('GET', `/accounting/ledger?${params}`);
    const isDebitNormal = ['Activo','Costo','Gasto'].includes(d.account.type);

    $('lm-summary').classList.remove('hidden');
    $('lm-opening').textContent = fmtMoney(d.opening_balance);
    $('lm-opening').style.color = d.opening_balance < 0 ? 'var(--error)' : '';
    $('lm-closing').textContent = fmtMoney(d.closing_balance);
    $('lm-closing').style.color = d.closing_balance < 0 ? 'var(--error)' : 'var(--primary)';
    const totalD = d.rows.reduce((s,r) => s + r.debit, 0);
    const totalC = d.rows.reduce((s,r) => s + r.credit, 0);
    $('lm-total-debit').textContent  = fmtMoney(totalD);
    $('lm-total-credit').textContent = fmtMoney(totalC);

    const openingRow = df ? `<tr style="background:var(--surface-2,#f8f8f8);font-style:italic">
      <td colspan="5" style="color:var(--text-muted);font-size:.85rem">Saldo inicial al ${fmtDate(df)}</td>
      <td class="text-right" style="font-weight:600">${fmtMoney(d.opening_balance)}</td>
    </tr>` : '';

    $('lm-tbody').innerHTML = openingRow + (d.rows.length ? d.rows.map(r => `
      <tr>
        <td>${fmtDate(r.date)}</td>
        <td>${esc(r.description)}${r.line_description ? `<br><span style="font-size:.8rem;color:var(--text-muted)">${esc(r.line_description)}</span>` : ''}</td>
        <td style="font-size:.78rem;color:var(--text-muted)">${esc(r.ref_type||'')}</td>
        <td class="text-right">${r.debit  > 0 ? fmtMoney(r.debit)  : ''}</td>
        <td class="text-right">${r.credit > 0 ? fmtMoney(r.credit) : ''}</td>
        <td class="text-right" style="font-weight:600;${r.balance < 0 ? 'color:var(--error)' : ''}">${fmtMoney(r.balance)}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted)">Sin movimientos en el período</td></tr>');
  } catch (err) { toast(err.message, 'error'); }
}

/* ================================================================ CIERRES CONTABLES */

async function loadCierres() {
  try {
    const rows = await api('GET', '/accounting/closes');
    $('closes-tbody').innerHTML = rows.length ? rows.map(r => `
      <tr>
        <td style="font-weight:600;font-family:monospace">${esc(r.period)}</td>
        <td>${fmtDateTime(r.closed_at)}</td>
        <td>${esc(r.closed_by_name || '—')}</td>
        <td class="text-center">
          <button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="reopenPeriod(${r.id},'${esc(r.period)}')">Reabrir</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-muted)">Sin períodos cerrados</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

$('btn-new-close').addEventListener('click', () => {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  $('inp-close-period').value = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
  $('close-form-wrap').classList.remove('hidden');
});
$('btn-close-cancel').addEventListener('click', () => $('close-form-wrap').classList.add('hidden'));
$('btn-close-confirm').addEventListener('click', async () => {
  const period = $('inp-close-period').value;
  if (!period) { toast('Seleccioná un período', 'error'); return; }
  if (!await confirm(`¿Cerrar el período ${period}? Los asientos de ese mes no podrán crearse ni modificarse.`)) return;
  const btn = $('btn-close-confirm');
  btn.disabled = true;
  try {
    await api('POST', '/accounting/closes', { period });
    toast(`Período ${period} cerrado`, 'success');
    $('close-form-wrap').classList.add('hidden');
    loadCierres();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

window.reopenPeriod = async function(id, period) {
  if (!await confirm(`¿Reabrir el período ${period}? Los asientos volverán a poder modificarse.`)) return;
  try {
    await api('DELETE', `/accounting/closes/${id}`);
    toast(`Período ${period} reabierto`, 'success');
    loadCierres();
  } catch (err) { toast(err.message, 'error'); }
};

/* ================================================================ CONCILIACIÓN BANCARIA */

let _recId = null;

async function loadRecBankAccounts() {
  try {
    const accounts = await api('GET', '/bank/accounts');
    $('rec-bank-select').innerHTML = '<option value="">— Seleccioná —</option>' +
      accounts.filter(a => a.active).map(a =>
        `<option value="${a.id}">${esc(a.name)}${a.bank ? ' — '+a.bank : ''}</option>`
      ).join('');
    if (!$('rec-period').value) {
      const now = new Date();
      $('rec-period').value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    }
  } catch (err) { toast(err.message, 'error'); }
}

$('btn-load-rec').addEventListener('click', loadReconciliation);

async function loadReconciliation() {
  const bankId = $('rec-bank-select').value;
  const period = $('rec-period').value;
  if (!bankId || !period) { toast('Seleccioná cuenta y período', 'error'); return; }
  const [year, month] = period.split('-');
  try {
    const d = await api('GET', `/accounting/reconciliation?bank_account_id=${bankId}&year=${year}&month=${month}`);
    _recId = d.reconciliation.id;
    $('rec-bank-balance-inp').value = d.reconciliation.bank_balance || '';
    $('rec-system-balance').textContent = fmtMoney(d.system_balance);
    updateRecDiff(d.system_balance, d.reconciliation.bank_balance);
    renderRecSystemMovements(d.system_movements, d.reconciliation.id);
    renderRecBankLines(d.bank_lines, d.reconciliation.id);
    $('rec-content').classList.remove('hidden');
  } catch (err) { toast(err.message, 'error'); }
}

function updateRecDiff(sysBalance, bankBalance) {
  const diff = (bankBalance || 0) - sysBalance;
  const el = $('rec-diff');
  el.textContent = fmtMoney(diff);
  el.style.color = Math.abs(diff) < 0.01 ? 'var(--success)' : 'var(--error)';
}

$('btn-rec-save-balance').addEventListener('click', async () => {
  if (!_recId) return;
  const val = parseFloat($('rec-bank-balance-inp').value) || 0;
  try {
    const sysText = $('rec-system-balance').textContent;
    await api('PUT', `/accounting/reconciliation/${_recId}`, { bank_balance: val });
    const sysBalance = parseFloat(sysText.replace(/[^\d.,-]/g,'').replace(',','.')) || 0;
    updateRecDiff(parseFloat($('rec-system-balance').textContent.replace(/[$.\s]/g,'').replace(',','.'))||0, val);
    toast('Saldo bancario actualizado', 'success');
    loadReconciliation();
  } catch (err) { toast(err.message, 'error'); }
});

function renderRecSystemMovements(movements, recId) {
  $('rec-system-tbody').innerHTML = movements.length ? movements.map(m => {
    const amt = m.type === 'ingreso' ? m.amount : -m.amount;
    return `<tr style="${m.is_reconciled ? 'opacity:.5;text-decoration:line-through' : ''}">
      <td>${fmtDate(m.created_at)}</td>
      <td style="font-size:.82rem">${esc(m.description||m.ref_type||'—')}</td>
      <td class="text-right" style="font-weight:600;color:${amt>=0?'var(--success)':'var(--error)'}">${fmtMoney(Math.abs(m.amount))} ${amt>=0?'↑':'↓'}</td>
      <td class="text-center">
        <input type="checkbox" ${m.is_reconciled?'checked':''} onchange="toggleRecMark(${m.id},this.checked)">
      </td>
    </tr>`;
  }).join('')
  : '<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--text-muted)">Sin movimientos en el período</td></tr>';
}

function renderRecBankLines(lines, recId) {
  $('rec-bank-tbody').innerHTML = lines.length ? lines.map(l => `
    <tr style="${l.is_reconciled ? 'opacity:.5;text-decoration:line-through' : ''}">
      <td>${fmtDate(l.date)}</td>
      <td style="font-size:.82rem">${esc(l.description||'—')}</td>
      <td class="text-right" style="font-weight:600;color:${l.amount>=0?'var(--success)':'var(--error)'}">${fmtMoney(Math.abs(l.amount))} ${l.amount>=0?'↑':'↓'}</td>
      <td class="text-center">
        <input type="checkbox" ${l.is_reconciled?'checked':''} onchange="toggleRecBankLine(${l.id},this.checked)">
      </td>
      <td class="text-center">
        <button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deleteRecBankLine(${l.id})">✕</button>
      </td>
    </tr>`).join('')
  : '<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--text-muted)">Sin líneas del extracto</td></tr>';
}

window.toggleRecMark = async function(movementId, mark) {
  if (!_recId) return;
  try { await api('POST', `/accounting/reconciliation/${_recId}/mark`, { movement_id: movementId, mark }); }
  catch (err) { toast(err.message, 'error'); loadReconciliation(); }
};

window.toggleRecBankLine = async function(lineId, is_reconciled) {
  if (!_recId) return;
  try { await api('PUT', `/accounting/reconciliation/${_recId}/bank-line/${lineId}`, { is_reconciled }); }
  catch (err) { toast(err.message, 'error'); loadReconciliation(); }
};

window.deleteRecBankLine = async function(lineId) {
  if (!_recId) return;
  if (!await confirm('¿Eliminar esta línea del extracto?')) return;
  try {
    await api('DELETE', `/accounting/reconciliation/${_recId}/bank-line/${lineId}`);
    loadReconciliation();
  } catch (err) { toast(err.message, 'error'); }
};

$('btn-rec-add-line').addEventListener('click', () => {
  $('rec-add-line-form').classList.remove('hidden');
  $('rec-line-date').value = new Date().toISOString().slice(0,10);
  $('rec-line-amount').value = '';
  $('rec-line-desc').value = '';
});
$('btn-rec-line-cancel').addEventListener('click', () => $('rec-add-line-form').classList.add('hidden'));
$('btn-rec-line-save').addEventListener('click', async () => {
  if (!_recId) return;
  const date   = $('rec-line-date').value;
  const amount = parseFloat($('rec-line-amount').value);
  const desc   = $('rec-line-desc').value.trim();
  if (!date || isNaN(amount)) { toast('Fecha y monto requeridos', 'error'); return; }
  try {
    await api('POST', `/accounting/reconciliation/${_recId}/bank-line`, { date, description: desc, amount });
    $('rec-add-line-form').classList.add('hidden');
    loadReconciliation();
  } catch (err) { toast(err.message, 'error'); }
});

/* ================================================================ CALENDARIO */

let _calFilter = 'all';

document.querySelectorAll('[data-cal-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-cal-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _calFilter = btn.dataset.calFilter;
    loadCalendar();
  });
});
$('btn-refresh-calendar').addEventListener('click', loadCalendar);

async function loadCalendar() {
  try {
    const d = await api('GET', `/accounting/calendar?days=90&type=${_calFilter}`);
    const today = d.today;
    const sevenDaysOut = new Date(Date.now() + 7 * 86400000).toISOString().slice(0,10);

    // Summary
    const totalCobrar = d.events.filter(e => ['cheque_cobrar','cliente_deuda'].includes(e.event_type))
      .reduce((s,e) => s + (e.amount||0), 0);
    const totalPagar  = d.events.filter(e => ['cheque_pagar','proveedor_deuda'].includes(e.event_type))
      .reduce((s,e) => s + (e.amount||0), 0);
    $('cal-total-cobrar').textContent = fmtMoney(totalCobrar);
    $('cal-total-pagar').textContent  = fmtMoney(totalPagar);

    if (!d.events.length) {
      $('cal-content').innerHTML = '<p style="color:var(--text-muted);padding:20px 0">Sin eventos en los próximos 90 días</p>';
      return;
    }

    // Group by week
    const weeks = {};
    d.events.forEach(e => {
      const dt = new Date(e.date + 'T00:00:00');
      // Find Monday of the week
      const day = dt.getDay() || 7;
      const mon = new Date(dt); mon.setDate(dt.getDate() - day + 1);
      const key = mon.toISOString().slice(0,10);
      if (!weeks[key]) weeks[key] = [];
      weeks[key].push(e);
    });

    const typeLabel = { cheque_cobrar: 'Cheque a cobrar', cheque_pagar: 'Cheque a pagar', cliente_deuda: 'Saldo cliente', proveedor_deuda: 'Deuda proveedor' };
    const typeColor = { cheque_cobrar: 'var(--success)', cheque_pagar: 'var(--error)', cliente_deuda: 'var(--success)', proveedor_deuda: 'var(--error)' };

    $('cal-content').innerHTML = Object.keys(weeks).sort().map(weekKey => {
      const events = weeks[weekKey];
      const weekEnd = new Date(weekKey); weekEnd.setDate(weekEnd.getDate()+6);
      const weekLabel = `Semana del ${fmtDate(weekKey)} al ${fmtDate(weekEnd.toISOString().slice(0,10))}`;
      const weekCobrar = events.filter(e => ['cheque_cobrar','cliente_deuda'].includes(e.event_type)).reduce((s,e) => s+e.amount,0);
      const weekPagar  = events.filter(e => ['cheque_pagar','proveedor_deuda'].includes(e.event_type)).reduce((s,e) => s+e.amount,0);

      const rows = events.map(e => {
        const isUrgent = e.date <= sevenDaysOut && e.date >= today;
        return `<tr style="${isUrgent ? 'background:#fef9c3' : ''}">
          <td>${fmtDate(e.date)}${isUrgent ? ' <span style="color:#b45309;font-size:.75rem;font-weight:600">⚡</span>' : ''}</td>
          <td><span style="color:${typeColor[e.event_type]};font-weight:600;font-size:.82rem">${esc(typeLabel[e.event_type]||e.event_type)}</span></td>
          <td>${esc(e.description)}</td>
          <td>${esc(e.entity_name||'—')}</td>
          <td class="text-right" style="font-weight:600;color:${typeColor[e.event_type]}">${fmtMoney(e.amount)}</td>
        </tr>`;
      }).join('');

      return `<div style="margin-bottom:20px">
        <div style="font-weight:700;font-size:.9rem;padding:8px 12px;background:var(--surface-2,#f8f8f8);border-radius:6px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center">
          <span>${weekLabel}</span>
          <span style="font-size:.82rem;font-weight:400;color:var(--text-muted)">
            <span style="color:var(--success)">A cobrar: ${fmtMoney(weekCobrar)}</span>&nbsp;·&nbsp;
            <span style="color:var(--error)">A pagar: ${fmtMoney(weekPagar)}</span>
          </span>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th style="width:110px">Fecha</th><th style="width:140px">Tipo</th><th>Descripción</th><th style="width:160px">Entidad</th><th class="text-right" style="width:120px">Monto</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
    }).join('');
  } catch (err) { toast(err.message, 'error'); }
}

/* ================================================================ NOTAS DE DÉBITO/CRÉDITO */

let _noteEntityType = null;
let _noteEntityId   = null;

// Open from client account
$('btn-new-client-note').addEventListener('click', () => {
  if (!_accountCustomerId) return;
  openNoteModal('customer', _accountCustomerId);
});

// Open from supplier account (wired after supplier functions)
$('btn-new-sup-note').addEventListener('click', () => {
  if (!currentSupplierId) return;
  openNoteModal('supplier', currentSupplierId);
});

function openNoteModal(entityType, entityId) {
  _noteEntityType = entityType;
  _noteEntityId   = entityId;
  const label = entityType === 'customer' ? 'cliente' : 'proveedor';
  $('note-modal-title').textContent = `Nueva nota — ${label}`;
  $('inp-note-type').value = 'debito';
  $('inp-note-date').value = new Date().toISOString().slice(0,10);
  $('inp-note-desc').value = '';
  $('inp-note-amount').value = '';
  $('inp-note-ref').value = '';
  updateNoteHint();
  $('note-modal').classList.remove('hidden');
}

function updateNoteHint() {
  const type = $('inp-note-type').value;
  const entity = _noteEntityType === 'customer' ? 'cliente' : 'proveedor';
  $('note-modal-hint').textContent = type === 'debito'
    ? `Nota de Débito: aumenta lo que el ${entity} debe.`
    : `Nota de Crédito: reduce lo que el ${entity} debe.`;
}
$('inp-note-type').addEventListener('change', updateNoteHint);

$('btn-note-cancel').addEventListener('click', () => $('note-modal').classList.add('hidden'));
$('note-modal').addEventListener('click', e => { if (e.target === $('note-modal')) $('note-modal').classList.add('hidden'); });

$('btn-note-save').addEventListener('click', async () => {
  const desc   = $('inp-note-desc').value.trim();
  const amount = parseFloat($('inp-note-amount').value);
  const date   = $('inp-note-date').value;
  const type   = $('inp-note-type').value;
  const ref    = $('inp-note-ref').value.trim();
  if (!desc) { toast('Descripción requerida', 'error'); return; }
  if (!amount || amount <= 0) { toast('Monto inválido', 'error'); return; }
  const btn = $('btn-note-save');
  btn.disabled = true;
  try {
    await api('POST', '/accounting/notes', {
      entity_type: _noteEntityType, entity_id: _noteEntityId,
      note_type: type, date, description: desc, amount, reference: ref
    });
    toast('Nota guardada', 'success');
    $('note-modal').classList.add('hidden');
    if (_noteEntityType === 'customer') loadAccount();
    else openSupplierAccount(_noteEntityId);
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

window.deleteNote = async function(id, entityType, entityId) {
  if (!await confirm('¿Eliminar esta nota? Se generará un contra-asiento contable automáticamente.')) return;
  try {
    await api('DELETE', `/accounting/notes/${id}`);
    toast('Nota eliminada', 'success');
    if (entityType === 'customer') loadAccount();
    else openSupplierAccount(entityId);
  } catch (err) { toast(err.message, 'error'); }
};

/* ================================================================ INIT */
checkAuth();
