import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getDb } from './_db.js';

const JWT_ISSUER = process.env.JWT_ISSUER || 'gatewayflow';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'gatewayflow-api';
const MIN_SECRET_LENGTH = 32;

export function requireAndroidToken(req, res) {
  const expected = process.env.ANDROID_API_TOKEN;
  if (!expected) {
    res.status(500).json({ success: false, error: 'Server missing ANDROID_API_TOKEN' });
    return false;
  }

  const auth = req.headers.authorization || '';
  if (!safeEqual(auth, `Bearer ${expected}`)) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function signAdminToken(payload) {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: '12h',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    jwtid: createTokenId()
  });
}

export function signClientToken(client) {
  return jwt.sign(
    {
      id: String(client._id),
      email: client.email,
      role: 'client',
      userRole: client.role || 'user'
    },
    getJwtSecret(),
    {
      expiresIn: '7d',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      jwtid: createTokenId()
    }
  );
}

export function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

export async function requireSmsSubmitter(req, res) {
  const token = getBearerToken(req);
  const expectedAndroidToken = process.env.ANDROID_API_TOKEN;

  if (expectedAndroidToken && safeEqual(token, expectedAndroidToken)) {
    return { role: 'android', type: 'static-token' };
  }

  if (process.env.JWT_SECRET && token) {
    try {
      const payload = await verifyAuthToken(token);
      if (payload.role === 'client' && payload.id) {
        return {
          role: 'client',
          id: payload.id,
          email: payload.email || '',
          userRole: payload.userRole || 'user'
        };
      }
      if (payload.role === 'admin') {
        return {
          role: 'admin',
          username: payload.username || ''
        };
      }
    } catch (err) {
      if (!isRequestAuthError(err)) {
        res.status(500).json({ success: false, error: authServerError(err) });
        return null;
      }
    }
  }

  res.status(401).json({ success: false, error: 'Android app login required' });
  return null;
}

export async function requireAdmin(req, res) {
  let payload;
  try {
    payload = await verifyAuthToken(getBearerToken(req));
  } catch (err) {
    const status = authErrorStatus(err);
    res.status(status).json({
      success: false,
      error: status === 500 ? authServerError(err) : 'Admin login required'
    });
    return null;
  }

  const isAdmin = payload.role === 'admin' || (payload.role === 'client' && payload.userRole === 'admin');
  if (!isAdmin) {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return null;
  }
  return payload;
}

export async function requireClient(req, res) {
  let payload;
  try {
    payload = await verifyAuthToken(getBearerToken(req));
  } catch (err) {
    const status = authErrorStatus(err);
    res.status(status).json({
      success: false,
      error: status === 500 ? authServerError(err) : 'Client login required'
    });
    return null;
  }

  if (payload.role !== 'client' || !payload.id) {
    res.status(403).json({ success: false, error: 'Client access required' });
    return null;
  }
  return payload;
}

export function generateApiKey() {
  return `pg_live_${crypto.randomBytes(24).toString('hex')}`;
}

export async function revokeBearerToken(req, expectedRole = '') {
  const token = getBearerToken(req);
  if (!token) return null;

  let payload;
  try {
    payload = verifyJwt(token, { ignoreExpiration: true });
  } catch (err) {
    if (isSecretConfigError(err)) throw err;
    return null;
  }

  if (expectedRole && payload.role !== expectedRole) return null;

  const now = new Date();
  const expiresAt = payload.exp
    ? new Date(payload.exp * 1000)
    : new Date(now.getTime() + 7 * 24 * 60 * 60_000);
  const tokenHash = hashToken(token);
  const revokedToken = {
    tokenHash,
    role: payload.role || '',
    subject: payload.id || payload.email || payload.username || payload.sub || '',
    expiresAt,
    createdAt: now
  };
  if (payload.jti) revokedToken.jti = payload.jti;

  const db = await getDb();
  await db.collection('revoked_tokens').updateOne(
    { tokenHash },
    {
      $setOnInsert: revokedToken,
      $set: { revokedAt: now }
    },
    { upsert: true }
  );

  return payload;
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) throw new Error('Server missing JWT_SECRET');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

async function verifyAuthToken(token) {
  const payload = verifyJwt(token);
  if (await isTokenRevoked(token, payload)) {
    throw new Error('Token revoked');
  }
  return payload;
}

function verifyJwt(token, options = {}) {
  if (!token) throw new Error('Missing token');
  return jwt.verify(token, getJwtSecret(), {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    ignoreExpiration: options.ignoreExpiration === true
  });
}

function isSecretConfigError(error) {
  return String(error?.message || '').includes('JWT_SECRET');
}

function authErrorStatus(error) {
  if (isSecretConfigError(error)) return 500;
  return isRequestAuthError(error) ? 401 : 500;
}

function authServerError(error) {
  return isSecretConfigError(error) ? error.message : 'Authentication service unavailable';
}

function isRequestAuthError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  return ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(name)
    || ['Missing token', 'Token revoked'].includes(message);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function isTokenRevoked(token, payload) {
  const tokenHash = hashToken(token);
  const query = payload?.jti
    ? { $or: [{ jti: payload.jti }, { tokenHash }] }
    : { tokenHash };
  const db = await getDb();
  const revoked = await db.collection('revoked_tokens').findOne(query, { projection: { _id: 1 } });
  return Boolean(revoked);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createTokenId() {
  return crypto.randomBytes(24).toString('hex');
}
