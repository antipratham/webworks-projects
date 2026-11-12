"""Build kb.jsonl (retrieval chunks) from the curated knowledge-base markdown.

Each `## ` section becomes one chunk. An optional `> Spoken:` blockquote in the
section becomes the `spoken` field: a short, voice-safe rendering of the answer.

Usage:  python build_kb.py <kb_dir> <out.jsonl>
Stdlib only.
"""
import json
import os
import re
import sys


def parse_frontmatter(text):
    """Return (meta_dict, body). Supports flat keys and simple `- ` lists."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    raw = text[3:end].strip("\n")
    body = text[end + 4:].lstrip("\n")

    meta, key = {}, None
    for line in raw.split("\n"):
        if not line.strip():
            continue
        if re.match(r"^\s*-\s+", line):          # list item under last key
            if key:
                meta.setdefault(key, [])
                if isinstance(meta[key], list):
                    meta[key].append(re.sub(r"^\s*-\s+", "", line).strip())
            continue
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if m:
            key, val = m.group(1), m.group(2).strip()
            meta[key] = val if val else []
    return meta, body


# `visibility` and `sensitivity` decide whether a chunk can be shown at all and how
# strictly its numbers are handled. Defaulting them is how a new pricing or legal file
# silently gets the permissive setting, so an absent value stops the build instead.
CONTENT_FILE = re.compile(r"^\d\d-.+\.md$")

VALID = {
    "visibility": {"public", "agent-only"},
    "sensitivity": {"normal", "high", "critical"},
}


def require(meta, key, filename, chunk_id):
    value = (meta.get(key) or "").strip()
    if not value:
        raise SystemExit(
            f"{filename}: frontmatter is missing `{key}:`  (needed by {chunk_id})\n"
            f"  add one of: {', '.join(sorted(VALID[key]))}")
    if value not in VALID[key]:
        raise SystemExit(
            f"{filename}: `{key}: {value}` is not a value this build understands\n"
            f"  use one of: {', '.join(sorted(VALID[key]))}")
    return value


def slugify(s):
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:60]


def split_sections(body):
    """Split on top-level '## ' headings. Returns [(heading, content)]."""
    parts = re.split(r"^##\s+(.+)$", body, flags=re.MULTILINE)
    # parts[0] is any preamble before the first heading
    out = []
    for i in range(1, len(parts), 2):
        out.append((parts[i].strip(), parts[i + 1].strip()))
    return out


SPOKEN_RE = re.compile(r"^>\s*Spoken:\s*(.+?)(?=\n\n|\n(?!>)|\Z)", re.DOTALL | re.MULTILINE)


def extract_spoken(content):
    m = SPOKEN_RE.search(content)
    if not m:
        return None, content
    spoken = " ".join(
        re.sub(r"^>\s?", "", ln).strip() for ln in m.group(1).split("\n")
    ).strip()
    rest = (content[: m.start()] + content[m.end():]).strip()
    if spoken.lower().startswith("(never"):
        spoken = None
    return spoken, rest


def token_estimate(s):
    return max(1, len(s) // 4)


def main(kb_dir, out_path):
    chunks = []
    for fn in sorted(os.listdir(kb_dir)):
        # Content files are numbered: 00-identity, 06-pricing, 99-guardrails. Anything
        # else in here is documentation for whoever maintains the folder, not an answer.
        if not CONTENT_FILE.match(fn):
            continue
        with open(os.path.join(kb_dir, fn), encoding="utf-8") as f:
            meta, body = parse_frontmatter(f.read())

        doc_id = meta.get("id") or slugify(fn[:-3])
        sources = meta.get("source_urls") or []
        if isinstance(sources, str):
            sources = [sources]

        # `opening_section:` names the heading that answers "what is this?". Retrieval
        # falls back to it when a question has no searchable words in it - a greeting, or
        # "tell me about eatlabs". The choice lives here, in the content, because it is a
        # content decision; the retriever just honours the flag.
        opening = (meta.get("opening_section") or "").strip()

        for heading, content in split_sections(body):
            spoken, text = extract_spoken(content)
            cid = f"{doc_id}#{slugify(heading)}"
            chunks.append({
                "id": cid,
                "doc_id": doc_id,
                "file": fn,
                "title": meta.get("title", ""),
                "heading": heading,
                "topic": meta.get("topic", ""),
                "visibility": require(meta, "visibility", fn, cid),
                "sensitivity": require(meta, "sensitivity", fn, cid),
                "retrieval": meta.get("retrieval", "on-demand"),
                "spoken": spoken,
                "text": text,
                "embed_text": f"{heading}\n\n{text}",
                "opening": bool(opening) and heading.strip() == opening,
                "provenance": meta.get("provenance", "scraped"),
                "source_urls": sources,
                "scraped": meta.get("scraped", ""),
                "approx_tokens": token_estimate(text),
            })

    with open(out_path, "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    # Exactly one, or retrieval has no answer for "hi" - and two would be a silent
    # coin-toss between them.
    openers = [c["id"] for c in chunks if c["opening"]]
    if len(openers) != 1:
        raise SystemExit(
            f"expected exactly one chunk marked by `opening_section:`, found {len(openers)}"
            f"{': ' + ', '.join(openers) if openers else ''}\n"
            f"  add `opening_section: <exact heading>` to one file's frontmatter")

    big = [c for c in chunks if c["approx_tokens"] > 400]
    novoice = [c for c in chunks
               if not c["spoken"] and c["visibility"] != "agent-only"]

    print(f"{len(chunks)} chunks -> {out_path}")
    print(f"  avg ~{sum(c['approx_tokens'] for c in chunks) // len(chunks)} tokens")
    print(f"  {len(big)} chunks over 400 tokens (consider splitting):")
    for c in big:
        print(f"    {c['id']}  ~{c['approx_tokens']}")
    if novoice:
        print(f"  {len(novoice)} guest-facing chunks missing a 'Spoken:' line:")
        for c in novoice:
            print(f"    {c['id']}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
