import bcrypt from 'bcryptjs';
import { getDb } from '../_db.js';
import { signClientToken } from '../_auth.js';
import { createAdminSession, getAdminConfig } from '../_admin.js';
import { cleanString, normalizeEmail, publicServerError, rateLimit, safeRequestBody, serializeClient } from '../_utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res, 'POST, OPTIONS')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!rateLimit(req, res, { key: 'client-login', limit: 12, windowMs: 15 * 60_000 })) return;

  try {
    const body = safeRequestBody(req, res);
    if (body === null) return;

    const email = normalizeEmail(body.email);
    const password = String(body.password || '');

    const adminSession = await createAdminSession({ email, password });
    if (adminSession.ok) {
      const db = await getDb();
      const now = new Date();
      const adminClient = {
        name: cleanString(process.env.ADMIN_NAME || 'Administrator', 120),
        email: adminSession.admin.email,
        role: 'admin',
        status: 'active',
        updatedAt: now,
        createdAt: now
      };

      const storedAdmin = await db.collection('clients').findOneAndUpdate(
        { email: adminClient.email },
        {
          $set: {
            name: adminClient.name,
            role: 'admin',
            status: 'active',
            updatedAt: now
          },
          $setOnInsert: {
            email: adminClient.email,
            createdAt: now
          }
        },
        { upsert: true, returnDocument: 'after' }
      );

      const client = storedAdmin.value || adminClient;
      const token = signClientToken(client);
      return res.status(200).json({
        success: true,
        token,
        client: serializeClient(client),
        admin: serializeClient(client),
        config: getAdminConfig()
      });
    }

    const db = await getDb();
    const client = await db.collection('clients').findOne({ email });
    const ok = client && client.passwordHash ? await bcrypt.compare(password, client.passwordHash) : false;

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
