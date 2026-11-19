# AGENTS.md — element-picker handover

Read this before changing anything. It says what the tool is for, what is
load-bearing, and what was already considered.

## Why it exists

The Hermes desktop app is a **packaged Electron build**: its CDP port is closed
by design (`apps/desktop/electron/dev-cdp.ts`), so there is no in-app DevTools
console to inspect the preview pane, and relaunching the app to get one destroys
the user's session. This tool gets the same outcome from inside the page: the
user points at a node, the pick is persisted, an agent reads it.

It was extracted from `~/Projects/slopstarvip/dev/` (commit `ccc0cc5`) where it
was first used to change two elements on that site.

## Files

| file | role |
| --- | --- |
| `serve.py` | stdlib-only static server; injects the script into HTML, serves it, receives picks |
| `picker.js` | the whole client: badge, hit-testing overlay, selector builder, descriptor, `window.__picker` API |
| `picks/last-pick.json` | the most recent pick, pretty-printed (this is what you read) |
| `picks/picks.log` | JSONL history, one pick per line |
| `README.md` | human quickstart |

No dependencies, no build step, no tests to run. Python 3 standard library and
one ~6 KB IIFE.

## Protocol

```
GET  /__picker.js     picker source, text/javascript, no-store
GET  /__pick          last pick as JSON; 404 {"empty": true} before the first one
POST /__pick          pick body → writes last-pick.json, appends picks.log,
                      prints "=== PICKED <selector> | <tag> <w>x<h>" to stdout
```

Pick body (all fields produced by `describe()` in `picker.js`):

```json
{
  "selector": "#work > div.work-head",
  "tag": "div",
  "id": null,
  "classes": ["work-head"],
  "text": "first 160 chars of textContent",
  "rect": {"x": 0, "y": 182, "w": 960, "h": 55},
  "styles": {"display": "flex", "font-size": "11px", "...": "16 properties"},
  "parents": [{"tag": "section", "classes": ["work"], "selector": "#work"}],
  "url": "http://127.0.0.1:8765/",
  "ts": 1795047027587
}
```

`serve.py` adds `"received"` (local ISO timestamp). `styles` is the fixed
`keysOfInterest` list at the top of `picker.js`; `parents` is four levels deep.

## Load-bearing behaviour (do not silently change)

- **The served directory is never written to.** Injection happens in memory at
  response time. Keep it that way; a tool that edits the site under test is a
  different, much riskier tool.
- **The script is external, not inline.** `script-src 'self'` sites (all of the
  user's) would block an inline snippet; `/__picker.js` same-origin passes.
- **Listeners are capture-phase and the pick calls `preventDefault()` +
  `stopPropagation()`.** That is what lets you pick a link or a button without
  navigating or submitting. Losing capture-phase silently breaks picking `<a>`.
- **`setOn(false)` after every pick** — a picker that stays armed eats the next
  click the user meant for the page.
- **`no-store` on every response** (see `end_headers`). Without it the browser
  serves a stale page from cache after an edit and the user picks an old node.
- **Selector builder** prefers `#id`, else `tag.class1.class2`, adding
  `:nth-of-type(n)` only when siblings share the tag, and appends a `/* N
  matches */` comment instead of lying when it is not unique. Keep the honesty:
  an agent acting on an ambiguous selector wastes a round trip.
- **`text-box` fields are viewport coordinates.** No `scrollX/scrollY` is added
  yet (see backlog); do not assume document coordinates.

## Limitations to know before promising anything

- **No shadow DOM or iframe piercing.** `e.target` is the host element; a pick
  inside an iframe returns the `<iframe>`.
- **Selectors are structural.** A site that re-renders into different wrappers
  invalidates them; they identify the node, not the component.
- **Only 16 computed properties** and a 160-char text excerpt.
- **Injection needs a literal `</body>`** in the HTML response.
- **One pick at a time.** There is no queue and no annotation field.
- **No authentication.** Binds `127.0.0.1` by default; `--host 0.0.0.0` exposes
  a write endpoint to the LAN/tailnet, so don't do it casually.
- **Picks are plain JSON on disk.** `picks/` is gitignored; if that changes,
  remember a pick can contain page text.

## Verify a change like this

```bash
cd ~/Projects/element-picker
python3 serve.py 8799 --dir /tmp/whatever &   # or any static dir
# drive a pick headlessly, then assert the file:
cat picks/last-pick.json
```

With the Hermes browser tools: `goto_url('http://127.0.0.1:8799/')`, then
`js("__picker.pick('.selector')")`, then read `picks/last-pick.json` and confirm
the selector, `rect` and one computed style. That path exercises injection,
client, POST, and the file write in one shot.

## Backlog — worth doing, roughly in order

1. **Live push instead of polling.** `GET /__events` as SSE (or a long-poll on
   `/__pick?since=<ts>`), so an agent loop reacts to a pick without re-reading
   the file. Today the agent reads on demand or watches stdout.
2. **Scroll-aware geometry.** Add `pageX/pageY` (add `scrollX/scrollY`), so a
   pick below the fold is unambiguous in document space.
3. **Shadow DOM + iframe.** Walk `e.composedPath()` for the host chain; for
   same-origin iframes, forward a pick from the frame's own picker instance with
   a frame path prefix (`iframe#preview >>> .inner`).
4. **Picker queue + notes.** `POST /__pick` with `{note}` and a `GET /__picks`
   returning the list; badge shows a count. Turns the tool into "mark these five
   things", which is how design reviews actually happen.
5. **Return the winning CSS rule.** Walk `document.styleSheets` (catching the
   CORS SecurityError), test every `cssRules[i].selectorText` against the node
   with `el.matches()`, and report matched selectors + declarations + rule
   order. That is the "which rule won?" question in one pick.
6. **Live property edit.** A tiny inline editor in the badge (property, value)
   that sets `el.style` and POSTs the change, so the user can see it before any
   source edit; the agent then applies it in the real stylesheet.
7. **Node screenshot.** Server-side headless capture clipped to `rect`, saved
   next to the pick, so a vision pass can confirm "that thing" without a full
   viewport screenshot.
8. **Stable hooks, optionally.** An opt-in "stamp" mode that writes
   `data-pick-id` onto picked nodes (in memory only) so repeat picks of the same
   node are comparable even when the markup shifts.
9. **Bookmarklet build.** Concatenate `picker.js` into a `javascript:` URL so it
   can be dropped onto any page, no server. Fallback path already logs and
   copies the selector.

## Conventions

- Keep it **zero-dependency** and **single-file** on the client side; that is why
  it can be pasted into arbitrary dev servers.
- Any new field in the descriptor is additive; never rename `selector`, `rect`,
  `styles` or `parents` — both the README and other agents' habits depend on
  them.
- If a change alters the protocol, update `README.md` and this file in the same
  commit.
