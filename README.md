# Inkfield

An infinite-canvas diagram editor that runs in your browser. Keep separate whiteboards in one workspace or side by side in their own windows, draw diagrams from scratch, and export any selection of items as a PNG.

![Inkfield showing a diagram with a table, icons and labelled connectors](docs/screenshot.png)

There is no account, backend or dependency to install. Your boards stay in your browser's storage.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/anonymousgroundhog/Inkfield.git
cd Inkfield
npm start
```

Then open <http://localhost:4173>. To use another port, run `PORT=5000 npm start`.

## What it does

- **Infinite whiteboard:** pan and zoom without limits. Scroll to pan, Ctrl+scroll to zoom, or hold Space and drag.
- **Multiple boards:** the strip along the bottom shows a live thumbnail of each board. Add, rename, duplicate, delete, or drag to reorder them.
- **Separate windows:** choose **Open in new window** from a board's `⋯` menu to work on two boards side by side. Windows stay in sync.
- **Diagramming tools:** shapes, text, sticky notes, tables, freehand pen, 30 built-in icons, and your own images (upload, drag in, or paste).
- **Connectors:** elbow, straight, or curved lines that stay attached when shapes move. They can have arrowheads and labels. Drag from the dots around a selected item to connect it.
- **Arrangement:** grouping (including nested groups), alignment guides while dragging, align and distribute commands, layering, undo and redo.
- **PNG export:** select items, then choose **Export PNG**. You can set the scale (1× to 4×), padding, and a white or transparent background, then download the file or copy it to the clipboard.

### Exporting part of a board

1. Drag across the board to select a group of items, or Shift-click them. Clicking any item in a saved group selects the whole group.
2. Click **Export PNG**. The image is cropped to those items.
3. Connectors with both ends on selected items are included automatically. Clear **Include connectors between selected items** to leave them out.

### Text formatting

Wrap words in double asterisks for bold, such as `**Rule 1:** Keep an audit trail`. This works in shapes, notes, table cells, and labels.

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `V` / `H` | Select / pan tool |
| `R` / `O` / `D` | Rectangle / ellipse / diamond |
| `C` / `T` / `N` / `P` | Connector / text / sticky note / pen |
| `Enter` or double-click | Edit text |
| `Ctrl+Enter` or `Esc` | Finish editing text |
| `Ctrl+G` / `Ctrl+Shift+G` | Group / ungroup |
| `Ctrl+C` / `X` / `V` / `D` | Copy / cut / paste / duplicate (paste works across boards and windows) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `[` / `]` | Send to back / bring to front |
| Arrow keys | Nudge 1 px (`Shift` for 10 px) |
| `Ctrl+1` / `Ctrl+0` | Fit to view / zoom to 100% |
| `Ctrl+Shift+E` | Export PNG |
| `Alt` while dragging | Move without snapping |

## Create diagrams from JSON

Boards are plain JSON, so scripts and AI assistants can write them too. Import a file with **File > Import JSON** or by dropping it on the canvas.

```json
{
  "name": "Login flow",
  "elements": [
    { "id": "user", "type": "icon", "icon": "user", "x": 0, "y": 0, "text": "User" },
    { "id": "api", "type": "rect", "x": 280, "y": 3, "text": "Auth API" },
    { "type": "connector", "from": "user", "to": "api", "label": "Sign in" }
  ]
}
```

| Type | Main fields |
| --- | --- |
| `rect`, `ellipse`, `diamond`, `hexagon`, `parallelogram`, `cylinder` | `x`, `y`, `w`, `h`, `text`, `fill`, `stroke`, `strokeWidth`, `dash`, `fontSize`, `fontWeight`, `align`, `valign`, `textColor` |
| `text`, `sticky` | `x`, `y`, `w`, `h`, `text`, `fontSize` |
| `icon` | `x`, `y`, `w`, `h`, `icon` (name from [`src/icons.js`](src/icons.js)), `text` (caption) |
| `table` | `x`, `y`, `w`, `h`, `cells` (array of rows), `titleRow`, `headerFill` |
| `connector` | `from` and `to` (an element id, or `{ "id", "side" }`, or `{ "x", "y" }`), `route` (`elbow`, `straight`, `curve`), `startCap` and `endCap` (`none`, `arrow`, `open`, `dot`), `label` |
| `image` | `x`, `y`, `w`, `h`, `src` (base64 `data:image/...` only) |

To preview a file without a browser, render it to SVG. Text wrapping in this output is approximate:

```bash
node bin/render-svg.js examples/review-pipeline.json diagram.svg
```

## Where your data lives

Boards are stored in your browser's IndexedDB, so they belong to one browser on one device, and clearing site data deletes them. Use **File > Back up all boards** to keep a copy and **File > Import JSON** to restore it.

## Current limitations

- Items can't be rotated.
- There is no multi-user collaboration across devices. Windows sync only within the same browser, and if two windows edit the same board at the same moment, the last save wins.
- Connectors route by simple rules and don't steer around other items.
- Text uses system fonts, so a PNG can look slightly different on another computer.

## Development

The app is plain JavaScript modules with no build step. Rendering lives in one pure function ([`src/render.js`](src/render.js)) shared by the canvas, thumbnails, and export, so a PNG matches what's on screen.

```bash
npm test                     # unit tests
python3 tests/e2e/smoke.py   # browser tests, with npm start running (needs Python Playwright)
```
