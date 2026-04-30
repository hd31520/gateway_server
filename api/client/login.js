import bcrypt from 'bcryptjs';
import { getDb } from '../_db.js';
import { signClientToken } from '../_auth.js';
import { handleCors, normalizeEmail, publicServerError, rateLimit, serializeClient } from '../_utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res, 'POST, OPTIONS')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!rateLimit(req, res, { key: 'client-login', limit: 12, windowMs: 15 * 60_000 })) return;

  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');

    const db = await getDb();
    const client = await db.collection('clients').findOne({ email });
    const ok = client ? await bcrypt.compare(password, client.passwordHash) : false;

    if (!ok || client.status === 'blocked') {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const token = signClientToken(client);
    return res.status(200).json({ success: true, token, client: serializeClient(client) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}
