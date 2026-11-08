import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { looksLikeMermaid, mermaidToElements, MermaidError } from '../src/mermaid.js';
import { routeConnector } from '../src/connectors.js';
import { approxMeasure } from '../src/render.js';
import { buildSvg } from '../src/export.js';
import { translate } from '../src/editor-transforms.js';
import { normalizeElements } from '../src/model.js';

const measure = approxMeasure;
const convert = (code) => mermaidToElements(code, { measure });
const shapes = (els) => els.filter((e) => e.type !== 'connector');
const conns = (els) => els.filter((e) => e.type === 'connector');
const byText = (els, t) => els.find((e) => e.text === t);
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const segHitsBox = (p, q, b) => {
  const [x0, x1] = [Math.min(p.x, q.x), Math.max(p.x, q.x)], [y0, y1] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
  return x0 < b.x + b.w && x1 > b.x && y0 < b.y + b.h && y1 > b.y;
};
const map = (els) => new Map(els.map((e) => [e.id, e]));

test('flowchart maps node syntax to shapes', () => {
  const { elements } = convert(`flowchart TD
    a[Rect] --> b(Round) --> c([Pill]) --> d[(Store)] --> e((Circle))
    e --> f{Choice} --> g{{Hex}} --> h[/Lean/] --> i>Flag] --> j[[Sub]]`);
  const type = (t) => byText(elements, t);
  assert.equal(type('Rect').type, 'rect');
  assert.equal(type('Rect').radius, 0);
  assert.equal(type('Round').radius, 12);
  assert.equal(type('Pill').radius, 999);
  assert.equal(type('Store').type, 'cylinder');
  assert.equal(type('Circle').type, 'ellipse');
  assert.equal(type('Choice').type, 'diamond');
  assert.equal(type('Hex').type, 'hexagon');
  assert.equal(type('Lean').type, 'parallelogram');
  assert.equal(type('Flag').type, 'parallelogram');
  assert.equal(type('Sub').type, 'rect');
  assert.equal(conns(elements).length, 9);
});

test('flowchart reads every link and label form', () => {
  const { elements, warnings } = convert(`graph LR
    A -->|pipe| B
    A -- inline --> C
    A -. dotted .-> D
    A == thick ==> E
    A --- F
    A -.- G
    A === H
    A --o I
    A --x J
    A <--> K
    A ~~~ L`);
  assert.deepEqual(warnings, []);
  const c = conns(elements);
  assert.equal(c.length, 10, 'the invisible link draws nothing');
  const label = (t) => c.find((x) => x.label === t);
  assert.equal(label('pipe').endCap, 'arrow');
  assert.equal(label('inline').endCap, 'arrow');
  assert.equal(label('dotted').dash, 'dashed');
  assert.equal(label('thick').strokeWidth, 4);
  const caps = c.filter((x) => !x.label).map((x) => [x.startCap, x.endCap].join());
  assert.deepEqual(caps, ['none,none', 'none,none', 'none,none', 'none,dot', 'none,cross', 'arrow,arrow']);
  assert.ok(byText(elements, 'L'), 'an invisible link still creates its node');
});

test('flowchart handles fan-out, semicolons, hyphenated ids and quoted labels', () => {
  const { elements, warnings } = convert('graph TD; A & B --> C & D; node-1["Has (parens) and; semi"] --> A');
  assert.deepEqual(warnings, []);
  assert.equal(conns(elements).length, 5);
  assert.ok(byText(elements, 'Has (parens) and; semi'));
});

test('labels decode line breaks and entities and strip markup', () => {
  const { elements } = convert('flowchart TD\n  A["one<br/>two #quot;x#quot; <b>bold</b>"] --> B');
  assert.ok(byText(elements, 'one\ntwo "x" bold'));
});

test('direction is honoured', () => {
  const pos = (dir) => {
    const { elements } = convert(`flowchart ${dir}\n A --> B`);
    return [byText(elements, 'A'), byText(elements, 'B')];
  };
  let [a, b] = pos('TD'); assert.ok(a.y < b.y);
  [a, b] = pos('BT'); assert.ok(a.y > b.y);
  [a, b] = pos('LR'); assert.ok(a.x < b.x);
  [a, b] = pos('RL'); assert.ok(a.x > b.x);
});

test('layout never overlaps nodes, and edges bind to their nodes', () => {
  const { elements } = convert(`flowchart TD
    A --> B & C & D
    B --> E
    C --> E
    D --> E
    E --> F --> G
    A --> G`);
  const s = shapes(elements);
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) assert.ok(!overlaps(s[i], s[j]), `${s[i].text} / ${s[j].text}`);
  const ids = map(elements);
  for (const c of conns(elements)) { assert.ok(ids.has(c.start.id)); assert.ok(ids.has(c.end.id)); }
});

test('an edge skipping ranks is routed around the nodes in between', () => {
  const { elements } = convert('flowchart TD\n A --> B --> C --> D\n A --> D');
  const ids = map(elements);
  const longEdge = conns(elements).find((c) => ids.get(c.start.id).text === 'A' && ids.get(c.end.id).text === 'D');
  const { pts } = routeConnector(longEdge, ids);
  for (const name of ['B', 'C']) {
    for (let i = 1; i < pts.length; i++) assert.ok(!segHitsBox(pts[i - 1], pts[i], byText(elements, name)), `crosses ${name}`);
  }
});

test('a cycle gets a side channel that clears spanned nodes', () => {
  const { elements } = convert('flowchart TD\n A --> B --> C --> A');
  const ids = map(elements);
  const back = conns(elements).find((c) => ids.get(c.start.id).text === 'C');
  assert.equal(back.start.side, 'right');
  const { pts } = routeConnector(back, ids);
  for (let i = 1; i < pts.length; i++) assert.ok(!segHitsBox(pts[i - 1], pts[i], byText(elements, 'B')));
});

test('self loops render with a real path', () => {
  const { elements } = convert('flowchart TD\n A --> A');
  const c = conns(elements)[0];
  assert.ok(routeConnector(c, map(elements)).pts.length >= 3);
});

test('subgraphs contain their members, including nesting and edges to the subgraph', () => {
  const { elements, warnings } = convert(`flowchart TD
    subgraph outer [Outer box]
      subgraph inner [Inner box]
        direction LR
        a --> b
      end
      c --> a
    end
    d --> outer
    b --> e`);
  assert.deepEqual(warnings, []);
  const outer = byText(elements, 'Outer box'), inner = byText(elements, 'Inner box');
  const within = (box, el) => el.x >= box.x && el.y >= box.y && el.x + el.w <= box.x + box.w && el.y + el.h <= box.y + box.h;
  assert.ok(within(inner, byText(elements, 'a')));
  assert.ok(within(inner, byText(elements, 'b')));
  assert.ok(within(outer, inner));
  assert.ok(within(outer, byText(elements, 'c')));
  assert.ok(!within(outer, byText(elements, 'e')));
  assert.ok(byText(elements, 'a').x < byText(elements, 'b').x, 'inner direction LR applies');
  assert.ok(elements.indexOf(outer) < elements.indexOf(inner) && elements.indexOf(inner) < elements.indexOf(byText(elements, 'a')), 'containers paint behind');
  assert.ok(conns(elements).some((c) => c.end.id === outer.id));
});

test('styles and classes apply, and unsafe colours are ignored', () => {
  const { elements } = convert(`flowchart TD
    A:::hot --> B
    classDef hot fill:#f00,color:#fff,stroke-width:3px
    style B fill:#0f0,stroke:url(evil)
    class B hot2`);
  const a = byText(elements, 'A'), b = byText(elements, 'B');
  assert.equal(a.fill, '#f00');
  assert.equal(a.textColor, '#fff');
  assert.equal(a.strokeWidth, 3);
  assert.equal(b.fill, '#0f0');
  assert.equal(b.stroke, '#111111');
});

test('comments, fences, front matter and init directives are handled', () => {
  const { elements, title } = convert('```mermaid\n---\ntitle: My flow\n---\n%%{init: {"theme":"dark"}}%%\nflowchart TD\n %% note\n A --> B %% trailing\n```');
  assert.equal(title, 'My flow');
  assert.equal(shapes(elements).length, 2);
});

test('sequence diagrams lay out participants, messages, notes and frames', () => {
  const { elements, warnings, kind } = convert(`sequenceDiagram
    autonumber
    actor U as User
    participant S as Server
    U->>+S: Request
    Note right of S: thinking
    alt ok
      S-->>-U: Response
    else failed
      S--xU: Error
    end
    S->>S: Clean up
    S-)U: Async`);
  assert.equal(kind, 'sequenceDiagram');
  assert.deepEqual(warnings, []);
  const c = conns(elements);
  const msg = (t) => c.find((x) => x.label.includes(t));
  assert.equal(msg('Request').label, '1. Request');
  assert.equal(msg('Response').dash, 'dashed');
  assert.equal(msg('Error').endCap, 'cross');
  assert.equal(msg('Async').endCap, 'open');
  assert.ok(msg('Request').start.y < msg('Response').start.y, 'time flows down');
  assert.ok(msg('Request').start.x < msg('Request').end.x);
  const cleanUp = byText(elements, '4. Clean up');
  const loop = c.find((x) => x.via);
  const loopPts = routeConnector(loop, new Map()).pts;
  assert.equal(loopPts.length, 4, 'self message loops');
  assert.ok(cleanUp.x > Math.max(...loopPts.map((p) => p.x)), 'its label sits clear of the loop');
  assert.ok(elements.some((e) => e.type === 'icon' && e.text === 'User'));
  assert.ok(byText(elements, 'thinking'));
  const frame = elements.find((e) => e.text?.includes('alt'));
  assert.ok(frame.y < msg('Response').start.y && frame.y + frame.h > msg('Error').start.y);
});

test('a sequence frame fits its heading and any self-message label', () => {
  const { elements } = convert(`sequenceDiagram
    A->>B: go
    loop a fairly long heading for one lifeline
      B->>B: A rather long self message label
    end`);
  const frame = elements.find((e) => e.text?.includes('heading'));
  const label = byText(elements, 'A rather long self message label');
  assert.ok(frame.x + frame.w >= label.x + label.w);
  assert.ok(frame.w >= approxMeasure('loop [a fairly long heading for one lifeline]', 13, 700));
});

test('state diagrams build start, end and composite states', () => {
  const { elements, warnings } = convert(`stateDiagram-v2
    [*] --> Idle
    state "Long name" as L
    Idle --> L: go
    state Group {
      [*] --> Inner
    }
    L --> Group
    state pick <<choice>>
    Group --> pick
    pick --> [*]`);
  assert.deepEqual(warnings, []);
  assert.ok(byText(elements, 'Long name'));
  const group = byText(elements, 'Group');
  const inner = byText(elements, 'Inner');
  assert.ok(inner.x >= group.x && inner.x + inner.w <= group.x + group.w);
  assert.ok(conns(elements).some((c) => c.label === 'go'));
  assert.ok(elements.some((e) => e.type === 'diamond'));
  assert.equal(elements.filter((e) => e.type === 'ellipse').length, 3);
});

test('class diagrams produce member tables and relationship caps', () => {
  const { elements, warnings } = convert(`classDiagram
    class Animal {
      +String name
      +eat()
    }
    Duck : +swim()
    Animal <|-- Duck
    Zoo "1" o-- "*" Animal : houses
    A ..> B`);
  assert.deepEqual(warnings, []);
  const animal = elements.find((e) => e.type === 'table' && e.cells[0][0] === 'Animal');
  assert.equal(animal.cells[1][0], '+String name\n+eat()');
  assert.ok(elements.some((e) => e.type === 'table' && e.cells[1]?.[0] === '+swim()'));
  const c = conns(elements);
  assert.equal(c[0].startCap, 'arrow');
  assert.equal(c[1].startCap, 'dot');
  assert.equal(c[1].label, '1 : houses : *');
  assert.equal(c[2].dash, 'dashed');
  assert.equal(c[2].endCap, 'open');
});

test('ER diagrams produce attribute tables and cardinality labels', () => {
  const { elements, warnings } = convert(`erDiagram
    CUSTOMER ||--o{ ORDER : places
    CUSTOMER {
      string name PK "the name"
    }
    ORDER }|..|{ ITEM : has`);
  assert.deepEqual(warnings, []);
  const c = conns(elements);
  assert.equal(c[0].label, 'places\n1 : 0..*');
  assert.equal(c[1].dash, 'dashed');
  assert.equal(elements.find((e) => e.type === 'table').cells[1][0], 'string name PK');
});

test('unreadable statements warn with a line number and the rest converts', () => {
  const { elements, warnings } = convert('flowchart TD\n A --> B\n A --> \n C --> D');
  assert.equal(shapes(elements).length, 4);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 3);
});

test('errors are clear', () => {
  const fails = (code, pattern) => assert.throws(() => convert(code), (e) => e instanceof MermaidError && pattern.test(e.message), code);
  fails('', /Enter some Mermaid/);
  fails('hello world', /must start with a type/);
  fails('pie title Pets\n "Dogs": 3', /"pie" diagrams aren't supported/);
  fails('flowchart TD', /No nodes/);
  fails('sequenceDiagram', /No participants/);
});

test('hostile labels are escaped on output', () => {
  const { elements } = convert('flowchart TD\n A["#lt;script#gt;alert(1)#lt;/script#gt;"] --> B["&lt;img onerror=x&gt;"]');
  const { svg } = buildSvg(elements, null, { measure });
  assert.ok(!svg.includes('<script') && !svg.includes('<img'));
});

test('huge or deep input stays bounded', () => {
  const chain = Array.from({ length: 400 }, (_, i) => `n${i} --> n${i + 1}`).join('\n');
  const started = Date.now();
  assert.equal(conns(convert(`flowchart TD\n${chain}`).elements).length, 400);
  assert.ok(Date.now() - started < 3000);
  assert.throws(() => convert(`flowchart TD\n${'x'.repeat(200001)}`), /too large/);
  const many = Array.from({ length: 2100 }, (_, i) => `n${i}`).join('\n');
  assert.throws(() => convert(`flowchart TD\n${many}`), /limited/);
});

test('waypoints follow a whole-diagram move, then give way when one end moves', () => {
  const { elements } = convert('flowchart TD\n A --> B --> C\n A --> C');
  const ids = map(elements);
  const long = conns(elements).find((c) => ids.get(c.start.id).text === 'A' && ids.get(c.end.id).text === 'C');
  const before = routeConnector(long, ids).pts;
  const moved = elements.map((e) => translate(e, 500, 300));
  const after = routeConnector(moved.find((e) => e.id === long.id), map(moved)).pts;
  assert.equal(after.length, before.length);
  assert.equal(after[1].x, before[1].x + 500);
  const c = elements.map((e) => (e.text === 'C' ? { ...e, x: e.x + 300 } : e));
  const rerouted = routeConnector(long, map(c)).pts;
  assert.notDeepEqual(rerouted.map((p) => p.x), before.map((p) => p.x + 0));
});

test('waypoints survive a save and reload, and bad ones are dropped', () => {
  const { elements } = convert('flowchart TD\n A --> B --> C\n A --> C');
  const copy = normalizeElements(JSON.parse(JSON.stringify(elements)));
  assert.ok(conns(copy).some((c) => c.via?.pts.length));
  const bad = normalizeElements([{ type: 'connector', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, via: { pts: [{ x: 'a' }] } }]);
  assert.equal(bad[0].via, undefined);
});

test('paste detection recognises Mermaid but not ordinary text', () => {
  assert.equal(looksLikeMermaid('flowchart TD\n A --> B'), true);
  assert.equal(looksLikeMermaid('```mermaid\nsequenceDiagram\nA->>B: hi\n```'), true);
  assert.equal(looksLikeMermaid('graph theory is fun\nand so are trees'), false);
  assert.equal(looksLikeMermaid('flowchart TD'), false);
  assert.equal(looksLikeMermaid('hello'), false);
});

test('every example converts without warnings', () => {
  const dir = new URL('../examples/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mmd'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const { elements, warnings } = convert(readFileSync(new URL(f, dir), 'utf8'));
    assert.deepEqual(warnings, [], f);
    assert.ok(elements.length > 2, f);
  }
});
