"""Deploy proposal folder (PDF + index) -> shareable URL (Netlify CLI or Drop)."""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path


def deploy_proposal(
    html_path: str | Path | None = None,
    folder: str | Path | None = None,
    primary_file: str | Path | None = None,
) -> dict:
    """Deploy proposal folder with Netlify CLI if available; else local fallback."""
    primary = Path(primary_file) if primary_file else (Path(html_path) if html_path else None)
    deploy_dir = Path(folder) if folder else (primary.parent if primary else None)
    if not deploy_dir or not deploy_dir.exists():
        raise FileNotFoundError(f"Proposal folder not found: {deploy_dir}")

    # Ensure index.html exists for drop deploys
    index = deploy_dir / "index.html"
    if not index.exists() and primary and primary.suffix.lower() == ".html" and primary.exists():
        shutil.copy2(primary, index)

    local_display = Path(primary).resolve() if primary and Path(primary).exists() else deploy_dir.resolve()

    netlify = shutil.which("netlify") or shutil.which("netlify.cmd")
    if not netlify:
        return {
            "ok": False,
            "url": None,
            "local_path": str(local_display),
            "folder": str(deploy_dir.resolve()),
            "message": (
                f"Netlify CLI not found. Open local file:\n  {local_display}\n"
                f"Or drag folder into https://app.netlify.com/drop :\n  {deploy_dir.resolve()}"
            ),
        }

    try:
        proc = subprocess.run(
            [netlify, "deploy", f"--dir={deploy_dir}", "--prod"],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
        url = _parse_netlify_url(combined)
        if proc.returncode != 0 or not url:
            return {
                "ok": False,
                "url": None,
                "local_path": str(local_display),
                "folder": str(deploy_dir.resolve()),
                "message": (
                    "Netlify deploy failed or not logged in. "
                    "Run `netlify login` once, or drag the folder to "
                    f"https://app.netlify.com/drop\nFolder: {deploy_dir.resolve()}\n"
                    f"CLI output:\n{combined[-800:]}"
                ),
                "cli_output": combined[-2000:],
            }
        # Prefer direct PDF URL when possible
        pdf_name = None
        if primary and primary.suffix.lower() == ".pdf":
            pdf_name = primary.name
        else:
            pdfs = list(deploy_dir.glob("*_proposal.pdf"))
            if pdfs:
                pdf_name = pdfs[0].name
        live = f"{url.rstrip('/')}/{pdf_name}" if pdf_name else url
        return {
            "ok": True,
            "url": live,
            "local_path": str(local_display),
            "folder": str(deploy_dir.resolve()),
            "message": f"✅ Proposal ready: {live}",
        }
    except Exception as exc:
        return {
            "ok": False,
            "url": None,
            "local_path": str(local_display),
            "folder": str(deploy_dir.resolve()),
            "message": (
                f"Deploy error: {exc}. Use local path or Netlify Drop:\n"
                f"  {deploy_dir.resolve()}"
            ),
        }


def _parse_netlify_url(text: str) -> str | None:
    patterns = [
        r"Website URL:\s*(https://\S+)",
        r"Unique Deploy URL:\s*(https://\S+)",
        r"Live Draft URL:\s*(https://\S+)",
        r"(https://[a-z0-9.-]+\.netlify\.app/?)",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.I)
        if m:
            return m.group(1).rstrip("/")
    return None
