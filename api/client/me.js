import { ObjectId } from 'mongodb';
import { getDb } from '../_db.js';
import { requireClient } from '../_auth.js';
import { getAdminConfig } from '../_admin.js';
import {
  BRAND_OPENING_FEE,
  cleanString,
  defaultClientSettings,
  getAndroidAppDownloadUrl,
  handleCors,
  isWebsiteActive,
  normalizePublicUrl,
  publicServerError,
  serializeClient,
  serializeBillingRequest,
  serializeDevice,
  serializePayment,
  serializeRenewal,
  serializeSettings,
  serializeTicket,
  serializeVerification,
  serializeWebsite
} from '../_utils.js';

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
    title: 'Admin login and brand approval',
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
    title: 'Create brand',
    method: 'POST',
    path: '/api/client/websites',
    auth: 'Bearer client_token',
    body: ['name', 'domain', 'walletProvider', 'walletNumber', 'receiverName']
  },
  {
    title: 'Submit billing request',
    method: 'POST',
    path: '/api/client/me?resource=billing',
    auth: 'Bearer client_token',
    body: ['websiteId', 'transaction_id', 'amount', 'months']
  }
];

export default async function handler(req, res) {
  if (handleCors(req, res, 'GET, POST, PUT, PATCH, OPTIONS')) return;

  const auth = requireClient(req, res);
  if (!auth) return;

  try {
    const db = await getDb();
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
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const paymentFilter = {
    $or: [
      { submittedByClientId: clientId },
      { clientId }
    ]
  };

  const [
    client,
    websites,
    recentPayments,
    recentVerifications,
    renewals,
    devices,
    settings,
    tickets,
    billingRequests,
    paymentCount,
    paymentAmount,
    pendingCount,
    pendingAmount,
    completedCount,
    completedAmount,
    completedTodayAmount
  ] = await Promise.all([
    db.collection('clients').findOne({ _id: clientId }),
    db.collection('websites').find({ clientId }).sort({ createdAt: -1 }).toArray(),
    db.collection('payments').find(paymentFilter).sort({ createdAt: -1 }).limit(25).toArray(),
    db.collection('payment_verifications').find({ clientId }).sort({ createdAt: -1 }).limit(25).toArray(),
    db.collection('subscription_renewals').find({ clientId }).sort({ paidAt: -1 }).limit(25).toArray(),
    db.collection('client_devices').find({ clientId }).sort({ lastSeenAt: -1 }).limit(20).toArray(),
    db.collection('client_settings').findOne({ clientId }),
    db.collection('support_tickets').find({ clientId }).sort({ createdAt: -1 }).limit(20).toArray(),
    db.collection('billing_requests').find({ clientId }).sort({ createdAt: -1 }).limit(30).toArray(),
    db.collection('payments').countDocuments(paymentFilter),
    sumCollection(db, 'payments', paymentFilter, 'amount'),
    db.collection('payments').countDocuments({ ...paymentFilter, status: 'received' }),
    sumCollection(db, 'payments', { ...paymentFilter, status: 'received' }, 'amount'),
    db.collection('payment_verifications').countDocuments({ clientId }),
    sumCollection(db, 'payment_verifications', { clientId }, 'amount'),
    sumCollection(db, 'payment_verifications', { clientId, createdAt: { $gte: todayStart } }, 'amount')
  ]);

  if (!client) {
    return res.status(404).json({ success: false, error: 'Client not found' });
  }

  const invoices = buildInvoices(websites);
  const activeWebsites = websites.filter((website) => isWebsiteActive(website)).length;
  const activeBrands = websites.filter((website) => website.brandStatus === 'active' || website.androidAppEnabled || isWebsiteActive(website)).length;
  const pendingBrands = websites.filter((website) => !isWebsiteActive(website) && (!website.brandStatus || ['pending_payment', 'pending_review'].includes(website.brandStatus))).length;
  const dueWebsites = Math.max(websites.length - activeWebsites, 0);
  const openTickets = tickets.filter((ticket) => ticket.status !== 'closed').length;

  return res.status(200).json({
    success: true,
    generatedAt: new Date(),
    client: serializeClient(client),
    websites: websites.map((website) => serializeWebsite(website)),
    payments: recentPayments.map(serializePayment),
    transactions: recentVerifications.map(serializeVerification),
    renewals: renewals.map(serializeRenewal),
    devices: devices.map(serializeDevice),
    settings: serializeSettings(settings),
    tickets: tickets.map(serializeTicket),
    billingRequests: billingRequests.map(serializeBillingRequest),
    invoices,
    plans,
    docs,
    adminPayment: getAdminConfig(),
    appDownload: {
      url: getAndroidAppDownloadUrl(),
      unlocked: activeBrands > 0
    },
    summary: {
      walletBalance: 0,
      storedData: paymentCount,
      totalReceivedAmount: paymentAmount,
      pendingTransactions: pendingCount,
      pendingAmount,
      completedTransactions: completedCount,
      completedAmount,
      completedTodayAmount,
      activeWebsites,
      dueWebsites,
      activeBrands,
      pendingBrands,
      unpaidInvoices: invoices.filter((invoice) => invoice.status === 'unpaid').length,
      openTickets,
      billingRequests: billingRequests.length,
      devices: devices.length,
      monthlyFee: BRAND_OPENING_FEE,
      brandOpeningFee: BRAND_OPENING_FEE
    }
  });
}

async function handleSettings(req, res, db, clientId) {
  if (req.method === 'GET') {
    const settings = await db.collection('client_settings').findOne({ clientId });
    return res.status(200).json({ success: true, settings: serializeSettings(settings) });
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const body = req.body || {};
    const now = new Date();
    const paymentMethods = Array.isArray(body.paymentMethods)
      ? body.paymentMethods.map((item) => cleanString(item, 40)).filter(Boolean).slice(0, 12)
      : defaultClientSettings().paymentMethods;

    const nextSettings = {
      currency: cleanString(body.currency, 8).toUpperCase() || 'BDT',
      timezone: cleanString(body.timezone, 80) || 'Asia/Dhaka',
      webhookUrl: normalizePublicUrl(body.webhookUrl),
      successUrl: normalizePublicUrl(body.successUrl),
      cancelUrl: normalizePublicUrl(body.cancelUrl),
      autoVerify: body.autoVerify !== false,
      paymentMethods,
      invoicePrefix: cleanString(body.invoicePrefix, 20).toUpperCase() || 'INV',
      supportEmail: cleanString(body.supportEmail, 160),
      updatedAt: now
    };

    const result = await db.collection('client_settings').findOneAndUpdate(
      { clientId },
      {
        $set: nextSettings,
        $setOnInsert: { clientId, createdAt: now }
      },
      { upsert: true, returnDocument: 'after' }
    );

    const settings = result?.value || await db.collection('client_settings').findOne({ clientId });
    return res.status(200).json({ success: true, settings: serializeSettings(settings) });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
}

async function handleSupport(req, res, db, clientId) {
  if (req.method === 'GET') {
    const tickets = await db.collection('support_tickets').find({ clientId }).sort({ createdAt: -1 }).limit(50).toArray();
    return res.status(200).json({ success: true, items: tickets.map(serializeTicket) });
  }

  if (req.method === 'POST') {
    const subject = cleanString(req.body?.subject, 180);
    const message = cleanString(req.body?.message, 3000);
    const category = cleanString(req.body?.category, 80) || 'General';
    const priority = cleanString(req.body?.priority, 30) || 'normal';

    if (!subject || !message) {
      return res.status(400).json({ success: false, error: 'Subject and message are required' });
    }

    const now = new Date();
    const ticket = {
      clientId,
      subject,
      message,
      category,
      priority,
      status: 'open',
      createdAt: now,
      updatedAt: now
    };
    const result = await db.collection('support_tickets').insertOne(ticket);
    ticket._id = result.insertedId;
    return res.status(201).json({ success: true, ticket: serializeTicket(ticket) });
  }

  if (req.method === 'PATCH') {
    const id = cleanString(req.body?.id, 80);
    const status = cleanString(req.body?.status, 30);
    const allowed = ['open', 'pending', 'closed'];

    if (!ObjectId.isValid(id) || !allowed.includes(status)) {
      return res.status(400).json({ success: false, error: 'Valid ticket id and status are required' });
    }

    await db.collection('support_tickets').updateOne(
      { _id: new ObjectId(id), clientId },
      { $set: { status, updatedAt: new Date() } }
    );
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
}

async function handleBilling(req, res, db, clientId) {
  if (req.method === 'GET') {
    const items = await db.collection('billing_requests').find({ clientId }).sort({ createdAt: -1 }).limit(50).toArray();
    return res.status(200).json({ success: true, items: items.map(serializeBillingRequest) });
  }

  if (req.method === 'POST') {
    const websiteId = cleanString(req.body?.websiteId, 80);
    const transactionId = cleanString(req.body?.transaction_id || req.body?.transactionId, 120).toUpperCase();
    const amount = Number(req.body?.amount || BRAND_OPENING_FEE);
    const months = Math.min(Math.max(Number(req.body?.months || 1), 1), 24);
    const note = cleanString(req.body?.note, 800);

    if (!ObjectId.isValid(websiteId) || !transactionId) {
      return res.status(400).json({ success: false, error: 'websiteId and transaction_id are required' });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Valid amount is required' });
    }

    const websiteObjectId = new ObjectId(websiteId);
    const website = await db.collection('websites').findOne({ _id: websiteObjectId, clientId });
    if (!website) {
      return res.status(404).json({ success: false, error: 'Brand not found' });
    }

    const now = new Date();
    const existingRequest = await db.collection('billing_requests').findOne({ transaction_id: transactionId });
    if (existingRequest && String(existingRequest.clientId) !== String(clientId)) {
      return res.status(409).json({ success: false, error: 'This transaction ID is already submitted by another account' });
    }

    const request = {
      clientId,
      websiteId: websiteObjectId,
      domain: website.domain,
      transaction_id: transactionId,
      amount: Number(amount.toFixed(2)),
      months,
      status: 'pending_review',
      note,
      createdAt: now,
      updatedAt: now
    };

    const result = await db.collection('billing_requests').findOneAndUpdate(
      { transaction_id: transactionId },
      {
        $set: request,
        $setOnInsert: { firstSubmittedAt: now }
      },
      { upsert: true, returnDocument: 'after' }
    );

    await db.collection('websites').updateOne(
      { _id: websiteObjectId, clientId },
      {
        $set: {
          brandStatus: 'pending_review',
          paymentStatus: 'pending_review',
          updatedAt: now
        }
      }
    );

    const saved = result?.value || await db.collection('billing_requests').findOne({ transaction_id: transactionId });
    return res.status(201).json({
      success: true,
      message: 'Billing request submitted for admin review',
      billingRequest: serializeBillingRequest(saved)
    });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
}

async function sumCollection(db, collection, filter, field) {
  const rows = await db.collection(collection).aggregate([
    { $match: filter },
    { $group: { _id: null, total: { $sum: `$${field}` } } }
  ]).toArray();
  return Number(rows[0]?.total || 0);
}

function buildInvoices(websites) {
  const now = new Date();
  return websites
    .filter((website) => !isWebsiteActive(website, now))
    .map((website, index) => ({
      id: `INV-${String(index + 1).padStart(4, '0')}-${String(website._id).slice(-6)}`,
      websiteId: String(website._id),
      title: website.paidUntil ? `Monthly subscription for ${website.domain}` : `Brand opening charge for ${website.domain}`,
      amount: Number(website.brandCharge || website.monthlyFee || BRAND_OPENING_FEE),
      currency: 'BDT',
      status: 'unpaid',
      dueDate: now,
      createdAt: website.updatedAt || website.createdAt || now
    }));
}
