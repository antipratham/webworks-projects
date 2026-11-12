"""Canonical company anchor + cross-section checks and balances."""
from __future__ import annotations

import re
from urllib.parse import urlparse

_INACTIVE_RE = re.compile(
    r"\b(struck off|strike[\s-]?off|deadpooled|inactive|dissolved|liquidat\w*|defunct)\b",
    re.I,
)
_UNRELATED_ENTITY_RE = re.compile(
    r"\b(pharmaceutical|terminals|precious metals|non-ferrous|electrical equipment|"
    r"metric prefix|wiktionary)\b",
    re.I,
)
_INDIAN_CITIES = (
    "bengaluru", "bangalore", "mumbai", "delhi", "gurgaon", "gurugram", "hyderabad",
    "pune", "chennai", "kolkata", "noida", "ahmedabad", "halol", "gujarat", "karnataka",
    "maharashtra", "india",
)


def _domain(url: str) -> str:
    try:
        return urlparse(url).netloc.lower().removeprefix("www.")
    except Exception:
        return ""


def _tokens(text: str) -> set[str]:
    return {t for t in re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).split() if len(t) > 2}


def build_company_card(company_name: str, url: str, metadata: dict) -> dict:
    domain = _domain(url)
    brand = (metadata.get("brand_name") or metadata.get("company_name") or company_name).strip()
    industry = (metadata.get("industry") or "").strip()
    summary = (metadata.get("one_line_summary") or "").strip()
    domain_root = domain.split(".")[0] if domain else ""
    legal = (metadata.get("footer_legal_name") or metadata.get("official_name") or "").strip()
    return {
        "input_name": company_name.strip(),
        "brand": brand,
        "legal_name": legal,
        "official_url": url,
        "domain": domain,
        "domain_root": domain_root,
        "industry_hint": industry,
        "summary_hint": summary,
        "brand_tokens": list(_tokens(f"{brand} {company_name} {domain_root}")),
        "industry_tokens": list(_tokens(f"{industry} {summary}")),
    }


def _text_blob(item: dict) -> str:
    return " ".join([
        item.get("title") or "",
        item.get("content") or item.get("snippet") or "",
        item.get("url") or "",
    ]).lower()


def score_identity_evidence(item: dict, card: dict) -> tuple[float, list[str]]:
    text = _text_blob(item)
    score = 0.0
    notes: list[str] = []

    domain = card.get("domain") or ""
    domain_root = card.get("domain_root") or ""
    brand = (card.get("brand") or "").lower()
    brand_tokens = set(card.get("brand_tokens") or [])
    industry_tokens = set(card.get("industry_tokens") or [])

    if domain and domain in text:
        score += 3.0
        notes.append("domain_match")
    if domain_root and domain_root in text.replace("-", ""):
        score += 2.0
        notes.append("domain_root_match")
    if brand and brand in text:
        score += 1.5
        notes.append("brand_match")

    overlap = len(brand_tokens & _tokens(text))
    if overlap >= 2:
        score += min(overlap * 0.4, 2.0)

    if industry_tokens:
        ind_overlap = len(industry_tokens & _tokens(text))
        if ind_overlap >= 1:
            score += min(ind_overlap * 0.5, 2.0)
            notes.append("industry_overlap")

    url = (item.get("url") or "").lower()
    if "wikipedia.org/wiki/metric_prefix" in url or "wiktionary" in url:
        score -= 5.0
        notes.append("reference_noise")
    if _INACTIVE_RE.search(text):
        score -= 4.0
        notes.append("inactive_entity")
    if _UNRELATED_ENTITY_RE.search(text):
        score -= 2.5
        notes.append("unrelated_industry_keyword")

    family = item.get("source_family") or ""
    if family == "official":
        score += 4.0
    elif family == "reference" and "wiki" in url and brand in text:
        score += 2.0

    return score, notes


def filter_identity_evidence(evidence: list[dict], card: dict,
                             min_score: float = 0.5) -> tuple[list[dict], list[dict]]:
    kept, rejected = [], []
    for item in evidence:
        score, notes = score_identity_evidence(item, card)
        item = dict(item)
        item["_relevance_score"] = round(score, 2)
        item["_relevance_notes"] = notes
        if score >= min_score:
            kept.append(item)
        else:
            rejected.append({**item, "reject_reason": "low_relevance_to_company_card"})
    kept.sort(key=lambda e: e.get("_relevance_score", 0), reverse=True)
    return kept, rejected


def mentions_company(text: str, card: dict) -> bool:
    """True only when brand/legal/domain appears as a real token (not loose substring)."""
    blob = (text or "")
    blob_l = blob.lower()
    brand = (card.get("brand") or "").strip()
    input_name = (card.get("input_name") or "").strip()
    domain_root = (card.get("domain_root") or "").strip().lower()
    legal = (card.get("legal_name") or "").strip()

    candidates = [c for c in (brand, input_name, legal) if c and len(c) >= 2]
    for name in candidates:
        # Word-boundary-ish match; allow possessive / punctuation after brand
        pat = re.compile(
            rf"(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])",
            re.I,
        )
        if pat.search(blob):
            return True

    # Domain root only if reasonably distinctive
    if domain_root and len(domain_root) >= 4:
        if re.search(rf"(?<![A-Za-z0-9]){re.escape(domain_root)}(?![A-Za-z0-9])", blob_l):
            return True
    return False


def is_company_primary_in_headline(text: str, card: dict) -> bool:
    """Reject ticker-list / multi-company roundups where brand is not primary."""
    title = (text or "").strip()
    if not title:
        return False
    if not mentions_company(title, card):
        return False
    brand = (card.get("brand") or card.get("input_name") or "").strip()
    if not brand:
        return True
    # Too many other capitalized company-like tokens -> roundup noise
    others = re.findall(r"\b[A-Z][A-Za-z0-9&.\-]{2,}\b", title)
    brand_l = brand.lower()
    foreign = [t for t in others if t.lower() != brand_l and t.lower() not in {
        "ipo", "q1", "q2", "q3", "q4", "ceo", "fda", "nch", "et", "ai", "india",
        "rs", "usd", "sebi", "rbi", "the", "and", "for", "how", "why", "new",
    }]
    # Brand should appear in the first half of the title for primary coverage
    half = title[: max(20, len(title) // 2) + len(brand)]
    if not mentions_company(half, card) and len(foreign) >= 3:
        return False
    if len(foreign) >= 6:
        return False
    return True


def filter_hits_by_card(hits: list[dict], card: dict, text_keys: tuple[str, ...] = ("snippet", "title")) -> list[dict]:
    out = []
    for h in hits:
        blob = " ".join(str(h.get(k) or "") for k in text_keys)
        title = h.get("title") or ""
        if not mentions_company(blob, card):
            continue
        if title and not is_company_primary_in_headline(title, card):
            continue
        out.append(h)
    return out


def audit_field_agreement(card: dict, metadata: dict, identity: dict,
                          coverage: dict, reviews: dict,
                          competitors: dict) -> dict:
    audit_log: list[str] = []
    patched_identity = dict(identity)
    patched_metadata = dict(metadata)
    patched_competitors = dict(competitors)
    patched_reviews = dict(reviews)
    patched_coverage = dict(coverage)

    industry_blob = " ".join([
        card.get("industry_hint") or "",
        card.get("summary_hint") or "",
        identity.get("industry") or "",
        metadata.get("industry") or "",
    ]).lower()

    legal = (identity.get("official_name") or "").upper()
    if legal and _UNRELATED_ENTITY_RE.search(legal):
        if not any(k in industry_blob for k in ("pharma", "drug", "medicine", "terminal")):
            audit_log.append(f"Rejected legal name '{legal}' — unrelated entity keyword vs brand industry.")
            patched_identity["official_name"] = None
            patched_identity["cin"] = None
            patched_identity["confidence"] = "none"

    addr = identity.get("registered_address") or metadata.get("company_address")
    if addr:
        addr_lower = addr.lower()
        if _INACTIVE_RE.search(addr_lower):
            audit_log.append("Rejected address — inactive/struck-off marker in text.")
            patched_identity["registered_address"] = None
            patched_metadata["company_address"] = None
        elif any(k in industry_blob for k in ("india", "e-commerce", "quick", "d2c")):
            if not any(c in addr_lower for c in _INDIAN_CITIES):
                audit_log.append("Rejected address — geography inconsistent with India-focused company card.")
                patched_identity["registered_address"] = None
                patched_metadata["company_address"] = None

    year = identity.get("year_founded") or metadata.get("year_founded")
    if year:
        try:
            y = int(str(year))
            fs = identity.get("field_sources") or {}
            sources = fs.get("year_founded") or []
            if y >= 2024 and len(sources) < 2:
                audit_log.append(
                    f"Downgraded founding year {year} — may be incorporation not brand founding."
                )
                patched_identity["year_founded"] = None
                patched_metadata["year_founded"] = None
        except ValueError:
            pass

    comp_list = list((competitors.get("competitors") or []))
    filtered = []
    for c in comp_list:
        name = (c.get("name") or "").lower()
        if any(bad in name for bad in ("wikipedia", "metric", "lvmh")):
            audit_log.append(f"Removed competitor '{c.get('name')}' — off-topic.")
            continue
        filtered.append(c)
    patched_competitors["competitors"] = filtered

    pos_f = [t for t in (coverage.get("positive_themes") or [])
             if mentions_company(f"{t.get('headline','')} {t.get('fact','')}", card)]
    neg_f = [t for t in (coverage.get("negative_themes") or [])
             if mentions_company(f"{t.get('headline','')} {t.get('fact','')}", card)]
    dropped_news = (len(coverage.get("positive_themes") or []) - len(pos_f)
                    + len(coverage.get("negative_themes") or []) - len(neg_f))
    if dropped_news:
        audit_log.append(f"Filtered {dropped_news} news theme(s) not mentioning target company.")
    patched_coverage["positive_themes"] = pos_f
    patched_coverage["negative_themes"] = neg_f

    pos_rf = [p for p in (reviews.get("positive_points") or [])
              if mentions_company(p.get("point") or "", card)]
    neg_rf = [p for p in (reviews.get("negative_points") or [])
              if mentions_company(p.get("point") or "", card)]
    if len(pos_rf) < len(reviews.get("positive_points") or []) or len(neg_rf) < len(reviews.get("negative_points") or []):
        audit_log.append("Filtered review points not mentioning target company.")
    patched_reviews["positive_points"] = pos_rf
    patched_reviews["negative_points"] = neg_rf

    return {
        "metadata": patched_metadata,
        "identity": patched_identity,
        "coverage": patched_coverage,
        "reviews": patched_reviews,
        "competitors": patched_competitors,
        "audit_log": audit_log,
        "company_card": card,
    }
