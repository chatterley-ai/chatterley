"""Image generation parameters for diffusers-based pipelines."""

from dataclasses import dataclass
from typing import Optional

from oumi.core.configs.params.base_params import BaseParams


@dataclass
class ImageGenerationParams(BaseParams):
    """Configuration options for image synthesis pipelines."""

    width: int = 1024
    """Requested image width in pixels (must be divisible by 8)."""

    height: int = 1024
    """Requested image height in pixels (must be divisible by 8)."""

    num_inference_steps: int = 30
    """Number of denoising steps to run; higher values improve quality but add latency."""

    guidance_scale: float = 7.5
    """Classifier-free guidance scale (a.k.a. CFG); larger values enforce the prompt more strongly."""

    negative_prompt: Optional[str] = None
    """Optional negative prompt to steer the model away from undesired concepts."""

    seed: Optional[int] = None
    """Random seed for deterministic sampling; `None` yields non-deterministic results."""

    num_images: int = 1
    """Number of images to generate per prompt."""

    scheduler: Optional[str] = None
    """Optional diffusers scheduler identifier; when set, overrides the default pipeline scheduler."""

    def __finalize_and_validate__(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError("Image width and height must be positive.")
        if self.width % 8 != 0 or self.height % 8 != 0:
            raise ValueError(
                "Image width and height must be divisible by 8 for diffusers pipelines."
            )
        if self.num_inference_steps <= 0:
            raise ValueError("num_inference_steps must be positive.")
        if self.guidance_scale < 0:
            raise ValueError("guidance_scale must be non-negative.")
        if self.num_images <= 0:
            raise ValueError("num_images must be positive.")
