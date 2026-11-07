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

# Standard drag-to-install DMG: app, Applications alias, arrow background,
# and a Finder window with fixed icon positions.
VERSION=$(node -p "require('./package.json').version")
VOLNAME="废土馆藏 $VERSION"
STAGE=$(mktemp -d /tmp/wasteland-dmg.XXXXXX)
RW=$(mktemp /tmp/wasteland-rw.XXXXXX.dmg)
MNT=""
cleanup() {
  hdiutil detach "$MNT" >/dev/null 2>&1 || true
  rm -rf "$STAGE" "$MNT"
  rm -f "$RW"
}
trap cleanup EXIT
cp -R "$APP" "$STAGE/废土馆藏.app"
ln -s /Applications "$STAGE/Applications"
mkdir -p "$STAGE/.background"
cp build/dmg-background.png "$STAGE/.background/background.png"

hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDRW "$RW" >/dev/null
ATTACH=$(hdiutil attach -nobrowse "$RW")
MNT=$(printf '%s\n' "$ATTACH" | awk -F '\t' '/\/Volumes\// {print $NF}' | tail -1)
if [ -z "$MNT" ]; then echo "DMG mount failed"; exit 1; fi

SCRIPT=$(mktemp /tmp/wasteland-finder.XXXXXX)
cat > "$SCRIPT" <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOLNAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {120, 120, 780, 540}
    set viewOptions to icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 96
    set background picture of viewOptions to file ".background:background.png"
    set position of item "废土馆藏.app" to {180, 220}
    set position of item "Applications" to {480, 220}
    close
    open
    update without registering applications
    delay 1
  end tell
end tell
APPLESCRIPT
osascript "$SCRIPT" >/tmp/wasteland-dmg-layout.log 2>&1 || true
rm -f "$SCRIPT"

sync
hdiutil detach "$MNT" >/dev/null 2>&1 || true
hdiutil convert "$RW" -format UDZO -o "$DMG" >/dev/null

echo "● $ARCH app: $APP"
echo "● $ARCH zip: $ZIP"
echo "● $ARCH dmg: $DMG"
