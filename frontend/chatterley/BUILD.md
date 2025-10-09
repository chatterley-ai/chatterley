# Chatterley - Build and Distribution Guide

This guide covers building and distributing Chatterley across platforms.

## Quick Start

### Development Build
```bash
# Quick development build (no distribution)
./scripts/dev-build.sh
```

### Production Build
```bash
# Build for current platform
./scripts/build-local.sh

# Build for specific platform
./scripts/build-local.sh mac
./scripts/build-local.sh win
./scripts/build-local.sh linux

# Build for all platforms
./scripts/build-local.sh all
```

## Build Scripts

### NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run dist:mac` | Build macOS DMG |
| `npm run dist:win` | Build Windows NSIS installer and portable |
| `npm run dist:linux` | Build Linux AppImage, DEB, and RPM |
| `npm run dist:all` | Build for all platforms |
| `npm run electron:dev` | Run in development mode |
| `npm run electron:pack` | Package without distribution |

### Shell Scripts

| Script | Description |
|--------|-------------|
| `./scripts/build-local.sh` | Interactive build script |
| `./scripts/dev-build.sh` | Quick development build |
| `./scripts/version.js` | Version management |

## Platform-Specific Builds

### macOS (DMG)
**Requirements:**
- macOS machine (for native builds)
- Xcode Command Line Tools
- Apple Developer ID (for code signing)

**Build:**
```bash
npm run dist:mac
```

**Output:**
- `Chatterley-{version}-mac-{arch}.dmg` - Installer

**Code Signing (Optional):**
Set environment variables:
```bash
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
```

### Windows (NSIS + Portable)
**Requirements:**
- Windows machine or cross-compilation setup
- Microsoft Visual C++ Build Tools 2022 with the **Desktop development with C++** workload (includes CMake, MSVC, Windows SDK)
- Git for Windows (the setup will automatically download a portable copy if `git` is missing)
- Code signing certificate (optional)
- Optional: Prebuilt `llama-cpp-python` wheel from the GitHub Actions workflow (see below)

**Build:**
```bash
npm run dist:win
```

**Output:**
- `Chatterley Setup {version}.exe` - NSIS installer
- `Chatterley {version}.exe` - Portable executable

**Code Signing (Optional):**
Set environment variables:
```bash
export WIN_CSC_LINK="path/to/certificate.p12"
export WIN_CSC_KEY_PASSWORD="certificate-password"
```

**Note:** Bundled Python extras such as `llama_cpp` require a working C++ toolchain. The virtual environment setup attempts to install the `cmake` Python package automatically, but you still need the Visual C++ Build Tools so that MSVC (`cl.exe`) and CMake are available on the PATH.

#### Prebuilt `llama-cpp-python`
- Trigger the **Build llama.cpp wheel (Windows)** workflow (`.github/workflows/build-llamacpp.yml`) from GitHub under the **Actions** tab → select the workflow → **Run workflow**.
- The workflow builds wheels for Python 3.11, 3.12, and 3.13. Download each artifact (`llama-cpp-python-win-wheel-py3.11`, `...-py3.12`, `...-py3.13`) once it completes and extract the `.whl` files inside.
- Organise the wheels by profile:
  - CPU: `frontend/chatterley/python-wheels/cpu/`
  - CUDA 12.4: `frontend/chatterley/python-wheels/cuda12.4/`
  - CUDA 12.6: `frontend/chatterley/python-wheels/cuda12.6/`
  (filenames still start with `llama_cpp_python`)
- The app detects the wheel matching the Python runtime version and installs the wheel from the active profile (see below). If no wheel is found, it falls back to building from source (requiring the toolchain above).

#### CUDA-enabled builds (optional)
- The same workflow now runs a CUDA job matrix. For each Python version (3.11–3.13) and CUDA runtime (12.4, 12.6) it uploads:
  - `llama-cpp-python-win-wheel-cuda12.4-pyX.Y`
  - `llama-cpp-python-win-wheel-cuda12.6-pyX.Y`
  - Runtime bundles: `cuda-runtime-v12.4`, `cuda-runtime-v12.6` (only once per run)
- After the workflow finishes:
  1. Download the wheel artifacts you need and place the `.whl` files in the matching profile directory listed above.
  2. Download the CUDA runtime bundles and extract them into `frontend/chatterley/windows-runners/cuda_v12.4/` and `.../cuda_v12.6/`. Each folder should contain a `bin/` directory with NVIDIA DLLs (and the accompanying license files).
- The packaged app will ship these resources so the Windows runtime can choose between CPU and CUDA runners without requiring the end user to install the CUDA toolkit.

#### Selecting a wheel profile when building
- Use the `LLAMA_WHEEL_PROFILE` environment variable (values: `cpu`, `cuda12.4`, `cuda12.6`).
- `./scripts/build-local.sh win <profile>` automatically exports the profile for you:
  ```bash
  ./scripts/build-local.sh win cpu        # CPU-only build
  ./scripts/build-local.sh win cuda12.4   # CUDA 12.4 wheel + runtime
  ./scripts/build-local.sh win cuda12.6   # CUDA 12.6 wheel + runtime
  ```
- If you call the script without a profile it defaults to `cpu`. The `all` target uses whichever profile is active in `LLAMA_WHEEL_PROFILE`.

#### Prebuilt `vLLM` wheels
- Trigger the **Build vLLM wheel (Windows)** workflow (`.github/workflows/build-vllm-windows.yml`).
- By default it builds wheels for Python 3.11–3.13 targeting CUDA 12.6. Each run uploads artifacts named `vllm-windows-wheel-cu126-py3.11`, etc.
- Extract the wheels into `frontend/chatterley/python-wheels/vllm/cuda12.6/`.
- The environment setup will install the bundled wheel automatically on Windows when the GPU extras are selected (no Git required).

### Linux (AppImage + DEB + RPM)
**Requirements:**
- Linux machine
- Standard build tools (`build-essential`)

**Build:**
```bash
npm run dist:linux
```

**Output:**
- `Chatterley-{version}.AppImage` - Universal Linux app
- `chatterley_{version}_amd64.deb` - Debian package
- `chatterley-{version}.x86_64.rpm` - Red Hat package

## Auto-Update System

Chatterley includes automatic updates using `electron-updater`:

### Configuration
Updates are configured in `package.json`:
```json
{
  "publish": [
    {
      "provider": "github",
      "owner": "oumi-ai",
      "repo": "oumi-chat-desktop"
    }
  ]
}
```

### Update Flow
1. App checks for updates on startup (production only)
2. Downloads updates in background
3. Notifies user when ready
4. Installs on next app restart

### Manual Update Check
Users can check for updates via:
- **macOS**: `Chatterley` → `Check for Updates`
- **Windows/Linux**: `Help` → `Check for Updates`

Note: macOS auto-updates typically use a `.zip` artifact. With only `dmg` builds, differential/mac auto-update may not function. Keep a mac `zip` target if you rely on auto-updates.

## Version Management

### Update Version
```bash
# Increment patch version (1.0.0 -> 1.0.1)
node scripts/version.js patch

# Increment minor version (1.0.0 -> 1.1.0)
node scripts/version.js minor

# Increment major version (1.0.0 -> 2.0.0)
node scripts/version.js major

# Set specific version
node scripts/version.js 1.2.3

# Show current version
node scripts/version.js --current
```

### Release Process
1. Update version: `node scripts/version.js patch`
2. Test build locally: `./scripts/build-local.sh`
3. Push to GitHub: `git push origin main --tags`
4. GitHub Actions builds and creates release automatically

## CI/CD Pipeline

GitHub Actions automatically builds releases when tags are pushed:

### Workflow Triggers
- **Tags**: `v*` (e.g., `v1.0.0`)
- **Manual**: Workflow dispatch

### Build Matrix
- **macOS**: Latest (Intel + Apple Silicon)
- **Windows**: Latest (x64)
- **Linux**: Latest (x64)

### Artifacts
- Automatically uploaded to GitHub Releases
- Available as build artifacts for 30 days

## Configuration Files

### Core Configuration
- `package.json` - Main electron-builder configuration
- `build/entitlements.mac.plist` - macOS security entitlements
- Notarization is handled automatically by electron-builder when env vars are set

### Build Resources
```
build/
├── entitlements.mac.plist    # macOS entitlements
└── icon.{icns,ico,png}      # Platform-specific icons (create these)

assets/
├── icon.icns               # macOS icon
├── icon.ico                # Windows icon
└── icon.png                # Linux icon
```

## Troubleshooting

### Common Issues

#### "Cannot find module" errors
```bash
# Clean and reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

#### macOS Gatekeeper issues
```bash
# Remove quarantine attribute
xattr -cr "/path/to/Chatterley.app"
```

#### Windows SmartScreen warnings
- Builds need to be code-signed to avoid warnings
- Submit to Microsoft for reputation building

#### Linux permission errors
```bash
# Make AppImage executable
chmod +x "Chatterley-*.AppImage"
```

### Debug Builds
```bash
# Build with debug info
DEBUG=electron-builder npm run dist:mac

# Build directory only (no packaging)
npm run electron:pack -- --dir
```

### Build Logs
- **Location**: `~/Library/Logs/Chatterley/` (macOS)
- **Location**: `%APPDATA%/Chatterley/logs/` (Windows)  
- **Location**: `~/.config/Chatterley/logs/` (Linux)

## Security Considerations

### Code Signing
- **macOS**: Prevents "Unknown Developer" warnings
- **Windows**: Prevents SmartScreen warnings
- **Required**: For distribution and auto-updates

### Notarization (macOS)
- **Required**: For macOS 10.15+ compatibility
- **Process**: Automatic via `scripts/notarize.js`
- **Requirements**: Apple Developer account

### Sandboxing
- **Status**: Disabled (Python integration requires full access)
- **Alternative**: Hardened Runtime with entitlements

## Performance Optimization

### Build Size Reduction
- Excludes dev dependencies and test files
- Compresses with maximum settings
- Filters unnecessary Python cache files

### Bundle Analysis
```bash
# Analyze bundle size
npx electron-builder --publish=never --analyze
```

## Support Matrix

| Platform | Architecture | Status | Notes |
|----------|-------------|--------|-------|
| macOS | x64 | ❌ | Not supported |
| macOS | arm64 | ✅ | Apple Silicon |
| Windows | x64 | ✅ | Windows 10+ |
| Windows | arm64 | ⚠️ | Experimental |
| Linux | x64 | ✅ | Ubuntu 18.04+ |
| Linux | arm64 | ❌ | Not supported |

## Resources

- [electron-builder Documentation](https://www.electron.build/)
- [electron-updater Documentation](https://github.com/electron-userland/electron-updater)
- [Apple Code Signing Guide](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [Windows Code Signing Guide](https://docs.microsoft.com/en-us/windows/msix/package/sign-app-package-using-signtool)
