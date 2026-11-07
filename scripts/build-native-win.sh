#!/bin/bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

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
rm -rf release/native/win-x64 release/native/Wasteland-Archive-win-x64 release/native/Wasteland-Archive-win-x64.zip
npx electron-builder --win dir --x64 --config.directories.output=release/native/win-x64
find release/native/win-x64 -maxdepth 2 -name "*.exe" -type f | head -3

echo "● portable zip"
cp -R release/native/win-x64/win-unpacked release/native/Wasteland-Archive-win-x64
cd release/native
zip -q -r -X Wasteland-Archive-win-x64.zip Wasteland-Archive-win-x64
cd "$ROOT"
rm -rf release/native/Wasteland-Archive-win-x64

restore
trap - EXIT
echo "● done: release/native/Wasteland-Archive-win-x64.zip"
