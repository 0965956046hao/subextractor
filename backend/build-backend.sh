#!/bin/bash
# Build the frozen backend (PyInstaller onedir) + ad-hoc codesign.
# Ad-hoc signing is REQUIRED: unsigned .so/.dylib files inside _internal
# make dyld hang when loading C extensions (e.g. rapidfuzz) on macOS.
set -e
cd "$(dirname "$0")"

.venv/bin/pyinstaller backend.spec --noconfirm

# Deduplicate dylibs: every dylib reference is @rpath (resolved against the
# _internal root), so the cv2/.dylibs, PIL/.dylibs, shapely/.dylibs copies are
# redundant. Materialize the root symlinks PyInstaller created and drop the
# .dylibs copies. Without this, the Tauri bundler resolves the symlinks into
# real files and the app would carry ~90MB of duplicates.
INTERNAL=dist/backend/_internal
python3 - "$INTERNAL" <<'PYEOF'
import os, shutil, sys
base = sys.argv[1]
removed = 0
saved = 0
for name in os.listdir(base):
    p = os.path.join(base, name)
    if not os.path.islink(p):
        continue
    target = os.readlink(p)
    if not target.startswith(("cv2/.dylibs/", "PIL/.dylibs/", "shapely/.dylibs/")):
        continue
    real = os.path.join(base, target)
    if not os.path.exists(real):
        continue
    saved += os.path.getsize(real)
    os.remove(p)                      # drop the symlink
    shutil.move(real, p)              # promote the real file to root
    removed += 1
print(f"Dedup: materialized {removed} root symlinks, removed {saved/1e6:.1f} MB of .dylibs copies")
PYEOF

# Drop any remaining hard duplicates: .dylibs files identical to a root file
# are unreferenced (@rpath resolves against root). Remove them so the Tauri
# bundler doesn't carry both copies in the app.
python3 - "$INTERNAL" <<'PYEOF'
import os, shutil, sys
base = sys.argv[1]
for sub in ("cv2/.dylibs", "PIL/.dylibs", "shapely/.dylibs"):
    d = os.path.join(base, sub)
    if not os.path.isdir(d):
        continue
    for f in os.listdir(d):
        root_p = os.path.join(base, f)
        sub_p = os.path.join(d, f)
        if os.path.isfile(root_p) and os.path.isfile(sub_p) and os.path.getsize(root_p) == os.path.getsize(sub_p):
            if open(root_p, 'rb').read() == open(sub_p, 'rb').read():
                os.remove(sub_p)
print("Removed remaining identical .dylibs duplicates")
PYEOF

codesign --force --deep --sign - dist/backend

echo "Backend built + signed at dist/backend"
