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
  error: null,
  dialog: false,
  lastChecked: 0,
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
  return "platform=web";
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
