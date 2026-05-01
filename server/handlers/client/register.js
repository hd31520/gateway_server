import bcrypt from 'bcryptjs';
import { getDb } from '../_db.js';
import { signClientToken } from '../_auth.js';
import { getAdminConfig } from '../_admin.js';
import { cleanString, handleCors, isValidEmail, normalizeEmail, publicServerError, rateLimit, serializeClient, safeRequestBody } from '../_utils.js';

const MIN_PASSWORD_LENGTH = 10;

export default async function handler(req, res) {
  if (handleCors(req, res, 'POST, OPTIONS')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!rateLimit(req, res, { key: 'client-register', limit: 8, windowMs: 15 * 60_000 })) return;

  try {
    const body = safeRequestBody(req, res);
    if (body === null) return;
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const name = cleanString(body.name, 120) || email.split('@')[0];

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }

    const adminEmail = getAdminConfig().email;
    if (adminEmail && email === adminEmail) {
      return res.status(409).json({ success: false, error: 'Use the existing admin login for this email' });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const now = new Date();
    const passwordHash = await bcrypt.hash(password, 10);
    const client = {
      name,
      email,
      passwordHash,
      role: 'client',
      status: 'active',
      createdAt: now,
      updatedAt: now
    };

    const db = await getDb();
    const result = await db.collection('clients').insertOne(client);
    client._id = result.insertedId;

    const token = signClientToken(client);
    return res.status(201).json({ success: true, token, client: serializeClient(client) });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ success: false, error: 'This email already has an account' });
    }
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}
