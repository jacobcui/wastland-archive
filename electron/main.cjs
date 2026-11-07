const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const isPackaged = app.isPackaged;
const root = app.getAppPath();
const appData = app.getPath("appData");
const legacyUserData = path.join(appData, "wasteland-browser");
const nextUserData = path.join(appData, "wasteland-archive");
try {
  if (fs.existsSync(legacyUserData)) {
    fs.mkdirSync(nextUserData, { recursive: true });
    const oldData = path.join(legacyUserData, "data");
    const newData = path.join(nextUserData, "data");
    if (fs.existsSync(oldData)) {
      if (!fs.existsSync(newData)) {
        fs.cpSync(oldData, newData, { recursive: true });
      } else {
        const countDirs = (dir) => {
          try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch { return 0; }
        };
        const oldIssues = path.join(oldData, "issues");
        const newIssues = path.join(newData, "issues");
        if (countDirs(oldIssues) > 0 && countDirs(newIssues) === 0) {
          fs.mkdirSync(newIssues, { recursive: true });
          fs.cpSync(oldIssues, newIssues, { recursive: true, force: false, errorOnExist: false });
        }
        for (const name of ["auth.json", "covers", "cache"]) {
          const from = path.join(oldData, name);
          const to = path.join(newData, name);
          if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
        }
      }
    }
    for (const name of ["Local Storage", "IndexedDB", "Session Storage"]) {
      const from = path.join(legacyUserData, name);
      const to = path.join(nextUserData, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
    }
  }
} catch (error) {
  console.error("legacy data migration failed", error);
}
app.setPath("userData", nextUserData);
const userData = app.getPath("userData");
const dataDir = path.join(userData, "data");
const logFile = path.join(userData, "app.log");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

let server = null;
let win = null;
let baseUrl = "";
let quitting = false;

function log(message) {
  try {
    fs.appendFileSync(logFile, "[" + new Date().toISOString() + "] " + message + "\n");
  } catch {}
}

// Keep this origin stable across launches: IndexedDB/localStorage are keyed by port.
const NATIVE_PORT = 5278;

function startServer(port) {
  const serverEntry = path.join(root, "server", "index.js");
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PORT: String(port),
    WASTELAND_ROOT: root,
    WASTELAND_DATA_DIR: dataDir,
    WASTELAND_HOME: path.join(app.getPath("home"), ".wasteland_browser"),
  };
  const bundledBrowsers = path.join(process.resourcesPath, "playwright-browsers");
  if (isPackaged && fs.existsSync(bundledBrowsers)) {
    env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
  }
  log("starting server " + serverEntry + " port " + port);
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk) => {
    try {
      fs.appendFileSync(logFile, chunk);
    } catch {}
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", (code, signal) => {
    log("server exited code=" + code + " signal=" + signal);
    if (!quitting) {
      dialog.showErrorBox("服务已停止", "本地服务异常退出。\n日志：" + logFile);
      app.quit();
    }
  });
  return child;
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url + "/api/session", { cache: "no-store" });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#080706",
    title: "废土馆藏",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (baseUrl && !url.startsWith(baseUrl)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.on("closed", () => {
    win = null;
  });
  win.loadURL(baseUrl);
}

async function boot() {
  app.setName("废土馆藏");
  try {
    baseUrl = "http://127.0.0.1:" + NATIVE_PORT;
    server = startServer(NATIVE_PORT);
    const ready = await waitForServer(baseUrl);
    if (!ready) {
      dialog.showErrorBox("启动失败", "本地服务没有在预期时间内启动。\n日志：" + logFile);
      app.quit();
      return;
    }
    createWindow();
  } catch (error) {
    dialog.showErrorBox("启动失败", String(error && error.message ? error.message : error) + "\n日志：" + logFile);
    app.quit();
  }
}

function stopServer() {
  if (server && !server.killed) {
    try { server.kill("SIGTERM"); } catch {}
  }
  server = null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    const template = [
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    boot();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });
  app.on("activate", () => {
    if (!win) boot();
  });
}
