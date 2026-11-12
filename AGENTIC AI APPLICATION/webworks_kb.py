"""Load WebWorks Co. service knowledge base for agent + proposal stages."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_KB_PATH = Path(__file__).resolve().parent / "webworks_services.json"


@lru_cache(maxsize=1)
def load_webworks_services() -> dict:
    if not _KB_PATH.exists():
        return {
            "company_name": "WebWorks Co.",
            "tagline": "",
            "website": "https://webworksco.in/",
            "service_categories": [],
            "credentials": [],
        }
    return json.loads(_KB_PATH.read_text(encoding="utf-8"))


def webworks_context_block() -> str:
    """Compact structured context for system prompts (reason over, don't copy-paste)."""
    kb = load_webworks_services()
    lines = [
        f"Vendor: {kb.get('company_name')} — {kb.get('tagline')}",
        f"Website: {kb.get('website')}",
        "Service categories (match findings -> services via fixes_weaknesses_like):",
    ]
    for cat in kb.get("service_categories") or []:
        lines.append(f"- Category: {cat.get('category')}")
        lines.append(f"  Services: {', '.join(cat.get('services') or [])}")
        lines.append(f"  Fixes weaknesses like: {', '.join(cat.get('fixes_weaknesses_like') or [])}")
    lines.append("Credentials (use verbatim only in proposals / Why WebWorks):")
    for c in kb.get("credentials") or []:
        lines.append(f"  • {c}")
    return "\n".join(lines)
