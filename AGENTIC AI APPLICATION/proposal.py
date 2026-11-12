"""Stage 2: grounded analysis JSON (+ optional MD) from research report -> feeds PDF."""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

import config
from analysis_schema import AnalysisModel, FormModel
from llm import get_llm, LLMError
from pdf_bridge import generate_proposal_pdf
from webworks_kb import load_webworks_services, webworks_context_block

ANALYSIS_SYSTEM = """You are preparing structured proposal content for WebWorks Co.
You will be given a factual research report about a prospect and a structured
list of WebWorks Co. services. Return ONLY a single JSON object (no markdown
fences, no commentary) with this exact shape:

{
  "industry": "short industry label",
  "whoYouAre": "2-4 sentence factual company summary from the report only",
  "opportunity": "1-3 sentences on the business opportunity grounded in findings",
  "strengths": [
    {"title": "short specific title", "text": "specific factual strength from the report"}
  ],
  "painPoints": [
    {"title": "short specific title", "text": "specific factual weakness from the report"}
  ],
  "solutionPitch": "paragraph mapping findings to WebWorks services (cite findings)",
  "tactics": ["Finding -> specific WebWorks service(s) - concrete action"],
  "deliverables": ["concrete deliverable tied to a finding"],
  "whyPoints": ["credential lines - prefer WebWorks credentials verbatim; may substitute industry"],
  "servicesNeeded": "comma-separated WebWorks service categories that actually matched findings",
  "subtitle": "one short confident line, similar length to Focus: Category, Category",
  "companyLegalName": "official registered legal name from MCA/registry findings when present, else omit"
}

Rules:
- Use ONLY information explicitly present in the research report.
- Every painPoint and tactic must trace to a specific finding - no generic filler
  like 'strong online presence' or 'room for growth'.
- Every item in `strengths` must be a specific, factual, checkable observation
  drawn directly from the research report - concrete details like a stated founding
  year, a named case-study result, a specific client industry served, a specific
  recognition or certification found in the research. Do NOT write vague general
  praise like 'strong online presence' or 'well-established brand.' If the research
  report doesn't contain enough factual material to support at least one genuine
  strength, return an empty strengths array rather than inventing one.
- Prefer fewer, higher-quality bullets over padding.
- Match services via fixes_weaknesses_like; never recommend a service without a finding.
- Populate whyPoints from the WebWorks credentials in the KB (verbatim where possible).

Strengths tone ("Where You Are Killing It"):
- Wording should sound celebratory and encouraging — the reader should feel
  recognized for what they already do well. Facts remain mandatory: do not add
  claims, superlatives, or praise that the research report does not support.
  Warmth is in the phrasing of real observations only. This does not relax the
  grounding rules above.

Forward-looking tone (solutionPitch, tactics, deliverables, and subtitle ONLY —
do not apply this voice to whoYouAre, opportunity, or painPoints):
Write the solutionPitch, tactics, and deliverables in a confident,
encouraging, execution-focused tone. The reader should come away certain
that WebWorks Co. will deliver measurable, noticeable improvement — not
vague reassurance. Concretely:
- Name the SPECIFIC metric category each tactic will move (e.g.
  conversion rate, organic traffic, engagement rate, lead volume, brand
  search volume, retention) — tie it directly to the weakness it
  addresses from the 'Where Improvements Can Be Made' section, don't
  introduce a metric that isn't a logical fix for a stated weakness.
- Use precise, active language ('we will build,' 'we will launch,' 'you
  will see') rather than hedged language ('we could potentially help
  with,' 'this may improve').
- Do NOT fabricate specific numeric promises (e.g. '47% increase in
  conversions') unless that number comes from a real, provided WebWorks
  track record or case study — inventing a precise-sounding statistic
  with no backing is a false-advertising risk, not just a copywriting
  choice. Where you want to convey scale of impact without a real number,
  use qualitative-but-confident framing instead: 'meaningfully increase,'
  'a step-change in,' 'directly close the gap left by [specific weakness]'
  — precise about WHAT will improve, honest about not having invented a
  number for HOW MUCH.
- Keep sentences short and declarative. Avoid corporate hedge-words:
  'may,' 'could,' 'potentially,' 'in theory,' 'aims to.'
- Every tactic should read as a direct, one-to-one response to something
  named in 'Where Improvements Can Be Made' — the reader should be able
  to trace each tactic back to the specific gap it closes.

Subtitle: apply the same confident, execution-focused tone in a single
short line consistent with the existing template format (one line, similar
length to 'Focus: Development, Marketing & Content'). No fabricated numbers.
"""


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s or "company"


_LEGAL_SUFFIX_RE = re.compile(
    r"\b([A-Z][A-Za-z0-9&.,'’\- ]{1,90}?"
    r"(?:Private\s+Limited|Pvt\.?\s*Ltd\.?|Limited|LLC|LLP|Inc\.?|PLC|GmbH))\b",
    re.I,
)


def _extract_company_legal_name(report_md: str, fallback: str = "") -> str:
    """
    Pull an official registered legal name from Stage 1 research when present
    (MCA / Zauba / registry mentions, title parentheses, etc.).
    Falls back to empty string so callers can use form.company.
    """
    text = report_md or ""
    # Prefer explicit registry phrasing
    for pat in (
        r"(?:legally\s+registered\s+as|registered\s+as|legal\s+name[:\s]+|"
        r"incorporated\s+as)\s[*_]*([^*\n|_]{3,120})",
        r"\bas\s+\*\*([^*]{3,120})\*\*",
        r"Company\s+Name:\s*[^(\n]+\(([^)]{3,120})\)",
        r"#\s*Company Research Memo:\s*[^(]+\(([^)]{3,120})\)",
    ):
        m = re.search(pat, text, re.I)
        if m:
            cand = re.sub(r"[*_`]+", "", m.group(1)).strip(" .;,")
            if _LEGAL_SUFFIX_RE.search(cand) or re.search(
                r"\b(Private\s+Limited|Pvt\.?\s*Ltd|Limited|LLC|LLP|Inc)\b", cand, re.I
            ):
                return cand[:200]
    # Any legal-suffix match in the first ~4k chars (overview)
    head = text[:4000]
    m2 = _LEGAL_SUFFIX_RE.search(head)
    if m2:
        return m2.group(1).strip(" .;,")[:200]
    return ""


def _extract_json(text: str) -> dict:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", raw)
        if not m:
            raise
        data = json.loads(m.group(0))
    return _sanitize_unicode(data)


def _sanitize_unicode(obj):
    """Normalize fancy Unicode that breaks Windows cp1252 consoles / some PDF fonts."""
    if isinstance(obj, str):
        return (
            obj.replace("\u2192", "->")
            .replace("\u2190", "<-")
            .replace("\u2014", "-")
            .replace("\u2013", "-")
            .replace("\u2022", "-")
            .replace("\u00a0", " ")
        )
    if isinstance(obj, list):
        return [_sanitize_unicode(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _sanitize_unicode(v) for k, v in obj.items()}
    return obj


def generate_analysis_json(
    research_report_path: str | Path,
    company_name: str,
) -> dict:
    """LLM pass: research MD -> validated analysis + form dicts."""
    report_path = Path(research_report_path)
    if not report_path.exists():
        raise FileNotFoundError(f"Research report not found: {report_path}")
    report_md = report_path.read_text(encoding="utf-8")
    name = (company_name or "").strip() or "Prospect"
    kb = load_webworks_services()
    kb_block = webworks_context_block()
    creds = kb.get("credentials") or []

    user = (
        f"Prospect company name: {name}\n\n"
        f"=== RESEARCH REPORT ===\n{report_md}\n\n"
        f"=== WEBWORKS SERVICES KB ===\n{kb_block}\n\n"
        f"Return the JSON object now."
    )

    llm = get_llm()
    try:
        reply = llm.chat(
            [
                {"role": "system", "content": ANALYSIS_SYSTEM},
                {"role": "user", "content": user},
            ],
            tools=None,
            temperature=0.2,
        )
    except LLMError as exc:
        raise RuntimeError(f"Analysis LLM error: {exc}") from exc

    data = _extract_json(reply.get("content") or "")
    industry = str(data.get("industry") or "digital").strip()
    services_needed = str(data.get("servicesNeeded") or "").strip()
    legal_name = str(data.get("companyLegalName") or "").strip()
    if not legal_name:
        legal_name = _extract_company_legal_name(report_md, name)

    # Ensure whyPoints from credentials if model left them empty/generic
    why = data.get("whyPoints") or []
    if len(why) < 3 and creds:
        why = [
            c.replace("{industry}", industry) if "{industry}" in c else c
            for c in creds
        ]
    data["whyPoints"] = why

    analysis = AnalysisModel.model_validate({
        "whoYouAre": data.get("whoYouAre"),
        "opportunity": data.get("opportunity") or "",
        "strengths": data.get("strengths") or [],
        "painPoints": data.get("painPoints"),
        "solutionPitch": data.get("solutionPitch"),
        "tactics": data.get("tactics"),
        "deliverables": data.get("deliverables") or [],
        "whyPoints": why,
        "industry": industry,
        "subtitle": str(data.get("subtitle") or "").strip(),
    }).model_dump()

    form = FormModel(
        company=name,
        companyLegalName=legal_name or name,
        industry=industry,
        servicesNeeded=services_needed,
    ).model_dump()

    return {"form": form, "analysis": analysis}


def generate_proposal(
    research_report_path: str | Path,
    company_name: str,
    output_path: str | Path | None = None,
    *,
    dry_run: bool = False,
) -> dict:
    """
    Stage 2+3: analysis JSON -> template PDF (Node pdf-lib).
    Also writes analysis JSON + a lightweight Markdown mirror for editing.
    """
    name = (company_name or "").strip() or "Prospect"
    slug = _slug(name)
    out_dir = Path(config.PROPOSALS_DIR) / slug
    out_dir.mkdir(parents=True, exist_ok=True)

    packed = generate_analysis_json(research_report_path, name)
    form, analysis = packed["form"], packed["analysis"]

    analysis_path = out_dir / f"{slug}_analysis.json"
    analysis_path.write_text(
        json.dumps({"form": form, "analysis": analysis}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    md = _analysis_to_markdown(form, analysis)
    md_path = out_dir / f"{slug}_proposal.md"
    md_path.write_text(md + "\n", encoding="utf-8")

    pdf_path = Path(output_path) if output_path else out_dir / f"{slug}_proposal.pdf"
    if pdf_path.suffix.lower() != ".pdf":
        pdf_path = pdf_path.with_suffix(".pdf")

    if dry_run:
        preview = generate_proposal_pdf(form, analysis, pdf_path, dry_run=True)
        return {
            "company_name": name,
            "slug": slug,
            "folder": str(out_dir),
            "analysis_path": str(analysis_path),
            "markdown_path": str(md_path),
            "markdown": md,
            "pdf_path": None,
            "html_path": None,
            "form": form,
            "analysis": analysis,
            "dry_run_content": preview,
            "date": date.today().isoformat(),
        }

    pdf_out = generate_proposal_pdf(form, analysis, pdf_path, dry_run=False)

    # Lightweight HTML index pointing at the PDF for Netlify Drop folders
    index_path = out_dir / "index.html"
    index_path.write_text(
        _pdf_index_html(name, pdf_path.name),
        encoding="utf-8",
    )
    # Copy/ensure PDF filename is in folder
    if Path(pdf_out).resolve() != (out_dir / pdf_path.name).resolve():
        import shutil
        shutil.copy2(pdf_out, out_dir / pdf_path.name)
        pdf_out = str(out_dir / pdf_path.name)

    return {
        "company_name": name,
        "slug": slug,
        "folder": str(out_dir),
        "analysis_path": str(analysis_path),
        "markdown_path": str(md_path),
        "markdown": md,
        "pdf_path": pdf_out,
        "html_path": str(index_path),
        "form": form,
        "analysis": analysis,
        "date": date.today().isoformat(),
    }


def _analysis_to_markdown(form: dict, analysis: dict) -> str:
    name = form.get("company") or "Prospect"
    lines = [
        f"Prepared for {name}",
        "by WebWorks Co.",
        "",
        f"{name} is doing good - but it can do great. Here's how we'll do it,",
        "together.",
        "",
    ]
    if analysis.get("subtitle"):
        lines += [analysis["subtitle"], ""]
    lines += [
        "## Who You Are?",
        analysis.get("whoYouAre") or "",
        "",
    ]
    if analysis.get("strengths"):
        lines.append("## Where You Are Killing It")
        for s in analysis["strengths"]:
            lines.append(f"- **{s.get('title') or 'Strength'}:** {s.get('text')}")
        lines.append("")
    if analysis.get("opportunity"):
        lines += ["## The Opportunity", analysis.get("opportunity") or "", ""]
    lines.append("## Where Improvements Can Be Made")
    for pp in analysis.get("painPoints") or []:
        lines.append(f"- **{pp.get('title')}:** {pp.get('text')}")
    lines += ["", "## How Can We Help", analysis.get("solutionPitch") or "", ""]
    if analysis.get("tactics"):
        lines.append("### Approach")
        for t in analysis["tactics"]:
            lines.append(f"- {t}")
        lines.append("")
    if analysis.get("deliverables"):
        lines.append("### Deliverables")
        for d in analysis["deliverables"]:
            lines.append(f"- {d}")
        lines.append("")
    lines.append("## Why Us?")
    for w in analysis.get("whyPoints") or []:
        lines.append(f"- {w}")
    return "\n".join(lines).strip()


def _pdf_index_html(company: str, pdf_filename: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>WebWorks Co. Proposal — {company}</title>
<style>
body{{font-family:Segoe UI,system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#1a1f2e}}
a.btn{{display:inline-block;background:#0d9488;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px}}
</style></head><body>
<h1>WebWorks Co. Proposal</h1>
<p>Prepared for <strong>{company}</strong>.</p>
<p><a class="btn" href="{pdf_filename}">Open / download PDF</a></p>
</body></html>
"""
