// Single entry point for /api/*, so no endpoint can skip the access checks.
import { handleAi } from './ai.js';
import { hasValidKey } from './auth.js';
import { handlePreview, isAllowedCaller } from './preview.js';

const refuse = (res, status, error) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ error }));
};

export async function routeApi(req, res, url, { key, ...options } = {}) {
  if (!isAllowedCaller(req)) return refuse(res, 403, 'Forbidden.');
  if (!hasValidKey(req, key)) return refuse(res, 401, 'Open Inkfield with the private link printed in the terminal.');
  if (url.pathname === '/api/session') return refuse(res, 200, null);
  if (url.pathname === '/api/preview') return handlePreview(req, res, url);
  if (url.pathname.startsWith('/api/ai/')) return handleAi(req, res, url, options);
  return refuse(res, 404, 'Not found.');
}
