import path from 'path';

function setCorsMidware(req, res) {
  // Get origin from request
  const origin = req.headers.origin || '*';
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  return false;
}

function safeRouteFromSlug(slugArray) {
  if (!Array.isArray(slugArray)) return null;
  const parts = slugArray.map(String).filter(Boolean).map((p) => p.replace(/[^a-zA-Z0-9_-]/g, ''));
  if (parts.length === 0) return null;
  if (parts.join('/').length > 200) return null;
  return parts.join('/');
}

export default async function handler(req, res) {
  try {
    // Handle CORS first
    if (setCorsMidware(req, res)) {
      return;
    }

    const slug = req.query && req.query.slug ? req.query.slug : [];
    const route = safeRouteFromSlug(Array.isArray(slug) ? slug : [slug]);
    if (!route) {
      return res.status(404).json({ success: false, error: 'Route not found' });
    }

    // Map route to handler in ../server/handlers
    const handlerPath = `../../server/handlers/${route}.js`;
    let mod;
    try {
      mod = await import(handlerPath);
    } catch (e) {
      // Try with index.js inside a folder
      try {
        const idxPath = `../../server/handlers/${route}/index.js`;
        mod = await import(idxPath);
      } catch (e2) {
        return res.status(404).json({ success: false, error: 'Handler not found' });
      }
    }

    const fn = mod && (mod.default || mod.handler || mod);
    if (typeof fn !== 'function') {
      return res.status(500).json({ success: false, error: 'Handler export is invalid' });
    }

    return await fn(req, res);
  } catch (error) {
    console.error('Catch-all router error', error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}
