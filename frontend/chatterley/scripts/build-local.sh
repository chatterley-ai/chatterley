#!/usr/bin/env bash

###############################################################################
# Local build script for Chatterley Desktop (macOS / Windows / Linux)
# Usage: ./scripts/build-local.sh [platform] [profile]
#   platform: mac | win | win-cpu | win-cuda12.6 | linux | all
#   profile : optional llama wheel profile override (e.g. cpu, cuda12.6)
###############################################################################

set -euo pipefail

# --- Helpers -----------------------------------------------------------------

cleanup_macos_dmg_volume() {
  local product_name version volume

  product_name=$(node -p "(p=> (p.build && p.build.productName) || p.productName || p.name || 'App')(require('./package.json'))" 2>/dev/null || echo "App")
  version=$(node -p "require('./package.json').version" 2>/dev/null || echo "")

  [[ -z "${product_name}" || -z "${version}" ]] && return 0

  volume="/Volumes/${product_name} ${version}"

  if mount | grep -Fq "${volume}"; then
    echo "dY\"O Detaching existing DMG volume: ${volume}"
    hdiutil detach -force "${volume}" || true
  fi

  if [[ -d "${volume}" ]]; then
    echo "dY1 Removing stale volume directory: ${volume}"
    rm -rf "${volume}" || true
  fi
}

# --- Script setup ------------------------------------------------------------

PLATFORM_INPUT=${1:-""}
PROFILE_ARG=${2:-""}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"

cd "${PROJECT_DIR}"

if [[ ! -f package.json ]]; then
  echo "�?O Error: build-local.sh must be run from the frontend directory"
  exit 1
fi

if [[ -n "${PROFILE_ARG}" ]]; then
  export LLAMA_WHEEL_PROFILE="${PROFILE_ARG}"
fi

export LLAMA_WHEEL_PROFILE="${LLAMA_WHEEL_PROFILE:-cpu}"

# Normalize platform name
if [[ -z "${PLATFORM_INPUT}" ]]; then
  PLATFORM_INPUT="$(uname | tr '[:upper:]' '[:lower:]')"
fi

case "${PLATFORM_INPUT}" in
  mac|darwin) PLATFORM="mac" ;;
  win|windows|msys*|mingw*|cygwin*) PLATFORM="win" ;;
  win-cpu) PLATFORM="win-cpu" ;;
  win-cuda12.6) PLATFORM="win-cuda12.6" ;;
  linux|gnu/linux*) PLATFORM="linux" ;;
  all) PLATFORM="all" ;;
  *)
    echo "�?O Unknown platform: ${PLATFORM_INPUT}"
    echo "Supported platforms: mac, win, win-cpu, win-cuda12.6, linux, all"
    exit 1
    ;;
esac

echo "dYs? Building Chatterley Desktop for platform: ${PLATFORM}"
echo "dY\"? Project directory: ${PROJECT_DIR}"

# Ensure dependencies
if [[ ! -d node_modules ]]; then
  echo "dY\"� Installing npm dependencies..."
  npm install
fi

# Clean previous artifacts
if [[ -d dist ]]; then
  echo "dY1 Removing existing dist directory..."
  rm -rf dist
fi

echo "�sT�,? Generating static configs..."
npm run generate-configs

# --- Platform builds ---------------------------------------------------------

build_mac() {
  echo "dY?Z Building for macOS..."
  echo "dYt? Pre-cleaning any stale DMG mounts/symlinks..."
  cleanup_macos_dmg_volume

  export LLAMA_WHEEL_PROFILE="${LLAMA_WHEEL_PROFILE:-mac}"
  echo "dYZ_ Llama wheel profile set to: ${LLAMA_WHEEL_PROFILE}"

  if [[ -z "${DEBUG:-}" ]]; then
    export DEBUG="electron-osx-sign*,electron-builder"
    echo "dY\"Z Debug logging enabled: ${DEBUG}"
  else
    echo "dY\"Z Using existing DEBUG: ${DEBUG}"
  fi

  npm run dist:mac
}

build_win() {
  local profile_msg="Windows"

  case "${1:-}" in
    cpu)
      export LLAMA_WHEEL_PROFILE="cpu"
      profile_msg="Windows (CPU profile)"
      ;;
    cuda12.6|"")
      export LLAMA_WHEEL_PROFILE="${LLAMA_WHEEL_PROFILE:-cuda12.6}"
      profile_msg="Windows (CUDA 12.6 profile)"
      ;;
    *)
      export LLAMA_WHEEL_PROFILE="${1}"
      profile_msg="Windows (${LLAMA_WHEEL_PROFILE} profile)"
      ;;
  esac

  echo "dY?Y Building for ${profile_msg}..."
  echo "dYZ_ Llama wheel profile: ${LLAMA_WHEEL_PROFILE}"
  npm run dist:win
}

build_linux() {
  echo "dY?5 Building for Linux..."
  npm run prepare-python
  node scripts/clear-pycache.js
  npm run build:electron
  npm run electron:compile
  echo "dY\"5 Packaging Debian installers for amd64 and arm64 (AppImage disabled for local build)..."
  npx electron-builder --linux deb --x64 --arm64
}

build_all() {
  echo "dYO? Building for all platforms..."
  echo "dY\"� Downloading Python distributions for all platforms..."
  npm run download-python -- --all-platforms

  # macOS
  export LLAMA_WHEEL_PROFILE="mac"
  build_mac

  # Windows CUDA 12.6
  export LLAMA_WHEEL_PROFILE="cuda12.6"
  build_win "cuda12.6"

  # Linux
  build_linux
}

# --- Dispatch ----------------------------------------------------------------

case "${PLATFORM}" in
  mac) build_mac ;;
  win) build_win ;;
  win-cpu) build_win "cpu" ;;
  win-cuda12.6) build_win "cuda12.6" ;;
  linux) build_linux ;;
  all) build_all ;;
esac

echo "�o. Build completed! Check dist/packages/ for installers."
echo ""
echo "dY\"� Build artifacts:"
if [[ -d dist/packages ]]; then
  ls -la dist/packages/
else
  echo "No build artifacts found."
fi
