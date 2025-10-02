"""Utilities for normalizing Oumi config paths for API responses.

This module centralizes logic for converting absolute filesystem paths to
canonical relative config paths (rooted under the `configs/` folder), and for
normalizing path separators.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple


def _to_forward_slashes(s: str) -> str:
    return s.replace("\\", "/")


def normalize_config_path(input_path: str | Path) -> Tuple[str, str]:
    """Return a (relative_config_path, absolute_path) tuple for a config file.

    - Converts path separators to forward slashes for consistency.
    - If the path contains a `configs/` segment, returns the portion after it
      as the canonical relative config path expected by the frontend.
    - Otherwise, attempts to resolve and derive the portion under a `configs`
      directory in the resolved path. If not found, returns a best-effort
      relative string (path with leading slashes stripped).
    """
    p = Path(input_path)
    try:
        abs_path = str(p.resolve())
    except Exception:
        # Fallback to absolute() if resolve() fails (e.g., path does not exist)
        try:
            abs_path = str(p.absolute())
        except Exception:
            abs_path = str(p)

    fwd_abs = _to_forward_slashes(abs_path)

    # Prefer slicing after explicit '/configs/' marker
    marker = "/configs/"
    if marker in fwd_abs:
        rel = fwd_abs.split(marker, 1)[1]
        return rel, abs_path

    # Inspect path parts to locate a 'configs' segment
    try:
        resolved = Path(abs_path)
        parts = list(resolved.parts)
        if "configs" in parts:
            idx = parts.index("configs")
            rel = str(Path(*parts[idx + 1:]))
            return rel, abs_path
    except Exception:
        pass

    # Best-effort fallback: strip leading separators and return forward-slashed
    raw = _to_forward_slashes(str(input_path)).lstrip("/")
    return raw, abs_path

