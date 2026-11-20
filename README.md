# Element Picker for Hermes Desktop

Point at any element in the Hermes Desktop preview pane and tell the agent what to change.

Element Picker attaches the exact CSS selector, bounding box, matched stylesheet rules, computed styles, and HTML straight to your prompt — no DevTools, no copy-pasting selectors, no guessing which `div` you meant.

- **Click** any element to pin it to your prompt
- **Drag** across elements to capture their shared container
- **Shift + Click** to queue multiple elements at once
- **Inert while picking** — links won't navigate, buttons won't fire, forms won't submit

## Install

Zero build step. Pick either method inside **Hermes Desktop**:

**One-click install:**
```
hermes://plugin/install?repo=clankerabuse/element-picker&enable=1
```

**From the app:**
1. Open **Capabilities → Plugins → Install from Git**
2. Paste `clankerabuse/element-picker` and enable it

## How to Use

1. Open any page in the **Preview** pane.
2. Click the **Inspect** button in the chat composer (or press `⌘⇧E` / `Ctrl+Shift+E`).
3. Click the element(s) you want to change, type your prompt, and hit send.

*(On your first pick per site, click **Allow** when Hermes asks for permission to inspect the preview page.)*
