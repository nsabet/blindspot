#!/usr/bin/env python3
"""Blindspot server: static files (web/) + tiny handshake relay (SSE + POST). Python 3 stdlib only.
Binds to 0.0.0.0 by default so any host on the network can connect.
  python3 server.py                       # http://<lan-ip>:8080
  python3 server.py --cert cert.pem --key key.pem   # https (needed for phone camera over LAN)
"""
import argparse, json, os, queue, secrets, socket, ssl, threading, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O/1/I
TTL = 3600
WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
SESSIONS, LOCK = {}, threading.Lock()

class Session:
    def __init__(self):
        self.t = time.time()
        self.q = {"sender": queue.Queue(), "receiver": queue.Queue()}   # messages waiting for that role
        self.last = {"sender": None, "receiver": None}                  # newest message per role (replayed on reconnect)
        self.gen = {"sender": 0, "receiver": 0}                         # newest SSE connection wins

class H(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".js": "text/javascript", ".webmanifest": "application/manifest+json"}
    def __init__(self, *a, **k): super().__init__(*a, directory=WEB, **k)
    def end_headers(self):
        if not getattr(self, "path", "").startswith("/api/"): self.send_header("Cache-Control", "no-cache")
        super().end_headers()
    def log_message(self, fmt, *a):
        # NB: self.path does not exist yet when parsing the request line fails
        if getattr(self, "raw_requestline", b"")[:1] == b"\x16":     # TLS ClientHello on a plain-HTTP port
            print(f"[hint] {self.client_address[0]} spoke HTTPS to a plain-HTTP server. "
                  f"Use http://..., or start the server with --cert/--key.")
            return
        if getattr(self, "path", "").startswith("/api/events"): return
        super().log_message(fmt, *a)
    def handle(self):
        try: super().handle()
        except (OSError, ssl.SSLError): pass     # dropped connections, failed TLS handshakes

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/events": return self._events(parse_qs(u.query))
        super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/session": return self._create()
        if u.path == "/api/msg": return self._msg(parse_qs(u.query))
        self.send_error(404)

    def _create(self):
        now = time.time()
        with LOCK:
            for k in [k for k, s in SESSIONS.items() if now - s.t > TTL]: del SESSIONS[k]
            sid = "".join(secrets.choice(ALPHA) for _ in range(6))
            SESSIONS[sid] = Session()
        self._json(200, {"id": sid})

    def _msg(self, qs):
        s = SESSIONS.get(qs.get("s", [""])[0]); role = qs.get("from", [""])[0]
        if not s or role not in s.q: return self.send_error(404)
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > 65536: raise ValueError
            m = json.loads(self.rfile.read(n))
            if not isinstance(m, dict): raise ValueError
        except ValueError:
            return self.send_error(400)
        dst = "receiver" if role == "sender" else "sender"
        s.t = time.time(); s.last[dst] = m; s.q[dst].put(m)
        self.send_response(204); self.end_headers()

    def _sse(self, m):
        self.wfile.write(b"data: " + json.dumps(m).encode() + b"\n\n"); self.wfile.flush()

    def _events(self, qs):
        s = SESSIONS.get(qs.get("s", [""])[0]); role = qs.get("role", [""])[0]
        if not s or role not in s.q: return self.send_error(404)
        s.gen[role] += 1; g = s.gen[role]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream"); self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while not s.q[role].empty(): s.q[role].get_nowait()      # newest state is in s.last
            if s.last[role]: self._sse(s.last[role])
            else: self.wfile.write(b": open\n\n"); self.wfile.flush()
            while s.gen[role] == g:
                try: self._sse(s.q[role].get(timeout=10))
                except queue.Empty: self.wfile.write(b": ka\n\n"); self.wfile.flush()
        except OSError:
            pass

class Srv(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    def handle_error(self, request, client_address):
        import sys
        if isinstance(sys.exc_info()[1], OSError): return    # noisy client disconnects / TLS failures
        super().handle_error(request, client_address)

def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("10.255.255.255", 1)); ips.add(s.getsockname()[0]); s.close()
    except OSError: pass
    try: ips.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError: pass
    return sorted(i for i in ips if not i.startswith("127."))

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0"); ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--cert"); ap.add_argument("--key")
    a = ap.parse_args()
    httpd = Srv((a.host, a.port), H)
    scheme = "http"
    if a.cert and a.key:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(a.cert, a.key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)  # handshake in worker thread, not accept loop; scheme = "https"
    print(f"Serving {WEB} on {a.host}:{a.port} ({scheme})")
    for ip in ["localhost"] + lan_ips(): print(f"  {scheme}://{ip}:{a.port}/")
    if scheme == "http": print("Note: phone cameras need https (or localhost); see README.")
    try: httpd.serve_forever()
    except KeyboardInterrupt: print()
