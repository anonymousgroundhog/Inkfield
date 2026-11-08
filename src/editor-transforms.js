// Pure geometric transforms applied to elements during gestures.
import { defaultMeasure, textHeight, wrapText } from './render.js';

export const MIN_SIZE = 8;

export function translate(el, dx, dy) {
  if (el.type === 'connector') {
    const shift = (end) => (end.id ? end : { ...end, x: end.x + dx, y: end.y + dy });
    return { ...el, start: shift(el.start), end: shift(el.end) };
  }
  return { ...el, x: el.x + dx, y: el.y + dy };
}

export function resizedBox(box, handle, dx, dy, keepAspect) {
  let { x, y, w, h } = box;
  if (handle.includes('e')) w = Math.max(MIN_SIZE, box.w + dx);
  if (handle.includes('s')) h = Math.max(MIN_SIZE, box.h + dy);
  if (handle.includes('w')) { w = Math.max(MIN_SIZE, box.w - dx); x = box.x + box.w - w; }
  if (handle.includes('n')) { h = Math.max(MIN_SIZE, box.h - dy); y = box.y + box.h - h; }
  if (keepAspect && box.w && box.h) {
    const f = Math.max(w / box.w, h / box.h);
    const nw = box.w * f, nh = box.h * f;
    if (handle.includes('w')) x = box.x + box.w - nw;
    if (handle.includes('n')) y = box.y + box.h - nh;
    w = nw; h = nh;
  }
  return { x, y, w, h };
}

export function scaleElement(el, from, to, baseById) {
  const fx = to.w / (from.w || 1), fy = to.h / (from.h || 1);
  const map = (p) => ({ x: to.x + (p.x - from.x) * fx, y: to.y + (p.y - from.y) * fy });
  if (el.type === 'connector') {
    const shift = (end) => (end.id && baseById.has(end.id) ? end : { ...end, ...map(end) });
    return { ...el, start: shift(el.start), end: shift(el.end) };
  }
  const a = map(el);
  return { ...el, x: a.x, y: a.y, w: Math.max(MIN_SIZE, el.w * fx), h: Math.max(MIN_SIZE, el.h * fy) };
}

export function fitTextHeight(el) {
  const lines = wrapText(el.text || ' ', el.w, el.fontSize, el.fontWeight, defaultMeasure);
  return { ...el, h: Math.max(el.fontSize * 1.25, textHeight(lines, el.fontSize)) };
}

