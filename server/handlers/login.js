import { createAdminSession } from './_admin.js';
import { normalizeEmail, rateLimit, safeRequestBody } from './_utils.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!rateLimit(req, res, { key: 'admin-login', limit: 8, windowMs: 15 * 60_000 })) return;

  const body = safeRequestBody(req, res);
  if (body === null) return;
  const email = normalizeEmail(body.email);

  if (email && !rateLimit(req, res, { key: 'admin-login-email', identity: email, limit: 5, windowMs: 15 * 60_000 })) return;
  if (String(body.password || '').length > 256) {
    return res.status(400).json({ success: false, error: 'Invalid admin credentials' });
  }

  const session = await createAdminSession(body);
  if (!session.ok) {
    return res.status(session.status).json({ success: false, error: session.error });
  }

  return res.status(200).json({
    success: true,
    token: session.token,
    admin: session.admin,
    config: session.config
  });
}
