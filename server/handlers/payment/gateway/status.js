import * as gateway from '../../payment-gateway.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });
  // attach params from req.query if present
  req.params = req.params || {};
  // route is /api/payment/gateway/status/:paymentId — local-server sets req.query for search params,
  // but path params are expected in the file name; extract paymentId from the URL path
  const parts = req.url ? req.url.split('/') : [];
  // last part should be paymentId
  const paymentId = parts[parts.length - 1] || req.query.paymentId;
  req.params.paymentId = paymentId;
  return gateway.getPaymentStatus(req, res);
}
