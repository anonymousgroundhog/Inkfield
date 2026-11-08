import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createElement, expandToGroups, groupElements, normalizeElements, parseImport, ungroupElements,
} from '../src/model.js';
import { elbowPoints, detachFrom, routeConnector } from '../src/connectors.js';
import { pointAlong, projectOntoPolyline, snapBox } from '../src/geometry.js';
import { approxMeasure, cellAt, hitTest, wrapText } from '../src/render.js';
import { buildSvg, exportScope, fitScale, MAX_CANVAS_SIDE, safeFilename } from '../src/export.js';
import { resizedBox, translate } from '../src/editor-transforms.js';

const measure = approxMeasure;
const map = (...els) => new Map(els.map((e) => [e.id, e]));

test('wrapText wraps, keeps explicit breaks, and parses bold runs', () => {
  const lines = wrapText('**Tip one:** keep things short\nnext', 100, 16, 400, measure);
  assert.ok(lines.length >= 3);
  assert.equal(lines[0].runs[0].bold, true);
  assert.equal(lines[0].runs[0].t, 'Tip one:');
  assert.equal(lines.at(-1).runs[0].t, 'next');
  for (const line of lines) assert.ok(line.width <= 100.01);
});

test('wrapText breaks a word wider than the box', () => {
  const lines = wrapText('x'.repeat(100), 80, 16, 400, measure);
  assert.ok(lines.length > 1);
  assert.equal(lines.map((l) => l.runs[0].t).join(''), 'x'.repeat(100));
});

test('elbow routes contain only axis-aligned segments for every side pairing', () => {
  const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  for (const ds of dirs) for (const de of dirs) for (const e of [{ x: 300, y: 200 }, { x: -300, y: 200 }, { x: 40, y: -300 }]) {
    const pts = elbowPoints({ x: 0, y: 0 }, ds, e, de);
    for (let i = 1; i < pts.length; i++) {
      assert.ok(Math.abs(pts[i].x - pts[i - 1].x) < 0.01 || Math.abs(pts[i].y - pts[i - 1].y) < 0.01, JSON.stringify(pts));
    }
    assert.deepEqual(pts[0], { x: 0, y: 0 });
    assert.deepEqual(pts.at(-1), e);
  }
});

test('connector follows the shape it is bound to', () => {
  const a = createElement('rect', { id: 'a', x: 0, y: 0, w: 100, h: 100 });
  const b = createElement('rect', { id: 'b', x: 400, y: 0, w: 100, h: 100 });
  const c = createElement('connector', { start: { id: 'a', x: 0, y: 0 }, end: { id: 'b', x: 0, y: 0 } });
  assert.deepEqual({ x: routeConnector(c, map(a, b)).pts[0].x }, { x: 100 });
  const moved = { ...a, x: 50 };
  assert.equal(routeConnector(c, map(moved, b)).pts[0].x, 150);
});

test('deleting a shape freezes the connector end at its last position', () => {
  const a = createElement('rect', { id: 'a', x: 0, y: 0, w: 100, h: 100 });
  const b = createElement('rect', { id: 'b', x: 400, y: 0, w: 100, h: 100 });
  const c = createElement('connector', { start: { id: 'a', x: 0, y: 0 }, end: { id: 'b', x: 0, y: 0 } });
  const [, , out] = detachFrom(new Set(['a']), [a, b, c], map(a, b, c));
  assert.equal(out.start.id, undefined);
  assert.equal(out.start.x, 100);
  assert.equal(out.end.id, 'b');
});

test('groups select together, nest, and ungroup one level at a time', () => {
  const a = createElement('rect', { id: 'a' }), b = createElement('rect', { id: 'b' }), c = createElement('rect', { id: 'c' });
  let els = groupElements(new Set(['a', 'b']), [a, b, c]);
  assert.deepEqual([...expandToGroups(['a'], els)].sort(), ['a', 'b']);
  els = groupElements(new Set(['a', 'b', 'c']), els);
  assert.deepEqual([...expandToGroups(['c'], els)].sort(), ['a', 'b', 'c']);
  els = ungroupElements(new Set(['c']), els);
  assert.deepEqual([...expandToGroups(['c'], els)], ['c']);
  assert.deepEqual([...expandToGroups(['a'], els)].sort(), ['a', 'b']);
});

test('export scope pulls in connectors only when both ends are selected', () => {
  const a = createElement('rect', { id: 'a' }), b = createElement('rect', { id: 'b', x: 300 }), z = createElement('rect', { id: 'z', x: 900 });
  const ab = createElement('connector', { id: 'ab', start: { id: 'a', x: 0, y: 0 }, end: { id: 'b', x: 0, y: 0 } });
  const bz = createElement('connector', { id: 'bz', start: { id: 'b', x: 0, y: 0 }, end: { id: 'z', x: 0, y: 0 } });
  const all = [a, b, z, ab, bz];
  assert.deepEqual(exportScope(all, ['a', 'b']).map((e) => e.id), ['a', 'b', 'ab']);
  assert.deepEqual(exportScope(all, ['a', 'b'], false).map((e) => e.id), ['a', 'b']);
  assert.equal(exportScope(all, null).length, 5);
});

test('buildSvg crops to the selection, not the whole board', () => {
  const a = createElement('rect', { id: 'a', x: 1000, y: 2000, w: 100, h: 50 });
  const far = createElement('rect', { id: 'far', x: -9000, y: -9000, w: 100, h: 50, text: 'far away' });
  const { svg, width, height } = buildSvg([a, far], ['a'], { padding: 10, measure });
  assert.ok(width < 140 && height < 90, `${width}x${height}`);
  assert.ok(!svg.includes('far away'));
});

test('buildSvg includes icon captions in the crop and paints transparent by default', () => {
  const icon = createElement('icon', { id: 'i', x: 0, y: 0, w: 96, h: 96, text: 'A rather long caption' });
  const { svg, height } = buildSvg([icon], null, { padding: 0, measure });
  assert.ok(height > 96 + 16);
  assert.ok(!svg.includes('<rect'));
});

test('buildSvg escapes hostile text and colours', () => {
  const [el] = normalizeElements([{ type: 'rect', text: '</text><script>x()</script>', fill: '"/><script>y()</script>' }]);
  const { svg } = buildSvg([el], null, { measure });
  assert.ok(!svg.includes('<script'));
});

test('import drops invalid items, remote images and dangling connectors', () => {
  const out = normalizeElements([
    { type: 'bogus' }, null,
    { type: 'image', src: 'https://evil.example/x.png' },
    { type: 'image', src: 'data:image/png;base64,AAAA' },
    { type: 'connector', from: 'missing', to: 'alsoMissing' },
    { type: 'rect', id: 'dup', x: 'NaN', w: -5 },
    { type: 'rect', id: 'dup' },
    { type: 'icon', icon: 'constructor' },
  ]);
  assert.deepEqual(out.map((e) => e.type), ['image', 'rect', 'rect', 'icon']);
  assert.notEqual(out[1].id, out[2].id);
  assert.equal(out[1].x, 0);
  assert.equal(out[1].w, 1);
  assert.doesNotThrow(() => buildSvg(out, null, { measure }));
});

test('import shorthand binds connectors by id, including unsafe ids', () => {
  const out = normalizeElements([
    { type: 'rect', id: 'has space' },
    { type: 'rect', id: 'b', x: 300 },
    { type: 'connector', from: 'has space', to: { id: 'b', side: 'left' } },
  ]);
  const conn = out[2];
  assert.equal(conn.start.id, out[0].id);
  assert.match(conn.start.id, /^[\w-]+$/);
  assert.equal(conn.end.side, 'left');
});

test('parseImport accepts a board, a backup, and rejects junk', () => {
  assert.equal(parseImport('{"name":"x","elements":[]}').length, 1);
  assert.equal(parseImport('{"boards":[{"elements":[]},{"elements":[]}]}').length, 2);
  assert.throws(() => parseImport('{"nope":1}'), /elements/);
  assert.throws(() => parseImport('not json'));
});

test('hit testing: unfilled boxes are grabbed by the edge, filled ones anywhere', () => {
  const box = createElement('rect', { x: 0, y: 0, w: 100, h: 100, fill: 'none' });
  const solid = { ...box, fill: '#fff' };
  const empty = new Map();
  assert.equal(hitTest(box, { x: 50, y: 50 }, empty, 4, measure), false);
  assert.equal(hitTest(box, { x: 1, y: 50 }, empty, 4, measure), true);
  assert.equal(hitTest(solid, { x: 50, y: 50 }, empty, 4, measure), true);
  assert.equal(hitTest(solid, { x: 200, y: 50 }, empty, 4, measure), false);
});

test('table title row spans all columns', () => {
  const t = createElement('table', { x: 0, y: 0, w: 300, h: 150 });
  assert.deepEqual(cellAt(t, { x: 250, y: 5 }), { r: 0, c: 0 });
  assert.equal(cellAt(t, { x: 250, y: 100 }).c, 2);
});

test('snapBox aligns to the closest edge within the threshold', () => {
  const s = snapBox({ x: 103, y: 500, w: 50, h: 50 }, [{ x: 100, y: 0, w: 200, h: 10 }], 6);
  assert.equal(s.dx, -3);
  assert.equal(s.dy, 0);
  assert.deepEqual(s.guides, [{ axis: 'x', at: 100 }]);
});

test('polyline helpers round trip', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  assert.deepEqual(pointAlong(pts, 0.5), { x: 100, y: 0 });
  assert.ok(Math.abs(projectOntoPolyline({ x: 100, y: 50 }, pts) - 0.75) < 1e-9);
});

test('resize keeps the opposite corner fixed and enforces a minimum size', () => {
  const box = { x: 10, y: 10, w: 100, h: 100 };
  assert.deepEqual(resizedBox(box, 'nw', 20, 30), { x: 30, y: 40, w: 80, h: 70 });
  const small = resizedBox(box, 'se', -500, -500);
  assert.equal(small.w, 8);
  assert.equal(small.x, 10);
});

test('translate leaves bound connector ends alone', () => {
  const c = createElement('connector', { start: { id: 'a', x: 1, y: 1 }, end: { x: 5, y: 5 } });
  const out = translate(c, 10, 10);
  assert.equal(out.start.x, 1);
  assert.equal(out.end.x, 15);
});

test('export scale is clamped to browser canvas limits', () => {
  assert.equal(fitScale(100, 100, 4), 4);
  assert.ok(fitScale(10000, 100, 4) * 10000 <= MAX_CANVAS_SIDE);
});

test('safeFilename strips path and shell characters', () => {
  assert.equal(safeFilename('../../etc/my board!'), 'etcmy-board');
  assert.equal(safeFilename('///'), 'inkfield');
});
