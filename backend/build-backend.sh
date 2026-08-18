#!/bin/bash
# Build the frozen backend (PyInstaller onedir) + ad-hoc codesign.
# Ad-hoc signing is REQUIRED: unsigned .so/.dylib files inside _internal
# make dyld hang when loading C extensions (e.g. rapidfuzz) on macOS.
set -e
cd "$(dirname "$0")"

.venv/bin/pyinstaller backend.spec --noconfirm
codesign --force --deep --sign - dist/backend

echo "Backend built + signed at dist/backend"
