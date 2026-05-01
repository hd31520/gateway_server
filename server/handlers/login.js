import { createAdminSession } from './_admin.js';
import { rateLimit, safeRequestBody } from './_utils.js';

export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!rateLimit(req, res, { key: 'admin-login', limit: 8, windowMs: 15 * 60_000 })) return;

  const body = safeRequestBody(req, res);
  if (body === null) return;

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
