// Pure geometry helpers. Rects are {x, y, w, h}; points are {x, y}.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function union(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const inflate = (r, d) => ({ x: r.x - d, y: r.y - d, w: r.w + d * 2, h: r.h + d * 2 });
export const contains = (outer, inner) =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
export const intersects = (a, b) =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
export const pointInRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
export const rectFromPoints = (a, b) => ({
  x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
});

export function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  return best;
}

export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polylineLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return total;
}

// Point at fraction t (0..1) of a polyline's length.
export function pointAlong(pts, t) {
  const target = polylineLength(pts) * clamp(t, 0, 1);
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (walked + seg >= target && seg > 0) {
      const f = (target - walked) / seg;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    walked += seg;
  }
  return { ...pts[pts.length - 1] };
}

// Fraction along the polyline closest to p.
export function projectOntoPolyline(p, pts) {
  const total = polylineLength(pts) || 1;
  let walked = 0, best = Infinity, bestT = 0.5;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const seg = Math.hypot(dx, dy);
    const f = seg ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (seg * seg), 0, 1) : 0;
    const d = Math.hypot(p.x - (a.x + f * dx), p.y - (a.y + f * dy));
    if (d < best) { best = d; bestT = (walked + f * seg) / total; }
    walked += seg;
  }
  return bestT;
}

// Snap a moving box to the edges/centres of static boxes. Returns the offset to
// apply plus the guide lines to draw.
export function snapBox(box, others, threshold) {
  const xs = [box.x, box.x + box.w / 2, box.x + box.w];
  const ys = [box.y, box.y + box.h / 2, box.y + box.h];
  let bestX = null, bestY = null;
  for (const o of others) {
    for (const ox of [o.x, o.x + o.w / 2, o.x + o.w]) {
      for (const x of xs) {
        const d = ox - x;
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: ox };
      }
    }
    for (const oy of [o.y, o.y + o.h / 2, o.y + o.h]) {
      for (const y of ys) {
        const d = oy - y;
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: oy };
      }
    }
  }
  const guides = [];
  if (bestX) guides.push({ axis: 'x', at: bestX.at });
  if (bestY) guides.push({ axis: 'y', at: bestY.at });
  return { dx: bestX ? bestX.d : 0, dy: bestY ? bestY.d : 0, guides };
}
