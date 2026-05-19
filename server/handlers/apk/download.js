import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireClient } from '../_auth.js';
import { getDb } from '../_db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const payload = await requireClient(req, res);
  if (!payload) return; // requireClient already sent response

  try {
    const db = getDb();
    const clients = db.collection('clients');
    const client = await clients.findOne({ _id: new global.ObjectId(String(payload.id)) });
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    // Allow if client has explicit permission or is admin userRole
    const canDownload = client.canDownloadApk === true || payload.userRole === 'admin' || client.role === 'admin';
    if (!canDownload) return res.status(403).json({ success: false, error: 'Download permission required' });

    const apkPath = path.resolve(__dirname, '..', '..', 'public', 'gatewayflow-android.apk');
    if (!fs.existsSync(apkPath)) return res.status(404).json({ success: false, error: 'APK not available' });

    const stat = fs.statSync(apkPath);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', 'attachment; filename="gatewayflow-android.apk"');

    const stream = fs.createReadStream(apkPath);
    stream.pipe(res);
  } catch (err) {
    console.error('APK download error:', err);
    res.status(500).json({ success: false, error: 'Unable to serve APK' });
  }
}
