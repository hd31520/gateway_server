import { ObjectId } from 'mongodb';
import { getDb } from '../_db.js';
import { requireClient } from '../_auth.js';
import {
  BRAND_OPENING_FEE,
  MONTHLY_DOMAIN_FEE,
  addOneMonth,
  cleanString,
  handleCors,
  normalizeAmount,
  serializeWebsite
} from '../_utils.js';

function unwrapMongoResult(result) {
  if (!result) return null;
  if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
  return result;
}

export default async function handler(req, res) {
  if (handleCors(req, res, 'POST, OPTIONS')) return;

  const auth = requireClient(req, res);
  if (!auth) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const websiteId = String(req.body?.websiteId || '');
    const transactionId = cleanString(req.body?.transaction_id, 120);
    const fee = BRAND_OPENING_FEE || MONTHLY_DOMAIN_FEE;
    const submittedAmount = normalizeAmount(req.body?.amount || fee);

    if (!ObjectId.isValid(websiteId) || !transactionId) {
      return res.status(400).json({ success: false, error: 'websiteId and transaction_id are required' });
    }

    if (submittedAmount !== fee) {
      return res.status(400).json({ success: false, error: `Domain monthly fee must be Tk ${fee}` });
    }

    const db = await getDb();
    const clientId = new ObjectId(auth.id);
    const websiteObjectId = new ObjectId(websiteId);
    const website = await db.collection('websites').findOne({ _id: websiteObjectId, clientId });

    if (!website) {
      return res.status(404).json({ success: false, error: 'Website not found' });
    }

    const now = new Date();
    const paymentResult = await db.collection('payments').findOneAndUpdate(
      {
        $and: [
          { transaction_id: transactionId, amount: fee, status: { $ne: 'rejected' } },
          { $or: [{ submittedByClientId: clientId }, { clientId }, { submittedByEmail: auth.email || '' }] },
          { $or: [{ usedFor: { $exists: false } }, { usedFor: null }] }
        ]
      },
      {
        $set: {
          status: 'verified',
          usedFor: 'domain_subscription',
          usedBy: websiteObjectId,
          websiteId: websiteObjectId,
          clientId,
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
        error: `No unused Tk ${fee} payment found for this account and transaction ID`
      });
    }

    const baseDate = website.paidUntil && new Date(website.paidUntil) > now
      ? new Date(website.paidUntil)
      : now;
    const paidUntil = addOneMonth(baseDate);

    await db.collection('subscription_renewals').insertOne({
      clientId,
      websiteId: websiteObjectId,
      paymentId: payment._id,
      transaction_id: transactionId,
      amount: fee,
      paidAt: now,
      paidUntil
    });

    await db.collection('websites').updateOne(
      { _id: websiteObjectId, clientId },
      {
        $set: {
          paidUntil,
          brandStatus: 'active',
          paymentStatus: 'paid',
          androidAppEnabled: true,
          approvedAt: website.approvedAt || now,
          updatedAt: now
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: 'Domain subscription renewed',
      website: serializeWebsite({ ...website, paidUntil, updatedAt: now })
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ success: false, error: 'This transaction ID was already used' });
    }
    console.error(error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}
