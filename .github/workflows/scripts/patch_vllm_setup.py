#!/usr/bin/env python3
"""Patch vLLM setup.py for Windows builds."""
from pathlib import Path

path = Path('setup.py')
text = path.read_text()

old_nvcc = "            if IS_WINDOWS:\n                cmake_args += [f'-DCMAKE_CUDA_COMPILER={CUDA_HOME.replace(\\"\\\\\\", \\"/\\")}/bin/nvcc.exe']"
new_nvcc = "            if IS_WINDOWS:\n                cuda_home_normalized = CUDA_HOME.replace('\\\\', '/')\n                cmake_args += [f'-DCMAKE_CUDA_COMPILER={cuda_home_normalized}/bin/nvcc.exe']"
if old_nvcc not in text:
    raise SystemExit('Expected nvcc snippet not found in setup.py')
text = text.replace(old_nvcc, new_nvcc)

needle = "        cmake_args += ['-DFETCHCONTENT_BASE_DIR={}'.format(fc_base_dir)]\n"
arch_line = "        cmake_args += ['-DCMAKE_CUDA_ARCHITECTURES=80;86;89;90']\n"
if needle not in text:
    raise SystemExit('Expected fetch content snippet not found in setup.py')
if arch_line.strip() not in text:
    text = text.replace(needle, needle + arch_line)
else:
    print('Existing CMAKE_CUDA_ARCHITECTURES entry detected; leaving as-is')

path.write_text(text)
print('Patched setup.py (nvcc path + CUDA architectures).')
