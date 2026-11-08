import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MEDIA_HOME, MEDIA_INDEX_FILE } from "./config.js";

const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mov", "mkv", "ts", "m2ts", "flv", "f4v", "mxf", "avi", "wmv", "mpg", "mpeg", "3gp"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "wma", "alac"]);
const SUB_EXT = new Set(["srt", "vtt"]);
const SKIP_DIRS = new Set([".git", "node_modules", "@eaDir", "#recycle", "$RECYCLE.BIN", "System Volume Information", ".Trashes", ".Spotlight-V100"]);
const MIME = {
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  ts: "video/mp2t", m2ts: "video/mp2t", flv: "video/x-flv", f4v: "video/x-f4v", mxf: "application/mxf",
  avi: "video/x-msvideo", wmv: "video/x-ms-wmv", mpg: "video/mpeg", mpeg: "video/mpeg", "3gp": "video/3gp",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav",
  ogg: "audio/ogg", opus: "audio/ogg", wma: "audio/x-ms-wma", alac: "audio/mp4",
};

let store = null;
let queue = Promise.resolve();

function emptyStore() {
  return { version: 1, updatedAt: 0, folders: [], items: [] };
}

function ensureHome() {
  fs.mkdirSync(MEDIA_HOME, { recursive: true });
}

function load() {
  if (store) return store;
  ensureHome();
  try {
    const parsed = JSON.parse(fs.readFileSync(MEDIA_INDEX_FILE, "utf8"));
    if (parsed && Array.isArray(parsed.folders) && Array.isArray(parsed.items)) {
      store = { ...emptyStore(), ...parsed };
      return store;
    }
  } catch {}
  store = emptyStore();
  return store;
}

function save() {
  ensureHome();
  const data = load();
  data.updatedAt = Date.now();
  const tmp = MEDIA_INDEX_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, MEDIA_INDEX_FILE);
}

function run(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function hash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 16);
}

function extOf(name) {
  return path.extname(String(name || "")).slice(1).toLowerCase();
}

function kindOf(name) {
  const ext = extOf(name);
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

function mimeOf(name) {
  return MIME[extOf(name)] || "application/octet-stream";
}

/* Cheap container sniffing: browsers can natively demux MP4/WebM only. An
   MPEG-TS file named .mp4 must go through HLS, otherwise Chromium reports a
   demuxer error after a failed native attempt (and some builds glitch). */
function detectContainer(filePath, name) {
  let buffer = Buffer.alloc(0);
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      buffer = Buffer.alloc(1024);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      buffer = buffer.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "missing";
  }
  const ext = extOf(name);
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") return "mp4";
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return ext === "webm" ? "webm" : "matroska";
  }
  if (buffer.length >= 3 && buffer[0] === 0x47 && (buffer.length < 188 || buffer[188] === 0x47)) return "mpegts";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF") {
    const riff = buffer.toString("ascii", 8, 12);
    if (riff === "AVI ") return "avi";
    if (riff === "WAVE") return "wav";
  }
  if (buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "FLV") return "flv";
  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0xba) return "mpeg";
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "fLaC") return "flac";
  if (buffer.length >= 8 && buffer[0] === 0x30 && buffer[1] === 0x26 && buffer[2] === 0xb2 && buffer[3] === 0x75) return "asf";
  if (buffer.length >= 3 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "mp3";
  if (buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "ID3") return "mp3";
  return "unknown";
}

function isNativePlayable(item, container) {
  const ext = extOf(item.name);
  if ((item.kind || kindOf(item.name)) !== "video") return true;
  if (container === "mp4") return ["mp4", "m4v", "mov"].includes(ext);
  if (container === "webm") return ext === "webm";
  return false;
}

let containersMigrated = false;

function ensureItemContainers() {
  if (containersMigrated) return;
  containersMigrated = true;
  const data = load();
  let changed = false;
  for (const item of data.items) {
    if (typeof item.container === "string") continue;
    const absolutePath = itemPath(item);
    item.container = absolutePath ? detectContainer(absolutePath, item.name) : "missing";
    changed = true;
  }
  if (changed) save();
}

function findFolder(id) {
  return load().folders.find((folder) => folder.id === id) || null;
}

function findItem(id) {
  return load().items.find((item) => item.id === id) || null;
}

function publicFolder(folder) {
  return { ...folder };
}

function publicItem(item) {
  const folder = findFolder(item.folderId);
  const kind = kindOf(item.relativePath || item.name) || item.kind || "video";
  const container = typeof item.container === "string" ? item.container : "unknown";
  return {
    ...item,
    absolutePath: folder ? path.join(folder.rootPath, item.relativePath) : "",
    fileUrl: "/api/media-library/file/" + item.id,
    subtitleUrl: item.subtitleRelative || item.subtitleText ? "/api/media-library/subtitle/" + item.id : null,
    hasSubtitle: Boolean(item.subtitleRelative || item.subtitleText),
    kind,
    container,
    nativePlayable: isNativePlayable({ ...item, kind }, container),
    type: mimeOf(item.relativePath || item.name),
  };
}

function snapshot() {
  ensureItemContainers();
  const data = load();
  return {
    version: data.version,
    updatedAt: data.updatedAt,
    folders: data.folders
      .slice()
      .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
      .map(publicFolder),
    items: data.items
      .filter((item) => findFolder(item.folderId))
      /* AppleDouble resource forks (._name.mp4) are not media. */
      .filter((item) => !path.basename(item.relativePath || item.name).startsWith("."))
      .map(publicItem)
      .sort((a, b) => (a.relativePath || a.name).localeCompare(b.relativePath || b.name, "zh-CN", { numeric: true, sensitivity: "base" })),
  };
}

async function scanFolder(folder) {
  const data = load();
  const root = folder.rootPath;
  const previous = new Map(
    data.items.filter((item) => item.folderId === folder.id).map((item) => [item.relativePath, item])
  );
  const found = [];
  const now = Date.now();

  async function walk(dir, relDir, depth) {
    if (depth > 12) return;
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = new Map();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      files.set(entry.name, entry);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), relDir ? relDir + "/" + entry.name : entry.name, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      /* Hidden files, including macOS AppleDouble "._name" resource forks,
         are never playable media. */
      if (entry.name.startsWith(".")) continue;
      const kind = kindOf(entry.name);
      if (!kind) continue;
      const relPath = relDir ? relDir + "/" + entry.name : entry.name;
      const abs = path.join(dir, entry.name);
      let stat;
      try { stat = await fs.promises.stat(abs); } catch { continue; }
      const old = previous.get(relPath);
      const stem = entry.name.replace(/.[^.]+$/, "");
      let subtitleName = "";
      let subtitleExact = false;
      for (const [fileName] of files) {
        if (!SUB_EXT.has(extOf(fileName))) continue;
        const subStem = fileName.replace(/.[^.]+$/, "");
        if (subStem === stem) { subtitleName = fileName; subtitleExact = true; break; }
        if (!subtitleName && subStem.startsWith(stem + ".")) subtitleName = fileName;
      }
      const subtitleRelative = subtitleName ? (relDir ? relDir + "/" + subtitleName : subtitleName) : "";
      const item = old || {
        id: hash(folder.id + ":" + relPath),
        folderId: folder.id,
        relativePath: relPath,
        position: 0,
        duration: 0,
        lastPlayedAt: 0,
        historyHidden: false,
        addedAt: now,
        subtitleText: "",
        subtitleName: "",
      };
      item.name = entry.name;
      item.size = stat.size;
      item.kind = kind;
      item.type = mimeOf(entry.name);
      item.container = detectContainer(abs, entry.name);
      item.lastModified = stat.mtimeMs;
      item.subtitleRelative = subtitleRelative;
      if (subtitleName && !item.subtitleName) item.subtitleName = subtitleName;
      if (!subtitleRelative && !item.subtitleText && old) item.subtitleName = "";
      found.push(item);
    }
  }

  await walk(root, "", 0);
  const keep = new Set(found.map((item) => item.relativePath));
  data.items = data.items.filter((item) => item.folderId !== folder.id || keep.has(item.relativePath));
  const byPath = new Map(data.items.map((item) => [item.id, item]));
  for (const item of found) byPath.set(item.id, item);
  data.items = [...byPath.values()];
  folder.lastScannedAt = Date.now();
  folder.itemCount = found.length;
  save();
}

async function addFolder(rootPath) {
  return run(async () => {
    const input = String(rootPath || "").trim();
    if (!input) throw new Error("目录路径为空");
    if (!path.isAbsolute(input)) throw new Error("请填写绝对路径，例如 /Volumes/MYBAK2/Movies");
    let real;
    try { real = fs.realpathSync(input); } catch { throw new Error("目录不存在或无权访问"); }
    let stat;
    try { stat = fs.statSync(real); } catch { throw new Error("目录不存在或无权访问"); }
    if (stat.isFile()) real = path.dirname(real);
    else if (!stat.isDirectory()) throw new Error("路径不是目录");
    const data = load();
    let folder = data.folders.find((item) => item.rootPath === real);
    if (!folder) {
      folder = { id: hash(real), name: path.basename(real), rootPath: real, addedAt: Date.now(), lastScannedAt: 0, itemCount: 0 };
      data.folders.push(folder);
    }
    await scanFolder(folder);
    save();
    return snapshot();
  });
}

async function rescanFolder(id) {
  return run(async () => {
    const folder = findFolder(id);
    if (!folder) throw new Error("目录不在媒体库中");
    let stat;
    try { stat = fs.statSync(folder.rootPath); } catch { throw new Error("目录已不存在"); }
    if (!stat.isDirectory()) throw new Error("目录已不存在");
    await scanFolder(folder);
    save();
    return snapshot();
  });
}

async function removeFolder(id) {
  return run(async () => {
    const data = load();
    const folder = findFolder(id);
    if (!folder) throw new Error("目录不在媒体库中");
    data.folders = data.folders.filter((item) => item.id !== id);
    data.items = data.items.filter((item) => item.folderId !== id);
    save();
    return snapshot();
  });
}

async function removeItem(id) {
  return run(async () => {
    const data = load();
    data.items = data.items.filter((item) => item.id !== id);
    save();
    return snapshot();
  });
}

async function updateItem(id, patch) {
  return run(async () => {
    const item = findItem(id);
    if (!item) throw new Error("媒体不在媒体库中");
    if (patch && Number.isFinite(Number(patch.position))) item.position = Math.max(0, Number(patch.position));
    if (patch && Number.isFinite(Number(patch.duration))) item.duration = Math.max(0, Number(patch.duration));
    if (patch && Number.isFinite(Number(patch.lastPlayedAt))) item.lastPlayedAt = Number(patch.lastPlayedAt);
    if (patch && typeof patch.historyHidden === "boolean") item.historyHidden = patch.historyHidden;
    if (patch && typeof patch.subtitleText === "string") item.subtitleText = patch.subtitleText.slice(0, 2 * 1024 * 1024);
    if (patch && typeof patch.subtitleName === "string") item.subtitleName = patch.subtitleName.slice(0, 300);
    save();
    return publicItem(item);
  });
}

function itemPath(item) {
  if (!item) return null;
  const folder = findFolder(item.folderId);
  if (!folder) return null;
  const root = path.resolve(folder.rootPath);
  const target = path.resolve(root, item.relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function subtitlePath(item) {
  if (!item || !item.subtitleRelative) return null;
  const folder = findFolder(item.folderId);
  if (!folder) return null;
  const root = path.resolve(folder.rootPath);
  const target = path.resolve(root, item.subtitleRelative);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function fileInfo(id) {
  const item = findItem(id);
  const absolutePath = itemPath(item);
  if (!item || !absolutePath) return null;
  return { item, absolutePath, mime: mimeOf(item.name) };
}

function subtitleInfo(id) {
  const item = findItem(id);
  if (!item) return null;
  if (item.subtitleText) return { text: item.subtitleText, name: item.subtitleName || "字幕", mime: "text/plain; charset=utf-8" };
  const absolutePath = subtitlePath(item);
  if (!absolutePath) return null;
  try {
    return { text: fs.readFileSync(absolutePath, "utf8"), name: path.basename(absolutePath), mime: "text/plain; charset=utf-8" };
  } catch {
    return null;
  }
}

export {
  addFolder,
  fileInfo,
  findItem,
  itemPath,
  rescanFolder,
  removeFolder,
  removeItem,
  snapshot,
  subtitleInfo,
  updateItem,
};
