import path from 'path';

function safeRouteFromSlug(slugArray) {
  if (!Array.isArray(slugArray)) return null;
  const parts = slugArray.map(String).filter(Boolean).map((p) => p.replace(/[^a-zA-Z0-9_-]/g, ''));
  if (parts.length === 0) return null;
  if (parts.join('/').length > 200) return null;
  return parts.join('/');
}

export default async function handler(req, res) {
  try {
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
