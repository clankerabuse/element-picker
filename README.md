# element-picker

Point at an element in a local page, and something else (a script, an agent)
can read exactly which node you meant — selector, box, computed styles, parent
chain.

Built for the Hermes desktop preview pane, where a packaged Electron app has no
DevTools/CDP port, so "inspect this div" has to happen inside the page. It works
anywhere a local HTTP server serves the page.

## Use

```bash
python3 serve.py                       # serve the current directory on :8765
python3 serve.py --port 9000 --dir ~/Projects/some-site/public
python3 serve.py --picks .picks        # where the pick files land
```

Open the printed URL, click **pick** (bottom left) or press `Alt+I`, hover to see
the outline, click the element. `Esc` cancels.

Every pick is written to `picks/last-pick.json`, appended to `picks/picks.log`,
and printed to the server's stdout as `=== PICKED <selector> | <tag> <w>x<h>`.

Read the last one:

```bash
cat picks/last-pick.json
curl -s http://127.0.0.1:8765/__pick
```

## What a pick contains

```json
{
  "selector": "#work > div.work-head",
  "tag": "div", "id": null, "classes": ["work-head"],
  "text": "index\n        05 entries",
  "rect": { "x": 0, "y": 182, "w": 960, "h": 55 },
  "styles": { "display": "flex", "font-size": "11px", "color": "rgb(172,168,159)", "...": "16 props" },
  "parents": [{ "tag": "section", "classes": ["work"], "selector": "#work" }, "..."],
  "url": "http://127.0.0.1:8765/", "ts": 1795047027587
}
```

## Using it without the server

Drop `<script src="/__picker.js"></script>` into any page served by your own dev
server (framework dev servers already serve files from disk — put `picker.js` in
the static root and add the tag). Without a `/__pick` endpoint the pick falls
back to `console.log` plus the selector on the clipboard.

Scripted picks:

```js
__picker.on();                       // enable hover outlines
__picker.pick('.work-head');         // pick by selector
__picker.describe('.work-head');     // just get the descriptor
```

Add `?picker=off` to any URL to skip the injection.

## Notes for agents

`AGENTS.md` is the handover doc: architecture, protocol, limitations and a
concrete backlog for extending it.
