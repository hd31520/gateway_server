import { ObjectId } from 'mongodb';
import { getDb } from './_db.js';
import { requireSmsSubmitter } from './_auth.js';
import {
  activateWebsiteFromAdminPayment,
  upsertBillingRequest
} from './_billing.js';
import { autoApprovePendingMerchantVerification } from './_merchant_verification.js';
import {
  BRAND_OPENING_FEE,
  cleanString,
  computePlanAmount,

  normalizeAmount,
  publicServerError,
  rateLimit,
  serializePayment,
  safeRequestBody
} from './_utils.js';

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function normalizeReceivedAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSameAmount(left, right) {
  return Number(left || 0).toFixed(2) === Number(right || 0).toFixed(2);
}

function belongsToSubmitter(payment, submitter) {
  if (!payment) return false;
  if (submitter.role === 'admin') {
    return payment.submittedBy === 'admin' || Boolean(payment.submittedByAdmin);
  }
  if (submitter.role !== 'client' || !ObjectId.isValid(submitter.id)) return false;
  const clientId = String(submitter.id);
  return String(payment.submittedByClientId || '') === clientId
    || String(payment.clientId || '') === clientId
    || (submitter.email && payment.submittedByEmail === submitter.email);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!rateLimit(req, res, { key: 'sms-submit', limit: 180, windowMs: 60_000 })) return;

  const submitter = await requireSmsSubmitter(req, res);
  if (!submitter) return;

  try {
    const body = safeRequestBody(req, res);
    if (body === null) return;
    const transactionId = cleanString(
      firstValue(body.transaction_id, body.transactionId, body.transactionNumber, body.trxId, body.txnId),
      120
    ).toUpperCase();
    const amount = normalizeAmount(firstValue(body.amount, body.receivedTk, body.received_tk));

    if (!transactionId || !amount) {
      return res.status(400).json({ success: false, error: 'transaction_id and valid amount are required' });
    }

    const db = await getDb();
    const now = new Date();
    await upsertClientDevice(db, submitter, body, now, false);

    const existing = await db.collection('payments').findOne({ transaction_id: transactionId });
    if (existing) {
      if (!belongsToSubmitter(existing, submitter)) {
        return res.status(409).json({
          success: false,
          error: 'This transaction ID is already stored under another account'
        });
      }

      if (isSameAmount(existing.amount, amount)) {
        const autoApproval = await autoApprovePendingAdminPayment(db, existing, now);
        const freshPayment = autoApproval
          ? await db.collection('payments').findOne({ _id: existing._id })
          : existing;
        const merchantAutoVerification = await autoApprovePendingMerchantVerification(db, freshPayment || existing, now);
        const latestPayment = merchantAutoVerification
          ? await db.collection('payments').findOne({ _id: existing._id })
          : freshPayment;
        return res.status(200).json({
          success: true,
          duplicate: true,
          message: 'Payment already saved',
          autoApproval,
          merchantAutoVerification,
          payment: serializePayment(latestPayment || freshPayment || existing)
        });
      }

      return res.status(409).json({
        success: false,
        error: 'Duplicate transaction_id with a different amount'
      });
    }

    const receivedAt = normalizeReceivedAt(firstValue(body.received_at, body.receivedAt));
    const payment = {
      sender: cleanString(firstValue(body.sender_name, body.senderName, body.selectedSenderName, body.provider, body.sender), 120) || 'unknown',
      provider: cleanString(body.provider, 60),
      source_number: cleanString(firstValue(body.source_number, body.sourceNumber, body.senderNumber, body.smsSender, body.selectedSender, body.sender), 120),
      payer_number: cleanString(firstValue(body.payer_number, body.payerNumber, body.customerNumber, body.fromNumber), 120),
      transaction_id: transactionId,
      amount,
      raw_message: cleanString(firstValue(body.raw_message, body.rawMessage, body.message, body.smsBody), 3000),
      status: 'received',
      currency: cleanString(body.currency, 10) || 'BDT',
      receivedAt,
      createdAt: now,
      updatedAt: now,
      submittedBy: submitter.role,
      clientIp: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null
    };

    if (submitter.role === 'client' && ObjectId.isValid(submitter.id)) {
      payment.submittedByClientId = new ObjectId(submitter.id);
      payment.submittedByEmail = submitter.email || '';
      if (submitter.userRole === 'admin') {
        payment.submittedByAdmin = submitter.email || String(submitter.id);
        payment.adminClientId = new ObjectId(submitter.id);
      }
    }
    if (submitter.role === 'admin') {
      payment.submittedByAdmin = submitter.username || '';
    }

    const insertResult = await db.collection('payments').insertOne(payment);
    payment._id = insertResult.insertedId;
    await upsertClientDevice(db, submitter, body, now, true);
    const autoApproval = await autoApprovePendingAdminPayment(db, payment, now);
    const savedPayment = autoApproval
      ? await db.collection('payments').findOne({ transaction_id: transactionId })
      : payment;
    const merchantAutoVerification = await autoApprovePendingMerchantVerification(db, savedPayment || payment, now);
    const latestPayment = merchantAutoVerification
      ? await db.collection('payments').findOne({ transaction_id: transactionId })
      : savedPayment;

    return res.status(201).json({
      success: true,
      message: merchantAutoVerification
        ? 'Payment saved and matching merchant verification auto-approved'
        : autoApproval
          ? 'Payment saved and matching brand request auto-approved'
          : 'Payment saved',
      autoApproval,
      merchantAutoVerification,
      payment: serializePayment(latestPayment || savedPayment || payment)
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(200).json({ success: true, duplicate: true, message: 'Payment already saved' });
    }
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

async function autoApprovePendingAdminPayment(db, payment, now) {
  if (!isAdminPayment(payment)) return null;

  const request = await db.collection('billing_requests').findOne({
    transaction_id: payment.transaction_id,
    amount: Number(payment.amount || 0),
    status: { $in: ['pending', 'pending_review'] }
  });
  if (!request || !ObjectId.isValid(String(request.websiteId || '')) || !ObjectId.isValid(String(request.clientId || ''))) {
    return null;
  }

  const website = await db.collection('websites').findOne({ _id: request.websiteId, clientId: request.clientId });
  if (!website) return null;

  const months = Math.min(Math.max(Number(request.months || 1), 1), 24);
  const siteCount = Math.min(Math.max(Number(request.siteCount || 1), 1), 500);
  const expectedAmount = Number((computePlanAmount(siteCount) * months).toFixed(2));
  if (!isSameAmount(payment.amount, expectedAmount)) return null;

  const activation = await activateWebsiteFromAdminPayment({
    db,
    website,
    websiteId: request.websiteId,
    clientId: request.clientId,
    transactionId: payment.transaction_id,
    amount: payment.amount,
    months,
    purpose: website.paidUntil ? 'domain_subscription' : 'brand_opening',
    now
  });
  if (!activation) return null;

  await upsertBillingRequest({
    db,
    clientId: request.clientId,
    websiteId: request.websiteId,
    domain: request.domain || website.domain,
    transactionId: payment.transaction_id,
    amount: payment.amount,
    months,
    siteCount,
    status: 'approved',
    note: request.note || '',
    adminNote: 'Auto approved after matching admin SMS payment',
    paymentId: activation.payment?._id,
    autoApproved: true,
    now
  });

  return {
    websiteId: String(request.websiteId),
    domain: request.domain || website.domain,
    transaction_id: payment.transaction_id,
    amount: Number(payment.amount || 0),
    status: 'approved'
  };
}

function isAdminPayment(payment) {
  return payment?.submittedBy === 'admin'
    || Boolean(payment?.submittedByAdmin)
    || (payment?.submittedBy === 'android' && process.env.TRUST_LEGACY_ANDROID_ADMIN_SMS === 'true');
}

async function upsertClientDevice(db, submitter, body, now, countSms) {
  if (submitter.role !== 'client' || !ObjectId.isValid(submitter.id)) return;

  const deviceId = cleanString(firstValue(body.device_id, body.deviceId), 180);
  if (!deviceId) return;

  const clientId = new ObjectId(submitter.id);
  const update = {
    $set: {
      name: cleanString(firstValue(body.device_name, body.deviceName, body.name), 160) || 'Android device',
      model: cleanString(body.model, 120),
      manufacturer: cleanString(body.manufacturer, 120),
      appVersion: cleanString(firstValue(body.app_version, body.appVersion), 40),
      androidVersion: cleanString(firstValue(body.android_version, body.androidVersion), 40),
      status: 'online',
      lastSeenAt: now,
      updatedAt: now
    },
    $setOnInsert: {
      clientId,
      deviceId,
      createdAt: now
    }
  };

  if (countSms) {
    update.$set.lastSmsAt = now;
    update.$inc = { totalSms: 1 };
  } else {
    update.$setOnInsert.totalSms = 0;
  }

  await db.collection('client_devices').updateOne({ clientId, deviceId }, update, { upsert: true });
}
