import json
from types import SimpleNamespace

import pytest
from PIL import Image

from oumi.core.configs import InferenceConfig
from oumi.core.configs.params.image_generation_params import ImageGenerationParams
from oumi.core.configs.params.model_params import ModelParams
from oumi.core.types.conversation import Conversation, Message, Role
from oumi.inference.diffusers_image_inference_engine import (
    DiffusersImageInferenceEngine,
)


class DummyScheduler:
    def __init__(self) -> None:
        self.config = {"dummy": True}

    @classmethod
    def from_config(cls, config):
        instance = cls()
        instance.config = config
        return instance


class DummyPipeline:
    def __init__(self) -> None:
        self.scheduler = DummyScheduler()
        self.progress_disabled = False
        self.device = "cpu"
        self.latest_call_kwargs = None

    @classmethod
    def from_pretrained(cls, *args, **kwargs):
        return cls()

    def to(self, device):
        self.device = device
        return self

    def set_progress_bar_config(self, disable: bool) -> None:
        self.progress_disabled = disable

    def __call__(self, **kwargs):
        self.latest_call_kwargs = kwargs
        width = kwargs.get("width", 1024)
        height = kwargs.get("height", 1024)
        image = Image.new("RGB", (width, height), color="white")
        return SimpleNamespace(images=[image])


@pytest.fixture(autouse=True)
def patch_diffusion_pipeline(monkeypatch):
    monkeypatch.setattr(
        "oumi.inference.diffusers_image_inference_engine.DiffusionPipeline",
        DummyPipeline,
    )


def test_diffusers_image_engine_generates_files(tmp_path, monkeypatch):
    monkeypatch.setattr("torch.cuda.is_available", lambda: False)

    model_params = ModelParams(model_name="dummy/diffusers")
    config = InferenceConfig(model=model_params)
    config.image_output_dir = str(tmp_path)
    config.image_generation = ImageGenerationParams(
        width=512,
        height=512,
        num_inference_steps=5,
        guidance_scale=4.0,
        seed=123,
    )

    engine = DiffusersImageInferenceEngine(model_params=model_params)

    conversation = Conversation(
        messages=[Message(role=Role.USER, content="a test prompt")]
    )

    output = engine._infer_online([conversation], inference_config=config)

    assert len(output) == 1
    assistant_message = output[0].messages[-1]
    assert assistant_message.role == Role.ASSISTANT
    assert "Generated 1 image" in assistant_message.content

    png_files = list(tmp_path.rglob("*.png"))
    metadata_files = list(tmp_path.rglob("*.json"))

    assert len(png_files) == 1
    assert len(metadata_files) == 1

    metadata = json.loads(metadata_files[0].read_text())
    assert metadata["prompt"] == "a test prompt"
    assert metadata["seed"] is not None
    assert metadata["model_name"] == "dummy/diffusers"
