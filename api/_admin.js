import bcrypt from 'bcryptjs';
import { signAdminToken } from './_auth.js';
import {
  BRAND_OPENING_FEE,
  cleanString,
  getAndroidAppDownloadUrl,
  normalizeEmail,
  normalizeWalletNumber
} from './_utils.js';

const MIN_ADMIN_PASSWORD_LENGTH = 10;

export function getAdminConfig() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL || process.env.ADMIN_USERNAME);
  const bkashNumber = normalizeWalletNumber(process.env.ADMIN_BKASH_NUMBER);
  const nagadNumber = normalizeWalletNumber(process.env.ADMIN_NAGAD_NUMBER);

  return {
    email,
    bkashNumber,
    nagadNumber,
    brandOpeningFee: BRAND_OPENING_FEE,
    androidAppDownloadUrl: getAndroidAppDownloadUrl()
  };
}

export async function createAdminSession(body = {}) {
  const email = normalizeEmail(body.email || body.username);
  const password = String(body.password || '');
  const config = getAdminConfig();
  const expectedEmail = config.email;
  const passwordHash = cleanString(process.env.ADMIN_PASSWORD_HASH, 300);
  const passwordPlain = process.env.ADMIN_PASSWORD || '';

  if (!expectedEmail) {
    return { ok: false, status: 500, error: 'Server missing ADMIN_EMAIL' };
  }

  if (!passwordHash && !passwordPlain) {
    return { ok: false, status: 500, error: 'Server missing ADMIN_PASSWORD_HASH or ADMIN_PASSWORD' };
  }

  if (isProduction() && passwordPlain && passwordPlain.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return { ok: false, status: 500, error: `ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters` };
  }

  const passwordOk = passwordHash
    ? await bcrypt.compare(password, passwordHash)
    : password === passwordPlain;

  if (email !== expectedEmail || !passwordOk) {
    return { ok: false, status: 401, error: 'Invalid admin email or password' };
  }

  const admin = {
    email: expectedEmail,
    role: 'admin',
    bkashNumber: config.bkashNumber,
    nagadNumber: config.nagadNumber
  };
  const token = signAdminToken(admin);

  return { ok: true, token, admin, config };
}

function isProduction() {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}
