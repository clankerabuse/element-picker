#!/usr/bin/env python3
"""Static dev server with a point-and-click element picker.

Serves any directory unchanged, but injects picker.js into every HTML response
so you can click a node in a browser and have a program (or an agent) read
exactly which node you mean.

    python3 serve.py                      # serve cwd on :8765
    python3 serve.py --port 9000 --dir ~/Projects/some-site/public
    python3 serve.py --picks .picks       # where last-pick.json + picks.log go

Protocol
    GET  /__picker.js   the client script (injected as <script src="/__picker.js">)
    POST /__pick        a pick arrives as JSON, is written to <picks>/last-pick.json
                        and appended to <picks>/picks.log, and printed to stdout
    GET  /__pick        the last pick as JSON (404 before the first one)

The served directory is never modified, and nothing here is meant for
production: it is a local instrument for "change *that* element" work.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SNIPPET = b'<script src="/__picker.js"></script>'

PICKER_JS = b""
PICKS_DIR = os.path.join(HERE, "picks")
LAST = os.path.join(PICKS_DIR, "last-pick.json")
LOG = os.path.join(PICKS_DIR, "picks.log")


class Handler(SimpleHTTPRequestHandler):
    server_version = "element-picker"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=kwargs.pop("directory"), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args):  # noqa: A002 - base class signature
        if self.path.startswith("/__") or self.command == "POST":
            sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- GET ---------------------------------------------------------------
    def do_GET(self):  # noqa: N802
        if self.path.startswith("/__picker.js"):
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(PICKER_JS)))
            self.end_headers()
            self.wfile.write(PICKER_JS)
            return
        if self.path.startswith("/__pick"):
            if os.path.exists(LAST):
                with open(LAST, encoding="utf-8") as fh:
                    self._json(json.load(fh))
            else:
                self._json({"empty": True}, 404)
            return

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        inject = "picker=off" not in (self.path.split("?")[1] if "?" in self.path else "")
        if inject and path.endswith((".html", ".htm")) and os.path.isfile(path):
            with open(path, "rb") as fh:
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
        if not self.path.startswith("/__pick"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            self._json({"error": "bad json"}, 400)
            return
        if not isinstance(data, dict):
            self._json({"error": "expected an object"}, 400)
            return
        os.makedirs(PICKS_DIR, exist_ok=True)
        data["received"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        with open(LAST, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(data) + "\n")
        rect = data.get("rect") or {}
        print("\n=== PICKED %s | %s %sx%s" % (
            data.get("selector"), data.get("tag"), rect.get("w"), rect.get("h")), flush=True)
        self._json({"ok": True})


def main() -> None:
    global PICKER_JS, PICKS_DIR, LAST, LOG

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
    os.makedirs(PICKS_DIR, exist_ok=True)
    with open(os.path.join(HERE, "picker.js"), "rb") as fh:
        PICKER_JS = fh.read()

    handler = lambda *a, **kw: Handler(*a, directory=root, **kw)  # noqa: E731
    srv = ThreadingHTTPServer((args.host, args.port), handler)
    print("serving %s at http://%s:%d/" % (root, args.host, args.port), flush=True)
    print("picker: click 'pick' bottom-left, or Alt+I · picks -> %s" % LAST, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
