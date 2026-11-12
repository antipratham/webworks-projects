"""Research tools: plain Python functions + OpenAI-compatible tool schemas."""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.robotparser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import requests
import trafilatura
from bs4 import BeautifulSoup
from ddgs import DDGS

import config

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

_rate_lock = threading.Lock()
_last_fetch_at = 0.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log_tool(name: str, args: dict, result: Any, latency_s: float, error: str | None = None) -> None:
    path = Path(config.TOOL_LOG_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "ts": _now_iso(),
        "tool": name,
        "args": args,
        "latency_s": round(latency_s, 3),
        "error": error,
        "result_preview": _preview(result),
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")


def _preview(result: Any, limit: int = 800) -> Any:
    try:
        text = json.dumps(result, ensure_ascii=False, default=str)
    except Exception:
        text = str(result)
    if len(text) > limit:
        return text[:limit] + "…"
    try:
        return json.loads(text)
    except Exception:
        return text


def _domain(url: str) -> str:
    try:
        return (urlparse(url).netloc or "").lower().removeprefix("www.")
    except Exception:
        return ""


def _host(url: str) -> str:
    try:
        return (urlparse(url).netloc or "").lower()
    except Exception:
        return ""


def _is_blocked_fetch(url: str) -> bool:
    host = _host(url)
    if host in config.BLOCKED_FETCH_DOMAINS:
        return True
    bare = host.removeprefix("www.")
    return any(bare == d.removeprefix("www.") or bare.endswith("." + d.removeprefix("www."))
               for d in config.BLOCKED_FETCH_DOMAINS)


def _rate_limit() -> None:
    global _last_fetch_at
    with _rate_lock:
        now = time.monotonic()
        wait = config.FETCH_RATE_LIMIT_SECONDS - (now - _last_fetch_at)
        if wait > 0:
            time.sleep(wait)
        _last_fetch_at = time.monotonic()


def _robots_allowed(url: str) -> bool:
    try:
        parsed = urlparse(url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(robots_url)
        rp.read()
        return bool(rp.can_fetch(config.USER_AGENT, url))
    except Exception:
        # If robots.txt is unreachable, allow with caution (common for research bots)
        return True


def _extract_text(html: str, url: str) -> str:
    if not html:
        return ""
    text = trafilatura.extract(
        html,
        url=url,
        include_comments=False,
        include_tables=True,
        favor_precision=True,
    ) or ""
    if len(text.strip()) >= config.MIN_PAGE_TEXT_CHARS:
        return text.strip()
    # Light BS4 fallback
    try:
        soup = BeautifulSoup(html, "lxml")
        for tag in soup(["script", "style", "noscript"]):
            tag.decompose()
        text2 = soup.get_text("\n", strip=True)
        return (text2 or text).strip()
    except Exception:
        return text.strip()


def _fetch_http(url: str) -> tuple[str, str]:
    _rate_limit()
    resp = requests.get(
        url,
        headers={
            "User-Agent": config.USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-IN,en;q=0.9",
        },
        timeout=config.HTTP_TIMEOUT,
        allow_redirects=True,
    )
    resp.raise_for_status()
    return str(resp.url), resp.text or ""


def _fetch_playwright(url: str) -> tuple[str, str]:
    if not config.USE_PLAYWRIGHT_FALLBACK:
        return url, ""
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return url, ""
    try:
        _rate_limit()
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page(user_agent=config.USER_AGENT)
                page.goto(url, wait_until="domcontentloaded", timeout=int(config.HTTP_TIMEOUT * 1000))
                page.wait_for_timeout(1500)
                html = page.content()
                final = page.url
                return final, html or ""
            finally:
                browser.close()
    except Exception:
        return url, ""


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def fetch_page(url: str) -> dict:
    """Fetch a URL and extract clean main text. Respects robots.txt + rate limit."""
    t0 = time.monotonic()
    args = {"url": url}
    try:
        target = (url or "").strip()
        if not target:
            out = {"ok": False, "error": "empty url", "url": url, "text": ""}
            _log_tool("fetch_page", args, out, time.monotonic() - t0, out["error"])
            return out
        if not target.startswith(("http://", "https://")):
            target = "https://" + target
        if _is_blocked_fetch(target):
            out = {
                "ok": False,
                "error": "blocked_domain: review/social sites may only be used via search snippets",
                "url": target,
                "text": "",
            }
            _log_tool("fetch_page", args, out, time.monotonic() - t0, out["error"])
            return out
        if not _robots_allowed(target):
            out = {"ok": False, "error": "robots.txt disallows fetch", "url": target, "text": ""}
            _log_tool("fetch_page", args, out, time.monotonic() - t0, out["error"])
            return out

        final_url, html = _fetch_http(target)
        text = _extract_text(html, final_url)
        method = "http+trafilatura"
        if len(text) < config.MIN_PAGE_TEXT_CHARS:
            pw_url, pw_html = _fetch_playwright(target)
            if pw_html:
                pw_text = _extract_text(pw_html, pw_url)
                if len(pw_text) > len(text):
                    text, final_url, method = pw_text, pw_url, "playwright+trafilatura"

        text = text[: config.MAX_PAGE_TEXT_CHARS]
        # Accept shorter pages if we at least got readable text (e.g. example.com)
        ok = len(text) >= 80
        out = {
            "ok": ok,
            "url": final_url,
            "method": method,
            "char_count": len(text),
            "text": text,
            "error": None if ok else "near-empty page text",
        }
        _log_tool("fetch_page", args, out, time.monotonic() - t0, out.get("error"))
        return out
    except Exception as exc:
        out = {"ok": False, "error": str(exc), "url": url, "text": ""}
        _log_tool("fetch_page", args, out, time.monotonic() - t0, str(exc))
        return out


def web_search(query: str, num_results: int = 5) -> dict:
    """Search the web via DuckDuckGo (ddgs). Optional Tavily fallback."""
    t0 = time.monotonic()
    args = {"query": query, "num_results": num_results}
    try:
        q = (query or "").strip()
        n = max(1, min(int(num_results or 5), 10))
        if not q:
            out = {"ok": False, "error": "empty query", "results": []}
            _log_tool("web_search", args, out, time.monotonic() - t0, out["error"])
            return out

        results: list[dict] = []
        backend = "ddgs"
        try:
            with DDGS() as ddgs:
                raw = list(ddgs.text(q, max_results=n)) or []
            for item in raw:
                results.append({
                    "title": (item.get("title") or "").strip(),
                    "url": (item.get("href") or item.get("url") or "").strip(),
                    "snippet": (item.get("body") or item.get("snippet") or "").strip(),
                })
        except Exception as ddg_exc:
            if config.TAVILY_API_KEY:
                results = _tavily_search(q, n)
                backend = "tavily"
                if not results:
                    raise ddg_exc
            else:
                raise

        if not results and config.TAVILY_API_KEY and backend == "ddgs":
            results = _tavily_search(q, n)
            backend = "tavily"

        out = {"ok": True, "backend": backend, "query": q, "results": results[:n]}
        _log_tool("web_search", args, out, time.monotonic() - t0)
        return out
    except Exception as exc:
        out = {"ok": False, "error": str(exc), "results": []}
        _log_tool("web_search", args, out, time.monotonic() - t0, str(exc))
        return out


def _tavily_search(query: str, num_results: int) -> list[dict]:
    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=config.TAVILY_API_KEY)
        data = client.search(query, max_results=num_results)
        out = []
        for item in data.get("results") or []:
            out.append({
                "title": (item.get("title") or "").strip(),
                "url": (item.get("url") or "").strip(),
                "snippet": (item.get("content") or "").strip(),
            })
        return out
    except Exception:
        return []


def search_reviews(company_name: str) -> dict:
    """India-focused review search via search-engine snippets only (no direct scrape)."""
    t0 = time.monotonic()
    args = {"company_name": company_name}
    try:
        brand = (company_name or "").strip()
        if not brand:
            out = {"ok": False, "error": "empty company_name", "results": []}
            _log_tool("search_reviews", args, out, time.monotonic() - t0, out["error"])
            return out
        sites = [
            "ambitionbox.com",
            "glassdoor.co.in",
            "justdial.com",
            "indeed.com",
        ]
        combined: list[dict] = []
        seen = set()
        for site in sites:
            q = f'"{brand}" site:{site}'
            hit = web_search(q, num_results=4)
            for r in hit.get("results") or []:
                url = r.get("url") or ""
                if url in seen:
                    continue
                seen.add(url)
                combined.append({**r, "source_site": site, "query": q})
        # Also generic review sentiment queries (still search-only)
        for q in (
            f'"{brand}" employee review India',
            f'"{brand}" customer review OR rating India',
        ):
            hit = web_search(q, num_results=4)
            for r in hit.get("results") or []:
                url = r.get("url") or ""
                if url in seen:
                    continue
                seen.add(url)
                combined.append({**r, "source_site": "web", "query": q})

        out = {"ok": True, "company_name": brand, "results": combined[:24]}
        _log_tool("search_reviews", args, out, time.monotonic() - t0)
        return out
    except Exception as exc:
        out = {"ok": False, "error": str(exc), "results": []}
        _log_tool("search_reviews", args, out, time.monotonic() - t0, str(exc))
        return out


def search_company_background(company_name: str) -> dict:
    """Background: founders, funding, controversy, MCA/registration — search snippets."""
    t0 = time.monotonic()
    args = {"company_name": company_name}
    try:
        brand = (company_name or "").strip()
        if not brand:
            out = {"ok": False, "error": "empty company_name", "results": []}
            _log_tool("search_company_background", args, out, time.monotonic() - t0, out["error"])
            return out
        queries = [
            f'"{brand}" founders',
            f'"{brand}" funding',
            f'"{brand}" news controversy',
            f'"{brand}" MCA registration OR CIN OR "Private Limited"',
            f'"{brand}" news after:{datetime.now().year - 1}',
        ]
        combined: list[dict] = []
        seen = set()
        for q in queries:
            hit = web_search(q, num_results=5)
            for r in hit.get("results") or []:
                url = r.get("url") or ""
                if url in seen:
                    continue
                seen.add(url)
                combined.append({**r, "query": q})
        out = {"ok": True, "company_name": brand, "results": combined[:30]}
        _log_tool("search_company_background", args, out, time.monotonic() - t0)
        return out
    except Exception as exc:
        out = {"ok": False, "error": str(exc), "results": []}
        _log_tool("search_company_background", args, out, time.monotonic() - t0, str(exc))
        return out


# Platforms we extract from the prospect's own HTML <a href> tags (ToS-safe).
_SOCIAL_PLATFORMS: list[tuple[str, re.Pattern]] = [
    ("instagram", re.compile(r"(?:^|\.)instagram\.com", re.I)),
    ("linkedin", re.compile(r"(?:^|\.)linkedin\.com/(?:company|in|school)/", re.I)),
    ("x", re.compile(r"(?:^|\.)(?:x\.com|twitter\.com)/", re.I)),
    ("facebook", re.compile(r"(?:^|\.)(?:facebook\.com|fb\.com)/", re.I)),
    ("youtube", re.compile(r"(?:^|\.)(?:youtube\.com|youtu\.be)/", re.I)),
    ("tiktok", re.compile(r"(?:^|\.)tiktok\.com/", re.I)),
    ("threads", re.compile(r"(?:^|\.)threads\.net/", re.I)),
    ("pinterest", re.compile(r"(?:^|\.)pinterest\.(?:com|co\.\w+)/", re.I)),
    ("github", re.compile(r"(?:^|\.)github\.com/", re.I)),
    ("whatsapp", re.compile(r"(?:wa\.me/|api\.whatsapp\.com/)", re.I)),
    ("telegram", re.compile(r"(?:^|\.)t\.me/", re.I)),
]


def _empty_socials() -> dict:
    return {name: None for name, _ in _SOCIAL_PLATFORMS}


def _parse_social_hrefs(html: str, base_url: str = "") -> dict:
    links = _empty_socials()
    if not html:
        return links
    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        return links
    for a in soup.find_all("a", href=True):
        href = (a.get("href") or "").strip()
        if not href or href.startswith(("#", "javascript:", "mailto:")):
            continue
        abs_url = href
        if base_url and not href.startswith(("http://", "https://")):
            from urllib.parse import urljoin
            abs_url = urljoin(base_url, href)
        host_path = abs_url
        try:
            p = urlparse(abs_url)
            host_path = f"{p.netloc}{p.path}"
        except Exception:
            pass
        for name, pat in _SOCIAL_PLATFORMS:
            if pat.search(abs_url) or pat.search(host_path):
                # Prefer first non-share / non-generic link
                if links[name]:
                    continue
                # Skip obvious share widgets without a profile path
                if name == "facebook" and re.search(r"facebook\.com/(sharer|share|dialog)", abs_url, re.I):
                    continue
                if name == "x" and re.search(r"(?:twitter|x)\.com/intent/", abs_url, re.I):
                    continue
                if name == "linkedin" and re.search(r"linkedin\.com/share", abs_url, re.I):
                    continue
                if name == "github" and re.search(r"github\.com/(features|pricing|about|login)", abs_url, re.I):
                    continue
                links[name] = abs_url.split("?")[0].rstrip("/")
                break
    return links


def _socials_found_count(links: dict) -> int:
    return sum(1 for v in links.values() if v)


def extract_social_links(url: str) -> dict:
    """Parse social profile hrefs from the prospect's own public HTML (not social platforms)."""
    t0 = time.monotonic()
    args = {"url": url}
    try:
        target = (url or "").strip()
        if not target:
            out = {"ok": False, "error": "empty url", "links": _empty_socials()}
            _log_tool("extract_social_links", args, out, time.monotonic() - t0, out["error"])
            return out
        if not target.startswith(("http://", "https://")):
            target = "https://" + target
        # Only fetch the prospect site — never open social platform URLs here
        if _is_blocked_fetch(target):
            out = {
                "ok": False,
                "error": "refusing to fetch blocked review/social platform URL; pass the company site URL",
                "links": _empty_socials(),
            }
            _log_tool("extract_social_links", args, out, time.monotonic() - t0, out["error"])
            return out

        robots_ok = _robots_allowed(target)
        final_url, html = target, ""
        method = "http"
        http_error = None
        if robots_ok:
            try:
                final_url, html = _fetch_http(target)
            except Exception as exc:
                http_error = str(exc)
                html = ""
        else:
            http_error = "robots.txt disallows automated fetch; trying Playwright fallback"

        links = _parse_social_hrefs(html, final_url) if html else _empty_socials()

        # Retry with Playwright when static HTML has no socials, 403s, or robots block
        need_pw = (
            config.USE_PLAYWRIGHT_FALLBACK
            and (_socials_found_count(links) == 0 or bool(http_error))
        )
        if need_pw:
            pw_url, pw_html = _fetch_playwright(target)
            if pw_html:
                pw_links = _parse_social_hrefs(pw_html, pw_url or final_url)
                if _socials_found_count(pw_links) >= _socials_found_count(links):
                    links = pw_links
                    method = "playwright"
                    final_url = pw_url or final_url
                    http_error = None

        # Normalize schemes/hosts
        for k, v in list(links.items()):
            if not v:
                continue
            if v.startswith("//"):
                v = "https:" + v
            if v.lower().startswith("http://"):
                v = "https://" + v[7:]
            links[k] = v

        out = {
            "ok": True,
            "url": final_url,
            "method": method,
            "found_count": _socials_found_count(links),
            "links": links,
            "warning": http_error,
            "error": None,
        }
        _log_tool("extract_social_links", args, out, time.monotonic() - t0)
        return out
    except Exception as exc:
        out = {"ok": False, "error": str(exc), "links": _empty_socials()}
        _log_tool("extract_social_links", args, out, time.monotonic() - t0, str(exc))
        return out


TOOL_IMPLS: dict[str, Callable[..., dict]] = {
    "fetch_page": fetch_page,
    "web_search": web_search,
    "search_reviews": search_reviews,
    "search_company_background": search_company_background,
    "extract_social_links": extract_social_links,
}


TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "fetch_page",
            "description": (
                "Fetch a public webpage and extract clean main text. "
                "Respects robots.txt. Do NOT use for LinkedIn, Glassdoor, "
                "AmbitionBox, Justdial, or Indeed — use search tools instead."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Full http(s) URL to fetch"},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web (DuckDuckGo). Returns title, url, snippet.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "num_results": {"type": "integer", "description": "Number of results (1-10)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_reviews",
            "description": (
                "Find employee/customer review snippets for an Indian company via "
                "search engines (AmbitionBox, Glassdoor.in, Justdial, Indeed). "
                "Does not scrape those sites directly."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "company_name": {"type": "string"},
                },
                "required": ["company_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_company_background",
            "description": (
                "Search founders, funding, controversies, MCA/registration, and recent news snippets."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "company_name": {"type": "string"},
                },
                "required": ["company_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "extract_social_links",
            "description": (
                "Extract social media profile links from the company's OWN website HTML "
                "(instagram, linkedin company/in, x/twitter, facebook, youtube, tiktok, "
                "threads, pinterest, github, whatsapp, telegram). Does not scrape social "
                "platforms — only parses <a href> on the given company URL."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Company website URL to parse"},
                },
                "required": ["url"],
            },
        },
    },
]


def execute_tool(name: str, arguments: dict | str | None) -> dict:
    """Dispatch a tool call safely."""
    fn = TOOL_IMPLS.get(name)
    if not fn:
        return {"ok": False, "error": f"unknown tool: {name}"}
    try:
        if isinstance(arguments, str):
            arguments = json.loads(arguments or "{}")
        arguments = arguments or {}
        if not isinstance(arguments, dict):
            return {"ok": False, "error": "arguments must be an object"}
        return fn(**arguments)
    except TypeError as exc:
        return {"ok": False, "error": f"bad arguments: {exc}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
