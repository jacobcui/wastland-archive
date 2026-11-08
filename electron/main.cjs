const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require("electron");
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

ipcMain.handle("wasteland:pick-directory", async () => {
  try {
    const options = { title: "选择媒体目录", properties: ["openDirectory", "createDirectory"] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, cancelled: true };
    return { ok: true, path: result.filePaths[0] };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("wasteland:reveal-path", async (_event, target) => {
  try {
    const resolved = path.resolve(String(target || ""));
    const allowedRoot = path.resolve(dataDir);
    if (resolved !== allowedRoot && !resolved.startsWith(allowedRoot + path.sep)) {
      return { ok: false, error: "路径不在应用数据目录内" };
    }
    if (!fs.existsSync(resolved)) return { ok: false, error: "目录不存在" };
    const error = await shell.openPath(resolved);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("wasteland:system-info", () => ({
  platform: process.platform,
  arch: process.arch,
  version: app.getVersion(),
  packaged: isPackaged,
}));

const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;
let updateDownloading = false;

function isAllowedUpdateUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "github.com" || host === "objects.githubusercontent.com" || /\.githubusercontent\.com$/.test(host);
  } catch {
    return false;
  }
}

function safeUpdateFileName(name) {
  const base = path.basename(String(name || "wasteland-update"));
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 180);
  return cleaned || "wasteland-update";
}

function uniqueDownloadPath(dir, name) {
  const ext = name.toLowerCase().endsWith(".tar.gz") ? ".tar.gz" : path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let target = path.join(dir, name);
  let index = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, stem + "-" + index + ext);
    index += 1;
  }
  return target;
}

function sendUpdateProgress(event, received, total) {
  try {
    if (event && event.sender && !event.sender.isDestroyed()) {
      event.sender.send("wasteland:update-progress", {
        received,
        total,
        percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
      });
    }
  } catch {}
}

async function downloadUpdateFile(event, payload) {
  if (updateDownloading) return { ok: false, error: "已有更新正在下载" };
  const url = String((payload && payload.url) || "");
  if (!isAllowedUpdateUrl(url)) return { ok: false, error: "更新下载地址不受信任" };
  const name = safeUpdateFileName(payload && payload.name);
  const dir = app.getPath("downloads");
  fs.mkdirSync(dir, { recursive: true });
  const target = uniqueDownloadPath(dir, name);
  const temp = target + ".part";
  updateDownloading = true;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "wasteland-archive-updater" },
    });
    if (!response.ok || !response.body) throw new Error("下载失败 (" + response.status + ")");
    const total = Number(response.headers.get("content-length")) || 0;
    if (total > MAX_UPDATE_BYTES) throw new Error("更新包过大");
    const file = fs.createWriteStream(temp);
    const reader = response.body.getReader();
    let received = 0;
    let lastSent = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_UPDATE_BYTES) throw new Error("更新包过大");
        if (!file.write(Buffer.from(value))) {
          await new Promise((resolve, reject) => {
            file.once("drain", resolve);
            file.once("error", reject);
          });
        }
        const now = Date.now();
        if (now - lastSent > 250) {
          lastSent = now;
          sendUpdateProgress(event, received, total);
        }
      }
      await new Promise((resolve, reject) => {
        file.end(resolve);
        file.once("error", reject);
      });
    } catch (error) {
      try { file.destroy(); } catch {}
      try { fs.rmSync(temp, { force: true }); } catch {}
      throw error;
    }
    fs.renameSync(temp, target);
    sendUpdateProgress(event, received, total || received);
    const shouldOpen = /\.(dmg|zip|tar\.gz)$/i.test(name);
    const openError = shouldOpen ? await shell.openPath(target) : "";
    return { ok: true, path: target, opened: shouldOpen ? !openError : false, openError: openError || "" };
  } finally {
    updateDownloading = false;
  }
}

ipcMain.handle("wasteland:download-update", async (event, payload) => {
  try {
    return await downloadUpdateFile(event, payload);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

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
    WASTELAND_MEDIA_HOME: userData,
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
      preload: path.join(__dirname, "preload.cjs"),
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
