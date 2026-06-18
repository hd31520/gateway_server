import { ObjectId } from 'mongodb';
import { getDb } from '../_db.js';
import { generateApiKey, hashApiKey, requireClient } from '../_auth.js';
import {
  activateWebsiteFromAdminPayment,
  normalizePayerNumber,
  normalizeTransactionId,
  paymentTimeWindow,
  upsertBillingRequest
} from '../_billing.js';
import {
  BRAND_OPENING_FEE,
  cleanString,

  normalizeDomain,
  normalizeWalletNumber,
  publicServerError,
  serializeWebsite
} from '../_utils.js';
import { safeRequestBody } from '../_utils.js';

export default async function handler(req, res) {
  const auth = await requireClient(req, res);
  if (!auth) return;
  if (!ObjectId.isValid(auth.id)) {
    return res.status(401).json({ success: false, error: 'Client login required' });
  }

  try {
    const db = await getDb();
    const clientId = new ObjectId(auth.id);

    if (req.method === 'GET') {
      const websites = await db.collection('websites').find({ clientId }).sort({ createdAt: -1 }).toArray();
      return res.status(200).json({ success: true, items: websites.map((website) => serializeWebsite(website)) });
    }

    if (req.method === 'POST') {
      const body = safeRequestBody(req, res);
      if (body === null) return;
      const domain = normalizeDomain(body.domain);
      const name = cleanString(body.name, 120) || domain;
      const walletProvider = cleanString(body.walletProvider || body.receiverMethod, 40).toLowerCase();
      const walletNumber = normalizeWalletNumber(body.walletNumber || body.receiverNumber);
      const receiverName = cleanString(body.receiverName, 120) || name;
      const transactionId = normalizeTransactionId(body.transaction_id || body.transactionId || body.adminTransactionId);
      const payerNumber = normalizePayerNumber(body.payer_number || body.payerNumber || body.senderNumber || body.customerPhone);
      const paymentStartedAt = normalizePaymentTime(body.payment_time || body.paymentTime) || new Date();
      const paymentWindow = paymentTimeWindow(paymentStartedAt);
      const allowedProviders = ['bkash', 'nagad', 'rocket', 'upay', 'bank', 'other'];

      if (!domain) {
        return res.status(400).json({ success: false, error: 'Valid domain is required' });
      }

      if (!allowedProviders.includes(walletProvider)) {
        return res.status(400).json({ success: false, error: 'Select where this brand will receive money' });
      }

      if (!walletNumber || walletNumber.length < 8) {
        return res.status(400).json({ success: false, error: 'Valid receiver wallet number is required' });
      }

      if (transactionId) {
        const existingRequest = await db.collection('billing_requests').findOne({ transaction_id: transactionId });
        if (existingRequest && String(existingRequest.clientId) !== String(clientId)) {
          return res.status(409).json({ success: false, error: 'This payment reference is already submitted by another account' });
        }
      }

      const now = new Date();
      const apiKey = generateApiKey();
      const website = {
        clientId,
        name,
        domain,
        apiKey,
        apiKeyHash: hashApiKey(apiKey),
        apiKeyLast4: apiKey.slice(-4),
        monthlyFee: BRAND_OPENING_FEE,
        brandCharge: BRAND_OPENING_FEE,
        brandStatus: 'pending_payment',
        paymentStatus: 'unpaid',
        walletProvider,
        walletNumber,
        receiverName,
        androidAppEnabled: false,
        paidUntil: null,
        createdAt: now,
        updatedAt: now
      };

      const result = await db.collection('websites').insertOne(website);
      website._id = result.insertedId;

      const activation = payerNumber || transactionId ? await activateWebsiteFromAdminPayment({
        db,
        website,
        websiteId: website._id,
        clientId,
        transactionId,
        payerNumber,
        paymentStartedAt: paymentWindow.startedAt,
        amount: BRAND_OPENING_FEE,
        months: 1,
        purpose: 'brand_opening'
      }) : null;

      if (activation) {
        const billingRequest = await upsertBillingRequest({
          db,
          clientId,
          websiteId: website._id,
          domain,
          transactionId,
          payerNumber,
          paymentStartedAt: paymentWindow.startedAt,
          amount: BRAND_OPENING_FEE,
          months: 1,
          status: 'approved',
          note: 'Brand opening payment submitted during brand creation',
          adminNote: 'Auto approved after matching admin SMS payment',
          paymentId: activation.payment?._id,
          autoApproved: true,
          now
        });

        return res.status(201).json({
          success: true,
          autoApproved: true,
          message: 'Admin SMS payment matched. Brand opened automatically and API key is ready.',
          website: serializeWebsite(activation.website),
          billingRequest
        });
      }

      if (payerNumber || transactionId) {
        await upsertBillingRequest({
          db,
          clientId,
          websiteId: website._id,
          domain,
          transactionId,
          payerNumber,
          paymentStartedAt: paymentWindow.startedAt,
          amount: BRAND_OPENING_FEE,
          months: 1,
          status: 'pending_review',
          note: 'Brand opening payment submitted during brand creation',
          adminNote: 'No matching admin SMS payment found yet',
          now
        });

        website.brandStatus = 'pending_review';
        website.paymentStatus = 'pending_review';
        website.adminNote = 'Payment submitted, but no matching admin SMS was found yet.';
        website.updatedAt = now;

        await db.collection('websites').updateOne(
          { _id: website._id, clientId },
          {
            $set: {
              brandStatus: website.brandStatus,
              paymentStatus: website.paymentStatus,
              adminNote: website.adminNote,
              updatedAt: now
            }
          }
        );

        return res.status(201).json({
          success: true,
          autoApproved: false,
          message: 'Brand request saved. It will auto-approve when matching admin SMS is recorded.',
          website: serializeWebsite(website)
        });
      }

      return res.status(201).json({
        success: true,
        autoApproved: false,
        message: 'Brand request saved. Submit the sender number used for gateway payment and it will auto-approve when SMS matches.',
        website: serializeWebsite(website)
      });
    }
    if (req.method === 'PUT') {
      const body = safeRequestBody(req, res);
      if (body === null) return;

      const websiteIdStr = cleanString(body.id || body.websiteId, 80);
      if (!websiteIdStr || !ObjectId.isValid(websiteIdStr)) {
        return res.status(400).json({ success: false, error: 'Valid Website ID is required' });
      }

      const websiteId = new ObjectId(websiteIdStr);
      const website = await db.collection('websites').findOne({ _id: websiteId, clientId });
      if (!website) {
        return res.status(404).json({ success: false, error: 'Website not found' });
      }

      const updates = {};

      if (body.domain !== undefined) {
        const domain = normalizeDomain(body.domain);
        if (!domain) {
          return res.status(400).json({ success: false, error: 'Valid domain is required' });
        }
        updates.domain = domain;
      }

      if (body.name !== undefined) {
        updates.name = cleanString(body.name, 120) || updates.domain || website.domain;
      }

      if (body.walletProvider !== undefined || body.receiverMethod !== undefined) {
        const walletProvider = cleanString(body.walletProvider || body.receiverMethod, 40).toLowerCase();
        const allowedProviders = ['bkash', 'nagad', 'rocket', 'upay', 'bank', 'other'];
        if (!allowedProviders.includes(walletProvider)) {
          return res.status(400).json({ success: false, error: 'Select where this brand will receive money' });
        }
        updates.walletProvider = walletProvider;
      }

      if (body.walletNumber !== undefined || body.receiverNumber !== undefined) {
        const walletNumber = normalizeWalletNumber(body.walletNumber || body.receiverNumber);
        if (!walletNumber || walletNumber.length < 8) {
          return res.status(400).json({ success: false, error: 'Valid receiver wallet number is required' });
        }
        updates.walletNumber = walletNumber;
      }

      if (body.receiverName !== undefined) {
        updates.receiverName = cleanString(body.receiverName, 120) || updates.name || website.name;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ success: false, error: 'No updates provided' });
      }

      updates.updatedAt = new Date();

      await db.collection('websites').updateOne(
        { _id: websiteId, clientId },
        { $set: updates }
      );

      const updatedWebsite = await db.collection('websites').findOne({ _id: websiteId, clientId });
      return res.status(200).json({
        success: true,
        message: 'Brand updated successfully.',
        website: serializeWebsite(updatedWebsite)
      });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ success: false, error: 'This domain is already registered' });
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
