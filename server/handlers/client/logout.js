import { revokeBearerToken } from '../_auth.js';
import { publicServerError } from '../_utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res, 'POST, OPTIONS')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    await revokeBearerToken(req, 'client');
    return res.status(200).json({ success: true, message: 'Logged out' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}
