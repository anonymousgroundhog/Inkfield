"""End-to-end test: drives the real app in Chromium with real pointer input.
Requires Python Playwright. Usage: PORT=4173 npm start, then python3 tests/e2e/smoke.py
Screenshots and exported PNGs go to tests/e2e/artifacts/."""
import json
import os
import struct
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = f"http://localhost:{os.environ.get('PORT', '4173')}"
OUT = Path(__file__).parent / "artifacts"
OUT.mkdir(exist_ok=True)
EXAMPLE = Path(__file__).parents[2] / "examples" / "review-pipeline.json"
failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def png_info(path):
    data = Path(path).read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    return struct.unpack(">II", data[16:24])


def els(page):
    return page.evaluate("window.inkfield.editor.elements")


def settle(page):
    page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")


def stage_point(page, x, y):
    box = page.locator("#stage").bounding_box()
    return box["x"] + x, box["y"] + y


def drag(page, a, b, steps=6):
    page.mouse.move(*a)
    page.mouse.down()
    page.mouse.move(*b, steps=steps)
    page.mouse.up()
    settle(page)


def draw_rect(page, x, y, w, h):
    page.keyboard.press("r")
    drag(page, stage_point(page, x, y), stage_point(page, x + w, y + h))


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1500, "height": 900}, accept_downloads=True)
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # The test forces a 502 preview on purpose, and browsers always log those.
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "status of 502" not in m.text else None)
    page.goto(BASE)
    page.wait_for_function("window.inkfield?.editor?.board")
    settle(page)
    page.screenshot(path=OUT / "01-empty.png")
    check("starts with one empty board", page.locator(".thumb").count() == 1 and len(els(page)) == 0)

    # Draw from scratch
    draw_rect(page, 100, 100, 160, 90)
    draw_rect(page, 450, 100, 160, 90)
    draw_rect(page, 450, 350, 160, 90)
    check("draws three shapes", len(els(page)) == 3)

    # Text in a shape
    page.mouse.dblclick(*stage_point(page, 180, 145))
    page.keyboard.type("Hello **bold**")
    page.keyboard.press("Control+Enter")
    settle(page)
    check("double-click sets shape text", els(page)[0]["text"] == "Hello **bold**")

    # Connector bound between shapes
    page.keyboard.press("c")
    drag(page, stage_point(page, 255, 145), stage_point(page, 455, 145))
    e = els(page)
    conn = e[-1]
    check("connector binds both ends", conn["type"] == "connector" and conn["start"].get("id") == e[0]["id"] and conn["end"].get("id") == e[1]["id"], json.dumps(conn))

    # Moving a shape carries the connector
    page.keyboard.press("Escape")
    x_before = els(page)[1]["x"]
    drag(page, stage_point(page, 530, 145), stage_point(page, 560, 215))
    moved = page.evaluate("""() => { const {editor} = window.inkfield; const el = editor.elements[1]; return {x: el.x, y: el.y}; }""")
    check("shape moves", abs(moved["x"] - x_before - 30) < 8, str(moved))
    conn_after = els(page)[-1]
    check("connector stays bound after move", conn_after["end"].get("id") == e[1]["id"])

    # Undo/redo
    page.keyboard.press("Control+z")
    settle(page)
    check("undo restores position", abs(els(page)[1]["x"] - x_before) < 0.01)
    page.keyboard.press("Control+Shift+z")
    settle(page)
    check("redo reapplies", abs(els(page)[1]["x"] - moved["x"]) < 0.01)

    # Infinite canvas: draw something far away, then pan and zoom
    before = page.evaluate("({...window.inkfield.editor.board.view})")
    px, py = stage_point(page, 600, 400)
    page.mouse.move(px, py)
    page.mouse.wheel(4000, 3000)
    settle(page)
    view = page.evaluate("({...window.inkfield.editor.board.view})")
    check("wheel pans", view["x"] == before["x"] - 4000 and view["y"] == before["y"] - 3000, str(view))
    draw_rect(page, 200, 200, 120, 80)
    far = els(page)[-1]
    check("draws at distant coordinates", far["x"] > 3000, str(far["x"]))
    page.keyboard.press("Control+1")
    settle(page)
    check("fit zooms out to show everything", page.evaluate("window.inkfield.editor.board.view.zoom") < 1)
    zoom0 = page.evaluate("window.inkfield.editor.board.view.zoom")
    page.mouse.move(px, py)
    page.keyboard.down("Control")
    page.mouse.wheel(0, -200)
    page.keyboard.up("Control")
    settle(page)
    check("ctrl+wheel zooms", page.evaluate("window.inkfield.editor.board.view.zoom") > zoom0)
    page.evaluate("window.inkfield.editor.select(new Set([window.inkfield.editor.elements.at(-1).id]))")
    page.keyboard.press("Delete")
    settle(page)
    page.keyboard.press("Control+1")
    settle(page)

    # Marquee selects a grouping. Screen boxes come from live view state.
    def screen_box(el):
        return page.evaluate("""(el) => { const {editor} = window.inkfield; const a = editor.toScreen(el); const z = editor.board.view.zoom; return {x: a.x, y: a.y, w: el.w*z, h: el.h*z}; }""", el)

    e = els(page)
    a, b = screen_box(e[0]), screen_box(e[1])
    drag(page, stage_point(page, a["x"] - 25, a["y"] - 25), stage_point(page, b["x"] + b["w"] + 25, b["y"] + b["h"] + 25))
    sel = page.evaluate("[...window.inkfield.editor.selection]")
    check("marquee selects the enclosed items and connector", set(sel) == {e[0]["id"], e[1]["id"], e[3]["id"]}, str(sel))

    # Group, then a click selects all members
    page.keyboard.press("Control+g")
    page.keyboard.press("Escape")
    settle(page)
    a = screen_box(els(page)[0])
    page.mouse.click(*stage_point(page, a["x"] + a["w"] / 2, a["y"] + a["h"] / 2))
    settle(page)
    check("click selects whole group", page.evaluate("window.inkfield.editor.selection.size") == 3)
    page.screenshot(path=OUT / "02-group-selected.png")

    # Export the selection
    page.keyboard.press("Control+Shift+e")
    page.wait_for_selector("#export-dialog[open]")
    page.wait_for_function("document.querySelector('#export-preview').naturalWidth > 0")
    page.screenshot(path=OUT / "03-export-dialog.png")
    with page.expect_download() as dl:
        page.click("#export-download")
    path = OUT / "selection.png"
    dl.value.save_as(path)
    w, h = png_info(path)
    bounds = page.evaluate("""() => { const {editor} = window.inkfield; const b = editor.selectionBounds(); return b; }""")
    check("selection PNG downloads with selection filename", dl.value.suggested_filename == "Board-1-selection.png", dl.value.suggested_filename)
    check("selection PNG is cropped to the group at 2x", abs(w - (bounds["w"] + 48) * 2) < 16 and abs(h - (bounds["h"] + 48) * 2) < 16, f"{w}x{h} vs {bounds}")

    # Pixel check: export contains ink, and transparent export has clear corners
    pixels = page.evaluate("""async () => {
      const {editor} = window.inkfield;
      const { buildSvg, rasterize } = await import('/src/export.js');
      const { blob, width, height } = await rasterize(buildSvg(editor.elements, [...editor.selection], {background: null}), 1);
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(width, height); const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, width, height).data;
      let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i+3] > 200 && d[i] < 60) dark++;
      return {corner: d[3], dark, width, height};
    }""")
    check("transparent export keeps corners clear and has ink", pixels["corner"] == 0 and pixels["dark"] > 200, str(pixels))

    # Multiple boards
    page.click("#add-board")
    page.wait_for_function("document.querySelectorAll('.thumb').length === 2")
    settle(page)
    check("new board is blank and active", len(els(page)) == 0 and page.evaluate("window.inkfield.editor.board.name") == "Board 2")
    check("URL tracks active board", "board=" in page.url)
    draw_rect(page, 300, 200, 200, 120)
    page.locator(".thumb").nth(0).click()
    settle(page)
    check("switching restores first board", len(els(page)) == 4)

    # Persistence
    page.wait_for_timeout(500)
    page.reload()
    page.wait_for_function("window.inkfield?.editor?.board")
    settle(page)
    check("boards survive reload", page.locator(".thumb").count() == 2 and len(els(page)) == 4)

    # Separate windows, live sync
    board1 = page.evaluate("window.inkfield.app.boards[0].id")
    with ctx.expect_page() as pop:
        page.evaluate("window.inkfield.app.openWindow(window.inkfield.app.boards[1].id)")
    win = pop.value
    win.on("pageerror", lambda e: errors.append("popup: " + str(e)))
    win.wait_for_function("window.inkfield?.editor?.board")
    settle(win)
    check("popup opens on requested board", win.evaluate("window.inkfield.editor.board.name") == "Board 2")
    check("windows show different boards", page.evaluate("window.inkfield.editor.board.id") == board1)
    draw_rect(win, 600, 300, 120, 80)
    page.wait_for_function("window.inkfield.app.boards[1].elements.length === 2", timeout=4000)
    check("edits in the popup reach the first window", True)
    page.locator(".thumb").nth(1).click()
    settle(page)
    check("first window shows the popup's edit", len(els(page)) == 2)
    # Same board open in both windows updates live
    draw_rect(page, 100, 100, 100, 100)
    win.wait_for_function("window.inkfield.editor.elements.length === 3", timeout=4000)
    check("same board syncs live between windows", True)
    win.close()
    page.locator(".thumb").nth(0).click()

    # Copy/paste keeps connector between pasted shapes
    settle(page)
    before = len(els(page))
    page.keyboard.press("Control+a")
    page.keyboard.press("Control+d")
    settle(page)
    after = els(page)
    pasted = after[before:]
    pasted_conn = [x for x in pasted if x["type"] == "connector"][0]
    pasted_ids = {x["id"] for x in pasted}
    check("duplicate rebinds connector to the copies", pasted_conn["start"]["id"] in pasted_ids and pasted_conn["end"]["id"] in pasted_ids)
    page.keyboard.press("Control+z")
    settle(page)

    # JSON import, icons, table, labels: visual fidelity board
    page.set_input_files("#file-input", EXAMPLE)
    page.wait_for_function("window.inkfield.editor.board.name === 'Review pipeline'")
    settle(page)
    page.wait_for_timeout(600)
    page.screenshot(path=OUT / "04-example-board.png")
    check("imports example JSON", len(els(page)) == 10)

    # Tool coverage: table edit, sticky, pen, icon, connector style
    page.click("#add-board")
    page.wait_for_function("window.inkfield.editor.board.elements.length === 0")
    settle(page)
    page.click("[data-tool=table]")
    drag(page, stage_point(page, 100, 60), stage_point(page, 560, 240))
    t = els(page)[0]
    check("table draws", t["type"] == "table")
    page.mouse.dblclick(*stage_point(page, 330, 170))
    page.keyboard.type("cell text")
    page.keyboard.press("Control+Enter")
    settle(page)
    check("table cell edits", any("cell text" in c for r in els(page)[0]["cells"] for c in r), str(els(page)[0]["cells"]))
    page.keyboard.press("n")
    page.mouse.click(*stage_point(page, 720, 150))
    page.keyboard.type("note")
    page.keyboard.press("Control+Enter")
    settle(page)
    check("sticky note keeps typed text", els(page)[-1]["text"] == "note", str(els(page)[-1]["text"]))
    check("typing in a note does not trigger tool hotkeys", page.evaluate("window.inkfield.editor.tool") == "select")
    page.keyboard.press("t")
    page.mouse.click(*stage_point(page, 720, 400))
    page.keyboard.type("free text")
    page.keyboard.press("Control+Enter")
    settle(page)
    check("text tool keeps typed text", els(page)[-1]["text"] == "free text", str(els(page)[-1]))
    page.keyboard.press("Escape")
    page.keyboard.press("r")
    drag(page, stage_point(page, 720, 450), stage_point(page, 820, 510))
    box0 = els(page)[-1]
    sb = page.evaluate("(el) => window.inkfield.editor.toScreen({x: el.x + el.w, y: el.y + el.h})", box0)
    drag(page, stage_point(page, sb["x"], sb["y"]), stage_point(page, sb["x"] + 40, sb["y"] + 30))
    box1 = els(page)[-1]
    check("corner handle resizes", abs(box1["w"] - box0["w"] - 40) < 2 and abs(box1["h"] - box0["h"] - 30) < 2 and box1["x"] == box0["x"], f"{box0['w']}->{box1['w']}")
    page.keyboard.press("Delete")
    settle(page)
    page.keyboard.press("p")
    drag(page, stage_point(page, 100, 330), stage_point(page, 300, 420), steps=12)
    page.keyboard.press("v")
    page.click("[data-tool=icons]")
    page.fill("#flyout input", "dat")
    page.click("[data-icon=database]")
    settle(page)
    # Style via inspector
    page.click('#inspector [data-patch="stroke"][data-value="#1971c2"]')
    settle(page)
    check("inspector recolours selection", els(page)[-1]["stroke"] == "#1971c2")
    # Image upload
    tiny = Path(OUT / "selection.png")
    page.set_input_files("#image-input", tiny)
    page.wait_for_function("window.inkfield.editor.elements.at(-1).type === 'image'")
    settle(page)
    page.screenshot(path=OUT / "05-tools.png")
    types = [x["type"] for x in els(page)]
    check("all tool types placed", set(types) >= {"table", "sticky", "pen", "icon", "image"}, str(types))

    # Whole-board export with image present must not taint the canvas
    page.keyboard.press("Escape")
    page.click("#export-btn")
    page.wait_for_selector("#export-dialog[open]")
    check("no selection defaults export to whole board", page.evaluate("document.querySelector('#export-form').elements.scope.value") == "board")
    with page.expect_download() as dl:
        page.click("#export-download")
    path = OUT / "board.png"
    dl.value.save_as(path)
    check("board PNG with image exports", png_info(path)[0] > 500)

    # Board rename + delete
    page.fill("#board-name", "Renamed")
    page.keyboard.press("Enter")
    settle(page)
    check("board renames", page.evaluate("window.inkfield.editor.board.name") == "Renamed")
    page.on("dialog", lambda d: d.accept())
    count = page.locator(".thumb").count()
    page.locator(".thumb.active .more").click()
    page.click('[data-board="delete"]')
    page.wait_for_function(f"document.querySelectorAll('.thumb').length === {count - 1}")
    check("board deletes", True)

    # Connector label via double-click
    page.evaluate("window.inkfield.app.switchBoard(window.inkfield.app.boards[0].id)")
    settle(page)
    page.keyboard.press("Control+1")
    settle(page)
    mid = page.evaluate("""async () => {
      const { routeConnector } = await import('/src/connectors.js');
      const { editor } = window.inkfield;
      const c = editor.elements.find((e) => e.type === 'connector');
      const p = routeConnector(c, editor.byId).pts; const a = p[1];
      const b = p[2]; return editor.toScreen({x: (a.x+b.x)/2, y: (a.y+b.y)/2});
    }""")
    page.mouse.dblclick(*stage_point(page, mid["x"], mid["y"]))
    page.keyboard.type("Label")
    page.keyboard.press("Control+Enter")
    settle(page)
    check("double-click adds a connector label", any(x.get("label") == "Label" for x in els(page)))

    # Mermaid: typed code previews live, then becomes editable native elements
    page.keyboard.press("Escape")
    n_before = len(els(page))
    page.keyboard.press("m")
    page.wait_for_selector("#mermaid-dialog[open]")
    check("mermaid dialog starts with insert disabled", page.is_disabled("#mermaid-add"))
    page.fill("#mermaid-code", "pie title Pets")
    page.wait_for_function("document.querySelector('#mermaid-error').textContent.includes('supported')")
    check("unsupported type explains itself", page.is_disabled("#mermaid-add"))
    page.fill("#mermaid-code", "flowchart TD\n  A[Start] --> B{Ready?}\n  B -- Yes --> C[Ship]\n  B -- No --> A")
    page.wait_for_function("!document.querySelector('#mermaid-add').disabled")
    page.wait_for_function("document.querySelector('#mermaid-preview').naturalWidth > 0")
    page.keyboard.press("v")
    check("typing in the dialog does not trigger hotkeys", page.input_value("#mermaid-code").endswith("v") and page.evaluate("window.inkfield.editor.tool") == "select")
    page.fill("#mermaid-code", "flowchart TD\n  A[Start] --> B{Ready?}\n  B -- Yes --> C[Ship]\n  B -- No --> A")
    page.wait_for_timeout(250)
    page.click("#mermaid-add")
    settle(page)
    added = els(page)[n_before:]
    check("mermaid adds shapes and connectors", len(added) == 6 and sum(1 for x in added if x["type"] == "connector") == 3, str(len(added)))
    check("generated items start selected", page.evaluate("window.inkfield.editor.selection.size") == 6)
    page.keyboard.press("Control+z")
    settle(page)
    check("one undo removes the whole diagram", len(els(page)) == n_before)
    page.keyboard.press("Control+Shift+z")
    settle(page)
    start = next(x for x in els(page) if x.get("text") == "Start")
    sp = page.evaluate("(el) => window.inkfield.editor.toScreen({x: el.x + el.w/2, y: el.y + el.h/2})", start)
    page.keyboard.press("Escape")
    page.mouse.click(*stage_point(page, sp["x"], sp["y"]))
    settle(page)
    page.keyboard.press("Enter")
    page.keyboard.type("Begin")
    page.keyboard.press("Control+Enter")
    settle(page)
    check("generated shapes are editable", any(x.get("text") == "Begin" for x in els(page)))

    # Pasting Mermaid onto the canvas opens the dialog already filled in
    boards_before = page.locator(".thumb").count()
    page.evaluate("navigator.clipboard.writeText('sequenceDiagram\\n  A->>B: Hello\\n  B-->>A: Hi')")
    page.keyboard.press("Escape")
    page.keyboard.press("Control+v")
    page.wait_for_selector("#mermaid-dialog[open]")
    check("paste opens dialog with the code", "sequenceDiagram" in page.input_value("#mermaid-code"))
    page.wait_for_function("!document.querySelector('#mermaid-new').disabled")
    page.click("#mermaid-new")
    page.wait_for_function(f"document.querySelectorAll('.thumb').length === {boards_before + 1}")
    settle(page)
    check("new board holds the sequence diagram", page.evaluate("window.inkfield.editor.board.name") == "Mermaid diagram" and any(x.get("label") == "Hello" for x in els(page)))
    with page.expect_download() as dl:
        page.keyboard.press("Control+Shift+e")
        page.wait_for_selector("#export-dialog[open]")
        page.click("#export-download")
    path = OUT / "mermaid.png"
    dl.value.save_as(path)
    check("mermaid diagram exports to PNG", png_info(path)[0] > 200)
    page.reload()
    page.wait_for_function("window.inkfield?.editor?.board")
    settle(page)

    # Link cards: pasted URLs load previews in the background. Network replies are mocked here.
    tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
    def preview(route):
        url = route.request.url
        if "fails.example" in url:
            route.fulfill(status=502, json={"error": "no"})
        elif "slow.example" in url:
            page.wait_for_timeout(0)
            route.fulfill(json={"kind": "page", "title": "Slow site", "description": "", "siteName": "", "image": ""})
        elif "youtu" in url:
            route.fulfill(json={"kind": "video", "title": "A mocked video", "description": "", "siteName": "YouTube", "image": tiny})
        else:
            route.fulfill(json={"kind": "page", "title": "A mocked site", "description": "", "siteName": "", "image": tiny})
    page.route("**/api/preview*", preview)
    page.route("https://i.ytimg.com/**", lambda r: r.abort())
    page.click("#add-board")
    page.wait_for_function("window.inkfield.editor.board.elements.length === 0")
    settle(page)
    def paste(text):
        page.evaluate("(t) => navigator.clipboard.writeText(t)", text)
        page.keyboard.press("Escape")
        page.keyboard.press("Control+v")
    def card(n=-1):
        return els(page)[n]
    paste("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    page.wait_for_function("window.inkfield.editor.elements.at(-1)?.status === 'ready'")
    settle(page)
    yt = card()
    check("pasted YouTube URL becomes a video card", yt["type"] == "link" and yt["kind"] == "video" and yt["title"] == "A mocked video")
    check("video card embeds its thumbnail", yt["image"].startswith("data:image/"))
    check("thumbnail is drawn with a play badge", page.locator("#world image").count() == 1 and page.locator("#world circle").count() >= 1)
    page.keyboard.press("Control+z")
    settle(page)
    check("undo removes the card", len(els(page)) == 0)
    page.keyboard.press("Control+Shift+z")
    settle(page)
    check("redo restores the loaded preview, not a loading card", card()["status"] == "ready" and card()["image"].startswith("data:"))
    paste("https://site.example/page")
    page.wait_for_function("window.inkfield.editor.elements.at(-1)?.title === 'A mocked site'")
    check("pasted website URL becomes a page card", card()["kind"] == "page" and card()["image"].startswith("data:"))
    paste("https://fails.example/")
    page.wait_for_function("window.inkfield.editor.elements.at(-1)?.status === 'failed'")
    settle(page)
    check("a failed preview keeps a usable card", card()["url"] == "https://fails.example/" and card()["title"] == "fails.example")
    check("inspector explains the missing preview", "No preview available" in page.inner_text("#inspector"))
    page.unroute("**/api/preview*")
    page.route("**/api/preview*", lambda r: r.fulfill(json={"kind": "page", "title": "Back online", "description": "", "siteName": "", "image": ""}))
    page.click('[data-cmd="link-refresh"]')
    page.wait_for_function("window.inkfield.editor.elements.at(-1)?.title === 'Back online'")
    check("refresh retries the preview", card()["status"] == "ready")
    page.fill("#link-title", "My title")
    settle(page)
    check("the title can be edited", card()["title"] == "My title")
    page.keyboard.press("Tab")
    paste("just some words")
    settle(page)
    check("ordinary text still pastes as text", card()["type"] == "text")
    # Several URLs at once don't collide, even once thumbnails make them grow
    page.unroute("**/api/preview*")
    page.route("**/api/preview*", lambda r: r.fulfill(json={"kind": "page", "title": "Tall", "description": "", "siteName": "", "image": tiny}))
    before_batch = len(els(page))
    paste("\n".join(f"https://batch{i}.example/" for i in range(5)))
    page.wait_for_function(f"window.inkfield.editor.elements.length === {before_batch + 5} && window.inkfield.editor.elements.every(e => e.status !== 'loading')")
    batch = els(page)[before_batch:]
    def collide(a, b):
        return a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]
    check("pasting several URLs lays out cards without overlap", all(batch[i]["h"] > 200 for i in range(5)) and not any(collide(batch[i], batch[j]) for i in range(5) for j in range(i + 1, 5)), str([(b["x"], b["y"], b["h"]) for b in batch]))
    page.keyboard.press("Delete")
    settle(page)

    # Double-click opens in a new tab, without disturbing the board
    yt_box = page.evaluate("(el) => { const e = window.inkfield.editor; const a = e.toScreen(el); return {x: a.x + 60*e.board.view.zoom, y: a.y + 60*e.board.view.zoom}; }", els(page)[0])
    page.keyboard.press("Escape")
    page.context.route("https://www.youtube.com/**", lambda r: r.fulfill(body="<title>mock</title>", content_type="text/html"))
    with ctx.expect_page() as tab:
        page.mouse.dblclick(*stage_point(page, yt_box["x"], yt_box["y"]))
    check("double-click opens the link", "youtube.com/watch" in tab.value.url, tab.value.url)
    check("the new tab has no opener", tab.value.evaluate("window.opener === null"))
    tab.value.close()
    # Survives a reload, exports cleanly, and an interrupted load resumes
    page.wait_for_timeout(500)
    page.reload()
    page.wait_for_function("window.inkfield?.editor?.board")
    settle(page)
    page.locator(".thumb").last.click()
    settle(page)
    check("cards survive a reload", els(page)[0]["image"].startswith("data:"))
    page.keyboard.press("Control+Shift+e")
    page.wait_for_selector("#export-dialog[open]")
    with page.expect_download() as dl:
        page.click("#export-download")
    dl.value.save_as(OUT / "links.png")
    check("cards export to PNG", png_info(OUT / "links.png")[0] > 300)
    page.unroute("**/api/preview*")

    # Narrow window keeps primary controls reachable
    page.set_viewport_size({"width": 820, "height": 700})
    settle(page)
    box = page.locator("#export-btn").bounding_box()
    check("export button visible at narrow width", box["x"] + box["width"] <= 820, str(box))

    check("no console or page errors", not errors, "; ".join(errors[:6]))
    browser.close()

print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
