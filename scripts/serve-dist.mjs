import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = resolve(process.env.JELLYTUBE_DIST || join(rootDir, 'dist'));
const host = process.env.JELLYTUBE_HOST || '0.0.0.0';
const port = Number(process.env.JELLYTUBE_PORT || process.env.PORT || 4173);
const indexPath = join(distDir, 'index.html');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid JELLYTUBE_PORT: ${process.env.JELLYTUBE_PORT}`);
  process.exit(1);
}

if (!existsSync(indexPath)) {
  console.error(`Missing production build at ${distDir}. Run "npm run build" first.`);
  process.exit(1);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'Method not allowed');
      return;
    }

    if (request.url === '/healthz') {
      sendJson(response, 200, { ok: true, app: 'jellytube' });
      return;
    }

    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const filePath = await resolveRequestPath(url.pathname, request.headers.accept || '');
    const fileStat = await stat(filePath);

    if (!fileStat.isFile()) {
      await sendFile(response, indexPath, request.method === 'HEAD');
      return;
    }

    await sendFile(response, filePath, request.method === 'HEAD');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await sendFile(response, indexPath, request.method === 'HEAD');
      return;
    }
    console.error(error);
    sendText(response, 500, 'Internal server error');
  }
});

server.listen(port, host, () => {
  console.log(`JellyTube serving ${distDir}`);
  console.log(`Listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

async function resolveRequestPath(pathname, acceptHeader) {
  const decodedPath = safeDecode(pathname);
  const normalizedPath = normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const relativePath = normalizedPath === sep ? 'index.html' : normalizedPath.replace(/^[/\\]+/, '');
  const candidate = resolve(distDir, relativePath);

  if (!isInsideDist(candidate)) return indexPath;
  if (extname(candidate)) return candidate;
  if (acceptHeader.includes('text/html')) return indexPath;
  return candidate;
}

async function sendFile(response, path, headOnly) {
  const fileStat = await stat(path);
  const headers = baseHeaders(path);
  response.writeHead(200, {
    ...headers,
    'Content-Length': String(fileStat.size),
    'Last-Modified': fileStat.mtime.toUTCString()
  });

  if (headOnly) {
    response.end();
    return;
  }

  createReadStream(path).pipe(response);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, message) {
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(message);
}

function baseHeaders(path) {
  const immutableAsset = path.includes(`${sep}assets${sep}`);
  return {
    ...securityHeaders(),
    'Content-Type': contentType(path),
    'Cache-Control': immutableAsset ? 'public, max-age=31536000, immutable' : 'no-cache'
  };
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  };
}

function contentType(path) {
  const extension = extname(path).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.txt': 'text/plain; charset=utf-8',
      '.map': 'application/json; charset=utf-8',
      '.wasm': 'application/wasm'
    }[extension] || 'application/octet-stream'
  );
}

function isInsideDist(path) {
  return path === distDir || path.startsWith(`${distDir}${sep}`);
}

function safeDecode(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return '/';
  }
}
