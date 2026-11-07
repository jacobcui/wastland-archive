#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const runtime = path.join(root, ".runtime", "pw-win");
const target = path.join(root, "native-resources", "playwright-browsers-win");
const ffmpegDir = path.join(root, "native-resources", "ffmpeg-win");
const ffmpegTarget = path.join(ffmpegDir, "ffmpeg.exe");
const shellName = "chromium_headless_shell-1254";
const shellDir = path.join(runtime, shellName);

fs.mkdirSync(target, { recursive: true });
fs.mkdirSync(ffmpegDir, { recursive: true });

if (!fs.existsSync(shellDir)) {
  console.log("→ downloading Windows Chromium headless shell (Playwright)");
  const result = spawnSync("npx", ["playwright", "install", "chromium-headless-shell"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "win64",
      PLAYWRIGHT_BROWSERS_PATH: runtime,
    },
  });
  if (result.status !== 0) throw new Error("Windows Playwright Chromium download failed");
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const name of [shellName, "ffmpeg-1013"]) {
  const source = path.join(runtime, name);
  if (fs.existsSync(source)) {
    console.log("→ " + name + " (win64)");
    fs.cpSync(source, path.join(target, name), { recursive: true, verbatimSymlinks: true });
  }
}

if (!fs.existsSync(ffmpegTarget)) {
  console.log("→ downloading ffmpeg win32-x64");
  const url = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz";
  const response = await fetch(url);
  if (!response.ok) throw new Error("ffmpeg win32-x64 download failed: HTTP " + response.status);
  const compressed = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(ffmpegTarget, zlib.gunzipSync(compressed));
}

console.log("Windows Playwright browsers → " + target);
console.log("Windows ffmpeg → " + ffmpegTarget);
