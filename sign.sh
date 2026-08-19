#!/bin/bash
# Ad-hoc sign the built .app and fix the resource-seal that `tauri build`
# leaves inconsistent (otherwise `codesign --verify --deep --strict` fails).
#
# NOTE: ad-hoc signing does NOT make the app trusted on other Macs. To open
# without a Gatekeeper warning you need a Developer ID certificate + notarize:
#   codesign --deep --force --sign "Developer ID Application: NAME (TEAMID)" "$APP"
#   xcrun notarytool submit --apple-id ... --wait "$APP.dmg"
#   xcrun stapler staple "$APP"
# Without a cert, recipients must right-click -> Open (or run `xattr -cr`).
set -e
cd "$(dirname "$0")"

APP="src-tauri/target/release/bundle/macos/SubTitle Extractor.app"
[ -d "$APP" ] || { echo "ERROR: $APP not found. Run 'npx tauri build' first." >&2; exit 1; }

xattr -cr "$APP"
codesign --deep --force --sign - "$APP"
xattr -cr "$APP"

echo "=== verify ==="
codesign --verify --deep --strict --verbose=2 "$APP"
echo "OK: $APP ad-hoc signed + verified"
