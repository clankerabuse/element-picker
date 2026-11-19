# notes

Context for whoever picks this up next.

## What it is

A local static server plus a ~6 KB in-page script. You click an element in the
browser, the pick is written to `picks/last-pick.json`, and anything else (a
script, an agent) reads it instead of guessing at "that div".

It exists because the Hermes desktop app is a packaged Electron build with the
CDP port closed, so the preview pane has no DevTools. The picker runs inside the
page instead and needs no debugging port.

## Files

- `serve.py` — stdlib only. Serves a directory unchanged, injects
  `<script src="/__picker.js">` into HTML responses in memory, answers
  `POST /__pick`.
- `picker.js` — badge, outline, selector builder, descriptor, `window.__picker`
  API (`on`, `off`, `describe`, `pick`).
- `picks/` — `last-pick.json` (pretty) and `picks.log` (JSONL). Gitignored.

## Protocol

```
GET  /__picker.js   the script
GET  /__pick        last pick as JSON (404 {"empty":true} before the first)
POST /__pick        writes last-pick.json + picks.log, prints "=== PICKED ..."
```

A pick carries `selector`, `tag`, `id`, `classes`, `text` (160 chars), `rect`,
`styles` (16 computed properties), `parents` (four levels), `url`, `ts`.

## Don't break these

- The served directory is never modified — injection happens at response time.
- The script is external, not inline: `script-src 'self'` sites would block an
  inline tag.
- Listeners are capture-phase and the pick calls `preventDefault()` +
  `stopPropagation()`, so links and buttons can be picked without firing.
- `no-store` on every response, or the user picks a stale node after an edit.
- The picker disarms itself after each pick.
- A selector that is not unique says so in a `/* N matches */` comment instead
  of pretending.

## Limits

No shadow-DOM or iframe piercing (a pick inside a frame returns the `<iframe>`);
selectors are structural, not stable component ids; `rect` is viewport
coordinates, no scroll offset; one pick at a time; no auth, binds 127.0.0.1.

## Ideas, roughly in order

1. SSE (`GET /__events`) so a watcher reacts without polling the file.
2. Add `pageX/pageY` so picks below the fold are unambiguous.
3. Pierce `composedPath()` for shadow roots, same-origin iframes with a frame
   prefix.
4. A pick queue with notes (`{note}`, `GET /__picks`) — "mark these five things".
5. Report the winning CSS rule: walk `document.styleSheets`, `el.matches()` each
   `selectorText`, return matched declarations in order.
6. Live property edit in the badge (sets `el.style`, POSTs the change) so the
   user can see it before a source edit.
7. Headless screenshot clipped to `rect`, saved beside the pick.

Keep it zero-dependency and single-file on the client; that is why it can be
pasted into any dev server.
