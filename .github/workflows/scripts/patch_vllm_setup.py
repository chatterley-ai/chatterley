#!/usr/bin/env python3
"""
Patch vLLM setup.py to normalize CUDA_HOME path on Windows.
This fixes issues with backslashes in CMake CUDA compiler paths.
"""
from pathlib import Path

path = Path('setup.py')
text = path.read_text()

# Original problematic line with inline path replacement
old = "            if IS_WINDOWS:\n                cmake_args += [f'-DCMAKE_CUDA_COMPILER={CUDA_HOME.replace(\"\\\\\", \"/\")}/bin/nvcc.exe']"

# Fixed version with separate normalization step
new = "            if IS_WINDOWS:\n                cuda_home_normalized = CUDA_HOME.replace('\\\\', '/')\n                cmake_args += [f'-DCMAKE_CUDA_COMPILER={cuda_home_normalized}/bin/nvcc.exe']"

if old not in text:
    raise SystemExit('Expected snippet not found in setup.py')

path.write_text(text.replace(old, new))
print("Successfully patched setup.py for CUDA_HOME path normalization")
