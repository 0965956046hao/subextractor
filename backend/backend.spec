# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

hiddenimports = []
hiddenimports += collect_submodules("app")
hiddenimports += [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
]

datas = []
datas += collect_data_files("rapidocr")

a = Analysis(
    ["entry.py"],
    pathex=[os.path.abspath(".")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter", "scipy", "pandas", "matplotlib", "notebook", "IPython",
        "grpc", "grpcio", "google.cloud", "sqlite3", "unittest", "test",
        "pydoc", "ensurepip"
    ],
    noarchive=False,
    optimize=0,
)

# Dylib dedup happens in build-backend.sh: PyInstaller collects FFmpeg dylibs
# both in a.binaries (root _internal, where @rpath resolves) and as package
# data (cv2/.dylibs etc). build-backend.sh promotes the root symlinks to real
# files and drops the redundant .dylibs copies so the Tauri bundler doesn't
# re-materialize them.

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="backend",
)
