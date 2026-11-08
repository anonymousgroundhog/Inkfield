// Connector geometry: anchors on shapes, routing, and path output.
import { polylineLength } from './geometry.js';

const DIRS = {
  top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 },
};
export const SIDES = Object.keys(DIRS);

export function parallelogramSkew(el) {
  return Math.min(el.w * 0.25, el.h * 0.6);
}

// Icon captions sit below the box, so a bottom connector has to start below them.
// An estimate is enough here and keeps routing independent of text measurement.
function captionDrop(el) {
  if (el.type !== 'icon' || !el.text) return 0;
  const lines = el.text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil((line.length * el.fontSize * 0.55) / (el.w + 80))), 0);
  return lines * el.fontSize * 1.25 + 10;
}

export function anchorPoint(el, side) {
  const { x, y, w, h } = el;
  const inset = el.type === 'parallelogram' ? parallelogramSkew(el) / 2 : 0;
  switch (side) {
    case 'top': return { x: x + w / 2, y };
    case 'bottom': return { x: x + w / 2, y: y + h + captionDrop(el) };
    case 'left': return { x: x + inset, y: y + h / 2 };
    default: return { x: x + w - inset, y: y + h / 2 };
  }
}

export function nearestSide(el, p) {
  let best = 'right', bestD = Infinity;
  for (const side of SIDES) {
    const a = anchorPoint(el, side);
    const d = Math.hypot(a.x - p.x, a.y - p.y);
    if (d < bestD) { bestD = d; best = side; }
  }
  return best;
}

function autoSide(el, toward) {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  const dx = (toward.x - cx) / (el.w / 2 || 1), dy = (toward.y - cy) / (el.h / 2 || 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

const refPoint = (end, byId) => {
  const el = end.id && byId.get(end.id);
  return el ? { x: el.x + el.w / 2, y: el.y + el.h / 2 } : { x: end.x, y: end.y };
};

function resolveEnd(end, other, byId) {
  const el = end.id && byId.get(end.id);
  if (!el) return { x: end.x, y: end.y, dir: null };
  const side = end.side || autoSide(el, refPoint(other, byId));
  return { ...anchorPoint(el, side), dir: DIRS[side] };
}

export function resolveEnds(conn, byId) {
  const start = resolveEnd(conn.start, conn.end, byId);
  const end = resolveEnd(conn.end, conn.start, byId);
  // A free end leaves toward the other end along the dominant axis.
  const infer = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? 1 : -1, y: 0 };
    return { x: 0, y: dy >= 0 ? 1 : -1 };
  };
  if (!start.dir) start.dir = infer(start, end);
  if (!end.dir) end.dir = infer(end, start);
  return { start, end };
}

function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const collinear = (Math.abs(a.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01)
        || (Math.abs(a.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01);
      if (collinear) out.pop();
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

export function elbowPoints(s, ds, e, de, pad = 26) {
  const p = { x: s.x + ds.x * pad, y: s.y + ds.y * pad };
  const q = { x: e.x + de.x * pad, y: e.y + de.y * pad };
  const sH = ds.x !== 0, eH = de.x !== 0;
  let mid;
  if (sH && eH) {
    if (ds.x === de.x) {
      const mx = ds.x > 0 ? Math.max(p.x, q.x) : Math.min(p.x, q.x);
      mid = [{ x: mx, y: p.y }, { x: mx, y: q.y }];
    } else if ((q.x - p.x) * ds.x >= 0) {
      const mx = (p.x + q.x) / 2;
      mid = [{ x: mx, y: p.y }, { x: mx, y: q.y }];
    } else {
      const my = (p.y + q.y) / 2;
      mid = [{ x: p.x, y: my }, { x: q.x, y: my }];
    }
  } else if (!sH && !eH) {
    if (ds.y === de.y) {
      const my = ds.y > 0 ? Math.max(p.y, q.y) : Math.min(p.y, q.y);
      mid = [{ x: p.x, y: my }, { x: q.x, y: my }];
    } else if ((q.y - p.y) * ds.y >= 0) {
      const my = (p.y + q.y) / 2;
      mid = [{ x: p.x, y: my }, { x: q.x, y: my }];
    } else {
      const mx = (p.x + q.x) / 2;
      mid = [{ x: mx, y: p.y }, { x: mx, y: q.y }];
    }
  } else if (sH) {
    const ok = (q.x - p.x) * ds.x >= 0 && (q.y - p.y) * -de.y >= 0;
    mid = [ok ? { x: q.x, y: p.y } : { x: p.x, y: q.y }];
  } else {
    const ok = (q.y - p.y) * ds.y >= 0 && (q.x - p.x) * -de.x >= 0;
    mid = [ok ? { x: p.x, y: q.y } : { x: q.x, y: p.y }];
  }
  return simplify([s, p, ...mid, q, e]);
}

function bezierAt(a, c1, c2, b, t) {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

// Returns {pts, curve?}. `pts` is always a polyline usable for hit tests and labels.
export function routeConnector(conn, byId) {
  const { start, end } = resolveEnds(conn, byId);
  if (conn.route === 'straight') return { pts: [start, end], startDir: unit(start, end), endDir: unit(end, start) };
  if (conn.route === 'curve') {
    const d = Math.max(30, Math.hypot(end.x - start.x, end.y - start.y) * 0.4);
    const c1 = { x: start.x + start.dir.x * d, y: start.y + start.dir.y * d };
    const c2 = { x: end.x + end.dir.x * d, y: end.y + end.dir.y * d };
    const pts = [];
    for (let i = 0; i <= 28; i++) pts.push(bezierAt(start, c1, c2, end, i / 28));
    return { pts, curve: { a: start, c1, c2, b: end }, startDir: start.dir, endDir: end.dir };
  }
  const pts = elbowPoints(start, start.dir, end, end.dir);
  return { pts, startDir: unit(pts[0], pts[1]), endDir: unit(pts[pts.length - 1], pts[pts.length - 2]) };
}

function unit(a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}

const fmt = (n) => Math.round(n * 100) / 100;

// SVG path, with both ends pulled back by trim distances so caps sit cleanly.
export function connectorPath(route, trimStart = 0, trimEnd = 0, radius = 14) {
  const moved = (p, dir, d) => ({ x: p.x + dir.x * d, y: p.y + dir.y * d });
  if (route.curve) {
    const a = moved(route.curve.a, route.startDir, trimStart);
    const b = moved(route.curve.b, route.endDir, trimEnd);
    const { c1, c2 } = route.curve;
    return `M${fmt(a.x)} ${fmt(a.y)}C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(b.x)} ${fmt(b.y)}`;
  }
  const pts = route.pts.map((p) => ({ x: p.x, y: p.y }));
  const total = polylineLength(pts);
  const safeStart = Math.min(trimStart, total * 0.4), safeEnd = Math.min(trimEnd, total * 0.4);
  pts[0] = moved(pts[0], route.startDir, safeStart);
  pts[pts.length - 1] = moved(pts[pts.length - 1], route.endDir, safeEnd);
  let d = `M${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], c = pts[i], b = pts[i + 1];
    const r = Math.min(radius, Math.hypot(c.x - a.x, c.y - a.y) / 2, Math.hypot(b.x - c.x, b.y - c.y) / 2);
    const u1 = unit(c, a), u2 = unit(c, b);
    d += `L${fmt(c.x + u1.x * r)} ${fmt(c.y + u1.y * r)}Q${fmt(c.x)} ${fmt(c.y)} ${fmt(c.x + u2.x * r)} ${fmt(c.y + u2.y * r)}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${fmt(last.x)} ${fmt(last.y)}`;
}

// Replaces any binding to a removed element with a fixed point at its current position.
export function detachFrom(removedIds, elements, byId) {
  return elements.map((el) => {
    if (el.type !== 'connector') return el;
    const hitsStart = el.start.id && removedIds.has(el.start.id);
    const hitsEnd = el.end.id && removedIds.has(el.end.id);
    if (!hitsStart && !hitsEnd) return el;
    const { start, end } = resolveEnds(el, byId);
    return {
      ...el,
      start: hitsStart ? { x: start.x, y: start.y } : el.start,
      end: hitsEnd ? { x: end.x, y: end.y } : el.end,
    };
  });
}
