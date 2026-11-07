#!/bin/bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

restore_arm64() {
  if [ -d native-resources/playwright-browsers.arm64 ]; then
    rm -rf native-resources/playwright-browsers
    mv native-resources/playwright-browsers.arm64 native-resources/playwright-browsers
  fi
  if [ -f /tmp/wasteland-ffmpeg-arm64 ]; then
    cp /tmp/wasteland-ffmpeg-arm64 node_modules/ffmpeg-static/ffmpeg
    chmod +x node_modules/ffmpeg-static/ffmpeg
    rm -f /tmp/wasteland-ffmpeg-arm64
  fi
}
trap restore_arm64 EXIT

echo "● frontend build"
npm run build

echo "● arm64 resources"
node scripts/prepare-native.mjs
node scripts/prepare-native-x64.mjs

rm -rf release/native/arm64 release/native/x64

echo "● arm64 app"
npx electron-builder --mac dir --arm64 --config.directories.output=release/native/arm64
APP_ARM=$(find release/native/arm64 -maxdepth 4 -name "废土馆藏.app" -type d | head -n 1)
if [ -z "$APP_ARM" ]; then echo "arm64 .app not found"; exit 1; fi
sh scripts/package-native.sh "$APP_ARM" arm64

echo "● x64 resources"
mv native-resources/playwright-browsers native-resources/playwright-browsers.arm64
cp -R native-resources/playwright-browsers-x64 native-resources/playwright-browsers
cp node_modules/ffmpeg-static/ffmpeg /tmp/wasteland-ffmpeg-arm64
cp native-resources/ffmpeg-x64/ffmpeg node_modules/ffmpeg-static/ffmpeg
chmod +x node_modules/ffmpeg-static/ffmpeg

echo "● x64 app"
npx electron-builder --mac dir --x64 --config.directories.output=release/native/x64
APP_X64=$(find release/native/x64 -maxdepth 4 -name "废土馆藏.app" -type d | head -n 1)
if [ -z "$APP_X64" ]; then echo "x64 .app not found"; exit 1; fi
file "$APP_X64/Contents/MacOS/废土馆藏"
sh scripts/package-native.sh "$APP_X64" x64

restore_arm64
trap - EXIT
echo "● done"
