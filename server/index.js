import express from "express";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { PORT, ROOT, ISSUES_DIR, DATA_DIR, MEDIA_CACHE_DIR, UPSTREAM } from "./lib/config.js";
import { readAuthRecord, session, normalizeCredentials } from "./lib/auth.js";
import { getMagazines, normalizeIssue } from "./lib/api.js";
import { ensureDirs, isComplete, listLocalIssues, localIssue, readProgress, writeProgress } from "./lib/store.js";
import { bus, cancelJob, deleteLocal, extFromContentType, fetchBinary, findActiveJob, listJobs, startDownload } from "./lib/downloads.js";
import { syncWithBrowser } from "./lib/browser-sync.js";
import {
  addFolder as addMediaFolder,
  fileInfo as mediaFileInfo,
  removeFolder as removeMediaFolder,
  removeItem as removeMediaItem,
  rescanFolder as rescanMediaFolder,
  snapshot as mediaLibrarySnapshot,
  subtitleInfo as mediaSubtitleInfo,
  updateItem as updateMediaItem,
} from "./lib/media-library.js";

ensureDirs();

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

/* Issue files live under DATA_DIR, not ROOT: in the native app ROOT is the
   read-only .app bundle while DATA_DIR is ~/Library/Application Support/... */
app.use("/media/issues", express.static(ISSUES_DIR, { maxAge: "7d", fallthrough: true }));
app.use("/vendor/pdfjs/cmaps", express.static(path.join(ROOT, "node_modules", "pdfjs-dist", "cmaps"), { maxAge: "7d", fallthrough: true }));
app.use("/vendor/pdfjs/standard_fonts", express.static(path.join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts"), { maxAge: "7d", fallthrough: true }));
app.use("/vendor/ffmpeg", express.static(path.join(ROOT, "node_modules", "@ffmpeg/core/dist/esm"), { maxAge: "7d", fallthrough: true }));

/* ------------------------------------------------------------------ */
/* home backgrounds: repo presets + ~/.wasteland_browser/bg_screens    */
/* ------------------------------------------------------------------ */
const BG_PRESET_DIR = path.join(ROOT, "bg_screens");
const BG_HOME = process.env.WASTELAND_HOME || path.join(os.homedir(), ".wasteland_browser");
const BG_CUSTOM_DIR = path.join(BG_HOME, "bg_screens");
const BG_RASTER_EXT = new Set(["jpg", "jpeg", "png", "webp", "avif", "gif"]);
const BG_MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};
fs.mkdirSync(BG_CUSTOM_DIR, { recursive: true });

function listPresetBackgrounds() {
  let manifest = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(BG_PRESET_DIR, "manifest.json"), "utf8"));
    if (Array.isArray(parsed)) manifest = parsed;
  } catch {}
  const known = new Map(manifest.map((item) => [item.file, item]));
  let files = [];
  try {
    files = fs.readdirSync(BG_PRESET_DIR).filter((file) => /\.(svg|png|jpe?g|webp|avif|gif)$/i.test(file));
  } catch {}
  const present = new Set(files);
  const ordered = [...manifest.map((item) => item.file), ...files.sort()].filter((file, index, all) => present.has(file) && all.indexOf(file) === index);
  return ordered
    .map((file) => {
      const meta = known.get(file) || {};
      return {
        id: "preset:" + file,
        kind: "preset",
        file,
        name: meta.name || file.replace(/\.[^.]+$/, ""),
        nameEn: meta.nameEn || meta.name || file.replace(/\.[^.]+$/, ""),
        description: meta.description || "",
        descriptionEn: meta.descriptionEn || meta.description || "",
        url: "/backgrounds/preset/" + encodeURIComponent(file),
      };
    });
}

function listCustomBackgrounds() {
  let files = [];
  try {
    files = fs.readdirSync(BG_CUSTOM_DIR).filter((file) => BG_RASTER_EXT.has(path.extname(file).slice(1).toLowerCase()));
  } catch {}
  return files
    .map((file) => ({ file, stat: fs.statSync(path.join(BG_CUSTOM_DIR, file)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .map(({ file }, index) => ({
      id: "custom:" + file,
      kind: "custom",
      file,
      name: "自定义背景 " + (index + 1),
      nameEn: "Custom background " + (index + 1),
      description: "",
      descriptionEn: "",
      url: "/backgrounds/custom/" + encodeURIComponent(file),
    }));
}

app.use("/backgrounds/preset", express.static(BG_PRESET_DIR, { maxAge: "7d", fallthrough: true }));
app.use("/backgrounds/custom", express.static(BG_CUSTOM_DIR, { maxAge: "7d", fallthrough: true }));

app.get("/api/backgrounds", (req, res) => {
  const presets = listPresetBackgrounds();
  const custom = listCustomBackgrounds();
  res.json({
    ok: true,
    presets,
    custom,
    customDir: "~/.wasteland_browser/bg_screens",
    defaultId: (presets.find((item) => item.file === "wasteland-dunes.svg") || presets[0] || {}).id || null,
  });
});

app.post("/api/backgrounds", (req, res) => {
  const contentType = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
  let ext = BG_MIME_EXT[contentType] || "";
  if (!ext) {
    ext = String(req.get("x-background-ext") || "").toLowerCase().replace(/^\./, "");
  }
  if (!BG_RASTER_EXT.has(ext)) {
    req.resume();
    return res.status(415).json({ ok: false, error: "只支持 JPG / PNG / WebP / AVIF / GIF 背景" });
  }
  const size = Number(req.get("content-length") || 0);
  if (size > 30 * 1024 * 1024) {
    req.resume();
    return res.status(413).json({ ok: false, error: "背景图片不能超过 30MB" });
  }
  const file = crypto.randomBytes(10).toString("hex") + "." + ext;
  const target = path.join(BG_CUSTOM_DIR, file);
  const output = fs.createWriteStream(target);
  let aborted = false;
  req.on("aborted", () => {
    aborted = true;
    output.destroy();
    try { fs.rmSync(target, { force: true }); } catch {}
  });
  output.on("error", (error) => {
    if (!res.headersSent) res.status(500).json({ ok: false, error: error.message });
  });
  req.pipe(output);
  output.on("finish", () => {
    if (aborted) return;
    const item = {
      id: "custom:" + file,
      kind: "custom",
      file,
      name: "自定义背景",
      nameEn: "Custom background",
      description: "",
      descriptionEn: "",
      url: "/backgrounds/custom/" + encodeURIComponent(file),
    };
    res.json({ ok: true, item });
  });
});

app.delete("/api/backgrounds/:file", (req, res) => {
  const file = path.basename(String(req.params.file || ""));
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!file || file !== req.params.file || !BG_RASTER_EXT.has(ext)) {
    return res.status(400).json({ ok: false, error: "无效的背景文件名" });
  }
  try {
    fs.rmSync(path.join(BG_CUSTOM_DIR, file), { force: true });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* local ffmpeg -> HLS streaming for media that browsers cannot decode */
/* ------------------------------------------------------------------ */
const TRANSCODE_ROOT = MEDIA_CACHE_DIR;
fs.mkdirSync(TRANSCODE_ROOT, { recursive: true });
/* 1.0.x kept HLS segments inside the portable archive folder. They are pure
   cache; remove the old directory so data/ stays small and transferable. */
try {
  const legacyTranscodes = path.join(DATA_DIR, "transcodes");
  if (legacyTranscodes !== TRANSCODE_ROOT && fs.existsSync(legacyTranscodes)) {
    fs.rmSync(legacyTranscodes, { recursive: true, force: true });
  }
} catch {}
const TRANSCODE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const require = createRequire(import.meta.url);
let bundledFfmpeg = null;
try {
  bundledFfmpeg = require("ffmpeg-static");
} catch {}
const FFMPEG_BIN = process.env.FFMPEG_PATH || bundledFfmpeg || "ffmpeg";
const transcodeSessions = new Map();

function transcodeSnapshot(id) {
  const session = transcodeSessions.get(id);
  if (!session) return null;
  let playlist = "";
  try {
    playlist = fs.readFileSync(session.playlistPath, "utf8");
  } catch {}
  const segments = (playlist.match(/#EXTINF/g) || []).length;
  return {
    id,
    status: session.status,
    error: session.error,
    ready: segments > 0,
    segments,
    ended: playlist.includes("#EXT-X-ENDLIST"),
    playlist: "/api/transcode/" + id + "/index.m3u8",
  };
}

function stopTranscode(id) {
  const session = transcodeSessions.get(id);
  if (!session) return;
  transcodeSessions.delete(id);
  try {
    if (session.proc && !session.proc.killed) session.proc.kill("SIGKILL");
  } catch {}
  try {
    fs.rmSync(session.dir, { recursive: true, force: true });
  } catch {}
}


app.post("/api/transcode/init", (req, res) => {
  const size = Number(req.body && req.body.size);
  if (size > TRANSCODE_MAX_BYTES) return res.status(413).json({ ok: false, error: "文件太大，无法建立流式转码会话" });
  const id = crypto.randomBytes(12).toString("hex");
  const ext = String((req.body && req.body.ext) || "bin")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || "bin";
  const dir = path.join(TRANSCODE_ROOT, id);
  const inputPath = path.join(dir, "input." + ext);
  const playlistPath = path.join(dir, "index.m3u8");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(inputPath, Buffer.alloc(0));
  transcodeSessions.set(id, {
    id,
    dir,
    inputPath,
    playlistPath,
    status: "uploading",
    error: null,
    proc: null,
    startedAt: Date.now(),
    uploaded: 0,
  });
  res.json({ ok: true, id, chunkSize: 32 * 1024 * 1024 });
});

app.post("/api/transcode/:id/chunk", (req, res) => {
  const session = transcodeSessions.get(req.params.id);
  if (!session || session.status !== "uploading") return res.status(409).json({ ok: false, error: "转码会话不可写入" });
  const output = fs.createWriteStream(session.inputPath, { flags: "a" });
  let aborted = false;
  req.on("aborted", () => {
    aborted = true;
    output.destroy();
  });
  output.on("error", (error) => {
    if (!res.headersSent) res.status(500).json({ ok: false, error: error.message });
  });
  req.pipe(output);
  output.on("finish", () => {
    if (aborted) return;
    session.uploaded += Number(req.get("content-length") || 0);
    res.json({ ok: true, uploaded: session.uploaded });
  });
});

app.post("/api/transcode/:id/start", (req, res) => {
  const session = transcodeSessions.get(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: "转码会话不存在" });
  if (session.status !== "uploading") return res.status(409).json({ ok: false, error: "转码会话已经开始" });
  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-y",
    "-i", session.inputPath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-hls_time", "2",
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_segment_filename", path.join(session.dir, "seg%05d.ts"),
    session.playlistPath,
  ];
  const logPath = path.join(session.dir, "ffmpeg.log");
  const log = fs.createWriteStream(logPath);
  try {
    session.proc = spawn(FFMPEG_BIN, args, { cwd: session.dir, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    session.status = "error";
    session.error = error.message;
    return res.status(500).json({ ok: false, error: "无法启动 ffmpeg: " + error.message });
  }
  session.status = "running";
  if (session.proc.stderr) session.proc.stderr.pipe(log);
  session.proc.on("error", (error) => {
    session.status = "error";
    session.error = error.code === "ENOENT" ? "本机没有找到 ffmpeg，请安装 ffmpeg 后重试" : error.message;
  });
  session.proc.on("close", (code) => {
    if (code === 0) {
      session.status = "done";
      return;
    }
    session.status = "error";
    if (!session.error) {
      let detail = "";
      try {
        detail = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-3).join(" ").slice(-500);
      } catch {}
      session.error = "ffmpeg 转码失败" + (detail ? ": " + detail : "");
    }
  });
  res.json({ ok: true, id: session.id });
});
app.post("/api/transcode", (req, res) => {
  const size = Number(req.get("content-length") || 0);
  if (size > TRANSCODE_MAX_BYTES) {
    req.resume();
    return res.status(413).json({ ok: false, error: "文件太大，无法建立流式转码会话" });
  }
  const id = crypto.randomBytes(12).toString("hex");
  const ext = String(req.get("x-media-ext") || "bin")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || "bin";
  const dir = path.join(TRANSCODE_ROOT, id);
  const inputPath = path.join(dir, "input." + ext);
  const playlistPath = path.join(dir, "index.m3u8");
  fs.mkdirSync(dir, { recursive: true });
  const output = fs.createWriteStream(inputPath);
  let aborted = false;

  req.on("aborted", () => {
    aborted = true;
    output.destroy();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  output.on("error", (error) => {
    if (!res.headersSent) res.status(500).json({ ok: false, error: error.message });
  });
  req.pipe(output);
  output.on("finish", () => {
    if (aborted) return;
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      "-y",
      "-i", inputPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-force_key_frames", "expr:gte(t,n_forced*2)",
      "-hls_time", "2",
      "-hls_list_size", "0",
      "-hls_playlist_type", "event",
      "-hls_segment_filename", path.join(dir, "seg%05d.ts"),
      playlistPath,
    ];
    const logPath = path.join(dir, "ffmpeg.log");
    const log = fs.createWriteStream(logPath);
    const session = {
      id,
      dir,
      inputPath,
      playlistPath,
      status: "running",
      error: null,
      proc: null,
      startedAt: Date.now(),
    };
    transcodeSessions.set(id, session);
    try {
      session.proc = spawn(FFMPEG_BIN, args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      session.status = "error";
      session.error = error.message;
      return res.status(500).json({ ok: false, error: "无法启动 ffmpeg: " + error.message });
    }
    if (session.proc.stderr) session.proc.stderr.pipe(log);
    session.proc.on("error", (error) => {
      session.status = "error";
      session.error = error.code === "ENOENT" ? "本机没有找到 ffmpeg，请安装 ffmpeg 后重试" : error.message;
    });
    session.proc.on("close", (code) => {
      if (code === 0) {
        session.status = "done";
        return;
      }
      session.status = "error";
      if (!session.error) {
        let detail = "";
        try {
          detail = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-3).join(" ").slice(-500);
        } catch {}
        session.error = "ffmpeg 转码失败" + (detail ? ": " + detail : "");
      }
    });
    res.json({ ok: true, id, playlist: "/api/transcode/" + id + "/index.m3u8" });
  });
});

app.get("/api/transcode/:id/status", (req, res) => {
  const snapshot = transcodeSnapshot(req.params.id);
  if (!snapshot) return res.status(404).json({ ok: false, error: "转码会话不存在或已结束" });
  res.json({ ok: true, ...snapshot });
});

app.delete("/api/transcode/:id", (req, res) => {
  stopTranscode(req.params.id);
  res.json({ ok: true });
});

app.use(
  "/api/transcode",
  (req, res, next) => {
    if (!/^\/[a-f0-9]{24}\/(index\.m3u8|seg\d{5}\.ts)$/.test(req.path)) return res.status(404).end();
    next();
  },
  express.static(TRANSCODE_ROOT, {
    fallthrough: true,
    setHeaders(res, filePath) {
      res.setHeader("Cache-Control", "no-store");
      if (filePath.endsWith(".m3u8")) res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      if (filePath.endsWith(".ts")) res.setHeader("Content-Type", "video/mp2t");
    },
  })
);

/* ------------------------------------------------------------------ */
/* server-backed media library: paths + playback state live outside    */
/* DATA_DIR, so changing browsers does not lose the library.          */
/* ------------------------------------------------------------------ */
app.get("/api/media-library", (_req, res) => {
  res.json({ ok: true, ...mediaLibrarySnapshot() });
});

app.post("/api/media-library/folders", async (req, res) => {
  try {
    const result = await addMediaFolder(req.body && req.body.path);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/media-library/folders/:id/rescan", async (req, res) => {
  try {
    const result = await rescanMediaFolder(req.params.id);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete("/api/media-library/folders/:id", async (req, res) => {
  try {
    const result = await removeMediaFolder(req.params.id);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete("/api/media-library/items/:id", async (req, res) => {
  try {
    const result = await removeMediaItem(req.params.id);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.patch("/api/media-library/items/:id", async (req, res) => {
  try {
    const item = await updateMediaItem(req.params.id, req.body || {});
    res.json({ ok: true, item });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/media-library/file/:id", (req, res) => {
  const info = mediaFileInfo(req.params.id);
  if (!info) return res.status(404).json({ ok: false, error: "媒体文件不存在" });
  res.setHeader("Content-Type", info.mime);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(info.absolutePath, (error) => {
    if (error && !res.headersSent) res.status(404).json({ ok: false, error: "无法读取媒体文件" });
  });
});

app.get("/api/media-library/subtitle/:id", (req, res) => {
  const info = mediaSubtitleInfo(req.params.id);
  if (!info) return res.status(404).json({ ok: false, error: "没有字幕" });
  res.type("text/plain; charset=utf-8");
  res.send(info.text);
});

app.post("/api/media-library/items/:id/transcode", (req, res) => {
  const info = mediaFileInfo(req.params.id);
  if (!info) return res.status(404).json({ ok: false, error: "媒体文件不存在" });
  const id = crypto.randomBytes(12).toString("hex");
  const dir = path.join(TRANSCODE_ROOT, id);
  const playlistPath = path.join(dir, "index.m3u8");
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-y",
    "-i", info.absolutePath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-hls_time", "2",
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_segment_filename", path.join(dir, "seg%05d.ts"),
    playlistPath,
  ];
  const logPath = path.join(dir, "ffmpeg.log");
  const log = fs.createWriteStream(logPath);
  const session = {
    id,
    dir,
    inputPath: info.absolutePath,
    playlistPath,
    status: "running",
    error: null,
    proc: null,
    startedAt: Date.now(),
  };
  transcodeSessions.set(id, session);
  try {
    session.proc = spawn(FFMPEG_BIN, args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    session.status = "error";
    session.error = error.message;
    return res.status(500).json({ ok: false, error: "无法启动 ffmpeg: " + error.message });
  }
  if (session.proc.stderr) session.proc.stderr.pipe(log);
  session.proc.on("error", (error) => {
    session.status = "error";
    session.error = error.code === "ENOENT" ? "本机没有找到 ffmpeg，请安装 ffmpeg 后重试" : error.message;
  });
  session.proc.on("close", (code) => {
    if (code === 0) {
      session.status = "done";
      return;
    }
    session.status = "error";
    if (!session.error) {
      let detail = "";
      try { detail = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-3).join(" ").slice(-500); } catch {}
      session.error = "ffmpeg 转码失败" + (detail ? ": " + detail : "");
    }
  });
  res.json({ ok: true, id, playlist: "/api/transcode/" + id + "/index.m3u8" });
});

const transcodeCleanup = setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, session] of transcodeSessions) {
    if (session.startedAt < cutoff) stopTranscode(id);
  }
  try {
    for (const name of fs.readdirSync(TRANSCODE_ROOT)) {
      const dir = path.join(TRANSCODE_ROOT, name);
      if (transcodeSessions.has(name)) continue;
      const stat = fs.statSync(dir);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}, 10 * 60 * 1000);
if (transcodeCleanup.unref) transcodeCleanup.unref();

/* Cover proxy: the image CDN intermittently fails DNS from this machine, so
 * covers are fetched (and cached) server-side with retries. */
const COVERS_DIR = path.join(DATA_DIR, "covers");
const coverCache = new Map();

app.get("/api/cover", async (req, res) => {
  const url = String(req.query.u || "");
  if (!/^https:\/\/(img|file)\.mkexue\.com\//.test(url)) {
    return res.status(400).json({ ok: false, error: "不支持的封面地址" });
  }
  const hash = crypto.createHash("sha1").update(url).digest("hex");
  if (coverCache.has(hash)) {
    const hit = coverCache.get(hash);
    res.setHeader("Content-Type", hit.type);
    res.setHeader("Cache-Control", "public, max-age=604800");
    return res.end(hit.buffer);
  }
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  const existing = fs.readdirSync(COVERS_DIR).find((f) => f.startsWith(hash));
  if (existing) {
    const buffer = fs.readFileSync(path.join(COVERS_DIR, existing));
    const type = existing.endsWith(".png") ? "image/png" : existing.endsWith(".webp") ? "image/webp" : "image/jpeg";
    coverCache.set(hash, { buffer, type });
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=604800");
    return res.end(buffer);
  }
  try {
    const buffer = await fetchBinary(url, { attempts: 6, timeoutMs: 30000 });
    const ext = extFromContentType(buffer, url);
    const type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    fs.writeFileSync(path.join(COVERS_DIR, hash + "." + ext), buffer);
    coverCache.set(hash, { buffer, type });
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.end(buffer);
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

const coverSrc = (url) => (url && /^https:\/\/(img|file)\.mkexue\.com\//.test(url) ? "/api/cover?u=" + encodeURIComponent(url) : url || null);

/* ------------------------------------------------------------------ */
/* session + credentials                                               */
/* ------------------------------------------------------------------ */
function maskAccount(login) {
  if (!login) return null;
  const text = String(login);
  if (/^\d{7,}$/.test(text)) return text.replace(/^(\d{3})\d+(\d{4})$/, "$1****$2");
  return text.length > 4 ? text.slice(0, 2) + "****" + text.slice(-2) : text;
}

function sessionInfo() {
  const record = readAuthRecord();
  return {
    authenticated: session.authenticated,
    expiresAt: session.expiresAt || (record && record.expiresAt) || null,
    loginAt: record ? record.loginAt || null : null,
    source: session.source,
    account: maskAccount(record && record.login),
    upstream: UPSTREAM.site,
  };
}

function credentialsFromBody(req) {
  return normalizeCredentials((req && req.body) || {});
}

function sendAuthError(res, error) {
  const required = error && error.code === "CREDENTIALS_REQUIRED";
  res.status(required ? 401 : 502).json({
    ok: false,
    error: error ? error.message : "登录失败",
    code: (error && error.code) || null,
  });
}

app.get("/api/session", (req, res) => {
  res.json({ ok: true, ...sessionInfo() });
});

app.post("/api/session/login", async (req, res) => {
  const creds = credentialsFromBody(req);
  if (!creds) {
    return res.status(400).json({ ok: false, code: "CREDENTIALS_REQUIRED", error: "请输入手机号和密码" });
  }
  try {
    await session.login(creds);
    res.json({ ok: true, ...sessionInfo() });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/session/logout", (req, res) => {
  session.logout();
  res.json({ ok: true, ...sessionInfo() });
});

/* ------------------------------------------------------------------ */
/* local cache helpers                                                 */
/* ------------------------------------------------------------------ */
const cachePath = (year) => path.join(DATA_DIR, "cache", "index-" + year + ".json");
const MAGAZINES_FILE = path.join(DATA_DIR, "cache", "magazines.json");

function readDiskCache(year) {
  try {
    const payload = JSON.parse(fs.readFileSync(cachePath(year), "utf8"));
    if (!payload || !Array.isArray(payload.issues)) return null;
    if (!payload.year) payload.year = Number(year);
    return payload;
  } catch {
    return null;
  }
}

function writeDiskCache(year, payload) {
  try {
    fs.mkdirSync(path.join(DATA_DIR, "cache"), { recursive: true });
    fs.writeFileSync(cachePath(year), JSON.stringify(payload, null, 2));
  } catch {}
}

function cachedYears() {
  try {
    const dir = path.join(DATA_DIR, "cache");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("index-") && f.endsWith(".json"))
      .map((f) => Number(f.slice(6, -5)))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function latestDiskCache() {
  try {
    const dir = path.join(DATA_DIR, "cache");
    if (!fs.existsSync(dir)) return null;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("index-") && f.endsWith(".json"))
      .map((f) => ({ file: f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    if (!files.length) return null;
    const payload = JSON.parse(fs.readFileSync(path.join(dir, files[0].file), "utf8"));
    if (payload && !payload.year) payload.year = Number(files[0].file.slice(6, -5));
    return payload;
  } catch {
    return null;
  }
}

function readMagazineCache() {
  try {
    const rows = JSON.parse(fs.readFileSync(MAGAZINES_FILE, "utf8"));
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function writeMagazineCache(rows) {
  try {
    fs.mkdirSync(path.join(DATA_DIR, "cache"), { recursive: true });
    fs.writeFileSync(MAGAZINES_FILE, JSON.stringify(rows, null, 2));
  } catch {}
}

function mapMagazines(rows) {
  return (rows || []).map((m) => ({
    magazineId: String(m.magazineId),
    name: m.magazineName,
    type: m.magazineTypeLabel,
    description: m.description,
    coverUrl: coverSrc(m.coverImage),
    free: m.freeLabel,
    tradeList: m.tradeList || [],
  }));
}

/* ------------------------------------------------------------------ */
/* library (cache-first; no automatic login, no automatic browser)     */
/* ------------------------------------------------------------------ */
function localIndex() {
  const map = new Map();
  for (const issue of listLocalIssues()) map.set(String(issue.nodeId), issue);
  return map;
}

async function buildLibrary(yearParam) {
  const local = localIndex();
  const localYears = [...new Set([...local.values()].map((i) => i.year).filter(Boolean))].sort((a, b) => b - a);
  const diskYears = cachedYears();
  const latest = latestDiskCache();

  const knownYears = [...new Set([...diskYears, ...localYears, ...(latest && latest.years ? latest.years.map(Number) : [])])]
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a);

  const year = Number(yearParam) || (latest && Number(latest.year)) || knownYears[0] || new Date().getFullYear();
  if (!knownYears.includes(year)) knownYears.push(year);
  knownYears.sort((a, b) => b - a);

  let index = readDiskCache(year);
  if (!index && latest && Number(latest.year) === Number(year)) index = latest;

  const issueRows = index && Array.isArray(index.issues) ? index.issues.filter((i) => Number(i.year) === Number(year)) : [];

  let magazines = readMagazineCache() || [];
  let magazineError = null;
  if (!magazines.length && session.authenticated) {
    try {
      const rows = await getMagazines();
      if (rows && rows.length) {
        magazines = mapMagazines(rows);
        writeMagazineCache(magazines);
      }
    } catch (error) {
      magazineError = error.message;
    }
  }

  if (!magazines.length) {
    const sample = [...local.values()].find((i) => i.title && (i.coverLocalUrl || i.coverUrl)) || issueRows.find((i) => i.title);
    if (sample) {
      magazines = [{
        magazineId: sample.magazineId ? String(sample.magazineId) : "local",
        name: sample.title,
        type: "LOCAL ARCHIVE",
        description: "本地离线档案。登录 mkexue.com 后可同步订阅信息与最新过刊索引。",
        coverUrl: sample.coverLocalUrl || coverSrc(sample.coverUrl),
        free: "离线可读",
        tradeList: [],
      }];
    }
  }

  const merged = new Map();
  for (const issue of issueRows) {
    const meta = local.get(String(issue.nodeId));
    merged.set(String(issue.nodeId), {
      ...issue,
      local: meta ? { complete: meta.complete, pageCount: meta.pageCount, bytes: meta.bytes, coverLocalUrl: meta.coverLocalUrl } : null,
      progress: meta ? meta.progress : null,
      job: findActiveJob(issue.nodeId),
    });
  }
  for (const meta of local.values()) {
    const id = String(meta.nodeId);
    if (merged.has(id) || Number(meta.year) !== Number(year)) continue;
    merged.set(id, {
      nodeId: id,
      title: meta.title,
      volume: meta.volume,
      year: meta.year,
      month: meta.month,
      number: meta.number,
      coverUrl: meta.coverUrl,
      publishTime: meta.publishTime,
      local: { complete: meta.complete, pageCount: meta.pageCount, bytes: meta.bytes, coverLocalUrl: meta.coverLocalUrl },
      progress: meta.progress,
      job: findActiveJob(id),
    });
  }

  for (const issue of merged.values()) issue.coverUrl = coverSrc(issue.coverUrl);

  const issues = [...merged.values()].sort((a, b) => (b.year - a.year) || (b.number - a.number));
  const archived = [...local.values()].filter((i) => i.complete);

  return {
    ok: true,
    fetchedAt: index ? index.fetchedAt || null : null,
    stale: Boolean(index && index.fetchedAt && Date.now() - index.fetchedAt > 20 * 60 * 1000),
    source: index ? "cache" : "local",
    needsLogin: !session.authenticated,
    remoteError: null,
    magazineError,
    year,
    years: knownYears,
    magazines,
    issues,
    localCount: archived.length,
    storageBytes: archived.reduce((sum, i) => sum + (i.bytes || 0), 0),
  };
}

app.get("/api/library", async (req, res) => {
  try {
    res.json(await buildLibrary(req.query.year));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* sync (explicit user action; browser credentials required)           */
/* ------------------------------------------------------------------ */
let syncInFlight = null;

function persistSyncResult(result, requestedYear) {
  const issues = (result.issues || []).map(normalizeIssue);
  const years = [
    ...new Set([
      ...((result.years || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)),
      ...issues.map((i) => Number(i.year)).filter((n) => Number.isFinite(n) && n > 0),
    ]),
  ].sort((a, b) => b - a);
  const year = Number(requestedYear) || (issues[0] && Number(issues[0].year)) || years[0] || new Date().getFullYear();
  const payload = { years, year, issues, fetchedAt: Date.now(), source: "live" };
  if (issues.length) writeDiskCache(year, payload);
  return payload;
}

app.post("/api/sync", async (req, res) => {
  const creds = credentialsFromBody(req);
  if (creds) session.setCredentials(creds);
  const effective = creds || session.credentials;
  if (!session.authenticated && !effective) {
    return res.status(401).json({ ok: false, code: "CREDENTIALS_REQUIRED", error: "同步订阅库需要手机号和密码" });
  }
  const year = req.body && req.body.year ? Number(req.body.year) : null;
  try {
    if (!syncInFlight) {
      syncInFlight = syncWithBrowser({
        year,
        tokenHint: session.authenticated ? session.token : null,
        credentials: effective,
      }).finally(() => {
        syncInFlight = null;
      });
    }
    const result = await syncInFlight;
    if (result.token) session.adoptToken(result.token, (creds && creds.login) || (session.credentials && session.credentials.login));
    const payload = persistSyncResult(result, year);
    if (!payload.issues.length) {
      throw new Error("没有捕获到过刊索引（请确认账号订阅状态，或稍后重试）");
    }
    try {
      const rows = await getMagazines();
      if (rows && rows.length) writeMagazineCache(mapMagazines(rows));
    } catch {}
    res.json({
      ok: true,
      synced: payload.issues.length,
      year: payload.year,
      years: payload.years,
      session: sessionInfo(),
    });
  } catch (error) {
    sendAuthError(res, error);
  }
});

/* ------------------------------------------------------------------ */
/* single issue                                                        */
/* ------------------------------------------------------------------ */
app.get("/api/issues/:nodeId", (req, res) => {
  const nodeId = String(req.params.nodeId);
  res.json({ ok: true, nodeId, local: localIssue(nodeId), job: findActiveJob(nodeId) });
});

app.get("/api/issues/:nodeId/pages", (req, res) => {
  const nodeId = String(req.params.nodeId);
  const info = localIssue(nodeId);
  if (!info) return res.status(404).json({ ok: false, error: "本地没有这一期" });
  res.json({
    ok: true,
    nodeId,
    title: info.title,
    volume: info.volume,
    pages: info.pages,
    pageCount: info.pageCount,
    progress: info.progress,
  });
});

app.get("/api/issues/:nodeId/progress", (req, res) => {
  const nodeId = String(req.params.nodeId);
  res.json({ ok: true, nodeId, progress: readProgress(nodeId) });
});

app.put("/api/issues/:nodeId/progress", (req, res) => {
  const nodeId = String(req.params.nodeId);
  const info = localIssue(nodeId);
  if (!info) return res.status(404).json({ ok: false, error: "本地没有这一期" });
  const page = Number(req.body && req.body.page);
  const total = Number(req.body && req.body.total) || info.pages.length;
  if (!page || page < 1) return res.status(400).json({ ok: false, error: "页码无效" });
  const progress = writeProgress(nodeId, Math.min(page, total), total);
  res.json({ ok: true, nodeId, progress });
});

app.post("/api/issues/:nodeId/download", (req, res) => {
  const nodeId = String(req.params.nodeId);
  const creds = credentialsFromBody(req);
  if (creds) session.setCredentials(creds);
  if (!session.authenticated && !session.credentials) {
    return res.status(401).json({ ok: false, code: "CREDENTIALS_REQUIRED", error: "归档下载需要手机号和密码" });
  }
  if (isComplete(nodeId)) return res.json({ ok: true, alreadyLocal: true, job: null });
  const job = startDownload(nodeId);
  res.json({ ok: true, job });
});

app.delete("/api/issues/:nodeId", (req, res) => {
  try {
    deleteLocal(String(req.params.nodeId));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* jobs + SSE                                                          */
/* ------------------------------------------------------------------ */
app.get("/api/jobs", (req, res) => res.json({ ok: true, jobs: listJobs() }));

app.post("/api/reveal", (req, res) => {
  const nodeId = req.body && req.body.nodeId ? String(req.body.nodeId) : null;
  if (nodeId && !/^[\w-]+$/.test(nodeId)) return res.status(400).json({ ok: false, error: "目录名无效" });
  const target = nodeId ? path.join(ISSUES_DIR, nodeId) : ISSUES_DIR;
  if (!fs.existsSync(target)) return res.status(404).json({ ok: false, error: "目录不存在" });
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(command, [target], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (error) => console.error("[reveal]", error.message));
    child.unref();
    res.json({ ok: true, path: target, command });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = cancelJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "没有这个任务" });
  res.json({ ok: true, job });
});

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const onJob = (job) => res.write("event: job\ndata: " + JSON.stringify(job) + "\n\n");
  bus.on("job", onJob);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  res.write("event: hello\ndata: {}\n\n");
  req.on("close", () => {
    clearInterval(ping);
    bus.off("job", onJob);
  });
});

/* ------------------------------------------------------------------ */
/* static frontend                                                     */
/* ------------------------------------------------------------------ */
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/media/") || req.path.startsWith("/vendor/")) return next();
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log("[wasteland-archive] plugin runtime online at http://127.0.0.1:" + PORT);
  console.log("[wasteland-archive] mkx archive stored in " + ISSUES_DIR);
});
