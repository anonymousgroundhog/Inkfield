// Element and board data model, including validation of untrusted imported JSON.
// Elements are treated as immutable: every edit replaces the object, which keeps
// undo snapshots cheap and lets the renderer diff by reference.

export const FONT_STACK = '"Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Liberation Sans", sans-serif';

const TEXT = { text: '', fontSize: 16, fontWeight: 400, align: 'center', valign: 'middle', textColor: '#111111' };
const BOX = { x: 0, y: 0, w: 160, h: 90, opacity: 1, groups: [] };
const SHAPE = { ...BOX, ...TEXT, fill: '#ffffff', stroke: '#111111', strokeWidth: 2, dash: 'solid' };

export const DEFAULTS = {
  rect: { ...SHAPE, radius: 10 },
  ellipse: { ...SHAPE, w: 150, h: 100 },
  diamond: { ...SHAPE, w: 150, h: 110 },
  hexagon: { ...SHAPE, w: 160, h: 100 },
  parallelogram: { ...SHAPE, w: 170, h: 90 },
  cylinder: { ...SHAPE, w: 110, h: 130 },
  text: { ...BOX, ...TEXT, w: 220, h: 24, align: 'left', valign: 'top' },
  sticky: { ...BOX, ...TEXT, w: 170, h: 170, fill: '#ffd966', valign: 'middle' },
  icon: { ...BOX, ...TEXT, w: 96, h: 96, icon: 'user', fill: 'none', stroke: '#111111', fontWeight: 600 },
  image: { ...BOX, w: 240, h: 180, src: '' },
  pen: { ...BOX, points: [], stroke: '#111111', strokeWidth: 3, dash: 'solid' },
  table: {
    ...BOX, w: 480, h: 180, cells: [['Title', '', ''], ['', '', ''], ['', '', '']], titleRow: true,
    fill: '#ffffff', headerFill: '#a8a8a8', stroke: '#111111', strokeWidth: 2, fontSize: 15, textColor: '#111111',
  },
  connector: {
    opacity: 1, groups: [], start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, route: 'elbow',
    startCap: 'none', endCap: 'arrow', stroke: '#111111', strokeWidth: 2.5, dash: 'solid',
    label: '', labelPos: 0.5, fontSize: 15, fontWeight: 600, textColor: '#111111',
  },
};

export const ELEMENT_TYPES = Object.keys(DEFAULTS);
export const SHAPE_TYPES = ['rect', 'ellipse', 'diamond', 'hexagon', 'parallelogram', 'cylinder'];
export const hasFill = (t) => SHAPE_TYPES.includes(t) || t === 'sticky' || t === 'table' || t === 'icon';
export const hasText = (t) => SHAPE_TYPES.includes(t) || t === 'text' || t === 'sticky' || t === 'icon';

let seq = 0;
export function uid() {
  const r = globalThis.crypto?.randomUUID?.();
  return r ? r.replace(/-/g, '').slice(0, 16) : `e${Date.now().toString(36)}${(seq++).toString(36)}`;
}

export function createElement(type, props = {}) {
  const base = structuredCloneSafe(DEFAULTS[type]);
  return { ...base, ...props, id: props.id || uid(), type };
}

function structuredCloneSafe(v) {
  return JSON.parse(JSON.stringify(v));
}

export function createBoard(name = 'Untitled board', elements = []) {
  return { id: uid(), name, elements, view: { x: 0, y: 0, zoom: 1 }, rev: 1, updatedAt: Date.now() };
}

const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;
const safeId = (v) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null);

function normalizeEnd(raw, idMap) {
  if (typeof raw === 'string') raw = { id: raw };
  if (!raw || typeof raw !== 'object') return null;
  const end = { x: finite(raw.x, 0), y: finite(raw.y, 0) };
  const mapped = raw.id != null ? idMap.get(String(raw.id)) : null;
  if (mapped) {
    end.id = mapped;
    if (['top', 'right', 'bottom', 'left'].includes(raw.side)) end.side = raw.side;
  } else if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) {
    return null;
  }
  return end;
}

// Turns untrusted JSON into valid elements: unknown types and fields are dropped,
// ids are made safe and unique, and connector references are remapped. Connectors
// may use the authoring shorthand {from: "id", to: "id"} in place of start/end.
export function normalizeElements(rawList) {
  if (!Array.isArray(rawList)) return [];
  const list = rawList.filter((r) => r && typeof r === 'object' && ELEMENT_TYPES.includes(r.type));
  const idMap = new Map();
  const used = new Set();
  const ids = list.map((r) => {
    let id = safeId(r.id);
    if (!id || used.has(id)) id = uid();
    used.add(id);
    if (r.id != null && !idMap.has(String(r.id))) idMap.set(String(r.id), id);
    return id;
  });

  const out = [];
  list.forEach((raw, i) => {
    const def = DEFAULTS[raw.type];
    const el = createElement(raw.type, { id: ids[i] });
    for (const key of Object.keys(def)) {
      if (['start', 'end', 'cells', 'points', 'groups', 'src'].includes(key)) continue;
      if (typeof raw[key] === typeof def[key] && (typeof raw[key] !== 'number' || Number.isFinite(raw[key]))) el[key] = raw[key];
    }
    if ('fontSize' in el) el.fontSize = Math.min(400, Math.max(1, el.fontSize));
    if ('strokeWidth' in el) el.strokeWidth = Math.min(100, Math.max(0, el.strokeWidth));
    if (Array.isArray(raw.groups)) el.groups = raw.groups.filter((g) => typeof g === 'string').map((g) => g.slice(0, 64));

    if (raw.type === 'connector') {
      el.start = normalizeEnd(raw.start ?? raw.from, idMap);
      el.end = normalizeEnd(raw.end ?? raw.to, idMap);
      if (!el.start || !el.end) return;
      if (!['straight', 'elbow', 'curve'].includes(el.route)) el.route = 'elbow';
    } else {
      el.w = Math.max(1, el.w); el.h = Math.max(1, el.h);
    }
    if (raw.type === 'table') {
      const rows = Array.isArray(raw.cells) ? raw.cells.filter(Array.isArray) : [];
      if (rows.length) {
        const cols = Math.max(1, ...rows.map((r) => r.length));
        el.cells = rows.map((r) => Array.from({ length: cols }, (_, c) => (r[c] == null ? '' : String(r[c]))));
      }
    }
    if (raw.type === 'pen') {
      el.points = (Array.isArray(raw.points) ? raw.points : [])
        .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({ x: p.x, y: p.y }));
      if (el.points.length < 2) return;
    }
    if (raw.type === 'image') {
      // Remote URLs would taint the export canvas and leak requests, so only embedded data is allowed.
      if (typeof raw.src !== 'string' || !SAFE_IMAGE.test(raw.src)) return;
      el.src = raw.src;
    }
    out.push(el);
  });
  return out;
}

export function normalizeBoard(raw, fallbackName = 'Imported board') {
  if (!raw || typeof raw !== 'object') throw new Error('Not a board file');
  if (!Array.isArray(raw.elements)) throw new Error('Board file has no "elements" list');
  const board = createBoard(typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : fallbackName, normalizeElements(raw.elements));
  if (raw.view && typeof raw.view === 'object') {
    board.view = { x: finite(raw.view.x, 0), y: finite(raw.view.y, 0), zoom: Math.min(8, Math.max(0.05, finite(raw.view.zoom, 1))) };
  }
  return board;
}

// Accepts a single board or a {boards: [...]} workspace backup.
export function parseImport(text) {
  const data = JSON.parse(text);
  const boards = Array.isArray(data?.boards) ? data.boards : [data];
  return boards.map((b) => normalizeBoard(b));
}

// ---- Groups: `groups` lists a member's group ids, innermost first. ----

export const outerGroup = (el) => (el.groups?.length ? el.groups[el.groups.length - 1] : null);

export function expandToGroups(ids, elements) {
  const selected = new Set(ids);
  const outer = new Set();
  for (const el of elements) if (selected.has(el.id) && outerGroup(el)) outer.add(outerGroup(el));
  if (!outer.size) return selected;
  for (const el of elements) if (outer.has(outerGroup(el))) selected.add(el.id);
  return selected;
}

export function groupElements(ids, elements) {
  const gid = `g${uid()}`;
  return elements.map((el) => (ids.has(el.id) ? { ...el, groups: [...(el.groups || []), gid] } : el));
}

export function ungroupElements(ids, elements) {
  const outers = new Set(elements.filter((el) => ids.has(el.id) && outerGroup(el)).map(outerGroup));
  return elements.map((el) => (outers.has(outerGroup(el)) ? { ...el, groups: el.groups.slice(0, -1) } : el));
}
