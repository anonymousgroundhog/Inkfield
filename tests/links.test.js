import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { displayHost, parseHttpUrl, parsePastedUrls, youTubeId } from '../src/links.js';
import { getPreview, isAllowedCaller, isPublicAddress, parseMeta, PreviewError, sniffImage } from '../server/preview.js';
import { normalizeElements, createElement } from '../src/model.js';
import { approxMeasure, hitTest } from '../src/render.js';
import { buildSvg } from '../src/export.js';

const measure = approxMeasure;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

test('youTubeId reads every common URL form and rejects others', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?list=x&v=${id}&t=30s`, `http://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`, `https://youtu.be/${id}?si=abc`, `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`, `https://www.youtube.com/live/${id}`, `https://www.youtube-nocookie.com/embed/${id}`,
  ]) assert.equal(youTubeId(url), id, url);
  for (const url of [
    'https://www.youtube.com/', 'https://www.youtube.com/playlist?list=abc', 'https://www.youtube.com/watch?v=short',
    `https://evil.example/watch?v=${id}`, `https://youtube.com.evil.example/watch?v=${id}`, 'not a url', `ftp://youtu.be/${id}`,
  ]) assert.equal(youTubeId(url), null, url);
});

test('pasted text is links only when every line is one', () => {
  assert.deepEqual(parsePastedUrls(' https://example.com/a '), ['https://example.com/a']);
  assert.deepEqual(parsePastedUrls('https://a.example\nhttp://b.example/x'), ['https://a.example/', 'http://b.example/x']);
  assert.deepEqual(parsePastedUrls('www.example.com/page'), ['https://www.example.com/page']);
  for (const text of ['see https://a.example now', 'notes.txt', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '', 'hello', 'https://user:pw@a.example/', 'https://a.example\nnot a link']) {
    assert.deepEqual(parsePastedUrls(text), [], text);
  }
  assert.equal(parseHttpUrl('https://a.example/' + 'x'.repeat(3000)), null);
  assert.equal(displayHost('https://www.example.com/a'), 'example.com');
});

test('private and reserved addresses are rejected', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001:0::1', 'not-an-ip', '']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '192.169.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
});

test('metadata parser reads Open Graph, falls back, resolves and decodes', () => {
  const m = parseMeta(`<html><head><title>Fallback</title>
    <meta content="Hello &amp; welcome" property="og:title">
    <meta property='og:description' content='Desc &#39;here&#39;'>
    <meta property="og:site_name" content="Site">
    <meta property="og:image" content="/img/a.png"></head><body><meta property="og:title" content="ignored"></body></html>`, new URL('https://a.example/x/y'));
  assert.equal(m.title, 'Hello & welcome');
  assert.equal(m.description, "Desc 'here'");
  assert.equal(m.siteName, 'Site');
  assert.equal(m.image, 'https://a.example/img/a.png');
  const f = parseMeta('<title>\n  Plain  <b>title</b>\n</title><meta name="description" content="d"><link rel="image_src" href="i.jpg">', new URL('https://a.example/p/'));
  assert.equal(f.title, 'Plain title');
  assert.equal(f.description, 'd');
  assert.equal(f.image, 'https://a.example/p/i.jpg');
  assert.equal(parseMeta('<meta property="og:image" content="javascript:alert(1)">', new URL('https://a.example')).image, '');
  assert.equal(parseMeta('<meta property="og:image" content="file:///etc/passwd">', new URL('https://a.example')).image, '');
});

test('image types come from the bytes, and SVG is refused', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a---')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<html>')), null);
});

test('only this app may call the endpoint', () => {
  const req = (headers) => ({ headers: { host: 'localhost:4173', ...headers } });
  assert.equal(isAllowedCaller(req({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(isAllowedCaller(req({})), true);
  assert.equal(isAllowedCaller(req({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isAllowedCaller(req({ origin: 'https://evil.example' })), false);
  assert.equal(isAllowedCaller(req({ origin: 'null' })), false);
  assert.equal(isAllowedCaller({ headers: { host: 'evil.example' } }), false, 'DNS rebinding');
});

// ---- Against a real local server, opening only the guard each test needs ----
let server, port;
const routes = {
  '/page': (res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<head><title>T</title><meta property="og:title" content="OG"><meta property="og:image" content="/pic"></head>'); },
  '/pic': (res) => { res.setHeader('content-type', 'image/png'); res.end(PNG); },
  '/svgpic': (res) => { res.setHeader('content-type', 'text/html'); res.end(`<meta property="og:image" content="/svg">`); },
  '/svg': (res) => { res.setHeader('content-type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'); },
  '/gz': (res) => { res.setHeader('content-type', 'text/html'); res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync('<title>Zipped</title>')); },
  '/bomb': (res) => { res.setHeader('content-type', 'image/png'); res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync(Buffer.alloc(30 * 1024 * 1024))); },
  '/bombpage': (res) => { res.setHeader('content-type', 'text/html'); res.end('<meta property="og:image" content="/bomb"><title>Survives</title>'); },
  '/big': (res) => { res.setHeader('content-type', 'text/html'); res.write('<title>Early</title>'); res.end('x'.repeat(4 * 1024 * 1024)); },
  '/direct': (res) => { res.setHeader('content-type', 'image/png'); res.end(PNG); },
  '/redir': (res) => { res.statusCode = 302; res.setHeader('location', '/page'); res.end(); },
  '/loop': (res) => { res.statusCode = 302; res.setHeader('location', '/loop'); res.end(); },
  '/to-private': (res) => { res.statusCode = 302; res.setHeader('location', `http://[::1]:${port}/page`); res.end(); },
  '/to-file': (res) => { res.statusCode = 302; res.setHeader('location', 'file:///etc/passwd'); res.end(); },
  '/404': (res) => { res.statusCode = 404; res.end('no'); },
  '/pdf': (res) => { res.setHeader('content-type', 'application/pdf'); res.end('%PDF'); },
};
before(async () => {
  server = http.createServer((req, res) => (routes[req.url] || routes['/404'])(res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

const testOpts = () => ({ checkAddress: (ip) => ip === '127.0.0.1', ports: new Set([String(port)]) });
const fetchPath = (path, extra) => getPreview(`http://127.0.0.1:${port}${path}`, { ...testOpts(), ...extra });

test('a page yields its metadata and an embedded thumbnail', async () => {
  const p = await fetchPath('/page');
  assert.equal(p.title, 'OG');
  assert.equal(p.kind, 'page');
  assert.match(p.image, /^data:image\/png;base64,/);
});

test('redirects are followed, loops and unsupported targets fail', async () => {
  assert.equal((await fetchPath('/redir')).title, 'OG');
  await assert.rejects(fetchPath('/loop'), /too many/);
  await assert.rejects(fetchPath('/to-file'), /unsupported/);
});

test('default guard blocks local targets, however they are spelled', async () => {
  for (const url of [`http://127.0.0.1:${port}/page`, 'http://127.0.0.1/', 'http://[::1]/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/']) {
    await assert.rejects(getPreview(url), (e) => e instanceof PreviewError && e.status === 422, url);
  }
});

test('a redirect from an allowed host to a private address is blocked', async () => {
  await assert.rejects(fetchPath('/to-private'), (e) => e.status === 422);
});

test('a hostname that resolves to a private address is blocked at connection time', async () => {
  const dnsLookup = (host, options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(getPreview(`http://rebind.example:${port}/page`, { dnsLookup, ports: new Set([String(port)]) }), (e) => e.status === 422);
  const mixed = (host, options, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  await assert.rejects(getPreview(`http://mixed.example:${port}/page`, { dnsLookup: mixed, ports: new Set([String(port)]) }), (e) => e.status === 422, 'any private answer fails');
});

test('other ports are refused by default', async () => {
  await assert.rejects(getPreview('http://8.8.8.8:22/'), (e) => e.status === 422);
});

test('non-image thumbnails and oversized images are dropped, the page still works', async () => {
  assert.equal((await fetchPath('/svgpic')).image, '');
  const p = await fetchPath('/bombpage');
  assert.equal(p.title, 'Survives');
  assert.equal(p.image, '');
});

test('compressed and very large pages stay within limits', async () => {
  assert.equal((await fetchPath('/gz')).title, 'Zipped');
  assert.equal((await fetchPath('/big')).title, 'Early');
});

test('a direct image link previews itself, other files and errors fail', async () => {
  assert.match((await fetchPath('/direct')).image, /^data:image\/png/);
  await assert.rejects(fetchPath('/pdf'), /not a web page/);
  await assert.rejects(fetchPath('/404'), /status 404/);
  await assert.rejects(getPreview('javascript:alert(1)'), (e) => e.status === 400);
});

test('imported cards are validated and never fetch on their own', () => {
  const out = normalizeElements([
    { type: 'link', url: 'javascript:alert(1)' },
    { type: 'link' },
    { type: 'link', url: 'https://a.example', status: 'loading', image: 'https://tracker.example/x.png', kind: 'evil' },
    { type: 'link', url: 'https://b.example', status: 'ready', image: 'data:image/png;base64,AAAA', kind: 'video', title: 'T' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].status, 'failed');
  assert.equal(out[0].image, '');
  assert.equal(out[0].kind, 'page');
  assert.equal(out[1].status, 'ready');
  assert.equal(out[1].kind, 'video');
});

test('link cards render title and host, escape hostile text, and embed only safe images', () => {
  const [card] = normalizeElements([{ type: 'link', url: 'https://www.example.com/a', status: 'ready', kind: 'video', title: '</text><script>x()</script>', image: 'data:image/png;base64,AAAA' }]);
  const { svg } = buildSvg([card], null, { measure });
  assert.ok(!svg.includes('<script'));
  assert.ok(svg.includes('example.com'));
  assert.ok(svg.includes('<image'));
  assert.ok(svg.includes('xMidYMid slice'));
  const remote = { ...card, image: 'https://tracker.example/x.png' };
  assert.ok(!buildSvg([remote], null, { measure }).svg.includes('tracker'));
  assert.equal(hitTest(createElement('link', { x: 0, y: 0, url: 'https://a.example' }), { x: 50, y: 40 }, new Map(), 4, measure), true);
});

test('long titles are clamped to two lines', () => {
  const [card] = normalizeElements([{ type: 'link', url: 'https://a.example', status: 'ready', title: 'word '.repeat(80), h: 300 }]);
  const { svg } = buildSvg([card], null, { measure });
  assert.ok(svg.includes('…'));
  assert.ok((svg.match(/word/g) || []).length < 40);
});
