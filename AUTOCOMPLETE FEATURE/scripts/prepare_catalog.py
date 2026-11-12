"""
prepare_catalog.py
-------------------
Cleans the raw Amazon_popular_books_dataset.json export into a lean
catalog.json that the suggestion engine loads at startup.

Run once (or whenever the raw dataset changes):
    python scripts/prepare_catalog.py --input /path/to/Amazon_popular_books_dataset.json --output data/catalog.json

Only the fields the suggestion engine actually needs are kept, so the
app doesn't have to parse the full ~20MB raw export on every request.
"""

import argparse
import json
import re


def parse_rating(raw_rating):
    """'4.6 out of 5 stars' -> 4.6 (float), or None if missing/unparseable."""
    if not raw_rating:
        return None
    match = re.match(r"([\d.]+)", raw_rating)
    return float(match.group(1)) if match else None


def clean_record(raw):
    title = (raw.get("title") or "").strip()
    if not title:
        return None  # a suggestion engine can't suggest an item with no title

    return {
        "id": raw.get("asin"),
        "title": title,
        "author": (raw.get("brand") or "").strip(),
        "categories": raw.get("categories") or [],
        "price": raw.get("final_price"),
        "rating": parse_rating(raw.get("rating")),
        "reviews_count": raw.get("reviews_count") or 0,
        "image_url": raw.get("image_url"),
        "url": raw.get("url"),
    }


def build_search_text(item):
    """
    Concatenated text used by the keyword (BM25) and embedding indexes.
    Title is repeated to weight it higher than category/author tokens.
    """
    parts = [item["title"], item["title"], item["author"]]
    parts.extend(item["categories"])
    return " ".join(p for p in parts if p)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="../Amazon_popular_books_dataset.json")
    parser.add_argument("--output", default="../data/catalog.json")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        raw_data = json.load(f)

    catalog = []
    seen_ids = set()
    for raw in raw_data:
        item = clean_record(raw)
        if item is None:
            continue
        # de-dupe on id (falls back to title if id missing)
        dedupe_key = item["id"] or item["title"]
        if dedupe_key in seen_ids:
            continue
        seen_ids.add(dedupe_key)
        item["search_text"] = build_search_text(item)
        catalog.append(item)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

    print(f"Wrote {len(catalog)} items to {args.output} (from {len(raw_data)} raw records).")


if __name__ == "__main__":
    main()
