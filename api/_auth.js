import crypto from 'crypto';
import jwt from 'jsonwebtoken';

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
    audience: JWT_AUDIENCE
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
      audience: JWT_AUDIENCE
    }
  );
}

export function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

export function requireSmsSubmitter(req, res) {
  const token = getBearerToken(req);
  const expectedAndroidToken = process.env.ANDROID_API_TOKEN;

  if (expectedAndroidToken && safeEqual(token, expectedAndroidToken)) {
    return { role: 'android', type: 'static-token' };
  }

  if (process.env.JWT_SECRET && token) {
    try {
      const payload = verifyJwt(token);
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
      // Fall through to the shared unauthorized response below.
    }
  }

  res.status(401).json({ success: false, error: 'Android app login required' });
  return null;
}

export function requireAdmin(req, res) {
  let payload;
  try {
    payload = verifyJwt(getBearerToken(req));
  } catch (err) {
    const status = isSecretConfigError(err) ? 500 : 401;
    res.status(status).json({
      success: false,
      error: status === 500 ? err.message : 'Admin login required'
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

export function requireClient(req, res) {
  let payload;
  try {
    payload = verifyJwt(getBearerToken(req));
  } catch (err) {
    const status = isSecretConfigError(err) ? 500 : 401;
    res.status(status).json({
      success: false,
      error: status === 500 ? err.message : 'Client login required'
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

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) throw new Error('Server missing JWT_SECRET');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

function verifyJwt(token) {
  if (!token) throw new Error('Missing token');
  return jwt.verify(token, getJwtSecret(), {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  });
}

function isSecretConfigError(error) {
  return String(error?.message || '').includes('JWT_SECRET');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
