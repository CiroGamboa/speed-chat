// Minimal concurrent static file server for the test harness. Node's http server handles many
// simultaneous requests (unlike python's single-threaded http.server, which stalls when several
// browser contexts fetch assets at once). Serves the repo root. Port via PORT env (default 8080).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // Same-origin fonts load without this, but an unknown type logs a console warning that
  // Actor's error capture would report as an app error.
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const s = await stat(filePath).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});

server.listen(PORT, () => console.log(`[static-server] serving ${ROOT} on http://localhost:${PORT}`));
