"""Bridge: Python -> Node pdf-service/generate.mjs (template-overlay PDF)."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from analysis_schema import AnalysisModel, FormModel, validate_proposal_payload

ROOT = Path(__file__).resolve().parent
PDF_SERVICE = ROOT / "pdf-service"
GENERATE_MJS = PDF_SERVICE / "generate.mjs"


def _node_bin() -> str:
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        raise RuntimeError("Node.js not found on PATH. Install Node 18+ to generate PDFs.")
    return node


def generate_proposal_pdf(
    form: dict,
    analysis: dict,
    output_path: str | Path,
    *,
    dry_run: bool = False,
) -> str | dict:
    """
    Serialize {form, analysis}, call Node generate.mjs, write PDF.
    Returns output_path (str) on success, or content dict when dry_run=True.
    """
    if not GENERATE_MJS.exists():
        raise FileNotFoundError(f"Missing PDF service entrypoint: {GENERATE_MJS}")

    payload = validate_proposal_payload(form, analysis)
    json_str = json.dumps(payload, ensure_ascii=False)
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    cmd = [_node_bin(), str(GENERATE_MJS)]
    if dry_run:
        cmd.append("--dry-run")
    else:
        cmd.append(str(out.resolve()))

    proc = subprocess.run(
        cmd,
        input=json_str,
        text=True,
        capture_output=True,
        cwd=str(PDF_SERVICE),
        timeout=120,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"PDF generator failed (exit {proc.returncode}): {err}")

    if dry_run:
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Dry-run returned non-JSON: {proc.stdout[:400]}") from exc

    if not out.exists():
        raise RuntimeError(f"PDF generator reported success but file missing: {out}")
    return str(out)


def analysis_from_llm_dict(data: dict[str, Any]) -> dict:
    """Validate/normalize LLM JSON into analysis dict."""
    return AnalysisModel.model_validate(data).model_dump()


def form_model(
    company: str,
    industry: str = "",
    services_needed: str = "",
    company_legal_name: str = "",
) -> dict:
    return FormModel(
        company=company,
        companyLegalName=company_legal_name or "",
        industry=industry or "digital",
        servicesNeeded=services_needed or "",
    ).model_dump()
