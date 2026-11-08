import { reactive } from "vue";
import { notify } from "./ui";
import { t } from "@/i18n";

const CACHE_KEY = "wasteland.update.cache.v1";
const LAST_KEY = "wasteland.update.last-check.v1";
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export const updateState = reactive({
  checking: false,
  checked: false,
  available: false,
  current: __APP_VERSION__,
  latest: "",
  releaseName: "",
  releaseUrl: "",
  publishedAt: null,
  body: "",
  asset: null,
  system: null,
  error: null,
  dialog: false,
  lastChecked: 0,
  downloading: false,
  downloadProgress: null,
  downloadError: null,
  downloadPath: "",
});

function readCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached && cached.latest) applyPayload(cached, false);
  } catch {}
}

function applyPayload(data, persist = true) {
  updateState.checked = true;
  updateState.current = data.current || updateState.current;
  updateState.latest = data.latest || "";
  updateState.available = Boolean(data.updateAvailable);
  updateState.releaseName = data.releaseName || "";
  updateState.releaseUrl = data.releaseUrl || "";
  updateState.publishedAt = data.publishedAt || null;
  updateState.body = data.body || "";
  updateState.asset = data.asset || null;
  updateState.system = data.system || null;
  updateState.error = null;
  updateState.lastChecked = data.checkedAt || Date.now();
  if (persist) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      localStorage.setItem(LAST_KEY, String(Date.now()));
    } catch {}
  }
}

async function platformQuery() {
  /* Native app: ask Electron directly. This is the most reliable source and
     avoids guessing the macOS architecture from the browser User-Agent. */
  const desktop = typeof window !== "undefined" ? window.wastelandDesktop : null;
  if (desktop && typeof desktop.getSystemInfo === "function") {
    try {
      const info = await desktop.getSystemInfo();
      if (info && info.platform) {
        const platform = info.platform === "win32" ? "windows" : info.platform === "darwin" ? "mac" : info.platform;
        return "platform=" + encodeURIComponent(platform) + (info.arch ? "&arch=" + encodeURIComponent(info.arch) : "");
      }
    } catch {}
  }
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  if (/Windows/i.test(ua)) return "platform=windows";
  if (/Macintosh|Mac OS X/i.test(ua)) {
    let arch = "";
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const values = await navigator.userAgentData.getHighEntropyValues(["architecture"]);
        const raw = String(values.architecture || "").toLowerCase();
        if (raw.includes("arm")) arch = "arm64";
        else if (raw.includes("x86")) arch = "x64";
      }
    } catch {}
    return "platform=mac" + (arch ? "&arch=" + arch : "");
  }
  if (/Linux/i.test(ua)) return "platform=linux";
  /* Local server: it knows process.platform/process.arch and will fill these in. */
  return "";
}

export async function checkForUpdates({ manual = false, force = false } = {}) {
  if (updateState.checking) return false;
  updateState.checking = true;
  if (manual) updateState.error = null;
  try {
    const query = await platformQuery();
    const response = await fetch("/api/update?" + query + (force ? "&force=1" : ""), { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || "检查更新失败");
    applyPayload(data, true);
    if (manual) {
      notify(
        data.updateAvailable
          ? t("app.updateFound", { version: data.latest })
          : t("app.updateLatest", { version: data.latest }),
        data.updateAvailable ? "success" : "info"
      );
    }
    return Boolean(data.updateAvailable);
  } catch (error) {
    updateState.error = error.message;
    updateState.checked = true;
    if (manual) notify(t("app.updateFailed", { error: error.message }), "error");
    return false;
  } finally {
    updateState.checking = false;
  }
}

export function maybeCheckForUpdates() {
  readCache();
  let last = 0;
  try { last = Number(localStorage.getItem(LAST_KEY)) || 0; } catch {}
  if (Date.now() - last < CHECK_INTERVAL) return;
  setTimeout(() => checkForUpdates({ manual: false, force: false }), 2500);
}

export function openUpdateDialog() {
  if (!updateState.latest) return;
  updateState.dialog = true;
}

export function closeUpdateDialog() {
  updateState.dialog = false;
}

export async function downloadUpdate() {
  const asset = updateState.asset;
  if (!asset || !asset.url) {
    if (updateState.releaseUrl && typeof window !== "undefined") {
      window.open(updateState.releaseUrl, "_blank", "noopener");
    }
    return false;
  }
  if (updateState.downloading) return false;

  const desktop = typeof window !== "undefined" ? window.wastelandDesktop : null;
  if (desktop && typeof desktop.downloadUpdate === "function") {
    updateState.downloading = true;
    updateState.downloadProgress = null;
    updateState.downloadError = null;
    updateState.downloadPath = "";
    let unsubscribe = null;
    try {
      if (typeof desktop.onUpdateProgress === "function") {
        unsubscribe = desktop.onUpdateProgress((payload) => {
          const percent = payload && Number(payload.percent);
          updateState.downloadProgress = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
        });
      }
      const result = await desktop.downloadUpdate({ url: asset.url, name: asset.name });
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : "下载失败");
      updateState.downloadPath = result.path || "";
      notify(
        result.opened === false
          ? t("app.updateInstallerDownloaded", { path: result.path || "" })
          : t("app.updateInstallerOpened"),
        result.opened === false ? "info" : "success"
      );
      return true;
    } catch (error) {
      updateState.downloadError = error.message;
      notify(t("app.updateDownloadFailed", { error: error.message }), "error");
      return false;
    } finally {
      updateState.downloading = false;
      updateState.downloadProgress = null;
      if (typeof unsubscribe === "function") unsubscribe();
    }
  }

  /* Browser/web package: GitHub serves the asset as an attachment, so opening
     in a new tab starts the correct download without leaving the app. */
  window.open(asset.url, "_blank", "noopener");
  notify(t("app.updateDownloadStarted"), "info");
  return true;
}
