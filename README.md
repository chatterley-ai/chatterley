<div align="center">
  <img alt="Chatterley" width="240" src="frontend/chatterley/public/images/chatterley-logo.png">
</div>

# Chatterley

Private, local-first desktop AI chat with a powerful Python backend.

Chatterley is a cross‑platform Electron + Next.js desktop app. It embeds and manages the Oumi backend (Python) to run chat and tools locally, with optional connectors to cloud APIs.

## macOS

- Build locally (recommended for now):
  - Backend: `cd backend/oumi && conda activate oumi && python -m oumi.webchat.server`
  - Frontend: `cd frontend/chatterley && npm install && npm run electron:build-debug`

## Windows

- Build locally (PowerShell):
  - Backend: `cd backend\\oumi; conda activate oumi; python -m oumi.webchat.server`
  - Frontend: `cd frontend\\chatterley; npm install; npm run electron:build-debug`

## Linux

- Build locally:
  - Backend: `cd backend/oumi && conda activate oumi && python -m oumi.webchat.server`
  - Frontend: `cd frontend/chatterley && npm install && npm run electron:build-debug`

Manual install instructions for the backend are available in `backend/oumi/README.md`.

## Docker

The backend ships with a Dockerfile. Example local build and run:

```bash
cd backend/oumi
docker build -t chatterley-oumi .
docker run --rm -p 9000:9000 chatterley-oumi python -m oumi.webchat.server --host 0.0.0.0 --port 9000
```

Run the desktop app pointing to that backend:

```bash
cd frontend/chatterley
NEXT_PUBLIC_BACKEND_URL=http://localhost:9000 npm run electron:debug
```

## Libraries

- Frontend (TypeScript): `frontend/chatterley`
- Backend (Python, Oumi): `backend/oumi`
- Docs: `backend/oumi/docs`

## Community

- Oumi Discord: https://discord.gg/oumi
- Oumi Docs: https://oumi.ai/docs

---

## Quickstart

Run the backend and desktop app in development.

```bash
# 1) Backend (terminal A)
cd backend/oumi
conda activate oumi
python -m oumi.webchat.server --port 9000

# 2) Frontend (terminal B)
cd frontend/chatterley
npm install
NEXT_PUBLIC_BACKEND_URL=http://localhost:9000 npm run electron:debug
```

The desktop app will start and connect to the backend. Use Settings → Model to select a configuration.

---

## Model Library

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

## Customize a Model

### Create a new text inference config (YAML)

1. Copy an existing config under `backend/oumi/configs/recipes/<family>/inference/`.
2. Edit `model.model_name`, `generation.max_new_tokens`, and any engine‑specific fields.
3. Test it:

```bash
cd backend/oumi
python -m oumi infer -i -c configs/recipes/<family>/inference/<your_config>.yaml
```

Then run the desktop app and select your config in Settings → Model.

### Create a diffusers config (JSON)

1. Copy `backend/oumi/configs/recipes/sdxl/diffusers_sdxl.json` and adjust `model.model_name` and `image_generation` fields.
2. In the desktop app, open the Diffusion Workbench and choose your config.

### Customize the system prompt (desktop)

Use Settings → System Prompt, or pass `--system-prompt` to `oumi.webchat.server` when launching the backend.

---

## CLI Reference (Backend)

All commands run from `backend/oumi` with the `oumi` environment active.

- Launch desktop‑friendly backend:

```bash
python -m oumi.webchat.server --host 0.0.0.0 --port 9000
```

- Launch full‑stack WebChat (browser UI) using the repo frontend when available:

```bash
oumi webchat --config configs/recipes/qwen3/inference/qwen3_7b_infer.yaml --backend-port 9000 --frontend-port 7860
```

- Infer from CLI (no UI):

```bash
oumi infer -i -c configs/recipes/qwen3/inference/qwen3_7b_infer.yaml
```

- Train (example):

```bash
oumi train -c configs/recipes/phi3/sft/full/train.yaml
```

---

## Building

### Desktop app (Electron + Next.js)

```bash
cd frontend/chatterley
npm install
npm run electron:build-debug   # dev build + run

# production artifacts
npm run dist:mac    # macOS
npm run dist:win    # Windows
npm run dist:linux  # Linux
```

### Backend (Python)

```bash
cd backend/oumi
make setup            # creates conda env and installs deps (requires conda)
pytest tests -q       # optional
```

---

## REST API

When the backend is running (default `http://localhost:9000`), the desktop app uses the following endpoints.

### Generate a response (chat completions)

```bash
curl -s http://localhost:9000/v1/chat/completions -X POST \\
  -H 'Content-Type: application/json' \\
  -d '{
    "messages": [{"role":"user","content":"Why is the sky blue?"}],
    "max_tokens": 64,
    "stream": false
  }'
```

### Oumi WebChat endpoints

- `GET /health`
- `GET /v1/oumi/configs` – discover available configs
- `GET /v1/oumi/branches` – list conversation branches
- `POST /v1/oumi/command` – branch/session operations
- `GET /v1/oumi/conversation` – fetch conversation for a branch
- `POST /v1/oumi/regen_node` – regenerate a node
- `GET /v1/oumi/system_stats` – backend system information
- `POST /v1/oumi/clear_model` – unload model from memory

See `backend/oumi/src/oumi/webchat/routes.py` for the full set.

---

## Repository Layout

- `frontend/chatterley` – Desktop application (Electron + Next.js + TypeScript)
- `backend/oumi` – Oumi backend (Python). This directory is currently vendored; it can optionally be switched to a Git submodule pointing at the upstream Oumi repository.

### Submodule Rollout (optional)

- Current: `backend/oumi` is a regular directory (easy cloning, no external dependency).
- Optional: `git submodule add <oumi-remote> backend/oumi && git submodule update --init` to track upstream directly.

---

## Contributing

- Frontend changes: `frontend/chatterley` (see its README & BUILD docs)
- Backend changes: `backend/oumi` (see `CONTRIBUTING.md`, `STYLE_GUIDE.md` inside)

Open an issue or PR with any improvements, especially around packaging and cross‑platform installers.

