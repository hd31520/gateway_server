const configKey = 'checkoutGatewayConfig';
const params = new URLSearchParams(location.search);

const walletMeta = {
  bkash: { label: 'bKash', tone: 'pink', icon: 'bK', action: 'Send Money' },
  nagad: { label: 'Nagad', tone: 'orange', icon: 'Ng', action: 'Payment' },
  rocket: { label: 'Rocket', tone: 'purple', icon: 'Rk', action: 'Send Money' },
  upay: { label: 'Upay', tone: 'yellow', icon: 'Up', action: 'Payment' },
  bank: { label: 'Bank', tone: 'blue', icon: 'Bk', action: 'Transfer' },
  other: { label: 'Wallet', tone: 'green', icon: 'Pay', action: 'Payment' }
};

const fields = {
  endpoint: document.getElementById('gatewayEndpoint'),
  apiKey: document.getElementById('gatewayApiKey'),
  domain: document.getElementById('gatewayDomain'),
  orderId: document.getElementById('orderId'),
  sellerName: document.getElementById('sellerName'),
  customerName: document.getElementById('customerName'),
  payerNumber: document.getElementById('payerNumber'),
  amount: document.getElementById('paymentAmount'),
  returnUrl: document.getElementById('returnUrl'),
  response: document.getElementById('checkoutResponse')
};

const ui = {
  merchantTitle: document.getElementById('merchantTitle'),
  merchantDomain: document.getElementById('merchantDomain'),
  headerAmount: document.getElementById('headerAmount'),
  walletGrid: document.getElementById('walletGrid'),
  walletHero: document.getElementById('walletHero'),
  receiverNumberText: document.getElementById('receiverNumberText'),
  tutorialOne: document.getElementById('tutorialOne'),
  tutorialTwo: document.getElementById('tutorialTwo'),
  tutorialThree: document.getElementById('tutorialThree'),
  waitingText: document.getElementById('waitingText'),
  countdownText: document.getElementById('countdownText'),
  successText: document.getElementById('successText'),
  failedText: document.getElementById('failedText'),
  configMessage: document.getElementById('configMessage')
};

const steps = {
  methods: document.getElementById('stepMethods'),
  phone: document.getElementById('stepPhone'),
  instructions: document.getElementById('stepInstructions'),
  waiting: document.getElementById('stepWaiting'),
  success: document.getElementById('stepSuccess'),
  failed: document.getElementById('stepFailed')
};

let selectedWallet = null;
let lastPayload = {};
let pollTimer = null;
let countdownTimer = null;
let countdown = 120;
let remoteWallets = [];

document.getElementById('checkoutConfigForm').addEventListener('submit', (event) => {
  event.preventDefault();
  saveConfig();
});
document.getElementById('methodNextBtn').addEventListener('click', () => showStep('phone'));
document.getElementById('phoneBackBtn').addEventListener('click', () => showStep('methods'));
document.getElementById('phoneNextBtn').addEventListener('click', () => {
  if (!normalizePhone(fields.payerNumber.value)) return alert('Enter the sender wallet number');
  fields.payerNumber.value = normalizePhone(fields.payerNumber.value);
  updateInstructionCopy();
  showStep('instructions');
});
document.getElementById('paidBtn').addEventListener('click', submitPayment);
document.getElementById('tryAgainBtn').addEventListener('click', () => showStep('methods'));
document.getElementById('doneBtn').addEventListener('click', () => window.close());
document.getElementById('copyReceiverBtn').addEventListener('click', () => {
  if (!selectedWallet?.number) return alert('Merchant receiver number is not configured yet.');
  return copyText(selectedWallet.number);
});
fields.payerNumber.addEventListener('input', () => {
  fields.payerNumber.value = fields.payerNumber.value.replace(/\D/g, '');
});
fields.amount.addEventListener('input', updateSummary);

function boot() {
  const stored = readConfig();
  const queryConfig = {
    endpoint: params.get('endpoint') || params.get('verify_endpoint'),
    apiKey: params.get('api_key') || params.get('apiKey'),
    domain: params.get('domain'),
    orderId: params.get('order_id') || params.get('orderId'),
    sellerName: params.get('seller_name') || params.get('sellerName'),
    customerName: params.get('customer_name') || params.get('customerName'),
    payerNumber: params.get('customer_phone') || params.get('customerPhone') || params.get('payer_number') || params.get('payerNumber'),
    amount: params.get('amount'),
    returnUrl: params.get('callback') || params.get('return_url') || params.get('returnUrl')
  };

  fields.endpoint.value = queryConfig.endpoint || stored.endpoint || '/api/merchant/verify';
  fields.apiKey.value = queryConfig.apiKey || stored.apiKey || '';
  fields.domain.value = normalizeDomain(queryConfig.domain || stored.domain || '');
  fields.orderId.value = queryConfig.orderId || `ORDER-${Date.now().toString().slice(-6)}`;
  fields.sellerName.value = queryConfig.sellerName || stored.sellerName || '';
  fields.customerName.value = queryConfig.customerName || '';
  fields.payerNumber.value = normalizePhone(queryConfig.payerNumber || '');
  fields.amount.value = queryConfig.amount || stored.amount || '500';
  fields.returnUrl.value = queryConfig.returnUrl || stored.returnUrl || '';

  renderWallets();
  updateSummary();
  fetchMerchantConfig();
  writeResponse({
    success: null,
    message: 'Ready. Select wallet, enter sender number, then wait for Android SMS match.',
    verifyEndpoint: fields.endpoint.value,
    requiredMatch: ['payer_number', 'amount', 'payment_time']
  });
}

function walletOptions() {
  if (remoteWallets.length) return remoteWallets;
  const rawMethods = (params.get('methods') || params.get('payment_methods') || params.get('paymentMethods') || params.get('payment_method') || params.get('paymentMethod') || 'bkash')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const receiver = params.get('receiver_number') || params.get('receiverNumber') || params.get('merchant_number') || params.get('merchantNumber') || '';
  return rawMethods.map((provider, index) => {
    const meta = walletMeta[provider] || walletMeta.other;
    return {
      id: `${provider}-${index}`,
      provider,
      number: normalizePhone(params.get(`${provider}_number`) || receiver),
      ...meta
    };
  });
}

function renderWallets() {
  const wallets = walletOptions();
  selectedWallet = wallets[0] || { provider: 'bkash', number: '', ...walletMeta.bkash };
  ui.walletGrid.innerHTML = wallets.map((wallet, index) => `
    <button type="button" class="gateway-wallet-option ${index === 0 ? 'active' : ''}" data-wallet="${wallet.id}">
      <span class="wallet-icon ${wallet.tone}">${wallet.icon}</span>
      <strong>${escapeHtml(wallet.label)}</strong>
      <small>${escapeHtml(wallet.number || 'Number from merchant portal')}</small>
    </button>
  `).join('');
  ui.walletGrid.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      selectedWallet = wallets.find((wallet) => wallet.id === button.dataset.wallet) || selectedWallet;
      ui.walletGrid.querySelectorAll('button').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      updateWalletHero();
      showStep('phone');
    });
  });
  updateWalletHero();
}

function updateWalletHero() {
  ui.walletHero.innerHTML = `
    <span class="wallet-icon large ${selectedWallet.tone}">${selectedWallet.icon}</span>
    <div><strong>${escapeHtml(selectedWallet.label)} ${escapeHtml(selectedWallet.action)}</strong><small>${escapeHtml(fields.domain.value || 'Merchant website')}</small></div>
    <b>${formatMoney(fields.amount.value)}</b>
  `;
  ui.receiverNumberText.textContent = selectedWallet.number || 'Use merchant configured number';
  updateInstructionCopy();
}

async function fetchMerchantConfig() {
  const apiKey = fields.apiKey.value.trim();
  const domain = normalizeDomain(fields.domain.value);
  if (!apiKey || !domain) return;

  try {
    const configUrl = new URL(fields.endpoint.value.trim() || '/api/merchant/verify', location.origin);
    configUrl.searchParams.set('config', '1');
    configUrl.searchParams.set('domain', domain);
    const response = await fetch(configUrl.toString(), { headers: { 'X-API-Key': apiKey } });
    const data = await response.json();
    if (!response.ok || !data.success) {
      writeResponse({ httpStatus: response.status, ...data });
      return;
    }

    const provider = String(data.walletProvider || 'bkash').toLowerCase();
    const meta = walletMeta[provider] || walletMeta.other;
    remoteWallets = [{
      id: `${provider}-remote`,
      provider,
      number: normalizePhone(data.walletNumber || ''),
      ...meta
    }];
    fields.domain.value = data.domain || domain;
    if (!fields.sellerName.value && data.merchantName) fields.sellerName.value = data.merchantName;
    renderWallets();
    updateSummary();
    writeResponse({
      success: true,
      message: 'Merchant wallet loaded from GatewayFlow.',
      domain: data.domain,
      walletProvider: data.walletProvider,
      walletNumber: data.walletNumber || ''
    });
  } catch (error) {
    writeResponse({ success: false, error: error.message });
  }
}

function updateInstructionCopy() {
  const walletName = selectedWallet?.label || 'wallet';
  const action = selectedWallet?.action || 'Payment';
  ui.tutorialOne.textContent = `Open ${walletName} app and choose ${action}.`;
  ui.tutorialTwo.textContent = `Send exactly ${formatMoney(fields.amount.value)} to ${selectedWallet?.number || 'the merchant number'}.`;
  ui.tutorialThree.textContent = `GatewayFlow Android matches sender ${normalizePhone(fields.payerNumber.value) || '01XXXXXXXXX'}, exact amount, and SMS receive time.`;
}

async function submitPayment() {
  const config = saveConfig();
  if (!config) return;
  const payerNumber = normalizePhone(fields.payerNumber.value);
  const amount = Number(fields.amount.value);
  if (!payerNumber || !Number.isFinite(amount) || amount <= 0 || !fields.orderId.value.trim()) {
    return fail('Sender number, order ID, and valid amount are required.');
  }
  if (!selectedWallet?.number) {
    return fail('Merchant receiver number is not configured. Add the brand wallet number in GatewayFlow portal or pass receiverNumber to GatewayWidget.open().');
  }

  const payload = {
    domain: config.domain,
    payer_number: payerNumber,
    amount,
    order_id: fields.orderId.value.trim(),
    seller_name: fields.sellerName.value.trim(),
    buyer_name: fields.customerName.value.trim(),
    return_url: fields.returnUrl.value.trim(),
    payment_method: selectedWallet.provider,
    receiver_number: selectedWallet.number,
    payment_time: new Date().toISOString()
  };

  showStep('waiting');
  startCountdown();
  writeResponse({ request: payload, status: 'submitting' });

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    writeResponse({ httpStatus: response.status, ...data });
    if (!response.ok || !data.success) return fail(data.error || 'Payment verification failed.');
    if (['verified', 'already_verified', 'manual_accepted'].includes(data.status)) return succeed(data);
    const requestId = data.pendingVerification?.id;
    if (!requestId) return fail('Pending request was not created.');
    notifyParent({
      type: 'payment_status',
      status: 'pending_sms',
      requestId,
      amount,
      orderId: fields.orderId.value.trim(),
      payerNumber,
      message: data.message || 'Waiting for matching Android SMS.'
    });
    pollStatus(requestId, config);
  } catch (error) {
    fail(error.message || 'Gateway request failed.');
  }
}

function pollStatus(requestId, config) {
  clearInterval(pollTimer);
  let pollAttempt = 0;
  const maxAttempts = 150; // 150 attempts × 2 seconds = 300 seconds (5 minutes)
  const maxRetries = 4;
  let consecutiveFailures = 0;

  async function doPoll() {
    pollAttempt++;
    const statusUrl = new URL(config.endpoint, location.origin);
    statusUrl.searchParams.set('request_id', requestId);
    
    try {
      const response = await fetch(statusUrl.toString(), { headers: { 'X-API-Key': config.apiKey } });
      const data = await response.json();
      
      writeResponse({ 
        httpStatus: response.status, 
        pollAttempt, 
        ...data 
      });

      if (response.ok && ['verified', 'already_verified', 'manual_accepted'].includes(data.status)) {
        succeed(data);
        return;
      }

      // Success response but still pending
      if (response.ok && data.status === 'pending_sms') {
        consecutiveFailures = 0; // Reset on successful response
      }
      
      // Check if max attempts reached
      if (pollAttempt >= maxAttempts) {
        fail(`No matching Android SMS arrived within 5 minutes. (${pollAttempt} poll attempts made)`);
        return;
      }
    } catch (error) {
      consecutiveFailures++;
      writeResponse({ 
        success: false, 
        error: error.message,
        pollAttempt,
        consecutiveFailures
      });

      // If too many consecutive failures (4+), bail out
      if (consecutiveFailures > maxRetries) {
        fail(`Network error after ${consecutiveFailures} attempts. Payment cancelled.`);
        return;
      }
    }
  }

  // Poll every 2 seconds
  pollTimer = setInterval(doPoll, 2000);
}

function succeed(data) {
  clearTimers();
  ui.successText.textContent = data.message || 'Server confirmed the matching SMS payment.';
  showStep('success');
  notifyParent({ type: 'payment_status', status: 'verified', amount: Number(fields.amount.value), orderId: fields.orderId.value, verification: data.verification || null });
  redirectReturn('completed', data);
}

function fail(message) {
  clearTimers();
  ui.failedText.textContent = message;
  showStep('failed');
  notifyParent({ type: 'payment_status', status: 'failed', error: message, orderId: fields.orderId.value });
}

function startCountdown() {
  countdown = 300;
  ui.countdownText.textContent = '5:00';
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    countdown -= 1;
    ui.countdownText.textContent = `${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')}`;
    if (countdown <= 0) fail('No matching Android SMS arrived within 5 minutes.');
  }, 1000);
}

function clearTimers() {
  clearInterval(pollTimer);
  clearInterval(countdownTimer);
}

function saveConfig() {
  const config = {
    endpoint: fields.endpoint.value.trim() || '/api/merchant/verify',
    apiKey: fields.apiKey.value.trim(),
    domain: normalizeDomain(fields.domain.value),
    amount: fields.amount.value,
    returnUrl: fields.returnUrl.value.trim(),
    sellerName: fields.sellerName.value.trim()
  };
  if (!config.apiKey || !config.domain) {
    ui.configMessage.textContent = 'Website API key and valid domain are required.';
    return null;
  }
  fields.domain.value = config.domain;
  localStorage.setItem(configKey, JSON.stringify(config));
  ui.configMessage.textContent = 'Gateway config saved.';
  return config;
}

function readConfig() {
  try { return JSON.parse(localStorage.getItem(configKey) || '{}'); } catch { return {}; }
}

function showStep(name) {
  Object.values(steps).forEach((step) => step.classList.add('hidden'));
  steps[name].classList.remove('hidden');
}

function updateSummary() {
  ui.headerAmount.textContent = formatMoney(fields.amount.value);
  ui.merchantTitle.textContent = fields.sellerName.value || fields.domain.value || 'Merchant payment';
  ui.merchantDomain.textContent = fields.domain.value ? `${fields.domain.value} - no TrxID required` : 'No TrxID required';
  updateWalletHero();
}

function redirectReturn(status, data) {
  const returnUrl = fields.returnUrl.value.trim();
  if (!returnUrl) return;
  try {
    const url = new URL(returnUrl);
    url.searchParams.set('status', status);
    url.searchParams.set('order_id', fields.orderId.value);
    url.searchParams.set('amount', String(Number(fields.amount.value || 0).toFixed(2)));
    const ref = data?.verification?.payment_ref || data?.verification?.transaction_id || '';
    if (ref) url.searchParams.set('payment_ref', ref);
    setTimeout(() => { location.href = url.toString(); }, 900);
  } catch {
    // Ignore invalid return URL.
  }
}

function notifyParent(message) {
  try { window.opener && window.opener.postMessage(message, '*'); } catch {}
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch { prompt('Copy this value', text); }
}

function writeResponse(payload) {
  lastPayload = payload;
  fields.response.textContent = JSON.stringify(lastPayload, null, 2);
}

function normalizePhone(raw) {
  let value = String(raw || '').trim().replace(/[^0-9+]/g, '');
  if (value.startsWith('+880')) value = `0${value.slice(4)}`;
  if (value.startsWith('880')) value = `0${value.slice(3)}`;
  if (!value.startsWith('0') && value.length === 10 && value.startsWith('1')) value = `0${value}`;
  return value;
}

function normalizeDomain(value) {
  let domain = String(value || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').split('/')[0].split('?')[0].split('#')[0];
  domain = domain.replace(/^www\./, '').replace(/:\d+$/, '');
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain) ? domain : '';
}

function formatMoney(value) {
  return `Tk ${Number(value || 0).toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

boot();
