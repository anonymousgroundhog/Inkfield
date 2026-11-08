// The canvas editor: view transform, selection, gestures, history and clipboard.
import {
  createElement, expandToGroups, groupElements, hasText, normalizeElements, ungroupElements, uid,
} from './model.js';
import { anchorPoint, detachFrom, nearestSide, resolveEnds, routeConnector, SIDES } from './connectors.js';
import {
  clamp, contains, inflate, intersects, pointInRect, projectOntoPolyline, rectFromPoints, snapBox, union,
} from './geometry.js';
import {
  cellAt, cellRect, defaultMeasure, elementBounds, hitTest, labelLayout, linkCardHeight, LINK_WIDTH, loadingCardHeight, renderElement, textBox, textHeight, visualBounds, wrapText,
} from './render.js';

import { displayHost, youTubeId } from './links.js';
import { fitTextHeight, MIN_SIZE, resizedBox, scaleElement, translate } from './editor-transforms.js';

const canConnect = (el) => el.type !== 'connector' && el.type !== 'pen';
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const CLIP_MARK = 'inkfield-clipboard';

export class Editor {
  constructor(stage) {
    this.stage = stage;
    this.world = stage.querySelector('#world');
    this.overlay = stage.querySelector('#overlay');
    this.board = null;
    this.byId = new Map();
    this.selection = new Set();
    this.tool = 'select';
    this.shapeType = 'rect';
    this.histories = new Map();
    this.gesture = null;
    this.editing = null;
    this.hover = null;
    this.guides = [];
    this.marquee = null;
    this.spaceDown = false;
    this.listeners = {};
    this.nodes = new Map();
    this.markup = new Map();
    this.lastPatch = { key: '', at: 0 };
    this.framePending = false;
    this.deferredPatches = [];
    this.bind();
  }

  on(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, arg) { (this.listeners[name] || []).forEach((fn) => fn(arg)); }

  // ---- Board lifecycle ----

  setBoard(board) {
    this.commitEdit();
    this.board = board;
    this.selection = new Set();
    this.world.replaceChildren();
    this.nodes.clear();
    this.markup.clear();
    this.reindex();
    this.requestRender();
    this.emit('selection');
    this.emit('history');
    this.emit('view');
    this.emit('boardchange');
  }

  // A newer copy of the active board arrived from another window.
  applyRemote(board) {
    const history = this.history();
    if (history.undo[history.undo.length - 1] !== this.board.elements) history.undo.push(this.board.elements);
    history.redo = [];
    const view = this.board.view;
    Object.assign(this.board, board, { view });
    this.reindex();
    const alive = new Set(this.board.elements.map((el) => el.id));
    this.selection = new Set([...this.selection].filter((id) => alive.has(id)));
    this.requestRender();
    this.emit('selection');
    this.emit('history');
  }

  get elements() { return this.board.elements; }
  get busy() { return !!this.gesture || !!this.editing; }

  reindex() { this.byId = new Map(this.board.elements.map((el) => [el.id, el])); }

  history() {
    let h = this.histories.get(this.board.id);
    if (!h) { h = { undo: [], redo: [] }; this.histories.set(this.board.id, h); }
    return h;
  }

  replace(elements) {
    this.board.elements = elements;
    this.reindex();
    this.requestRender();
  }

  // Applies a change as one undo step.
  commit(elements, { coalesceKey } = {}) {
    if (elements === this.elements) return;
    const h = this.history();
    const now = Date.now();
    const merge = coalesceKey && this.lastPatch.key === coalesceKey && now - this.lastPatch.at < 700;
    if (!merge) {
      h.undo.push(this.elements);
      if (h.undo.length > 200) h.undo.shift();
    }
    this.lastPatch = { key: coalesceKey || '', at: now };
    h.redo = [];
    this.replace(elements);
    this.dirty();
  }

  // Records the state a finished gesture started from.
  commitGesture(base) {
    if (base === this.elements) return;
    const h = this.history();
    h.undo.push(base);
    if (h.undo.length > 200) h.undo.shift();
    h.redo = [];
    this.lastPatch = { key: '', at: 0 };
    this.dirty();
  }

  dirty() {
    this.board.rev = (this.board.rev || 0) + 1;
    this.board.updatedAt = Date.now();
    this.emit('change');
    this.emit('history');
    this.emit('selection');
  }

  undo() {
    this.commitEdit();
    const h = this.history();
    if (!h.undo.length) return;
    h.redo.push(this.elements);
    this.replace(h.undo.pop());
    this.pruneSelection();
    this.dirty();
  }

  redo() {
    this.commitEdit();
    const h = this.history();
    if (!h.redo.length) return;
    h.undo.push(this.elements);
    this.replace(h.redo.pop());
    this.pruneSelection();
    this.dirty();
  }

  pruneSelection() {
    this.selection = new Set([...this.selection].filter((id) => this.byId.has(id)));
  }

  // ---- Selection ----

  select(ids, { expand = true } = {}) {
    this.selection = expand ? expandToGroups(ids, this.elements) : new Set(ids);
    this.requestRender();
    this.emit('selection');
  }

  selectedElements() { return this.elements.filter((el) => this.selection.has(el.id)); }

  selectionBounds() {
    return union(this.selectedElements().map((el) => elementBounds(el, this.byId)));
  }

  setTool(tool, shapeType) {
    this.commitEdit();
    this.tool = tool;
    if (shapeType) this.shapeType = shapeType;
    if (tool !== 'select') this.select([]);
    this.hover = null;
    this.updateCursor();
    this.requestRender();
    this.emit('tool');
  }

  updateCursor() {
    const t = this.tool;
    this.stage.style.cursor = this.spaceDown || t === 'hand' ? 'grab' : t === 'select' ? 'default' : t === 'text' ? 'text' : 'crosshair';
  }

  // ---- Commands ----

  patchSelected(patch, opts) {
    const ids = this.selection;
    if (!ids.size) return;
    this.commit(this.elements.map((el) => {
      if (!ids.has(el.id)) return el;
      const next = { ...el };
      for (const [k, v] of Object.entries(patch)) if (k in el) next[k] = v;
      return next;
    }), opts);
  }

  updateElement(id, patch, opts) {
    this.commit(this.elements.map((el) => (el.id === id ? { ...el, ...patch } : el)), opts);
  }

  deleteSelected() {
    if (!this.selection.size) return;
    const removed = this.selection;
    const kept = detachFrom(removed, this.elements, this.byId).filter((el) => !removed.has(el.id));
    this.selection = new Set();
    this.commit(kept);
  }

  group() {
    if (this.selection.size < 2) return;
    this.commit(groupElements(this.selection, this.elements));
  }

  ungroup() {
    this.commit(ungroupElements(this.selection, this.elements));
  }

  reorder(where) {
    if (!this.selection.size) return;
    const sel = this.elements.filter((el) => this.selection.has(el.id));
    const rest = this.elements.filter((el) => !this.selection.has(el.id));
    this.commit(where === 'front' ? [...rest, ...sel] : [...sel, ...rest]);
  }

  align(mode) {
    const sel = this.selectedElements().filter((el) => el.type !== 'connector');
    if (sel.length < 2) return;
    const box = union(sel.map((el) => elementBounds(el, this.byId)));
    const moved = new Map(sel.map((el) => {
      switch (mode) {
        case 'left': return [el.id, { x: box.x }];
        case 'hcenter': return [el.id, { x: box.x + (box.w - el.w) / 2 }];
        case 'right': return [el.id, { x: box.x + box.w - el.w }];
        case 'top': return [el.id, { y: box.y }];
        case 'vcenter': return [el.id, { y: box.y + (box.h - el.h) / 2 }];
        default: return [el.id, { y: box.y + box.h - el.h }];
      }
    }));
    this.commit(this.elements.map((el) => (moved.has(el.id) ? { ...el, ...moved.get(el.id) } : el)));
  }

  distribute(axis) {
    const sel = this.selectedElements().filter((el) => el.type !== 'connector');
    if (sel.length < 3) return;
    const pos = axis === 'h' ? 'x' : 'y', len = axis === 'h' ? 'w' : 'h';
    const sorted = [...sel].sort((a, b) => a[pos] - b[pos]);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const used = sorted.reduce((sum, el) => sum + el[len], 0);
    const gap = (last[pos] + last[len] - first[pos] - used) / (sorted.length - 1);
    const moved = new Map();
    let at = first[pos];
    for (const el of sorted) { moved.set(el.id, at); at += el[len] + gap; }
    this.commit(this.elements.map((el) => (moved.has(el.id) ? { ...el, [pos]: moved.get(el.id) } : el)));
  }

  addElements(list, { select = true } = {}) {
    this.commit([...this.elements, ...list]);
    if (select) this.select(list.map((el) => el.id), { expand: false });
  }

  placeAtCenter(type, props) {
    const c = this.viewCenter();
    const size = createElement(type, props);
    this.addElements([{ ...size, x: c.x - size.w / 2, y: c.y - size.h / 2 }]);
    this.setTool('select');
    this.select([size.id], { expand: false });
  }

  // Places generated elements at the view centre as one undo step, zooming out if needed.
  insertDiagram(list) {
    const merged = new Map([...this.byId, ...list.map((el) => [el.id, el])]);
    const box = union(list.map((el) => visualBounds(el, merged)));
    const c = this.viewCenter();
    const dx = c.x - box.x - box.w / 2, dy = c.y - box.y - box.h / 2;
    const moved = list.map((el) => translate(el, dx, dy));
    this.setTool('select');
    this.addElements(moved);
    const placed = { ...box, x: box.x + dx, y: box.y + dy };
    if (!contains(this.viewRect(), placed)) this.zoomToFit(placed);
  }

  // Adds cards in a loading state. The app sees them on 'change' and fetches previews.
  addLinks(urls, at) {
    const c = at || this.viewCenter();
    const cards = urls.map((url, i) => {
      const video = !!youTubeId(url);
      const h = loadingCardHeight(url, video);
      const col = i % 3, row = Math.floor(i / 3);
      return createElement('link', {
        url, kind: video ? 'video' : 'page', title: displayHost(url), h,
        // Cards grow when their thumbnail arrives, so rows leave room for the tallest one.
        x: c.x - LINK_WIDTH / 2 + col * (LINK_WIDTH + 24),
        y: urls.length === 1 ? c.y - h / 2 : c.y + row * (linkCardHeight(LINK_WIDTH, 1, true) + 24),
      });
    });
    this.setTool('select');
    this.addElements(cards);
    return cards;
  }

  // Applies a finished background load. It isn't an undo step, and it also updates undo
  // snapshots, so undoing later can't bring back a card stuck on "Loading preview…".
  patchUntracked(board, id, patch) {
    if (board === this.board && this.gesture) {
      // A running drag rebuilds from its starting snapshot and would lose this change.
      this.deferredPatches.push([board, id, patch]);
      return;
    }
    const apply = (list) => (list.some((el) => el.id === id) ? list.map((el) => (el.id === id ? { ...el, ...patch } : el)) : list);
    const h = this.histories.get(board.id);
    if (h) {
      h.undo = h.undo.map(apply);
      h.redo = h.redo.map(apply);
    }
    if (board !== this.board) {
      board.elements = apply(board.elements);
      board.rev = (board.rev || 0) + 1;
      return;
    }
    this.replace(apply(this.elements));
    this.board.rev = (this.board.rev || 0) + 1;
    this.board.updatedAt = Date.now();
    this.emit('change');
    this.emit('selection');
  }

  addImage(src, naturalW, naturalH, at) {
    const scale = Math.min(1, 640 / naturalW, 480 / naturalH);
    const w = Math.max(8, naturalW * scale), h = Math.max(8, naturalH * scale);
    const c = at || this.viewCenter();
    const el = createElement('image', { src, w, h, x: c.x - w / 2, y: c.y - h / 2 });
    this.addElements([el]);
  }

  nudge(dx, dy) {
    const ids = this.selection;
    this.commit(this.elements.map((el) => (ids.has(el.id) ? translate(el, dx, dy) : el)), { coalesceKey: 'nudge' });
  }

  tableEdit(fn) {
    const el = this.selectedElements()[0];
    if (el?.type !== 'table') return;
    this.updateElement(el.id, { cells: fn(el.cells.map((r) => [...r])) });
  }

  // ---- Clipboard ----

  serializeSelection() {
    const scoped = this.selectedElements().map((el) => {
      if (el.type !== 'connector') return el;
      // Connectors stay attached to copied shapes; other ends freeze where they are.
      const { start, end } = resolveEnds(el, this.byId);
      const pin = (raw, resolved) => (raw.id && this.selection.has(raw.id) ? raw : { x: resolved.x, y: resolved.y });
      return { ...el, start: pin(el.start, start), end: pin(el.end, end) };
    });
    return JSON.stringify({ [CLIP_MARK]: 1, elements: scoped });
  }

  pasteSerialized(text) {
    let data;
    try { data = JSON.parse(text); } catch { return false; }
    if (!data?.[CLIP_MARK] || !Array.isArray(data.elements)) return false;
    this.insertCopies(data.elements);
    return true;
  }

  insertCopies(raw) {
    const idMap = new Map(raw.map((el) => [el.id, uid()]));
    const groupMap = new Map();
    const remapGroup = (g) => { if (!groupMap.has(g)) groupMap.set(g, `g${uid()}`); return groupMap.get(g); };
    const copies = normalizeElements(raw.map((el) => {
      const copy = { ...el, id: idMap.get(el.id), groups: (el.groups || []).map(remapGroup) };
      if (el.type === 'connector') {
        const remap = (end) => (end.id ? { ...end, id: idMap.get(end.id) } : end);
        return { ...copy, start: remap(el.start), end: remap(el.end) };
      }
      return copy;
    }));
    if (!copies.length) return;
    const merged = new Map([...this.byId, ...copies.map((el) => [el.id, el])]);
    const box = union(copies.map((el) => elementBounds(el, merged)));
    const view = this.viewRect();
    const c = this.viewCenter();
    const offset = intersects(box, view) ? { x: 24, y: 24 } : { x: c.x - box.x - box.w / 2, y: c.y - box.y - box.h / 2 };
    const moved = copies.map((el) => translate(el, offset.x, offset.y));
    this.addElements(moved);
    this.select(moved.map((el) => el.id), { expand: false });
  }

  duplicate() {
    if (!this.selection.size) return;
    this.insertCopies(JSON.parse(this.serializeSelection()).elements);
  }

  // ---- View ----

  stageRect() { return this.stage.getBoundingClientRect(); }

  toWorld(clientX, clientY) {
    const r = this.stageRect(), v = this.board.view;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  }

  toScreen(p) {
    const v = this.board.view;
    return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
  }

  viewRect() {
    const r = this.stageRect(), v = this.board.view;
    return { x: -v.x / v.zoom, y: -v.y / v.zoom, w: r.width / v.zoom, h: r.height / v.zoom };
  }

  viewCenter() {
    const b = this.viewRect();
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  zoomAt(factor, cx, cy) {
    const v = this.board.view;
    const zoom = clamp(v.zoom * factor, 0.05, 8);
    const f = zoom / v.zoom;
    v.x = cx - (cx - v.x) * f;
    v.y = cy - (cy - v.y) * f;
    v.zoom = zoom;
    this.viewChanged();
  }

  zoomBy(factor) {
    const r = this.stageRect();
    this.zoomAt(factor, r.width / 2, r.height / 2);
  }

  setZoom(zoom) {
    this.zoomBy(zoom / this.board.view.zoom);
  }

  zoomToFit(rect) {
    const target = rect || union(this.elements.map((el) => visualBounds(el, this.byId)));
    const r = this.stageRect();
    if (!target) {
      Object.assign(this.board.view, { x: r.width / 2, y: r.height / 2, zoom: 1 });
    } else {
      const zoom = clamp(Math.min((r.width - 120) / (target.w || 1), (r.height - 120) / (target.h || 1)), 0.05, 2);
      Object.assign(this.board.view, {
        zoom,
        x: r.width / 2 - (target.x + target.w / 2) * zoom,
        y: r.height / 2 - (target.y + target.h / 2) * zoom,
      });
    }
    this.viewChanged();
  }

  viewChanged() {
    this.requestRender();
    this.positionEditor();
    this.emit('view');
    this.emit('viewsave');
  }

  // ---- Rendering ----

  requestRender() {
    if (this.framePending) return;
    this.framePending = true;
    requestAnimationFrame(() => { this.framePending = false; this.render(); });
  }

  render() {
    if (!this.board) return;
    const { x, y, zoom } = this.board.view;
    this.world.setAttribute('transform', `translate(${x} ${y}) scale(${zoom})`);
    let step = 24 * zoom;
    while (step < 14) step *= 2;
    while (step > 60) step /= 2;
    this.stage.style.backgroundSize = `${step}px ${step}px`;
    this.stage.style.backgroundPosition = `${x}px ${y}px`;
    this.renderElements();
    this.renderOverlay();
    this.stage.classList.toggle('is-empty', !this.elements.length && !this.gesture);
  }

  renderElements() {
    const hideText = this.editing ? { id: this.editing.id, r: this.editing.r, c: this.editing.c } : null;
    const alive = new Set();
    let prev = null;
    for (const el of this.elements) {
      alive.add(el.id);
      const html = renderElement(el, { byId: this.byId, hideText: hideText?.id === el.id ? hideText : null });
      let node = this.nodes.get(el.id);
      if (!node) {
        node = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.nodes.set(el.id, node);
      }
      if (this.markup.get(el.id) !== html) {
        node.innerHTML = html;
        this.markup.set(el.id, html);
      }
      const expected = prev ? prev.nextSibling : this.world.firstChild;
      if (expected !== node) this.world.insertBefore(node, expected);
      prev = node;
    }
    for (const [id, node] of this.nodes) {
      if (!alive.has(id)) { node.remove(); this.nodes.delete(id); this.markup.delete(id); }
    }
  }

  renderOverlay() {
    const parts = [];
    const sc = (p) => this.toScreen(p);
    const rectOf = (b) => { const a = sc(b); const z = this.board.view.zoom; return { x: a.x, y: a.y, w: b.w * z, h: b.h * z }; };
    const sel = this.selectedElements();

    for (const el of sel) {
      if (el.type === 'connector') continue;
      const b = rectOf(elementBounds(el, this.byId));
      parts.push(`<rect class="ov-outline" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`);
    }

    const connectorOnly = sel.length === 1 && sel[0].type === 'connector';
    if (connectorOnly) {
      const el = sel[0];
      const route = routeConnector(el, this.byId);
      const pts = route.pts.map(sc);
      parts.push(`<polyline class="ov-route" points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}"/>`);
      const a = pts[0], z = pts[pts.length - 1];
      parts.push(`<circle class="ov-end${el.start.id ? ' bound' : ''}" data-h="start" cx="${a.x}" cy="${a.y}" r="6"/>`);
      parts.push(`<circle class="ov-end${el.end.id ? ' bound' : ''}" data-h="end" cx="${z.x}" cy="${z.y}" r="6"/>`);
    } else if (sel.length) {
      const b = rectOf(this.selectionBounds());
      if (sel.length > 1) parts.push(`<rect class="ov-group" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`);
      if (!this.gesture || this.gesture.kind === 'resize') {
        const pos = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
        for (const h of HANDLES) {
          const hx = b.x + b.w * pos[h][0], hy = b.y + b.h * pos[h][1];
          parts.push(`<rect class="ov-handle" data-h="${h}" x="${hx - 5}" y="${hy - 5}" width="10" height="10" rx="2" style="cursor:${CURSORS[h]}"/>`);
        }
      }
      if (!this.gesture && sel.length === 1 && canConnect(sel[0])) {
        for (const side of SIDES) {
          const p = sc(anchorPoint(sel[0], side));
          const off = { top: [0, -20], bottom: [0, 20], left: [-20, 0], right: [20, 0] }[side];
          parts.push(`<circle class="ov-anchor" data-h="anchor:${side}" cx="${p.x + off[0]}" cy="${p.y + off[1]}" r="5"><title>Drag to connect</title></circle>`);
        }
      }
    }

    if (this.hover && this.byId.has(this.hover)) {
      const el = this.byId.get(this.hover);
      const b = rectOf(elementBounds(el, this.byId));
      parts.push(`<rect class="ov-hover" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`);
      for (const side of SIDES) {
        const p = sc(anchorPoint(el, side));
        parts.push(`<circle class="ov-target" cx="${p.x}" cy="${p.y}" r="4.5"/>`);
      }
    }

    if (this.marquee) {
      const b = rectOf(this.marquee);
      parts.push(`<rect class="ov-marquee" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`);
    }

    const r = this.stageRect();
    for (const g of this.guides) {
      if (g.axis === 'x') { const x = sc({ x: g.at, y: 0 }).x; parts.push(`<line class="ov-guide" x1="${x}" x2="${x}" y1="0" y2="${r.height}"/>`); }
      else { const y = sc({ x: 0, y: g.at }).y; parts.push(`<line class="ov-guide" y1="${y}" y2="${y}" x1="0" x2="${r.width}"/>`); }
    }
    this.overlay.innerHTML = parts.join('');
  }

  // ---- Input ----

  bind() {
    const s = this.stage;
    s.addEventListener('pointerdown', (e) => this.onDown(e));
    // Focus is managed in onDown. The browser's default would otherwise pull focus
    // off an inline editor opened during the same press and close it instantly.
    s.addEventListener('mousedown', (e) => { if (!e.target.closest('textarea')) e.preventDefault(); });
    s.addEventListener('pointermove', (e) => this.onMove(e));
    s.addEventListener('pointerup', (e) => this.onUp(e));
    s.addEventListener('pointercancel', (e) => this.onUp(e));
    s.addEventListener('dblclick', (e) => this.onDouble(e));
    s.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.requestRender()).observe(s);
  }

  hitAt(p, filter) {
    const tol = 5 / this.board.view.zoom;
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const el = this.elements[i];
      if (filter && !filter(el)) continue;
      if (hitTest(el, p, this.byId, tol)) return el;
    }
    return null;
  }

  connectTarget(p, exclude) {
    const pad = 14 / this.board.view.zoom;
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const el = this.elements[i];
      if (el.id === exclude || !canConnect(el)) continue;
      if (pointInRect(p, inflate(elementBounds(el, this.byId), pad))) return el;
    }
    return null;
  }

  onWheel(e) {
    e.preventDefault();
    const r = this.stageRect();
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0035)), e.clientX - r.left, e.clientY - r.top);
    } else {
      const unit = e.deltaMode ? 24 : 1;
      this.board.view.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
      this.board.view.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
      this.viewChanged();
    }
  }

  onDown(e) {
    if (e.target.closest('textarea')) return;
    if (this.editing) this.commitEdit();
    this.stage.focus({ preventScroll: true });
    this.emit('canvasdown');
    const p = this.toWorld(e.clientX, e.clientY);
    const start = { client: { x: e.clientX, y: e.clientY }, p, base: this.elements };
    this.stage.setPointerCapture(e.pointerId);

    if (e.button === 1 || e.button === 2 || this.tool === 'hand' || this.spaceDown) return this.beginPan(start);
    if (e.button !== 0) return;

    const handle = e.target.closest?.('[data-h]')?.dataset.h;
    if (handle) {
      if (handle === 'start' || handle === 'end') return this.beginEndpoint(start, handle);
      if (handle.startsWith('anchor:')) return this.beginConnector(start, this.selectedElements()[0], handle.slice(7));
      return this.beginResize(start, handle);
    }
    switch (this.tool) {
      case 'shape': case 'table': return this.beginDraw(start);
      case 'text': return this.placeText(p);
      case 'sticky': return this.placeSticky(p);
      case 'pen': return this.beginPen(start);
      case 'connector': {
        const target = this.connectTarget(p);
        return this.beginConnector(start, target, target ? nearestSide(target, p) : null);
      }
      default: return this.selectDown(start, e);
    }
  }

  selectDown(start, e) {
    const single = this.selectedElements();
    if (single.length === 1 && single[0].type === 'connector' && single[0].label) {
      const route = routeConnector(single[0], this.byId);
      const label = labelLayout(single[0], route);
      if (label && pointInRect(start.p, inflate(label, 4))) return this.beginLabelDrag(start, single[0], route);
    }
    const hit = this.hitAt(start.p);
    if (!hit) {
      if (!e.shiftKey) this.select([]);
      return this.beginMarquee(start, e.shiftKey ? new Set(this.selection) : new Set());
    }
    if (e.shiftKey) {
      const members = expandToGroups([hit.id], this.elements);
      const next = new Set(this.selection);
      const removing = next.has(hit.id);
      members.forEach((id) => (removing ? next.delete(id) : next.add(id)));
      this.select(next, { expand: false });
      return undefined;
    }
    if (!this.selection.has(hit.id)) this.select([hit.id]);
    return this.beginMove(start);
  }

  beginPan(start) {
    const v0 = { ...this.board.view };
    this.stage.style.cursor = 'grabbing';
    this.gesture = {
      kind: 'pan',
      move: (e) => {
        this.board.view.x = v0.x + e.clientX - start.client.x;
        this.board.view.y = v0.y + e.clientY - start.client.y;
        this.viewChanged();
      },
      up: () => this.updateCursor(),
    };
  }

  beginMarquee(start, baseSelection) {
    this.gesture = {
      kind: 'marquee',
      move: (e) => {
        const p = this.toWorld(e.clientX, e.clientY);
        this.marquee = rectFromPoints(start.p, p);
        const inside = this.elements.filter((el) => contains(this.marquee, elementBounds(el, this.byId))).map((el) => el.id);
        this.selection = new Set([...baseSelection, ...expandToGroups(inside, this.elements)]);
        this.requestRender();
      },
      up: () => { this.marquee = null; this.requestRender(); this.emit('selection'); },
    };
  }

  beginMove(start) {
    const baseEls = this.elements;
    const ids = new Set(this.selection);
    const movingBox = union(baseEls.filter((el) => ids.has(el.id)).map((el) => elementBounds(el, this.byId)));
    const view = this.viewRect();
    const others = baseEls
      .filter((el) => !ids.has(el.id) && el.type !== 'connector' && el.type !== 'pen')
      .map((el) => elementBounds(el, this.byId))
      .filter((b) => intersects(b, view));
    let moved = false;
    this.gesture = {
      kind: 'move',
      move: (ev) => {
        if (!moved && Math.hypot(ev.clientX - start.client.x, ev.clientY - start.client.y) < 3) return;
        moved = true;
        const p = this.toWorld(ev.clientX, ev.clientY);
        let dx = p.x - start.p.x, dy = p.y - start.p.y;
        this.guides = [];
        if (!ev.altKey && movingBox) {
          const snap = snapBox({ ...movingBox, x: movingBox.x + dx, y: movingBox.y + dy }, others, 6 / this.board.view.zoom);
          dx += snap.dx; dy += snap.dy;
          this.guides = snap.guides;
        }
        this.replace(baseEls.map((el) => (ids.has(el.id) ? translate(el, dx, dy) : el)));
      },
      up: () => {
        this.guides = [];
        this.requestRender();
        if (moved) this.commitGesture(baseEls);
      },
    };
  }

  beginResize(start, handle) {
    const baseEls = this.elements;
    const box0 = this.selectionBounds();
    const ids = new Set(this.selection);
    const baseById = new Map(baseEls.map((el) => [el.id, el]));
    this.gesture = {
      kind: 'resize',
      move: (e) => {
        const p = this.toWorld(e.clientX, e.clientY);
        const box = resizedBox(box0, handle, p.x - start.p.x, p.y - start.p.y, e.shiftKey);
        this.replace(baseEls.map((el) => (ids.has(el.id) ? scaleElement(el, box0, box, baseById) : el)));
      },
      up: () => {
        this.replace(this.elements.map((el) => (ids.has(el.id) && el.type === 'text' ? fitTextHeight(el) : el)));
        this.commitGesture(baseEls);
      },
    };
  }

  beginEndpoint(start, which) {
    const baseEls = this.elements;
    const id = this.selectedElements()[0].id;
    this.gesture = {
      kind: 'endpoint',
      move: (e) => {
        const p = this.toWorld(e.clientX, e.clientY);
        const target = this.connectTarget(p);
        this.hover = target?.id || null;
        const end = target ? { id: target.id, side: nearestSide(target, p), x: p.x, y: p.y } : { x: p.x, y: p.y };
        this.replace(this.elements.map((el) => (el.id === id ? { ...el, [which]: end } : el)));
      },
      up: () => { this.hover = null; this.requestRender(); this.commitGesture(baseEls); },
    };
  }

  beginConnector(start, fromEl, side) {
    const baseEls = this.elements;
    const from = fromEl ? { id: fromEl.id, side, x: start.p.x, y: start.p.y } : { x: start.p.x, y: start.p.y };
    const conn = createElement('connector', { start: from, end: { x: start.p.x, y: start.p.y } });
    this.selection = new Set();
    this.replace([...baseEls, conn]);
    let dragged = false;
    this.gesture = {
      kind: 'connector',
      move: (e) => {
        const p = this.toWorld(e.clientX, e.clientY);
        if (Math.hypot(p.x - start.p.x, p.y - start.p.y) > 4 / this.board.view.zoom) dragged = true;
        const target = this.connectTarget(p, fromEl?.id);
        this.hover = target?.id || null;
        const end = target ? { id: target.id, side: nearestSide(target, p), x: p.x, y: p.y } : { x: p.x, y: p.y };
        this.replace(this.elements.map((el) => (el.id === conn.id ? { ...el, end } : el)));
      },
      up: () => {
        this.hover = null;
        if (!dragged) { this.replace(baseEls); this.emit('selection'); return; }
        this.commitGesture(baseEls);
        this.setTool('select');
        this.select([conn.id], { expand: false });
      },
    };
  }

  beginLabelDrag(start, conn, route) {
    const baseEls = this.elements;
    let moved = false;
    this.gesture = {
      kind: 'label',
      move: (e) => {
        moved = true;
        const t = projectOntoPolyline(this.toWorld(e.clientX, e.clientY), route.pts);
        this.replace(this.elements.map((el) => (el.id === conn.id ? { ...el, labelPos: t } : el)));
      },
      up: () => { if (moved) this.commitGesture(baseEls); },
    };
  }

  beginDraw(start) {
    const baseEls = this.elements;
    const type = this.tool === 'table' ? 'table' : this.shapeType;
    const proto = createElement(type);
    let el = { ...proto, x: start.p.x - proto.w / 2, y: start.p.y - proto.h / 2 };
    let dragged = false;
    this.selection = new Set();
    this.gesture = {
      kind: 'draw',
      move: (e) => {
        const p = this.toWorld(e.clientX, e.clientY);
        if (Math.hypot(p.x - start.p.x, p.y - start.p.y) * this.board.view.zoom < 4) return;
        dragged = true;
        const b = rectFromPoints(start.p, p);
        if (e.shiftKey) { const side = Math.max(b.w, b.h); b.w = side; b.h = side; }
        el = { ...proto, ...b, w: Math.max(MIN_SIZE, b.w), h: Math.max(MIN_SIZE, b.h) };
        this.replace([...baseEls, el]);
      },
      up: () => {
        if (!dragged) this.replace([...baseEls, el]);
        this.commitGesture(baseEls);
        this.setTool('select');
        this.select([el.id], { expand: false });
      },
    };
  }

  placeText(p) {
    const el = createElement('text', { x: p.x, y: p.y - 12 });
    this.setTool('select');
    this.addElements([el]);
    this.startEdit(el.id);
  }

  placeSticky(p) {
    const proto = createElement('sticky');
    const el = { ...proto, x: p.x - proto.w / 2, y: p.y - proto.h / 2 };
    this.setTool('select');
    this.addElements([el]);
    this.startEdit(el.id);
  }

  beginPen(start) {
    const baseEls = this.elements;
    const raw = [start.p];
    const proto = createElement('pen');
    const build = () => {
      const b = union(raw.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
      const w = Math.max(1, b.w), h = Math.max(1, b.h);
      return { ...proto, x: b.x, y: b.y, w, h, points: raw.map((p) => ({ x: (p.x - b.x) / w, y: (p.y - b.y) / h })) };
    };
    this.gesture = {
      kind: 'pen',
      move: (e) => {
        raw.push(this.toWorld(e.clientX, e.clientY));
        if (raw.length > 1) this.replace([...baseEls, build()]);
      },
      up: () => { if (raw.length > 1) this.commitGesture(baseEls); },
    };
  }

  onMove(e) {
    if (this.gesture) { this.gesture.move(e); return; }
    if (this.tool === 'connector') {
      const target = this.connectTarget(this.toWorld(e.clientX, e.clientY));
      const id = target?.id || null;
      if (id !== this.hover) { this.hover = id; this.requestRender(); }
    }
  }

  onUp(e) {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (this.stage.hasPointerCapture(e.pointerId)) this.stage.releasePointerCapture(e.pointerId);
    g.up(e);
    this.requestRender();
    this.deferredPatches.splice(0).forEach(([board, id, patch]) => this.patchUntracked(board, id, patch));
    this.emit('gestureend');
    this.emit('selection');
  }

  onDouble(e) {
    if (e.target.closest('textarea')) return;
    const p = this.toWorld(e.clientX, e.clientY);
    const hit = this.hitAt(p);
    if (!hit) {
      if (this.tool === 'select') this.placeText(p);
      return;
    }
    this.select([hit.id], { expand: false });
    if (hit.type === 'link') {
      this.emit('openlink', hit);
    } else if (hit.type === 'table') {
      const cell = cellAt(hit, p);
      if (cell) this.startEdit(hit.id, cell);
    } else if (hasText(hit.type) || hit.type === 'connector') {
      this.startEdit(hit.id);
    }
  }

  // ---- Inline text editing ----

  startEdit(id, cell) {
    const el = this.byId.get(id);
    if (!el) return;
    this.commitEdit();
    const ta = document.createElement('textarea');
    ta.className = 'inline-editor';
    ta.spellcheck = false;
    ta.value = cell ? el.cells[cell.r][cell.c] : el.type === 'connector' ? el.label : el.text;
    this.editing = { id, r: cell?.r, c: cell?.c, ta, base: this.elements };
    this.stage.append(ta);
    ta.addEventListener('input', () => this.positionEditor());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.commitEdit(); }
    });
    for (const type of ['copy', 'cut', 'paste']) ta.addEventListener(type, (e) => e.stopPropagation());
    ta.addEventListener('blur', () => this.commitEdit());
    this.positionEditor();
    ta.focus();
    ta.select();
    this.markup.delete(id);
    this.requestRender();
  }

  editorStyle(el) {
    const { r, c } = this.editing;
    if (el.type === 'table') {
      const b = cellRect(el, r, c);
      const title = el.titleRow && el.cells.length > 1 && r === 0;
      return {
        box: { x: b.x + 8, y: b.y + 4, w: b.w - 16, h: b.h - 8 },
        fontSize: title ? el.fontSize * 1.1 : el.fontSize, fontWeight: title ? 700 : 400, align: 'center', valign: 'middle', color: el.textColor,
      };
    }
    if (el.type === 'connector') {
      const route = routeConnector(el, this.byId);
      const at = labelLayout({ ...el, label: el.label || ' ' }, route).at;
      return { box: { x: at.x - 130, y: at.y - el.fontSize, w: 260, h: el.fontSize * 2 }, fontSize: el.fontSize, fontWeight: el.fontWeight, align: 'center', valign: 'middle', color: el.textColor, backed: true };
    }
    const box = textBox(el);
    if (el.type === 'icon') return { box: { ...box, h: el.fontSize * 3 }, fontSize: el.fontSize, fontWeight: el.fontWeight, align: 'center', valign: 'top', color: el.textColor };
    return { box, fontSize: el.fontSize, fontWeight: el.fontWeight, align: el.align, valign: el.valign, color: el.textColor };
  }

  positionEditor() {
    if (!this.editing) return;
    const el = this.byId.get(this.editing.id);
    if (!el) return;
    const { ta } = this.editing;
    const st = this.editorStyle(el);
    const z = this.board.view.zoom;
    const a = this.toScreen(st.box);
    const lines = wrapText(ta.value || ' ', st.box.w, st.fontSize, st.fontWeight, defaultMeasure);
    const contentH = textHeight(lines, st.fontSize);
    const boxH = Math.max(st.box.h, contentH);
    const free = boxH - contentH;
    const pad = st.valign === 'top' ? 0 : st.valign === 'bottom' ? free : free / 2;
    Object.assign(ta.style, {
      left: `${a.x}px`, top: `${a.y}px`, width: `${st.box.w * z}px`, height: `${boxH * z + 4}px`,
      paddingTop: `${pad * z}px`, fontSize: `${st.fontSize * z}px`, fontWeight: st.fontWeight,
      textAlign: st.align, color: st.color, background: st.backed ? 'rgba(255,255,255,.92)' : 'transparent',
    });
  }

  commitEdit() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const value = ed.ta.value;
    ed.ta.remove();
    this.markup.delete(ed.id);
    const el = this.byId.get(ed.id);
    this.stage.focus({ preventScroll: true });
    if (!el) { this.requestRender(); return; }
    if (el.type === 'text' && !value.trim()) {
      this.selection.delete(ed.id);
      this.commit(this.elements.filter((x) => x.id !== ed.id));
      return;
    }
    let patch;
    if (el.type === 'table') {
      const cells = el.cells.map((row) => [...row]);
      cells[ed.r][ed.c] = value;
      patch = { cells };
    } else if (el.type === 'connector') {
      patch = { label: value };
    } else {
      patch = { text: value };
    }
    const next = { ...el, ...patch };
    const changed = el.type === 'table' ? el.cells[ed.r][ed.c] !== value : el.type === 'connector' ? el.label !== value : el.text !== value;
    if (changed) this.commit(this.elements.map((x) => (x.id === ed.id ? (x.type === 'text' ? fitTextHeight(next) : next) : x)));
    else this.requestRender();
    this.emit('selection');
  }
}
