# WHAT: crawls every page of eatlabs.io with Scrapy and rewrites source-raw/ and its manifest.
# ROLE: the discovery half of the refresh loop. tools/scrape_eatlabs.py works from a hardcoded URL list,
#       which silently misses whole sections when the site grows - the /guide/* tree was twenty-two pages
#       old before anything noticed. This follows links instead, so a new page is found because it is
#       linked, not because somebody remembered to add it here.
#
#   python tools/crawl_eatlabs.py                 # crawl, report, write nothing
#   python tools/crawl_eatlabs.py --update        # also rewrite source-raw/ and _manifest.json
#   python tools/crawl_eatlabs.py --json out.json # machine-readable page list, for CI
#
# Exit codes match watch_site.py so CI can treat them the same way:
#   0  crawl completed
#   20 the site could not be reached at all
#
# Extraction is imported from watch_site.py rather than reimplemented. Those two scripts write the same
# files, and a second copy of the HTML-to-text rules would drift until every page showed a spurious diff
# depending on which tool ran last.

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from watch_site import SITE, RAW_DIR, MANIFEST, Extractor, to_text, slug_for, canonical  # noqa: E402

try:
    import scrapy
    from scrapy.crawler import CrawlerProcess
    from scrapy.linkextractors import LinkExtractor
except ImportError:
    sys.exit("Scrapy is not installed.  pip install scrapy")

# Anything that is not a page. Scrapy would happily download a 4 MB hero video and hand it to an HTML parser.
ASSETS = (".css", ".js", ".mjs", ".json", ".xml", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
          ".ico", ".pdf", ".zip", ".mp4", ".webm", ".mp3", ".woff", ".woff2", ".ttf", ".otf", ".map")


class EatLabsSpider(scrapy.Spider):
    name = "eatlabs"
    allowed_domains = ["eatlabs.io"]

    custom_settings = {
        "USER_AGENT": "EatLabsKBWatcher/1.0 (+https://eatlabs.io; knowledge-base refresh)",
        # The site's robots.txt disallows /legal/, which is where the terms, both privacy policies and the
        # deletion process live - the pages the agent is least allowed to get wrong. This is EatLabs' own
        # site and its own knowledge base, so the rule is not ours to be bound by; it exists to keep those
        # pages out of search results, not out of our index. Nothing here is republished.
        "ROBOTSTXT_OBEY": False,
        "CONCURRENT_REQUESTS": 4,          # a small marketing site; no reason to hammer it
        "DOWNLOAD_DELAY": 0.25,
        "DOWNLOAD_TIMEOUT": 45,
        "RETRY_TIMES": 3,
        "REDIRECT_ENABLED": True,          # /guide 301s to /guide/ - following it is the point
        "HTTPERROR_ALLOW_ALL": True,       # a 404 should be reported, not silently dropped
        "DEPTH_LIMIT": 0,
        "LOG_LEVEL": "WARNING",
    }

    def __init__(self, sink=None, **kw):
        super().__init__(**kw)
        self.sink = sink if sink is not None else {}   # {canonical_url: text}, filled as pages arrive
        self.failures = {}                             # {url: reason}
        self.link_extractor = LinkExtractor(allow_domains=["eatlabs.io"], deny_extensions=[], unique=True)

    def _seeds(self):
        # Sitemap first, then the crawl widens it. A page missing from the sitemap is exactly the failure
        # this script exists to catch, so the sitemap is a seed list and never the boundary.
        return [
            scrapy.Request(f"{SITE}/sitemap.xml", callback=self.parse_sitemap, dont_filter=True,
                           errback=self.on_error),
            scrapy.Request(f"{SITE}/", callback=self.parse_page, errback=self.on_error),
        ]

    # Scrapy 2.13 renamed the seed hook from start_requests() to an async start(), and 2.19 dropped the old
    # name outright - a spider that only defines start_requests() there crawls nothing and exits cleanly,
    # which is a miserable way to find out. Both names delegate to _seeds() so either generation works.
    async def start(self):
        for request in self._seeds():
            yield request

    def start_requests(self):
        return iter(self._seeds())

    def parse_sitemap(self, response):
        if response.status != 200:
            self.logger.warning(f"sitemap returned {response.status}; relying on the crawl alone")
            return
        for loc in response.xpath("//*[local-name()='loc']/text()").getall():
            loc = loc.strip()
            if loc.startswith(SITE):
                yield scrapy.Request(loc, callback=self.parse_page, errback=self.on_error)

    def parse_page(self, response):
        url = canonical(response.url)

        if response.status >= 400:
            self.failures[url] = f"HTTP {response.status}"
            return
        ctype = response.headers.get("Content-Type", b"").decode("latin-1").lower()
        if "html" not in ctype:
            return

        p = Extractor()
        p.feed(response.text)
        p.flush()
        self.sink[url] = to_text(p.out)

        # Follow every internal link on the page, including the footer - that is where the legal pages and
        # the guide index are reachable from, and they are linked from nowhere else on the home page.
        for link in self.link_extractor.extract_links(response):
            target = canonical(link.url)
            if not target.startswith(SITE):
                continue
            if urllib.parse.urlparse(target).path.lower().endswith(ASSETS):
                continue
            yield scrapy.Request(target, callback=self.parse_page, errback=self.on_error)

    def on_error(self, failure):
        url = canonical(failure.request.url)
        self.failures[url] = repr(failure.value)


def main():
    ap = argparse.ArgumentParser(description="Crawl eatlabs.io into source-raw/.")
    ap.add_argument("--update", action="store_true", help="rewrite source-raw/ and _manifest.json")
    ap.add_argument("--json", metavar="PATH", help="write the page list as JSON")
    args = ap.parse_args()

    pages = {}

    process = CrawlerProcess(settings={"TELNETCONSOLE_ENABLED": False})
    crawler = process.create_crawler(EatLabsSpider)
    process.crawl(crawler, sink=pages)
    process.start()

    failures = getattr(crawler.spider, "failures", {}) if crawler.spider else {}

    if not pages:
        print("Nothing was fetched - the site could not be reached.", file=sys.stderr)
        for url, why in sorted(failures.items()):
            print(f"  ! {url}: {why}", file=sys.stderr)
        return 20

    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    print(f"Crawled {len(pages)} pages from {SITE}\n")
    for url in sorted(pages):
        print(f"  {len(pages[url]):>7} chars  {url}")
    if failures:
        print(f"\n{len(failures)} did not come back:")
        for url, why in sorted(failures.items()):
            print(f"  ! {url}: {why}")

    if args.update:
        os.makedirs(RAW_DIR, exist_ok=True)
        manifest = {}
        for url, text in pages.items():
            fn = f"{slug_for(url)}.md"
            with open(os.path.join(RAW_DIR, fn), "w", encoding="utf-8") as f:
                f.write(f"<!-- source: {url} -->\n<!-- fetched: {stamp} -->\n\n{text}\n")
            manifest[url] = {"sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                             "chars": len(text), "file": fn}
        with open(MANIFEST, "w", encoding="utf-8") as f:
            json.dump({"pages": manifest, "last_run": stamp, "site": SITE}, f, ensure_ascii=False, indent=2)
        print(f"\nsource-raw/ and the manifest updated ({len(manifest)} pages).")
    else:
        print("\nNothing written. Re-run with --update to rewrite source-raw/.")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"site": SITE, "crawled_at": stamp,
                       "pages": {u: {"chars": len(t)} for u, t in sorted(pages.items())},
                       "failures": failures}, f, ensure_ascii=False, indent=2)
        print(f"Report written to {args.json}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
