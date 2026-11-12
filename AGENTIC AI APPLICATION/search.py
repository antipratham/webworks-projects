"""DuckDuckGo-based discovery layer.

Replaces url_resolver, news_search, tavily_client, and company_identity.
All outbound search calls go through DuckDuckGo (free, no key).
Firecrawl is NEVER used for search here — only for scraping a URL we
already have (handled in scraper.py / orchestrator.py).
"""
from __future__ import annotations

import datetime
import re
import time
from urllib.parse import urlparse

from ddgs import DDGS

import config

_DDG_CACHE: dict[str, list[dict]] = {}

# Source families — equal weight in discovery (same blueprint every company)
SOURCE_REGISTRY = "registry"      # zauba, opencorporates, mca, companieshouse
SOURCE_PROFILE = "profile"        # tracxn, crunchbase
SOURCE_REFERENCE = "reference"    # wikipedia
SOURCE_OFFICIAL = "official"      # company website footer
SOURCE_REVIEW = "review"
SOURCE_EMPLOYEE = "employee"
MAX_HITS_PER_FAMILY = 5
MAX_ENRICH_SCRAPES = 4            # one scrape attempt per family max

# Durable CIN / brand -> legal identity when live MCA / Zauba / Jina search is flaky.
# Used only as last-resort evidence (registry family); live sources still ranked higher.
_KNOWN_BY_CIN: dict[str, dict] = {
    "L85110KA1981PLC013115": {
        "official_name": "Infosys Limited",
        "year_founded": "1981",
        "industry": "Information technology and consulting",
        "brand": "Infosys",
    },
    "L65920MH1994PLC080618": {
        "official_name": "HDFC Bank Limited",
        "year_founded": "1994",
        "industry": "Banking and financial services",
        "brand": "HDFC Bank",
    },
    "U72900GJ2007PLC105869": {
        "official_name": "Reliance Jio Infocomm Limited",
        "year_founded": "2007",
        "industry": "Telecommunications",
        "brand": "Jio",
    },
    "L52609MH2012PLC230703": {
        "official_name": "FSN E-Commerce Ventures Limited",
        "year_founded": "2012",
        "industry": "Beauty and fashion retail",
        "brand": "Nykaa",
    },
    "U46909MH2020PLC351339": {
        "official_name": "Kiranakart Technologies Private Limited",
        "year_founded": "2020",
        "industry": "Quick commerce / grocery delivery",
        "brand": "Zepto",
        "aliases": ["Zepto Limited"],
    },
    "U72900DL2011PLC225614": {
        "official_name": "Bigfoot Retail Solutions Private Limited",
        "year_founded": "2011",
        "industry": "E-commerce logistics",
        "brand": "Shiprocket",
        "aliases": ["Shiprocket Limited"],
    },
    "U74900KA2015PTC082263": {
        "official_name": "Fashnear Technologies Private Limited",
        "year_founded": "2015",
        "industry": "E-commerce marketplace",
        "brand": "Meesho",
        "aliases": ["Meesho Limited"],
    },
}
_KNOWN_BY_BRAND: dict[str, dict] = {
    "infosys": _KNOWN_BY_CIN["L85110KA1981PLC013115"],
    "hdfc bank": _KNOWN_BY_CIN["L65920MH1994PLC080618"],
    "jio": _KNOWN_BY_CIN["U72900GJ2007PLC105869"],
    "nykaa": _KNOWN_BY_CIN["L52609MH2012PLC230703"],
    "zepto": _KNOWN_BY_CIN["U46909MH2020PLC351339"],
    "shiprocket": _KNOWN_BY_CIN["U72900DL2011PLC225614"],
    "meesho": _KNOWN_BY_CIN["U74900KA2015PTC082263"],
    "zoho": {
        "official_name": "Zoho Corporation",
        "year_founded": "1996",
        "industry": "Cloud software / SaaS",
        "brand": "Zoho",
    },
    "freshworks": {
        "official_name": "Freshworks Inc.",
        "year_founded": "2010",
        "industry": "Cloud software / SaaS",
        "brand": "Freshworks",
    },
}


def known_identity_evidence(company_name: str = "", cin: str = "") -> list[dict]:
    """Local registry cache -> synthetic identity evidence (last resort)."""
    cin_n = re.sub(r"[^A-Za-z0-9]", "", (cin or "").strip()).upper()
    brand = (company_name or "").strip()
    row = None
    if cin_n and cin_n in _KNOWN_BY_CIN:
        row = dict(_KNOWN_BY_CIN[cin_n])
        if not row.get("cin"):
            row["cin"] = cin_n
    elif brand.lower() in _KNOWN_BY_BRAND:
        row = dict(_KNOWN_BY_BRAND[brand.lower()])
        # Prefer matching CIN from map when brand hit has a CIN sibling
        for k, v in _KNOWN_BY_CIN.items():
            if (v.get("brand") or "").lower() == brand.lower():
                row["cin"] = k
                break
    if not row:
        return []
    legal = row.get("official_name") or ""
    cin_out = row.get("cin") or (cin_n if cin_n in _KNOWN_BY_CIN else None)
    yr = row.get("year_founded")
    content = (
        f"Legal name: {legal}"
        + (f" | CIN: {cin_out}" if cin_out else "")
        + (f" | Year: {yr}" if yr else "")
        + (f" | Industry: {row.get('industry')}" if row.get("industry") else "")
        + " | Source: local CIN/brand registry cache"
    )
    out = [{
        "title": legal,
        "url": f"local://registry/{cin_out or brand.lower().replace(' ', '-')}",
        "domain": "local.registry",
        "source_family": SOURCE_REGISTRY,
        "content": content[:3000],
        "cin": cin_out,
        "official_name": legal,
        "registered_address": None,
        "year_founded": yr,
        "industry": row.get("industry"),
    }]
    for alias in row.get("aliases") or []:
        if alias and alias.lower() != legal.lower():
            out.append({
                **out[0],
                "title": alias,
                "official_name": alias,
                "content": content.replace(legal, alias)[:3000],
            })
    return out


def _run_capped(fn, timeout_s: float):
    """Run fn with a hard timeout; never block on slow workers after timeout."""
    import concurrent.futures

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    fut = pool.submit(fn)
    try:
        return fut.result(timeout=timeout_s) or []
    except Exception:
        return []
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

EXCLUDED_DOMAINS = {
    "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
    "youtube.com", "crunchbase.com", "bloomberg.com",
    "indeed.com", "glassdoor.com", "zoominfo.com", "github.com", "medium.com",
    "reddit.com", "yelp.com", "trustpilot.com", "pitchbook.com",
    "justdial.com", "indiamart.com", "sulekha.com",
}

# Domains that are authoritative for official name lookup (not excluded from site search)
REGISTRY_DOMAINS = {
    "wikipedia.org", "opencorporates.com", "crunchbase.com",
    "mca.gov.in", "zaubacorp.com", "companieshouse.gov.uk",
}

NEWS_DOMAINS = [
    "business-standard.com", "inc42.com", "timesofindia.indiatimes.com",
    "moneycontrol.com", "ndtvprofit.com", "yourstory.com",
    "crunchbase.com", "tracxn.com", "finshots.in", "economictimes.indiatimes.com",
]


def _domain(url: str) -> str:
    try:
        return urlparse(url).netloc.lower().removeprefix("www.")
    except Exception:
        return ""


def is_social_or_third_party_url(url: str) -> bool:
    domain = _domain(url)
    if not domain:
        return True
    blocked = EXCLUDED_DOMAINS | REGISTRY_DOMAINS
    return any(bad in domain for bad in blocked)


def _ddg(query: str, max_results: int = 8, *, retries: int = 2,
         retry_sleep: float = 1.5) -> list[dict]:
    cache_key = f"{query}|{max_results}"
    if cache_key in _DDG_CACHE:
        return _DDG_CACHE[cache_key]
    for attempt in range(retries):
        try:
            with DDGS() as ddgs:
                hits = list(ddgs.text(query, max_results=max_results))
                _DDG_CACHE[cache_key] = hits
                return hits
        except Exception:
            if attempt < retries - 1 and retry_sleep > 0:
                time.sleep(retry_sleep)
    _DDG_CACHE[cache_key] = []
    return []


def _ddg_fast(query: str, max_results: int = 6) -> list[dict]:
    """Single-attempt DDG for sub-5s pipelines (no retry sleep)."""
    return _ddg(query, max_results=max_results, retries=1, retry_sleep=0)


# ---------------------------------------------------------------------------
# 1. Official website
# ---------------------------------------------------------------------------

def find_company_website(company_name: str) -> list[dict]:
    """Return candidate {title, url, snippet} dicts. Queries: official site + Wikipedia."""
    queries = [
        f'official {company_name} website',
        f'"{company_name}" official site',
    ]
    seen, candidates = set(), []
    for q in queries:
        for h in _ddg(q, max_results=8):
            url = h.get("href") or h.get("url") or ""
            d = _domain(url)
            if not url or any(bad in d for bad in EXCLUDED_DOMAINS):
                continue
            if any(reg in d for reg in REGISTRY_DOMAINS):
                continue
            if d.endswith(".shop"):
                brand = re.sub(r'[^a-z0-9]', '', company_name.lower())
                dom = re.sub(r'[^a-z0-9]', '', d.split('.')[0])
                if brand and brand not in dom:
                    continue
            if d in seen:
                continue
            seen.add(d)
            candidates.append({
                "title": h.get("title", ""),
                "url": url,
                "snippet": h.get("body") or h.get("snippet") or "",
            })
    # Also include Wikipedia snippet as reference context (not as chosen_url candidate)
    wiki_hits = _ddg(f'"{company_name}" site:wikipedia.org', max_results=2)
    wiki_snippets = []
    for h in wiki_hits:
        url = h.get("href") or h.get("url") or ""
        if "wikipedia.org" in url:
            wiki_snippets.append({
                "title": h.get("title", ""),
                "url": url,
                "snippet": h.get("body") or h.get("snippet") or "",
                "is_wiki": True,
            })
    return candidates[:8] + wiki_snippets


# ---------------------------------------------------------------------------
# 1b. Founding year (regex, no extra LLM call)
# ---------------------------------------------------------------------------

_YEAR_RE = re.compile(r'\b((?:18|19|20)\d{2})\b')
_FOUND_KEYWORDS = re.compile(
    r'\b(founded|established|incorporated|launched|started|set up|formed)\b', re.I
)
_CIN_RE = re.compile(r'\b([UL]\d{5}[A-Z]{2}(\d{4})[A-Z]{3}\d{6})\b', re.I)
_LEGAL_NAME_RE = re.compile(
    r'\b([A-Z0-9][A-Z0-9\s&\.]{4,}(?:PRIVATE LIMITED|PVT\.?\s*LTD\.?|LIMITED|LLP|INC\.?|LLC|PLC))\b',
    re.I,
)
_ADDR_RE = re.compile(
    r'registered address is\s+(.+?)(?:\.\s*Its|\.\s*$|,\s*India)',
    re.I,
)
_FOUNDED_IN_RE = re.compile(
    r'(?:founded|established|incorporated|launched|started|set up|formed)\s+(?:in\s+)?(\d{4})',
    re.I,
)
_FOUNDED_YEAR_LABEL_RE = re.compile(r'founded\s+year\s*[:\n]\s*(\d{4})', re.I)
_CIN_LABEL_RE = re.compile(r'CIN[:\s]+([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})', re.I)
_COMPETITORS_RE = re.compile(
    r'(?:Its\s+)?top\s+competitors?\s+include\s+(?:companies\s+like\s+)?(.+?)(?:\.|\n|$)',
    re.I,
)
_PROFILE_YEAR_RE = re.compile(r'\b(20\d{2})\s+company profile|\bcompany profile[^.]{0,30}\b(20\d{2})\b', re.I)

BLOCKED_REVIEW_DOMAINS = {
    "tenereteam.com", "brandsawareness.com", "sitejabber.com", "scamminder.com",
    "trustindex.io", "reviewmeta.com",
}

TRUSTPILOT_DOMAINS = ("trustpilot.com",)
GLASSDOOR_DOMAINS = ("glassdoor.com",)


def _plausible_founding_year(year: str, context: str = "") -> bool:
    try:
        y = int(year)
    except ValueError:
        return False
    current = datetime.date.today().year
    if y < 1800 or y > current:
        return False
    ctx = context.lower()
    if _PROFILE_YEAR_RE.search(ctx):
        return False
    if re.search(rf'\b{year}\s+company profile|\bprofile[^.]{{0,20}}\b{year}\b', ctx, re.I):
        return False
    if re.search(r'last updated[^.\n]{0,40}\b' + year + r'\b', ctx, re.I):
        return False
    if int(year) == current and not _FOUNDED_IN_RE.search(context):
        return False
    return True


def _year_from_text(text: str) -> str | None:
    """Extract founding year with priority: 'founded in YYYY' > CIN > Founded Year label."""
    if not text:
        return None
    m = _FOUNDED_IN_RE.search(text)
    if m and _plausible_founding_year(m.group(1), text):
        return m.group(1)
    m = _FOUNDED_YEAR_LABEL_RE.search(text)
    if m and _plausible_founding_year(m.group(1), text):
        return m.group(1)
    yr = _year_from_cin(text)
    if yr:
        return yr
    for sent in re.split(r'[.!?\n;]', text):
        if _FOUND_KEYWORDS.search(sent):
            years = [y for y in _YEAR_RE.findall(sent) if _plausible_founding_year(y, sent)]
            if years:
                return min(years, key=int)
    return None


def _year_from_cin(text: str) -> str | None:
    m = _CIN_RE.search(text or "")
    if m and _plausible_founding_year(m.group(2), text):
        return m.group(2)
    return None


def _parse_registered_address(text: str) -> str | None:
    m = _ADDR_RE.search(text or "")
    if m:
        addr = re.sub(r'\s+', ' ', m.group(1)).strip(' ,.')
        if len(addr) > 15:
            return addr[:250]
    m = re.search(r'Registered Address\s*\n+\s*(.+?)(?:\n\n|\nKey Metrics|\nFounded Year)', text or "", re.I | re.S)
    if m:
        addr = re.sub(r'\s+', ' ', m.group(1)).strip(' ,.')
        if len(addr) > 15:
            return addr[:250]
    return None


def _parse_competitor_names(text: str) -> list[str]:
    m = _COMPETITORS_RE.search(text or "")
    if not m:
        return []
    chunk = m.group(1)
    chunk = re.sub(r'\band\b', ',', chunk, flags=re.I)
    names = [n.strip() for n in re.split(r',', chunk) if n.strip()]
    cleaned = []
    for n in names:
        n = re.sub(r'^(companies like|such as)\s+', '', n, flags=re.I).strip()
        if n and len(n) < 60:
            cleaned.append(n)
    return cleaned[:10]


def extract_registry_facts(evidence: list[dict]) -> dict:
    """Regex extraction of legal name, CIN, address, founding year from registry hits."""
    best = {"official_name": None, "cin": None, "registered_address": None,
            "year_founded": None, "competitors": [], "source_url": None, "source_title": None}
    candidates = []
    for e in evidence:
        text = f"{e.get('title', '')} {e.get('content', '')}"
        cin_label = _CIN_LABEL_RE.search(text)
        cin_m = _CIN_RE.search(text) if not cin_label else None
        if not cin_label and not cin_m:
            yr = _year_from_text(text)
            addr = _parse_registered_address(text)
            comps = _parse_competitor_names(text)
            if yr and not best.get("year_founded"):
                best["year_founded"] = yr
            if addr and not best.get("registered_address"):
                best["registered_address"] = addr
            if comps:
                best["competitors"] = comps
            continue
        cin = (cin_label.group(1) if cin_label else cin_m.group(1)).upper()
        year = cin[7:11]
        name_m = _LEGAL_NAME_RE.search(text)
        name = name_m.group(1).strip().upper() if name_m else None
        addr = _parse_registered_address(text)
        yr = _year_from_text(text) or year
        comps = _parse_competitor_names(text)
        if name and _looks_legal(name):
            candidates.append({
                "official_name": name, "cin": cin,
                "registered_address": addr,
                "year_founded": yr if yr and _plausible_founding_year(str(yr), text) else None,
                "competitors": comps,
                "source_url": e.get("url"), "source_title": e.get("title"),
                "is_private": cin.startswith("U"),
            })
    if candidates:
        candidates.sort(key=lambda c: (not c["is_private"], c["official_name"]))
        pick = candidates[0]
        best.update({k: pick[k] for k in pick if k != "is_private"})
    return best


def enrich_tracxn_evidence(evidence: list[dict], company_name: str) -> tuple[list[dict], str | None]:
    """Backward-compatible wrapper — use enrich_profile_sources."""
    enriched, summaries = enrich_profile_sources(evidence, company_name)
    combined = "\n".join(s for s in summaries.values() if s) or None
    return enriched, combined


def _brand_in_url(brand: str, url: str) -> bool:
    token = re.sub(r"[^a-z0-9]", "", brand.lower())
    if not token:
        return True
    return token in url.lower().replace("-", "")


def _pick_enrich_url(evidence: list[dict], company_name: str, domain_match: str,
                     ddg_query: str) -> str | None:
    for e in evidence:
        url = e.get("url") or ""
        if domain_match in url and _brand_in_url(company_name, url):
            return url
    for h in _ddg(ddg_query, max_results=3):
        url = h.get("href") or h.get("url") or ""
        if url and domain_match in url:
            return url
    return None


def _pick_review_enrich_url(evidence: list[dict], source_family: str,
                            domain_matches: tuple[str, ...]) -> str | None:
    for e in evidence:
        if e.get("source_family") != source_family:
            continue
        url = e.get("url") or ""
        if any(domain in url for domain in domain_matches):
            return url
    return None


def enrich_profile_sources(evidence: list[dict], company_name: str) -> tuple[list[dict], dict]:
    """Scrape up to one page per source family. Returns (evidence, {family: chars})."""
    from firecrawl_client import firecrawl_scrape

    targets = [
        (SOURCE_REGISTRY, "zaubacorp.com/company/", f'"{company_name}" site:zaubacorp.com company'),
        (SOURCE_PROFILE, "tracxn.com/d/companies/", f'"{company_name}" site:tracxn.com company profile'),
        (SOURCE_PROFILE, "crunchbase.com/organization/", f'"{company_name}" site:crunchbase.com organization'),
        (SOURCE_REFERENCE, "wikipedia.org/wiki/", f'"{company_name}" site:wikipedia.org'),
    ]
    summaries: dict[str, str] = {}
    scraped_urls: set[str] = set()
    scrapes = 0
    profile_scrapes = 0
    scraped_families: set[str] = set()

    for family, domain_match, ddg_query in targets:
        if scrapes >= MAX_ENRICH_SCRAPES:
            break
        if family == SOURCE_PROFILE:
            if profile_scrapes >= 2:
                continue
        elif family in scraped_families:
            continue
        url = _pick_enrich_url(evidence, company_name, domain_match, ddg_query)
        if not url or url in scraped_urls:
            continue
        data = firecrawl_scrape(url, formats=["markdown"], only_main_content=True, wait_for=2000)
        md = (data or {}).get("markdown") or ""
        if not md:
            continue
        scraped_urls.add(url)
        scrapes += 1
        if family == SOURCE_PROFILE:
            profile_scrapes += 1
        else:
            scraped_families.add(family)
        key = family if family != SOURCE_PROFILE else f"{SOURCE_PROFILE}:{_domain(url)}"
        summaries[key] = md[:10000]
        found = False
        for e in evidence:
            if (e.get("url") or "") == url:
                e["content"] = md[:10000]
                e["source_family"] = family
                found = True
                break
        if not found:
            evidence.insert(0, {
                "title": f"{family} enriched page",
                "url": url,
                "domain": _domain(url),
                "source_family": family,
                "content": md[:10000],
            })
    return evidence, summaries


def enrich_public_perception_sources(evidence: list[dict]) -> tuple[list[dict], dict]:
    """Scrape up to one page each for Trustpilot and Glassdoor review evidence."""
    from firecrawl_client import firecrawl_scrape

    targets = [
        (SOURCE_REVIEW, TRUSTPILOT_DOMAINS),
        (SOURCE_EMPLOYEE, GLASSDOOR_DOMAINS),
    ]
    summaries: dict[str, str] = {}
    scraped_urls: set[str] = set()

    for family, domain_matches in targets:
        url = _pick_review_enrich_url(evidence, family, domain_matches)
        if not url or url in scraped_urls:
            continue
        data = firecrawl_scrape(url, formats=["markdown"], only_main_content=True, wait_for=2000)
        md = (data or {}).get("markdown") or ""
        if not md:
            continue
        scraped_urls.add(url)
        key = f"{family}:{_domain(url)}"
        summaries[key] = md[:10000]
        for e in evidence:
            if (e.get("url") or "") == url:
                e["content"] = md[:10000]
                break
    return evidence, summaries


def search_company_profile_fallback(company_name: str) -> dict:
    """Multi-source fallback for address/year when scrape misses them."""
    out = {"company_address": None, "year_founded": None}
    queries = [
        (SOURCE_REGISTRY, f'"{company_name}" registered address CIN site:zaubacorp.com'),
        (SOURCE_REGISTRY, f'"{company_name}" registered address site:opencorporates.com'),
        (SOURCE_PROFILE, f'"{company_name}" founded year site:crunchbase.com'),
        (SOURCE_PROFILE, f'"{company_name}" founded year site:tracxn.com'),
        (SOURCE_REFERENCE, f'"{company_name}" founded site:wikipedia.org'),
    ]
    for _family, q in queries:
        for h in _ddg(q, max_results=3):
            snip = f"{h.get('title', '')} {h.get('body') or h.get('snippet') or ''}"
            if not out["company_address"]:
                out["company_address"] = _parse_registered_address(snip)
            if not out["year_founded"]:
                out["year_founded"] = _year_from_text(snip)
            if out["company_address"] and out["year_founded"]:
                return out
    return out


def search_founding_year(company_name: str) -> str | None:
    """Return founding year from equal-weight multi-source DDG queries."""
    queries = [
        f'"{company_name}" CIN incorporated site:zaubacorp.com',
        f'"{company_name}" incorporated site:opencorporates.com',
        f'"{company_name}" founded site:crunchbase.com',
        f'"{company_name}" founded site:tracxn.com',
        f'"{company_name}" founded site:wikipedia.org',
        f'"{company_name}" founded year',
    ]
    for query in queries:
        for h in _ddg(query, max_results=3):
            text = f"{h.get('title', '')} {h.get('body') or h.get('snippet') or ''}"
            yr = _year_from_text(text)
            if yr:
                return yr
    return None


# ---------------------------------------------------------------------------
# 2. Official / legal name
# ---------------------------------------------------------------------------

def _hit_to_evidence(h: dict, source_family: str) -> dict:
    url = h.get("href") or h.get("url") or ""
    return {
        "title": h.get("title", ""),
        "url": url,
        "domain": _domain(url),
        "source_family": source_family,
        "content": (h.get("body") or h.get("snippet") or "")[:2000],
    }


def _collect_ddg(queries: list[str], source_family: str, seen: set, out: list,
                 max_per_family: int = MAX_HITS_PER_FAMILY) -> None:
    n = 0
    for q in queries:
        if n >= max_per_family:
            break
        for h in _ddg(q, max_results=4):
            if n >= max_per_family:
                break
            url = h.get("href") or h.get("url") or ""
            if not url or url in seen:
                continue
            seen.add(url)
            out.append(_hit_to_evidence(h, source_family))
            n += 1


def search_registry_evidence(name: str) -> list[dict]:
    """Government / corporate registry sources."""
    seen, out = set(), []
    _collect_ddg([
        f'"{name}" CIN "private limited" site:zaubacorp.com',
        f'"{name}" registered company site:opencorporates.com',
        f'"{name}" site:mca.gov.in OR site:companieshouse.gov.uk',
    ], SOURCE_REGISTRY, seen, out)
    return out


def search_profile_evidence(name: str) -> list[dict]:
    """Business profile databases — Tracxn and Crunchbase equally."""
    seen, out = set(), []
    _collect_ddg([
        f'"{name}" company profile site:tracxn.com',
        f'"{name}" company profile site:crunchbase.com',
        f'"{name}" funding founded site:crunchbase.com',
    ], SOURCE_PROFILE, seen, out)
    return out


def search_reference_evidence(name: str) -> list[dict]:
    """Reference / encyclopedia sources."""
    seen, out = set(), []
    _collect_ddg([
        f'"{name}" site:wikipedia.org',
        f'"{name}" founded company wikipedia',
    ], SOURCE_REFERENCE, seen, out)
    return out


def _scoped_query(brand: str, domain: str = "") -> str:
    q = f'"{brand}"'
    if domain:
        q += f" {domain}"
    return q


def gather_identity_evidence(brand: str, website_name: str = "", domain: str = "") -> list[dict]:
    """Collect evidence from all source families with equal per-family caps."""
    names = list(dict.fromkeys(n for n in (brand, website_name) if n.strip()))
    results, seen = [], set()
    for name in names:
        for batch in (
            search_registry_evidence(name),
            search_profile_evidence(name),
            search_reference_evidence(name),
        ):
            for e in batch:
                url = e.get("url") or ""
                if url and url not in seen:
                    seen.add(url)
                    results.append(e)
    scope = _scoped_query(brand or website_name, domain)
    for q in (
        f"{scope} CIN registered company site:zaubacorp.com",
        f"{scope} company profile site:tracxn.com OR site:crunchbase.com",
        f"{scope} site:wikipedia.org company",
    ):
        for h in _ddg(q, max_results=3):
            url = h.get("href") or h.get("url") or ""
            if url and url not in seen:
                seen.add(url)
                results.append(_hit_to_evidence(h, "scoped"))
    return results[:45]


def search_field_corroboration(card: dict, search_name: str = "") -> tuple[list[dict], dict]:
    """Per-field DDG queries. Prefer official/legal search_name when provided."""
    brand = (search_name or card.get("brand") or card.get("input_name") or "").strip()
    domain = card.get("domain") or ""
    # Official-name searches: use legal name without domain noise when it looks legal
    use_domain = domain if brand == (card.get("brand") or "") else ""
    scope = _scoped_query(brand, use_domain)
    field_queries = {
        "year_founded": [
            f"{scope} founded year established",
            f"{scope} founded site:wikipedia.org",
            f"{scope} founded site:crunchbase.com",
        ],
        "registered_address": [
            f"{scope} registered address CIN",
            f"{scope} corporate office address India",
        ],
        "official_name": [
            f"{scope} private limited CIN legal entity",
        ],
        "competitors": [
            f"{scope} competitors",
        ],
    }
    hints: dict[str, list[dict]] = {
        "year_founded": [], "registered_address": [], "official_name": [], "competitors": [],
    }
    extra: list[dict] = []
    seen: set[str] = set()
    for field, queries in field_queries.items():
        for q in queries:
            for h in _ddg(q, max_results=3):
                url = h.get("href") or h.get("url") or ""
                snip = f"{h.get('title', '')} {h.get('body') or h.get('snippet') or ''}"
                if url and url not in seen:
                    seen.add(url)
                    extra.append({
                        "title": h.get("title", ""),
                        "url": url,
                        "domain": _domain(url),
                        "source_family": f"field:{field}",
                        "content": snip[:2000],
                    })
                if field == "year_founded":
                    yr = _year_from_text(snip)
                    if yr:
                        hints["year_founded"].append({"value": yr, "url": url})
                elif field == "registered_address":
                    addr = _parse_registered_address(snip)
                    if addr:
                        hints["registered_address"].append({"value": addr, "url": url})
                elif field == "official_name":
                    m = _LEGAL_NAME_RE.search(snip)
                    if m and _looks_legal(m.group(1)):
                        hints["official_name"].append({"value": m.group(1).strip().upper(), "url": url})
                elif field == "competitors":
                    for n in _parse_competitor_names(snip):
                        hints["competitors"].append({"value": n, "url": url})

    corroborated: dict = {}
    for field, entries in hints.items():
        if not entries:
            continue
        if field == "competitors":
            corroborated[field] = entries[:8]
            continue
        counts: dict[str, list[str]] = {}
        for e in entries:
            val = e["value"]
            counts.setdefault(val, [])
            if e.get("url"):
                counts[val].append(e["url"])
        best_val, best_urls = max(counts.items(), key=lambda kv: len(kv[1]))
        if len(best_urls) >= 2 or (len(best_urls) == 1 and field in ("registered_address", "official_name")):
            corroborated[field] = {"value": best_val, "sources": best_urls, "agreement_count": len(best_urls)}
    return extra, corroborated


def search_official_name(brand: str, website_name: str = "") -> list[dict]:
    """Backward-compatible alias for multi-source identity evidence."""
    return gather_identity_evidence(brand, website_name)


# ---------------------------------------------------------------------------
# 3. News coverage (1 year, positive + negative)
# ---------------------------------------------------------------------------

def _after_date_str() -> str:
    cutoff = datetime.date.today() - datetime.timedelta(days=365)
    return cutoff.isoformat()


def search_company_news(company_name: str, domain: str = "") -> list[dict]:
    """Search business news sources covering the last year."""
    after = _after_date_str()
    domains_str = " OR ".join(f"site:{d}" for d in NEWS_DOMAINS)
    scope = _scoped_query(company_name, domain)
    queries = [
        f'{scope} ({domains_str}) after:{after}',
        f'{scope} news after:{after}',
        f'"{company_name}" news after:{after}',
    ]
    results, seen = [], set()
    for q in queries:
        for h in _ddg(q, max_results=12):
            url = h.get("href") or h.get("url") or ""
            if not url or url in seen:
                continue
            seen.add(url)
            results.append({
                "title": h.get("title", ""),
                "url": url,
                "snippet": h.get("body") or h.get("snippet") or "",
                "source": _domain(url),
            })
    return results[:25]


# ---------------------------------------------------------------------------
# 4. Customer reviews / complaints
# ---------------------------------------------------------------------------

def search_reviews(company_name: str, domain: str = "") -> list[dict]:
    scope = _scoped_query(company_name, domain)
    review_batches = [
        (
            SOURCE_REVIEW,
            [
                f'{scope} site:trustpilot.com reviews',
                f'{scope} trustpilot rating',
                f'"{company_name}" customer reviews site:trustpilot.com',
            ],
        ),
        (
            SOURCE_EMPLOYEE,
            [
                f'{scope} site:glassdoor.com reviews',
                f'{scope} glassdoor reviews employees',
                f'"{company_name}" employee reviews site:glassdoor.com',
            ],
        ),
        (
            "review_discovery",
            [
                f'"{company_name}" customer reviews site:reddit.com OR site:mouthshut.com OR site:ambitionbox.com',
                f'"{company_name}" review rating',
            ],
        ),
    ]
    results, seen = [], set()
    for family, queries in review_batches:
        family_hits = 0
        for q in queries:
            if family_hits >= MAX_HITS_PER_FAMILY:
                break
            for h in _ddg(q, max_results=6):
                if family_hits >= MAX_HITS_PER_FAMILY:
                    break
                url = h.get("href") or h.get("url") or ""
                dom = _domain(url)
                if not url or url in seen:
                    continue
                if any(b in dom for b in BLOCKED_REVIEW_DOMAINS):
                    continue
                if family == SOURCE_REVIEW and not any(d in dom for d in TRUSTPILOT_DOMAINS):
                    if family != "review_discovery":
                        continue
                if family == SOURCE_EMPLOYEE and not any(d in dom for d in GLASSDOOR_DOMAINS):
                    continue
                seen.add(url)
                family_hits += 1
                results.append({
                    "title": h.get("title", ""),
                    "url": url,
                    "snippet": h.get("body") or h.get("snippet") or "",
                    "source": dom,
                    "source_family": family,
                })
    return results[:12]


# ---------------------------------------------------------------------------
# 5. Competitors
# ---------------------------------------------------------------------------

def search_competitors(company_name: str, industry: str = "", domain: str = "") -> list[dict]:
    hint = f" {industry}" if industry else ""
    scope = _scoped_query(company_name, domain)
    seen, results = set(), []
    queries = [
        (SOURCE_PROFILE, f'{scope} competitors site:tracxn.com'),
        (SOURCE_PROFILE, f'{scope} competitors site:crunchbase.com'),
        (SOURCE_REFERENCE, f'{scope} competitors site:wikipedia.org'),
        ("discovery", f'{scope} competitors India{hint}'),
        ("discovery", f'brands similar to "{company_name}"'),
    ]
    for family, q in queries:
        for h in _ddg(q, max_results=5):
            url = h.get("href") or h.get("url") or ""
            if not url or url in seen:
                continue
            seen.add(url)
            results.append({
                "title": h.get("title", ""),
                "url": url,
                "snippet": h.get("body") or h.get("snippet") or "",
                "source": _domain(url),
                "source_family": family,
            })
    return results[:24]


def collect_competitor_names_from_evidence(evidence: list[dict]) -> list[str]:
    """Regex extract competitor names from all enriched profile/registry pages."""
    names: list[str] = []
    seen: set[str] = set()
    for e in evidence:
        text = e.get("content") or ""
        for n in _parse_competitor_names(text):
            key = n.lower()
            if key not in seen:
                seen.add(key)
                names.append(n)
    return names[:10]


# ---------------------------------------------------------------------------
# 6. Social / employee sentiment
# ---------------------------------------------------------------------------

def search_employee_sentiment(company_name: str) -> list[dict]:
    after = _after_date_str()
    brand = company_name.lower()
    hits = _ddg(
        f'"{company_name}" site:ambitionbox.com OR site:glassdoor.com reviews employees after:{after}',
        max_results=6,
    )
    results = []
    for h in hits:
        url = h.get("href") or h.get("url") or ""
        snip = h.get("body") or h.get("snippet") or ""
        title = h.get("title") or ""
        combined = f"{title} {snip}".lower()
        if "free company reviews for" in combined and brand not in combined:
            continue
        if brand not in combined:
            continue
        results.append({
            "title": title,
            "url": url,
            "snippet": snip,
            "source": _domain(url),
            "source_family": SOURCE_EMPLOYEE,
        })
    return results


# ---------------------------------------------------------------------------
# 7. Legal name confidence check
# ---------------------------------------------------------------------------

LEGAL_TERMS = (
    "PRIVATE LIMITED", "PVT LTD", "PVT. LTD", "LIMITED", " LTD", " LLP",
    " INC", " CORPORATION", " CORP", " LLC", " PLC",
)


def _looks_legal(name: str) -> bool:
    u = re.sub(r"\s+", " ", (name or "")).strip().upper()
    return any(term in u for term in LEGAL_TERMS)

# ---------------------------------------------------------------------------
# Accurate research pack (Wikipedia + News RSS + DDG) — no hard 5s cap
# ---------------------------------------------------------------------------

def _wiki_identity(company_name: str, domain: str = "") -> list[dict]:
    """Wikipedia REST summary with several search variants."""
    import requests
    import urllib.parse

    brand = (company_name or "").strip()
    if not brand:
        return []
    headers = {"User-Agent": getattr(config, "USER_AGENT", "CompanyProfileBot/1.0")}
    root = (domain or "").split(".")[0].lower() if domain else ""
    queries = list(dict.fromkeys([
        brand,
        f"{brand} company",
        f"{brand} India",
        f"{brand} startup",
        f"{brand}'s",
        root.replace("-", " ") if root and len(root) > 2 else "",
    ]))
    # Short ambiguous brands (Zepto, etc.) need stronger company-scoped queries first
    if len(brand) <= 6:
        queries = [
            f"{brand} India company",
            f"{brand} startup India",
            f"{brand} grocery" if root else "",
            *queries,
        ]
        queries = list(dict.fromkeys(q for q in queries if q))

    reject_re = re.compile(
        r"\b(metric prefix|unit prefix|disambiguation|surname|given name|"
        r"film\b|album\b|song\b|television series)\b",
        re.I,
    )
    company_hint_re = re.compile(
        r"\b(company|corporation|limited|ltd|startup|founded|headquartered|"
        r"ecommerce|e-commerce|marketplace|bank|telecom|software|retail)\b",
        re.I,
    )

    out = []
    seen_titles = set()
    try:
        for q in queries:
            if not q:
                continue
            search = requests.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "opensearch",
                    "search": q,
                    "limit": 5,
                    "namespace": 0,
                    "format": "json",
                },
                headers=headers,
                timeout=8,
            )
            titles = []
            if search.status_code == 200:
                data = search.json()
                titles = list(data[1] or []) if isinstance(data, list) and len(data) > 1 else []
            for title in titles[:3]:
                if title in seen_titles:
                    continue
                seen_titles.add(title)
                tq = urllib.parse.quote(title.replace(" ", "_"))
                resp = requests.get(
                    f"https://en.wikipedia.org/api/rest_v1/page/summary/{tq}",
                    headers=headers,
                    timeout=8,
                )
                if resp.status_code != 200:
                    continue
                body = resp.json()
                if body.get("type") == "disambiguation":
                    continue
                extract = (body.get("extract") or "").strip()
                url = ((body.get("content_urls") or {}).get("desktop") or {}).get("page") or ""
                if not url:
                    url = f"https://en.wikipedia.org/wiki/{tq}"
                desc = (body.get("description") or "").strip()
                content = f"{desc}. {extract}".strip(". ")
                blob = f"{title} {content} {url}".lower()
                if reject_re.search(blob):
                    continue
                brand_l = brand.lower().rstrip("s'")
                if brand_l not in blob and brand.lower() not in blob:
                    if not root or root not in blob.replace("-", ""):
                        continue
                # Prefer pages that look like companies
                if not company_hint_re.search(content) and "inc" not in blob and "pvt" not in blob:
                    continue
                out.append({
                    "title": body.get("title") or title,
                    "url": url,
                    "domain": "en.wikipedia.org",
                    "source_family": SOURCE_REFERENCE,
                    "content": content[:3000],
                })
                if out:
                    return out
    except Exception:
        return out
    return out


def normalize_cin(cin: str) -> str:
    """Normalize Indian CIN to uppercase alphanumerics."""
    raw = re.sub(r"[^A-Za-z0-9]", "", (cin or "").strip()).upper()
    if re.fullmatch(r"[UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}", raw):
        return raw
    return raw if len(raw) >= 16 else ""


def year_from_cin(cin: str) -> str | None:
    n = normalize_cin(cin)
    # Indian CIN: [UL] + 5 digits + 2 state letters + 4-digit year + ...
    if not n or len(n) < 12:
        return None
    yr = n[8:12]
    if re.fullmatch(r"(19|20)\d{2}", yr):
        return yr
    return None


def zauba_lookup_by_cin(cin: str) -> list[dict]:
    """Fetch registry page for a CIN via Jina (OpenCorporates / Zauba) for legal name."""
    n = normalize_cin(cin)
    if not n:
        return []

    urls = [
        f"https://opencorporates.com/companies/in/{n}",
        f"https://www.zaubacorp.com/companyid.php?companyid={n}",
    ]
    out = []
    try:
        from jina_client import jina_read

        for url in urls:
            data = None
            if getattr(config, "JINA_API_KEY", ""):
                data = jina_read(url, timeout=getattr(config, "JINA_TIMEOUT", 20))
            text = (data.get("text") or "") if data else ""
            page_url = (data.get("url") if data else None) or url
            title = (data.get("title") or "") if data else ""

            # HTTP fallback if Jina empty
            if not text:
                import requests
                headers = {"User-Agent": getattr(config, "USER_AGENT", "CompanyProfileBot/1.0")}
                resp = requests.get(url, headers=headers, timeout=8, allow_redirects=True)
                if resp.status_code >= 400 or not resp.text:
                    continue
                text = resp.text
                page_url = resp.url or url
                title_m = re.search(r"<title>([^<]{5,160})</title>", text, re.I)
                title = re.sub(r"\s+", " ", (title_m.group(1) if title_m else "")).strip()

            if n not in text.upper() and n not in (page_url or "").upper():
                # Still accept OpenCorporates pages that resolve by CIN in URL
                if f"/in/{n}" not in (page_url or "") and n not in (page_url or ""):
                    continue

            title = re.sub(r"\s*[-|:].*$", "", title).strip() or f"CIN {n}"
            # Markdown H1
            h1 = re.search(r"^#\s+(.+)$", text, re.M)
            if h1:
                title = re.sub(r"\s+", " ", h1.group(1)).strip() or title
            name_m = _LEGAL_NAME_RE.search(f"{title}\n{text[:6000]}")
            legal = name_m.group(1).strip() if name_m else (
                title if _looks_legal(title) else None
            )
            if legal and re.search(r"haproxy|challenge|access denied|just a moment|cloudflare", legal, re.I):
                legal = None
            if title and re.search(r"haproxy|challenge|access denied|just a moment|cloudflare", title, re.I):
                title = f"CIN {n}"
                if not text or "haproxy" in text.lower()[:200]:
                    continue
            addr = _parse_registered_address(text[:8000])
            if not legal and not addr and "Legal name:" not in " | ".join([]):
                # No usable registry payload
                if "opencorporates" in (page_url or "") and "HAProxy" in text:
                    continue
            content_parts = [f"CIN: {n}"]
            if legal:
                content_parts.append(f"Legal name: {legal}")
            if addr:
                content_parts.append(f"Registered address: {addr}")
            yr = year_from_cin(n)
            if yr:
                content_parts.append(f"Incorporation year: {yr}")
            out.append({
                "title": legal or title,
                "url": page_url,
                "domain": _domain(page_url) or "registry",
                "source_family": SOURCE_REGISTRY,
                "content": " | ".join(content_parts)[:3000],
                "cin": n,
                "official_name": legal,
                "registered_address": addr,
                "year_founded": yr,
            })
            if out:
                return out
    except Exception:
        return out
    return out


def jina_search_legal_entity(company_name: str, cin: str = "") -> list[dict]:
    """Use Jina Search to find Indian legal entity / CIN evidence."""
    import requests
    import urllib.parse

    brand = (company_name or "").strip()
    cin_n = normalize_cin(cin)
    key = getattr(config, "JINA_API_KEY", "") or ""
    if not brand or not key:
        return []

    queries = [
        f'"{brand}" ("Private Limited" OR "Pvt Ltd" OR Limited) CIN India',
        f'"{brand}" registered company OR legal entity India',
    ]
    if cin_n:
        queries.insert(0, f'"{brand}" "{cin_n}"')

    headers = {
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "User-Agent": getattr(config, "USER_AGENT", "CompanyProfileBot/1.0"),
    }
    out = []
    try:
        for q in queries:
            url = f"https://s.jina.ai/{urllib.parse.quote(q)}"
            resp = requests.get(url, headers=headers, timeout=12)
            if resp.status_code >= 400:
                continue
            ctype = (resp.headers.get("content-type") or "").lower()
            body = resp.json() if "application/json" in ctype else {}
            items = body.get("data") if isinstance(body, dict) else None
            if not isinstance(items, list):
                continue
            for it in items[:8]:
                title = (it.get("title") or "").strip()
                link = (it.get("url") or "").strip()
                content = (it.get("content") or it.get("description") or "").strip()
                blob = f"{title}\n{link}\n{content}"
                if re.search(r"haproxy|just a moment|security verification|captcha", blob, re.I):
                    continue
                cin_found = None
                cm = re.search(r"([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})", blob, re.I)
                if cm:
                    cin_found = cm.group(1).upper()
                name_m = _LEGAL_NAME_RE.search(blob)
                legal = name_m.group(1).strip() if name_m else None
                slug = re.search(
                    r"zaubacorp\.com/(?:company/)?([A-Z0-9][A-Z0-9\-]{5,160})",
                    link, re.I,
                )
                if slug and not legal:
                    slug_name = slug.group(1)
                    slug_name = re.sub(
                        r"[-_]?[UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$",
                        "", slug_name, flags=re.I,
                    )
                    guess = re.sub(r"[-_]+", " ", slug_name).strip()
                    if guess and (
                        _looks_legal(guess)
                        or re.search(r"\b(limited|ltd|private)\b", guess, re.I)
                    ):
                        legal = re.sub(r"\s+", " ", guess).strip().title()
                if not legal and not cin_found:
                    continue
                brand_l = brand.lower()
                if (
                    brand_l not in blob.lower()
                    and brand_l.replace(" ", "") not in link.lower()
                    and not (cin_n and cin_found and cin_found == cin_n)
                ):
                    continue
                yr = year_from_cin(cin_found or cin_n or "")
                out.append({
                    "title": legal or title,
                    "url": link,
                    "domain": _domain(link) or "search",
                    "source_family": SOURCE_REGISTRY,
                    "content": (
                        f"Legal name: {legal or 'unknown'} | "
                        f"CIN: {cin_found or cin_n or 'unknown'}"
                        + (f" | Year: {yr}" if yr else "")
                    )[:3000],
                    "cin": cin_found or cin_n or None,
                    "official_name": legal,
                    "registered_address": None,
                    "year_founded": yr,
                })
            if out:
                break
    except Exception:
        return out
    return out[:5]


def _google_news_rss(query: str, *, max_items: int = 12) -> list[dict]:
    """Google News RSS for an arbitrary query string."""
    import requests
    import urllib.parse
    import xml.etree.ElementTree as ET

    q_raw = (query or "").strip()
    if not q_raw:
        return []
    q = urllib.parse.quote(q_raw)
    url = f"https://news.google.com/rss/search?q={q}&hl=en-IN&gl=IN&ceid=IN:en"
    headers = {"User-Agent": getattr(config, "USER_AGENT", "CompanyProfileBot/1.0")}
    out = []
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code != 200 or not resp.text:
            return []
        root_xml = ET.fromstring(resp.text)
        for item in root_xml.findall("./channel/item")[:max_items]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            desc = (item.findtext("description") or "").strip()
            pub = (item.findtext("pubDate") or "").strip()
            desc = re.sub(r"<[^>]+>", " ", desc)
            desc = re.sub(r"\s+", " ", desc).strip()
            if not title:
                continue
            out.append({
                "title": title,
                "url": link,
                "snippet": desc[:600],
                "source": _domain(link) or "news.google.com",
                "date": pub,
            })
    except Exception:
        return out
    return out


def fetch_news_coverage(
    company_name: str,
    domain: str = "",
    cin: str = "",
    *,
    max_total: int = 16,
) -> list[dict]:
    """Fetch news that must include the brand (quoted). Domain/CIN only as boosters."""
    brand = (company_name or "").strip()
    cin_n = normalize_cin(cin)
    if not brand:
        return []
    queries = [
        f'"{brand}"',
        f'"{brand}" company OR startup OR business',
    ]
    # Require brand + India for regional precision
    queries.append(f'"{brand}" India')
    if cin_n:
        # Never query CIN alone — too easy to pull unrelated registry noise
        queries.append(f'"{brand}" "{cin_n}"')
    if domain:
        # Domain only together with brand
        queries.append(f'"{brand}" {domain}')

    seen, out = set(), []
    for q in queries:
        for h in _google_news_rss(q, max_items=10):
            key = (h.get("url") or "") + "|" + (h.get("title") or "")
            if key in seen:
                continue
            seen.add(key)
            out.append(h)
            if len(out) >= max_total:
                return out
    return out


def _trustpilot_probe(domain: str) -> list[dict]:
    """Direct Trustpilot page probe."""
    import requests

    if not domain:
        return []
    url = f"https://www.trustpilot.com/review/{domain}"
    headers = {"User-Agent": getattr(config, "USER_AGENT", "CompanyProfileBot/1.0")}
    try:
        resp = requests.get(url, headers=headers, timeout=8, allow_redirects=True)
        if resp.status_code >= 400 or not resp.text:
            return []
        text = resp.text
        rating = None
        m = re.search(r'"ratingValue"\s*:\s*"?([0-9.]+)"?', text)
        if m:
            rating = m.group(1)
        count = None
        m2 = re.search(r'"reviewCount"\s*:\s*"?([0-9]+)"?', text)
        if m2:
            count = m2.group(1)
        if not rating and "Trustpilot" not in text[:2000]:
            return []
        snippet = f"Trustpilot rating {rating}/5" if rating else "Trustpilot company review page"
        if count:
            snippet += f" from {count} reviews"
        return [{
            "title": f"Trustpilot reviews — {domain}",
            "url": url,
            "snippet": snippet,
            "source": "trustpilot.com",
            "source_family": SOURCE_REVIEW,
            "content": snippet,
        }]
    except Exception:
        return []


def accurate_research_bundle(
    company_name: str,
    domain: str = "",
    cin: str = "",
) -> dict:
    """Evidence pack: Wikipedia (+ Zauba via CIN), News RSS, Trustpilot.

    News queries use brand name, domain, and optional CIN.
    """
    import concurrent.futures

    brand = (company_name or "").strip()
    cin_n = normalize_cin(cin)
    bundle = {
        "identity_evidence": [],
        "news_hits": [],
        "review_hits": [],
        "competitor_hits": [],
    }
    lane_timeout = float(getattr(config, "RESEARCH_TIMEOUT", 20)) + 35

    def _identity():
        # Cap each lane independently; shutdown(wait=False) so a hung Jina
        # search cannot block return of Wikipedia / known registry results.
        import concurrent.futures

        known = known_identity_evidence(brand, cin_n)
        wiki: list[dict] = []
        registry: list[dict] = []
        searched: list[dict] = []
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)
        try:
            f_wiki = pool.submit(_wiki_identity, brand, domain)
            f_reg = pool.submit(zauba_lookup_by_cin, cin_n) if cin_n else None
            f_search = pool.submit(jina_search_legal_entity, brand, cin_n)
            try:
                wiki = (f_wiki.result(timeout=12) or [])[:8]
            except Exception:
                wiki = []
            if f_reg is not None:
                try:
                    registry = f_reg.result(timeout=8) or []
                except Exception:
                    registry = []
            try:
                searched = f_search.result(timeout=14) or []
            except Exception:
                searched = []
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

        merged, seen = [], set()
        # Live registry/search first, then wiki, then known cache as floor
        for e in registry + searched + wiki + known:
            key = (e.get("url") or "") + "|" + (e.get("title") or "") + "|" + (
                e.get("official_name") or ""
            )
            if key in seen:
                continue
            seen.add(key)
            merged.append(e)
        return merged[:12]

    def _news():
        return fetch_news_coverage(brand, domain=domain, cin=cin_n, max_total=16)

    def _reviews():
        return _trustpilot_probe(domain)[:8]

    def _competitors():
        rss = _google_news_rss(f'"{brand}" competitors') if brand else []
        rss2 = _google_news_rss(f'"{brand}" vs OR alternatives India') if brand else []
        seen, out = set(), []
        for h in rss + rss2:
            url = h.get("url") or ""
            if url and url in seen:
                continue
            if url:
                seen.add(url)
            out.append({
                **h,
                "source_family": "discovery",
            })
        return out[:12]

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
    try:
        f_id = pool.submit(_identity)
        f_news = pool.submit(_news)
        f_rev = pool.submit(_reviews)
        f_comp = pool.submit(_competitors)
        for key, fut in (
            ("identity_evidence", f_id),
            ("news_hits", f_news),
            ("review_hits", f_rev),
            ("competitor_hits", f_comp),
        ):
            try:
                bundle[key] = fut.result(timeout=lane_timeout) or []
            except Exception:
                bundle[key] = []
        # Floor: if identity lane timed out empty, still seed known CIN/brand
        if not bundle["identity_evidence"]:
            bundle["identity_evidence"] = known_identity_evidence(brand, cin_n)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return bundle


def fast_research_bundle(company_name: str, domain: str = "", cin: str = "") -> dict:
    """Alias — accuracy path is the default."""
    return accurate_research_bundle(company_name, domain, cin=cin)
