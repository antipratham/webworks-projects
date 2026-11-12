"""
keyword_index.py
-----------------
A lightweight, dependency-free keyword/prefix search index.

This is the layer that makes "type 'what' and see multiple matching
suggestions immediately, updating as you keep typing" work, the same
way a search engine's autosuggest box does. It needs no ML model and
no external library, so it's instant even on a cold start.

How it works:
1. At load time, every catalog item's title/author/category text is
   tokenized into lowercase words.
2. An inverted index maps each *word prefix* (e.g. "wh", "wha", "what")
   to the set of item ids that contain a word starting with that prefix.
   This is what makes "what" instantly match "What to Expect...",
   "What Alice Forgot", etc., without scanning the whole catalog.
3. A query is split into tokens; each token's prefix-matches are
   intersected/unioned across items, then items are scored and ranked.

This module is intentionally dependency-free (pure `stdlib`) so it
works standalone. The BM25-based scorer in `bm25_index.py` is a drop-in
upgrade for better relevance ranking once you `pip install rank_bm25`.
"""

import re
from collections import defaultdict

TOKEN_RE = re.compile(r"[a-z0-9]+")


def tokenize(text):
    return TOKEN_RE.findall(text.lower())


class KeywordIndex:
    def __init__(self, catalog):
        """
        catalog: list of dicts, each with at least 'id' and 'search_text'
        """
        self.catalog = {item["id"]: item for item in catalog}
        # prefix -> set of item ids (built from every prefix of every token,
        # capped at a max prefix length for index size sanity)
        self.prefix_index = defaultdict(set)
        # token -> set of item ids (exact token matches, for scoring boosts)
        self.token_index = defaultdict(set)
        self._build(catalog)

    def _build(self, catalog):
        for item in catalog:
            item_id = item["id"]
            tokens = tokenize(item["search_text"])
            seen_prefixes = set()
            for token in tokens:
                self.token_index[token].add(item_id)
                # index every prefix length from 2 chars up to full token
                # (2 chars minimum avoids an explosion of 1-letter buckets)
                for i in range(2, len(token) + 1):
                    prefix = token[:i]
                    if prefix not in seen_prefixes:
                        self.prefix_index[prefix].add(item_id)
                        seen_prefixes.add(prefix)

    def search(self, query, top_k=8):
        """
        Returns a list of (item_id, score) sorted by score descending.
        Score is a simple heuristic: sum of per-query-token match quality,
        boosted for items where the match starts at the beginning of the
        title (classic autosuggest behavior), and boosted by popularity
        (reviews_count) as a tie-breaker.
        """
        tokens = tokenize(query)
        if not tokens:
            return []

        # candidate items = union across the LAST token's prefix matches
        # intersected with exact matches on all earlier (already-completed) tokens
        *complete_tokens, last_token = tokens

        candidate_ids = None
        for token in complete_tokens:
            ids = self.token_index.get(token, set())
            candidate_ids = ids if candidate_ids is None else (candidate_ids & ids)

        last_matches = self.prefix_index.get(last_token, set())
        candidate_ids = last_matches if candidate_ids is None else (candidate_ids & last_matches)

        if not candidate_ids:
            # fall back to a looser OR-match if the strict AND-match is empty,
            # so a slightly-off query still returns *something*
            candidate_ids = set()
            for token in tokens:
                candidate_ids |= self.prefix_index.get(token, set())

        scored = []
        for item_id in candidate_ids:
            item = self.catalog[item_id]
            title_lower = item["title"].lower()
            score = 0.0

            for token in tokens:
                if title_lower.startswith(token):
                    score += 3.0
                elif re.search(r"\b" + re.escape(token), title_lower):
                    score += 2.0
                elif token in item["search_text"].lower():
                    score += 1.0

            # small popularity boost so well-reviewed books rank slightly
            # higher among otherwise-equal keyword matches
            score += min(item.get("reviews_count", 0) or 0, 20000) / 20000.0

            scored.append((item_id, score))

        scored.sort(key=lambda pair: pair[1], reverse=True)
        return scored[:top_k]

    def get_item(self, item_id):
        return self.catalog.get(item_id)
