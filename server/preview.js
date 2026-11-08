// Fetches link previews for the local app. Browsers can't read other sites' metadata
// or export remote images, so this runs on the server and returns embedded data.
//
// It fetches URLs supplied by the client, so it must not become a way into private
// networks: every address is checked at connection time (which also defeats DNS
// rebinding), every redirect is re-checked, and only ports 80 and 443 are allowed.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { parseHttpUrl, youTubeId } from '../src/links.js';

const USER_AGENT = 'InkfieldLinkPreview/0.1';
const MAX_HTML = 768 * 1024;
const MAX_IMAGE = 6 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 8000;
const MAX_CONCURRENT = 8;
const ALLOWED_PORTS = new Set(['', '80', '443']);

export class PreviewError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function ipv4Public(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function expandIpv6(ip) {
  let text = ip.toLowerCase().split('%')[0];
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = text.includes('::') ? Array(8 - left.length - right.length).fill('0') : [];
  return [...left, ...fill, ...right].map((h) => parseInt(h, 16));
}

export function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return ipv4Public(ip);
  if (family !== 6) return false;
  const g = expandIpv6(ip);
  if (g.length !== 8 || g.some((n) => !Number.isFinite(n))) return false;
  const v4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return ipv4Public(v4()); // Mapped
  if (g.slice(0, 6).every((n) => n === 0)) return false; // ::, ::1, deprecated compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return ipv4Public(v4()); // NAT64
  if (g[0] === 0x2002) return ipv4Public(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return false; // Unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // Link local
  if ((g[0] & 0xff00) === 0xff00) return false; // Multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // Documentation
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  return true;
}

function fetchOnce(url, opts) {
  const { accept, maxBytes, truncate, checkAddress, ports, dnsLookup, signal } = opts;
  if (!ports.has(url.port)) return Promise.reject(new PreviewError('That port is not allowed.', 422));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // Node skips the lookup hook for IP literals, so those are checked here.
  if (net.isIP(hostname) && !checkAddress(hostname)) return Promise.reject(new PreviewError('That address is private.', 422));

  const lookup = (host, options, callback) => {
    dnsLookup(host, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (!list.length || !list.every((a) => checkAddress(a.address))) {
        return callback(new PreviewError('That address is private.', 422));
      }
      return options.all ? callback(null, list) : callback(null, list[0].address, list[0].family);
    });
  };

  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'GET', agent: false, lookup, signal,
      headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en' },
    }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.destroy();
        resolve({ status, location: res.headers.location, headers: res.headers });
        return;
      }
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      const decoder = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[encoding];
      const stream = decoder ? res.pipe(decoder()) : res;
      const chunks = [];
      let total = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve({ status, headers: res.headers, body: Buffer.concat(chunks) });
      };
      stream.on('data', (chunk) => {
        // Counted after decompression, so a compressed bomb hits the same limit.
        total += chunk.length;
        if (total > maxBytes) {
          if (truncate) {
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (total - maxBytes))));
            finish();
          } else {
            reject(new PreviewError('That file is too large.', 502));
          }
          res.destroy();
          stream.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', finish);
      stream.on('error', (err) => { if (!finished) reject(err); });
      res.on('error', (err) => { if (!finished) reject(err); });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchGuarded(start, opts) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchOnce(url, opts);
    if (!res.location) return { ...res, url };
    const next = parseHttpUrl(new URL(res.location, url).href);
    if (!next) throw new PreviewError('That page redirects somewhere unsupported.', 502);
    url = next;
  }
  throw new PreviewError('That page redirects too many times.', 502);
}

// ---- Metadata ----

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? all;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}
const clean = (text, max = 300) => decodeEntities(String(text ?? '')).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function attributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

export function parseMeta(html, baseUrl) {
  const end = html.search(/<\/head\s*>/i);
  const head = end > 0 ? html.slice(0, end) : html;
  const meta = new Map();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const key = (a.property || a.name || '').toLowerCase();
    if (key && a.content && !meta.has(key)) meta.set(key, a.content);
  }
  let imageLink = '';
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    if (String(a.rel).toLowerCase() === 'image_src' && a.href) imageLink = a.href;
  }
  const first = (...keys) => keys.map((k) => meta.get(k)).find(Boolean) || '';
  const rawImage = first('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src') || imageLink;
  let image = '';
  if (rawImage) {
    try { image = parseHttpUrl(new URL(decodeEntities(rawImage.trim()), baseUrl).href)?.href || ''; } catch { image = ''; }
  }
  return {
    title: clean(first('og:title', 'twitter:title') || head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]),
    description: clean(first('og:description', 'twitter:description', 'description'), 400),
    siteName: clean(first('og:site_name'), 100),
    image,
  };
}

// Types come from the bytes, not the header. SVG is excluded on purpose.
export function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && /^GIF8[79]a/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function fetchImage(href, opts) {
  const url = parseHttpUrl(href);
  if (!url) return '';
  try {
    const res = await fetchGuarded(url, { ...opts, accept: 'image/*', maxBytes: MAX_IMAGE, truncate: false });
    if (res.status !== 200) return '';
    const type = sniffImage(res.body);
    return type ? `data:${type};base64,${res.body.toString('base64')}` : '';
  } catch {
    return '';
  }
}

const decodeHtml = (res) => {
  const charset = String(res.headers['content-type'] || '').match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  return res.body.toString(charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252' ? 'latin1' : 'utf8');
};

async function youTubePreview(id, opts) {
  let image = '';
  // The largest size doesn't exist for every video. These two have no letterbox bars.
  for (const size of ['maxresdefault', 'mqdefault']) {
    image = await fetchImage(`https://i.ytimg.com/vi/${id}/${size}.jpg`, opts);
    if (image) break;
  }
  let title = '', author = '';
  try {
    const target = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
    const res = await fetchGuarded(new URL(`https://www.youtube.com/oembed?format=json&url=${target}`), { ...opts, accept: 'application/json', maxBytes: MAX_HTML, truncate: false });
    if (res.status === 200) {
      const data = JSON.parse(res.body.toString('utf8'));
      title = clean(data.title);
      author = clean(data.author_name, 120);
    }
  } catch { /* The thumbnail alone is still a useful preview. */ }
  if (!image && !title) throw new PreviewError('That video could not be loaded.', 502);
  return { kind: 'video', title: title || 'YouTube video', description: author, siteName: 'YouTube', image };
}

export async function getPreview(rawUrl, overrides = {}) {
  const url = parseHttpUrl(rawUrl);
  if (!url) throw new PreviewError('That is not a valid web address.', 400);
  const opts = { checkAddress: isPublicAddress, ports: ALLOWED_PORTS, dnsLookup: dns.lookup, ...overrides };
  const id = overrides.youTube === false ? null : youTubeId(rawUrl);
  if (id) return youTubePreview(id, opts);

  const res = await fetchGuarded(url, { ...opts, accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5', maxBytes: MAX_HTML, truncate: true });
  if (res.status < 200 || res.status >= 300) throw new PreviewError(`The site responded with status ${res.status}.`, 502);
  const type = String(res.headers['content-type'] || '').toLowerCase();
  if (type.startsWith('image/')) {
    return { kind: 'page', title: decodeURIComponent(res.url.pathname.split('/').pop() || '') || res.url.hostname, description: '', siteName: '', image: await fetchImage(res.url.href, opts) };
  }
  if (!type.includes('html')) throw new PreviewError('That address is not a web page.', 502);
  const meta = parseMeta(decodeHtml(res), res.url);
  const image = meta.image ? await fetchImage(meta.image, opts) : '';
  return { kind: 'page', title: meta.title, description: meta.description, siteName: meta.siteName, image };
}

// ---- HTTP endpoint ----

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
let active = 0;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

// Only this app may call the endpoint, so other websites can't use it as a proxy.
export function isAllowedCaller(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== String(req.headers.host).toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function handlePreview(req, res, requestUrl) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
  if (!isAllowedCaller(req)) return send(res, 403, { error: 'Forbidden.' });
  if (active >= MAX_CONCURRENT) return send(res, 429, { error: 'Too many previews at once.' });
  active++;
  const signal = AbortSignal.timeout(TIMEOUT_MS * 2);
  try {
    const stage = AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    return send(res, 200, await getPreview(requestUrl.searchParams.get('url'), { signal: stage }));
  } catch (err) {
    return send(res, err instanceof PreviewError ? err.status : 502, { error: err instanceof PreviewError ? err.message : 'The preview could not be loaded.' });
  } finally {
    active--;
  }
}
