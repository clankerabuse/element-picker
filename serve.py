#!/usr/bin/env python3
"""Static dev server with a point-and-click element picker.

Serves any directory unchanged, but injects picker.js into every HTML response
so you can click a node in a browser and have a program (or an agent) read
exactly which node you mean.

    python3 serve.py                      # serve cwd on :8765
    python3 serve.py --port 9000 --dir ~/Projects/some-site/public
    python3 serve.py --picks .picks       # where last-pick.json + picks.log go

Protocol
    GET    /__picker.js   the client script (injected as an external tag)
    GET    /__pick        the last pick as JSON (404 before the first one)
    POST   /__pick        a pick arrives as JSON, is written to
                          <picks>/last-pick.json, appended to <picks>/picks.log,
                          printed to stdout and broadcast on /__events
    GET    /__picks       the pick queue as a JSON array (empty before use)
    POST   /__picks       {pick: {...}, note: "..."} appends one queued pick
                          (a bare pick object with an optional "note" inside
                          also works); index is assigned server-side
    DELETE /__picks       clears the queue
    POST   /__edit        {selector, prop, value} a live style edit made in the
                          page; written to <picks>/last-edit.json + picks.log
    GET    /__live.js     the reload client (injected as an external tag too)
    GET    /__rev         {"rev", "files", "subs"} — the change counter the client
                          polls once a second, the fallback for a dead SSE
    GET    /__reload      force every open page to refresh (bumps the counter)
    GET    /__events      Server-Sent Events: one message per pick / queued pick
                          / edit / clear as event: pick|queue|edit|clear, plus a
                          "reload" event when a served file changes, and a
                          ": ping" comment every 15s — a watcher reacts without
                          polling the files

The served directory is never modified, and nothing here is meant for
production: it is a local instrument for "change *that* element" work.
"""

from __future__ import annotations

import argparse
import json
import os
import queue as _queue
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SNIPPET = b'<script src="/__picker.js"></script>'
LIVE_SNIPPET = b'<script src="/__live.js" defer></script>'
LIVE_ENABLED = True

_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


def safe(value) -> str:
    """Page data is untrusted: never let control characters reach a terminal."""
    if value is None:
        return ""
    return _CTRL.sub("", value if isinstance(value, str) else str(value))

LIVE_JS = b"""/* Live reload for serve.py.
 *
 * External script on purpose (script-src 'self' sites block inline tags).
 * Two channels, because one is not enough in the real world:
 *   1. push  - /__events (SSE) delivers a "reload" the moment a file changes
 *   2. pull  - /__rev is a revision counter polled once a second, so a frozen
 *              tab, a dropped stream or a server restart still catches up
 * A reload keeps the viewport where it was. ?live=off skips this file.
 */
(function () {
  if (window.__live) return;

  var SCROLL_KEY = "__live:scroll";
  var href = location.href;
  var state = window.__live = {
    rev: null, events: 0, reloads: 0, sse: "connecting", files: null, hold: false
  };

  function remember() {
    try {
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ href: href, y: window.scrollY }));
    } catch (e) {}
  }

  try {
    var raw = sessionStorage.getItem(SCROLL_KEY);
    if (raw) {
      sessionStorage.removeItem(SCROLL_KEY);
      var saved = JSON.parse(raw);
      if (saved && saved.href === href && saved.y > 0) {
        window.scrollTo(0, saved.y);
        window.addEventListener("load", function () { window.scrollTo(0, saved.y); });
      }
    }
  } catch (e) {}

  var timer = null;

  function refresh(files) {
    if (files) state.files = files;
    if (state.hold) return;                     // window.__live.hold = true pauses it
    clearTimeout(timer);
    // editors write a file in several steps: one reload per save, not per write
    timer = setTimeout(function () {
      state.reloads++;
      remember();
      location.reload();
    }, 120);
  }

  state.refresh = function () { refresh(null); };   // window.__live.refresh() on demand

  function note(info) {
    if (!info) return;
    if (typeof info.rev === "number" && (state.rev === null || info.rev > state.rev)) {
      state.rev = info.rev;
    }
  }

  // -- push ---------------------------------------------------------------
  try {
    var es = new EventSource("/__events");
    state.es = es;
    es.addEventListener("hello", function (ev) {
      state.sse = "open";
      try { note(JSON.parse(ev.data)); } catch (e) {}
    });
    es.addEventListener("reload", function (ev) {
      state.events++;
      var info = null;
      try { info = JSON.parse(ev.data); } catch (e) {}
      note(info);
      refresh(info && info.files);
    });
    es.onerror = function () { state.sse = "retrying"; };
  } catch (e) { state.sse = "unavailable"; }

  // -- pull ---------------------------------------------------------------
  var busy = false;
  function poll() {
    if (busy || document.readyState === "loading") return;
    busy = true;
    var req = new XMLHttpRequest();
    req.open("GET", "/__rev", true);
    req.timeout = 4000;
    req.onload = function () {
      busy = false;
      if (req.status !== 200) { state.sse = state.sse === "open" ? "open" : "offline"; return; }
      var body = null;
      try { body = JSON.parse(req.responseText); } catch (e) { return; }
      if (typeof body.rev !== "number") return;
      if (state.rev === null) { state.rev = body.rev; return; }   // baseline
      if (body.rev !== state.rev) {
        state.events++;
        note(body);
        refresh(body.files);
      }
    };
    req.onerror = req.ontimeout = function () { busy = false; state.sse = "offline"; };
    req.send();
  }
  poll();
  setInterval(poll, 1000);
})();
"""

# Watchlist: things that change what the page looks like. Editors also rewrite
# temp files, so sweep only these extensions and skip the usual noise dirs.
WATCH_EXTS = {
    ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json", ".svg",
    ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".woff", ".woff2",
}
SKIP_DIRS = {"picks", "node_modules", ".git", "__pycache__"}

PICKER_LOCK = threading.Lock()

# Bumped only when a served file changes (picks must never trigger a reload).
# /__rev hands it to the client, whose 1s poll is the fallback for a dead SSE.
REV = 0
LAST_CHANGED: list = []
REV_LOCK = threading.Lock()


def bump_rev(files: list) -> int:
    global REV, LAST_CHANGED
    with REV_LOCK:
        REV += 1
        LAST_CHANGED = list(files)
        return REV


def live_state() -> dict:
    with REV_LOCK:
        return {"rev": REV, "files": list(LAST_CHANGED), "subs": len(BUS.subs)}


def picker_bytes() -> bytes:
    with PICKER_LOCK:
        return PICKER_JS


def set_picker_bytes(data: bytes) -> None:
    global PICKER_JS
    with PICKER_LOCK:
        PICKER_JS = data


def stable_read(path: str, tries: int = 4) -> bytes:
    """Read a file an editor may be halfway through writing: accept only a read
    whose size and mtime held still across it."""
    data = b""
    for _ in range(tries):
        try:
            before = os.stat(path)
            data = open(path, "rb").read()
            after = os.stat(path)
        except OSError:
            return data
        if (before.st_mtime_ns, before.st_size) == (after.st_mtime_ns, after.st_size) \
                and len(data) == after.st_size:
            return data
        time.sleep(0.08)
    return data


def snapshot(root: str) -> dict:
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if os.path.splitext(name)[1].lower() not in WATCH_EXTS:
                continue
            path = os.path.join(dirpath, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            out[path] = (st.st_mtime_ns, st.st_size)
    return out


def watch_loop(root: str, picker_path: str, interval: float = 0.4) -> None:
    """Publish "reload" when a served file changes.

    Polling rather than inotify keeps the server stdlib-only, and a 0.4s sweep
    of a fixture tree costs nothing. picker.js is watched separately so an edit
    to it is picked up without restarting the server.
    """
    prev = snapshot(root)
    try:
        st = os.stat(picker_path)
        picker_stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        picker_stamp = None

    while True:
        time.sleep(interval)
        cur = snapshot(root)
        changed = [os.path.relpath(p, root) for p, stamp in cur.items() if prev.get(p) != stamp]
        changed += [os.path.relpath(p, root) for p in prev if p not in cur]
        prev = cur

        try:
            st = os.stat(picker_path)
            stamp = (st.st_mtime_ns, st.st_size)
        except OSError:
            stamp = None
        if stamp != picker_stamp:
            picker_stamp = stamp
            fresh = stable_read(picker_path)
            if fresh:
                set_picker_bytes(fresh)
                changed.append(os.path.basename(picker_path))

        if changed:
            changed.sort()
            rev = bump_rev(changed)
            print("\n=== RELOAD rev=%d %s" % (rev, safe(", ".join(changed[:4])
                                     + (" +%d more" % (len(changed) - 4) if len(changed) > 4 else ""))),
                  flush=True)
            BUS.publish("reload", {"rev": rev, "files": changed, "at": time.time()})

PICKS_DIR = os.path.join(HERE, "picks")
LAST = os.path.join(PICKS_DIR, "last-pick.json")
LOG = os.path.join(PICKS_DIR, "picks.log")
QUEUE = os.path.join(PICKS_DIR, "queue.json")
EDIT = os.path.join(PICKS_DIR, "last-edit.json")

QUEUE_LOCK = threading.Lock()


class Bus:
    """Fan-out for SSE subscribers; each is a bounded queue drained by its
    connection thread. A full queue means a dead watcher: drop it."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.subs: list[_queue.Queue] = []

    def subscribe(self) -> _queue.Queue:
        q = _queue.Queue(maxsize=128)
        with self.lock:
            self.subs.append(q)
        return q

    def unsubscribe(self, q: _queue.Queue) -> None:
        with self.lock:
            if q in self.subs:
                self.subs.remove(q)

    def publish(self, event: str, data: dict) -> None:
        with self.lock:
            subs = list(self.subs)
        for q in subs:
            try:
                q.put_nowait({"event": event, "data": data})
            except _queue.Full:
                self.unsubscribe(q)


BUS = Bus()


def log_append(entry: dict) -> None:
    entry = dict(entry)
    entry.setdefault("ts", time.time())
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")


def read_queue() -> list:
    try:
        with open(QUEUE, encoding="utf-8") as fh:
            arr = json.load(fh)
        return arr if isinstance(arr, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def write_queue(arr: list) -> None:
    with open(QUEUE, "w", encoding="utf-8") as fh:
        json.dump(arr, fh, indent=2)


class Handler(SimpleHTTPRequestHandler):
    server_version = "element-picker"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=kwargs.pop("directory"), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args):  # noqa: A002 - base class signature
        if self.path.startswith("/__") or self.command == "POST" or self.command == "DELETE":
            sys.stderr.write("%s - %s\n" % (self.address_string(), safe(format % args)))

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    MAX_BODY = 2 * 1024 * 1024  # a descriptor is a few KB; 2 MB is generous

    def _read_body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._json({"error": "bad length"}, 400)
            self.close_connection = True
            return None
        if length > self.MAX_BODY:
            self._json({"error": "body too large"}, 413)
            self.close_connection = True
            return None
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            self._json({"error": "bad json"}, 400)
            return None
        if not isinstance(data, dict):
            self._json({"error": "expected an object"}, 400)
            return None
        return data

    # -- SSE ---------------------------------------------------------------

    def _sse(self) -> None:
        q = BUS.subscribe()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.end_headers()

        def send(name: str, payload) -> None:
            body = "event: %s\ndata: %s\n\n" % (name, json.dumps(payload))
            self.wfile.write(body.encode())
            self.wfile.flush()

        try:
            send("hello", {"queue": len(read_queue()), "last_pick": os.path.exists(LAST),
                           "rev": live_state()["rev"]})
            while True:
                try:
                    msg = q.get(timeout=15)
                except _queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                send(msg["event"], msg["data"])
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # watcher went away
        finally:
            BUS.unsubscribe(q)
            self.close_connection = True

    # -- GET ---------------------------------------------------------------

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/__events":
            self._sse()
            return
        if path == "/__rev":
            self._json(live_state())
            return
        if path == "/__reload":
            # force every open page to refresh (no file had to change)
            rev = bump_rev(["__reload"])
            BUS.publish("reload", {"rev": rev, "files": ["__reload"], "at": time.time()})
            print("\n=== RELOAD forced (rev=%d)" % rev, flush=True)
            self._json({"ok": True, "rev": rev})
            return
        if path.startswith("/__live.js"):
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(LIVE_JS)))
            self.end_headers()
            self.wfile.write(LIVE_JS)
            return
        if path.startswith("/__picker.js"):
            body = picker_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/__picks":
            with QUEUE_LOCK:
                arr = read_queue()
            self._json(arr)
            return
        if path.startswith("/__pick"):
            if os.path.exists(LAST):
                with open(LAST, encoding="utf-8") as fh:
                    self._json(json.load(fh))
            else:
                self._json({"empty": True}, 404)
            return

        fs_path = self.translate_path(self.path)
        if os.path.isdir(fs_path):
            fs_path = os.path.join(fs_path, "index.html")
        query = self.path.split("?")[1] if "?" in self.path else ""
        inject = "picker=off" not in query
        live = LIVE_ENABLED and "live=off" not in query
        if (inject or live) and fs_path.endswith((".html", ".htm")) and os.path.isfile(fs_path):
            with open(fs_path, "rb") as fh:
                html = fh.read()
            tags = b""
            if live and LIVE_SNIPPET not in html:
                tags += LIVE_SNIPPET
            if inject and SNIPPET not in html:
                tags += SNIPPET
            if tags:
                html = html.replace(b"</body>", tags + b"</body>")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return
        super().do_GET()

    # -- POST --------------------------------------------------------------

    def do_POST(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/__picks" or path == "/__picks/":
            self._queue_append()
            return
        if path.startswith("/__pick"):
            self._pick()
            return
        if path == "/__edit":
            self._edit()
            return
        self.send_error(404)

    def _pick(self) -> None:
        data = self._read_body()
        if data is None:
            return
        data["type"] = "pick"
        data["received"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        with open(LAST, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        log_append(data)
        rect = data.get("rect") or {}
        point = data.get("point") or {}
        print("\n=== PICKED %s | %s %sx%s at page %s,%s" % (
            safe(data.get("selector")), safe(data.get("tag")), safe(rect.get("w")), safe(rect.get("h")),
            safe(point.get("pageX")), safe(point.get("pageY"))), flush=True)
        BUS.publish("pick", data)
        self._json({"ok": True})

    def _queue_append(self) -> None:
        data = self._read_body()
        if data is None:
            return
        if isinstance(data.get("pick"), dict):
            pick, note = data["pick"], data.get("note")
        else:
            note = data.get("note")
            pick = {k: v for k, v in data.items() if k != "note"}
        entry = dict(pick)
        entry["note"] = note if isinstance(note, str) and note.strip() else None
        with QUEUE_LOCK:
            arr = read_queue()
            entry["index"] = len(arr) + 1
            entry["queueTs"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            arr.append(entry)
            write_queue(arr)
        log_append({"type": "queue", **entry})
        print("\n=== QUEUED #%d %s | note=%s" % (
            entry["index"], safe(entry.get("selector")), safe(entry["note"])), flush=True)
        BUS.publish("queue", entry)
        self._json({"ok": True, "index": entry["index"], "count": len(arr)})

    def _edit(self) -> None:
        data = self._read_body()
        if data is None:
            return
        for key in ("selector", "prop"):
            if not isinstance(data.get(key), str) or not data[key]:
                self._json({"error": "%s is required" % key}, 400)
                return
        data["type"] = "edit"
        data.setdefault("value", "")
        data["received"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        with open(EDIT, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        log_append(data)
        print("\n=== EDIT %s { %s: %s } (was %s)" % (
            safe(data["selector"]), safe(data["prop"]), safe(data["value"]),
            safe(data.get("prior")) or "unset"), flush=True)
        BUS.publish("edit", data)
        self._json({"ok": True})

    # -- DELETE -------------------------------------------------------------

    def do_DELETE(self):  # noqa: N802
        if self.path.split("?")[0] != "/__picks":
            self.send_error(404)
            return
        with QUEUE_LOCK:
            arr = read_queue()
            write_queue([])
        log_append({"type": "clear", "cleared": len(arr)})
        print("\n=== QUEUE CLEARED (%d)" % len(arr), flush=True)
        BUS.publish("clear", {"cleared": len(arr)})
        self._json({"ok": True, "cleared": len(arr)})


def main() -> None:
    global LIVE_ENABLED, PICKS_DIR, LAST, LOG, QUEUE, EDIT

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", nargs="?", type=int, default=8765, help="port to bind (default 8765)")
    ap.add_argument("--dir", default=os.getcwd(), help="directory to serve (default: cwd)")
    ap.add_argument("--picks", default=os.path.join(HERE, "picks"),
                    help="where last-pick.json and picks.log live (default: ./picks next to this script)")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    ap.add_argument("--no-live", action="store_true",
                    help="serve files without the reload client (no file watching)")
    args = ap.parse_args()

    LIVE_ENABLED = not args.no_live

    root = os.path.abspath(os.path.expanduser(args.dir))
    if not os.path.isdir(root):
        sys.exit("no such directory: %s" % root)

    PICKS_DIR = os.path.abspath(os.path.expanduser(args.picks))
    LAST = os.path.join(PICKS_DIR, "last-pick.json")
    LOG = os.path.join(PICKS_DIR, "picks.log")
    QUEUE = os.path.join(PICKS_DIR, "queue.json")
    EDIT = os.path.join(PICKS_DIR, "last-edit.json")
    os.makedirs(PICKS_DIR, exist_ok=True)
    picker_path = os.path.join(HERE, "picker.js")
    with open(picker_path, "rb") as fh:
        set_picker_bytes(fh.read())

    handler = lambda *a, **kw: Handler(*a, directory=root, **kw)  # noqa: E731
    srv = ThreadingHTTPServer((args.host, args.port), handler)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: binding %s — this dev server trusts its clients; keep it loopback." % args.host, flush=True)
    print("serving %s at http://%s:%d/ (add ?picker=off to skip injection)" % (root, args.host, args.port), flush=True)
    print("picker: 'pick' or Alt+I · 'queue' or Alt+Q · picks -> %s" % LAST, flush=True)
    print("watch: GET /__events (SSE) · queue: GET /__picks · edits: picks/last-edit.json", flush=True)
    if LIVE_ENABLED:
        threading.Thread(target=watch_loop, args=(root, picker_path), daemon=True).start()
        print("live: /__live.js — the page reloads when a served file changes "
              "(?live=off on the URL, --no-live for the server)", flush=True)
    else:
        print("live: off (--no-live)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
