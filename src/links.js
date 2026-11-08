// URL helpers shared by the browser and the preview server.

export function parseHttpUrl(text) {
  const raw = String(text ?? '').trim();
  if (!raw || /\s/.test(raw) || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

// Pasted text counts as links only if every line is one, so prose that merely
// mentions a URL stays text. Bare domains need "www." to avoid catching words like "notes.txt".
export function parsePastedUrls(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines.length > 20) return [];
  const urls = lines.map((line) => parseHttpUrl(/^www\.[^\s.]+\.[^\s]+$/i.test(line) ? `https://${line}` : line));
  return urls.every(Boolean) ? urls.map((u) => u.href) : [];
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const VIDEO_ID = /^[\w-]{11}$/;

export function youTubeId(text) {
  const url = parseHttpUrl(text);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be') id = parts[0];
  else if (YOUTUBE_HOSTS.has(host)) {
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1];
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

export const displayHost = (url) => {
  const parsed = parseHttpUrl(url);
  return parsed ? parsed.hostname.replace(/^www\./i, '') : String(url ?? '');
};
