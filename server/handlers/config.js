export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });
  const raw = process.env.ALLOWED_CALLBACKS || '';
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  res.status(200).json({ success: true, allowedCallbacks: list });
}
