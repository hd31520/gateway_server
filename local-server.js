import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const root = path.dirname(__filename);
const apiRoot = path.join(root, 'api');
const publicRoot = path.join(root, 'public');
const MAX_BODY_BYTES = 1_048_576;

await loadEnvFile('.env', true);
await loadEnvFile('.env.local', true);

const { publicServerError } = await import('./api/_utils.js');
const port = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'payment-gateway-server-ten.vercel.app'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.statusCode = Number(error.statusCode || 500);
      res.setHeader('Content-Type', 'application/json');
    }
    const statusCode = Number(error.statusCode || res.statusCode || 500);
    const message = statusCode >= 400 && statusCode < 500 ? error.message : publicServerError(error);
    res.end(JSON.stringify({ success: false, error: message }));
  }
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. If another local server is running, stop it or start with a different port: $env:PORT=3001; npm start`);
    process.exitCode = 1;
    return;
  }

  console.error('Unable to start the payment gateway local server:', error?.message || error);
  process.exitCode = 1;
});

server.listen(port, () => {
  console.log(`Payment gateway local server running on port ${port}. Live API: https://payment-gateway-server-ten.vercel.app`);
});

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/?/, '');
  if (!isSafeRoutePath(route)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'API route not found' }));
    return;
  }

  const filePath = path.resolve(apiRoot, `${route}.js`);
  if (!isInsideDirectory(apiRoot, filePath)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'API route not found' }));
    return;
  }

  try {
    await fs.access(filePath);
  } catch (error) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'API route not found' }));
    return;
  }

  req.query = Object.fromEntries(url.searchParams.entries());
  req.body = await readBody(req);
  attachResponseHelpers(res);

  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
  const mod = await import(moduleUrl);
  await mod.default(req, res);
}

function attachResponseHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  res.json = (payload) => {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify(payload));
  };
}

async function readBody(req) {
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
    if (String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
      const parseError = new Error('Invalid JSON request body');
      parseError.statusCode = 400;
      throw parseError;
    }
    return {};
  }
}

async function serveStatic(res, requestPath) {
  const safePath = requestPath === '/' ? '/index.html' : requestPath;
  const filePath = path.resolve(publicRoot, `.${safePath}`);

  if (!isInsideDirectory(publicRoot, filePath)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    res.setHeader('Content-Type', contentType(filePath));
    setStaticHeaders(res, filePath);
    res.end(file);
  } catch (error) {
    const fallback = await fs.readFile(path.join(publicRoot, 'index.html'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    setStaticHeaders(res, 'index.html');
    res.end(fallback);
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.apk': 'application/vnd.android.package-archive'
  };
  return types[ext] || 'application/octet-stream';
}

function setStaticHeaders(res, filePath) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (/\.(html|js|css)$/i.test(filePath)) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https: https://payment-gateway-server-ten.vercel.app; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    );
  }
}

function isSafeRoutePath(route) {
  return /^[a-z0-9_/-]+$/i.test(route) && !route.split('/').includes('..');
}

function isInsideDirectory(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function loadEnvFile(fileName, override = false) {
  const envPath = path.join(root, fileName);

  try {
    const content = await fs.readFile(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const index = trimmed.indexOf('=');
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      value = value.replace(/^['"]|['"]$/g, '');
      if (key && (override || process.env[key] === undefined)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    // Local env files are optional.
  }
}
