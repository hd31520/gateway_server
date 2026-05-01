import { ObjectId } from 'mongodb';
import {
  cleanString,
  isWebsiteActive,
  normalizeAmount,
  normalizeDomain
} from './_utils.js';

export function ownerPaymentFilter(clientId) {
  return { $or: [{ submittedByClientId: clientId }, { clientId }] };
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

  const cleanTransactionId = normalizeTransactionId(transactionId);
  const cleanAmount = normalizeAmount(amount);
  if (!db || !website?._id || !website?.clientId || !cleanTransactionId || !cleanAmount) return null;

  const pending = {
    clientId: website.clientId,
    websiteId: website._id,
    domain: normalizeDomain(website.domain) || cleanString(website.domain, 180),
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
      $set: pending,
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

export async function findConflictingPendingMerchantVerification(db, website, transactionId, amount) {
  const cleanTransactionId = normalizeTransactionId(transactionId);
  const cleanAmount = normalizeAmount(amount);
  if (!db || !website?._id || !cleanTransactionId || !cleanAmount) return null;

  const pending = await db.collection('merchant_verification_requests').findOne({
    transaction_id: cleanTransactionId,
    status: 'pending_sms'
  });
  if (!pending) return null;

  const sameWebsite = String(pending.websiteId) === String(website._id);
  const sameAmount = Number(pending.amount || 0).toFixed(2) === Number(cleanAmount || 0).toFixed(2);
  return sameWebsite && sameAmount ? null : pending;
}

export async function autoApprovePendingMerchantVerification(db, payment, now = new Date()) {
  const transactionId = normalizeTransactionId(payment?.transaction_id);
  const amount = normalizeAmount(payment?.amount);
  if (!db || !payment?._id || !transactionId || !amount) return null;

  const request = await db.collection('merchant_verification_requests').findOne({
    transaction_id: transactionId,
    amount,
    status: 'pending_sms'
  });
  if (!request) return null;

  const existing = await db.collection('payment_verifications').findOne({ transaction_id: transactionId });
  if (existing) {
    await db.collection('merchant_verification_requests').updateOne(
      { _id: request._id },
      {
        $set: {
          status: 'verified',
          verificationId: existing._id,
          verifiedAt: existing.createdAt || now,
          updatedAt: now
        }
      }
    );
    return {
      status: 'already_verified',
      verificationId: String(existing._id),
      websiteId: String(existing.websiteId || request.websiteId),
      transaction_id: transactionId,
      amount
    };
  }

  const website = await db.collection('websites').findOne({
    _id: request.websiteId,
    clientId: request.clientId
  });
  if (!website || !isWebsiteActive(website, now)) {
    return null;
  }

  const paymentResult = await db.collection('payments').findOneAndUpdate(
    {
      $and: [
        { _id: payment._id, transaction_id: transactionId, amount, status: { $ne: 'rejected' } },
        ownerPaymentFilter(request.clientId),
        unusedPaymentFilter()
      ]
    },
    {
      $set: {
        status: 'verified',
        usedFor: 'merchant_payment',
        usedBy: request.websiteId,
        websiteId: request.websiteId,
        clientId: request.clientId,
        verifiedAt: now,
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  );
  const matchedPayment = unwrapMongoResult(paymentResult);
  if (!matchedPayment) return null;

  const verification = {
    clientId: request.clientId,
    websiteId: request.websiteId,
    domain: request.domain || website.domain,
    paymentId: matchedPayment._id,
    transaction_id: transactionId,
    amount,
    order_id: request.order_id || null,
    sellerName: request.sellerName || '',
    buyerName: request.buyerName || '',
    buyerAddress: request.buyerAddress || '',
    callbackUrl: request.callbackUrl || '',
    returnUrl: request.returnUrl || '',
    status: 'verified',
    createdAt: now
  };

  const result = await db.collection('payment_verifications').insertOne(verification);
  verification._id = result.insertedId;

  await db.collection('merchant_verification_requests').updateOne(
    { _id: request._id },
    {
      $set: {
        status: 'verified',
        paymentId: matchedPayment._id,
        verificationId: verification._id,
        verifiedAt: now,
        updatedAt: now
      }
    }
  );

  return {
    status: 'verified',
    verificationId: String(verification._id),
    websiteId: String(request.websiteId),
    transaction_id: transactionId,
    amount
  };
}

export async function manuallyUpdateMerchantVerification(options = {}) {
  const {
    db,
    requestId,
    transactionId,
    status,
    adminNote = '',
    reviewedBy = 'admin',
    now = new Date()
  } = options;

  const allowedStatuses = ['pending_sms', 'manual_approved', 'verified', 'rejected'];
  const nextStatus = cleanString(status, 40);
  if (!db || !allowedStatuses.includes(nextStatus)) return null;

  const filter = buildRequestFilter(requestId, transactionId);
  if (!filter) return null;

  const request = await db.collection('merchant_verification_requests').findOne(filter);
  if (!request) return null;

  if (nextStatus === 'rejected' || nextStatus === 'pending_sms') {
    const result = await db.collection('merchant_verification_requests').findOneAndUpdate(
      { _id: request._id },
      {
        $set: {
          status: nextStatus,
          adminNote: cleanString(adminNote, 800),
          reviewedBy,
          reviewedAt: now,
          updatedAt: now
        }
      },
      { returnDocument: 'after' }
    );
    return unwrapMongoResult(result)
      || await db.collection('merchant_verification_requests').findOne({ _id: request._id });
  }

  const existing = await db.collection('payment_verifications').findOne({ transaction_id: request.transaction_id });
  if (existing) {
    const result = await db.collection('merchant_verification_requests').findOneAndUpdate(
      { _id: request._id },
      {
        $set: {
          status: existing.status || 'verified',
          verificationId: existing._id,
          paymentId: existing.paymentId || null,
          adminNote: cleanString(adminNote, 800),
          reviewedBy,
          reviewedAt: now,
          verifiedAt: existing.createdAt || now,
          updatedAt: now
        }
      },
      { returnDocument: 'after' }
    );
    return unwrapMongoResult(result)
      || await db.collection('merchant_verification_requests').findOne({ _id: request._id });
  }

  const payment = await findMatchingUnusedPayment(db, request, now);
  const verificationStatus = nextStatus === 'verified' ? 'verified' : 'manual_approved';
  const verification = {
    clientId: request.clientId,
    websiteId: request.websiteId,
    domain: request.domain || '',
    paymentId: payment?._id || null,
    transaction_id: request.transaction_id,
    amount: Number(request.amount || 0),
    order_id: request.order_id || null,
    sellerName: request.sellerName || '',
    buyerName: request.buyerName || '',
    buyerAddress: request.buyerAddress || '',
    callbackUrl: request.callbackUrl || '',
    returnUrl: request.returnUrl || '',
    status: verificationStatus,
    adminNote: cleanString(adminNote, 800),
    reviewedBy,
    createdAt: now
  };

  const result = await db.collection('payment_verifications').insertOne(verification);
  verification._id = result.insertedId;

  const updatedRequestResult = await db.collection('merchant_verification_requests').findOneAndUpdate(
    { _id: request._id },
    {
      $set: {
        status: verificationStatus,
        paymentId: payment?._id || null,
        verificationId: verification._id,
        adminNote: cleanString(adminNote, 800),
        reviewedBy,
        reviewedAt: now,
        verifiedAt: now,
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  );

  return unwrapMongoResult(updatedRequestResult)
    || await db.collection('merchant_verification_requests').findOne({ _id: request._id });
}

export function normalizeTransactionId(value) {
  return cleanString(value, 120).toUpperCase();
}

export function unwrapMongoResult(result) {
  if (!result) return null;
  if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
  return result;
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

function buildRequestFilter(requestId, transactionId) {
  const cleanRequestId = cleanString(requestId, 80);
  if (ObjectId.isValid(cleanRequestId)) return { _id: new ObjectId(cleanRequestId) };

  const cleanTransactionId = normalizeTransactionId(transactionId);
  return cleanTransactionId ? { transaction_id: cleanTransactionId } : null;
}

async function findMatchingUnusedPayment(db, request, now) {
  const paymentResult = await db.collection('payments').findOneAndUpdate(
    {
      $and: [
        {
          transaction_id: request.transaction_id,
          amount: Number(request.amount || 0),
          status: { $ne: 'rejected' }
        },
        ownerPaymentFilter(request.clientId),
        unusedPaymentFilter()
      ]
    },
    {
      $set: {
        status: 'verified',
        usedFor: 'merchant_payment',
        usedBy: request.websiteId,
        websiteId: request.websiteId,
        clientId: request.clientId,
        verifiedAt: now,
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  );

  return unwrapMongoResult(paymentResult);
}
