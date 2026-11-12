"""Batch verification scored by accuracy vs ground truth (target ≥ 95%)."""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from orchestrator import run_pipeline, save_report
from scraper import _SCRAPE_CACHE
from search import _DDG_CACHE
from company_card import mentions_company, is_company_primary_in_headline, build_company_card

REQUIREMENT = (
    "Better marketing, better creator outreach, improvement in online brand content"
)

ACCURACY_TARGET = 0.95

# Ground truth for India test set — accuracy is measured against these facts.
COMPANIES = [
    {
        "tier": "large",
        "name": "Infosys",
        "url": "https://www.infosys.com",
        "cin": "L85110KA1981PLC013115",
        "expect": {
            "legal_aliases": ["Infosys Limited", "Infosys Ltd", "Infosys Ltd."],
            "year": "1981",
            "industry_keywords": ["technology", "it", "software", "consulting", "outsourcing", "digital"],
            "domain_root": "infosys",
        },
    },
    {
        "tier": "large",
        "name": "HDFC Bank",
        "url": "https://www.hdfcbank.com",
        "cin": "L65920MH1994PLC080618",
        "expect": {
            "legal_aliases": ["HDFC Bank Limited", "HDFC Bank Ltd", "HDFC Bank Ltd."],
            "year": "1994",
            "industry_keywords": ["bank", "banking", "financial", "finance"],
            "domain_root": "hdfcbank",
        },
    },
    {
        "tier": "large",
        "name": "Jio",
        "url": "https://www.jio.com",
        "cin": "U72900GJ2007PLC105869",
        "expect": {
            "legal_aliases": [
                "Reliance Jio Infocomm Limited",
                "Reliance Jio Infocomm Ltd",
                "Reliance Jio Infocom Limited",
                "Jio Platforms Limited",
            ],
            "year": "2007",
            "industry_keywords": ["telecom", "telecommunication", "mobile", "internet", "digital"],
            "domain_root": "jio",
        },
    },
    {
        "tier": "medium",
        "name": "Zoho",
        "url": "https://www.zoho.com",
        "cin": "",
        "expect": {
            "legal_aliases": ["Zoho Corporation", "Zoho Corporation Pvt Ltd", "Zoho Corp"],
            "year": "1996",
            "industry_keywords": ["software", "saas", "cloud", "technology", "business"],
            "domain_root": "zoho",
        },
    },
    {
        "tier": "medium",
        "name": "Nykaa",
        "url": "https://www.nykaa.com",
        "cin": "L52609MH2012PLC230703",
        "expect": {
            "legal_aliases": [
                "FSN E-Commerce Ventures Limited",
                "FSN E-Commerce Ventures Ltd",
                "FSN E-Commerce Ventures Ltd.",
            ],
            "year": "2012",
            "industry_keywords": ["beauty", "fashion", "retail", "ecommerce", "e-commerce", "cosmetic"],
            "domain_root": "nykaa",
        },
    },
    {
        "tier": "medium",
        "name": "Freshworks",
        "url": "https://www.freshworks.com",
        "cin": "",
        "expect": {
            "legal_aliases": ["Freshworks Inc", "Freshworks Inc.", "Freshworks"],
            "year": "2010",
            "industry_keywords": ["software", "saas", "customer", "cloud", "crm"],
            "domain_root": "freshworks",
        },
    },
    {
        "tier": "startup",
        "name": "Zepto",
        "url": "https://www.zeptonow.com",
        "cin": "U46909MH2020PLC351339",
        "expect": {
            "legal_aliases": [
                "Zepto Limited",
                "Kiranakart Technologies Private Limited",
                "Zepto Marketplace Private Limited",
                "Kiranakart Technologies Pvt Ltd",
            ],
            "year": "2020",
            "industry_keywords": [
                "grocery", "quick commerce", "commerce", "delivery", "retail", "ecommerce", "startup",
            ],
            "domain_root": "zeptonow",
        },
    },
    {
        "tier": "startup",
        "name": "Shiprocket",
        "url": "https://www.shiprocket.in",
        "cin": "U72900DL2011PLC225614",
        "expect": {
            "legal_aliases": [
                "Shiprocket Limited",
                "SHIPROCKET LIMITED",
                "Shiprocket Merchant App Private Limited",
                "Bigfoot Retail Solutions Private Limited",
                "Bigfoot Retail Solutions Pvt Ltd",
            ],
            "year": "2011",
            "industry_keywords": [
                "logistics", "shipping", "ecommerce", "e-commerce", "delivery", "retail", "saas",
            ],
            "domain_root": "shiprocket",
        },
    },
    {
        "tier": "startup",
        "name": "Meesho",
        "url": "https://www.meesho.com",
        "cin": "U74900KA2015PTC082263",
        "expect": {
            "legal_aliases": [
                "Meesho Limited",
                "Meesho Private Limited",
                "MEESHO LIMITED",
                "Fashnear Technologies Private Limited",
                "Fashnear Technologies Pvt Ltd",
            ],
            "year": "2015",
            "industry_keywords": [
                "ecommerce", "e-commerce", "marketplace", "retail", "social commerce", "shopping",
            ],
            "domain_root": "meesho",
        },
    },
]


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _legal_match(got: str | None, aliases: list[str]) -> bool:
    g = _norm(got or "")
    if not g:
        return False
    for a in aliases:
        an = _norm(a)
        if not an:
            continue
        if g == an or an in g or g in an:
            return True
        # Allow 1-char edit distance for OCR/search typos (Infocomm/Infocom)
        if abs(len(g) - len(an)) <= 2 and len(g) >= 12:
            # crude: shared prefix length
            pref = 0
            for x, y in zip(g, an):
                if x != y:
                    break
                pref += 1
            if pref >= min(len(g), len(an)) - 2:
                return True
    return False


def _industry_match(got: str | None, keywords: list[str]) -> bool:
    blob = (got or "").lower()
    if not blob:
        return False
    return any(k.lower() in blob for k in keywords)


def _news_accuracy(report: dict, company_name: str, url: str) -> tuple[float, dict]:
    """Fraction of news themes that are actually about this company."""
    cov = (report.get("coverage") or {}).get("analysis") or {}
    hits = (report.get("coverage") or {}).get("news_hits") or []
    themes = list(cov.get("positive_themes") or []) + list(cov.get("negative_themes") or [])
    card = build_company_card(company_name, url, report.get("metadata") or {})
    if report.get("official_identity", {}).get("official_name"):
        card["legal_name"] = report["official_identity"]["official_name"]

    if not themes and not hits:
        return 0.0, {"themes": 0, "relevant": 0, "hits": 0}

    relevant_themes = 0
    for t in themes:
        text = f"{t.get('headline', '')} {t.get('fact', '')}"
        if mentions_company(text, card) and is_company_primary_in_headline(
            t.get("headline") or text, card
        ):
            relevant_themes += 1

    relevant_hits = sum(
        1 for h in hits
        if mentions_company(f"{h.get('title', '')} {h.get('snippet', '')}", card)
        and is_company_primary_in_headline(h.get("title") or "", card)
    )

    # Prefer theme relevance; require at least one relevant item
    if themes:
        score = relevant_themes / len(themes)
    else:
        score = relevant_hits / max(1, len(hits))
    detail = {
        "themes": len(themes),
        "relevant_themes": relevant_themes,
        "hits": len(hits),
        "relevant_hits": relevant_hits,
    }
    return score, detail


def score_accuracy(report: dict, expect: dict, company_name: str, url: str, cin: str) -> dict:
    """Return per-field checks and overall accuracy in [0, 1]."""
    identity = report.get("official_identity") or {}
    meta = report.get("metadata") or {}
    scraped = report.get("scraped_raw_signals") or {}
    rec = report.get("recommendation") or {}

    got_legal = identity.get("official_name")
    got_cin = identity.get("cin") or report.get("cin_input")
    got_year = str(identity.get("year_founded") or meta.get("year_founded") or "")
    got_industry = identity.get("industry") or meta.get("industry")
    raw_text = ""
    # raw_text not always in scraped_raw_signals — approximate via pages + contacts
    pages = scraped.get("pages_visited") or []
    scrapers = report.get("_debug", {}).get("scrapers_used") if isinstance(report.get("_debug"), dict) else None

    checks = {}
    weights = {}

    # Legal name (high weight)
    checks["legal_name"] = _legal_match(got_legal, expect.get("legal_aliases") or [])
    weights["legal_name"] = 0.25

    # CIN when expected
    if cin:
        checks["cin"] = bool(got_cin) and _norm(got_cin) == _norm(cin)
        weights["cin"] = 0.15
    else:
        checks["cin"] = True  # N/A
        weights["cin"] = 0.05

    # Year
    checks["year"] = bool(got_year) and got_year == str(expect.get("year") or "")
    weights["year"] = 0.15

    # Industry topicality
    checks["industry"] = _industry_match(got_industry, expect.get("industry_keywords") or [])
    weights["industry"] = 0.10

    # Scrape success — Jina markdown counts even without emails/socials
    pages = scraped.get("pages_visited") or []
    scrapers = (report.get("scraped_raw_signals") or {}).get("scrapers_used") or []
    content_ok = (
        bool(meta.get("one_line_summary"))
        or bool(scraped.get("socials_found"))
        or bool(scraped.get("emails_found"))
        or ("jina" in scrapers and bool(pages))
        or bool(pages)
    )
    checks["scrape"] = bool(pages) and content_ok
    weights["scrape"] = 0.15

    # News must be company-true; empty news = 0
    news_score, news_detail = _news_accuracy(report, company_name, url)
    checks["news_relevance"] = news_score >= 0.95 and news_detail.get("themes", 0) + news_detail.get("hits", 0) > 0
    # Partial credit via continuous score folded into weighted avg
    weights["news_relevance"] = 0.15

    # Services mapped from requirement (deterministic)
    services = rec.get("matched_opportunities") or []
    checks["services"] = len(services) > 0
    weights["services"] = 0.05

    # Continuous accuracy: binary checks + news continuous
    total_w = sum(weights.values())
    acc = 0.0
    for k, w in weights.items():
        if k == "news_relevance":
            # Use continuous news score (0..1), not only binary gate
            acc += w * float(news_score)
        else:
            acc += w * (1.0 if checks[k] else 0.0)
    accuracy = round(acc / total_w, 4) if total_w else 0.0

    return {
        "accuracy": accuracy,
        "checks": checks,
        "news_detail": news_detail,
        "got": {
            "legal": got_legal,
            "cin": got_cin,
            "year": got_year or None,
            "industry": got_industry,
            "pages": len(pages),
            "services": len(services),
            "scrapers": scrapers,
        },
        "pass": accuracy >= ACCURACY_TARGET,
    }


def main():
    out_dir = Path("reports/verification")
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []

    for c in COMPANIES:
        _SCRAPE_CACHE.clear()
        _DDG_CACHE.clear()
        name, url, tier = c["name"], c["url"], c["tier"]
        cin = c.get("cin") or ""
        print(f"\n=== {tier.upper()}: {name} ===", flush=True)
        row = {"tier": tier, "name": name, "url": url, "cin": cin or None}
        try:
            t0 = time.time()
            report = run_pipeline(
                name,
                submitted_requirement=REQUIREMENT,
                official_url=url,
                cin=cin,
            )
            report.setdefault("_debug", {})["scrapers_used"] = (
                report.get("scraped_raw_signals") or {}
            ).get("scrapers_used") or []
            path = save_report(report, out_dir=str(out_dir))
            scored = score_accuracy(report, c["expect"], name, url, cin)
            row.update({
                "runtime_s": report.get("run_time_seconds"),
                "accuracy": scored["accuracy"],
                "pass": scored["pass"],
                "checks": scored["checks"],
                "news_detail": scored["news_detail"],
                "got": {
                    **scored["got"],
                    "scrapers": (report.get("scraped_raw_signals") or {}).get("scrapers_used"),
                },
                "report_path": path,
                "wall_s": round(time.time() - t0, 1),
                "error": None,
            })
            status = "PASS" if scored["pass"] else "FAIL"
            print(
                f"  {status} accuracy={scored['accuracy']*100:.1f}% "
                f"runtime={row['runtime_s']}s legal={scored['got']['legal']!r} "
                f"year={scored['got']['year']!r} news={scored['news_detail']}",
                flush=True,
            )
            print(f"    checks={scored['checks']}", flush=True)
        except Exception as e:
            row.update({
                "runtime_s": None,
                "accuracy": 0.0,
                "pass": False,
                "error": f"{type(e).__name__}: {e}",
            })
            print(f"  FAIL {row['error']}", flush=True)
        results.append(row)

    accuracies = [r.get("accuracy") or 0 for r in results]
    overall = round(sum(accuracies) / max(1, len(accuracies)), 4)
    summary = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "metric": "accuracy_vs_ground_truth",
        "accuracy_target": ACCURACY_TARGET,
        "overall_accuracy": overall,
        "overall_pass": overall >= ACCURACY_TARGET,
        "total": len(results),
        "passed": sum(1 for r in results if r.get("pass")),
        "failed": sum(1 for r in results if not r.get("pass")),
        "avg_runtime": round(
            sum(r.get("runtime_s") or 0 for r in results) / max(1, len(results)), 1
        ),
        "results": results,
    }
    summary_path = out_dir / "batch_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print("\n==== ACCURACY SUMMARY ====", flush=True)
    print(
        f"overall_accuracy={overall*100:.1f}% target={ACCURACY_TARGET*100:.0f}% "
        f"{'PASS' if summary['overall_pass'] else 'FAIL'} "
        f"companies_pass={summary['passed']}/{summary['total']} "
        f"avg_runtime={summary['avg_runtime']}s",
        flush=True,
    )
    print(f"wrote {summary_path}", flush=True)
    return summary


if __name__ == "__main__":
    main()
