#!/usr/bin/env python3
"""Patch vLLM setup.py for Windows builds."""
import sys
from pathlib import Path

target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("setup.py")
if not target.exists():
    raise SystemExit(f"Target setup.py not found at: {target}")

text = target.read_text()

old_nvcc = (
    "            if IS_WINDOWS:\n"
    "                cmake_args += [f'-DCMAKE_CUDA_COMPILER={CUDA_HOME.replace(\"\\\\\\\\\", \"/\")}/bin/nvcc.exe']"
)
new_nvcc = (
    "            if IS_WINDOWS:\n"
    "                cuda_home_normalized = Path(CUDA_HOME).as_posix()\n"
    "                cmake_args += [f'-DCMAKE_CUDA_COMPILER={cuda_home_normalized}/bin/nvcc.exe']"
)
if old_nvcc not in text:
    raise SystemExit('Expected nvcc snippet not found in setup.py')
text = text.replace(old_nvcc, new_nvcc)

if "from pathlib import Path" not in text:
    import_hook = "import os\n"
    if import_hook in text:
        text = text.replace(import_hook, import_hook + "from pathlib import Path\n", 1)
    else:
        text = text.replace(
            "import sys\n", "import sys\nfrom pathlib import Path\n", 1
        )

needle = "        cmake_args += ['-DFETCHCONTENT_BASE_DIR={}'.format(fc_base_dir)]\n"
arch_line = "        cmake_args += ['-DCMAKE_CUDA_ARCHITECTURES=80;86;89;90']\n"
if needle not in text:
    raise SystemExit('Expected fetch content snippet not found in setup.py')
if arch_line.strip() not in text:
    text = text.replace(needle, needle + arch_line)
else:
    print('Existing CMAKE_CUDA_ARCHITECTURES entry detected; leaving as-is')

target.write_text(text)
print('Patched setup.py (nvcc path + CUDA architectures).')
