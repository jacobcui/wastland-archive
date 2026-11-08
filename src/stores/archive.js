import { reactive, computed } from "vue";
import { request } from "@/lib/http";
import { notify } from "./ui";
import { ensureCredentials, loginWithSaved, sessionState } from "./session";

export const state = reactive({
  library: null,
  loading: false,
  busy: false,
  error: null,
  needsLogin: false,
  year: null,
  jobs: {},
  reader: {
    open: false,
    nodeId: null,
    title: "",
    volume: "",
    pages: [],
    page: 1,
    resumeAt: 1,
    askResume: false,
    spread: false,
    fit: "height",
    showRail: true,
    zoom: 1,
  },
});

/* ------------------------------------------------------------------ */
/* session                                                             */
/* ------------------------------------------------------------------ */
export async function syncArchive() {
  if (state.busy) return false;
  state.busy = true;
  state.error = null;
  const creds = await ensureCredentials("同步订阅库需要登录 mkexue.com");
  if (!creds) {
    state.busy = false;
    return false;
  }
  state.loading = true;
  try {
    const data = await request("/api/sync", {
      method: "POST",
      body: JSON.stringify({
        login: creds.login,
        password: creds.password,
        year: state.year || undefined,
      }),
      timeoutMs: 240000,
    });
    if (data.session) sessionState.session = data.session;
    await loadLibrary(data.year || state.year, false);
    notify("同步完成 · " + data.synced + " 期 · " + (data.year || "—"), "success");
    return true;
  } catch (error) {
    state.error = error.message;
    notify("同步失败: " + error.message, "error");
    return false;
  } finally {
    state.busy = false;
    state.loading = false;
  }
}

export async function relogin() {
  if (state.busy) return false;
  state.busy = true;
  try {
    const ok = await loginWithSaved("重新登录 mkexue.com 订阅账号");
    if (!ok) return false;
    await loadLibrary(state.year, false);
    return true;
  } finally {
    state.busy = false;
  }
}

/* ------------------------------------------------------------------ */
/* library                                                             */
/* ------------------------------------------------------------------ */
export async function loadLibrary(year = null, refresh = false) {
  state.loading = true;
  state.error = null;
  try {
    const params = new URLSearchParams();
    if (year) params.set("year", year);
    if (refresh) params.set("refresh", "1");
    const data = await request("/api/library?" + params.toString());
    state.library = data;
    state.year = data.year;
    state.needsLogin = Boolean(data.needsLogin);
    if (data.remoteError) state.error = "远端同步失败: " + data.remoteError;
    for (const issue of data.issues) {
      if (issue.job) state.jobs[issue.nodeId] = issue.job;
    }
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
  }
}

export function selectYear(year) {
  if (year === state.year) return;
  loadLibrary(year, false);
}

/* ------------------------------------------------------------------ */
/* jobs                                                                */
/* ------------------------------------------------------------------ */
export function jobsFor(nodeId) {
  return state.jobs[String(nodeId)] || null;
}

export const activeJobs = computed(() =>
  Object.values(state.jobs).filter((job) => ["queued", "preparing", "downloading"].includes(job.status)),
);

export function applyJob(job) {
  if (!job) return;
  state.jobs[job.nodeId] = job;
  if (job.status === "complete") {
    const issue = issues().find((item) => item.nodeId === job.nodeId);
    if (issue) issue.local = { complete: true, pageCount: job.total, bytes: job.bytes };
    notify("归档完成 · " + (job.volume || job.title) + " · " + job.total + " 页", "success");
    setTimeout(() => loadLibrary(state.year, false), 600);
  } else if (job.status === "error") {
    notify("归档中断: " + (job.error || "未知错误"), "error");
  } else if (job.status === "canceled") {
    notify("已取消归档任务", "info");
  }
}

export async function downloadIssue(issue) {
  const creds = await ensureCredentials("归档下载需要登录 mkexue.com");
  if (!creds) return;
  try {
    const data = await request("/api/issues/" + issue.nodeId + "/download", {
      method: "POST",
      body: JSON.stringify({ login: creds.login, password: creds.password }),
    });
    if (data.alreadyLocal) {
      notify("本地已有完整归档", "info");
      await loadLibrary(state.year, false);
      return;
    }
    if (data.job) {
      state.jobs[data.job.nodeId] = data.job;
      notify("开始归档 · " + issue.volume, "info");
    }
  } catch (error) {
    notify("无法开始下载: " + error.message, "error");
  }
}

export async function cancelDownload(nodeId) {
  const job = jobsFor(nodeId);
  if (!job) return;
  try {
    await request("/api/jobs/" + job.id + "/cancel", { method: "POST" });
  } catch (error) {
    notify(error.message, "error");
  }
}

/* ------------------------------------------------------------------ */
/* reader                                                              */
/* ------------------------------------------------------------------ */
export const issues = () => (state.library ? [...state.library.issues] : []);

export async function openReader(issue) {
  try {
    const data = await request("/api/issues/" + issue.nodeId + "/pages");
    if (!data.pages || !data.pages.length) throw new Error("本地归档不完整");
    const total = data.pages.length;
    const saved = data.progress && data.progress.page ? Math.min(data.progress.page, total) : 1;
    const finished = saved >= total;
    state.reader = {
      open: true,
      nodeId: issue.nodeId,
      title: data.title || issue.title,
      volume: data.volume || issue.volume,
      pages: data.pages,
      page: finished ? 1 : saved,
      resumeAt: saved,
      askResume: saved > 1 && !finished,
      spread: false,
      fit: "height",
      showRail: true,
      zoom: 1,
    };
    document.body.style.overflow = "hidden";
  } catch (error) {
    notify("无法打开阅读器: " + error.message, "error");
  }
}

export function closeReader() {
  flushProgress();
  state.reader.open = false;
  state.reader.askResume = false;
  document.body.style.overflow = "";
}

/* ----- reading progress ----- */
let progressTimer = null;

export function flushProgress() {
  const reader = state.reader;
  if (!reader.open || !reader.nodeId || !reader.pages.length) return;
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  const payload = { page: reader.page, total: reader.pages.length };
  const issue = issues().find((item) => String(item.nodeId) === String(reader.nodeId));
  if (issue) issue.progress = { ...payload, updatedAt: new Date().toISOString() };
  fetch("/api/issues/" + reader.nodeId + "/progress", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function queueProgress() {
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = setTimeout(flushProgress, 700);
}

export function goToPage(page) {
  const total = state.reader.pages.length;
  const next = Math.min(Math.max(1, page), total);
  state.reader.page = next;
  state.reader.askResume = false;
  queueProgress();
}

export function resumeReading() {
  state.reader.askResume = false;
  if (state.reader.resumeAt) state.reader.page = state.reader.resumeAt;
  queueProgress();
}

export function restartReading() {
  state.reader.askResume = false;
  goToPage(1);
}

export function stepPage(delta) {
  const step = state.reader.spread ? 2 : 1;
  goToPage(state.reader.page + delta * step);
}

export function toggleSpread() {
  state.reader.spread = !state.reader.spread;
  if (state.reader.spread && state.reader.page % 2 === 0) goToPage(state.reader.page - 1);
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */
let source = null;
export function connectEvents() {
  if (source) return;
  source = new EventSource("/api/events");
  source.addEventListener("job", (event) => {
    try {
      applyJob(JSON.parse(event.data));
    } catch {}
  });
  source.addEventListener("error", () => {
    /* EventSource retries on its own */
  });
}

export function disconnectEvents() {
  if (source) source.close();
  source = null;
}

export async function revealArchive(nodeId = null) {
  const issuesDir = state.library && state.library.paths && state.library.paths.issuesDir;
  const sep = issuesDir && issuesDir.includes("\\") ? "\\" : "/";
  const target = issuesDir ? (nodeId ? issuesDir + sep + nodeId : issuesDir) : null;
  if (target && window.wastelandDesktop && typeof window.wastelandDesktop.revealPath === "function") {
    try {
      const result = await window.wastelandDesktop.revealPath(target);
      if (result && result.ok) {
        notify("已打开: " + target, "info");
      } else {
        notify("无法打开目录: " + ((result && result.error) || "未知错误"), "error");
      }
      return;
    } catch (error) {
      notify("无法打开目录: " + error.message, "error");
      return;
    }
  }
  try {
    const data = await request("/api/reveal", { method: "POST", body: JSON.stringify({ nodeId }) });
    notify("已打开: " + data.path, "info");
  } catch (error) {
    notify("无法打开目录: " + error.message, "error");
  }
}

export async function refreshJobs() {
  try {
    const data = await request("/api/jobs");
    for (const job of data.jobs || []) {
      if (["queued", "preparing", "downloading"].includes(job.status)) state.jobs[job.nodeId] = job;
    }
  } catch {}
}

export function progressOf(job) {
  if (!job || !job.total) return 0;
  return Math.min(1, (job.downloaded + job.failed) / job.total);
}
