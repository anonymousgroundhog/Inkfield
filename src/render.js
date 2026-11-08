// Pure SVG-string renderer. The live canvas, thumbnails and PNG export all share it,
// so what you see is exactly what gets exported. Text is plain SVG <text> rather than
// foreignObject, because foreignObject would taint the canvas used for PNG output.
import { FONT_STACK } from './model.js';
import { connectorPath, parallelogramSkew, routeConnector } from './connectors.js';
import { contains, distToPolyline, inflate, pointAlong, pointInPolygon, pointInRect, union } from './geometry.js';
import { iconPaths } from './icons.js';

export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const n = (v) => Math.round(v * 100) / 100;
const LINE = 1.25;
const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i;

let canvasCtx = null;
export function browserMeasure(text, fontSize, weight) {
  if (!canvasCtx) canvasCtx = document.createElement('canvas').getContext('2d');
  canvasCtx.font = `${weight} ${fontSize}px ${FONT_STACK}`;
  return canvasCtx.measureText(text).width;
}
// Used outside the browser (tests, CLI); an average-glyph approximation.
export const approxMeasure = (text, fontSize, weight) => text.length * fontSize * (weight >= 600 ? 0.56 : 0.52);
export const defaultMeasure = typeof document !== 'undefined' ? browserMeasure : approxMeasure;

// ---- Text layout. Supports **bold** spans and explicit line breaks. ----

export function wrapText(text, maxWidth, fontSize, baseWeight = 400, measure = defaultMeasure) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    const words = [];
    for (const part of para.split(/(\*\*[^*\n]+\*\*)/)) {
      if (!part) continue;
      const bold = /^\*\*.+\*\*$/.test(part);
      const raw = bold ? part.slice(2, -2) : part;
      raw.split(/( +)/).forEach((w) => { if (w) words.push({ t: w, bold }); });
    }
    let line = [], width = 0;
    const flush = () => {
      while (line.length && !line[line.length - 1].t.trim()) { width -= line.pop().w; }
      lines.push({ runs: mergeRuns(line), width: Math.max(0, width) });
      line = []; width = 0;
    };
    for (const word of words) {
      const weight = word.bold ? 700 : baseWeight;
      const isSpace = !word.t.trim();
      const w = measure(word.t, fontSize, weight);
      if (isSpace && !line.length) continue;
      if (!isSpace && width + w > maxWidth && line.length) flush();
      if (!isSpace && w > maxWidth) {
        // Break an over-long word across lines.
        let chunk = '';
        for (const ch of word.t) {
          if (chunk && measure(chunk + ch, fontSize, weight) > maxWidth) {
            line.push({ t: chunk, bold: word.bold, w: measure(chunk, fontSize, weight) });
            width += line[line.length - 1].w;
            flush();
            chunk = '';
          }
          chunk += ch;
        }
        if (chunk) {
          const cw = measure(chunk, fontSize, weight);
          line.push({ t: chunk, bold: word.bold, w: cw });
          width += cw;
        }
        continue;
      }
      line.push({ t: word.t, bold: word.bold, w });
      width += w;
    }
    flush();
  }
  return lines;
}

function mergeRuns(words) {
  const runs = [];
  for (const w of words) {
    const last = runs[runs.length - 1];
    if (last && last.bold === w.bold) last.t += w.t;
    else runs.push({ t: w.t, bold: w.bold });
  }
  return runs;
}

export const textHeight = (lines, fontSize) => lines.length * fontSize * LINE;

function textMarkup(text, box, style, measure) {
  if (!text) return '';
  const { fontSize, fontWeight = 400, align = 'center', valign = 'middle', textColor = '#111111' } = style;
  const lines = wrapText(text, Math.max(10, box.w), fontSize, fontWeight, measure);
  const total = textHeight(lines, fontSize);
  const top = valign === 'top' ? box.y : valign === 'bottom' ? box.y + box.h - total : box.y + (box.h - total) / 2;
  const x = align === 'left' ? box.x : align === 'right' ? box.x + box.w : box.x + box.w / 2;
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  const spans = lines.map((line, i) => {
    const y = top + i * fontSize * LINE + fontSize * (LINE - 1) / 2 + fontSize * 0.82;
    const inner = line.runs.map((r) => (r.bold ? `<tspan font-weight="700">${esc(r.t)}</tspan>` : esc(r.t))).join('');
    return `<tspan x="${n(x)}" y="${n(y)}">${inner || ' '}</tspan>`;
  }).join('');
  return `<text font-size="${n(fontSize)}" font-weight="${esc(fontWeight)}" fill="${esc(textColor)}" text-anchor="${anchor}" style="white-space:pre">${spans}</text>`;
}

// The world-space box text is laid out in, also used to position the inline editor.
export function textBox(el) {
  const { x, y, w, h } = el;
  switch (el.type) {
    case 'ellipse': return { x: x + w * 0.15, y: y + h * 0.15, w: w * 0.7, h: h * 0.7 };
    case 'diamond': return { x: x + w * 0.25, y: y + h * 0.25, w: w * 0.5, h: h * 0.5 };
    case 'hexagon': return { x: x + w * 0.2, y: y + 6, w: w * 0.6, h: h - 12 };
    case 'parallelogram': { const s = parallelogramSkew(el); return { x: x + s + 4, y: y + 6, w: Math.max(10, w - s * 2 - 8), h: h - 12 }; }
    case 'cylinder': { const cap = Math.min(h * 0.18, 24); return { x: x + 8, y: y + cap * 2, w: w - 16, h: h - cap * 2.5 }; }
    case 'text': return { x, y, w, h };
    case 'sticky': return { x: x + 14, y: y + 14, w: w - 28, h: h - 28 };
    case 'icon': return { x: x - 40, y: y + h + 4, w: w + 80, h: 0 };
    default: return { x: x + 10, y: y + 6, w: w - 20, h: h - 12 };
  }
}

// ---- Tables ----

export function tableLayout(el) {
  const rows = el.cells.length, cols = el.cells[0]?.length || 1;
  const titleH = el.titleRow && rows > 1 ? Math.min(el.fontSize * 2.6, el.h / rows * 1.2) : 0;
  const bodyRows = titleH ? rows - 1 : rows;
  const rowH = (el.h - titleH) / bodyRows;
  return { rows, cols, titleH, rowH, colW: el.w / cols };
}

export function cellRect(el, r, c) {
  const l = tableLayout(el);
  if (l.titleH && r === 0) return { x: el.x, y: el.y, w: el.w, h: l.titleH };
  const bodyIndex = l.titleH ? r - 1 : r;
  return { x: el.x + c * l.colW, y: el.y + l.titleH + bodyIndex * l.rowH, w: l.colW, h: l.rowH };
}

export function cellAt(el, p) {
  const l = tableLayout(el);
  for (let r = 0; r < l.rows; r++) {
    for (let c = 0; c < l.cols; c++) {
      if (pointInRect(p, cellRect(el, r, c))) return { r, c };
      if (l.titleH && r === 0) break;
    }
  }
  return null;
}

const isCellHidden = (el, r, c) => el.titleRow && el.cells.length > 1 && r === 0 && c > 0;

function tableMarkup(el, ctx) {
  const l = tableLayout(el);
  const strokeAttr = `stroke="${esc(el.stroke)}" stroke-width="${n(el.strokeWidth)}"`;
  let out = `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" fill="${esc(el.fill)}"/>`;
  if (l.titleH) out += `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(l.titleH)}" fill="${esc(el.headerFill)}"/>`;
  el.cells.forEach((row, r) => row.forEach((value, c) => {
    if (isCellHidden(el, r, c) || !value) return;
    if (ctx.hideText?.id === el.id && ctx.hideText.r === r && ctx.hideText.c === c) return;
    const b = cellRect(el, r, c);
    const title = l.titleH && r === 0;
    out += textMarkup(value, { x: b.x + 8, y: b.y + 4, w: b.w - 16, h: b.h - 8 }, {
      fontSize: title ? el.fontSize * 1.1 : el.fontSize, fontWeight: title ? 700 : 400, textColor: el.textColor,
    }, ctx.measure);
  }));
  const bodyTop = el.y + l.titleH;
  for (let c = 1; c < l.cols; c++) out += `<path d="M${n(el.x + c * l.colW)} ${n(bodyTop)}V${n(el.y + el.h)}" ${strokeAttr}/>`;
  if (l.titleH) out += `<path d="M${n(el.x)} ${n(bodyTop)}H${n(el.x + el.w)}" ${strokeAttr}/>`;
  const bodyRows = l.titleH ? l.rows - 1 : l.rows;
  for (let r = 1; r < bodyRows; r++) out += `<path d="M${n(el.x)} ${n(bodyTop + r * l.rowH)}H${n(el.x + el.w)}" ${strokeAttr}/>`;
  out += `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" fill="none" ${strokeAttr}/>`;
  return out;
}

// ---- Shapes ----

const dashAttr = (el) => {
  const w = el.strokeWidth || 1;
  if (el.dash === 'dashed') return ` stroke-dasharray="${n(w * 4)} ${n(w * 3)}"`;
  if (el.dash === 'dotted') return ` stroke-dasharray="0.1 ${n(w * 2.5)}" stroke-linecap="round"`;
  return '';
};

export function polygonFor(el) {
  const { x, y, w, h } = el;
  if (el.type === 'diamond') return [{ x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x, y: y + h / 2 }];
  if (el.type === 'hexagon') {
    const s = Math.min(w * 0.22, h * 0.5);
    return [{ x: x + s, y }, { x: x + w - s, y }, { x: x + w, y: y + h / 2 }, { x: x + w - s, y: y + h }, { x: x + s, y: y + h }, { x, y: y + h / 2 }];
  }
  if (el.type === 'parallelogram') {
    const s = parallelogramSkew(el);
    return [{ x: x + s, y }, { x: x + w, y }, { x: x + w - s, y: y + h }, { x, y: y + h }];
  }
  return null;
}

function shapeMarkup(el) {
  const paint = `fill="${esc(el.fill)}" stroke="${esc(el.stroke)}" stroke-width="${n(el.strokeWidth)}" stroke-linejoin="round"${dashAttr(el)}`;
  const { x, y, w, h } = el;
  if (el.type === 'rect') {
    const r = Math.max(0, Math.min(el.radius, w / 2, h / 2));
    return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" ${paint}/>`;
  }
  if (el.type === 'ellipse') return `<ellipse cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" rx="${n(w / 2)}" ry="${n(h / 2)}" ${paint}/>`;
  if (el.type === 'cylinder') {
    const c = Math.min(h * 0.18, 24), rx = n(w / 2);
    return `<path d="M${n(x)} ${n(y + c)}A${rx} ${n(c)} 0 0 1 ${n(x + w)} ${n(y + c)}V${n(y + h - c)}A${rx} ${n(c)} 0 0 1 ${n(x)} ${n(y + h - c)}Z" ${paint}/>`
      + `<path d="M${n(x)} ${n(y + c)}A${rx} ${n(c)} 0 0 0 ${n(x + w)} ${n(y + c)}" fill="none" stroke="${esc(el.stroke)}" stroke-width="${n(el.strokeWidth)}"/>`;
  }
  const pts = polygonFor(el).map((p) => `${n(p.x)},${n(p.y)}`).join(' ');
  return `<polygon points="${pts}" ${paint}/>`;
}

function stickyMarkup(el) {
  const { x, y, w, h } = el;
  const fold = Math.min(22, w * 0.18, h * 0.18);
  return `<path d="M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h - fold)}L${n(x + w - fold)} ${n(y + h)}H${n(x)}Z" fill="${esc(el.fill)}"/>`
    + `<path d="M${n(x + w)} ${n(y + h - fold)}H${n(x + w - fold)}V${n(y + h)}Z" fill="#000" fill-opacity="0.16"/>`;
}

function iconMarkup(el) {
  const size = Math.min(el.w, el.h);
  const scale = size / 24;
  const ox = el.x + (el.w - size) / 2, oy = el.y + (el.h - size) / 2;
  const paths = iconPaths(el.icon).map((d) => `<path d="${esc(d)}"/>`).join('');
  return `<g transform="translate(${n(ox)} ${n(oy)}) scale(${n(scale)})" fill="${esc(el.fill)}" stroke="${esc(el.stroke)}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;
}

function penPath(el) {
  const pts = el.points.map((p) => ({ x: el.x + p.x * el.w, y: el.y + p.y * el.h }));
  if (pts.length < 2) return '';
  let d = `M${n(pts[0].x)} ${n(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += `Q${n(pts[i].x)} ${n(pts[i].y)} ${n(mx)} ${n(my)}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${n(last.x)} ${n(last.y)}`;
}

// ---- Connectors ----

const capSize = (el) => Math.max(10, el.strokeWidth * 4.2);

function capMarkup(cap, tip, dir, el) {
  if (cap === 'none') return '';
  const size = capSize(el);
  const nx = -dir.y, ny = dir.x, half = size * 0.48;
  const base = { x: tip.x + dir.x * size, y: tip.y + dir.y * size };
  if (cap === 'dot') return `<circle cx="${n(tip.x)}" cy="${n(tip.y)}" r="${n(size * 0.38)}" fill="${esc(el.stroke)}"/>`;
  if (cap === 'cross') {
    const r = size * 0.42;
    const c = { x: tip.x + dir.x * r, y: tip.y + dir.y * r };
    const ax = (dir.x + nx) * r * 0.7, ay = (dir.y + ny) * r * 0.7, bx = (dir.x - nx) * r * 0.7, by = (dir.y - ny) * r * 0.7;
    return `<path d="M${n(c.x - ax)} ${n(c.y - ay)}L${n(c.x + ax)} ${n(c.y + ay)}M${n(c.x - bx)} ${n(c.y - by)}L${n(c.x + bx)} ${n(c.y + by)}" fill="none" stroke="${esc(el.stroke)}" stroke-width="${n(el.strokeWidth)}" stroke-linecap="round"/>`;
  }
  if (cap === 'open') {
    return `<path d="M${n(base.x + nx * half)} ${n(base.y + ny * half)}L${n(tip.x)} ${n(tip.y)}L${n(base.x - nx * half)} ${n(base.y - ny * half)}" fill="none" stroke="${esc(el.stroke)}" stroke-width="${n(el.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `<polygon points="${n(tip.x)},${n(tip.y)} ${n(base.x + nx * half)},${n(base.y + ny * half)} ${n(base.x - nx * half)},${n(base.y - ny * half)}" fill="${esc(el.stroke)}"/>`;
}

export function labelLayout(el, route, measure = defaultMeasure) {
  if (!el.label) return null;
  const lines = wrapText(el.label, 240, el.fontSize, el.fontWeight, measure);
  const w = Math.max(...lines.map((l) => l.width)), h = textHeight(lines, el.fontSize);
  const at = pointAlong(route.pts, el.labelPos ?? 0.5);
  return { x: at.x - w / 2, y: at.y - h / 2, w, h, at };
}

function connectorMarkup(el, ctx) {
  const route = routeConnector(el, ctx.byId);
  const trim = (cap) => (cap === 'arrow' ? capSize(el) * 0.85 : 0);
  const d = connectorPath(route, trim(el.startCap), trim(el.endCap));
  const label = ctx.hideText?.id === el.id ? null : labelLayout(el, route, ctx.measure);
  let mask = '', maskAttr = '';
  if (label) {
    // A mask (not a filled box) opens the gap, so labels stay clean on transparent exports.
    const b = union(route.pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
    const m = inflate(union([b, label]), capSize(el) + el.strokeWidth);
    const id = `${ctx.idPrefix || ''}gap-${el.id}`;
    mask = `<mask id="${esc(id)}" maskUnits="userSpaceOnUse" x="${n(m.x)}" y="${n(m.y)}" width="${n(m.w)}" height="${n(m.h)}"><rect x="${n(m.x)}" y="${n(m.y)}" width="${n(m.w)}" height="${n(m.h)}" fill="#fff"/><rect x="${n(label.x - 6)}" y="${n(label.y - 2)}" width="${n(label.w + 12)}" height="${n(label.h + 4)}" fill="#000"/></mask>`;
    maskAttr = ` mask="url(#${esc(id)})"`;
  }
  let out = mask;
  out += `<path d="${d}" fill="none" stroke="${esc(el.stroke)}" stroke-width="${n(el.strokeWidth)}" stroke-linejoin="round"${dashAttr(el)}${maskAttr}/>`;
  out += capMarkup(el.startCap, route.pts[0], route.startDir, el);
  out += capMarkup(el.endCap, route.pts[route.pts.length - 1], route.endDir, el);
  if (label) {
    out += textMarkup(el.label, { x: label.x, y: label.y, w: Math.max(label.w, 1) + 1, h: label.h }, {
      fontSize: el.fontSize, fontWeight: el.fontWeight, textColor: el.textColor,
    }, ctx.measure);
  }
  return out;
}

export function renderElement(el, ctx) {
  ctx = { measure: defaultMeasure, ...ctx };
  let body = '';
  const showText = ctx.hideText?.id !== el.id;
  switch (el.type) {
    case 'connector': body = connectorMarkup(el, ctx); break;
    case 'table': body = tableMarkup(el, ctx); break;
    case 'pen': body = `<path d="${penPath(el)}" fill="none" stroke="${esc(el.stroke)}" stroke-width="${n(el.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"${dashAttr(el)}/>`; break;
    case 'image':
      if (SAFE_IMAGE.test(el.src)) body = `<image x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" href="${esc(el.src)}" preserveAspectRatio="xMidYMid meet"/>`;
      break;
    case 'text': break;
    case 'sticky': body = stickyMarkup(el); break;
    case 'icon': body = iconMarkup(el); break;
    default: body = shapeMarkup(el);
  }
  if (showText && el.text && el.type !== 'connector') {
    const b = textBox(el);
    body += textMarkup(el.text, b, el.type === 'icon' ? { ...el, align: 'center', valign: 'top' } : el, ctx.measure);
  }
  return el.opacity != null && el.opacity < 1 ? `<g opacity="${n(el.opacity)}">${body}</g>` : body;
}

// ---- Bounds and hit testing ----

export function elementBounds(el, byId) {
  if (el.type === 'connector') return union(routeConnector(el, byId).pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
  return { x: el.x, y: el.y, w: el.w, h: el.h };
}

// Everything that paints, including strokes, arrowheads and captions. Export crops to this.
export function visualBounds(el, byId, measure = defaultMeasure) {
  const base = elementBounds(el, byId);
  if (el.type === 'connector') {
    const route = routeConnector(el, byId);
    return inflate(union([base, labelLayout(el, route, measure)]), capSize(el) / 2 + el.strokeWidth);
  }
  const rects = [inflate(base, (el.strokeWidth || 0) / 2 + 1)];
  if (el.type === 'icon' && el.text) {
    const b = textBox(el);
    const lines = wrapText(el.text, b.w, el.fontSize, el.fontWeight, measure);
    const w = Math.max(...lines.map((l) => l.width));
    rects.push({ x: el.x + el.w / 2 - w / 2, y: b.y, w, h: textHeight(lines, el.fontSize) + 2 });
  }
  return union(rects);
}

export function hitTest(el, p, byId, tol = 6, measure = defaultMeasure) {
  if (el.type === 'connector') {
    const route = routeConnector(el, byId);
    if (distToPolyline(p, route.pts) <= tol + el.strokeWidth / 2) return true;
    const label = labelLayout(el, route, measure);
    return !!label && pointInRect(p, inflate(label, 3));
  }
  if (el.type === 'pen') {
    const pts = el.points.map((q) => ({ x: el.x + q.x * el.w, y: el.y + q.y * el.h }));
    return distToPolyline(p, pts) <= tol + el.strokeWidth / 2;
  }
  const box = { x: el.x, y: el.y, w: el.w, h: el.h };
  if (!pointInRect(p, inflate(box, tol))) {
    return el.type === 'icon' && !!el.text && pointInRect(p, visualBounds(el, byId, measure));
  }
  if (['image', 'text', 'sticky', 'table', 'icon'].includes(el.type)) return true;
  const filled = el.fill && el.fill !== 'none' && el.fill !== 'transparent';
  const nearEdge = !contains(box, inflate({ x: p.x, y: p.y, w: 0, h: 0 }, tol));
  if (el.type === 'ellipse') {
    const rx = el.w / 2, ry = el.h / 2;
    const v = ((p.x - el.x - rx) / (rx || 1)) ** 2 + ((p.y - el.y - ry) / (ry || 1)) ** 2;
    if (filled || el.text) return v <= (1 + tol / Math.min(rx, ry)) ** 2;
    const inner = Math.max(0, 1 - tol / Math.min(rx, ry)) ** 2;
    return v >= inner && v <= (1 + tol / Math.min(rx, ry)) ** 2;
  }
  const poly = polygonFor(el);
  if (poly) {
    if (filled || el.text) return pointInPolygon(p, poly);
    const closed = [...poly, poly[0]];
    return distToPolyline(p, closed) <= tol;
  }
  // An unfilled box is grabbed by its edge, so things inside it stay clickable.
  return filled || !!el.text || nearEdge;
}
