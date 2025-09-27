# Chatterley Monorepo

This repository hosts the Chatterley desktop application alongside the Oumi backend that powers it. The codebase is being reorganized to keep the platform layers isolated while preserving cross-project workflows.

## Repository layout
- `frontend/chatterley` – Next.js + Electron application that packages the Chatterley desktop client.
- `backend/oumi` – Oumi backend (Python) that serves models and APIs for the desktop app. This directory will become a Git submodule pointing at the upstream Oumi repository.

## Getting started
1. Clone the repository.
2. (Temporarily) pull backend dependencies directly from `backend/oumi`. A follow-up step will convert this folder into a Git submodule (see **Submodule rollout** below).
3. Set up the backend by following the instructions in `backend/oumi/README.md` (conda environment, Python dependencies, etc.).
4. Set up the frontend by following `frontend/chatterley/README.md` (Node.js install, Electron build targets, etc.).
5. For local development, start the backend (`python -m oumi.webchat.server`) from `backend/oumi`, then run `npm run dev` from `frontend/chatterley`.

## Submodule rollout
- **Current state**: `backend/oumi` is still a normal directory so no history is lost during the transition.
- **Next step**: once the upstream Oumi repository URL is confirmed, replace the directory with `git submodule add <oumi-remote> backend/oumi` and run `git submodule update --init`.
- **Contributor note**: after the switch, contributors will need to run `git submodule update --init --recursive` when cloning.

## Additional documentation
- Backend contribution guides: `backend/oumi/CONTRIBUTING.md`
- Backend coding standards: `backend/oumi/STYLE_GUIDE.md`
- Frontend documentation: `frontend/chatterley/README.md` and `frontend/chatterley/BUILD.md`

Have suggestions for smoothing the transition? Open an issue or PR so we can coordinate the last-mile submodule work.
