#!/usr/bin/env node
// Renders a board JSON or Mermaid (.mmd) file to SVG without a browser, so scripts and AI assistants
// can generate diagrams. Text widths are approximated here; the app measures exactly.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseImport } from '../src/model.js';
import { buildSvg } from '../src/export.js';
import { mermaidToElements } from '../src/mermaid.js';

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node bin/render-svg.js <board.json|diagram.mmd> [out.svg]');
  process.exit(2);
}
try {
  const source = readFileSync(input, 'utf8');
  const elements = /\.(mmd|mermaid)$/i.test(input) ? mermaidToElements(source).elements : parseImport(source)[0].elements;
  const { svg, count } = buildSvg(elements, null, { background: '#ffffff' });
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
