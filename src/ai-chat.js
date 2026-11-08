// Pure helpers for the chat panel: finding diagrams in replies and classifying files.
import { mermaidToElements } from './mermaid.js';
import { parseImport } from './model.js';
import { defaultMeasure } from './render.js';

const CLOSED_BLOCK = /```(mermaid|inkfield|json)[ \t]*\r?\n([\s\S]*?)```/gi;
const OPEN_BLOCK = /```(mermaid|inkfield|json)[ \t]*\r?\n[\s\S]*$/i;

// Splits a reply into readable text and its diagram. If there are several, the last wins.
export function parseReply(text) {
  const matches = [...String(text).matchAll(CLOSED_BLOCK)];
  const withoutClosed = String(text).replace(CLOSED_BLOCK, '');
  const open = withoutClosed.match(OPEN_BLOCK);
  const display = withoutClosed.replace(OPEN_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
  const last = matches[matches.length - 1];
  return {
    display,
    drawing: !!open,
    diagram: last ? { format: last[1].toLowerCase() === 'mermaid' ? 'mermaid' : 'inkfield', code: last[2].trim() } : null,
  };
}

// Throws an Error with a readable message if the diagram can't be used.
export function diagramToElements(diagram, measure = defaultMeasure) {
  if (diagram.format === 'mermaid') {
    const { elements, warnings, title } = mermaidToElements(diagram.code, { measure });
    return { elements, warnings: warnings.map((w) => (w.line ? `Line ${w.line}: ${w.message}` : w.message)), title };
  }
  let board;
  try {
    [board] = parseImport(diagram.code);
  } catch (err) {
    throw new Error(`The diagram data isn't valid: ${err.message}`);
  }
  if (!board?.elements.length) throw new Error('The diagram has no items that can be drawn.');
  return { elements: board.elements, warnings: [], title: board.name };
}

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|mmd|mermaid|log|sql|py|js|mjs|ts|tsx|jsx|java|c|h|cpp|cs|go|rs|rb|php|sh|toml|ini|tex|bib)$/i;

// Returns 'image', 'pdf' or 'text', or null when the file can't be used.
export function fileKind(file) {
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '');
  if (IMAGE_TYPES.test(type)) return 'image';
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (type.startsWith('text/') || type === 'application/json' || TEXT_EXTENSIONS.test(name)) return 'text';
  return null;
}

export const MAX_SEND_ATTACHMENTS = 8;
export const MAX_SEND_BYTES = 30 * 1024 * 1024;

// The model only sees attachments that are re-sent each turn. Keep the newest that fit
// and tell it about any that had to be left out.
export function prepareMessages(history) {
  let count = 0;
  let bytes = 0;
  const out = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const kept = [];
    const dropped = [];
    for (const file of [...(m.attachments || [])].reverse()) {
      if (count < MAX_SEND_ATTACHMENTS && bytes + file.data.length <= MAX_SEND_BYTES) {
        count++;
        bytes += file.data.length;
        kept.unshift({ name: file.name, kind: file.kind, data: file.data });
      } else {
        dropped.unshift(file.name);
      }
    }
    const note = dropped.length ? `\n[Earlier attachment no longer available: ${dropped.join(', ')}]` : '';
    out.unshift({ role: m.role, text: m.text + note, attachments: kept });
  }
  return out;
}
