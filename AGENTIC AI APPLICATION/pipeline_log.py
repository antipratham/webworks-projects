"""Backend-only pipeline logging. Writes to logs/pipeline.log — never shown in Streamlit."""

import logging
import os
from datetime import datetime

import config

_LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(_LOG_DIR, exist_ok=True)
_LOG_PATH = os.path.join(_LOG_DIR, "pipeline.log")

_logger = logging.getLogger("company_profile")
if not _logger.handlers:
    _logger.setLevel(logging.DEBUG)
    fh = logging.FileHandler(_LOG_PATH, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    _logger.addHandler(fh)


def log(msg: str, level: str = "info"):
    getattr(_logger, level, _logger.info)(msg)
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def debug_artifact(report: dict, key: str, value) -> None:
    """Attach debug data to report for JSON export only — not rendered in UI."""
    report.setdefault("_debug", {})[key] = value
