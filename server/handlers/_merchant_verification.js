import { toObjectId, unwrapMongoResult } from './_billing.js';
import { cleanString, normalizeAmount, serializeMerchantVerification } from './_utils.js';

export { unwrapMongoResult };

const PAYMENT_LOOKBACK_MS = 5 * 60 * 1000;
const PAYMENT_WINDOW_MS = 30 * 60 * 1000;

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
    payerNumber = '',
    paymentStartedAt = null,
    orderId = '',
    sellerName = '',
    buyerName = '',
    buyerAddress = '',
    callbackUrl = '',
    returnUrl = '',
    walletProvider = '',
    receiverNumber = '',
    now = new Date()
  } = options;

  const websiteId = toObjectId(website?._id);
  const clientId = toObjectId(website?.clientId);
  const cleanTransactionId = normalizeMerchantTransactionId(transactionId);
  const cleanAmount = normalizeAmount(amount);
  const cleanPayerNumber = normalizePayerNumber(payerNumber);
  const startedAt = normalizeDate(paymentStartedAt) || now;
  const expiresAt = new Date(startedAt.getTime() + PAYMENT_WINDOW_MS);

  if (!db || !websiteId || !clientId || !cleanAmount || (!cleanTransactionId && !cleanPayerNumber)) return null;

  const request = {
    clientId,
    websiteId,
    domain: cleanString(website.domain, 180),
    payer_number: cleanPayerNumber,
    amount: cleanAmount,
    order_id: cleanString(orderId, 160) || null,
    sellerName: cleanString(sellerName, 160),
    buyerName: cleanString(buyerName, 160),
    buyerAddress: cleanString(buyerAddress, 500),
    callbackUrl: cleanString(callbackUrl, 500),
    returnUrl: cleanString(returnUrl, 500),
    walletProvider: cleanString(walletProvider, 60).toLowerCase(),
    receiverNumber: cleanString(receiverNumber, 80).replace(/\D/g, ''),
    status: 'pending_sms',
    paymentStartedAt: startedAt,
    expiresAt,
    updatedAt: now
  };
  if (cleanTransactionId) request.transaction_id = cleanTransactionId;

  const matchKey = cleanTransactionId || buildPendingMatchKey(websiteId, orderId, cleanPayerNumber, cleanAmount, startedAt);
  request.match_key = matchKey;

  const result = await db.collection('merchant_verification_requests').findOneAndUpdate(
    cleanTransactionId ? { transaction_id: cleanTransactionId } : { match_key: matchKey },
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
    || await db.collection('merchant_verification_requests').findOne(cleanTransactionId ? { transaction_id: cleanTransactionId } : { match_key: matchKey });
}

export async function autoApprovePendingMerchantVerification(db, payment, now = new Date()) {
  const transactionId = normalizeMerchantTransactionId(payment?.transaction_id);
  const reliableTransactionId = transactionId && !transactionId.startsWith('AUTO-') ? transactionId : '';
  const amount = normalizeAmount(payment?.amount);
  const payerNumber = normalizePayerNumber(payment?.payer_number);
  if (!db || !payment || !amount || (!reliableTransactionId && !payerNumber)) return null;
  if (!paymentIsUnused(payment)) return null;

  const baseQuery = {
    status: { $in: ['pending', 'pending_sms', 'pending_review'] }
  };
  let pendingItems = [];
  let queriedByTransaction = false;

  if (reliableTransactionId) {
    queriedByTransaction = true;
    pendingItems = await db.collection('merchant_verification_requests')
      .find({ ...baseQuery, transaction_id: reliableTransactionId })
      .sort({ createdAt: 1 })
      .limit(50)
      .toArray();
  }

  if (!pendingItems.length) {
    pendingItems = await db.collection('merchant_verification_requests')
      .find({ ...baseQuery, amount })
      .sort({ createdAt: 1 })
      .limit(50)
      .toArray();
    queriedByTransaction = false;
  }

  const ownedPendingItems = pendingItems.filter((item) => paymentBelongsToClient(payment, item.clientId));
  const pending = ownedPendingItems.find((item) => pendingMatchesPayment(item, payment, { amount, payerNumber, transactionId: reliableTransactionId, now }));
  if (!pending) {
    const amountMismatch = queriedByTransaction ? ownedPendingItems[0] : null;
    if (amountMismatch) {
      await db.collection('merchant_verification_requests').updateOne(
        { _id: amountMismatch._id },
        {
          $set: {
            adminNote: `Matched payment reference but SMS amount ${Number(amount).toFixed(2)} did not equal requested ${Number(amountMismatch.amount || 0).toFixed(2)}`,
            updatedAt: now
          }
        }
      );
    }
    return null;
  }

  const verificationTransactionId = reliableTransactionId || transactionId;
  const existing = await db.collection('payment_verifications').findOne({ transaction_id: verificationTransactionId });
  if (existing) {
    await markMerchantRequestVerified(db, pending, existing, now);
    return {
      status: 'already_verified',
      requestId: String(pending._id),
      verificationId: String(existing._id),
      transaction_id: verificationTransactionId,
      payer_number: payerNumber,
      amount
    };
  }

  const paymentId = toObjectId(payment._id);
  if (!paymentId) return null;

  const claimedPayment = await claimPaymentForMerchant(db, {
    paymentId,
    pending,
    transactionId: reliableTransactionId,
    payerNumber,
    amount,
    now
  });
  if (!claimedPayment) return null;

  const verification = {
    clientId: pending.clientId,
    websiteId: pending.websiteId,
    domain: pending.domain || '',
    paymentId: claimedPayment._id,
    transaction_id: verificationTransactionId,
    payer_number: payerNumber,
    amount,
    order_id: pending.order_id || null,
    sellerName: pending.sellerName || '',
    buyerName: pending.buyerName || '',
    buyerAddress: pending.buyerAddress || '',
    callbackUrl: pending.callbackUrl || '',
    returnUrl: pending.returnUrl || '',
    walletProvider: pending.walletProvider || '',
    receiverNumber: pending.receiverNumber || '',
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
    transaction_id: verificationTransactionId,
    payer_number: payerNumber,
    amount
  };
}

async function claimPaymentForMerchant(db, { paymentId, pending, transactionId, payerNumber, amount, now }) {
  const identityFilter = transactionId
    ? { transaction_id: transactionId, amount, status: { $ne: 'rejected' } }
    : { payer_number: payerNumber, amount, status: { $ne: 'rejected' } };
  const result = await db.collection('payments').findOneAndUpdate(
    {
      $and: [
        { _id: paymentId },
        identityFilter,
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

  const duplicateIdentity = [];
  if (pending?.transaction_id) {
    duplicateIdentity.push({ transaction_id: pending.transaction_id });
  }
  if (pending?.order_id && pending?.payer_number && pending?.amount) {
    duplicateIdentity.push({
      order_id: pending.order_id,
      payer_number: pending.payer_number,
      amount: pending.amount
    });
  }

  if (!duplicateIdentity.length) return;

  await db.collection('merchant_verification_requests').updateMany(
    {
      _id: { $ne: pending._id },
      websiteId: pending.websiteId,
      status: { $in: ['pending', 'pending_sms', 'pending_review'] },
      $or: duplicateIdentity
    },
    {
      $set: {
        status: verification.status || 'verified',
        paymentId: verification.paymentId || null,
        verificationId: verification._id,
        verifiedAt: now,
        updatedAt: now,
        adminNote: 'Auto-resolved duplicate pending request after matching SMS verification'
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

export function normalizePayerNumber(value) {
  const digits = cleanString(value, 120).replace(/\D/g, '');
  if (!digits) return '';

  // Canonicalize common Bangladesh formats so +8801XXXXXXXXX, 8801XXXXXXXXX,
  // and 01XXXXXXXXX are treated as the same payer number.
  if (digits.startsWith('8801') && digits.length >= 13) {
    return `0${digits.slice(-10)}`;
  }
  if (digits.startsWith('01') && digits.length >= 11) {
    return digits.slice(0, 11);
  }

  return digits;
}

export function paymentTimeWindow(now = new Date()) {
  return {
    startedAt: new Date(now.getTime() - PAYMENT_LOOKBACK_MS),
    expiresAt: new Date(now.getTime() + PAYMENT_WINDOW_MS)
  };
}

export function pendingMatchesPayment(pending, payment, { amount, payerNumber, transactionId, now = new Date() } = {}) {
  if (Number(pending?.amount || 0).toFixed(2) !== Number(amount || payment?.amount || 0).toFixed(2)) return false;
  if (transactionId && normalizeMerchantTransactionId(pending?.transaction_id) === transactionId) return true;
  const cleanPendingPayer = normalizePayerNumber(pending?.payer_number);
  const cleanPaymentPayer = normalizePayerNumber(payerNumber || payment?.payer_number);
  if (!cleanPendingPayer || !cleanPaymentPayer || cleanPendingPayer !== cleanPaymentPayer) return false;

  const paidAt = normalizeDate(payment?.receivedAt || payment?.createdAt) || now;
  const startedAt = normalizeDate(pending?.paymentStartedAt || pending?.createdAt) || now;
  const expiresAt = normalizeDate(pending?.expiresAt) || new Date(startedAt.getTime() + PAYMENT_WINDOW_MS);
  return paidAt.getTime() >= startedAt.getTime() - PAYMENT_LOOKBACK_MS && paidAt.getTime() <= expiresAt.getTime();
}

function buildPendingMatchKey(websiteId, orderId, payerNumber, amount, startedAt) {
  const cleanOrderId = cleanString(orderId, 160);
  const stableOrderKey = cleanOrderId
    ? cleanOrderId.toLowerCase()
    : `window-${Math.floor(startedAt.getTime() / (5 * 60 * 1000))}`;

  return [
    String(websiteId),
    stableOrderKey,
    payerNumber,
    Number(amount || 0).toFixed(2),
    'merchant'
  ].join(':');
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
