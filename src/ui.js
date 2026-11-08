// Toolbar, inspector, board strip, menus and export dialog.
import { createElement, hasFill, hasText, SHAPE_TYPES } from './model.js';
import { ICONS, ICON_NAMES } from './icons.js';
import { buildSvg, downloadBlob, fitScale, rasterize, safeFilename } from './export.js';
import { esc } from './render.js';
import { looksLikeMermaid, mermaidToElements } from './mermaid.js';
import { displayHost, parseHttpUrl, parsePastedUrls } from './links.js';

const $ = (sel) => document.querySelector(sel);
const svg = (paths) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${paths.map((d) => `<path d="${esc(d)}"/>`).join('')}</svg>`;
const I = {
  select: svg(['M5 3l14 8-6 2-3 6z']),
  hand: svg(['M8 12V5a1.5 1.5 0 0 1 3 0v6', 'M11 11V4a1.5 1.5 0 0 1 3 0v7', 'M14 11V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6 7-3 0-4.5-1.5-6-4l-2-4c-.8-1.5 1.2-2.5 2.2-1.300L8 14']),
  shape: svg(['M4 4h10v10H4z', 'M20 15a4.5 4.5 0 1 1-9 0']),
  connector: svg(['M4 19h6a3 3 0 0 0 3-3V8a3 3 0 0 1 3-3h4', 'M17 2l3 3-3 3']),
  text: svg(['M5 6V4h14v2', 'M12 4v16', 'M9 20h6']),
  sticky: svg(['M4 4h16v11l-5 5H4z', 'M20 15h-5v5']),
  pen: svg(['M4 20l1-4L16 5a2 2 0 0 1 3 3L8 19z', 'M14 7l3 3']),
  table: svg(['M3 5h18v14H3z', 'M3 10h18', 'M9 10v9', 'M15 10v9']),
  icons: svg(['M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.200L12 17l-5.6 3 1.2-6.200L3 9.500l6.3-.8z']),
  mermaid: svg(['M4 4h7v5H4z', 'M13 15h7v5h-7z', 'M7.5 9v5a3 3 0 0 0 3 3H13', 'M16 4l4 3-4 3']),
  link: svg(['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1']),
  image: svg(['M3 5h18v14H3z', 'M3 16l5-5 4 4 3-3 6 6', 'M15.5 9h.01']),
  undo: svg(['M8 5L4 9l4 4', 'M4 9h10a6 6 0 0 1 0 12h-3']),
  redo: svg(['M16 5l4 4-4 4', 'M20 9H10a6 6 0 0 0 0 12h3']),
  plus: svg(['M12 5v14', 'M5 12h14']),
  minus: svg(['M5 12h14']),
  alLeft: svg(['M4 3v18', 'M8 7h10v4H8z', 'M8 14h6v4H8z']),
  alH: svg(['M12 3v18', 'M6 7h12v4H6z', 'M8 14h8v4H8z']),
  alRight: svg(['M20 3v18', 'M6 7h10v4H6z', 'M10 14h6v4h-6z']),
  alTop: svg(['M3 4h18', 'M7 8v10h4V8z', 'M14 8v6h4V8z']),
  alV: svg(['M3 12h18', 'M7 6v12h4V6z', 'M14 8v8h4V8z']),
  alBottom: svg(['M3 20h18', 'M7 6v10h4V6z', 'M14 10v6h4v-6z']),
  distH: svg(['M4 3v18', 'M20 3v18', 'M10 7h4v10h-4z']),
  distV: svg(['M3 4h18', 'M3 20h18', 'M7 10h10v4H7z']),
  txtL: svg(['M4 6h16', 'M4 12h10', 'M4 18h13']),
  txtC: svg(['M4 6h16', 'M7 12h10', 'M5.5 18h13']),
  txtR: svg(['M4 6h16', 'M10 12h10', 'M7 18h13']),
};

const SHAPE_ICONS = {
  rect: 'M4 6h16a0 0 0 0 1 0 0v12H4z',
  ellipse: 'M3 12a9 7 0 1 0 18 0a9 7 0 1 0-18 0',
  diamond: 'M12 3l9 9-9 9-9-9z',
  hexagon: 'M7.5 5h9L21 12l-4.5 7h-9L3 12z',
  parallelogram: 'M7 5h14l-4 14H3z',
  cylinder: 'M5 6c0-3 14-3 14 0v12c0 3-14 3-14 0zM5 6c0 3 14 3 14 0',
};

const PALETTE = ['#111111', '#ffffff', '#a8a8a8', '#bcc5ce', '#ffd6d6', '#ffd966', '#b7e4c7', '#a5d8ff', '#d0bfff', '#e03131', '#1971c2', '#0f6b5c'];

export function createUI(editor, app) {
  const toast = (() => {
    const node = $('#toast');
    let timer;
    return (msg) => {
      node.textContent = msg;
      node.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => { node.hidden = true; }, 2800);
    };
  })();

  // ---- Tool rail ----
  const TOOLS = [
    { id: 'select', icon: I.select, title: 'Select (V)' },
    { id: 'hand', icon: I.hand, title: 'Pan (H, or hold Space)' },
    { sep: true },
    { id: 'shape', icon: I.shape, title: 'Shapes (R)', flyout: 'shapes' },
    { id: 'connector', icon: I.connector, title: 'Connector (C)' },
    { id: 'text', icon: I.text, title: 'Text (T)' },
    { id: 'sticky', icon: I.sticky, title: 'Sticky note (N)' },
    { id: 'pen', icon: I.pen, title: 'Pen (P)' },
    { id: 'table', icon: I.table, title: 'Table: drag to draw' },
    { sep: true },
    { id: 'icons', icon: I.icons, title: 'Icons', flyout: 'icons' },
    { id: 'link', icon: I.link, title: 'Add link with preview (L)' },
    { id: 'image', icon: I.image, title: 'Upload image' },
    { id: 'mermaid', icon: I.mermaid, title: 'Create from Mermaid code (M)' },
  ];
  const rail = $('#tools');
  rail.innerHTML = TOOLS.map((t) => (t.sep ? '<div class="tool-sep"></div>'
    : `<button class="tool" data-tool="${t.id}" title="${esc(t.title)}" aria-label="${esc(t.title)}">${t.icon}${t.flyout ? '<span class="caret"></span>' : ''}</button>`)).join('');

  const flyout = $('#flyout');
  const closeFlyout = () => { flyout.hidden = true; };
  rail.addEventListener('click', (e) => {
    const id = e.target.closest('[data-tool]')?.dataset.tool;
    if (!id) return;
    if (id === 'shape') { editor.setTool('shape'); showShapes(); return; }
    if (id === 'icons') { showIcons(); return; }
    closeFlyout();
    if (id === 'image') { $('#image-input').click(); return; }
    if (id === 'mermaid') { openMermaid(); return; }
    if (id === 'link') { promptForLink(); return; }
    editor.setTool(id);
  });

  function showShapes() {
    flyout.innerHTML = `<h3>Shapes: pick one, then drag on the board</h3><div class="grid-pick">${
      SHAPE_TYPES.map((t) => `<button data-shape="${t}" title="${t}" aria-label="${t}"><svg viewBox="0 0 24 24"><path d="${SHAPE_ICONS[t]}"/></svg></button>`).join('')}</div>`;
    flyout.hidden = false;
  }

  function iconGrid(filter = '') {
    const names = ICON_NAMES.filter((n) => n.includes(filter.toLowerCase()));
    if (!names.length) return '<p class="none">No matching icons.</p>';
    return `<div class="grid-pick">${names.map((name) => `<button data-icon="${name}" title="${name}" aria-label="${name}"><svg viewBox="0 0 24 24">${ICONS[name].map((d) => `<path d="${esc(d)}"/>`).join('')}</svg></button>`).join('')}</div>`;
  }

  function showIcons() {
    flyout.innerHTML = `<h3>Icons: click to place</h3><input type="search" placeholder="Search icons" aria-label="Search icons"><div class="results">${iconGrid()}</div>`;
    flyout.hidden = false;
    const input = flyout.querySelector('input');
    input.addEventListener('input', () => { flyout.querySelector('.results').innerHTML = iconGrid(input.value); });
    input.focus();
  }

  flyout.addEventListener('click', (e) => {
    const shape = e.target.closest('[data-shape]')?.dataset.shape;
    if (shape) { editor.setTool('shape', shape); closeFlyout(); return; }
    const icon = e.target.closest('[data-icon]')?.dataset.icon;
    if (icon) { editor.placeAtCenter('icon', { icon, text: icon[0].toUpperCase() + icon.slice(1) }); closeFlyout(); }
  });

  editor.on('canvasdown', () => { closeFlyout(); closeMenus(); });
  editor.on('tool', () => {
    rail.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === editor.tool));
  });
  rail.querySelector('[data-tool=select]').classList.add('active');

  // ---- Links ----
  function promptForLink() {
    const text = prompt('Paste a web address');
    if (text == null) return;
    const urls = parsePastedUrls(text);
    if (urls.length) editor.addLinks(urls);
    else toast('That is not a valid web address. It should start with http:// or https://.');
  }
  function openLink(el) {
    const url = parseHttpUrl(el.url);
    if (url) window.open(url.href, '_blank', 'noopener,noreferrer');
  }
  editor.on('openlink', openLink);

  // ---- Images ----
  async function addImageFile(file, at) {
    if (!/^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(file.type)) return toast('That file type is not supported. Use PNG, JPEG, GIF, WebP or SVG.');
    const src = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const img = new Image();
    img.src = src;
    try { await img.decode(); } catch { return toast(`Could not read ${file.name}.`); }
    editor.addImage(src, img.naturalWidth || 300, img.naturalHeight || 200, at);
    return undefined;
  }
  $('#image-input').addEventListener('change', async (e) => {
    if (e.target.files[0]) await addImageFile(e.target.files[0]);
    e.target.value = '';
  });
  const stage = $('#stage');
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('drop', async (e) => {
    e.preventDefault();
    const at = editor.toWorld(e.clientX, e.clientY);
    if (!e.dataTransfer.files.length) {
      const dropped = parsePastedUrls(e.dataTransfer.getData('text/uri-list').replace(/^#.*$/gm, '') || e.dataTransfer.getData('text/plain'));
      if (dropped.length) editor.addLinks(dropped, at);
      return;
    }
    for (const file of e.dataTransfer.files) {
      if (file.type.startsWith('image/')) await addImageFile(file, at);
      else if (/\.(mmd|mermaid)$/i.test(file.name)) openMermaid(await file.text());
      else if (file.name.endsWith('.json')) await app.importFile(file).catch((err) => toast(err.message));
    }
  });

  // ---- Top bar ----
  $('#undo').innerHTML = I.undo; $('#redo').innerHTML = I.redo;
  $('#zoom-in').innerHTML = I.plus; $('#zoom-out').innerHTML = I.minus;
  $('#add-board').innerHTML = I.plus;
  $('#undo').onclick = () => editor.undo();
  $('#redo').onclick = () => editor.redo();
  $('#zoom-in').onclick = () => editor.zoomBy(1.2);
  $('#zoom-out').onclick = () => editor.zoomBy(1 / 1.2);
  $('#zoom-level').onclick = () => editor.setZoom(1);
  $('#zoom-fit').onclick = () => editor.zoomToFit();
  $('#export-btn').onclick = () => openExport();
  $('#add-board').onclick = () => app.addBoard();

  const nameInput = $('#board-name');
  nameInput.addEventListener('change', () => app.renameBoard(editor.board.id, nameInput.value));
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur(); e.stopPropagation(); });

  editor.on('history', () => {
    const h = editor.history();
    $('#undo').disabled = !h.undo.length;
    $('#redo').disabled = !h.redo.length;
  });
  editor.on('view', () => { $('#zoom-level').textContent = `${Math.round(editor.board.view.zoom * 100)}%`; });

  // ---- File menu ----
  const fileMenu = $('#file-menu'), fileBtn = $('#file-btn'), boardMenu = $('#board-menu');
  function closeMenus() {
    fileMenu.hidden = true; boardMenu.hidden = true;
    fileBtn.setAttribute('aria-expanded', 'false');
  }
  fileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = fileMenu.hidden;
    closeMenus();
    fileMenu.hidden = !open;
    fileBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', closeMenus);
  fileMenu.addEventListener('click', (e) => {
    const action = e.target.closest('[data-file]')?.dataset.file;
    if (action === 'new') app.addBoard();
    if (action === 'window') app.openWindow(editor.board.id);
    if (action === 'open') $('#file-input').click();
    if (action === 'mermaid') openMermaid();
    if (action === 'save') app.saveBoardFile();
    if (action === 'backup') app.saveBackupFile();
    if (action === 'png') openExport();
  });
  $('#file-input').addEventListener('change', async (e) => {
    const picked = e.target.files[0];
    if (picked && /\.(mmd|mermaid)$/i.test(picked.name)) { openMermaid(await picked.text()); e.target.value = ''; return; }
    if (e.target.files[0]) await app.importFile(e.target.files[0]).catch((err) => toast(`Import failed: ${err.message}`));
    e.target.value = '';
  });

  // ---- Inspector ----
  const panel = $('#inspector');
  let signature = '';

  function colorRow(label, key, value, allowNone) {
    const swatches = PALETTE.map((c) => `<button class="swatch${c === value ? ' on' : ''}" style="background:${c}" data-patch="${key}" data-value="${c}" title="${c}" aria-label="${label} ${c}"></button>`).join('');
    const none = allowNone ? `<button class="swatch none${value === 'none' ? ' on' : ''}" data-patch="${key}" data-value="none" title="None" aria-label="No ${label}"></button>` : '';
    const custom = `<label class="swatch custom" title="Custom colour"><input type="color" data-color="${key}" aria-label="Custom ${label}" value="${/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}"></label>`;
    return `<div class="row"><label>${label}</label></div><div class="swatches" style="margin-bottom:8px">${none}${swatches}${custom}</div>`;
  }

  function seg(key, options, value) {
    return `<div class="seg">${options.map(([v, label, title]) => `<button class="${v === value ? 'on' : ''}" data-patch="${key}" data-value="${esc(v)}" title="${esc(title || label)}" aria-label="${esc(title || label)}">${label}</button>`).join('')}</div>`;
  }

  const common = (list, key) => {
    const vals = new Set(list.filter((el) => key in el).map((el) => el[key]));
    return vals.size === 1 ? [...vals][0] : undefined;
  };

  function renderInspector() {
    if (!editor.board) return;
    const active = document.activeElement;
    if (panel.contains(active) && active.tagName === 'INPUT' && active.type !== 'color' && active.type !== 'range') return;
    const sel = editor.selectedElements();
    const sig = JSON.stringify(sel.map((el) => [el.id, el.fill, el.stroke, el.strokeWidth, el.dash, el.fontSize, el.fontWeight, el.align, el.valign, el.textColor, el.route, el.startCap, el.endCap, el.radius, el.opacity, el.titleRow, el.headerFill, el.cells?.length, el.cells?.[0]?.length, el.groups?.length, el.status, el.title]));
    if (sig === signature && sel.length) return;
    signature = sig;
    panel.classList.toggle('idle', !sel.length);
    if (!sel.length) {
      panel.innerHTML = `<div class="section"><h3>Board</h3><p class="note">${editor.elements.length} item${editor.elements.length === 1 ? '' : 's'}. Select items to style them or export just those as a PNG. Drag across the board to select several.</p></div>
      <div class="section"><h3>Shortcuts</h3><div class="keys">
        <span><kbd>V</kbd> <kbd>H</kbd></span><span>Select, pan</span>
        <span><kbd>R</kbd> <kbd>C</kbd> <kbd>T</kbd> <kbd>N</kbd> <kbd>P</kbd></span><span>Shape, connector, text, note, pen</span>
        <span><kbd>Space</kbd>+drag</span><span>Pan</span>
        <span><kbd>M</kbd></span><span>Create from Mermaid code</span>
        <span><kbd>L</kbd></span><span>Add link (or paste a URL)</span>
        <span><kbd>Ctrl</kbd>+<kbd>G</kbd></span><span>Group</span>
        <span><kbd>Ctrl</kbd>+<kbd>D</kbd></span><span>Duplicate</span>
        <span><kbd>[</kbd> <kbd>]</kbd></span><span>Send back, bring front</span>
        <span><kbd>Alt</kbd>+drag</span><span>Move without snapping</span>
      </div></div>`;
      return;
    }
    const types = new Set(sel.map((el) => el.type));
    const anyFill = sel.some((el) => hasFill(el.type));
    const anyStroke = sel.some((el) => 'stroke' in el);
    const anyText = sel.some((el) => hasText(el.type) || el.type === 'connector' || el.type === 'table');
    const connectors = sel.filter((el) => el.type === 'connector');
    let html = '';

    html += `<div class="section"><button class="primary btn-wide" data-cmd="export">Export ${sel.length === 1 ? 'item' : `${sel.length} items`} as PNG</button></div>`;

    {
      html += '<div class="section"><h3>Style</h3>';
      if (anyFill) html += colorRow('Fill', 'fill', common(sel, 'fill'), true);
      if (anyStroke) {
        html += colorRow('Stroke', 'stroke', common(sel, 'stroke'), sel.every((el) => el.type !== 'connector' && el.type !== 'pen'));
        const notIcon = sel.some((el) => 'strokeWidth' in el);
        if (notIcon) html += `<div class="row"><label for="sw">Width</label><input id="sw" class="num" type="number" min="0" max="40" step="0.5" data-num="strokeWidth" value="${common(sel, 'strokeWidth') ?? ''}"></div>`;
        if (sel.some((el) => 'dash' in el)) {
          html += `<div class="row"><label>Line</label>${seg('dash', [['solid', 'Solid'], ['dashed', 'Dash'], ['dotted', 'Dot']], common(sel, 'dash'))}</div>`;
        }
      }
      if (types.size === 1 && types.has('rect')) html += `<div class="row"><label for="rad">Corners</label><input id="rad" class="range" type="range" min="0" max="60" data-range="radius" value="${common(sel, 'radius') ?? 0}"></div>`;
      html += `<div class="row"><label for="opa">Opacity</label><input id="opa" class="range" type="range" min="0.1" max="1" step="0.05" data-range="opacity" value="${common(sel, 'opacity') ?? 1}"></div>`;
      html += '</div>';
    }

    if (anyText) {
      html += '<div class="section"><h3>Text</h3>';
      html += `<div class="row"><label for="fs">Size</label><input id="fs" class="num" type="number" min="6" max="200" data-num="fontSize" value="${common(sel, 'fontSize') ?? ''}"></div>`;
      if (sel.some((el) => 'fontWeight' in el)) html += `<div class="row"><label>Weight</label>${seg('fontWeight', [[400, 'Regular'], [600, 'Semi'], [700, 'Bold']], common(sel, 'fontWeight'))}</div>`;
      if (sel.some((el) => 'align' in el && el.type !== 'icon')) {
        html += `<div class="row"><label>Align</label>${seg('align', [['left', I.txtL, 'Left'], ['center', I.txtC, 'Centre'], ['right', I.txtR, 'Right']], common(sel, 'align'))}</div>`;
        html += `<div class="row"><label>Vertical</label>${seg('valign', [['top', 'Top'], ['middle', 'Mid'], ['bottom', 'Btm']], common(sel, 'valign'))}</div>`;
      }
      html += colorRow('Colour', 'textColor', common(sel, 'textColor'), false);
      html += '<p class="note">Double-click to edit. Wrap words in <kbd>**</kbd> for bold.</p></div>';
    }

    if (connectors.length) {
      const caps = [['none', 'None'], ['arrow', 'Arrow'], ['open', 'Open'], ['dot', 'Dot'], ['cross', '×']];
      html += '<div class="section"><h3>Connector</h3>';
      html += `<div class="row"><label>Route</label>${seg('route', [['elbow', 'Elbow'], ['straight', 'Line'], ['curve', 'Curve']], common(connectors, 'route'))}</div>`;
      html += `<div class="row"><label>Start</label>${seg('startCap', caps, common(connectors, 'startCap'))}</div>`;
      html += `<div class="row"><label>End</label>${seg('endCap', caps, common(connectors, 'endCap'))}</div>`;
      if (connectors.length === 1) html += '<p class="note">Double-click the line to add a label, then drag the label along it.</p>';
      html += '</div>';
    }

    if (sel.length === 1 && sel[0].type === 'link') {
      const l = sel[0];
      const state = { loading: 'Loading preview…', failed: 'No preview available for this address. The link still works.' }[l.status];
      html += `<div class="section"><h3>Link</h3>
        <p class="note link-host" title="${esc(l.url)}">${esc(displayHost(l.url))}</p>
        ${state ? `<p class="note">${esc(state)}</p>` : ''}
        <div class="row"><label for="link-title">Title</label><input id="link-title" class="text" data-str="title" value="${esc(l.title)}"></div>
        <div class="row"><button class="btn" data-cmd="link-open">Open link</button><button class="btn" data-cmd="link-refresh" ${l.status === 'loading' ? 'disabled' : ''}>Refresh preview</button></div>
        <p class="note">Double-click the card to open it.</p></div>`;
    }

    if (sel.length === 1 && sel[0].type === 'table') {
      const t = sel[0];
      html += `<div class="section"><h3>Table</h3>
        <div class="row"><label>Rows</label><button class="btn" data-cmd="row-" ${t.cells.length < 2 ? 'disabled' : ''}>Remove</button><button class="btn" data-cmd="row+">Add</button></div>
        <div class="row"><label>Columns</label><button class="btn" data-cmd="col-" ${t.cells[0].length < 2 ? 'disabled' : ''}>Remove</button><button class="btn" data-cmd="col+">Add</button></div>
        <div class="row"><label><input type="checkbox" data-check="titleRow" ${t.titleRow ? 'checked' : ''}> Title row</label></div>
        ${t.titleRow ? colorRow('Title fill', 'headerFill', t.headerFill, false) : ''}</div>`;
    }

    const multi = sel.filter((el) => el.type !== 'connector').length;
    const isGrouped = sel.some((el) => el.groups?.length);
    html += '<div class="section"><h3>Arrange</h3>';
    html += `<div class="row"><button class="btn" data-cmd="group" ${sel.length < 2 ? 'disabled' : ''}>Group</button><button class="btn" data-cmd="ungroup" ${isGrouped ? '' : 'disabled'}>Ungroup</button></div>`;
    html += '<div class="row"><button class="btn" data-cmd="front">To front</button><button class="btn" data-cmd="back">To back</button></div>';
    if (multi >= 2) {
      html += `<div class="row"><div class="seg">
        <button data-cmd="al:left" title="Align left" aria-label="Align left">${I.alLeft}</button>
        <button data-cmd="al:hcenter" title="Align centres horizontally" aria-label="Align centres horizontally">${I.alH}</button>
        <button data-cmd="al:right" title="Align right" aria-label="Align right">${I.alRight}</button>
        <button data-cmd="al:top" title="Align top" aria-label="Align top">${I.alTop}</button>
        <button data-cmd="al:vcenter" title="Align centres vertically" aria-label="Align centres vertically">${I.alV}</button>
        <button data-cmd="al:bottom" title="Align bottom" aria-label="Align bottom">${I.alBottom}</button>
      </div></div>`;
    }
    if (multi >= 3) html += `<div class="row"><div class="seg"><button data-cmd="dist:h" title="Distribute horizontally" aria-label="Distribute horizontally">${I.distH}</button><button data-cmd="dist:v" title="Distribute vertically" aria-label="Distribute vertically">${I.distV}</button></div></div>`;
    html += '<div class="row"><button class="btn" data-cmd="duplicate">Duplicate</button><button class="btn" data-cmd="delete">Delete</button></div></div>';
    panel.innerHTML = html;
  }

  panel.addEventListener('click', (e) => {
    const patchBtn = e.target.closest('[data-patch]');
    if (patchBtn) {
      const key = patchBtn.dataset.patch;
      const raw = patchBtn.dataset.value;
      editor.patchSelected({ [key]: key === 'fontWeight' ? Number(raw) : raw });
      return;
    }
    const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
    if (!cmd) return;
    if (cmd === 'export') openExport();
    else if (cmd === 'link-open') openLink(editor.selectedElements()[0]);
    else if (cmd === 'link-refresh') editor.patchUntracked(editor.board, editor.selectedElements()[0].id, { status: 'loading' });
    else if (cmd === 'group') editor.group();
    else if (cmd === 'ungroup') editor.ungroup();
    else if (cmd === 'front') editor.reorder('front');
    else if (cmd === 'back') editor.reorder('back');
    else if (cmd === 'duplicate') editor.duplicate();
    else if (cmd === 'delete') editor.deleteSelected();
    else if (cmd.startsWith('al:')) editor.align(cmd.slice(3));
    else if (cmd.startsWith('dist:')) editor.distribute(cmd.slice(5));
    else if (cmd === 'row+') editor.tableEdit((c) => [...c, c[0].map(() => '')]);
    else if (cmd === 'row-') editor.tableEdit((c) => c.slice(0, -1));
    else if (cmd === 'col+') editor.tableEdit((c) => c.map((r) => [...r, '']));
    else if (cmd === 'col-') editor.tableEdit((c) => c.map((r) => r.slice(0, -1)));
  });
  panel.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.color) editor.patchSelected({ [t.dataset.color]: t.value }, { coalesceKey: `c:${t.dataset.color}` });
    if (t.dataset.range) editor.patchSelected({ [t.dataset.range]: Number(t.value) }, { coalesceKey: `r:${t.dataset.range}` });
    if (t.dataset.num && t.value !== '' && Number(t.value) >= Number(t.min)) editor.patchSelected({ [t.dataset.num]: Number(t.value) }, { coalesceKey: `n:${t.dataset.num}` });
    if (t.dataset.str) editor.patchSelected({ [t.dataset.str]: t.value.slice(0, 300) }, { coalesceKey: `s:${t.dataset.str}` });
    if (t.dataset.check) editor.patchSelected({ [t.dataset.check]: t.checked });
  });
  panel.addEventListener('keydown', (e) => e.stopPropagation());
  panel.addEventListener('focusout', () => setTimeout(renderInspector));
  editor.on('selection', renderInspector);

  // ---- Export dialog ----
  const dialog = $('#export-dialog'), form = $('#export-form');
  let previewUrl = null;

  function currentExport() {
    const f = form.elements;
    const ids = f.scope.value === 'selection' ? [...editor.selection] : null;
    return buildSvg(editor.elements, ids, {
      padding: Math.max(0, Number(f.padding.value) || 0),
      background: f.bg.value || null,
      includeConnectors: f.connectors.checked,
    });
  }

  function refreshExport() {
    const data = currentExport();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([data.svg], { type: 'image/svg+xml' }));
    $('#export-preview').src = previewUrl;
    const scale = Number(form.elements.scale.value);
    const effective = fitScale(data.width, data.height, scale);
    const shrunk = effective < scale ? ` Reduced from ${scale}× to fit browser limits.` : '';
    $('#export-size').textContent = `${Math.round(data.width * effective)} × ${Math.round(data.height * effective)} px, ${data.count} item${data.count === 1 ? '' : 's'}.${shrunk}`;
    $('#export-error').textContent = '';
    const empty = data.count === 0;
    $('#export-download').disabled = empty;
    $('#export-copy').disabled = empty;
    if (empty) $('#export-size').textContent = 'This board is empty, so there is nothing to export.';
    $('#connector-option').hidden = form.elements.scope.value !== 'selection';
  }

  function openExport() {
    editor.commitEdit();
    const f = form.elements;
    const hasSel = editor.selection.size > 0;
    f.scope[0].disabled = !hasSel;
    $('#scope-selection').textContent = hasSel ? `Selected items (${editor.selection.size})` : 'Selected items (none)';
    f.scope.value = hasSel ? 'selection' : 'board';
    refreshExport();
    dialog.showModal();
  }

  form.addEventListener('input', refreshExport);
  form.addEventListener('change', refreshExport);
  form.addEventListener('submit', (e) => e.preventDefault());
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  $('#export-cancel').onclick = () => dialog.close();

  const exportName = () => {
    const part = form.elements.scope.value === 'selection' ? '-selection' : '';
    return `${safeFilename(editor.board.name)}${part}.png`;
  };
  $('#export-download').onclick = async () => {
    try {
      const { blob, width, height } = await rasterize(currentExport(), Number(form.elements.scale.value));
      downloadBlob(blob, exportName());
      dialog.close();
      toast(`Saved ${exportName()} (${width} × ${height} px).`);
    } catch (err) {
      $('#export-error').textContent = err.message;
    }
  };
  $('#export-copy').onclick = async () => {
    try {
      const { blob } = await rasterize(currentExport(), Number(form.elements.scale.value));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      dialog.close();
      toast('PNG copied to clipboard.');
    } catch (err) {
      $('#export-error').textContent = `Could not copy: ${err.message}. Your browser may block image clipboard access, so try Download.`;
    }
  };

  // ---- Mermaid dialog ----
  const mermaidDialog = $('#mermaid-dialog'), mermaidCode = $('#mermaid-code');
  let mermaidTimer = null, mermaidUrl = null, mermaidResult = null;

  function refreshMermaid() {
    clearTimeout(mermaidTimer);
    mermaidResult = null;
    const list = $('#mermaid-warnings');
    const img = $('#mermaid-preview');
    list.replaceChildren();
    $('#mermaid-error').textContent = '';
    const code = mermaidCode.value;
    if (code.trim()) {
      try {
        mermaidResult = mermaidToElements(code);
        const { svg: preview } = buildSvg(mermaidResult.elements, null, { padding: 16, background: '#ffffff' });
        if (mermaidUrl) URL.revokeObjectURL(mermaidUrl);
        mermaidUrl = URL.createObjectURL(new Blob([preview], { type: 'image/svg+xml' }));
        img.src = mermaidUrl;
        for (const w of mermaidResult.warnings) {
          const li = document.createElement('li');
          li.textContent = w.line ? `Line ${w.line}: ${w.message}` : w.message;
          list.append(li);
        }
      } catch (err) {
        $('#mermaid-error').textContent = err.name === 'MermaidError' ? err.message : `Could not convert this diagram: ${err.message}`;
      }
    }
    img.hidden = !mermaidResult;
    $('#mermaid-empty').hidden = !!mermaidResult;
    $('#mermaid-empty').textContent = code.trim() ? 'Fix the problem below to see a preview.' : 'Your diagram appears here as you type.';
    $('#mermaid-add').disabled = !mermaidResult;
    $('#mermaid-new').disabled = !mermaidResult;
  }

  function openMermaid(code) {
    editor.commitEdit();
    closeFlyout();
    closeMenus();
    if (code !== undefined) mermaidCode.value = code;
    refreshMermaid();
    mermaidDialog.showModal();
    mermaidCode.focus();
  }

  mermaidCode.addEventListener('input', () => {
    clearTimeout(mermaidTimer);
    mermaidTimer = setTimeout(refreshMermaid, 180);
  });
  mermaidCode.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    mermaidCode.setRangeText('  ', mermaidCode.selectionStart, mermaidCode.selectionEnd, 'end');
    mermaidCode.dispatchEvent(new Event('input'));
  });
  mermaidDialog.addEventListener('keydown', (e) => e.stopPropagation());
  $('#mermaid-form').addEventListener('submit', (e) => e.preventDefault());
  $('#mermaid-cancel').onclick = () => mermaidDialog.close();
  $('#mermaid-add').onclick = () => {
    refreshMermaid();
    if (!mermaidResult) return;
    editor.insertDiagram(mermaidResult.elements);
    mermaidDialog.close();
    mermaidCode.value = '';
  };
  $('#mermaid-new').onclick = async () => {
    refreshMermaid();
    if (!mermaidResult) return;
    const { elements, title } = mermaidResult;
    mermaidDialog.close();
    mermaidCode.value = '';
    await app.addBoardWith(title || 'Mermaid diagram', elements);
  };

  // ---- Board strip ----
  const thumbs = $('#thumbs');
  let menuBoard = null;
  let dragId = null;

  function renderStrip() {
    const list = app.boards;
    const existing = new Map([...thumbs.children].map((n) => [n.dataset.id, n]));
    list.forEach((board, i) => {
      let node = existing.get(board.id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'thumb';
        node.dataset.id = board.id;
        node.draggable = true;
        node.tabIndex = 0;
        node.setAttribute('role', 'button');
        node.innerHTML = '<img alt=""><span class="cap"></span><span class="more" role="button" aria-label="Board options" title="Board options">⋯</span>';
      }
      existing.delete(board.id);
      node.classList.toggle('active', board.id === editor.board?.id);
      node.querySelector('.cap').textContent = `${i + 1}  ${board.name}`;
      node.title = board.name;
      node.setAttribute('aria-label', `Board ${i + 1}: ${board.name}`);
      const url = app.thumbUrl(board);
      const img = node.querySelector('img');
      if (img.dataset.url !== url) { img.src = url; img.dataset.url = url; }
      if (thumbs.children[i] !== node) thumbs.insertBefore(node, thumbs.children[i] || null);
    });
    existing.forEach((n) => n.remove());
    nameInput.value = editor.board?.name || '';
    document.title = editor.board ? `${editor.board.name} · Inkfield` : 'Inkfield';
  }

  thumbs.addEventListener('click', (e) => {
    const node = e.target.closest('.thumb');
    if (!node) return;
    if (e.target.closest('.more')) {
      e.stopPropagation();
      openBoardMenu(node.dataset.id, e.clientX, e.clientY);
      return;
    }
    app.switchBoard(node.dataset.id);
  });
  thumbs.addEventListener('keydown', (e) => {
    const node = e.target.closest('.thumb');
    if (node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); app.switchBoard(node.dataset.id); }
  });
  thumbs.addEventListener('contextmenu', (e) => {
    const node = e.target.closest('.thumb');
    if (!node) return;
    e.preventDefault();
    openBoardMenu(node.dataset.id, e.clientX, e.clientY);
  });
  function openBoardMenu(id, x, y) {
    closeMenus();
    menuBoard = id;
    boardMenu.hidden = false;
    const r = boardMenu.getBoundingClientRect();
    boardMenu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    boardMenu.style.top = `${Math.max(8, y - r.height - 6)}px`;
  }
  boardMenu.addEventListener('click', (e) => {
    const action = e.target.closest('[data-board]')?.dataset.board;
    const board = app.boards.find((b) => b.id === menuBoard);
    if (!action || !board) return;
    if (action === 'rename') {
      const name = prompt('Rename board', board.name);
      if (name != null) app.renameBoard(board.id, name);
    }
    if (action === 'duplicate') app.duplicateBoard(board.id);
    if (action === 'window') app.openWindow(board.id);
    if (action === 'delete' && confirm(`Delete "${board.name}"? This cannot be undone.`)) app.deleteBoard(board.id);
  });

  thumbs.addEventListener('dragstart', (e) => {
    const node = e.target.closest('.thumb');
    if (!node) return;
    dragId = node.dataset.id;
    node.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  });
  thumbs.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    thumbs.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before'));
    e.target.closest('.thumb')?.classList.add('drop-before');
  });
  thumbs.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const target = e.target.closest('.thumb');
    app.moveBoard(dragId, target?.dataset.id || null);
  });
  thumbs.addEventListener('dragend', () => {
    dragId = null;
    thumbs.querySelectorAll('.dragging,.drop-before').forEach((n) => n.classList.remove('dragging', 'drop-before'));
  });

  // ---- Keyboard and clipboard ----
  const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

  document.addEventListener('keydown', (e) => {
    if (typing(e.target) || dialog.open || mermaidDialog.open) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.code === 'Space' && !e.repeat) { editor.spaceDown = true; editor.updateCursor(); e.preventDefault(); return; }
    if (mod) {
      const actions = {
        z: () => (e.shiftKey ? editor.redo() : editor.undo()),
        y: () => editor.redo(),
        a: () => editor.select(editor.elements.map((el) => el.id)),
        d: () => editor.duplicate(),
        g: () => (e.shiftKey ? editor.ungroup() : editor.group()),
        '=': () => editor.zoomBy(1.2),
        '+': () => editor.zoomBy(1.2),
        '-': () => editor.zoomBy(1 / 1.2),
        0: () => editor.setZoom(1),
        1: () => editor.zoomToFit(),
        e: () => (e.shiftKey ? openExport() : null),
      };
      if (actions[key] && !(key === 'e' && !e.shiftKey)) { e.preventDefault(); actions[key](); }
      return;
    }
    const tools = { v: 'select', h: 'hand', c: 'connector', t: 'text', n: 'sticky', p: 'pen' };
    if (tools[key]) { editor.setTool(tools[key]); closeFlyout(); return; }
    if (key === 'm') { openMermaid(); return; }
    if (key === 'l') { promptForLink(); return; }
    if (key === 'r') { editor.setTool('shape', 'rect'); closeFlyout(); return; }
    if (key === 'o') { editor.setTool('shape', 'ellipse'); closeFlyout(); return; }
    if (key === 'd') { editor.setTool('shape', 'diamond'); closeFlyout(); return; }
    if (e.key === 'Escape') { closeFlyout(); closeMenus(); editor.setTool('select'); editor.select([]); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editor.deleteSelected(); return; }
    if (e.key === ']') { editor.reorder('front'); return; }
    if (e.key === '[') { editor.reorder('back'); return; }
    if (e.key === 'Enter' && editor.selection.size === 1) {
      const el = editor.selectedElements()[0];
      if (hasText(el.type) || el.type === 'connector') { e.preventDefault(); editor.startEdit(el.id); }
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && editor.selection.size) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      editor.nudge(arrows[e.key][0] * step, arrows[e.key][1] * step);
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { editor.spaceDown = false; editor.updateCursor(); }
  });
  window.addEventListener('blur', () => { editor.spaceDown = false; editor.updateCursor(); });

  document.addEventListener('copy', (e) => {
    if (typing(e.target) || !editor.selection.size) return;
    e.clipboardData.setData('text/plain', editor.serializeSelection());
    e.preventDefault();
  });
  document.addEventListener('cut', (e) => {
    if (typing(e.target) || !editor.selection.size) return;
    e.clipboardData.setData('text/plain', editor.serializeSelection());
    e.preventDefault();
    editor.deleteSelected();
  });
  document.addEventListener('paste', async (e) => {
    if (typing(e.target) || dialog.open || mermaidDialog.open) return;
    const image = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (image) { e.preventDefault(); await addImageFile(image); return; }
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (editor.pasteSerialized(text)) return;
    if (looksLikeMermaid(text)) { openMermaid(text); return; }
    const urls = parsePastedUrls(text);
    if (urls.length) { editor.addLinks(urls); return; }
    const c = editor.viewCenter();
    const el = createElement('text', { text, x: c.x - 110, y: c.y - 12 });
    editor.addElements([el]);
  });

  return { renderStrip, renderInspector, toast, openExport, openMermaid };
}
