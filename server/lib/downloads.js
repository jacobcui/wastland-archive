import fs from "node:fs";
import dns from "node:dns";
import path from "node:path";
import { EventEmitter } from "node:events";
import https from "node:https";
import { getIssueDetail, normalizeIssue } from "./api.js";
import { issueDir, pagesDir, readMeta, writeMeta, removeIssue } from "./store.js";
import { UA } from "./config.js";

export const jobs = new Map();
export const bus = new EventEmitter();
bus.setMaxListeners(50);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The OSS host (file.mkexue.com) occasionally SERVFAILs on the system
 * resolver, so every connection uses a cached, retrying lookup. */
const dnsCache = new Map();

const lookupSystem = (hostname) =>
  new Promise((resolve, reject) => dns.lookup(hostname, { family: 4 }, (error, address) => (error ? reject(error) : resolve(address))));

const resolveCares = (hostname) =>
  new Promise((resolve, reject) =>
    dns.resolve4(hostname, { ttl: true }, (error, records) => {
      if (error || !records || !records.length) return reject(error || new Error("no A record"));
      resolve(records[0].address);
    }),
  );

async function resolveDoh(hostname) {
  const endpoints = [
    "https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(hostname) + "&type=A",
    "https://dns.google/resolve?name=" + encodeURIComponent(hostname) + "&type=A",
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, { headers: { accept: "application/dns-json" } });
      const json = await res.json();
      const answer = (json.Answer || []).find((entry) => entry.type === 1 || entry.type === 5);
      const a = (json.Answer || []).filter((entry) => entry.type === 1).pop();
      if (a && a.data) return a.data;
      if (answer && answer.data && /^\d+\.\d+\.\d+\.\d+$/.test(answer.data)) return answer.data;
    } catch {}
  }
  throw new Error("DoH 解析失败");
}

async function resolveHost(hostname) {
  const hit = dnsCache.get(hostname);
  if (hit && hit.expires > Date.now()) return hit.address;
  const strategies = [lookupSystem, resolveCares, resolveDoh];
  for (const strategy of strategies) {
    try {
      const address = await strategy(hostname);
      if (address) {
        dnsCache.set(hostname, { address, expires: Date.now() + 5 * 60 * 1000 });
        return address;
      }
    } catch {}
  }
  if (hit) return hit.address;
  throw new Error("DNS 解析失败: " + hostname);
}

function resolveWithCache(hostname, callback) {
  resolveHost(hostname).then((address) => callback(null, address), (error) => callback(error));
}

function lookup(hostname, options, callback) {
  resolveWithCache(hostname, (error, address) => {
    if (error) return callback(error);
    if (options && options.all) return callback(null, [{ address, family: 4 }]);
    return callback(null, address, 4);
  });
}

function downloadOnce(url, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { lookup, headers: { "User-Agent": UA, Accept: "*/*" }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    if (signal) {
      signal.addEventListener("abort", () => req.destroy(new Error("已取消")), { once: true });
    }
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", reject);
  });
}

function emitJob(job) {
  bus.emit("job", publicJob(job));
}

export function publicJob(job) {
  return {
    id: job.id,
    nodeId: job.nodeId,
    title: job.title,
    volume: job.volume,
    coverUrl: job.coverUrl,
    status: job.status,
    total: job.total,
    downloaded: job.downloaded,
    failed: job.failed,
    bytes: job.bytes,
    error: job.error || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
  };
}

export function listJobs() {
  return [...jobs.values()].map(publicJob).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export function findActiveJob(nodeId) {
  for (const job of jobs.values()) {
    if (job.nodeId === String(nodeId) && ["queued", "preparing", "downloading"].includes(job.status)) return publicJob(job);
  }
  return null;
}

/** Download a remote file into memory with exponential backoff (OSS DNS is flaky). */
export async function fetchBinary(url, { attempts = 8, timeoutMs = 45000, signal } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal && signal.aborted) throw new Error("已取消");
    try {
      return await downloadOnce(url, { timeoutMs, signal });
    } catch (error) {
      lastError = error;
      if (signal && signal.aborted) throw error;
      await sleep(Math.min(500 * Math.pow(1.5, attempt), 4000));
    }
  }
  throw new Error("下载失败: " + (lastError ? lastError.message : "未知错误"));
}

export function extFromContentType(buffer, url) {
  if (buffer.length > 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF") return "webp";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
  const m = /\.(webp|jpg|jpeg|png)(\?|$)/i.exec(url || "");
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "webp";
}

async function pool(items, limit, worker, signal) {
  const queue = items.slice();
  const runners = new Array(Math.min(limit, queue.length)).fill(0).map(async () => {
    while (queue.length) {
      if (signal && signal.aborted) return;
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export function startDownload(rawNodeId) {
  const nodeId = String(rawNodeId);
  const existing = findActiveJob(nodeId);
  if (existing) return existing;

  const job = {
    id: "job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
    nodeId,
    title: "电脑报",
    volume: "",
    coverUrl: null,
    status: "queued",
    total: 0,
    downloaded: 0,
    failed: 0,
    bytes: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    controller: new AbortController(),
  };
  jobs.set(job.id, job);
  emitJob(job);

  (async () => {
    try {
      job.status = "preparing";
      emitJob(job);
      const detail = await getIssueDetail(nodeId);
      const base = normalizeIssue(detail);
      const pageSource = (detail.ebookPageVos && detail.ebookPageVos[0] && detail.ebookPageVos[0].webpData) || [];
      const pages = pageSource
        .filter((p) => p && p.ossUrl)
        .map((p, index) => ({ index: index + 1, title: p.title || "第" + (index + 1) + "页", url: p.ossUrl }));

      if (!pages.length) throw new Error("这一期没有可下载的页面（可能需要订阅权限）");

      job.title = base.title;
      job.volume = base.volume;
      job.coverUrl = base.coverUrl;
      job.total = pages.length;

      const dir = issueDir(nodeId);
      const pdir = pagesDir(nodeId);
      fs.mkdirSync(pdir, { recursive: true });

      const meta = {
        nodeId,
        title: base.title,
        volume: base.volume,
        year: base.year,
        month: base.month,
        number: base.number,
        magazineId: base.magazineId,
        coverUrl: base.coverUrl,
        publishTime: base.publishTime,
        pageCount: pages.length,
        status: "downloading",
        startedAt: new Date().toISOString(),
        source: "mkexue.com",
      };
      writeMeta(nodeId, meta);

      // cover
      if (base.coverUrl) {
        try {
          const coverBuf = await fetchBinary(base.coverUrl, { signal: job.controller.signal });
          fs.writeFileSync(path.join(dir, "cover." + extFromContentType(coverBuf, base.coverUrl)), coverBuf);
        } catch {}
      }

      job.status = "downloading";
      emitJob(job);

      await pool(
        pages,
        4,
        async (page) => {
          const label = String(page.index).padStart(3, "0");
          const target = path.join(pdir, "p-" + label);
          try {
            const buf = await fetchBinary(page.url, { signal: job.controller.signal });
            const ext = extFromContentType(buf, page.url);
            fs.writeFileSync(target + "." + ext, buf);
            job.downloaded += 1;
            job.bytes += buf.length;
          } catch (error) {
            job.failed += 1;
          }
          emitJob(job);
        },
        job.controller.signal,
      );

      const metaFinal = {
        ...meta,
        status: job.downloaded === 0 ? "error" : job.failed > 0 ? "partial" : "complete",
        finishedAt: new Date().toISOString(),
        requestedPages: job.total,
        storedPages: job.downloaded,
      };
      writeMeta(nodeId, metaFinal);

      job.status = metaFinal.status === "complete" ? "complete" : "error";
      if (job.status === "error") job.error = job.downloaded === 0 ? "所有页面下载失败" : job.failed + " 页下载失败，可重试补齐";
      job.finishedAt = Date.now();
      emitJob(job);
    } catch (error) {
      const aborted = job.controller.signal.aborted;
      job.status = aborted ? "canceled" : "error";
      job.error = aborted ? "已取消" : error.message;
      job.finishedAt = Date.now();
      const meta = readMeta(nodeId);
      if (meta) writeMeta(nodeId, { ...meta, status: aborted ? "canceled" : "error", error: job.error });
      emitJob(job);
    }
  })();

  return publicJob(job);
}

export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (["queued", "preparing", "downloading"].includes(job.status)) {
    job.controller.abort();
    job.status = "canceled";
    job.finishedAt = Date.now();
    emitJob(job);
  }
  return publicJob(job);
}

export function deleteLocal(nodeId) {
  const active = findActiveJob(nodeId);
  if (active) cancelJob(active.id);
  removeIssue(nodeId);
  return true;
}
