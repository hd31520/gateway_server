import { requireClient } from '../../_auth.js';
import { getDb } from '../../_db.js';
import { ObjectId } from 'mongodb';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  const payload = await requireClient(req, res);
  if (!payload) return;

  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ success: false, error: 'Missing domain' });

  try {
    const db = getDb();
    const subs = db.collection('subscriptions');
    const sub = await subs.findOne({ clientId: new ObjectId(String(payload.id)) });
    if (!sub) return res.status(404).json({ success: false, error: 'Subscription not found' });
    if (sub.type !== 'unlimited') return res.status(403).json({ success: false, error: 'Subscription does not allow domains' });

    // allow unlimited domains — push if not present
    const domains = Array.isArray(sub.domains) ? sub.domains : [];
    if (!domains.includes(domain)) domains.push(domain);
    await subs.updateOne({ _id: sub._id }, { $set: { domains } });
    return res.status(200).json({ success: true, domains });
  } catch (err) {
    console.error('Add domain error:', err);
    return res.status(500).json({ success: false, error: 'Failed to add domain' });
  }
}
