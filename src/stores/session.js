import { reactive } from "vue";
import { request } from "@/lib/http";
import { notify } from "./ui";

const STORAGE_KEY = "wasteland.mkx.credentials.v1";

function normalizeSaved(raw) {
  if (!raw || typeof raw !== "object") return null;
  const login = String(raw.login || "").trim();
  const password = String(raw.password || "");
  return login && password ? { login, password } : null;
}

export function readSavedCredentials() {
  try {
    return normalizeSaved(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
  } catch {
    return null;
  }
}

function writeSavedCredentials(creds) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ login: creds.login, password: creds.password }));
  } catch {}
}

export function clearSavedCredentials() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function maskPhone(phone) {
  if (!phone) return "未登录";
  const text = String(phone);
  if (text.includes("*")) return text;
  if (/^\d{7,}$/.test(text)) return text.replace(/^(\d{3})\d+(\d{4})$/, "$1 **** $2");
  return text.length > 4 ? text.slice(0, 2) + "****" + text.slice(-2) : text;
}

const saved = readSavedCredentials();

export const sessionState = reactive({
  session: {
    authenticated: false,
    expiresAt: null,
    loginAt: null,
    source: null,
    account: null,
    upstream: "https://mkexue.com",
  },
  credentials: {
    login: saved ? saved.login : null,
    hasPassword: Boolean(saved),
  },
  loginDialog: {
    open: false,
    reason: "",
    force: false,
    busy: false,
    error: null,
    phone: "",
    password: "",
    remember: true,
    hasSaved: Boolean(saved),
  },
  lastLoginAt: 0,
});

let dialogPromise = null;
let dialogResolve = null;

function finishDialog(value) {
  sessionState.loginDialog.open = false;
  const resolve = dialogResolve;
  dialogResolve = null;
  dialogPromise = null;
  if (resolve) resolve(value);
}

export function openLoginDialog(reason, { force = false, error = null } = {}) {
  if (dialogPromise) {
    if (reason) sessionState.loginDialog.reason = reason;
    if (error) sessionState.loginDialog.error = error;
    if (force) {
      sessionState.loginDialog.force = true;
      sessionState.loginDialog.password = "";
    }
    return dialogPromise;
  }
  const stored = readSavedCredentials();
  Object.assign(sessionState.loginDialog, {
    open: true,
    reason: reason || "登录 mkexue.com 订阅账号",
    force: Boolean(force),
    busy: false,
    error: error || null,
    phone: stored ? stored.login : sessionState.credentials.login || "",
    password: "",
    remember: true,
    hasSaved: Boolean(stored),
  });
  dialogPromise = new Promise((resolve) => {
    dialogResolve = resolve;
  });
  return dialogPromise;
}

export function cancelLoginDialog() {
  finishDialog(null);
}

export async function submitLoginDialog() {
  const dialog = sessionState.loginDialog;
  const login = String(dialog.phone || "").trim();
  const password = String(dialog.password || "");
  if (!login || !password) {
    dialog.error = "请输入手机号和密码";
    return;
  }
  dialog.busy = true;
  dialog.error = null;
  try {
    const data = await request("/api/session/login", {
      method: "POST",
      body: JSON.stringify({ login, password }),
    });
    sessionState.session = data;
    sessionState.lastLoginAt = Date.now();
    if (dialog.remember) {
      writeSavedCredentials({ login, password });
      sessionState.credentials = { login, hasPassword: true };
    } else {
      clearSavedCredentials();
      sessionState.credentials = { login, hasPassword: true };
    }
    notify("登录成功 · " + maskPhone(login), "success");
    finishDialog({ login, password, fresh: true });
  } catch (error) {
    dialog.error = error.message;
    await loadSession();
  } finally {
    dialog.busy = false;
  }
}

export async function loadSession() {
  try {
    const data = await request("/api/session");
    sessionState.session = data;
  } catch {
    /* local offline mode: the shell still opens */
  }
}

export async function ensureCredentials(reason) {
  const stored = readSavedCredentials();
  if (stored) {
    sessionState.credentials = { login: stored.login, hasPassword: true };
    return { ...stored, fresh: false };
  }
  return openLoginDialog(reason);
}

export async function loginWithSaved(reason) {
  const creds = await ensureCredentials(reason);
  if (!creds) return false;
  if (creds.fresh) {
    await loadSession();
    return true;
  }
  try {
    const data = await request("/api/session/login", {
      method: "POST",
      body: JSON.stringify({ login: creds.login, password: creds.password }),
    });
    sessionState.session = data;
    sessionState.lastLoginAt = Date.now();
    notify("登录成功 · " + maskPhone(creds.login), "success");
    return true;
  } catch (error) {
    const retry = await openLoginDialog(reason + " · " + error.message, { force: true, error: error.message });
    if (!retry) return false;
    if (retry.fresh) {
      await loadSession();
      return true;
    }
    return false;
  }
}

export async function logout() {
  try {
    await request("/api/session/logout", { method: "POST" });
  } catch {}
  clearSavedCredentials();
  sessionState.session = {
    authenticated: false,
    expiresAt: null,
    loginAt: null,
    source: null,
    account: null,
    upstream: "https://mkexue.com",
  };
  sessionState.credentials = { login: null, hasPassword: false };
  sessionState.loginDialog.hasSaved = false;
  notify("已退出登录 · 本机凭据与 token 已清除", "info");
  finishDialog(null);
}
