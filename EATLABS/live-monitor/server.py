# WHAT: a local web page that shows one phone call as it happens - the dialogue between the caller and the
#       agent, the gap before each reply, and the knowledge base of the restaurant whose number was dialled.
# ROLE: a development window for Pratham. It is NOT part of the voice agent: it lives outside the repo, it
#       is never imported by it, and nothing in agent/ knows it exists. The live lines arrive by HTTP POST
#       from live_shim.py, which patches the call session in the worker's own process.
#
#   python server.py                      # http://127.0.0.1:3100
#   python server.py --port 4000
#   REPO_DIR="../VOICE AGENT" python server.py
#
# Standard library only, on purpose: it has to run without the repo's virtualenv and without pip.

import argparse
import json
import mimetypes
import os
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.abspath(os.environ.get("REPO_DIR", os.path.join(HERE, "..", "VOICE AGENT")))
MAX_LINES = 500                     # the transcript kept in memory for a page that reloads mid-call
# The worker's own map of real phone number -> restaurant number (infra/aws/bootstrap_live.sh writes it).
# Reading it is what lets the page open on whichever restaurant actually answers the line.
NUMBER_MAP_FILE = os.environ.get("NUMBER_MAP_FILE", "/root/live/number_map.env")


class Feed:
    """What the page is shown: the lines so far, and a queue per connected browser. One lock guards both,
    so a POST arriving while a browser connects cannot lose an event or hand out a torn snapshot."""

    def __init__(self):
        self.lock = threading.Lock()
        self.events = []
        self.listeners = []
        self.seq = 0

    def publish(self, event):
        with self.lock:
            self.seq += 1
            event["seq"] = self.seq
            event.setdefault("at", time.time())
            self.events.append(event)
            if len(self.events) > MAX_LINES:
                del self.events[:-MAX_LINES]
            dead = []
            for q in self.listeners:
                try:
                    q.put_nowait(event)
                except queue.Full:
                    dead.append(q)          # a browser that stopped reading: drop it rather than block
            for q in dead:
                self.listeners.remove(q)
        return event["seq"]

    def snapshot(self):
        with self.lock:
            return list(self.events)

    def listen(self):
        q = queue.Queue(maxsize=1000)
        with self.lock:
            self.listeners.append(q)
        return q

    def unlisten(self, q):
        with self.lock:
            if q in self.listeners:
                self.listeners.remove(q)

    def clear(self):
        with self.lock:
            self.events = []


FEED = Feed()


# ------------------------------------------------------------------ the restaurants and their knowledge

def _read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def _read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def _numbers_by_outlet():
    # data/numbers.json: which numbers ring which outlet, and how the booking is then attributed.
    data = _read_json(os.path.join(REPO_DIR, "data", "numbers.json"), {}) or {}
    out = {}
    for n in data.get("numbers") or []:
        out.setdefault(n.get("outlet_id"), []).append(n)
    return out


def restaurants():
    """Enough of each outlet to fill the picker: its name, where it is, and the numbers that reach it."""
    root = os.path.join(REPO_DIR, "data", "restaurants")
    numbers = _numbers_by_outlet()
    out = []
    if not os.path.isdir(root):
        return out
    for outlet_id in sorted(os.listdir(root)):
        profile = _read_json(os.path.join(root, outlet_id, "profile.json"))
        if not profile:
            continue
        voice = _read_json(os.path.join(root, outlet_id, "voice_config.json"), {}) or {}
        out.append({
            "outlet_id": outlet_id,
            "name": profile.get("name") or outlet_id,
            "locality": profile.get("locality"),
            "cuisine": profile.get("cuisine"),
            "status": voice.get("status"),
            "languages": voice.get("languages") or [],
            "numbers": [n.get("number") for n in numbers.get(outlet_id, [])],
        })
    return out


def knowledge(outlet_id):
    """Everything the agent is given about one outlet. The same files mock_platform/seed.py loads, plus the
    outlet manager's own knowledge base from data/knowledge/<id>.json when they have written one."""
    base = os.path.join(REPO_DIR, "data", "restaurants", os.path.basename(outlet_id))
    if not os.path.isdir(base):
        return None
    numbers = _numbers_by_outlet().get(outlet_id, [])
    return {
        "outlet_id": outlet_id,
        "numbers": numbers,
        "profile": _read_json(os.path.join(base, "profile.json")),
        "rules": _read_json(os.path.join(base, "rules.json")),
        "voice_config": _read_json(os.path.join(base, "voice_config.json")),
        "menu": _read_json(os.path.join(base, "menu.json")),
        "tables": _read_json(os.path.join(base, "tables.json")),
        "events": _read_json(os.path.join(base, "events.json")),
        "special_requests": _read_json(os.path.join(base, "special_requests.json")),
        "faq": _read_text(os.path.join(base, "faq.md")),
        "brief": _read_text(os.path.join(base, "brief.md")),
        # The manager's own words, merged over the above by agent/knowledge_base.py at call time.
        "manager_kb": _read_json(os.path.join(REPO_DIR, "data", "knowledge", outlet_id + ".json")),
    }


def mapped_outlets():
    """Which restaurant answers which real number, resolved to outlet ids.

    NUMBER_MAP is `real=virtual,real=virtual`; data/numbers.json says which outlet owns the virtual one.
    The map is deliberately not printed on the box - a caller must not know which restaurant answers - but
    the person running the test does need to know, which is the whole point of this page."""
    try:
        with open(NUMBER_MAP_FILE, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return []
    value = ""
    for line in text.splitlines():
        if line.startswith("NUMBER_MAP="):
            value = line.split("=", 1)[1].strip()
    if not value:
        return []
    owner = {}
    for n in (_read_json(os.path.join(REPO_DIR, "data", "numbers.json"), {}) or {}).get("numbers") or []:
        owner[n.get("number")] = n.get("outlet_id")
    names = {r["outlet_id"]: r["name"] for r in restaurants()}
    out = []
    for pair in value.split(","):
        if "=" not in pair:
            continue
        real, virtual = pair.split("=", 1)
        outlet = owner.get(virtual.strip())
        out.append({"dialled": real.strip(), "virtual": virtual.strip(),
                    "outlet_id": outlet, "name": names.get(outlet)})
    return out


# ------------------------------------------------------------------ http

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "eatlabs-live-monitor"

    def log_message(self, fmt, *args):
        pass                                        # the page polls; its own log is noise

    # -- helpers ----------------------------------------------------
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _file(self, name):
        path = os.path.join(HERE, name)
        if not os.path.isfile(path):
            return self._send(404, {"error": "no such file"})
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            self._send(200, f.read(), ctype)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            return {}

    # -- routes -----------------------------------------------------
    def do_GET(self):
        route = urlparse(self.path).path
        if route == "/":
            return self._file("index.html")
        if route == "/api/restaurants":
            return self._send(200, {"restaurants": restaurants(), "repo": REPO_DIR})
        if route == "/api/mapped":
            return self._send(200, {"mapped": mapped_outlets()})
        if route.startswith("/api/restaurants/"):
            found = knowledge(route[len("/api/restaurants/"):])
            if found is None:
                return self._send(404, {"error": "no such outlet"})
            return self._send(200, found)
        if route == "/api/state":
            return self._send(200, {"events": FEED.snapshot(), "seq": FEED.seq})
        if route == "/api/stream":
            return self._stream()
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        route = urlparse(self.path).path
        if route == "/api/event":
            event = self._body()
            if not isinstance(event, dict) or not event.get("kind"):
                return self._send(400, {"error": "need {kind: ...}"})
            return self._send(200, {"seq": FEED.publish(event)})
        if route == "/api/clear":
            FEED.clear()
            return self._send(200, {"cleared": True})
        return self._send(404, {"error": "not found"})

    def _stream(self):
        # Server-sent events: the browser reconnects by itself if this process restarts.
        q = FEED.listen()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                try:
                    event = q.get(timeout=15)
                    payload = "data: %s\n\n" % json.dumps(event, ensure_ascii=False)
                except queue.Empty:
                    payload = ": keep-alive\n\n"     # so a proxy or a sleeping laptop does not drop it
                self.wfile.write(payload.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            FEED.unlisten(q)


def main():
    ap = argparse.ArgumentParser(description="live view of one call: the dialogue and the knowledge base")
    ap.add_argument("--port", type=int, default=3100)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    found = restaurants()
    print("repo         %s" % REPO_DIR)
    print("restaurants  %d" % len(found))
    if not found:
        print("             (none found - is REPO_DIR right? expected <repo>/data/restaurants/)")
    print("open         http://%s:%d" % (args.host, args.port))
    print("the worker posts its lines to http://%s:%d/api/event" % (args.host, args.port))
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
