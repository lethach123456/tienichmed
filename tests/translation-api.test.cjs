const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const DEFAULT_TRANSLATION_URL = "https://medreview.vn/api/medical/translate-content.php";
const template = { subtitle_en: "", content_en: "" };
const source = { id: 53, name: "Nha khoa A", address: "12 Nguyễn Huệ", gallery_json: [{ url: "/uploads/clinic.jpg", caption: "Mặt tiền" }] };
const translationItem = {
  id: "translation-facility-53", sourceType: "translation", type: "facility", translation_type: "facility",
  source_id: 53, title: "Nha khoa A", prompt: "Dịch theo yêu cầu API",
  source, translation_fields: ["subtitle_en", "content_en"], output_template: template,
  status: "đang viết"
};
const translated = { subtitle_en: "Dental clinic", content_en: "<p>English article</p>" };
const translationEnvelope = { type: "facility", source_id: 53, translated };

function loadBackground(initial = {}, responseOverride) {
  const state = plain(initial);
  const calls = [];
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    chrome: {
      runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
      storage: { local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : keys == null ? Object.keys(state) : [keys];
          return plain(Object.fromEntries(list.filter((key) => key in state).map((key) => [key, state[key]])));
        },
        async set(values) { Object.assign(state, plain(values)); }
      } }
    },
    URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options: plain(options) });
      const data = options.method === "POST"
        ? { ok: true, translation_id: 901, slug: "nha-khoa-a-en", status: "draft", saved_fields: Object.keys(JSON.parse(options.body).items[0].translated) }
        : { ok: true, items: [translationItem] };
      return responseOverride ? responseOverride(url, options, data) : {
        ok: true, status: 200, text: async () => JSON.stringify(data)
      };
    }
  });
  const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8") + `
    globalThis.__translationTests = {
      fetchTranslations, refreshQueue, mergeQueueItems, queueItemMatchesRunner,
      buildTranslationPayload, updateTranslation, finishJob, retryUpdate
    };
  `;
  vm.runInContext(source, context, { filename: "background.js" });
  return { ...context.__translationTests, state, calls };
}

test("translation GET requests selected type/page/limit with the configured endpoint and API key", async () => {
  const api = loadBackground();
  await api.fetchTranslations("doctor");
  const request = api.calls[0];
  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, DEFAULT_TRANSLATION_URL);
  assert.equal(url.searchParams.get("type"), "doctor");
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("limit"), "1");
  assert.deepEqual(plain(request.options.headers), { "X-Medical-Api-Key": "test-medical-key", Accept: "application/json" });
});

test("translation GET reports HTTP status and API error body", async () => {
  const api = loadBackground({}, () => ({ ok: false, status: 503, text: async () => JSON.stringify({ message: "maintenance" }) }));
  await assert.rejects(api.fetchTranslations("facility"), /503: maintenance/);
});

test("translation merge stores API prompt, schema, type, and source ID in separate per-type queue entries", () => {
  const api = loadBackground();
  const facility = api.mergeQueueItems([], [{ ...translationItem, id: 100, source_id: 53 }], "translation", "facility");
  const doctor = api.mergeQueueItems(facility.items, [{ ...translationItem, id: 101, type: "doctor", source_id: 53, title: "Bác sĩ A" }], "translation", "doctor");
  assert.deepEqual(plain(doctor.items.map((item) => item.id)), ["translation-facility-53", "translation-doctor-53"]);
  assert.equal(doctor.items[0].type, "facility");
  assert.equal(doctor.items[0].source_id, 53);
  assert.equal(doctor.items[0].prompt, "Dịch theo yêu cầu API");
  assert.deepEqual(plain(doctor.items[0].source), source, "the complete Vietnamese DB source stays attached to the queue record");
  assert.equal(doctor.items[1].type, "doctor");
  assert.equal(api.queueItemMatchesRunner(doctor.items[0], { sourceType: "translation", translationType: "facility" }), true);
  assert.equal(api.queueItemMatchesRunner(doctor.items[1], { sourceType: "translation", translationType: "facility" }), false);
});

test("translation POST sends only allowed translated fields and keeps type/source_id outside the AI JSON", async () => {
  const api = loadBackground({ translationUrl: DEFAULT_TRANSLATION_URL });
  const result = await api.updateTranslation(translationItem, translationEnvelope);
  assert.equal(result.translation_id, 901);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].url, DEFAULT_TRANSLATION_URL);
  assert.equal(api.calls[0].options.method, "POST");
  assert.deepEqual(plain(api.calls[0].options.headers), {
    "Content-Type": "application/json", "X-Medical-Api-Key": "test-medical-key", Accept: "application/json"
  });
  assert.deepEqual(JSON.parse(api.calls[0].options.body), {
    type: "facility", items: [{ source_id: 53, translated }]
  });
});

test("translation fields are restricted to the overlap and envelope metadata must match the queued source", () => {
  const api = loadBackground();
  const item = { ...translationItem, translation_fields: ["subtitle_en", "content_en", "not_in_template"] };
  assert.deepEqual(plain(api.buildTranslationPayload(item, translationEnvelope)), {
    type: "facility", items: [{ source_id: 53, translated }]
  });
  assert.throws(() => api.buildTranslationPayload(item, { ...translationEnvelope, translated: { ...translated, not_in_template: "extra" } }), /ngoài output_template\/translation_fields/);
  assert.throws(() => api.buildTranslationPayload(item, { ...translationEnvelope, translated: { subtitle_en: "Only one" } }), /thiếu 1 trường/);
  assert.throws(() => api.buildTranslationPayload(item, { ...translationEnvelope, source_id: 99 }), /sai source_id/);
  assert.throws(() => api.buildTranslationPayload(item, { ...translationEnvelope, type: "doctor" }), /sai type/);
  assert.throws(() => api.buildTranslationPayload(item, translated), /envelope \{type, source_id, translated\}/);
  assert.throws(() => api.buildTranslationPayload({ ...item, source_id: undefined }, translationEnvelope), /thiếu source_id/);
  assert.throws(() => api.buildTranslationPayload({ ...item, output_template: null, translation_fields: null }, translationEnvelope), /thiếu translation_fields\/output_template/);
});

test("article completion and retry both use the translation endpoint, never facility update", async () => {
  const retryItem = { ...translationItem, status: "hoàn tất", result: translationEnvelope };
  const api = loadBackground({
    sourceType: "facility",
    translationUrl: DEFAULT_TRANSLATION_URL,
    updateUrl: "https://example.invalid/facility-update",
    items: [retryItem]
  });
  await api.retryUpdate(translationItem.id);
  assert.equal(api.calls[0].url, DEFAULT_TRANSLATION_URL);
  assert.deepEqual(JSON.parse(api.calls[0].options.body), { type: "facility", items: [{ source_id: 53, translated }] });

  const fresh = loadBackground({ translationUrl: DEFAULT_TRANSLATION_URL, items: [{ ...translationItem }] });
  await fresh.finishJob(translationItem.id, translationEnvelope, JSON.stringify(translationEnvelope));
  assert.equal(fresh.calls[0].url, DEFAULT_TRANSLATION_URL);
  assert.equal(fresh.state.items[0].status, "hoàn tất");
  assert.deepEqual(plain(fresh.state["article-content:" + translationItem.id].result), translationEnvelope);
  assert.equal(fresh.state.items[0].api_update.translation_id, 901);
});

test("translation server errors preserve the JSON and expose HTTP diagnostics", async () => {
  const api = loadBackground({ items: [{ ...translationItem }] }, () => ({
    ok: false, status: 422, text: async () => JSON.stringify({ ok: false, message: "unknown source_id" })
  }));
  await api.finishJob(translationItem.id, translationEnvelope, JSON.stringify(translationEnvelope));
  assert.equal(api.state.items[0].status, "lỗi cập nhật");
  assert.match(api.state.items[0].api_error, /422: unknown source_id/);
  assert.deepEqual(plain(api.state["article-content:" + translationItem.id].result), translationEnvelope);
});
