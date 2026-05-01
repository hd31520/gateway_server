import { handleCors } from './_utils.js';

export default function handler(req, res) {
  if (handleCors(req, res, 'GET, OPTIONS')) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  res.status(200).json({
    success: true,
    message: 'Payment gateway API is running',
    version: 'security-dynamic-client-android-2026-04-29'
  });
}
