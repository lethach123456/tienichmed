// Isolated browser QA: all page assets and extension APIs are mocked locally.
// No installed extension/profile, real AI, API POST or facility image is touched.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("/Users/macbookprom12020/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }

async function main() {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "medreview-image-fix-ui-"));
  const assets = Object.fromEntries(await Promise.all(["popup.html", "popup.css", "popup.js"].map(async (name) =>
    [name, await fs.readFile(path.join(__dirname, "..", name), "utf8")])));
  const browser = await playwright.chromium.launch({ headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
  try {
    for (const width of [288, 430]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors = [], external = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== "https://image-fix-preview.invalid") { external.push(url.href); return route.abort(); }
        const name = url.pathname.slice(1);
        return assets[name] ? route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html", body: assets[name] }) : route.abort();
      });
      await context.addInitScript(() => {
        const base = { sourceType: "facility_image_fix", ownerTabId: 77, images_count: 6,
          prompt: "PROMPT FIX ẢNH NGUYÊN BẢN TỪ SERVER", images_revision: "a".repeat(64) };
        const items = [
          { ...base, id: "fix-1", facility_id: 1, title: "Cơ sở kiểm tra ảnh · chi nhánh Nguyễn Huệ", status: "chờ",
            writer_claimed: true, writer_claim: { provider: "grok", instance_label: "Máy khác" } },
          { ...base, id: "fix-2", facility_id: 2, title: "Kết quả được website tiếp nhận", status: "hoàn tất", result: { id: 2 },
            api_update: { updated: [{ id: 2, images_imported: 3, images_failed: 0, image_processing: "completed", image_results: [] }], image_processing: "completed" } },
          { ...base, id: "fix-3", facility_id: 3, title: "Ảnh đã thay đổi · cần kiểm tra lại", status: "lỗi cập nhật", result: { id: 3 },
            image_fix_error_code: "images_changed", image_fix_requires_research: true },
          { ...base, id: "fix-4", facility_id: 4, title: "JSON đã lưu · còn một ảnh tải lỗi", status: "ảnh chưa đủ", result: { id: 4 }, image_fix_import_pending: true,
            api_update: { image_processing: "partial", updated: [{ id: 4, images_imported: 2, images_failed: 1, image_processing: "partial",
              image_results: [{ source_url: "https://clinic.example/failed.jpg", ok: false, error: "HTTP 403" }] }] } }
        ];
        const data = { items, runner: { active: false }, sourceType: "facility_image_fix" };
        const listeners = [], messages = [];
        window.chrome = {
          storage: { local: {
            async get(keys) { return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])); },
            async set(values) { Object.assign(data, values); }
          }, onChanged: { addListener(listener) { listeners.push(listener); } } },
          runtime: { async sendMessage(message) {
            messages.push(message);
            if (message.type === "get-tab-context") return { ok: true, tabId: 77, targetTabId: 77, provider: "gemini", supported: true };
            if (message.type === "refresh-queue") return { ok: true, items, added: 0, skipped: 0 };
            if (message.type === "retry-update") return { ok: true, updated: true, partial: true, image_processing: "partial", images_imported: 2, images_failed: 1 };
            return { ok: true };
          } }
        };
        window.__fixPreview = { messages };
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("https://image-fix-preview.invalid/popup.html" + (width === 288 ? "?embedded=1&tabId=77&provider=gemini" : ""));
      await page.locator(".queue-item").first().waitFor();
      // Rows can render before Chromium commits the .embedded style change.
      // Wait for the intended viewport layout, not an arbitrary screenshot delay.
      await page.waitForFunction((expectedWidth) =>
        Math.abs(document.body.getBoundingClientRect().width - expectedWidth) <= 1,
      width, { timeout: 3000 });
      assert.equal(await page.locator("#sourceType").inputValue(), "facility_image_fix");
      assert.equal(await page.locator(".queue-item").count(), 2);
      assert.match(await page.locator(".queue-item").first().innerText(), /6 ảnh/);
      assert.match(await page.locator(".queue-item").first().innerText(), /Máy khác/);
      assert.equal(await page.locator(".image-progress.queued").count(), 0);
      assert.equal(await page.locator(".image-progress.ok").innerText(), "3 ảnh lưu");
      assert.equal(await page.locator(".image-progress.partial").innerText(), "2 lưu · 1 lỗi");
      assert.equal(await page.locator(".retry-api").count(), 1);
      assert.equal(await page.locator(".retry-image-fix-research").count(), 1);
      const layout = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth,
        classes: document.documentElement.className, location: location.href,
        rootWidth: getComputedStyle(document.documentElement).width, bodyWidth: getComputedStyle(document.body).width,
        overflow: [...document.querySelectorAll("body, main, section, label, select")].filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
          .map((node) => [node.tagName, node.className, node.id, node.getBoundingClientRect().width]) }));
      assert.ok(layout.scroll <= layout.viewport + 1, JSON.stringify(layout));
      await page.screenshot({ path: path.join(output, `${width}-fix.png`) });
      await page.locator("#settingsToggle").click();
      assert.match(await page.locator("#facilityImageFixUrl").inputValue(), /facilities-needing-image-fix/);
      assert.match(await page.locator("#facilityImageFixUpdateUrl").inputValue(), /facility-image-fix-update/);
      await page.locator("#facilityImageFixUrl").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `${width}-settings.png`) });
      await page.keyboard.press("Escape");
      await page.locator(".image-errors").click();
      assert.match(await page.locator("#modalJson").innerText(), /failed\.jpg/);
      assert.match(await page.locator("#modalJson").innerText(), /HTTP 403/);
      await page.screenshot({ path: path.join(output, `${width}-partial-error.png`) });
      await page.keyboard.press("Escape");
      await page.locator(".retry-api").click();
      assert.match(await page.locator("#status").innerText(), /2 ảnh lưu · 1 ảnh lỗi/);
      await page.locator(".retry-image-fix-research").click();
      const messages = await page.evaluate(() => window.__fixPreview.messages);
      assert.ok(messages.some((message) => message.type === "retry-update" && message.articleId === "fix-4" && message.targetTabId === 77));
      assert.ok(messages.some((message) => message.type === "retry-image-fix-research" && message.articleId === "fix-3" && message.targetTabId === 77));
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`PASS ${width}px: Fix ảnh, cấu hình API, completed/partial, popup lỗi, gửi lại, kiểm tra lại; không gọi mạng ngoài`);
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(`Screenshots: ${output}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
