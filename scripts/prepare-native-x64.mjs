#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const runtime = path.join(root, ".runtime", "pw-x64");
const target = path.join(root, "native-resources", "playwright-browsers-x64");
const ffmpegDir = path.join(root, "native-resources", "ffmpeg-x64");
const ffmpegTarget = path.join(ffmpegDir, "ffmpeg");
const shellName = "chromium_headless_shell-1254";
const shellDir = path.join(runtime, shellName);

fs.mkdirSync(target, { recursive: true });
fs.mkdirSync(ffmpegDir, { recursive: true });

if (!fs.existsSync(shellDir)) {
  console.log("→ downloading x64 Chromium headless shell (Playwright)");
  const result = spawnSync("npx", ["playwright", "install", "chromium-headless-shell"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "mac14",
      PLAYWRIGHT_BROWSERS_PATH: runtime,
    },
  });
  if (result.status !== 0) throw new Error("x64 Playwright Chromium download failed");
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const name of [shellName]) {
  const source = path.join(runtime, name);
  if (fs.existsSync(source)) {
    console.log("→ " + name + " (x64)");
    fs.cpSync(source, path.join(target, name), { recursive: true, verbatimSymlinks: true });
  }
}

if (!fs.existsSync(ffmpegTarget)) {
  console.log("→ downloading ffmpeg darwin-x64");
  const url = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-x64.gz";
  const response = await fetch(url);
  if (!response.ok) throw new Error("ffmpeg x64 download failed: HTTP " + response.status);
  const compressed = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(ffmpegTarget, zlib.gunzipSync(compressed));
  fs.chmodSync(ffmpegTarget, 0o755);
}

console.log("x64 Playwright browsers → " + target);
console.log("x64 ffmpeg → " + ffmpegTarget);
