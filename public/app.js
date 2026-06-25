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
function isVendor()     { return state.user && state.user.role === 'vendedor'; }

/* ================================================================ STATE */
const state = {
  user:              null,
  sucursales:        [],
  activeSucursalId:  null,
  filterStatus:      'Todos',
  editingOrderId:    null,
  editingProdId:     null,
  editingUserId:     null,
  editingClientId:   null,
  items:             [],
  productCatalog:    [],
  customerList:      [],
  allSucursales:     [],
  charts:            {},
  discountOver:      false
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
    const data = await api('GET', '/auth/me');
    state.user = data;
    state.sucursales = data.sucursales || [];
    state.activeSucursalId = data.active_sucursal_id || null;
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
  const roleLabels = { admin: 'Administrador', subadmin: 'Subadmin', vendedor: 'Vendedor', mp: 'MP / Fábrica' };
  $('sidebar-role').textContent = roleLabels[state.user.role] || 'Vendedor';
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdminLike()));
  document.querySelectorAll('.admin-only-col').forEach(el => el.classList.toggle('hidden', !isAdminLike()));
  document.querySelectorAll('.admin-only-field').forEach(el => el.classList.toggle('hidden', !isAdminLike()));
  document.querySelectorAll('.strict-admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  // MP nav visible para admin y fabrica; resto del nav oculto para fabrica
  document.querySelectorAll('.mp-visible').forEach(el => el.classList.toggle('hidden', !canAccessMP()));
  // prod-visible: visible para todos los roles excepto vendedor
  document.querySelectorAll('.prod-visible').forEach(el => el.classList.toggle('hidden', !canAccessProd()));
  if (isFabrica()) {
    document.querySelectorAll('.nav-item:not(.mp-visible):not(.prod-visible)').forEach(el => el.classList.add('hidden'));
  } else {
    // Restaurar módulos base para roles no-mp (pueden haber quedado ocultos si antes
    // había una sesión mp activa en la misma pestaña)
    document.querySelectorAll('.nav-item:not(.mp-visible):not(.prod-visible):not(.admin-only):not(.strict-admin-only)')
      .forEach(el => el.classList.remove('hidden'));
  }

  // Renderizar selector de sucursal
  renderSucursalSelector();

  // Cargar settings
  try {
    const cfg = await api('GET', '/settings');
    $('sidebar-company').textContent = cfg.company_name || 'Candex Pro';
    $('mobile-company-name').textContent = cfg.company_name || 'Candex Pro';
    $('inp-company-name').value = cfg.company_name || '';
  } catch {}

  // Cargar catálogo de productos para el formulario
  await loadProductCatalog();

  navigate(isFabrica() ? 'mp' : 'pedidos');
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('login-btn');
  $('login-error').classList.add('hidden');
  btn.disabled = true; btn.textContent = 'Ingresando...';
  try {
    const data = await api('POST', '/auth/login', {
      username: $('inp-username').value.trim(),
      password: $('inp-password').value
    });
    state.user = data;
    state.sucursales = data.sucursales || [];
    state.activeSucursalId = data.active_sucursal_id || null;
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

/* ================================================================ SUCURSAL SELECTOR */
function renderSucursalSelector() {
  const container = $('sidebar-sucursal');
  const sel = $('sel-sucursal');
  const sucursales = state.sucursales || [];

  // Show selector only if user has 2+ sucursales, or is admin
  const showSel = sucursales.length >= 2 || isAdmin();
  container.classList.toggle('hidden', !showSel);
  if (!showSel) return;

  sel.innerHTML = '';
  if (isAdmin()) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Todas las sucursales';
    sel.appendChild(opt);
  }
  for (const s of sucursales) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  }
  sel.value = state.activeSucursalId || '';
}

$('sel-sucursal').addEventListener('change', async () => {
  const val = $('sel-sucursal').value;
  const sucursal_id = val === '' ? null : Number(val);
  try {
    await api('POST', '/auth/switch-sucursal', { sucursal_id });
    state.activeSucursalId = sucursal_id;
    // Reload current section data
    const active = document.querySelector('.nav-item.active');
    if (active) {
      const section = active.getAttribute('data-section');
      if (section) navigate(section);
    }
  } catch (err) { toast(err.message, 'error'); }
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
  if (isVendor() && section === 'produccion') {
    toast('Sin acceso a esta sección', 'error');
    return;
  }
  if (isFabrica() && section !== 'mp' && section !== 'produccion') {
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
  if (section === 'mp')        { showMpView('list'); loadMpOrders(); }
  if (section === 'produccion') showProdTab('proceso');
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
    const modelo = ($('inp-orders-modelo').value || '').trim();
    if (modelo) params.set('modelo', modelo);
    const qs = params.toString() ? `?${params}` : '';
    const orders = await api('GET', `/orders${qs}`);
    renderOrders(orders, q, modelo);
  } catch (err) { toast(err.message, 'error'); }
}

function applyOrderSearch() {
  clearTimeout(_ordersSearchTimer);
  _ordersSearchTimer = setTimeout(loadOrders, 250);
}

function applyOrderModeloFilter() {
  $('btn-orders-modelo-clear').style.display = $('inp-orders-modelo').value ? '' : 'none';
  clearTimeout(_ordersSearchTimer);
  _ordersSearchTimer = setTimeout(loadOrders, 250);
}

function renderOrders(orders, searchQuery = '', modeloQuery = '') {
  const tbody = $('orders-tbody');
  const noEl  = $('no-orders');
  const infoEl = $('orders-modelo-info');
  $('list-count').textContent = orders.length === 0 ? 'Sin pedidos' : `${orders.length} pedido${orders.length !== 1 ? 's' : ''}`;

  if (modeloQuery) {
    infoEl.style.display = '';
    infoEl.textContent = `${orders.length} pedido${orders.length !== 1 ? 's' : ''} con el modelo "${modeloQuery}"`;
  } else {
    infoEl.style.display = 'none';
  }

  if (orders.length === 0) {
    tbody.innerHTML = '';
    $('no-orders-msg').textContent = modeloQuery
      ? 'No se encontraron pedidos con ese modelo'
      : (searchQuery ? 'No se encontraron pedidos' : 'No hay pedidos');
    noEl.classList.remove('hidden');
    return;
  }
  noEl.classList.add('hidden');

  tbody.innerHTML = orders.map(o => `
    <tr data-id="${o.id}" style="cursor:pointer">
      <td><span class="order-num">#${esc(o.order_number)}</span></td>
      <td>${esc(o.customer_name)}${modeloQuery && o.modelo_qty ? `<br><span style="font-size:.76rem;color:var(--primary);font-weight:600">${o.modelo_qty % 1 === 0 ? o.modelo_qty : o.modelo_qty.toFixed(2)} × ${esc(modeloQuery)}</span>` : ''}</td>
      <td>${statusBadge(o.status)}</td>
      ${isAdmin() ? `<td style="color:var(--text-muted);font-size:.83rem">${esc(o.vendor_name||'—')}</td>` : ''}
      <td class="text-center col-mobile-hide">${o.total_units % 1 === 0 ? o.total_units : (o.total_units || 0).toFixed(2)}</td>
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
$('inp-orders-modelo').addEventListener('input', applyOrderModeloFilter);
$('btn-orders-modelo-clear').addEventListener('click', () => {
  $('inp-orders-modelo').value = '';
  $('btn-orders-modelo-clear').style.display = 'none';
  loadOrders();
});
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
  state.discountOver = false;
  $('disc-limit-error').classList.add('hidden');
  $('btn-save').disabled = false;

  $('form-title').textContent = orderId ? 'Editar Pedido' : 'Nuevo Pedido';
  $('inp-order-number').value = '';
  $('inp-customer').value     = '';
  $('inp-status').value       = 'Pendiente';
  $('inp-delivery-date').value = '';
  $('inp-notes').value        = '';
  $('inp-disc1').value = '0'; $('inp-disc2').value = '0';
  $('inp-disc3').value = '0'; $('inp-disc4').value = '0';
  $('inp-iva-exempt').checked        = false;
  $('inp-payment-efectivo').checked  = false;
  $('inp-payment-cheque').checked    = false;
  $('form-status-badge').innerHTML = '';
  $('btn-export-pdf').classList.add('hidden');
  $('btn-export-pdf-deposito').classList.add('hidden');
  if ($('inp-sucursal-id'))    $('inp-sucursal-id').value    = '';
  if ($('inp-price-list-id')) $('inp-price-list-id').value  = '';

  // Vendedores solo pueden seleccionar Cancelado
  const statusSel = $('inp-status');
  Array.from(statusSel.options).forEach(opt => { opt.disabled = isVendor() && opt.value !== 'Cancelado'; });

  // Cargar listas de precios para selector (solo admin)
  if (isAdmin()) await loadPriceLists();

  // Cargar lista de usuarios para selector de vendedor (solo admin)
  if (isAdmin() && $('inp-vendor-id')) {
    try {
      const users = await api('GET', '/users');
      const sel = $('inp-vendor-id');
      sel.innerHTML = '<option value="">— Sin asignar —</option>' +
        users.filter(u => u.active)
             .map(u => `<option value="${u.id}">${esc(u.full_name || u.username)}</option>`)
             .join('');
    } catch {}
  }

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
      $('inp-iva-exempt').checked       = !!o.iva_exempt;
      $('inp-payment-efectivo').checked = !!o.payment_efectivo;
      $('inp-payment-cheque').checked   = !!o.payment_cheque;
      $('form-status-badge').innerHTML = statusBadge(o.status);
      $('btn-export-pdf').classList.remove('hidden');
      $('btn-export-pdf-deposito').classList.remove('hidden');
      if ($('inp-vendor-id') && isAdmin())     $('inp-vendor-id').value     = o.vendor_id || '';
      if ($('inp-sucursal-id'))                 $('inp-sucursal-id').value    = o.sucursal_id || '';
      if ($('inp-price-list-id') && isAdmin()) $('inp-price-list-id').value  = o.price_list_id || '';
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
function findCustomerByName(name) {
  return (state.customerList || []).find(c => c.name.toLowerCase() === name.toLowerCase().trim());
}

$('inp-customer').addEventListener('input', () => {
  const hint = $('customer-cuit-hint');
  if (!hint) return;
  const match = findCustomerByName($('inp-customer').value);
  if (match && match.cuit) {
    hint.textContent = `CUIT: ${formatCuit(match.cuit)}`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
});

$('inp-customer').addEventListener('blur', () => {
  const val = $('inp-customer').value.trim();
  if (!val) return;
  if (!findCustomerByName(val)) {
    $('inp-customer').value = '';
    const hint = $('customer-cuit-hint');
    if (hint) hint.style.display = 'none';
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
      // Auto-fill price from selected price list (or active list / base_price fallback)
      const match = state.productCatalog.find(p => p.name.toLowerCase() === inp.value.toLowerCase());
      if (match) {
        const priceInp = inp.closest('tr').querySelector('.item-inp-price');
        const selListId = $('inp-price-list-id') ? Number($('inp-price-list-id').value) || null : null;
        getPriceForList(selListId).then(priceMap => {
          const price = (priceMap && priceMap[match.id] !== undefined) ? priceMap[match.id] : match.base_price;
          state.items[i].unit_price = price;
          priceInp.value = price;
          refreshItem(i);
        });
      }
    });
    inp.addEventListener('blur', () => {
      const i = inp.dataset.i;
      const val = inp.value.trim();
      if (!val) return;
      const match = state.productCatalog.find(p => p.name.toLowerCase() === val.toLowerCase());
      if (!match) {
        state.items[i].product_name = '';
        state.items[i].unit_price   = 0;
        inp.value = '';
        const priceInp = inp.closest('tr').querySelector('.item-inp-price');
        if (priceInp) priceInp.value = 0;
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
    inp.addEventListener('input', () => {
      state.items[inp.dataset.i].discount = parseFloat(inp.value) || 0;
      refreshItem(inp.dataset.i);
      checkDiscountLimit({ type: 'item', index: parseInt(inp.dataset.i) });
    });
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
// ── Validación de límite de descuento ─────────────────────────────────────────
const DISC_LIMIT = 0.278; // 1 − 0.80 × 0.95 × 0.95

function effDiscount(itemPct, d1, d2, d3, d4) {
  return 1 - (1 - itemPct/100) * (1 - d1/100) * (1 - d2/100) * (1 - d3/100) * (1 - d4/100);
}

function maxItemDisc() {
  return state.items.reduce((m, it) => Math.max(m, parseFloat(it.discount) || 0), 0);
}

// changedSpec: { type: 'general', id: 'inp-disc1' } | { type: 'item', index: N } | null
function checkDiscountLimit(changedSpec) {
  if (isAdmin()) {
    $('disc-limit-error').classList.add('hidden');
    state.discountOver = false;
    return;
  }

  const d1 = parseFloat($('inp-disc1').value) || 0;
  const d2 = parseFloat($('inp-disc2').value) || 0;
  const d3 = parseFloat($('inp-disc3').value) || 0;
  const d4 = parseFloat($('inp-disc4').value) || 0;
  const maxI = maxItemDisc();
  let eff = effDiscount(maxI, d1, d2, d3, d4);

  if (eff > DISC_LIMIT + 1e-9 && changedSpec) {
    const KEEP = 1 - DISC_LIMIT;
    const d1f = 1 - d1/100, d2f = 1 - d2/100, d3f = 1 - d3/100, d4f = 1 - d4/100;
    const itemF = 1 - maxI/100;

    if (changedSpec.type === 'general') {
      const cid = changedSpec.id;
      let others;
      if      (cid === 'inp-disc1') others = itemF * d2f * d3f * d4f;
      else if (cid === 'inp-disc2') others = itemF * d1f * d3f * d4f;
      else if (cid === 'inp-disc3') others = itemF * d1f * d2f * d4f;
      else                          others = itemF * d1f * d2f * d3f;
      const maxVal = others > 0 ? Math.max(0, 100 * (1 - KEEP / others)) : 0;
      $(cid).value = maxVal.toFixed(2);
      calcTotals();
      const newD = parseFloat(maxVal.toFixed(2));
      if      (cid === 'inp-disc1') eff = effDiscount(maxI, newD, d2, d3, d4);
      else if (cid === 'inp-disc2') eff = effDiscount(maxI, d1, newD, d3, d4);
      else if (cid === 'inp-disc3') eff = effDiscount(maxI, d1, d2, newD, d4);
      else                          eff = effDiscount(maxI, d1, d2, d3, newD);
    } else if (changedSpec.type === 'item') {
      const idx = changedSpec.index;
      const genF = d1f * d2f * d3f * d4f;
      const maxItemVal = genF > 0 ? Math.max(0, 100 * (1 - KEEP / genF)) : 0;
      state.items[idx].discount = parseFloat(maxItemVal.toFixed(2));
      const inp = document.querySelector(`.item-inp-disc[data-i="${idx}"]`);
      if (inp) inp.value = state.items[idx].discount;
      refreshItem(idx);
      eff = effDiscount(maxItemDisc(), d1, d2, d3, d4);
    }
  }

  const exceeded = eff > DISC_LIMIT + 1e-9;
  state.discountOver = exceeded;
  $('disc-limit-error').classList.toggle('hidden', !exceeded);
  $('btn-save').disabled = exceeded;
}

['inp-disc1','inp-disc2','inp-disc3','inp-disc4'].forEach(id =>
  $(id).addEventListener('input', () => { calcTotals(); checkDiscountLimit({ type: 'general', id }); })
);
$('inp-iva-exempt').addEventListener('change', calcTotals);
$('inp-payment-efectivo').addEventListener('change', () => {
  if ($('inp-payment-efectivo').checked) $('inp-payment-cheque').checked = false;
});
$('inp-payment-cheque').addEventListener('change', () => {
  if ($('inp-payment-cheque').checked) $('inp-payment-efectivo').checked = false;
});

/* ================================================================ SAVE ORDER */
$('order-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (state.discountOver) { toast('El descuento máximo permitido es 20+5+5 (27.8%)', 'error'); return; }
  const invalidItem = state.items.find(it => {
    const name = (it.product_name || '').trim();
    return name && !state.productCatalog.find(p => p.name.toLowerCase() === name.toLowerCase());
  });
  if (invalidItem) { toast('Todos los ítems deben tener un producto seleccionado de la lista', 'error'); return; }
  const customer = $('inp-customer').value.trim();
  if (!customer) { toast('El nombre del cliente es requerido', 'error'); $('inp-customer').focus(); return; }
  if (!findCustomerByName(customer)) { toast('El cliente debe estar registrado en el módulo Clientes', 'error'); $('inp-customer').focus(); return; }

  if ($('inp-sucursal-id') && !$('inp-sucursal-id').value) {
    toast('La sucursal es obligatoria', 'error'); $('inp-sucursal-id').focus(); return;
  }

  const data = {
    customer_name: customer,
    status:        $('inp-status').value,
    delivery_date: $('inp-delivery-date').value || null,
    notes:         $('inp-notes').value.trim(),
    discount:  parseFloat($('inp-disc1').value) || 0,
    discount2: parseFloat($('inp-disc2').value) || 0,
    discount3: parseFloat($('inp-disc3').value) || 0,
    discount4: parseFloat($('inp-disc4').value) || 0,
    iva_exempt:        $('inp-iva-exempt').checked ? 1 : 0,
    payment_efectivo:  $('inp-payment-efectivo').checked ? 1 : 0,
    payment_cheque:    $('inp-payment-cheque').checked   ? 1 : 0,
    items:             state.items.filter(i => i.product_name.trim())
  };
  if ($('inp-sucursal-id')) {
    const sid = $('inp-sucursal-id').value;
    data.sucursal_id = sid ? Number(sid) : null;
  }
  if (isAdmin() && $('inp-vendor-id')) {
    const vid = $('inp-vendor-id').value;
    data.vendor_id = vid ? Number(vid) : null;
  }
  if (isAdmin() && $('inp-price-list-id')) {
    const plid = $('inp-price-list-id').value;
    data.price_list_id = plid ? Number(plid) : null;
  }

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
    const showInactive = $('chk-catalog-show-inactive') && $('chk-catalog-show-inactive').checked;
    const [products, activeList] = await Promise.all([
      api('GET', showInactive ? '/products?all=1' : '/products'),
      api('GET', '/price-lists/active').catch(() => null)
    ]);
    renderCatalog(products);
    const infoEl = $('active-price-list-info');
    if (infoEl) {
      if (activeList) {
        infoEl.textContent = `Lista vigente: ${activeList.nombre} (desde ${fmtDate(activeList.fecha_vigencia)})`;
      } else {
        infoEl.textContent = 'Sin lista de precios activa — se usan los precios base de cada producto';
      }
    }
  } catch (err) { toast(err.message, 'error'); }
}

if ($('chk-catalog-show-inactive')) {
  $('chk-catalog-show-inactive').addEventListener('change', loadCatalog);
}

/* ================================================================ LISTAS DE PRECIO */

if ($('btn-new-price-list')) {
  $('btn-new-price-list').addEventListener('click', openPriceListModal);
}
['btn-price-list-cancel','btn-price-list-cancel2'].forEach(id => {
  if ($(id)) $(id).addEventListener('click', () => $('price-list-modal').classList.add('hidden'));
});
$('price-list-modal').addEventListener('click', e => {
  if (e.target === $('price-list-modal')) $('price-list-modal').classList.add('hidden');
});

async function openPriceListModal() {
  $('inp-pl-nombre').value  = '';
  $('inp-pl-fecha').value   = new Date().toISOString().slice(0,10);
  $('price-list-modal').classList.remove('hidden');

  // Cargar productos con precios actuales
  try {
    const [products, activeList] = await Promise.all([
      api('GET', '/products?all=1'),
      api('GET', '/price-lists/active').catch(() => null)
    ]);
    const priceMap = {};
    if (activeList && activeList.items) {
      for (const it of activeList.items) priceMap[it.product_id] = it.precio;
    }
    const activeProducts = products.filter(p => p.active);
    $('pl-items-tbody').innerHTML = activeProducts.map(p => {
      const precio = priceMap[p.id] !== undefined ? priceMap[p.id] : p.base_price;
      return `<tr>
        <td>${esc(p.name)}</td>
        <td class="text-right"><input type="number" class="input pl-price-inp" data-pid="${p.id}" value="${precio}" min="0" step="0.01" style="width:120px;text-align:right"></td>
      </tr>`;
    }).join('');
  } catch (err) { toast(err.message, 'error'); }
}

if ($('btn-price-list-save')) {
  $('btn-price-list-save').addEventListener('click', async () => {
    const nombre = $('inp-pl-nombre').value.trim();
    const fecha  = $('inp-pl-fecha').value;
    if (!nombre) { toast('El nombre es requerido', 'error'); $('inp-pl-nombre').focus(); return; }
    if (!fecha)  { toast('La fecha de vigencia es requerida', 'error'); $('inp-pl-fecha').focus(); return; }

    const items = Array.from($('pl-items-tbody').querySelectorAll('.pl-price-inp')).map(inp => ({
      product_id: Number(inp.dataset.pid),
      precio:     parseFloat(inp.value) || 0
    }));
    if (!items.length) { toast('No hay productos para guardar', 'error'); return; }

    const btn = $('btn-price-list-save');
    btn.disabled = true;
    try {
      await api('POST', '/price-lists', { nombre, fecha_vigencia: fecha, items });
      toast('Lista de precios guardada y activada', 'success');
      $('price-list-modal').classList.add('hidden');
      loadCatalog();
      // Recargar catálogo de productos y listas en el formulario de pedido
      await loadProductCatalog();
      await loadPriceLists();
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; }
  });
}

// ── Importar Excel en lista de precios ──
if ($('inp-pl-import-file')) {
  $('inp-pl-import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    try {
      const rows = await parseFileRows(file);
      const data = rows.map(r => ({
        nombre: normalizeKey(r, ['nombre','name','producto','product','descripcion','description']),
        precio: normalizeKey(r, ['precio','price','base_price','precio_base','valor','value','importe'])
      })).filter(r => r.nombre);

      if (!data.length) { toast('No se encontraron filas con nombre de producto', 'error'); return; }

      // Mapear por nombre a los inputs de la tabla
      const inputs = Array.from($('pl-items-tbody').querySelectorAll('.pl-price-inp'));
      let matched = 0;
      for (const d of data) {
        const normD = d.nombre.toLowerCase().trim();
        const inp = inputs.find(i => {
          const row = i.closest('tr');
          const tdName = row ? row.querySelector('td:first-child') : null;
          return tdName && tdName.textContent.toLowerCase().trim() === normD;
        });
        if (inp) {
          const precio = parseFloat(String(d.precio).replace(',', '.')) || 0;
          inp.value = precio;
          matched++;
        }
      }
      toast(`${matched} precio${matched !== 1 ? 's' : ''} actualizado${matched !== 1 ? 's' : ''} desde el archivo`, matched > 0 ? 'success' : 'error');
    } catch (err) { toast('Error al leer el archivo: ' + err.message, 'error'); }
  });
}

let _priceLists   = [];
let _activePriceListItems = {};

async function loadPriceLists() {
  try {
    _priceLists = await api('GET', '/price-lists');
    const sel = $('inp-price-list-id');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Vigente —</option>' +
      _priceLists.map(l => `<option value="${l.id}">${esc(l.nombre)} (${fmtDate(l.fecha_vigencia)})${l.active ? ' ✓' : ''}</option>`).join('');
  } catch {}
}

async function getPriceForList(listId) {
  if (!listId) {
    // Usar lista activa
    try {
      const active = await api('GET', '/price-lists/active');
      if (active && active.items) {
        const map = {};
        for (const it of active.items) map[it.product_id] = it.precio;
        return map;
      }
    } catch {}
    return null;
  }
  try {
    const list = await api('GET', `/price-lists/${listId}`);
    if (list && list.items) {
      const map = {};
      for (const it of list.items) map[it.product_id] = it.precio;
      return map;
    }
  } catch {}
  return null;
}

/* ================================================================ IMPORTAR LISTA DE PRECIOS */

let _iplData = [];  // filas parseadas del Excel

$('btn-import-price-list').addEventListener('click', () => {
  _iplData = [];
  $('inp-ipl-nombre').value = '';
  $('inp-ipl-fecha').value  = new Date().toISOString().slice(0,10);
  $('inp-ipl-file').value   = '';
  $('ipl-preview').classList.add('hidden');
  $('ipl-error').classList.add('hidden');
  $('btn-import-pl-confirm').classList.add('hidden');
  $('import-price-list-modal').classList.remove('hidden');
});

['btn-import-pl-cancel','btn-import-pl-cancel2'].forEach(id =>
  $(id).addEventListener('click', () => $('import-price-list-modal').classList.add('hidden'))
);
$('import-price-list-modal').addEventListener('click', e => {
  if (e.target === $('import-price-list-modal')) $('import-price-list-modal').classList.add('hidden');
});

$('inp-ipl-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  $('ipl-preview').classList.add('hidden');
  $('ipl-error').classList.add('hidden');
  $('btn-import-pl-confirm').classList.add('hidden');
  _iplData = [];

  try {
    const buf = await file.arrayBuffer();
    const ext = file.name.split('.').pop().toLowerCase();
    let rows = [];
    if (ext === 'csv') {
      const text = new TextDecoder('utf-8').decode(buf);
      rows = text.trim().split('\n').map(l => l.split(/[,;]/).map(c => c.trim().replace(/^"|"$/g, '')));
    } else {
      const wb = XLSX.read(buf, { type: 'array' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    }
    if (!rows.length) { $('ipl-error').textContent = 'Archivo vacío'; $('ipl-error').classList.remove('hidden'); return; }

    // Detectar columnas
    const header = rows[0].map(h => String(h).toLowerCase().trim());
    const nameIdx  = header.findIndex(h => ['nombre','name','producto','product'].includes(h));
    const priceIdx = header.findIndex(h => ['precio','price','base_price','valor','value','importe'].includes(h));
    if (nameIdx < 0 || priceIdx < 0) {
      $('ipl-error').textContent = 'No se encontraron columnas "nombre" y "precio". Revisá los encabezados del archivo.';
      $('ipl-error').classList.remove('hidden'); return;
    }

    // Cargar catálogo para hacer el match
    const catalog = await api('GET', '/products?all=1');
    const catalogMap = {};
    catalog.forEach(p => { catalogMap[p.name.toLowerCase().trim()] = p; });

    const found = [], notFound = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name  = String(row[nameIdx]  || '').trim();
      const rawPrice = String(row[priceIdx] || '').replace(/[^\d.,]/g,'').replace(',','.');
      const precio = parseFloat(rawPrice) || 0;
      if (!name) continue;
      const match = catalogMap[name.toLowerCase()];
      if (match) {
        found.push({ product_id: match.id, name: match.name, precio });
      } else {
        notFound.push(name);
      }
    }

    _iplData = found;

    // Mostrar preview
    $('ipl-tbody').innerHTML = found.map(r =>
      `<tr><td>${esc(r.name)}</td><td class="text-right">${fmtMoney(r.precio)}</td><td><span class="badge badge-success">OK</span></td></tr>`
    ).join('');
    $('ipl-summary').textContent = `${found.length} producto${found.length !== 1 ? 's' : ''} encontrado${found.length !== 1 ? 's' : ''} para actualizar.`;

    const nfEl = $('ipl-not-found');
    if (notFound.length) {
      $('ipl-not-found-list').textContent = notFound.join(', ');
      nfEl.classList.remove('hidden');
    } else { nfEl.classList.add('hidden'); }

    $('ipl-preview').classList.remove('hidden');
    if (found.length) $('btn-import-pl-confirm').classList.remove('hidden');
  } catch (err) {
    $('ipl-error').textContent = 'No se pudo leer el archivo: ' + err.message;
    $('ipl-error').classList.remove('hidden');
  }
});

$('btn-import-pl-confirm').addEventListener('click', async () => {
  const nombre = $('inp-ipl-nombre').value.trim();
  const fecha  = $('inp-ipl-fecha').value;
  if (!nombre) { toast('El nombre de la lista es requerido', 'error'); $('inp-ipl-nombre').focus(); return; }
  if (!fecha)  { toast('La fecha de vigencia es requerida', 'error'); $('inp-ipl-fecha').focus(); return; }
  if (!_iplData.length) return;

  const btn = $('btn-import-pl-confirm');
  btn.disabled = true;
  try {
    const result = await api('POST', '/price-lists', { nombre, fecha_vigencia: fecha, items: _iplData });
    toast(`Lista "${result.nombre}" guardada con ${_iplData.length} precios`, 'success');
    $('import-price-list-modal').classList.add('hidden');
    loadCatalog();
    await loadProductCatalog();
    await loadPriceLists();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

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
          : u.role === 'mp'
            ? '<span class="badge" style="background:#7c3aed;color:#fff">MP / Fábrica</span>'
            : '<span class="badge badge-vendor">Vendedor</span>'}</td>
      <td style="font-size:.82rem;color:var(--text-muted)">${(u.sucursales||[]).map(s=>esc(s.name)).join(', ') || '—'}</td>
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
$('inp-user-role').addEventListener('change', function() {
  const sec = $('user-mp-suppliers-section');
  if (this.value === 'mp') {
    renderUserMpSupplierCheckboxes(_mpFormSuppliers, new Set());
    sec.classList.remove('hidden');
  } else {
    sec.classList.add('hidden');
  }
});

function renderUserSucursalCheckboxes(assignedIds) {
  const container = $('user-sucursal-checkboxes');
  container.innerHTML = (state.allSucursales || []).map(s => `
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
      <input type="checkbox" value="${s.id}" ${(assignedIds || []).includes(s.id) ? 'checked' : ''}>
      ${esc(s.name)}
    </label>
  `).join('');
}

function getSelectedSucursalIds() {
  return Array.from($('user-sucursal-checkboxes').querySelectorAll('input[type=checkbox]:checked'))
    .map(cb => Number(cb.value));
}

let _mpFormSuppliers = [];

function renderUserMpSupplierCheckboxes(suppliers, assignedIds) {
  const container = $('user-mp-supplier-checkboxes');
  container.innerHTML = suppliers.length === 0
    ? '<span style="color:var(--text-muted);font-size:.88rem">No hay proveedores registrados</span>'
    : suppliers.map(s => `
        <label style="display:flex;gap:8px;align-items:center;cursor:pointer;font-size:.9rem">
          <input type="checkbox" class="user-mp-sup-cb" value="${s.id}" ${assignedIds.has(s.id) ? 'checked' : ''}>
          ${esc(s.name)}
        </label>`).join('');
}

window.openUserForm = async function(id) {
  state.editingUserId = id || null;
  $('user-form-title').textContent = id ? 'Editar Usuario' : 'Nuevo Usuario';
  $('inp-user-fullname').value  = '';
  $('inp-user-username').value  = '';
  $('inp-user-password').value  = '';
  $('inp-user-role').value      = 'vendedor';
  $('inp-user-username').disabled = false;
  $('pwd-label').textContent = id ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña *';
  $('user-mp-suppliers-section').classList.add('hidden');
  $('user-mp-supplier-checkboxes').innerHTML = '<span style="color:var(--text-muted);font-size:.88rem">Cargando...</span>';
  showUsersSubview('form');
  setTimeout(() => $('inp-user-fullname').focus(), 50);
  try {
    const [subs, allUsers, allSuppliers] = await Promise.all([
      api('GET', '/users/sucursales'),
      api('GET', '/users'),
      api('GET', '/suppliers')
    ]);
    state.allSucursales = subs;
    _mpFormSuppliers = allSuppliers.filter(s => s.active);
    let assignedMpIds = new Set();
    if (id) {
      const u = allUsers.find(x => x.id === id);
      if (u) {
        $('inp-user-fullname').value  = u.full_name;
        $('inp-user-username').value  = u.username;
        $('inp-user-role').value      = u.role;
        $('inp-user-username').disabled = true;
        renderUserSucursalCheckboxes((u.sucursales || []).map(s => s.id));
        assignedMpIds = new Set(u.mp_supplier_ids || []);
      }
    } else {
      renderUserSucursalCheckboxes([]);
    }
    if ($('inp-user-role').value === 'mp') {
      renderUserMpSupplierCheckboxes(_mpFormSuppliers, assignedMpIds);
      $('user-mp-suppliers-section').classList.remove('hidden');
    }
  } catch (err) { toast(err.message, 'error'); }
};

$('user-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fullname     = $('inp-user-fullname').value.trim();
  const username     = $('inp-user-username').value.trim();
  const password     = $('inp-user-password').value;
  const role         = $('inp-user-role').value;
  const sucursal_ids = getSelectedSucursalIds();
  const mp_supplier_ids = role === 'mp'
    ? [...document.querySelectorAll('.user-mp-sup-cb:checked')].map(cb => Number(cb.value))
    : [];

  if (!fullname) { toast('El nombre completo es requerido', 'error'); return; }
  if (!state.editingUserId && !username) { toast('El nombre de usuario es requerido', 'error'); return; }
  if (!state.editingUserId && (!password || password.length < 4))
    { toast('La contraseña debe tener al menos 4 caracteres', 'error'); return; }

  const btn = $('btn-user-save');
  btn.disabled = true;
  try {
    if (state.editingUserId) {
      const body = { full_name: fullname, role, sucursal_ids, mp_supplier_ids };
      if (password) body.password = password;
      await api('PUT', `/users/${state.editingUserId}`, body);
      toast('Usuario actualizado', 'success');
    } else {
      await api('POST', '/users', { username, password, full_name: fullname, role, sucursal_ids, mp_supplier_ids });
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

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

async function loadReports() {
  const now    = new Date();
  const picker = $('rpt-month-picker');

  // Initialize picker to current month if empty
  if (picker && !picker.value) {
    picker.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  }

  const [yr, mo] = (picker ? picker.value : '').split('-').map(Number);
  const year  = yr || now.getFullYear();
  const month = mo || (now.getMonth() + 1);

  const from = `${year}-${String(month).padStart(2,'0')}-01`;
  const to   = new Date(year, month, 0).toISOString().slice(0,10);

  const periodLabel = `${MONTHS_ES[month-1]} ${year}`;
  $('reports-period').textContent = periodLabel;

  // Update dynamic stat card labels
  const labelMap = {
    'stat-month-orders':          'Pedidos',
    'stat-month-sales':           'Ventas',
    'stat-avg':                   'Ticket promedio',
    'stat-month-units':           'Unidades pedidas',
    'stat-month-units-delivered': 'Unidades entregadas'
  };
  Object.entries(labelMap).forEach(([id, base]) => {
    const card = $(id)?.closest?.('.stat-card');
    if (card) card.querySelector('.stat-label').textContent = `${base} — ${periodLabel}`;
  });

  try {
    const [stats, dailyUnits, topProds] = await Promise.all([
      api('GET', `/reports/stats?from=${from}&to=${to}`),
      api('GET', '/reports/daily-units'),
      api('GET', `/reports/top-products?from=${from}&to=${to}`)
    ]);
    renderStats(stats);
    renderDailyUnitsChart(dailyUnits);
    renderStatusChart(stats.by_status);
    renderTopProducts(topProds);
  } catch (err) { toast(err.message, 'error'); }

  loadRankings();
  initQtyReport('sold');
  initQtyReport('delivered');
  loadPurchasesReport(from, to);
}

if ($('rpt-month-picker')) {
  $('rpt-month-picker').addEventListener('change', loadReports);
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

function fmtUnits(v) { const n = v || 0; return n % 1 === 0 ? n : n.toFixed(2); }

function renderStats(stats) {
  $('stat-total-orders').textContent           = stats.total_orders;
  $('stat-month-orders').textContent           = stats.month_orders;
  $('stat-month-sales').textContent            = fmtMoney(stats.month_sales);
  $('stat-avg').textContent                    = fmtMoney(stats.avg_order);
  $('stat-total-units').textContent            = fmtUnits(stats.total_units);
  $('stat-month-units').textContent            = fmtUnits(stats.month_units);
  $('stat-month-units-delivered').textContent  = fmtUnits(stats.month_units_delivered);
}

function renderDailyUnitsChart(days) {
  const canvas = $('chart-weekly');
  if (!canvas || typeof Chart === 'undefined') return;
  if (state.charts.weekly) state.charts.weekly.destroy();
  state.charts.weekly = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: days.map(d => d.label),
      datasets: [{
        label: 'Unidades',
        data: days.map(d => d.units),
        backgroundColor: 'rgba(16,185,129,0.75)',
        borderRadius: 4,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#f1f5f9' } },
        x: { grid: { display: false }, ticks: { maxTicksLimit: 14, maxRotation: 45 } }
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
      <td class="text-right" style="font-weight:600">${p.total_qty % 1 === 0 ? p.total_qty : p.total_qty.toFixed(2)}</td>
      <td class="text-center">${p.order_count}</td>
      <td class="text-right" style="font-weight:600;color:var(--primary)">${fmtMoney(p.revenue)}</td>
    </tr>
  `).join('');
}

$('btn-report-pdf').addEventListener('click', () => window.open('/api/reports/print', '_blank'));
$('btn-report-excel').addEventListener('click', () => { window.location.href = '/api/reports/excel'; });

// ── Unidades vendidas por período ─────────────────────────────────────────────
// ── Helpers de fecha para botones rápidos ────────────────────────────────────
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function qtyRangeDates(range) {
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  if (range === 'today') {
    const t = fmt(now); return { from: t, to: t };
  }
  if (range === 'week') {
    const mon = new Date(now);
    const dow = now.getDay() === 0 ? 6 : now.getDay() - 1;
    mon.setDate(now.getDate() - dow);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { from: fmt(mon), to: fmt(sun) };
  }
  if (range === 'month') {
    return { from: `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`, to: fmt(now) };
  }
  if (range === 'prevmonth') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last  = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: fmt(first), to: fmt(last) };
  }
  if (range === 'year') {
    return { from: `${now.getFullYear()}-01-01`, to: fmt(now) };
  }
  return { from: null, to: null };
}

// ── Reporte de cantidades (vendidas / entregadas) ─────────────────────────────
const QTY_CFG = {
  sold:      { fromId: 'sold-from',  toId: 'sold-to',  tbodyId: 'sold-tbody',  tfootId: 'sold-tfoot',  emptyId: 'no-sold'  },
  delivered: { fromId: 'deliv-from', toId: 'deliv-to', tbodyId: 'deliv-tbody', tfootId: 'deliv-tfoot', emptyId: 'no-deliv' }
};

async function loadQtyReport(mode, from, to) {
  const cfg = QTY_CFG[mode];
  if (!cfg) return;
  const resolvedFrom = from !== undefined ? from : $(`${cfg.fromId}`).value || null;
  const resolvedTo   = to   !== undefined ? to   : $(`${cfg.toId}`).value   || null;
  try {
    const params = new URLSearchParams({ mode });
    if (resolvedFrom) params.set('from', resolvedFrom);
    if (resolvedTo)   params.set('to',   resolvedTo);
    const d = await api('GET', '/reports/units?' + params.toString());
    const tbody = $(cfg.tbodyId);
    const tfoot = $(cfg.tfootId);
    if (!d.products.length) {
      tbody.innerHTML = '';
      tfoot.innerHTML = '';
      $(cfg.emptyId).classList.remove('hidden');
      return;
    }
    $(cfg.emptyId).classList.add('hidden');
    tbody.innerHTML = d.products.map((p, i) => `
      <tr>
        <td style="color:var(--text-muted);font-weight:600">${i + 1}</td>
        <td>${esc(p.product_name)}</td>
        <td class="text-right" style="font-weight:600">${fmtUnits(p.total_qty)}</td>
        <td class="text-right" style="color:var(--text-muted)">${p.pct.toFixed(1)}%</td>
        <td class="text-right">${p.order_count}</td>
      </tr>`).join('');
    const tot = d.total_units;
    tfoot.innerHTML = `<tr style="font-weight:700;border-top:2px solid var(--border)">
      <td colspan="2" class="text-right" style="padding:8px 10px">Total</td>
      <td class="text-right" style="padding:8px 10px">${fmtUnits(tot)}</td>
      <td class="text-right" style="padding:8px 10px">100%</td>
      <td class="text-right" style="padding:8px 10px">${d.products.reduce((s,p)=>s+p.order_count,0)}</td>
    </tr>`;
  } catch (err) { console.error('Error cantidades:', err.message); }
}

function initQtyReport(mode) {
  const cfg = QTY_CFG[mode];
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const monthFrom = `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`;
  const today     = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  $(cfg.fromId).value = monthFrom;
  $(cfg.toId).value   = today;
  loadQtyReport(mode, monthFrom, today);
}

// Quick-range buttons (both sections, data-mode + data-range attrs)
document.querySelectorAll('.qty-quick').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode  = btn.dataset.mode;
    const range = btn.dataset.range;
    const cfg   = QTY_CFG[mode];
    const { from, to } = qtyRangeDates(range);
    if (from) $(cfg.fromId).value = from;
    if (to)   $(cfg.toId).value   = to;
    loadQtyReport(mode, from, to);
    // highlight active quick button within this section
    btn.closest('div').querySelectorAll('.qty-quick').forEach(b => b.classList.remove('btn-primary'));
    btn.classList.add('btn-primary');
  });
});

$('btn-sold-apply').addEventListener('click', () => loadQtyReport('sold'));
$('btn-deliv-apply').addEventListener('click', () => loadQtyReport('delivered'));

$('btn-sold-excel').addEventListener('click', () => {
  const p = new URLSearchParams({ mode: 'sold' });
  if ($('sold-from').value) p.set('from', $('sold-from').value);
  if ($('sold-to').value)   p.set('to',   $('sold-to').value);
  window.location.href = '/api/reports/units/excel?' + p.toString();
});
$('btn-sold-pdf').addEventListener('click', () => {
  const p = new URLSearchParams({ mode: 'sold' });
  if ($('sold-from').value) p.set('from', $('sold-from').value);
  if ($('sold-to').value)   p.set('to',   $('sold-to').value);
  window.open('/api/reports/units/print?' + p.toString(), '_blank');
});
$('btn-deliv-excel').addEventListener('click', () => {
  const p = new URLSearchParams({ mode: 'delivered' });
  if ($('deliv-from').value) p.set('from', $('deliv-from').value);
  if ($('deliv-to').value)   p.set('to',   $('deliv-to').value);
  window.location.href = '/api/reports/units/excel?' + p.toString();
});
$('btn-deliv-pdf').addEventListener('click', () => {
  const p = new URLSearchParams({ mode: 'delivered' });
  if ($('deliv-from').value) p.set('from', $('deliv-from').value);
  if ($('deliv-to').value)   p.set('to',   $('deliv-to').value);
  window.open('/api/reports/units/print?' + p.toString(), '_blank');
});

// ── Reportes de Compras de Materia Prima ──────────────────────────────────────
async function loadPurchasesReport(from, to) {
  try {
    let url = '/reports/purchases';
    const params = [];
    if (from) params.push(`from=${from}`);
    if (to)   params.push(`to=${to}`);
    if (params.length) url += '?' + params.join('&');

    const d = await api('GET', url);

    // Cards
    $('rpt-pur-count').textContent     = d.count;
    $('rpt-pur-total').textContent     = fmtMoney(d.total);
    $('rpt-pur-suppliers').textContent = d.supplierCount;
    $('rpt-pur-products').textContent  = d.productCount;

    // Tabla comprobantes
    if (d.purchases.length) {
      $('rpt-pur-tbody').innerHTML = d.purchases.map(p => `
        <tr>
          <td><a href="#" onclick="openPurchaseDetail(${p.id});showComprasTab('comprobantes');return false;" style="font-weight:600">${esc(p.purchase_number)}</a></td>
          <td>${esc(p.supplier_name)}</td>
          <td>${esc(p.doc_type)}</td>
          <td>${esc(p.doc_number || '—')}</td>
          <td>${fmtDate(p.doc_date || p.created_at)}</td>
          <td class="text-right">${fmtMoney(p.total)}</td>
        </tr>`).join('');
      $('rpt-pur-empty').classList.add('hidden');
    } else {
      $('rpt-pur-tbody').innerHTML = '';
      $('rpt-pur-empty').classList.remove('hidden');
    }

    // Por proveedor
    if (d.bySupplier.length) {
      $('rpt-pur-by-supplier-tbody').innerHTML = d.bySupplier.map((s, i) => `
        <tr>
          <td>${esc(s.supplier_name)}</td>
          <td class="text-right">${s.qty}</td>
          <td class="text-right">${fmtMoney(s.total)}</td>
        </tr>`).join('');
      $('rpt-pur-by-supplier-empty').classList.add('hidden');
    } else {
      $('rpt-pur-by-supplier-tbody').innerHTML = '';
      $('rpt-pur-by-supplier-empty').classList.remove('hidden');
    }

    // Por producto
    if (d.byProduct.length) {
      $('rpt-pur-by-product-tbody').innerHTML = d.byProduct.map(p => `
        <tr>
          <td>${esc(p.product_name)}</td>
          <td class="text-right">${p.total_qty % 1 === 0 ? p.total_qty : p.total_qty.toFixed(2)}</td>
          <td class="text-right">${fmtMoney(p.total_amount)}</td>
        </tr>`).join('');
      $('rpt-pur-by-product-empty').classList.add('hidden');
    } else {
      $('rpt-pur-by-product-tbody').innerHTML = '';
      $('rpt-pur-by-product-empty').classList.remove('hidden');
    }
  } catch (err) { console.error('Error reporte compras:', err.message); }
}

// Inicializar fechas del reporte de compras (mes actual)
{
  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,'0');
  const from = `${y}-${m}-01`;
  const to   = new Date(y, now.getMonth()+1, 0).toISOString().slice(0,10);
  if ($('rpt-pur-from')) $('rpt-pur-from').value = from;
  if ($('rpt-pur-to'))   $('rpt-pur-to').value   = to;
}

$('btn-rpt-pur-filter').addEventListener('click', () => {
  loadPurchasesReport($('rpt-pur-from').value, $('rpt-pur-to').value);
});
$('btn-rpt-pur-reset').addEventListener('click', () => {
  $('rpt-pur-from').value = '';
  $('rpt-pur-to').value = '';
  loadPurchasesReport();
});
$('btn-rpt-pur-excel').addEventListener('click', () => {
  const from = $('rpt-pur-from').value;
  const to   = $('rpt-pur-to').value;
  const params = [];
  if (from) params.push(`from=${from}`);
  if (to)   params.push(`to=${to}`);
  window.location.href = '/api/reports/purchases/excel' + (params.length ? '?' + params.join('&') : '');
});

/* ================================================================ CUSTOMERS */
function showClientsSubview(view) {
  $('clients-list-view').classList.toggle('hidden', view !== 'list');
  $('clients-form-view').classList.toggle('hidden', view !== 'form');
  $('clients-account-view').classList.toggle('hidden', view !== 'account');
}

let _allClients = [];

async function loadClients() {
  try {
    _allClients = await api('GET', '/customers');
    const q = ($('client-search') || {}).value || '';
    renderClients(_allClients, q);
  } catch (err) { toast(err.message, 'error'); }
}

function renderClients(clients, searchQuery) {
  const tbody = $('clients-tbody');
  const noEl  = $('no-clients');
  const noMsg = $('no-clients-msg');

  const q = (searchQuery || '').toLowerCase().trim();
  const filtered = q
    ? clients.filter(c => [c.name, c.cuit, c.localidad, c.provincia, c.email, c.phone]
        .some(v => v && v.toLowerCase().includes(q)))
    : clients;

  $('clients-count').textContent = `${filtered.length} cliente${filtered.length !== 1 ? 's' : ''}`;

  if (!filtered.length) {
    tbody.innerHTML = '';
    if (noMsg) noMsg.textContent = q ? 'No se encontraron clientes' : 'No hay clientes cargados todavía';
    noEl.classList.remove('hidden');
    return;
  }
  noEl.classList.add('hidden');

  tbody.innerHTML = filtered.map(c => {
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
      <td style="color:var(--text-muted);font-size:.85rem">${esc([c.localidad, c.provincia].filter(Boolean).join(', ') || '—')}</td>
      <td class="text-right">${balFmt}</td>
      <td class="text-center" style="white-space:nowrap;position:sticky;right:0;background:var(--white);box-shadow:-2px 0 4px rgba(0,0,0,0.06)">
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

$('btn-clients-export-pdf').addEventListener('click', () => {
  if (!_allClients.length) { toast('No hay clientes para exportar', 'error'); return; }
  const fecha = new Date().toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
  const rows = _allClients.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${esc(formatCuit(c.cuit)||'')}</td>
      <td>${esc(c.phone||'')}</td>
      <td>${esc(c.email||'')}</td>
      <td>${esc(c.address||'')}</td>
      <td>${esc(c.localidad||'')}</td>
      <td>${esc(c.provincia||'')}</td>
      <td>${esc(c.vendor_name||'')}</td>
    </tr>`).join('');
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <title>Clientes</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:11px;margin:20px}
      h1{font-size:16px;margin:0 0 4px}
      .sub{font-size:11px;color:#666;margin-bottom:14px}
      table{width:100%;border-collapse:collapse}
      th{background:#1e293b;color:#fff;padding:6px 8px;text-align:left;font-size:10px}
      td{padding:5px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top}
      tr:nth-child(even) td{background:#f8fafc}
      tfoot td{font-weight:600;background:#f1f5f9;border-top:2px solid #cbd5e1}
      @media print{body{margin:10mm}}
    </style>
  </head><body>
    <h1>Lista de Clientes</h1>
    <div class="sub">Exportado el ${fecha}</div>
    <table>
      <thead><tr><th>Nombre</th><th>CUIT</th><th>Teléfono</th><th>Email</th><th>Dirección</th><th>Localidad</th><th>Provincia</th><th>Vendedor</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="8">Total: ${_allClients.length} cliente${_allClients.length!==1?'s':''}</td></tr></tfoot>
    </table>
    <script>window.onload=()=>window.print()<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
});

$('btn-clients-export-excel').addEventListener('click', () => {
  if (!_allClients.length) { toast('No hay clientes para exportar', 'error'); return; }
  const headers = ['Nombre','CUIT','Teléfono','Email','Dirección','Localidad','Provincia','Vendedor'];
  const data = [headers, ..._allClients.map(c => [
    c.name, formatCuit(c.cuit)||'', c.phone||'', c.email||'', c.address||'', c.localidad||'', c.provincia||'', c.vendor_name||''
  ])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [30,16,14,28,30,20,16,18].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Clientes');
  const fecha = new Date().toISOString().slice(0,10).replace(/-/g,'');
  XLSX.writeFile(wb, `clientes_${fecha}.xlsx`);
});

$('btn-new-client').addEventListener('click', () => openClientForm(null));
$('btn-clients-back').addEventListener('click', () => { showClientsSubview('list'); loadClients(); });
$('btn-client-cancel').addEventListener('click', () => { showClientsSubview('list'); loadClients(); });

if ($('client-search')) {
  $('client-search').addEventListener('input', e => renderClients(_allClients, e.target.value));
}

window.openClientForm = function(id) {
  state.editingClientId = id || null;
  $('client-form-title').textContent = id ? 'Editar Cliente' : 'Nuevo Cliente';
  $('inp-client-name').value       = '';
  $('inp-client-cuit').value       = '';
  $('inp-client-phone').value      = '';
  $('inp-client-email').value      = '';
  $('inp-client-address').value    = '';
  $('inp-client-localidad').value  = '';
  $('inp-client-provincia').value  = '';
  $('inp-client-notes').value      = '';
  $('inp-client-iva').value        = 'Consumidor Final';
  if ($('inp-client-vendor')) $('inp-client-vendor').value = '';

  if (isAdmin()) {
    api('GET', '/users').then(users => {
      const sel = $('inp-client-vendor');
      if (!sel) return;
      sel.innerHTML = '<option value="">— Seleccioná un vendedor —</option>' +
        users.filter(u => u.active)
             .map(u => `<option value="${u.id}">${esc(u.full_name || u.username)}</option>`)
             .join('');
      if (id) {
        api('GET', '/customers').then(list => {
          const c = list.find(x => x.id === id);
          if (c) {
            $('inp-client-name').value      = c.name;
            $('inp-client-cuit').value      = formatCuit(c.cuit);
            $('inp-client-phone').value     = c.phone || '';
            $('inp-client-email').value     = c.email || '';
            $('inp-client-address').value   = c.address || '';
            $('inp-client-localidad').value = c.localidad || '';
            $('inp-client-provincia').value = c.provincia || '';
            $('inp-client-notes').value     = c.notes || '';
            $('inp-client-iva').value       = c.iva_condition || 'Consumidor Final';
            sel.value = c.vendor_id || '';
          }
        });
      }
    });
  } else if (id) {
    api('GET', '/customers').then(list => {
      const c = list.find(x => x.id === id);
      if (c) {
        $('inp-client-name').value      = c.name;
        $('inp-client-cuit').value      = formatCuit(c.cuit);
        $('inp-client-phone').value     = c.phone || '';
        $('inp-client-email').value     = c.email || '';
        $('inp-client-address').value   = c.address || '';
        $('inp-client-localidad').value = c.localidad || '';
        $('inp-client-provincia').value = c.provincia || '';
        $('inp-client-notes').value     = c.notes || '';
        $('inp-client-iva').value       = c.iva_condition || 'Consumidor Final';
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

$('btn-composicion-saldos').addEventListener('click', () => {
  if (!_accountCustomerId) return;
  const a = document.createElement('a');
  a.href = `/api/customers/${_accountCustomerId}/composicion-saldos`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

async function loadAccount() {
  if (!_accountCustomerId) return;
  try {
    const data = await api('GET', `/customers/${_accountCustomerId}/account`);
    $('account-client-name').textContent = data.customer.name;
    $('account-client-iva').textContent  = data.customer.iva_condition || 'Consumidor Final';
    const loc = [data.customer.localidad, data.customer.provincia].filter(Boolean).join(', ');
    $('account-client-location').textContent = loc || '';

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
          <td class="text-center">
            <a href="/api/payments/${p.id}/recibo" target="_blank" class="btn-icon" title="Recibo PDF">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </a>
          </td>
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

function paymentAllocTotal() {
  let t = 0;
  document.querySelectorAll('.payment-alloc-row').forEach(row => {
    if (row.querySelector('.payment-alloc-chk').checked)
      t += parseFloat(row.querySelector('.payment-alloc-amt').value) || 0;
  });
  return Math.round(t * 100) / 100;
}
function updatePaymentAllocTotal() {
  const t = paymentAllocTotal();
  $('payment-alloc-total').textContent = fmtMoney(t);
  if (t > 0 && !$('inp-payment-amount').dataset.manual)
    $('inp-payment-amount').value = t.toFixed(2);
}

$('inp-payment-amount').addEventListener('input', () => {
  $('inp-payment-amount').dataset.manual = '1';
});

$('btn-new-payment').addEventListener('click', async () => {
  $('inp-payment-method').value    = 'efectivo';
  $('inp-payment-amount').value    = '';
  delete $('inp-payment-amount').dataset.manual;
  $('inp-payment-date').value      = new Date().toISOString().slice(0,10);
  $('inp-payment-reference').value = '';
  $('inp-payment-notes').value     = '';
  $('inp-payment-cheque-bank').value    = '';
  $('inp-payment-cheque-number').value  = '';
  $('inp-payment-cheque-due').value     = '';
  $('inp-payment-cuit-librador').value  = '';
  updatePaymentFields();
  await populateBankSelect($('inp-payment-bank-account'));

  // Cargar remitos pendientes
  const remitosSection = $('payment-remitos-section');
  if (_accountCustomerId) {
    try {
      const pending = await api('GET', `/customers/${_accountCustomerId}/pending-remitos`);
      if (pending.length) {
        $('payment-remitos-list').innerHTML = `
          <table style="width:100%;border-collapse:collapse;font-size:.82rem">
            <thead>
              <tr style="background:var(--bg-secondary);position:sticky;top:0">
                <th style="padding:6px 8px;text-align:center;width:32px"></th>
                <th style="padding:6px 8px;text-align:left">Remito</th>
                <th style="padding:6px 8px;text-align:left">Pedido / Fecha</th>
                <th style="padding:6px 8px;text-align:right">Saldo</th>
                <th style="padding:6px 8px;text-align:right;width:120px">Asignar ($)</th>
              </tr>
            </thead>
            <tbody>
              ${pending.map(r => `
                <tr class="payment-alloc-row" data-id="${r.id}" data-balance="${r.balance}">
                  <td style="padding:5px 8px;text-align:center">
                    <input type="checkbox" class="payment-alloc-chk">
                  </td>
                  <td style="padding:5px 8px;font-weight:600">${esc(r.remito_number)}</td>
                  <td style="padding:5px 8px;color:var(--text-muted)">${esc(r.order_number)}<br><small>${fmtDate(r.created_at)}</small></td>
                  <td style="padding:5px 8px;text-align:right">${fmtMoney(r.balance)}</td>
                  <td style="padding:5px 8px">
                    <input type="number" class="input payment-alloc-amt" value="${r.balance.toFixed(2)}"
                      min="0.01" max="${r.balance.toFixed(2)}" step="0.01"
                      style="width:100%;padding:3px 6px;font-size:.82rem" disabled>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>`;
        $('payment-alloc-total').textContent = fmtMoney(0);
        $('payment-remitos-list').querySelectorAll('.payment-alloc-row').forEach(row => {
          const chk = row.querySelector('.payment-alloc-chk');
          const amt = row.querySelector('.payment-alloc-amt');
          chk.addEventListener('change', () => { amt.disabled = !chk.checked; updatePaymentAllocTotal(); });
          amt.addEventListener('input', () => { delete $('inp-payment-amount').dataset.manual; updatePaymentAllocTotal(); });
        });
        remitosSection.classList.remove('hidden');
      } else {
        remitosSection.classList.add('hidden');
      }
    } catch(e) { remitosSection.classList.add('hidden'); }
  } else {
    remitosSection.classList.add('hidden');
  }

  $('payment-modal').classList.remove('hidden');
});
$('btn-payment-cancel').addEventListener('click', () => $('payment-modal').classList.add('hidden'));
$('payment-modal').addEventListener('click', e => { if (e.target === $('payment-modal')) $('payment-modal').classList.add('hidden'); });

$('btn-payment-confirm').addEventListener('click', async () => {
  const btn    = $('btn-payment-confirm');
  const method = $('inp-payment-method').value;
  btn.disabled = true;
  try {
    // Recoger asignaciones a remitos
    const allocations = [];
    document.querySelectorAll('.payment-alloc-row').forEach(row => {
      if (row.querySelector('.payment-alloc-chk').checked) {
        const amt = parseFloat(row.querySelector('.payment-alloc-amt').value);
        if (amt > 0) allocations.push({ remito_id: Number(row.dataset.id), amount: amt });
      }
    });

    const amount = parseFloat($('inp-payment-amount').value);
    if (!amount || amount <= 0) { toast('Ingresá un monto válido', 'error'); btn.disabled = false; return; }

    const payDate = $('inp-payment-date').value;
    if (!payDate) { toast('La fecha de cobro es obligatoria', 'error'); btn.disabled = false; return; }

    // Validar total asignado vs monto del pago
    if (allocations.length) {
      const allocTotal = allocations.reduce((s, a) => s + a.amount, 0);
      if (Math.abs(allocTotal - amount) > 0.02) {
        toast(`El total asignado (${fmtMoney(allocTotal)}) no coincide con el monto del pago (${fmtMoney(amount)})`, 'error');
        btn.disabled = false; return;
      }
    }

    const payload = {
      customer_id:  _accountCustomerId,
      amount,
      method,
      payment_date: payDate,
      notes:        $('inp-payment-notes').value.trim(),
      reference:    $('inp-payment-reference').value.trim(),
      allocations:  allocations.length ? allocations : undefined,
    };
    if (['transferencia','tarjeta'].includes(method)) {
      payload.bank_account_id = $('inp-payment-bank-account').value;
      if (!payload.bank_account_id) { toast('Seleccioná una cuenta bancaria', 'error'); btn.disabled = false; return; }
    }
    if (method === 'cheque') {
      payload.cheque_bank     = $('inp-payment-cheque-bank').value.trim();
      payload.cheque_number   = $('inp-payment-cheque-number').value.trim();
      payload.cheque_due_date = $('inp-payment-cheque-due').value;
      if (!payload.cheque_bank || !payload.cheque_number || !payload.cheque_due_date) {
        toast('Completá los datos del cheque', 'error'); btn.disabled = false; return;
      }
      const cuit = $('inp-payment-cuit-librador').value.trim();
      if (cuit) {
        const cuitClean = cuit.replace(/-/g, '');
        if (!/^\d{11}$/.test(cuitClean)) {
          toast('CUIT inválido — usá el formato XX-XXXXXXXX-X o 11 dígitos', 'error'); btn.disabled = false; return;
        }
        payload.cuit_librador = cuit;
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
  const isNew = !state.editingClientId;
  const name     = $('inp-client-name').value.trim();
  const phone    = $('inp-client-phone').value.trim();
  const email    = $('inp-client-email').value.trim();
  const address  = $('inp-client-address').value.trim();
  const localidad = $('inp-client-localidad').value.trim();
  const provincia = $('inp-client-provincia').value;
  const vendorVal = $('inp-client-vendor') ? $('inp-client-vendor').value : '';

  if (!name)     { toast('El nombre es requerido', 'error');     $('inp-client-name').focus();     return; }

  const rawCuit = $('inp-client-cuit').value.trim();
  const normalizedCuit = rawCuit.replace(/\D/g, '');
  if (isNew) {
    if (!normalizedCuit)            { toast('El CUIT es requerido', 'error');                                          $('inp-client-cuit').focus();     return; }
    if (normalizedCuit.length !== 11) { toast('El CUIT debe tener 11 dígitos (formato: XX-XXXXXXXX-X)', 'error');     $('inp-client-cuit').focus();     return; }
    if (!phone)    { toast('El teléfono es requerido', 'error');    $('inp-client-phone').focus();    return; }
    if (!email)    { toast('El email es requerido', 'error');        $('inp-client-email').focus();    return; }
    if (!address)  { toast('La dirección es requerida', 'error');    $('inp-client-address').focus();  return; }
    if (!localidad){ toast('La localidad es requerida', 'error');    $('inp-client-localidad').focus();return; }
    if (!provincia){ toast('La provincia es requerida', 'error');    $('inp-client-provincia').focus();return; }
    if (isAdmin() && !vendorVal) { toast('El vendedor es requerido', 'error'); $('inp-client-vendor').focus(); return; }
  } else if (rawCuit && normalizedCuit.length !== 11) {
    toast('El CUIT debe tener 11 dígitos (formato: XX-XXXXXXXX-X)', 'error'); $('inp-client-cuit').focus(); return;
  }

  const data = {
    name,
    cuit:          normalizedCuit || '',
    phone,
    email,
    address,
    localidad,
    provincia,
    notes:         $('inp-client-notes').value.trim(),
    iva_condition: $('inp-client-iva').value
  };
  if (isAdmin() && $('inp-client-vendor')) data.vendor_id = vendorVal ? Number(vendorVal) : null;
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
    const nuevos = result.imported || 0;
    const actualizados = result.updated || 0;
    const partes = [];
    if (nuevos > 0) partes.push(`${nuevos} nuevo${nuevos !== 1 ? 's' : ''}`);
    if (actualizados > 0) partes.push(`${actualizados} actualizado${actualizados !== 1 ? 's' : ''}`);
    toast(partes.length ? partes.join(', ') + ' correctamente' : 'Sin cambios', 'success');
    if (result.errors && result.errors.length) console.warn('Errores de importación:', result.errors);
    await loadProductCatalog();
    loadCatalog();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── Limpiar duplicados ──

$('btn-dedup-products').addEventListener('click', async () => {
  $('dedup-loading').classList.remove('hidden');
  $('dedup-none').classList.add('hidden');
  $('dedup-found').classList.add('hidden');
  $('btn-dedup-confirm').classList.add('hidden');
  $('dedup-products-modal').classList.remove('hidden');
  try {
    const groups = await api('GET', '/products/duplicates');
    $('dedup-loading').classList.add('hidden');
    if (!groups.length) {
      $('dedup-none').classList.remove('hidden');
    } else {
      const totalRemove = groups.reduce((s, g) => s + g.qty - 1, 0);
      $('dedup-tbody').innerHTML = groups.map(g => `
        <tr>
          <td>${esc(g.name)}</td>
          <td class="text-right" style="color:var(--success)">${fmtMoney(g.min_price)}</td>
          <td class="text-right" style="color:var(--danger)">${fmtMoney(g.max_price)}</td>
          <td class="text-center">${g.qty}</td>
        </tr>
      `).join('');
      $('dedup-summary').textContent = `Se eliminarán ${totalRemove} producto${totalRemove !== 1 ? 's' : ''} duplicado${totalRemove !== 1 ? 's' : ''} (en ${groups.length} grupo${groups.length !== 1 ? 's' : ''}).`;
      $('dedup-found').classList.remove('hidden');
      $('btn-dedup-confirm').classList.remove('hidden');
    }
  } catch (err) {
    $('dedup-loading').classList.add('hidden');
    toast(err.message, 'error');
    $('dedup-products-modal').classList.add('hidden');
  }
});

$('btn-dedup-cancel').addEventListener('click', () => $('dedup-products-modal').classList.add('hidden'));
$('dedup-products-modal').addEventListener('click', e => {
  if (e.target === $('dedup-products-modal')) $('dedup-products-modal').classList.add('hidden');
});

$('btn-dedup-confirm').addEventListener('click', async () => {
  const btn = $('btn-dedup-confirm');
  btn.disabled = true;
  try {
    const result = await api('POST', '/products/deduplicate');
    $('dedup-products-modal').classList.add('hidden');
    toast(`${result.removed} duplicado${result.removed !== 1 ? 's' : ''} eliminado${result.removed !== 1 ? 's' : ''} correctamente`, 'success');
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
    ['nombre', 'cuit', 'telefono', 'email', 'direccion', 'localidad', 'provincia', 'vendedor'],
    ['Juan García', '20-12345678-9', '11 1234-5678', 'juan@ejemplo.com', 'Av. Corrientes 1234', 'Buenos Aires', 'Buenos Aires', 'María Vendedora']
  ]);
  ws['!cols'] = [{ wch: 32 }, { wch: 16 }, { wch: 16 }, { wch: 28 }, { wch: 28 }, { wch: 18 }, { wch: 16 }, { wch: 22 }];
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

  let totalStock = 0, totalPending = 0, totalDiff = 0;
  tbody.innerHTML = products.map(p => {
    totalStock   += p.stock;
    totalPending += p.pending_orders;
    totalDiff    += p.difference;
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
        <button class="btn-icon" onclick="openStockEditModal(${p.id},'${esc(p.name)}',${p.stock},${p.pending_extra||0})" title="Editar artículo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');

  const tfoot = $('stock-tfoot');
  if (tfoot) {
    const diffColor = totalDiff < 0 ? 'var(--error)' : 'var(--success)';
    tfoot.innerHTML = `<tr style="border-top:2px solid var(--border);font-weight:700;background:var(--surface)">
      <td style="padding:10px 12px">TOTAL</td>
      <td class="text-center">${totalStock}</td>
      <td class="text-center">${totalPending}</td>
      <td class="text-center" style="color:${diffColor}">${totalDiff >= 0 ? '+' : ''}${totalDiff}</td>
      <td colspan="2"></td>
    </tr>`;
  }
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

// ── Edit modal (tabs: ajuste / ingreso / pedidos extra) ───────────────────────
let _stockEditId = null;
let _stockEditTab = 'ajuste';

function stockEditSwitchTab(tab) {
  _stockEditTab = tab;
  ['ajuste','ingreso','pedidos'].forEach(t => {
    $(`stock-edit-tab-${t}`).classList.toggle('hidden', t !== tab);
  });
  document.querySelectorAll('.stock-edit-tab').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.style.borderBottomColor = active ? 'var(--primary)' : 'transparent';
    btn.style.color = active ? 'var(--primary)' : 'var(--text-muted)';
    btn.style.fontWeight = active ? '600' : '500';
  });
  setTimeout(() => {
    if (tab === 'ajuste')   { $('inp-stock-edit-qty').focus(); $('inp-stock-edit-qty').select(); }
    if (tab === 'ingreso')  { $('inp-stock-edit-ingreso-qty').focus(); }
    if (tab === 'pedidos')  { $('inp-stock-edit-pending-extra').focus(); $('inp-stock-edit-pending-extra').select(); }
  }, 50);
}

document.querySelectorAll('.stock-edit-tab').forEach(btn => {
  btn.addEventListener('click', () => stockEditSwitchTab(btn.dataset.tab));
});

window.openStockEditModal = function(id, name, currentStock, pendingExtra) {
  _stockEditId = id;
  $('stock-edit-product-name').textContent = name;
  $('stock-edit-prev').textContent = `Stock actual: ${currentStock}`;
  $('inp-stock-edit-qty').value  = currentStock;
  $('inp-stock-edit-note').value = '';
  $('inp-stock-edit-ingreso-qty').value  = '';
  $('inp-stock-edit-ingreso-note').value = '';
  $('inp-stock-edit-pending-extra').value = pendingExtra ?? 0;
  $('stock-edit-modal').classList.remove('hidden');
  stockEditSwitchTab('ajuste');
};

$('btn-stock-edit-cancel').addEventListener('click', () => $('stock-edit-modal').classList.add('hidden'));
$('stock-edit-modal').addEventListener('click', e => { if (e.target === $('stock-edit-modal')) $('stock-edit-modal').classList.add('hidden'); });

$('btn-stock-edit-save').addEventListener('click', async () => {
  if (!_stockEditId) return;
  const btn = $('btn-stock-edit-save');
  btn.disabled = true;
  try {
    if (_stockEditTab === 'ajuste') {
      const quantity = parseFloat($('inp-stock-edit-qty').value);
      const note     = $('inp-stock-edit-note').value.trim();
      if (isNaN(quantity)) { toast('Ingresá una cantidad válida', 'error'); return; }
      await api('PUT', `/stock/${_stockEditId}`, { quantity, note });
      toast('Stock actualizado', 'success');
    } else if (_stockEditTab === 'ingreso') {
      const quantity = parseFloat($('inp-stock-edit-ingreso-qty').value);
      const notes    = $('inp-stock-edit-ingreso-note').value.trim();
      if (!quantity || quantity <= 0) { toast('Ingresá una cantidad mayor a 0', 'error'); return; }
      await api('POST', '/stock/ingresos', { product_id: _stockEditId, quantity, notes });
      toast('Ingreso registrado', 'success');
    } else if (_stockEditTab === 'pedidos') {
      const pending_extra = parseInt($('inp-stock-edit-pending-extra').value, 10);
      if (isNaN(pending_extra) || pending_extra < 0) { toast('Ingresá un valor válido (≥ 0)', 'error'); return; }
      await api('PUT', `/stock/${_stockEditId}/pending-extra`, { pending_extra });
      toast('Pedidos extra actualizados', 'success');
    }
    $('stock-edit-modal').classList.add('hidden');
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

let _suppliersData = [];

async function loadSuppliers() {
  try {
    const rows = await api('GET', '/suppliers');
    _suppliersData = rows;
    $('suppliers-tbody').innerHTML = rows.length ? rows.map(s => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${esc(s.cuit || '—')}</td>
        <td>${esc(s.iva_condition)}</td>
        <td>${esc(s.phone || '—')}</td>
        <td>${esc(s.celular || '—')}</td>
        <td class="text-right" style="font-weight:600;color:${s.balance > 0 ? 'var(--error)' : 'var(--success)'}">${fmtMoney(s.balance)}</td>
        <td class="text-center">
          <button class="btn btn-ghost btn-sm" onclick="openSupplierAccount(${s.id})">Cuenta</button>
          <button class="btn btn-ghost btn-sm" onclick="openSupplierForm(${s.id})">Editar</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deleteSupplier(${s.id},'${esc(s.name)}')">Eliminar</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">Sin proveedores</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

$('btn-new-supplier').addEventListener('click', () => openSupplierForm(null));
$('btn-back-suppliers').addEventListener('click', () => { showProveedoresSubview('list'); loadSuppliers(); });
$('btn-sup-form-cancel').addEventListener('click', () => showProveedoresSubview('list'));

window.openSupplierForm = async function(id) {
  editingSupplierId = id;
  $('supplier-form-title').textContent = id ? 'Editar Proveedor' : 'Nuevo Proveedor';
  $('supplier-form').reset();
  showProveedoresSubview('form');
  const mpCbs = $('sup-mp-users-checkboxes');
  mpCbs.innerHTML = '<span style="color:var(--text-muted);font-size:.88rem">Cargando...</span>';
  try {
    const [allUsers, supplier] = await Promise.all([
      api('GET', '/users'),
      id ? api('GET', `/suppliers/${id}`) : Promise.resolve({ mp_user_ids: [] })
    ]);
    if (id && supplier) {
      $('inp-sup-name').value    = supplier.name;
      $('inp-sup-cuit').value    = supplier.cuit || '';
      $('inp-sup-iva').value     = supplier.iva_condition;
      $('inp-sup-phone').value   = supplier.phone || '';
      $('inp-sup-celular').value = supplier.celular || '';
      $('inp-sup-email').value   = supplier.email || '';
      $('inp-sup-address').value = supplier.address || '';
      $('inp-sup-notes').value   = supplier.notes || '';
    }
    const mpUsers = allUsers.filter(u => u.role === 'mp' && u.active);
    const assigned = new Set(supplier.mp_user_ids || []);
    mpCbs.innerHTML = mpUsers.length === 0
      ? '<span style="color:var(--text-muted);font-size:.88rem">No hay usuarios con rol MP registrados</span>'
      : mpUsers.map(u => `
          <label style="display:flex;gap:8px;align-items:center;cursor:pointer;font-size:.9rem">
            <input type="checkbox" class="sup-mp-user-cb" value="${u.id}" ${assigned.has(u.id) ? 'checked' : ''}>
            ${esc(u.full_name || u.username)}
          </label>`).join('');
  } catch (err) { toast(err.message, 'error'); }
};

$('supplier-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('btn-sup-form-save');
  btn.disabled = true;
  try {
    const mp_user_ids = [...document.querySelectorAll('.sup-mp-user-cb:checked')].map(cb => Number(cb.value));
    const data = {
      name: $('inp-sup-name').value.trim(),
      cuit: $('inp-sup-cuit').value.trim(),
      iva_condition: $('inp-sup-iva').value,
      phone:   $('inp-sup-phone').value.trim(),
      celular: $('inp-sup-celular').value.trim(),
      email:   $('inp-sup-email').value.trim(),
      address: $('inp-sup-address').value.trim(),
      notes: $('inp-sup-notes').value.trim(),
      mp_user_ids
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

$('btn-sup-export-pdf').addEventListener('click', () => {
  if (!_suppliersData.length) { toast('No hay proveedores para exportar', 'error'); return; }
  const fecha = new Date().toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
  const rows = _suppliersData.map(s => `
    <tr>
      <td>${esc(s.name)}</td>
      <td>${esc(s.cuit||'')}</td>
      <td>${esc(s.phone||'')}</td>
      <td>${esc(s.celular||'')}</td>
      <td>${esc(s.email||'')}</td>
      <td>${esc(s.address||'')}</td>
      <td>${esc(s.notes||'')}</td>
    </tr>`).join('');
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <title>Proveedores</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:11px;margin:20px}
      h1{font-size:16px;margin:0 0 4px}
      .sub{font-size:11px;color:#666;margin-bottom:14px}
      table{width:100%;border-collapse:collapse}
      th{background:#1e293b;color:#fff;padding:6px 8px;text-align:left;font-size:10px}
      td{padding:5px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top}
      tr:nth-child(even) td{background:#f8fafc}
      @media print{body{margin:10mm}}
    </style>
  </head><body>
    <h1>Lista de Proveedores</h1>
    <div class="sub">Exportado el ${fecha} &mdash; ${_suppliersData.length} proveedor${_suppliersData.length!==1?'es':''}</div>
    <table>
      <thead><tr><th>Nombre</th><th>CUIT</th><th>Teléfono</th><th>Celular</th><th>Email</th><th>Dirección</th><th>Notas</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <script>window.onload=()=>window.print()<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
});

$('btn-sup-export-excel').addEventListener('click', () => {
  if (!_suppliersData.length) { toast('No hay proveedores para exportar', 'error'); return; }
  const headers = ['Nombre','CUIT','Cond. IVA','Teléfono','Celular','Email','Dirección','Notas'];
  const data = [headers, ..._suppliersData.map(s => [
    s.name, s.cuit||'', s.iva_condition||'', s.phone||'', s.celular||'', s.email||'', s.address||'', s.notes||''
  ])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [40,18,22,16,16,28,32,30].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Proveedores');
  const fecha = new Date().toISOString().slice(0,10).replace(/-/g,'');
  XLSX.writeFile(wb, `proveedores_${fecha}.xlsx`);
});

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
        <td class="text-center"><a href="/api/supplier-payments/${p.id}/orden-pago" target="_blank" class="btn btn-ghost btn-sm">PDF</a></td>
        <td class="text-center"><button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deleteSupplierPayment(${p.id})">Eliminar</button></td>
      </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--text-muted)">Sin pagos</td></tr>';
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

// ── Supplier payment modal ────────────────────────────────────────────────────
let supPayFromAccount = false; // true cuando se abre desde cuenta corriente

function supPayAllocTotal() {
  let t = 0;
  document.querySelectorAll('.sup-pay-alloc-row').forEach(row => {
    if (row.querySelector('.sup-pay-chk').checked)
      t += parseFloat(row.querySelector('.sup-pay-alloc-amt').value) || 0;
  });
  return Math.round(t * 100) / 100;
}
function updateSupPayAllocTotal() {
  const t = supPayAllocTotal();
  $('sup-pay-alloc-total').textContent = fmtMoney(t);
  // Si hay asignaciones, auto-completar el monto total
  if (t > 0 && !$('inp-sup-pay-amount').dataset.manual)
    $('inp-sup-pay-amount').value = t.toFixed(2);
}

async function openSupPayModal(fromAccount) {
  supPayFromAccount = fromAccount;
  $('inp-sup-pay-amount').value = '';
  delete $('inp-sup-pay-amount').dataset.manual;
  $('inp-sup-pay-date').value   = new Date().toISOString().slice(0,10);
  $('inp-sup-pay-method').value = 'efectivo';
  $('inp-sup-pay-reference').value = '';
  $('inp-sup-pay-notes').value  = '';
  $('inp-sup-pay-cheque-bank').value   = '';
  $('inp-sup-pay-cheque-number').value = '';
  $('inp-sup-pay-cheque-due').value    = '';
  updateSupPayFields();
  await populateBankSelect($('inp-sup-pay-bank-account'));

  const allocSection = $('sup-pay-alloc-section');
  if (fromAccount && currentSupplierId) {
    try {
      const pending = await api('GET', `/suppliers/${currentSupplierId}/pending-purchases`);
      if (pending.length) {
        $('sup-pay-alloc-list').innerHTML = `
          <table style="width:100%;border-collapse:collapse;font-size:.82rem">
            <thead>
              <tr style="background:var(--bg-secondary);position:sticky;top:0">
                <th style="padding:6px 8px;text-align:center;width:32px"></th>
                <th style="padding:6px 8px;text-align:left">Comprobante</th>
                <th style="padding:6px 8px;text-align:left">Tipo / Nº Doc</th>
                <th style="padding:6px 8px;text-align:right">Saldo</th>
                <th style="padding:6px 8px;text-align:right;width:120px">Asignar ($)</th>
              </tr>
            </thead>
            <tbody>
              ${pending.map(p => `
                <tr class="sup-pay-alloc-row" data-id="${p.id}" data-balance="${p.balance}">
                  <td style="padding:5px 8px;text-align:center">
                    <input type="checkbox" class="sup-pay-chk">
                  </td>
                  <td style="padding:5px 8px;font-weight:600">${esc(p.purchase_number)}</td>
                  <td style="padding:5px 8px;color:var(--text-muted)">${esc(p.doc_type)}${p.doc_number ? ' ' + esc(p.doc_number) : ''}<br><small>${fmtDate(p.doc_date)}</small></td>
                  <td style="padding:5px 8px;text-align:right">${fmtMoney(p.balance)}</td>
                  <td style="padding:5px 8px">
                    <input type="number" class="input sup-pay-alloc-amt" value="${p.balance.toFixed(2)}" min="0.01" max="${p.balance.toFixed(2)}" step="0.01" style="width:100%;padding:3px 6px;font-size:.82rem" disabled>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>`;
        // Eventos de checkbox y monto
        $('sup-pay-alloc-list').querySelectorAll('.sup-pay-alloc-row').forEach(row => {
          const chk = row.querySelector('.sup-pay-chk');
          const amt = row.querySelector('.sup-pay-alloc-amt');
          chk.addEventListener('change', () => {
            amt.disabled = !chk.checked;
            updateSupPayAllocTotal();
          });
          amt.addEventListener('input', () => {
            delete $('inp-sup-pay-amount').dataset.manual;
            updateSupPayAllocTotal();
          });
        });
        $('sup-pay-alloc-total').textContent = fmtMoney(0);
        allocSection.classList.remove('hidden');
      } else {
        allocSection.classList.add('hidden');
      }
    } catch(e) { allocSection.classList.add('hidden'); }
  } else {
    allocSection.classList.add('hidden');
  }

  $('sup-payment-modal').classList.remove('hidden');
}

$('inp-sup-pay-amount').addEventListener('input', () => {
  $('inp-sup-pay-amount').dataset.manual = '1';
});

$('btn-new-sup-payment').addEventListener('click', () => openSupPayModal(true));
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
    // Recoger asignaciones a comprobantes (si las hay)
    const allocations = [];
    if (supPayFromAccount) {
      document.querySelectorAll('.sup-pay-alloc-row').forEach(row => {
        if (row.querySelector('.sup-pay-chk').checked) {
          const amt = parseFloat(row.querySelector('.sup-pay-alloc-amt').value);
          if (amt > 0) allocations.push({ purchase_id: Number(row.dataset.id), amount: amt });
        }
      });
    }

    const amount = parseFloat($('inp-sup-pay-amount').value);
    if (!amount || amount <= 0) { toast('Ingresá un monto válido', 'error'); btn.disabled = false; return; }

    // Validar que el total asignado no supere el monto
    if (allocations.length) {
      const allocTotal = allocations.reduce((s, a) => s + a.amount, 0);
      if (Math.abs(allocTotal - amount) > 0.02) {
        toast(`El total asignado (${fmtMoney(allocTotal)}) no coincide con el monto del pago (${fmtMoney(amount)})`, 'error');
        btn.disabled = false; return;
      }
    }

    const basePayload = {
      supplier_id:  currentSupplierId,
      method,
      amount,
      payment_date: $('inp-sup-pay-date').value || null,
      notes:        $('inp-sup-pay-notes').value.trim(),
      reference:    $('inp-sup-pay-reference').value.trim(),
    };
    if (method === 'transferencia') {
      basePayload.bank_account_id = $('inp-sup-pay-bank-account').value;
      if (!basePayload.bank_account_id) { toast('Seleccioná una cuenta bancaria', 'error'); btn.disabled = false; return; }
    }
    if (method === 'cheque') {
      basePayload.cheque_bank     = $('inp-sup-pay-cheque-bank').value.trim();
      basePayload.cheque_number   = $('inp-sup-pay-cheque-number').value.trim();
      basePayload.cheque_due_date = $('inp-sup-pay-cheque-due').value;
      if (!basePayload.cheque_bank || !basePayload.cheque_number || !basePayload.cheque_due_date) {
        toast('Completá los datos del cheque', 'error'); btn.disabled = false; return;
      }
    }

    if (allocations.length > 1) {
      // Batch: un pago por comprobante, un asiento total
      await api('POST', '/supplier-payments/batch', { ...basePayload, allocations });
    } else {
      // Pago único (con o sin comprobante)
      const payload = { ...basePayload, purchase_id: allocations[0]?.purchase_id || (currentPurchaseId || null) };
      await api('POST', '/supplier-payments', payload);
    }

    toast('Pago registrado', 'success');
    $('sup-payment-modal').classList.add('hidden');
    if (currentPurchaseId && !supPayFromAccount) {
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
    $('purchases-tbody').innerHTML = rows.length ? rows.map(p => {
      const mpBadge = p.origin === 'pedido_mp'
        ? `<span style="font-size:.68rem;background:#dbeafe;color:#1d4ed8;border-radius:4px;padding:1px 6px;font-weight:700;vertical-align:middle;white-space:nowrap">MP #${p.origin_id}</span>`
        : '';
      return `<tr>
        <td><a href="#" onclick="openPurchaseDetail(${p.id});return false;" style="font-weight:600">${esc(p.purchase_number)}</a></td>
        <td>${esc(p.supplier_name)} ${mpBadge}</td>
        <td>${esc(p.doc_type)}</td>
        <td>${esc(p.doc_number || '—')}</td>
        <td>${fmtDate(p.doc_date || p.created_at)}</td>
        <td class="text-right">${fmtMoney(p.total)}</td>
        <td class="text-center">
          <button class="btn btn-ghost btn-sm" onclick="openPurchaseDetail(${p.id})">Ver</button>
          <a href="/api/purchases/${p.id}/print" target="_blank" class="btn btn-ghost btn-sm">PDF</a>
          <button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="deletePurchase(${p.id},'${esc(p.purchase_number)}')">Eliminar</button>
        </td>
      </tr>`;
    }).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">Sin comprobantes</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

window.openPurchaseDetail = async function(id) {
  currentPurchaseId = id;
  try {
    const p = await api('GET', `/purchases/${id}`);
    $('pur-detail-title').textContent = p.purchase_number;
    $('pur-detail-subtitle').textContent = `${p.supplier_name} — ${p.doc_type}${p.doc_number ? ' ' + p.doc_number : ''} ${p.doc_date ? '| ' + fmtDate(p.doc_date) : ''}${p.iva_condition ? ' | ' + p.iva_condition : ''}`;
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

  // Botón Orden de pago PDF: visible solo cuando hay pagos
  const opBtn = $('btn-orden-pago-pdf');
  if (payments.length) {
    opBtn.href = `/api/purchases/${p.id}/orden-pago`;
    opBtn.classList.remove('hidden');
  } else {
    opBtn.classList.add('hidden');
  }
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
  // Limpiar campos nuevos
  $('inp-pur-docprefix').value      = '';
  $('inp-pur-docseq').value         = '';
  $('inp-pur-iva-condition').value  = '';
  $('inp-pur-iva-pct').value        = '21';
  // populate supplier select con datos de condición IVA
  try {
    const suppliers = await api('GET', '/suppliers');
    $('inp-pur-supplier').innerHTML = '<option value="">— Seleccioná —</option>' +
      suppliers.map(s => `<option value="${s.id}" data-iva="${esc(s.iva_condition||'')}">${esc(s.name)}</option>`).join('');
  } catch(e) {}
  $('inp-pur-docdate').value = new Date().toISOString().slice(0,10);
  showComprobantesSubview('form');
});

// Auto-completar condición IVA al seleccionar proveedor
$('inp-pur-supplier').addEventListener('change', () => {
  const opt = $('inp-pur-supplier').selectedOptions[0];
  const iva = opt?.dataset?.iva || '';
  if (iva) $('inp-pur-iva-condition').value = iva;
});
$('btn-back-purchases').addEventListener('click', () => { showComprobantesSubview('list'); loadPurchases(); });
$('btn-pur-form-cancel').addEventListener('click', () => { showComprobantesSubview('list'); loadPurchases(); });
$('btn-back-purchase-detail').addEventListener('click', () => { currentPurchaseId = null; showComprobantesSubview('list'); loadPurchases(); });

// Eliminar desde el detalle del comprobante
$('btn-delete-purchase-detail').addEventListener('click', async () => {
  if (!currentPurchaseId) return;
  const title = $('pur-detail-title').textContent;
  if (!await confirm(`¿Eliminar comprobante ${title}? El stock ingresado se va a descontar.`)) return;
  try {
    await api('DELETE', `/purchases/${currentPurchaseId}`);
    toast('Comprobante eliminado', 'success');
    currentPurchaseId = null;
    showComprobantesSubview('list');
    loadPurchases();
  } catch (err) { toast(err.message, 'error'); }
});

$('btn-new-purchase-payment').addEventListener('click', async () => {
  if (!currentPurchaseId) return;
  try {
    const pur = await api('GET', `/purchases/${currentPurchaseId}`);
    currentSupplierId = pur.supplier_id;
    await openSupPayModal(false); // desde detalle de comprobante: sin selector
  } catch (err) { toast(err.message, 'error'); }
});

function renderPurchaseItems() {
  const c = $('purchase-items-container');
  if (!purchaseItems.length) { c.innerHTML = ''; updatePurchaseTotal(); return; }
  c.innerHTML = purchaseItems.map((it, i) => `
    <div class="purchase-item-row" data-i="${i}">
      <input type="text"   class="input pi-name"  value="${esc(it.name)}"  placeholder="Producto" style="flex:2">
      <input type="number" class="input pi-qty"   value="${it.qty === '' ? '' : it.qty}"   min="0.001" step="any" placeholder="Cant." style="width:90px">
      <input type="number" class="input pi-price" value="${it.price === '' ? '' : it.price}" min="0"     step="any" placeholder="Precio unit." style="width:120px">
      <span class="pi-subtotal" style="width:90px;text-align:right;font-size:.9rem;color:var(--text-muted)">$${((parseFloat(it.qty)||0)*(parseFloat(it.price)||0)).toFixed(2)}</span>
      <button type="button" class="btn btn-ghost btn-sm pi-remove" style="color:var(--error);padding:4px 8px">✕</button>
    </div>`).join('');
  // events
  c.querySelectorAll('.pi-name').forEach((el, i) => el.addEventListener('input', () => { purchaseItems[i].name = el.value; updatePurchaseTotal(); }));
  c.querySelectorAll('.pi-qty').forEach((el, i) => {
    el.addEventListener('focus', () => el.select());
    el.addEventListener('input', () => {
      purchaseItems[i].qty = el.value;
      el.closest('.purchase-item-row').querySelector('.pi-subtotal').textContent =
        '$' + ((parseFloat(el.value)||0) * (parseFloat(purchaseItems[i].price)||0)).toFixed(2);
      updatePurchaseTotal();
    });
  });
  c.querySelectorAll('.pi-price').forEach((el, i) => {
    el.addEventListener('focus', () => el.select());
    el.addEventListener('input', () => {
      purchaseItems[i].price = el.value;
      el.closest('.purchase-item-row').querySelector('.pi-subtotal').textContent =
        '$' + ((parseFloat(purchaseItems[i].qty)||0) * (parseFloat(el.value)||0)).toFixed(2);
      updatePurchaseTotal();
    });
  });
  c.querySelectorAll('.pi-remove').forEach((el, i) => el.addEventListener('click', () => { purchaseItems.splice(i,1); renderPurchaseItems(); }));
  updatePurchaseTotal();
}

function addPurchaseItemRow() {
  purchaseItems.push({ name:'', qty:'', price:'' });
  renderPurchaseItems();
}

function updatePurchaseTotal() {
  const sub    = purchaseItems.reduce((s, it) => s + (parseFloat(it.qty)||0)*(parseFloat(it.price)||0), 0);
  const ivaPct = parseFloat($('inp-pur-iva-pct')?.value) || 0;
  const ivaAmt = Math.round(sub * ivaPct / 100 * 100) / 100;
  const total  = Math.round((sub + ivaAmt) * 100) / 100;
  const fmt    = v => '$ ' + v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $('pur-display-subtotal').textContent = fmt(sub);
  $('pur-display-iva').textContent      = fmt(ivaAmt);
  $('pur-display-total').textContent    = fmt(total);
}

$('btn-add-purchase-item').addEventListener('click', addPurchaseItemRow);
$('inp-pur-iva-pct').addEventListener('change', updatePurchaseTotal);

$('purchase-form').addEventListener('submit', async e => {
  e.preventDefault();
  const supplier_id = $('inp-pur-supplier').value;
  if (!supplier_id) { toast('Seleccioná un proveedor', 'error'); return; }
  if (!purchaseItems.length || !purchaseItems.some(it => it.name.trim())) { toast('Agregá al menos un ítem', 'error'); return; }
  const btn = e.submitter;
  btn.disabled = true;
  try {
    // Construir doc_number desde prefijo + número
    const prefix = $('inp-pur-docprefix').value.trim();
    const seq    = $('inp-pur-docseq').value.trim();
    const doc_number = prefix && seq ? `${prefix}-${seq}` : (prefix || seq || '');

    await api('POST', '/purchases', {
      supplier_id,
      doc_type:      $('inp-pur-doctype').value,
      doc_number,
      doc_date:      $('inp-pur-docdate').value || null,
      notes:         $('inp-pur-notes').value.trim(),
      iva_condition: $('inp-pur-iva-condition').value || '',
      iva_percent:   parseFloat($('inp-pur-iva-pct').value) || 0,
      items: purchaseItems.filter(it => it.name.trim()).map(it => ({
        product_name: it.name.trim(),
        quantity:     parseFloat(it.qty)  || 0,
        unit_price:   parseFloat(it.price) || 0
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
        <td colspan="6" style="padding:10px 16px 14px 52px"><div id="jrn-detail-inner-${e.id}">Cargando…</div></td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted)">Sin asientos en el período</td></tr>';

    // Pagination
    const pages = Math.ceil(data.total / data.per_page);
    $('journal-pagination').innerHTML = pages <= 1 ? '' : `
      <button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="loadJournal(${page-1})">← Ant.</button>
      <span style="font-size:.85rem;color:var(--text-muted)">Pág. ${page} / ${pages} (${data.total} asientos)</span>
      <button class="btn btn-ghost btn-sm" ${page >= pages ? 'disabled' : ''} onclick="loadJournal(${page+1})">Sig. →</button>`;
  } catch (err) { toast(err.message, 'error'); }
}

window.closeJournalDetail = function(id) {
  const row = $(`jrn-detail-${id}`);
  row.classList.add('hidden');
  const prev = row.previousElementSibling;
  if (prev) { const b = prev.querySelector('button[title="Ver líneas"]'); if (b) b.textContent = '▸'; }
};

window.toggleJournalDetail = async function(id, btn) {
  const row = $(`jrn-detail-${id}`);
  const wasHidden = row.classList.contains('hidden');
  row.classList.toggle('hidden', !wasHidden);
  btn.textContent = wasHidden ? '▾' : '▸';
  if (!wasHidden) return;
  const inner = $(`jrn-detail-inner-${id}`);
  inner.textContent = 'Cargando…';
  try {
    const e = await api('GET', `/accounting/journal/${id}`);
    const refLabels = {
      manual: 'Manual', venta: 'Venta', cobro: 'Cobro', compra: 'Compra',
      pago: 'Pago', caja: 'Caja', banco: 'Banco', cheque: 'Cheque',
      reversal: 'Anulación', note_customer: 'Nota cliente', note_supplier: 'Nota proveedor'
    };
    const lines = e.lines || [];
    inner.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;flex-wrap:wrap;gap:8px">
        <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:.83rem">
          <span><b>Fecha:</b> ${fmtDate(e.date)}</span>
          <span><b>Descripción:</b> ${esc(e.description)}</span>
          <span><b>Tipo:</b> ${esc(refLabels[e.ref_type] || e.ref_type || '—')}</span>
          ${e.reference ? `<span><b>Ref.:</b> ${esc(e.reference)}</span>` : ''}
          <span><b>Estado:</b> ${e.is_reversed
            ? '<span class="badge badge-default">Anulado</span>'
            : '<span class="badge badge-success">Vigente</span>'}</span>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="closeJournalDetail(${id})">✕ Cerrar</button>
      </div>
      <table class="table" style="max-width:700px;margin:0">
        <thead><tr>
          <th style="width:110px">Código</th><th>Cuenta</th>
          <th>Descripción línea</th>
          <th class="text-right" style="width:120px">Debe</th>
          <th class="text-right" style="width:120px">Haber</th>
        </tr></thead>
        <tbody>${lines.map(l => `
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
          <td class="text-right">${fmtMoney(lines.reduce((s,l)=>s+(l.debit||0),0))}</td>
          <td class="text-right">${fmtMoney(lines.reduce((s,l)=>s+(l.credit||0),0))}</td>
        </tr></tfoot>
      </table>`;
  } catch(err) { $(`jrn-detail-inner-${id}`).textContent = 'Error al cargar detalle'; }
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
  try { amAccountsList = (await api('GET', '/accounting/accounts')).filter(a => a.accepts_movements); }
  catch(e) { toast('Error al cargar cuentas', 'error'); return; }
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

/* ================================================================ MÓDULO PEDIDOS MP */

function isFabrica()   { return state.user && state.user.role === 'mp'; }
function canAccessMP() { return isAdmin() || isFabrica(); }
function canAccessProd(){ return state.user && !isVendor(); }

const MP_SECTIONS = [
  { num: 1, name: 'C/Frnts', unidad: 'kg', items: [
    '28x1.5x2400 (108/104)',
    '1.25x118.5 (109 p/c ó 109 p/L)',
    '1.5x200x240 (100/111/120)',
    '1.25x89 (112)',
    '1.5x67x240 (113)',
    '1.25x140x5x240 (115/116)',
    '1.5x39x2400 (118/117/114)',
    '1.25x79.5 (119 emb)',
    '1.5x69 (119 corr/emb)',
    '1.5x79.5 (119 c/arr)',
    '1.25x25 (122/127/127 p/r /121 nuevo)',
    '1.25x32.5x2400 (124/125/126/901/902)',
    '1.57x27 (128)',
    '1.5x40 (117/117p/r)',
  ], campoLabel: 'CANTIDAD KG C/F' },
  { num: 2, name: 'Frentes', unidad: 'kg', items: [
    '(102/103/106/107) 3x28 Bronce',
    '(112 Bronce/112 CIVE) 2x98',
    '(100/104/108/111) 3x28x300=2',
    '(109 P/L / 109 P/C) 3x100',
    '(112) 2x110',
    '(113) 2x71x240=2.8',
    '(114) 2.5x25x3000=1.5',
    '(115/124/due/901) 2x25x3000=1.2',
    '(116/125/902) 2x20x3000=0.955',
    '(117/117 p/r /122/2000mp) 2.25x25x3000=1.4',
    '(118/128) 3x26.5x3000=1.895',
    '(119emb/ 119C/emb) 1.5x95.5x2.4=2.73',
    '(119 C/Arr) 1.5x51',
    '(120/123 y C/F123) 2.5x23.5x3000=1.35',
    '(121/127/127P) 2.5x20x3000=1.2',
  ], campoLabel: 'CANTIDAD KG Frnts' },
  { num: 3, name: 'Cremallera', unidad: 'kg', items: [
    '(108/111/114/112/117p/r) 2.45x59x3000=3.5',
    '(115/116/117/118/124/126/127p/R/100 2000mp) 2.45x55x3000=3.2',
    '(119todas/110) 2.45x36x3000=2.1 crem 119',
    '(120) 2.22x59x300=3.2',
    '(121/127) 2.45x46x3000=2.8',
    '(123) 2.50x133.5x3000',
    '(901/902) 2.95x30x3000=2.1',
    '(901/902 TRABA) 2.5x42x3000=2.72',
    '(2000mp TRABA) 2.45x64',
  ], campoLabel: 'CANTIDAD KG Cremallera' },
  { num: 4, name: 'Sup. Cremallera', unidad: 'kg', items: [
    '(120) 3x45x300=3.5',
    '(115x116) 3x42x3000=3.1',
    '(114) 1.89x53.5=2.45',
    '(121/127) 3x80x3000=6.05',
    '(DUE/126) 2.5x48x240=2.4',
    '(110) 2x53x240=2.65 Y LEVA',
    '(119) 1.25x41',
    '(110 Falleva) 2x88x240',
    '(124/125) 1.57x48',
    '(110 sup/Falleva) 2.5x53',
    '(2000mp GuíatornilloC) 2x22',
    '(118/128 PortaPerno) 2.5x70x2.240=3.4',
    '(111 porta perno) 2x62',
    '(117) 3x45',
  ], campoLabel: 'CANTIDAD KG Sup. Cremallera' },
  { num: 5, name: 'Cajas', unidad: 'kg', items: [
    '(100/102/103/111) 1.57x182',
    '(108/104/105/109p/C p/L 106/128) 96.5x1.57',
    '(110) 1.57x200',
    '(112/113) 1.25x94.5x2.4=2.5',
    '(114) 1.57x169.5=5.27',
    '(115/116) 1.57x150x2400=6.608',
    '(117/117p/R/2000mp) 1.57x167.5x240=5.1',
    '(118) 1.57x107.5',
    '(119 emb) 1.25x72.5',
    '(119 Arr) 1.25x93',
    '(119 1/2Emb) 1.25x71',
    '(120) 1.57x173 120 tapa',
    '(121) 1.25x54x2400',
    '(122) 98.5x1.57',
    '(124/125) 1.25x150',
    '(126) 1.25x167.5',
    '(127/127 p/R) 1.50x95',
    '(DUE BASE Y TAPA) 1.25x155',
    '(DUE CERROJO Base y Tapa) 98x1.25',
    '(123) 1.57x54x2400=1.64',
  ], campoLabel: 'CANTIDAD KG Cajas' },
  { num: 6, name: 'Tapas', unidad: 'kg', items: [
    '(104/108/109/128) 1.57x68x2400=2.25',
    '(100/111) 1.57x146x2.4=4.5',
    '(110) 1.57x158.5',
    '(112/113) 1.25x67',
    '(115/116) 1.57x131 3.9kgrs',
    '(117/114/117 p/R) 1.57x140.5',
    '(118) 1.57x145',
    '(119emb-Arr/dr/iz Crrd-ArrCrrd-emb) 1.25x49x2400=1.2',
    '(119-1/2emb) 1.25x73',
    '(121) 1.25x45x2400',
    '(122) 1.57x72x240=2.2',
    '(124/125 T 901/902 BaseyTapa) 1.25x136x2400=3.25',
    '(127/127 p/R) 1.50x78 2.25',
    '(123) 1.57x45x2400 1.45',
  ], campoLabel: 'CANTIDAD KG Tapas' },
  { num: 7, name: 'Palanca', unidad: 'kg', items: [
    '(115/116/124/125) 109.5x2x240=4.25',
    '(117/117p/R / 111/100) 128x2x2460=4.95',
    '(118) 2x133.5',
    '(120) 1.25x124.5x2400=3.03',
    '(121) 1.80x66=2.35',
    '(2000mp) 1.57x115',
    '(108/111/117/otros) 1.95x62',
    '(112/113/114/115/124) 1.45x62',
    '(119/123) 1.45x43.5',
    '(120) 1.45x76',
    '(121/127) 1.45x68',
    '(100 110 varios) 1.95x62x2.5=2.55 Bronce',
  ], campoLabel: 'CANTIDAD KG Palanca' },
  { num: 8, name: 'Combinaciones', unidad: 'kg', items: [
    '(115/120/123) 0.6x74.5',
    '(111/117/114/2000mp) 0.6x84',
    '(108/119/128/122) 0.6x59.5=83.25',
    '(112/127/127 P/R) 113 .6x49.5=8.6grs',
    '(121) 0.6x29',
    'Disco Bocallaves 34x0.6',
    '(118 Rollos Ac Inoxid) 0.6x93 23grs 43 kgrs',
    'chapa inox 1x2 0.7',
  ], campoLabel: 'CANTIDAD KG Combinaciones' },
  { num: 9, name: 'Ac. Inox / Varios', unidad: 'kg', items: [
    '(109 capuchón) 1.25x156x2.4=4',
    '(113 capuchón) 1.25x124',
    '(124/125/126 Bocallaves) 0.80x74.5',
    '(109 dr/Izq Bocallaves) 1.25x133',
    '(110 Bocallaves) 1.25x175',
    '(120/123 Cuad Crema) 2.85x44.5x3000=3.5',
    '(121/127/127p/R Cuad crema) 2.75x44x3000=3',
    'HIERRO4mCad.Crem (108/11/114/112/118/128)',
    'Cuad.crem4mBronce (111/108/114/112/118 otr)',
    'Cuad crem 3x33x3000 (115/116/124/125/117/122/126)=2.4',
    '(119) Cuadcrem 2.45x36 IDEM CREMALLERA 119',
    'cuadcrem5m HIERRO p/resorte nuez',
    'Bronce/discos/bocallaves (102/103/106/107)',
  ], campoLabel: 'CANTIDAD KG Varios' },
  { num: 10, name: 'Varios', unidad: 'u', items: [], campoLabel: 'CANTIDAD Varios', esLibre: true },
  { num: 11, name: 'Bronce', esBronce: true, subsections: [
    { num: 11, name: 'Nuez' },
    { num: 12, name: 'Pestillo' },
    { num: 13, name: 'Llaves' }
  ]},
];

const MP_ESTADO_LABELS = { pendiente: 'Pendiente', realizado: 'Realizado', entregado: 'Entregado' };
const MP_ESTADO_BADGE  = { pendiente: 'badge-warning', realizado: 'badge-info', entregado: 'badge-success' };

let _mpEstadoFilter = 'todos';
let _mpCurrentId    = null;
let _mpSuppliers    = [];

function mpBadge(estado) {
  return `<span class="badge ${MP_ESTADO_BADGE[estado] || 'badge-default'}">${MP_ESTADO_LABELS[estado] || estado}</span>`;
}

function showMpView(view) {
  ['mp-list-view','mp-form-view','mp-detail-view','mp-report-view'].forEach(id => {
    const el = $(id); if (el) el.classList.toggle('hidden', id !== `mp-${view}-view`);
  });
}

async function loadMpSuppliers() {
  try {
    _mpSuppliers = await api('GET', '/suppliers/for-mp');
  } catch { _mpSuppliers = []; }
}

function populateMpSupplierSelect(selId, includeAll = false) {
  const sel = $(selId); if (!sel) return;
  if (!includeAll && isFabrica() && _mpSuppliers.length === 0) {
    sel.innerHTML = '<option value="">No tenés proveedores asignados, contactá al administrador</option>';
    return;
  }
  sel.innerHTML = (includeAll ? '<option value="">Todos</option>' : '<option value="">— Seleccioná —</option>') +
    _mpSuppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
}

async function loadMpOrders() {
  try {
    const params = _mpEstadoFilter !== 'todos' ? `?estado=${_mpEstadoFilter}` : '';
    const orders = await api('GET', `/mp-orders${params}`);
    renderMpOrders(orders);
  } catch (err) { toast(err.message, 'error'); }
}

function renderMpOrders(orders) {
  const tbody = $('mp-tbody'), noEl = $('no-mp');
  $('mp-count').textContent = `${orders.length} pedido${orders.length !== 1 ? 's' : ''}`;
  if (!orders.length) { tbody.innerHTML = ''; noEl.classList.remove('hidden'); return; }
  noEl.classList.add('hidden');
  tbody.innerHTML = orders.map(o => `
    <tr style="cursor:pointer" onclick="openMpDetail(${o.id})">
      <td style="font-family:monospace">#${o.id}</td>
      <td>${fmtDate(o.fecha)}</td>
      <td style="font-weight:500">${esc(o.supplier_name || o.proveedor || '—')}</td>
      <td>${mpBadge(o.estado)}</td>
      <td style="font-size:.83rem;color:var(--text-muted)">${esc(o.created_by_name || '—')}</td>
      <td class="text-center" style="white-space:nowrap" onclick="event.stopPropagation()">
        ${isAdmin() ? `<select class="input select" style="font-size:.8rem;padding:2px 4px;width:auto" onchange="changeMpEstado(${o.id},this.value)">
          ${['pendiente','realizado','entregado'].map(e =>
            `<option value="${e}" ${o.estado===e?'selected':''}>${MP_ESTADO_LABELS[e]}</option>`
          ).join('')}
        </select>` : ''}
        <button class="btn-icon" onclick="openMpDetail(${o.id})" title="Ver detalle">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </td>
    </tr>`).join('');
}

let _mpReceiptOrderId = null;

window.changeMpEstado = async function(id, estado) {
  if (estado === 'entregado') {
    _mpReceiptOrderId = id;
    await openMpReceiptModal();
    return;
  }
  try {
    await api('PUT', `/mp-orders/${id}/estado`, { estado });
    loadMpOrders();
    toast('Estado actualizado', 'success');
  } catch (err) { toast(err.message, 'error'); loadMpOrders(); }
};

async function openMpReceiptModal() {
  $('inp-mpr-fecha').value = new Date().toISOString().slice(0, 10);
  $('inp-mpr-numero').value = '';
  $('inp-mpr-monto').value = '';
  $('inp-mpr-notas').value = '';
  $('inp-mpr-tipo').value = 'Factura A';
  $('inp-mpr-iva').value = '21%';
  // Load sucursales
  try {
    const subs = await api('GET', '/users/sucursales');
    $('inp-mpr-sucursal').innerHTML = '<option value="">— Seleccioná —</option>' +
      subs.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  } catch {
    $('inp-mpr-sucursal').innerHTML = '<option value="">Error cargando sucursales</option>';
  }
  $('mp-receipt-modal').classList.remove('hidden');
}

$('btn-mpr-cancel').addEventListener('click', () => {
  $('mp-receipt-modal').classList.add('hidden');
  _mpReceiptOrderId = null;
  loadMpOrders();
});

$('btn-mpr-confirm').addEventListener('click', async () => {
  const sucursal = $('inp-mpr-sucursal').value;
  const monto    = $('inp-mpr-monto').value;
  const fecha    = $('inp-mpr-fecha').value;
  if (!sucursal) { toast('Seleccioná la sucursal', 'error'); return; }
  if (!monto || parseFloat(monto) <= 0) { toast('Ingresá el monto total', 'error'); return; }
  if (!fecha) { toast('Ingresá la fecha del comprobante', 'error'); return; }
  const btn = $('btn-mpr-confirm');
  btn.disabled = true;
  try {
    await api('PUT', `/mp-orders/${_mpReceiptOrderId}/estado`, {
      estado: 'entregado',
      receipt: {
        sucursal,
        tipo_comprobante: $('inp-mpr-tipo').value,
        numero_comprobante: $('inp-mpr-numero').value.trim(),
        fecha_comprobante: fecha,
        monto_total: parseFloat(monto),
        iva: $('inp-mpr-iva').value,
        notas: $('inp-mpr-notas').value.trim()
      }
    });
    $('mp-receipt-modal').classList.add('hidden');
    _mpReceiptOrderId = null;
    toast('Pedido marcado como entregado y factura registrada', 'success');
    loadMpOrders();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

window.openMpDetail = async function(id) {
  _mpCurrentId = id;
  try {
    const o = await api('GET', `/mp-orders/${id}`);
    const provName = o.supplier_name || o.proveedor || '—';
    $('mp-detail-title').textContent = `Pedido MP #${id} — ${provName}`;

    const bySection = {};
    for (const it of (o.items || [])) {
      if (!bySection[it.seccion]) bySection[it.seccion] = [];
      bySection[it.seccion].push(it);
    }

    let html = `<div class="card" style="padding:16px;margin-bottom:12px">
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        <div><label style="font-size:.8rem;color:var(--text-muted)">Fecha</label><p style="margin:0;font-weight:600">${fmtDate(o.fecha)}</p></div>
        <div><label style="font-size:.8rem;color:var(--text-muted)">Proveedor</label><p style="margin:0;font-weight:600">${esc(provName)}</p></div>
        <div><label style="font-size:.8rem;color:var(--text-muted)">Estado</label><p style="margin:0">${mpBadge(o.estado)}</p></div>
        <div><label style="font-size:.8rem;color:var(--text-muted)">Creado por</label><p style="margin:0;font-size:.85rem">${esc(o.created_by_name || '—')}</p></div>
      </div>
      ${o.notas ? `<p style="margin:10px 0 0;font-size:.85rem;color:var(--text-muted)"><strong>Notas:</strong> ${esc(o.notas)}</p>` : ''}
    </div>
    ${o.receipt ? `<div class="card" style="padding:12px 16px;margin-bottom:12px;background:#f0f7ff;border:1px solid #bbd4f0">
      <div style="font-weight:700;font-size:.82rem;text-transform:uppercase;color:#2563eb;margin-bottom:8px">Comprobante de recepción</div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:.85rem">
        <div><label style="font-size:.75rem;color:var(--text-muted)">Sucursal</label><p style="margin:0;font-weight:600">${esc(o.receipt.sucursal)}</p></div>
        <div><label style="font-size:.75rem;color:var(--text-muted)">Comprobante</label><p style="margin:0;font-weight:600">${esc(o.receipt.tipo_comprobante)} ${esc(o.receipt.numero_comprobante||'')}</p></div>
        <div><label style="font-size:.75rem;color:var(--text-muted)">Fecha</label><p style="margin:0;font-weight:600">${fmtDate(o.receipt.fecha_comprobante)}</p></div>
        <div><label style="font-size:.75rem;color:var(--text-muted)">Monto</label><p style="margin:0;font-weight:600">${fmtMoney(o.receipt.monto_total)}</p></div>
        <div><label style="font-size:.75rem;color:var(--text-muted)">IVA</label><p style="margin:0;font-weight:600">${esc(o.receipt.iva)}</p></div>
        ${o.receipt.notas ? `<div><label style="font-size:.75rem;color:var(--text-muted)">Notas</label><p style="margin:0">${esc(o.receipt.notas)}</p></div>` : ''}
      </div>
    </div>` : ''}`;

    for (const sec of MP_SECTIONS) {
      if (sec.esBronce) {
        const hasAny = sec.subsections.some(sub => (bySection[sub.num] || []).length > 0);
        if (!hasAny) continue;
        html += `<div class="card" style="padding:12px 16px;margin-bottom:8px">
          <div style="font-weight:700;margin-bottom:10px;font-size:.9rem">${sec.num}. ${esc(sec.name)}</div>
          ${sec.subsections.map(sub => {
            const subItems = bySection[sub.num] || [];
            if (!subItems.length) return '';
            return `<div style="margin-bottom:10px">
              <div style="font-size:.8rem;font-weight:700;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase">${esc(sub.name)}</div>
              <table class="table" style="font-size:.83rem">
                <thead><tr><th>Modelo</th><th style="width:80px" class="text-right">Cantidad</th></tr></thead>
                <tbody>${subItems.map(it => `<tr>
                  <td>${esc(it.descripcion)}</td>
                  <td class="text-right" style="font-weight:600">${it.cantidad != null ? it.cantidad : '—'}</td>
                </tr>`).join('')}</tbody>
              </table>
            </div>`;
          }).join('')}
        </div>`;
        continue;
      }
      const items = bySection[sec.num] || [];
      if (!items.length) continue;
      html += `<div class="card" style="padding:12px 16px;margin-bottom:8px">
        <div style="font-weight:700;margin-bottom:8px;font-size:.9rem">${sec.num}. ${esc(sec.name)}</div>
        <table class="table" style="font-size:.83rem">
          <thead><tr><th>Descripción</th><th style="width:80px" class="text-right">Cantidad</th><th style="width:60px" class="text-right">Unidad</th></tr></thead>
          <tbody>${items.map(it => `<tr>
            <td>${esc(it.descripcion)}</td>
            <td class="text-right" style="font-weight:600">${it.cantidad != null ? it.cantidad : '—'}</td>
            <td class="text-right" style="color:var(--text-muted)">${esc(it.unidad)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`;
    }

    $('mp-detail-content').innerHTML = html;
    showMpView('detail');
  } catch (err) { toast(err.message, 'error'); }
};

// Eliminar pedido MP (admin only)
$('btn-mp-delete').addEventListener('click', async () => {
  if (!_mpCurrentId) return;
  if (!await confirm(`¿Eliminar el pedido MP #${_mpCurrentId}? Se eliminarán también todos sus ítems. Esta acción no se puede deshacer.`)) return;
  try {
    await api('DELETE', `/mp-orders/${_mpCurrentId}`);
    toast('Pedido MP eliminado', 'success');
    showMpView('list');
    loadMpOrders();
  } catch (err) { toast(err.message, 'error'); }
});

// RENDER FORM SECTIONS
function renderMpFormSections() {
  const container = $('mp-sections-container');
  container.innerHTML = MP_SECTIONS.map(sec => {
    let itemRows;
    if (sec.esBronce) {
      itemRows = sec.subsections.map(sub => `
        <div style="margin-bottom:14px">
          <div style="font-size:.82rem;font-weight:700;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.03em">${esc(sub.name)}</div>
          <div id="mp-bronce-${sub.num}">
            <div class="mp-bronce-row" data-sub="${sub.num}" style="display:flex;gap:8px;margin-bottom:6px">
              <input type="text" class="input mp-bronce-model" placeholder="Modelo" style="flex:1">
              <input type="number" class="input mp-bronce-qty" placeholder="Cantidad" min="0" step="any" style="width:110px">
            </div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" style="margin-top:2px" onclick="addMpBronceRow(${sub.num})">+ Agregar</button>
        </div>`).join('');
    } else if (sec.esLibre) {
      itemRows = `<div id="mp-sec-${sec.num}-libre">
          <div class="mp-libre-row" style="display:flex;gap:8px;margin-bottom:6px">
            <input type="text" class="input mp-libre-desc" placeholder="Descripción" style="flex:1">
            <input type="number" class="input mp-libre-qty" placeholder="Cantidad" min="0" step="any" style="width:100px">
            <input type="text" class="input mp-libre-unit" placeholder="Unid." style="width:70px" value="${sec.unidad}">
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" style="margin-top:4px" onclick="addMpLibreRow(${sec.num})">+ Agregar ítem</button>`;
    } else {
      itemRows = sec.items.map((item, idx) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <label style="flex:1;font-size:.82rem;color:var(--text)">${esc(item)}</label>
          <input type="number" class="input mp-item-qty" data-sec="${sec.num}" data-idx="${idx}" data-desc="${esc(item)}" data-unidad="${esc(sec.unidad)}"
            placeholder="kg" min="0" step="any" style="width:100px;text-align:right">
        </div>`).join('');
    }

    return `<details class="mp-section-card" style="margin-bottom:8px;border:1px solid var(--border);border-radius:8px;overflow:hidden">
      <summary style="padding:10px 14px;font-weight:700;cursor:pointer;background:var(--bg);user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center">
        <span>${sec.num}. ${esc(sec.name)}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div style="padding:12px 14px;background:var(--white)">${itemRows}</div>
    </details>`;
  }).join('');
}

window.addMpLibreRow = function(secNum) {
  const container = $(`mp-sec-${secNum}-libre`);
  const row = document.createElement('div');
  row.className = 'mp-libre-row';
  row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px';
  row.innerHTML = `<input type="text" class="input mp-libre-desc" placeholder="Descripción" style="flex:1">
    <input type="number" class="input mp-libre-qty" placeholder="Cantidad" min="0" step="any" style="width:100px">
    <input type="text" class="input mp-libre-unit" placeholder="Unid." style="width:70px" value="u">`;
  container.appendChild(row);
};

window.addMpBronceRow = function(subNum) {
  const container = $(`mp-bronce-${subNum}`);
  const row = document.createElement('div');
  row.className = 'mp-bronce-row';
  row.dataset.sub = subNum;
  row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px';
  row.innerHTML = `<input type="text" class="input mp-bronce-model" placeholder="Modelo" style="flex:1">
    <input type="number" class="input mp-bronce-qty" placeholder="Cantidad" min="0" step="any" style="width:110px">`;
  container.appendChild(row);
};

function collectMpItems() {
  const items = [];
  document.querySelectorAll('.mp-item-qty').forEach(inp => {
    const val = inp.value.trim();
    if (!val) return;
    items.push({ seccion: Number(inp.dataset.sec), descripcion: inp.dataset.desc,
      cantidad: parseFloat(val) || 0, unidad: inp.dataset.unidad || 'kg', notas: '' });
  });
  document.querySelectorAll('.mp-libre-row').forEach(row => {
    const desc = row.querySelector('.mp-libre-desc').value.trim();
    const qty  = row.querySelector('.mp-libre-qty').value.trim();
    const unit = row.querySelector('.mp-libre-unit').value.trim() || 'u';
    if (desc && qty) items.push({ seccion: 10, descripcion: desc, cantidad: parseFloat(qty)||0, unidad: unit, notas: '' });
  });
  document.querySelectorAll('.mp-bronce-row').forEach(row => {
    const model = row.querySelector('.mp-bronce-model').value.trim();
    const qty   = row.querySelector('.mp-bronce-qty').value.trim();
    const subNum = Number(row.dataset.sub);
    if (model && qty) items.push({ seccion: subNum, descripcion: model, cantidad: parseFloat(qty)||0, unidad: 'u', notas: '' });
  });
  return items;
}

// EVENT LISTENERS
$('btn-new-mp').addEventListener('click', async () => {
  $('mp-form-title').textContent = 'Nuevo Pedido MP';
  $('inp-mp-fecha').value  = new Date().toISOString().slice(0,10);
  $('inp-mp-notas').value  = '';
  await loadMpSuppliers();
  populateMpSupplierSelect('inp-mp-supplier');
  renderMpFormSections();
  showMpView('form');
});

['btn-mp-cancel','btn-mp-cancel2'].forEach(id => {
  if ($(id)) $(id).addEventListener('click', () => { showMpView('list'); loadMpOrders(); });
});

$('btn-mp-back').addEventListener('click', () => { showMpView('list'); loadMpOrders(); });

$('btn-mp-print').addEventListener('click', () => {
  if (_mpCurrentId) window.open(`/api/mp-orders/${_mpCurrentId}/print`, '_blank');
});

$('mp-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fecha       = $('inp-mp-fecha').value;
  const supplier_id = $('inp-mp-supplier').value;
  if (!fecha)       { toast('La fecha es requerida', 'error'); $('inp-mp-fecha').focus(); return; }
  if (!supplier_id) { toast('El proveedor es requerido', 'error'); $('inp-mp-supplier').focus(); return; }

  const items = collectMpItems();
  if (!items.length) { toast('Completá al menos un ítem antes de guardar', 'error'); return; }

  const btn = $('btn-mp-save');
  btn.disabled = true;
  try {
    await api('POST', '/mp-orders', { fecha, supplier_id: Number(supplier_id),
      notas: $('inp-mp-notas').value.trim(), items });
    toast('Pedido MP guardado', 'success');
    showMpView('list');
    loadMpOrders();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// Filtros de estado
document.querySelectorAll('.mp-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _mpEstadoFilter = btn.dataset.estado;
    document.querySelectorAll('.mp-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    loadMpOrders();
  });
});

// REPORTE MP
if ($('btn-mp-reporte')) {
  $('btn-mp-reporte').addEventListener('click', async () => {
    await loadMpSuppliers();
    populateMpSupplierSelect('inp-mp-report-supplier', true);
    // Rango de fechas: mes actual
    const now = new Date();
    $('inp-mp-report-desde').value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    $('inp-mp-report-hasta').value = now.toISOString().slice(0,10);
    showMpView('report');
    loadMpReport();
  });
}

$('btn-mp-report-back').addEventListener('click', () => { showMpView('list'); loadMpOrders(); });

$('btn-mp-report-filter').addEventListener('click', loadMpReport);

$('btn-mp-report-print').addEventListener('click', () => {
  const desde       = $('inp-mp-report-desde').value;
  const hasta       = $('inp-mp-report-hasta').value;
  const supplier_id = $('inp-mp-report-supplier').value;
  const params = new URLSearchParams();
  if (desde)       params.set('desde', desde);
  if (hasta)       params.set('hasta', hasta);
  if (supplier_id) params.set('supplier_id', supplier_id);
  window.open(`/api/mp-orders/report/print?${params}`, '_blank');
});

async function loadMpReport() {
  try {
    const desde       = $('inp-mp-report-desde').value;
    const hasta       = $('inp-mp-report-hasta').value;
    const supplier_id = $('inp-mp-report-supplier').value;
    const params = new URLSearchParams();
    if (desde)       params.set('desde', desde);
    if (hasta)       params.set('hasta', hasta);
    if (supplier_id) params.set('supplier_id', supplier_id);
    const orders = await api('GET', `/mp-orders/report?${params}`);
    renderMpReport(orders);
  } catch (err) { toast(err.message, 'error'); }
}

function renderMpReport(orders) {
  const tbody = $('mp-report-tbody'), noEl = $('no-mp-report');
  $('mp-report-count').textContent = `${orders.length} pedido${orders.length!==1?'s':''} entregado${orders.length!==1?'s':''}`;
  if (!orders.length) { tbody.innerHTML = ''; noEl.classList.remove('hidden'); return; }
  noEl.classList.add('hidden');
  const SECNAMES = ['C/Frnts','Frentes','Cremallera','Sup. Cremallera','Cajas','Tapas','Palanca','Combinaciones','Ac. Inox/Varios','Varios'];
  tbody.innerHTML = orders.map(o => {
    const secResumen = Object.entries(o.seccionMap || {})
      .map(([s,c]) => `${SECNAMES[Number(s)-1]||'Sec.'+s} (${c} ítem${c!==1?'s':''})`)
      .join(', ') || '—';
    const r = o.receipt;
    return `<tr>
      <td style="font-family:monospace">#${o.id}</td>
      <td>${fmtDate(o.fecha)}</td>
      <td style="font-weight:500">${esc(o.supplier_name||o.proveedor||'—')}</td>
      <td style="font-size:.82rem;color:var(--text-muted)">${esc(secResumen)}</td>
      <td style="font-size:.83rem;color:var(--text-muted)">${esc(o.created_by_name||'—')}</td>
      <td style="font-size:.83rem">${r ? esc(r.sucursal) : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="font-size:.83rem">${r ? `${esc(r.tipo_comprobante)} ${esc(r.numero_comprobante||'')}`.trim() : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td class="text-right" style="font-size:.83rem">${r ? fmtMoney(r.monto_total) : '<span style="color:var(--text-muted)">—</span>'}</td>
    </tr>`;
  }).join('');
}

/* ================================================================ PRODUCCIÓN */

const PROD_CATEGORIAS = ['','C/Frnts','Frentes','Cremallera','Sup. Cremallera','Cajas','Tapas','Palanca','Combinaciones','Ac. Inox / Varios'];
const PROD_PIEZAS_CIRCUITO = ['cajas','tapas','cremalleras','combinaciones','contrafrentes'];
const PROD_PIEZAS_DIRECTAS = ['llaves','nueces','pestillos'];
const PROD_CAMPOS_PROCESO = [
  ['cajas_pulidas','Cajas pulidas'],['cajas_sincadas','Cajas sincadas'],
  ['tapas_pulidas','Tapas pulidas'],['tapas_sincadas','Tapas sincadas'],
  ['cremalleras_pulidas','Cremalleras pulidas'],['cremalleras_sincadas','Cremalleras sincadas'],
  ['combinaciones_pulidas','Combinaciones pulidas'],['combinaciones_sincadas','Combinaciones sincadas'],
  ['contrafrentes_pulidos','Contrafrentes pulidos'],['contrafrentes_sincados','Contrafrentes sincados'],
  ['llaves','Llaves'],['nueces','Nueces'],['pestillos','Pestillos']
];
const PROD_CAMPOS = {
  proceso:   PROD_CAMPOS_PROCESO,
  terminadas:[['cantidad','Cantidad']]
};

// Color de fila según nombre de artículo
function prodRowClass(name) {
  if (!name) return '';
  if (/\b(108|111|118|128|115|116|124|125)\b/.test(name)) return 'prod-row-rosa';
  if (/\b(117|114|122|126)\b/.test(name))                  return 'prod-row-verde';
  if (/\b(121|127)\b/.test(name))                          return 'prod-row-verde-int';
  if (/\b(120|123)\b/.test(name))                          return 'prod-row-celeste';
  return '';
}

function prodTipoBadge(tipo) {
  const MAP = {
    ingreso_chapa:       ['info',    'Ingreso chapa'],
    ajuste_chapa:        ['default', 'Ajuste chapa'],
    procesado:           ['warning', 'Procesado'],
    sincado:             ['info',    'Sincado'],
    armado:              ['success', 'Armado'],
    ingreso_componentes: ['info',    'Ingreso comp.'],
    ajuste_manual:       ['default', 'Ajuste'],
    ingreso_deposito:    ['success', 'Ingreso dep.'],
    egreso_deposito:     ['warning', 'Egreso dep.'],
    // legacy
    entrada_mp:['info','Ingreso MP'], proceso:['warning','A proceso']
  };
  const [cls, label] = MAP[tipo] || ['default', tipo];
  return `<span class="badge badge-${cls}">${label}</span>`;
}

function fmtQtyColored(v) {
  if (v === null || v === undefined || v === 0) return '<span style="color:var(--text-muted)">—</span>';
  const c = v > 0 ? '#166534' : 'var(--danger)';
  return `<span style="color:${c}">${v > 0 ? '+' : ''}${v}</span>`;
}

// ── Tab navigation ─────────────────────────────────────────────

function showProdTab(tab) {
  document.querySelectorAll('.prod-tab').forEach(el =>
    el.classList.toggle('active', el.dataset.prodTab === tab)
  );
  ['proceso','terminadas','deposito','historial'].forEach(t => {
    const el = $(`prod-tab-${t}`);
    if (el) el.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'proceso')    { loadProdChapa(); loadProdProceso(); }
  if (tab === 'terminadas') loadProdTerminadas();
  if (tab === 'deposito')   loadDeposito();
  if (tab === 'historial')  loadProdHistorial();
}

document.querySelectorAll('.prod-tab').forEach(btn =>
  btn.addEventListener('click', () => showProdTab(btn.dataset.prodTab))
);

// ── Sección A: Chapa (kg) ──────────────────────────────────────

let _prodChapa = [];

async function loadProdChapa() {
  try {
    _prodChapa = await api('GET', '/produccion/chapa');
    renderProdChapa(_prodChapa);
  } catch (err) { toast(err.message, 'error'); }
}

function renderProdChapa(rows) {
  const tbody = $('prod-chapa-tbody');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td style="font-weight:500">${esc(r.nombre)}</td>
      <td class="text-right" style="font-weight:${r.kilos > 0 ? '700' : '400'};color:${r.kilos > 0 ? 'var(--text)' : 'var(--text-muted)'}">${(r.kilos||0).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2})} kg</td>
      <td class="text-center" style="white-space:nowrap">
        <button class="btn btn-sm btn-secondary" data-action="ing-chapa" data-cat="${r.categoria}" data-nombre="${esc(r.nombre)}">+ Ingresar kg</button>
        <button class="btn btn-sm btn-ghost"     data-action="procesado"  data-cat="${r.categoria}" data-nombre="${esc(r.nombre)}" data-kg="${r.kilos}" style="margin-left:4px">Procesar</button>
      </td>
    </tr>
  `).join('');
}

$('prod-chapa-tbody').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'ing-chapa') openProdChapaIngModal(Number(btn.dataset.cat));
  if (btn.dataset.action === 'procesado') openProdProcesadoModal(Number(btn.dataset.cat), Number(btn.dataset.kg));
});

$('btn-prod-refresh-chapa').addEventListener('click', loadProdChapa);
$('btn-prod-aj-chapa').addEventListener('click', openProdChapaAjModal);

// ── Sección B: Potencial para armar ───────────────────────────

let _prodProceso = [];

async function loadProdProceso() {
  try {
    _prodProceso = await api('GET', '/produccion/mp-proceso');
    renderProdProceso(_prodProceso);
    // Populate historial product filter
    const sel = $('prod-hist-product');
    if (sel.options.length <= 1) {
      _prodProceso.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.product_id; opt.textContent = p.name;
        sel.appendChild(opt);
      });
    }
  } catch (err) { toast(err.message, 'error'); }
}

function fmtPZ(v, isSin) {
  if (!v) return '<span style="color:var(--text-muted);font-size:.78rem">0</span>';
  const bold = isSin && v > 0 ? 'font-weight:700;' : '';
  const color = isSin && v > 0 ? 'color:var(--success-txt);' : '';
  return `<span style="${bold}${color}">${v}</span>`;
}

function renderProdProceso(rows) {
  const tbody = $('prod-proceso-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="16" class="text-center" style="color:var(--text-muted);padding:24px">No hay artículos activos en el catálogo</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const cls = prodRowClass(r.name);
    const rowData = JSON.stringify({
      cp:r.cajas_pulidas,cs:r.cajas_sincadas,
      tp:r.tapas_pulidas,ts:r.tapas_sincadas,
      crp:r.cremalleras_pulidas,crs:r.cremalleras_sincadas,
      cop:r.combinaciones_pulidas,cos:r.combinaciones_sincadas,
      cfp:r.contrafrentes_pulidos,cfs:r.contrafrentes_sincados,
      ll:r.llaves,nu:r.nueces,pe:r.pestillos
    });
    return `<tr class="${cls}" data-pid="${r.product_id}">
      <td style="font-weight:500;font-size:.82rem">${esc(r.name)}</td>
      <td class="text-center">${fmtPZ(r.cajas_pulidas,false)}</td>
      <td class="text-center">${fmtPZ(r.cajas_sincadas,true)}</td>
      <td class="text-center">${fmtPZ(r.tapas_pulidas,false)}</td>
      <td class="text-center">${fmtPZ(r.tapas_sincadas,true)}</td>
      <td class="text-center">${fmtPZ(r.cremalleras_pulidas,false)}</td>
      <td class="text-center">${fmtPZ(r.cremalleras_sincadas,true)}</td>
      <td class="text-center">${fmtPZ(r.combinaciones_pulidas,false)}</td>
      <td class="text-center">${fmtPZ(r.combinaciones_sincadas,true)}</td>
      <td class="text-center">${fmtPZ(r.contrafrentes_pulidos,false)}</td>
      <td class="text-center">${fmtPZ(r.contrafrentes_sincados,true)}</td>
      <td class="text-center">${fmtPZ(r.llaves,false)}</td>
      <td class="text-center">${fmtPZ(r.nueces,false)}</td>
      <td class="text-center">${fmtPZ(r.pestillos,false)}</td>
      <td class="prod-obs-cell" data-pid="${r.product_id}" title="Clic para editar" style="font-size:.8rem">${esc(r.observaciones)||'<span style="color:var(--text-muted)">—</span>'}</td>
      <td class="text-center" style="white-space:nowrap">
        <button class="btn btn-sm btn-ghost" data-action="sincar" data-pid="${r.product_id}" data-name="${esc(r.name)}" data-row='${rowData}' style="font-size:.78rem;padding:3px 8px">Sincar</button>
        <button class="btn btn-sm btn-primary" data-action="armar" data-pid="${r.product_id}" data-name="${esc(r.name)}" data-row='${rowData}' style="font-size:.78rem;padding:3px 8px;margin-left:3px">Armar</button>
      </td>
    </tr>`;
  }).join('');
}

$('prod-proceso-tbody').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (btn) {
    const pid  = Number(btn.dataset.pid);
    const name = btn.dataset.name;
    let rd = {};
    try { rd = JSON.parse(btn.dataset.row || '{}'); } catch {}
    if (btn.dataset.action === 'sincar') openProdSincarModal(pid, name, rd);
    if (btn.dataset.action === 'armar')  openProdArmarModal(pid, name, rd);
    return;
  }
  // Editar observaciones inline
  const obsCell = e.target.closest('.prod-obs-cell');
  if (obsCell && !obsCell.querySelector('input')) {
    const pid     = Number(obsCell.dataset.pid);
    const current = _prodProceso.find(r => r.product_id === pid)?.observaciones || '';
    const inp     = document.createElement('input');
    inp.type = 'text'; inp.value = current; inp.className = 'prod-obs-input';
    obsCell.innerHTML = '';
    obsCell.appendChild(inp);
    inp.focus();
    const save = async () => {
      const val = inp.value.trim();
      try {
        await api('PUT', `/produccion/mp-proceso/${pid}/obs`, { observaciones: val });
        const row = _prodProceso.find(r => r.product_id === pid);
        if (row) row.observaciones = val;
        obsCell.innerHTML = val ? esc(val) : '<span style="color:var(--text-muted)">—</span>';
      } catch (err) { toast(err.message, 'error'); loadProdProceso(); }
    };
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
      if (ev.key === 'Escape') loadProdProceso();
    });
  }
});

$('btn-prod-refresh-proceso').addEventListener('click', () => { loadProdChapa(); loadProdProceso(); });
$('btn-prod-aj-proceso').addEventListener('click',      () => openProdAjusteModal('proceso'));
$('btn-prod-ingcomp').addEventListener('click',          openProdIngcompModal);

// ── Tab: Terminadas ────────────────────────────────────────────

async function loadProdTerminadas() {
  try {
    const rows = await api('GET', '/produccion/terminadas');
    const tbody = $('prod-term-tbody');
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="3" class="text-center" style="color:var(--text-muted);padding:24px">Sin artículos</td></tr>'; return; }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td style="font-weight:500">${esc(r.name)}</td>
        <td class="text-center" style="font-weight:${r.cantidad>0?'700':'400'};color:${r.cantidad>0?'var(--success-txt)':'var(--text-muted)'}">${r.cantidad||0}</td>
        <td style="color:var(--text-muted);font-size:.83rem">${r.updated_at?fmtDateTime(r.updated_at):'—'}</td>
      </tr>`).join('');
  } catch (err) { toast(err.message, 'error'); }
}

$('btn-prod-refresh-term').addEventListener('click', loadProdTerminadas);
$('btn-prod-aj-term').addEventListener('click', () => openProdAjusteModal('terminadas'));

// ── Tab: Historial ─────────────────────────────────────────────

async function loadProdHistorial() {
  try {
    const params = new URLSearchParams();
    const pid   = $('prod-hist-product').value;
    const tipo  = $('prod-hist-tipo').value;
    const desde = $('prod-hist-desde').value;
    const hasta = $('prod-hist-hasta').value;
    if (pid)   params.set('product_id', pid);
    if (tipo)  params.set('tipo', tipo);
    if (desde) params.set('desde', desde);
    if (hasta) params.set('hasta', hasta);
    const rows = await api('GET', `/produccion/movimientos${params.toString()?'?'+params:''}`);
    const tbody = $('prod-hist-tbody');
    const empty = $('prod-hist-empty');
    if (!rows.length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    const CATNAMES = ['','C/Frnts','Frentes','Cremallera','Sup. Cremallera','Cajas','Tapas','Palanca','Combinaciones','Ac. Inox / Varios'];
    tbody.innerHTML = rows.map(r => {
      const subject = r.product_name
        ? esc(r.product_name)
        : (r.categoria ? `<span style="color:var(--text-muted)">${esc(CATNAMES[r.categoria]||'Cat.'+r.categoria)}</span>` : '—');
      const pieza   = r.pieza ? `<span style="font-size:.82rem">${esc(r.pieza)}</span>` : '—';
      const cantidad = r.cantidad !== null && r.cantidad !== 0 ? fmtQtyColored(r.cantidad) : '—';
      const kgUsados = r.kg_usados ? `<span style="color:var(--text-muted)">${r.kg_usados} kg</span>` : '—';
      return `<tr>
        <td style="color:var(--text-muted)">${fmtDateTime(r.created_at)}</td>
        <td>${subject}</td>
        <td class="text-center">${prodTipoBadge(r.tipo)}</td>
        <td>${pieza}</td>
        <td class="text-right">${cantidad}</td>
        <td class="text-right">${kgUsados}</td>
        <td style="font-size:.82rem;color:var(--text-muted)">${esc(r.notas||'')}${r.purchase_doc?` <span class="badge badge-info" style="font-size:.72rem">${esc(r.purchase_doc)}</span>`:''}</td>
        <td style="font-size:.82rem;color:var(--text-muted)">${esc(r.created_by_name||'—')}</td>
      </tr>`;
    }).join('');
  } catch (err) { toast(err.message, 'error'); }
}

$('btn-prod-refresh-hist').addEventListener('click', loadProdHistorial);
$('btn-prod-hist-filter').addEventListener('click', loadProdHistorial);
$('btn-prod-hist-clear').addEventListener('click', () => {
  ['prod-hist-product','prod-hist-tipo','prod-hist-desde','prod-hist-hasta'].forEach(id => $(id).value = '');
  loadProdHistorial();
});

// ── Helpers comunes ────────────────────────────────────────────

function fillProdCatSelect(selId, presetCat) {
  const sel = $(selId);
  sel.innerHTML = PROD_CATEGORIAS.slice(1).map((n,i) => `<option value="${i+1}">${n}</option>`).join('');
  if (presetCat) sel.value = presetCat;
}

async function fillProdProductSelect(selId, presetPid) {
  const sel = $(selId);
  const prods = _prodProceso.length ? _prodProceso : await api('GET', '/produccion/mp-proceso');
  sel.innerHTML = '<option value="">— Seleccioná un artículo —</option>';
  prods.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.product_id; opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (presetPid) sel.value = presetPid;
}

async function loadPurchasesSelect(selId) {
  try {
    const purchases = await api('GET', '/produccion/purchases-for-mp');
    const sel = $(selId);
    sel.innerHTML = '<option value="">— Sin vincular —</option>';
    purchases.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.purchase_number} — ${esc(p.supplier_name)}${p.doc_date?' ('+fmtDate(p.doc_date)+')':''}`;
      sel.appendChild(opt);
    });
  } catch {}
}

// ── Modal: Ingresar kg de chapa ────────────────────────────────

async function openProdChapaIngModal(presetCat) {
  fillProdCatSelect('inp-prod-cha-cat', presetCat);
  await loadPurchasesSelect('inp-prod-cha-purchase');
  $('inp-prod-cha-kg').value    = '';
  $('inp-prod-cha-notas').value = '';
  $('prod-chapa-ing-modal').classList.remove('hidden');
  $('inp-prod-cha-kg').focus();
}

$('btn-prod-cha-cancel').addEventListener('click', () => $('prod-chapa-ing-modal').classList.add('hidden'));
$('btn-prod-cha-confirm').addEventListener('click', async () => {
  const cat  = Number($('inp-prod-cha-cat').value);
  const kg   = Number($('inp-prod-cha-kg').value);
  const notas = $('inp-prod-cha-notas').value.trim();
  const pid  = Number($('inp-prod-cha-purchase').value) || null;
  if (!cat || kg <= 0) { toast('Categoría y kg requeridos', 'error'); return; }
  try {
    await api('POST', '/produccion/chapa/ingreso', { categoria: cat, kilos: kg, notas, purchase_id: pid });
    $('prod-chapa-ing-modal').classList.add('hidden');
    toast('Ingreso de chapa registrado', 'success');
    loadProdChapa();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Modal: Ajuste kg de chapa ─────────────────────────────────

function openProdChapaAjModal(presetCat) {
  fillProdCatSelect('inp-prod-chaj-cat', presetCat);
  $('inp-prod-chaj-delta').value = '';
  $('inp-prod-chaj-notas').value = '';
  $('prod-chapa-aj-modal').classList.remove('hidden');
}

$('btn-prod-chaj-cancel').addEventListener('click', () => $('prod-chapa-aj-modal').classList.add('hidden'));
$('btn-prod-chaj-confirm').addEventListener('click', async () => {
  const cat   = Number($('inp-prod-chaj-cat').value);
  const delta = Number($('inp-prod-chaj-delta').value);
  const notas = $('inp-prod-chaj-notas').value.trim();
  if (!cat || isNaN(delta) || delta === 0) { toast('Categoría y delta requeridos', 'error'); return; }
  try {
    await api('POST', '/produccion/chapa/ajuste', { categoria: cat, delta, notas });
    $('prod-chapa-aj-modal').classList.add('hidden');
    toast('Ajuste de chapa aplicado', 'success');
    loadProdChapa();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Modal: Procesar chapa → piezas pulidas ────────────────────

async function openProdProcesadoModal(presetCat, chapaKg) {
  fillProdCatSelect('inp-prod-prc-cat', presetCat);
  await fillProdProductSelect('inp-prod-prc-product', null);
  $('prod-proc-chapa-info').textContent = `Stock disponible: ${chapaKg||0} kg`;
  $('inp-prod-prc-kg').value     = '';
  $('inp-prod-prc-piezas').value = '';
  $('inp-prod-prc-notas').value  = '';
  $('prod-procesado-modal').classList.remove('hidden');
}

$('btn-prod-prc-cancel').addEventListener('click', () => $('prod-procesado-modal').classList.add('hidden'));
$('btn-prod-prc-confirm').addEventListener('click', async () => {
  const cat   = Number($('inp-prod-prc-cat').value);
  const pid   = Number($('inp-prod-prc-product').value);
  const pieza = $('inp-prod-prc-pieza').value;
  const kg    = Number($('inp-prod-prc-kg').value);
  const pzas  = Number($('inp-prod-prc-piezas').value);
  const notas = $('inp-prod-prc-notas').value.trim();
  if (!cat || !pid || !pieza || kg <= 0 || pzas <= 0) { toast('Completá todos los campos requeridos', 'error'); return; }
  try {
    await api('POST', '/produccion/procesado', { product_id: pid, categoria: cat, pieza, kg_usados: kg, piezas_resultado: pzas, notas });
    $('prod-procesado-modal').classList.add('hidden');
    toast('Procesado registrado', 'success');
    loadProdChapa(); loadProdProceso();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Modal: Sincar piezas ───────────────────────────────────────

let _prodSincarPid = null;

function openProdSincarModal(pid, name, rd) {
  _prodSincarPid = pid;
  $('prod-sincar-name').textContent = name;
  $('prod-sincar-info').innerHTML =
    `Pulidas → Cajas: <b>${rd.cp||0}</b> | Tapas: <b>${rd.tp||0}</b> | Cremalleras: <b>${rd.crp||0}</b> | Comb.: <b>${rd.cop||0}</b> | C/Frnts: <b>${rd.cfp||0}</b>`;
  $('inp-prod-sin-cantidad').value = '';
  $('inp-prod-sin-notas').value    = '';
  $('prod-sincar-modal').classList.remove('hidden');
  $('inp-prod-sin-cantidad').focus();
}

$('btn-prod-sin-cancel').addEventListener('click', () => $('prod-sincar-modal').classList.add('hidden'));
$('btn-prod-sin-confirm').addEventListener('click', async () => {
  const pieza    = $('inp-prod-sin-pieza').value;
  const cantidad = Number($('inp-prod-sin-cantidad').value);
  const notas    = $('inp-prod-sin-notas').value.trim();
  if (!_prodSincarPid || cantidad <= 0) { toast('Cantidad inválida', 'error'); return; }
  try {
    await api('POST', '/produccion/sincar', { product_id: _prodSincarPid, pieza, cantidad, notas });
    $('prod-sincar-modal').classList.add('hidden');
    toast('Sincado registrado', 'success');
    loadProdProceso();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Modal: Armar cerraduras ────────────────────────────────────

let _prodArmarPid = null;

function openProdArmarModal(pid, name, rd) {
  _prodArmarPid = pid;
  $('prod-armar-name').textContent = name;
  $('prod-armar-info').innerHTML =
    `Sincadas → Cajas: <b>${rd.cs||0}</b> | Tapas: <b>${rd.ts||0}</b> | Crem.: <b>${rd.crs||0}</b> | Comb.: <b>${rd.cos||0}</b> | C/Frnts: <b>${rd.cfs||0}</b><br>Directas → Llaves: <b>${rd.ll||0}</b> | Nueces: <b>${rd.nu||0}</b> | Pestillos: <b>${rd.pe||0}</b>`;
  $('inp-prod-arm-cantidad').value = 1;
  // Pre-fill consumo fields with default consumption per cerradura (0 if no stock)
  $('inp-arm-cajas').value          = (rd.cs||0) > 0 ? 1 : 0;
  $('inp-arm-tapas').value          = (rd.ts||0) > 0 ? 1 : 0;
  $('inp-arm-cremalleras').value    = (rd.crs||0) > 0 ? 1 : 0;
  $('inp-arm-combinaciones').value  = (rd.cos||0) > 0 ? 1 : 0;
  $('inp-arm-contrafrentes').value  = (rd.cfs||0) > 0 ? 1 : 0;
  $('inp-arm-llaves').value         = (rd.ll||0) > 0 ? 2 : 0;
  $('inp-arm-nueces').value         = (rd.nu||0) > 0 ? 1 : 0;
  $('inp-arm-pestillos').value      = (rd.pe||0) > 0 ? 1 : 0;
  $('inp-arm-notas').value          = '';
  $('prod-armar-modal').classList.remove('hidden');
  $('inp-prod-arm-cantidad').focus();
  $('inp-prod-arm-cantidad').select();
}

$('btn-prod-arm-cancel').addEventListener('click', () => $('prod-armar-modal').classList.add('hidden'));
$('btn-prod-arm-confirm').addEventListener('click', async () => {
  const qty = Number($('inp-prod-arm-cantidad').value);
  if (!_prodArmarPid || qty <= 0) { toast('Cantidad inválida', 'error'); return; }
  const consumo = {
    cajas:          Number($('inp-arm-cajas').value)         || 0,
    tapas:          Number($('inp-arm-tapas').value)         || 0,
    cremalleras:    Number($('inp-arm-cremalleras').value)   || 0,
    combinaciones:  Number($('inp-arm-combinaciones').value) || 0,
    contrafrentes:  Number($('inp-arm-contrafrentes').value) || 0,
    llaves:         Number($('inp-arm-llaves').value)        || 0,
    nueces:         Number($('inp-arm-nueces').value)        || 0,
    pestillos:      Number($('inp-arm-pestillos').value)     || 0
  };
  try {
    await api('POST', '/produccion/armar', { product_id: _prodArmarPid, cantidad: qty, consumo, notas: $('inp-arm-notas').value.trim() });
    $('prod-armar-modal').classList.add('hidden');
    toast(`${qty} cerradura${qty>1?'s':''} armada${qty>1?'s':''} correctamente`, 'success');
    loadProdProceso(); loadProdTerminadas();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Modal: Ingresar componentes ────────────────────────────────

async function openProdIngcompModal() {
  await fillProdProductSelect('inp-prod-ic-product', null);
  $('inp-prod-ic-cantidad').value = '';
  $('inp-prod-ic-notas').value    = '';
  $('prod-ingcomp-modal').classList.remove('hidden');
}

$('btn-prod-ic-cancel').addEventListener('click', () => $('prod-ingcomp-modal').classList.add('hidden'));
$('btn-prod-ic-confirm').addEventListener('click', async () => {
  const pid     = Number($('inp-prod-ic-product').value);
  const pieza   = $('inp-prod-ic-pieza').value;
  const cantidad = Number($('inp-prod-ic-cantidad').value);
  const notas   = $('inp-prod-ic-notas').value.trim();
  if (!pid || cantidad <= 0) { toast('Artículo y cantidad requeridos', 'error'); return; }
  try {
    await api('POST', '/produccion/ingreso-componentes', { product_id: pid, pieza, cantidad, notas });
    $('prod-ingcomp-modal').classList.add('hidden');
    toast('Componentes ingresados', 'success');
    loadProdProceso();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Modal: Ajuste manual ───────────────────────────────────────

async function openProdAjusteModal(presetEtapa) {
  await fillProdProductSelect('inp-prod-aj-product', null);
  if (presetEtapa) $('inp-prod-aj-etapa').value = presetEtapa;
  updateProdAjCampos();
  $('inp-prod-aj-delta').value = '';
  $('inp-prod-aj-notas').value = '';
  $('prod-ajuste-modal').classList.remove('hidden');
}

function updateProdAjCampos() {
  const etapa  = $('inp-prod-aj-etapa').value;
  const campos = PROD_CAMPOS[etapa] || [];
  $('inp-prod-aj-campo').innerHTML = campos.map(([v,l]) => `<option value="${v}">${l}</option>`).join('');
}

$('inp-prod-aj-etapa').addEventListener('change', updateProdAjCampos);
$('btn-prod-aj-cancel').addEventListener('click', () => $('prod-ajuste-modal').classList.add('hidden'));
$('btn-prod-aj-confirm').addEventListener('click', async () => {
  const pid   = Number($('inp-prod-aj-product').value);
  const etapa = $('inp-prod-aj-etapa').value;
  const campo = $('inp-prod-aj-campo').value;
  const delta = Number($('inp-prod-aj-delta').value);
  const notas = $('inp-prod-aj-notas').value.trim();
  if (!pid)                       { toast('Seleccioná un artículo', 'error'); return; }
  if (isNaN(delta) || delta === 0){ toast('El delta no puede ser cero', 'error'); return; }
  try {
    await api('POST', '/produccion/ajuste', { etapa, product_id: pid, campo, delta, notas });
    $('prod-ajuste-modal').classList.add('hidden');
    toast('Ajuste aplicado', 'success');
    if (etapa === 'proceso')    loadProdProceso();
    if (etapa === 'terminadas') loadProdTerminadas();
  } catch (err) { toast(err.message, 'error'); }
});

/* ================================================================ DEPÓSITO */

let _deposito = [];

// ── Carga y render principal ───────────────────────────────────

async function loadDeposito() {
  try {
    _deposito = await api('GET', '/produccion/deposito/insumos');
    renderDepositoSummary(_deposito);
    renderDepositoTable(_deposito);
  } catch (err) { toast(err.message, 'error'); }
}

function renderDepositoSummary(rows) {
  const totalTornillos = rows.filter(r => r.tipo === 'tornillo').reduce((s, r) => s + r.stock_actual, 0);
  const totalCajas     = rows.filter(r => r.tipo === 'caja').reduce((s, r) => s + r.stock_actual, 0);
  const cerraduras     = Math.floor(totalTornillos / 4);
  $('dep-summary').innerHTML = `
    <div class="stat-card">
      <div style="font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Tornillos en stock</div>
      <div style="font-size:1.6rem;font-weight:700;color:var(--text)">${totalTornillos.toLocaleString('es-AR')}</div>
    </div>
    <div class="stat-card">
      <div style="font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Cajas en stock</div>
      <div style="font-size:1.6rem;font-weight:700;color:var(--text)">${totalCajas.toLocaleString('es-AR')}</div>
    </div>
    <div class="stat-card">
      <div style="font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Tornillos → cerraduras</div>
      <div style="font-size:1.6rem;font-weight:700;color:var(--success-txt)">${cerraduras.toLocaleString('es-AR')}</div>
      <div style="font-size:.8rem;color:var(--text-muted);margin-top:4px">4 tornillos por cerradura</div>
    </div>`;
}

function renderDepositoTable(rows) {
  const tbody = $('dep-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="color:var(--text-muted);padding:24px">Sin insumos activos</td></tr>';
    return;
  }
  // Group: tornillos first, then cajas
  const sorted = [...rows].sort((a, b) => {
    if (a.tipo !== b.tipo) return a.tipo === 'tornillo' ? -1 : 1;
    return a.id - b.id;
  });
  let lastTipo = null;
  tbody.innerHTML = sorted.map(r => {
    const groupHeader = r.tipo !== lastTipo
      ? `<tr><td colspan="5" style="background:var(--bg);font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);padding:8px 14px">${r.tipo === 'tornillo' ? 'Tornillos' : 'Cajas de embalaje'}</td></tr>`
      : '';
    lastTipo = r.tipo;
    const stockColor = r.stock_actual > 0 ? 'var(--text)' : 'var(--text-muted)';
    return `${groupHeader}<tr data-id="${r.id}">
      <td style="color:var(--text-muted);font-size:.83rem">${r.tipo === 'tornillo' ? 'Tornillo' : 'Caja'}</td>
      <td style="font-weight:500">${esc(r.descripcion)}</td>
      <td class="text-center" style="font-weight:700;color:${stockColor}">${r.stock_actual}</td>
      <td style="color:var(--text-muted);font-size:.83rem">${r.updated_at ? fmtDateTime(r.updated_at) : '—'}</td>
      <td class="text-center" style="white-space:nowrap">
        <button class="btn btn-sm btn-secondary" data-dep-action="ingresar" data-id="${r.id}" data-name="${esc(r.descripcion)}">+ Ingresar</button>
        <button class="btn btn-sm btn-ghost" data-dep-action="egresar" data-id="${r.id}" data-name="${esc(r.descripcion)}" data-stock="${r.stock_actual}" style="margin-left:4px">− Egresar</button>
      </td>
    </tr>`;
  }).join('');
}

$('dep-tbody').addEventListener('click', e => {
  const btn = e.target.closest('button[data-dep-action]');
  if (!btn) return;
  const id    = Number(btn.dataset.id);
  const name  = btn.dataset.name;
  const stock = Number(btn.dataset.stock);
  if (btn.dataset.depAction === 'ingresar') openDepIngresoModal(id, name);
  if (btn.dataset.depAction === 'egresar')  openDepEgresoModal(id, name, stock);
});

$('btn-dep-refresh').addEventListener('click', loadDeposito);
$('btn-dep-gestionar').addEventListener('click', openDepGestionarModal);

// ── Modal: Ingresar ────────────────────────────────────────────

let _depIngId = null;

function openDepIngresoModal(id, name) {
  _depIngId = id;
  $('dep-ing-name').textContent = name;
  $('inp-dep-ing-cantidad').value = '';
  $('inp-dep-ing-obs').value      = '';
  $('dep-ingreso-modal').classList.remove('hidden');
  $('inp-dep-ing-cantidad').focus();
}

$('btn-dep-ing-cancel').addEventListener('click', () => $('dep-ingreso-modal').classList.add('hidden'));
$('btn-dep-ing-confirm').addEventListener('click', async () => {
  const qty = Number($('inp-dep-ing-cantidad').value);
  if (!_depIngId || qty <= 0) { toast('Cantidad inválida', 'error'); return; }
  try {
    await api('POST', '/produccion/deposito/ingreso', {
      insumo_id:    _depIngId,
      cantidad:     qty,
      observaciones: $('inp-dep-ing-obs').value.trim()
    });
    $('dep-ingreso-modal').classList.add('hidden');
    toast('Ingreso registrado', 'success');
    loadDeposito();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Modal: Egresar ─────────────────────────────────────────────

let _depEgrId = null;

function openDepEgresoModal(id, name, stock) {
  _depEgrId = id;
  $('dep-egr-name').textContent  = name;
  $('dep-egr-stock').textContent = `Stock disponible: ${stock} unidades`;
  $('inp-dep-egr-cantidad').value = '';
  $('inp-dep-egr-obs').value      = '';
  $('inp-dep-egr-motivo').value   = 'uso';
  $('dep-egreso-modal').classList.remove('hidden');
  $('inp-dep-egr-cantidad').focus();
}

$('btn-dep-egr-cancel').addEventListener('click', () => $('dep-egreso-modal').classList.add('hidden'));
$('btn-dep-egr-confirm').addEventListener('click', async () => {
  const qty = Number($('inp-dep-egr-cantidad').value);
  if (!_depEgrId || qty <= 0) { toast('Cantidad inválida', 'error'); return; }
  try {
    await api('POST', '/produccion/deposito/egreso', {
      insumo_id:    _depEgrId,
      cantidad:     qty,
      motivo:       $('inp-dep-egr-motivo').value,
      observaciones: $('inp-dep-egr-obs').value.trim()
    });
    $('dep-egreso-modal').classList.add('hidden');
    toast('Egreso registrado', 'success');
    loadDeposito();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Modal: Gestionar insumos ───────────────────────────────────

async function openDepGestionarModal() {
  await renderDepGestList();
  $('dep-gestionar-modal').classList.remove('hidden');
}

async function renderDepGestList() {
  try {
    const todos = await api('GET', '/produccion/deposito/insumos?all=1');
    $('dep-gest-tbody').innerHTML = todos.map(r => `
      <tr id="dep-gest-row-${r.id}">
        <td style="color:var(--text-muted);font-size:.82rem">${r.tipo === 'tornillo' ? 'Tornillo' : 'Caja'}</td>
        <td id="dep-gest-desc-${r.id}">${esc(r.descripcion)}</td>
        <td class="text-center">${r.stock_actual}</td>
        <td class="text-center">
          <span class="badge ${r.activo ? 'badge-success' : 'badge-default'}">${r.activo ? 'Activo' : 'Inactivo'}</span>
        </td>
        <td class="text-center">
          <button class="btn btn-sm btn-ghost" data-gest-edit="${r.id}" data-desc="${esc(r.descripcion)}" data-activo="${r.activo}">Editar</button>
        </td>
      </tr>
    `).join('');
  } catch (err) { toast(err.message, 'error'); }
}

$('dep-gest-tbody').addEventListener('click', e => {
  const btn = e.target.closest('button[data-gest-edit]');
  if (!btn) return;
  const id     = Number(btn.dataset.gestEdit);
  const desc   = btn.dataset.desc;
  const activo = Number(btn.dataset.activo);
  const row    = $(`dep-gest-row-${id}`);
  if (!row) return;
  row.innerHTML = `
    <td colspan="2">
      <input type="text" id="dep-gest-inp-${id}" class="input" style="font-size:.87rem;padding:5px 8px" value="${esc(desc)}">
    </td>
    <td class="text-center" style="font-size:.82rem;color:var(--text-muted)">${e.target.closest('tr').cells[2].textContent}</td>
    <td class="text-center">
      <select id="dep-gest-activo-${id}" class="input select" style="font-size:.82rem;padding:4px 6px;height:auto">
        <option value="1" ${activo ? 'selected' : ''}>Activo</option>
        <option value="0" ${!activo ? 'selected' : ''}>Inactivo</option>
      </select>
    </td>
    <td class="text-center" style="white-space:nowrap">
      <button class="btn btn-sm btn-primary" data-gest-save="${id}">Guardar</button>
      <button class="btn btn-sm btn-ghost" data-gest-cancel="${id}" style="margin-left:4px">✕</button>
    </td>`;
  $(`dep-gest-inp-${id}`).focus();
});

$('dep-gest-tbody').addEventListener('click', async e => {
  const saveBtn   = e.target.closest('button[data-gest-save]');
  const cancelBtn = e.target.closest('button[data-gest-cancel]');
  if (saveBtn) {
    const id     = Number(saveBtn.dataset.gestSave);
    const desc   = $(`dep-gest-inp-${id}`)?.value.trim();
    const activo = Number($(`dep-gest-activo-${id}`)?.value);
    if (!desc) { toast('La descripción no puede estar vacía', 'error'); return; }
    try {
      await api('PUT', `/produccion/deposito/insumos/${id}`, { descripcion: desc, activo });
      toast('Insumo actualizado', 'success');
      await renderDepGestList();
      loadDeposito();
    } catch (err) { toast(err.message, 'error'); }
  }
  if (cancelBtn) { await renderDepGestList(); }
});

$('btn-dep-new-add').addEventListener('click', async () => {
  const tipo = $('inp-dep-new-tipo').value;
  const desc = $('inp-dep-new-desc').value.trim();
  if (!desc) { toast('Ingresá una descripción', 'error'); return; }
  try {
    await api('POST', '/produccion/deposito/insumos', { tipo, descripcion: desc });
    $('inp-dep-new-desc').value = '';
    toast('Insumo agregado', 'success');
    await renderDepGestList();
    loadDeposito();
  } catch (err) { toast(err.message, 'error'); }
});

$('btn-dep-gest-close').addEventListener('click', () => $('dep-gestionar-modal').classList.add('hidden'));
$('btn-dep-gest-done').addEventListener('click',  () => $('dep-gestionar-modal').classList.add('hidden'));

/* ================================================================ INIT */
checkAuth();
