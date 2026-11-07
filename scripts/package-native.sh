#!/bin/bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
APP=${1:?usage: package-native.sh <app> <arch>}
ARCH=${2:?usage: package-native.sh <app> <arch>}
NAME="Wasteland-Archive-mac-$ARCH"
ZIP="release/native/$NAME.zip"
DMG="release/native/$NAME.dmg"

# Ad-hoc signature; users still need to right-click → Open on first launch.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
xattr -cr "$APP" 2>/dev/null || true

rm -f "$ZIP" "$DMG"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

# A Finder window with the app and an Applications alias is the standard
# drag-to-install DMG. Keep the staging folder so the alias is preserved.
STAGE=$(mktemp -d /tmp/wasteland-dmg.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/废土馆藏.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "废土馆藏" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

echo "● $ARCH app: $APP"
echo "● $ARCH zip: $ZIP"
echo "● $ARCH dmg: $DMG"
