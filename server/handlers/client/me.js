import { ObjectId } from 'mongodb';
import { getDb } from '../_db.js';
import { requireClient } from '../_auth.js';
import { getAdminConfig } from '../_admin.js';
import {
  activateWebsiteFromAdminPayment,
  normalizeTransactionId,
  upsertBillingRequest
} from '../_billing.js';
import {
  BRAND_OPENING_FEE,
  cleanString,
  defaultClientSettings,
  getAndroidAppDownloadUrl,
  handleCors,
  isWebsiteActive,
  normalizePublicUrl,
  publicServerError,
  serializeClient,
  serializeBillingRequest,
  serializeDevice,
  serializeMerchantVerification,
  serializePayment,
  serializeRenewal,
  serializeSettings,
  serializeTicket,
  serializeVerification,
  serializeWebsite
} from '../_utils.js';
import { safeRequestBody } from '../_utils.js';

const plans = [
  { id: 'free-3', name: 'Free Plan', duration: '3 Days', price: 0, websites: 1 },
  { id: 'basic-15', name: 'Basic 15', duration: '15 Days', price: 25, websites: 1 },
  { id: 'site-30', name: '1 Site', duration: '1 Month', price: 30, websites: 1 },
  { id: 'starter-30', name: '30 Days', duration: '1 Month', price: 50, websites: 5 },
  { id: 'business-30', name: 'Business 30', duration: '1 Month', price: 100, websites: 10 },
  { id: 'basic-365', name: 'Basic 365', duration: '1 Year', price: 500, websites: 5 },
  { id: 'standard-365', name: 'Standard 365', duration: '1 Year', price: 1000, websites: 10 },
  { id: 'ultimate-365', name: 'Ultimate 365', duration: '1 Year', price: 3000, websites: -1 }
];

const docs = [
  {
    title: 'Admin login and manual brand review',
    method: 'POST/GET/PATCH',
    path: '/api/admin?action=login',
    auth: 'Admin email + password / Bearer admin_token',
    body: ['email', 'password', 'websiteId', 'brandStatus']
  },
  {
    title: 'Android SMS upload',
    method: 'POST',
    path: '/api/sms',
    auth: 'Bearer client_token',
    body: ['transaction_id', 'amount', 'sender_name', 'raw_message', 'device_id']
  },
  {
    title: 'Merchant payment verify',
    method: 'POST',
    path: '/api/merchant/verify',
    auth: 'X-API-Key: website_api_key',
    body: ['domain', 'transaction_id', 'amount', 'order_id']
  },
  {
    title: 'Client portal snapshot',
    method: 'GET',
    path: '/api/client/me?view=dashboard',
    auth: 'Bearer client_token',
    body: []
  },
  {
    title: 'Client logout',
    method: 'POST',
    path: '/api/client/logout',
    auth: 'Bearer client_token',
    body: []
  },
  {
    title: 'Create brand with auto activation',
    method: 'POST',
    path: '/api/client/websites',
    auth: 'Bearer client_token',
    body: ['name', 'domain', 'walletProvider', 'walletNumber', 'receiverName', 'transaction_id']
  },
  {
    title: 'Submit admin payment TrxID',
    method: 'POST',
    path: '/api/client/me?resource=billing',
    auth: 'Bearer client_token',
    body: ['websiteId', 'transaction_id', 'amount', 'months']
  }
];

export default async function handler(req, res) {
  if (handleCors(req, res, 'GET, POST, PATCH, OPTIONS')) return;

  const auth = await requireClient(req, res);
  if (!auth) return;

  try {
    const db = await getDb();
    const body = safeRequestBody(req, res);
    if (body === null) return;
    const clientId = new ObjectId(auth.id);
    const resource = String(req.query?.resource || '').trim().toLowerCase();

    if (resource === 'settings') return handleSettings(req, res, db, clientId);
    if (resource === 'support') return handleSupport(req, res, db, clientId);
    if (resource === 'billing') return handleBilling(req, res, db, clientId);

    if (req.method !== 'GET') {
      return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    return sendDashboard(res, db, clientId);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}

// (rest of file omitted for brevity — original implementation preserved in handlers)
