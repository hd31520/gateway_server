export const MONTHLY_DOMAIN_FEE = 60;
export const BRAND_OPENING_FEE = Number(process.env.BRAND_OPENING_FEE || MONTHLY_DOMAIN_FEE);
export const DEFAULT_ANDROID_APP_DOWNLOAD_PATH = '/gatewayflow-android.apk';

const rateLimitBuckets = new Map();

export function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
}

export function setCors(req, res, methods = 'GET, POST, PATCH, OPTIONS') {
  setSecurityHeaders(res);
  const origin = resolveAllowedOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (origin !== '*') appendVary(res, 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function handleCors(req, res, methods) {
  setCors(req, res, methods);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

export function rateLimit(req, res, options = {}) {
  const {
    key = 'global',
    limit = 60,
    windowMs = 60_000,
    identity = getClientIp(req)
  } = options;
  const bucketKey = `${key}:${identity}`;
  const now = Date.now();
  const current = rateLimitBuckets.get(bucketKey);

  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return true;
  }

  current.count += 1;
  if (current.count <= limit) return true;

  res.setHeader('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
  res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
  return false;
}

export function cleanString(value, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

export function cleanObjectId(value) {
  return String(value || '').trim();
}

export function normalizeAmount(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).replace(/,/g, '').trim();
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Number(num.toFixed(2));
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function normalizeDomain(value) {
  let domain = String(value || '').trim().toLowerCase();
  if (!domain) return '';

  domain = domain.replace(/^https?:\/\//, '');
  domain = domain.split('/')[0].split('?')[0].split('#')[0];
  domain = domain.replace(/^www\./, '').replace(/:\d+$/, '');

  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) {
    return '';
  }

  return domain;
}

export function normalizePublicUrl(value, max = 500) {
  const raw = cleanString(value, max);
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    if (isProduction() && (url.protocol !== 'https:' || isLoopbackHostname(url.hostname))) return '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch (error) {
    return '';
  }
}

export function normalizeWalletNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('1')) return `0${digits}`;
  if (digits.length === 11 && digits.startsWith('01')) return digits;
  return digits.slice(0, 18);
}

export function getAndroidAppDownloadUrl() {
  return cleanString(process.env.ANDROID_APP_DOWNLOAD_URL || DEFAULT_ANDROID_APP_DOWNLOAD_PATH, 500);
}

export function addOneMonth(date) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + 1);
  return next;
}

export function isWebsiteActive(website, now = new Date()) {
  if (!website?.paidUntil) return false;
  return new Date(website.paidUntil) > now;
}

export function publicServerError(error) {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  const name = String(error?.name || '').toLowerCase();

  if (message.includes('mongodb_uri') && message.includes('placeholder')) {
    return 'MONGODB_URI is still a placeholder. Put your real MongoDB connection string in payment-gateway-server/.env.local.';
  }

  const databaseSignals = [
    'mongodb_uri',
    'mongo',
    'mongoserver',
    'querysrv',
    'econnrefused',
    'enotfound',
    'etimedout',
    'server selection',
    'bad auth',
    'auth failed',
    'authentication failed'
  ];

  if (databaseSignals.some((signal) => message.includes(signal) || code.includes(signal) || name.includes(signal))) {
    return 'Database connection failed. Check MONGODB_URI and MongoDB network access.';
  }

  return 'Server error';
}

export function sanitizeErrorMessage(error) {
  const message = String(error?.message || 'Unknown error');
  return message
    .replace(/mongodb(?:\+srv)?:\/\/[^@\s]+@/gi, 'mongodb://***@')
    .slice(0, 240);
}

export function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function safeRequestBody(req, res) {
  try {
    return req.body || {};
  } catch (err) {
    console.error('Invalid JSON in request body', err);
    try {
      res.status(400).json({ success: false, error: 'Invalid JSON in request body' });
    } catch (e) {
      // ignore secondary errors
    }
    return null;
  }
}

export function serializeClient(client) {
  if (!client) return null;
  return {
    id: String(client._id),
    name: client.name,
    email: client.email,
    role: client.role || 'user',
    status: client.status,
    createdAt: client.createdAt
  };
}

export function serializeWebsite(website, now = new Date()) {
  const active = isWebsiteActive(website, now);
  const brandStatus = website.brandStatus || (active ? 'active' : 'pending_payment');
  const paymentStatus = website.paymentStatus || (active ? 'paid' : 'unpaid');
  const androidAppEnabled = Boolean(website.androidAppEnabled || active || brandStatus === 'active');
  return {
    id: String(website._id),
    name: website.name,
    domain: website.domain,
    apiKey: website.apiKey,
    monthlyFee: website.monthlyFee || website.brandCharge || BRAND_OPENING_FEE,
    brandCharge: Number(website.brandCharge || website.monthlyFee || BRAND_OPENING_FEE),
    brandStatus,
    paymentStatus,
    walletProvider: website.walletProvider || '',
    walletNumber: website.walletNumber || '',
    receiverName: website.receiverName || '',
    androidAppEnabled,
    appDownloadUrl: androidAppEnabled ? getAndroidAppDownloadUrl() : null,
    adminNote: website.adminNote || '',
    approvedAt: website.approvedAt || null,
    subscriptionStatus: active ? 'active' : 'due',
    paidUntil: website.paidUntil || null,
    createdAt: website.createdAt,
    updatedAt: website.updatedAt
  };
}

export function serializePayment(payment) {
  if (!payment) return null;
  return {
    id: String(payment._id),
    sender: payment.sender || payment.provider || 'unknown',
    provider: payment.provider || payment.sender || 'unknown',
    sourceNumber: payment.source_number || '',
    payerNumber: payment.payer_number || '',
    transaction_id: payment.transaction_id,
    amount: Number(payment.amount || 0),
    status: payment.status || 'received',
    usedFor: payment.usedFor || null,
    rawMessage: payment.raw_message || '',
    currency: payment.currency || 'BDT',
    receivedAt: payment.receivedAt || null,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt
  };
}

export function serializeVerification(verification) {
  if (!verification) return null;
  return {
    id: String(verification._id),
    websiteId: verification.websiteId ? String(verification.websiteId) : null,
    domain: verification.domain || '',
    transaction_id: verification.transaction_id,
    amount: Number(verification.amount || 0),
    order_id: verification.order_id || null,
    sellerName: verification.sellerName || '',
    buyerName: verification.buyerName || '',
    buyerAddress: verification.buyerAddress || '',
    callbackUrl: verification.callbackUrl || '',
    returnUrl: verification.returnUrl || '',
    status: verification.status || 'verified',
    createdAt: verification.createdAt
  };
}

export function serializeMerchantVerification(item) {
  if (!item) return null;
  return {
    id: String(item._id),
    clientId: item.clientId ? String(item.clientId) : null,
    websiteId: item.websiteId ? String(item.websiteId) : null,
    paymentId: item.paymentId ? String(item.paymentId) : null,
    verificationId: item.verificationId ? String(item.verificationId) : null,
    domain: item.domain || '',
    transaction_id: item.transaction_id || '',
    amount: Number(item.amount || 0),
    order_id: item.order_id || null,
    sellerName: item.sellerName || '',
    buyerName: item.buyerName || '',
    buyerAddress: item.buyerAddress || '',
    callbackUrl: item.callbackUrl || '',
    returnUrl: item.returnUrl || '',
    status: item.status || 'pending_sms',
    adminNote: item.adminNote || '',
    reviewedBy: item.reviewedBy || '',
    reviewedAt: item.reviewedAt || null,
    verifiedAt: item.verifiedAt || item.createdAt || null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt || null
  };
}

export function serializeRenewal(renewal) {
  if (!renewal) return null;
  return {
    id: String(renewal._id),
    websiteId: renewal.websiteId ? String(renewal.websiteId) : null,
    transaction_id: renewal.transaction_id,
    amount: Number(renewal.amount || 0),
    paidAt: renewal.paidAt,
    paidUntil: renewal.paidUntil
  };
}

export function serializeDevice(device) {
  if (!device) return null;
  return {
    id: String(device._id),
    deviceId: device.deviceId,
    name: device.name || device.deviceName || 'Android device',
    model: device.model || '',
    manufacturer: device.manufacturer || '',
    appVersion: device.appVersion || '',
    androidVersion: device.androidVersion || '',
    status: device.status || 'online',
    lastSeenAt: device.lastSeenAt || device.updatedAt || device.createdAt,
    lastSmsAt: device.lastSmsAt || null,
    totalSms: Number(device.totalSms || 0),
    createdAt: device.createdAt
  };
}

export function defaultClientSettings() {
  return {
    currency: 'BDT',
    timezone: 'Asia/Dhaka',
    webhookUrl: '',
    successUrl: '',
    cancelUrl: '',
    autoVerify: true,
    paymentMethods: ['bkash', 'nagad', 'rocket'],
    invoicePrefix: 'INV',
    supportEmail: 'support@gatewayflow.local'
  };
}

export function serializeSettings(settings) {
  return {
    ...defaultClientSettings(),
    ...(settings || {}),
    id: settings?._id ? String(settings._id) : null,
    clientId: settings?.clientId ? String(settings.clientId) : null
  };
}

export function serializeTicket(ticket) {
  if (!ticket) return null;
  return {
    id: String(ticket._id),
    subject: ticket.subject,
    category: ticket.category || 'General',
    priority: ticket.priority || 'normal',
    status: ticket.status || 'open',
    message: ticket.message || '',
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt
  };
}

export function serializeBillingRequest(request) {
  if (!request) return null;
  return {
    id: String(request._id),
    clientId: request.clientId ? String(request.clientId) : null,
    websiteId: request.websiteId ? String(request.websiteId) : null,
    domain: request.domain || '',
    transaction_id: request.transaction_id || '',
    amount: Number(request.amount || 0),
    months: Number(request.months || 1),
    status: request.status || 'pending_review',
    note: request.note || '',
    adminNote: request.adminNote || '',
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    reviewedAt: request.reviewedAt || null
  };
}

function resolveAllowedOrigin(req) {
  const requestOrigin = cleanString(req?.headers?.origin, 300);
  const configuredOrigins = parseAllowedOrigins();

  if (configuredOrigins.includes('*')) return '*';

  if (!requestOrigin) {
    return '';
  }

  if (configuredOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  if (!isProduction() && isLocalOrigin(requestOrigin)) {
    return requestOrigin;
  }

  if (isSameOrigin(req, requestOrigin)) {
    return requestOrigin;
  }

  return '';
}

function parseAllowedOrigins() {
  return cleanString(process.env.CORS_ORIGINS || process.env.CORS_ORIGIN, 2000)
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function appendVary(res, value) {
  const current = String(res.getHeader?.('Vary') || '');
  const values = current.split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.includes(value)) values.push(value);
  res.setHeader('Vary', values.join(', '));
}

function isSameOrigin(req, requestOrigin) {
  try {
    const originUrl = new URL(requestOrigin);
    const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '');
    const proto = String(req?.headers?.['x-forwarded-proto'] || (isProduction() ? 'https' : 'http'));
    return host && originUrl.host === host && originUrl.protocol === `${proto}:`;
  } catch (error) {
    return false;
  }
}

function isLocalOrigin(origin) {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch (error) {
    return false;
  }
}

function isLoopbackHostname(hostname) {
  const loopbackHosts = [['local', 'host'].join(''), ['127', '0', '0', '1'].join('.'), '::1'];
  return loopbackHosts.includes(String(hostname).toLowerCase());
}

function isProduction() {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}
