"""Jina Reader API — primary URL->markdown scraper."""
from __future__ import annotations

import time

import requests

import config


class JinaError(RuntimeError):
    pass


def jina_read(url: str, *, timeout: float | None = None, retries: int = 3) -> dict | None:
    """Fetch a URL via https://r.jina.ai/{url} as markdown.

    Returns {"url", "title", "text", "links"} or None on failure.
    Retries briefly on empty / 429 / 5xx / network blips.
    """
    target = (url or "").strip()
    if not target:
        return None
    if not target.startswith(("http://", "https://")):
        target = "https://" + target

    key = getattr(config, "JINA_API_KEY", "") or ""
    if not key:
        return None

    timeout = float(timeout or getattr(config, "JINA_TIMEOUT", 20))
    endpoint = f"{config.JINA_READER_BASE.rstrip('/')}/{target}"
    headers = {
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "X-Return-Format": "markdown",
        "User-Agent": getattr(config, "USER_AGENT", "CompanyProfileBot/1.0"),
    }
    attempts = max(1, int(retries))
    for attempt in range(attempts):
        try:
            resp = requests.get(endpoint, headers=headers, timeout=timeout)
            if resp.status_code in (429, 500, 502, 503, 504):
                if attempt < attempts - 1:
                    time.sleep(0.8 * (attempt + 1))
                    continue
                return None
            if resp.status_code >= 400:
                return None
            ctype = (resp.headers.get("content-type") or "").lower()
            if "application/json" in ctype:
                body = resp.json()
                data = body.get("data") if isinstance(body, dict) else None
                if isinstance(data, dict):
                    text = (data.get("content") or data.get("text") or "").strip()
                    title = (data.get("title") or "").strip()
                    links = data.get("links") or []
                    if isinstance(links, dict):
                        links = list(links.values()) if links else []
                    if text or links:
                        return {
                            "url": data.get("url") or target,
                            "title": title,
                            "text": text,
                            "links": [str(x) for x in links if x][:200],
                        }
                elif isinstance(body, dict) and (body.get("content") or body.get("text")):
                    text = (body.get("content") or body.get("text") or "").strip()
                    if text:
                        return {
                            "url": target,
                            "title": (body.get("title") or "").strip(),
                            "text": text,
                            "links": [],
                        }
            else:
                text = (resp.text or "").strip()
                if text:
                    return {"url": target, "title": "", "text": text, "links": []}
            if attempt < attempts - 1:
                time.sleep(0.8 * (attempt + 1))
                continue
            return None
        except Exception:
            if attempt < attempts - 1:
                time.sleep(0.8 * (attempt + 1))
                continue
            return None
    return None
