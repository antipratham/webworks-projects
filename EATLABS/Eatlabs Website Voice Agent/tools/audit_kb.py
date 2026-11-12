# WHAT: audits the curated knowledge base against the raw scrape it was written from.
# ROLE: the KB is hand-written from scraped pages, so the risk is a figure that exists in no source.
#       A wrong price said with confidence on a sales call is the worst failure this project has, and
#       no amount of retrieval or prompt work catches it - the number is simply wrong in the data.
#       Checks grounding of every figure, that cited pages exist, structure, and what the site says
#       that the KB dropped. Exit 1 if anything is ungrounded.

import json
import pathlib
import re
import sys
from collections import defaultdict

# Figures worth grounding. Bare small integers ("three plans") are prose, not claims, so the
# bare-number rule starts at three digits - below that the false positives drown the signal.
MONEY = re.compile(r"₹\s?[\d,]+(?:\.\d+)?")
PERCENT = re.compile(r"\d+(?:\.\d+)?\s?%")
DURATION = re.compile(r"\b(\d+)[\s-]?(day|days|hour|hours|month|months|year|years|minute|minutes)\b", re.I)
BIGNUM = re.compile(r"\b\d[\d,]{2,}\b")

NUMBER_WORDS = re.compile(
    r"\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
    r"twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|crore)\b", re.I)

CONTENT_FILE = re.compile(r"^\d\d-.+\.md$")

REQUIRED_KEYS = {"id", "title", "topic", "visibility", "sensitivity", "source_urls", "scraped"}


def norm(s):
    """Compare figures without punctuation noise: '₹35,000', '35000' and '35,000' are one claim.

    Hyphens go too. The site writes "20-minute demo" and the KB writes "20 minute", and an audit
    that reports that as a fabricated figure is worse than no audit, because it teaches you to
    skim past the one line that matters.
    """
    return re.sub(r"[,\s₹\-–—]", "", s.lower())


def figures(text):
    out = set()
    for m in MONEY.findall(text):
        out.add(("money", m.strip()))
    for m in PERCENT.findall(text):
        out.add(("percent", m.strip()))
    for n, unit in DURATION.findall(text):
        out.add(("duration", f"{n} {unit.lower()}"))
    for m in BIGNUM.findall(text):
        out.add(("number", m.strip()))
    return out


def read_frontmatter(raw):
    """Returns (meta, body). Only the shapes this KB uses: scalars, and lists under a key.

    The list items have to stay attached to the key above them. A file with both
    `source_urls:` and `source_files:` would otherwise pour its local filenames into the
    url list, and the url check would then report a perfectly good file as citing a page
    that was never scraped.
    """
    fm_block, _, body = raw[3:].partition("\n---")
    meta = {}
    current = None
    for line in fm_block.splitlines():
        if m := re.match(r"^(\w+):\s*(.*)$", line):
            key, value = m.group(1), m.group(2).strip()
            current = key
            meta[key] = value if value else []
        elif (m := re.match(r"^\s+-\s*(\S+)", line)) and current:
            if not isinstance(meta.get(current), list):
                meta[current] = []
            meta[current].append(m.group(1))
    for key in ("source_urls", "source_files"):
        meta.setdefault(key, [])
        if isinstance(meta[key], str):
            meta[key] = [meta[key]] if meta[key] else []
    return meta, body


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass

    root = pathlib.Path(__file__).resolve().parent.parent
    kb_dir, raw_dir = root / "knowledge-base", root / "source-raw"
    given_dir = root / "source-provided"

    source_pages = {f.name: f.read_text(encoding="utf-8") for f in sorted(raw_dir.glob("*.md"))}

    # Not everything can be scraped. Copy supplied by the business - the WebWorks Co.
    # description, for one - lives in source-provided/ verbatim, so a claim written from it
    # is checkable exactly like a claim written from a page. Content with no source in
    # either directory is the thing this tool exists to catch.
    given_pages = {f.name: f.read_text(encoding="utf-8") for f in sorted(given_dir.glob("*.md"))} \
        if given_dir.is_dir() else {}
    source_norm = norm(" ".join([*source_pages.values(), *given_pages.values()]))

    manifest = json.loads((raw_dir / "_manifest.json").read_text(encoding="utf-8"))
    known_urls = set(manifest["pages"])

    problems = defaultdict(list)
    stats = {"files": 0, "chunks": 0, "figures": 0}

    kb_files = {p.name: p.read_text(encoding="utf-8")
                for p in sorted(kb_dir.glob("*.md")) if CONTENT_FILE.match(p.name)}
    kb_norm = norm(" ".join(kb_files.values()))

    for name, raw in kb_files.items():
        stats["files"] += 1
        if not raw.startswith("---"):
            problems["no frontmatter"].append(name)
            continue
        meta, body = read_frontmatter(raw)

        missing = REQUIRED_KEYS - {k for k, v in meta.items() if v}
        if missing:
            problems["frontmatter relies on a default"].append(f"{name}: {sorted(missing)}")

        if meta.get("provenance") == "provided" and not meta["source_files"]:
            problems["provided content names no source file"].append(name)
        for given in meta["source_files"]:
            if not (root / given).is_file():
                problems["names a source file that is not there"].append(f"{name}: {given}")

        # A cited page that was never scraped means the claim cannot be checked by anyone.
        for u in meta["source_urls"]:
            base = u.split("#")[0].rstrip("/")
            if base not in known_urls and base + "/" not in known_urls:
                problems["cites a page not in the scrape"].append(f"{name}: {u}")

        for section in re.split(r"\n(?=## )", body):
            if not section.strip().startswith("##"):
                continue
            stats["chunks"] += 1
            heading = section.splitlines()[0].lstrip("# ").strip()
            spoken = " ".join(
                line.lstrip("> ").removeprefix("Spoken:").strip()
                for line in section.splitlines() if line.startswith(">"))
            prose = "\n".join(line for line in section.splitlines() if not line.startswith(">"))
            where = f"{meta.get('id', name)}#{heading[:48]}"

            for kind, fig in figures(prose):
                stats["figures"] += 1
                if norm(fig) not in source_norm:
                    problems[f"UNGROUNDED {kind}"].append(f"{where}: {fig!r}")

            # The repo's tested TTS normaliser turns 35,000 into words, in three languages. A spoken
            # line that spells the number out bypasses it, and the Hindi and Kannada paths cannot
            # normalise an English number word.
            if spoken and NUMBER_WORDS.search(spoken):
                problems["spoken spells a number out"].append(where)

    # The reverse direction: a figure the site publishes that the KB never mentions. Most hits are
    # correctly dropped - the marketing pages are full of mocked-up dashboards and sample guests, and
    # an agent that quotes a fake guest's loyalty points is worse than one that says it does not know.
    # So this reports rather than fails, and a reviewer decides. It is what found the liability cap.
    uncovered = {}
    for name, body in source_pages.items():
        for line in body.splitlines():
            if line.startswith("<!-- fetched:"):
                continue                      # the scraper's own provenance stamp, not site content
            for kind, fig in figures(line):
                if kind == "duration":
                    continue                  # too noisy in this direction; durations are prose-bound
                if norm(fig) not in kb_norm:
                    uncovered.setdefault((kind, fig, name), line.strip()[:100])

    print(f"knowledge base: {stats['files']} files, {stats['chunks']} chunks")
    print(f"source scrape:  {len(source_pages)} pages, {sum(map(len, source_pages.values())):,} chars")
    if given_pages:
        print(f"source provided: {len(given_pages)} files, {sum(map(len, given_pages.values())):,} chars")
    print(f"figures checked: {stats['figures']}")
    print()

    hard = 0
    for kind in sorted(problems, key=lambda k: (not k.startswith("UNGROUNDED"), k)):
        items = problems[kind]
        severe = kind.startswith("UNGROUNDED") or "not in the scrape" in kind or kind == "no frontmatter"
        hard += len(items) if severe else 0
        print(f"{'FAIL' if severe else 'warn'}  {kind}  ({len(items)})")
        for item in items[:12]:
            print(f"        {item}")
        if len(items) > 12:
            print(f"        ... and {len(items) - 12} more")
        print()

    print(f"note  figures published on the site but absent from the KB  ({len(uncovered)})")
    print("      mostly mocked dashboards and sample guests, correctly dropped - skim for real terms")
    for (kind, fig, page), ctx in sorted(uncovered.items())[:14]:
        print(f"        [{kind:7}] {fig:>13}  {page}")
        print(f"                      {ctx}")
    if len(uncovered) > 14:
        print(f"        ... and {len(uncovered) - 14} more")

    if not hard:
        print()
        print("clean: every figure in the KB appears in the scrape")
    return 1 if hard else 0


if __name__ == "__main__":
    sys.exit(main())
