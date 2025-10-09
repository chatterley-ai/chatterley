#!/usr/bin/env python3
"""Append/override CMAKE_CUDA_ARCHITECTURES inside setup.py."""
from pathlib import Path

path = Path('setup.py')
text = path.read_text()
needle = "        cmake_args += ['-DFETCHCONTENT_BASE_DIR={}'.format(fc_base_dir)]\n"
replacement = needle + "        cmake_args += ['-DCMAKE_CUDA_ARCHITECTURES=80;86;89;90']\n"
if needle not in text:
    raise SystemExit('Expected fetch content snippet not found in setup.py')
if "-DCMAKE_CUDA_ARCHITECTURES" in text:
    raise SystemExit('setup.py already defines CMAKE_CUDA_ARCHITECTURES')
path.write_text(text.replace(needle, replacement))
print('Inserted fixed CUDA architectures into setup.py')
