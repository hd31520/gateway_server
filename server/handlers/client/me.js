import { ObjectId } from 'mongodb';
import { getDb } from '../_db.js';
import { requireClient } from '../_auth.js';
import { getAdminConfig } from '../_admin.js';
import {
  activateWebsiteFromAdminPayment,
  normalizeTransactionId,
  upsertBillingRequest
} from '../_billing.js';
import {
  BRAND_OPENING_FEE,
  cleanString,
  defaultClientSettings,
  getAndroidAppDownloadUrl,
  isWebsiteActive,
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

const plans = [
  { id: 'free-3', name: 'Free Plan', duration: '3 Days', price: 0, websites: 1 },
  { id: 'basic-15', name: 'Basic 15', duration: '15 Days', price: 25, websites: 1 },
  { id: 'site-30', name: '1 Site', duration: '1 Month', price: 30, websites: 1 },
  { id: 'starter-30', name: '30 Days', duration: '1 Month', price: 50, websites: 5 },
  { id: 'business-30', name: 'Business 30', duration: '1 Month', price: 100, websites: 10 },
  { id: 'basic-365', name: 'Basic 365', duration: '1 Year', price: 500, websites: 5 },
  { id: 'standard-365', name: 'Standard 365', duration: '1 Year', price: 1000, websites: 10 },
  { id: 'ultimate-365', name: 'Ultimate 365', duration: '1 Year', price: 3000, websites: -1 }
];

const docs = [
  {
    title: 'Admin login and manual brand review',
    method: 'POST/GET/PATCH',
    path: '/api/admin?action=login',
    auth: 'Admin email + password / Bearer admin_token',
    body: ['email', 'password', 'websiteId', 'brandStatus']
  },
  {
    title: 'Android SMS upload',
    method: 'POST',
    path: '/api/sms',
    auth: 'Bearer client_token',
    body: ['transaction_id', 'amount', 'sender_name', 'raw_message', 'device_id']
  },
  {
    title: 'Merchant payment verify',
    method: 'POST',
    path: '/api/merchant/verify',
    auth: 'X-API-Key: website_api_key',
    body: ['domain', 'transaction_id', 'amount', 'order_id']
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
    title: 'Submit admin payment TrxID',
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
    docs
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

        : 'Billing request submitted. It will auto-approve when the matching admin SMS TrxID arrives.',
  if (body === null) return;

  const websiteId = cleanString(body.websiteId || body.website_id, 80);
  const transactionId = normalizeTransactionId(body.transaction_id || body.transactionId);
  const amount = Number(body.amount || BRAND_OPENING_FEE);
  const months = Math.min(Math.max(Number(body.months || 1), 1), 24);

  if (!ObjectId.isValid(websiteId) || !transactionId) {
    return res.status(400).json({ success: false, error: 'websiteId and transaction_id are required' });
  }

  const websiteObjectId = new ObjectId(websiteId);
  const website = await db.collection('websites').findOne({ _id: websiteObjectId, clientId });
  if (!website) {
    return res.status(404).json({ success: false, error: 'Website not found' });
  }

  const now = new Date();
  const expectedAmount = Number((Number(website.brandCharge || website.monthlyFee || BRAND_OPENING_FEE) * months).toFixed(2));
  const activation = await activateWebsiteFromAdminPayment({
    db,
    website,
    websiteId: websiteObjectId,
    clientId,
    transactionId,
    amount: amount || expectedAmount,
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
    amount: amount || expectedAmount,
    months,
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

function ownerPaymentQuery(clientId) {
  return {
    $or: [
      { clientId },
      { submittedByClientId: clientId }
    ]
  };
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
