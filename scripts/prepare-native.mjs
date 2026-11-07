#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const executable = chromium.executablePath();
const match = executable.match(/(.*)[\\/](chromium-\d+)[\\/]/);
if (!match) {
  console.error("无法识别 Playwright Chromium 路径: " + executable);
  process.exit(1);
}
const cacheRoot = match[1];
const revision = match[2].replace("chromium-", "");
const target = path.join(root, "native-resources", "playwright-browsers");
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

const wanted = ["chromium_headless_shell-" + revision];

for (const name of wanted) {
  const source = path.join(cacheRoot, name);
  if (!fs.existsSync(source)) continue;
  const destination = path.join(target, name);
  console.log("→ " + name);
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}
console.log("Playwright browsers → " + target);
