import { requireClient, hashApiKey } from '../../_auth.js';
import { getDb } from '../../_db.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  const payload = await requireClient(req, res);
  if (!payload) return;

  // Only client-level admins can create dynamic users
  const isClientAdmin = payload.userRole === 'admin';
  if (!isClientAdmin) return res.status(403).json({ success: false, error: 'Client admin required' });

  const { name, email, role = 'user' } = req.body || {};
  if (!name) return res.status(400).json({ success: false, error: 'Missing name' });

  try {
    const db = getDb();
    const users = db.collection('client_users');
    const rawKey = `user_${crypto.randomBytes(12).toString('hex')}`;
    const user = {
      clientId: payload.id,
      name,
      email: email || '',
      role,
      createdAt: new Date(),
      apiKeyHash: hashApiKey(rawKey)
    };
    const r = await users.insertOne(user);
    return res.status(200).json({ success: true, userId: r.insertedId.toString(), apiKey: rawKey });
  } catch (err) {
    console.error('Create client user error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create client user' });
  }
}
