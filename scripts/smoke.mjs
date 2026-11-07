import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2, locale: "zh-CN" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 140)));
await page.goto("http://127.0.0.1:5178/#/plugin/mkx-archive", { waitUntil: "domcontentloaded" });
await page.waitForSelector("article.issue", { timeout: 60000 });
await page.waitForTimeout(1200);
await page.locator("article.issue").first().locator("button", { hasText: "阅读" }).click();
await page.waitForTimeout(1500);
if (await page.locator("text=RESUME SESSION").count()) {
  await page.locator("button", { hasText: "从头开始" }).click();
  await page.waitForTimeout(400);
}
console.log("hud:", (await page.locator(".reader__title span").innerText()).replace(/\s+/g, " ").trim());
const box = await page.locator(".book__pages").boundingBox();
const y = box.y + box.height * 0.55;
const x0 = box.x + box.width * 0.85;
await page.mouse.move(x0, y);
await page.mouse.down();
for (let i = 1; i <= 14; i += 1) {
  await page.mouse.move(x0 - (box.width * 0.45 * i) / 14, y);
  await page.waitForTimeout(20);
}
await page.mouse.up();
await page.waitForTimeout(1200);
console.log("drag ->", (await page.locator(".reader__readout").first().innerText()).replace(/\n/g, " "));

const zoomBefore = await page.locator(".reader__readout span").nth(1).innerText();
await page.evaluate(() => {
  const stage = document.querySelector(".reader__stage");
  stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, ctrlKey: true, cancelable: true, bubbles: true }));
});
await page.waitForTimeout(500);
const zoomAfter = await page.locator(".reader__readout span").nth(1).innerText();
console.log("mod+wheel zoom:", zoomBefore.replace(/\n/g, " "), "->", zoomAfter.replace(/\n/g, " "));

const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
const transformBefore = await page.locator(".book").evaluate((el) => getComputedStyle(el).transform);
await page.mouse.move(center.x, center.y);
await page.keyboard.down("Control");
await page.mouse.down();
for (let i = 1; i <= 10; i += 1) {
  await page.mouse.move(center.x - 8 * i, center.y - 4 * i);
  await page.waitForTimeout(20);
}
await page.mouse.up();
await page.keyboard.up("Control");
await page.waitForTimeout(300);
const transformAfter = await page.locator(".book").evaluate((el) => getComputedStyle(el).transform);
console.log("mod+drag pan changed:", transformBefore !== transformAfter, transformAfter.slice(0, 40));

await page.locator(".reader__nav--next").click();
await page.waitForTimeout(1300);
console.log("next ->", (await page.locator(".reader__readout").first().innerText()).replace(/\n/g, " "));
console.log("errors:", errors.join("|") || "none");
await browser.close();
