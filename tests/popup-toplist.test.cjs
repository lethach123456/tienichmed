const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const defaults = {
  facilitiesUrl: "https://medreview.vn/api/medical/facilities-needing-content.php?page=1&limit=1&type=facility",
  updateUrl: "https://medreview.vn/api/medical/facility-content-update.php",
  doctorsUrl: "https://medreview.vn/api/medical/doctors-needing-content.php?page=1&limit=25",
  doctorUpdateUrl: "https://medreview.vn/api/medical/doctor-content-update.php",
  doctorContentUrl: "https://medreview.vn/api/medical/doctor-content.php",
  handbooksUrl: "https://medreview.vn/api/medical/handbooks-needing-content.php?limit=10&language=vi",
  handbookUpdateUrl: "https://medreview.vn/api/medical/handbook-content-update.php",
  facilityImageFixUrl: "https://medreview.vn/api/medical/facilities-needing-image-fix.php?limit=10",
  facilityImageFixUpdateUrl: "https://medreview.vn/api/medical/facility-image-fix-update.php",
  toplistsUrl: "https://medreview.vn/api/medical/toplists-needing-members.php?page=1&limit=1",
  toplistUpdateUrl: "https://medreview.vn/api/medical/toplist-members-update.php",
  aiImagesUrl: "https://medreview.vn/api/medical/facilities-needing-ai-images.php?page=1&limit=1&min_images=3",
  aiImageUpdateUrl: "https://medreview.vn/api/medical/facility-ai-image-update.php",
  translationUrl: "https://medreview.vn/api/medical/translate-content.php"
};

const doctorSchemaMessage = "API danh sách bác sĩ HTTP 503: Chưa sẵn sàng schema bác sĩ. Chạy scripts/migrate_doctor_content.php.";
const doctorQueueFailure = {
  sourceType: "doctor", status: "error", httpStatus: 503, message: doctorSchemaMessage,
  schemaUnavailable: true,
  help: "Website chưa sẵn sàng schema bác sĩ. Chạy php scripts/migrate_doctor_content.php rồi thử lại."
};
const doctorQueueReady = { sourceType: "doctor", status: "ready", httpStatus: 200, message: "", schemaUnavailable: false, help: "" };

function assertDoctorQueueFailure(popup) {
  const queueState = popup.functions.getState().doctorQueueState;
  assert.equal(queueState?.sourceType, "doctor");
  assert.equal(queueState?.status, "error");
  assert.equal(queueState?.httpStatus, 503);
  assert.equal(queueState?.schemaUnavailable, true);
  assert.equal(popup.node("queueLoadError").hidden, false);
  assert.match(popup.node("queueErrorTitle").textContent, /bác sĩ|hồ sơ/i);
  assert.match(popup.node("queueErrorMessage").textContent, /HTTP 503/);
  assert.match(popup.node("queueErrorMessage").textContent, /Chưa sẵn sàng schema bác sĩ/);
  assert.match(popup.node("queueErrorHelp").textContent, /php scripts\/migrate_doctor_content\.php/);
  assert.equal(popup.node("runCaption").textContent, "Không tải được hồ sơ");
  assert.match(popup.node("runDetail").textContent, /website|schema/i);
  assert.equal(popup.node("runToggle").disabled, true);
}

function element() {
  const children = [];
  const listeners = new Map();
  const selectorChildren = new Map();
  let html = "";
  const node = {
    value: "", hidden: false, disabled: false, textContent: "", style: {}, dataset: {}, children,
    classList: {
      names: new Set(),
      add(...names) { names.forEach((name) => this.names.add(name)); },
      toggle(name, force) {
        if (force === false) this.names.delete(name);
        else this.names.add(name);
      },
      contains(name) { return this.names.has(name); }
    },
    append(child) { children.push(child); },
    appendChild(child) { children.push(child); },
    replaceChildren(...nodes) { children.splice(0, children.length, ...nodes); },
    setAttribute() {}, focus() {},
    addEventListener(type, callback) { listeners.set(type, callback); },
    querySelectorAll: () => [],
    querySelector(selector) {
      const className = selector.startsWith(".") ? selector.slice(1) : null;
      if (className && !new RegExp(`class=[\"'][^\"']*\\b${className}\\b`).test(html)) return null;
      if (!selectorChildren.has(selector)) selectorChildren.set(selector, element());
      return selectorChildren.get(selector);
    },
    async click(event = {}) {
      const payload = { stopPropagation() {}, preventDefault() {}, currentTarget: node, target: node, ...event };
      if (typeof node.onclick === "function") await node.onclick(payload);
      if (listeners.has("click")) await listeners.get("click")(payload);
    }
  };
  Object.defineProperty(node, "innerHTML", {
    get() { return html; },
    set(value) { html = String(value); if (!html) children.length = 0; }
  });
  return node;
}

function loadPopup({
  stored = {},
  respond = async () => ({ ok: true, items: [] }),
  tabContext = { ok: true, tabId: 33, targetTabId: 33, provider: "chatgpt", supported: true },
  search = ""
} = {}) {
  const data = plain(stored);
  const nodes = new Map();
  const messages = [];
  const writes = [];
  const intervals = [];
  let storageListener;
  const document = {
    documentElement: element(), head: element(),
    createElement: () => element(),
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    }
  };
  const window = {};
  window.top = window;
  const script = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");
  // Suppress automatic startup. Tests explicitly invoke init/loadArticles with
  // mocked storage/runtime; no real Chrome data or website API is contacted.
  const instrumented = script.replace(/^init\(\);\s*$/m, "") + `
    globalThis.__popupTests = {
      init, resolvePanelContext, mergeApiArticles, displayArticleTitle, displayJobStatus, saveSettings, loadArticles, render,
      updateRunButton, currentTabIsRunning, toggleCurrentTabRun, canRunSourceOnProvider, imageProviderMessage, systemNoticeView, renderSystemNotice,
      getState: () => state,
      setState: (value) => { state = value; },
      getPanelContext: () => panelContext
    };
  `;
  const context = vm.createContext({
    document, window, location: { search }, URL, URLSearchParams,
    chrome: {
      storage: {
        onChanged: { addListener(listener) { storageListener = listener; } },
        local: {
          async get(keys) { const wanted = Array.isArray(keys) ? keys : [keys]; return plain(Object.fromEntries(wanted.filter((key) => key in data).map((key) => [key, data[key]]))); },
          async set(values) { writes.push(plain(values)); Object.assign(data, plain(values)); }
        }
      },
      runtime: { async sendMessage(message) {
        messages.push(plain(message));
        if (message.type === "replace-queue-items") { data.items = plain(message.items); return { ok: true }; }
        return message.type === "get-tab-context" ? plain(tabContext) : respond(message);
      } }
    },
    setInterval(callback, ms) { intervals.push({ callback, ms }); return intervals.length; },
    clearInterval(id) { if (intervals[id - 1]) intervals[id - 1].cleared = true; }
  });
  vm.runInContext(instrumented, context, { filename: "popup.js" });
  return {
    functions: context.__popupTests, messages, writes, intervals, stored: data,
    root: document.documentElement,
    emitChanges(changes) {
      for (const [key, change] of Object.entries(changes)) data[key] = plain(change.newValue);
      storageListener(plain(changes), "local");
    },
    node: (id) => document.getElementById(id),
    async init() { await context.__popupTests.init(); await new Promise(setImmediate); }
  };
}

test("the extension panel is dark by default", () => {
  const standard = loadPopup();
  const explicitLight = loadPopup({ search: "?theme=light" });
  assert.equal(standard.root.classList.contains("dark-theme"), true);
  assert.equal(standard.root.classList.contains("light-theme"), false);
  assert.equal(explicitLight.root.classList.contains("light-theme"), true);
});

test("Fix ảnh has a selectable source and both real configuration inputs", () => {
  const html = fs.readFileSync(path.join(__dirname, "../popup.html"), "utf8");
  assert.match(html, /option value="facility_image_fix">Fix ảnh cơ sở y tế/);
  for (const id of ["facilityImageFixUrl", "facilityImageFixUpdateUrl"]) assert.match(html, new RegExp(`input id="${id}" type="url"`));
});

test("Fix ảnh is text research on every provider and uses distinct queue identity with verbatim prompt", () => {
  const popup = loadPopup();
  for (const provider of ["chatgpt", "grok", "gemini", "claude"]) assert.equal(popup.functions.canRunSourceOnProvider("facility_image_fix", provider), true);
  const prompt = "  PROMPT FIX TỪ SERVER\nKhông đổi whitespace\n  ";
  const article = { id: "facility-7", facility_id: 7, title: "Cơ sở", prompt: "Viết bài", status: "chờ" };
  const merged = popup.functions.mergeApiArticles([article], [{ id: 7, name: "Cơ sở", prompt, images_count: 6, images_revision: "a".repeat(64) }], "facility_image_fix");
  assert.equal(merged.items[1].id, "facility_image_fix-7");
  assert.equal(merged.items[1].prompt, prompt);
  assert.equal(merged.items[1].images_count, 6);
  assert.equal(merged.items[0].prompt, "Viết bài");
});

test("Fix ảnh accepted receipt is pending image work, and stale/ambiguous results have different retry actions", () => {
  const popup = loadPopup();
  const base = { sourceType: "facility_image_fix", facility_id: 7, title: "Cơ sở", result: { id: 7 } };
  const accepted = { ...base, id: "fix-done", status: "hoàn tất", api_update: { image_processing: "queued", updated: [{ id: 7 }] } };
  assert.match(popup.functions.displayJobStatus(accepted), /chờ worker xử lý ảnh/);
  const stale = { ...base, id: "fix-stale", status: "lỗi cập nhật", image_fix_error_code: "images_changed", image_fix_requires_research: true };
  const ambiguous = { ...base, id: "fix-pending", status: "chưa xác nhận", image_fix_error_code: "lease_lost", image_fix_api_pending: true };
  popup.node("sourceType").value = "facility_image_fix";
  popup.functions.setState({ sourceType: "facility_image_fix", runner: { active: false }, items: [accepted, stale, ambiguous] });
  popup.functions.render();
  const rows = popup.node("apiStatus").children;
  assert.match(rows[0].innerHTML, /retry-api/);
  assert.doesNotMatch(rows[0].innerHTML, /retry-image-fix-research/);
  assert.match(rows[1].innerHTML, /retry-image-fix-research/);
  assert.doesNotMatch(rows[1].innerHTML, /retry-api/);
  assert.match(rows[2].innerHTML, /Chờ worker/);
  assert.match(rows[2].innerHTML, /api-state pending/);
  assert.doesNotMatch(rows[2].innerHTML, /retry-api/);
});

test("Fix ảnh queue errors surface bad gallery IDs instead of silently reporting an empty source", async () => {
  const popup = loadPopup({ respond: async () => ({ ok: true, items: [], added: 0, skipped: 0,
    errors: [{ id: 71, message: "gallery_json malformed" }] }) });
  popup.node("sourceType").value = "facility_image_fix";
  await popup.functions.loadArticles();
  assert.match(popup.node("status").textContent, /ID 71: gallery_json malformed/);
});

test("synchronous Fix ảnh reads completed metrics from its own nested receipt, not another item's partial", () => {
  const popup = loadPopup();
  const item = { id: "fix-sync", sourceType: "facility_image_fix", facility_id: 7, title: "Cơ sở", status: "hoàn tất", result: { id: 7 },
    api_update: { ok: true, image_processing: "partial", updated: [
      { id: 8, image_processing: "partial", images_imported: 1, images_failed: 3 },
      { id: 7, image_processing: "completed", images_imported: 4, images_failed: 0, image_results: [] }
    ] } };
  popup.node("sourceType").value = "facility_image_fix";
  popup.functions.setState({ items: [item], runner: { active: false } });
  popup.functions.render();
  const row = popup.node("apiStatus").children[0];
  assert.match(row.innerHTML, /api-state ok/);
  assert.match(row.innerHTML, /4 ảnh lưu/);
  assert.doesNotMatch(row.innerHTML, /Chờ worker|retry-api|ảnh lỗi/);
  assert.match(popup.functions.displayJobStatus(item), /4 ảnh đã lưu/);
});

test("partial Fix ảnh shows counts/error popup and retries its receipt, not the AI prompt", async () => {
  const popup = loadPopup({ respond: async () => ({ ok: true, updated: true, partial: true,
    image_processing: "partial", images_imported: 2, images_failed: 1 }) });
  const item = { id: "fix-partial", sourceType: "facility_image_fix", facility_id: 7, title: "Cơ sở", status: "ảnh chưa đủ",
    result: { id: 7 }, image_fix_import_pending: true, api_update: { ok: true, image_processing: "completed", updated: [
      { id: 7, image_processing: "partial", images_imported: 2, images_failed: 1,
        image_results: [{ source_url: "https://clinic.example/failed.jpg", ok: false, error: "HTTP 403" }] }
    ] } };
  popup.node("sourceType").value = "facility_image_fix";
  popup.functions.setState({ items: [item], runner: { active: false } });
  popup.functions.render();
  assert.equal(popup.node("queueCount").textContent, "0", "AI work is finished, but retry/result history remains");
  assert.equal(popup.node("resultCount").textContent, "1");
  const row = popup.node("apiStatus").children[0];
  assert.match(row.innerHTML, /api-state pending/);
  assert.match(row.innerHTML, /2 lưu · 1 lỗi/);
  assert.doesNotMatch(row.innerHTML, /Chờ worker|api-state ok|retry-image-fix-research/);
  await row.querySelector(".image-errors").click();
  assert.equal(popup.node("jsonModal").hidden, false);
  assert.match(popup.node("modalJson").textContent, /failed\.jpg/);
  assert.match(popup.node("modalJson").textContent, /HTTP 403/);
  await row.querySelector(".retry-api").click();
  assert.equal(popup.messages.at(-1).type, "retry-update");
  assert.equal(popup.messages.at(-1).articleId, item.id);
  assert.match(popup.node("status").textContent, /2 ảnh lưu · 1 ảnh lỗi/);
  assert.doesNotMatch(popup.node("status").textContent, /thành công|worker/);
  assert.equal(row.querySelector(".retry-api").disabled, false);
});

test("Fix ảnh retry transport error keeps prior partial counts and shows the new API error", async () => {
  const popup = loadPopup();
  const item = { id: "fix-retry-error", sourceType: "facility_image_fix", facility_id: 7, title: "Cơ sở", status: "chưa xác nhận",
    result: { id: 7 }, image_fix_api_pending: true, image_fix_import_pending: true, api_error: "HTTP 504 proxy timeout",
    api_previous_update: { updated: [{ id: 7, image_processing: "partial", images_imported: 2, images_failed: 1 }] } };
  popup.node("sourceType").value = "facility_image_fix";
  popup.functions.setState({ items: [item], runner: { active: false } });
  popup.functions.render();
  const row = popup.node("apiStatus").children[0];
  await row.querySelector(".api-state").click();
  assert.match(popup.node("modalJson").textContent, /HTTP 504/);
  assert.match(popup.node("modalJson").textContent, /2 ảnh lưu · 1 ảnh lỗi/);
  assert.match(row.innerHTML, /retry-api/);
});

test("Fix ảnh in-flight status describes synchronous download/storage without a POST deadline", () => {
  const popup = loadPopup();
  const current = { id: "fix-busy", sourceType: "facility_image_fix", facility_id: 7, status: "đang cập nhật", api_request_started_at: new Date().toISOString() };
  const view = popup.functions.systemNoticeView({ active: true, current, worker: {}, now: Date.now() });
  assert.match(view.phase, /tải\/lưu ảnh/);
  assert.match(view.detail, /không cắt thời gian POST/);
  assert.doesNotMatch(view.detail, /chờ worker/);
});

test("queues facility and Toplist records with the same numeric ID separately", () => {
  const { functions } = loadPopup();
  const facility = functions.mergeApiArticles([], [{ id: 7, name: "Cơ sở 7", prompt: "Viết cơ sở" }], "facility");
  const merged = functions.mergeApiArticles(facility.items, [{ id: 7, title: "Top cơ sở", prompt: "Viết Toplist" }], "toplist");
  assert.deepEqual(plain(merged.items.map((item) => item.id)), ["facility-7", "toplist-7"]);
  assert.equal(merged.items[0].facility_id, 7);
  assert.equal(merged.items[1].toplist_id, 7);
  assert.equal(merged.items[1].sourceType, "toplist");
});

test("doctor research has its own source and preserves verbatim API prompt separately from doctor translation", () => {
  const { functions } = loadPopup();
  const facility = functions.mergeApiArticles([], [{ id: 7, name: "Cơ sở 7", prompt: "Viết cơ sở" }], "facility");
  const prompt = "  Nghiên cứu bác sĩ\nHợp đồng JSON của server\n  ";
  const research = functions.mergeApiArticles(facility.items, [{ id: 7, name: "Bác sĩ A", type: "doctor", prompt,
    output_template: { id: 7, name: "Bác sĩ A", insufficient_data: false, education_json: [] } }], "doctor");
  const merged = functions.mergeApiArticles(research.items, [{ source_id: 7, type: "doctor", name: "Bác sĩ A", prompt: "Dịch bác sĩ" }], "translation");
  assert.deepEqual(plain(merged.items.map((item) => item.id)), ["facility-7", "doctor-7", "translation-doctor-7"]);
  const doctor = merged.items[1];
  assert.equal(doctor.doctor_id, 7);
  assert.equal(doctor.facility_id, undefined);
  assert.equal(doctor.sourceType, "doctor");
  assert.equal(doctor.prompt, prompt);
  assert.deepEqual(plain(doctor.output_template.education_json), []);
  assert.equal(functions.displayArticleTitle(doctor), "Bác sĩ · Bác sĩ A");
  const updated = functions.mergeApiArticles(merged.items, [{ id: 7, name: "Bác sĩ A", prompt: "Prompt mới từ API", output_template: { id: 7, version: 2 } }], "doctor");
  assert.equal(updated.added, 0);
  assert.equal(updated.items[1].prompt, "Prompt mới từ API", "waiting doctor prompts must not retain old cached versions");
  assert.equal(updated.items[1].output_template.version, 2);
  assert.equal(updated.items[2].prompt, "Dịch bác sĩ");
});

test("doctor source refresh and run are distinct from the translation doctor's subtype", async () => {
  const popup = loadPopup({ respond: async () => ({ ok: true, items: [], added: 0, skipped: 0 }) });
  await popup.functions.resolvePanelContext();
  popup.node("sourceType").value = "doctor";
  popup.node("translationType").value = "doctor";
  popup.functions.setState({ items: [], sourceType: "doctor", runner: { active: false } });
  await popup.functions.loadArticles();
  assert.deepEqual(popup.messages.at(-1), { type: "refresh-queue", sourceType: "doctor", targetTabId: 33 });
  await popup.functions.toggleCurrentTabRun();
  assert.deepEqual(popup.messages.at(-1), { type: "start-run", targetTabId: 33, provider: "chatgpt", sourceType: "doctor" });
  assert.equal(popup.node("translationTypeWrap").hidden, true);
  assert.equal(popup.node("queueHeading").textContent, "Hồ sơ cần nghiên cứu");
  assert.equal(popup.node("resultsHeading").textContent, "Hồ sơ đã nghiên cứu");
});

test("doctor queue load failures have an accessible, initially hidden retry notice", () => {
  const html = fs.readFileSync(path.join(__dirname, "../popup.html"), "utf8");
  const notice = html.match(/<[^>]+\bid="queueLoadError"[^>]*>/)?.[0];
  assert.ok(notice, "the queue load error needs a dedicated notice, not only the transient status line");
  assert.match(notice, /\bhidden\b/);
  assert.match(notice, /\brole="alert"|\baria-live="(?:assertive|polite)"/);
  for (const id of ["queueErrorTitle", "queueErrorMessage", "queueErrorHelp"]) assert.match(html, new RegExp(`id="${id}"`));
  const retry = html.match(/<button\b[^>]*\bid="queueRetry"[^>]*>/)?.[0];
  assert.ok(retry, "retry must remain a keyboard-accessible native button");
  assert.match(retry, /\btype="button"/);
});

test("doctor HTTP 503 blocks Run and preserves existing JSON and receipt leases", async () => {
  const saved = { id: "tab-33:doctor-7", ownerTabId: 33, doctor_id: 7, sourceType: "doctor", title: "Bác sĩ đã lưu", status: "hoàn tất",
    result: { id: 7, name: "Bác sĩ đã lưu", content: "JSON cũ vẫn giữ nguyên" }, api_update: { ok: true } };
  const receipt = { id: "tab-33:doctor-8", ownerTabId: 33, doctor_id: 8, sourceType: "doctor", title: "Bác sĩ cần xác nhận", status: "chưa xác nhận",
    result: { id: 8, content: "JSON đang chờ xác nhận" }, api_error: "POST chưa xác nhận",
    writer_claim_token: "mock-owner-token", writer_claim_request_id: "mock-attempt-8", doctor_writer_request_id: "mock-attempt-8" };
  const items = [saved, receipt];
  const popup = loadPopup({ respond: async () => ({ ok: false, error: doctorSchemaMessage, httpStatus: 503,
    doctorQueueError: true, queueState: doctorQueueFailure }) });
  await popup.functions.resolvePanelContext();
  popup.node("sourceType").value = "doctor";
  popup.functions.setState({ sourceType: "doctor", items: plain(items), runner: { active: false } });
  popup.functions.render();
  const savedResultRow = popup.node("results").children[1]; // Results are newest first.
  const receiptApiRow = popup.node("apiStatus").children[1];
  assert.ok(savedResultRow);
  assert.ok(receiptApiRow);

  await popup.functions.loadArticles();

  assertDoctorQueueFailure(popup);
  assert.equal(popup.node("queueRetry").disabled, false, "a failed request must leave manual retry available");
  assert.match(popup.node("status").textContent, /HTTP 503/);
  assert.deepEqual(plain(popup.functions.getState().items), items, "loading an unavailable schema must not replace any stored JSON or lease");
  assert.equal(popup.node("resultCount").textContent, "2");
  assert.equal(popup.node("apiCount").textContent, "2");
  assert.equal(popup.node("results").children[1], savedResultRow);
  assert.equal(popup.node("apiStatus").children[1], receiptApiRow);
  await popup.functions.toggleCurrentTabRun();
  assert.equal(popup.messages.some((message) => message.type === "start-run"), false, "the defensive Run guard must also reject a direct call");
});

test("a thrown doctor HTTP 503 becomes a persistent queue error instead of a successful empty queue", async () => {
  const popup = loadPopup({ respond: async () => { throw new Error(doctorSchemaMessage); } });
  await popup.functions.resolvePanelContext();
  popup.node("sourceType").value = "doctor";
  popup.functions.setState({ sourceType: "doctor", items: [], runner: { active: false } });

  await popup.functions.loadArticles();

  assertDoctorQueueFailure(popup);
  assert.equal(popup.node("queueCount").textContent, "0");
  assert.doesNotMatch(popup.node("items").innerHTML, /Chưa có bài|Đã xử lý hết/, "an unavailable API must not be described as successfully exhausted");
  assert.equal(popup.node("refresh").disabled, false);
  assert.equal(popup.node("sourceType").disabled, false);
  await popup.functions.toggleCurrentTabRun();
  assert.equal(popup.messages.some((message) => message.type === "start-run"), false);
});

test("old raw quota error is restored as storage failure, not an API/schema outage", async () => {
  const popup = loadPopup({ stored: {
    ...defaults, sourceType: "doctor", "tab-task-source:33": { sourceType: "doctor" },
    "tab-doctor-queue:33": { ...doctorQueueFailure, httpStatus: null, schemaUnavailable: false,
      message: "Resource::kQuotaBytes quota exceeded", help: "Kiểm tra API/endpoint rồi thử lại." },
    items: []
  } });
  await popup.init();
  assert.equal(popup.node("queueLoadError").hidden, false);
  assert.equal(popup.node("queueErrorTitle").textContent, "Bộ nhớ tiện ích đã đầy");
  assert.match(popup.node("queueErrorHelp").textContent, /chrome:\/\/extensions/);
  assert.match(popup.node("queueErrorHelp").textContent, /Không gỡ tiện ích/);
  assert.doesNotMatch(popup.node("queueErrorHelp").textContent, /DB|schema|endpoint/);
  assert.equal(popup.node("systemPhase").textContent, "Bộ nhớ tiện ích đã đầy");
  assert.match(popup.node("runDetail").textContent, /Reload tiện ích/);
  assert.equal(popup.messages.some((message) => message.type === "refresh-queue"), false);
});

for (const sourceType of ["doctor", "facility", "facility_image_fix", "toplist", "translation"]) {
  test(`quota failure in ${sourceType} preserves saved JSON and offers safe retry`, async () => {
    let ready = false;
    const saved = { id: `tab-33:${sourceType}-7`, ownerTabId: 33, sourceType, title: "JSON đã lưu",
      status: "lỗi cập nhật", has_result: true, content_version: 1, writer_claim_token: "original-token" };
    const result = { id: 7, content: "Dữ liệu chưa gửi" };
    const stored = { ...defaults, sourceType, "tab-task-source:33": { sourceType },
      items: [saved], "tab-job-items:33": [saved], [`article-content:${saved.id}`]: { result, rawResponse: JSON.stringify(result) } };
    const popup = loadPopup({ stored, respond: async () => ready ? { ok: true, items: [saved], added: 0,
      queueState: doctorQueueReady } : { ok: false, error: "Resource::kQuotaBytes quota exceeded",
      storageError: true, errorCode: "storage_quota_exceeded" } });
    await popup.init();
    await popup.functions.loadArticles();
    assert.equal(popup.node("queueLoadError").hidden, false);
    assert.equal(popup.node("queueErrorTitle").textContent, "Bộ nhớ tiện ích đã đầy");
    assert.equal(popup.node("runToggle").disabled, true);
    assert.equal(popup.functions.getState().items[0].writer_claim_token, saved.writer_claim_token);
    assert.deepEqual(popup.stored[`article-content:${saved.id}`], stored[`article-content:${saved.id}`]);
    const before = popup.messages.length;
    await popup.functions.toggleCurrentTabRun();
    assert.equal(popup.messages.slice(before).some((message) => message.type === "start-run"), false);
    ready = true;
    await popup.functions.loadArticles();
    assert.equal(popup.node("queueLoadError").hidden, true);
    assert.equal(popup.node("runToggle").disabled, false);
    assert.deepEqual(popup.stored[`article-content:${saved.id}`], stored[`article-content:${saved.id}`]);
  });
}

test("a stored doctor schema failure is restored for its tab without automatically requesting it again", async () => {
  const otherTabState = { ...doctorQueueReady, message: "Tab khác đã tải được" };
  const popup = loadPopup({ stored: {
    "tab-task-source:33": { sourceType: "doctor" }, "tab-job-items:33": [],
    "tab-doctor-queue:33": doctorQueueFailure, "tab-doctor-queue:44": otherTabState,
    runner: { active: false }
  } });

  await popup.init();

  assert.equal(popup.node("sourceType").value, "doctor");
  assertDoctorQueueFailure(popup);
  assert.deepEqual(plain(popup.functions.getState().doctorQueueState), doctorQueueFailure);
  assert.equal(popup.messages.some((message) => message.type === "refresh-queue"), false, "reopening the panel must wait for an explicit retry after 503");
  for (const timer of popup.intervals.filter((timer) => !timer.cleared)) timer.callback();
  assert.equal(popup.messages.some((message) => message.type === "refresh-queue"), false, "UI clocks must not become an automatic retry loop");
  assert.deepEqual(popup.stored["tab-doctor-queue:44"], otherTabState);
});

test("the legacy doctor queue namespace restores a failure when no target tab is available", async () => {
  const popup = loadPopup({ tabContext: { ok: false, error: "Không xác định được tab AI." }, stored: {
    sourceType: "doctor", items: [], "tab-doctor-queue:legacy": doctorQueueFailure, runner: { active: false }
  } });

  await popup.init();

  assert.equal(popup.functions.getPanelContext().targetTabId, null);
  assert.deepEqual(plain(popup.functions.getState().doctorQueueState), doctorQueueFailure);
  assert.equal(popup.node("queueLoadError").hidden, false);
  assert.match(popup.node("queueErrorMessage").textContent, /HTTP 503/);
  assert.equal(popup.messages.some((message) => message.type === "refresh-queue"), false);
});

test("manual doctor retry clears the schema error and keeps old JSON and unresolved receipt leases", async () => {
  const saved = { id: "tab-33:doctor-7", ownerTabId: 33, doctor_id: 7, sourceType: "doctor", title: "Bác sĩ đã lưu", status: "hoàn tất",
    result: { id: 7, content: "Giữ JSON đã lưu" }, api_update: { ok: true } };
  const receipt = { id: "tab-33:doctor-8", ownerTabId: 33, doctor_id: 8, sourceType: "doctor", title: "Bác sĩ chưa xác nhận", status: "chưa xác nhận",
    result: { id: 8, content: "Giữ JSON chờ API" }, writer_claim_token: "mock-owner-token",
    writer_claim_request_id: "mock-attempt-8", doctor_writer_request_id: "mock-attempt-8", api_error: "POST chưa xác nhận" };
  const next = { id: "tab-33:doctor-9", ownerTabId: 33, doctor_id: 9, sourceType: "doctor", title: "Bác sĩ mới", status: "chờ", prompt: "Prompt API nguyên bản" };
  const popup = loadPopup({ stored: {
    "tab-task-source:33": { sourceType: "doctor" }, "tab-job-items:33": [saved, receipt],
    "tab-doctor-queue:33": doctorQueueFailure, runner: { active: false }
  }, respond: async (message) => message.type === "refresh-queue"
    ? { ok: true, items: [saved, receipt, next], added: 1, skipped: 0, queueState: doctorQueueReady }
    : { ok: true } });
  await popup.init();
  assertDoctorQueueFailure(popup);
  const savedResultRow = popup.node("results").children[1]; // Results are newest first.
  const receiptApiRow = popup.node("apiStatus").children[1];
  assert.ok(savedResultRow);
  assert.ok(receiptApiRow);

  await popup.node("queueRetry").click();

  assert.deepEqual(popup.messages.filter((message) => message.type === "refresh-queue"), [
    { type: "refresh-queue", sourceType: "doctor", targetTabId: 33 }
  ]);
  assert.equal(popup.functions.getState().doctorQueueState?.status, "ready");
  assert.equal(popup.node("queueLoadError").hidden, true);
  assert.equal(popup.node("runToggle").disabled, false);
  assert.notEqual(popup.node("runCaption").textContent, "Không tải được hồ sơ");
  assert.deepEqual(plain(popup.functions.getState().items), [saved, receipt, next]);
  assert.equal(popup.node("results").children[1], savedResultRow, "successful retry keeps the saved JSON history row");
  assert.equal(popup.node("apiStatus").children[1], receiptApiRow, "successful retry does not rebuild an unresolved receipt row");
  await savedResultRow.click();
  assert.deepEqual(JSON.parse(popup.node("modalJson").textContent), saved.result);
  await popup.functions.toggleCurrentTabRun();
  assert.deepEqual(popup.messages.at(-1), { type: "start-run", targetTabId: 33, provider: "chatgpt", sourceType: "doctor" });
});

test("a successful HTTP 200 doctor retry with no rows is ready, not a schema failure", async () => {
  const popup = loadPopup({ stored: {
    "tab-task-source:33": { sourceType: "doctor" }, "tab-job-items:33": [],
    "tab-doctor-queue:33": doctorQueueFailure, runner: { active: false }
  }, respond: async (message) => message.type === "refresh-queue"
    ? { ok: true, items: [], added: 0, skipped: 0, queueState: doctorQueueReady }
    : { ok: true } });
  await popup.init();

  await popup.node("queueRetry").click();

  assert.equal(popup.functions.getState().doctorQueueState?.status, "ready");
  assert.equal(popup.node("queueLoadError").hidden, true);
  assert.equal(popup.node("queueCount").textContent, "0");
  assert.equal(popup.node("runToggle").disabled, false);
  assert.equal(popup.node("runCaption").textContent, "Sẵn sàng");
  assert.match(popup.node("runDetail").textContent, /Không còn bác sĩ đang chờ/);
  assert.doesNotMatch(popup.node("status").textContent, /HTTP 503|schema bác sĩ/);
});

test("a doctor queue failure does not block a facility source on the same tab", async () => {
  const facility = { id: "tab-33:facility-7", ownerTabId: 33, facility_id: 7, sourceType: "facility", title: "Cơ sở", prompt: "Prompt cơ sở", status: "chờ" };
  const popup = loadPopup({ respond: async () => ({ ok: true }) });
  await popup.functions.resolvePanelContext();
  popup.functions.setState({ sourceType: "doctor", doctorQueueState: doctorQueueFailure, items: [facility], runner: { active: false } });
  popup.node("sourceType").value = "doctor";
  popup.functions.render();
  assertDoctorQueueFailure(popup);

  popup.node("sourceType").value = "facility";
  popup.functions.render();

  assert.equal(popup.node("queueLoadError").hidden, true);
  assert.equal(popup.node("runToggle").disabled, false);
  assert.equal(popup.node("queueCount").textContent, "1");
  assert.deepEqual(plain(popup.functions.getState().doctorQueueState), doctorQueueFailure, "switching sources preserves the doctor diagnostic for later");
  await popup.functions.toggleCurrentTabRun();
  assert.deepEqual(popup.messages.at(-1), { type: "start-run", targetTabId: 33, provider: "chatgpt", sourceType: "facility" });
});

test("doctor queue storage changes repaint only the matching tab and clear a recovered error", async () => {
  const waiting = { id: "tab-33:doctor-7", ownerTabId: 33, doctor_id: 7, sourceType: "doctor", title: "Bác sĩ", prompt: "Nghiên cứu", status: "chờ" };
  const popup = loadPopup({ stored: {
    "tab-task-source:33": { sourceType: "doctor" }, "tab-job-items:33": [waiting],
    "tab-doctor-queue:33": doctorQueueReady, runner: { active: false }
  } });
  await popup.init();
  const queueRow = popup.node("items").children[0];
  assert.equal(popup.node("queueLoadError").hidden, true);

  popup.emitChanges({ "tab-doctor-queue:44": { newValue: doctorQueueFailure } });

  assert.equal(popup.functions.getState().doctorQueueState?.status, "ready");
  assert.equal(popup.node("queueLoadError").hidden, true);
  assert.equal(popup.node("runToggle").disabled, false);
  assert.equal(popup.node("items").children[0], queueRow);

  popup.emitChanges({ "tab-doctor-queue:33": { newValue: doctorQueueFailure } });

  assertDoctorQueueFailure(popup);
  assert.equal(popup.node("items").children[0], queueRow, "error metadata must not recreate queued jobs or lose their actions");

  popup.emitChanges({ "tab-doctor-queue:33": { newValue: doctorQueueReady } });

  assert.equal(popup.node("queueLoadError").hidden, true);
  assert.equal(popup.node("runToggle").disabled, false);
  assert.equal(popup.functions.getState().doctorQueueState?.status, "ready");
  assert.equal(popup.node("items").children[0], queueRow);
  assert.equal(popup.messages.some((message) => message.type === "refresh-queue"), false, "storage repaint is not an implicit reload");
});

test("another panel's pending doctor refresh keeps Run disabled until its queue is ready", async () => {
  const popup = loadPopup({ stored: {
    "tab-task-source:33": { sourceType: "doctor" }, "tab-job-items:33": [],
    "tab-doctor-queue:33": doctorQueueFailure, runner: { active: false }
  } });
  await popup.init();

  popup.emitChanges({ "tab-doctor-queue:33": { newValue: { sourceType: "doctor", status: "loading", requestId: "other-panel-refresh" } } });

  assert.equal(popup.functions.getState().doctorQueueState.status, "loading");
  assert.equal(popup.node("runToggle").disabled, true, "removing the previous error must not make an unconfirmed queue runnable");
  assert.match(popup.node("runCaption").textContent, /^Đang tải hồ sơ(?: bác sĩ)?$/);
  assert.equal(popup.messages.some((message) => message.type === "refresh-queue" || message.type === "start-run"), false);

  popup.emitChanges({ "tab-doctor-queue:33": { newValue: doctorQueueReady } });

  assert.equal(popup.node("runToggle").disabled, false);
  assert.equal(popup.node("runCaption").textContent, "Sẵn sàng");
  assert.equal(popup.node("queueLoadError").hidden, true);
});

test("manual doctor retry immediately shows pending feedback and cannot send duplicate refreshes", async () => {
  let resolveReply, enteredRefresh;
  const entered = new Promise((resolve) => { enteredRefresh = resolve; });
  const popup = loadPopup({ stored: {
    "tab-task-source:33": { sourceType: "doctor" }, "tab-job-items:33": [],
    "tab-doctor-queue:33": doctorQueueFailure, runner: { active: false }
  }, respond: async (message) => {
    if (message.type !== "refresh-queue") return { ok: true };
    enteredRefresh();
    return new Promise((resolve) => { resolveReply = resolve; });
  } });
  await popup.init();

  const retrying = popup.node("queueRetry").click();
  await entered;

  assert.equal(popup.node("queueRetry").disabled, true);
  assert.equal(popup.node("queueRetry").textContent, "Đang thử lại…");
  assert.equal(popup.node("runToggle").disabled, true);
  await popup.node("queueRetry").click(); // A direct event still exercises the loading guard.
  assert.equal(popup.messages.filter((message) => message.type === "refresh-queue").length, 1);
  resolveReply({ ok: true, items: [], added: 0, skipped: 0, queueState: doctorQueueReady });
  await retrying;
  assert.equal(popup.node("queueLoadError").hidden, true);
  assert.equal(popup.node("runToggle").disabled, false);
});

test("a doctor URL error popup gives field-specific manual repair instructions without sending AI or losing JSON", async () => {
  const result = { id: 12, name: "BS. Nguyễn Văn An", website_url: { url: "https://example.org/doctor" },
    sources_json: [{ id: "s1", url: "https://example.org/doctor" }],
    evidence_json: { identity_status: "matched" }, future_field: { original: [null, false] } };
  const item = { id: "tab-33:doctor-12", ownerTabId: 33, doctor_id: 12, name: result.name, title: result.name,
    sourceType: "doctor", status: "lỗi cập nhật", result,
    api_error: "website_url: URL phải là chuỗi hoặc null, không phải object, mảng, số hay boolean. JSON gốc được giữ nguyên, chưa gửi website." };
  const popup = loadPopup();
  await popup.functions.resolvePanelContext();
  popup.node("sourceType").value = "doctor";
  popup.functions.setState({ sourceType: "doctor", items: [plain(item)], runner: { active: false } });
  popup.functions.render();
  const messagesBefore = popup.messages.length;

  await popup.node("apiStatus").children[0].querySelector(".api-state").click();

  assert.equal(popup.node("jsonModal").hidden, false);
  const guide = popup.node("modalJson").textContent;
  assert.match(guide, /website_url: URL/);
  assert.match(guide, /Hướng dẫn sửa JSON bằng AI \(chưa tự gửi\)/);
  assert.match(guide, /id 12/);
  assert.ok(guide.includes(JSON.stringify(result.name)));
  assert.match(guide, /Giữ nguyên id, name/);
  assert.match(guide, /không (?:tự chọn URL từ object nhiều trường hay )?xoá ảnh\/nguồn\/chứng cứ/);
  assert.match(guide, /gallery_json\[i\]\.url.*sources_json\[i\]\.url/);
  assert.match(guide, /bắt buộc.*không null/);
  assert.match(guide, /social_links_json.*CHUỖI URL/);
  assert.match(guide, /social_links_json.*object.*danh sách object chỉ gồm platform và url/);
  assert.match(guide, /giữ tên nền tảng.*khoảng trắng ngoài.*không trùng\/trống/);
  assert.match(guide, /không tự chọn URL từ object nhiều trường/);
  assert.match(guide, /video_urls_json.*CHUỖI URL/);
  assert.match(guide, /không thêm claim token\/khóa API/);
  assert.match(guide, /gửi lại JSON cũ sẽ vẫn bị chặn nếu chưa sửa/);
  assert.equal(popup.messages.length, messagesBefore, "reading repair guidance must not automatically send a prompt or resubmit JSON");
  assert.deepEqual(plain(popup.functions.getState().items[0]), item);
  await popup.node("results").children[0].click();
  assert.deepEqual(JSON.parse(popup.node("modalJson").textContent), result, "the original malformed JSON stays available separately from the repair guidance");
});

test("completed doctor insufficient-data research is a completed audit, not a retryable failed article", () => {
  const popup = loadPopup();
  const doctor = { id: "doctor-7", doctor_id: 7, sourceType: "doctor", title: "Bác sĩ A", status: "hoàn tất",
    result: { id: 7, name: "Bác sĩ A", insufficient_data: true, content: null, notes_for_editor: "Chưa xác thực được người cùng tên." } };
  assert.equal(popup.functions.displayJobStatus(doctor), "đã nghiên cứu · thiếu dữ liệu");
  assert.equal(popup.functions.displayJobStatus({ ...doctor, result: undefined, insufficient_data: true, has_result: true }), "đã nghiên cứu · thiếu dữ liệu");
  assert.equal(popup.functions.displayJobStatus({ ...doctor, result: { insufficient_data: false } }), "đã lưu hồ sơ · chờ duyệt");
  const notice = popup.functions.systemNoticeView({ active: false, latest: doctor, runner: { active: false } });
  assert.equal(notice.phase, "Đã lưu nghiên cứu thiếu dữ liệu");
  assert.match(notice.detail, /không tự viết lại/);
  assert.match(notice.detail, /Chưa xác thực/);
  assert.match(notice.detail, /ID: 7/);
  popup.node("sourceType").value = "doctor";
  popup.functions.setState({ items: [doctor], sourceType: "doctor", runner: { active: false } });
  popup.functions.render();
  assert.equal(popup.node("queueCount").textContent, "0");
  assert.equal(popup.node("resultCount").textContent, "1");
  assert.match(popup.node("results").children[0].innerHTML, /THIẾU DL/);
  assert.doesNotMatch(popup.node("apiStatus").children[0].innerHTML, /retry-api/, "saved doctor audit has no lease and must not be resubmitted");
});

test("doctor API URLs and chosen source are isolated to the current tab", async () => {
  const stored = { "tab-api-settings:33": { doctorsUrl: "https://example.invalid/own-doctors", doctorUpdateUrl: "https://example.invalid/own-save" },
    "tab-api-settings:44": { doctorsUrl: "https://example.invalid/other-doctors", doctorUpdateUrl: "https://example.invalid/other-save" },
    "tab-task-source:33": { sourceType: "doctor" }, "tab-task-source:44": { sourceType: "translation", translationType: "doctor" },
    runner: { active: true, workers: { "tab-44": { active: true, sourceType: "translation", translationType: "doctor", targetTabId: 44 } } } };
  const popup = loadPopup({ stored });
  await popup.init();
  assert.equal(popup.node("sourceType").value, "doctor");
  assert.equal(popup.node("doctorsUrl").value, "https://example.invalid/own-doctors");
  popup.node("doctorUpdateUrl").value = "https://example.invalid/own-new-save";
  await popup.functions.saveSettings();
  assert.equal(popup.stored["tab-api-settings:33"].doctorUpdateUrl, "https://example.invalid/own-new-save");
  assert.equal(popup.stored["tab-api-settings:44"].doctorUpdateUrl, "https://example.invalid/other-save");
  assert.equal(popup.stored["tab-task-source:44"].sourceType, "translation");
});

test("translation queue keeps type and source_id as immutable identity and uses the API prompt", () => {
  const { functions } = loadPopup();
  const facility = functions.mergeApiArticles([], [{
    source_id: 7, type: "facility", title: "Phòng khám A", prompt: "Dịch đúng prompt API",
    translation_fields: ["subtitle_en", "content_en"], output_template: { subtitle_en: "", content_en: "" }
  }], "translation");
  const doctor = functions.mergeApiArticles(facility.items, [{
    source_id: 7, type: "doctor", title: "Bác sĩ A", prompt: "Prompt bác sĩ"
  }], "translation");
  assert.deepEqual(plain(doctor.items.map(({ id }) => id)), ["translation-facility-7", "translation-doctor-7"]);
  assert.equal(doctor.items[0].type, "facility");
  assert.equal(doctor.items[0].source_id, 7);
  assert.equal(doctor.items[0].prompt, "Dịch đúng prompt API");
  assert.equal(doctor.items[1].type, "doctor");
});

test("translation API success is presented as a saved draft", () => {
  const { functions } = loadPopup();
  assert.equal(functions.displayJobStatus({ sourceType: "translation", status: "hoàn tất", api_update: { status: "draft" } }), "đã lưu bản dịch nháp");
});

test("deduplicates repeated API rows and subsequent reloads", () => {
  const { functions } = loadPopup();
  const incoming = [{ id: 7, title: "Toplist", prompt: "Prompt gốc" }, { id: "7", title: "Trùng", prompt: "Prompt trùng" }];
  const first = functions.mergeApiArticles([], incoming, "toplist");
  const again = functions.mergeApiArticles(first.items, incoming, "toplist");
  assert.equal(first.added, 1);
  assert.equal(again.added, 0);
  assert.equal(again.items.length, 1);
  assert.equal(again.items[0].prompt, "Prompt gốc");
});

test("preserves the API prompt exactly and skips rows missing a usable prompt", () => {
  const { functions } = loadPopup();
  const prompt = '  Viết Toplist\nGiữ JSON {"toplist_id":7,"facilities":[]}\n  ';
  const result = functions.mergeApiArticles([], [
    { id: 7, title: "Toplist", prompt },
    { id: 8, title: "Thiếu" }, { id: 9, prompt: null },
    { id: 10, prompt: "   \n" }, { prompt: "Thiếu ID" }
  ], "toplist");
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 4);
  assert.equal(result.items[0].prompt, prompt);
});

test("keeps legacy facility results and statuses while adding Toplists", () => {
  const { functions } = loadPopup();
  const legacy = {
    id: "facility-7", facility_id: 7, title: "Cơ sở cũ", prompt: "Prompt cũ", status: "hoàn tất",
    result: { id: 7, content: "Đã viết", reviews: [{ rating: 5 }] }, api_update: { ok: true, updated_ids: [7] }
  };
  const current = [legacy];
  const result = functions.mergeApiArticles(current, [{ id: 7, title: "Toplist mới", prompt: "Prompt mới" }], "toplist");
  assert.deepEqual(plain(result.items[0]), legacy);
  assert.equal(current.length, 1, "merge must not mutate the original queue");
  assert.equal(functions.mergeApiArticles(result.items, [{ id: 7, name: "Cơ sở trùng", prompt: "Prompt khác" }], "facility").added, 0);
  assert.equal(functions.displayArticleTitle(legacy), "Cơ sở cũ");
  assert.equal(functions.displayArticleTitle(result.items[1]), "Toplist · Toplist mới");
});

test("one button auto-detects Claude and controls only its exact tab", async () => {
  const popup = loadPopup({
    search: "?embedded=1&provider=claude&tabId=33",
    tabContext: { ok: true, tabId: 33, targetTabId: 33, provider: "claude", supported: true },
    stored: {
      runner: {
        active: true,
        workers: { "tab-44": { active: true, provider: "grok", targetTabId: 44, currentId: "facility-8" } }
      }
    },
    respond: async (message) => {
      if (message.type === "start-run") popup.emitChanges({ runner: { newValue: {
        active: true, workers: {
          "tab-44": { active: true, provider: "grok", targetTabId: 44, currentId: "facility-8" },
          "tab-33": { active: true, provider: "claude", targetTabId: 33, sourceType: "facility" }
        }
      } } });
      return { ok: true };
    }
  });
  await popup.functions.resolvePanelContext();
  popup.functions.setState({
    items: [{ id: "facility-7", title: "Bài Claude", status: "chờ" }],
    runner: {
      active: true,
      workers: { "tab-44": { active: true, provider: "grok", targetTabId: 44, currentId: "facility-8" } }
    }
  });
  popup.functions.updateRunButton();

  assert.equal(popup.node("runProvider").textContent, "Claude");
  assert.equal(popup.node("runLabel").textContent, "Chạy");
  assert.equal(popup.node("runToggle").disabled, false, "another running tab must not disable this tab's Run button");

  await popup.node("runToggle").click();
  assert.deepEqual(popup.messages.at(-1), { type: "start-run", targetTabId: 33, provider: "claude", sourceType: "facility" });
  assert.equal(popup.node("runLabel").textContent, "Dừng");
  assert.equal(popup.functions.currentTabIsRunning(), true);

  await popup.node("runToggle").click();
  assert.deepEqual(popup.messages.at(-1), { type: "stop-run", targetTabId: 33, provider: "claude" });
  assert.equal(popup.node("runLabel").textContent, "Chạy");
  assert.equal(popup.functions.currentTabIsRunning(), false);
});

test("running Gemini shows the live seconds remaining before the next queued article", async () => {
  const popup = loadPopup({
    search: "?embedded=1&provider=gemini&tabId=33",
    tabContext: { ok: true, tabId: 33, targetTabId: 33, provider: "gemini", supported: true }
  });
  await popup.functions.resolvePanelContext();
  popup.functions.setState({
    sourceType: "facility",
    items: [{ id: "facility-2", facility_id: 2, title: "Bài tiếp", status: "chờ" }],
    runner: {
      active: true,
      workers: { "tab-33": { active: true, provider: "gemini", targetTabId: 33, currentId: null, nextJobAt: Date.now() + 42000 } }
    }
  });
  popup.functions.updateRunButton();

  assert.equal(popup.node("runCaption").textContent, "Đang chạy Gemini");
  assert.match(popup.node("runDetail").textContent, /^Đã tải dữ liệu bài tiếp theo · còn 4[12] giây · Bài tiếp$/);
  assert.equal(popup.intervals.at(-1).ms, 1000, "the displayed remaining seconds should update once per second");
});

test("progress-only updates preserve queue, result and API DOM rows", () => {
  const popup = loadPopup();
  const items = [
    { id: "facility-1", title: "Waiting", status: "chờ", prompt: "Write" },
    { id: "facility-2", title: "Sending", status: "đang cập nhật", has_result: true, content_version: 1, api_request_started_at: new Date().toISOString() }
  ];
  popup.functions.setState({ items, runner: { active: false } });
  popup.functions.render();
  const queueRow = popup.node("items").children[0];
  const resultRow = popup.node("results").children[0];
  const apiRow = popup.node("apiStatus").children[0];
  const secondQueueRow = popup.node("items").children[1];
  items[0].last_progress_at = new Date().toISOString();
  popup.functions.render();
  assert.equal(popup.node("items").children[0], queueRow);
  assert.equal(popup.node("results").children[0], resultRow);
  assert.equal(popup.node("apiStatus").children[0], apiRow);
  for (const timer of popup.intervals.filter((timer) => !timer.cleared)) timer.callback();
  assert.equal(popup.node("apiStatus").children[0], apiRow, "API elapsed seconds must not rebuild rows");
  items[0].status = "lỗi";
  popup.functions.render();
  assert.notEqual(popup.node("items").children[0], queueRow, "changed row must update");
  assert.equal(popup.node("items").children[1], secondQueueRow, "changing one row must preserve another row");
  assert.equal(popup.node("apiStatus").children[0], apiRow, "adding an API error must preserve the other in-flight row");
});

test("metadata-only result opens its JSON on demand", async () => {
  const popup = loadPopup({ respond: async (message) => message.type === "get-article-content" ? { ok: true, content: { result: { id: 41, content: "Complete JSON" } } } : { ok: true } });
  popup.functions.setState({ items: [{ id: "facility-41", title: "Nha khoa", status: "hoàn tất", has_result: true, content_version: 2 }], runner: { active: false } });
  popup.functions.render();
  assert.equal(popup.messages.length, 0, "rendering must not fetch a large result");
  await popup.node("results").children[0].click();
  assert.equal(popup.messages[0].type, "get-article-content");
  assert.deepEqual(JSON.parse(popup.node("modalJson").textContent), { id: 41, content: "Complete JSON" });
});

test("system card reports prompt preparation, retry, JSON and reload countdown accurately", () => {
  const { systemNoticeView } = loadPopup().functions;
  const now = Date.now();
  const worker = { provider: "gemini", runToken: "run-41" };
  const current = { id: "facility-41", facility_id: 41, title: "Nha khoa", status: "đang viết", prompt_sent_at: new Date(now - 590000).toISOString() };
  const notice = { articleId: current.id, runToken: worker.runToken, phase: "waiting-ai", detail: "Theo dõi Stop mỗi giây." };
  const view = (fields = {}) => systemNoticeView({ active: true, worker, current, notice, now, ...fields });
  assert.equal(view().phase, "Chuẩn bị tải lại Spark");
  assert.match(view().countdown, /0 phút 10 giây/);
  assert.match(view().detail, /ID: 41/);
  const reading = view({ notice: { ...notice, phase: "reading-json", detail: "Đang đọc JSON." } });
  assert.equal(reading.phase, "Đang lấy JSON");
  assert.equal(reading.countdown, "", "completed AI response should not advertise another reload");
  const scheduled = view({ current: { ...current, prompt_sent_at: undefined, prompt_prepared_at: new Date(now).toISOString(), prompt_scheduled_at: new Date(now + 42000).toISOString() } });
  assert.equal(scheduled.phase, "Prompt đã điền · chờ gửi");
  assert.match(scheduled.countdown, /0 phút 42 giây/);
  const retry = view({ current: { ...current, gemini_spark_json_retry_at: new Date(now + 5000).toISOString(), gemini_spark_json_retry_count: 4, error: "Sai ID bài" } });
  assert.equal(retry.phase, "Chuẩn bị gửi lại bài");
  assert.match(retry.detail, /Lần gửi lại: 4.*\nSai ID bài/);
  assert.match(retry.countdown, /0 phút 05 giây/);
  assert.notEqual(view({ notice: { ...notice, runToken: "old-run", phase: "reading-json" } }).phase, "Đang lấy JSON", "stale run phase must not override the active run");
  assert.equal(view({ current: { ...current, status: "đang cập nhật" } }).phase, "Đang gửi JSON lên website");
});

test("an idle translation worker reports its scoped waiting queue, not another tab's countdown or refill", async () => {
  const popup = loadPopup({ search: "?embedded=1&provider=chatgpt&tabId=33" });
  await popup.functions.resolvePanelContext();
  popup.node("sourceType").value = "translation";
  popup.node("translationType").value = "facility";
  const queued = { id: "tab-33:translation-facility-53", ownerTabId: 33, sourceType: "translation", type: "facility", source_id: 53, status: "chờ", title: "Bản dịch chờ" };
  const worker = { active: true, provider: "chatgpt", targetTabId: 33, sourceType: "translation", translationType: "facility", currentId: null };
  popup.functions.setState({
    items: [queued, { ...queued, id: "tab-44:translation-facility-54", ownerTabId: 44, source_id: 54 },
      { ...queued, id: "tab-33:translation-doctor-55", type: "doctor", source_id: 55 }],
    sourceType: "translation", translationType: "facility",
    runner: { active: true, nextJobAt: Date.now() + 60000, refilling: true, lastError: "Lỗi tab khác", workers: {
      "tab-33": worker,
      "tab-44": { active: true, provider: "grok", targetTabId: 44, refilling: true, nextJobAt: Date.now() + 60000 }
    } }
  });

  popup.functions.render();

  assert.equal(popup.node("queueCount").textContent, "1");
  assert.equal(popup.node("runDetail").textContent, "Có 1 bài chờ · đang tiếp tục hàng đợi");
  assert.equal(popup.node("systemPhase").textContent, "Đang tiếp tục hàng đợi");
  assert.match(popup.node("systemDetail").textContent, /Có 1 bài chờ trên tab này/);
  assert.doesNotMatch(popup.node("systemDetail").textContent, /Lỗi tab khác/);
  assert.equal(popup.node("systemCountdown").textContent, "");
});

test("idle queue status prioritizes its worker's refill, wait reason, and error", async () => {
  const popup = loadPopup({ search: "?embedded=1&provider=chatgpt&tabId=33" });
  await popup.functions.resolvePanelContext();
  popup.node("sourceType").value = "translation";
  const worker = { active: true, provider: "chatgpt", targetTabId: 33, sourceType: "translation", translationType: "facility", currentId: null,
    waitReason: "Bản dịch đang được xử lý trên tab 44.", lastError: "HTTP 503 khi tải bản dịch" };
  const state = { items: [{ id: "translation-facility-53", sourceType: "translation", type: "facility", source_id: 53, status: "chờ" }],
    runner: { active: true, workers: { "tab-33": worker } } };
  popup.functions.setState(state);

  popup.functions.render();
  assert.equal(popup.node("runDetail").textContent, worker.waitReason);
  assert.equal(popup.node("systemPhase").textContent, "Hàng đợi đang tạm chờ");
  assert.match(popup.node("systemDetail").textContent, /Bản dịch đang được xử lý trên tab 44/);
  assert.match(popup.node("systemDetail").textContent, /HTTP 503/);

  worker.refilling = true;
  popup.functions.render();
  assert.equal(popup.node("runCaption").textContent, "Đang tải thêm cho ChatGPT");
  assert.equal(popup.node("systemPhase").textContent, "Đang tải bài tiếp theo");
  worker.refilling = false;
  delete worker.waitReason;
  popup.functions.render();
  assert.equal(popup.node("runDetail").textContent, worker.lastError);
  assert.equal(popup.node("systemPhase").textContent, "Hàng đợi gặp lỗi");
});

test("an inactive blocked translation queue retains only its own scoped wait reason or error", async () => {
  const popup = loadPopup({ search: "?embedded=1&provider=chatgpt&tabId=33" });
  await popup.functions.resolvePanelContext();
  popup.node("sourceType").value = "translation";
  popup.node("translationType").value = "facility";
  const waiting = { id: "tab-33:translation-facility-53", ownerTabId: 33, sourceType: "translation", type: "facility", source_id: 53, status: "chờ" };
  const previous = { ...waiting, id: "tab-33:translation-facility-52", source_id: 52, title: "Bản dịch vừa hoàn tất", status: "hoàn tất" };
  const worker = { active: false, provider: "chatgpt", targetTabId: 33, sourceType: "translation", translationType: "facility", currentId: null,
    waitReason: "Bản dịch này đang được xử lý ở tab 44." };
  popup.functions.setState({ items: [waiting, previous],
    systemNotices: { "tab-33": { articleId: previous.id, history: [] } },
    runner: { active: true, waitReason: "Lý do của runner chung", lastError: "Lỗi của runner chung", workers: {
      "tab-33": worker,
      "tab-44": { active: true, provider: "grok", targetTabId: 44, waitReason: "Lý do của tab khác", lastError: "Lỗi của tab khác" }
    } } });

  popup.functions.render();
  assert.equal(popup.node("runLabel").textContent, "Chạy");
  assert.equal(popup.node("runCaption").textContent, "Hàng đợi đang tạm chờ");
  assert.equal(popup.node("runDetail").textContent, worker.waitReason);
  assert.equal(popup.node("systemPhase").textContent, "Hàng đợi đang tạm chờ");
  assert.equal(popup.node("systemDetail").textContent, worker.waitReason, "old completion must not mask the blocked queue");
  const runner = popup.functions.getState().runner;
  runner.active = false;
  runner.workers["tab-44"].active = false;
  popup.functions.render();
  assert.equal(popup.node("runDetail").textContent, worker.waitReason, "the reason remains when the last worker stops");
  assert.equal(popup.node("systemDetail").textContent, worker.waitReason);

  delete worker.waitReason;
  worker.lastError = "HTTP 503 khi tải bản dịch";
  popup.functions.render();
  assert.equal(popup.node("runDetail").textContent, worker.lastError);
  assert.equal(popup.node("systemPhase").textContent, "Hàng đợi gặp lỗi");
  assert.equal(popup.node("systemDetail").textContent, worker.lastError);

  delete worker.lastError;
  popup.functions.render();
  assert.doesNotMatch(popup.node("runDetail").textContent, /Lý do|Lỗi/);
  assert.doesNotMatch(popup.node("systemDetail").textContent, /Lý do|Lỗi/);

  worker.waitReason = "Chỉ áp dụng cho bản dịch cơ sở";
  popup.node("translationType").value = "doctor";
  popup.functions.render();
  assert.doesNotMatch(popup.node("runDetail").textContent, /Chỉ áp dụng/);
  assert.doesNotMatch(popup.node("systemDetail").textContent, /Chỉ áp dụng/);
  popup.node("sourceType").value = "facility";
  popup.functions.render();
  assert.doesNotMatch(popup.node("runDetail").textContent, /Chỉ áp dụng/);
  assert.doesNotMatch(popup.node("systemDetail").textContent, /Chỉ áp dụng/);
});

test("an idle worker's own scheduled countdown is preserved ahead of a wait reason", async () => {
  const popup = loadPopup({ search: "?embedded=1&provider=chatgpt&tabId=33" });
  await popup.functions.resolvePanelContext();
  const worker = { active: true, provider: "chatgpt", targetTabId: 33, currentId: null,
    nextJobAt: Date.now() + 60000, waitReason: "Lý do chờ cũ" };
  popup.functions.setState({ items: [{ id: "facility-53", facility_id: 53, status: "chờ", title: "Bài kế" }],
    runner: { active: true, workers: { "tab-33": worker } } });

  popup.functions.render();

  assert.match(popup.node("runDetail").textContent, /^Đã tải dữ liệu bài tiếp theo · còn (59|60) giây · Bài kế$/);
  assert.equal(popup.node("systemPhase").textContent, "Đang chuẩn bị bài tiếp theo");
  assert.match(popup.node("systemCountdown").textContent, /Gửi bài tiếp theo sau/);
  assert.doesNotMatch(popup.node("systemDetail").textContent, /Lý do chờ cũ/);
});

test("running article shows its elapsed writing time and keeps counting", async () => {
  const popup = loadPopup({
    search: "?embedded=1&provider=gemini&tabId=33",
    tabContext: { ok: true, tabId: 33, targetTabId: 33, provider: "gemini", supported: true }
  });
  await popup.functions.resolvePanelContext();
  popup.functions.setState({
    sourceType: "facility",
    items: [{ id: "facility-59", facility_id: 59, title: "Nha khoa", status: "đang viết", write_started_at: new Date(Date.now() - 65000).toISOString() }],
    runner: { active: true, workers: { "tab-33": { active: true, provider: "gemini", targetTabId: 33, currentId: "facility-59" } } }
  });
  popup.functions.updateRunButton();

  assert.match(popup.node("runDetail").textContent, /^Đang viết bài · đã 1 phút 5 giây · Nha khoa$/);
  assert.equal(popup.intervals.at(-1).ms, 1000);
});

test("running Spark article shows a retry prompt countdown", async () => {
  const popup = loadPopup({
    search: "?embedded=1&provider=gemini&tabId=33",
    tabContext: { ok: true, tabId: 33, targetTabId: 33, provider: "gemini", supported: true }
  });
  await popup.functions.resolvePanelContext();
  popup.functions.setState({
    sourceType: "facility",
    items: [{
      id: "facility-59", facility_id: 59, title: "Nha khoa", status: "đang viết",
      gemini_spark_json_retry_at: new Date(Date.now() + 5000).toISOString(),
      gemini_spark_json_retry_count: 2
    }],
    runner: { active: true, workers: { "tab-33": { active: true, provider: "gemini", targetTabId: 33, currentId: "facility-59" } } }
  });
  popup.functions.updateRunButton();

  assert.match(popup.node("runDetail").textContent, /^Chuẩn bị gửi lại prompt · lần 2 · còn [45] giây · Nha khoa$/);
  assert.equal(popup.intervals.at(-1).ms, 1000);
});

test("a pre-existing run labels elapsed time as tracking time, not its unknown total duration", async () => {
  const popup = loadPopup({
    search: "?embedded=1&provider=gemini&tabId=33",
    tabContext: { ok: true, tabId: 33, targetTabId: 33, provider: "gemini", supported: true }
  });
  await popup.functions.resolvePanelContext();
  popup.functions.setState({
    sourceType: "facility",
    items: [{ id: "facility-59", facility_id: 59, title: "Nha khoa", status: "đang viết", write_started_at: new Date(Date.now() - 5000).toISOString(), write_timer_backfilled: true }],
    runner: { active: true, workers: { "tab-33": { active: true, provider: "gemini", targetTabId: 33, currentId: "facility-59" } } }
  });
  popup.functions.updateRunButton();

  assert.match(popup.node("runDetail").textContent, /^Đang viết bài · theo dõi 5 giây · Nha khoa$/);
});

test("AI image jobs are disabled on Claude and Gemini, while article sources still run", async () => {
  const rules = loadPopup().functions;
  for (const provider of ["claude", "gemini"]) {
    const popup = loadPopup({
      search: `?embedded=1&provider=${provider}&tabId=33`,
      tabContext: { ok: true, tabId: 33, targetTabId: 33, provider, supported: true },
      respond: async () => ({ ok: true })
    });
    await popup.functions.resolvePanelContext();
    popup.functions.setState({
      sourceType: "ai-image",
      items: [{ id: "ai-image-51", sourceType: "ai-image", facility_id: 51, title: "Cơ sở gallery", prompt: "Tạo ảnh", status: "chờ" }],
      runner: { active: false }
    });
    popup.node("sourceType").value = "ai-image";
    popup.functions.updateRunButton();

    assert.equal(popup.node("runToggle").disabled, true, `${provider} must not start an image job`);
    assert.equal(popup.node("runLabel").textContent, "Không hỗ trợ");
    assert.match(popup.node("runCaption").textContent, new RegExp(`Ảnh AI chưa hỗ trợ trên ${provider === "claude" ? "Claude" : "Gemini"}`));
    assert.match(popup.node("runDetail").textContent, /ChatGPT hoặc Grok/);
    assert.equal(popup.node("providerCapabilityHint").hidden, false);
    assert.match(popup.node("providerCapabilityHint").textContent, /Cơ sở y tế và Toplist/);

    await popup.functions.toggleCurrentTabRun();
    assert.equal(popup.messages.some((message) => message.type === "start-run"), false, "the defensive run guard must also prevent a direct call");

    for (const sourceType of ["facility", "doctor", "toplist"]) {
      popup.node("sourceType").value = sourceType;
      popup.functions.updateRunButton();
      assert.equal(popup.node("runToggle").disabled, false, `${provider} must still run ${sourceType}`);
      assert.equal(popup.node("runLabel").textContent, "Chạy");
      assert.equal(popup.node("providerCapabilityHint").hidden, true);
    }
  }
  assert.equal(rules.canRunSourceOnProvider("ai-image", "chatgpt"), true);
  assert.equal(rules.canRunSourceOnProvider("ai-image", "grok"), true);
  assert.equal(rules.canRunSourceOnProvider("ai-image", "gemini"), false);
  assert.equal(rules.canRunSourceOnProvider("toplist", "gemini"), true);
});

test("initializes all API URL fields with defaults", async () => {
  const popup = loadPopup();
  await popup.init();
  for (const [key, expected] of Object.entries(defaults)) assert.equal(popup.node(key).value, expected);
  assert.equal(popup.node("sourceType").value, "facility");
  const imageListUrl = new URL(popup.node("aiImagesUrl").value);
  assert.equal(imageListUrl.searchParams.get("min_images"), "3");
  assert.equal(imageListUrl.searchParams.get("only_missing"), null, "the documented API default prevents duplicate image creation");
  assert.equal(popup.node("instanceLabel").value, "Máy chưa đặt tên");
  assert.equal(popup.node("accountLabel").value, "AI account chưa đặt tên");
});

test("saves and reloads all ten URLs without changing stored article results", async () => {
  const items = [{ id: "facility-7", facility_id: 7, title: "Cơ sở cũ", prompt: "Prompt", status: "hoàn tất", result: { id: 7, content: "Đầy đủ" } }];
  const popup = loadPopup({ stored: { items } });
  const settings = {
    facilitiesUrl: "https://example.invalid/facilities?page=2",
    updateUrl: "https://example.invalid/facility-update",
    doctorsUrl: "https://example.invalid/doctors?page=3",
    doctorUpdateUrl: "https://example.invalid/doctor-update",
    doctorContentUrl: "https://example.invalid/doctor-content",
    toplistsUrl: "https://example.invalid/toplists?page=3",
    toplistUpdateUrl: "https://example.invalid/toplist-update",
    aiImagesUrl: "https://example.invalid/ai-images?page=3",
    aiImageUpdateUrl: "https://example.invalid/ai-image-update",
    translationUrl: "https://example.invalid/translate"
  };
  for (const [key, value] of Object.entries(settings)) popup.node(key).value = `  ${value}  `;
  popup.node("instanceLabel").value = "  Máy văn phòng  ";
  popup.node("accountLabel").value = "  Gemini content  ";
  await popup.functions.saveSettings();
  const reloaded = loadPopup({ stored: { ...popup.stored, runner: { active: true } } });
  await reloaded.init();
  for (const [key, value] of Object.entries(settings)) assert.equal(reloaded.node(key).value, value);
  assert.equal(reloaded.node("instanceLabel").value, "Máy văn phòng");
  assert.equal(reloaded.node("accountLabel").value, "Gemini content");
  assert.deepEqual(plain(reloaded.functions.getState().items), items);
});

test("blank URL fields save the default endpoints", async () => {
  const popup = loadPopup();
  for (const key of Object.keys(defaults)) popup.node(key).value = "  ";
  await popup.functions.saveSettings();
  assert.deepEqual(popup.stored, { ...defaults, instance_label: "Máy chưa đặt tên", account_label: "AI account chưa đặt tên" });
});

test("remote writer claim is visible in a waiting facility row", () => {
  const popup = loadPopup();
  const status = popup.functions.displayJobStatus({ status: "chờ", writer_claimed: true, writer_claim: {
    provider: "gemini", instance_label: "Máy văn phòng", account_label: "Gemini content"
  } });
  assert.equal(status, "đang viết · Gemini · Máy văn phòng · Gemini content");
});

test("Toplist loading asks the background to refresh and preserves its merged queue", async () => {
  const legacy = { id: "facility-7", facility_id: 7, title: "Cơ sở", prompt: "Cơ sở", status: "chờ" };
  const toplist = { id: "toplist-7", sourceType: "toplist", toplist_id: 7, title: "Toplist mới", prompt: "Prompt API nguyên bản\n", status: "chờ" };
  const popup = loadPopup({ respond: async () => ({ ok: true, items: [legacy, toplist], added: 1, skipped: 0 }) });
  popup.functions.setState({ items: [legacy], runner: { active: false } });
  popup.node("sourceType").value = "toplist";
  await popup.functions.loadArticles();
  assert.deepEqual(popup.messages, [{ type: "refresh-queue", sourceType: "toplist", targetTabId: null }]);
  assert.deepEqual(plain(popup.functions.getState().items[0]), legacy);
  assert.equal(popup.functions.getState().items[1].id, "toplist-7");
  assert.equal(popup.functions.getState().items[1].prompt, "Prompt API nguyên bản\n");
  assert.equal(popup.node("sourceType").disabled, false);
  assert.equal(popup.node("refresh").disabled, false);
});

test("translation list request carries only the selected translation type", async () => {
  const popup = loadPopup({ respond: async () => ({ ok: true, items: [], added: 0, skipped: 0 }) });
  popup.functions.setState({ items: [], runner: { active: false }, sourceType: "translation", translationType: "doctor" });
  popup.node("sourceType").value = "translation";
  popup.node("translationType").value = "doctor";
  await popup.functions.loadArticles();
  assert.deepEqual(popup.messages.at(-1), { type: "refresh-queue", sourceType: "translation", translationType: "doctor", targetTabId: null });
});

test("translation run request carries the selected type for this tab", async () => {
  const popup = loadPopup({
    search: "?embedded=1&provider=gemini&tabId=33",
    tabContext: { ok: true, tabId: 33, targetTabId: 33, provider: "gemini", supported: true },
    respond: async () => ({ ok: true })
  });
  await popup.functions.resolvePanelContext();
  popup.functions.setState({ items: [], runner: { active: false }, sourceType: "translation", translationType: "toplist" });
  popup.node("sourceType").value = "translation";
  popup.node("translationType").value = "toplist";
  await popup.functions.toggleCurrentTabRun();
  assert.deepEqual(popup.messages.at(-1), { type: "start-run", targetTabId: 33, provider: "gemini", sourceType: "translation", translationType: "toplist" });
});

test("restores the selected Toplist source after reload", async () => {
  const popup = loadPopup({ stored: { sourceType: "toplist" }, respond: async () => ({ ok: true, items: [], added: 0, skipped: 0 }) });
  await popup.init();
  assert.equal(popup.node("sourceType").value, "toplist");
  assert.deepEqual(popup.messages, [
    { type: "get-tab-context" },
    { type: "reconcile-api-status" },
    { type: "refresh-queue", sourceType: "toplist", targetTabId: 33 }
  ]);
});

test("popup migrates per-tab legacy Toplist URLs and keeps custom settings", async () => {
  const other = { toplistsUrl: "https://example.invalid/other", account_label: "Tab khác" };
  const popup = loadPopup({ stored: {
    "tab-api-settings:33": { toplistsUrl: "https://medreview.vn/api/medical/toplists-needing-facilities.php?page=4&entity_type=doctor", toplistUpdateUrl: "https://top.top/api/medical/toplist-facilities-update.php", doctorUpdateUrl: "https://example.invalid/custom-doctor", account_label: "Máy của tao" },
    "tab-api-settings:44": other
  } });
  await popup.init();
  assert.equal(popup.node("toplistsUrl").value, "https://medreview.vn/api/medical/toplists-needing-members.php?page=4&entity_type=doctor");
  assert.equal(popup.node("toplistUpdateUrl").value, defaults.toplistUpdateUrl);
  assert.equal(popup.stored["tab-api-settings:33"].doctorUpdateUrl, "https://example.invalid/custom-doctor");
  assert.equal(popup.stored["tab-api-settings:33"].account_label, "Máy của tao");
  assert.deepEqual(popup.stored["tab-api-settings:44"], other);
});

test("waiting Toplist refresh updates entity type and dedicated prompt, not completed history", () => {
  const incoming = { id: 132, entity_type: "doctor", prompt: "Prompt danh sách bác sĩ mới", prompt_key_used: "toplist_doctor", output_template: { doctors: [] }, receive_endpoint: "/api/medical/toplist-members-update.php" };
  const waiting = { id: "toplist-132", toplist_id: 132, sourceType: "toplist", status: "chờ", prompt: "Prompt cũ" };
  const updated = loadPopup().functions.mergeApiArticles([plain(waiting)], [incoming], "toplist").items[0];
  assert.equal(updated.entity_type, "doctor");
  assert.equal(updated.prompt, incoming.prompt);
  assert.equal(updated.prompt_key_used, "toplist_doctor");
  const done = { ...waiting, status: "hoàn tất", prompt: "Giữ lịch sử" };
  const history = loadPopup().functions.mergeApiArticles([done], [incoming], "toplist").items[0];
  assert.equal(history.prompt, "Giữ lịch sử");
  assert.equal(history.entity_type, undefined);
});

test("Gemini and ChatGPT panels restore independent tab memories and Run/Stop controls", async () => {
  const a = { id: "tab-33:facility-7", ownerTabId: 33, sourceType: "facility", facility_id: 7, title: "Viết ở Gemini", status: "đang viết" };
  const b = { id: "tab-44:translation-facility-7", ownerTabId: 44, sourceType: "translation", type: "facility", source_id: 7, title: "Dịch ở ChatGPT", status: "đang viết" };
  const stored = { items: [a, b], sourceType: "toplist", runner: { active: true, sourceType: "toplist", workers: {
    "tab-33": { active: true, targetTabId: 33, provider: "gemini", sourceType: "facility", currentId: a.id },
    "tab-44": { active: true, targetTabId: 44, provider: "chatgpt", sourceType: "translation", translationType: "facility", currentId: b.id }
  } }, "tab-job-items:33": [a], "tab-job-items:44": [b],
  "tab-task-source:33": { sourceType: "facility" }, "tab-task-source:44": { sourceType: "translation", translationType: "facility" } };
  const gemini = loadPopup({ stored, search: "?tabId=33&provider=gemini", tabContext: { ok: true, tabId: 33, provider: "gemini" }, respond: async () => ({ ok: true }) });
  const chatgpt = loadPopup({ stored, search: "?tabId=44&provider=chatgpt", tabContext: { ok: true, tabId: 44, provider: "chatgpt" }, respond: async () => ({ ok: true }) });
  await Promise.all([gemini.init(), chatgpt.init()]);
  assert.deepEqual(plain(gemini.functions.getState().items), [a]);
  assert.deepEqual(plain(chatgpt.functions.getState().items), [b]);
  assert.equal(gemini.node("sourceType").value, "facility");
  assert.equal(chatgpt.node("sourceType").value, "translation");
  assert.equal(chatgpt.node("runLabel").textContent, "Dừng");
  const geminiQueue = gemini.node("items").children[0];
  gemini.emitChanges({ items: { newValue: [b] }, "tab-job-items:44": { newValue: [] }, "tab-task-source:44": { newValue: { sourceType: "ai-image" } } });
  assert.deepEqual(plain(gemini.functions.getState().items), [a], "other namespaces never enter this panel's memory");
  assert.equal(gemini.node("items").children[0], geminiQueue, "other queue writes do not rebuild this tab's DOM");
  assert.equal(gemini.node("sourceType").value, "facility");
  await chatgpt.node("runToggle").click();
  assert.deepEqual(chatgpt.messages.at(-1), { type: "stop-run", targetTabId: 44, provider: "chatgpt" });
  assert.equal(chatgpt.node("runLabel").textContent, "Chạy");
  assert.equal(chatgpt.node("sourceType").disabled, false, "another running source must not lock this tab's selector");
  assert.equal(gemini.node("runLabel").textContent, "Dừng");
  assert.equal(chatgpt.functions.getState().runner.workers["tab-33"].active, true);
});

test("changing a source, clearing its queue and saving settings write only this tab's namespace", async () => {
  const old = { id: "tab-44:facility-7", ownerTabId: 44, sourceType: "facility", facility_id: 7, prompt: "P", status: "chờ" };
  const fetched = { id: "tab-44:toplist-9", ownerTabId: 44, sourceType: "toplist", toplist_id: 9, prompt: "Top", status: "chờ" };
  const other = { id: "tab-33:facility-8", ownerTabId: 33, facility_id: 8, status: "chờ" };
  const popup = loadPopup({ search: "?tabId=44&provider=chatgpt", tabContext: { ok: true, tabId: 44, provider: "chatgpt" },
    stored: { items: [old, other], "tab-job-items:44": [old], "tab-job-items:33": [other], runner: { active: false },
      "tab-task-source:44": { sourceType: "facility" }, "tab-task-source:33": { sourceType: "translation" },
      "tab-api-settings:33": { updateUrl: "https://example.invalid/other-update" },
      "tab-api-settings:44": { writerClaimUrl: "https://example.invalid/own-claim", updateUrl: "https://example.invalid/own-update" } },
    respond: async (message) => message.type === "refresh-queue" ? { ok: true, items: [old, fetched, other], added: 1 } : { ok: true }
  });
  await popup.init();
  assert.equal(popup.node("updateUrl").value, "https://example.invalid/own-update");
  popup.node("sourceType").value = "toplist";
  await popup.node("sourceType").onchange();
  assert.equal(popup.stored["tab-task-source:44"].sourceType, "toplist");
  assert.equal(popup.stored["tab-task-source:33"].sourceType, "translation");
  assert.deepEqual(plain(popup.functions.getState().items), [old, fetched]);
  assert.equal(popup.messages.at(-1).targetTabId, 44);
  await popup.node("clear").click();
  const clearing = popup.messages.at(-1);
  assert.equal(clearing.targetTabId, 44);
  assert.deepEqual(clearing.removeArticleIds, [fetched.id]);
  assert.deepEqual(plain(popup.functions.getState().items), [old], "other sources in the same tab remain in memory");
  assert.deepEqual(popup.stored["tab-job-items:33"], [other]);
  popup.node("updateUrl").value = "https://example.invalid/changed-own-update";
  await popup.functions.saveSettings();
  assert.equal(popup.stored["tab-api-settings:44"].updateUrl, "https://example.invalid/changed-own-update");
  assert.equal(popup.stored["tab-api-settings:44"].writerClaimUrl, "https://example.invalid/own-claim");
  assert.equal(popup.stored["tab-api-settings:33"].updateUrl, "https://example.invalid/other-update");
  assert.equal(popup.writes.some((write) => Object.hasOwn(write, "updateUrl") || Object.hasOwn(write, "sourceType")), false);
});

test("completed jobs leave the queue but remain available in results and API history", () => {
  const popup = loadPopup();
  popup.functions.setState({
    runner: { active: false },
    items: [
      {
        id: "facility-7", facility_id: 7, title: "Đã xong", prompt: "Prompt 7", status: "hoàn tất",
        result: { id: 7, content: "Đầy đủ" }, api_update: { ok: true, updated_count: 1 }
      },
      { id: "facility-8", facility_id: 8, title: "Đang chờ", prompt: "Prompt 8", status: "chờ" },
      {
        id: "toplist-9", sourceType: "toplist", toplist_id: 9, title: "Lỗi API", prompt: "Prompt 9",
        status: "lỗi cập nhật", result: { toplist_id: 9, facilities: [{ id: 7 }] }, api_error: "HTTP 500"
      }
    ]
  });

  popup.functions.render();

  assert.equal(popup.node("queueCount").textContent, "1", "only this selected source's unfinished jobs are visible");
  assert.equal(popup.node("items").children.length, 1, "completed rows and other sources are hidden from the working queue");
  assert.equal(popup.node("resultCount").textContent, "1", "this source's saved JSON remains in result history");
  assert.equal(popup.node("results").children.length, 1);
  assert.equal(popup.node("apiCount").textContent, "1", "this source's completed sends remain in API history");
  assert.equal(popup.node("apiStatus").children.length, 1);
  assert.equal(popup.functions.getState().items.length, 3, "hiding a row must not erase its retry/result record");
  popup.node("sourceType").value = "toplist";
  popup.functions.render();
  assert.equal(popup.node("items").children.length, 1);
  assert.equal(popup.node("resultCount").textContent, "1", "switching back to a source restores its saved result");
  assert.equal(popup.node("apiStatus").children.length, 1);
});

test("an uncertain API send remains visible, keeps its JSON result and offers a retry", () => {
  const popup = loadPopup();
  popup.functions.setState({
    runner: { active: false },
    items: [{
      id: "facility-59", facility_id: 59, title: "Nha khoa", status: "chưa xác nhận",
      api_error: "Yêu cầu có thể đã tới server.", result: { id: 59, content: "JSON đã lưu" }
    }]
  });

  popup.functions.render();
  assert.equal(popup.node("resultCount").textContent, "1");
  assert.equal(popup.node("apiCount").textContent, "1");
  assert.match(popup.node("apiStatus").children[0].innerHTML, /uncertain/);
  assert.match(popup.node("apiStatus").children[0].innerHTML, /\?/);
  assert.match(popup.node("apiStatus").children[0].innerHTML, /Gửi lại/);
  assert.deepEqual(plain(popup.functions.getState().items[0].result), { id: 59, content: "JSON đã lưu" });
});

test("deleting a visible row removes that item after completed rows were filtered out", async () => {
  const popup = loadPopup();
  popup.functions.setState({
    runner: { active: false },
    items: [
      { id: "facility-1", facility_id: 1, title: "Lịch sử", prompt: "P1", status: "hoàn tất", result: { id: 1 } },
      { id: "facility-2", facility_id: 2, title: "Xoá bài này", prompt: "P2", status: "chờ" },
      { id: "facility-3", facility_id: 3, title: "Giữ bài này", prompt: "P3", status: "chờ" }
    ]
  });
  popup.functions.render();

  const firstVisible = popup.node("items").children[0];
  await firstVisible.querySelector(".delete-item").click();

  assert.deepEqual(plain(popup.functions.getState().items.map((item) => item.id)), ["facility-1", "facility-3"]);
  assert.deepEqual(plain(popup.stored.items.map((item) => item.id)), ["facility-1", "facility-3"]);
  assert.equal(popup.node("queueCount").textContent, "1");
});
