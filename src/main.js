// Boot, board management, persistence and multi-window sync.
import { Editor } from './editor.js';
import { createBoard, normalizeBoard, parseImport } from './model.js';
import { createStore } from './store.js';
import { createUI } from './ui.js';
import { buildSvg, downloadBlob, safeFilename } from './export.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const editor = new Editor(document.getElementById('stage'));

const app = {
  boards: [],
  thumbs: new Map(),

  thumbUrl(board) {
    const cached = this.thumbs.get(board.id);
    if (cached?.rev === board.rev) return cached.url;
    if (cached) URL.revokeObjectURL(cached.url);
    const data = buildSvg(board.elements, null, { padding: 12, background: '#ffffff', idPrefix: `t${board.id}-` });
    const url = URL.createObjectURL(new Blob([data.svg], { type: 'image/svg+xml' }));
    this.thumbs.set(board.id, { rev: board.rev, url });
    return url;
  },

  find(id) { return this.boards.find((b) => b.id === id); },

  switchBoard(id) {
    const board = this.find(id);
    if (!board || board === editor.board) return;
    flushSave();
    editor.setBoard(board);
    const url = new URL(location.href);
    url.searchParams.set('board', id);
    history.replaceState(null, '', url);
    ui.renderStrip();
    ui.renderInspector();
  },

  async addBoard(board = createBoard(`Board ${this.boards.length + 1}`)) {
    const rect = editor.stageRect();
    if (!board.elements.length) board.view = { x: rect.width / 2, y: rect.height / 2, zoom: 1 };
    this.boards.push(board);
    await store.save(board);
    this.switchBoard(board.id);
    return board;
  },

  async addBoardWith(name, elements) {
    const board = createBoard(name.slice(0, 120), elements);
    this.boards.push(board);
    await store.save(board);
    this.switchBoard(board.id);
    editor.zoomToFit();
    return board;
  },

  async duplicateBoard(id) {
    const source = this.find(id);
    if (!source) return;
    const copy = { ...clone(source), id: createBoard().id, name: `${source.name} copy`, rev: 1 };
    const index = this.boards.indexOf(source);
    this.boards.splice(index + 1, 0, copy);
    await store.save(copy);
    await store.setOrder(this.boards.map((b) => b.id));
    this.switchBoard(copy.id);
  },

  renameBoard(id, name) {
    const board = this.find(id);
    const clean = String(name).trim().slice(0, 120);
    if (!board || !clean || clean === board.name) { ui.renderStrip(); return; }
    board.name = clean;
    board.rev += 1;
    store.save(board);
    ui.renderStrip();
  },

  async deleteBoard(id) {
    const index = this.boards.findIndex((b) => b.id === id);
    if (index < 0) return;
    this.boards.splice(index, 1);
    this.thumbs.delete(id);
    if (saveTimer && editor.board?.id === id) { clearTimeout(saveTimer); saveTimer = null; }
    await store.remove(id);
    if (!this.boards.length) { await this.addBoard(createBoard('Board 1')); return; }
    if (editor.board.id === id) this.switchBoard(this.boards[Math.min(index, this.boards.length - 1)].id);
    ui.renderStrip();
  },

  moveBoard(id, beforeId) {
    const board = this.find(id);
    if (!board || id === beforeId) return;
    this.boards.splice(this.boards.indexOf(board), 1);
    const at = beforeId ? this.boards.findIndex((b) => b.id === beforeId) : this.boards.length;
    this.boards.splice(at < 0 ? this.boards.length : at, 0, board);
    store.setOrder(this.boards.map((b) => b.id));
    ui.renderStrip();
  },

  openWindow(id) {
    flushSave();
    const url = new URL(location.href);
    url.searchParams.set('board', id);
    const win = window.open(url, '_blank', 'popup,width=1280,height=820');
    if (!win) ui.toast('Your browser blocked the new window. Allow pop-ups for this page.');
  },

  async importFile(file) {
    const boards = parseImport(await file.text());
    let last;
    for (const board of boards) {
      this.boards.push(board);
      await store.save(board);
      last = board;
    }
    this.switchBoard(last.id);
    if (!(last.view.x || last.view.y)) editor.zoomToFit();
    ui.toast(boards.length === 1 ? `Imported "${last.name}".` : `Imported ${boards.length} boards.`);
  },

  saveBoardFile() {
    flushSave();
    const { name, elements, view } = editor.board;
    const blob = new Blob([JSON.stringify({ name, elements, view }, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${safeFilename(name)}.inkfield.json`);
  },

  saveBackupFile() {
    flushSave();
    const boards = this.boards.map(({ name, elements, view }) => ({ name, elements, view }));
    const blob = new Blob([JSON.stringify({ boards }, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `inkfield-backup-${new Date().toISOString().slice(0, 10)}.json`);
  },
};

// ---- Persistence ----
let saveTimer = null;
let viewTimer = null;
const stateNode = document.getElementById('save-state');

function persist(board) {
  return store.save(board).then(
    () => { stateNode.textContent = store.persistent ? 'Saved' : 'Not saved: browser storage is blocked'; },
    (err) => { stateNode.textContent = 'Save failed'; ui.toast(`Could not save: ${err.message}`); },
  );
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    persist(editor.board);
  }
}

function scheduleSave() {
  stateNode.textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; persist(editor.board); }, 250);
}

let stripTimer = null;
editor.on('change', () => {
  scheduleSave();
  clearTimeout(stripTimer);
  stripTimer = setTimeout(() => ui.renderStrip(), 400);
});
// View changes save quietly: they need to survive reloads, not notify other windows urgently.
editor.on('viewsave', () => {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { if (!saveTimer) store.save(editor.board).catch(() => {}); }, 600);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', flushSave);

// ---- Multi-window sync ----
let pendingRemote = false;
async function syncFromStore() {
  if (editor.busy) { pendingRemote = true; return; }
  if (saveTimer) return; // Local edits are newer; our save will broadcast them.
  const fresh = await store.loadAll();
  if (editor.busy || saveTimer) { pendingRemote = true; return; }
  const local = new Map(app.boards.map((b) => [b.id, b]));
  app.boards = fresh.map((b) => {
    const mine = local.get(b.id);
    if (!mine) return b;
    if (mine === editor.board) {
      if ((b.rev || 0) > (mine.rev || 0)) editor.applyRemote(b);
      return mine;
    }
    return (b.rev || 0) >= (mine.rev || 0) ? b : mine;
  });
  if (!app.boards.length) {
    await app.addBoard(createBoard('Board 1'));
    return;
  }
  if (!app.find(editor.board.id)) {
    ui.toast('This board was deleted in another window.');
    const next = app.boards[0];
    editor.setBoard(next);
  }
  ui.renderStrip();
}
editor.on('gestureend', () => {
  if (pendingRemote) { pendingRemote = false; syncFromStore(); }
});

// ---- Boot ----
const ui = createUI(editor, app);
const store = await createStore(() => syncFromStore());
app.boards = await store.loadAll();
if (!app.boards.length) {
  const first = createBoard('Board 1');
  app.boards.push(first);
  await store.save(first);
  const rect = editor.stageRect();
  first.view = { x: rect.width / 2, y: rect.height / 2, zoom: 1 };
}
const wanted = new URLSearchParams(location.search).get('board');
editor.setBoard(app.find(wanted) || app.boards[0]);
ui.renderStrip();
ui.renderInspector();
if (!store.persistent) ui.toast('Browser storage is blocked, so boards will not survive a reload. Use File, then Save board as JSON.');

window.inkfield = { editor, app, normalizeBoard };
