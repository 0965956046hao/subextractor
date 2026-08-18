#!/bin/bash
# Build the frozen demucs CLI (PyInstaller onedir) + ad-hoc codesign.
# Requires .venv-demucs (see below). demucs/torch are HUGE; keep them OUT
# of the backend build, hence a dedicated venv + binary.
set -e
cd "$(dirname "$0")"

if [ ! -x .venv-demucs/bin/pyinstaller ]; then
    echo "Missing .venv-demucs. Bootstrap:"
    echo "  python3 -m venv .venv-demucs"
    echo "  .venv-demucs/bin/pip install demucs numpy pyinstaller pyinstaller-hooks-contrib"
    exit 1
fi

.venv-demucs/bin/pyinstaller demucs.spec --noconfirm
codesign --force --deep --sign - dist/demucs

echo "Demucs built + signed at dist/demucs"
