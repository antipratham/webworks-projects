"""ReAct-style research agent loop (Stage 1)."""
from __future__ import annotations

import json
import re
import time
from datetime import date
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

import config
from llm import get_llm, LLMError
from prompts import build_system_prompt, build_user_prompt
from tools import TOOL_SCHEMAS, execute_tool, extract_social_links, fetch_page


ProgressCb = Callable[[str, str], None]


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s or "company"


def save_markdown_report(company_name: str, markdown: str, output_dir: str | None = None) -> Path:
    out_dir = Path(output_dir or config.OUTPUT_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{_slug(company_name)}_{date.today().isoformat()}.md"
    clean = (
        (markdown or "")
        .replace("\u2192", "->")
        .replace("\u2190", "<-")
        .replace("\u2014", "-")
        .replace("\u2013", "-")
    )
    path.write_text(clean.strip() + "\n", encoding="utf-8")
    return path


def _format_socials_block(social: dict) -> str:
    links = (social or {}).get("links") or {}
    lines = ["## Digital Presence", ""]
    found = [(k, v) for k, v in links.items() if v]
    if not found:
        lines.append(
            "No social profile links were found in the company website HTML "
            f"(method={(social or {}).get('method')})."
        )
    else:
        for k, v in found:
            lines.append(f"- **{k}:** {v}")
        missing = [k for k, v in links.items() if not v]
        if missing:
            lines.append("")
            lines.append(f"Not linked on-site: {', '.join(missing)}")
    lines.append("")
    return "\n".join(lines)


def _ensure_digital_presence(markdown: str, social: dict) -> str:
    if re.search(r"^##\s+Digital Presence\b", markdown, re.M | re.I):
        return markdown
    block = _format_socials_block(social)
    # Insert after Overview if present, else after title
    m = re.search(r"(^##\s+Overview\b.*?)(?=^##\s+|\Z)", markdown, re.M | re.S | re.I)
    if m:
        insert_at = m.end()
        return markdown[:insert_at].rstrip() + "\n\n" + block + markdown[insert_at:].lstrip()
    m2 = re.search(r"^#\s+.+$", markdown, re.M)
    if m2:
        insert_at = m2.end()
        return markdown[:insert_at] + "\n\n" + block + markdown[insert_at:]
    return block + "\n" + markdown


def run_research_agent(
    company_name: str,
    official_url: str,
    requirements: str = "",
    *,
    on_progress: ProgressCb | None = None,
    max_tool_calls: int | None = None,
) -> dict:
    """Run the ReAct loop and return report metadata + markdown."""
    def prog(stage: str, msg: str):
        if on_progress:
            on_progress(stage, msg)

    name = (company_name or "").strip()
    url = (official_url or "").strip()
    if not name:
        raise ValueError("company_name is required")
    if not url:
        raise ValueError("official_url is required")
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    limit = int(max_tool_calls or config.MAX_TOOL_CALLS)
    t0 = time.monotonic()
    prog("init", f"Starting research for {name}")

    prog("scrape", f"Fetching official site {url}")
    home = fetch_page(url)
    prog("scrape", f"Extracting social links from {url}")
    social = extract_social_links(url)

    seed_note = ""
    if home.get("ok") and home.get("text"):
        seed_note = (
            f"\n\n[Prefetched official homepage — {home.get('url')} "
            f"via {home.get('method')}, {home.get('char_count')} chars]\n"
            f"{(home.get('text') or '')[:5500]}\n"
        )
    else:
        seed_note = (
            f"\n\n[Prefetch of official homepage failed: {home.get('error')}. "
            f"Use fetch_page on the URL.]\n"
        )
    seed_note += (
        f"\n[Prefetched social links via extract_social_links — "
        f"found={social.get('found_count')} method={social.get('method')}]\n"
        f"{json.dumps(social.get('links') or {}, ensure_ascii=False)}\n"
    )

    llm = get_llm()
    messages: list[dict] = [
        {"role": "system", "content": build_system_prompt()},
        {
            "role": "user",
            "content": build_user_prompt(name, url, requirements) + seed_note,
        },
    ]

    tool_calls_used = 0
    final_text = None
    prog("agent", f"LLM backend={config.LLM_BACKEND}, max_tool_calls={limit}")

    while tool_calls_used < limit:
        prog("agent", f"LLM turn (tools used {tool_calls_used}/{limit})")
        try:
            reply = llm.chat(messages, tools=TOOL_SCHEMAS, temperature=0.2)
        except LLMError as exc:
            raise RuntimeError(f"LLM error: {exc}") from exc

        content = reply.get("content")
        tool_calls = reply.get("tool_calls") or []

        if not tool_calls:
            final_text = (content or "").strip()
            break

        assistant_msg: dict = {"role": "assistant", "content": content or ""}
        assistant_msg["tool_calls"] = tool_calls
        if reply.get("gemini_parts"):
            assistant_msg["gemini_parts"] = reply["gemini_parts"]
        messages.append(assistant_msg)

        for tc in tool_calls:
            if tool_calls_used >= limit:
                break
            fn = tc.get("function") or {}
            t_name = fn.get("name") or ""
            t_args = fn.get("arguments") or "{}"
            prog("tool", f"Calling {t_name}({_short_args(t_args)})")
            result = execute_tool(t_name, t_args)
            tool_calls_used += 1
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id") or f"call_{tool_calls_used}",
                "name": t_name,
                "content": json.dumps(_truncate_result(result), ensure_ascii=False),
            })

    if not final_text:
        prog("agent", "Max tools reached — requesting final Markdown synthesis")
        messages.append({
            "role": "user",
            "content": (
                "Stop calling tools. Using only evidence already gathered, "
                "write the complete Markdown due-diligence report now, including "
                "Digital Presence and WebWorks Service Recommendations."
            ),
        })
        reply = llm.chat(messages, tools=None, temperature=0.2)
        final_text = (reply.get("content") or "").strip()

    if not final_text:
        raise RuntimeError("Agent produced no final report text")

    if not final_text.lstrip().startswith("#"):
        final_text = f"# Company Research Memo: {name}\n\n{final_text}"

    final_text = _ensure_digital_presence(final_text, social)

    path = save_markdown_report(name, final_text)
    elapsed = round(time.monotonic() - t0, 2)
    prog("done", f"Report saved to {path} in {elapsed}s")

    return {
        "company_name": name,
        "official_url": url,
        "requirements": requirements,
        "markdown": final_text,
        "report_path": str(path),
        "social_links": social.get("links") or {},
        "tool_calls_used": tool_calls_used,
        "run_time_seconds": elapsed,
        "llm_backend": config.LLM_BACKEND,
        "prefetch_ok": bool(home.get("ok")),
        "domain": urlparse(url).netloc,
    }


def _short_args(raw: str, n: int = 80) -> str:
    s = re.sub(r"\s+", " ", str(raw))
    return s if len(s) <= n else s[:n] + "…"


def _truncate_result(result: dict, text_limit: int = 8000) -> dict:
    if not isinstance(result, dict):
        return {"ok": False, "error": "non-dict tool result"}
    out = dict(result)
    text = out.get("text")
    if isinstance(text, str) and len(text) > text_limit:
        out["text"] = text[:text_limit] + "…"
        out["truncated"] = True
    results = out.get("results")
    if isinstance(results, list) and len(results) > 12:
        out["results"] = results[:12]
        out["truncated"] = True
    return out
