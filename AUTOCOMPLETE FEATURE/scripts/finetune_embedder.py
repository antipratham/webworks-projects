"""
finetune_embedder.py
---------------------
Fine-tunes a small sentence-transformers embedding model on this catalog,
per the earlier plan's Phase 4. This uses SYNTHETIC training pairs
generated from the catalog itself, since a real search-query log isn't
available yet — swap in real logged queries later for a stronger model
(see the "Using real query logs" note at the bottom of this file).

Requires:  pip install sentence-transformers torch

Run:
    python scripts/finetune_embedder.py \
        --catalog data/catalog.json \
        --base-model sentence-transformers/all-MiniLM-L6-v2 \
        --output models/product-embedder-v1 \
        --epochs 3
"""

import argparse
import json
import random

from sentence_transformers import InputExample, SentenceTransformer, losses
from torch.utils.data import DataLoader


def build_synthetic_pairs(catalog, seed=42):
    """
    Builds (query, positive_product_text) pairs a shopper might plausibly
    type, paired with the product that should match.

    Three query styles per book, so the model learns to match:
      1. Partial/short title fragments  -> "harry potter"        (title truncation)
      2. Author-style queries           -> "books by emily bronte"
      3. Category-style queries         -> "genre fiction books"

    MultipleNegativesRankingLoss treats every OTHER pair in the same
    training batch as an implicit negative, so we don't need to hand-pick
    negative examples — just good positive pairs.
    """
    random.seed(seed)
    examples = []

    for item in catalog:
        title = item["title"]
        author = item.get("author")
        categories = item.get("categories") or []
        product_text = item["search_text"]

        # 1. partial title query (first N words, simulating a half-typed title)
        words = title.split()
        if len(words) >= 2:
            cut = random.randint(1, min(4, len(words) - 1))
            partial = " ".join(words[:cut])
            examples.append(InputExample(texts=[partial, product_text]))

        # 2. author-style query
        if author:
            examples.append(InputExample(texts=[f"books by {author}", product_text]))

        # 3. category-style query
        if categories:
            examples.append(InputExample(texts=[f"{categories[-1].lower()} books", product_text]))

    random.shuffle(examples)
    return examples


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog.json")
    parser.add_argument("--base-model", default="sentence-transformers/all-MiniLM-L6-v2")
    parser.add_argument("--output", default="models/product-embedder-v1")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=32)
    args = parser.parse_args()

    with open(args.catalog, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    print(f"Building synthetic training pairs from {len(catalog)} catalog items...")
    train_examples = build_synthetic_pairs(catalog)
    print(f"Built {len(train_examples)} training pairs.")

    model = SentenceTransformer(args.base_model)
    train_dataloader = DataLoader(train_examples, shuffle=True, batch_size=args.batch_size)
    train_loss = losses.MultipleNegativesRankingLoss(model)

    warmup_steps = int(len(train_dataloader) * args.epochs * 0.1)
    model.fit(
        train_objectives=[(train_dataloader, train_loss)],
        epochs=args.epochs,
        warmup_steps=warmup_steps,
        show_progress_bar=True,
        output_path=args.output,
    )

    print(f"Fine-tuned model saved to {args.output}")
    print("Point EmbeddingIndex(model_path=...) at this folder to use it (see backend/main.py).")


if __name__ == "__main__":
    main()

# --- Using real query logs instead of synthetic pairs -----------------------
# Once your app is live and logging real user input (see main.py's optional
# query logging hook), replace build_synthetic_pairs() with pairs built from
# (logged_query, clicked_product) — this is strictly better training signal
# than the synthetic heuristics above, because it reflects how people
# actually phrase searches rather than how titles happen to be worded.
