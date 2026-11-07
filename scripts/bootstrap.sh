#!/bin/sh
# Wasteland Archive · environment bootstrap
# Installs a local Node.js if needed, npm dependencies, ffmpeg, and Chromium.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
RUNTIME="$ROOT/.runtime"
NODE_VERSION="${NODE_VERSION:-22.11.0}"
NODE_DIR="$RUNTIME/node"
NODE_BIN="$NODE_DIR/bin/node"
NPM_BIN="$NODE_DIR/bin/npm"

log() { printf '  %s\n' "$*"; }
section() { printf '\n● %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

node_is_ok() {
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1
}

download() {
  url="$1"
  output="$2"
  if have curl; then
    curl -fL --retry 3 --connect-timeout 15 -o "$output" "$url"
  elif have wget; then
    wget -O "$output" "$url"
  else
    log "缺少 curl / wget，无法下载 Node.js。请先安装 curl。"
    exit 1
  fi
}

section "检查 Node.js"
NODE_EXE=""
NPM_EXE=""
if [ -x "$NODE_BIN" ] && node_is_ok "$NODE_BIN"; then
  NODE_EXE="$NODE_BIN"
  NPM_EXE="$NPM_BIN"
  log "使用项目内置 Node $("$NODE_EXE" -v)"
elif have node && node_is_ok "$(command -v node)"; then
  NODE_EXE="$(command -v node)"
  NPM_EXE="$(command -v npm)"
  log "使用系统 Node $("$NODE_EXE" -v)"
else
  if have node; then
    log "系统 Node $(node -v) 低于 20，安装项目内置 Node ${NODE_VERSION}…"
  else
    log "未找到 Node.js，安装项目内置 Node ${NODE_VERSION}…"
  fi
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    *) log "暂不支持系统 $os"; exit 1 ;;
  esac
  case "$arch" in
    arm64|aarch64) cpu="arm64" ;;
    x86_64|amd64) cpu="x64" ;;
    *) log "暂不支持架构 $arch"; exit 1 ;;
  esac
  mkdir -p "$RUNTIME/downloads"
  archive="$RUNTIME/downloads/node-v$NODE_VERSION-$platform-$cpu.tar.gz"
  url="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$platform-$cpu.tar.gz"
  log "下载 $url"
  download "$url" "$archive"
  rm -rf "$RUNTIME/node-v$NODE_VERSION-$platform-$cpu" "$NODE_DIR"
  tar -xzf "$archive" -C "$RUNTIME"
  mv "$RUNTIME/node-v$NODE_VERSION-$platform-$cpu" "$NODE_DIR"
  NODE_EXE="$NODE_BIN"
  NPM_EXE="$NPM_BIN"
  if [ ! -x "$NODE_EXE" ]; then
    log "Node 安装失败"
    exit 1
  fi
  log "已安装 Node $("$NODE_EXE" -v)"
fi
export PATH="$(dirname "$NODE_EXE"):$PATH"

section "检查 npm 依赖"
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ] && ! [ package-lock.json -nt node_modules/.package-lock.json ]; then
  log "依赖已是最新"
else
  log "安装 npm 依赖（首次会下载 ffmpeg / Playwright 等包，可能需要几分钟）…"
  "$NPM_EXE" install --no-audit --no-fund
fi

section "检查 ffmpeg"
if "$NODE_EXE" -e 'const p=require("ffmpeg-static"); process.exit(p ? 0 : 1)' >/dev/null 2>&1; then
  log "使用项目内置 ffmpeg-static"
elif have ffmpeg; then
  log "使用系统 ffmpeg ($(ffmpeg -version | head -n 1 | cut -c1-60))"
else
  log "未找到 ffmpeg；流式转码会退回 WASM 完整转码。"
fi

section "检查浏览器（mkexue 登录 / 同步使用）"
CHROME_FOUND=0
if [ "$(uname -s)" = "Darwin" ] && [ -d "/Applications/Google Chrome.app" ]; then CHROME_FOUND=1; fi
if [ "$(uname -s)" = "Darwin" ] && [ -d "/Applications/Chromium.app" ]; then CHROME_FOUND=1; fi
if have google-chrome || have google-chrome-stable || have chromium || have chromium-browser; then CHROME_FOUND=1; fi
if [ "$CHROME_FOUND" = "1" ]; then
  log "已找到 Chrome / Chromium"
else
  log "未找到 Chrome，安装 Playwright Chromium（首次约 150MB）…"
  if "$NPM_EXE" exec --yes playwright install chromium; then
    log "已安装 Playwright Chromium"
  else
    log "Playwright Chromium 安装失败；本地媒体/MKX 离线浏览仍可用，登录/同步需要 Chrome。"
  fi
fi

section "检查前端构建"
if [ ! -f dist/index.html ]; then
  log "首次构建前端 dist/…"
  "$NPM_EXE" run build
else
  log "dist/ 已存在"
fi

section "环境就绪"
log "Node: $("$NODE_EXE" -v)"
log "npm:  $("$NPM_EXE" -v)"
log "执行 make up 启动服务。"
