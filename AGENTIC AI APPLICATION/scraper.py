

import concurrent.futures
import json
import re
import time
import urllib.parse

import requests
from bs4 import BeautifulSoup

import config
from firecrawl_client import firecrawl_scrape
from jina_client import jina_read

_SCRAPE_CACHE: dict[str, dict] = {}

EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(r"(?:\+\d{1,3}[\s\-]?)?\(?\d{2,5}\)?[\s\-]?\d{3,5}[\s\-]?\d{3,5}")

VALID_EMAIL_TLDS = {"com", "in", "org", "net", "co", "io", "co.in", "edu", "gov", "info", "biz"}


def _valid_email(email: str) -> bool:
    if not email or "@" not in email:
        return False
    parts = email.split("@")
    if len(parts) != 2:
        return False
    domain = parts[1].lower()
    tld = domain.split(".")[-1]
    if tld.isdigit() or len(tld) < 2:
        return False
    local = parts[0].lower()
    if any(x in local for x in ("tracker", "pixel", "noreply", "no-reply", "unsubscribe")):
        return False
    return True


def _valid_phone(phone: str) -> bool:
    raw = (phone or "").strip()
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 10 or len(digits) > 15:
        return False
    if len(set(digits)) <= 2:
        return False
    if digits.startswith(("19", "20")) and len(digits) == 10:
        return False
    if re.match(r"^\d{1,3}-\d{4}-\d{4}$", raw):
        return False
    if len(digits) > 12 and not raw.startswith("+"):
        return False
    if len(digits) == 10 and digits[0] not in "6789":
        return False
    if raw.startswith("+"):
        return True
    if raw.startswith("(") or any(c in raw for c in "-(). "):
        return True
    return False

SOCIAL_DOMAINS = {
    "linkedin.com": "linkedin",
    "twitter.com": "twitter",
    "x.com": "twitter",
    "facebook.com": "facebook",
    "instagram.com": "instagram",
    "youtube.com": "youtube",
    "github.com": "github",
    "threads.net": "threads",
    "wa.me": "whatsapp",
    "whatsapp.com": "whatsapp",
    "t.me": "telegram",
    "telegram.me": "telegram",
    "telegram.org": "telegram",
    "pinterest.com": "pinterest",
    "tiktok.com": "tiktok",
    "medium.com": "medium",
}

# Platform name matched against a logo link's alt text / class / aria-label
# / data-* attrs / sprite refs / background-image / hidden text — catches
# social icons whose href is a tracking/short link with no platform
# domain in it.
ICON_KEYWORDS = {
    "linkedin": "linkedin",
    "twitter": "twitter", "x-twitter": "twitter", "x-social": "twitter",
    "facebook": "facebook", "fb-": "facebook",
    "instagram": "instagram", "insta": "instagram",
    "youtube": "youtube", "yt-": "youtube",
    "whatsapp": "whatsapp",
    "github": "github",
    "threads": "threads",
    "telegram": "telegram",
    "pinterest": "pinterest",
    "tiktok": "tiktok",
    "medium": "medium",
}

# Domains/path patterns that are almost never the actual destination —
# short-link services and generic internal redirect endpoints. Any
# social candidate whose href matches one of these gets a redirect-
# resolution attempt (point 4).
TRACKER_PATTERNS = [
    re.compile(r"bit\.ly", re.I), re.compile(r"tinyurl\.com", re.I),
    re.compile(r"\bt\.co\b", re.I), re.compile(r"lnkd\.in", re.I),
    re.compile(r"fb\.me", re.I), re.compile(r"ow\.ly", re.I),
    re.compile(r"buff\.ly", re.I), re.compile(r"rebrand\.ly", re.I),
    re.compile(r"cutt\.ly", re.I), re.compile(r"shorturl\.at", re.I),
    re.compile(r"linktr\.ee", re.I),  # link-in-bio pages: worth resolving/flagging too
    re.compile(r"/(goto|go|redirect|out|track|link)/", re.I),
    re.compile(r"[?&](url|redirect|goto)=", re.I),
]

# Generic "absolute URL" matcher used for the raw-HTML regex scan (point 3)
# and for pulling a full URL out of JSON-LD sameAs entries.
URL_RE = re.compile(r"https?://[^\s\"'<>\\]+")

REDIRECT_TIMEOUT = 5  # seconds — best-effort, never allowed to stall the run
MAX_REDIRECTS_RESOLVED_PER_PAGE = 8  # cap outbound resolution calls per page


def _normalise_url_candidate(value: str) -> str:
    """Normalise common HTML/JSON URL encodings without changing the URL's
    meaning. Firecrawl may return escaped JSON URLs such as
    escaped social URL forms such as https://instagram.com/zepto or
    protocol-relative //instagram.com/...."""
    if not isinstance(value, str):
        return ""
    value = value.strip().strip('\"\'<>')
    value = value.replace("\\/", "/")
    value = value.replace("&amp;", "&")
    if value.startswith("//"):
        value = "https:" + value
    return value


def _platform_for_url(url: str) -> str | None:
    url = _normalise_url_candidate(url)
    if not url:
        return None
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except Exception:
        host = ""
    host = host.removeprefix("www.")
    for domain, name in SOCIAL_DOMAINS.items():
        if host == domain or host.endswith("." + domain):
            return name
    return None


# ---------------------------------------------------------------- 1. links
def _link_url(item) -> str:
    """Accept Firecrawl links returned either as strings or link objects."""
    if isinstance(item, str):
        return _normalise_url_candidate(item)
    if isinstance(item, dict):
        for key in ("url", "href", "link", "sourceURL"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return _normalise_url_candidate(value)
    return ""


def _domain_socials(links: list) -> dict:
    """Firecrawl's parsed link list. Handles both string and object entries."""
    socials = {}
    for item in links or []:
        href = _link_url(item)
        name = _platform_for_url(href)
        if name and name not in socials:
            socials[name] = href
    return socials


# ---------------------------------------------------------------- 2. icons
def _icon_socials(html: str) -> dict:
    """Inspects every <a> in the parsed HTML, not just its href, for any
    signal that it's a social icon: class names, aria-label, title,
    data-* attributes, nested img/svg/i (alt, class, aria-label), SVG
    sprite refs (<use xlink:href="#icon-instagram">), inline
    background-image CSS, and visually-hidden accessible text."""
    socials = {}
    if not html:
        return socials
    soup = BeautifulSoup(html, "lxml")
    for a in soup.find_all("a", href=True):
        href = a["href"]
        parts = [
            " ".join(a.get("class", []) or []),
            a.get("aria-label", "") or "",
            a.get("title", "") or "",
            a.get("id", "") or "",
        ]
        # any data-* attribute on the <a> itself (data-social, data-icon,
        # data-platform, data-testid="social-instagram", etc.)
        for attr_name, attr_val in a.attrs.items():
            if attr_name.startswith("data-"):
                parts.append(attr_name)
                parts.append(attr_val if isinstance(attr_val, str) else " ".join(attr_val))
        style = a.get("style", "") or ""
        if "background" in style.lower():
            parts.append(style)

        for tag in a.find_all(["img", "svg", "i", "use", "span", "path"]):
            parts.append(tag.get("alt", "") or "")
            parts.append(" ".join(tag.get("class", []) or []))
            parts.append(tag.get("aria-label", "") or "")
            parts.append(tag.get("id", "") or "")
            # SVG sprite icon refs: <use xlink:href="#icon-instagram"> or href=
            parts.append(tag.get("xlink:href", "") or "")
            parts.append(tag.get("href", "") or "")
            tag_style = tag.get("style", "") or ""
            if "background" in tag_style.lower():
                parts.append(tag_style)
            for attr_name, attr_val in tag.attrs.items():
                if attr_name.startswith("data-"):
                    parts.append(attr_name)
                    parts.append(attr_val if isinstance(attr_val, str) else " ".join(attr_val))
            # <svg><title>Instagram</title></svg> and visually-hidden text
            # (<span class="sr-only">Follow us on Instagram</span>)
            tag_text = tag.get_text(" ", strip=True)
            if tag_text:
                parts.append(tag_text)

        haystack = " ".join(p for p in parts if p).lower()
        for kw, name in ICON_KEYWORDS.items():
            if kw in haystack and name not in socials:
                socials[name] = _normalise_url_candidate(href)
    return socials


# ---------------------------------------------------------- 3. raw HTML
def _raw_html_socials(html: str) -> dict:
    """Regex-scans the ENTIRE raw HTML string — not just rendered <a>
    tags BeautifulSoup finds — for social URLs. This catches:
      - schema.org JSON-LD `sameAs` arrays (Organization markup), which
        is often the single most reliable source of official social
        links when a site has it, since it's meant to be machine-read.
      - social URLs embedded in <script> hydration/state blobs (common
        in React/Next.js sites) that never render as a plain <a href>.
      - malformed/unparsed markup BeautifulSoup's tree-builder skips.
    """
    socials = {}
    if not html:
        return socials

    # 3a. JSON-LD sameAs (most reliable — explicit, structured, official)
    try:
        soup = BeautifulSoup(html, "lxml")
        for script in soup.find_all("script", type=lambda t: t and "ld+json" in t):
            raw = script.string or script.get_text() or ""
            if not raw.strip():
                continue
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            nodes = data if isinstance(data, list) else [data]
            for node in nodes:
                if isinstance(node, dict) and "@graph" in node and isinstance(node["@graph"], list):
                    nodes.extend(node["@graph"])
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                same_as = node.get("sameAs")
                if not same_as:
                    continue
                for url in (same_as if isinstance(same_as, list) else [same_as]):
                    if not isinstance(url, str):
                        continue
                    name = _platform_for_url(url)
                    if name and name not in socials:
                        socials[name] = url
    except Exception:
        pass  # best-effort — malformed JSON-LD shouldn't break the scrape

    # 3b. Blanket regex pass over the whole HTML text. Include escaped
    # JSON URLs and protocol-relative URLs because modern React/Next sites
    # frequently keep footer/social destinations inside hydration blobs.
    raw_candidates = list(URL_RE.findall(html))
    raw_candidates.extend(re.findall(r"(?<![A-Za-z0-9])(?:https?:\\/\\/|https?://|//)[^\s\"'<>\\]+", html))
    for match in raw_candidates:
        url = _normalise_url_candidate(match.rstrip("\\\"'),.;"))
        name = _platform_for_url(url)
        if name and name not in socials:
            socials[name] = url

    # 3c. Explicit href/src attributes, including relative links that may be
    # redirected to a social profile.
    try:
        soup = BeautifulSoup(html, "lxml")
        for tag in soup.find_all(True):
            for attr in ("href", "src", "data-href", "data-url", "data-link"):
                value = tag.get(attr)
                if isinstance(value, str):
                    value = _normalise_url_candidate(value)
                    name = _platform_for_url(value)
                    if name and name not in socials:
                        socials[name] = value
    except Exception:
        pass

    return socials


# ---------------------------------------------------- 4. redirect resolve
def _looks_like_tracker(url: str) -> bool:
    if _platform_for_url(url):
        return False  # already a recognized social domain, nothing to resolve
    return any(p.search(url) for p in TRACKER_PATTERNS)


def _resolve_redirect(url: str) -> str:
    """Follows a suspected tracker/shortener link to its final
    destination. HEAD first (cheap), falling back to GET if the server
    doesn't support HEAD (common for redirect endpoints built on simple
    frameworks). Best-effort: any failure just returns the original URL
    unchanged, never raises, never blocks the rest of the pipeline."""
    headers = {"User-Agent": config.USER_AGENT}
    try:
        resp = requests.head(url, allow_redirects=True, timeout=REDIRECT_TIMEOUT, headers=headers)
        if resp.url and resp.status_code < 400:
            return resp.url
    except requests.RequestException:
        pass
    try:
        resp = requests.get(url, allow_redirects=True, timeout=REDIRECT_TIMEOUT,
                             headers=headers, stream=True)
        final = resp.url
        resp.close()
        if final:
            return final
    except requests.RequestException:
        pass
    return url


def _resolve_social_candidates(socials: dict, base_url: str = "") -> dict:
    """Resolve non-social URLs that were positively identified as social
    icons. This covers internal routes such as /instagram, tracking URLs,
    and short links. Direct social URLs are never re-requested."""
    resolved = dict(socials)
    candidates = []
    for name, raw_url in socials.items():
        url = _normalise_url_candidate(raw_url)
        if not url or _platform_for_url(url):
            continue
        absolute = urllib.parse.urljoin(base_url, url) if base_url else url
        # Pull obvious nested redirect parameters without a network request.
        try:
            query = urllib.parse.parse_qs(urllib.parse.urlparse(absolute).query)
            for key in ("url", "u", "target", "dest", "destination", "redirect", "redirect_url", "goto"):
                for nested in query.get(key, []):
                    nested = _normalise_url_candidate(nested)
                    nested_name = _platform_for_url(nested)
                    if nested_name:
                        resolved[nested_name] = nested
                        if nested_name != name and resolved.get(name) == raw_url:
                            del resolved[name]
                        nested = None
                        break
                if nested is None:
                    break
            else:
                candidates.append((name, absolute))
        except Exception:
            candidates.append((name, absolute))

    candidates = candidates[:MAX_REDIRECTS_RESOLVED_PER_PAGE]
    if not candidates:
        return resolved

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(candidates))) as pool:
        futures = {name: pool.submit(_resolve_redirect, url) for name, url in candidates}
        for name, fut in futures.items():
            try:
                final_url = _normalise_url_candidate(fut.result())
            except Exception:
                continue
            landed_platform = _platform_for_url(final_url)
            if landed_platform:
                resolved[landed_platform] = final_url
                if landed_platform != name and resolved.get(name) == socials.get(name):
                    resolved.pop(name, None)
    return resolved


def _resolve_tracker_socials(socials: dict) -> dict:
    """Backward-compatible wrapper for callers outside this module."""
    return _resolve_social_candidates(socials)


def _extract_from_page(url: str):
    """One Firecrawl scrape call for one guessed URL (including the
    homepage, ""). Returns None only if the fetch itself failed / the
    page doesn't exist — NOT if the page simply has no markdown text,
    since a link-only/JS-shell page can still carry valid social links
    via its `links` list or raw HTML that we don't want to discard."""
    data = firecrawl_scrape(
        url,
        formats=["markdown", "links", "html", "rawHtml"],
        only_main_content=False,
        wait_for=3000,
    )
    if not data:
        return None

    # `html` is Firecrawl's cleaned HTML; `rawHtml` is the unmodified page.
    # Keep both because cleaned HTML can drop the exact SVG/footer attributes
    # that identify social icons.
    html = data.get("html") or ""
    raw_html = data.get("rawHtml") or data.get("raw_html") or ""
    parse_html = raw_html or html
    links = data.get("links") or []
    text = (data.get("markdown") or "").strip()

    # If there's no markdown but there IS html/links, still extract from
    # those — only bail out if the fetch gave us nothing at all.
    if not text and not parse_html and not links:
        return None

    socials = {}
    socials.update(_domain_socials(links))                    # 1. Firecrawl links
    socials.update(_icon_socials(parse_html))                # 2. icon attributes
    socials.update(_raw_html_socials(parse_html))            # 3. raw HTML / JSON-LD
    if html and html != parse_html:
        socials.update(_icon_socials(html))
        socials.update(_raw_html_socials(html))
    # 4. Resolve icon links that are internal/tracking URLs to their final
    # social destination. Only candidates already identified as social icons
    # are resolved, so this does not crawl arbitrary links.
    socials = _resolve_social_candidates(socials, base_url=url)

    # Fall back to HTML's visible text for email/phone regexes when
    # markdown extraction came back empty (e.g. JS-rendered page where
    # Firecrawl's markdown conversion missed body content but the raw
    # HTML still has it).
    text_for_regex = text
    if not text_for_regex and parse_html:
        try:
            text_for_regex = BeautifulSoup(parse_html, "lxml").get_text(" ", strip=True)
        except Exception:
            text_for_regex = ""

    emails = {e for e in EMAIL_RE.findall(text_for_regex) if _valid_email(e)}
    phones = {ph.strip() for ph in PHONE_RE.findall(text_for_regex) if _valid_phone(ph)}

    return {"url": url, "text": text, "emails": emails, "phones": phones, "socials": socials}


def _extract_from_page_http(url: str, *, timeout: float | None = None) -> dict | None:
    """Direct HTTP homepage fetch — much faster than Firecrawl for the 5s path."""
    try:
        resp = requests.get(
            url,
            headers={
                "User-Agent": config.USER_AGENT,
                "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=float(timeout or getattr(config, "HTTP_SCRAPE_TIMEOUT", 8)),
            allow_redirects=True,
        )
        if resp.status_code >= 400 or not resp.text:
            return None
        html = resp.text
    except requests.RequestException:
        return None
    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        return None
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    text = soup.get_text("\n", strip=True)
    links = []
    for a in soup.find_all("a", href=True):
        href = a.get("href") or ""
        abs_url = urllib.parse.urljoin(url, href)
        links.append(abs_url)
    socials = {}
    socials.update(_domain_socials(links))
    socials.update(_icon_socials(html))
    socials.update(_raw_html_socials(html))
    emails = {e for e in EMAIL_RE.findall(text) if _valid_email(e)}
    phones = {ph.strip() for ph in PHONE_RE.findall(text) if _valid_phone(ph)}
    # Keep markdown-ish text for summary heuristics
    md = text[:15000]
    return {"url": str(resp.url), "text": md, "emails": emails, "phones": phones, "socials": socials}


def _extract_from_page_jina(url: str):
    """Jina Reader primary scrape — clean markdown for JS-heavy sites."""
    if not getattr(config, "USE_JINA_SCRAPER", True):
        return None
    if not getattr(config, "JINA_API_KEY", ""):
        return None
    data = jina_read(url)
    if not data:
        return None
    text = (data.get("text") or "").strip()
    links = data.get("links") or []
    # Also pull URLs embedded in markdown
    md_urls = URL_RE.findall(text)
    all_links = list(dict.fromkeys([*links, *md_urls]))
    if not text and not all_links:
        return None
    socials = _domain_socials(all_links)
    emails = {e for e in EMAIL_RE.findall(text) if _valid_email(e)}
    phones = {ph.strip() for ph in PHONE_RE.findall(text) if _valid_phone(ph)}
    return {
        "url": data.get("url") or url,
        "text": text[:15000],
        "emails": emails,
        "phones": phones,
        "socials": socials,
        "scraper": "jina",
    }


def _extract_from_page_fast(url: str):
    """Jina first -> HTTP -> Firecrawl fallback."""
    jina_page = _extract_from_page_jina(url)
    if jina_page and ((jina_page.get("text") or "").strip() or jina_page.get("emails") or jina_page.get("socials")):
        return jina_page

    page = _extract_from_page_http(url)
    if page and ((page.get("text") or "").strip() or page.get("emails") or page.get("socials")):
        page["scraper"] = "http"
        return page
    # One longer HTTP retry before Firecrawl (transient blocks / slow TTFB)
    page = _extract_from_page_http(url, timeout=max(12.0, float(getattr(config, "HTTP_SCRAPE_TIMEOUT", 8)) + 4))
    if page and ((page.get("text") or "").strip() or page.get("emails") or page.get("socials")):
        page["scraper"] = "http"
        return page
    data = firecrawl_scrape(
        url,
        formats=["markdown", "links"],
        only_main_content=True,
        wait_for=getattr(config, "FIRECRAWL_WAIT_FOR_FAST", 0),
    )
    if not data:
        return page
    links = data.get("links") or []
    text = (data.get("markdown") or "").strip()
    if not text and not links and not page:
        return None
    socials = {}
    socials.update(_domain_socials(links))
    emails = {e for e in EMAIL_RE.findall(text) if _valid_email(e)}
    phones = {ph.strip() for ph in PHONE_RE.findall(text) if _valid_phone(ph)}
    if page:
        emails |= set(page.get("emails") or [])
        phones |= set(page.get("phones") or [])
        socials.update(page.get("socials") or {})
        text = text or page.get("text") or ""
    return {
        "url": url,
        "text": text,
        "emails": emails,
        "phones": phones,
        "socials": socials,
        "scraper": "firecrawl",
    }


def scrape_company_site(base_url: str, *, fast: bool = True) -> dict:
    """
    Scrapes the company site.
    fast=True: homepage (+ optional about/contact) via Jina -> HTTP -> Firecrawl.
    fast=False: fuller multi-page crawl.
    """
    if not base_url.startswith("http"):
        base_url = "https://" + base_url
    # Drop tracking query params (?srsltid=...) so domain/root stay clean.
    parsed = urllib.parse.urlparse(base_url)
    clean = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path or "/", "", "", ""))
    base_url = clean.rstrip("/") or clean
    cache_key = base_url.lower() + ("|fast" if fast else "|full")
    if cache_key in _SCRAPE_CACHE:
        return _SCRAPE_CACHE[cache_key]
    parsed = urllib.parse.urlparse(base_url)
    root = f"{parsed.scheme}://{parsed.netloc}"

    subpaths = list(
        getattr(config, "FAST_CANDIDATE_SUBPATHS", [""]) if fast else config.CANDIDATE_SUBPATHS
    )
    if "" not in subpaths:
        subpaths = [""] + subpaths
    urls = list(dict.fromkeys(urllib.parse.urljoin(root + "/", p) for p in subpaths))
    extract = _extract_from_page_fast if fast else _extract_from_page

    visited = []
    combined_text_parts = []
    emails, phones, socials = set(), set(), {}
    scrapers_used = set()

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(urls))) as pool:
        for page in pool.map(extract, urls):
            if not page:
                continue
            visited.append(page["url"])
            if page.get("scraper"):
                scrapers_used.add(page["scraper"])
            if page["text"]:
                combined_text_parts.append(f"--- PAGE: {page['url']} ---\n{page['text']}")
            emails.update(page["emails"])
            phones.update(page["phones"])
            socials.update(page["socials"])

    result = {
        "root_url": root,
        "pages_visited": visited,
        "raw_text": "\n\n".join(combined_text_parts)[:20000],
        "emails_found": sorted(emails),
        "phones_found": sorted(phones),
        "socials_found": socials,
        "scrapers_used": sorted(scrapers_used),
    }
    # Empty scrapes are often transient (Jina 429 / slow sites) — do not cache them
    if visited or result["raw_text"]:
        _SCRAPE_CACHE[cache_key] = result
    elif fast:
        # One full-path retry after a short pause
        time.sleep(1.2)
        page = _extract_from_page_fast(root)
        if page and ((page.get("text") or "").strip() or page.get("emails") or page.get("socials")):
            result = {
                "root_url": root,
                "pages_visited": [page["url"]],
                "raw_text": (page.get("text") or "")[:20000],
                "emails_found": sorted(page.get("emails") or []),
                "phones_found": sorted(page.get("phones") or []),
                "socials_found": dict(page.get("socials") or {}),
                "scrapers_used": [page["scraper"]] if page.get("scraper") else [],
            }
            _SCRAPE_CACHE[cache_key] = result
    return result


def extract_metadata_fast(company_name: str, scraped: dict) -> dict:
    """Heuristic metadata from scrape — no LLM (keeps latency low)."""
    text = (scraped.get("raw_text") or "").strip()
    summary = ""
    for line in text.splitlines():
        clean = re.sub(r"^#+\s*", "", line).strip()
        if len(clean) >= 40 and not clean.startswith("---"):
            summary = clean[:180]
            break
    socials = dict(scraped.get("socials_found") or {})
    GENERIC_SOCIAL_ROOTS = {
        "https://www.instagram.com", "https://instagram.com",
        "https://www.facebook.com", "https://facebook.com",
        "https://twitter.com", "https://x.com", "https://www.x.com",
        "https://www.linkedin.com", "https://linkedin.com",
        "https://www.youtube.com", "https://youtube.com",
        "https://www.tiktok.com", "https://tiktok.com",
        "https://www.pinterest.com", "https://pinterest.com",
    }
    filtered = {
        k: v for k, v in socials.items()
        if v and v.rstrip("/") not in GENERIC_SOCIAL_ROOTS
        and k not in {"github", "medium", "threads"}
    }
    return {
        "company_name": company_name,
        "brand_name": company_name,
        "industry": None,
        "year_founded": None,
        "company_address": None,
        "footer_legal_name": None,
        "management": [],
        "general_emails": (scraped.get("emails_found") or [])[:1],
        "general_phones": (scraped.get("phones_found") or [])[:1],
        "social_links": filtered,
        "one_line_summary": summary or None,
        "services_offered": [],
    }
