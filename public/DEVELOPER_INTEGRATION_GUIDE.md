# GatewayFlow Developer Integration Guide

This guide shows how to connect another website to the GatewayFlow payment system, open the payment popup, verify payments from your dashboard, and manage websites, subscriptions, and users.

## 1. What you get

- A hosted payment popup (`widget.js`) that opens the gateway checkout page.
- A merchant verification API that checks payer number, amount, and payment time.
- A client dashboard for websites, brands, subscriptions, Android download, and developer docs.
- Client and admin APIs protected by JWT or API key, depending on the route.

## 2. Basic flow

1. Your website shows a Pay button.
2. Clicking the button opens the GatewayFlow popup.
3. The customer selects bKash, Nagad, or Rocket and sends money.
4. Android forwards the SMS to the gateway server.
5. The server verifies the payment and returns a transaction ID.
6. Your website receives the result through callback, popup message, or server status polling.

## 3. Widget setup on another website

Add the widget script to the merchant site:

```html
<script>
  window.GATEWAY_WIDGET_URL = "https://your-gateway-domain.com";
</script>
<script src="https://your-gateway-domain.com/widget.js"></script>
```

Open the popup from a button:

```html
<button onclick="GatewayWidget.open({
  amount: 500,
  callback: 'https://your-merchant-site.com/payment-return',
  onComplete: (result) => console.log('payment complete', result)
})">
  Pay Now
</button>
```

If you use Next.js or React, store the gateway host in:

```env
NEXT_PUBLIC_PAYMENT_WIDGET_URL=https://your-gateway-domain.com
```

Then pass it into your frontend component and open the popup using that value.

## 4. Merchant verification API

Use the merchant verification endpoint when your website receives a payer number or payment reference from the customer.

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

## 5. Dashboard checklist

From the client dashboard you can manage:

- Admin login and manual brand review
- Android SMS upload
- Merchant payment verify
- Client portal snapshot
- Client logout
- Create brand with auto activation
- Submit admin payment reference

## 6. Website, subscription, and user management

You can assign a subscription to a client, allow unlimited domains, and create dynamic users for a school or multi-website business.

### Unlimited subscription model

- A client can buy a subscription.
- A permitted client can add unlimited domains under that subscription.
- Each domain can connect to one dashboard and still handle multiple payment-enabled websites.
- A client admin can create dynamic users for staff and websites.

### Suggested internal workflow

1. Admin creates or activates a client.
2. Admin grants download permission and subscription access.
3. Client adds domains in the dashboard.
4. Client creates users for different staff or school branches.
5. Each website uses the widget and API key to verify payments.

## 7. API routes referenced in the dashboard

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
- Keep API keys on the server or in a secure dashboard only.
- Restrict callback URLs to approved domains.
- Validate amount, phone number, and payment time before accepting a payment.

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
