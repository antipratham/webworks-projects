"""App configuration — free-tier LLM backends + research settings."""
from __future__ import annotations

import os
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# LLM backend: "groq" (default) or "gemini" — one-line swap via .env
# ---------------------------------------------------------------------------
_raw_backend = (os.getenv("LLM_BACKEND", "") or "").strip().lower()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

# Auto-pick: honor LLM_BACKEND only when that provider's key exists
if _raw_backend == "groq" and GROQ_API_KEY:
    LLM_BACKEND = "groq"
elif _raw_backend == "gemini" and GEMINI_API_KEY:
    LLM_BACKEND = "gemini"
elif GROQ_API_KEY:
    LLM_BACKEND = "groq"
elif GEMINI_API_KEY:
    LLM_BACKEND = "gemini"
else:
    LLM_BACKEND = _raw_backend or "groq"

# Optional free-tier search fallback
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
SEARCH_BACKEND = (os.getenv("SEARCH_BACKEND", "ddgs") or "ddgs").strip().lower()

# Fetch / rate limits
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 "
    "CompanyResearchBot/1.0 (+local; due-diligence research)"
)
HTTP_TIMEOUT = float(os.getenv("HTTP_TIMEOUT", "20"))
FETCH_RATE_LIMIT_SECONDS = float(os.getenv("FETCH_RATE_LIMIT_SECONDS", "1.0"))
MIN_PAGE_TEXT_CHARS = int(os.getenv("MIN_PAGE_TEXT_CHARS", "400"))
MAX_PAGE_TEXT_CHARS = int(os.getenv("MAX_PAGE_TEXT_CHARS", "12000"))
USE_PLAYWRIGHT_FALLBACK = os.getenv("USE_PLAYWRIGHT_FALLBACK", "true").lower() in (
    "1", "true", "yes",
)

# Agent loop
MAX_TOOL_CALLS = int(os.getenv("MAX_TOOL_CALLS", "20"))
TOOL_LOG_PATH = os.getenv("TOOL_LOG_PATH", "./logs/tool_calls.jsonl")

OUTPUT_DIR = os.getenv("OUTPUT_DIR", "./reports")
PROPOSALS_DIR = os.getenv("PROPOSALS_DIR", "./proposals")
DEPLOY_PROPOSALS = os.getenv("DEPLOY_PROPOSALS", "true").lower() in ("1", "true", "yes")
NETLIFY_SITE_NAME = os.getenv("NETLIFY_SITE_NAME", "")  # optional pre-linked site

# Domains that must NEVER be fetched directly (ToS) — search snippets only
# Note: extracting social hrefs FROM the prospect's own site is allowed;
# fetching glassdoor/linkedin/ambitionbox pages themselves is not.
BLOCKED_FETCH_DOMAINS = frozenset({
    "linkedin.com",
    "www.linkedin.com",
    "glassdoor.com",
    "www.glassdoor.com",
    "glassdoor.co.in",
    "www.glassdoor.co.in",
    "ambitionbox.com",
    "www.ambitionbox.com",
    "justdial.com",
    "www.justdial.com",
    "indeed.com",
    "www.indeed.com",
    "in.indeed.com",
})
