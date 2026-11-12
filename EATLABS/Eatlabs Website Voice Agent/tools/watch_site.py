# WHAT: watches eatlabs.io for change. Discovers every page (sitemap + crawl), extracts the text, compares it
#       with the last run, and reports what is new, what changed and what has gone - then names the knowledge
#       base chunks that cite the changed page and so need a human to look at them.
# ROLE: the refresh loop behind the knowledge base. The site is the source of truth and it moves; the KB is a
#       curated reading of it and must not drift. This script closes that gap without ever letting raw
#       marketing copy write itself into an answer the agent gives about money or the law.
#
#   python tools/watch_site.py                      # report what changed since last run
#   python tools/watch_site.py --update             # also rewrite source-raw/ and the manifest
#   python tools/watch_site.py --json report.json   # machine-readable, for CI
#
# Exit codes, so CI can act on them:
#   0  nothing changed
#   10 something changed and a person should look (see --json)
#   20 the site could not be reached
#
# Why it does not write the curated KB itself: the curated files carry judgement - which contradictions to
# flag, what the agent must never say, what a legal clause means for a caller. A diff cannot make those
# calls. What it can do is notice, and point at exactly the chunks that are now suspect.

import argparse
import difflib
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

SITE = "https://eatlabs.io"
UA = "EatLabsKBWatcher/1.0 (+https://eatlabs.io; knowledge-base refresh)"

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(HERE, "source-raw")
MANIFEST = os.path.join(RAW_DIR, "_manifest.json")
KB_JSONL = os.path.join(HERE, "kb.jsonl")

SKIP_TAGS = {"script", "style", "noscript", "svg", "path", "head", "template"}
BLOCK = {
    "p", "div", "section", "article", "header", "footer", "main", "nav", "aside",
    "ul", "ol", "table", "tr", "br", "hr", "form", "figure", "figcaption",
    "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "dt", "dd", "blockquote",
    "button", "label", "summary", "details", "option",
}

# A changed line touching any of these is a claim the agent could repeat on a sales call or a legal question.
# Everything else - a testimonial reworded, an image alt changed - is noise the KB does not need to track.
HIGH_RISK = re.compile(
    r"(₹|\bRs\b|\bINR\b|\bGST\b|\bcrore\b|\blakh\b|%|"
    r"\bprice|\bpricing|\bplan\b|\bper month\b|\bper venue\b|\bfree\b|\btrial\b|\bcredit|\btop-?up|"
    r"\bcontract|\bnotice\b|\brefund|\bcancel|\brenew|\bterm\b|\bSLA\b|\buptime|\bguarantee|\bunlimited|"
    r"\bDPDP|\bGDPR|\bcompliance|\bconsent|\bretention|\bdelete|\berasure|\bsub-?processor|"
    r"\bencrypt|\bsecurity|\bliability|\bwarrant)",
    re.IGNORECASE,
)


class Extractor(HTMLParser):
    """Same extraction the original scrape used, so hashes stay comparable across runs."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.buf, self.links = [], [], []
        self.skip_depth = 0
        self.cur_kind = "text"

    def flush(self):
        txt = re.sub(r"[ \t ]+", " ", "".join(self.buf)).strip()
        self.buf = []
        if txt:
            self.out.append((self.cur_kind, txt))
        self.cur_kind = "text"

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in SKIP_TAGS:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag == "a" and a.get("href"):
            self.links.append(a["href"])
        if tag == "img":
            alt = (a.get("alt") or "").strip()
            if alt:
                self.flush()
                self.out.append(("img", alt))
            return
        if tag in BLOCK:
            self.flush()
            if tag[0] == "h" and tag[1:].isdigit():
                self.cur_kind = tag
            elif tag == "li":
                self.cur_kind = "li"
            elif tag == "button":
                self.cur_kind = "btn"
            elif tag in ("td", "th"):
                self.cur_kind = "cell"

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS:
            self.skip_depth = max(0, self.skip_depth - 1)
        elif not self.skip_depth and tag in BLOCK:
            self.flush()

    def handle_data(self, data):
        if not self.skip_depth:
            self.buf.append(data)


def to_text(items):
    lines, prev = [], None
    for kind, txt in items:
        if txt == prev:
            continue
        prev = txt
        if kind[0] == "h" and kind[1:].isdigit():
            lines += ["", "#" * min(int(kind[1]) + 1, 6) + " " + txt, ""]
        elif kind == "li":
            lines.append("- " + txt)
        elif kind == "btn":
            lines.append(f"[button] {txt}")
        elif kind == "cell":
            lines.append("| " + txt)
        elif kind == "img":
            lines.append(f"[image: {txt}]")
        else:
            lines.append(txt)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def fetch(url, tries=3):
    last = None
    for attempt in range(tries):
        if attempt:
            time.sleep(1.5 * attempt)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


def slug_for(url):
    path = urllib.parse.urlparse(url).path.strip("/")
    return path.replace("/", "-") or "home"


def canonical(url):
    """Drop the query and the fragment. `/?plan=growth` only prefills a form - it is the same page as `/`,
    and left alone every variant collapses onto the same filename and overwrites it."""
    p = urllib.parse.urlparse(url)
    return f"{p.scheme}://{p.netloc}{p.path.rstrip('/')}" or SITE


def discover():
    """Sitemap first, then one crawl pass over internal links - a new page is often linked before it is
    listed, and a page missing from the KB because nobody updated the sitemap is exactly the failure here."""
    urls = set()
    try:
        xml = fetch(f"{SITE}/sitemap.xml")
        urls |= {m.strip() for m in re.findall(r"<loc>(.*?)</loc>", xml, re.DOTALL)}
    except Exception as e:  # noqa: BLE001
        print(f"  ! sitemap unreadable ({e}); falling back to a crawl", file=sys.stderr)

    urls.add(SITE + "/")
    seen, found = set(), dict()
    queue = sorted({canonical(u) for u in urls})

    while queue:
        url = queue.pop(0)
        norm = canonical(url)
        if norm in seen:
            continue
        seen.add(norm)
        try:
            html = fetch(url or SITE)
        except Exception as e:  # noqa: BLE001
            print(f"  ! {url}: {e}", file=sys.stderr)
            continue
        p = Extractor()
        p.feed(html)
        p.flush()
        found[norm] = to_text(p.out)

        for href in p.links:
            if href.startswith(("mailto:", "tel:", "#", "javascript:")):
                continue
            absolute = canonical(urllib.parse.urljoin(url, href))
            if absolute.startswith(SITE) and absolute not in seen:
                queue.append(absolute)
    return found


def load_manifest():
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            return json.load(f)
    return {"pages": {}, "last_run": None}


STOP = set((
    "the a an and or of to in on for with is are was were be been it its this that these those you your we our "
    "they their as at by from not no any all can will may must do does if then than so such other each per one "
    "two more most only own same s t just now what when where which who how why has have had about into out up"
).split())


def words(text):
    return {w for w in re.findall(r"[a-z0-9₹%]+", text.lower()) if w not in STOP and len(w) > 2}


def kb_chunks():
    """Every chunk with the urls it cites and its vocabulary, so a diff can be pointed at the few chunks it
    actually touches rather than at every chunk in the file."""
    out = []
    if not os.path.exists(KB_JSONL):
        return out
    with open(KB_JSONL, encoding="utf-8") as f:
        for line in f:
            c = json.loads(line)
            out.append({
                "id": c["id"],
                "urls": {u.split("#")[0].rstrip("/") for u in c.get("source_urls", [])},
                "words": words(c.get("heading", "") + " " + c.get("text", "")),
            })
    return out


def affected_chunks(chunks, url, changed_lines, limit=8):
    """Chunks citing this page, ranked by how much vocabulary they share with the lines that actually changed.

    Without the ranking this is useless: nearly every curated file lists the homepage in its `source_urls`,
    so a one-word change to the homepage 'affects' sixty chunks and a reviewer ignores the whole report.
    """
    citing = [c for c in chunks if url.rstrip("/") in c["urls"]]
    if not citing:
        return [], 0
    changed = words(" ".join(changed_lines))
    if not changed:
        return [], len(citing)
    scored = []
    for c in citing:
        overlap = changed & c["words"]
        if overlap:
            scored.append((len(overlap), c["id"], sorted(overlap)[:6]))
    scored.sort(reverse=True)
    return scored[:limit], len(citing)


def diff_lines(old, new):
    return [
        ln for ln in difflib.unified_diff(
            old.splitlines(), new.splitlines(), lineterm="", n=1,
            fromfile="previous", tofile="current",
        )
    ]


def main():
    # The diff is full of ₹ and Devanagari. A Windows console defaults to cp1252 and would die on the first
    # rupee sign - which is exactly the line we most need to print.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001  - older Python, or a stream that cannot be reconfigured
            pass

    ap = argparse.ArgumentParser(description="Watch eatlabs.io and report what the knowledge base must catch up with.")
    ap.add_argument("--update", action="store_true", help="rewrite source-raw/ and the manifest")
    ap.add_argument("--json", metavar="PATH", help="write the report as JSON")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    print(f"Fetching {SITE} ...")
    try:
        current = discover()
    except Exception as e:  # noqa: BLE001
        print(f"Could not reach the site: {e}", file=sys.stderr)
        return 20
    if not current:
        print("No pages fetched.", file=sys.stderr)
        return 20

    manifest = load_manifest()
    previous = manifest.get("pages", {})
    chunks = kb_chunks()

    report = {"checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "pages_seen": len(current),
              "new": [], "changed": [], "gone": [], "hash_drift": [], "needs_review": False}

    for url, text in sorted(current.items()):
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        before = previous.get(url)

        if before is None:
            entry = {"url": url, "chars": len(text),
                     "headings": re.findall(r"^#+\s+(.+)$", text, re.MULTILINE)[:12]}
            report["new"].append(entry)
            report["needs_review"] = True            # a new page is always a human decision
            continue

        if before["sha256"] == digest:
            continue

        old_text = ""
        raw_path = os.path.join(RAW_DIR, before.get("file", ""))
        if os.path.exists(raw_path):
            with open(raw_path, encoding="utf-8") as f:
                old_text = re.sub(r"^<!--.*?-->\n", "", f.read(), flags=re.MULTILINE).strip()

        d = diff_lines(old_text, text)
        touched = [ln for ln in d if ln[:1] in "+-" and ln[:3] not in ("+++", "---")]

        if not touched:
            # The hash moved but the text did not: source-raw/ is out of step with the manifest, usually
            # because someone edited it by hand. Worth saying, not worth waking anyone up for.
            report["hash_drift"].append({"url": url})
            continue

        risky = [ln for ln in touched if HIGH_RISK.search(ln)]
        ranked, citing_total = affected_chunks(chunks, url, touched)

        entry = {
            "url": url,
            "lines_changed": len(touched),
            "high_risk": bool(risky),
            "risk_lines": risky[:20],
            "diff": d[:120],
            "chunks_to_review": [{"id": cid, "shared_terms": terms, "score": n} for n, cid, terms in ranked],
            "chunks_citing_page": citing_total,
        }
        report["changed"].append(entry)
        if risky or ranked:
            report["needs_review"] = True

    for url in sorted(set(previous) - set(current)):
        orphaned = sorted(c["id"] for c in chunks if url.rstrip("/") in c["urls"])
        report["gone"].append({"url": url, "orphaned_chunks": orphaned})
        report["needs_review"] = True

    if not args.quiet:
        print(f"\n{len(current)} pages checked.")
        if not (report["new"] or report["changed"] or report["gone"]):
            print("No change since the last run.")
        for e in report["new"]:
            print(f"\nNEW  {e['url']}  ({e['chars']} chars)")
            for h in e["headings"]:
                print(f"       · {h}")
            print("     -> no KB coverage at all. Decide whether it needs a curated file.")
        for e in report["changed"]:
            flag = "HIGH RISK" if e["high_risk"] else "cosmetic"
            print(f"\nCHANGED  {e['url']}  ({e['lines_changed']} lines, {flag})")
            for ln in e["risk_lines"][:8]:
                print(f"       {ln}")
            if e["chunks_to_review"]:
                print(f"     -> review these chunks (of {e['chunks_citing_page']} citing this page):")
                for c in e["chunks_to_review"]:
                    print(f"          {c['id']}   [{', '.join(c['shared_terms'])}]")
            else:
                print(f"     -> no chunk's wording overlaps the change ({e['chunks_citing_page']} cite the page).")
        for e in report["gone"]:
            print(f"\nGONE  {e['url']}")
            if e["orphaned_chunks"]:
                print(f"     -> these chunks now cite a dead page: {', '.join(e['orphaned_chunks'])}")
        if report["hash_drift"]:
            print(f"\nhash drift (source-raw edited by hand, no site change): "
                  f"{', '.join(e['url'] for e in report['hash_drift'])}")

    if args.update:
        os.makedirs(RAW_DIR, exist_ok=True)
        pages = {}
        for url, text in current.items():
            fn = f"{slug_for(url)}.md"
            with open(os.path.join(RAW_DIR, fn), "w", encoding="utf-8") as f:
                f.write(f"<!-- source: {url} -->\n<!-- fetched: {report['checked_at']} -->\n\n{text}\n")
            pages[url] = {"sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                          "chars": len(text), "file": fn}
        with open(MANIFEST, "w", encoding="utf-8") as f:
            json.dump({"pages": pages, "last_run": report["checked_at"], "site": SITE}, f,
                      ensure_ascii=False, indent=2)
        print(f"\nsource-raw/ and the manifest updated ({len(pages)} pages).")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print(f"Report written to {args.json}")

    return 10 if report["needs_review"] else 0


if __name__ == "__main__":
    sys.exit(main())
