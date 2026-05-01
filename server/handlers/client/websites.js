import { ObjectId } from 'mongodb';
import { getDb } from '../_db.js';
import { generateApiKey, requireClient } from '../_auth.js';
import {
  activateWebsiteFromAdminPayment,
  normalizeTransactionId,
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
          return res.status(409).json({ success: false, error: 'This transaction ID is already submitted by another account' });
        }
      }

      const now = new Date();
      const website = {
        clientId,
        name,
        domain,
        apiKey: generateApiKey(),
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

      if (transactionId) {
        const activation = await activateWebsiteFromAdminPayment({
          db,
          website,
          websiteId: website._id,
          clientId,
          transactionId,
          amount: BRAND_OPENING_FEE,
          months: 1,
          purpose: 'brand_opening'
        });

        if (activation) {
          const billingRequest = await upsertBillingRequest({
            db,
            clientId,
            websiteId: website._id,
            domain,
            transactionId,
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

        await upsertBillingRequest({
          db,
          clientId,
          websiteId: website._id,
          domain,
          transactionId,
          amount: BRAND_OPENING_FEE,
          months: 1,
          status: 'pending_review',
          note: 'Brand opening payment submitted during brand creation',
          adminNote: 'No matching admin SMS payment found yet',
          now
        });

        website.brandStatus = 'pending_review';
        website.paymentStatus = 'pending_review';
        website.adminNote = 'Payment TrxID submitted, but no matching admin SMS was found yet.';
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
          message: 'Brand request saved. It will auto-approve when the matching admin SMS TrxID is recorded.',
          website: serializeWebsite(website)
        });
      }

      return res.status(201).json({
        success: true,
        autoApproved: false,
        message: 'Brand request saved. Submit the admin payment TrxID and it will auto-approve when the SMS matches.',
        website: serializeWebsite(website)
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
