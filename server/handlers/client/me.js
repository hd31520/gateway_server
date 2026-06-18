import { ObjectId } from 'mongodb';
import { getDb } from '../_db.js';
import { requireClient } from '../_auth.js';
import { getAdminConfig } from '../_admin.js';
import {
  activateWebsiteFromAdminPayment,
  normalizePayerNumber,
  normalizeTransactionId,
  paymentTimeWindow,
  upsertBillingRequest
} from '../_billing.js';
import { clientSmsPaymentFilter } from '../_merchant_verification.js';
import {
  BRAND_OPENING_FEE,
  WEBSITE_PLAN_TIERS,
  cleanString,
  computePlanTotalAmount,
  defaultClientSettings,
  getAndroidAppDownloadUrl,
  isWebsiteActive,
  normalizeBillingMonths,
  normalizePublicUrl,
  publicServerError,
  serializeClient,
  serializeBillingRequest,
  serializeDevice,
  serializeMerchantVerification,
  serializePayment,
  serializeRenewal,
  serializeSettings,
  serializeTicket,
  serializeVerification,
  serializeWebsite
} from '../_utils.js';
import { safeRequestBody } from '../_utils.js';

const plans = WEBSITE_PLAN_TIERS;

const merchantGuide = {
  title: 'GatewayFlow integration - simple guide',
  subtitle: 'এই ধাপগুলো follow করলে যেকোনো website-এ GatewayFlow payment popup সহজে চালু করা যাবে। Customer TrxID দেবে না; system sender number, exact amount, আর SMS receive time match করবে।',
  gatewayUrl: 'https://payment-gateway-server-ten.vercel.app',
  widgetUrl: 'https://payment-gateway-server-ten.vercel.app/widget.js',
  localGatewayUrl: 'http://localhost:3000',
  localWidgetUrl: 'http://localhost:3000/widget.js',
  steps: [
    {
      step: '01',
      title: 'Brand active করুন',
      text: 'Portal থেকে Brands/My Plan section-এ আপনার website domain add করুন। Brand active হলে ওই domain-এর API key পাবেন।'
    },
    {
      step: '02',
      title: 'API key copy করুন',
      text: 'Website credentials card থেকে API key copy করুন। এই key widget popup এবং server verify API-তে ব্যবহার হবে।'
    },
    {
      step: '03',
      title: 'Widget URL বসান',
      text: 'আপনার website HTML/React layout-এ gateway server-এর widget.js script include করুন। Production URL: https://payment-gateway-server-ten.vercel.app/widget.js'
    },
    {
      step: '04',
      title: 'Pay button connect করুন',
      text: 'Button click হলে GatewayWidget.open(...) call করুন। এখানে apiKey, domain, amount, orderId, receiverNumber, paymentMethods পাঠাবেন।'
    },
    {
      step: '05',
      title: 'Android app চালু রাখুন',
      text: 'Merchant Android app login করা থাকবে এবং SMS permission enabled থাকবে। SMS এলে app server-এ payer number ও amount পাঠাবে।'
    },
    {
      step: '06',
      title: 'Success/Fail handle করুন',
      text: 'Matching SMS এলে popup success দেখাবে। ২ মিনিটের মধ্যে SMS না এলে failed দেখাবে। callback URL-এ status পাঠানো হবে।'
    }
  ],
  snippet: [
    'window.GATEWAY_WIDGET_URL = "https://payment-gateway-server-ten.vercel.app";',
    '<script src="https://payment-gateway-server-ten.vercel.app/widget.js"></script>',
    'GatewayWidget.open({',
    '  apiKey: "website_api_key",',
    '  domain: "your-site.com",',
    '  amount: 500,',
    '  orderId: "ORD-1001",',
    '  paymentMethods: ["bkash", "nagad"],',
    '  receiverNumber: "017XXXXXXXX",',
    '  callback: "https://your-site.com/payment-return"',
    '})'
  ],
  verifySnippet: [
    'POST https://payment-gateway-server-ten.vercel.app/api/merchant/verify',
    'Header: X-API-Key: website_api_key',
    '{',
    '  "domain": "your-site.com",',
    '  "payer_number": "0179007328",',
    '  "amount": 500,',
    '  "order_id": "ORD-1001",',
    '  "payment_time": "2026-05-20T12:30:00+06:00"',
    '}'
  ],
  checklist: [
    'Widget URL হবে gateway server-এর URL, merchant website URL না।',
    'Customer TrxID দেবে না। শুধু sender wallet number দেবে।',
    'Sender number + exact amount + payment time একসাথে match হতে হবে।',
    'Android app login এবং SMS permission enabled থাকতে হবে।',
    'Callback URL আপনার নিজের website/domain-এর হওয়া উচিত।',
    'পেমেন্ট উইজেট খোলার পূর্বে অবশ্যই সঠিক apiKey, domain এবং amount পাস করতে হবে, অন্যথায় পপআপ ব্লক হবে।'
  ]
};

const docs = [
  {
    title: 'Full developer integration guide',
    method: 'READ',
    path: '/DEVELOPER_INTEGRATION_GUIDE.md',
    auth: 'Public guide for merchants',
    body: ['widget.js', 'callback', 'merchant verify', 'subscription', 'domains'],
    url: '/DEVELOPER_INTEGRATION_GUIDE.md'
  },
  {
    title: 'Widget popup script',
    method: 'GET',
    path: '/widget.js',
    auth: 'Public script',
    body: ['apiKey', 'domain', 'amount', 'orderId', 'paymentMethods', 'receiverNumber', 'callback']
  },
  {
    title: 'Android SMS upload',
    method: 'POST',
    path: '/api/sms',
    auth: 'Bearer client_token',
    body: ['payer_number', 'amount', 'received_at', 'sender_name', 'raw_message', 'device_id']
  },
  {
    title: 'Merchant payment verify',
    method: 'POST',
    path: '/api/merchant/verify',
    auth: 'X-API-Key: website_api_key',
    body: ['domain', 'payer_number', 'amount', 'order_id', 'payment_time']
  },
  {
    title: 'Poll pending merchant payment',
    method: 'GET',
    path: '/api/merchant/verify?request_id=...',
    auth: 'X-API-Key: website_api_key',
    body: []
  },
  {
    title: 'Client portal snapshot',
    method: 'GET',
    path: '/api/client/me?view=dashboard',
    auth: 'Bearer client_token',
    body: []
  },
  {
    title: 'Client logout',
    method: 'POST',
    path: '/api/client/logout',
    auth: 'Bearer client_token',
    body: []
  },
  {
    title: 'Create brand with auto activation',
    method: 'POST',
    path: '/api/client/websites',
    auth: 'Bearer client_token',
    body: ['name', 'domain', 'walletProvider', 'walletNumber', 'receiverName', 'transaction_id']
  },
  {
    title: 'Submit admin payment reference',
    method: 'POST',
    path: '/api/client/me?resource=billing',
    auth: 'Bearer client_token',
    body: ['websiteId', 'transaction_id', 'amount', 'months']
  }
];

export default async function handler(req, res) {
  const auth = await requireClient(req, res);
  if (!auth) return;
  if (!ObjectId.isValid(auth.id)) {
    return res.status(401).json({ success: false, error: 'Client login required' });
  }

  try {
    const db = await getDb();
    const body = safeRequestBody(req, res);
    if (body === null) return;
    const clientId = new ObjectId(auth.id);
    const resource = String(req.query?.resource || '').trim().toLowerCase();

    if (resource === 'settings') return handleSettings(req, res, db, clientId);
    if (resource === 'support') return handleSupport(req, res, db, clientId);
    if (resource === 'billing') return handleBilling(req, res, db, clientId);

    if (req.method !== 'GET') {
      return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    return sendDashboard(res, db, clientId);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

async function sendDashboard(res, db, clientId) {
  const now = new Date();
  const [client, websites, payments, verifications, renewals, billingRequests, devices, settings, tickets, merchantHistory] = await Promise.all([
    db.collection('clients').findOne({ _id: clientId }),
    db.collection('websites').find({ clientId }).sort({ createdAt: -1 }).toArray(),
    db.collection('payments').find(ownerPaymentQuery(clientId)).sort({ createdAt: -1 }).limit(50).toArray(),
    db.collection('payment_verifications').find({ clientId }).sort({ createdAt: -1 }).limit(50).toArray(),
    db.collection('subscription_renewals').find({ clientId }).sort({ paidAt: -1 }).limit(50).toArray(),
    db.collection('billing_requests').find({ clientId }).sort({ createdAt: -1 }).limit(50).toArray(),
    db.collection('client_devices').find({ clientId }).sort({ lastSeenAt: -1 }).limit(20).toArray(),
    db.collection('client_settings').findOne({ clientId }),
    db.collection('support_tickets').find({ clientId }).sort({ createdAt: -1 }).limit(50).toArray(),
    db.collection('merchant_verification_requests').find({ clientId }).sort({ createdAt: -1 }).limit(50).toArray()
  ]);

  const serializedWebsites = websites.map((website) => serializeWebsite(website, now));
  const activeWebsites = serializedWebsites.filter((site) => site.subscriptionStatus === 'active').length;
  const dueWebsites = Math.max(serializedWebsites.length - activeWebsites, 0);
  const completedPayments = payments.filter((payment) => payment.status === 'verified');
  const pendingPayments = payments.filter((payment) => payment.status !== 'verified' && payment.status !== 'rejected');
  const pendingMerchantItems = merchantHistory.filter((item) => ['pending', 'pending_sms', 'pending_review'].includes(String(item.status || '')));
  const openTickets = tickets.filter((ticket) => ticket.status !== 'closed').length;
  const billingOpen = billingRequests.filter((request) => ['pending', 'pending_review'].includes(String(request.status || '')));
  const adminConfig = getAdminConfig();
  const appDownloadUrl = getAndroidAppDownloadUrl();
  const appUnlocked = serializedWebsites.some((site) => site.androidAppEnabled || site.brandStatus === 'active');

  return res.status(200).json({
    success: true,
    client: serializeClient(client),
    summary: {
      walletBalance: sumAmounts(completedPayments),
      completedAmount: sumAmounts(completedPayments),
      completedTodayAmount: sumAmounts(completedPayments.filter((payment) => isToday(payment.verifiedAt || payment.createdAt, now))),
      pendingAmount: sumAmounts(pendingPayments),
      pendingTransactions: pendingPayments.length,
      pendingMerchantAmount: sumAmounts(pendingMerchantItems),
      pendingMerchantVerifications: pendingMerchantItems.length,
      storedData: payments.length,
      completedTransactions: completedPayments.length,
      unpaidInvoices: billingOpen.length + dueWebsites,
      openTickets,
      billingRequests: billingRequests.length,
      activeWebsites,
      dueWebsites,
      activeBrands: serializedWebsites.filter((site) => site.brandStatus === 'active').length,
      pendingBrands: serializedWebsites.filter((site) => String(site.brandStatus || '').startsWith('pending')).length,
      devices: devices.length,
      monthlyFee: BRAND_OPENING_FEE,
      brandOpeningFee: adminConfig.brandOpeningFee || BRAND_OPENING_FEE
    },
    adminPayment: {
      brandOpeningFee: adminConfig.brandOpeningFee || BRAND_OPENING_FEE,
      bkashNumber: adminConfig.bkashNumber || '',
      nagadNumber: adminConfig.nagadNumber || ''
    },
    appDownload: {
      url: appDownloadUrl,
      unlocked: appUnlocked
    },
    websites: serializedWebsites,
    payments: payments.map(serializePayment),
    transactions: verifications.map(serializeVerification),
    merchantHistory: merchantHistory.map(serializeMerchantVerification),
    renewals: renewals.map(serializeRenewal),
    billingRequests: billingRequests.map(serializeBillingRequest),
    invoices: billingRequests.map(serializeBillingRequest),
    devices: devices.map(serializeDevice),
    settings: serializeSettings(settings),
    tickets: tickets.map(serializeTicket),
    plans,
    docs,
    merchantGuide
  });
}

async function handleSettings(req, res, db, clientId) {
  if (req.method === 'GET') {
    const settings = await db.collection('client_settings').findOne({ clientId });
    return res.status(200).json({ success: true, settings: serializeSettings(settings) });
  }

  if (!['POST', 'PATCH', 'PUT'].includes(req.method)) {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const body = safeRequestBody(req, res);
  if (body === null) return;

  const defaults = defaultClientSettings();
  const now = new Date();
  const settings = {
    ...defaults,
    currency: cleanString(body.currency, 12) || defaults.currency,
    timezone: cleanString(body.timezone, 80) || defaults.timezone,
    webhookUrl: normalizePublicUrl(body.webhookUrl || body.webhook_url) || '',
    successUrl: normalizePublicUrl(body.successUrl || body.success_url) || '',
    cancelUrl: normalizePublicUrl(body.cancelUrl || body.cancel_url) || '',
    autoVerify: body.autoVerify !== false,
    paymentMethods: normalizePaymentMethods(body.paymentMethods),
    invoicePrefix: cleanString(body.invoicePrefix || body.invoice_prefix, 24) || defaults.invoicePrefix,
    supportEmail: cleanString(body.supportEmail || body.support_email, 160) || defaults.supportEmail,
    updatedAt: now
  };

  const result = await db.collection('client_settings').findOneAndUpdate(
    { clientId },
    {
      $set: settings,
      $setOnInsert: { clientId, createdAt: now }
    },
    { upsert: true, returnDocument: 'after' }
  );

  const saved = result.value || await db.collection('client_settings').findOne({ clientId });
  return res.status(200).json({ success: true, settings: serializeSettings(saved) });
}

async function handleSupport(req, res, db, clientId) {
  if (req.method === 'GET') {
    const tickets = await db.collection('support_tickets').find({ clientId }).sort({ createdAt: -1 }).limit(50).toArray();
    return res.status(200).json({ success: true, tickets: tickets.map(serializeTicket) });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const body = safeRequestBody(req, res);
  if (body === null) return;

  const subject = cleanString(body.subject, 160);
  const message = cleanString(body.message, 2000);
  if (!subject || !message) {
    return res.status(400).json({ success: false, error: 'Subject and message are required' });
  }

  const now = new Date();
  const ticket = {
    clientId,
    subject,
    message,
    category: cleanString(body.category, 80) || 'General',
    priority: cleanString(body.priority, 40) || 'normal',
    status: 'open',
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection('support_tickets').insertOne(ticket);
  ticket._id = result.insertedId;
  return res.status(201).json({ success: true, ticket: serializeTicket(ticket) });
}

async function handleBilling(req, res, db, clientId) {
  if (req.method === 'GET') {
    const requests = await db.collection('billing_requests').find({ clientId }).sort({ createdAt: -1 }).limit(50).toArray();
    return res.status(200).json({ success: true, billingRequests: requests.map(serializeBillingRequest) });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const body = safeRequestBody(req, res);
  if (body === null) return;

  const websiteId = cleanString(body.websiteId || body.website_id, 80);
  const transactionId = normalizeTransactionId(body.transaction_id || body.transactionId);
  const payerNumber = normalizePayerNumber(body.payer_number || body.payerNumber || body.senderNumber || body.customerPhone);
  const paymentStartedAt = normalizePaymentTime(body.payment_time || body.paymentTime) || new Date();
  const paymentWindow = paymentTimeWindow(paymentStartedAt);
  const siteCount = Math.min(Math.max(Number(body.siteCount || 1), 1), 500);
  const months = normalizeBillingMonths(body.months || 1);
  const expectedAmount = computePlanTotalAmount(siteCount, months);
  const amount = Number(body.amount || expectedAmount);

  if (!ObjectId.isValid(websiteId) || (!transactionId && !payerNumber)) {
    return res.status(400).json({ success: false, error: 'websiteId and payer_number are required' });
  }

  if (amount !== expectedAmount) {
    return res.status(400).json({
      success: false,
      error: `Submitted amount must equal Tk ${expectedAmount} for ${siteCount} website${siteCount > 1 ? 's' : ''} and ${months} month${months > 1 ? 's' : ''}`
    });
  }

  const websiteObjectId = new ObjectId(websiteId);
  const website = await db.collection('websites').findOne({ _id: websiteObjectId, clientId });
  if (!website) {
    return res.status(404).json({ success: false, error: 'Website not found' });
  }

  const now = new Date();
  const activation = await activateWebsiteFromAdminPayment({
    db,
    website,
    websiteId: websiteObjectId,
    clientId,
    transactionId,
    payerNumber,
    paymentStartedAt: paymentWindow.startedAt,
    amount: expectedAmount,
    months,
    purpose: isWebsiteActive(website, now) ? 'domain_subscription' : 'brand_opening',
    now
  });

  const billingRequest = await upsertBillingRequest({
    db,
    clientId,
    websiteId: websiteObjectId,
    domain: website.domain,
    transactionId,
    payerNumber,
    paymentStartedAt: paymentWindow.startedAt,
    amount: expectedAmount,
    months,
    siteCount,
    status: activation ? 'approved' : 'pending_review',
    note: cleanString(body.note, 500) || 'Billing payment submitted from client portal',
    adminNote: activation ? 'Auto approved after matching admin SMS payment' : 'Waiting for matching admin SMS payment or admin review',
    paymentId: activation?.payment?._id,
    autoApproved: Boolean(activation),
    now
  });

  return res.status(activation ? 200 : 202).json({
    success: true,
    autoApproved: Boolean(activation),
    message: activation
      ? 'Admin SMS payment matched. Brand activated automatically.'
      : 'Billing request submitted for review.',
    website: activation?.website ? serializeWebsite(activation.website) : serializeWebsite(website),
    billingRequest: serializeBillingRequest(billingRequest)
  });
}

function normalizePaymentTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ownerPaymentQuery(clientId) {
  return clientSmsPaymentFilter(clientId);
}

function sumAmounts(items, field = 'amount') {
  return Number(items.reduce((total, item) => total + Number(item?.[field] || 0), 0).toFixed(2));
}

function isToday(value, now = new Date()) {
  if (!value) return false;
  const date = new Date(value);
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function normalizePaymentMethods(value) {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const methods = items.map((item) => cleanString(item, 40).toLowerCase()).filter(Boolean);
  return methods.length ? [...new Set(methods)] : defaultClientSettings().paymentMethods;
}
