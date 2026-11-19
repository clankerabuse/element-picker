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
    GET    /__events      Server-Sent Events: one message per pick / queued pick
                          / edit / clear as event: pick|queue|edit|clear, plus a
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

_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


def safe(value) -> str:
    """Page data is untrusted: never let control characters reach a terminal."""
    if value is None:
        return ""
    return _CTRL.sub("", value if isinstance(value, str) else str(value))

PICKER_JS = b""
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
            send("hello", {"queue": len(read_queue()), "last_pick": os.path.exists(LAST)})
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
        if path.startswith("/__picker.js"):
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(PICKER_JS)))
            self.end_headers()
            self.wfile.write(PICKER_JS)
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
        inject = "picker=off" not in (self.path.split("?")[1] if "?" in self.path else "")
        if inject and fs_path.endswith((".html", ".htm")) and os.path.isfile(fs_path):
            with open(fs_path, "rb") as fh:
                html = fh.read()
            if SNIPPET not in html:
                html = html.replace(b"</body>", SNIPPET + b"</body>")
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
    global PICKER_JS, PICKS_DIR, LAST, LOG, QUEUE, EDIT

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", nargs="?", type=int, default=8765, help="port to bind (default 8765)")
    ap.add_argument("--dir", default=os.getcwd(), help="directory to serve (default: cwd)")
    ap.add_argument("--picks", default=os.path.join(HERE, "picks"),
                    help="where last-pick.json and picks.log live (default: ./picks next to this script)")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    args = ap.parse_args()

    root = os.path.abspath(os.path.expanduser(args.dir))
    if not os.path.isdir(root):
        sys.exit("no such directory: %s" % root)

    PICKS_DIR = os.path.abspath(os.path.expanduser(args.picks))
    LAST = os.path.join(PICKS_DIR, "last-pick.json")
    LOG = os.path.join(PICKS_DIR, "picks.log")
    QUEUE = os.path.join(PICKS_DIR, "queue.json")
    EDIT = os.path.join(PICKS_DIR, "last-edit.json")
    os.makedirs(PICKS_DIR, exist_ok=True)
    with open(os.path.join(HERE, "picker.js"), "rb") as fh:
        PICKER_JS = fh.read()

    handler = lambda *a, **kw: Handler(*a, directory=root, **kw)  # noqa: E731
    srv = ThreadingHTTPServer((args.host, args.port), handler)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: binding %s — this dev server trusts its clients; keep it loopback." % args.host, flush=True)
    print("serving %s at http://%s:%d/ (add ?picker=off to skip injection)" % (root, args.host, args.port), flush=True)
    print("picker: 'pick' or Alt+I · 'queue' or Alt+Q · picks -> %s" % LAST, flush=True)
    print("watch: GET /__events (SSE) · queue: GET /__picks · edits: picks/last-edit.json", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
