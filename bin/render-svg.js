#!/usr/bin/env node
// Renders a board JSON file to SVG without a browser, so scripts and AI assistants
// can generate diagrams. Text widths are approximated here; the app measures exactly.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseImport } from '../src/model.js';
import { buildSvg } from '../src/export.js';

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node bin/render-svg.js <board.json> [out.svg]');
  process.exit(2);
}
try {
  const [board] = parseImport(readFileSync(input, 'utf8'));
  const { svg, count } = buildSvg(board.elements, null, { background: '#ffffff' });
  if (output) {
    writeFileSync(output, svg);
    console.error(`Wrote ${output} (${count} elements)`);
  } else {
    process.stdout.write(svg);
  }
} catch (err) {
  console.error(`Could not render ${input}: ${err.message}`);
  process.exit(1);
}
