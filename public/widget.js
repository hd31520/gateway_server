// widget.js — hosted on gateway server
// Usage on merchant site:
// <script src="https://gateway.example.com/widget.js"></script>
// <button onclick="GatewayWidget.open({amount:500, callback:'https://merchant.example.com/return', onComplete: r=>console.log(r)})">Pay</button>

(function(global){
  function getGatewayOrigin() {
    const script = document.currentScript;
    const configured = script && script.dataset && script.dataset.gatewayUrl;
    if (configured) {
      try {
        return new URL(configured, location.origin).origin;
      } catch (error) {
        // Ignore invalid override and fall back below.
      }
    }

    if (global.GATEWAY_WIDGET_URL) {
      try {
        return new URL(global.GATEWAY_WIDGET_URL, location.origin).origin;
      } catch (error) {
        // Ignore invalid override and fall back below.
      }
    }

    return location.origin;
  }

  function open(opts = {}){
    const amount = opts.amount || 0;
    const callback = opts.callback || '';
    const width = opts.width || 520;
    const height = opts.height || 760;
    const left = Math.max(0, (screen.width - width) / 2);
    const top = Math.max(0, (screen.height - height) / 2);

    // Resolve gateway origin at call time so runtime overrides work
    const GATEWAY_ORIGIN = getGatewayOrigin();
    const url = new URL('/checkout.html', GATEWAY_ORIGIN);
    url.searchParams.set('amount', amount);
    if (callback) url.searchParams.set('callback', callback);
    const queryMap = {
      apiKey: 'api_key',
      domain: 'domain',
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

    const popup = window.open(url.toString(), 'GatewayCheckout', `width=${width},height=${height},left=${left},top=${top}`);
    if (!popup) {
      opts.onError && opts.onError('popup_blocked');
      return null;
    }

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
