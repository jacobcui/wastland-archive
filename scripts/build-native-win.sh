#!/bin/bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
VERSION=$(node -p "require('./package.json').version")
NAME="Wasteland-Archive-win-x64-$VERSION"

restore() {
  if [ -d native-resources/playwright-browsers.win ]; then
    rm -rf native-resources/playwright-browsers
    mv native-resources/playwright-browsers.win native-resources/playwright-browsers
  fi
  rm -f node_modules/ffmpeg-static/ffmpeg.exe
}
trap restore EXIT

echo "● frontend build"
npm run build
node scripts/prepare-native-win.mjs

echo "● windows resources"
rm -rf native-resources/playwright-browsers.win
mv native-resources/playwright-browsers native-resources/playwright-browsers.win
cp -R native-resources/playwright-browsers-win native-resources/playwright-browsers
cp native-resources/ffmpeg-win/ffmpeg.exe node_modules/ffmpeg-static/ffmpeg.exe

echo "● Windows x64 app"
rm -rf release/native/win-x64 "release/native/$NAME" "release/native/$NAME.zip"
npx electron-builder --win dir --x64 --config.directories.output=release/native/win-x64
find release/native/win-x64 -maxdepth 2 -name "*.exe" -type f | head -3

echo "● portable zip"
cp -R release/native/win-x64/win-unpacked "release/native/$NAME"
cd release/native
zip -q -r -X "$NAME.zip" "$NAME"
cd "$ROOT"
rm -rf "release/native/$NAME"

restore
trap - EXIT
echo "● done: release/native/$NAME.zip"
