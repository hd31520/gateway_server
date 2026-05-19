# GatewayFlow Developer Integration Guide

Live app:

- Dashboard and developer portal: https://gateway-client-rho.vercel.app/
- Payment gateway server: use your deployed gateway URL for `widget.js`, checkout, and APIs.

This guide explains how to connect another website to GatewayFlow, open the popup payment window, verify payments, and manage subscriptions, domains, and users.

## 1. Merchant integration at a glance

1. Your website shows a Pay button.
2. Clicking the button opens the GatewayFlow popup.
3. The customer chooses bKash, Nagad, or Rocket and sends money.
4. Android forwards the payment SMS to the gateway server.
5. The server verifies the payment and returns a transaction ID.
6. Your website receives the result through callback, popup message, or server status polling.

## 2. What the merchant site needs

- Your gateway host URL.
- A website API key from the dashboard.
- A callback URL on your own domain.
- The hosted `widget.js` script from your gateway server.

## 3. Add the popup widget to your website

Plain HTML example:

```html
<script>
  window.GATEWAY_WIDGET_URL = "https://your-gateway-domain.com";
</script>
<script src="https://your-gateway-domain.com/widget.js"></script>

<button
  onclick="GatewayWidget.open({
    amount: 500,
    callback: 'https://your-merchant-site.com/payment-return',
    onComplete: (result) => console.log('payment complete', result)
  })"
>
  Pay Now
</button>
```

Next.js or React example:

```env
NEXT_PUBLIC_PAYMENT_WIDGET_URL=https://your-gateway-domain.com
```

```jsx
const gatewayUrl = process.env.NEXT_PUBLIC_PAYMENT_WIDGET_URL;

function PayButton() {
  return (
    <button
      onClick={() => {
        window.GatewayWidget.open({
          amount: 500,
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

## 4. Merchant payment verification API

Use this API when your website needs to verify a payment for a specific domain.

Request:

```http
POST /api/merchant/verify
X-API-Key: website_api_key
Content-Type: application/json
```

Body:

```json
{
  "domain": "school.example.com",
  "payer_number": "0179007328",
  "amount": 500,
  "order_id": "ORD-1001",
  "payment_time": "2026-05-19T12:30:00+06:00"
}
```

Rules:

- No customer payment reference is needed.
- The server matches `payer_number + amount + payment_time`.
- The request must use the website API key assigned to the domain.

## 5. Dashboard features

The client dashboard shows:

- Admin login and manual brand review
- Android SMS upload
- Merchant payment verify
- Client portal snapshot
- Client logout
- Create brand with auto activation
- Submit admin payment reference

## 6. Subscription, domain, and user model

GatewayFlow supports a school or multi-website setup:

- One client can buy a plan.
- The approved client can add unlimited domains on an unlimited subscription.
- Each domain can run payment collection for separate websites.
- The client admin can create dynamic users for staff, branches, or site operators.

Example workflow:

1. Admin creates or activates the client.
2. Admin grants download permission and subscription access.
3. Client adds domains from the dashboard.
4. Client creates staff users.
5. Each website uses the popup widget and its API key.

## 7. Dashboard API routes

### Admin login and manual brand review

- Method: `POST/GET/PATCH`
- Route: `/api/admin?action=login`
- Auth: admin email/password or bearer admin token
- Body: `email`, `password`, `websiteId`, `brandStatus`

### Android SMS upload

- Method: `POST`
- Route: `/api/sms`
- Auth: bearer client token
- Body: `payer_number`, `amount`, `received_at`, `sender_name`, `raw_message`, `device_id`

### Merchant payment verify

- Method: `POST`
- Route: `/api/merchant/verify`
- Auth: `X-API-Key: website_api_key`
- Body: `domain`, `payer_number`, `amount`, `order_id`, `payment_time`

### Client portal snapshot

- Method: `GET`
- Route: `/api/client/me?view=dashboard`
- Auth: bearer client token

### Client logout

- Method: `POST`
- Route: `/api/client/logout`
- Auth: bearer client token

### Create brand with auto activation

- Method: `POST`
- Route: `/api/client/websites`
- Auth: bearer client token
- Body: `name`, `domain`, `walletProvider`, `walletNumber`, `receiverName`, `transaction_id`

### Submit admin payment reference

- Method: `POST`
- Route: `/api/client/me?resource=billing`
- Auth: bearer client token
- Body: `websiteId`, `transaction_id`, `amount`, `months`

## 8. Safety notes

- Never expose admin credentials in frontend code.
- Keep API keys in the dashboard or server-side only.
- Restrict callback URLs to approved domains.
- Validate amount, phone number, and payment time before accepting a payment.
- Keep one gateway host URL per environment: development, staging, and production.

## 9. Example merchant page

```html
<script>
  window.GATEWAY_WIDGET_URL = "https://your-gateway-domain.com";
</script>
<script src="https://your-gateway-domain.com/widget.js"></script>
<button onclick="GatewayWidget.open({ amount: 500, callback: 'https://your-merchant-site.com/return' })">
  Pay Now
</button>
```
