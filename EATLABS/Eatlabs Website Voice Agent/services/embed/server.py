# WHAT: a small OpenAI-compatible /v1/embeddings server, running on the CPU.
# ROLE: the local stand-in for the GPU embedding endpoint, so hybrid retrieval can be built and measured
#       on a laptop instead of waiting for a g6e. The knowledge base is 104 chunks and a question is one
#       sentence, so a CPU is genuinely enough here - this is not a compromise for the sake of testing.
#       Same protocol as vLLM and TEI, so src/embed.ts cannot tell the difference and nothing has to
#       change when this is swapped for the real thing.
#
# Usage:
#   python services/embed/server.py                       # port 8001, multilingual-e5-small
#   EMBED_MODEL=BAAI/bge-m3 python services/embed/server.py
#
# Stdlib HTTP rather than FastAPI, unlike services/stt and services/tts. The reason is narrow: this has
# one route, and adding a web framework to a laptop that only needs to answer /v1/embeddings is a
# dependency the repo would then carry everywhere.

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModel, AutoTokenizer

MODEL_ID = os.environ.get("EMBED_MODEL", "intfloat/multilingual-e5-small")
PORT = int(os.environ.get("EMBED_PORT", "8001"))
MAX_TOKENS = 512

# The e5 family is trained with these prefixes and loses accuracy without them; bge-m3 is trained
# without any. Getting this wrong is a silent quality loss, not an error, which is why it is explicit.
USES_E5_PREFIX = "e5" in MODEL_ID.lower()

print(f"loading {MODEL_ID} on CPU ...", flush=True)
tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
model = AutoModel.from_pretrained(MODEL_ID)
model.eval()
torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
LOCK = threading.Lock()
print(f"ready on http://127.0.0.1:{PORT}/v1/embeddings  (e5 prefixes: {USES_E5_PREFIX})", flush=True)


def embed(texts, kind):
    """Mean-pooled, L2-normalised sentence vectors. `kind` is 'query' or 'passage' (e5 only)."""
    if USES_E5_PREFIX:
        texts = [f"{kind}: {t}" for t in texts]
    batch = tokenizer(texts, padding=True, truncation=True, max_length=MAX_TOKENS, return_tensors="pt")
    with torch.no_grad():
        out = model(**batch).last_hidden_state
    # Mean pool over real tokens only - padding would otherwise drag every short text toward the same
    # point, which shows up as unrelated chunks scoring alike.
    mask = batch["attention_mask"].unsqueeze(-1).float()
    pooled = (out * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
    return torch.nn.functional.normalize(pooled, p=2, dim=1).tolist()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # probeEmbedder() in src/embed.ts checks /v1/models before deciding the endpoint is there.
        if self.path.rstrip("/") == "/v1/models":
            self._send(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model"}]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/embeddings":
            return self._send(404, {"error": "not found"})
        try:
            raw = self.rfile.read(int(self.headers.get("content-length", 0)))
            req = json.loads(raw or b"{}")
            texts = req.get("input") or []
            if isinstance(texts, str):
                texts = [texts]
            if not texts:
                return self._send(400, {"error": "input is empty"})
            # One question at a time is a query; a batch is the knowledge base being indexed.
            kind = "query" if len(texts) == 1 else "passage"
            with LOCK:                      # one model, and torch is not safe to call re-entrantly
                vectors = embed(texts, kind)
            self._send(200, {
                "object": "list",
                "model": MODEL_ID,
                "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vectors)],
            })
        except Exception as err:                                    # noqa: BLE001 - report, do not die
            self._send(500, {"error": str(err)})

    def log_message(self, *_args):
        pass                                                        # the console is for the agent, not this


if __name__ == "__main__":
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
