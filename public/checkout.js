const configKey = 'checkoutGatewayConfig';

const fields = {
  endpoint: document.getElementById('gatewayEndpoint'),
  apiKey: document.getElementById('gatewayApiKey'),
  domain: document.getElementById('gatewayDomain'),
  orderId: document.getElementById('orderId'),
  sellerName: document.getElementById('sellerName'),
  buyerName: document.getElementById('buyerName'),
  buyerAddress: document.getElementById('buyerAddress'),
  amount: document.getElementById('paymentAmount'),
  transactionId: document.getElementById('transactionId'),
  returnUrl: document.getElementById('returnUrl'),
  configStatus: document.getElementById('configStatus'),
  configMessage: document.getElementById('configMessage'),
  paymentMessage: document.getElementById('paymentMessage'),
  response: document.getElementById('checkoutResponse'),
  summaryOrder: document.getElementById('summaryOrder'),
  summaryAmount: document.getElementById('summaryAmount'),
  summaryStatus: document.getElementById('summaryStatus')
};

let lastPayload = {};

document.getElementById('checkoutConfigForm').addEventListener('submit', (event) => {
  event.preventDefault();
  saveConfig();
});

document.getElementById('paymentVerifyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await verifyPayment();
});

document.getElementById('copyPayloadBtn').addEventListener('click', async () => {
  const text = JSON.stringify(lastPayload, null, 2);
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    prompt('Copy response', text);
  }
});

fields.orderId.addEventListener('input', updateSummary);
fields.amount.addEventListener('input', updateSummary);

function loadConfig() {
  const config = readConfig();
  fields.endpoint.value = config.endpoint || '/api/merchant/verify';
  fields.apiKey.value = config.apiKey || '';
  fields.domain.value = config.domain || '';

  if (config.apiKey && config.domain) {
    fields.configStatus.textContent = 'Saved';
    fields.configStatus.className = 'badge success';
  }
}

function readConfig() {
  try {
    return JSON.parse(localStorage.getItem(configKey) || '{}');
  } catch (error) {
    return {};
  }
}

function saveConfig() {
  const config = {
    endpoint: fields.endpoint.value.trim() || '/api/merchant/verify',
    apiKey: fields.apiKey.value.trim(),
    domain: normalizeDomain(fields.domain.value)
  };

  if (!config.apiKey || !config.domain) {
    fields.configMessage.textContent = 'API key and valid domain are required.';
    fields.configMessage.className = 'notice error-text';
    fields.configStatus.textContent = 'Unsaved';
    fields.configStatus.className = 'badge warning';
    return null;
  }

  fields.domain.value = config.domain;
  localStorage.setItem(configKey, JSON.stringify(config));
  fields.configStatus.textContent = 'Saved';
  fields.configStatus.className = 'badge success';
  fields.configMessage.textContent = 'Gateway saved.';
  fields.configMessage.className = 'notice success-text';
  return config;
}

async function verifyPayment() {
  const config = saveConfig();
  if (!config) return;

  const amount = Number(fields.amount.value);
  const transactionId = fields.transactionId.value.trim();
  const orderId = fields.orderId.value.trim();

  if (!Number.isFinite(amount) || amount <= 0 || !transactionId || !orderId) {
    setPaymentState('Amount, order ID, and transaction ID are required.', false);
    return;
  }

  const payload = {
    domain: config.domain,
    transaction_id: transactionId,
    amount,
    order_id: orderId,
    seller_name: fields.sellerName.value.trim(),
    buyer_name: fields.buyerName.value.trim(),
    buyer_address: fields.buyerAddress.value.trim(),
    return_url: fields.returnUrl.value.trim()
  };

  setPaymentState('Checking payment...', null);
  writeResponse({ request: payload, status: 'pending' });

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

    if (!response.ok || !data.success) {
      setPaymentState(data.error || 'Payment verification failed.', false);
      return;
    }

    setPaymentState(paymentVerificationMessage(data), data.status === 'pending_sms' ? null : true);
    if (data.redirectUrl) {
      fields.paymentMessage.textContent += ` Return URL: ${data.redirectUrl}`;
    }
  } catch (error) {
    writeResponse({ success: false, error: error.message });
    setPaymentState('Gateway request failed.', false);
  }
}

function setPaymentState(message, success) {
  fields.paymentMessage.textContent = message;
  fields.paymentMessage.className = success ? 'notice success-text' : success === false ? 'notice error-text' : 'notice';
  fields.summaryStatus.textContent = success ? 'Verified' : success === false ? 'Failed' : 'Pending';
}

function paymentVerificationMessage(data) {
  if (data.status === 'pending_sms') return data.message || 'Payment saved. Waiting for matching Android SMS.';
  if (data.status === 'already_verified') return 'Payment already verified.';
  if (data.status === 'manual_accepted') return 'Payment manually accepted.';
  return 'Payment verified.';
}

function writeResponse(payload) {
  lastPayload = payload;
  fields.response.textContent = JSON.stringify(payload, null, 2);
}

function updateSummary() {
  fields.summaryOrder.textContent = fields.orderId.value || 'ORDER';
  fields.summaryAmount.textContent = `Tk ${Number(fields.amount.value || 0).toFixed(2)}`;
}

function normalizeDomain(value) {
  let domain = String(value || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '');
  domain = domain.split('/')[0].split('?')[0].split('#')[0];
  domain = domain.replace(/^www\./, '').replace(/:\d+$/, '');
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain) ? domain : '';
}

fields.orderId.value = `ORDER-${Date.now().toString().slice(-6)}`;
loadConfig();
updateSummary();
writeResponse({
  success: null,
  endpoint: fields.endpoint.value,
  body: {
    domain: 'example.com',
    transaction_id: 'CUSTOMER_TRX_ID',
    amount: 500,
    order_id: fields.orderId.value
  }
});
