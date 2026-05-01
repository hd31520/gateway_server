import { ObjectId } from 'mongodb';
import { getDb } from './_db.js';
import { requireAdmin } from './_auth.js';
import { createAdminSession, getAdminConfig } from './_admin.js';
import { adminPaymentRecordFilter } from './_billing.js';
import { manuallyUpdateMerchantVerification } from './_merchant_verification.js';
import {
  BRAND_OPENING_FEE,
  addOneMonth,
  cleanString,
  handleCors,
  isWebsiteActive,
  publicServerError,
  rateLimit,
  serializeBillingRequest,
  serializeClient,
  serializeDevice,
  serializeMerchantVerification,
  serializePayment,
  serializeTicket,
  serializeWebsite
} from './_utils.js';
import { safeRequestBody } from './_utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res, 'GET, POST, PATCH, OPTIONS')) return;

  const body = safeRequestBody(req, res);
  if (body === null) return;

  const action = cleanString(req.query?.action || body.action, 60).toLowerCase();

  if ((action === 'login' || (!action && req.method === 'POST' && req.body?.password)) && req.method === 'POST') {
    return loginAdmin(req, res);
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const db = await getDb();

    if (req.method === 'GET') {
      if (action === 'config') {
        return res.status(200).json({ success: true, config: getAdminConfig() });
      }

      if (action === 'brands') {
        return listBrands(req, res, db);
      }

      if (action === 'users') {
        return listUsers(req, res, db);
      }

      if (action === 'billing') {
        return listBilling(req, res, db);
      }

      if (action === 'history') {
        return listHistory(req, res, db);
      }

      if (action === 'merchantverification' || action === 'merchant-verifications') {
        return listMerchantVerifications(req, res, db);
      }

      if (action === 'payments' || action === 'sms') {
        return listPayments(req, res, db);
      }

      return adminDashboard(res, db);
    }

    if (req.method === 'PATCH' || (req.method === 'POST' && action === 'brand')) {
      if (action === 'user') return updateUser(req, res, db);
      if (action === 'merchantverification') return updateMerchantVerification(req, res, db, admin);
      return updateBrand(req, res, db, admin);
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

async function loginAdmin(req, res) {
  if (!rateLimit(req, res, { key: 'admin-login', limit: 8, windowMs: 15 * 60_000 })) return;

  const body = safeRequestBody(req, res);
  if (body === null) return;

  const session = await createAdminSession(body);
  if (!session.ok) {
    return res.status(session.status).json({ success: false, error: session.error });
  }

  return res.status(200).json({
    success: true,
    token: session.token,
    admin: session.admin,
    config: session.config
  });
}

async function adminDashboard(res, db) {
  const [clients, websites, payments, devices, tickets, billingRequests, merchantRequests, totalClients, totalBrands, pendingBrands, activeBrands, pendingBilling, pendingMerchantVerifications, paymentSummary, accountHistory] = await Promise.all([
    db.collection('clients').find({}).sort({ createdAt: -1 }).limit(20).toArray(),
    db.collection('websites').find({}).sort({ createdAt: -1 }).limit(30).toArray(),
    db.collection('payments').find({}).sort({ createdAt: -1 }).limit(30).toArray(),
    db.collection('client_devices').find({}).sort({ lastSeenAt: -1 }).limit(20).toArray(),
    db.collection('support_tickets').find({}).sort({ createdAt: -1 }).limit(20).toArray(),
    db.collection('billing_requests').find({}).sort({ createdAt: -1 }).limit(30).toArray(),
    db.collection('merchant_verification_requests').find({}).sort({ createdAt: -1 }).limit(50).toArray(),
    db.collection('clients').countDocuments({}),
    db.collection('websites').countDocuments({}),
    db.collection('websites').countDocuments({ brandStatus: { $in: ['pending_payment', 'pending_review'] } }),
    db.collection('websites').countDocuments({ brandStatus: 'active' }),
    db.collection('billing_requests').countDocuments({ status: 'pending_review' }),
    db.collection('merchant_verification_requests').countDocuments({ status: 'pending_sms' }),
    db.collection('payments').aggregate([
      { $group: { _id: null, totalAmount: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]).toArray(),
    getAdminAccountHistory(db, { limit: 30 })
  ]);

  return res.status(200).json({
    success: true,
    config: getAdminConfig(),
    summary: {
      totalClients,
      totalBrands,
      pendingBrands,
      activeBrands,
      pendingBilling,
      pendingMerchantVerifications,
      totalSms: Number(paymentSummary[0]?.count || 0),
      totalSmsAmount: Number(paymentSummary[0]?.totalAmount || 0),
      adminIncomeAmount: accountHistory.summary.totalAmount,
      adminIncomeCount: accountHistory.summary.totalCount,
      unusedAdminAmount: accountHistory.summary.unusedAmount
    },
    clients: clients.map(serializeClient),
    brands: await attachClientEmails(db, websites),
    billingRequests: await attachBillingClientEmails(db, billingRequests),
    merchantVerifications: await attachMerchantVerificationDetails(db, merchantRequests),
    payments: payments.map(serializePayment),
    accountHistory: accountHistory.items,
    devices: devices.map(serializeDevice),
    tickets: tickets.map(serializeTicket)
  });
}

async function listBrands(req, res, db) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
  const status = cleanString(req.query.status, 40);
  const search = cleanString(req.query.search, 120);
  const filter = {};

  if (status) filter.brandStatus = status;
  if (search) {
    filter.$or = [
      { domain: { $regex: escapeRegex(search), $options: 'i' } },
      { name: { $regex: escapeRegex(search), $options: 'i' } },
      { walletNumber: { $regex: escapeRegex(search), $options: 'i' } }
    ];
  }

  const [websites, total] = await Promise.all([
    db.collection('websites').find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    db.collection('websites').countDocuments(filter)
  ]);

  return res.status(200).json({
    success: true,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    items: await attachClientEmails(db, websites)
  });
}

async function listUsers(req, res, db) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
  const role = cleanString(req.query.role, 40);
  const search = cleanString(req.query.search, 120);
  const filter = {};

  if (role) filter.role = role;
  if (search) {
    filter.$or = [
      { email: { $regex: escapeRegex(search), $options: 'i' } },
      { name: { $regex: escapeRegex(search), $options: 'i' } }
    ];
  }

  const [items, total] = await Promise.all([
    db.collection('clients').find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    db.collection('clients').countDocuments(filter)
  ]);

  return res.status(200).json({
    success: true,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    items: items.map(serializeClient)
  });
}

async function listBilling(req, res, db) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
  const status = cleanString(req.query.status, 40);
  const filter = status ? { status } : {};

  const [items, total] = await Promise.all([
    db.collection('billing_requests').find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    db.collection('billing_requests').countDocuments(filter)
  ]);

  return res.status(200).json({
    success: true,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    items: await attachBillingClientEmails(db, items)
  });
}

async function listPayments(req, res, db) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
  const search = cleanString(req.query.search, 120);
  const filter = search
    ? {
        $or: [
          { transaction_id: { $regex: escapeRegex(search), $options: 'i' } },
          { sender: { $regex: escapeRegex(search), $options: 'i' } },
          { source_number: { $regex: escapeRegex(search), $options: 'i' } },
          { raw_message: { $regex: escapeRegex(search), $options: 'i' } }
        ]
      }
    : {};

  const [items, total] = await Promise.all([
    db.collection('payments').find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    db.collection('payments').countDocuments(filter)
  ]);

  return res.status(200).json({
    success: true,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    items: items.map(serializePayment)
  });
}

async function listHistory(req, res, db) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
  const search = cleanString(req.query.search, 120);
  const history = await getAdminAccountHistory(db, { page, limit, search });

  return res.status(200).json({
    success: true,
    page,
    limit,
    total: history.total,
    totalPages: Math.ceil(history.total / limit),
    summary: history.summary,
    items: history.items
  });
}

async function listMerchantVerifications(req, res, db) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
  const status = cleanString(req.query.status, 40);
  const search = cleanString(req.query.search, 120);
  const filter = {};

  if (status) filter.status = status;
  if (search) {
    const escaped = escapeRegex(search);
    filter.$or = [
      { transaction_id: { $regex: escaped, $options: 'i' } },
      { domain: { $regex: escaped, $options: 'i' } },
      { order_id: { $regex: escaped, $options: 'i' } },
      { sellerName: { $regex: escaped, $options: 'i' } },
      { buyerName: { $regex: escaped, $options: 'i' } },
      { adminNote: { $regex: escaped, $options: 'i' } }
    ];
  }

  const [items, total] = await Promise.all([
    db.collection('merchant_verification_requests').find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    db.collection('merchant_verification_requests').countDocuments(filter)
  ]);

  return res.status(200).json({
    success: true,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    items: await attachMerchantVerificationDetails(db, items)
  });
}

async function updateBrand(req, res, db, admin) {
  const websiteId = cleanString(req.body?.websiteId || req.body?.id, 80);
  const billingRequestId = cleanString(req.body?.billingRequestId, 80);
  const status = cleanString(req.body?.brandStatus || req.body?.status, 40) || 'active';
  const paymentStatus = cleanString(req.body?.paymentStatus, 40) || (status === 'active' ? 'paid' : 'unpaid');
  const adminNote = cleanString(req.body?.adminNote || req.body?.note, 800);
  const months = Math.min(Math.max(Number(req.body?.months || 1), 1), 24);
  const allowedStatuses = ['pending_payment', 'pending_review', 'active', 'suspended', 'rejected'];
  const allowedPaymentStatuses = ['unpaid', 'pending_review', 'paid', 'waived', 'failed', 'refunded'];

  if ((!ObjectId.isValid(websiteId) && !ObjectId.isValid(billingRequestId)) || !allowedStatuses.includes(status) || !allowedPaymentStatuses.includes(paymentStatus)) {
    return res.status(400).json({ success: false, error: 'Valid websiteId or billingRequestId, brandStatus, and paymentStatus are required' });
  }

  const now = new Date();
  const billingRequest = ObjectId.isValid(billingRequestId)
    ? await db.collection('billing_requests').findOne({ _id: new ObjectId(billingRequestId) })
    : null;
  const resolvedWebsiteId = ObjectId.isValid(websiteId)
    ? new ObjectId(websiteId)
    : billingRequest?.websiteId;

  if (!resolvedWebsiteId) {
    return res.status(404).json({ success: false, error: 'Brand or billing request not found' });
  }

  const update = {
    brandStatus: status,
    paymentStatus,
    adminNote,
    updatedAt: now,
    reviewedAt: now,
    reviewedBy: admin.email || admin.username || 'admin'
  };

  if (status === 'active') {
    const existing = await db.collection('websites').findOne({ _id: resolvedWebsiteId });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Brand not found' });
    }

    let paidUntil = existing.paidUntil && new Date(existing.paidUntil) > now
      ? new Date(existing.paidUntil)
      : now;
    for (let index = 0; index < months; index += 1) paidUntil = addOneMonth(paidUntil);

    update.androidAppEnabled = true;
    update.approvedAt = existing.approvedAt || now;
    update.paidUntil = paidUntil;
    update.monthlyFee = existing.monthlyFee || BRAND_OPENING_FEE;

    if (billingRequest) {
      const renewal = {
        clientId: existing.clientId,
        websiteId: existing._id,
        billingRequestId: billingRequest._id,
        transaction_id: billingRequest.transaction_id,
        amount: Number(billingRequest.amount || BRAND_OPENING_FEE),
        months,
        paidAt: now,
        paidUntil
      };
      await db.collection('subscription_renewals').updateOne(
        { transaction_id: billingRequest.transaction_id },
        { $set: renewal, $setOnInsert: { createdAt: now } },
        { upsert: true }
      );
    }
  }

  const result = await db.collection('websites').findOneAndUpdate(
    { _id: resolvedWebsiteId },
    { $set: update },
    { returnDocument: 'after' }
  );

  if (billingRequest) {
    await db.collection('billing_requests').updateOne(
      { _id: billingRequest._id },
      {
        $set: {
          status: status === 'active' ? 'approved' : status,
          paymentStatus,
          adminNote,
          reviewedAt: now,
          reviewedBy: admin.email || admin.username || 'admin',
          updatedAt: now
        }
      }
    );
  }

  const website = result?.value || await db.collection('websites').findOne({ _id: resolvedWebsiteId });
  return res.status(200).json({
    success: true,
    message: status === 'active' ? 'Brand approved and Android app unlocked' : 'Brand updated',
    brand: serializeWebsite(website)
  });
}

async function updateMerchantVerification(req, res, db, admin) {
  const id = cleanString(req.body?.id || req.body?.requestId, 80);
  const transactionId = cleanString(req.body?.transaction_id || req.body?.transactionId, 120);
  const status = cleanString(req.body?.status, 40);
  const adminNote = cleanString(req.body?.adminNote || req.body?.note, 800);
  const reviewedBy = admin.email || admin.username || 'admin';

  const updated = await manuallyUpdateMerchantVerification({
    db,
    requestId: id,
    transactionId,
    status,
    adminNote,
    reviewedBy
  });

  if (!updated) {
    return res.status(400).json({ success: false, error: 'Valid merchant verification id and status are required' });
  }

  return res.status(200).json({
    success: true,
    message: status === 'rejected'
      ? 'Merchant verification rejected'
      : status === 'pending_sms'
        ? 'Merchant verification returned to pending'
        : 'Merchant verification approved manually',
    merchantVerification: serializeMerchantVerification(updated)
  });
}

async function updateUser(req, res, db) {
  const userId = cleanString(req.body?.userId || req.body?.id, 80);
  const role = cleanString(req.body?.role, 40);
  const status = cleanString(req.body?.status, 40);
  const allowedRoles = ['user', 'admin'];
  const allowedStatuses = ['active', 'blocked'];
  const update = { updatedAt: new Date() };

  if (!ObjectId.isValid(userId)) {
    return res.status(400).json({ success: false, error: 'Valid userId is required' });
  }

  if (role) {
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, error: 'Role must be user or admin' });
    }
    update.role = role;
  }

  if (status) {
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Status must be active or blocked' });
    }
    update.status = status;
  }

  const result = await db.collection('clients').findOneAndUpdate(
    { _id: new ObjectId(userId) },
    { $set: update },
    { returnDocument: 'after' }
  );
  const client = result?.value || await db.collection('clients').findOne({ _id: new ObjectId(userId) });

  if (!client) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  return res.status(200).json({ success: true, user: serializeClient(client) });
}

async function getAdminAccountHistory(db, options = {}) {
  const page = Math.max(Number(options.page || 1), 1);
  const limit = Math.min(Math.max(Number(options.limit || 30), 1), 100);
  const search = cleanString(options.search, 120);
  const filter = buildAdminHistoryFilter(search);

  const [payments, total, summaryRows] = await Promise.all([
    db.collection('payments').find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    db.collection('payments').countDocuments(filter),
    db.collection('payments').aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$usedFor',
          totalAmount: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]).toArray()
  ]);

  return {
    total,
    summary: summarizeAdminHistory(summaryRows),
    items: await attachAdminHistoryDetails(db, payments)
  };
}

function buildAdminHistoryFilter(search) {
  const base = adminPaymentRecordFilter();
  if (!search) return base;

  const escaped = escapeRegex(search);
  return {
    $and: [
      base,
      {
        $or: [
          { transaction_id: { $regex: escaped, $options: 'i' } },
          { sender: { $regex: escaped, $options: 'i' } },
          { provider: { $regex: escaped, $options: 'i' } },
          { source_number: { $regex: escaped, $options: 'i' } },
          { raw_message: { $regex: escaped, $options: 'i' } },
          { usedFor: { $regex: escaped, $options: 'i' } }
        ]
      }
    ]
  };
}

function summarizeAdminHistory(rows = []) {
  const summary = {
    totalAmount: 0,
    totalCount: 0,
    usedAmount: 0,
    usedCount: 0,
    unusedAmount: 0,
    unusedCount: 0,
    brandOpeningAmount: 0,
    subscriptionAmount: 0
  };

  for (const row of rows) {
    const key = String(row._id || '');
    const amount = Number(row.totalAmount || 0);
    const count = Number(row.count || 0);

    summary.totalAmount += amount;
    summary.totalCount += count;

    if (!key) {
      summary.unusedAmount += amount;
      summary.unusedCount += count;
    } else {
      summary.usedAmount += amount;
      summary.usedCount += count;
    }

    if (key === 'brand_opening') summary.brandOpeningAmount += amount;
    if (key === 'domain_subscription') summary.subscriptionAmount += amount;
  }

  return summary;
}

async function attachAdminHistoryDetails(db, payments) {
  const websiteIds = [...new Set(payments.map((payment) => String(payment.websiteId || '')).filter(ObjectId.isValid))]
    .map((id) => new ObjectId(id));
  const paymentClientIds = payments.map((payment) => String(payment.clientId || '')).filter(ObjectId.isValid);

  const websites = websiteIds.length
    ? await db.collection('websites').find({ _id: { $in: websiteIds } }).project({ name: 1, domain: 1, clientId: 1 }).toArray()
    : [];
  const websiteMap = new Map(websites.map((website) => [String(website._id), website]));
  const websiteClientIds = websites.map((website) => String(website.clientId || '')).filter(ObjectId.isValid);
  const clientIds = [...new Set([...paymentClientIds, ...websiteClientIds])].map((id) => new ObjectId(id));
  const clients = clientIds.length
    ? await db.collection('clients').find({ _id: { $in: clientIds } }).project({ email: 1, name: 1 }).toArray()
    : [];
  const clientMap = new Map(clients.map((client) => [String(client._id), client]));

  return payments.map((payment) => {
    const website = websiteMap.get(String(payment.websiteId || ''));
    const client = clientMap.get(String(payment.clientId || website?.clientId || ''));
    return {
      ...serializePayment(payment),
      type: adminHistoryType(payment.usedFor),
      direction: 'income',
      submittedByAdmin: payment.submittedByAdmin || payment.submittedBy || '',
      websiteId: payment.websiteId ? String(payment.websiteId) : null,
      clientId: payment.clientId ? String(payment.clientId) : null,
      domain: website?.domain || '',
      brandName: website?.name || '',
      clientEmail: client?.email || '',
      clientName: client?.name || ''
    };
  });
}

function adminHistoryType(usedFor) {
  if (usedFor === 'brand_opening') return 'Brand opening';
  if (usedFor === 'domain_subscription') return 'Brand renewal';
  if (usedFor === 'merchant_payment') return 'Merchant payment';
  if (usedFor) return String(usedFor).replaceAll('_', ' ');
  return 'Unmatched admin SMS';
}

async function attachClientEmails(db, websites) {
  const clientIds = [...new Set(websites.map((site) => String(site.clientId || '')).filter(ObjectId.isValid))].map((id) => new ObjectId(id));
  const clients = clientIds.length
    ? await db.collection('clients').find({ _id: { $in: clientIds } }).project({ email: 1, name: 1 }).toArray()
    : [];
  const clientMap = new Map(clients.map((client) => [String(client._id), client]));

  return websites.map((website) => {
    const client = clientMap.get(String(website.clientId));
    return {
      ...serializeWebsite(website),
      clientId: website.clientId ? String(website.clientId) : null,
      clientEmail: client?.email || '',
      clientName: client?.name || ''
    };
  });
}

async function attachBillingClientEmails(db, requests) {
  const clientIds = [...new Set(requests.map((request) => String(request.clientId || '')).filter(ObjectId.isValid))].map((id) => new ObjectId(id));
  const clients = clientIds.length
    ? await db.collection('clients').find({ _id: { $in: clientIds } }).project({ email: 1, name: 1 }).toArray()
    : [];
  const clientMap = new Map(clients.map((client) => [String(client._id), client]));

  return requests.map((request) => {
    const client = clientMap.get(String(request.clientId));
    return {
      ...serializeBillingRequest(request),
      clientEmail: client?.email || '',
      clientName: client?.name || ''
    };
  });
}

async function attachMerchantVerificationDetails(db, requests) {
  const clientIds = [...new Set(requests.map((request) => String(request.clientId || '')).filter(ObjectId.isValid))]
    .map((id) => new ObjectId(id));
  const websiteIds = [...new Set(requests.map((request) => String(request.websiteId || '')).filter(ObjectId.isValid))]
    .map((id) => new ObjectId(id));

  const [clients, websites] = await Promise.all([
    clientIds.length
      ? db.collection('clients').find({ _id: { $in: clientIds } }).project({ email: 1, name: 1 }).toArray()
      : [],
    websiteIds.length
      ? db.collection('websites').find({ _id: { $in: websiteIds } }).project({ name: 1, domain: 1 }).toArray()
      : []
  ]);

  const clientMap = new Map(clients.map((client) => [String(client._id), client]));
  const websiteMap = new Map(websites.map((website) => [String(website._id), website]));

  return requests.map((request) => {
    const client = clientMap.get(String(request.clientId || ''));
    const website = websiteMap.get(String(request.websiteId || ''));
    return {
      ...serializeMerchantVerification(request),
      domain: request.domain || website?.domain || '',
      brandName: website?.name || '',
      clientEmail: client?.email || '',
      clientName: client?.name || ''
    };
  });
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
