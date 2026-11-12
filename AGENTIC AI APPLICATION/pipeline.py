"""Full pipeline: research -> analysis JSON -> template PDF -> optional Netlify deploy."""
from __future__ import annotations

import time
from typing import Callable

import config
from agent import run_research_agent
from deploy import deploy_proposal
from proposal import generate_proposal

ProgressCb = Callable[[str, str], None]


def run_full_pipeline(
    company_name: str,
    official_url: str,
    requirements: str = "",
    *,
    deploy: bool | None = None,
    dry_run: bool = False,
    on_progress: ProgressCb | None = None,
    max_tool_calls: int | None = None,
) -> dict:
    """
    1) Stage 1 research MD
    2) Stage 2 analysis JSON (grounded)
    3) Stage 3 template PDF via Node pdf-service
    4) Stage 4 deploy (optional)
    """
    def prog(stage: str, msg: str):
        if on_progress:
            on_progress(stage, msg)

    t0 = time.monotonic()
    do_deploy = False if dry_run else (config.DEPLOY_PROPOSALS if deploy is None else bool(deploy))

    prog("research", "Stage 1 — research agent")
    research = run_research_agent(
        company_name,
        official_url,
        requirements,
        on_progress=on_progress,
        max_tool_calls=max_tool_calls,
    )

    prog("proposal", "Stage 2/3 — analysis JSON + template PDF")
    proposal = generate_proposal(
        research["report_path"],
        company_name=research["company_name"],
        dry_run=dry_run,
    )

    deploy_result = None
    artifact = proposal.get("pdf_path") or proposal.get("html_path")
    if do_deploy and proposal.get("folder"):
        prog("deploy", "Stage 4 — publishing proposal")
        deploy_result = deploy_proposal(
            artifact or proposal.get("html_path"),
            folder=proposal["folder"],
            primary_file=proposal.get("pdf_path"),
        )
        prog("deploy", deploy_result.get("message") or "Deploy finished")
    else:
        prog(
            "deploy",
            f"Skipped deploy. Local: {artifact or proposal.get('analysis_path')}",
        )

    elapsed = round(time.monotonic() - t0, 2)
    live_url = (deploy_result or {}).get("url")
    summary = {
        "company_name": research["company_name"],
        "research_path": research["report_path"],
        "analysis_path": proposal.get("analysis_path"),
        "proposal_md": proposal.get("markdown_path"),
        "proposal_pdf": proposal.get("pdf_path"),
        "proposal_html": proposal.get("html_path"),
        "proposal_folder": proposal.get("folder"),
        "live_url": live_url,
        "deploy": deploy_result,
        "tool_calls_used": research.get("tool_calls_used"),
        "run_time_seconds": elapsed,
        "dry_run": dry_run,
        "research": research,
        "proposal": proposal,
    }
    prog(
        "done",
        f"Done in {elapsed}s | research={summary['research_path']} | "
        f"pdf={summary.get('proposal_pdf')}"
        + (f" | live={live_url}" if live_url else ""),
    )
    return summary
