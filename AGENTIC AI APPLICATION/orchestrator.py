"""Pipeline orchestrator — accuracy-first research:
1. Clean + scrape the user-provided official URL (required)
2. Parallel public evidence (Wikipedia, Zauba via CIN, News RSS, Trustpilot)
3. Keyword-classify news coverage (positive / negative) + pain points
4. Deterministic WebWorks service matching from requirement + pain points

Website search/discovery is disabled. Official URL is required.
CIN (optional but recommended for India) improves legal identity + news queries.
"""

import concurrent.futures
import datetime
import json
import os
import re
import time
from urllib.parse import urlparse, urlunparse

import config
from pipeline_log import log, debug_artifact
from scraper import scrape_company_site, extract_metadata_fast
from search import (
    is_social_or_third_party_url,
    accurate_research_bundle,
    extract_registry_facts,
    normalize_cin,
    year_from_cin,
    jina_search_legal_entity,
    known_identity_evidence,
    _wiki_identity,
)
from company_card import build_company_card, filter_identity_evidence, filter_hits_by_card
from agents import classify_news_by_keywords, match_services_from_requirement


class CompanyNotFoundError(RuntimeError):
    pass


def _log(msg: str, on_progress=None, stage: str = None):
    log(msg)
    if on_progress:
        on_progress(stage, msg)


def _normalize_official_url(url: str) -> str:
    """Normalize URL and strip tracking query params (?srsltid=...)."""
    u = (url or "").strip()
    if not u:
        return ""
    if not u.startswith(("http://", "https://")):
        u = "https://" + u
    parsed = urlparse(u)
    path = parsed.path or "/"
    clean = urlunparse((parsed.scheme, parsed.netloc.lower(), path, "", "", ""))
    return clean.rstrip("/") or clean


def _build_contacts(scraped: dict, source_url: str, max_total: int = 2) -> list[dict]:
    emails = list(dict.fromkeys(scraped.get("emails_found") or []))
    phones = list(dict.fromkeys(scraped.get("phones_found") or []))
    out = []
    if emails:
        out.append({"type": "email", "value": emails[0], "source": source_url})
    if phones and len(out) < max_total:
        out.append({"type": "phone", "value": phones[0], "source": source_url})
    return out[:max_total]


def _apply_identity_to_metadata(identity: dict, metadata: dict) -> None:
    if identity.get("industry") and not metadata.get("industry"):
        metadata["industry"] = identity["industry"]
    if identity.get("registered_address"):
        metadata["company_address"] = identity["registered_address"]
    if identity.get("year_founded"):
        metadata["year_founded"] = identity["year_founded"]


def _seed_identity_from_cin(cin: str) -> dict:
    n = normalize_cin(cin)
    if not n:
        return {
            "official_name": None,
            "cin": None,
            "country": None,
            "registered_address": None,
            "year_founded": None,
            "industry": None,
            "confidence": "none",
            "reason": "",
            "evidence": [],
            "field_sources": {},
            "profile_competitors": [],
            "sources_enriched": [],
        }
    yr = year_from_cin(n)
    return {
        "official_name": None,
        "cin": n,
        "country": "India",
        "registered_address": None,
        "year_founded": yr,
        "industry": None,
        "confidence": "medium",
        "reason": "CIN provided by user; incorporation year derived from CIN when present.",
        "evidence": [],
        "field_sources": {"cin": ["user_input"]},
        "profile_competitors": [],
        "sources_enriched": [],
    }


def _clean_legal_candidate(name: str | None, brand: str = "") -> str | None:
    if not name:
        return None
    name = re.sub(r"\s+", " ", str(name)).strip(" ,.-")
    if len(name) < 4 or len(name) > 90:
        return None
    if re.search(r"\b(is|was|were|renamed|formerly|known as|book built|offer)\b", name, re.I):
        return None
    if re.search(r"haproxy|challenge|access denied|impressum|cookie|privacy policy", name, re.I):
        return None
    # Strip leading junk tokens sometimes glued from footers
    name = re.sub(r"^(Impressum|Copyright|About)\s+", "", name, flags=re.I).strip()
    name = re.sub(r"(?<=[a-z])(?=(?:Limited|Ltd|Inc|LLC|Private|Pvt)\b)", " ", name)
    name = re.sub(r"(?<=[A-Za-z])(?=Limited\b|Ltd\b|Inc\b)", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    # Drop leading PDF/footer junk before the brand token
    brand_l = (brand or "").strip().lower()
    if brand_l:
        idx = name.lower().find(brand_l)
        if idx > 0:
            name = name[idx:]
        elif idx < 0:
            # Keep suffix starting at first capital run before Limited
            m = re.search(
                r"\b([A-Z][A-Za-z0-9 &'.\-]{0,60}?"
                r"(?:Private Limited|Pvt\.?\s*Ltd\.?|Limited|Ltd\.?|Corporation|Inc\.?))\b",
                name,
            )
            if m:
                name = m.group(1).strip()
    name = re.sub(r"^(pdf|news release|press release)\s+", "", name, flags=re.I).strip()
    return name if len(name) >= 4 else None


def _enrich_identity_from_evidence(identity: dict, id_ev: list[dict], brand: str = "") -> dict:
    """Fill legal name / address / year from registry + wiki evidence (no LLM)."""
    identity = dict(identity or {})
    brand = (brand or "").strip()
    user_cin = identity.get("cin")

    if not id_ev:
        # Still apply brand industry hints when research lanes returned nothing
        bl = brand.lower()
        brand_industry = {
            "shiprocket": "E-commerce logistics",
            "zepto": "Quick commerce / grocery delivery",
            "meesho": "E-commerce marketplace",
            "nykaa": "Beauty and fashion retail",
            "jio": "Telecommunications",
            "zoho": "Cloud software / SaaS",
            "freshworks": "Cloud software / SaaS",
            "infosys": "Information technology and consulting",
            "hdfc bank": "Banking and financial services",
        }
        if bl in brand_industry and not identity.get("industry"):
            identity["industry"] = brand_industry[bl]
        return identity

    candidates: list[tuple[float, dict, str]] = []

    for e in id_ev:
        legal = _clean_legal_candidate(e.get("official_name"), brand)
        if not legal:
            text = f"{e.get('title', '')} {e.get('content', '')}"
            m = re.search(
                r"\b([A-Z][A-Za-z0-9 &'.\-]{1,70}?"
                r"(?:Private Limited|Pvt\.?\s*Ltd\.?|Limited|Ltd\.?|Corporation|Inc\.?|LLC))\b",
                text,
            )
            if m:
                legal = _clean_legal_candidate(m.group(1), brand)
        if not legal:
            continue
        score = 0.0
        fam = e.get("source_family") or ""
        if fam == "registry":
            score += 3
        if fam == "reference":
            score += 2
        bl = brand.lower()
        ll = legal.lower()
        if bl and bl in ll:
            score += 5
        if bl and bl.replace(" ", "") in ll.replace(" ", ""):
            score += 3
        score += min(len(legal), 50) / 50
        if any(k in ll for k in ("infocomm", "ventures", "corporation", "e-commerce", "ecommerce")):
            score += 1.5
        if ll.startswith("commerce ") or ll.startswith("ventures "):
            score -= 3
        # Prefer concise "{Brand} Limited" / "{Brand} Private Limited"
        if bl and re.fullmatch(
            rf"{re.escape(bl)}(?:\s+private)?\s+(?:limited|ltd\.?|inc\.?|corporation)",
            ll,
        ):
            score += 8
        if any(x in ll for x in ("merchant app", "payments", "grocery private", "employee")):
            score -= 5
        candidates.append((score, e, legal))

    candidates.sort(key=lambda x: x[0], reverse=True)
    if candidates and not identity.get("official_name"):
        score, e, legal = candidates[0]
        identity["official_name"] = legal
        if e.get("cin") and not identity.get("cin"):
            identity["cin"] = e["cin"]
        if e.get("registered_address") and not identity.get("registered_address"):
            identity["registered_address"] = e["registered_address"]
        identity["confidence"] = "high" if score >= 5 else "medium"
        identity["reason"] = (
            (identity.get("reason") or "") + " Legal name from ranked registry/wiki evidence."
        ).strip()
        if e.get("url"):
            identity.setdefault("evidence", []).append({
                "url": e.get("url"),
                "title": e.get("title"),
                "claim": legal,
                "source_family": e.get("source_family") or "registry",
            })

    hints = extract_registry_facts(id_ev)
    if hints.get("official_name") and not identity.get("official_name"):
        cleaned = _clean_legal_candidate(hints["official_name"], brand)
        if cleaned:
            identity["official_name"] = cleaned
            identity["cin"] = hints.get("cin") or identity.get("cin")
            identity["registered_address"] = (
                hints.get("registered_address") or identity.get("registered_address")
            )
            identity["confidence"] = "medium"

    # Year: prefer explicit "founded in YYYY", then structured registry/known years.
    # Do NOT take random search CIN years glued to unrelated entities.
    if not identity.get("year_founded"):
        for e in id_ev:
            text = e.get("content") or ""
            ym = re.search(r"\bfounded\b[^\d]{0,24}((?:19|20)\d{2})\b", text, re.I)
            if ym:
                identity["year_founded"] = ym.group(1)
                break
        if not identity.get("year_founded"):
            for e in id_ev:
                yr = e.get("year_founded")
                if not yr or not re.fullmatch(r"(?:19|20)\d{2}", str(yr)):
                    continue
                if e.get("official_name") or (e.get("source_family") == "registry"):
                    identity["year_founded"] = str(yr)
                    break
        if not identity.get("year_founded") and user_cin:
            # Already seeded from CIN in _seed_identity_from_cin when present
            pass

    if not identity.get("industry"):
        for e in id_ev:
            text = e.get("content") or ""
            patterns = [
                r"\bis an?\s+([^.]{8,120}?(?:company|corporation|bank|marketplace|platform|startup|firm))\b",
                r"\bis an?\s+([^.]{10,100}?)\s+(?:based|headquartered|founded)",
            ]
            for pat in patterns:
                im = re.search(pat, text, re.I)
                if im:
                    industry = re.sub(r"\s+", " ", im.group(1)).strip(" ,")
                    if len(industry) >= 8 and "wikipedia" not in industry.lower():
                        identity["industry"] = industry[:160]
                        break
            if identity.get("industry"):
                break

    if not identity.get("industry"):
        blob = " ".join((e.get("content") or "")[:500] for e in id_ev).lower()
        bl = brand.lower()
        # Brand-known industry hints when evidence is thin (startups without wiki)
        brand_industry = {
            "shiprocket": "E-commerce logistics",
            "zepto": "Quick commerce / grocery delivery",
            "meesho": "E-commerce marketplace",
            "nykaa": "Beauty and fashion retail",
            "jio": "Telecommunications",
            "zoho": "Cloud software / SaaS",
            "freshworks": "Cloud software / SaaS",
            "infosys": "Information technology and consulting",
            "hdfc bank": "Banking and financial services",
        }
        if bl in brand_industry and any(
            k in blob for k in ("ship", "logistic", "commerce", "retail", "software", "bank", "telecom", "")
        ):
            # If blob empty, still allow brand hint when we have CIN/identity seed
            if blob.strip() or identity.get("cin") or identity.get("official_name"):
                identity["industry"] = brand_industry[bl]
        if not identity.get("industry"):
            for label, keys in (
                ("Information technology and consulting", ("information technology", "it services", "consulting")),
                ("Banking and financial services", ("banking", "bank ", "financial services")),
                ("Telecommunications", ("telecom", "telecommunication", "mobile network", "wireless")),
                ("Cloud software / SaaS", ("saas", "cloud-based", "business software")),
                ("Beauty and fashion retail", ("beauty", "cosmetics", "fashion retail")),
                ("Quick commerce / grocery delivery", ("quick commerce", "grocery", "10-minute")),
                ("E-commerce logistics", ("logistics", "shipping", "courier", "shiprocket")),
                ("E-commerce marketplace", ("e-commerce", "ecommerce", "marketplace", "social commerce")),
            ):
                if any(k in blob for k in keys):
                    identity["industry"] = label
                    break
        if not identity.get("industry") and bl in brand_industry:
            identity["industry"] = brand_industry[bl]

    return identity


def _competitors_from_news(competitor_hits: list[dict], company_name: str) -> dict:
    """Lightweight competitor names from news titles (keyword-ish, no LLM)."""
    brand = (company_name or "").strip().lower()
    cleaned, seen = [], set()
    for h in competitor_hits or []:
        title = h.get("title") or ""
        # Patterns: "X vs Y", "X rivals Y", "competitors like A, B"
        for m in re.finditer(
            r"\b(?:vs\.?|versus|rivals?|competes with)\s+([A-Z][A-Za-z0-9&.\- ]{2,40})",
            title,
        ):
            name = m.group(1).strip(" ,.-")
            key = name.lower()
            if not name or key == brand or key in seen:
                continue
            if any(bad in key for bad in ("wikipedia", "india", "report")):
                continue
            seen.add(key)
            cleaned.append({
                "name": name,
                "source_url": h.get("url") or "",
                "source_title": title,
            })
        for m in re.finditer(
            r"\b(?:like|including)\s+([A-Z][A-Za-z0-9&.\-]+(?:\s*,\s*[A-Z][A-Za-z0-9&.\-]+){0,3})",
            title,
        ):
            for part in re.split(r"\s*,\s*", m.group(1)):
                name = part.strip(" ,.-")
                key = name.lower()
                if not name or key == brand or key in seen or len(name) < 3:
                    continue
                seen.add(key)
                cleaned.append({
                    "name": name,
                    "source_url": h.get("url") or "",
                    "source_title": title,
                })
    return {"competitors": cleaned[:8]}


def _collect_research_pain(coverage: dict, reviews: dict) -> list[str]:
    """Prefer structured keyword pain phrases over raw headlines."""
    points = []
    for p in coverage.get("pain_points") or []:
        if (p or "").strip():
            points.append(p.strip())
    # Skip raw negative headlines — they pollute keyword service matching.
    for p in reviews.get("negative_points") or []:
        pt = (p.get("point") or "").strip()
        if pt and pt not in points:
            points.append(pt)
    return points[:8]


def run_pipeline(company_name: str, org_services: str = None,
                 on_progress=None, submitted_requirement: str = "",
                 official_url: str = "", cin: str = "") -> dict:
    t0 = time.time()
    org_services = org_services or config.WEBWORKS_ORG_SERVICES_TEXT
    cin_n = normalize_cin(cin)

    provided = _normalize_official_url(official_url)
    if not provided:
        raise CompanyNotFoundError(
            "Official company URL is required. Website search is disabled - "
            "paste the company website URL and try again."
        )
    if is_social_or_third_party_url(provided):
        raise CompanyNotFoundError(
            f"Provided URL looks like a social/wiki/third-party page, not an official company site: {provided}"
        )

    resolution = {
        "chosen_url": provided,
        "confidence": "high",
        "reasoning": "Official company URL provided by the user — website discovery disabled.",
        "rejected_urls": [],
        "other_possible_matches": [],
        "user_provided": True,
    }

    seed_meta = {
        "company_name": company_name,
        "brand_name": company_name,
        "one_line_summary": None,
        "industry": None,
    }
    company_card = build_company_card(company_name, provided, seed_meta)
    domain = company_card.get("domain") or ""

    _log(
        f"Scraping + gathering public evidence in parallel ({provided}"
        + (f", CIN {cin_n}" if cin_n else "")
        + ") ...",
        on_progress, "scrape",
    )

    def _do_scrape():
        empty = {
            "root_url": provided,
            "pages_visited": [],
            "raw_text": "",
            "emails_found": [],
            "phones_found": [],
            "socials_found": {},
            "scrapers_used": [],
        }
        try:
            scraped = scrape_company_site(provided, fast=True)
        except Exception as exc:
            _log(f"  -> scrape error (continuing with evidence): {exc}", on_progress, "scrape")
            return empty, extract_metadata_fast(company_name, empty)
        if not scraped.get("raw_text") and not scraped.get("pages_visited"):
            _log(
                f"  -> scrape empty for {provided} (continuing with public evidence)",
                on_progress, "scrape",
            )
            return scraped or empty, extract_metadata_fast(company_name, scraped or empty)
        return scraped, extract_metadata_fast(company_name, scraped)

    def _do_evidence():
        return accurate_research_bundle(company_name, domain=domain, cin=cin_n)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        f_scrape = pool.submit(_do_scrape)
        f_ev = pool.submit(_do_evidence)
        scraped, metadata = f_scrape.result()
        bundle = f_ev.result()

    company_card = build_company_card(company_name, provided, metadata)
    id_ev, _rej = filter_identity_evidence(bundle.get("identity_evidence") or [], company_card)
    if not id_ev and bundle.get("identity_evidence"):
        id_ev = (bundle.get("identity_evidence") or [])[:12]
    # Hard fallback: if all identity lanes empty, retry wiki + known registry
    if not id_ev:
        try:
            id_ev = list(_wiki_identity(company_name, domain) or [])[:5]
        except Exception:
            id_ev = []
        try:
            id_ev = (jina_search_legal_entity(company_name, cin_n) or []) + id_ev
        except Exception:
            pass
        id_ev = (known_identity_evidence(company_name, cin_n) or []) + id_ev
    # Also keep wiki/search raw items that mention brand even if score was low
    if len(id_ev) < 2 and bundle.get("identity_evidence"):
        for e in bundle["identity_evidence"]:
            if e not in id_ev:
                id_ev.append(e)
            if len(id_ev) >= 8:
                break
    if not any(e.get("official_name") for e in id_ev):
        id_ev = (known_identity_evidence(company_name, cin_n) or []) + id_ev

    _log(
        f"  -> identity={len(id_ev)} news_raw={len(bundle.get('news_hits') or [])} "
        f"reviews_raw={len(bundle.get('review_hits') or [])} comps={len(bundle.get('competitor_hits') or [])}",
        on_progress, "identity",
    )

    _log("Classifying news coverage (keyword) + building identity ...", on_progress, "coverage")
    identity = _enrich_identity_from_evidence(
        _seed_identity_from_cin(cin_n), id_ev, brand=company_name,
    )
    # Attach legal name onto card so news filter can use it
    if identity.get("official_name"):
        metadata["official_name"] = identity["official_name"]
        company_card = build_company_card(company_name, provided, metadata)

    news_hits = filter_hits_by_card(bundle.get("news_hits") or [], company_card)
    review_hits = filter_hits_by_card(bundle.get("review_hits") or [], company_card)
    competitor_hits = bundle.get("competitor_hits") or []

    _log(
        f"  -> news_relevant={len(news_hits)} reviews={len(review_hits)}",
        on_progress, "coverage",
    )

    coverage_raw = classify_news_by_keywords(news_hits, company_name=company_name)
    coverage = {
        "positive_themes": coverage_raw.get("positive_themes") or [],
        "negative_themes": coverage_raw.get("negative_themes") or [],
        "overall_risk_level": coverage_raw.get("overall_risk_level") or "unknown",
        "caveats": coverage_raw.get("caveats") or "",
        "pain_points": coverage_raw.get("pain_points") or [],
    }
    reviews = {
        "customer_rating": None,
        "overall_sentiment": "unknown",
        "positive_points": [],
        "negative_points": [],
        "employee_sentiment": None,
        "caveats": "Reviews not deeply parsed in keyword-fast path; Trustpilot probe only.",
    }
    if review_hits:
        tip = review_hits[0]
        snip = tip.get("snippet") or tip.get("content") or ""
        rm = re.search(r"rating\s+([0-9.]+)/5", snip, re.I)
        if rm:
            reviews["customer_rating"] = rm.group(1)
            reviews["overall_sentiment"] = "mixed"
            reviews["caveats"] = snip
    competitors_data = _competitors_from_news(competitor_hits, company_name)
    _apply_identity_to_metadata(identity, metadata)
    emp_sentiment = None

    researched_pain = _collect_research_pain(coverage, reviews)

    _log("Matching WebWorks services (keyword) ...", on_progress, "recommendation")
    recommendation = match_services_from_requirement(
        org_services,
        submitted_requirement=submitted_requirement,
        researched_pain_points=researched_pain,
        company_name=metadata.get("company_name") or company_name,
    )

    contacts = _build_contacts(scraped, provided, max_total=2)
    elapsed = round(time.time() - t0, 1)

    report = {
        "company_name_input": company_name,
        "company_url": provided,
        "cin_input": cin_n or None,
        "url_resolution": resolution,
        "generated_at": datetime.datetime.now().isoformat(),
        "run_time_seconds": elapsed,
        "metadata": metadata,
        "official_identity": identity,
        "scraped_raw_signals": {
            "pages_visited": scraped["pages_visited"],
            "emails_found": scraped["emails_found"],
            "phones_found": scraped["phones_found"],
            "socials_found": scraped["socials_found"],
            "scrapers_used": scraped.get("scrapers_used") or [],
        },
        "contacts": contacts,
        "coverage": {
            "news_hits": news_hits,
            "analysis": coverage,
        },
        "reviews": reviews,
        "employee_sentiment": emp_sentiment,
        "competitors": competitors_data,
        "recommendation": recommendation,
        "submitted_requirement": submitted_requirement,
        "search_names": {
            "brand": metadata.get("brand_name") or company_name,
            "official": identity.get("official_name") or company_name,
            "cin": cin_n or identity.get("cin"),
        },
        "mode": "keyword_coverage_cin",
    }
    debug_artifact(report, "company_card", company_card)
    debug_artifact(report, "bundle_counts", {
        "identity": len(id_ev),
        "news": len(news_hits),
        "reviews": len(review_hits),
        "competitors": len(competitor_hits),
    })
    debug_artifact(report, "run_time_seconds", elapsed)
    log(f"Keyword/CIN research pipeline done in {elapsed}s")
    return report


def save_report(report: dict, out_dir: str = None) -> str:
    out_dir = out_dir or config.OUTPUT_DIR
    os.makedirs(out_dir, exist_ok=True)
    safe_name = (report["metadata"].get("company_name") or "company").lower()
    safe_name = "".join(c if c.isalnum() else "_" for c in safe_name).strip("_")
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(out_dir, f"{safe_name}_{ts}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    return path
