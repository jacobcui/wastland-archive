#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
APP=$(find release/native -maxdepth 3 -name "*.app" -type d | head -n 1)
if [ -z "$APP" ]; then
  echo "未找到 .app；先运行 npm run desktop:build"
  exit 1
fi
# Local ad-hoc signature so macOS can launch the arm64 bundle.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
xattr -cr "$APP" 2>/dev/null || true
ZIP="release/native/Wasteland-Archive-mac-arm64.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
echo "● 已生成原生 App：$APP"
echo "● 已生成压缩包：$ZIP"
DMG="release/native/Wasteland-Archive-mac-arm64.dmg"
rm -f "$DMG"
hdiutil create -volname "废土馆藏" -srcfolder "$APP" -ov -format UDZO "$DMG" >/dev/null
echo "● 已生成 DMG：$DMG"
