#!/usr/bin/env python3
"""No-cache static server for the AI-control editor (dev only).

Serves the audiomass/ repo root so /src/* and /ai-control/* both resolve, with
Cache-Control: no-store on every response. AudioMass's editor pulls control.js and
multitrack.js (which we iterate on constantly); the browser's heuristic caching
otherwise serves stale copies after edits, so we disable caching here. Production
serving is a separate concern — this is purely the local dev harness.

Run:  python3 ai-control/devserver.py        (PORT env overrides 5056)
"""
import http.server
import os
import socketserver

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # audiomass/ root
PORT = int(os.environ.get("PORT", "5056"))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass  # quiet


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
    print(f"no-cache dev server on http://127.0.0.1:{PORT} (root: {os.getcwd()})")
    httpd.serve_forever()
