// widget.js — hosted on gateway server
// Usage on merchant site:
// <script src="https://gateway.example.com/widget.js"></script>
// <button onclick="GatewayWidget.open({apiKey:'pg_live_xxx', domain:'example.com', amount:500, onComplete:r=>console.log(r)})">Pay</button>

(function(global){
  function getGatewayOrigin() {
    const script = document.currentScript;
    const configured = script && script.dataset && script.dataset.gatewayUrl;
    if (configured) {
      try {
        return new URL(configured, location.origin).origin;
      } catch (error) {}
    }

    if (global.GATEWAY_WIDGET_URL) {
      try {
        return new URL(global.GATEWAY_WIDGET_URL, location.origin).origin;
      } catch (error) {}
    }

    return location.origin;
  }

  function normalizeDomain(value) {
    let domain = String(value || '').trim().toLowerCase();
    domain = domain.replace(/^https?:\/\//, '').split('/')[0].split('?')[0].split('#')[0];
    domain = domain.replace(/^www\./, '').replace(/:\d+$/, '');
    return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain) ? domain : '';
  }

  function fail(opts, code, message) {
    const payload = { type: 'payment_status', status: 'failed', code, error: message };
    opts.onError && opts.onError(message, payload);
    opts.onStatus && opts.onStatus(payload);
    opts.onComplete && opts.onComplete(payload);
    if (opts.alertOnError !== false) alert(message);
    return null;
  }

  async function validateMerchantConfig(opts, gatewayOrigin) {
    const apiKey = String(opts.apiKey || opts.api_key || '').trim();
    const domain = normalizeDomain(opts.domain || location.hostname);
    const amount = Number(opts.amount || 0);

    if (!apiKey) {
      return { ok: false, code: 'missing_api_key', message: 'Gateway API key is required. Checkout popup was not opened.' };
    }
    if (!domain) {
      return { ok: false, code: 'invalid_domain', message: 'Valid merchant domain is required. Checkout popup was not opened.' };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, code: 'invalid_amount', message: 'Valid amount is required. Checkout popup was not opened.' };
    }

    const verifyUrl = new URL('/api/merchant/verify', gatewayOrigin);
    verifyUrl.searchParams.set('config', '1');
    verifyUrl.searchParams.set('domain', domain);

    try {
      const response = await fetch(verifyUrl.toString(), { headers: { 'X-API-Key': apiKey } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        return { ok: false, code: 'api_not_allowed', message: data.error || data.message || 'API key is not allowed for this domain. Checkout popup was not opened.' };
      }
      if (!data.walletNumber && !opts.receiverNumber && !opts.merchantNumber) {
        return { ok: false, code: 'missing_receiver_number', message: 'Merchant receiver number is not configured yet. Checkout popup was not opened.' };
      }
      return { ok: true, apiKey, domain, config: data };
    } catch (error) {
      return { ok: false, code: 'config_check_failed', message: error.message || 'Unable to validate gateway API key. Checkout popup was not opened.' };
    }
  }

  async function open(opts = {}){
    const width = opts.width || 520;
    const height = opts.height || 760;
    const left = Math.max(0, (screen.width - width) / 2);
    const top = Math.max(0, (screen.height - height) / 2);
    const GATEWAY_ORIGIN = getGatewayOrigin();

    const validation = await validateMerchantConfig(opts, GATEWAY_ORIGIN);
    if (!validation.ok) return fail(opts, validation.code, validation.message);

    const amount = opts.amount || 0;
    const callback = opts.callback || '';
    const url = new URL('/checkout.html', GATEWAY_ORIGIN);
    url.searchParams.set('amount', amount);
    url.searchParams.set('api_key', validation.apiKey);
    url.searchParams.set('domain', validation.domain);
    if (callback) url.searchParams.set('callback', callback);

    const queryMap = {
      orderId: 'order_id',
      sellerName: 'seller_name',
      customerName: 'customer_name',
      customerPhone: 'customer_phone',
      paymentMethod: 'payment_method',
      paymentMethods: 'payment_methods',
      receiverNumber: 'receiver_number',
      merchantNumber: 'merchant_number',
      returnUrl: 'return_url'
    };
    Object.entries(queryMap).forEach(([key, param]) => {
      const value = opts[key];
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(param, Array.isArray(value) ? value.join(',') : String(value));
      }
    });

    if (!url.searchParams.get('receiver_number') && validation.config?.walletNumber) {
      url.searchParams.set('receiver_number', validation.config.walletNumber);
    }
    if (!url.searchParams.get('payment_methods') && validation.config?.paymentMethods) {
      url.searchParams.set('payment_methods', validation.config.paymentMethods.join(','));
    }

    const popup = window.open(url.toString(), 'GatewayCheckout', `width=${width},height=${height},left=${left},top=${top}`);
    if (!popup) return fail(opts, 'popup_blocked', 'Popup was blocked by the browser.');

    function handleMessage(e){
      if (e.origin !== GATEWAY_ORIGIN) return;
      const msg = e.data || {};
      if (msg.type === 'payment_status'){
        opts.onStatus && opts.onStatus(msg);
        const finalStatuses = ['verified', 'already_verified', 'manual_accepted', 'completed', 'success', 'failed', 'cancelled'];
        if (finalStatuses.includes(String(msg.status || '').toLowerCase())) {
          opts.onComplete && opts.onComplete(msg);
          window.removeEventListener('message', handleMessage);
        }
      }
    }

    window.addEventListener('message', handleMessage);
    return { popup };
  }

  global.GatewayWidget = { open };
})(window);
