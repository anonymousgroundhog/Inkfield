// IndexedDB persistence (images can exceed localStorage limits) and live sync
// between windows through BroadcastChannel. Falls back to memory if storage is blocked.
const DB = 'inkfield', VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('boards', { keyPath: 'id' });
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});
const result = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function createStore(onRemoteChange) {
  let db = null;
  const memory = { boards: new Map(), order: [] };
  try {
    db = await open();
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    db = null;
  }
  const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('inkfield-sync') : null;
  if (channel) channel.onmessage = (e) => onRemoteChange(e.data);
  const announce = (msg) => channel?.postMessage(msg);

  return {
    persistent: !!db,
    async loadAll() {
      if (!db) return memory.order.map((id) => memory.boards.get(id)).filter(Boolean);
      const tx = db.transaction(['boards', 'meta']);
      const [boards, order] = await Promise.all([
        result(tx.objectStore('boards').getAll()),
        result(tx.objectStore('meta').get('order')),
      ]);
      const byId = new Map(boards.map((b) => [b.id, b]));
      const ordered = (order || []).map((id) => byId.get(id)).filter(Boolean);
      const seen = new Set(ordered.map((b) => b.id));
      return [...ordered, ...boards.filter((b) => !seen.has(b.id))];
    },
    async save(board) {
      if (!db) { memory.boards.set(board.id, board); if (!memory.order.includes(board.id)) memory.order.push(board.id); return; }
      const tx = db.transaction(['boards', 'meta'], 'readwrite');
      tx.objectStore('boards').put(board);
      const meta = tx.objectStore('meta');
      const order = (await result(meta.get('order'))) || [];
      if (!order.includes(board.id)) { order.push(board.id); meta.put(order, 'order'); }
      await done(tx);
      announce({ kind: 'board', id: board.id, rev: board.rev });
    },
    async remove(id) {
      if (!db) { memory.boards.delete(id); memory.order = memory.order.filter((x) => x !== id); return; }
      const tx = db.transaction(['boards', 'meta'], 'readwrite');
      tx.objectStore('boards').delete(id);
      const meta = tx.objectStore('meta');
      const order = (await result(meta.get('order'))) || [];
      meta.put(order.filter((x) => x !== id), 'order');
      await done(tx);
      announce({ kind: 'removed', id });
    },
    async setOrder(ids) {
      if (!db) { memory.order = ids; return; }
      const tx = db.transaction(['meta'], 'readwrite');
      tx.objectStore('meta').put(ids, 'order');
      await done(tx);
      announce({ kind: 'order' });
    },
  };
}
