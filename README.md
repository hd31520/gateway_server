# Payment Gateway Server - Vercel + MongoDB

This project receives payment SMS data from your Android app, saves it in MongoDB, and provides:

- Admin dashboard for SMS payment records.
- Client register/login web app.
- Multiple website/domain support per client.
- Tk 60 monthly activation per domain.
- Merchant API verification by `transaction_id` and `amount`.

## Run locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Environment variables

Add these in Vercel Project Settings > Environment Variables, and also in local `.env` if you run locally:

```text
MONGODB_URI
MONGODB_DB
ANDROID_API_TOKEN
JWT_SECRET
ADMIN_EMAIL
ADMIN_PASSWORD_HASH or ADMIN_PASSWORD
ADMIN_BKASH_NUMBER
ADMIN_NAGAD_NUMBER
CORS_ORIGINS
```

Do not use values from `.env.example` directly. `JWT_SECRET` and `ANDROID_API_TOKEN` should be long random strings. In production, set `CORS_ORIGINS` to the exact client origins that may call the API, for example `https://client.example.com,https://admin.example.com`.

## Android SMS endpoint

The Android app logs in as a client and sends received payment SMS data here:

```text
POST /api/sms
```

Headers:

```text
Content-Type: application/json
Authorization: Bearer CLIENT_LOGIN_TOKEN
```

`ANDROID_API_TOKEN` is still supported for controlled server-to-server or legacy Android submitters, but the client login token is the recommended path.

Body:

```json
{
  "sender": "bKash",
  "source_number": "16247",
  "transaction_id": "ABC123456",
  "amount": "500.00",
  "raw_message": "You have received Tk 500.00. TrxID ABC123456"
}
```

Duplicate `transaction_id` values are blocked.

## Admin dashboard

Open `/`, choose Admin, and login with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

Admin can search payment records and mark them `verified` or `rejected`.

## Client dashboard

Open `/`, choose Client, then register or login.

Clients can:

- Add multiple websites/domains.
- Copy the API key for each domain.
- Submit a Tk 60 subscription transaction ID to activate a domain for one month.
- Open `/checkout.html` to test a merchant checkout client.

The Tk 60 transaction must already exist in the `payments` collection from the Android SMS endpoint.

## Merchant payment verification API

Merchant websites verify customer payments by transaction ID and amount:

```text
POST /api/merchant/verify
```

The included checkout client is available at:

```text
/checkout.html
```

Headers:

```text
Content-Type: application/json
X-API-Key: WEBSITE_API_KEY
```

Body:

```json
{
  "domain": "example.com",
  "transaction_id": "CUSTOMER_TRX_ID",
  "amount": 500,
  "order_id": "ORDER-1001"
}
```

Success response:

```json
{
  "success": true,
  "status": "verified",
  "verification": {
    "id": "verification_id",
    "transaction_id": "CUSTOMER_TRX_ID",
    "amount": 500,
    "order_id": "ORDER-1001",
    "verifiedAt": "2026-04-28T00:00:00.000Z"
  }
}
```

Rules:

- The domain must be active with monthly Tk 60 paid.
- The API key must belong to that domain.
- The `transaction_id` and `amount` must match an unused Android SMS payment.
- A transaction ID can only be used once.
- Manual acceptance is disabled by default. Only enable `ALLOW_MANUAL_MERCHANT_ACCEPT=true` if you intentionally accept the fraud risk.

## Deploy to Vercel

```bash
npm install
vercel login
vercel
```

Dashboard URL:

```text
https://YOUR-VERCEL-PROJECT.vercel.app
```

Android API URL:

```text
https://YOUR-VERCEL-PROJECT.vercel.app/api/sms
```

Merchant verify URL:

```text
https://YOUR-VERCEL-PROJECT.vercel.app/api/merchant/verify
```

## Security notes

- Do not publish `ANDROID_API_TOKEN`, `JWT_SECRET`, or website API keys publicly.
- Use a long random `JWT_SECRET`.
- Prefer `ADMIN_PASSWORD_HASH` over a plain `ADMIN_PASSWORD`.
- Do not commit real `.env` values or MongoDB credentials.
- Keep merchant verification on the merchant server when possible; browser checkout demos expose website API keys.
- Merchant verification should ideally be called from the merchant server, not public browser JavaScript.
- Make sure users consent to SMS access and data forwarding.
