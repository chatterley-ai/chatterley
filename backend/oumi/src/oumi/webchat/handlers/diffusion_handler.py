"""HTTP handler for diffusers-backed image synthesis."""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path
from typing import Any, Optional

from aiohttp import web

from oumi.core.configs import InferenceConfig, InferenceEngineType
from oumi.core.configs.params.image_generation_params import ImageGenerationParams
from oumi.core.types.conversation import Conversation, Message, Role
from oumi.infer import get_engine
from oumi.utils.logging import logger


class DiffusionHandler:
    """Expose REST endpoints for image synthesis workflows."""

    def __init__(self, base_dir: Optional[str] = None) -> None:
        self._base_dir = Path(base_dir).resolve() if base_dir else None

    async def handle_generate_image_api(self, request: web.Request) -> web.Response:
        """Generate an image using a diffusers configuration."""

        try:
            payload = await request.json()
        except Exception as exc:  # pragma: no cover - request validation
            return web.json_response(
                {"error": f"Invalid JSON payload: {exc}"},
                status=400,
            )

        prompt = (payload.get("prompt") or "").strip()
        if not prompt:
            return web.json_response(
                {"error": "Missing required field 'prompt'"},
                status=400,
            )

        config_path = payload.get("config_path")
        config_id = payload.get("config_id")

        try:
            resolved_config_path = self._resolve_config_path(config_path, config_id)
        except FileNotFoundError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        logger.info(
            "Diffusion request received",
            extra={
                "config_path": resolved_config_path,
                "config_id": config_id,
                "prompt_preview": prompt[:80],
            },
        )

        try:
            config = InferenceConfig.from_yaml(resolved_config_path)
        except Exception as exc:
            logger.error("Failed to load inference config %s: %s", resolved_config_path, exc)
            return web.json_response(
                {"error": f"Failed to load inference config: {exc}"},
                status=500,
            )

        # Ensure config is finalized and ready for inference
        try:
            config.finalize_and_validate()
        except Exception as exc:
            logger.error("Invalid inference config at %s: %s", resolved_config_path, exc)
            return web.json_response(
                {"error": f"Inference config failed validation: {exc}"},
                status=500,
            )

        # Force diffusers engine regardless of config default
        config.engine = InferenceEngineType.DIFFUSERS_IMAGE

        if getattr(config, "input_path", None):
            logger.debug(
                "Diffusion config defines input_path, but request supplied a prompt; clearing input_path to prioritize direct input",
                extra={
                    "config_path": resolved_config_path,
                    "input_path": config.input_path,
                },
            )
            config.input_path = None

        # Apply optional overrides for image generation params
        image_params = config.image_generation or ImageGenerationParams()
        overrides: dict[str, Any] = {}
        for field_name in (
            "width",
            "height",
            "num_inference_steps",
            "guidance_scale",
            "negative_prompt",
            "num_images",
            "seed",
            "scheduler",
        ):
            if field_name in payload and payload[field_name] is not None:
                overrides[field_name] = payload[field_name]

        for key, value in overrides.items():
            setattr(image_params, key, value)

        config.image_generation = image_params

        if output_dir := payload.get("output_dir"):
            output_path = Path(output_dir)
            if not output_path.is_absolute() and self._base_dir is not None:
                output_path = self._base_dir / output_path
            config.image_output_dir = str(output_path)

        start = time.perf_counter()

        try:
            engine = get_engine(config)
            conversations = engine.infer(
                input=[Conversation(messages=[Message(role=Role.USER, content=prompt)])],
                inference_config=config,
            )
        except Exception as exc:
            logger.exception("Diffusion inference failed: %s", exc)
            return web.json_response(
                {"error": f"Image generation failed: {exc}"},
                status=500,
            )

        elapsed = time.perf_counter() - start

        if not conversations:
            return web.json_response({"error": "No generation results returned"}, status=500)

        conversation = conversations[0]
        metadata = conversation.metadata or {}
        artifacts = metadata.get("diffusion_artifacts", [])

        response_artifacts = []
        for artifact in artifacts:
            image_path = Path(artifact.get("image_path", ""))
            metadata_path = Path(artifact.get("metadata_path", ""))

            if not image_path.exists():
                logger.warning("Generated image path does not exist: %s", image_path)
                continue

            try:
                image_bytes = image_path.read_bytes()
                image_base64 = base64.b64encode(image_bytes).decode("ascii")
            except Exception as exc:
                logger.error("Failed to read generated image %s: %s", image_path, exc)
                image_base64 = ""

            metadata_payload: dict[str, Any] = artifact.get("metadata", {})
            if not metadata_payload and metadata_path.exists():
                try:
                    metadata_payload = json.loads(metadata_path.read_text(encoding="utf-8"))
                except Exception:
                    metadata_payload = {}

            response_artifacts.append(
                {
                    "image_path": str(image_path),
                    "metadata_path": str(metadata_path),
                    "metadata": metadata_payload,
                    "image_base64": image_base64,
                }
            )

        response_payload = {
            "prompt": prompt,
            "config_path": resolved_config_path,
            "config_id": config_id,
            "elapsed_ms": int(elapsed * 1000),
            "artifacts": response_artifacts,
            "run_directory": metadata.get("diffusion_run_directory"),
        }

        return web.json_response({"success": True, "data": response_payload})

    def _resolve_config_path(self, config_path: Optional[str], config_id: Optional[str]) -> str:
        if config_path:
            path = Path(config_path)
            if not path.is_absolute() and self._base_dir is not None:
                path = self._base_dir / path
            if path.exists():
                return str(path.resolve())
            raise FileNotFoundError(f"Config path does not exist: {path}")

        if not config_id:
            raise ValueError("Either 'config_path' or 'config_id' must be provided")

        # Fallback: simple scan within configs directory
        search_root = self._base_dir or Path(__file__).resolve().parent.parent.parent.parent
        configs_dir = search_root / "configs" / "recipes"
        candidate = configs_dir / config_id
        if candidate.exists():
            return str(candidate.resolve())

        raise FileNotFoundError(
            f"Unable to resolve configuration path for id '{config_id}'"
        )
