// Isolated visual smoke test: every browser request is intercepted locally.
// No installed extension, existing Chrome profile, or real API is accessed.
// Run with NODE_PATH pointing to the bundled node_modules, if needed.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("/Users/macbookprom12020/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }
const { chromium } = playwright;

const workspace = path.resolve(__dirname, "..");
const origin = "https://extension-preview.invalid";
const chromeExecutable = process.env.UI_PREVIEW_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const fixtures = Array.from({ length: 12 }, (_, index) => {
  const number = index + 1;
  const toplist = number % 3 === 0;
  const name = toplist ? `Top 10 phòng khám nha khoa uy tín tại Đà Nẵng · ${number}` : `Nha khoa Nụ Cười Việt – Chi nhánh Nguyễn Huệ · ${number}`;
  const status = ["hoàn tất", "lỗi cập nhật", "đang viết", "chờ", "hoàn tất", "chờ", "đang cập nhật", "lỗi", "chờ", "hoàn tất", "chờ", "chờ"][index];
  const result = ["hoàn tất", "lỗi cập nhật", "đang cập nhật"].includes(status)
    ? { id: number, name, content: "<p>Nội dung JSON mô phỏng để kiểm tra giao diện.</p>", reviews: [{ rating: 5, content: "Đánh giá thử nghiệm" }], extra_future_field: "Được giữ nguyên" }
    : undefined;
  return {
    id: `${toplist ? "toplist" : "facility"}-${number}`,
    sourceType: toplist ? "toplist" : "facility",
    ...(toplist ? { toplist_id: number } : { facility_id: number }),
    title: name,
    prompt: `Hãy viết bài ${name}.\nChỉ trả về JSON đầy đủ.\nGiữ nguyên nội dung mẫu <script>không chạy</script>.`,
    status, result,
    created_at: "2026-09-08T09:30:00.000Z", completed_at: result ? "2026-09-08T09:35:00.000Z" : undefined,
    ...(status === "hoàn tất" ? { api_update: { ok: true, updated_count: 1, updated_ids: [number] } } : {}),
    ...(status === "lỗi cập nhật" ? { api_error: "API cập nhật trả về 500: Không thể cập nhật dữ liệu thử nghiệm." } : {}),
    ...(status === "lỗi" ? { error: "Hết thời gian chờ JSON mô phỏng." } : {})
  };
});
const visibleQueueFixtures = fixtures.filter((item) => item.status !== "hoàn tất");

async function installChromeMock(context, items) {
  await context.addInitScript(({ initialItems }) => {
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const data = { items: copy(initialItems), runner: { active: false }, sourceType: "facility" };
    const listeners = [];
    const messages = [];
    const set = async (values) => {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: data[key], newValue: copy(value) };
        data[key] = copy(value);
      }
      listeners.forEach((listener) => listener(changes, "local"));
    };
    window.chrome = {
      storage: {
        local: {
          async get(keys) {
            return copy(Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])));
          },
          set
        },
        onChanged: { addListener: (listener) => listeners.push(listener) }
      },
      runtime: {
        async sendMessage(message) {
          messages.push(copy(message));
          if (message.type === "get-tab-context") {
            return { ok: true, tabId: 77, targetTabId: 77, provider: "chatgpt", supported: true };
          }
          if (message.type === "start-run") {
            await set({
              runner: {
                active: true,
                provider: message.provider,
                workers: {
                  [`tab-${message.targetTabId}`]: {
                    active: true,
                    provider: message.provider,
                    targetTabId: message.targetTabId
                  }
                }
              }
            });
          }
          if (message.type === "stop-run") await set({ runner: { active: false, workers: {} } });
          if (message.type === "refresh-queue") return { ok: true, items: copy(data.items), added: 0, skipped: 0 };
          return { ok: true };
        }
      }
    };
    window.__uiPreview = { data, messages, set };
  }, { initialItems: items });
}

async function verifyViewport(frame, viewport, label) {
  const dimensions = await frame.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  assert.ok(dimensions.document <= dimensions.viewport + 1, `${label}: document horizontal overflow ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.body <= dimensions.viewport + 1, `${label}: body horizontal overflow ${JSON.stringify(dimensions)}`);
  const run = await frame.locator("#runToggle").boundingBox();
  assert.ok(run && run.width > 0 && run.height > 0 && run.y >= 0 && run.y + run.height <= viewport.height + 1, `${label}: run footer is outside viewport: ${JSON.stringify(run)}`);
}

async function main() {
  const output = process.argv[2] || await fs.mkdtemp(path.join(os.tmpdir(), "article-runner-ui-"));
  await fs.mkdir(output, { recursive: true });
  const assets = Object.fromEntries(await Promise.all(["popup.html", "popup.css", "popup.js"].map(async (name) => [name, await fs.readFile(path.join(workspace, name), "utf8")])));
  const browser = await chromium.launch({ executablePath: chromeExecutable, headless: true, args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
  const failures = [];
  try {
    for (const viewport of [{ width: 288, height: 900 }, { width: 400, height: 720 }]) {
      for (const theme of ["dark", "light"]) {
        const label = `${viewport.width}x${viewport.height}-${theme}`;
        const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: "reduce", timezoneId: "Asia/Ho_Chi_Minh" });
        const errors = [];
        const blocked = [];
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) { blocked.push(url.href); return route.abort(); }
          const name = url.pathname.slice(1);
          if (name === "index.html") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body style="margin:0;background:${theme === "dark" ? "#212121" : "#f7f7f7"}"><iframe title="Extension preview" src="/popup.html?theme=${theme}" style="width:100vw;height:100vh;border:0;display:block"></iframe></body></html>` });
          if (assets[name]) return route.fulfill({ contentType: name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "text/javascript" : "text/html", body: assets[name] });
          return route.abort();
        });
        await installChromeMock(context, fixtures);
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`${origin}/index.html`);
          const frame = page.frames().find((candidate) => candidate.url().includes("/popup.html"));
          await frame.locator(".queue-item").first().waitFor();
          assert.equal(await frame.locator(".queue-item").count(), visibleQueueFixtures.length, `${label}: completed jobs should be hidden from queue`);
          assert.equal(await frame.locator("#queueCount").innerText(), String(visibleQueueFixtures.length), `${label}: queue count should count visible jobs`);
          assert.equal(await frame.locator(".result-row").count(), fixtures.filter((item) => item.result).length, `${label}: completed JSON should remain in results`);
          assert.equal(await frame.locator(".api-row").count(), fixtures.filter((item) => ["hoàn tất", "lỗi cập nhật", "đang cập nhật", "lỗi"].includes(item.status)).length, `${label}: completed API records should remain visible`);
          await verifyViewport(frame, viewport, label);
          await page.screenshot({ path: path.join(output, `${label}.png`) });

          await frame.locator("#runToggle").click();
          assert.match(await frame.locator("#runToggle").innerText(), /ChatGPT/);
          assert.match(await frame.locator("#runToggle").innerText(), /Dừng/);
          let messages = await frame.evaluate(() => window.__uiPreview.messages);
          assert.ok(messages.some((message) =>
            message.type === "start-run" && message.provider === "chatgpt" && message.targetTabId === 77
          ), `${label}: Run must target this exact ChatGPT tab`);
          await page.screenshot({ path: path.join(output, `${label}-running.png`) });
          await frame.locator("#runToggle").click();
          assert.match(await frame.locator("#runToggle").innerText(), /ChatGPT/);
          assert.match(await frame.locator("#runToggle").innerText(), /Chạy/);
          messages = await frame.evaluate(() => window.__uiPreview.messages);
          assert.ok(messages.some((message) =>
            message.type === "stop-run" && message.provider === "chatgpt" && message.targetTabId === 77
          ), `${label}: Stop must target this exact ChatGPT tab`);

          await frame.locator("#settingsToggle").click();
          assert.equal(await frame.locator("#settings").isVisible(), true);
          assert.equal(await frame.locator("#settings input[type=url]").count(), 4);
          await page.screenshot({ path: path.join(output, `${label}-settings.png`) });
          await page.keyboard.press("Escape");
          assert.equal(await frame.locator("#settings").isVisible(), false, `${label}: Escape should close settings`);

          await frame.locator(".queue-item").first().click({ position: { x: 40, y: 24 } });
          assert.equal(await frame.locator("#jsonModal").isVisible(), true);
          assert.match(await frame.locator("#modalTitle").innerText(), /Prompt/);
          assert.equal(await frame.locator("#modalJson").innerText(), visibleQueueFixtures[0].prompt);
          await page.screenshot({ path: path.join(output, `${label}-prompt.png`) });
          await page.keyboard.press("Escape");
          assert.equal(await frame.locator("#jsonModal").isVisible(), false, `${label}: Escape should close prompt dialog`);

          const resultRows = frame.locator(".result-row");
          await resultRows.first().focus();
          await page.keyboard.press("Enter");
          assert.equal(await frame.locator("#jsonModal").isVisible(), true, `${label}: result keyboard activation`);
          const shownResult = JSON.parse(await frame.locator("#modalJson").innerText());
          assert.equal(shownResult.extra_future_field, "Được giữ nguyên");
          await page.screenshot({ path: path.join(output, `${label}-json.png`) });
          await frame.locator("#closeJson").click();

          await frame.locator(".api-state.error").first().click();
          assert.equal(await frame.locator("#jsonModal").isVisible(), true);
          assert.match(await frame.locator("#modalJson").innerText(), /Lỗi|lỗi|thời gian/);
          await page.keyboard.press("Escape");
          await frame.locator(".retry-api").first().click();
          messages = await frame.evaluate(() => window.__uiPreview.messages);
          assert.ok(messages.some((message) => message.type === "retry-update"), `${label}: retry should dispatch through mocked runtime`);
          assert.deepEqual(errors, [], `${label}: browser script errors`);
          assert.deepEqual(blocked, [], `${label}: unexpected external network attempted`);
          console.log(`PASS ${label}: layout, scroll, footer, run/stop, settings, prompt, JSON, keyboard, retry`);
        } catch (error) {
          await page.screenshot({ path: path.join(output, `${label}-failure.png`) });
          failures.push(`${label}: ${error.stack}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`Screenshots: ${output}`);
  if (failures.length) throw new Error(failures.join("\n\n"));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
