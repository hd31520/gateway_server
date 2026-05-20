import { getDb } from '../_db.js';
import { hashApiKey } from '../_auth.js';
import {
  findConflictingPendingMerchantVerification,
  normalizePayerNumber,
  ownerPaymentFilter,
  paymentTimeWindow,
  pendingMatchesPayment,
  upsertPendingMerchantVerification,
  unwrapMongoResult
} from '../_merchant_verification.js';
import { toObjectId } from '../_billing.js';
import {
  cleanString,
  isWebsiteActive,
  normalizeAmount,
  normalizeDomain,
  normalizePublicUrl,
  publicServerError,
  rateLimit,
  requireJsonRequest,
  setSecurityHeaders
} from '../_utils.js';
import { safeRequestBody } from '../_utils.js';

function readApiKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-api-key'] || '').trim();
}

export default async function handler(req, res) {
  if (handleMerchantCors(req, res)) return;

  if (req.method === 'GET') {
    return handleMerchantStatus(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!rateLimit(req, res, { key: 'merchant-verify-ip', limit: 90, windowMs: 60_000 })) return;
  if (!requireJsonRequest(req, res)) return;

  try {
    const body = safeRequestBody(req, res);
    if (body === null) return;
    const apiKey = readApiKey(req);
    const transactionId = cleanString(body.transaction_id || body.transactionId || body.trxId || body.txnId, 120).toUpperCase();
    const amount = normalizeAmount(body.amount);
    const payerNumber = normalizePayerNumber(body.payer_number || body.payerNumber || body.customer_phone || body.customerPhone || body.sender_number || body.senderNumber);
    const paymentStartedAt = normalizePaymentTime(body.payment_time || body.paymentTime) || new Date();
    const paymentWindow = paymentTimeWindow(paymentStartedAt);
    const orderId = cleanString(body.order_id || body.orderId, 160);
    const sellerName = cleanString(body.seller_name || body.sellerName, 160);
    const buyerName = cleanString(body.buyer_name || body.buyerName || body.customer_name || body.customerName, 160);
    const buyerAddress = cleanString(body.buyer_address || body.buyerAddress || body.address, 500);
    const callbackUrl = normalizePublicUrl(body.callback_url || body.callbackUrl);
    const returnUrl = normalizePublicUrl(body.return_url || body.returnUrl);
    const walletProvider = cleanString(body.payment_method || body.paymentMethod || body.walletProvider || body.provider, 60).toLowerCase();
    const receiverNumber = cleanString(body.receiver_number || body.receiverNumber || body.merchant_number || body.merchantNumber, 80).replace(/\D/g, '');
    const manualAccept = body.manual === true || body.manual === 'true';
    const submittedDomain = normalizeDomain(body.domain);
    const checkoutReference = transactionId || buildCheckoutReference({ payerNumber, amount, orderId, paymentStartedAt });

    if (!apiKey || !amount || (!transactionId && !payerNumber)) {
      return res.status(400).json({
        success: false,
        error: 'api_key, valid amount, and payer_number are required'
      });
    }

    if (!rateLimit(req, res, { key: 'merchant-verify-key', identity: apiKey, limit: 120, windowMs: 60_000 })) return;

    const db = await getDb();
    const website = await db.collection('websites').findOne({
      $or: [
        { apiKeyHash: hashApiKey(apiKey) },
        { apiKey }
      ]
    });

    if (!website) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    if (!requestOriginAllowedForWebsite(req, website)) {
      return res.status(403).json({ success: false, error: 'Request origin does not match this API key domain' });
    }

    if (!isWebsiteActive(website)) {
      return res.status(402).json({ success: false, error: 'Domain monthly payment is due' });
    }

    if (submittedDomain && submittedDomain !== website.domain) {
      return res.status(403).json({ success: false, error: 'Domain does not match this API key' });
    }

    if (manualAccept && !merchantManualAcceptEnabled(website)) {
      return res.status(403).json({ success: false, error: 'Manual payment acceptance is disabled for this gateway' });
    }

    const existing = transactionId
      ? await db.collection('payment_verifications').findOne({ transaction_id: transactionId })
      : null;
    if (existing) {
      const sameWebsite = String(existing.websiteId) === String(website._id);
      if (sameWebsite && Number(existing.amount) === amount) {
        return res.status(200).json({
          success: true,
          status: 'already_verified',
          verification: {
            id: String(existing._id),
            transaction_id: existing.transaction_id,
            payment_ref: existing.transaction_id,
            payer_number: existing.payer_number || '',
            amount: existing.amount,
            order_id: existing.order_id || null,
            verifiedAt: existing.createdAt
          }
        });
      }

      return res.status(409).json({ success: false, error: 'This payment reference is already used' });
    }

    const conflictingPending = transactionId
      ? await findConflictingPendingMerchantVerification(db, website, transactionId, amount)
      : null;
    if (conflictingPending) {
      return res.status(409).json({ success: false, error: 'This payment reference is already waiting for another verification' });
    }

    const now = new Date();
    if (manualAccept) {
      const verification = {
        clientId: website.clientId,
        websiteId: website._id,
        domain: website.domain,
        paymentId: null,
        transaction_id: checkoutReference,
        payer_number: payerNumber,
        amount,
        order_id: orderId || null,
        sellerName,
        buyerName,
        buyerAddress,
        callbackUrl,
        returnUrl,
        walletProvider,
        receiverNumber,
        status: 'manual_accepted',
        createdAt: now
      };

      const result = await db.collection('payment_verifications').insertOne(verification);
      verification._id = result.insertedId;
      await db.collection('merchant_verification_requests').updateOne(
        transactionId ? { transaction_id: transactionId } : { _id: verification._id },
        {
          $set: {
            clientId: website.clientId,
            websiteId: website._id,
            domain: website.domain,
            paymentId: null,
            verificationId: verification._id,
            transaction_id: checkoutReference,
            payer_number: payerNumber,
            amount,
            order_id: orderId || null,
            sellerName,
            buyerName,
            buyerAddress,
            callbackUrl,
            returnUrl,
            walletProvider,
            receiverNumber,
            status: 'manual_accepted',
            verifiedAt: now,
            updatedAt: now
          },
          $setOnInsert: {
            createdAt: now,
            firstSubmittedAt: now
          }
        },
        { upsert: true }
      );

      return res.status(200).json({
        success: true,
        status: 'manual_accepted',
        redirectUrl: buildReturnUrl(returnUrl, 'completed', transactionId, orderId),
        verification: {
          id: String(verification._id),
          transaction_id: checkoutReference,
          payment_ref: checkoutReference,
          payer_number: payerNumber,
          amount,
          order_id: orderId || null,
          verifiedAt: now
        }
      });
    }

    const paymentQuery = transactionId
      ? { transaction_id: transactionId, amount, status: { $ne: 'rejected' } }
      : { payer_number: payerNumber, amount, status: { $ne: 'rejected' } };
    const candidatePayments = await db.collection('payments')
      .find({
        $and: [
          paymentQuery,
          ownerPaymentFilter(website.clientId),
          { $or: [{ usedFor: { $exists: false } }, { usedFor: null }, { usedFor: '' }] }
        ]
      })
      .sort({ receivedAt: -1, createdAt: -1 })
      .limit(10)
      .toArray();
    const candidatePayment = candidatePayments.find((item) => pendingMatchesPayment(
      {
        amount,
        payer_number: payerNumber,
        transaction_id: transactionId,
        paymentStartedAt: paymentWindow.startedAt,
        expiresAt: paymentWindow.expiresAt
      },
      item,
      { amount, payerNumber, transactionId, now }
    ));
    let payment = null;
    if (candidatePayment) {
      const claimResult = await db.collection('payments').findOneAndUpdate(
        {
          $and: [
            { _id: candidatePayment._id },
            paymentQuery,
            ownerPaymentFilter(website.clientId),
            { $or: [{ usedFor: { $exists: false } }, { usedFor: null }, { usedFor: '' }] }
          ]
        },
        {
          $set: {
            status: 'verified',
            usedFor: 'merchant_payment',
            usedBy: website._id,
            websiteId: website._id,
            clientId: website.clientId,
            verifiedAt: now,
            updatedAt: now
          }
        },
        { returnDocument: 'after' }
      );
      payment = unwrapMongoResult(claimResult);
    }

    if (!payment) {
      const pendingVerification = await upsertPendingMerchantVerification({
        db,
        website,
        transactionId,
        amount,
        payerNumber,
        paymentStartedAt: paymentWindow.startedAt,
        orderId,
        sellerName,
        buyerName,
        buyerAddress,
        callbackUrl,
        returnUrl,
        walletProvider,
        receiverNumber,
        now
      });

      return res.status(202).json({
        success: true,
        status: 'pending_sms',
        message: 'Payment verification is pending until the matching Android SMS record arrives for the sender number, amount, and time window',
        redirectUrl: buildReturnUrl(returnUrl, 'pending', transactionId, orderId),
        pendingVerification: {
          id: pendingVerification?._id ? String(pendingVerification._id) : null,
          transaction_id: transactionId,
          payment_ref: transactionId || '',
          payer_number: payerNumber,
          amount,
          order_id: orderId || null,
          payment_method: walletProvider,
          receiver_number: receiverNumber,
          status: 'pending_sms'
        }
      });
    }

    const verification = {
      clientId: website.clientId,
      websiteId: website._id,
      domain: website.domain,
      paymentId: payment._id,
      transaction_id: checkoutReference || payment.transaction_id,
      payer_number: payerNumber,
      amount,
      order_id: orderId || null,
      sellerName,
      buyerName,
      buyerAddress,
      callbackUrl,
      returnUrl,
      walletProvider,
      receiverNumber,
      status: 'verified',
      createdAt: now
    };

    const result = await db.collection('payment_verifications').insertOne(verification);
    verification._id = result.insertedId;
    await db.collection('merchant_verification_requests').updateOne(
      transactionId ? { transaction_id: transactionId } : { _id: verification._id },
      {
        $set: {
          clientId: website.clientId,
          websiteId: website._id,
          domain: website.domain,
          status: 'verified',
          paymentId: payment._id,
          verificationId: verification._id,
          transaction_id: checkoutReference || payment.transaction_id,
          payer_number: payerNumber,
          amount,
          order_id: orderId || null,
          sellerName,
          buyerName,
          buyerAddress,
          callbackUrl,
          returnUrl,
          walletProvider,
          receiverNumber,
          verifiedAt: now,
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now,
          firstSubmittedAt: now
        }
      },
      { upsert: true }
    );

    return res.status(200).json({
      success: true,
      status: 'verified',
      redirectUrl: buildReturnUrl(returnUrl, 'completed', transactionId, orderId),
      verification: {
        id: String(verification._id),
        transaction_id: checkoutReference || payment.transaction_id,
        payment_ref: checkoutReference || payment.transaction_id,
        payer_number: payerNumber,
        amount,
        order_id: orderId || null,
        verifiedAt: now
      }
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ success: false, error: 'This payment reference is already used' });
    }
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

function handleMerchantCors(req, res) {
  setSecurityHeaders(res);
  const origin = cleanString(req.headers.origin, 300);
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  if (origin) res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

async function handleMerchantStatus(req, res) {
  if (!rateLimit(req, res, { key: 'merchant-status-ip', limit: 180, windowMs: 60_000 })) return;

  try {
    const apiKey = readApiKey(req);
    if (!apiKey) return res.status(400).json({ success: false, error: 'api_key is required' });
    if (!rateLimit(req, res, { key: 'merchant-status-key', identity: apiKey, limit: 240, windowMs: 60_000 })) return;

    const url = new URL(req.url || '/api/merchant/verify', `http://${req.headers.host || 'localhost'}`);
    const requestId = cleanString(url.searchParams.get('request_id') || url.searchParams.get('requestId') || '', 80);
    const orderId = cleanString(url.searchParams.get('order_id') || url.searchParams.get('orderId') || '', 160);
    const payerNumber = normalizePayerNumber(url.searchParams.get('payer_number') || url.searchParams.get('payerNumber'));
    const amount = normalizeAmount(url.searchParams.get('amount'));
    const wantsConfig = url.searchParams.get('config') === '1' || url.searchParams.get('action') === 'config';
    const submittedDomain = normalizeDomain(url.searchParams.get('domain'));

    const db = await getDb();
    const website = await db.collection('websites').findOne({
      $or: [
        { apiKeyHash: hashApiKey(apiKey) },
        { apiKey }
      ]
    });
    if (!website) return res.status(401).json({ success: false, error: 'Invalid API key' });
    if (!requestOriginAllowedForWebsite(req, website)) {
      return res.status(403).json({ success: false, error: 'Request origin does not match this API key domain' });
    }
    if (submittedDomain && submittedDomain !== website.domain) {
      return res.status(403).json({ success: false, error: 'Domain does not match this API key' });
    }

    if (wantsConfig) {
      return res.status(200).json({
        success: true,
        domain: website.domain,
        merchantName: website.name || website.domain,
        walletProvider: website.walletProvider || 'bkash',
        walletNumber: website.walletNumber || '',
        receiverName: website.receiverName || website.name || website.domain || '',
        paymentMethods: [website.walletProvider || 'bkash'].filter(Boolean)
      });
    }

    if (!requestId && (!orderId || !payerNumber || !amount)) {
      return res.status(400).json({ success: false, error: 'request_id or order_id, payer_number, and amount are required' });
    }

    const query = requestId
      ? { _id: toObjectId(requestId), websiteId: website._id }
      : { websiteId: website._id, order_id: orderId || null, payer_number: payerNumber, amount };
    const pending = await db.collection('merchant_verification_requests').findOne(query);
    if (!pending) return res.status(404).json({ success: false, error: 'Payment request not found' });

    const verification = pending.verificationId
      ? await db.collection('payment_verifications').findOne({ _id: pending.verificationId, websiteId: website._id })
      : null;
    return res.status(200).json({
      success: true,
      status: pending.status || 'pending_sms',
      requestId: String(pending._id),
      message: pending.status === 'verified' ? 'Payment confirmed by Android SMS server.' : 'Waiting for matching Android SMS.',
      verification: verification ? {
        id: String(verification._id),
        transaction_id: verification.transaction_id,
        payment_ref: verification.transaction_id,
        payer_number: verification.payer_number || '',
        amount: verification.amount,
        order_id: verification.order_id || null,
        verifiedAt: verification.createdAt
      } : null
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

function buildReturnUrl(returnUrl, status, transactionId, orderId) {
  if (!returnUrl) return null;
  try {
    const url = new URL(returnUrl);
    url.searchParams.set('status', status);
    if (transactionId) url.searchParams.set('payment_ref', transactionId);
    if (orderId) url.searchParams.set('order_id', orderId);
    return url.toString();
  } catch (error) {
    return null;
  }
}

function buildCheckoutReference({ payerNumber, amount, orderId, paymentStartedAt }) {
  const stamp = Number(paymentStartedAt?.getTime?.() || Date.now()).toString(36).toUpperCase();
  const phoneTail = String(payerNumber || 'PHONE').slice(-4) || 'PHONE';
  const amountPart = Number(amount || 0).toFixed(2).replace(/\D/g, '');
  const orderPart = cleanString(orderId, 24).replace(/[^a-z0-9]/gi, '').toUpperCase() || 'ORDER';
  return `PAY-${orderPart}-${phoneTail}-${amountPart}-${stamp}`;
}

function normalizePaymentTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function merchantManualAcceptEnabled(website) {
  return process.env.ALLOW_MANUAL_MERCHANT_ACCEPT === 'true' || website.manualAcceptEnabled === true;
}

function requestOriginAllowedForWebsite(req, website) {
  const origin = cleanString(req.headers.origin, 300);
  const referer = cleanString(req.headers.referer, 500);
  const source = origin || referer;
  if (!source) return true;

  try {
    const hostname = normalizeDomain(new URL(source).hostname);
    const requestHost = normalizeDomain(String(req.headers.host || '').split(':')[0]);
    if (requestHost && hostname === requestHost) return true;
    return hostname === website.domain || hostname.endsWith(`.${website.domain}`);
  } catch (error) {
    return false;
  }
}
