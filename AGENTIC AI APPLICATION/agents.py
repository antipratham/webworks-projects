"""LLM agent functions. Every function extracts facts from supplied text only.
All agents share BLUEPRINT rules — same workflow for every company worldwide."""

import json
import re

import config
from gemini_client import GeminiClient, _parse_json_loose

# ---------------------------------------------------------------------------
# Shared blueprint — every agent follows this for every company
# ---------------------------------------------------------------------------

BLUEPRINT = """You are a factual company due-diligence parser for WebWorks Co.
Same rules apply to EVERY company worldwide. Do not adapt rules per company.

CORE PARSING RULES:
1. Parse ONLY from the candidate evidence blocks provided below. Never use training memory.
2. If a field is not explicitly supported by a candidate, return null — never guess.
3. Every fact must be traceable to a source URL listed in the evidence.
4. Reject impersonator sites (.shop domains that mimic a brand), directories, marketplaces, and parent-company pages as the brand's own data unless explicitly labeled.
5. FOUNDING YEAR: accept only (a) "founded in YYYY", (b) "Founded Year: YYYY", (c) incorporation year embedded in a registration ID (e.g. Indian CIN digit positions 8-11). REJECT page "Last updated" dates and "YYYY Company Profile" title years.
6. LEGAL NAME: must include a legal suffix (Private Limited, Pvt Ltd, Inc, LLC, LLP, PLC, GmbH, etc.) OR appear with a registration number (CIN, CRN, EIN). Brand name alone is NOT a legal name.
7. When multiple legal entities appear, pick the operating entity that runs the brand — not the parent/holding conglomerate.
8. PHONE/EMAIL: only extract values explicitly labeled as contact details — never parse numbers from addresses, pincodes, or section numbers.
9. COMPETITORS: only direct peers in the same niche/market explicitly named as competitors — not generic global brands unless the source compares them directly to the target company.
10. Neutral factual language only. No opinions, marketing, or sales language.
11. MULTI-SOURCE FUSION: reconcile candidates from registry, profile, reference, and official sources with equal weight. Priority when values conflict: (a) official website footer/legal notice, (b) government registry (Zauba, MCA, OpenCorporates, Companies House), (c) Crunchbase or Wikipedia, (d) Tracxn or other directories, (e) blogs/news. Prefer a value only when supported by 2+ independent source families when multiple families are present; otherwise pick the highest-priority single source and note confidence accordingly."""


def _system(task_rule: str = "") -> str:
    parts = [BLUEPRINT]
    if task_rule:
        parts.append(task_rule)
    parts.append("Respond with ONLY valid JSON matching the requested schema.")
    return "\n\n".join(parts)


def _format_evidence(evidence: list[dict], max_items: int = 12, max_chars: int = 4000) -> str:
    lines = []
    for i, e in enumerate(evidence[:max_items], 1):
        url = e.get("url") or ""
        title = e.get("title") or ""
        domain = e.get("domain") or ""
        family = e.get("source_family") or "unknown"
        content = (e.get("content") or e.get("snippet") or "")[:max_chars // max_items]
        lines.append(
            f"[Candidate {i}]\nSource family: {family}\nSource URL: {url}\n"
            f"Domain: {domain}\nTitle: {title}\nContent:\n{content}"
        )
    return "\n\n".join(lines) if lines else "(no evidence candidates)"


# ---------------------------------------------------------------------------
# Unified profile evidence parser (identity + registry + competitors seed)
# ---------------------------------------------------------------------------

def parse_profile_evidence_agent(client: GeminiClient, brand: str,
                                  website_name: str, evidence: list[dict],
                                  regex_hints: dict | None = None,
                                  company_card: dict | None = None) -> dict:
    hints = json.dumps(regex_hints or {}, ensure_ascii=False)
    card_text = json.dumps(company_card or {}, ensure_ascii=False)
    ev_text = _format_evidence(evidence, max_items=20, max_chars=14000)
    prompt = f"""Target brand (user input): {brand!r}
Brand name on official website: {website_name!r}

CANONICAL COMPANY CARD (all extracted fields MUST match this operating company):
{card_text}

TASK: Fuse candidates from ALL source families (registry, profile, reference, official) into one profile.

Pre-extracted machine hints (VERIFY against candidates — discard if not supported):
{hints}

Return JSON with exactly these keys:
- official_name (string or null)
- cin_or_registration_number (string or null)
- year_founded (string or null — 4-digit year only)
- registered_address (string or null)
- country (string or null)
- industry (string or null)
- competitors (list of strings — competitor company names only, max 8)
- confidence ("high" | "medium" | "low" | "none")
- reason (string — explain which source families and candidates were used)
- evidence (list of {{"url","title","claim","source_family"}} — one entry per source actually used)
- field_sources (object mapping each populated field to a list of source URLs that support it, e.g. {{"year_founded":["url1","url2"]}})

Critical disambiguation rules:
- REJECT registry/profile hits for unrelated legal entities that only share the brand token (e.g. pharmaceuticals, terminals, struck-off shells).
- Pick the legal entity that OPERATES the brand at official_url / domain in the company card — not parent shells or name collisions.
- If multiple incompatible legal entities remain, return null for official_name and confidence "none".
- year_founded must reflect brand founding when stated; do NOT use incorporation year from an unrelated entity CIN.
- registered_address must belong to the operating entity tied to the company card domain/industry.

Candidate parsing guide by source family:
- registry (Zauba, OpenCorporates, MCA, Companies House): legal entity name, CIN/registration, registered address, incorporation year.
- profile (Tracxn, Crunchbase): founding year, industry, competitors — treat Tracxn and Crunchbase with equal weight.
- reference (Wikipedia): founding year, industry, competitors when explicitly stated.
- official (website footer): prefer footer legal name when present in candidates.

When multiple families disagree, apply the multi-source priority ladder from the blueprint. Require corroboration from 2+ families when available before setting confidence to "high".

CANDIDATE EVIDENCE:
{ev_text}"""
    try:
        return client.chat_json(prompt, temperature=0.0, system=_system())
    except Exception as e:
        return {
            "official_name": None, "cin_or_registration_number": None,
            "year_founded": None, "registered_address": None, "country": None,
            "industry": None, "competitors": [], "confidence": "none",
            "reason": str(e), "evidence": [], "field_sources": {},
        }


# ---------------------------------------------------------------------------
# URL resolution
# ---------------------------------------------------------------------------

def resolve_company_url_agent(client: GeminiClient, company_name: str,
                                candidates: list) -> dict:
    cand_text = _format_evidence(
        [{"title": c.get("title", ""), "url": c.get("url", ""),
          "domain": "", "content": c.get("snippet", "")} for c in candidates],
        max_items=15, max_chars=6000,
    )
    prompt = f"""Target company: "{company_name}"

TASK: Choose the primary official website from the URL candidates below.

Selection rules:
- Must be a domain the company itself owns and operates (root homepage preferred).
- NEVER choose: social media, Wikipedia, Tracxn, Crunchbase, Zauba, LinkedIn, app stores, news sites, directories, or impersonator .shop domains.
- Reject URLs whose domain does not match the brand unless the snippet explicitly states it is the official site.
- If a candidate is a deep product/collection path on the correct domain, return the root domain URL instead.
- If no confident match, return null for chosen_url.

Return JSON:
- chosen_url (string or null)
- confidence ("high" | "medium" | "low" | "none")
- reasoning (1-2 sentences citing candidate numbers)
- rejected_urls (list of strings — URLs rejected and why, brief)
- other_possible_matches (list of strings)

URL CANDIDATES:
{cand_text}"""
    resp = client.chat(
        [{"role": "system", "content": _system()},
         {"role": "user", "content": prompt}],
        temperature=0.0, max_tokens=600, json_mode=True,
    )
    return _parse_json_loose(resp)


# ---------------------------------------------------------------------------
# Site metadata extraction
# ---------------------------------------------------------------------------

def extract_metadata_agent(client: GeminiClient, scraped: dict) -> dict:
    prompt = f"""TASK: Extract company metadata from the official website text below.
Use ONLY text explicitly present on the site. Use null or [] for missing fields.

Contact rules:
- general_emails and general_phones: use ONLY the pre-validated lists below (from regex on site). Do not add new ones.
- Do not treat copyright years, product SKUs, or pincode fragments as phone numbers.

Founding year rules:
- year_founded: only if the site explicitly states when the company was founded. Do not use copyright year alone.

Return JSON with exactly these keys:
- company_name, brand_name, industry, year_founded, company_address, footer_legal_name
- management (list of {{"name","title","email","phone"}})
- general_emails (list), general_phones (list), social_links (object)
- one_line_summary (<30 words, neutral), services_offered (list)

Pre-validated contacts from site scrape:
Emails: {scraped['emails_found']}
Phones: {scraped['phones_found']}
Socials: {scraped['socials_found']}

WEBSITE TEXT ({len(scraped['pages_visited'])} pages):
{scraped['raw_text'][:12000]}"""
    resp = client.chat(
        [{"role": "system", "content": _system()},
         {"role": "user", "content": prompt}],
        temperature=0.0, max_tokens=2000, json_mode=True,
    )
    return _parse_json_loose(resp)


# ---------------------------------------------------------------------------
# Official legal name (fallback when unified parser confidence is low)
# ---------------------------------------------------------------------------

def resolve_official_name_agent(client: GeminiClient, brand: str,
                                 website_name: str, evidence: list[dict]) -> dict:
    return parse_profile_evidence_agent(client, brand, website_name, evidence)


# ---------------------------------------------------------------------------
# News coverage
# ---------------------------------------------------------------------------

def summarize_news_agent(client: GeminiClient, company_name: str,
                          hits: list[dict], company_card: dict | None = None) -> dict:
    hits_text = _format_evidence(
        [{"title": h.get("title", ""), "url": h.get("url", ""),
          "domain": h.get("source", ""), "content": h.get("snippet", "")}
         for h in hits],
        max_items=20, max_chars=8000,
    )
    card_text = json.dumps(company_card or {}, ensure_ascii=False)
    prompt = f"""Company: {company_name}

CANONICAL COMPANY CARD (only include news about THIS company):
{card_text}

TASK: Summarize news coverage from the candidate snippets below (last 12 months only).

Rules:
- Extract only facts present in snippets. Include specific numbers/figures when stated.
- Frame allegations as "reported". Drop snippets older than 1 year.
- Each theme MUST include source_url copied exactly from the candidate.
- Drop snippets about unrelated companies that only share a similar name.
- Max 5 positive and 5 negative themes.

Return JSON:
- positive_themes (list of {{"theme","headline","fact","source","source_url","date"}})
- negative_themes (list of {{"theme","headline","fact","source","source_url","date"}})
- overall_risk_level ("low"|"medium"|"high"|"unknown")
- caveats (string)

NEWS CANDIDATES:
{hits_text}"""
    resp = client.chat(
        [{"role": "system", "content": _system()},
         {"role": "user", "content": prompt}],
        temperature=0.0, max_tokens=3000, json_mode=True,
    )
    return _parse_json_loose(resp)


# ---------------------------------------------------------------------------
# Customer review summary
# ---------------------------------------------------------------------------

def summarize_reviews_agent(client: GeminiClient, company_name: str,
                             hits: list[dict], company_card: dict | None = None) -> dict:
    hits_text = _format_evidence(
        [{"title": h.get("title", ""), "url": h.get("url", ""),
          "domain": h.get("source", ""),
          "source_family": h.get("source_family", ""),
          "content": h.get("content") or h.get("snippet", "")}
         for h in hits],
        max_items=15, max_chars=6000,
    )
    card_text = json.dumps(company_card or {}, ensure_ascii=False)
    prompt = f"""Company: {company_name}

CANONICAL COMPANY CARD (only include reviews about THIS company):
{card_text}

TASK: Aggregate customer/employee review patterns from candidates below.

Rules:
- Synthesize patterns across sources — do NOT quote a single review verbatim.
- Ignore SEO aggregator sites (tenereteam, brandsawareness, trustindex).
- Treat Trustpilot and Glassdoor as equal-priority public-perception sources when both are present.
- Prefer patterns corroborated by 2+ source families when available; if only one family supports a point, keep wording cautious.
- employee_sentiment: only if evidence is about THIS company on Glassdoor/AmbitionBox — reject generic Glassdoor homepage text.
- Each point must include source_url from candidates.
- If Trustpilot or Glassdoor is missing, note that gap briefly in caveats rather than inventing balance.

Return JSON:
- customer_rating (string or null)
- overall_sentiment ("positive"|"mixed"|"negative"|"unknown")
- positive_points (list of {{"point","source","source_url"}} — max 4)
- negative_points (list of {{"point","source","source_url"}} — max 4)
- employee_sentiment (string or null)
- caveats (string)

REVIEW CANDIDATES:
{hits_text}"""
    resp = client.chat(
        [{"role": "system", "content": _system()},
         {"role": "user", "content": prompt}],
        temperature=0.0, max_tokens=1500, json_mode=True,
    )
    return _parse_json_loose(resp)


# ---------------------------------------------------------------------------
# Competitors
# ---------------------------------------------------------------------------

def extract_competitors_agent(client: GeminiClient, company_name: str,
                               industry: str, hits: list[dict]) -> dict:
    hits_text = _format_evidence(
        [{"title": h.get("title", ""), "url": h.get("url", ""),
          "domain": h.get("source", ""), "content": h.get("snippet", "")}
         for h in hits],
        max_items=15, max_chars=6000,
    )
    prompt = f"""Company: {company_name}
Industry: {industry or 'unknown'}

TASK: List direct competitor company names from the candidates below.

Rules:
- Names only — no descriptions, market share, or strengths.
- Must be explicitly named as a competitor or direct peer of {company_name}.
- Prefer same geography and category (e.g. India D2C fashion, not global luxury unless source compares directly).
- Max 8 names. Do not invent.

Return JSON:
- competitors (list of {{"name","source_url","source_title"}})

COMPETITOR CANDIDATES:
{hits_text}"""
    resp = client.chat(
        [{"role": "system", "content": _system()},
         {"role": "user", "content": prompt}],
        temperature=0.0, max_tokens=1000, json_mode=True,
    )
    return _parse_json_loose(resp)



def _empty_research() -> dict:
    return {
        "identity": {
            "official_name": None, "cin": None, "year_founded": None,
            "registered_address": None, "country": None, "industry": None,
            "confidence": "none", "reason": "Research fusion failed.",
            "evidence": [],
        },
        "coverage": {
            "positive_themes": [], "negative_themes": [],
            "overall_risk_level": "unknown", "caveats": "",
        },
        "reviews": {
            "customer_rating": None, "overall_sentiment": "unknown",
            "positive_points": [], "negative_points": [],
            "employee_sentiment": None, "caveats": "",
        },
        "competitors": {"competitors": []},
    }


def _coerce_research(raw: dict) -> dict:
    empty = _empty_research()
    if not isinstance(raw, dict):
        return empty
    out = {}
    for key in empty:
        val = raw.get(key)
        out[key] = val if isinstance(val, dict) else empty[key]
    return out


def fuse_research_grounded_agent(
    client: GeminiClient,
    company_name: str,
    company_card: dict,
    evidence_bundle: dict | None = None,
) -> dict:
    """Google-AI-mode style company research in one structured call.

    1) Try Gemini + Google Search grounding (best accuracy when quota allows)
    2) Fall back to fusing Wikipedia / News / DDG / Trustpilot evidence packs
    """
    card_text = json.dumps(company_card or {}, ensure_ascii=False)
    bundle = evidence_bundle or {}
    id_text = _format_evidence(bundle.get("identity_evidence") or [], max_items=12, max_chars=6000)
    news_text = _format_evidence(
        [{"title": h.get("title", ""), "url": h.get("url", ""),
          "domain": h.get("source", ""), "content": h.get("snippet", "")}
         for h in (bundle.get("news_hits") or [])],
        max_items=12, max_chars=5000,
    )
    rev_text = _format_evidence(
        [{"title": h.get("title", ""), "url": h.get("url", ""),
          "domain": h.get("source", ""),
          "source_family": h.get("source_family", ""),
          "content": h.get("content") or h.get("snippet", "")}
         for h in (bundle.get("review_hits") or [])],
        max_items=10, max_chars=3500,
    )
    comp_text = _format_evidence(
        [{"title": h.get("title", ""), "url": h.get("url", ""),
          "domain": h.get("source", ""), "content": h.get("snippet", "")}
         for h in (bundle.get("competitor_hits") or [])],
        max_items=10, max_chars=3500,
    )

    schema = """Return ONLY valid JSON (no markdown) with exactly:
{
  "identity": {
    "official_name": string|null,
    "cin": string|null,
    "year_founded": string|null,
    "registered_address": string|null,
    "country": string|null,
    "industry": string|null,
    "confidence": "high"|"medium"|"low"|"none",
    "reason": string,
    "evidence": [{"url","title","claim","source_family"}]
  },
  "coverage": {
    "positive_themes": [{"theme","headline","fact","source","source_url","date"}],
    "negative_themes": [{"theme","headline","fact","source","source_url","date"}],
    "overall_risk_level": "low"|"medium"|"high"|"unknown",
    "caveats": string
  },
  "reviews": {
    "customer_rating": string|null,
    "overall_sentiment": "positive"|"mixed"|"negative"|"unknown",
    "positive_points": [{"point","source","source_url"}],
    "negative_points": [{"point","source","source_url"}],
    "employee_sentiment": string|null,
    "caveats": string
  },
  "competitors": {
    "competitors": [{"name","source_url","source_title"}]
  }
}"""

    grounded_prompt = f"""You are researching one company like Google AI Mode / deep web research.

Company brand: {company_name!r}
Official website / domain card:
{card_text}

Use Google Search to find current, precise facts about THIS company only
(the one operating at the official_url / domain above — reject name collisions).

Cover:
1) Legal / registry identity (official name, CIN if India, founding year, registered address, country, industry)
2) News from roughly the last 12 months (positive + negative) with source URLs
3) Customer / employee review patterns (Trustpilot, Glassdoor, etc.) with source URLs
4) Direct competitors with source URLs

Rules:
- Prefer corroboration from reputable sources.
- Do not invent. Use null / empty when unknown.
- year_founded = brand founding year when stated.
- Max 5 positive and 5 negative news themes; max 5 review points each side; max 8 competitors.

{schema}"""

    evidence_prompt = f"""Company brand: {company_name!r}

CANONICAL COMPANY CARD (only research THIS operating company / domain):
{card_text}

TASK: Fuse the evidence packs below into one precise company profile.
Use ONLY facts supported by the packs. Reject unrelated entities that share a similar name.

Rules:
- Prefer registry + Wikipedia + official domain matches.
- year_founded = brand founding year when stated.
- Max 5 positive + 5 negative news themes; max 5 review points each side; max 8 competitors.
- If a pack is empty, leave that section empty/unknown — do not invent.

{schema}

IDENTITY EVIDENCE:
{id_text}

NEWS CANDIDATES:
{news_text}

REVIEW CANDIDATES:
{rev_text}

COMPETITOR CANDIDATES:
{comp_text}"""

    empty = _empty_research()
    timeout = float(getattr(config, "FUSION_TIMEOUT", 45))

    def _call(prompt: str, *, tools=None, json_mode=True, allow_search=False) -> dict:
        task = (
            "You may use Google Search results and provided evidence. "
            "Return only valid JSON matching the requested schema. No markdown fences."
            if allow_search else
            "Return only valid JSON matching the requested schema. No markdown fences. "
            "Use only the supplied evidence packs."
        )
        resp = client.chat(
            [{"role": "system", "content": _system(task)},
             {"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=3500,
            json_mode=json_mode,
            max_retries=2,
            timeout=timeout,
            tools=tools,
        )
        return _coerce_research(_parse_json_loose(resp))

    # 1) Google Search grounding (Google-AI-mode)
    if bool(getattr(config, "ENABLE_GOOGLE_SEARCH_GROUNDING", True)):
        try:
            return _call(grounded_prompt, tools=[{"google_search": {}}], json_mode=True, allow_search=True)
        except Exception:
            try:
                return _call(
                    grounded_prompt + "\n\nRespond with raw JSON only.",
                    tools=[{"google_search": {}}],
                    json_mode=False,
                    allow_search=True,
                )
            except Exception:
                pass

    # 2) Evidence fusion (works without grounding quota)
    try:
        return _call(evidence_prompt, json_mode=True, allow_search=False)
    except Exception:
        try:
            return _call(
                evidence_prompt + "\n\nRespond with raw JSON only.",
                json_mode=False,
                allow_search=False,
            )
        except Exception as e:
            empty["identity"]["reason"] = str(e)
            empty["coverage"]["caveats"] = str(e)
            return empty


def fuse_research_bundle_agent(
    client: GeminiClient,
    company_name: str,
    company_card: dict,
    identity_evidence: list[dict],
    news_hits: list[dict],
    review_hits: list[dict],
    competitor_hits: list[dict],
    regex_hints: dict | None = None,
) -> dict:
    """Compatibility wrapper around fuse_research_grounded_agent."""
    _ = regex_hints
    return fuse_research_grounded_agent(
        client, company_name, company_card,
        evidence_bundle={
            "identity_evidence": identity_evidence,
            "news_hits": news_hits,
            "review_hits": review_hits,
            "competitor_hits": competitor_hits,
        },
    )


# ---------------------------------------------------------------------------
# Service matching (WebWorks pitch)
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Service matching (WebWorks pitch)
# ---------------------------------------------------------------------------

def _parse_named_services(org_services: str) -> list[str]:
    services = []
    for raw in (org_services or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(("- ", "* ", "• ")):
            line = line[2:].strip()
        elif ":" in line[:25]:
            continue
        else:
            continue
        if line and line not in services:
            services.append(line)
    return services


def _normalise(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


BANNED_PHRASES = (
        "drive growth", "boost efficiency", "streamline operations",
        "improve profitability", "leverage ai", "optimize processes",
    "enhance experience", "unlock value", "transform the business",
    "cut costs", "ai can help",
)

# Keyword -> WebWorks service (indirect OK; keep grounded in catalog).
# Order matters: first matching rules win per need fragment.
_REQUIREMENT_SERVICE_RULES: list[tuple[tuple[str, ...], list[tuple[str, str]]]] = [
    (
        ("creator outreach", "creator", "ugc", "influencer", "influencers"),
        [
            ("Influencer Marketing", "Creator / influencer outreach maps to Influencer Marketing."),
            ("UGC Video Campaigns", "Creator-led content maps to UGC Video Campaigns."),
            ("Product-educated creators", "Outreach programs benefit from product-educated creators."),
        ],
    ),
    (
        ("brand content", "online brand content", "content creation", "brand creative",
         "creative content", "content marketing"),
        [
            ("Brand Content Creation", "Brand content needs map directly to Brand Content Creation."),
            ("Social Media Management", "Online brand content is delivered via social channels."),
            ("Brand Positioning and Digital Roadmaps", "Content improvements tie to brand positioning."),
        ],
    ),
    (
        ("marketing", "performance marketing", "meta ads", "ads", "advertising",
         "paid media", "roas", "campaigns"),
        [
            ("Meta Ads and Performance Marketing", "Marketing needs map to Meta Ads and Performance Marketing."),
            ("Campaign Analysis and Optimization", "Marketing improvement benefits from campaign analysis."),
            ("Turbo Boosting", "Performance lift maps to Turbo Boosting."),
        ],
    ),
    (
        ("seo", "search ranking", "organic traffic", "search engine"),
        [("SEO Optimization", "Search / organic needs map to SEO Optimization.")],
    ),
    (
        ("social media", "instagram", "linkedin", "facebook presence", "community management"),
        [("Social Media Management", "Social presence needs map to Social Media Management.")],
    ),
    (
        ("website", "web development", "web app", "landing page", "site redesign"),
        [
            ("Custom Web Development", "Website needs map to Custom Web Development."),
            ("UI/UX Design", "Site experience improvements map to UI/UX Design."),
        ],
    ),
    (
        ("mobile app", "android app", "ios app", "app development"),
        [("Mobile App Development", "App needs map to Mobile App Development.")],
    ),
    (
        ("ecommerce", "e-commerce", "online store", "shopify"),
        [("eCommerce Platform Development", "Store / commerce needs map to eCommerce Platform Development.")],
    ),
    (
        ("video", "reels", "short form", "hook"),
        [
            ("UGC Video Campaigns", "Video needs map to UGC Video Campaigns."),
            ("Hook-first video strategy", "Short-form performance maps to hook-first video strategy."),
            ("High retention visuals", "Video retention maps to High retention visuals."),
        ],
    ),
    (
        ("strategy", "roadmap", "consulting", "consultancy", "planning"),
        [
            ("IT and Marketing Strategy Planning", "Planning needs map to IT and Marketing Strategy Planning."),
            ("Brand Positioning and Digital Roadmaps", "Strategy needs map to Brand Positioning and Digital Roadmaps."),
        ],
    ),
    (
        ("cloud", "devops", "infrastructure", "backend", "api"),
        [
            ("DevOps and Cloud Architecture", "Infra needs map to DevOps and Cloud Architecture."),
            ("API and Backend Solutions", "Backend needs map to API and Backend Solutions."),
            ("Platform and Infrastructure Consultation", "Infra advisory maps to Platform and Infrastructure Consultation."),
        ],
    ),
]


def _split_requirement_fragments(text: str) -> list[str]:
    raw = (text or "").strip()
    if not raw:
        return []
    parts = re.split(r"[\n;,]+|\band\b", raw, flags=re.I)
    out = []
    for p in parts:
        frag = re.sub(r"\s+", " ", p).strip(" .-")
        if len(frag) >= 4:
            out.append(frag)
    return out or [raw]


# ---------------------------------------------------------------------------
# Fast keyword coverage classification (no LLM)
# ---------------------------------------------------------------------------

_POS_NEWS_KW = (
    "raises", "raised", "funding", "funded", "growth", "grows", "award", "awards",
    "partnership", "partners with", "debut", "surge", "soars", "profit", "profits",
    "expands", "expansion", "launches", "launch", "ipo", "listing gains", "milestone",
    "record", "wins", "won", "acquires", "acquisition", "hiring", "hire", "innovation",
    "breakthrough", "success", "boost", "rallies", "outperforms", "beats estimates",
)
_NEG_NEWS_KW = (
    "scam", "fraud", "complaint", "complaints", "crackdown", "suspend", "suspended",
    "lawsuit", "sued", "fine", "fined", "probe", "investigation", "controversy",
    "layoff", "layoffs", "loss", "losses", "fda", "illegal", "ban", "banned",
    "fire", "fired", "penalty", "penalties", "raid", "arrest", "backlash",
    "boycott", "outage", "breach", "leak", "scandal", "regulatory", "scrutiny",
    "strike", "protest", "warning", "fails", "failed", "collapse", "debt",
    "default", "downgrade", "recall", "contamination", "safety", "violation",
)
# Map negative headline patterns -> pain-point phrases for service matching
_NEG_PAIN_MAP = (
    (("complaint", "complaints", "backlash", "boycott", "review"),
     "customer complaints and brand reputation issues"),
    (("fda", "safety", "contamination", "recall", "violation"),
     "compliance and public trust / brand content recovery"),
    (("layoff", "layoffs", "fired", "hiring freeze"),
     "employer brand and online brand content improvement"),
    (("outage", "breach", "leak", "fails", "failed"),
     "digital trust and marketing communications"),
    (("scam", "fraud", "scandal", "controversy"),
     "brand reputation and crisis-related marketing content"),
    (("probe", "investigation", "regulatory", "scrutiny", "fine", "penalty"),
     "reputation management and clearer brand messaging"),
    (("lawsuit", "sued", "crackdown", "ban", "suspend"),
     "public perception and brand content improvement"),
)


def classify_news_by_keywords(news_hits: list[dict], *, company_name: str = "") -> dict:
    """Classify news headlines as positive/negative via keyword matching."""
    positive, negative = [], []
    pain_points: list[str] = []
    seen_pain: set[str] = set()

    for h in news_hits or []:
        title = (h.get("title") or "").strip()
        snippet = (h.get("snippet") or h.get("content") or "").strip()
        blob = f"{title} {snippet}".lower()
        if not title:
            continue
        pos_hit = any(k in blob for k in _POS_NEWS_KW)
        neg_hit = any(k in blob for k in _NEG_NEWS_KW)
        theme = {
            "theme": title[:80],
            "headline": title,
            "fact": (snippet or title)[:280],
            "source": h.get("source") or "",
            "source_url": h.get("url") or "",
            "date": h.get("date") or "",
        }
        if neg_hit and not pos_hit:
            negative.append(theme)
            for keys, pain in _NEG_PAIN_MAP:
                if any(k in blob for k in keys) and pain not in seen_pain:
                    seen_pain.add(pain)
                    pain_points.append(pain)
                    break
        else:
                generic = "negative media coverage affecting brand perception"
                if generic not in seen_pain:
                    seen_pain.add(generic)
                    pain_points.append(generic)
        elif pos_hit and not neg_hit:
            positive.append(theme)
        elif neg_hit and pos_hit:
            # Mixed: prefer negative for risk awareness
            negative.append(theme)
        # else: neutral — skip

    if len(negative) >= 4:
        risk = "high"
    elif len(negative) >= 2:
        risk = "medium"
    elif negative:
        risk = "low"
    else:
        risk = "low" if positive else "unknown"

    brand = company_name or "company"
    caveat = (
        f"Keyword-classified from Google News for {brand} "
        f"({len(positive)} positive, {len(negative)} negative)."
    )
    return {
        "positive_themes": positive[:8],
        "negative_themes": negative[:8],
        "overall_risk_level": risk,
        "caveats": caveat,
        "pain_points": pain_points[:8],
    }


def match_services_from_requirement(
    org_services: str,
    submitted_requirement: str = "",
    researched_pain_points: list[str] | None = None,
    *,
    company_name: str = "",
) -> dict:
    """Deterministic requirement->service map (no LLM). Prefer exact catalog names.

    Always maps the submitted requirement when present — does not wait for
    extra researched pain points.
    """
    service_names = _parse_named_services(org_services)
    allowed = {_normalise(s): s for s in service_names}
    base = {
            "matched_opportunities": [],
            "draft_pitch_paragraph": "",
        "show_options": False,
        "discovered_pain_points": list(researched_pain_points or []),
            "no_clear_service_offering": True,
        "reason": "",
    }
    if not service_names:
        base["reason"] = "No service offerings configured."
        return base

    needs: list[tuple[str, str]] = []
    for frag in _split_requirement_fragments(submitted_requirement):
        needs.append((frag, "requirement"))
    for p in researched_pain_points or []:
        if (p or "").strip():
            needs.append((p.strip(), "research"))

    if not needs:
        base["reason"] = "No requirement or pain points provided to match."
        return base

    matched = []
    used_services: set[str] = set()
    for need, source in needs:
        need_l = need.lower()
        for keywords, offerings in _REQUIREMENT_SERVICE_RULES:
            if not any(k in need_l for k in keywords):
                continue
            for service_name, why in offerings:
                canonical = allowed.get(_normalise(service_name))
                if not canonical or canonical in used_services:
                    continue
                used_services.add(canonical)
                matched.append({
                    "pain_point": need,
                    "our_service": canonical,
                    "why_it_fits": why,
                    "source": source,
                })
            break  # one rule family per need fragment

    if not matched:
        base["reason"] = "No grounded match between the requirement and WebWorks services."
        return base

    brand = company_name or "the company"
    services_list = ", ".join(m["our_service"] for m in matched[:5])
    pitch = (
        f"For {brand}, the stated needs ({submitted_requirement.strip() or 'documented issues'}) "
        f"align with WebWorks offerings including {services_list}. "
        f"These services address the requirement directly or through closely related delivery "
        f"(content, creators, paid media, and channel management) without stretching into unrelated work."
    )

    return {
        "matched_opportunities": matched,
        "draft_pitch_paragraph": pitch,
        "show_options": True,
        "discovered_pain_points": list(researched_pain_points or []),
        "no_clear_service_offering": False,
        "reason": "",
    }


def recommendation_agent(client: GeminiClient, metadata: dict,
                          pain_points: list[str], org_services: str,
                          submitted_requirement: str = "",
                          *, show_options: bool = True) -> dict:
    """Map requirement (+ optional research pains) to WebWorks services.

    Fast path: deterministic keyword matching (no LLM). show_options is kept
    for API compatibility; requirement alone is enough to offer services.
    """
    _ = client, show_options  # LLM path removed for latency; signature kept
    return match_services_from_requirement(
        org_services,
        submitted_requirement=submitted_requirement,
        researched_pain_points=pain_points,
        company_name=(metadata or {}).get("company_name")
        or (metadata or {}).get("brand_name")
        or "",
    )
