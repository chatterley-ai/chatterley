#!/usr/bin/env python3
"""
Build llama-cpp-python 0.3.16 from source using Python 3.12 and drop the wheel
into the same directory as this script.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


PROJECT_VERSION = "0.3.16"
PACKAGE_NAME = "llama-cpp-python"


def run(cmd: list[str], *, env: dict[str, str] | None = None) -> None:
    """Run a subprocess, streaming output and raising on failure."""
    print(f"+ {' '.join(cmd)}")
    subprocess.run(cmd, check=True, env=env)


def resolve_python312() -> Path:
    """Locate the python3.12 executable."""
    candidate = shutil.which("python3.12")
    if not candidate:
        raise SystemExit(
            "python3.12 not found in PATH. Install Python 3.12 or adjust PATH."
        )
    return Path(candidate)


def create_venv(python312: Path, workdir: Path) -> Path:
    """Create a temporary virtual environment using the requested interpreter."""
    venv_dir = workdir / "venv"
    run([str(python312), "-m", "venv", str(venv_dir)])
    return venv_dir


def python_bin_from_venv(venv_dir: Path, binary: str) -> Path:
    """Return the path to a binary inside the venv, supporting Windows/macOS/Linux."""
    if os.name == "nt":
        return venv_dir / "Scripts" / f"{binary}.exe"
    return venv_dir / "bin" / binary


def build_wheel(venv_dir: Path, output_dir: Path) -> Path:
    """Build the wheel using pip wheel with --no-binary to ensure source build."""
    pip_bin = python_bin_from_venv(venv_dir, "pip")
    env_python = python_bin_from_venv(venv_dir, "python")

    # Fresh tooling in the build environment.
    run([str(pip_bin), "install", "--upgrade", "pip"])
    run([str(pip_bin), "install", "setuptools", "wheel", "cmake"])

    # Force a source build of the specific version we want.
    build_env = dict(os.environ)
    build_env["PYTHONNOUSERSITE"] = "1"

    run(
        [
            str(pip_bin),
            "wheel",
            f"{PACKAGE_NAME}=={PROJECT_VERSION}",
            "--no-binary",
            ":all:",
            "--wheel-dir",
            str(output_dir),
        ],
        env=build_env,
    )

    # Determine the wheel path to report it back to the caller.
    wheel_pattern = f"{PACKAGE_NAME.replace('-', '_')}-{PROJECT_VERSION}-*.whl"
    built_wheels = sorted(output_dir.glob(wheel_pattern))
    if not built_wheels:
        raise SystemExit("Wheel build completed but no wheel found in output directory.")

    return built_wheels[-1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build llama-cpp-python 0.3.16 from source using Python 3.12 and store "
            "the resulting wheel in the scripts directory."
        )
    )
    parser.add_argument(
        "--keep-workdir",
        action="store_true",
        help="Preserve the temporary build directory for inspection.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    scripts_dir = Path(__file__).resolve().parent
    python312 = resolve_python312()

    with tempfile.TemporaryDirectory(prefix="llamacpp-build-") as tmp:
        workdir = Path(tmp)
        venv_dir = create_venv(python312, workdir)
        wheel_path = build_wheel(venv_dir, scripts_dir)
        print(f"Built wheel: {wheel_path}")

        if args.keep_workdir:
            kept_path = scripts_dir / f"{workdir.name}"
            print(f"--keep-workdir requested; moving {workdir} -> {kept_path}")
            shutil.move(str(workdir), kept_path)
            return

    print("Temporary build directory cleaned up.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        raise SystemExit(
            f"Command failed with exit code {exc.returncode}: {' '.join(exc.cmd)}"
        ) from exc
