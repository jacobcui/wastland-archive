import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const procs = [];

function run(name, command, args) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    console.log("[" + name + "] exited with " + code);
    shutdown(code || 0);
  });
  procs.push(child);
  return child;
}

function shutdown(code) {
  for (const proc of procs) {
    if (!proc.killed) proc.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("server", process.execPath, ["server/index.js"]);
setTimeout(() => run("vite", "npx", ["vite"]), 600);

console.log("\n  废土馆藏 · WASTELAND ARCHIVE → http://127.0.0.1:5177\n");
