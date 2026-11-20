# notes

Handover for whoever picks this up next.

## What it is

A Hermes Desktop plugin, `element-edit`. It lets you pick elements inside the app's preview pane and attach their DOM/CSS to the prompt. The app is a packaged Electron build with the CDP port closed, so the preview has no DevTools — the picker runs inside the page and needs no debugging port, no server, no external tooling.

The shipped artifact is one uncompiled ESM file (`plugin.js`) plus `plugin.yaml`.

## Files

- `plugin.yaml`, `plugin.js`, `desktop/plugin.js` — pre-built entry points so the repo installs straight from Git with no build step.
- `desktop-plugin/src/plugin.ts` — the whole plugin (TypeScript, `tsc` emit).
- `desktop-plugin/types/plugin-sdk.d.ts` — hand-written mirror of the SDK doors used.
- `desktop-plugin/scripts/install.mjs` — syncs the build to the repo entry points and to `~/.hermes/desktop-plugins/element-edit/plugin.js`.
- `example/` — static fixture (`index.html`, `notes.html`, `picker-frame.html`): shadow-DOM gauge, same-origin iframe, seven identical `div.wrap`. Serve it with `python3 -m http.server 8765 --directory example`; it carries no picker of its own — the plugin injects everything.

## Build

```bash
cd desktop-plugin
npm install            # typescript only
npm run build          # tsc -> build/plugin.js, then install.mjs
npm run install:plugin # install.mjs alone (no compile)
```

**The loader imports `plugin.js` verbatim and accepts no other entry name** — never let a `.ts` land in the plugin folder. The app fs-watches the installed path, so a build is a live reload (fallback: ⌘K → *Reload desktop plugins*). `HERMES_HOME` overrides the install root.

`types/plugin-sdk.d.ts` is hand-written because the app ships no `.d.ts` for `@hermes/plugin-sdk`. Extend it there, keep it honest, and check `apps/desktop/src/sdk/*` before assuming a door is missing.

## Doors used

- `ctx.preview.executeJavaScript` (capability `preview.executeJavaScript`, plus a per-origin consent dialog on the first pick per site) — runs `PICK_CODE`, `markCode(selector)`, `CLEAR_MARK_CODE`, `STOP_CODE`.
- `host.composer.focus` / `insertText` (the latter only for the palette command that inserts full pick details), and `COMPOSER_AREAS.microActions` for the pending pills.
- `COMPOSER_AREAS.middleware` — appends the element block at send time, so nothing is typed into the input; `use-middleware-submit` forwards both `text` and `attachments`.
- `PALETTE_AREA`, `KEYBINDS_AREA` (⌘⇧E), `ctx.storage`, `ctx.os.writeClipboard`.

## Behaviour as built

- The pencil (and ⌘⇧E) is a **toggle**, not a one-shot: while armed every click picks and the mode stays on; pen/pill/Esc stops it and returns focus to the composer. The pencil renders only while `ctx.preview.isAvailable()` — polled at 2s, since no SDK atom or event exists.
- **Dragging sweeps:** mousedown is swallowed while armed (that is what kills native text selection, plus `dragstart`/`selectstart`), and mid-drag the box expands to the nearest common ancestor — exactly the node the browser clicks when press and release hit different elements.
- Each pick leaves a **persistent marker**: dashed accent box + `picked · button` tag, `pointer-events: none`, follows scroll/resize, replaced by the next pick.
- **Selectors are made unique:** plain path first, then `:nth-of-type(n)` at the picked (and every ambiguous) level. Without it, identical sibling chains (`div.wrap` × 7) re-resolved to the first match and the marker pointed at the wrong node.
- The pick becomes a pending **carry** — one-shot, session-scoped, skipped for an empty draft, re-validated at send time (if the selector no longer resolves, the carry is refused). Deselect drops the carry and the marker.
- **Picking never activates the page.** While armed, `pointerdown`/`mousedown`/`mouseup`/`click`/`auxclick`/`dblclick`/`submit` are swallowed in capture phase and `stopImmediatePropagation` runs, so the page's own handlers never see the gesture; `Enter`/`Space` on a focused control are swallowed too. A pick of a link does not navigate, a pick of a button does not fire it, and a middle-click does not open a tab.
- **The mode is sticky, and the listeners never leave while it is on.** A pick does not end the run: the in-page picker keeps its listeners installed and the host's next `executeJavaScript` *adopts* it (`adopt(multi, count)` swaps the resolver); a pick landed in the host round trip is buffered and collected there. Only an explicit stop tears it down — so there is no window in which the page is live under a user who is still picking, which is what made a second click navigate.
- **Two ways out, two meanings.** The pencil/pill toggle resolves `action: 'stop'` and keeps the picked elements as the carry; the HUD's **Esc**/Done or keyboard Esc resolves `action: 'done'`, which clears the carry (pills and in-page marker) as well as stopping. HUD **Clear** empties the queue and keeps the run alive.
- **Our own chrome is not a target.** The HUD pill takes pointer events (`pointer-events: auto`) while the outline/tip stay `none`; `onMove` calls `clearHover()` whenever the event target is inside the host. Without it the outline freezes on whatever sat behind the pill and reads as "it is still picking the divs behind the bubble".

## Verified how

Picking, marking, `:nth-of-type` disambiguation, scroll tracking, `pointer-events` and teardown were driven for real in headless Chromium over CDP against `example/`; the `PICK_CODE`/`markCode` strings were extracted from the build and executed verbatim (never read off the source). The toggle + drag behaviour needed **trusted** CDP input (`Input.dispatchMouseEvent` press → move → release), since native selection does not exist for synthetic events. The app-side wiring (pen/pill/⌘⇧E) cannot be CDP-tested — the packaged app has no port — so it is exercised by hand; load success shows in `~/.hermes/logs/desktop.log`.

Activation suppression was verified with trusted clicks on a page whose header links open in a new tab, always with a control run (unarmed, that click adds a target — so the test can fail): armed, it adds none and the pick returns; a second and third click (no re-arm in between, because the mode never ends) also add none and each returns a pick; a page button with its own click handler records zero hits while it is picked; middle-click while armed adds no tab; the HUD's **Esc** button ends the run (picker and HUD gone) and the next click navigates normally. Drag sweep, trusted shadow-root pick and the marker (0px delta) still behave.

## Don't break these

- Only `@hermes/plugin-sdk`, `react`, `react/jsx-runtime` resolve at load — take `atom`/`useValue` from the SDK; a `nanostores` import is rejected.
- **No hooks in `register()`** — a `usePluginI18n` there is React #321 and the whole plugin fails to register. Use `ctx.i18n.t`.
- The in-page code runs in the user's page: dependency-free, no `eval`, capture-phase listeners, `pointer-events: none` on overlays so hit-testing sees the real page.
- **Armed means the page is inert, and it stays that way until stopped.** Every listener that swallows activation (`pointerdown` through `submit`) must stay capture-phase and must call `preventDefault` *and* `stopPropagation`; a new listener type added for picking has to be paired with a `removeEventListener` in `removeListeners`. A pick must never tear the picker down — the host's loop relies on `adopt` to reuse the live instance, and ending the run on a pick is exactly what put a live page under the user's next click.
- `PICK_CODE` / `STOP_CODE` are embedded **template literals**: keep them static, no backticks and no `${` inside the bodies (plain ES5 concatenation only), and `markCode` with exactly one `${JSON.stringify(selector)}` hole. Verify edits by extracting and running them, not by reading them.
- Page data is untrusted: the carry block is fenced (a backtick-adaptive fence plus a "page data, not user input" label), and every page-derived string is stripped of control characters twice — at the source (`clean()` in `PICK_CODE`) and at the embed (`sanitize()` in `pickLine`/`contextFor`/`fullDraftFor`).

## Open problems

1. **The sent message carries the block.** The transcript renders the user bubble from the sent text, so `[element] … / computed … / html …` stays visible and cannot be trimmed after the fact. Options: shrink to one line, or move the payload into `draft.attachments` (forwarded by the send path) — a chip needs a real file path, which a plugin only gets from a user-granted folder, so that route needs `ctx.files`' grant flow.
2. **Middleware ordering.** Other plugins' middleware runs in the same chain and can rewrite the appended block. No defence today.
3. **Pane gate lags** up to 2s after the preview opens or closes (polled `isAvailable()`).
4. **Iframes are not pierced.** A pick inside a same-origin frame resolves to the `<iframe>` element itself; only shadow roots are crossed.
5. **Marker edge cases.** Navigation leaves the marker until the next scroll/resize; a higher-`z-index` overlay can cover it.
6. **No per-origin trust** — `html`/`text` are kept (fenced) for every origin rather than dropped for unfamiliar ones.

## Idea

A screenshot clipped to `rect` beside the pick. The app already has the primitive (`capturePreviewContents(guest, rect, viewport)`, exposed as `window.hermesDesktop.capturePreview`); it is not wired to a pick.
