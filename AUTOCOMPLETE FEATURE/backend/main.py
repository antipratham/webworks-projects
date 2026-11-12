"""
main.py
-------
FastAPI backend for the live typeahead suggestion box.

Endpoints:
    GET /suggest?q=<text>   -> ranked list of book suggestions, updated
                                on every keystroke by the frontend

Retrieval is hybrid:
    - keyword_index.py   : instant prefix/keyword matching (always on)
    - embedding_index.py : semantic matching (on automatically if
                            sentence-transformers + faiss are installed;
                            otherwise the app runs keyword-only with no
                            errors)

Run:
    uvicorn backend.main:app --reload --port 8000
"""

import json
import os

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.embedding_index import EmbeddingIndex
from backend.keyword_index import KeywordIndex

CATALOG_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "catalog.json")
FINE_TUNED_MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "models", "product-embedder-v1")
EMBEDDING_INDEX_CACHE = os.path.join(os.path.dirname(__file__), "..", "data", "embedding_index.faiss")

# Weighting for hybrid score fusion. Tune these against a held-out eval
# set as described in the fine-tuning plan; these are reasonable defaults.
KEYWORD_WEIGHT = 0.5
SEMANTIC_WEIGHT = 0.5

app = FastAPI(title="Book Suggestion API")

# Allow the plain-HTML frontend (served separately or via file://) to call this API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_catalog():
    with open(CATALOG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


CATALOG = _load_catalog()
keyword_index = KeywordIndex(CATALOG)

# Use the fine-tuned model if it exists (see scripts/finetune_embedder.py),
# otherwise fall back to the base pretrained model, otherwise disable
# semantic search entirely if the optional dependencies aren't installed.
_model_path = FINE_TUNED_MODEL_PATH if os.path.isdir(FINE_TUNED_MODEL_PATH) else None
embedding_index = EmbeddingIndex(
    CATALOG, model_path=_model_path, index_cache_path=EMBEDDING_INDEX_CACHE
) if EmbeddingIndex.available() else None


def _normalize_scores(pairs):
    """Min-max normalize a list of (id, score) to the 0-1 range for fair fusion."""
    if not pairs:
        return {}
    scores = [s for _, s in pairs]
    lo, hi = min(scores), max(scores)
    span = (hi - lo) or 1.0
    return {item_id: (score - lo) / span for item_id, score in pairs}


def hybrid_search(query, top_k=8):
    keyword_results = keyword_index.search(query, top_k=top_k * 3)
    keyword_scores = _normalize_scores(keyword_results)

    semantic_scores = {}
    if embedding_index is not None:
        semantic_results = embedding_index.search(query, top_k=top_k * 3)
        semantic_scores = _normalize_scores(semantic_results)

    all_ids = set(keyword_scores) | set(semantic_scores)
    fused = []
    for item_id in all_ids:
        k_score = keyword_scores.get(item_id, 0.0)
        s_score = semantic_scores.get(item_id, 0.0)
        # items found by both layers get a natural boost since both terms contribute
        fused_score = KEYWORD_WEIGHT * k_score + SEMANTIC_WEIGHT * s_score
        fused.append((item_id, fused_score))

    fused.sort(key=lambda pair: pair[1], reverse=True)
    return fused[:top_k]


@app.get("/suggest")
def suggest(q: str = Query("", min_length=0, max_length=200), limit: int = 8):
    """
    Returns live suggestions for the current (possibly partial) input text.
    Called on every keystroke by the frontend, debounced client-side.
    """
    q = q.strip()
    if not q:
        return {"query": q, "results": []}

    ranked = hybrid_search(q, top_k=limit)
    results = []
    for item_id, score in ranked:
        item = keyword_index.get_item(item_id)
        if not item:
            continue
        results.append(
            {
                "id": item["id"],
                "title": item["title"],
                "author": item["author"],
                "price": item["price"],
                "rating": item["rating"],
                "reviews_count": item["reviews_count"],
                "image_url": item["image_url"],
                "url": item["url"],
                "score": round(score, 4),
            }
        )
    return {"query": q, "results": results}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "catalog_size": len(CATALOG),
        "semantic_search_enabled": embedding_index is not None,
    }


# Serves the plain-textbox frontend directly from the backend at "/",
# so you can just run uvicorn and open one URL — no separate frontend server needed.
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
