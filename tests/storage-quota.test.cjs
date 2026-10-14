const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const TEN_MIB = 10 * 1024 * 1024;
const CONTENT_KEY = "article-content:tab-101:doctor-12";
const DOCTOR_STATE_KEY = "tab-doctor-queue:101";
const quotaError = () => new Error("Resource::kQuotaBytes quota exceeded");
const storageBytes = (values) => Object.entries(values).reduce((sum, [key, value]) =>
  sum + Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)), 0);

function savedJob(extra = {}) {
  return { id: "tab-101:doctor-12", doctor_id: 12, sourceType: "doctor", ownerTabId: 101,
    title: "Bác sĩ mẫu", status: "lỗi cập nhật", content_version: 1, has_result: true, ...extra };
}

function savedContent(extra = {}) {
  return { prompt: "Prompt riêng của bác sĩ", result: { id: 12, content: "JSON chưa gửi thành công" },
    rawResponse: '{ "id": 12, "content": "JSON chưa gửi thành công" }',
    image_fix_payload: '{ "items": [{ "id": 12, "receipt": "giữ nguyên byte" }] }', ...extra };
}

function loadBackground(initial = {}, options = {}) {
  const state = plain({ items: [], ...initial });
  const fetchCalls = [], writeAttempts = [], removals = [];
  const config = { quota: options.quota ?? TEN_MIB, unlimited: options.unlimited ?? false,
    failWrite: options.failWrite };
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: {
      async get(keys) {
        const wanted = keys == null ? Object.keys(state) : Array.isArray(keys) ? keys : [keys];
        return plain(Object.fromEntries(wanted.filter((key) => key in state).map((key) => [key, state[key]])));
      },
      async set(values) {
        writeAttempts.push(plain(values));
        if (config.failWrite?.(values, state) || !config.unlimited && storageBytes({ ...state, ...values }) > config.quota) {
          throw quotaError();
        }
        // Chrome's failed set must not partially mutate the persisted snapshot.
        Object.assign(state, plain(values));
      },
      async remove(keys) {
        const values = Array.isArray(keys) ? keys : [keys];
        removals.push(...values);
        for (const key of values) delete state[key];
      }
    } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } }
  };
  const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
  const startup = "initializeExtensionStorage().then(restoreNextJobAlarms).catch(() => {});";
  assert.ok(source.includes(startup), "the harness only suppresses automatic startup migration, never business logic");
  const context = vm.createContext({ chrome, URL, AbortController, setTimeout, clearTimeout, structuredClone,
    MEDREVIEW_MEDICAL_API_KEY: "test-only-not-a-live-key",
    fetch: async (url, request = {}) => {
      fetchCalls.push({ url: String(url), method: request.method || "GET" });
      const response = options.response ?? { status: 200, body: { ok: true, items: [] } };
      return { ok: response.status >= 200 && response.status < 300, status: response.status,
        async text() { return JSON.stringify(response.body); } };
    }
  });
  vm.runInContext(source.replace(startup, "void 0;") + `
    globalThis.__storageQuotaTests = {
      jobStorage, hydrateArticle, writeJobStorage, extensionErrorResponse,
      isStorageQuotaError, doctorQueueStateFromError, fetchDoctors, stageArticleResult, finishJob, refreshQueue
    };
  `, context, { filename: "background.js" });
  return { ...context.__storageQuotaTests, state, config, fetchCalls, writeAttempts, removals };
}

test("manifest removes the local-storage quota without changing the extension's existing storage area", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
  const background = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
  assert.match(background, /const RAW_JOB_STORAGE = chrome\.storage\.local;/);
});

test("unlimited storage retains over 10 MiB of JSON, raw response and a byte-identical replay receipt", async () => {
  const result = { id: 12, content: "x".repeat(6 * 1024 * 1024), caption: "Ảnh mặt tiền" };
  const rawResponse = JSON.stringify(result);
  const receipt = '{ "items": [{ "id": 12, "notes": "giữ đúng byte – không đổi" }] }';
  const api = loadBackground({ items: [savedJob({ status: "đang viết" })],
    [CONTENT_KEY]: savedContent({ image_fix_payload: receipt }) }, { unlimited: true });
  const staged = await api.stageArticleResult("tab-101:doctor-12", result, rawResponse);
  assert.equal(staged.accepted, true);
  assert.ok(storageBytes(api.state) > TEN_MIB, "fixture genuinely crosses the former limit");
  const stored = await api.hydrateArticle(api.state.items[0]);
  assert.deepEqual(plain(stored.result), result);
  assert.equal(stored.rawResponse, rawResponse);
  assert.equal(stored.image_fix_payload, receipt);
  assert.equal(api.fetchCalls.length, 0);
  assert.equal(api.removals.length, 0);
});

test("a quota rejection keeps all existing unsent JSON and reports storage instead of API", async () => {
  const initial = { items: [savedJob()], [CONTENT_KEY]: savedContent() };
  const api = loadBackground(initial, { quota: storageBytes(initial) + 1 });
  const before = plain(api.state);
  await assert.rejects(api.writeJobStorage({ extra: "x".repeat(1024) }), (error) => {
    assert.equal(error.code, "storage_quota_exceeded");
    assert.equal(error.storageError, true);
    assert.match(error.message, /không phải lỗi API/);
    const response = api.extensionErrorResponse(error);
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, "storage_quota_exceeded");
    assert.equal(response.storageError, true);
    assert.equal(response.queueState.schemaUnavailable, false);
    assert.equal(response.queueState.httpStatus, null);
    assert.equal(response.doctorQueueError, undefined);
    assert.match(response.queueState.help, /Không gỡ tiện ích hoặc xóa dữ liệu/);
    return true;
  });
  assert.deepEqual(api.state, before);
  assert.deepEqual(api.removals, []);
});

test("a failed result staging write never POSTs to the website and preserves the previous pending result", async () => {
  const initial = { items: [savedJob({ status: "đang viết" })], [CONTENT_KEY]: savedContent() };
  const api = loadBackground(initial, { quota: storageBytes(initial) + 100 });
  const before = plain(api.state);
  const replacement = { id: 12, content: "x".repeat(2048) };
  await assert.rejects(api.finishJob("tab-101:doctor-12", replacement, JSON.stringify(replacement)),
    (error) => error.storageError === true);
  assert.deepEqual(api.state, before);
  assert.equal(api.fetchCalls.filter((call) => call.method === "POST").length, 0);
  assert.equal(api.fetchCalls.length, 0);
  assert.deepEqual(api.removals, []);
});

test("quota while saving doctor loading state is storage failure, not a doctor API failure", async () => {
  const api = loadBackground({ items: [savedJob()], [CONTENT_KEY]: savedContent() }, {
    failWrite: (values) => values[DOCTOR_STATE_KEY]?.status === "loading"
  });
  await assert.rejects(api.fetchDoctors([], 101), (error) => {
    assert.equal(error.storageError, true);
    assert.equal(error.doctorQueueError, false);
    assert.equal(error.queueState.storageError, true);
    assert.equal(error.queueState.httpStatus, null);
    assert.equal(error.queueState.schemaUnavailable, false);
    return true;
  });
  assert.equal(api.fetchCalls.length, 0, "do not contact the website if loading state cannot be stored");
  assert.deepEqual(api.state[CONTENT_KEY], savedContent());
});

test("quota while saving a successful doctor response remains a storage failure", async () => {
  const api = loadBackground({ items: [savedJob()], [CONTENT_KEY]: savedContent() }, {
    failWrite: (values) => values[DOCTOR_STATE_KEY]?.status === "ready"
  });
  await assert.rejects(api.fetchDoctors([], 101), (error) => {
    assert.equal(error.storageError, true);
    assert.equal(error.doctorQueueError, false);
    assert.equal(error.queueState.storageError, true);
    assert.equal(error.queueState.httpStatus, null);
    return true;
  });
  assert.equal(api.fetchCalls.length, 1);
  assert.deepEqual(api.state[CONTENT_KEY], savedContent());
  assert.equal(api.state[DOCTOR_STATE_KEY].storageError, true);
});

test("full storage while reporting HTTP 503 does not mask the website's original HTTP error", async () => {
  const api = loadBackground({ items: [savedJob()], [CONTENT_KEY]: savedContent() }, {
    response: { status: 503, body: { ok: false, message: "Schema chưa sẵn sàng" } },
    failWrite: (values) => values[DOCTOR_STATE_KEY]?.status === "error"
  });
  await assert.rejects(api.fetchDoctors([], 101), (error) => {
    assert.match(error.message, /HTTP 503: Schema chưa sẵn sàng/);
    assert.equal(error.httpStatus, 503);
    assert.equal(error.storageError, undefined);
    assert.equal(error.doctorQueueError, true);
    assert.equal(error.queueState.httpStatus, 503);
    assert.equal(error.queueState.schemaUnavailable, true);
    const response = api.extensionErrorResponse(error);
    assert.equal(response.httpStatus, 503);
    assert.equal(response.doctorQueueError, true);
    assert.equal(response.storageError, undefined);
    return true;
  });
  assert.deepEqual(api.state[CONTENT_KEY], savedContent());
});

test("quota while committing a queue/index update never deletes old payloads", async () => {
  const initial = { items: [savedJob()], [CONTENT_KEY]: savedContent(),
    "tab-job-items:101": [savedJob()] };
  const api = loadBackground(initial, { failWrite: (values) => Object.hasOwn(values, "items") });
  const before = plain(api.state);
  await assert.rejects(api.jobStorage.set({ items: [] }), (error) => error.storageError === true);
  assert.deepEqual(api.state, before);
  assert.deepEqual(api.removals, [], "remove must only happen after a successful metadata commit");
});

test("quota after a doctor list GET but before queue commit retains old unsent JSON", async () => {
  const initial = { items: [savedJob()], [CONTENT_KEY]: savedContent() };
  const api = loadBackground(initial, {
    response: { status: 200, body: { ok: true, items: [{ id: 13, name: "Bác sĩ mới", type: "doctor",
      needs_content: true, status: "published", language_code: "vi", content: null, last_researched_at: null,
      prompt: "Prompt mới", output_template: { id: 13, name: "Bác sĩ mới", content: null, insufficient_data: true } }] } },
    failWrite: (values) => Object.hasOwn(values, "items")
  });
  await assert.rejects(api.refreshQueue("doctor", null, 101), (error) => {
    const response = api.extensionErrorResponse(error);
    assert.equal(response.storageError, true);
    assert.equal(response.doctorQueueError, undefined);
    return true;
  });
  assert.deepEqual(api.state.items, initial.items);
  assert.deepEqual(api.state[CONTENT_KEY], initial[CONTENT_KEY]);
  assert.equal(api.fetchCalls.length, 1);
  assert.deepEqual(api.removals, []);
});

test("quota classification accepts Chrome variants but does not classify ordinary HTTP/server errors", () => {
  const api = loadBackground();
  for (const error of [quotaError(), new Error("QUOTA_BYTES exceeded"),
    { code: "storage_quota_exceeded" }, { storageError: true }]) {
    assert.equal(api.isStorageQuotaError(error), true);
    assert.equal(api.doctorQueueStateFromError(error).storageError, true);
  }
  for (const error of [new Error("API HTTP 503"), new Error("Failed to fetch"),
    { message: "API request limit", httpStatus: 429 }, { message: "API HTTP 429: quota exceeded", httpStatus: 429 }]) {
    assert.equal(api.isStorageQuotaError(error), false);
  }
});
