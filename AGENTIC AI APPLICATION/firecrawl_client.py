"""Firecrawl v2 scrape-only client. No search endpoint."""
import requests
import config


class FirecrawlError(RuntimeError):
    pass


def _headers() -> dict:
    if not config.FIRECRAWL_API_KEY:
        raise FirecrawlError("No FIRECRAWL_API_KEY set in .env")
    return {"Authorization": f"Bearer {config.FIRECRAWL_API_KEY}",
            "Content-Type": "application/json"}


def firecrawl_scrape(url: str, formats: list = None, *,
                     only_main_content: bool = False, wait_for: int = 2500) -> dict | None:
    try:
        payload = {
            "url": url,
            "formats": formats or ["markdown"],
            "onlyMainContent": only_main_content,
        }
        if wait_for > 0:
            payload["waitFor"] = wait_for
        resp = requests.post(f"{config.FIRECRAWL_BASE_URL}/scrape",
                             headers=_headers(), json=payload,
                             timeout=config.FIRECRAWL_TIMEOUT)
        if resp.status_code != 200:
            return None
        body = resp.json()
        if not body.get("success"):
            return None
        return body.get("data") or {}
    except requests.RequestException:
        return None
