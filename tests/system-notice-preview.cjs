// Local UI smoke test with a clean browser profile and mocked extension APIs.
const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

(async () => {
  const assets = Object.fromEntries(await Promise.all(["popup.html", "popup.css", "popup.js"].map(async (name) => [name, await fs.readFile(path.join(__dirname, "..", name), "utf8")])));
  const browser = await chromium.launch({ executablePath: process.env.UI_PREVIEW_CHROME, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 350, height: 850 } });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const name = url.pathname.slice(1);
      if (url.origin !== "https://preview.invalid" || !assets[name]) return route.abort();
      return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html", body: assets[name] });
    });
    await context.addInitScript(() => {
      const listeners = [];
      const now = Date.now();
      const article = { id: "facility-41", facility_id: 41, title: "Nha Khoa Quốc Bình", content_version: 1, status: "đang viết", workerKey: "tab-404", prompt_prepared_at: new Date(now).toISOString(), prompt_scheduled_at: new Date(now + 42000).toISOString() };
      const notice = { articleId: article.id, runToken: "run-41", title: article.title, phase: "waiting-send", detail: "Prompt đã điền sẵn. Đang đợi hết thời gian giữa hai bài để bấm Gửi.", at: now };
      const data = { items: [article], sourceType: "facility", runner: { active: true, workers: { "tab-404": { active: true, provider: "gemini", targetTabId: 404, currentId: article.id, runToken: "run-41" } } }, systemNotices: { "tab-404": { ...notice, history: [notice, { ...notice, phase: "filling", detail: "Đang điền prompt vào ô nhập bên phải.", at: now - 2000 }] } } };
      window.__previewSet = async (values) => {
        const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
        Object.assign(data, values);
        listeners.forEach((listener) => listener(changes, "local"));
      };
      window.__previewData = data;
      window.__previewPayloadReads = 0;
      window.chrome = {
        storage: { local: { get: async (keys) => Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])), set: window.__previewSet }, onChanged: { addListener: (listener) => listeners.push(listener) } },
        runtime: { sendMessage: async (message) => {
          if (message.type === "get-tab-context") return { ok: true, provider: "gemini", targetTabId: 404, supported: true };
          if (message.type === "get-article-content") { window.__previewPayloadReads++; return { ok: true, content: { prompt: "Prompt mẫu" } }; }
          return { ok: true };
        } }
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("https://preview.invalid/popup.html?embedded=1&spark=1&provider=gemini&tabId=404");
    await page.getByText("Prompt đã điền · chờ gửi", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__previewPayloadReads), 0);
    await page.locator(".queue-item").first().click();
    assert.equal(await page.locator("#modalJson").innerText(), "Prompt mẫu");
    assert.equal(await page.evaluate(() => window.__previewPayloadReads), 1);
    await page.locator("#closeJson").click();
    await page.locator(".system-history summary").click();
    assert.equal(await page.locator("#systemHistory li").count(), 2);
    assert.match(await page.locator("#systemCountdown").innerText(), /Đến lượt gửi/);
    const output = path.join(os.tmpdir(), "medreview-system-card.png");
    await page.screenshot({ path: output });
    await page.evaluate(async () => {
      const data = window.__previewData;
      delete data.items[0].prompt_scheduled_at;
      data.items[0].prompt_sent_at = new Date().toISOString();
      await window.__previewSet({ items: data.items, systemNotices: { "tab-404": { ...data.systemNotices["tab-404"], phase: "reading-json", detail: "Nút Stop đã đóng. Đang trích JSON và kiểm tra ID." } } });
    });
    await page.getByText("Đang lấy JSON", { exact: true }).waitFor();
    assert.equal(await page.locator("#systemCountdown").isVisible(), false);
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth }));
    assert.ok(dimensions.body <= dimensions.viewport, "system card should fit the narrow Spark sidebar");
    assert.deepEqual(errors, []);
    console.log(`PASS: preparation countdown, history, JSON phase, no overflow or script errors. Screenshot: ${output}`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
