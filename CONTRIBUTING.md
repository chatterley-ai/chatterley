# Contributing

Thanks for helping improve Chatterley! This repository now splits the desktop app and backend into separate workspaces.

- Frontend changes live in `frontend/chatterley`. Follow the setup and workflow documented in `frontend/chatterley/README.md`.
- Backend changes belong in `backend/oumi`. That directory tracks the upstream [Oumi](https://github.com/oumi-ai/oumi) project; consult `backend/oumi/CONTRIBUTING.md` and `backend/oumi/STYLE_GUIDE.md` before opening a PR.

When the backend folder is converted into a Git submodule, make sure to commit backend changes inside the submodule and update the parent repository with the new submodule reference.

If you have questions about the restructure or submodule migration, please open an issue so the maintainers can coordinate the rollout.
