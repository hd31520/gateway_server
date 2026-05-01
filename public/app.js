let adminToken = localStorage.getItem('adminToken') || '';
let clientToken = localStorage.getItem('clientToken') || '';
let page = 1;
let totalPages = 1;
let clientWebsites = [];
let clientAdminPayment = { brandOpeningFee: 60, bkashNumber: '', nagadNumber: '' };

const $ = (selector) => document.querySelector(selector);

const authView = $('#authView');
const adminDashboard = $('#adminDashboard');
const clientDashboard = $('#clientDashboard');
const authError = $('#authError');
const paymentsBody = $('#paymentsBody');
const websiteList = $('#websiteList');

function setVisible(view) {
  authView.classList.toggle('hidden', view !== 'auth');
  adminDashboard.classList.toggle('hidden', view !== 'admin');
  clientDashboard.classList.toggle('hidden', view !== 'client');
}

function setAuthRole(role) {
  authError.textContent = '';
  $('#clientAuthTab').classList.toggle('active', role === 'client');
  $('#adminAuthTab').classList.toggle('active', role === 'admin');
  $('#clientLoginForm').classList.toggle('hidden', role !== 'client');
  $('#clientRegisterForm').classList.add('hidden');
  $('#adminLoginForm').classList.toggle('hidden', role !== 'admin');
}

function showClientRegister() {
  authError.textContent = '';
  $('#clientLoginForm').classList.add('hidden');
  $('#clientRegisterForm').classList.remove('hidden');
  $('#adminLoginForm').classList.add('hidden');
  $('#clientAuthTab').classList.add('active');
  $('#adminAuthTab').classList.remove('active');
}

function showAuth() {
  setVisible('auth');
  setAuthRole('client');
}

$('#clientAuthTab').addEventListener('click', () => setAuthRole('client'));
$('#adminAuthTab').addEventListener('click', () => setAuthRole('admin'));
$('#showRegisterBtn').addEventListener('click', showClientRegister);
$('#showLoginBtn').addEventListener('click', () => setAuthRole('client'));

$('#adminLoginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  authError.textContent = '';

  const username = $('#adminUsername').value;
  const password = $('#adminPassword').value;
  const res = await fetchJson('/api/login', { username, password });

  if (!res.ok) {
    authError.textContent = res.data.error || 'Login failed';
    return;
  }

  adminToken = res.data.token;
  localStorage.setItem('adminToken', adminToken);
  await showAdminDashboard();
});

$('#clientLoginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  authError.textContent = '';

  const email = $('#clientEmail').value;
  const password = $('#clientPassword').value;
  const res = await fetchJson('/api/client/login', { email, password });

  if (!res.ok) {
    authError.textContent = res.data.error || 'Login failed';
    return;
  }

  clientToken = res.data.token;
  localStorage.setItem('clientToken', clientToken);
  await showClientDashboard();
});

$('#clientRegisterForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  authError.textContent = '';

  const name = $('#registerName').value;
  const email = $('#registerEmail').value;
  const password = $('#registerPassword').value;
  const res = await fetchJson('/api/client/register', { name, email, password });

  if (!res.ok) {
    authError.textContent = res.data.error || 'Register failed';
    return;
  }

  clientToken = res.data.token;
  localStorage.setItem('clientToken', clientToken);
  await showClientDashboard();
});

$('#adminLogoutBtn').addEventListener('click', async () => {
  try {
    if (adminToken) await fetchJson('/api/logout', {}, adminToken);
  } catch (error) {
    // Local logout should still complete if the network request fails.
  }
  localStorage.removeItem('adminToken');
  adminToken = '';
  showAuth();
});

$('#clientLogoutBtn').addEventListener('click', async () => {
  try {
    if (clientToken) await fetchJson('/api/client/logout', {}, clientToken);
  } catch (error) {
    // Local logout should still complete if the network request fails.
  }
  localStorage.removeItem('clientToken');
  clientToken = '';
  clientWebsites = [];
  clientAdminPayment = { brandOpeningFee: 60, bkashNumber: '', nagadNumber: '' };
  showAuth();
});

$('#searchBtn').addEventListener('click', () => {
  page = 1;
  loadPayments();
});
$('#refreshBtn').addEventListener('click', loadPayments);
$('#prevBtn').addEventListener('click', () => {
  if (page > 1) {
    page--;
    loadPayments();
  }
});
$('#nextBtn').addEventListener('click', () => {
  if (page < totalPages) {
    page++;
    loadPayments();
  }
});

paymentsBody.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-payment-status]');
  if (!button) return;

  const id = button.dataset.paymentId;
  const status = button.dataset.paymentStatus;
  const res = await fetch('/api/payments', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ id, status })
  });
  const data = await res.json();

  if (!res.ok) {
    alert(data.error || 'Failed to update payment');
    return;
  }

  loadPayments();
});

$('#websiteForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#websiteMessage');
  message.textContent = '';

  const name = $('#websiteName').value;
  const domain = $('#websiteDomain').value;
  const walletProvider = $('#walletProvider').value;
  const walletNumber = $('#walletNumber').value;
  const receiverName = $('#receiverName').value;
  const res = await fetchJson('/api/client/websites', { name, domain, walletProvider, walletNumber, receiverName }, clientToken);

  if (!res.ok) {
    message.textContent = res.data.error || 'Website add failed';
    message.className = 'notice error-text';
    return;
  }

  $('#websiteForm').reset();
  message.textContent = `Website added. Pay ${formatMoney(clientAdminPayment.brandOpeningFee || 60)} to activate the domain.`;
  message.className = 'notice success-text';
  await loadClientData();
});

$('#refreshClientBtn').addEventListener('click', loadClientData);

websiteList.addEventListener('click', async (event) => {
  const copyButton = event.target.closest('[data-copy]');
  if (!copyButton) return;

  const text = copyButton.dataset.copy;
  try {
    await navigator.clipboard.writeText(text);
    copyButton.textContent = 'Copied';
    setTimeout(() => { copyButton.textContent = 'Copy'; }, 1200);
  } catch (error) {
    prompt('Copy API key', text);
  }
});

websiteList.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target.closest('[data-renew-form]');
  if (!form) return;

  const websiteId = form.dataset.websiteId;
  const input = form.querySelector('input[name="transaction_id"]');
  const message = form.querySelector('.renew-message');
  message.textContent = '';

  const res = await fetchJson('/api/client/subscription', {
    websiteId,
    transaction_id: input.value,
    amount: clientAdminPayment.brandOpeningFee || 60
  }, clientToken);

  if (!res.ok) {
    message.textContent = res.data.error || 'Renew failed';
    message.className = 'renew-message error-text';
    return;
  }

  message.textContent = 'Domain activated for one month.';
  message.className = 'renew-message success-text';
  input.value = '';
  await loadClientData();
});

async function showAdminDashboard() {
  setVisible('admin');
  await loadPayments();
}

async function showClientDashboard() {
  setVisible('client');
  await loadClientData();
}

async function loadPayments() {
  const search = encodeURIComponent($('#searchInput').value.trim());
  const res = await fetch(`/api/payments?page=${page}&limit=25&search=${search}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('adminToken');
    adminToken = '';
    showAuth();
    return;
  }

  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Failed to load payments');
    return;
  }

  totalPages = data.totalPages || 1;
  $('#totalCount').textContent = data.summary.count || 0;
  $('#totalAmount').textContent = formatMoney(data.summary.totalAmount || 0);
  $('#pageInfo').textContent = `Page ${data.page} of ${totalPages}`;

  paymentsBody.innerHTML = data.items.map((item) => `
    <tr>
      <td>${formatDate(item.createdAt)}</td>
      <td>${escapeHtml(item.sender || item.provider)}</td>
      <td>${escapeHtml(item.source_number || item.sourceNumber)}</td>
      <td><strong>${escapeHtml(item.transaction_id)}</strong></td>
      <td>${formatMoney(item.amount || 0)}</td>
      <td><span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'received')}</span></td>
      <td>${escapeHtml(item.usedFor || '-')}</td>
      <td class="message" title="${escapeHtml(item.raw_message || item.rawMessage)}">${escapeHtml(item.raw_message || item.rawMessage)}</td>
      <td>
        <div class="row-actions">
          <button type="button" class="tiny secondary" data-payment-id="${item.id || item._id}" data-payment-status="verified">Verify</button>
          <button type="button" class="tiny danger" data-payment-id="${item.id || item._id}" data-payment-status="rejected">Reject</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function loadClientData() {
  const res = await fetch('/api/client/me', {
    headers: { Authorization: `Bearer ${clientToken}` }
  });

  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('clientToken');
    clientToken = '';
    showAuth();
    return;
  }

  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Failed to load client');
    return;
  }

  clientWebsites = data.websites || [];
  clientAdminPayment = data.adminPayment || clientAdminPayment;
  $('#clientName').textContent = data.client?.name || 'Client';
  $('#clientEmailText').textContent = data.client?.email || '';
  renderClientStats();
  renderWebsites();
  renderApiExample();
}

function renderClientStats() {
  const active = clientWebsites.filter((site) => site.subscriptionStatus === 'active').length;
  const due = clientWebsites.length - active;
  $('#websiteCount').textContent = clientWebsites.length;
  $('#activeDomainCount').textContent = active;
  $('#monthlyDue').textContent = formatMoney(due * (clientAdminPayment.brandOpeningFee || 60));
}

function renderApiExample() {
  const first = clientWebsites[0];
  const example = {
    domain: first?.domain || 'example.com',
    transaction_id: 'CUSTOMER_TRX_ID',
    amount: 500,
    order_id: 'ORDER-1001'
  };

  $('#apiExample').textContent = JSON.stringify(example, null, 2);
}

function renderWebsites() {
  if (!clientWebsites.length) {
    websiteList.innerHTML = '<div class="empty">No websites added yet.</div>';
    return;
  }

  websiteList.innerHTML = clientWebsites.map((site) => `
    <article class="website-card">
      <div class="website-main">
        <div>
          <div class="website-title">
            <strong>${escapeHtml(site.name)}</strong>
            <span class="badge ${site.subscriptionStatus === 'active' ? 'success' : 'warning'}">${escapeHtml(site.subscriptionStatus)}</span>
          </div>
          <p class="muted">${escapeHtml(site.domain)}</p>
        </div>
        <div class="paid-date">
          <span>Paid until</span>
          <strong>${site.paidUntil ? formatDate(site.paidUntil) : 'Not active'}</strong>
        </div>
      </div>

      <div class="api-key-row">
        <code>${escapeHtml(site.apiKey)}</code>
        <button type="button" class="secondary tiny" data-copy="${escapeHtml(site.apiKey)}">Copy</button>
      </div>

      <form class="renew-form" data-renew-form data-website-id="${site.id}">
        <input name="transaction_id" placeholder="${formatMoney(site.monthlyFee || site.brandCharge || clientAdminPayment.brandOpeningFee || 60)} transaction ID" required />
        <button type="submit">Renew</button>
        <span class="renew-message" aria-live="polite"></span>
      </form>
    </article>
  `).join('');
}

async function fetchJson(url, body, token = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  let data = {};

  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }

  return { ok: response.ok, status: response.status, data };
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatMoney(value) {
  return `Tk ${Number(value || 0).toFixed(2)}`;
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function statusClass(status) {
  if (status === 'verified') return 'success';
  if (status === 'rejected') return 'danger-badge';
  return 'warning';
}

if (clientToken) {
  showClientDashboard();
} else if (adminToken) {
  showAdminDashboard();
} else {
  showAuth();
}
