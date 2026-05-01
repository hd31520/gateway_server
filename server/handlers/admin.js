import { ObjectId } from 'mongodb';
import { getDb } from './_db.js';
import { requireAdmin } from './_auth.js';
import { createAdminSession, getAdminConfig } from './_admin.js';
import { unwrapMongoResult } from './_billing.js';
import {
  BRAND_OPENING_FEE,
  addOneMonth,
  getAndroidAppDownloadUrl,
  publicServerError,
  safeRequestBody,
  serializeBillingRequest,
  serializeClient,
  serializeDevice,
  serializeMerchantVerification,
  serializePayment,
  serializeSettings,
  serializeTicket,
  serializeWebsite
} from './_utils.js';

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

    const [
      clients,
      websites,
      payments,
      billingRequests,
      merchantVerifications,
      devices,
      tickets,
      settings
    ] = await Promise.all([
      db.collection('clients').find({}).sort({ createdAt: -1 }).limit(50).toArray(),
      db.collection('websites').find({}).sort({ createdAt: -1 }).limit(100).toArray(),
      db.collection('payments').find({}).sort({ createdAt: -1 }).limit(100).toArray(),
      db.collection('billing_requests').find({}).sort({ createdAt: -1 }).limit(100).toArray(),
      db.collection('merchant_verification_requests').find({}).sort({ createdAt: -1 }).limit(100).toArray(),
      db.collection('client_devices').find({}).sort({ lastSeenAt: -1 }).limit(50).toArray(),
      db.collection('support_tickets').find({}).sort({ createdAt: -1 }).limit(50).toArray(),
      db.collection('admin_settings').findOne({})
    ]);

    const serializedClients = clients.map((client) => serializeClient(client));
    const clientById = new Map(serializedClients.map((client) => [client.id, client]));
    const websiteById = new Map(websites.map((website) => [String(website._id), website]));
    const brandedWebsites = websites.map((website) => ({
      ...serializeWebsite(website),
      clientEmail: clientById.get(String(website.clientId))?.email || '',
      clientName: clientById.get(String(website.clientId))?.name || ''
    }));
    const serializedPayments = payments.map((payment) => serializePayment(payment));
    const serializedBillingRequests = billingRequests.map((request) => {
      const client = clientById.get(String(request.clientId));
      const website = websiteById.get(String(request.websiteId));
      return {
        ...serializeBillingRequest(request),
        clientEmail: client?.email || '',
        clientName: client?.name || '',
        brandName: website?.name || '',
        domain: request.domain || website?.domain || ''
      };
    });
    const serializedMerchantVerifications = merchantVerifications.map((item) => {
      const client = clientById.get(String(item.clientId));
      const website = websiteById.get(String(item.websiteId));
      return {
        ...serializeMerchantVerification(item),
        clientEmail: client?.email || '',
        clientName: client?.name || '',
        brandName: website?.name || ''
      };
    });
    const serializedDevices = devices.map((device) => serializeDevice(device));
    const serializedTickets = tickets.map((ticket) => serializeTicket(ticket));

    const totalSmsAmount = serializedPayments.reduce((total, item) => total + Number(item.amount || 0), 0);
    const adminIncomeItems = payments.filter((payment) => Boolean(payment.usedFor));
    const adminIncomeAmount = adminIncomeItems.reduce((total, item) => total + Number(item.amount || 0), 0);

    const accountHistory = [
      ...payments.map((payment) => ({
        id: `payment:${String(payment._id)}`,
        type: 'sms_payment',
        transaction_id: payment.transaction_id || '',
        domain: payment.domain || '',
        brandName: payment.brandName || '',
        clientEmail: payment.clientEmail || '',
        provider: payment.provider || payment.sender || '',
        sender: payment.sender || payment.provider || '',
        amount: Number(payment.amount || 0),
        status: payment.status || 'received',
        usedFor: payment.usedFor || '',
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt || null
      })),
      ...billingRequests.map((request) => ({
        id: `billing:${String(request._id)}`,
        type: 'billing_request',
        transaction_id: request.transaction_id || '',
        domain: request.domain || '',
        brandName: request.domain || '',
        clientEmail: request.clientEmail || '',
        provider: 'billing_request',
        sender: 'client',
        amount: Number(request.amount || 0),
        status: request.status || 'pending_review',
        usedFor: 'brand_opening',
        createdAt: request.createdAt,
        updatedAt: request.updatedAt || null
      })),
      ...merchantVerifications.map((item) => ({
        id: `merchant:${String(item._id)}`,
        type: 'merchant_verification',
        transaction_id: item.transaction_id || '',
        domain: item.domain || '',
        brandName: item.domain || '',
        clientEmail: item.clientEmail || '',
        provider: 'merchant_verification',
        sender: 'client',
        amount: Number(item.amount || 0),
        status: item.status || 'pending_sms',
        usedFor: 'merchant_payment',
        createdAt: item.createdAt,
        updatedAt: item.updatedAt || null
      }))
    ].sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));

    const totalClients = serializedClients.length;
    const totalBrands = brandedWebsites.length;
    const pendingBrands = brandedWebsites.filter((site) => String(site.brandStatus || '').startsWith('pending')).length;
    const activeBrands = brandedWebsites.filter((site) => site.brandStatus === 'active').length;
    const pendingBilling = serializedBillingRequests.filter((request) => ['pending', 'pending_review'].includes(String(request.status || ''))).length;
    const pendingMerchantVerifications = serializedMerchantVerifications.filter((item) => item.status === 'pending_sms').length;

    return res.status(200).json({
      success: true,
      admin: auth,
      config,
      clients: serializedClients,
      brands: brandedWebsites,
      billingRequests: serializedBillingRequests,
      payments: serializedPayments,
      accountHistory,
      merchantVerifications: serializedMerchantVerifications,
      devices: serializedDevices,
      tickets: serializedTickets,
      summary: {
        totalClients,
        totalBrands,
        pendingBrands,
        activeBrands,
        pendingBilling,
        pendingMerchantVerifications,
        totalSms: serializedPayments.length,
        totalSmsAmount,
        adminIncomeAmount,
        adminIncomeCount: adminIncomeItems.length,
        unusedAdminAmount: Math.max(totalSmsAmount - adminIncomeAmount, 0)
      },
      runtime: {
        brandOpeningFee: config.brandOpeningFee || BRAND_OPENING_FEE,
        androidAppDownloadUrl: config.androidAppDownloadUrl || getAndroidAppDownloadUrl(),
        settings: serializeSettings(settings || {})
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
    const websiteIdValue = body.websiteId || body.id;
    if (!ObjectId.isValid(String(websiteIdValue || ''))) {
      return res.status(400).json({ success: false, error: 'Valid websiteId is required' });
    }

    const websiteId = new ObjectId(websiteIdValue);
    const newStatus = String(body.brandStatus || '').toLowerCase();
    const paymentStatus = String(body.paymentStatus || '').toLowerCase();
    const adminNote = String(body.adminNote || '').trim().slice(0, 500);
    const months = Math.min(Math.max(Number(body.months || 1), 1), 24);

    if (!['active', 'pending_review', 'rejected', 'suspended'].includes(newStatus)) {
      return res.status(400).json({ success: false, error: 'Invalid brand status' });
    }

    const update = {
      brandStatus: newStatus,
      paymentStatus: paymentStatus || statusToPaymentStatus(newStatus),
      updatedAt: new Date()
    };

    if (adminNote) {
      update.adminNote = adminNote;
    }

    if (newStatus === 'active') {
      const now = new Date();
      const website = await db.collection('websites').findOne({ _id: websiteId });
      const baseDate = website?.paidUntil && new Date(website.paidUntil) > now
        ? new Date(website.paidUntil)
        : now;
      let paidUntil = baseDate;
      for (let index = 0; index < months; index += 1) paidUntil = addOneMonth(paidUntil);

      update.paidUntil = paidUntil;
      update.approvedAt = website?.approvedAt || now;
      update.androidAppEnabled = true;
    }

    if (newStatus === 'suspended' || newStatus === 'rejected') {
      update.androidAppEnabled = false;
    }

    const result = await db.collection('websites').findOneAndUpdate(
      { _id: websiteId },
      { $set: update },
      { returnDocument: 'after' }
    );

    const updatedWebsite = unwrapMongoResult(result);
    if (!updatedWebsite) {
      return res.status(404).json({ success: false, error: 'Brand not found' });
    }

    const billingRequestId = body.billingRequestId || body.requestId;
    if (billingRequestId && ObjectId.isValid(String(billingRequestId))) {
      await db.collection('billing_requests').updateOne(
        { _id: new ObjectId(billingRequestId) },
        {
          $set: {
            status: newStatus === 'active' ? 'approved' : newStatus === 'rejected' ? 'rejected' : 'pending_review',
            reviewedAt: new Date(),
            reviewedBy: 'admin',
            adminNote,
            updatedAt: new Date()
          }
        }
      );
    }

    return res.status(200).json({ success: true, website: updatedWebsite });
  } catch (error) {
    console.error('Brand action error:', error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

async function handleUserAction(req, res, body) {
  try {
    const db = await getDb();
    const clientIdValue = body.clientId || body.userId || body.id;
    if (!ObjectId.isValid(String(clientIdValue || ''))) {
      return res.status(400).json({ success: false, error: 'Valid clientId is required' });
    }

    const clientId = new ObjectId(clientIdValue);
    const status = String(body.status || '').toLowerCase();
    const role = String(body.role || '').toLowerCase();
    const adminNote = String(body.adminNote || '').trim().slice(0, 500);

    if (status && !['active', 'suspended', 'pending', 'blocked'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid user status' });
    }

    if (role && !['user', 'client', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid user role' });
    }

    const update = { updatedAt: new Date() };
    if (status) update.status = status;
    if (role) update.role = role === 'user' ? 'client' : role;
    if (adminNote) update.adminNote = adminNote;

    const result = await db.collection('clients').findOneAndUpdate(
      { _id: clientId },
      { $set: update },
      { returnDocument: 'after' }
    );

    const updatedClient = unwrapMongoResult(result);
    if (!updatedClient) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    return res.status(200).json({ success: true, client: updatedClient });
  } catch (error) {
    console.error('User action error:', error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

async function handleMerchantVerificationAction(req, res, body) {
  try {
    const db = await getDb();
    // Accept both 'id' and 'verificationId' for backward compatibility
    const idValue = body.id || body.verificationId;
    if (!idValue) {
      return res.status(400).json({ success: false, error: 'Missing id or verificationId' });
    }

    let verificationId;
    try {
      verificationId = new ObjectId(idValue);
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid verification ID format' });
    }

    const status = String(body.status || '').toLowerCase();
    const adminNote = String(body.adminNote || '').trim().slice(0, 500);

    if (!['approved', 'rejected', 'pending', 'manual_approved', 'verified'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid verification status' });
    }

    const normalizedStatus = status === 'approved' ? 'manual_approved' : status;
    const update = {
      updatedAt: new Date(),
      reviewedAt: new Date(),
      reviewedBy: 'admin'
    };
    if (normalizedStatus) update.status = normalizedStatus;
    if (adminNote) update.adminNote = adminNote;

    let verificationResult = null;
    const current = await db.collection('merchant_verification_requests').findOne({ _id: verificationId });
    if (!current) {
      return res.status(404).json({ success: false, error: 'Verification not found' });
    }

    if (['manual_approved', 'verified'].includes(normalizedStatus)) {
      const existingVerification = await db.collection('payment_verifications').findOne({
        transaction_id: current.transaction_id
      });

      if (existingVerification) {
        verificationResult = existingVerification;
        update.verificationId = existingVerification._id;
        update.verifiedAt = existingVerification.createdAt || new Date();
      } else {
        const verification = {
          clientId: current.clientId,
          websiteId: current.websiteId,
          domain: current.domain || '',
          paymentId: current.paymentId || null,
          transaction_id: current.transaction_id,
          amount: Number(current.amount || 0),
          order_id: current.order_id || null,
          sellerName: current.sellerName || '',
          buyerName: current.buyerName || '',
          buyerAddress: current.buyerAddress || '',
          callbackUrl: current.callbackUrl || '',
          returnUrl: current.returnUrl || '',
          status: normalizedStatus,
          adminNote,
          createdAt: new Date()
        };
        const inserted = await db.collection('payment_verifications').insertOne(verification);
        verification._id = inserted.insertedId;
        verificationResult = verification;
        update.verificationId = verification._id;
        update.verifiedAt = verification.createdAt;
      }
    }

    const result = await db.collection('merchant_verification_requests').findOneAndUpdate(
      { _id: verificationId },
      { $set: update },
      { returnDocument: 'after' }
    );

    const updatedVerification = unwrapMongoResult(result);
    if (!updatedVerification) {
      return res.status(404).json({ success: false, error: 'Verification not found' });
    }

    return res.status(200).json({ success: true, verification: updatedVerification, paymentVerification: verificationResult });
  } catch (error) {
    console.error('Merchant verification action error:', error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

function statusToPaymentStatus(status) {
  if (status === 'active') return 'paid';
  if (status === 'rejected') return 'failed';
  if (status === 'suspended') return 'unpaid';
  return status || 'pending_review';
}
