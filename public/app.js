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
function statusBadge(s) {
  const cls = { 'Pendiente':'warning','En preparación':'info','Entregado':'success','Cancelado':'default','Entrega parcial':'partial' };
  return `<span class="badge badge-${cls[s]||'default'}">${esc(s)}</span>`;
}
function isAdmin() { return state.user && state.user.role === 'admin'; }

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
  $('sidebar-role').textContent = state.user.role === 'admin' ? 'Administrador' : 'Vendedor';
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  document.querySelectorAll('.admin-only-col').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  document.querySelectorAll('.admin-only-field').forEach(el => el.classList.toggle('hidden', !isAdmin()));

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
  if (section === 'compras')   { showComprasTab('resumen'); loadFinanceSummary(); }
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
  $('inp-order-discount').value = '0';
  $('form-status-badge').innerHTML = '';
  $('btn-export-pdf').classList.add('hidden');
  if ($('inp-vendor-display')) $('inp-vendor-display').value = '';

  if (orderId) {
    try {
      const o = await api('GET', `/orders/${orderId}`);
      $('inp-order-number').value   = `#${o.order_number}`;
      $('inp-customer').value       = o.customer_name;
      $('inp-status').value         = o.status;
      $('inp-delivery-date').value  = o.delivery_date || '';
      $('inp-notes').value          = o.notes || '';
      $('inp-order-discount').value = o.discount || 0;
      $('form-status-badge').innerHTML = statusBadge(o.status);
      $('btn-export-pdf').classList.remove('hidden');
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
$('inp-status').addEventListener('change', () => {
  if (state.editingOrderId) $('form-status-badge').innerHTML = statusBadge($('inp-status').value);
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
  const pct      = parseFloat($('inp-order-discount').value) || 0;
  const discAmt  = subtotal * pct / 100;
  $('calc-subtotal').textContent = fmtMoney(subtotal);
  $('calc-discount').textContent = `− ${fmtMoney(discAmt)}`;
  $('calc-total').textContent    = fmtMoney(subtotal - discAmt);
}
$('inp-order-discount').addEventListener('input', calcTotals);

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
    discount:      parseFloat($('inp-order-discount').value) || 0,
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

function renderCatalog(products) {
  const tbody = $('catalog-tbody');
  const noEl  = $('no-catalog');
  $('catalog-count').textContent = `${products.length} producto${products.length !== 1 ? 's' : ''}`;

  if (products.length === 0) { tbody.innerHTML = ''; noEl.classList.remove('hidden'); return; }
  noEl.classList.add('hidden');

  tbody.innerHTML = products.map(p => {
    const stockClass = p.active && p.stock === 0 ? 'stock-critical' : (p.active && p.stock_min > 0 && p.stock <= p.stock_min ? 'stock-low' : '');
    return `
    <tr class="${stockClass}">
      <td style="${!p.active ? 'opacity:.5;text-decoration:line-through' : ''}">${esc(p.name)}</td>
      <td class="text-right" style="font-weight:600">${fmtMoney(p.base_price)}</td>
      <td class="text-center">
        ${p.active ? stockBadge(p.stock, p.stock_min) : '<span class="badge badge-default">—</span>'}
      </td>
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
  $('inp-client-phone').value   = '';
  $('inp-client-email').value   = '';
  $('inp-client-address').value = '';
  $('inp-client-notes').value   = '';
  $('inp-client-iva').value     = 'Consumidor Final';

  if (id) {
    api('GET', '/customers').then(list => {
      const c = list.find(x => x.id === id);
      if (c) {
        $('inp-client-name').value    = c.name;
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
$('btn-new-payment').addEventListener('click', () => {
  $('inp-payment-method').value    = 'efectivo';
  $('inp-payment-amount').value    = '';
  $('inp-payment-date').value      = '';
  $('inp-payment-bank').value      = '';
  $('inp-payment-reference').value = '';
  $('inp-payment-notes').value     = '';
  updatePaymentFields();
  $('payment-modal').classList.remove('hidden');
});
$('btn-payment-cancel').addEventListener('click', () => $('payment-modal').classList.add('hidden'));
$('payment-modal').addEventListener('click', e => { if (e.target === $('payment-modal')) $('payment-modal').classList.add('hidden'); });

function updatePaymentFields() {
  const m = $('inp-payment-method').value;
  $('payment-bank-wrap').classList.toggle('hidden', m !== 'cheque');
  $('payment-reference-wrap').classList.toggle('hidden', !['cheque','transferencia','tarjeta'].includes(m));
  const refLabels = { cheque: 'Nº de cheque', transferencia: 'Referencia / Nº operación', tarjeta: 'Nº de autorización' };
  if (refLabels[m]) $('lbl-payment-reference').textContent = refLabels[m];
  $('lbl-payment-date').textContent = m === 'cheque' ? 'Fecha de cobro' : 'Fecha del pago';
}
$('inp-payment-method').addEventListener('change', updatePaymentFields);

$('btn-payment-confirm').addEventListener('click', async () => {
  const amount = parseFloat($('inp-payment-amount').value);
  if (!amount || amount <= 0) { toast('Ingresá un monto válido', 'error'); $('inp-payment-amount').focus(); return; }
  const btn = $('btn-payment-confirm');
  btn.disabled = true;
  try {
    await api('POST', '/payments', {
      customer_id:  _accountCustomerId,
      amount,
      method:       $('inp-payment-method').value,
      bank:         $('inp-payment-bank').value.trim(),
      reference:    $('inp-payment-reference').value.trim(),
      notes:        $('inp-payment-notes').value.trim(),
      payment_date: $('inp-payment-date').value || null
    });
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
  const data = {
    name,
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

function stockBadge(stock, stock_min) {
  if (stock === 0)
    return `<span class="badge badge-stock-out">Sin stock</span>`;
  if (stock_min > 0 && stock <= stock_min)
    return `<span class="badge badge-stock-low">${stock}</span>`;
  return `<span class="badge badge-stock-ok">${stock}</span>`;
}

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
  $('stock-count').textContent = `${products.length} producto${products.length !== 1 ? 's' : ''}`;

  if (!products.length) { tbody.innerHTML = ''; noEl.classList.remove('hidden'); return; }
  noEl.classList.add('hidden');

  tbody.innerHTML = products.map(p => {
    const isLow  = p.stock_min > 0 && p.stock <= p.stock_min && p.stock > 0;
    const isOut  = p.stock === 0;
    const rowCls = isOut ? 'stock-critical' : isLow ? 'stock-low' : '';
    return `<tr class="${rowCls}">
      <td style="font-weight:500">${esc(p.name)}</td>
      <td class="text-center" style="font-weight:700;font-size:1.05rem">${p.stock}</td>
      <td class="text-center" style="color:var(--text-muted)">${p.stock_min || '—'}</td>
      <td class="text-center">${stockBadge(p.stock, p.stock_min)}</td>
      <td class="text-center" style="white-space:nowrap">
        <button class="btn-icon" onclick="openIngresoModal(${p.id})" title="Registrar ingreso">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="btn-icon" onclick="openMovementsModal(${p.id},'${esc(p.name)}')" title="Ver historial">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

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
        <td class="text-center">
          ${m.type === 'ingreso'
            ? '<span class="badge badge-stock-ok">Ingreso</span>'
            : '<span class="badge badge-stock-out">Egreso</span>'}
        </td>
        <td class="text-center" style="font-weight:600">${m.quantity}</td>
        <td style="font-size:.85rem">${esc(m.reference || m.notes || '—')}</td>
        <td style="color:var(--text-muted);font-size:.83rem">${esc(m.user_name || '—')}</td>
      </tr>
    `).join('');
  } catch (err) { toast(err.message, 'error'); $('movements-modal').classList.add('hidden'); }
};

$('btn-movements-close').addEventListener('click', () => $('movements-modal').classList.add('hidden'));
$('movements-modal').addEventListener('click', e => { if (e.target === $('movements-modal')) $('movements-modal').classList.add('hidden'); });

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
    if (tab === 'resumen')      loadFinanceSummary();
    if (tab === 'proveedores')  { showProveedoresSubview('list'); loadSuppliers(); }
    if (tab === 'comprobantes') { showComprobantesSubview('list'); loadPurchases(); }
    if (tab === 'caja')         loadCash();
    if (tab === 'banco')        { showBancoSubview('list'); loadBankAccounts(); }
    if (tab === 'cheques')      loadCheques();
  });
});

// ── FINANCE SUMMARY ─────────────────────────────────────────────────────────
async function loadFinanceSummary() {
  try {
    const d = await api('GET', '/finance/summary');
    const color = v => v >= 0 ? 'var(--success)' : 'var(--error)';
    $('fin-cash').textContent     = fmtMoney(d.cash_balance);
    $('fin-cash').style.color     = color(d.cash_balance);
    $('fin-bank').textContent     = fmtMoney(d.bank_balance);
    $('fin-bank').style.color     = color(d.bank_balance);
    $('fin-clients').textContent  = fmtMoney(d.client_debt);
    $('fin-suppliers').textContent= fmtMoney(d.supplier_debt);
    $('fin-ch-cobrar').textContent= fmtMoney(d.cheques_cobrar);
    $('fin-ch-pagar').textContent = fmtMoney(d.cheques_pagar);
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
  } catch (err) { toast(err.message, 'error'); }
};

$('btn-back-sup-account').addEventListener('click', () => { showProveedoresSubview('list'); loadSuppliers(); });

// Supplier payment modal
$('btn-new-sup-payment').addEventListener('click', () => {
  $('inp-sup-pay-amount').value = '';
  $('inp-sup-pay-date').value   = '';
  $('inp-sup-pay-method').value = 'efectivo';
  $('inp-sup-pay-bank').value   = '';
  $('inp-sup-pay-reference').value = '';
  $('inp-sup-pay-notes').value  = '';
  updateSupPayFields();
  $('sup-payment-modal').classList.remove('hidden');
});
$('btn-sup-pay-cancel').addEventListener('click', () => $('sup-payment-modal').classList.add('hidden'));
$('sup-payment-modal').addEventListener('click', e => { if (e.target === $('sup-payment-modal')) $('sup-payment-modal').classList.add('hidden'); });

function updateSupPayFields() {
  const method = $('inp-sup-pay-method').value;
  $('sup-pay-bank-wrap').classList.toggle('hidden', !['cheque','transferencia'].includes(method));
  $('sup-pay-ref-wrap').classList.toggle('hidden', !['cheque','transferencia'].includes(method));
}
$('inp-sup-pay-method').addEventListener('change', updateSupPayFields);

$('btn-sup-pay-confirm').addEventListener('click', async () => {
  const btn = $('btn-sup-pay-confirm');
  btn.disabled = true;
  try {
    await api('POST', '/supplier-payments', {
      supplier_id:  currentSupplierId,
      amount:       parseFloat($('inp-sup-pay-amount').value),
      method:       $('inp-sup-pay-method').value,
      bank:         $('inp-sup-pay-bank').value.trim(),
      reference:    $('inp-sup-pay-reference').value.trim(),
      notes:        $('inp-sup-pay-notes').value.trim(),
      payment_date: $('inp-sup-pay-date').value || null
    });
    toast('Pago registrado', 'success');
    $('sup-payment-modal').classList.add('hidden');
    openSupplierAccount(currentSupplierId);
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

window.deleteSupplierPayment = async function(id) {
  if (!await confirm('¿Eliminar este pago?')) return;
  try {
    await api('DELETE', `/supplier-payments/${id}`);
    toast('Pago eliminado', 'success');
    openSupplierAccount(currentSupplierId);
  } catch (err) { toast(err.message, 'error'); }
};

// ── PURCHASES (Comprobantes) ─────────────────────────────────────────────────
let purchaseItems = [];

function showComprobantesSubview(v) {
  $('comprobantes-list-view').classList.toggle('hidden', v !== 'list');
  $('purchase-form-view').classList.toggle('hidden', v !== 'form');
}

async function loadPurchases() {
  try {
    const rows = await api('GET', '/purchases');
    $('purchases-tbody').innerHTML = rows.length ? rows.map(p => `
      <tr>
        <td>${esc(p.purchase_number)}</td>
        <td>${esc(p.supplier_name)}</td>
        <td>${esc(p.doc_type)}</td>
        <td>${esc(p.doc_number || '—')}</td>
        <td>${fmtDate(p.doc_date || p.created_at)}</td>
        <td class="text-right">${fmtMoney(p.total)}</td>
        <td class="text-center">
          <a href="/api/purchases/${p.id}/print" target="_blank" class="btn btn-ghost btn-sm">PDF</a>
          <button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deletePurchase(${p.id},'${esc(p.purchase_number)}')">Eliminar</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">Sin comprobantes</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

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
  purchaseItems.push({ name:'', qty:1, price:0 });
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
        ? nextStatuses.map(([s, l]) => `<button class="btn btn-ghost btn-sm" onclick="updateChequeStatus(${c.id},'${s}')">${l}</button>`).join('')
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

window.updateChequeStatus = async function(id, status) {
  try {
    await api('PATCH', `/cheques/${id}/status`, { status });
    toast('Estado actualizado', 'success');
    loadCheques();
  } catch (err) { toast(err.message, 'error'); }
};

window.deleteCheque = async function(id) {
  if (!await confirm('¿Eliminar este cheque?')) return;
  try {
    await api('DELETE', `/cheques/${id}`);
    toast('Cheque eliminado', 'success');
    loadCheques();
  } catch (err) { toast(err.message, 'error'); }
};

/* ================================================================ INIT */
checkAuth();
