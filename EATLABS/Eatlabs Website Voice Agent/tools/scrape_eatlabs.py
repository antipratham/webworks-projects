"""Scrape eatlabs.io into structured markdown. Stdlib only."""
import html
import json
import os
import re
import sys
import urllib.request
from html.parser import HTMLParser

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

URLS = [
    "https://eatlabs.io/",
    "https://eatlabs.io/features",
    "https://eatlabs.io/who-its-for",
    "https://eatlabs.io/security",
    "https://eatlabs.io/faq",
    "https://eatlabs.io/contact",
    "https://eatlabs.io/legal/terms",
    "https://eatlabs.io/legal/privacy",
    "https://eatlabs.io/legal/guest-privacy",
    "https://eatlabs.io/legal/guest-terms",
    "https://eatlabs.io/legal/data-deletion",
]

SKIP_TAGS = {"script", "style", "noscript", "svg", "path", "head", "template"}
BLOCK = {
    "p", "div", "section", "article", "header", "footer", "main", "nav", "aside",
    "ul", "ol", "table", "tr", "br", "hr", "form", "figure", "figcaption",
    "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "dt", "dd", "blockquote",
    "button", "label", "summary", "details", "option",
}


class Extractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []          # list of (kind, text)
        self.skip_depth = 0
        self.tag_stack = []
        self.buf = []
        self.cur_kind = "text"
        self.links = []
        self.title = None
        self.in_title = False
        self.meta_desc = None

    # --- helpers -------------------------------------------------
    def flush(self):
        txt = "".join(self.buf)
        txt = re.sub(r"[ \t ]+", " ", txt).strip()
        self.buf = []
        if txt:
            self.out.append((self.cur_kind, txt))
        self.cur_kind = "text"

    # --- parser hooks --------------------------------------------
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in SKIP_TAGS:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag == "title":
            self.in_title = True
            return
        if tag == "meta" and a.get("name") == "description":
            self.meta_desc = a.get("content")
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
            if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
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
            return
        if tag == "title":
            self.in_title = False
            return
        if self.skip_depth:
            return
        if tag in BLOCK:
            self.flush()

    def handle_data(self, data):
        if self.skip_depth:
            return
        if self.in_title:
            self.title = (self.title or "") + data
            return
        self.buf.append(data)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8", "replace")


def to_markdown(items):
    lines = []
    prev = None
    for kind, txt in items:
        if txt == prev:          # collapse exact repeats (aria duplicates)
            continue
        prev = txt
        if kind in ("h1", "h2", "h3", "h4", "h5", "h6"):
            lvl = int(kind[1])
            lines.append("")
            lines.append("#" * min(lvl + 1, 6) + " " + txt)
            lines.append("")
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
    md = "\n".join(lines)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip()


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    pages = {}
    for url in URLS:
        slug = url.rstrip("/").replace("https://eatlabs.io", "") or "/home"
        slug = slug.strip("/").replace("/", "-") or "home"
        try:
            raw = fetch(url)
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {url}: {e}", file=sys.stderr)
            continue
        p = Extractor()
        p.feed(raw)
        p.flush()
        pages[slug] = {
            "url": url,
            "title": (p.title or "").strip(),
            "description": (p.meta_desc or "").strip(),
            "markdown": to_markdown(p.out),
            "links": sorted(set(p.links)),
            "bytes": len(raw),
        }
        print(f"OK {url}  html={len(raw)}B  text={len(pages[slug]['markdown'])}chars")

    with open(os.path.join(outdir, "_scraped.json"), "w", encoding="utf-8") as f:
        json.dump(pages, f, ensure_ascii=False, indent=2)

    for slug, p in pages.items():
        with open(os.path.join(outdir, f"{slug}.md"), "w", encoding="utf-8") as f:
            f.write(f"<!-- source: {p['url']} -->\n")
            f.write(f"<!-- title: {p['title']} -->\n")
            f.write(f"<!-- description: {p['description']} -->\n\n")
            f.write(p["markdown"] + "\n")
    print(f"\nWrote {len(pages)} pages to {outdir}")


if __name__ == "__main__":
    main(sys.argv[1])
