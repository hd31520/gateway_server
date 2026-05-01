import { ObjectId } from 'mongodb';
import { getDb } from './_db.js';
import { requireAdmin, signAdminToken } from './_auth.js';
import { createAdminSession, getAdminConfig } from './_admin.js';
import { publicServerError, safeRequestBody } from './_utils.js';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    return handleAdminLogin(req, res);
  }

  if (req.method === 'GET') {
    return handleAdminGet(req, res);
  }

  if (req.method === 'PATCH') {
    return handleAdminPatch(req, res);
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
}

async function handleAdminLogin(req, res) {
  try {
    const body = safeRequestBody(req, res);
    if (body === null) return;

    const result = await createAdminSession(body);
    if (!result.ok) {
      return res.status(result.status || 400).json({ success: false, error: result.error });
    }

    res.setHeader('Set-Cookie', `gatewayAdminToken=${result.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`);
    return res.status(200).json({
      success: true,
      token: result.token,
      admin: result.admin,
      config: result.config
    });
  } catch (error) {
    console.error('Admin login error:', error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

async function handleAdminGet(req, res) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  try {
    const db = await getDb();
    const config = getAdminConfig();

    // Get summary stats
    const [totalClients, totalBrands, pendingBrands, activeBrands] = await Promise.all([
      db.collection('clients').countDocuments({}),
      db.collection('websites').countDocuments({}),
      db.collection('websites').countDocuments({ brandStatus: 'pending_review' }),
      db.collection('websites').countDocuments({ brandStatus: 'active' })
    ]);

    const pendingBilling = await db.collection('billing_requests').countDocuments({ status: 'pending_review' });
    const pendingMerchantVerifications = await db.collection('merchant_verifications').countDocuments({ status: 'pending' });

    return res.status(200).json({
      success: true,
      admin: auth,
      config,
      summary: {
        totalClients,
        totalBrands,
        pendingBrands,
        activeBrands,
        pendingBilling,
        pendingMerchantVerifications
      }
    });
  } catch (error) {
    console.error('Admin get error:', error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

async function handleAdminPatch(req, res) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  try {
    const body = safeRequestBody(req, res);
    if (body === null) return;

    const action = String(body.action || '').toLowerCase();

    if (action === 'brand') {
      return handleBrandAction(req, res, body);
    }

    if (action === 'user') {
      return handleUserAction(req, res, body);
    }

    if (action === 'merchantverification') {
      return handleMerchantVerificationAction(req, res, body);
    }

    return res.status(400).json({ success: false, error: 'Unknown action' });
  } catch (error) {
    console.error('Admin patch error:', error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

async function handleBrandAction(req, res, body) {
  try {
    const db = await getDb();
    const websiteId = new ObjectId(body.websiteId);
    const newStatus = String(body.brandStatus || '').toLowerCase();
    const adminNote = String(body.adminNote || '').trim().slice(0, 500);

    if (!['active', 'pending_review', 'rejected'].includes(newStatus)) {
      return res.status(400).json({ success: false, error: 'Invalid brand status' });
    }

    const update = {
      brandStatus: newStatus,
      paymentStatus: newStatus,
      updatedAt: new Date()
    };

    if (adminNote) {
      update.adminNote = adminNote;
    }

    if (newStatus === 'active') {
      update.approvedAt = new Date();
      update.androidAppEnabled = true;
    }

    const result = await db.collection('websites').findOneAndUpdate(
      { _id: websiteId },
      { $set: update },
      { returnDocument: 'after' }
    );

    if (!result.value) {
      return res.status(404).json({ success: false, error: 'Brand not found' });
    }

    return res.status(200).json({ success: true, website: result.value });
  } catch (error) {
    console.error('Brand action error:', error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

async function handleUserAction(req, res, body) {
  try {
    const db = await getDb();
    const clientId = new ObjectId(body.clientId);
    const status = String(body.status || '').toLowerCase();
    const adminNote = String(body.adminNote || '').trim().slice(0, 500);

    if (!['active', 'suspended', 'pending'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid user status' });
    }

    const update = { updatedAt: new Date() };
    if (status) update.accountStatus = status;
    if (adminNote) update.adminNote = adminNote;

    const result = await db.collection('clients').findOneAndUpdate(
      { _id: clientId },
      { $set: update },
      { returnDocument: 'after' }
    );

    if (!result.value) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    return res.status(200).json({ success: true, client: result.value });
  } catch (error) {
    console.error('User action error:', error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

async function handleMerchantVerificationAction(req, res, body) {
  try {
    const db = await getDb();
    const verificationId = new ObjectId(body.verificationId);
    const status = String(body.status || '').toLowerCase();
    const adminNote = String(body.adminNote || '').trim().slice(0, 500);

    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid verification status' });
    }

    const update = { updatedAt: new Date() };
    if (status) update.status = status;
    if (adminNote) update.adminNote = adminNote;

    const result = await db.collection('merchant_verifications').findOneAndUpdate(
      { _id: verificationId },
      { $set: update },
      { returnDocument: 'after' }
    );

    if (!result.value) {
      return res.status(404).json({ success: false, error: 'Verification not found' });
    }

    return res.status(200).json({ success: true, verification: result.value });
  } catch (error) {
    console.error('Merchant verification action error:', error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}
