# Book Search — Live Typeahead Suggestions

A search-engine-style suggestion box: type into a plain textbox and
matching books from your catalog appear immediately, updating on every
keystroke — like Google's autosuggest, but backed by your own dataset
(`Amazon_popular_books_dataset.json`).

```
book-suggest/
├── data/
│   ├── catalog.json          # cleaned dataset (generated — see step 1)
│   └── embedding_index.faiss # cached vector index (generated, optional layer)
├── models/
│   └── product-embedder-v1/  # your fine-tuned embedding model (generated, optional)
├── backend/
│   ├── main.py                # FastAPI app + /suggest endpoint
│   ├── keyword_index.py       # instant prefix/keyword matching (no deps)
│   └── embedding_index.py     # optional semantic search layer
├── frontend/
│   └── index.html             # the plain textbox UI
├── scripts/
│   ├── prepare_catalog.py     # cleans the raw dataset
│   └── finetune_embedder.py   # fine-tunes the embedding model on this catalog
└── requirements.txt
```

## How the live-typing behavior works

The frontend (`frontend/index.html`) fires a request to `GET /suggest?q=...`
on every keystroke, with a short debounce (150ms) so a fast typist doesn't
flood the network, plus in-flight request cancellation so an older, slower
response can never overwrite a newer one. The backend's keyword index is a
prefix-based inverted index, so lookups are near-instant even before any ML
model is involved — this is what makes "what" → instantly show every "What
to Expect...", "What Alice Forgot", etc. as you type, and narrow further
with every additional letter.

## Quick start (keyword-only — works in under a minute, no ML deps)

```bash
cd book-suggest
pip install -r requirements.txt   # fastapi + uvicorn is all you strictly need
python scripts/prepare_catalog.py --input /path/to/Amazon_popular_books_dataset.json --output data/catalog.json
uvicorn backend.main:app --reload --port 8000
```

Open **http://localhost:8000** — the backend serves the frontend directly.
Start typing, e.g. "what", "harry pot", "atomic hab" — suggestions appear
and adapt with every keystroke.

## Adding semantic search (optional, hybrid mode)

```bash
pip install sentence-transformers faiss-cpu numpy torch
```

That's it — `backend/main.py` auto-detects these packages at startup and
switches on the semantic layer automatically (`/health` will show
`"semantic_search_enabled": true`). It merges keyword + semantic scores
(see `KEYWORD_WEIGHT` / `SEMANTIC_WEIGHT` in `main.py`) so exact keyword
matches and "similar meaning" matches both surface.

## Fine-tuning the embedding model on this catalog (optional)

Per the earlier plan: this teaches the embedding model your catalog's
specific language (titles, author phrasing, category names) rather than
relying on the generic pretrained model.

```bash
python scripts/finetune_embedder.py \
    --catalog data/catalog.json \
    --base-model sentence-transformers/all-MiniLM-L6-v2 \
    --output models/product-embedder-v1 \
    --epochs 3
```

Restart `uvicorn` afterward — `main.py` automatically picks up
`models/product-embedder-v1` if it exists, and falls back to the base
pretrained model otherwise. Delete `data/embedding_index.faiss` first if
you re-run fine-tuning, so the cached index gets rebuilt from the new
model rather than reused from the old one.

## Tuning the suggestions

- `backend/keyword_index.py` — scoring heuristics for prefix/keyword
  matches (title-start boost, popularity tie-breaker).
- `backend/main.py` — `KEYWORD_WEIGHT` / `SEMANTIC_WEIGHT` — how much
  each layer contributes to the final ranking.
- `frontend/index.html` — `DEBOUNCE_MS` — lower for snappier (more
  requests), higher for lighter server load.
