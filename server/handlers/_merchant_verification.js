import { toObjectId, unwrapMongoResult } from './_billing.js';
import { cleanString, normalizeAmount, serializeMerchantVerification } from './_utils.js';

export { unwrapMongoResult };

export async function createMerchantVerification(db, data = {}) {
  const now = new Date();
  const doc = {
    clientId: toObjectId(data.clientId),
    websiteId: toObjectId(data.websiteId),
    name: data.name || '',
    phone: data.phone || '',
    nid: data.nid || '',
    address: data.address || '',
    status: data.status || 'pending',
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection('merchant_verifications').insertOne(doc);
  doc._id = result.insertedId;
  return serializeMerchantVerification(doc);
}

export async function getMerchantVerification(db, id) {
  const oid = toObjectId(id);
  if (!oid) return null;
  const doc = await db.collection('merchant_verifications').findOne({ _id: oid });
  return doc ? serializeMerchantVerification(doc) : null;
}

export function ownerPaymentFilter(clientId) {
  return clientSmsPaymentFilter(clientId);
}

export function clientSmsPaymentFilter(clientId) {
  const values = objectIdValues(clientId);
  if (!values.length) return { _id: null };

  return {
    $and: [
      {
        $or: [
          { submittedBy: 'client' },
          { submittedBy: { $exists: false } }
        ]
      },
      { submittedByAdmin: { $exists: false } },
      { adminClientId: { $exists: false } },
      {
        $or: [
          { submittedByClientId: { $in: values } },
          { clientId: { $in: values }, submittedByClientId: { $exists: false } }
        ]
      }
    ]
  };
}

export async function findConflictingPendingMerchantVerification(db, website, transactionId, amount) {
  const cleanTransactionId = normalizeMerchantTransactionId(transactionId);
  const cleanAmount = normalizeAmount(amount);
  if (!db || !website?._id || !cleanTransactionId || !cleanAmount) return null;

  const existing = await db.collection('merchant_verification_requests').findOne({
    transaction_id: cleanTransactionId,
    status: { $in: ['pending', 'pending_sms', 'pending_review'] }
  });

  if (!existing) return null;

  const sameWebsite = String(existing.websiteId || '') === String(website._id || '');
  const sameAmount = Number(existing.amount || 0).toFixed(2) === Number(cleanAmount).toFixed(2);
  return sameWebsite && sameAmount ? null : existing;
}

export async function upsertPendingMerchantVerification(options = {}) {
  const {
    db,
    website,
    transactionId,
    amount,
    orderId = '',
    sellerName = '',
    buyerName = '',
    buyerAddress = '',
    callbackUrl = '',
    returnUrl = '',
    now = new Date()
  } = options;

  const websiteId = toObjectId(website?._id);
  const clientId = toObjectId(website?.clientId);
  const cleanTransactionId = normalizeMerchantTransactionId(transactionId);
  const cleanAmount = normalizeAmount(amount);

  if (!db || !websiteId || !clientId || !cleanTransactionId || !cleanAmount) return null;

  const request = {
    clientId,
    websiteId,
    domain: cleanString(website.domain, 180),
    transaction_id: cleanTransactionId,
    amount: cleanAmount,
    order_id: cleanString(orderId, 160) || null,
    sellerName: cleanString(sellerName, 160),
    buyerName: cleanString(buyerName, 160),
    buyerAddress: cleanString(buyerAddress, 500),
    callbackUrl: cleanString(callbackUrl, 500),
    returnUrl: cleanString(returnUrl, 500),
    status: 'pending_sms',
    updatedAt: now
  };

  const result = await db.collection('merchant_verification_requests').findOneAndUpdate(
    { transaction_id: cleanTransactionId },
    {
      $set: request,
      $setOnInsert: {
        createdAt: now,
        firstSubmittedAt: now
      }
    },
    { upsert: true, returnDocument: 'after' }
  );

  return unwrapMongoResult(result)
    || await db.collection('merchant_verification_requests').findOne({ transaction_id: cleanTransactionId });
}

export async function autoApprovePendingMerchantVerification(db, payment, now = new Date()) {
  const transactionId = normalizeMerchantTransactionId(payment?.transaction_id);
  const amount = normalizeAmount(payment?.amount);
  if (!db || !payment || !transactionId || !amount) return null;
  if (!paymentIsUnused(payment)) return null;

  const pendingItems = await db.collection('merchant_verification_requests')
    .find({
      transaction_id: transactionId,
      amount,
      status: { $in: ['pending', 'pending_sms', 'pending_review'] }
    })
    .sort({ createdAt: 1 })
    .limit(10)
    .toArray();

  const pending = pendingItems.find((item) => paymentBelongsToClient(payment, item.clientId));
  if (!pending) return null;

  const existing = await db.collection('payment_verifications').findOne({ transaction_id: transactionId });
  if (existing) {
    await markMerchantRequestVerified(db, pending, existing, now);
    return {
      status: 'already_verified',
      requestId: String(pending._id),
      verificationId: String(existing._id),
      transaction_id: transactionId,
      amount
    };
  }

  const paymentId = toObjectId(payment._id);
  if (!paymentId) return null;

  const claimedPayment = await claimPaymentForMerchant(db, {
    paymentId,
    pending,
    transactionId,
    amount,
    now
  });
  if (!claimedPayment) return null;

  const verification = {
    clientId: pending.clientId,
    websiteId: pending.websiteId,
    domain: pending.domain || '',
    paymentId: claimedPayment._id,
    transaction_id: transactionId,
    amount,
    order_id: pending.order_id || null,
    sellerName: pending.sellerName || '',
    buyerName: pending.buyerName || '',
    buyerAddress: pending.buyerAddress || '',
    callbackUrl: pending.callbackUrl || '',
    returnUrl: pending.returnUrl || '',
    status: 'verified',
    createdAt: now
  };

  const result = await db.collection('payment_verifications').insertOne(verification);
  verification._id = result.insertedId;

  await markMerchantRequestVerified(db, pending, verification, now);

  return {
    status: 'verified',
    requestId: String(pending._id),
    verificationId: String(verification._id),
    websiteId: String(pending.websiteId),
    domain: pending.domain || '',
    transaction_id: transactionId,
    amount
  };
}

async function claimPaymentForMerchant(db, { paymentId, pending, transactionId, amount, now }) {
  const result = await db.collection('payments').findOneAndUpdate(
    {
      $and: [
        { _id: paymentId },
        { transaction_id: transactionId, amount, status: { $ne: 'rejected' } },
        clientSmsPaymentFilter(pending.clientId),
        unusedPaymentFilter()
      ]
    },
    {
      $set: {
        status: 'verified',
        usedFor: 'merchant_payment',
        usedBy: pending.websiteId,
        websiteId: pending.websiteId,
        clientId: pending.clientId,
        verifiedAt: now,
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  );

  return unwrapMongoResult(result);
}

async function markMerchantRequestVerified(db, pending, verification, now) {
  await db.collection('merchant_verification_requests').updateOne(
    { _id: pending._id },
    {
      $set: {
        status: verification.status || 'verified',
        paymentId: verification.paymentId || null,
        verificationId: verification._id,
        verifiedAt: now,
        updatedAt: now
      }
    }
  );
}

function paymentBelongsToClient(payment, clientId) {
  const clientValues = objectIdValues(clientId).map(String);
  const submittedBy = String(payment?.submittedBy || '');
  if (submittedBy && submittedBy !== 'client') return false;
  if (payment?.submittedByAdmin || payment?.adminClientId) return false;

  const paymentValues = [
    payment.submittedByClientId,
    payment.submittedByClientId ? null : payment.clientId
  ].filter(Boolean).map(String);

  return paymentValues.some((value) => clientValues.includes(value));
}

function paymentIsUnused(payment) {
  return !payment?.usedFor;
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

function objectIdValues(value) {
  const objectId = toObjectId(value);
  if (!objectId) return [];
  return [objectId, String(objectId)];
}

function normalizeMerchantTransactionId(value) {
  return cleanString(value, 120).toUpperCase();
}
