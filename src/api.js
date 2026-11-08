// Calls to the local server. The key arrives once in the link's #fragment, which browsers
// never send to servers or in referrers, and is removed from the address bar right away.
// localStorage is scoped to this exact address, so sites and apps on other ports can't read it.
const STORAGE_KEY = 'inkfield-key';
let memoryKey = null;

function readStored() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return memoryKey; }
}

function captureKeyFromLink() {
  const match = location.hash.match(/^#key=([0-9a-f]{64})$/);
  if (!match) return;
  memoryKey = match[1];
  try { localStorage.setItem(STORAGE_KEY, match[1]); } catch { /* Kept in memory for this tab. */ }
  history.replaceState(null, '', location.pathname + location.search);
}
captureKeyFromLink();

export function apiFetch(path, options = {}) {
  const key = readStored() || memoryKey;
  return fetch(path, {
    credentials: 'omit',
    ...options,
    headers: { ...options.headers, ...(key ? { 'X-Inkfield-Key': key } : {}) },
  });
}

// True when a local server exists but this browser doesn't hold its key.
export async function needsPrivateLink() {
  try {
    return (await apiFetch('api/session')).status === 401;
  } catch {
    return false;
  }
}
