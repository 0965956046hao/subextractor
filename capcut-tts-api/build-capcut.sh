#!/bin/bash
# Build the frozen CapCut TTS service (PyInstaller onedir) + ad-hoc codesign.
set -e
cd "$(dirname "$0")"

../backend/.venv/bin/pyinstaller capcut.spec --noconfirm --distpath dist
codesign --force --deep --sign - dist/capcut-tts-api

echo "CapCut service built + signed at dist/capcut-tts-api"
