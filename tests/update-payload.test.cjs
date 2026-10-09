const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBackground() {
  const calls = [];
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    chrome: {
      runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
      storage: { local: { get: async () => ({ updateUrl: "https://example.invalid/update" }) } }
    },
    AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => '{"ok":true,"updated_ids":[59],"errors":[]}' };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8") +
    "\nglobalThis.testApi = { buildUpdatePayload, updateFacilityContent };", context);
  return { ...context.testApi, calls };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const article = { id: 59, content: "<p>Đầy đủ</p>", reviews: [{ name: "An", rating: 5 }], future: { enabled: true } };

test("forwards every article field in the API items envelope", () => {
  const api = loadBackground();
  assert.deepEqual(plain(api.buildUpdatePayload({ facility_id: 59 }, article)), { items: [article] });
});

test("preserves root arrays and wrapped JSON including wrapper metadata", () => {
  const api = loadBackground();
  assert.deepEqual(plain(api.buildUpdatePayload({ facility_id: 59 }, [article])), { items: [article] });
  const wrapped = { items: [article], schema_version: 2, extra: { source: "AI" } };
  assert.deepEqual(plain(api.buildUpdatePayload({ facility_id: 59 }, wrapped)), wrapped);
});

test("fills only a missing ID and does not mutate the saved JSON", () => {
  const api = loadBackground();
  const data = { reviews: [], custom: "giữ nguyên" };
  assert.deepEqual(plain(api.buildUpdatePayload({ facility_id: 59 }, data)), { items: [{ ...data, id: 59 }] });
  assert.equal(Object.hasOwn(data, "id"), false);
  assert.equal(api.buildUpdatePayload({ facility_id: 59 }, { ...article, id: "59" }).items[0].id, "59");
});

test("invalid containers and mismatching facility IDs never reach fetch", async () => {
  const api = loadBackground();
  for (const data of [null, "not JSON", [], [1], { ...article, id: 60 }, [article, { id: 60 }]]) {
    await assert.rejects(api.updateFacilityContent({ facility_id: 59 }, data));
  }
  assert.equal(api.calls.length, 0);
});

test("old text fallbacks cannot be resent as completed JSON", async () => {
  const api = loadBackground();
  const rawResponse = 'JSON\n{"id": :contentReference[oaicite:0]{index=0}';
  await assert.rejects(api.updateFacilityContent({ facility_id: 59, rawResponse }, {
    title: "Dana Dental", content: rawResponse, format: "text"
  }), /đọc lỗi/);
  assert.equal(api.calls.length, 0);
});

test("mocked POST contains complete JSON with reviews and future fields", async () => {
  const api = loadBackground();
  await api.updateFacilityContent({ facility_id: 59 }, article);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].url, "https://example.invalid/update");
  assert.equal(api.calls[0].options.method, "POST");
  assert.equal("signal" in api.calls[0].options, false, "website updates must not be aborted by a client-side timeout");
  assert.deepEqual(JSON.parse(api.calls[0].options.body), { items: [article] });
});
