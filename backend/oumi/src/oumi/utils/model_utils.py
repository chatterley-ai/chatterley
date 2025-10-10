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

"""Utilities for reasoning about model names and capabilities."""

from __future__ import annotations

from typing import Optional, Tuple

from oumi.core.configs.params.model_params import ModelParams

_VISION_KEYWORDS = (
    "vision",
    "vl",
    "gpt-4o",
    "gemini",
    "claude-3",
    "sonnet",
    "flash",
    "imagebind",
    "internvl",
    "llava",
)


def is_qwen_omni_model(model_name: Optional[str]) -> bool:
    """Returns True if the supplied model name corresponds to a Qwen Omni model."""

    if not model_name:
        return False
    lowered = model_name.lower()
    return "qwen" in lowered and "omni" in lowered


def _infer_vision_from_name(model_name: Optional[str]) -> bool:
    if not model_name:
        return False
    lowered = model_name.lower()
    return any(keyword in lowered for keyword in _VISION_KEYWORDS)


def resolve_model_capabilities(
    model_params: Optional[ModelParams],
    *,
    config_path: Optional[str] = None,
    model_name: Optional[str] = None,
) -> Tuple[bool, bool]:
    """Resolve (is_vision_capable, is_omni_capable) tuple for the supplied config."""

    is_vision: Optional[bool] = None
    is_omni: Optional[bool] = None

    resolved_name = model_name

    if model_params is not None:
        is_vision = model_params.is_vision_capable
        is_omni = model_params.is_omni_capable
        resolved_name = model_params.model_name

    if resolved_name is None:
        resolved_name = model_name

    if is_omni is None:
        is_omni = is_qwen_omni_model(resolved_name)

    if is_vision is None:
        if is_omni:
            is_vision = True
        elif config_path and "vision" in config_path.replace("\\", "/"):
            is_vision = True
        else:
            is_vision = _infer_vision_from_name(resolved_name)

    if is_omni and not is_vision:
        is_vision = True

    return bool(is_vision), bool(is_omni)


__all__ = ["is_qwen_omni_model", "resolve_model_capabilities"]
