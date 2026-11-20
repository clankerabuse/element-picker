# element-picker

A plugin for **Hermes Desktop**: point at any element in the preview pane and hand the agent its exact selector, box, matched CSS rules, computed styles and redacted HTML — no DevTools. The app is a packaged Electron build with the CDP port closed, so the picker runs inside the page instead.

## Install

The repo ships pre-built (`plugin.js` + `plugin.yaml`), so there is no build step:

- **Capabilities → Plugins → Install from Git** → `clankerabuse/element-picker`
- One-click: `hermes://plugin/install?repo=clankerabuse/element-picker&enable=1`
- From a clone: `cd desktop-plugin && npm install && npm run build` — compiles, syncs the repo entry points, installs to `~/.hermes/desktop-plugins/element-edit/plugin.js`, and hot-reloads live.

## Using it

- **Open:** the inspect button in the composer action row, `⌘⇧E` (`Ctrl+Shift+E`), or `⌘K` → *Element Picker: Pick element in preview*. It appears only while a preview page is open.
- **Pick:** one click pins the element and the picker stays on. Every further click picks again; the newest pick replaces the pending carry.
- **HUD:** a floating pill at the bottom of the page — *Click element · drag to group · Shift+click queues*, plus **Queue**, **Clear**, **Esc** — stays up for as long as the picker is selected.
- **Turn it off:** the pencil again keeps what you picked as the carry; the HUD's **Esc** or Esc on the keyboard stops picking *and* deselects everything.
- **Multi-pick:** `Shift`+click (or **Queue** in the HUD) appends numbered pins instead of replacing the carry; clicking a pinned node removes it.
- **Drag:** press and drag across siblings — the outline expands to their nearest common ancestor, without selecting page text.
- **Inert while armed:** picking a link does not follow it, a button does not fire, a form does not submit. The page only reacts again once you leave pick mode.
- **Capture:** pierces open shadow roots (`>>>` segments), records the winning stylesheet rules in cascade order, and redacts password/token/secret fields before anything leaves the page.
- **Carry:** picks wait as pills in the composer's micro-action strip (`✕ #1 div.hero-copy · 534×342`, `Clear all (N)`); on send, `composer.middleware` appends the fenced DOM + CSS block after your prompt.

## Develop

```bash
cd desktop-plugin
npm install && npm run build    # tsc -> build/plugin.js, syncs repo root + desktop/, installs locally
npm run check                   # typecheck only
```

`example/` is a static fixture for testing picks — a shadow-DOM gauge, a same-origin iframe, and identical sibling cards:

```bash
python3 -m http.server 8765 --directory example    # http://127.0.0.1:8765/
```

See `NOTES.md` for the handover, the load-bearing rules and the open problems. MIT licensed.
