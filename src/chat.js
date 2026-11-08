// The AI chat panel. The browser holds the conversation; it is gone on reload, and the
// server keeps nothing. Replies are always rendered as plain text, never as HTML.
import { apiFetch } from './api.js';
import { diagramToElements, fileKind, parseReply, prepareMessages } from './ai-chat.js';
import { buildSvg } from './export.js';
import { withFreshIds } from './model.js';

const $ = (sel) => document.querySelector(sel);
const MAX_IMAGE_SIDE = 1568;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const MAX_READ_BYTES = 40 * 1024 * 1024;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const base64Of = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1);
const readDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// Large images are shrunk to what the model can use anyway, keeping requests small.
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES) {
    bitmap.close();
    return base64Of(await readDataUrl(file));
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return base64Of(canvas.toDataURL('image/jpeg', 0.88));
}

async function prepareFile(file) {
  const kind = fileKind(file);
  if (!kind) throw new Error(`"${file.name}" can't be read. Use an image, a PDF or a text file. Save Word and Excel files as PDF first.`);
  if (file.size > MAX_READ_BYTES) throw new Error(`"${file.name}" is too large.`);
  if (kind === 'text') return { name: file.name, kind, data: await file.text() };
  if (kind === 'pdf') return { name: file.name, kind, data: base64Of(await readDataUrl(file)) };
  try {
    return { name: file.name, kind, data: await prepareImage(file) };
  } catch {
    throw new Error(`"${file.name}" couldn't be read as an image.`);
  }
}

export function createChat(editor, app, ui) {
  const panel = $('#chat-panel'), log = $('#chat-log'), input = $('#chat-input');
  const sendBtn = $('#chat-send'), stopBtn = $('#chat-stop'), chips = $('#chat-files'), notice = $('#chat-notice');
  const fileInput = $('#chat-file-input');

  let history = [];
  let pending = [];
  let controller = null;
  let ready = false;
  let previewUrls = [];
  let lastInserted = null;
  let replaceButtons = [];
  let previewSeq = 0;

  const scrollDown = () => { log.scrollTop = log.scrollHeight; };

  function updateControls() {
    const busy = !!controller;
    input.disabled = !ready;
    $('#chat-attach').disabled = !ready;
    sendBtn.hidden = busy;
    stopBtn.hidden = !busy;
    sendBtn.disabled = !ready || (!input.value.trim() && !pending.length);
  }

  // ---- Availability ----
  function showNotice(title, body, code) {
    notice.replaceChildren();
    notice.hidden = false;
    notice.append(el('strong', '', title), el('p', '', body));
    if (code) notice.append(el('code', '', code));
    const again = el('button', 'btn', 'Check again');
    again.type = 'button';
    again.onclick = checkStatus;
    notice.append(again);
  }

  async function checkStatus() {
    ready = false;
    updateControls();
    let status = null;
    let reachable = true;
    let locked = false;
    try {
      const res = await apiFetch('api/ai/status');
      locked = res.status === 401;
      if (res.ok && String(res.headers.get('content-type')).includes('json')) status = await res.json();
      else reachable = false;
    } catch {
      reachable = false;
    }
    if (locked) {
      showNotice('Open your private link', 'To keep your Claude Code account private, chat only works in a browser that opened the link printed in the terminal when you ran npm start. Open that link, then come back.');
    } else if (!reachable) {
      showNotice('AI chat needs the local server', 'Chat runs through Claude Code on your computer, so it only works when Inkfield is started from a terminal. Restart it if you started it before this feature was added.', 'npm start');
    } else if (!status.available) {
      showNotice('Claude Code isn\'t installed', 'Chat uses the Claude Code command-line tool on this computer. Install it, sign in, and check again.', 'npm install -g @anthropic-ai/claude-code');
    } else if (status.loggedIn === false) {
      showNotice('Claude Code isn\'t signed in', 'Sign in from a terminal, then check again.', 'claude auth login');
    } else {
      notice.hidden = true;
      ready = true;
    }
    updateControls();
    if (ready && panel.classList.contains('open')) input.focus();
  }

  // ---- Attachments ----
  function renderChips() {
    chips.replaceChildren();
    pending.forEach((file, i) => {
      const chip = el('span', 'chip');
      chip.append(el('span', 'chip-name', file.name));
      const x = el('button', '', '×');
      x.type = 'button';
      x.title = `Remove ${file.name}`;
      x.setAttribute('aria-label', `Remove ${file.name}`);
      x.onclick = () => { pending.splice(i, 1); renderChips(); updateControls(); };
      chip.append(x);
      chips.append(chip);
    });
    chips.hidden = !pending.length;
  }

  async function addFiles(files) {
    if (!ready) return;
    for (const file of files) {
      if (pending.length >= 8) { ui.toast('You can attach up to 8 files to a message.'); break; }
      try {
        pending.push(await prepareFile(file));
      } catch (err) {
        ui.toast(err.message);
      }
    }
    renderChips();
    updateControls();
  }

  $('#chat-attach').onclick = () => fileInput.click();
  fileInput.addEventListener('change', async () => {
    await addFiles([...fileInput.files]);
    fileInput.value = '';
  });
  input.addEventListener('paste', (e) => {
    const files = [...e.clipboardData.files];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  panel.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); panel.classList.add('dropping'); });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('dropping'); });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    panel.classList.remove('dropping');
    addFiles([...e.dataTransfer.files]);
  });

  // ---- Messages ----
  function addUserBubble(text, attachments) {
    log.querySelector('.chat-welcome')?.remove();
    const bubble = el('div', 'msg user');
    if (text) bubble.append(el('p', '', text));
    if (attachments.length) {
      const list = el('div', 'msg-files');
      attachments.forEach((f) => list.append(el('span', 'chip', f.name)));
      bubble.append(list);
    }
    log.append(bubble);
    scrollDown();
  }

  function refreshReplaceButtons() {
    const active = lastInserted && lastInserted.boardId === editor.board.id && lastInserted.ids.some((id) => editor.byId.has(id));
    replaceButtons.forEach((b) => { b.hidden = !active; });
  }

  function renderDiagramCard(parent, diagram) {
    const card = el('div', 'diagram-card');
    let result;
    try {
      result = diagramToElements(diagram);
    } catch (err) {
      card.append(el('p', 'msg-error', `This diagram couldn't be drawn. ${err.message}`));
      const fix = el('button', 'btn', 'Ask Claude to fix it');
      fix.type = 'button';
      fix.onclick = () => send(`That diagram couldn't be drawn. The error was: ${err.message}\nPlease fix it and send the whole diagram again.`);
      card.append(fix);
      parent.append(card);
      return;
    }
    const { svg } = buildSvg(result.elements, null, { padding: 12, background: '#ffffff', idPrefix: `chat${++previewSeq}-` });
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    previewUrls.push(url);
    const img = el('img');
    img.src = url;
    img.alt = 'Diagram preview';
    card.append(img);
    if (result.warnings.length) card.append(el('p', 'msg-warning', `Some lines were skipped. ${result.warnings.slice(0, 3).join(' ')}`));

    const actions = el('div', 'diagram-actions');
    const button = (label, primary, handler) => {
      const b = el('button', primary ? 'primary' : 'btn', label);
      b.type = 'button';
      b.onclick = handler;
      actions.append(b);
      return b;
    };
    button('Add to board', true, () => {
      const ids = editor.insertDiagram(withFreshIds(result.elements));
      lastInserted = { boardId: editor.board.id, ids };
      refreshReplaceButtons();
    });
    replaceButtons.push(button('Replace last', false, () => {
      if (!lastInserted || lastInserted.boardId !== editor.board.id) return;
      const ids = editor.replaceDiagram(lastInserted.ids, withFreshIds(result.elements));
      lastInserted = { boardId: editor.board.id, ids };
      refreshReplaceButtons();
    }));
    button('New board', false, async () => {
      const board = await app.addBoardWith(result.title || 'AI diagram', withFreshIds(result.elements));
      lastInserted = { boardId: board.id, ids: board.elements.map((x) => x.id) };
      refreshReplaceButtons();
    });
    card.append(actions);
    parent.append(card);
    refreshReplaceButtons();
  }

  async function run() {
    const bubble = el('div', 'msg assistant');
    const body = el('p', '', '');
    const status = el('p', 'msg-status', 'Thinking…');
    bubble.append(body, status);
    log.append(bubble);
    scrollDown();

    controller = new AbortController();
    updateControls();
    let text = '';
    let failure = null;
    const paint = () => {
      const { display, drawing } = parseReply(text);
      body.textContent = display;
      body.hidden = !display;
      status.textContent = drawing ? 'Drawing your diagram…' : 'Thinking…';
      status.hidden = !!display && !drawing;
      scrollDown();
    };

    try {
      const res = await apiFetch('api/ai/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: prepareMessages(history) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `The chat request failed (status ${res.status}).`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === 'text') { text += event.text; paint(); }
          if (event.type === 'error') failure = event.message;
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') failure = err.message === 'Failed to fetch' ? 'Lost contact with the local server. Check that it is still running.' : err.message;
    }

    const stoppedByUser = controller.signal.aborted;
    controller = null;
    status.remove();
    const { display, diagram, drawing } = parseReply(text);
    body.textContent = display;
    body.hidden = !display;
    if (text) history.push({ role: 'assistant', text, attachments: [] });
    if (diagram && !stoppedByUser) renderDiagramCard(bubble, diagram);
    if (drawing && !diagram && !failure && !stoppedByUser) failure = 'The reply ended before the diagram was finished.';
    if (stoppedByUser) bubble.append(el('p', 'msg-status', 'Stopped.'));
    if (failure) {
      bubble.append(el('p', 'msg-error', failure));
      const retry = el('button', 'btn', 'Try again');
      retry.type = 'button';
      retry.onclick = () => {
        retry.remove();
        if (history[history.length - 1]?.role === 'assistant') history.pop();
        if (history[history.length - 1]?.role === 'user') run();
      };
      bubble.append(retry);
    }
    updateControls();
    scrollDown();
    if (panel.classList.contains('open')) input.focus();
  }

  function send(textOverride) {
    if (controller || !ready) return;
    const text = (textOverride ?? input.value).trim();
    if (!text && !pending.length) return;
    const attachments = textOverride === undefined ? pending : [];
    const sentText = text || 'Create a diagram from the attached file.';
    addUserBubble(text, attachments);
    history.push({ role: 'user', text: sentText, attachments });
    if (textOverride === undefined) {
      input.value = '';
      input.style.height = '';
      pending = [];
      renderChips();
    }
    run();
  }

  function newChat() {
    controller?.abort();
    history = [];
    pending = [];
    lastInserted = null;
    replaceButtons = [];
    previewUrls.forEach((u) => URL.revokeObjectURL(u));
    previewUrls = [];
    log.replaceChildren();
    renderChips();
    showWelcome();
    updateControls();
  }

  function showWelcome() {
    const welcome = el('div', 'chat-welcome');
    welcome.append(
      el('p', '', 'Describe a diagram, or attach an image or file to work from. You can ask for changes after each reply.'),
      el('p', 'chat-privacy', 'Messages and attachments go to Claude through your Claude Code account and count toward its usage. Claude can\'t access your files or boards unless you attach them. This chat clears when you reload.'),
    );
    const examples = el('div', 'chat-examples');
    for (const text of ['Flowchart for handling a support ticket', 'Sequence diagram of a user logging in', 'Recreate my attached image as an editable diagram']) {
      const b = el('button', 'btn', text);
      b.type = 'button';
      b.onclick = () => { input.value = text; updateControls(); input.focus(); };
      examples.append(b);
    }
    welcome.append(examples);
    log.append(welcome);
  }

  // ---- Panel ----
  function setOpen(open) {
    panel.classList.toggle('open', open);
    panel.hidden = !open;
    document.querySelector('[data-tool=ai]')?.classList.toggle('active', open);
    const stage = editor.stageRect();
    editor.rightInset = open ? Math.max(0, stage.right - panel.getBoundingClientRect().left) : 0;
    if (open) checkStatus();
  }

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight + 2)}px`;
    updateControls();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  panel.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') setOpen(false);
  });
  sendBtn.onclick = () => send();
  stopBtn.onclick = () => controller?.abort();
  $('#chat-new').onclick = newChat;
  $('#chat-close').onclick = () => setOpen(false);
  editor.on('boardchange', refreshReplaceButtons);
  editor.on('change', refreshReplaceButtons);

  showWelcome();
  updateControls();
  return { toggle: () => setOpen(!panel.classList.contains('open')), open: () => setOpen(true) };
}
