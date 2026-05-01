function setCorsMiddleware(req, res) {
  // Get origin from request
  const origin = req.headers.origin || '*';
  
  // Set CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };
  
  // Apply headers
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return true;
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
    if (setCorsMiddleware(req, res)) {
      return;
    }

    const slug = req.query && req.query.slug ? req.query.slug : [];
    const route = safeRouteFromSlug(Array.isArray(slug) ? slug : [slug]);
    if (!route) {
      return res.status(404).json({ success: false, error: 'Route not found' });
    }

    // Map route to handler in ../server/handlers.
    const handlerPath = new URL(`../server/handlers/${route}.js`, import.meta.url);
    let mod;
    try {
      mod = await import(handlerPath.href);
    } catch (e) {
      // Try with index.js inside a folder
      try {
        const idxPath = new URL(`../server/handlers/${route}/index.js`, import.meta.url);
        mod = await import(idxPath.href);
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
