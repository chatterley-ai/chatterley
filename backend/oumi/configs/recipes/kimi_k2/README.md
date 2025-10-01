# Kimi K2 Recipes

Configuration files for running the **Kimi K2 Instruct 0905** model with the Oumi
toolkit.

Available recipes:

1. `inference/instruct_vllm_infer.yaml` – vLLM GPU inference with the full
   precision checkpoint hosted at `moonshotai/Kimi-K2-Instruct-0905`.
2. `inference/instruct_sglang_infer.yaml` – remote inference via an SGLang
   server.
3. `inference/instruct_gguf_macos_infer.yaml` – local llama.cpp inference using
   the Unsloth multi-part GGUF quantization.

The GGUF recipe demonstrates how to reference sharded quantized artifacts using
the new `model_kwargs.filenames` field. When invoked, Oumi automatically
downloads and assembles the parts into a single GGUF file inside its cache.

> **Note**
> FlashAttention 2 and SGLang backends must be installed separately. Use the
> optional installs section inside Chatterley’s Settings screen to provision
> them before running the associated recipes.
