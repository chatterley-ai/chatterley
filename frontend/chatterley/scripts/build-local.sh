#!/bin/bash

# Local build script for Chatterley Desktop
# Usage: ./scripts/build-local.sh [platform]
# Platforms: mac, win, linux, all

set -e

PLATFORM=${1:-"$(uname | tr '[:upper:]' '[:lower:]')"}
PROFILE_ARG=${2:-}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -z "${LLAMA_WHEEL_PROFILE:-}" && -n "$PROFILE_ARG" ]]; then
    export LLAMA_WHEEL_PROFILE="$PROFILE_ARG"
fi

if [[ -z "${LLAMA_WHEEL_PROFILE:-}" ]]; then
    export LLAMA_WHEEL_PROFILE="cpu"
fi

if [[ -z "${VLLM_WHEEL_PROFILE:-}" ]]; then
    export VLLM_WHEEL_PROFILE="$LLAMA_WHEEL_PROFILE"
fi

# Best-effort cleanup so rebuilds don't fail on existing artifacts/symlinks
cleanup_macos_dmg_volume() {
    # Determine product name and version from package.json
    local product_name
    local version
    product_name=$(node -p "(p=> (p.build && p.build.productName) || p.productName || p.name || 'App')(require('./package.json'))" 2>/dev/null || echo "App")
    version=$(node -p "require('./package.json').version" 2>/dev/null || echo "")

    # If we couldn't determine, do nothing
    if [[ -z "$product_name" || -z "$version" ]]; then
        return 0
    fi

    local volume="/Volumes/${product_name} ${version}"

    # Detach if mounted
    if mount | grep -Fq "$volume"; then
        echo "🔌 Detaching existing DMG volume: $volume"
        hdiutil detach -force "$volume" || true
    fi

    # Remove any stale mount directory or symlinks inside
    if [[ -d "$volume" ]]; then
        echo "🧹 Removing stale volume directory: $volume"
        rm -rf "$volume" || true
    fi
}

sign_macos_llama_wheel() {
    local wheel_dir="$PROJECT_DIR/python-wheels/mac"
    local wheel_path
    wheel_path=$(find "$wheel_dir" -maxdepth 1 -type f -name 'llama_cpp_python-*.whl' | head -n 1 || true)

    if [[ -z "$wheel_path" ]]; then
        echo "ℹ️  No mac llama.cpp wheel found to sign (expected in $wheel_dir)."
        return 0
    fi

    local identity="${APPLE_CODESIGN_IDENTITY:-${CSC_NAME:-${MAC_CODESIGN_NAME:-}}}"
    if [[ -z "$identity" ]]; then
        echo "⚠️  Skipping llama.cpp wheel signing: no macOS code signing identity provided (APPLE_CODESIGN_IDENTITY / CSC_NAME)."
        return 0
    fi

    echo "🪪 Signing bundled llama.cpp wheel with identity: $identity"
    local temp_dir
    temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/llama-wheel-XXXXXXXX") || {
        echo "❌ Failed to create temporary directory for wheel signing."
        return 1
    }

    cleanup() { rm -rf "$temp_dir"; }
    trap cleanup EXIT

    unzip -q "$wheel_path" -d "$temp_dir"

    while IFS= read -r -d '' dylib; do
        echo "  • codesign $(basename "$dylib")"
        codesign --force --options runtime --timestamp --sign "$identity" "$dylib"
    done < <(find "$temp_dir" -type f -name '*.dylib' -print0)

    local new_wheel="${wheel_path}.signed"
    (cd "$temp_dir" && zip -qr "$new_wheel" .)
    mv "$new_wheel" "$wheel_path"

    rm -rf "$temp_dir"
    trap - EXIT
    echo "✅ llama.cpp wheel signed and repacked: $(basename "$wheel_path")"
}

echo "🚀 Building Chatterley Desktop for platform: $PLATFORM"
echo "📁 Project directory: $PROJECT_DIR"

cd "$PROJECT_DIR"

# Check if we're in the frontend directory
if [[ ! -f "package.json" ]]; then
    echo "❌ Error: Must run from frontend directory"
    exit 1
fi

# Install dependencies if needed
if [[ ! -d "node_modules" ]]; then
    echo "📦 Installing npm dependencies..."
    npm install
fi

# Clean existing build artifacts
if [[ -d "dist" ]]; then
    echo "🧹 Removing existing dist directory..."
    rm -rf dist
fi

# Generate static configs
echo "⚙️ Generating static configs..."
npm run generate-configs

# Download Python distributions based on platform
case "$PLATFORM" in
    "mac" | "darwin")
        echo "🍎 Building for macOS..."
        echo "🧽 Pre-cleaning any stale DMG mounts/symlinks..."
        cleanup_macos_dmg_volume
        if [[ -z "${LLAMA_WHEEL_PROFILE:-}" ]]; then
            export LLAMA_WHEEL_PROFILE="mac"
            echo "🎯 Llama wheel profile set to: ${LLAMA_WHEEL_PROFILE}"
        else
            echo "🎯 Using existing Llama wheel profile: ${LLAMA_WHEEL_PROFILE}"
        fi
        # Enable detailed signing/build logs unless DEBUG is already set by the user
        if [[ -z "${DEBUG:-}" ]]; then
            export DEBUG="electron-osx-sign*,electron-builder"
            echo "🔎 Debug logging enabled: $DEBUG"
        else
            echo "🔎 Using existing DEBUG: $DEBUG"
        fi
        sign_macos_llama_wheel
        npm run dist:mac
        ;;
    "win" | "windows" | "win-cpu" | "win-cuda12.4" | "win-cuda12.6")
        case "$PLATFORM" in
            win-cpu) export LLAMA_WHEEL_PROFILE="cpu" ;;
            win-cuda12.4) export LLAMA_WHEEL_PROFILE="cuda12.4" ;;
            win-cuda12.6) export LLAMA_WHEEL_PROFILE="cuda12.6" ;;
        esac
        export VLLM_WHEEL_PROFILE="${VLLM_WHEEL_PROFILE:-$LLAMA_WHEEL_PROFILE}"
        echo "🪟 Building for Windows..."
        echo "🎯 Llama wheel profile: ${LLAMA_WHEEL_PROFILE}"
        echo "🎯 vLLM wheel profile: ${VLLM_WHEEL_PROFILE}"
        npm run dist:win
        ;;
    "linux")
        echo "🐧 Building for Linux..."
        npm run dist:linux
        ;;
    "all")
        echo "🌍 Building for all platforms..."
        echo "📦 Downloading Python distributions for all platforms..."
        npm run download-python -- --all-platforms
        echo "🍎 Building macOS packages..."
        echo "🧽 Pre-cleaning any stale DMG mounts/symlinks..."
        cleanup_macos_dmg_volume
        if [[ -z "${LLAMA_WHEEL_PROFILE:-}" ]]; then
            export LLAMA_WHEEL_PROFILE="mac"
        fi
        echo "🎯 Llama wheel profile (mac): ${LLAMA_WHEEL_PROFILE}"
        if [[ -z "${DEBUG:-}" ]]; then
            export DEBUG="electron-osx-sign*,electron-builder"
            echo "🔎 Debug logging enabled: $DEBUG"
        else
            echo "🔎 Using existing DEBUG: $DEBUG"
        fi
        sign_macos_llama_wheel
        npm run dist:mac
        if [[ "${LLAMA_WHEEL_PROFILE}" == "mac" ]]; then
            export LLAMA_WHEEL_PROFILE="cpu"
        fi
        echo "🪟 Building Windows packages (profile: ${LLAMA_WHEEL_PROFILE})..."
        export VLLM_WHEEL_PROFILE="${VLLM_WHEEL_PROFILE:-$LLAMA_WHEEL_PROFILE}"
        npm run dist:win
        echo "🐧 Building Linux packages..."
        npm run dist:linux
        ;;
    *)
        echo "❌ Unknown platform: $PLATFORM"
        echo "Supported platforms: mac, win, linux, all"
        exit 1
        ;;
esac

echo "✅ Build completed! Check dist/packages/ for installers."

# Show build artifacts
echo ""
echo "📦 Build artifacts:"
if [[ -d "dist/packages" ]]; then
    ls -la dist/packages/
else
    echo "No build artifacts found."
fi
