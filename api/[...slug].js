function setCorsMiddleware(req, res) {
  const origin = req.headers.origin || '*';

  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };

  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return true;
  }

  return false;
}

function safeRouteFromSlug(slug) {
  const raw = Array.isArray(slug) ? slug.join('/') : String(slug || '');
  const parts = raw.split('/').map(String).filter(Boolean).map((part) => part.replace(/[^a-zA-Z0-9_-]/g, ''));
  if (parts.length === 0) return null;
  if (parts.join('/').length > 200) return null;
  return parts.join('/');
}

async function parseRequestBody(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return {};
  
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error('Failed to parse request body:', error);
    return {};
  }
}

export default async function handler(req, res) {
  try {
    if (setCorsMiddleware(req, res)) return;

    const route = safeRouteFromSlug(req.query?.slug);
    if (!route) {
      return res.status(404).json({ success: false, error: 'Route not found' });
    }

    // Parse request body for POST, PUT, PATCH
    req.body = await parseRequestBody(req);

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
