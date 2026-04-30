import { getDb } from '../_db.js';
import {
  cleanString,
  handleCors,
  isWebsiteActive,
  normalizeAmount,
  normalizeDomain,
  normalizePublicUrl,
  publicServerError,
  rateLimit
} from '../_utils.js';

function readApiKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-api-key'] || '').trim();
}

function unwrapMongoResult(result) {
  if (!result) return null;
  if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
  return result;
}

function ownerPaymentFilter(clientId) {
  return { $or: [{ submittedByClientId: clientId }, { clientId }] };
}

export default async function handler(req, res) {
  if (handleCors(req, res, 'POST, OPTIONS')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!rateLimit(req, res, { key: 'merchant-verify-ip', limit: 90, windowMs: 60_000 })) return;

  try {
    const body = req.body || {};
    const apiKey = readApiKey(req);
    const transactionId = cleanString(body.transaction_id, 120).toUpperCase();
    const amount = normalizeAmount(body.amount);
    const orderId = cleanString(body.order_id || body.orderId, 160);
    const sellerName = cleanString(body.seller_name || body.sellerName, 160);
    const buyerName = cleanString(body.buyer_name || body.buyerName || body.customer_name || body.customerName, 160);
    const buyerAddress = cleanString(body.buyer_address || body.buyerAddress || body.address, 500);
    const callbackUrl = normalizePublicUrl(body.callback_url || body.callbackUrl);
    const returnUrl = normalizePublicUrl(body.return_url || body.returnUrl);
    const manualAccept = body.manual === true || body.manual === 'true';
    const submittedDomain = normalizeDomain(body.domain);

    if (!apiKey || !transactionId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'api_key, transaction_id, and valid amount are required'
      });
    }

    if (!rateLimit(req, res, { key: 'merchant-verify-key', identity: apiKey, limit: 120, windowMs: 60_000 })) return;

    const db = await getDb();
    const website = await db.collection('websites').findOne({ apiKey });

    if (!website) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
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

    const existing = await db.collection('payment_verifications').findOne({ transaction_id: transactionId });
    if (existing) {
      const sameWebsite = String(existing.websiteId) === String(website._id);
      if (sameWebsite && Number(existing.amount) === amount) {
        return res.status(200).json({
          success: true,
          status: 'already_verified',
          verification: {
            id: String(existing._id),
            transaction_id: existing.transaction_id,
            amount: existing.amount,
            order_id: existing.order_id || null,
            verifiedAt: existing.createdAt
          }
        });
      }

      return res.status(409).json({ success: false, error: 'This transaction ID is already used' });
    }

    const now = new Date();
    if (manualAccept) {
      const verification = {
        clientId: website.clientId,
        websiteId: website._id,
        domain: website.domain,
        paymentId: null,
        transaction_id: transactionId,
        amount,
        order_id: orderId || null,
        sellerName,
        buyerName,
        buyerAddress,
        callbackUrl,
        returnUrl,
        status: 'manual_accepted',
        createdAt: now
      };

      const result = await db.collection('payment_verifications').insertOne(verification);
      verification._id = result.insertedId;

      return res.status(200).json({
        success: true,
        status: 'manual_accepted',
        redirectUrl: buildReturnUrl(returnUrl, 'completed', transactionId, orderId),
        verification: {
          id: String(verification._id),
          transaction_id: transactionId,
          amount,
          order_id: orderId || null,
          verifiedAt: now
        }
      });
    }

    const paymentResult = await db.collection('payments').findOneAndUpdate(
      {
        $and: [
          { transaction_id: transactionId, amount, status: { $ne: 'rejected' } },
          ownerPaymentFilter(website.clientId),
          { $or: [{ usedFor: { $exists: false } }, { usedFor: null }] }
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
    const payment = unwrapMongoResult(paymentResult);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'No unused payment found in this account with this transaction ID and amount',
        redirectUrl: buildReturnUrl(returnUrl, 'failed', transactionId, orderId)
      });
    }

    const verification = {
      clientId: website.clientId,
      websiteId: website._id,
      domain: website.domain,
      paymentId: payment._id,
      transaction_id: transactionId,
      amount,
      order_id: orderId || null,
      sellerName,
      buyerName,
      buyerAddress,
      callbackUrl,
      returnUrl,
      status: 'verified',
      createdAt: now
    };

    const result = await db.collection('payment_verifications').insertOne(verification);
    verification._id = result.insertedId;

    return res.status(200).json({
      success: true,
      status: 'verified',
      redirectUrl: buildReturnUrl(returnUrl, 'completed', transactionId, orderId),
      verification: {
        id: String(verification._id),
        transaction_id: transactionId,
        amount,
        order_id: orderId || null,
        verifiedAt: now
      }
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ success: false, error: 'This transaction ID is already used' });
    }
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

function buildReturnUrl(returnUrl, status, transactionId, orderId) {
  if (!returnUrl) return null;
  try {
    const url = new URL(returnUrl);
    url.searchParams.set('status', status);
    url.searchParams.set('transaction_id', transactionId);
    if (orderId) url.searchParams.set('order_id', orderId);
    return url.toString();
  } catch (error) {
    return null;
  }
}

function merchantManualAcceptEnabled(website) {
  return process.env.ALLOW_MANUAL_MERCHANT_ACCEPT === 'true' || website.manualAcceptEnabled === true;
}
