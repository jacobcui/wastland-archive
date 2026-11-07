import fs from "node:fs";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { AUTH_FILE, UPSTREAM, DATA_DIR, UA } from "./config.js";

/* ------------------------------------------------------------------ *
 * Credentials are supplied by the browser (popup login) and used in
 * memory only. No password is ever written to disk.
 * ------------------------------------------------------------------ */

export const CREDENTIALS_REQUIRED = "CREDENTIALS_REQUIRED";

export class CredentialsRequiredError extends Error {
  constructor(message = "需要手机号和密码登录 mkexue.com") {
    super(message);
    this.name = "CredentialsRequiredError";
    this.code = CREDENTIALS_REQUIRED;
  }
}

export function normalizeCredentials(input) {
  if (!input || typeof input !== "object") return null;
  const login = String(input.login || input.phonenumber || "").trim();
  const password = String(input.password || "");
  if (!login || !password) return null;
  return { login, password };
}

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function tokenExpiry(token) {
  const payload = decodeJwt(token || "");
  return payload && payload.exp ? payload.exp * 1000 : null;
}

/* ---------------------------------------------------------------- *
 * Fast path: replicate the website login request.
 * The site encrypts the JSON body with a random 32-char AES key and
 * ships the RSA(PKCS#1 v1.5) encrypted key in the "encrypt-key" header.
 * ---------------------------------------------------------------- */
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const publicKey = crypto.createPublicKey({
  key: Buffer.from(UPSTREAM.rsaPublicKey, "base64"),
  format: "der",
  type: "spki",
});

function randomKey() {
  let out = "";
  for (let i = 0; i < 32; i += 1) out += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return out;
}

function encryptBody(payload, key) {
  const cipher = crypto.createCipheriv("aes-256-ecb", Buffer.from(key, "utf8"), null);
  return Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]).toString("base64");
}

function decryptBody(cipherText, key) {
  const decipher = crypto.createDecipheriv("aes-256-ecb", Buffer.from(key, "utf8"), null);
  return Buffer.concat([decipher.update(Buffer.from(cipherText, "base64")), decipher.final()]).toString("utf8");
}

export async function directLogin(creds) {
  const key = randomKey();
  const encryptedKey = crypto
    .publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(Buffer.from(key, "utf8").toString("base64"), "utf8"),
    )
    .toString("base64");
  const body = {
    phonenumber: creds.login,
    password: creds.password,
    grantType: "password_pc_4c",
    clientId: UPSTREAM.clientId,
  };
  const res = await fetch(UPSTREAM.api + "/auth/login", {
    method: "POST",
    headers: {
      "Content-Language": "zh_CN",
      "Content-Type": "application/json;charset=utf-8",
      clientid: UPSTREAM.clientId,
      Accept: "application/json",
      isencrypt: "true",
      "encrypt-key": encryptedKey,
      "User-Agent": UA,
      Referer: UPSTREAM.site + "/",
    },
    body: encryptBody(body, key),
  });
  const text = (await res.text()).trim();
  const respHeaderKey = res.headers.get("encrypt-key") || res.headers.get("Encrypt-Key");
  let json = null;
  try {
    json = respHeaderKey ? JSON.parse(decryptBody(text, key)) : JSON.parse(text);
  } catch {
    json = null;
  }
  if (!json || json.code !== 200) {
    throw new Error("直接登录失败: " + (json ? json.msg : text.slice(0, 120)));
  }
  const token = json.data && json.data.access_token;
  if (!token) throw new Error("登录响应中没有 access_token");
  return { token, profile: json.data };
}

/* ---------------------------------------------------------------- *
 * Robust path: drive a headless Chrome through the real login page.
 * Used whenever the direct call is rejected, so the app keeps working
 * even if the site tweaks its login payload.
 * ---------------------------------------------------------------- */
export async function browserLogin(creds) {
  const launchers = [{ channel: "chrome" }, {}];
  const errors = [];
  for (const options of launchers) {
    let browser;
    try {
      browser = await chromium.launch({ headless: true, ...options });
      const context = await browser.newContext({ locale: "zh-CN", userAgent: UA, viewport: { width: 1440, height: 960 } });
      const page = await context.newPage();
      await page.goto(UPSTREAM.site + "/login", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector("input", { timeout: 30000 });
      await page.waitForTimeout(1200);
      const inputs = page.locator("input");
      await inputs.nth(0).fill(creds.login);
      await inputs.nth(1).fill(creds.password);
      await page.locator("button").first().click();
      const deadline = Date.now() + 45000;
      let token = null;
      while (Date.now() < deadline) {
        await page.waitForTimeout(700);
        const cookies = await context.cookies();
        const hit = cookies.find((c) => c.name === "token");
        if (hit && hit.value) {
          token = hit.value;
          break;
        }
      }
      await browser.close();
      if (!token) throw new Error("无头浏览器登录超时（未拿到 token cookie）");
      return { token, profile: null };
    } catch (error) {
      errors.push((options.channel || "bundled") + ": " + String(error.message).split("\n")[0]);
      if (browser) await browser.close().catch(() => {});
    }
  }
  throw new Error("自动登录失败 → " + errors.join(" | "));
}

/* ---------------------------------------------------------------- */

function loadCachedToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (!raw.token) return null;
    const exp = raw.expiresAt || tokenExpiry(raw.token);
    if (exp && exp - Date.now() < 5 * 60 * 1000) return null;
    return raw;
  } catch {
    return null;
  }
}

export function readAuthRecord() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function saveToken(token, login) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const previous = readAuthRecord();
  let account = null;
  if (typeof login === "string") account = login;
  else if (login && (login.phonenumber || login.login)) account = login.phonenumber || login.login;
  const record = {
    token,
    expiresAt: tokenExpiry(token) || Date.now() + 2 * 60 * 60 * 1000,
    loginAt: new Date().toISOString(),
    login: account || (previous && previous.login) || null,
  };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(record, null, 2));
  fs.chmodSync(AUTH_FILE, 0o600);
  return record;
}

export class Session {
  constructor() {
    this.token = null;
    this.profile = null;
    this.credentials = null;
    this.inflight = null;
    this.source = null;
    this.expiresAtCache = null;
    const cached = loadCachedToken();
    if (cached) {
      this.token = cached.token;
      this.expiresAtCache = cached.expiresAt || null;
      this.source = "cache";
    }
  }

  get expiresAt() {
    return tokenExpiry(this.token) || this.expiresAtCache;
  }

  get authenticated() {
    if (!this.token) return false;
    const exp = tokenExpiry(this.token);
    return !exp || exp - Date.now() > 5 * 60 * 1000;
  }

  setCredentials(creds) {
    const normalized = normalizeCredentials(creds);
    if (normalized) this.credentials = normalized;
    return this.credentials;
  }

  clearCredentials() {
    this.credentials = null;
  }

  adoptToken(token, login) {
    if (!token) return null;
    const record = saveToken(token, login || null);
    this.token = token;
    this.expiresAtCache = record.expiresAt;
    if (this.source !== "api") this.source = "browser";
    return record;
  }

  async authenticate(creds) {
    let directError = null;
    try {
      const result = await directLogin(creds);
      return { ...result, source: "api" };
    } catch (error) {
      directError = error;
    }
    try {
      const result = await browserLogin(creds);
      return { ...result, source: "browser" };
    } catch (error) {
      throw new Error("登录失败: " + directError.message + " | " + error.message);
    }
  }

  async login(creds) {
    const normalized = normalizeCredentials(creds);
    if (!normalized) throw new CredentialsRequiredError("请输入手机号和密码");
    this.setCredentials(normalized);
    this.invalidate();
    try {
      const result = await this.authenticate(normalized);
      this.token = result.token;
      this.profile = result.profile;
      this.source = result.source;
      const account = (result.profile && result.profile.phonenumber) || normalized.login;
      const record = saveToken(result.token, account);
      this.expiresAtCache = record.expiresAt;
      return this;
    } catch (error) {
      this.expiresAtCache = null;
      try {
        fs.rmSync(AUTH_FILE, { force: true });
      } catch {}
      throw error;
    }
  }

  async ensureToken(force = false, creds = null) {
    if (creds) this.setCredentials(creds);
    if (!force) {
      const cached = loadCachedToken();
      if (cached) {
        this.token = cached.token;
        this.expiresAtCache = cached.expiresAt || this.expiresAtCache;
        return this.token;
      }
      if (this.authenticated) return this.token;
    }
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const credential = this.credentials;
      if (!credential) throw new CredentialsRequiredError();
      try {
        const result = await this.authenticate(credential);
        this.token = result.token;
        this.profile = result.profile;
        this.source = result.source;
        const account = (result.profile && result.profile.phonenumber) || credential.login;
        const record = saveToken(result.token, account);
        this.expiresAtCache = record.expiresAt;
        return this.token;
      } catch (error) {
        this.token = null;
        this.expiresAtCache = null;
        try {
          fs.rmSync(AUTH_FILE, { force: true });
        } catch {}
        throw error;
      }
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  invalidate() {
    this.token = null;
    try {
      fs.rmSync(AUTH_FILE, { force: true });
    } catch {}
  }

  logout() {
    this.token = null;
    this.credentials = null;
    this.profile = null;
    this.expiresAtCache = null;
    this.source = null;
    try {
      fs.rmSync(AUTH_FILE, { force: true });
    } catch {}
  }
}

export const session = new Session();
