import { ObjectId } from 'mongodb';
import { getDb } from '../_db.js';
import { requireClient } from '../_auth.js';
import { cleanString, publicServerError, serializeDevice } from '../_utils.js';

export default async function handler(req, res) {
  const auth = await requireClient(req, res);
  if (!auth) return;

  try {
    const db = await getDb();
    const clientId = new ObjectId(auth.id);

    if (req.method === 'GET') {
      const devices = await db.collection('client_devices').find({ clientId }).sort({ lastSeenAt: -1 }).limit(50).toArray();
      return res.status(200).json({ success: true, items: devices.map(serializeDevice) });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const now = new Date();
      const deviceId = cleanString(body.device_id || body.deviceId, 180);

      if (!deviceId) {
        return res.status(400).json({ success: false, error: 'device_id is required' });
      }

      await db.collection('client_devices').updateOne(
        { clientId, deviceId },
        {
          $set: {
            name: cleanString(body.device_name || body.deviceName || body.name, 160) || 'Android device',
            model: cleanString(body.model, 120),
            manufacturer: cleanString(body.manufacturer, 120),
            appVersion: cleanString(body.app_version || body.appVersion, 40),
            androidVersion: cleanString(body.android_version || body.androidVersion, 40),
            status: 'online',
            lastSeenAt: now,
            updatedAt: now
          },
          $setOnInsert: {
            clientId,
            deviceId,
            totalSms: 0,
            createdAt: now
          }
        },
        { upsert: true }
      );

      const [device, websites] = await Promise.all([
        db.collection('client_devices').findOne({ clientId, deviceId }),
        db.collection('websites').find({
          clientId,
          $or: [{ brandStatus: 'active' }, { androidAppEnabled: true }]
        }).sort({ updatedAt: -1 }).toArray()
      ]);
      return res.status(200).json({
        success: true,
        device: serializeDevice(device),
        smsSenderRules: buildSmsSenderRules(websites),
        wallets: websites.map((site) => ({
          brandName: site.name || site.domain,
          method: site.walletProvider || '',
          number: site.walletNumber || ''
        }))
      });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

function buildSmsSenderRules(websites) {
  const methods = new Set(websites.map((site) => String(site.walletProvider || '').toLowerCase()).filter(Boolean));
  const ruleMap = {
    bkash: [
      { displayName: 'bKash', senderValue: 'bKash' },
      { displayName: 'bKash Short Code', senderValue: '16247' }
    ],
    nagad: [{ displayName: 'Nagad', senderValue: 'Nagad' }],
    rocket: [
      { displayName: 'Rocket', senderValue: 'Rocket' },
      { displayName: 'DBBL', senderValue: 'DBBL' }
    ],
    upay: [{ displayName: 'Upay', senderValue: 'Upay' }]
  };

  const rules = [];
  for (const method of methods) {
    rules.push(...(ruleMap[method] || []));
  }

  return rules.length ? rules : [
    { displayName: 'bKash', senderValue: 'bKash' },
    { displayName: 'Nagad', senderValue: 'Nagad' },
    { displayName: 'Rocket', senderValue: 'Rocket' },
    { displayName: 'Upay', senderValue: 'Upay' }
  ];
}
