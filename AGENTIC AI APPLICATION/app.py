"""Streamlit UI - research -> analysis -> WebWorks template PDF."""
from __future__ import annotations

import json
import sys


def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


_configure_stdio()

import streamlit as st

import config
from llm import LLMError
from pipeline import run_full_pipeline

st.set_page_config(
    page_title="WebWorks Research & Proposal",
    page_icon=":mag:",
    layout="wide",
)

STAGE_LABELS = {
    "init": "Init",
    "scrape": "Site / social",
    "agent": "Research",
    "tool": "Tools",
    "research": "Stage 1",
    "proposal": "Stage 2/3",
    "deploy": "Stage 4",
    "done": "Done",
}

st.title("WebWorks Research & Proposal Agent")
st.caption(
    "Stage 1 research -> Stage 2 grounded analysis JSON -> Stage 3 template PDF (pdf-lib). "
    f"LLM: **{config.LLM_BACKEND}**."
)

with st.form("pipeline_form"):
    company_name = st.text_input("Company name", placeholder="e.g. Zoho, Meesho")
    official_url = st.text_input(
        "Official website URL",
        placeholder="e.g. https://www.zoho.com",
    )
    requirements = st.text_area(
        "Requirements / focus areas",
        height=110,
        placeholder="e.g. Improve SEO, social content, and conversion",
    )
    dry_run = st.checkbox("Dry-run (preview PDF content JSON, skip render)", value=False)
    do_deploy = st.checkbox(
        "Try Netlify deploy for shareable link",
        value=False,
        help="Requires netlify CLI + login. Deploys the proposals/<slug> folder (PDF + index).",
    )
    submitted = st.form_submit_button("Run full pipeline", type="primary", use_container_width=True)

with st.sidebar:
    st.subheader("Settings")
    st.write(f"**LLM:** `{config.LLM_BACKEND}`")
    st.caption(f"Max tool calls: {config.MAX_TOOL_CALLS}")
    st.caption("PDF: `pdf-service/` (Node + pdf-lib template overlay)")

if submitted:
    if not company_name.strip():
        st.error("Enter a company name.")
    elif not official_url.strip():
        st.error("Enter the official website URL.")
    else:
        status = st.empty()
        log_box = st.empty()
        events: list[str] = []

        def on_progress(stage: str, message: str):
            label = STAGE_LABELS.get(stage, stage)
            events.append(f"**{label}:** {message}")
            status.info(f"{label} — {message}")
            log_box.markdown("\n\n".join(events[-14:]))

        try:
            with st.spinner("Running pipeline…"):
                result = run_full_pipeline(
                    company_name.strip(),
                    official_url.strip(),
                    requirements.strip(),
                    deploy=do_deploy and not dry_run,
                    dry_run=dry_run,
                    on_progress=on_progress,
                )
        except (LLMError, ValueError, RuntimeError) as exc:
            st.error(str(exc))
        except Exception as exc:
            st.error(f"Unexpected error: {exc}")
        else:
            status.success(
                f"Done in {result['run_time_seconds']}s · tools={result.get('tool_calls_used')}"
            )
            c1, c2, c3 = st.columns(3)
            c1.write(f"**Research:** `{result['research_path']}`")
            c2.write(f"**PDF:** `{result.get('proposal_pdf')}`")
            if result.get("live_url"):
                c3.markdown(f"**Live:** [{result['live_url']}]({result['live_url']})")
            else:
                dep = result.get("deploy") or {}
                c3.write(dep.get("message") or "Local proposal only")

            if result.get("dry_run"):
                st.subheader("Dry-run content")
                preview = (result.get("proposal") or {}).get("dry_run_content")
                st.json(preview)

            tabs = st.tabs(["Proposal markdown", "Analysis JSON", "Research report"])
            with tabs[0]:
                md = (result.get("proposal") or {}).get("markdown") or ""
                if md:
                    st.download_button(
                        "Download proposal Markdown",
                        data=md,
                        file_name=(result.get("proposal_md") or "proposal.md").replace("\\", "/").split("/")[-1],
                        mime="text/markdown",
                    )
                    st.markdown(md)
            with tabs[1]:
                packed = {
                    "form": (result.get("proposal") or {}).get("form"),
                    "analysis": (result.get("proposal") or {}).get("analysis"),
                }
                st.code(json.dumps(packed, indent=2, ensure_ascii=False), language="json")
            with tabs[2]:
                st.download_button(
                    "Download research Markdown",
                    data=result["research"]["markdown"],
                    file_name=result["research_path"].replace("\\", "/").split("/")[-1],
                    mime="text/markdown",
                )
                st.markdown(result["research"]["markdown"])

            pdf_path = result.get("proposal_pdf")
            if pdf_path:
                try:
                    with open(pdf_path, "rb") as f:
                        st.download_button(
                            "Download proposal PDF",
                            data=f.read(),
                            file_name=pdf_path.replace("\\", "/").split("/")[-1],
                            mime="application/pdf",
                            use_container_width=True,
                        )
                except OSError:
                    pass
