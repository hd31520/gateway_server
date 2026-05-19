# GatewayFlow Developer Integration Guide

Live links:

- Merchant portal: https://gateway-client-rho.vercel.app/
- Portal route map: https://gateway-client-rho.vercel.app/portal
- Payment gateway server: use your deployed gateway host for `widget.js`, checkout, and APIs. Live widget URL: `https://payment-gateway-server-ten.vercel.app/widget.js`.

This guide is written for merchants and developers who want to embed GatewayFlow into another website, verify payments automatically, and manage plans, domains, and staff users from the portal.

## 1. What the flow looks like

1. Your website shows a Pay button.
2. The button opens the GatewayFlow popup.
3. The customer selects bKash, Nagad, Rocket, or another configured wallet.
4. The Android app forwards the payment SMS to the gateway server.
5. The gateway server matches sender number, amount, and time.
6. Your website receives the result through callback, popup completion, or server polling.

## 2. What you need before integrating

- A GatewayFlow server URL. The live server used in the examples below is `https://payment-gateway-server-ten.vercel.app`.
- A website API key from the merchant portal.
- A callback URL on your own domain.
- The hosted `widget.js` script from your gateway server.

### Which URL goes in the widget?

Use the gateway server host, not the merchant website URL:

- Production script URL: `https://payment-gateway-server-ten.vercel.app/widget.js`
- Production gateway origin: `https://payment-gateway-server-ten.vercel.app`
- Local script URL: `http://localhost:3000/widget.js`
- Local gateway origin: `http://localhost:3000`

`<script src=".../widget.js">` needs the full script URL. `window.GATEWAY_WIDGET_URL` or `data-gateway-url` needs only the origin without `/widget.js`.

## 3. Merchant portal route map

The client portal uses real routes, so sections can be opened directly and refreshed without losing the selected menu.

### Portal sections

| Section | Route |
| --- | --- |
| Dashboard | `/portal` |
| Add Funds | `/portal/add-funds` |
| Payment Link | `/portal/payment-link` |
| Transactions | `/portal/transactions` |
| Invoice | `/portal/invoice` |
| Data | `/portal/data` |
| Brands | `/portal/brands` |
| Devices | `/portal/devices` |
| Payment Settings | `/portal/payment-settings` |
| Others | `/portal/others` |
| Affiliates | `/portal/affiliates` |
| Support Tickets | `/portal/support-tickets` |
| Plans | `/portal/plans` |
| My Plan | `/portal/my-plan` |
| Currency | `/portal/currency` |
| Android App | `/portal/android-app` |
| Home Page | `/portal/home-page` |
| SMS List | `/portal/sms-list` |
| Developer Docs | `/portal/developer-docs` |
| Our Support | `/portal/our-support` |

### Admin sections

| Section | Route |
| --- | --- |
| Overview | `/admin` |
| Brand Requests | `/admin/brand-requests` |
| Billing Requests | `/admin/billing-requests` |
| Merchant Verify | `/admin/merchant-verify` |
| Payments | `/admin/payments` |
| History | `/admin/history` |
| Clients | `/admin/clients` |
| Devices | `/admin/devices` |
| Support | `/admin/support` |
| Settings | `/admin/settings` |

## 4. Add the popup widget to your site

### Plain HTML

```html
<script>
  window.GATEWAY_WIDGET_URL = "https://payment-gateway-server-ten.vercel.app";
</script>
<script src="https://payment-gateway-server-ten.vercel.app/widget.js"></script>

<button
  onclick="GatewayWidget.open({
    apiKey: 'website_api_key',
    domain: 'your-merchant-site.com',
    amount: 500,
    orderId: 'ORD-1001',
    sellerName: 'My Shop',
    customerName: 'John Doe',
    paymentMethods: ['bkash', 'nagad'],
    receiverNumber: '017XXXXXXXX', // optional when brand wallet number is saved in GatewayFlow
    callback: 'https://your-merchant-site.com/payment-return',
    onComplete: (result) => console.log('payment complete', result)
  })"
>
  Pay Now
</button>
```

### Next.js or React

```env
NEXT_PUBLIC_PAYMENT_WIDGET_URL=https://payment-gateway-server-ten.vercel.app
NEXT_PUBLIC_PAYMENT_WIDGET_SCRIPT=https://payment-gateway-server-ten.vercel.app/widget.js
```

```jsx
function PayButton() {
  return (
    <button
      onClick={() => {
        window.GatewayWidget.open({
          apiKey: process.env.NEXT_PUBLIC_GATEWAY_WEBSITE_API_KEY,
          domain: 'your-merchant-site.com',
          amount: 500,
          orderId: 'ORD-1001',
          paymentMethods: ['bkash', 'nagad'],
          receiverNumber: '017XXXXXXXX', // optional when brand wallet number is saved
          callback: 'https://your-merchant-site.com/payment-return',
          onComplete: (result) => console.log(result)
        });
      }}
    >
      Pay Now
    </button>
  );
}
```

### Recommended popup payload

```js
{
  apiKey: 'website_api_key',
  domain: 'your-merchant-site.com',
  amount: 500,
  callback: 'https://your-merchant-site.com/payment-return',
  orderId: 'ORD-1001',
  customerName: 'John Doe',
  customerPhone: '0179007328',
  paymentMethods: ['bkash', 'nagad'],
  receiverNumber: '017XXXXXXXX', // optional when brand wallet number is saved
  onComplete: (result) => {
    console.log(result);
  }
}
```

## 5. Merchant payment verification API

Use this API when your own server needs to verify a payment for a specific domain.

### Request

```http
POST /api/merchant/verify
X-API-Key: website_api_key
Content-Type: application/json
```

### Body

```json
{
  "domain": "school.example.com",
  "payer_number": "0179007328",
  "amount": 500,
  "order_id": "ORD-1001",
  "payment_time": "2026-05-19T12:30:00+06:00"
}
```

### Rules

- No customer payment reference is needed.
- The server matches `payer_number + amount + payment_time`.
- The request must use the website API key assigned to the domain.
- If the response status is `pending_sms`, poll `GET /api/merchant/verify?request_id=...` with the same `X-API-Key` until Android SMS confirms it or the popup reaches the 2-minute timeout.

## 6. Common server routes

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/payment/gateway/initiate` | Start a popup payment session |
| `POST` | `/api/payment/gateway/verify-sms` | Verify Android SMS payload |
| `GET` | `/api/payment/gateway/status/:paymentId` | Check payment status |
| `POST` | `/api/payment/gateway/cancel/:paymentId` | Cancel a pending payment |
| `POST` | `/api/merchant/verify` | Verify a merchant payment by domain |
| `GET` | `/api/merchant/verify?request_id=...` | Poll a pending no-TrxID merchant payment |
| `GET` | `/api/client/me?view=dashboard` | Load portal dashboard snapshot |
| `PATCH` | `/api/client/me?resource=settings` | Save client settings |
| `POST` | `/api/client/me?resource=support` | Create a support ticket |
| `POST` | `/api/client/websites` | Add a new brand/domain |
| `POST` | `/api/client/subscription` | Manage client subscription |
| `POST` | `/api/client/logout` | Log out the merchant session |
| `POST` | `/api/admin` | Admin login and management actions |
| `PATCH` | `/api/admin` | Update admin-controlled records |
| `POST` | `/api/sms` | Android SMS upload/forwarding |
| `GET` | `/api/apk/download` | Protected Android APK download |

## 7. Subscription, domain, and user model

GatewayFlow supports a multi-website setup:

- One client can buy a plan.
- Approved clients can add unlimited domains on an unlimited subscription.
- Each domain can run payment collection for a separate website.
- Client admins can create staff users for branches, teams, or operators.

Suggested workflow:

1. Admin creates or activates the client.
2. Admin grants download permission and subscription access.
3. Client adds domains from the portal.
4. Client creates staff users.
5. Each website uses the popup widget and its API key.

## 8. Security notes

- Never expose admin credentials in frontend code.
- Keep API keys server-side or in the dashboard only.
- Restrict callback URLs to approved domains.
- Validate amount, phone number, and payment time before accepting a payment.
- Keep one gateway host URL per environment: development, staging, and production.

## 9. Troubleshooting

- If a popup does not open, confirm `window.GATEWAY_WIDGET_URL` or the script source is set correctly. The widget now resolves the gateway origin when `GatewayWidget.open()` is called, so a runtime override (`window.GATEWAY_WIDGET_URL`) works even if set after `widget.js` is loaded - just ensure the value is a valid origin (e.g. `https://your-gateway.example.com`).
- If verification fails, compare sender number formatting and the exact amount.
- If the popup stays pending, make sure the Android app is logged in, SMS permission is enabled, and the received SMS contains the same sender number and exact amount.
- If a route looks blank after refresh, use the portal route directly, such as `/portal/transactions`.
- If an APK download is blocked, confirm the client has download permission.

## 10. Example merchant page

```html
<script>
  window.GATEWAY_WIDGET_URL = "https://payment-gateway-server-ten.vercel.app";
</script>
<script src="https://payment-gateway-server-ten.vercel.app/widget.js"></script>
<button onclick="GatewayWidget.open({
  apiKey: 'website_api_key',
  domain: 'your-merchant-site.com',
  amount: 500,
  orderId: 'ORD-1001',
  paymentMethods: ['bkash', 'nagad'],
  receiverNumber: '017XXXXXXXX',
  callback: 'https://your-merchant-site.com/return'
})">
  Pay Now
</button>
```
