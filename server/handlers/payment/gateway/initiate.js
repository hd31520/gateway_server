import * as gateway from '../../payment-gateway.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  // delegate to core function
  return gateway.initiatePayment(req, res);
}
