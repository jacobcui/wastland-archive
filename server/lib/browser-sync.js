import { chromium } from "playwright";
import { UPSTREAM, UA } from "./config.js";
import { CredentialsRequiredError, normalizeCredentials, saveToken } from "./auth.js";

const SUBSCRIBE_PATH = "/knowledge/ebook/subscribe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch() {
  try {
    return await chromium.launch({ headless: true, channel: "chrome" });
  } catch {
    return chromium.launch({ headless: true });
  }
}

/**
 * The ebook index endpoints only accept tokens minted by a real browser
 * session (they answer "客户端ID与Token不匹配" for anything else), so the
 * index is captured from the page the browser itself renders. Everything
 * else in this app talks to the plain API with the resulting token.
 *
 * Credentials come from the browser popup login and live in server memory
 * only for the duration of the sync.
 */
export async function syncWithBrowser({ year = null, tokenHint = null, credentials = null } = {}) {
  const debug = process.env.MKX_DEBUG === "1";
  const log = (...args) => debug && console.log("[sync]", ...args);
  const creds = normalizeCredentials(credentials);

  const browser = await launch();
  try {
    const context = await browser.newContext({ locale: "zh-CN", userAgent: UA, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();

    const captured = [];
    page.on("response", async (res) => {
      const url = res.url();
      if (!url.includes("api.mkexue.com")) return;
      if (!url.includes("bookshelfYear") && !url.includes("bookshelfPagePc")) return;
      try {
        const json = await res.json();
        captured.push({ url, json });
      } catch {}
    });

    if (tokenHint) {
      await context.addCookies([{ name: "token", value: tokenHint, domain: "mkexue.com", path: "/" }]).catch(() => {});
    }

    const openSubscribe = async () => {
      await page.goto(UPSTREAM.site + SUBSCRIBE_PATH, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(2500);
    };

    const waitForIndex = async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (captured.some((c) => c.url.includes("bookshelfPagePc"))) return true;
        await sleep(400);
      }
      return false;
    };

    const doLogin = async () => {
      if (!creds) throw new CredentialsRequiredError("同步订阅索引需要手机号和密码");
      await page.goto(UPSTREAM.site + "/login", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector("input", { timeout: 30000 });
      await sleep(1200);
      const inputs = page.locator("input");
      await inputs.nth(0).fill(creds.login);
      await inputs.nth(1).fill(creds.password);
      await page.locator("button").first().click();
      await sleep(3500);
      log("after login url:", page.url());
    };

    await openSubscribe();
    let ready = await waitForIndex(7000);
    if (!ready) {
      log("no index data yet → logging in");
      await doLogin();
      await openSubscribe();
      ready = await waitForIndex(12000);
    }
    log("index ready:", ready, "captured:", captured.length);

    // year switch when the page landed on another year
    if (year) {
      const wanted = String(year);
      const tabs = await page.locator(".el-scrollbar p").allInnerTexts().catch(() => []);
      if (tabs.includes(wanted)) {
        const active = await page.locator("p.qktype-active").first().innerText().catch(() => "");
        if (active.trim() !== wanted) {
          log("switching year to", wanted);
          await page.locator(".el-scrollbar p", { hasText: new RegExp("^\\s*" + wanted + "\\s*$") }).first().click({ timeout: 5000 }).catch(() => {});
          await sleep(2500);
        }
      }
    }

    // paginate through every page of the current year
    const pagerCount = await page.locator(".el-pager li.number").count().catch(() => 0);
    log("pager pages:", pagerCount);
    for (let n = 2; n <= pagerCount; n += 1) {
      const li = page.locator(".el-pager li.number").filter({ hasText: new RegExp("^\\s*" + n + "\\s*$") }).first();
      if (!(await li.count())) break;
      const before = captured.filter((c) => c.url.includes("bookshelfPagePc")).length;
      await li.click({ timeout: 6000 }).catch(() => {});
      for (let i = 0; i < 25; i += 1) {
        await sleep(300);
        if (captured.filter((c) => c.url.includes("bookshelfPagePc")).length > before) break;
      }
    }

    const cookies = await context.cookies();
    const token = (cookies.find((c) => c.name === "token") || {}).value || null;
    if (token) saveToken(token, creds ? creds.login : null);
    log("token:", token ? token.slice(0, 16) : null);

    const issues = new Map();
    let years = [];
    let total = 0;
    for (const item of captured) {
      const payload = (item.json && item.json.data) || item.json || {};
      if (item.url.includes("bookshelfYear")) {
        if (Array.isArray(payload)) years = payload;
        else if (Array.isArray(payload.data)) years = payload.data;
        continue;
      }
      const rows = payload.rows || (payload.data && payload.data.rows) || [];
      total = payload.total || (payload.data && payload.data.total) || total;
      for (const row of rows) {
        if (row && row.nodeId) issues.set(String(row.nodeId), row);
      }
    }

    return { token, years, total, issues: [...issues.values()] };
  } finally {
    await browser.close().catch(() => {});
  }
}
