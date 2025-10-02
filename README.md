<div align="center">
  <img alt="Chatterley" width="240" src="frontend/chatterley/public/images/chatterley-logo.png">
</div>

# Chatterley

Chatterley is a pretty, private, powerful, local-first desktop AI chat app for MacOS, Windows and Linux, supporting gpt-oss, DeepSeek-R1, Gemma 3, Qwen3 Coder, Qwen3 Omni, GPT-5, Claude Sonnet 4.5, and more. 

## Project Philosophy

* **Local-first.** While we love closed models, Chatterley is designed as a local-first experience. We will maintain strong support for local backends.
* **Private.** We take data privacy seriously. After first-run installation and model downloading, Chatterley works normally when you're offline. We will never add any telemetry, ads, or user tracking, and Chatterley will never require an internet connection to run.
* **Fully open source.** We are and will remain completely open source. Furthermore, we release our code under the highly permissive Apache 2.0 License to encourage further experimentation.

## Why Chatterley?

* **Any model, any backend, anytime.** Chatterley supports dynamic model swapping mid-chat, allowing for quick experimentation and A/B testing of nearly any open or closed model. Swap between any supported backend (VLLM, SGLang, LlamaCPP, Native) and run speed comparisons in your local environment. Compare GGUF checkpoint response quality. All without leaving the chat.
* **Branch your chat.** Chatterley supports chat branching. Try out new ideas or follow new threads, without having to start over or leave your active chat.
* **WYSIWYG edit your chat.** Edit user turns and model responses just like you're editing a Word document.
* **Save and load your chat.** Save and load chats in compliant JSON for easy transfer to other platforms.
* **Search your chat.** Chatterley maintains a searchable database of all your old chats so you can find that conversation from three months ago.
* **Chat with any type of data.** Why limit yourself to text? Chatterley allows you to attach images, videos, audio, fetch websites, load PDFs ...
* **Generate images.** Want to generate images too? Chatterley can do that. Run image synthesis (local-only) without leaving the chat interface.
* **Chat in style.** Chatterley allows extensive customization of the chat experience; design your own color palettes, change the font, change the text size.

## Under the Hood

This section contains some technical details about Chatterley for those who are interested in diving deeper into the interface or becoming contributors.

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

If you're interested in contributing, please open an issue or submit a PR with improvements. We are particularly interested in contributors with strong backgrounds in Node.JS, frontend devs, UI specialists, UX specialists, and technical writers.
