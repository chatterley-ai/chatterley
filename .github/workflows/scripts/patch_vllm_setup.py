#!/usr/bin/env python3
"""Patch vLLM setup.py for Windows builds."""
import sys
from pathlib import Path


def ensure_pathlib_import(lines: list[str]) -> None:
    """Insert `from pathlib import Path` if it is not already present."""
    if any("from pathlib import Path" in line for line in lines):
        return

    inserted = False

    for idx, line in enumerate(lines):
        if line.strip() == "import os":
            lines.insert(idx + 1, "from pathlib import Path")
            inserted = True
            break

    if not inserted:
        for idx, line in enumerate(lines):
            if line.startswith("import "):
                lines.insert(idx + 1, "from pathlib import Path")
                inserted = True
                break

    if not inserted:
        lines.insert(0, "from pathlib import Path")


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("setup.py")
    if not target.exists():
        raise SystemExit(f"Target setup.py not found at: {target}")

    original_text = target.read_text()
    lines = original_text.splitlines()
    trailing_newline = original_text.endswith("\n")

    replaced_nvcc = False
    for idx, line in enumerate(lines):
        if line.strip() == "if IS_WINDOWS:" and idx + 1 < len(lines):
            next_line = lines[idx + 1]
            if (
                "CMAKE_CUDA_COMPILER" in next_line
                and "CUDA_HOME.replace" in next_line
                and "nvcc.exe" in next_line
            ):
                indent = next_line[: len(next_line) - len(next_line.lstrip())]
                lines[idx + 1 : idx + 2] = [
                    f"{indent}cuda_home_normalized = Path(CUDA_HOME).as_posix()",
                    f"{indent}cmake_args += [f'-DCMAKE_CUDA_COMPILER={{cuda_home_normalized}}/bin/nvcc.exe']",
                ]
                replaced_nvcc = True
                break

    if not replaced_nvcc:
        raise SystemExit("Expected nvcc snippet not found in setup.py")

    ensure_pathlib_import(lines)

    fetch_idx = next(
        (idx for idx, line in enumerate(lines) if "-DFETCHCONTENT_BASE_DIR" in line),
        None,
    )
    if fetch_idx is None:
        raise SystemExit("Expected fetch content snippet not found in setup.py")

    if any("-DCMAKE_CUDA_ARCHITECTURES=" in line for line in lines):
        print("Existing CMAKE_CUDA_ARCHITECTURES entry detected; leaving as-is")
    else:
        indent = lines[fetch_idx][: len(lines[fetch_idx]) - len(lines[fetch_idx].lstrip())]
        lines.insert(
            fetch_idx + 1,
            f"{indent}cmake_args += ['-DCMAKE_CUDA_ARCHITECTURES=80;86;89;90']",
        )

    new_text = "\n".join(lines)
    if trailing_newline:
        new_text += "\n"

    target.write_text(new_text)
    print("Patched setup.py (nvcc path + CUDA architectures).")


if __name__ == "__main__":
    main()
