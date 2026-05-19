import { ObjectId } from 'mongodb';
import { getDb } from '../_db.js';
import { requireClient } from '../_auth.js';
import {
  activateWebsiteFromAdminPayment,
  normalizePayerNumber,
  normalizeTransactionId,
  paymentTimeWindow,
  upsertBillingRequest
} from '../_billing.js';
import {
  BRAND_OPENING_FEE,
  MONTHLY_DOMAIN_FEE,
  computePlanTotalAmount,
  normalizeAmount,
  normalizeBillingMonths,
  publicServerError,
  serializeBillingRequest,
  serializeWebsite
} from '../_utils.js';
import { safeRequestBody } from '../_utils.js';

export default async function handler(req, res) {
  const auth = await requireClient(req, res);
  if (!auth) return;
  if (!ObjectId.isValid(auth.id)) {
    return res.status(401).json({ success: false, error: 'Client login required' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = safeRequestBody(req, res);
    if (body === null) return;

    const websiteId = String(body.websiteId || '');
    const transactionId = normalizeTransactionId(body.transaction_id || body.transactionId);
    const payerNumber = normalizePayerNumber(body.payer_number || body.payerNumber || body.senderNumber || body.customerPhone);
    const paymentStartedAt = normalizePaymentTime(body.payment_time || body.paymentTime) || new Date();
    const paymentWindow = paymentTimeWindow(paymentStartedAt);
    const siteCount = Number(body.siteCount || 1) || 1;
    const months = normalizeBillingMonths(body.months || 1);
    const fee = body.siteCount ? computePlanTotalAmount(siteCount, months) : (BRAND_OPENING_FEE || MONTHLY_DOMAIN_FEE);
    const submittedAmount = normalizeAmount(body.amount || fee);

    if (!ObjectId.isValid(websiteId) || (!transactionId && !payerNumber)) {
      return res.status(400).json({ success: false, error: 'websiteId and payer_number are required' });
    }

    if (submittedAmount !== fee) {
      return res.status(400).json({ success: false, error: `Submitted amount must equal Tk ${fee} for selected plan` });
    }

    const db = await getDb();
    const clientId = new ObjectId(auth.id);
    const websiteObjectId = new ObjectId(websiteId);
    const website = await db.collection('websites').findOne({ _id: websiteObjectId, clientId });

    if (!website) {
      return res.status(404).json({ success: false, error: 'Website not found' });
    }

    const now = new Date();
    const activation = await activateWebsiteFromAdminPayment({
      db,
      website,
      websiteId: websiteObjectId,
      clientId,
      transactionId,
      payerNumber,
      paymentStartedAt: paymentWindow.startedAt,
      amount: fee,
      months,
      purpose: website.paidUntil ? 'domain_subscription' : 'brand_opening',
      now
    });

    if (activation) {
      const billingRequest = await upsertBillingRequest({
        db,
        clientId,
        websiteId: websiteObjectId,
        domain: website.domain,
        transactionId,
        payerNumber,
        paymentStartedAt: paymentWindow.startedAt,
        amount: fee,
        months,
        siteCount,
        status: 'approved',
        note: 'Subscription payment submitted from client portal',
        adminNote: 'Auto approved after matching admin SMS payment',
        paymentId: activation.payment?._id,
        autoApproved: true,
        now
      });

      return res.status(200).json({
        success: true,
        autoApproved: true,
        message: activation.alreadyApplied
          ? 'This admin SMS payment was already applied to this brand.'
          : 'Admin SMS payment matched. Brand activated automatically and API key is ready.',
        website: serializeWebsite(activation.website),
        billingRequest
      });
    }

    const billingRequest = await upsertBillingRequest({
      db,
      clientId,
      websiteId: websiteObjectId,
      domain: website.domain,
      transactionId,
      payerNumber,
      paymentStartedAt: paymentWindow.startedAt,
      amount: fee,
      months,
      siteCount,
      status: 'pending_review',
      note: 'Subscription payment submitted from client portal',
      adminNote: 'Waiting for matching admin SMS payment',
      now
    });

    return res.status(202).json({
      success: true,
      autoApproved: false,
      message: 'Subscription request saved. It will auto-approve when matching admin SMS is recorded.',
      website: serializeWebsite(website),
      billingRequest: billingRequest ? serializeBillingRequest(billingRequest) : null
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ success: false, error: 'This payment was already used' });
    }
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

function normalizePaymentTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
