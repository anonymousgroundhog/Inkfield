// Converts Mermaid source into native, editable Inkfield elements. Mermaid's own
// library would only produce a flat SVG, so this parses the common diagram types
// and lays them out itself. Pure: no DOM access beyond the injected text measure.
import { createElement } from './model.js';
import { anchorPoint } from './connectors.js';
import { defaultMeasure, textHeight, wrapText } from './render.js';

const MAX_SOURCE = 200000;
const MAX_NODES = 2000;
const WRAP = 200;
const FONT = 15;
const LABEL_FONT = 13;
const SUPPORTED = 'flowchart, sequenceDiagram, stateDiagram, classDiagram and erDiagram';
const KNOWN_UNSUPPORTED = /^(gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4\w*|sankey(-beta)?|xychart(-beta)?|block(-beta)?|packet(-beta)?|kanban|architecture(-beta)?|radar(-beta)?|treemap(-beta)?)\b/;
const HEADER = /^(graph|flowchart|sequenceDiagram|stateDiagram(-v2)?|classDiagram(-v2)?|erDiagram)\b/;

export class MermaidError extends Error {
  constructor(message, line) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = 'MermaidError';
    this.line = line;
  }
}

// ---- Source cleanup ----

function stripFence(source) {
  const fenced = source.match(/```\s*(?:mermaid)?[ \t]*\r?\n([\s\S]*?)```/i);
  return fenced ? fenced[1] : source;
}

function readLines(source) {
  const raw = stripFence(source).replace(/\r\n?/g, '\n').split('\n');
  let title = '';
  let i = 0;
  while (i < raw.length && !raw[i].trim()) i++;
  if (raw[i]?.trim() === '---') {
    const close = raw.findIndex((l, k) => k > i && l.trim() === '---');
    if (close > 0) {
      for (let k = i + 1; k < close; k++) {
        const m = raw[k].match(/^\s*title:\s*(.+?)\s*$/);
        if (m) title = m[1].replace(/^["']|["']$/g, '');
        raw[k] = '';
      }
      raw[i] = ''; raw[close] = '';
    }
  }
  const lines = [];
  raw.forEach((text, index) => {
    const clean = text.replace(/(^|\s)%%.*$/, '').trim();
    if (clean) lines.push({ n: index + 1, text: clean });
  });
  return { lines, title };
}

export function looksLikeMermaid(text) {
  const { lines } = readLines(String(text).slice(0, MAX_SOURCE));
  if (lines.length < 2) return false;
  const first = lines[0].text;
  if (/^(graph|flowchart)\b/.test(first)) return /^(graph|flowchart)(\s+(TD|TB|BT|LR|RL))?\s*;?$/.test(first);
  return HEADER.test(first);
}

function decodeText(text) {
  return String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\n/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/#(quot|amp|lt|gt|nbsp|#?\d+);/g, (all, name) => {
      const known = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ' }[name];
      if (known) return known;
      const code = Number(name.replace('#', ''));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/&(quot|amp|lt|gt|nbsp);/g, (_, name) => ({ quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ' }[name]))
    .replace(/\bfa[bsrl]?:fa-[\w-]+\s*/g, '')
    .trim();
}

function unquote(text) {
  let t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  if (t.length >= 2 && t.startsWith('`') && t.endsWith('`')) t = t.slice(1, -1);
  return decodeText(t);
}

// Splits on `;` outside quotes and brackets.
function splitStatements(lines) {
  const out = [];
  for (const { n, text } of lines) {
    let depth = 0, quote = false, start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') quote = !quote;
      else if (!quote && '([{'.includes(ch)) depth++;
      else if (!quote && ')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      else if (!quote && !depth && ch === ';') {
        const part = text.slice(start, i).trim();
        if (part) out.push({ n, text: part });
        start = i + 1;
      }
    }
    const rest = text.slice(start).trim();
    if (rest) out.push({ n, text: rest });
  }
  return out;
}

// ---- Graph model shared by flowchart, state, class and ER diagrams ----

function newGraph(direction) {
  return { direction, nodes: new Map(), clusters: new Map(), order: [], edges: [], warnings: [], styles: new Map(), classDefs: new Map(), nodeClasses: new Map() };
}

function touchNode(g, id, parent) {
  let node = g.nodes.get(id);
  if (!node) {
    if (g.nodes.size >= MAX_NODES) throw new MermaidError(`Diagrams are limited to ${MAX_NODES} nodes.`);
    node = { id, label: id, shape: 'rect', parent: null };
    g.nodes.set(id, node);
    g.order.push(id);
  }
  if (parent && !node.parent) node.parent = parent;
  return node;
}

function addCluster(g, id, label, parent, direction) {
  const cluster = { id, label, parent: parent || null, direction, isCluster: true };
  if (!g.clusters.has(id)) g.order.push(id);
  g.clusters.set(id, cluster);
  return cluster;
}

function parseStyleProps(text) {
  const props = {};
  const colour = /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d.,\s%]+\))$/i;
  for (const part of text.split(',')) {
    const [k, v] = part.split(':').map((x) => x?.trim());
    if (!k || !v) continue;
    if (k === 'fill' && colour.test(v)) props.fill = v;
    if (k === 'stroke' && colour.test(v)) props.stroke = v;
    if (k === 'color' && colour.test(v)) props.textColor = v;
    if (k === 'stroke-width' && Number.isFinite(parseFloat(v))) props.strokeWidth = Math.min(20, Math.max(0, parseFloat(v)));
  }
  return props;
}

// ---- Flowchart ----

const SHAPES = [
  ['(((', ')))', 'circle'], ['((', '))', 'circle'], ['([', '])', 'stadium'], ['[[', ']]', 'rect'], ['[(', ')]', 'cylinder'],
  ['[/', '/]', 'parallelogram'], ['[/', '\\]', 'parallelogram'], ['[\\', '\\]', 'parallelogram'], ['[\\', '/]', 'parallelogram'],
  ['{{', '}}', 'hexagon'], ['[', ']', 'rect'], ['(', ')', 'rounded'], ['{', '}', 'diamond'], ['>', ']', 'parallelogram'],
];
const NAMED_SHAPES = {
  rect: 'rect', proc: 'rect', process: 'rect', rectangle: 'rect', rounded: 'rounded', event: 'rounded', stadium: 'stadium', pill: 'stadium', terminal: 'stadium',
  diam: 'diamond', diamond: 'diamond', decision: 'diamond', question: 'diamond', circle: 'circle', circ: 'circle', 'sm-circ': 'circle', 'dbl-circ': 'circle',
  cyl: 'cylinder', cylinder: 'cylinder', db: 'cylinder', database: 'cylinder', hex: 'hexagon', hexagon: 'hexagon', prepare: 'hexagon',
  'lean-r': 'parallelogram', 'lean-l': 'parallelogram', 'in-out': 'parallelogram', 'out-in': 'parallelogram',
};
const LINK_AHEAD = /^(--|==|-\.|~~~)/;

function readNode(s, start) {
  let i = start;
  while (i < s.length && /\s/.test(s[i])) i++;
  const idStart = i;
  while (i < s.length) {
    const ch = s[i];
    if (!/[\p{L}\p{N}_.\-/\\$#*+!?'’]/u.test(ch)) break;
    if (LINK_AHEAD.test(s.slice(i))) break;
    i++;
  }
  // A trailing dot or dash belongs to the following syntax, not the id.
  while (i > idStart && /[.\-]/.test(s[i - 1])) i--;
  if (i === idStart) return null;
  const node = { id: s.slice(idStart, i) };

  const rest = s.slice(i);
  const named = rest.match(/^@\{([^}]*)\}/);
  if (named) {
    i += named[0].length;
    const shape = named[1].match(/\bshape\s*:\s*"?([\w-]+)"?/);
    const label = named[1].match(/\blabel\s*:\s*(?:"([^"]*)"|([^,]+))/);
    if (shape) node.shape = NAMED_SHAPES[shape[1]] || 'rect';
    if (label) node.label = decodeText(label[1] ?? label[2]);
  } else {
    for (const [open, close, shape] of SHAPES) {
      if (!rest.startsWith(open)) continue;
      const bodyStart = i + open.length;
      let end;
      const afterOpen = s.slice(bodyStart).match(/^\s*/)[0].length + bodyStart;
      if (s[afterOpen] === '"') {
        const q = s.indexOf('"', afterOpen + 1);
        if (q < 0) return { error: 'Unclosed quote in a node label' };
        end = s.indexOf(close, q + 1);
      } else {
        end = s.indexOf(close, bodyStart);
      }
      if (end < 0) continue;
      node.shape = shape;
      node.label = unquote(s.slice(bodyStart, end));
      i = end + close.length;
      break;
    }
  }
  const cls = s.slice(i).match(/^:::([\w-]+)/);
  if (cls) { node.cls = cls[1]; i += cls[0].length; }
  return { node, next: i };
}

function readGroup(s, start) {
  const nodes = [];
  let i = start;
  for (;;) {
    const r = readNode(s, i);
    if (!r) return null;
    if (r.error) return r;
    nodes.push(r.node);
    i = r.next;
    const amp = s.slice(i).match(/^\s*&\s*/);
    if (!amp) return { nodes, next: i };
    i += amp[0].length;
  }
}

const CAP = { '>': 'arrow', o: 'dot', x: 'cross', '<': 'arrow' };

function readLink(s, start) {
  const ws = s.slice(start).match(/^\s*/)[0].length;
  const i = start + ws;
  const rest = s.slice(i);
  if (rest.startsWith('~~~')) {
    const m = rest.match(/^~{3,}/);
    return finishLink(s, i + m[0].length, { invisible: true });
  }
  const m = rest.match(/^(<|[ox](?=[-=.]))?(-{2,}|={2,}|-\.+-?)([>ox](?![\p{L}\p{N}_])|>)?/u);
  if (!m || (m[1] && /^[ox]$/.test(m[1]) && !ws && start !== 0)) return null;
  const body = m[2];
  const base = {
    startCap: m[1] ? CAP[m[1]] : 'none',
    dash: body.includes('.') ? 'dashed' : 'solid',
    thick: body.startsWith('='),
  };
  const open = !m[3] && (body === '--' || body === '==' || body === '-.');
  if (!open) return finishLink(s, i + m[0].length, { ...base, endCap: m[3] ? CAP[m[3]] : 'none' });
  // Inline label form: A -- text --> B
  const close = { '--': /-{2,}([>ox])?/, '==': /={2,}([>ox])?/, '-.': /\.+-([>ox])?/ }[body];
  const after = i + m[0].length;
  const found = s.slice(after).match(close);
  if (!found) return null;
  const label = unquote(s.slice(after, after + found.index));
  return { link: { ...base, endCap: found[1] ? CAP[found[1]] : 'none', label }, next: after + found.index + found[0].length };
}

function finishLink(s, i, link) {
  const piped = s.slice(i).match(/^\s*\|((?:"[^"]*"|[^|])*)\|/);
  if (!piped) return { link, next: i };
  return { link: { ...link, label: unquote(piped[1]) }, next: i + piped[0].length };
}

function parseFlowEdge(s) {
  const first = readGroup(s, 0);
  if (!first || first.error) return { error: first?.error || 'Could not read this statement' };
  const groups = [first.nodes];
  const links = [];
  let i = first.next;
  while (s.slice(i).trim()) {
    const l = readLink(s, i);
    if (!l) return { error: `Unexpected "${s.slice(i).trim().slice(0, 24)}"` };
    const g = readGroup(s, l.next);
    if (!g || g.error) return { error: g?.error || 'A link is missing its target' };
    links.push(l.link);
    groups.push(g.nodes);
    i = g.next;
  }
  return { groups, links };
}

function parseFlowchart(lines, firstLine) {
  const dirMatch = firstLine.match(/^(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)/);
  const g = newGraph(normalizeDir(dirMatch?.[1] || 'TB'));
  const stack = [];
  let anon = 0;
  const current = () => stack[stack.length - 1] || null;

  for (const { n, text } of splitStatements(lines)) {
    if (/^end$/.test(text)) {
      if (!stack.length) g.warnings.push({ line: n, message: '"end" without a matching subgraph' });
      stack.pop();
      continue;
    }
    const sub = text.match(/^subgraph\b\s*(.*)$/);
    if (sub) {
      const parts = sub[1].match(/^([^\s[\]"]+)\s*\[(.*)\]$/);
      const raw = sub[1].trim();
      const id = parts ? parts[1] : raw && !raw.startsWith('"') ? raw : `__subgraph${++anon}`;
      const label = parts ? unquote(parts[2]) : unquote(raw);
      addCluster(g, id, label, current(), null);
      stack.push(id);
      continue;
    }
    const dir = text.match(/^direction\s+(TD|TB|BT|LR|RL)$/);
    if (dir) {
      if (current()) g.clusters.get(current()).direction = normalizeDir(dir[1]);
      else g.direction = normalizeDir(dir[1]);
      continue;
    }
    const style = text.match(/^style\s+(\S+)\s+(.+)$/);
    if (style) { g.styles.set(style[1], { ...g.styles.get(style[1]), ...parseStyleProps(style[2]) }); continue; }
    const classDef = text.match(/^classDef\s+(\S+)\s+(.+)$/);
    if (classDef) {
      const props = parseStyleProps(classDef[2]);
      classDef[1].split(',').forEach((c) => g.classDefs.set(c.trim(), props));
      continue;
    }
    const cls = text.match(/^class\s+(.+?)\s+(\S+)$/);
    if (cls) { cls[1].split(',').forEach((id) => addNodeClass(g, id.trim(), cls[2])); continue; }
    if (/^(linkStyle|click|accTitle|accDescr|title)\b/.test(text)) continue;

    const parsed = parseFlowEdge(text);
    if (parsed.error) { g.warnings.push({ line: n, message: `${parsed.error}. Skipped.` }); continue; }
    for (const group of parsed.groups) {
      for (const item of group) {
        const node = touchNode(g, item.id, current());
        if (item.label !== undefined) node.label = item.label;
        if (item.shape) node.shape = item.shape;
        if (item.cls) addNodeClass(g, item.id, item.cls);
      }
    }
    parsed.links.forEach((link, k) => {
      for (const a of parsed.groups[k]) for (const b of parsed.groups[k + 1]) g.edges.push({ from: a.id, to: b.id, ...link });
    });
  }
  if (stack.length) g.warnings.push({ line: lines[lines.length - 1]?.n, message: `${stack.length} subgraph(s) not closed with "end"` });
  // A subgraph can be an edge endpoint; it then isn't a node of its own.
  for (const id of g.clusters.keys()) g.nodes.delete(id);
  return g;
}

function addNodeClass(g, id, cls) {
  if (!g.nodeClasses.has(id)) g.nodeClasses.set(id, []);
  g.nodeClasses.get(id).push(cls);
}

const normalizeDir = (d) => (d === 'TD' ? 'TB' : d);

// ---- State diagrams ----

function parseState(lines) {
  const g = newGraph('TB');
  const stack = [];
  const current = () => stack[stack.length - 1] || null;
  const endpoint = (raw, role) => {
    if (raw !== '[*]') return touchNode(g, raw, current()).id;
    const id = `__${role}_${current() || 'root'}`;
    const node = touchNode(g, id, current());
    node.shape = role;
    node.label = '';
    return id;
  };
  let inNote = false;
  for (const { n, text } of lines) {
    if (inNote) { if (/^end note$/.test(text)) inNote = false; continue; }
    if (/^note\b/.test(text)) { if (!text.includes(':')) inNote = true; continue; }
    if (text === '}') { stack.pop(); continue; }
    if (text === '--' || /^(hide empty|scale|classDef|class|style)\b/.test(text)) continue;
    const dir = text.match(/^direction\s+(TD|TB|BT|LR|RL)$/);
    if (dir) {
      if (current()) g.clusters.get(current()).direction = normalizeDir(dir[1]);
      else g.direction = normalizeDir(dir[1]);
      continue;
    }
    const composite = text.match(/^state\s+(?:"([^"]*)"\s+as\s+)?(\S+)\s*\{$/);
    if (composite) {
      addCluster(g, composite[2], decodeText(composite[1] ?? composite[2]), current(), null);
      stack.push(composite[2]);
      continue;
    }
    const alias = text.match(/^state\s+"([^"]*)"\s+as\s+(\S+)$/);
    if (alias) { touchNode(g, alias[2], current()).label = decodeText(alias[1]); setStateShape(g, alias[2]); continue; }
    const pseudo = text.match(/^state\s+(\S+)\s*<<(choice|fork|join)>>$/);
    if (pseudo) {
      const node = touchNode(g, pseudo[1], current());
      node.shape = pseudo[2] === 'choice' ? 'choice' : 'bar';
      node.label = '';
      continue;
    }
    const plain = text.match(/^state\s+(\S+)$/);
    if (plain) { touchNode(g, plain[1], current()); setStateShape(g, plain[1]); continue; }
    const edge = text.match(/^(\[\*\]|[^\s:]+)\s*-->\s*(\[\*\]|[^\s:]+)\s*(?::\s*(.*))?$/);
    if (edge) {
      const from = endpoint(edge[1], 'start');
      const to = endpoint(edge[2], 'end');
      [from, to].forEach((id) => setStateShape(g, id));
      g.edges.push({ from, to, label: decodeText(edge[3] || ''), startCap: 'none', endCap: 'arrow', dash: 'solid' });
      continue;
    }
    const desc = text.match(/^([^\s:]+)\s*:\s*(.+)$/);
    if (desc) { touchNode(g, desc[1], current()).label = decodeText(desc[2]); setStateShape(g, desc[1]); continue; }
    g.warnings.push({ line: n, message: `Could not read "${text.slice(0, 40)}". Skipped.` });
  }
  for (const id of g.clusters.keys()) g.nodes.delete(id);
  return g;
}

function setStateShape(g, id) {
  const node = g.nodes.get(id);
  if (node?.shape === 'rect') node.shape = 'rounded';
}

// ---- Class diagrams ----

const CLASS_REL = /^("[^"]+"|[^\s"]+)\s*(?:"([^"]*)")?\s*(<\|--|<\|\.\.|\*--|o--|<--|<\.\.|--\|>|\.\.\|>|--\*|--o|-->|\.\.>|--|\.\.)\s*(?:"([^"]*)")?\s*("[^"]+"|[^\s":]+)\s*(?::\s*(.*))?$/;
const REL_CAPS = { '<|': 'arrow', '|>': 'arrow', '*': 'dot', o: 'dot', '<': 'open', '>': 'open' };

function parseClass(lines) {
  const g = newGraph('TB');
  const members = new Map();
  const add = (id, text) => {
    if (!members.has(id)) members.set(id, []);
    members.get(id).push(decodeText(text));
  };
  let open = null;
  for (const { n, text } of lines) {
    if (open) {
      if (text === '}') open = null;
      else add(open, text);
      continue;
    }
    if (/^(note|namespace|link|click|callback|style|cssClass|<<|\})/.test(text)) continue;
    const dir = text.match(/^direction\s+(TD|TB|BT|LR|RL)$/);
    if (dir) { g.direction = normalizeDir(dir[1]); continue; }
    const cls = text.match(/^class\s+("[^"]+"|[^\s{["]+)(?:\["([^"]*)"\])?\s*(\{)?\s*(\})?$/);
    if (cls) {
      const id = unquote(cls[1]);
      const node = touchNode(g, id);
      if (cls[2]) node.label = decodeText(cls[2]);
      if (cls[3] && !cls[4]) open = id;
      continue;
    }
    const rel = text.match(CLASS_REL);
    if (rel) {
      const op = rel[3];
      const dashed = op.includes('..');
      const line = dashed ? '..' : '--';
      const [left, right] = op.split(line);
      const from = unquote(rel[1]), to = unquote(rel[5]);
      touchNode(g, from); touchNode(g, to);
      const parts = [rel[2] && `${rel[2]} :`, rel[6] && decodeText(rel[6]), rel[4] && `: ${rel[4]}`].filter(Boolean);
      g.edges.push({ from, to, label: parts.join(' ').replace(/^:\s|\s:$/g, ''), startCap: REL_CAPS[left] || 'none', endCap: REL_CAPS[right] || 'none', dash: dashed ? 'dashed' : 'solid' });
      continue;
    }
    const member = text.match(/^("[^"]+"|[^\s:]+)\s*:\s*(.+)$/);
    if (member) { const id = unquote(member[1]); touchNode(g, id); add(id, member[2]); continue; }
    g.warnings.push({ line: n, message: `Could not read "${text.slice(0, 40)}". Skipped.` });
  }
  for (const node of g.nodes.values()) {
    const list = members.get(node.id);
    node.shape = 'table';
    node.cells = list?.length ? [[node.label], [list.join('\n')]] : [[node.label]];
  }
  return g;
}

// ---- ER diagrams ----

const CARD = { '||': '1', '|o': '0..1', 'o|': '0..1', '}o': '0..*', 'o{': '0..*', '}|': '1..*', '|{': '1..*' };
const ER_REL = /^("[^"]+"|[\w-]+)\s*(\|\||\|o|o\||\}o|o\{|\}\||\|\{)(--|\.\.)(\|\||\|o|o\||\}o|o\{|\}\||\|\{)\s*("[^"]+"|[\w-]+)\s*(?::\s*(.*))?$/;

function parseEr(lines) {
  const g = newGraph('TB');
  const attrs = new Map();
  let open = null;
  for (const { n, text } of lines) {
    if (open) {
      if (text === '}') open = null;
      else attrs.get(open).push(decodeText(text.replace(/\s+"[^"]*"\s*$/, '')));
      continue;
    }
    const dir = text.match(/^direction\s+(TD|TB|BT|LR|RL)$/);
    if (dir) { g.direction = normalizeDir(dir[1]); continue; }
    const block = text.match(/^("[^"]+"|[\w-]+)(?:\["([^"]*)"\])?\s*\{\s*(\})?$/);
    if (block) {
      const id = unquote(block[1]);
      const node = touchNode(g, id);
      if (block[2]) node.label = decodeText(block[2]);
      if (!attrs.has(id)) attrs.set(id, []);
      if (!block[3]) open = id;
      continue;
    }
    const rel = text.match(ER_REL);
    if (rel) {
      const from = unquote(rel[1]), to = unquote(rel[5]);
      touchNode(g, from); touchNode(g, to);
      const name = rel[6] ? unquote(rel[6]) : '';
      const card = `${CARD[rel[2]]} : ${CARD[rel[4]]}`;
      g.edges.push({ from, to, label: name ? `${name}\n${card}` : card, startCap: 'none', endCap: 'none', dash: rel[3] === '..' ? 'dashed' : 'solid' });
      continue;
    }
    if (/^[\w-]+$/.test(text)) { touchNode(g, text); continue; }
    g.warnings.push({ line: n, message: `Could not read "${text.slice(0, 40)}". Skipped.` });
  }
  for (const node of g.nodes.values()) {
    const list = attrs.get(node.id);
    node.shape = 'table';
    node.cells = list?.length ? [[node.label], [list.join('\n')]] : [[node.label]];
  }
  return g;
}

// ---- Layered layout. Each subgraph is laid out on its own, then treated as one
// ---- large node by its parent, so members stay inside their container.

function nodeSize(node, measure) {
  if (node.shape === 'start') return { w: 24, h: 24 };
  if (node.shape === 'end') return { w: 26, h: 26 };
  if (node.shape === 'choice') return { w: 40, h: 40 };
  if (node.shape === 'bar') return { w: 90, h: 8 };
  const block = (text, weight = 400, size = FONT) => {
    const lines = wrapText(text || ' ', WRAP, size, weight, measure);
    return { w: Math.max(...lines.map((l) => l.width)) + 2, h: textHeight(lines, size) };
  };
  if (node.shape === 'table') {
    const title = block(node.cells[0][0], 700, FONT * 1.1);
    const body = node.cells[1] ? block(node.cells[1][0]) : { w: 0, h: 0 };
    const titleH = FONT * 2.6;
    return { w: Math.max(140, Math.max(title.w, body.w) + 36), h: node.cells[1] ? titleH + body.h + 20 : titleH + FONT * 2 };
  }
  const t = block(node.label);
  switch (node.shape) {
    case 'circle': { const d = Math.max(70, Math.hypot(t.w, t.h) + 16); return { w: d, h: d }; }
    case 'diamond': return { w: Math.max(100, t.w / 0.5 + 12), h: Math.max(70, t.h / 0.5 + 8) };
    case 'hexagon': return { w: Math.max(110, t.w / 0.6 + 12), h: Math.max(50, t.h + 24) };
    case 'parallelogram': { const h = Math.max(50, t.h + 24); return { w: Math.max(120, t.w + h * 1.2 + 16), h }; }
    case 'cylinder': { const h = Math.max(80, t.h + 56); return { w: Math.max(90, t.w + 24), h }; }
    default: return { w: Math.max(90, t.w + 32), h: Math.max(44, t.h + 22) };
  }
}

function layoutLevel(ids, sizeOf, edges, dir) {
  const vertical = dir === 'TB' || dir === 'BT';
  const flip = dir === 'BT' || dir === 'RL';
  const rankDim = (id) => (vertical ? sizeOf(id).h : sizeOf(id).w);
  const crossDim = (id) => (vertical ? sizeOf(id).w : sizeOf(id).h);
  const out = new Map(ids.map((id) => [id, []]));
  edges.forEach((e) => out.get(e.u).push(e));

  // Back edges close cycles. They leave ranking and run in a channel on the side.
  const state = new Map();
  const visit = (id) => {
    state.set(id, 1);
    for (const e of out.get(id)) {
      const s = state.get(e.v);
      if (s === 1) e.back = true;
      else if (!s) visit(e.v);
    }
    state.set(id, 2);
  };
  ids.forEach((id) => { if (!state.has(id)) visit(id); });
  const forward = edges.filter((e) => !e.back);

  // Longest-path ranking, then pull sources down next to their targets.
  const rank = new Map(ids.map((id) => [id, 0]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  forward.forEach((e) => indegree.set(e.v, indegree.get(e.v) + 1));
  const queue = ids.filter((id) => !indegree.get(id));
  const topo = [];
  while (queue.length) {
    const id = queue.shift();
    topo.push(id);
    for (const e of out.get(id)) {
      if (e.back) continue;
      rank.set(e.v, Math.max(rank.get(e.v), rank.get(id) + 1));
      indegree.set(e.v, indegree.get(e.v) - 1);
      if (!indegree.get(e.v)) queue.push(e.v);
    }
  }
  const hasIncoming = new Set(forward.map((e) => e.v));
  [...topo].reverse().forEach((id) => {
    const targets = out.get(id).filter((e) => !e.back).map((e) => rank.get(e.v));
    if (!hasIncoming.has(id) && targets.length) rank.set(id, Math.min(...targets) - 1);
  });

  // Long edges get a dummy per skipped rank, reserving a clear channel through it.
  const maxRank = ids.length ? Math.max(...ids.map((id) => rank.get(id))) : 0;
  const layers = Array.from({ length: maxRank + 1 }, () => []);
  ids.forEach((id) => layers[rank.get(id)].push({ id, size: crossDim(id) }));
  const segments = [];
  forward.forEach((e, index) => {
    const a = rank.get(e.u), b = rank.get(e.v);
    let prev = e.u;
    e.dummies = [];
    for (let r = a + 1; r < b; r++) {
      const id = `\0d${index}:${r}`;
      layers[r].push({ id, size: 18, dummy: true });
      e.dummies.push({ id, r });
      segments.push([prev, id]);
      prev = id;
    }
    segments.push([prev, e.v]);
  });

  const up = new Map(), down = new Map();
  const link = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  segments.forEach(([a, b]) => { link(down, a, b); link(up, b, a); });

  // Order within ranks by barycentre sweeps, keeping the arrangement with fewest crossings.
  const positions = () => {
    const pos = new Map();
    layers.forEach((layer) => layer.forEach((n, i) => pos.set(n.id, i)));
    return pos;
  };
  const crossings = () => {
    if (segments.length > 600) return 0;
    const pos = positions();
    const rankOf = (id) => (rank.has(id) ? rank.get(id) : Number(id.split(':')[1]));
    let count = 0;
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const [a, b] = segments[i], [c, d] = segments[j];
        if (rankOf(a) !== rankOf(c)) continue;
        if ((pos.get(a) - pos.get(c)) * (pos.get(b) - pos.get(d)) < 0) count++;
      }
    }
    return count;
  };
  let best = layers.map((l) => [...l]);
  let bestScore = crossings();
  for (let sweep = 0; sweep < 8 && bestScore > 0; sweep++) {
    const pos = positions();
    const order = sweep % 2 ? [...layers.keys()].reverse() : [...layers.keys()];
    for (const r of order) {
      const refs = sweep % 2 ? down : up;
      const score = new Map(layers[r].map((n, i) => {
        const list = refs.get(n.id);
        return [n.id, list?.length ? list.reduce((s, id) => s + pos.get(id), 0) / list.length : i];
      }));
      layers[r].sort((a, b) => score.get(a.id) - score.get(b.id));
      layers[r].forEach((n, i) => pos.set(n.id, i));
    }
    const now = crossings();
    if (now < bestScore) { bestScore = now; best = layers.map((l) => [...l]); }
  }
  best.forEach((l, r) => { layers[r] = l; });

  // Cross positions: pull each node toward its neighbours without overlapping.
  const GAP = 44;
  const center = new Map();
  layers.forEach((layer) => {
    let at = 0;
    layer.forEach((n) => { center.set(n.id, at + n.size / 2); at += n.size + GAP; });
  });
  const separation = (a, b) => (a.size + b.size) / 2 + (a.dummy && b.dummy ? 16 : GAP);
  const placeLayer = (layer, refs) => {
    const want = layer.map((n) => {
      const list = refs.get(n.id);
      return list?.length ? list.reduce((s, id) => s + center.get(id), 0) / list.length : center.get(n.id);
    });
    const a = [...want], b = [...want];
    for (let i = 1; i < layer.length; i++) a[i] = Math.max(a[i], a[i - 1] + separation(layer[i - 1], layer[i]));
    for (let i = layer.length - 2; i >= 0; i--) b[i] = Math.min(b[i], b[i + 1] - separation(layer[i], layer[i + 1]));
    layer.forEach((n, i) => center.set(n.id, (a[i] + b[i]) / 2));
  };
  for (let pass = 0; pass < 12; pass++) {
    if (pass % 2 === 0) for (let r = 1; r < layers.length; r++) placeLayer(layers[r], up);
    else for (let r = layers.length - 2; r >= 0; r--) placeLayer(layers[r], down);
  }
  let minCross = Infinity, maxCross = 0;
  layers.flat().forEach((n) => { minCross = Math.min(minCross, center.get(n.id) - n.size / 2); });
  if (minCross === Infinity) minCross = 0;
  center.forEach((v, k) => center.set(k, Math.round(v - minCross)));
  layers.flat().forEach((n) => { maxCross = Math.max(maxCross, center.get(n.id) + n.size / 2); });

  // Rank coordinates, leaving room for edge labels in each gap.
  const bandSize = layers.map((layer) => Math.max(0, ...layer.filter((n) => !n.dummy).map((n) => rankDim(n.id))));
  const gapSize = layers.map(() => 56);
  forward.forEach((e) => {
    if (!e.labelSize) return;
    const extent = vertical ? e.labelSize.h + 52 : e.labelSize.w + 48;
    const r = rank.get(e.u);
    gapSize[r] = Math.max(gapSize[r], extent);
  });
  const rankTop = [];
  let cursor = 0;
  layers.forEach((_, r) => { rankTop[r] = cursor; cursor += bandSize[r] + gapSize[r]; });
  const totalRank = Math.max(0, cursor - (gapSize[layers.length - 1] || 0));
  const flipR = (r) => (flip ? totalRank - r : r);
  const midGap = (r) => rankTop[r] + bandSize[r] + gapSize[r] / 2;
  const toReal = (r, c) => (vertical ? { x: c, y: flipR(r) } : { x: flipR(r), y: c });

  const sides = {
    TB: { out: 'bottom', in: 'top', back: 'right', self: ['right', 'top'] },
    BT: { out: 'top', in: 'bottom', back: 'right', self: ['right', 'bottom'] },
    LR: { out: 'right', in: 'left', back: 'bottom', self: ['bottom', 'left'] },
    RL: { out: 'left', in: 'right', back: 'bottom', self: ['bottom', 'right'] },
  }[dir];

  // Long edges thread their reserved channels.
  for (const e of forward) {
    e.sides = [sides.out, sides.in];
    if (!e.dummies.length) continue;
    const via = [];
    e.dummies.forEach(({ id, r }) => {
      const c = center.get(id);
      via.push(toReal(midGap(r - 1), c), toReal(midGap(r), c));
    });
    e.localVia = via;
  }
  // Back edges run outside everything they span.
  let channels = 0;
  for (const e of edges) {
    if (!e.back) continue;
    e.sides = [sides.back, sides.back];
    const lo = Math.min(rank.get(e.u), rank.get(e.v)), hi = Math.max(rank.get(e.u), rank.get(e.v));
    let reach = 0;
    for (let r = lo; r <= hi; r++) layers[r].forEach((n) => { reach = Math.max(reach, center.get(n.id) + n.size / 2); });
    const at = reach + 34 + channels * 18;
    channels++;
    e.channel = { vertical, at };
    const labelReach = e.labelSize ? (vertical ? e.labelSize.w : e.labelSize.h) / 2 + 8 : 0;
    maxCross = Math.max(maxCross, at + labelReach);
  }

  const pos = new Map(ids.map((id) => {
    const r = rank.get(id);
    const band = rankTop[r] + (bandSize[r] - rankDim(id)) / 2;
    const c = center.get(id) - crossDim(id) / 2;
    const rr = flip ? totalRank - band - rankDim(id) : band;
    return [id, vertical ? { x: c, y: rr } : { x: rr, y: c }];
  }));
  return { pos, w: vertical ? maxCross : totalRank, h: vertical ? totalRank : maxCross, sides };
}

function layoutGraph(g, measure) {
  const labelSize = (text) => {
    const lines = wrapText(text, 240, LABEL_FONT, 600, measure);
    return { w: Math.max(...lines.map((l) => l.width)), h: textHeight(lines, LABEL_FONT) };
  };
  const parentOf = (id) => (g.clusters.get(id) || g.nodes.get(id))?.parent ?? null;
  const chain = (id) => {
    const list = [];
    const seen = new Set();
    let p = parentOf(id);
    while (p && !seen.has(p)) { list.push(p); seen.add(p); p = parentOf(p); }
    list.push(null);
    return list;
  };
  const childUnder = (id, level) => {
    let at = id;
    for (let guard = 0; guard < 1000 && parentOf(at) !== level; guard++) at = parentOf(at);
    return at;
  };

  const levelEdges = new Map();
  const edges = g.edges.filter((e) => (g.nodes.has(e.from) || g.clusters.has(e.from)) && (g.nodes.has(e.to) || g.clusters.has(e.to)));
  edges.forEach((e) => {
    e.labelSize = e.label ? labelSize(e.label) : null;
    if (e.from === e.to) { e.self = true; return; }
    const toChain = new Set(chain(e.to));
    const level = chain(e.from).find((c) => toChain.has(c)) ?? null;
    const u = childUnder(e.from, level), v = childUnder(e.to, level);
    if (u === v) return; // A link between a subgraph and its own member stays auto-routed.
    e.u = u; e.v = v; e.level = level;
    if (!levelEdges.has(level)) levelEdges.set(level, []);
    levelEdges.get(level).push(e);
  });

  const children = new Map();
  g.order.forEach((id) => {
    if (!g.nodes.has(id) && !g.clusters.has(id)) return;
    const p = parentOf(id);
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(id);
  });

  const layouts = new Map();
  const sizes = new Map();
  const PAD = 22, TITLE = 30;
  const compute = (level, dir) => {
    const ids = children.get(level) || [];
    ids.forEach((id) => {
      const cluster = g.clusters.get(id);
      if (!cluster) { sizes.set(id, nodeSize(g.nodes.get(id), measure)); return; }
      const inner = compute(id, cluster.direction || dir);
      const titleW = cluster.label ? labelSize(cluster.label).w + 28 : 0;
      sizes.set(id, { w: Math.max(inner.w + PAD * 2, titleW, 80), h: inner.h + PAD + (cluster.label ? TITLE : PAD) + 4 });
    });
    const result = layoutLevel(ids, (id) => sizes.get(id), levelEdges.get(level) || [], dir);
    result.dir = dir;
    layouts.set(level, result);
    return result;
  };
  const root = compute(null, g.direction);

  const absolute = new Map();
  const origin = new Map();
  const place = (level, ox, oy) => {
    origin.set(level, { x: ox, y: oy });
    const layout = layouts.get(level);
    for (const id of children.get(level) || []) {
      const p = layout.pos.get(id);
      const at = { x: ox + p.x, y: oy + p.y };
      absolute.set(id, { ...at, ...sizes.get(id) });
      const cluster = g.clusters.get(id);
      if (cluster) {
        // Centre content when the title made the container wider than its contents.
        const inner = layouts.get(id);
        const extra = sizes.get(id).w - inner.w - PAD * 2;
        place(id, at.x + PAD + Math.max(0, extra) / 2, at.y + (cluster.label ? TITLE : PAD));
      }
    }
  };
  place(null, 0, 0);
  return { absolute, edges, origin, root, layouts };
}

function nodeElement(node, box, style) {
  const base = { x: box.x, y: box.y, w: box.w, h: box.h, text: node.label, fontSize: FONT };
  let el;
  switch (node.shape) {
    case 'rounded': el = createElement('rect', { ...base, radius: 12 }); break;
    case 'stadium': el = createElement('rect', { ...base, radius: 999 }); break;
    case 'circle': el = createElement('ellipse', base); break;
    case 'diamond': case 'hexagon': case 'parallelogram': case 'cylinder': el = createElement(node.shape, base); break;
    case 'start': el = createElement('ellipse', { ...base, text: '', fill: '#111111' }); break;
    case 'end': el = createElement('ellipse', { ...base, text: '', fill: '#111111', stroke: '#8a929a', strokeWidth: 4 }); break;
    case 'choice': el = createElement('diamond', { ...base, text: '' }); break;
    case 'bar': el = createElement('rect', { ...base, text: '', radius: 0, fill: '#111111' }); break;
    case 'table':
      el = createElement('table', { x: box.x, y: box.y, w: box.w, h: box.h, cells: node.cells, titleRow: node.cells.length > 1, fontSize: FONT, headerFill: '#e4e7ea' });
      if (node.cells.length === 1) el = createElement('rect', { ...base, text: `**${node.cells[0][0]}**`, radius: 0 });
      break;
    default: el = createElement('rect', { ...base, radius: 0 });
  }
  return { ...el, ...style };
}

function graphToElements(g, measure) {
  if (!g.nodes.size && !g.clusters.size) throw new MermaidError('No nodes found. Check the diagram after its first line.');
  const { absolute, edges, origin } = layoutGraph(g, measure);
  const out = [];
  const ids = new Map();
  const styleFor = (id) => {
    const merged = { ...g.classDefs.get('default') };
    (g.nodeClasses.get(id) || []).forEach((c) => Object.assign(merged, g.classDefs.get(c)));
    return { ...merged, ...g.styles.get(id) };
  };

  const clusters = [...g.clusters.values()].filter((c) => absolute.has(c.id));
  const depth = (c) => { let d = 0; let p = c.parent; while (p && d < 1000) { d++; p = g.clusters.get(p)?.parent; } return d; };
  clusters.sort((a, b) => depth(a) - depth(b));
  for (const c of clusters) {
    const el = createElement('rect', {
      ...absolute.get(c.id), text: c.label, radius: 8, fill: depth(c) % 2 ? '#e9edf0' : '#f3f5f6', stroke: '#9aa4ae', strokeWidth: 1.5,
      align: 'left', valign: 'top', fontSize: 14, fontWeight: 600, ...styleFor(c.id),
    });
    ids.set(c.id, el);
    out.push(el);
  }
  for (const node of g.nodes.values()) {
    if (!absolute.has(node.id)) continue;
    const el = nodeElement(node, absolute.get(node.id), styleFor(node.id));
    ids.set(node.id, el);
    out.push(el);
  }

  for (const e of edges) {
    if (e.invisible) continue;
    const a = ids.get(e.from), b = ids.get(e.to);
    if (!a || !b) continue;
    let sides = e.sides || [];
    if (e.self) sides = (({ TB: ['right', 'top'], BT: ['right', 'bottom'], LR: ['bottom', 'left'], RL: ['bottom', 'right'] })[g.direction]);
    const startSide = sides[0], endSide = sides[1];
    const s = startSide ? anchorPoint(a, startSide) : { x: a.x, y: a.y };
    const t = endSide ? anchorPoint(b, endSide) : { x: b.x, y: b.y };
    const conn = createElement('connector', {
      start: { id: a.id, x: s.x, y: s.y, ...(startSide ? { side: startSide } : {}) },
      end: { id: b.id, x: t.x, y: t.y, ...(endSide ? { side: endSide } : {}) },
      label: e.label || '', startCap: e.startCap || 'none', endCap: e.endCap || 'none',
      dash: e.dash || 'solid', strokeWidth: e.thick ? 4 : 2, fontSize: LABEL_FONT,
    });
    const o = origin.get(e.level ?? null) || { x: 0, y: 0 };
    if (e.localVia) {
      const pts = e.localVia.map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
      const vertical = startSide === 'top' || startSide === 'bottom';
      const first = vertical ? { x: s.x, y: pts[0].y } : { x: pts[0].x, y: s.y };
      const lastPt = pts[pts.length - 1];
      const last = vertical ? { x: t.x, y: lastPt.y } : { x: lastPt.x, y: t.y };
      conn.via = { pts: [first, ...pts, last], s: { x: s.x, y: s.y }, e: { x: t.x, y: t.y } };
    } else if (e.channel) {
      const pts = e.channel.vertical
        ? [{ x: e.channel.at + o.x, y: s.y }, { x: e.channel.at + o.x, y: t.y }]
        : [{ x: s.x, y: e.channel.at + o.y }, { x: t.x, y: e.channel.at + o.y }];
      conn.via = { pts, s: { x: s.x, y: s.y }, e: { x: t.x, y: t.y } };
    }
    out.push(conn);
  }
  return out;
}

// ---- Sequence diagrams ----

const MESSAGE = /^(.+?)\s*(<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)\s*([^:]+?)\s*(?::\s*(.*))?$/;

function parseSequence(lines) {
  const seq = { participants: new Map(), events: [], warnings: [] };
  const touch = (id) => {
    if (!seq.participants.has(id)) {
      if (seq.participants.size >= 200) throw new MermaidError('Sequence diagrams are limited to 200 participants.');
      seq.participants.set(id, { id, label: id, actor: false });
    }
    return seq.participants.get(id);
  };
  let number = 0, numbering = false;
  const blocks = [];
  for (const { n, text } of lines) {
    if (/^(activate|deactivate|destroy|links?|properties|details|title|acc\w+)\b/.test(text)) continue;
    if (/^autonumber\b/.test(text)) { numbering = !/\boff\b/.test(text); continue; }
    const person = text.match(/^(?:create\s+)?(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/);
    if (person) {
      const p = touch(person[2].trim());
      p.actor = person[1] === 'actor';
      if (person[3]) p.label = decodeText(person[3]);
      else p.label = decodeText(person[2]);
      continue;
    }
    const block = text.match(/^(loop|alt|opt|par|critical|break)\b\s*(.*)$/);
    if (block) { blocks.push('frame'); seq.events.push({ kind: 'open', name: block[1], text: decodeText(block[2]) }); continue; }
    if (/^(box|rect)\b/.test(text)) { blocks.push('plain'); continue; }
    const divider = text.match(/^(else|and|option)\b\s*(.*)$/);
    if (divider) { seq.events.push({ kind: 'divider', text: decodeText(divider[2]) }); continue; }
    if (text === 'end') {
      const kind = blocks.pop();
      if (kind === 'frame') seq.events.push({ kind: 'close' });
      else if (!kind) seq.warnings.push({ line: n, message: '"end" without a matching block' });
      continue;
    }
    const note = text.match(/^[Nn]ote\s+(over|left of|right of)\s+([^:]+?)\s*:\s*(.*)$/);
    if (note) {
      const who = note[2].split(',').map((x) => x.trim()).filter(Boolean);
      who.forEach(touch);
      seq.events.push({ kind: 'note', place: note[1], who, text: decodeText(note[3]) });
      continue;
    }
    const msg = text.match(MESSAGE);
    if (msg) {
      const from = msg[1].trim(), to = msg[4].trim();
      touch(from); touch(to);
      const label = decodeText(msg[5] || '');
      if (numbering) number++;
      seq.events.push({ kind: 'message', from, to, op: msg[2], text: numbering ? `${number}. ${label}` : label });
      continue;
    }
    seq.warnings.push({ line: n, message: `Could not read "${text.slice(0, 40)}". Skipped.` });
  }
  return seq;
}

function sequenceToElements(seq, measure) {
  const people = [...seq.participants.values()];
  if (!people.length) throw new MermaidError('No participants or messages found.');
  const tw = (text, size = LABEL_FONT, weight = 600) => {
    if (!text) return { w: 0, h: 0 };
    const lines = wrapText(text, 280, size, weight, measure);
    return { w: Math.max(...lines.map((l) => l.width)), h: textHeight(lines, size) };
  };
  const index = new Map(people.map((p, i) => [p.id, i]));
  const boxes = people.map((p) => {
    const t = tw(p.label, FONT, 400);
    return p.actor ? { w: Math.max(60, t.w), h: 52 } : { w: Math.max(100, t.w + 32), h: Math.max(44, t.h + 20) };
  });
  const gaps = people.map((_, i) => (i + 1 < people.length ? (boxes[i].w + boxes[i + 1].w) / 2 + 40 : 0));
  const need = (a, b, width) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const have = gaps.slice(lo, hi).reduce((s, g) => s + g, 0);
    if (hi > lo && have < width) gaps[hi - 1] += width - have;
  };
  for (const ev of seq.events) {
    if (ev.kind === 'message') {
      const a = index.get(ev.from), b = index.get(ev.to);
      if (a === b && a + 1 < people.length) need(a, a + 1, tw(ev.text).w + 90);
      else need(a, b, tw(ev.text).w + 56);
    }
    if (ev.kind === 'note' && ev.who.length > 1) need(index.get(ev.who[0]), index.get(ev.who[1]), tw(ev.text, 14, 400).w - 60);
  }
  const xs = [];
  people.forEach((_, i) => { xs[i] = i ? xs[i - 1] + gaps[i - 1] : 0; });

  const headerH = Math.max(...boxes.map((b) => b.h));
  const notes = [], messages = [], frames = [], dividers = [];
  const stack = [];
  const touchFrames = (...i) => stack.forEach((f) => i.forEach((k) => { f.lo = Math.min(f.lo, k); f.hi = Math.max(f.hi, k); }));
  let y = headerH + 40;

  for (const ev of seq.events) {
    if (ev.kind === 'open') {
      stack.push({ name: ev.name, text: ev.text, top: y, lo: Infinity, hi: -Infinity, depth: stack.length, dividers: [], reach: -Infinity });
      y += 40;
    } else if (ev.kind === 'divider') {
      if (stack.length) stack[stack.length - 1].dividers.push({ y, text: ev.text });
      y += 36;
    } else if (ev.kind === 'close') {
      const f = stack.pop();
      if (f) { f.bottom = y; frames.push(f); }
      y += 22;
    } else if (ev.kind === 'note') {
      const i = ev.who.map((id) => index.get(id));
      touchFrames(...i);
      const t = tw(ev.text, 14, 400);
      const h = t.h + 18;
      let x0, w;
      if (ev.place === 'over') {
        const lo = xs[Math.min(...i)], hi = xs[Math.max(...i)];
        w = Math.max(t.w + 24, hi - lo + 60, 100);
        x0 = (lo + hi) / 2 - w / 2;
      } else {
        w = Math.max(t.w + 24, 90);
        x0 = ev.place === 'left of' ? xs[i[0]] - w - 14 : xs[i[0]] + 14;
      }
      notes.push(createElement('rect', { x: x0, y, w, h, text: ev.text, fontSize: 14, radius: 2, fill: '#fff4c2', stroke: '#c7ad4d', strokeWidth: 1.5 }));
      y += h + 22;
    } else if (ev.kind === 'message') {
      const a = index.get(ev.from), b = index.get(ev.to);
      touchFrames(a, b);
      const dashed = ev.op.startsWith('--') || ev.op.startsWith('<<--');
      const head = ev.op.endsWith('>>') ? 'arrow' : ev.op.endsWith('x') ? 'cross' : ev.op.endsWith(')') ? 'open' : 'none';
      const both = ev.op.startsWith('<<');
      const t = tw(ev.text);
      const base = { label: ev.text, dash: dashed ? 'dashed' : 'solid', strokeWidth: 2, endCap: head, startCap: both ? 'arrow' : 'none', fontSize: LABEL_FONT };
      if (a === b) {
        const x = xs[a], top = y, drop = Math.max(30, t.h + 12);
        const end = top + drop;
        const reach = x + 46;
        messages.push(createElement('connector', {
          ...base, label: '', start: { x, y: top }, end: { x, y: end },
          via: { pts: [{ x: reach, y: top }, { x: reach, y: end }], s: { x, y: top }, e: { x, y: end } },
        }));
        // Beside the loop rather than on it, where the label would break the small path.
        if (ev.text) {
          messages.push(createElement('text', {
            x: reach + 8, y: top + (drop - t.h) / 2, w: t.w + 6, h: t.h, text: ev.text, fontSize: LABEL_FONT, fontWeight: 600,
          }));
        }
        stack.forEach((f) => { f.reach = Math.max(f.reach, reach + 8 + t.w + 18); });
        y = end + 26;
      } else {
        y += Math.max(0, t.h - LABEL_FONT * 1.25);
        messages.push(createElement('connector', { ...base, route: 'straight', start: { x: xs[a], y }, end: { x: xs[b], y } }));
        y += 44;
      }
    }
  }
  while (stack.length) { const f = stack.pop(); f.bottom = y; frames.push(f); y += 22; }

  const frameEls = [...frames].sort((a, b) => a.depth - b.depth).map((f) => {
    const lo = Number.isFinite(f.lo) ? f.lo : 0, hi = Number.isFinite(f.hi) ? f.hi : people.length - 1;
    const inset = 28 - Math.min(f.depth, 3) * 6;
    const x = xs[lo] - inset;
    const heading = f.text ? `${f.name} [${f.text}]` : f.name;
    const right = Math.max(xs[hi] + inset, f.reach, x + tw(heading, 13, 700).w + 32);
    const w = right - x;
    for (const d of f.dividers) {
      dividers.push(createElement('connector', {
        route: 'straight', start: { x, y: d.y }, end: { x: right, y: d.y }, endCap: 'none', dash: 'dashed', strokeWidth: 1.5, stroke: '#7a838c',
      }));
      if (d.text) dividers.push(createElement('text', { x: x + 8, y: d.y + 3, w: w - 16, h: 18, text: `[${d.text}]`, fontSize: 13, fontWeight: 600, textColor: '#4b5560' }));
    }
    return createElement('rect', {
      x, y: f.top, w, h: f.bottom - f.top, radius: 2, fill: 'none', stroke: '#7a838c', strokeWidth: 1.5,
      text: f.text ? `**${f.name}** [${f.text}]` : `**${f.name}**`, align: 'left', valign: 'top', fontSize: 13, textColor: '#4b5560',
    });
  });

  const bottom = y + 6;
  const heads = [], lifelines = [];
  people.forEach((p, i) => {
    const b = boxes[i];
    const top = headerH - b.h;
    if (p.actor) {
      heads.push(createElement('icon', { icon: 'user', x: xs[i] - 26, y: top - 18, w: 52, h: 52, text: p.label, fontSize: FONT, fontWeight: 400 }));
    } else {
      heads.push(createElement('rect', { x: xs[i] - b.w / 2, y: top, w: b.w, h: b.h, text: p.label, fontSize: FONT, radius: 4, fill: '#f3f5f6' }));
    }
    lifelines.push(createElement('connector', {
      route: 'straight', start: { x: xs[i], y: headerH + (p.actor ? 22 : 0) }, end: { x: xs[i], y: bottom }, endCap: 'none', dash: 'dashed', strokeWidth: 1.5, stroke: '#7a838c',
    }));
  });
  return [...frameEls, ...lifelines, ...heads, ...dividers, ...notes, ...messages];
}

// ---- Entry point ----

export function mermaidToElements(source, { measure = defaultMeasure } = {}) {
  const text = String(source ?? '');
  if (text.length > MAX_SOURCE) throw new MermaidError('This diagram is too large to convert.');
  const { lines, title } = readLines(text);
  if (!lines.length) throw new MermaidError('Enter some Mermaid code to create a diagram.');
  const [first, ...rest] = lines;
  const head = first.text;
  const known = head.match(KNOWN_UNSUPPORTED);
  if (known) throw new MermaidError(`"${known[0]}" diagrams aren't supported yet. Inkfield can convert ${SUPPORTED}.`);
  const header = head.match(HEADER);
  if (!header) throw new MermaidError(`A diagram must start with a type such as "flowchart TD". Inkfield can convert ${SUPPORTED}.`, first.n);
  const kind = header[1];

  if (kind === 'sequenceDiagram') {
    const seq = parseSequence(rest);
    return { elements: sequenceToElements(seq, measure), warnings: seq.warnings, title, kind };
  }
  let graph;
  if (kind === 'graph' || kind === 'flowchart') {
    // A statement may follow the header on the same line: graph TD; A-->B
    const inline = head.replace(/^(?:graph|flowchart)(?:\s+(?:TD|TB|BT|LR|RL))?\s*;?/, '').trim();
    graph = parseFlowchart(inline ? [{ n: first.n, text: inline }, ...rest] : rest, head);
  } else if (kind.startsWith('stateDiagram')) graph = parseState(rest);
  else if (kind.startsWith('classDiagram')) graph = parseClass(rest);
  else graph = parseEr(rest);
  return { elements: graphToElements(graph, measure), warnings: graph.warnings, title, kind };
}
