import { cleanString, setCors, setSecurityHeaders } from '../server/handlers/_utils.js';

const MAX_BODY_BYTES = 1_048_576;

function safeRouteFromSlug(slug) {
  const raw = Array.isArray(slug) ? slug.join('/') : String(slug || '');
  const parts = raw.split('/').map(String).filter(Boolean).map((part) => part.replace(/[^a-zA-Z0-9_-]/g, ''));
  if (parts.length === 0) return null;
  if (parts.join('/').length > 200) return null;
  return parts.join('/');
}

function setCorsMiddleware(req, res, route) {
  if (route === 'merchant/verify') {
    setMerchantCors(req, res);
  } else {
    setCors(req, res);
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }

  return false;
}

function setMerchantCors(req, res) {
  setSecurityHeaders(res);
  const origin = cleanString(req.headers.origin, 300);
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  if (origin) res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function parseRequestBody(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return {};

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    const parseError = new Error('Invalid JSON request body');
    parseError.statusCode = 400;
    throw parseError;
  }
}

export default async function handler(req, res) {
  try {
    const route = safeRouteFromSlug(req.query?.slug);
    if (!route) {
      setCors(req, res);
      return res.status(404).json({ success: false, error: 'Route not found' });
    }

    if (setCorsMiddleware(req, res, route)) return;

    try {
      req.body = await parseRequestBody(req);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message || 'Invalid request body' });
    }

    let mod;
    try {
      const handlerPath = new URL(`../server/handlers/${route}.js`, import.meta.url);
      mod = await import(handlerPath.href);
    } catch (error) {
      try {
        const indexPath = new URL(`../server/handlers/${route}/index.js`, import.meta.url);
        mod = await import(indexPath.href);
      } catch (indexError) {
        return res.status(404).json({ success: false, error: 'Handler not found' });
      }
    }

    const fn = mod && (mod.default || mod.handler || mod);
    if (typeof fn !== 'function') {
      return res.status(500).json({ success: false, error: 'Handler export is invalid' });
    }

    return await fn(req, res);
  } catch (error) {
    console.error('API router error', error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}
