import fs from "node:fs";
import path from "node:path";
import { ISSUES_DIR, DATA_DIR } from "./config.js";

export function ensureDirs() {
  fs.mkdirSync(ISSUES_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const issueDir = (nodeId) => path.join(ISSUES_DIR, String(nodeId));
export const pagesDir = (nodeId) => path.join(issueDir(nodeId), "pages");
export const metaPath = (nodeId) => path.join(issueDir(nodeId), "meta.json");

export function readMeta(nodeId) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(nodeId), "utf8"));
  } catch {
    return null;
  }
}

export function writeMeta(nodeId, meta) {
  fs.mkdirSync(issueDir(nodeId), { recursive: true });
  fs.writeFileSync(metaPath(nodeId), JSON.stringify(meta, null, 2));
}

export function isComplete(nodeId) {
  const meta = readMeta(nodeId);
  if (!meta) return false;
  if (meta.status !== "complete") return false;
  const dir = pagesDir(nodeId);
  if (!fs.existsSync(dir)) return false;
  const files = fs.readdirSync(dir).filter((f) => /\.(webp|jpg|jpeg|png)$/i.test(f));
  return files.length >= (meta.pageCount || 0) && files.length > 0;
}

/* ------------------------------ reading progress ------------------------------ */
export const progressPath = (nodeId) => path.join(issueDir(nodeId), "progress.json");

export function readProgress(nodeId) {
  try {
    const raw = JSON.parse(fs.readFileSync(progressPath(nodeId), "utf8"));
    if (!raw || !raw.page) return null;
    return { page: Number(raw.page), total: raw.total ? Number(raw.total) : null, updatedAt: raw.updatedAt || null };
  } catch {
    return null;
  }
}

export function writeProgress(nodeId, page, total) {
  const record = {
    page: Math.max(1, Number(page) || 1),
    total: total ? Number(total) : null,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(issueDir(nodeId), { recursive: true });
  fs.writeFileSync(progressPath(nodeId), JSON.stringify(record, null, 2));
  return record;
}

export function localCoverUrl(nodeId) {
  const dir = issueDir(nodeId);
  if (!fs.existsSync(dir)) return null;
  const cover = fs.readdirSync(dir).find((f) => /^cover\.(webp|jpg|jpeg|png)$/i.test(f));
  return cover ? `/media/issues/${nodeId}/${cover}` : null;
}

export function localIssue(nodeId) {
  const meta = readMeta(nodeId);
  if (!meta) return null;
  const complete = isComplete(nodeId);
  let bytes = 0;
  const dir = pagesDir(nodeId);
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      try {
        bytes += fs.statSync(path.join(dir, file)).size;
      } catch {}
    }
  }
  const pages = listPages(nodeId);
  return { ...meta, complete, bytes, pages, coverLocalUrl: localCoverUrl(nodeId), progress: readProgress(nodeId) };
}

export function listPages(nodeId) {
  const dir = pagesDir(nodeId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(webp|jpg|jpeg|png)$/i.test(f))
    .sort()
    .map((f, index) => ({ index: index + 1, file: f, url: `/media/issues/${nodeId}/pages/${encodeURIComponent(f)}` }));
}

export function listLocalIssues() {
  if (!fs.existsSync(ISSUES_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(ISSUES_DIR)) {
    const full = path.join(ISSUES_DIR, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    const meta = readMeta(entry);
    if (!meta) continue;
    let bytes = 0;
    const pdir = pagesDir(entry);
    if (fs.existsSync(pdir)) {
      for (const file of fs.readdirSync(pdir)) {
        try {
          bytes += fs.statSync(path.join(pdir, file)).size;
        } catch {}
      }
    }
    out.push({ ...meta, complete: isComplete(entry), bytes, coverLocalUrl: localCoverUrl(entry), progress: readProgress(entry) });
  }
  return out;
}

export function removeIssue(nodeId) {
  const dir = issueDir(nodeId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
