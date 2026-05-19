import { ObjectId } from 'mongodb';
import {
  BRAND_OPENING_FEE,
  addMonths,
  cleanString,
  normalizeAmount,
  normalizeBillingMonths
} from './_utils.js';

const AUTO_APPROVAL_NOTE = 'Auto approved after matching admin SMS payment';
const PAYMENT_LOOKBACK_MS = 5 * 60 * 1000;
const PAYMENT_WINDOW_MS = 30 * 60 * 1000;

export function normalizeTransactionId(value) {
  return cleanString(value, 120).toUpperCase();
}

export function unwrapMongoResult(result) {
  if (!result) return null;
  if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
  return result;
}

export function adminPaymentRecordFilter() {
  const filters = [
    { submittedBy: 'admin' },
    { submittedByAdmin: { $exists: true, $ne: '' } }
  ];

  if (trustLegacyAndroidAdminSms()) {
    filters.push({ submittedBy: 'android', submittedByClientId: { $exists: false }, clientId: { $exists: false } });
  }

  return { $or: filters };
}

export async function activateWebsiteFromAdminPayment(options = {}) {
  const {
    db,
    website,
    websiteId,
    clientId,
    transactionId,
    payerNumber,
    paymentStartedAt,
    amount = BRAND_OPENING_FEE,
    months = 1,
    purpose = 'brand_opening',
    adminNote = AUTO_APPROVAL_NOTE,
    now = new Date()
  } = options;

  const cleanTransactionId = normalizeTransactionId(transactionId);
  const cleanPayerNumber = normalizePayerNumber(payerNumber);
  const cleanAmount = normalizeAmount(amount);
  const cleanMonths = normalizeBillingMonths(months);
  const websiteObjectId = toObjectId(websiteId || website?._id);
  const clientObjectId = toObjectId(clientId || website?.clientId);

  if (!db || !websiteObjectId || !clientObjectId || !cleanAmount || (!cleanTransactionId && !cleanPayerNumber)) {
    return null;
  }

  const currentWebsite = website || await db.collection('websites').findOne({ _id: websiteObjectId, clientId: clientObjectId });
  if (!currentWebsite) return null;

  const existingAppliedQuery = {
    amount: cleanAmount,
    websiteId: websiteObjectId,
    clientId: clientObjectId,
    usedFor: { $in: ['brand_opening', 'domain_subscription'] }
  };
  if (cleanTransactionId) existingAppliedQuery.transaction_id = cleanTransactionId;
  else existingAppliedQuery.payer_number = cleanPayerNumber;
  const existingAppliedPayment = await db.collection('payments').findOne(existingAppliedQuery);

  if (existingAppliedPayment) {
    return {
      alreadyApplied: true,
      payment: existingAppliedPayment,
      website: currentWebsite,
      paidUntil: currentWebsite.paidUntil || null
    };
  }

  const payment = await claimAdminPayment(db, {
    transactionId: cleanTransactionId,
    payerNumber: cleanPayerNumber,
    amount: cleanAmount,
    paymentStartedAt,
    websiteObjectId,
    clientObjectId,
    purpose,
    now
  });

  if (!payment) return null;

  const paymentReference = cleanTransactionId || payment.transaction_id;

  const baseDate = currentWebsite.paidUntil && new Date(currentWebsite.paidUntil) > now
    ? new Date(currentWebsite.paidUntil)
    : now;
  const paidUntil = addMonths(baseDate, cleanMonths);

  const websiteUpdate = {
    paidUntil,
    brandStatus: 'active',
    paymentStatus: 'paid',
    androidAppEnabled: true,
    approvedAt: currentWebsite.approvedAt || now,
    autoApprovedAt: now,
    autoApprovedBy: 'admin_sms',
    adminPaymentTransactionId: paymentReference,
    adminPaymentPayerNumber: cleanPayerNumber || payment.payer_number || '',
    adminNote,
    monthlyFee: currentWebsite.monthlyFee || BRAND_OPENING_FEE,
    updatedAt: now
  };

  const websiteResult = await db.collection('websites').findOneAndUpdate(
    { _id: websiteObjectId, clientId: clientObjectId },
    {
      $set: {
        ...websiteUpdate,
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  );
  const updatedWebsite = unwrapMongoResult(websiteResult)
    || await db.collection('websites').findOne({ _id: websiteObjectId, clientId: clientObjectId });

  await db.collection('subscription_renewals').updateOne(
    { transaction_id: paymentReference },
    {
      $set: {
        clientId: clientObjectId,
        websiteId: websiteObjectId,
        paymentId: payment._id,
        transaction_id: paymentReference,
        payer_number: cleanPayerNumber || payment.payer_number || '',
        amount: cleanAmount,
        months: cleanMonths,
        source: 'admin_sms',
        type: purpose,
        paidAt: now,
        paidUntil,
        updatedAt: now
      },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true }
  );

  return {
    alreadyApplied: false,
    payment,
    website: updatedWebsite || { ...currentWebsite, ...websiteUpdate },
    paidUntil
  };
}

export async function upsertBillingRequest(options = {}) {
  const {
    db,
    clientId,
    websiteId,
    domain,
    transactionId,
    payerNumber,
    paymentStartedAt,
    amount = BRAND_OPENING_FEE,
    months = 1,
    siteCount = 1,
    status = 'pending_review',
    note = '',
    adminNote = '',
    paymentId = null,
    autoApproved = false,
    now = new Date()
  } = options;

  const cleanTransactionId = normalizeTransactionId(transactionId);
  const cleanPayerNumber = normalizePayerNumber(payerNumber);
  const clientObjectId = toObjectId(clientId);
  const websiteObjectId = toObjectId(websiteId);
  const cleanAmount = normalizeAmount(amount);
  const startedAt = normalizeDate(paymentStartedAt) || now;
  const expiresAt = new Date(startedAt.getTime() + PAYMENT_WINDOW_MS);

  if (!db || !clientObjectId || !websiteObjectId || !cleanAmount || (!cleanTransactionId && !cleanPayerNumber)) {
    return null;
  }

  const matchKey = cleanTransactionId || buildBillingMatchKey(websiteObjectId, cleanPayerNumber, cleanAmount, startedAt);
  const paymentReference = cleanTransactionId || `PAY-${String(matchKey).split(':').slice(-3).join('-').replace(/[^a-z0-9-]/gi, '').toUpperCase()}`;

  const request = {
    clientId: clientObjectId,
    websiteId: websiteObjectId,
    domain: cleanString(domain, 180),
    transaction_id: paymentReference,
    payer_number: cleanPayerNumber,
    match_key: matchKey,
    amount: cleanAmount,
    months: normalizeBillingMonths(months),
    siteCount: Math.min(Math.max(Number(siteCount || 1), 1), 500),
    status,
    note,
    adminNote,
    autoApproved,
    paymentStartedAt: startedAt,
    expiresAt,
    updatedAt: now
  };

  if (paymentId) request.paymentId = paymentId;
  if (autoApproved) {
    request.reviewedAt = now;
    request.reviewedBy = 'admin_sms';
  }

  const findQuery = cleanTransactionId
    ? { $or: [{ match_key: matchKey }, { transaction_id: cleanTransactionId }] }
    : {
        $or: [
          { match_key: matchKey },
          {
            websiteId: websiteObjectId,
            payer_number: cleanPayerNumber,
            amount: cleanAmount,
            status: { $in: ['pending', 'pending_review', 'approved'] }
          }
        ]
      };

  const result = await db.collection('billing_requests').findOneAndUpdate(
    findQuery,
    {
      $set: request,
      $setOnInsert: {
        firstSubmittedAt: now,
        createdAt: now
      }
    },
    { upsert: true, returnDocument: 'after' }
  );

  return unwrapMongoResult(result)
    || await db.collection('billing_requests').findOne(findQuery);
}

export function normalizePayerNumber(value) {
  return cleanString(value, 120).replace(/\D/g, '');
}

export function paymentTimeWindow(now = new Date()) {
  return {
    startedAt: new Date(now.getTime() - PAYMENT_LOOKBACK_MS),
    expiresAt: new Date(now.getTime() + PAYMENT_WINDOW_MS)
  };
}

export function billingRequestMatchesPayment(request, payment, now = new Date()) {
  if (!request || !payment) return false;
  const requestAmount = normalizeAmount(request.amount);
  const paymentAmount = normalizeAmount(payment.amount);
  if (!requestAmount || !paymentAmount || Number(requestAmount).toFixed(2) !== Number(paymentAmount).toFixed(2)) return false;

  const requestTransactionId = normalizeTransactionId(request.transaction_id);
  const paymentTransactionId = normalizeTransactionId(payment.transaction_id);
  const reliablePaymentTransactionId = paymentTransactionId && !paymentTransactionId.startsWith('AUTO-') ? paymentTransactionId : '';
  if (reliablePaymentTransactionId && requestTransactionId === reliablePaymentTransactionId) return true;

  const requestPayer = normalizePayerNumber(request.payer_number);
  const paymentPayer = normalizePayerNumber(payment.payer_number);
  if (!requestPayer || !paymentPayer || requestPayer !== paymentPayer) return false;

  const paidAt = normalizeDate(payment.receivedAt || payment.createdAt) || now;
  const startedAt = normalizeDate(request.paymentStartedAt || request.createdAt) || now;
  const expiresAt = normalizeDate(request.expiresAt) || new Date(startedAt.getTime() + PAYMENT_WINDOW_MS);
  return paidAt.getTime() >= startedAt.getTime() - PAYMENT_LOOKBACK_MS && paidAt.getTime() <= expiresAt.getTime();
}

async function claimAdminPayment(db, { transactionId, payerNumber, amount, paymentStartedAt, websiteObjectId, clientObjectId, purpose, now }) {
  const identityFilter = transactionId
    ? { transaction_id: transactionId, amount, status: { $ne: 'rejected' } }
    : { amount, payer_number: payerNumber, status: { $ne: 'rejected' } };

  const candidates = await db.collection('payments')
    .find({ $and: [identityFilter, adminPaymentRecordFilter(), unusedPaymentFilter()] })
    .sort({ receivedAt: -1, createdAt: -1 })
    .limit(20)
    .toArray();

  const window = paymentTimeWindow(normalizeDate(paymentStartedAt) || now);
  const matched = candidates.find((payment) => {
    if (transactionId) return true;
    return billingRequestMatchesPayment({
      payer_number: payerNumber,
      amount,
      paymentStartedAt: window.startedAt,
      expiresAt: window.expiresAt
    }, payment, now);
  });
  if (!matched) return null;

  const result = await db.collection('payments').findOneAndUpdate(
    { $and: [{ _id: matched._id }, identityFilter, adminPaymentRecordFilter(), unusedPaymentFilter()] },
    {
      $set: {
        status: 'verified',
        usedFor: purpose,
        usedBy: websiteObjectId,
        websiteId: websiteObjectId,
        clientId: clientObjectId,
        verifiedAt: now,
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  );

  return unwrapMongoResult(result);
}

function buildBillingMatchKey(websiteId, payerNumber, amount, startedAt) {
  return [
    String(websiteId),
    payerNumber,
    Number(amount || 0).toFixed(2),
    Math.floor(startedAt.getTime() / 1000)
  ].join(':');
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function unusedPaymentFilter() {
  return {
    $or: [
      { usedFor: { $exists: false } },
      { usedFor: null },
      { usedFor: '' }
    ]
  };
}

function trustLegacyAndroidAdminSms() {
  return process.env.TRUST_LEGACY_ANDROID_ADMIN_SMS === 'true';
}

export function toObjectId(value) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  const text = String(value);
  return ObjectId.isValid(text) ? new ObjectId(text) : null;
}
