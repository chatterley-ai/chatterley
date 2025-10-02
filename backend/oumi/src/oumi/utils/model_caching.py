# Copyright 2025 - Oumi
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import annotations

import re
import shutil
import os
from pathlib import Path
from typing import Sequence

from huggingface_hub import hf_hub_download

from oumi.utils.logging import logger

def _resolve_default_hf_cache() -> str:
    """Resolve a safe, absolute Hugging Face cache directory.

    Priority:
    1) OUMI_HF_CACHE
    2) HF_HOME
    3) HUGGINGFACE_HUB_CACHE
    4) TRANSFORMERS_CACHE
    5) ~/.cache/huggingface

    This avoids writing into the application working directory when Oumi is
    embedded (e.g., inside an Electron app bundle). Using a user-level cache
    prevents the app package from growing after first run.
    """
    for var in ("OUMI_HF_CACHE", "HF_HOME", "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE"):
        val = os.environ.get(var)
        if val and isinstance(val, str) and val.strip():
            return os.path.expanduser(val.strip())

    return str((Path.home() / ".cache" / "huggingface").resolve())


HUGGINGFACE_CACHE = _resolve_default_hf_cache()


def _download_gguf_part(repo_id: str, filename: str, cache_dir: Path) -> Path:
    if Path(filename).suffix != ".gguf":
        raise ValueError(f"The `filename` provided is not a `.gguf` file: `{filename}`")
    cache_dir.mkdir(parents=True, exist_ok=True)
    part_path = cache_dir / filename
    if part_path.exists():
        logger.info(f"Loading GGUF part from cache ({part_path}).")
        return part_path
    logger.info(f"Downloading GGUF file `{filename}` from HuggingFace.")
    try:
        return Path(
            hf_hub_download(repo_id=repo_id, filename=filename, local_dir=cache_dir.as_posix())
        )
    except Exception:
        logger.exception(
            f"Failed to download the GGUF file `{filename}` from HuggingFace Hub repo `{repo_id}`."
        )
        raise


def _assemble_sharded_gguf(repo_id: str, parts: Sequence[str], cache_dir: Path) -> Path:
    first = Path(parts[0]).name
    match = re.search(r"-(\d+)-of-(\d+)(\.gguf)$", first)
    if match:
        assembled_name = first[: match.start()] + match.group(3)
    else:
        assembled_name = first
    target_path = cache_dir / assembled_name
    cache_dir.mkdir(parents=True, exist_ok=True)
    # Skip recomposition if assembled file already exists.
    if target_path.exists():
        logger.info(f"Reusing assembled GGUF file ({target_path}).")
        return target_path

    logger.info(
        "Assembling sharded GGUF file into %s", target_path
    )
    with open(target_path, "wb") as merged:
        for part_name in parts:
            part_path = _download_gguf_part(repo_id, part_name, cache_dir)
            with open(part_path, "rb") as src:
                shutil.copyfileobj(src, merged)

    return target_path


def get_local_filepath_for_gguf(
    repo_id: str, filename: str | Sequence[str], cache_dir=HUGGINGFACE_CACHE
) -> str:
    """Return a local path for the provided GGUF file(s), downloading if needed."""

    cache_path = Path(cache_dir)

    if isinstance(filename, (list, tuple, set)):
        parts = sorted(str(part) for part in filename)
        if not parts:
            raise ValueError("Expected at least one GGUF filename")
        assembled = _assemble_sharded_gguf(repo_id, parts, cache_path)
        return assembled.absolute().as_posix()

    part_path = _download_gguf_part(repo_id, str(filename), cache_path)
    return part_path.absolute().as_posix()
