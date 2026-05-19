import * as gateway from '../../../../payment-gateway.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'PATCH') return res.status(405).json({ success: false, error: 'Method not allowed' });
  req.params = req.params || {};
  const parts = req.url ? req.url.split('/') : [];
  const paymentId = parts[parts.length - 1] || req.query.paymentId;
  req.params.paymentId = paymentId;
  return gateway.cancelPayment(req, res);
}
