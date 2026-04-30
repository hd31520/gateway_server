import { ObjectId } from 'mongodb';
import { getDb } from './_db.js';
import { requireSmsSubmitter } from './_auth.js';
import { cleanString, handleCors, normalizeAmount, publicServerError, rateLimit, serializePayment } from './_utils.js';

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
  if (!payment || submitter.role !== 'client' || !ObjectId.isValid(submitter.id)) return false;
  const clientId = String(submitter.id);
  return String(payment.submittedByClientId || '') === clientId
    || String(payment.clientId || '') === clientId
    || (submitter.email && payment.submittedByEmail === submitter.email);
}

export default async function handler(req, res) {
  if (handleCors(req, res, 'POST, OPTIONS')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!rateLimit(req, res, { key: 'sms-submit', limit: 180, windowMs: 60_000 })) return;

  const submitter = requireSmsSubmitter(req, res);
  if (!submitter) return;

  try {
    const body = req.body || {};
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
        return res.status(200).json({
          success: true,
          duplicate: true,
          message: 'Payment already saved',
          payment: serializePayment(existing)
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
    }
    if (submitter.role === 'admin') {
      payment.submittedByAdmin = submitter.username || '';
    }

    await db.collection('payments').insertOne(payment);
    await upsertClientDevice(db, submitter, body, now, true);

    return res.status(201).json({ success: true, message: 'Payment saved', payment: serializePayment(payment) });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(200).json({ success: true, duplicate: true, message: 'Payment already saved' });
    }
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
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
