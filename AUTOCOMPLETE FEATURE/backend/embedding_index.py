"""
embedding_index.py
-------------------
Optional semantic search layer, built on `sentence-transformers`.

This is used alongside `keyword_index.py` for hybrid retrieval — the
keyword index handles fast literal/prefix matching, this handles
"catches the meaning even if the words don't match exactly".

Requires:  pip install sentence-transformers faiss-cpu numpy

If these packages aren't installed, `EmbeddingIndex.available()` returns
False and the app automatically falls back to keyword-only suggestions
(see backend/main.py) — nothing breaks, semantic search is purely additive.

By default this loads the base pretrained model. To use your fine-tuned
model instead (see scripts/finetune_embedder.py), pass
`model_path="models/product-embedder-v1"`.
"""

import json
import os

try:
    import numpy as np
    from sentence_transformers import SentenceTransformer

    _DEPS_AVAILABLE = True
except ImportError:
    _DEPS_AVAILABLE = False

try:
    import faiss

    _FAISS_AVAILABLE = True
except ImportError:
    _FAISS_AVAILABLE = False


DEFAULT_BASE_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


class EmbeddingIndex:
    def __init__(self, catalog, model_path=None, index_cache_path=None):
        """
        catalog: list of dicts with 'id' and 'search_text'
        model_path: path to a fine-tuned model dir, or None to use the base model
        index_cache_path: optional path to save/load a prebuilt FAISS index,
                           so you don't re-embed the whole catalog on every startup
        """
        self.enabled = _DEPS_AVAILABLE and _FAISS_AVAILABLE
        if not self.enabled:
            return

        self.catalog = catalog
        self.item_ids = [item["id"] for item in catalog]
        self.model = SentenceTransformer(model_path or DEFAULT_BASE_MODEL)

        if index_cache_path and os.path.exists(index_cache_path):
            self.index = faiss.read_index(index_cache_path)
        else:
            self.index = self._build_index(catalog)
            if index_cache_path:
                faiss.write_index(self.index, index_cache_path)

    @staticmethod
    def available():
        return _DEPS_AVAILABLE and _FAISS_AVAILABLE

    def _build_index(self, catalog):
        texts = [item["search_text"] for item in catalog]
        embeddings = self.model.encode(
            texts, batch_size=64, show_progress_bar=True, normalize_embeddings=True
        )
        embeddings = np.asarray(embeddings, dtype="float32")
        index = faiss.IndexFlatIP(embeddings.shape[1])  # inner product == cosine, since vectors are normalized
        index.add(embeddings)
        return index

    def search(self, query, top_k=8):
        """Returns a list of (item_id, score) sorted by score descending."""
        if not self.enabled:
            return []
        query_vec = self.model.encode([query], normalize_embeddings=True)
        query_vec = np.asarray(query_vec, dtype="float32")
        scores, indices = self.index.search(query_vec, top_k)
        results = []
        for score, idx in zip(scores[0], indices[0]):
            if idx == -1:
                continue
            results.append((self.item_ids[idx], float(score)))
        return results
