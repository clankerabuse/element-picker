# element-picker

A Hermes Desktop UI plugin (`element-edit`) and nothing else. It lets the user
point at a DOM element inside the app's preview pane and attach its DOM/CSS to
the prompt (single pick, drag-sweep, Shift+click queue). One TypeScript source,
`desktop-plugin/src/plugin.ts`, compiled by plain `tsc` into one ESM file.

`NOTES.md` is the authoritative handover — read it before editing plugin
behaviour. There is no server half; `serve.py`/`picker.js` are gone, `example/`
survives as a static fixture.

## Commands

```bash
cd desktop-plugin
npm run build        # tsc -> build/plugin.js, then scripts/install.mjs syncs 3 places
npm run check        # typecheck without emitting
npm run install:plugin   # re-sync without compiling
```

`npm run build` writes `<repo>/plugin.js`, `<repo>/desktop/plugin.js`, and
`~/.hermes/desktop-plugins/element-edit/plugin.js` (live-watched by the app).

```bash
python3 -m http.server 8765 --directory example     # fixture: shadow DOM, iframe, 7 div.wrap
```

## Rules

- The loader imports `plugin.js` verbatim and accepts no other entry name. Never
  let a `.ts` file or a `build/` path land in the plugin folder.
- Reload after building: Cmd+K -> *Reload desktop plugins*. Load failures print
  in `~/.hermes/logs/desktop.log`.
- Plugin code may only use the public plugin/desktop SDK doors; do not patch
  host markup at runtime.
- Verify in-page behaviour by loading the extracted runtime strings, then arm
  and click in one `js()` call and read the result in a second (the resolve
  happens in a microtask). The `element-picker-dev` skill has the exact snippet.
- If a port is already serving something the user is looking at, use another
  port rather than killing theirs.
- A change is not done until a pick actually resolves in the running app.

## Layout

`desktop-plugin/src/plugin.ts` (all behaviour), `desktop-plugin/scripts/`,
`plugin.yaml`, `plugin.js`, `desktop/plugin.js`, `example/`, `NOTES.md`.
