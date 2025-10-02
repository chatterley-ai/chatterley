<div align="center">
  <img alt="Chatterley" width="240" src="frontend/chatterley/public/images/chatterley-logo.png">
</div>

# Chatterley

Chatterley is a pretty, private, powerful, local-first desktop AI chat app for MacOS, Windows and Linux.

## How Does it Work?

## Why Chatterley?

## Under the Hood

### How to Add New Models

Chatterley discovers model configurations from `backend/oumi/configs`. It supports:

- Chat/inference YAMLs (Transformers, vLLM, llama.cpp)
- API providers (OpenAI, Anthropic, Gemini) via config files
- Diffusers (e.g., SDXL) via JSON configs

Examples (relative to `backend/oumi/configs`):

- `recipes/qwen3/inference/qwen3_7b_infer.yaml` (local GPU/CPU)
- `apis/openai/infer_gpt_4o.yaml` (OpenAI)
- `recipes/sdxl/diffusers_sdxl.json` (image generation)

Notes:
- The app computes and displays `context_length` for text models; diffusion configs set `context_length: 0`.
- You typically need at least 8 GB RAM for 7B text models; larger models require more memory and a compatible GPU for best performance.

---

#### Create a new text inference config (YAML)

1. Copy an existing config under `backend/oumi/configs/recipes/<family>/inference/`.
2. Edit `model.model_name`, `generation.max_new_tokens`, and any engine‑specific fields.
3. Test it:

```bash
cd backend/oumi
python -m oumi infer -i -c configs/recipes/<family>/inference/<your_config>.yaml
```

Then run the desktop app and select your config in Settings → Model.

#### Create a diffusers config (JSON)

1. Copy `backend/oumi/configs/recipes/sdxl/diffusers_sdxl.json` and adjust `model.model_name` and `image_generation` fields.
2. In the desktop app, open the Diffusion Workbench and choose your config.

### Customize the system prompt (desktop)

Use Settings → System Prompt, or pass `--system-prompt` to `oumi.webchat.server` when launching the backend.

### REST API

When the backend is running (default `http://localhost:9000`), the desktop app uses the following endpoints.

#### Generate a response (chat completions)

```bash
curl -s http://localhost:9000/v1/chat/completions -X POST \\
  -H 'Content-Type: application/json' \\
  -d '{
    "messages": [{"role":"user","content":"Why is the sky blue?"}],
    "max_tokens": 64,
    "stream": false
  }'
```

#### Oumi WebChat endpoints

- `GET /health`
- `GET /v1/oumi/configs` – discover available configs
- `GET /v1/oumi/branches` – list conversation branches
- `POST /v1/oumi/command` – branch/session operations
- `GET /v1/oumi/conversation` – fetch conversation for a branch
- `POST /v1/oumi/regen_node` – regenerate a node
- `GET /v1/oumi/system_stats` – backend system information
- `POST /v1/oumi/clear_model` – unload model from memory

See `backend/oumi/src/oumi/webchat/routes.py` for the full set.

## Contributing

Open an issue or PR with any improvements, especially around packaging and cross‑platform installers.

