import { ObjectId } from 'mongodb';
import {
  BRAND_OPENING_FEE,
  addOneMonth,
  cleanString,
  normalizeAmount
} from './_utils.js';

const AUTO_APPROVAL_NOTE = 'Auto approved after matching admin SMS payment';

export function normalizeTransactionId(value) {
  return cleanString(value, 120).toUpperCase();
}

export function unwrapMongoResult(result) {
  if (!result) return null;
  if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
  return result;
}

export function adminPaymentRecordFilter() {
  return {
    $or: [
      { submittedBy: 'admin' },
      { submittedBy: 'android', submittedByClientId: { $exists: false }, clientId: { $exists: false } },
      { submittedByAdmin: { $exists: true, $ne: '' } }
    ]
  };
}

export async function activateWebsiteFromAdminPayment(options = {}) {
  const {
    db,
    website,
    websiteId,
    clientId,
    transactionId,
    amount = BRAND_OPENING_FEE,
    months = 1,
    purpose = 'brand_opening',
    adminNote = AUTO_APPROVAL_NOTE,
    now = new Date()
  } = options;

  const cleanTransactionId = normalizeTransactionId(transactionId);
  const cleanAmount = normalizeAmount(amount);
  const cleanMonths = Math.min(Math.max(Number(months || 1), 1), 24);
  const websiteObjectId = toObjectId(websiteId || website?._id);
  const clientObjectId = toObjectId(clientId || website?.clientId);

  if (!db || !websiteObjectId || !clientObjectId || !cleanTransactionId || !cleanAmount) {
    return null;
  }

  const currentWebsite = website || await db.collection('websites').findOne({ _id: websiteObjectId, clientId: clientObjectId });
  if (!currentWebsite) return null;

  const existingAppliedPayment = await db.collection('payments').findOne({
    transaction_id: cleanTransactionId,
    amount: cleanAmount,
    websiteId: websiteObjectId,
    clientId: clientObjectId,
    usedFor: { $in: ['brand_opening', 'domain_subscription'] }
  });

  if (existingAppliedPayment) {
    return {
      alreadyApplied: true,
      payment: existingAppliedPayment,
      website: currentWebsite,
      paidUntil: currentWebsite.paidUntil || null
    };
  }

  const paymentResult = await db.collection('payments').findOneAndUpdate(
    {
      $and: [
        { transaction_id: cleanTransactionId, amount: cleanAmount, status: { $ne: 'rejected' } },
        adminPaymentRecordFilter(),
        unusedPaymentFilter()
      ]
    },
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
  const payment = unwrapMongoResult(paymentResult);

  if (!payment) return null;

  let paidUntil = currentWebsite.paidUntil && new Date(currentWebsite.paidUntil) > now
    ? new Date(currentWebsite.paidUntil)
    : now;
  for (let index = 0; index < cleanMonths; index += 1) paidUntil = addOneMonth(paidUntil);

  const websiteUpdate = {
    paidUntil,
    brandStatus: 'active',
    paymentStatus: 'paid',
    androidAppEnabled: true,
    approvedAt: currentWebsite.approvedAt || now,
    autoApprovedAt: now,
    autoApprovedBy: 'admin_sms',
    adminPaymentTransactionId: cleanTransactionId,
    adminNote,
    monthlyFee: currentWebsite.monthlyFee || BRAND_OPENING_FEE,
    updatedAt: now
  };

  const websiteResult = await db.collection('websites').findOneAndUpdate(
    { _id: websiteObjectId, clientId: clientObjectId },
    { $set: websiteUpdate },
    { returnDocument: 'after' }
  );
  const updatedWebsite = unwrapMongoResult(websiteResult)
    || await db.collection('websites').findOne({ _id: websiteObjectId, clientId: clientObjectId });

  await db.collection('subscription_renewals').updateOne(
    { transaction_id: cleanTransactionId },
    {
      $set: {
        clientId: clientObjectId,
        websiteId: websiteObjectId,
        paymentId: payment._id,
        transaction_id: cleanTransactionId,
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
    amount = BRAND_OPENING_FEE,
    months = 1,
    status = 'pending_review',
    note = '',
    adminNote = '',
    paymentId = null,
    autoApproved = false,
    now = new Date()
  } = options;

  const cleanTransactionId = normalizeTransactionId(transactionId);
  const clientObjectId = toObjectId(clientId);
  const websiteObjectId = toObjectId(websiteId);
  const cleanAmount = normalizeAmount(amount);

  if (!db || !clientObjectId || !websiteObjectId || !cleanTransactionId || !cleanAmount) {
    return null;
  }

  const request = {
    clientId: clientObjectId,
    websiteId: websiteObjectId,
    domain: cleanString(domain, 180),
    transaction_id: cleanTransactionId,
    amount: cleanAmount,
    months: Math.min(Math.max(Number(months || 1), 1), 24),
    status,
    note,
    adminNote,
    autoApproved,
    updatedAt: now
  };

  if (paymentId) request.paymentId = paymentId;
  if (autoApproved) {
    request.reviewedAt = now;
    request.reviewedBy = 'admin_sms';
  }

  const result = await db.collection('billing_requests').findOneAndUpdate(
    { transaction_id: cleanTransactionId },
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
    || await db.collection('billing_requests').findOne({ transaction_id: cleanTransactionId });
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

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  const text = String(value);
  return ObjectId.isValid(text) ? new ObjectId(text) : null;
}
