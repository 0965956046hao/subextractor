#!/bin/bash
# Pack the runtime tools into downloadable archives for the first-run
# downloader (src-tauri/src/tools.rs). Upload the archives in tools-dist/ to
# your host and set STE_TOOLS_URL (or edit DEFAULT_TOOLS_URL in tools.rs).
set -e
cd "$(dirname "$0")"

OUT="${1:-tools-dist}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
TOOLS="src-tauri/resources/tools"
mkdir -p "$TOOLS"

# Stage the tools that normally ship via tauri resources (not built in place).
if [ ! -x "$TOOLS/youtubeuploader" ]; then
    if [ -x youtubeuploader/youtubeuploader ]; then
        echo "Staging youtubeuploader..."
        cp youtubeuploader/youtubeuploader "$TOOLS/youtubeuploader"
    else
        echo "ERROR: missing youtubeuploader/youtubeuploader" >&2
        exit 1
    fi
fi

if [ ! -d "$TOOLS/demucs" ]; then
    if [ -d backend/dist/demucs ]; then
        echo "Staging demucs from backend/dist/demucs..."
        cp -r backend/dist/demucs "$TOOLS/demucs"
    else
        echo "ERROR: missing backend/dist/demucs. Run backend/build-demucs.sh first." >&2
        exit 1
    fi
fi

if [ ! -x "$TOOLS/ffmpeg" ]; then
    echo "ERROR: missing $TOOLS/ffmpeg" >&2
    exit 1
fi

(cd "$TOOLS" && tar -czf "$OUT/ffmpeg.tar.gz" ffmpeg lib)
(cd "$TOOLS" && tar -czf "$OUT/demucs.tar.gz" demucs)
(cd "$TOOLS" && tar -czf "$OUT/youtubeuploader.tar.gz" youtubeuploader)

echo "Archives ready in $OUT:"
ls -lh "$OUT"