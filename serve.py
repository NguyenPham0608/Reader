#!/usr/bin/env python3
"""Serve Reader locally and open it in the browser.

    python3 serve.py [port]

The two Cross-Origin headers let the voice model use several CPU threads,
which is what makes speech start quickly.
"""
import functools
import http.server
import os
import sys
import threading
import webbrowser

_ports = [a for a in sys.argv[1:] if not a.startswith("--")]
PORT = int(_ports[0]) if _ports else 8137
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        url = f"http://localhost:{PORT}/"
        print(f"Reader is running at {url}  (Ctrl+C to stop)")
        if "--no-open" not in sys.argv:
            threading.Timer(0.4, webbrowser.open, args=(url,)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
