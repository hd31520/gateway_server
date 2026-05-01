import { ObjectId } from 'mongodb';
import { getDb } from '../_db.js';
import { generateApiKey, requireClient } from '../_auth.js';
import {
  BRAND_OPENING_FEE,
  cleanString,
  handleCors,
  normalizeDomain,
  normalizeWalletNumber,
  publicServerError,
  serializeWebsite
} from '../_utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res, 'GET, POST, OPTIONS')) return;

  const auth = await requireClient(req, res);
  if (!auth) return;

  try {
    const db = await getDb();
    const clientId = new ObjectId(auth.id);

    if (req.method === 'GET') {
      const websites = await db.collection('websites').find({ clientId }).sort({ createdAt: -1 }).toArray();
      return res.status(200).json({ success: true, items: websites.map((website) => serializeWebsite(website)) });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const domain = normalizeDomain(body.domain);
      const name = cleanString(body.name, 120) || domain;
      const walletProvider = cleanString(body.walletProvider || body.receiverMethod, 40).toLowerCase();
      const walletNumber = normalizeWalletNumber(body.walletNumber || body.receiverNumber);
      const receiverName = cleanString(body.receiverName, 120) || name;
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

      return res.status(201).json({ success: true, website: serializeWebsite(website) });
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
