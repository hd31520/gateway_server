import { requireAdmin } from '../../_auth.js';
import { getDb } from '../../_db.js';
import { ObjectId } from 'mongodb';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { clientId, type = 'unlimited' } = req.body || {};
  if (!clientId) return res.status(400).json({ success: false, error: 'Missing clientId' });

  try {
    const db = getDb();
    const subs = db.collection('subscriptions');
    const sub = {
      clientId: new ObjectId(clientId),
      type,
      domains: [],
      createdAt: new Date(),
    };
    const r = await subs.insertOne(sub);
    return res.status(200).json({ success: true, subscriptionId: r.insertedId.toString() });
  } catch (err) {
    console.error('Create subscription error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create subscription' });
  }
}
