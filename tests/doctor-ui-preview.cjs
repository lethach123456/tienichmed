// Isolated doctor UI QA: only local popup assets and mocked extension APIs run.
// Chromium uses a fresh headless context; no installed extension, user profile,
// live doctor endpoint, AI provider, migration or API POST is accessed.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("/Users/macbookprom12020/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }

const origin = "https://doctor-ui-preview.invalid";
const targetTabId = 77;
const queueKey = `tab-doctor-queue:${targetTabId}`;
const itemsKey = `tab-job-items:${targetTabId}`;
const queueFailure = {
  sourceType: "doctor", status: "error", httpStatus: 503, schemaUnavailable: true,
  message: "API bác sĩ HTTP 503: Doctor content schema is not ready.",
  help: "Quản trị website: kiểm tra DB/schema và bản deploy; chạy php scripts/migrate_doctor_content.php trên đúng DB server. API sẵn sàng rồi bấm Thử lại. Tiện ích không tự chạy migration."
};
const queueReady = { sourceType: "doctor", status: "ready", httpStatus: 200,
  schemaUnavailable: false, message: "", help: "" };
const nextDoctor = {
  id: `tab-${targetTabId}:doctor-12`, doctor_id: 12, sourceType: "doctor", ownerTabId: targetTabId,
  name: "BS. Nguyễn Văn An", title: "BS. Nguyễn Văn An · hồ sơ cần nghiên cứu",
  prompt: "PROMPT NGHIÊN CỨU NGUYÊN BẢN TỪ SERVER · id 12", status: "chờ"
};
const originalResult = {
  id: 34, name: "BS. Nguyễn Thị Bình", content: "<p>Chứng cứ gốc cần được giữ nguyên.</p>",
  website_url: { url: "https://doctor.example/profile/34" }, booking_url: null,
  professional_profile_url: "https://doctor.example/registry/34", practice_registry_url: null,
  gallery_json: [{ url: ["https://doctor.example/portrait.jpg"], caption: "Ảnh gốc có bằng chứng" }],
  sources_json: [{ url: "https://doctor.example/evidence/34", title: "Nguồn xác minh gốc" }],
  video_urls_json: [], social_links_json: [],
  future_evidence: { keep: true, value: "<script>window.__doctorEvidenceExecuted = true</script>" }
};
const urlError = "API cập nhật bác sĩ HTTP 422: gallery_json[0].url phải là chuỗi URL HTTP(S) hợp lệ; website_url sai kiểu object.";
const failedDoctor = {
  id: `tab-${targetTabId}:doctor-34`, doctor_id: 34, sourceType: "doctor", ownerTabId: targetTabId,
  name: originalResult.name, title: originalResult.name, status: "lỗi cập nhật",
  result: originalResult, has_result: true, api_error: urlError,
  rawResponse: JSON.stringify(originalResult), content_version: 1,
  completed_at: "2026-10-10T02:30:00.000Z"
};

async function installChromeMock(context, scenario) {
  await context.addInitScript(({ initialScenario, tabId, storedQueueFailure, storedQueueReady, queuedDoctor, failedJob }) => {
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const doctorItemsKey = `tab-job-items:${tabId}`;
    const doctorQueueKey = `tab-doctor-queue:${tabId}`;
    const initialItems = initialScenario === "url-error" ? [failedJob] : [];
    const data = {
      sourceType: "doctor", runner: { active: false, workers: {} }, items: copy(initialItems),
      [doctorItemsKey]: copy(initialItems),
      [`tab-task-source:${tabId}`]: { sourceType: "doctor", translationType: "facility" },
      [doctorQueueKey]: copy(initialScenario === "url-error" ? storedQueueReady : storedQueueFailure)
    };
    const messages = [], listeners = [];
    const set = async (values) => {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: copy(data[key] ?? null), newValue: copy(value) };
        data[key] = copy(value);
      }
      listeners.forEach((listener) => listener(changes, "local"));
    };
    window.chrome = {
      storage: {
        local: {
          async get(keys) {
            return copy(Object.fromEntries(keys.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]])));
          },
          set
        },
        onChanged: { addListener(listener) { listeners.push(listener); } }
      },
      runtime: {
        async sendMessage(message) {
          messages.push(copy(message));
          if (message.type === "get-tab-context") return {
            ok: true, tabId, targetTabId: tabId, provider: "gemini", supported: true
          };
          if (message.type === "reconcile-api-status") return { ok: true };
          if (message.type === "refresh-queue") {
            const items = initialScenario === "retry-success" ? [copy(queuedDoctor)] : [];
            await set({ items, [doctorItemsKey]: items, [doctorQueueKey]: storedQueueReady });
            return { ok: true, items, added: items.length, skipped: 0, queueState: copy(storedQueueReady) };
          }
          if (message.type === "retry-update") return { ok: false, error: failedJob.api_error };
          // Unexpected writes/start actions are recorded and rejected, never sent.
          return { ok: false, error: `Unexpected isolated preview message: ${message.type}` };
        }
      }
    };
    window.__doctorPreview = { data, messages };
  }, { initialScenario: scenario, tabId: targetTabId, storedQueueFailure: queueFailure,
    storedQueueReady: queueReady, queuedDoctor: nextDoctor, failedJob: failedDoctor });
}

async function recordedMessages(page, type) {
  return page.evaluate((wanted) => window.__doctorPreview.messages.filter((message) => message.type === wanted), type);
}

async function verifyLayout(page, label) {
  const layout = await page.evaluate(() => ({ viewport: innerWidth,
    document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(layout.document <= layout.viewport + 1, `${label}: document overflow ${JSON.stringify(layout)}`);
  assert.ok(layout.body <= layout.viewport + 1, `${label}: body overflow ${JSON.stringify(layout)}`);
  const run = await page.locator("#runToggle").boundingBox();
  const viewport = page.viewportSize();
  assert.ok(run && run.width > 0 && run.height > 0 && run.y >= 0 && run.y + run.height <= viewport.height + 1,
    `${label}: Run footer is outside viewport: ${JSON.stringify(run)}`);
}

async function verifyNoAutomaticActions(page, label) {
  // Wait through a real one-second system notice tick without driving an action.
  await page.waitForTimeout(1100);
  for (const type of ["refresh-queue", "start-run", "retry-update", "retry-article"])
    assert.deepEqual(await recordedMessages(page, type), [], `${label}: must not automatically ${type}`);
}

async function verifyRestored503(page, label, screenshot) {
  await page.locator("#queueLoadError").waitFor({ state: "visible" });
  assert.equal(await page.locator("#sourceType").inputValue(), "doctor");
  assert.equal(await page.locator("#queueLoadError").getAttribute("role"), "alert");
  assert.equal(await page.locator("#queueLoadError").getAttribute("aria-labelledby"), "queueErrorTitle");
  assert.match(await page.locator("#queueErrorTitle").innerText(), /Không tải được hồ sơ bác sĩ/);
  assert.match(await page.locator("#queueErrorMessage").innerText(), /HTTP 503.*schema/i);
  assert.equal(await page.locator("#runToggle").isDisabled(), true);
  assert.match(await page.locator("#runDetail").innerText(), /schema.*Thử lại/);
  assert.match(await page.locator("#systemPhase").innerText(), /Không tải được hồ sơ/);
  assert.equal(await page.locator("#systemCountdown").isVisible(), false);
  assert.match(await page.locator("#items").innerText(), /Đây là lỗi tải API, không phải hết bác sĩ/);
  assert.equal(await page.locator("#queueRetry").isEnabled(), true);
  await page.locator("#queueLoadError summary").focus();
  await page.keyboard.press("Enter");
  assert.match(await page.locator("#queueErrorHelp").innerText(), /php scripts\/migrate_doctor_content\.php/);
  assert.match(await page.locator("#queueErrorHelp").innerText(), /Tiện ích không tự chạy migration/);
  const retry = await page.locator("#queueRetry").boundingBox();
  assert.ok(retry && retry.height >= 44, `${label}: retry target should be at least 44px high`);
  await verifyLayout(page, label);
  await verifyNoAutomaticActions(page, label);
  await screenshot("503-restored");
}

async function verifyManualQueueRetry(page, scenario, label, screenshot) {
  await page.locator("#queueRetry").focus();
  assert.equal(await page.evaluate(() => document.activeElement.id), "queueRetry");
  await page.keyboard.press("Enter");
  await page.locator("#queueLoadError").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#runToggle").isEnabled(), true);
  assert.deepEqual(await recordedMessages(page, "refresh-queue"), [
    { type: "refresh-queue", sourceType: "doctor", targetTabId }
  ], `${label}: only explicit retry should fetch this tab's doctor source`);
  assert.deepEqual(await recordedMessages(page, "start-run"), [], `${label}: queue recovery must not start AI`);
  assert.deepEqual(await recordedMessages(page, "retry-update"), [], `${label}: queue recovery must not POST a saved result`);
  assert.equal(await page.evaluate((key) => window.__doctorPreview.data[key].httpStatus, queueKey), 200);
  assert.equal(await page.evaluate((key) => window.__doctorPreview.data[key].status, queueKey), "ready");
  if (scenario === "retry-success") {
    assert.equal(await page.locator(".queue-item").count(), 1);
    assert.equal(await page.locator("#queueCount").innerText(), "1");
    assert.match(await page.locator(".queue-item").innerText(), /BS\. Nguyễn Văn An/);
    assert.match(await page.locator("#status").innerText(), /Đã thêm 1 bác sĩ/);
  } else {
    assert.equal(await page.locator(".queue-item").count(), 0);
    assert.equal(await page.locator("#queueCount").innerText(), "0");
    assert.match(await page.locator("#status").innerText(), /Đã thêm 0 bác sĩ/);
    assert.doesNotMatch(await page.locator("#items").innerText(), /lỗi tải API|Không tải được/);
    assert.doesNotMatch(await page.locator("#systemPhase").innerText(), /Không tải được/);
  }
  await verifyLayout(page, label);
  await screenshot(scenario === "retry-success" ? "retry200-success" : "retry200-empty");
}

async function verifyUrlError(page, label, screenshot) {
  await page.locator(".result-row").waitFor();
  assert.equal(await page.locator("#queueLoadError").isVisible(), false, `${label}: HTTP 422 is not a schema outage`);
  assert.equal(await page.locator(".api-state.error").count(), 1);
  assert.equal(await page.locator(".retry-api").count(), 1);
  await verifyNoAutomaticActions(page, label);
  await page.locator(".api-state.error").click();
  await page.locator("#jsonModal").waitFor({ state: "visible" });
  assert.equal(await page.locator("#jsonModal").getAttribute("role"), "dialog");
  assert.equal(await page.locator("#jsonModal").getAttribute("aria-labelledby"), "modalTitle");
  assert.equal(await page.evaluate(() => document.activeElement.id), "modalJson");
  const guide = await page.locator("#modalJson").innerText();
  assert.match(guide, /HTTP 422/);
  assert.match(guide, /gallery_json\[0\]\.url/);
  assert.match(guide, /website_url sai kiểu object/);
  assert.match(guide, /Hướng dẫn sửa JSON bằng AI \(chưa tự gửi\)/);
  assert.match(guide, /id 34, name "BS\. Nguyễn Thị Bình"/);
  assert.match(guide, /Giữ nguyên id, name/);
  assert.match(guide, /professional_profile_url, practice_registry_url/);
  assert.match(guide, /JSON gốc trong tiện ích vẫn được giữ nguyên/);
  assert.match(guide, /không.*claim token\/khóa API/);
  await screenshot("url422-manual-guide");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#jsonModal").isVisible(), false);

  await page.locator(".result-row").focus();
  await page.keyboard.press("Enter");
  await page.locator("#jsonModal").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.activeElement.id), "modalJson");
  assert.deepEqual(JSON.parse(await page.locator("#modalJson").innerText()), originalResult,
    `${label}: viewing guide must not normalize, discard or rewrite the saved JSON`);
  const stored = await page.evaluate((key) => window.__doctorPreview.data[key][0], itemsKey);
  assert.deepEqual(stored.result, originalResult);
  assert.equal(stored.rawResponse, JSON.stringify(originalResult));
  assert.equal(await page.evaluate(() => window.__doctorEvidenceExecuted), undefined,
    `${label}: untrusted JSON is text, not executable HTML`);
  assert.deepEqual(await recordedMessages(page, "retry-update"), []);
  assert.deepEqual(await recordedMessages(page, "start-run"), []);
  await screenshot("url422-original-json");
  await page.keyboard.press("Escape");

  // A rejected resend is explicit and targets only this item; the mock never POSTs.
  await page.locator(".retry-api").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("HTTP 422"));
  assert.deepEqual(await recordedMessages(page, "retry-update"), [
    { type: "retry-update", articleId: failedDoctor.id, targetTabId }
  ]);
  assert.deepEqual(await page.evaluate((key) => window.__doctorPreview.data[key][0].result, itemsKey), originalResult);
  assert.deepEqual(await recordedMessages(page, "start-run"), []);
  await verifyLayout(page, label);
}

async function main() {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "medreview-doctor-ui-"));
  console.log(`Screenshots directory: ${output}`);
  const assets = Object.fromEntries(await Promise.all(["popup.html", "popup.css", "popup.js"].map(async (name) =>
    [name, await fs.readFile(path.join(__dirname, "..", name), "utf8")])));
  const browser = await playwright.chromium.launch({ headless: true,
    executablePath: process.env.UI_PREVIEW_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
  const failures = [];
  try {
    for (const width of [288, 430]) {
      for (const scenario of ["retry-success", "retry-empty", "url-error"]) {
        const label = `${width}px-${scenario}`;
        const context = await browser.newContext({ viewport: { width, height: width === 288 ? 900 : 600 },
          reducedMotion: "reduce", timezoneId: "Asia/Ho_Chi_Minh", serviceWorkers: "block" });
        const errors = [], external = [];
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) { external.push(url.href); return route.abort(); }
          const name = url.pathname.slice(1);
          return Object.hasOwn(assets, name)
            ? route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html", body: assets[name] })
            : route.abort();
        });
        await installChromeMock(context, scenario);
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        const screenshot = async (state) => {
          const filename = path.join(output, `${label}-${state}.png`);
          await page.screenshot({ path: filename });
          console.log(`Screenshot: ${filename}`);
        };
        try {
          await page.goto(`${origin}/popup.html${width === 288 ? "?embedded=1&tabId=77&provider=gemini" : ""}`);
          // Wait for popup.js to finish applying the intended embedded/toolbar width.
          await page.waitForFunction((expected) => Math.abs(document.body.getBoundingClientRect().width - expected) <= 1,
            width, { timeout: 3000 });
          if (scenario === "url-error") await verifyUrlError(page, label, screenshot);
          else {
            await verifyRestored503(page, label, screenshot);
            if (scenario === "retry-success") {
              // Reopening the popup restores the persisted failure without refetching.
              await page.reload();
              await page.locator("#queueLoadError").waitFor({ state: "visible" });
              assert.equal(await page.locator("#runToggle").isDisabled(), true);
              await verifyNoAutomaticActions(page, `${label}-reopened`);
            }
            await verifyManualQueueRetry(page, scenario, label, screenshot);
          }
          assert.deepEqual(errors, [], `${label}: browser script errors`);
          assert.deepEqual(external, [], `${label}: unexpected external network attempt`);
          console.log(`PASS ${label}: local mock only, no automatic API/AI actions, JSON retained`);
        } catch (error) {
          await screenshot("failure");
          failures.push(`${label}: ${error.stack}\nBrowser errors: ${JSON.stringify(errors)}\nBlocked external URLs: ${JSON.stringify(external)}`);
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); }
  console.log(`Screenshots directory: ${output}`);
  if (failures.length) throw new Error(failures.join("\n\n"));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
