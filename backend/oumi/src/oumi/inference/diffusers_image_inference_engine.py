"""Diffusers-backed image synthesis inference engine."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import torch
from typing_extensions import override

from oumi.core.configs import GenerationParams, InferenceConfig, ModelParams
from oumi.core.configs.params.image_generation_params import ImageGenerationParams
from oumi.core.inference import BaseInferenceEngine
from oumi.core.types.conversation import Conversation, Message, Role
from oumi.utils.logging import logger
from oumi.utils.torch_utils import get_torch_dtype

try:  # pragma: no cover - import guard for optional dependency
    from diffusers import DiffusionPipeline
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "diffusers is required to use DiffusersImageInferenceEngine."
    ) from exc


@dataclass
class _GeneratedArtifact:
    image_path: Path
    metadata_path: Path


class DiffusersImageInferenceEngine(BaseInferenceEngine):
    """Runs image generation using Hugging Face diffusers pipelines."""

    _DEFAULT_OUTPUT_DIR = Path("data/gen_img")

    def __init__(
        self,
        model_params: ModelParams,
        *,
        generation_params: Optional[GenerationParams] = None,
    ) -> None:
        super().__init__(model_params=model_params, generation_params=generation_params)
        self._pipeline: Optional[DiffusionPipeline] = None
        self._device: Optional[torch.device] = None

    # ------------------------------------------------------------------
    # BaseInferenceEngine API
    # ------------------------------------------------------------------
    @override
    def get_supported_params(self) -> set[str]:
        # This engine does not consume text-generation parameters.
        return set()

    @override
    def _infer_online(
        self,
        input: list[Conversation],
        inference_config: Optional[InferenceConfig] = None,
    ) -> list[Conversation]:
        if inference_config is None:
            raise ValueError("Inference configuration is required for image generation.")

        image_params = inference_config.image_generation or ImageGenerationParams()
        output_root = self._resolve_output_root(inference_config.image_output_dir)
        run_directory = self._create_run_directory(output_root)

        pipeline = self._ensure_pipeline(image_params)

        results: list[Conversation] = []
        for idx, conversation in enumerate(input):
            prompt = self._extract_prompt(conversation)
            if not prompt:
                raise ValueError("No text prompt found in conversation for image synthesis.")

            logger.info("Generating image(s) for prompt: %s", prompt)
            artifacts = self._generate_images(
                pipeline=pipeline,
                prompt=prompt,
                image_params=image_params,
                run_directory=run_directory,
                prompt_index=idx,
            )

            response_text_lines = [
                f"Generated {len(artifacts)} image(s) using {self._model_params.model_name}.",
            ]

            for artifact_idx, artifact in enumerate(artifacts, start=1):
                response_text_lines.append(
                    f"  Image {artifact_idx}: {artifact.image_path}"
                )
                response_text_lines.append(
                    f"  Metadata {artifact_idx}: {artifact.metadata_path}"
                )

            artifact_payloads: list[dict[str, object]] = []
            for artifact in artifacts:
                metadata_dict = {}
                try:
                    metadata_dict = json.loads(
                        artifact.metadata_path.read_text(encoding="utf-8")
                    )
                except Exception as exc:  # pragma: no cover - informational only
                    logger.warning(
                        "Unable to read metadata file %s: %s",
                        artifact.metadata_path,
                        exc,
                    )

                artifact_payloads.append(
                    {
                        "image_path": str(artifact.image_path),
                        "metadata_path": str(artifact.metadata_path),
                        "metadata": metadata_dict,
                    }
                )

            response_message = Message(
                role=Role.ASSISTANT,
                content="\n".join(response_text_lines),
            )

            updated_messages = list(conversation.messages) + [response_message]
            existing_metadata = dict(conversation.metadata or {})
            existing_metadata.setdefault("diffusion_artifacts", []).extend(artifact_payloads)
            existing_metadata["diffusion_run_directory"] = str(run_directory)
            results.append(
                Conversation(
                    conversation_id=conversation.conversation_id,
                    messages=updated_messages,
                    metadata=existing_metadata,
                )
            )

        return results

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _ensure_pipeline(self, image_params: ImageGenerationParams) -> DiffusionPipeline:
        if self._pipeline is not None:
            return self._pipeline

        model_kwargs = dict(self._model_params.model_kwargs or {})
        dtype_arg = None
        if self._model_params.torch_dtype_str.lower() != "auto":
            try:
                dtype_arg = get_torch_dtype(self._model_params.torch_dtype_str)
            except ValueError as exc:
                raise ValueError(
                    "Unsupported torch dtype for diffusers pipeline: "
                    f"{self._model_params.torch_dtype_str}"
                ) from exc

        logger.info(
            "Loading diffusers pipeline for %s", self._model_params.model_name
        )
        use_safetensors = model_kwargs.pop("use_safetensors", True)
        pipeline_kwargs = dict(model_kwargs)
        if dtype_arg is not None:
            pipeline_kwargs["torch_dtype"] = dtype_arg
        pipe = DiffusionPipeline.from_pretrained(
            self._model_params.model_name,
            use_safetensors=use_safetensors,
            trust_remote_code=self._model_params.trust_remote_code,
            **pipeline_kwargs,
        )

        self._device = self._select_device(pipe)
        if self._device.type == "cuda":
            pipe.to(self._device)
        elif self._device.type == "mps":
            pipe.to(self._device)
        else:
            pipe.to("cpu")

        pipe.set_progress_bar_config(disable=True)

        if image_params.scheduler:
            self._maybe_configure_scheduler(pipe, image_params.scheduler)

        self._pipeline = pipe
        return pipe

    def _select_device(self, pipe: DiffusionPipeline) -> torch.device:
        if torch.cuda.is_available():
            return torch.device("cuda")
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return torch.device("mps")
        logger.info("Falling back to CPU execution for diffusers pipeline.")
        return torch.device("cpu")

    def _maybe_configure_scheduler(self, pipe: DiffusionPipeline, scheduler_name: str) -> None:
        try:
            from diffusers import schedulers as diffusers_schedulers_module

            scheduler_cls = getattr(diffusers_schedulers_module, scheduler_name, None)
            if scheduler_cls is None:
                # Some schedulers are re-exported at the package root.
                import diffusers as diffusers_root

                scheduler_cls = getattr(diffusers_root, scheduler_name, None)
            if scheduler_cls is None:
                raise AttributeError
            pipe.scheduler = scheduler_cls.from_config(pipe.scheduler.config)
            logger.info("Using custom scheduler %s", scheduler_name)
        except AttributeError as exc:
            raise ValueError(
                f"Unknown diffusers scheduler '{scheduler_name}'."
            ) from exc

    def _generate_images(
        self,
        pipeline: DiffusionPipeline,
        prompt: str,
        image_params: ImageGenerationParams,
        run_directory: Path,
        prompt_index: int,
    ) -> list[_GeneratedArtifact]:
        generator_arg = None
        if image_params.seed is not None:
            if image_params.num_images > 1:
                generator_arg = [
                    self._make_generator(
                        image_params.seed
                        + prompt_index * image_params.num_images
                        + i
                    )
                    for i in range(image_params.num_images)
                ]
            else:
                generator_arg = self._make_generator(
                    image_params.seed + prompt_index
                )

        with torch.inference_mode():
            result = pipeline(
                prompt=prompt,
                negative_prompt=image_params.negative_prompt,
                num_inference_steps=image_params.num_inference_steps,
                guidance_scale=image_params.guidance_scale,
                num_images_per_prompt=image_params.num_images,
                generator=generator_arg,
                width=image_params.width,
                height=image_params.height,
            )

        images = result.images if hasattr(result, "images") else result
        artifacts: list[_GeneratedArtifact] = []
        timestamp_prefix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

        for image_idx, image in enumerate(images):
            unique_suffix = uuid.uuid4().hex[:8]
            image_filename = f"{timestamp_prefix}_{image_idx}_{unique_suffix}.png"
            image_path = run_directory / image_filename
            image.save(image_path)

            metadata = {
                "prompt": prompt,
                "negative_prompt": image_params.negative_prompt,
                "seed": (
                    image_params.seed + prompt_index * image_params.num_images + image_idx
                    if image_params.seed is not None
                    else None
                ),
                "width": image.width,
                "height": image.height,
                "num_inference_steps": image_params.num_inference_steps,
                "guidance_scale": image_params.guidance_scale,
                "model_name": self._model_params.model_name,
                "scheduler": image_params.scheduler,
                "num_images": image_params.num_images,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }

            metadata_path = image_path.with_suffix(".json")
            metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

            artifacts.append(
                _GeneratedArtifact(
                    image_path=image_path.resolve(),
                    metadata_path=metadata_path.resolve(),
                )
            )

        return artifacts

    def _extract_prompt(self, conversation: Conversation) -> str:
        for message in reversed(conversation.messages):
            if message.role != Role.USER:
                continue
            if isinstance(message.content, str):
                content = message.content.strip()
                if content:
                    return content
            elif isinstance(message.content, list):
                parts = []
                for item in message.content:
                    content = getattr(item, "content", None)
                    if isinstance(content, str) and content.strip():
                        parts.append(content.strip())
                if parts:
                    return "\n".join(parts)
        return ""

    def _resolve_output_root(self, configured_path: Optional[str]) -> Path:
        if configured_path:
            return Path(configured_path).expanduser().resolve()
        return (self._DEFAULT_OUTPUT_DIR).expanduser().resolve()

    def _create_run_directory(self, root: Path) -> Path:
        run_subdir = datetime.now(timezone.utc).strftime("%Y%m%d-%H")
        path = root / run_subdir
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _make_generator(self, seed: int) -> torch.Generator:
        if self._device and self._device.type == "cuda":
            return torch.Generator(device=self._device).manual_seed(seed)
        return torch.Generator().manual_seed(seed)
