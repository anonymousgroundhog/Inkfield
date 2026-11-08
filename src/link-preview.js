// Browser side of link previews: asks the local server, then shrinks the thumbnail
// so a board stays small enough to store and sync.
import { youTubeId } from './links.js';

const MAX_THUMB_WIDTH = 720;

async function shrink(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_THUMB_WIDTH / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return { src: canvas.toDataURL('image/jpeg', 0.84), ratio: canvas.height / canvas.width };
  } catch {
    return { src: '', ratio: 0 };
  }
}

// When there is no preview server (a static host, for example), YouTube thumbnails can
// still be read directly. Website previews can't, because browsers block that.
async function directYouTube(id) {
  for (const size of ['maxresdefault', 'mqdefault']) {
    try {
      const res = await fetch(`https://i.ytimg.com/vi/${id}/${size}.jpg`, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) continue;
      const blob = await res.blob();
      const image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      return { kind: 'video', title: 'YouTube video', description: '', siteName: 'YouTube', image };
    } catch { /* Try the next size. */ }
  }
  return null;
}

async function askServer(url) {
  try {
    const res = await fetch(`api/preview?url=${encodeURIComponent(url)}`, { credentials: 'omit' });
    if (!res.ok || !String(res.headers.get('content-type')).includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Resolves to fields for a link element. Never rejects: failure is a card without a thumbnail.
export async function loadPreview(url) {
  const id = youTubeId(url);
  const data = (await askServer(url)) || (id ? await directYouTube(id) : null);
  if (!data) return { status: 'failed' };
  const thumb = data.image ? await shrink(data.image) : { src: '', ratio: 0 };
  return {
    status: 'ready',
    kind: data.kind === 'video' ? 'video' : 'page',
    title: String(data.title || ''),
    description: String(data.description || ''),
    siteName: String(data.siteName || ''),
    image: thumb.src,
    ratio: thumb.ratio,
  };
}
