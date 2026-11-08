// Minimal static file server plus the link preview endpoint. Binds to localhost only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePreview } from './server/preview.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, 'http://localhost');
    if (requestUrl.pathname === '/api/preview') {
      await handlePreview(req, res, requestUrl);
      return;
    }
    const pathname = decodeURIComponent(requestUrl.pathname);
    const rel = normalize(pathname === '/' ? 'index.html' : `.${pathname}`);
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Inkfield running at http://localhost:${PORT}`));
