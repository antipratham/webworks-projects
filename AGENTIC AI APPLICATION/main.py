"""CLI: research -> analysis -> template PDF -> optional deploy.

Examples:
  python main.py --name Zoho --url https://www.zoho.com
  python main.py --name Zoho --url https://www.zoho.com --dry-run
  python -m pdf_bridge  (see pdf_bridge self-test via sample file)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _configure_stdio() -> None:
    """Windows consoles default to cp1252 and crash on arrows/emoji from the LLM."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


_configure_stdio()

from pipeline import run_full_pipeline
from pdf_bridge import generate_proposal_pdf


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="WebWorks research -> template PDF pipeline")
    p.add_argument("--name", help="Company name")
    p.add_argument("--url", help="Official website URL")
    p.add_argument("--requirements", default="", help="Focus / stakeholder requirements")
    p.add_argument("--deploy", action="store_true", help="Attempt Netlify deploy")
    p.add_argument("--no-deploy", action="store_true", help="Skip deploy (default)")
    p.add_argument("--dry-run", action="store_true", help="Print assembled PDF content JSON; skip PDF bytes")
    p.add_argument("--max-tools", type=int, default=None, help="Cap Stage-1 tool calls")
    p.add_argument(
        "--pdf-only",
        metavar="ANALYSIS_JSON",
        help="Skip research; build PDF from an existing {form,analysis} JSON file",
    )
    p.add_argument(
        "--out",
        default="",
        help="Output PDF path (with --pdf-only)",
    )
    args = p.parse_args(argv)

    if args.pdf_only:
        payload = json.loads(Path(args.pdf_only).read_text(encoding="utf-8"))
        out = args.out or str(Path("proposals") / "manual" / "manual_proposal.pdf")
        if args.dry_run:
            preview = generate_proposal_pdf(payload["form"], payload["analysis"], out, dry_run=True)
            print(json.dumps(preview, indent=2, ensure_ascii=False))
            return 0
        path = generate_proposal_pdf(payload["form"], payload["analysis"], out, dry_run=False)
        print(f"Wrote PDF: {path}")
        return 0

    if not args.name or not args.url:
        p.error("--name and --url are required unless --pdf-only is set")

    deploy = True if args.deploy else False

    def on_progress(stage, msg):
        print(f"[{stage}] {msg}", flush=True)

    result = run_full_pipeline(
        args.name,
        args.url,
        args.requirements,
        deploy=deploy,
        dry_run=args.dry_run,
        on_progress=on_progress,
        max_tool_calls=args.max_tools,
    )
    print("\n==== PIPELINE OUTPUT ====")
    print(f"Research:  {result['research_path']}")
    print(f"Analysis:  {result.get('analysis_path')}")
    print(f"Markdown:  {result.get('proposal_md')}")
    print(f"PDF:       {result.get('proposal_pdf')}")
    if result.get("dry_run"):
        content = (result.get("proposal") or {}).get("dry_run_content")
        if content:
            print("\n---- dry-run content ----")
            print(json.dumps(content.get("content") if isinstance(content, dict) else content, indent=2, ensure_ascii=False)[:3000])
    if result.get("live_url"):
        print(f"✅ Proposal ready: {result['live_url']}")
    else:
        dep = result.get("deploy") or {}
        print(dep.get("message") or f"Local folder: {result.get('proposal_folder')}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
