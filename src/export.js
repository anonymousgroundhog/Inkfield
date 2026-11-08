// Standalone SVG documents and PNG rasterisation. Pure except for rasterize().
import { FONT_STACK } from './model.js';
import { defaultMeasure, renderElement, esc, visualBounds } from './render.js';
import { union } from './geometry.js';

export const MAX_CANVAS_SIDE = 16000;

// With `includeConnectors`, connectors whose two ends are both bound inside the
// selection come along, so exporting a group of boxes keeps the arrows between them.
export function exportScope(elements, ids, includeConnectors = true) {
  if (!ids) return elements;
  const set = new Set(ids);
  return elements.filter((el) => {
    if (set.has(el.id)) return true;
    return includeConnectors && el.type === 'connector' && el.start.id && el.end.id
      && set.has(el.start.id) && set.has(el.end.id);
  });
}

export function buildSvg(allElements, ids, opts = {}) {
  const { padding = 24, background = null, includeConnectors = true, measure = defaultMeasure, idPrefix = '' } = opts;
  const byId = new Map(allElements.map((el) => [el.id, el]));
  const scope = exportScope(allElements, ids, includeConnectors);
  const bounds = union(scope.map((el) => visualBounds(el, byId, measure))) || { x: 0, y: 0, w: 1, h: 1 };
  const x = bounds.x - padding, y = bounds.y - padding;
  const width = Math.ceil(bounds.w + padding * 2), height = Math.ceil(bounds.h + padding * 2);
  const body = scope.map((el) => renderElement(el, { byId, measure, idPrefix })).join('');
  const bg = background ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${esc(background)}"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}" font-family="${esc(FONT_STACK)}">${bg}${body}</svg>`;
  return { svg, width, height, count: scope.length };
}

export function fitScale(width, height, scale) {
  return Math.min(scale, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height);
}

export async function rasterize({ svg, width, height }, scale) {
  const effective = fitScale(width, height, scale);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * effective);
    canvas.height = Math.round(height * effective);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The browser could not encode this PNG. Try a smaller scale.');
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const safeFilename = (name) => (String(name).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'inkfield').slice(0, 80);
