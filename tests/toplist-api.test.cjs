const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = (value) => JSON.parse(JSON.stringify(value));
const defaultUrls = {
  facilitiesUrl: "https://medreview.vn/api/medical/facilities-needing-content.php?page=1&limit=1&type=facility",
  updateUrl: "https://medreview.vn/api/medical/facility-content-update.php",
  toplistsUrl: "https://medreview.vn/api/medical/toplists-needing-members.php?page=1&limit=1",
  toplistUpdateUrl: "https://medreview.vn/api/medical/toplist-members-update.php",
  writerClaimUrl: "https://medreview.vn/api/medical/writer-claim.php"
};
const customUrls = {
  facilitiesUrl: "https://example.invalid/facility-list?page=4",
  updateUrl: "https://example.invalid/facility-update",
  toplistsUrl: "https://example.invalid/toplist-list?page=2",
  toplistUpdateUrl: "https://example.invalid/toplist-update"
};
const toplist = {
  toplist_id: 17,
  title: "Nha khoa Đà Nẵng",
  facilities: [
    { id: 59, name: "Dana Dental", rank_order: 1, reviews: [{ rating: 5, text: "Tốt" }], future: { enabled: true } },
    { name: "Cơ sở mới", address: "Đà Nẵng", rank_order: 2 }
  ],
  future_toplist_field: { source: "AI" }
};

function loadBackground(initial = {}, responseOverride) {
  const state = plain(initial);
  const calls = [];
  let listener;
  let installed;
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    chrome: {
      runtime: {
        onMessage: { addListener(callback) { listener = callback; } },
        onInstalled: { addListener(callback) { installed = callback; } }
      },
      storage: { local: {
        async get(keys) {
          const entries = Object.entries(state).filter(([key]) =>
            keys == null || (Array.isArray(keys) ? keys.includes(key) : keys === key));
          return plain(Object.fromEntries(entries));
        },
        async set(values) { Object.assign(state, plain(values)); }
      } }
    },
    AbortController, URL, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      let data;
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        if (String(url).includes("writer-claim.php")) {
          data = body.action === "claim"
            ? { ok: true, claimed: true, claim_token: `claim-${body.id}`, lease_seconds: 180 }
            : { ok: true, released: body.action === "release", lease_seconds: 180 };
        } else {
          data = { ok: true, errors: [], updated_count: 1,
            updated_ids: body.items.map((item) => item.id),
            updated_toplist_ids: body.items.map((item) => item.toplist_id ?? item.toplistId ?? item.id),
            created_facility_ids: [71] };
        }
      } else {
        data = { ok: true, items: [{ id: 17, title: "Nha khoa Đà Nẵng", prompt: "API prompt nguyên vẹn", prompt_type: "toplist" }] };
      }
      return responseOverride ? responseOverride(url, options, data) : {
        ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data)
      };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8") +
    "\nglobalThis.testApi = { fetchToplists, fetchFacilities, buildUpdatePayload, updateFacilityContent, finishJob, retryUpdate, initializeExtensionStorage, reconcileStaleApiUpdates };", context);
  return {
    ...context.testApi, calls, state, installed,
    dispatch(message) {
      return new Promise((resolve, reject) => {
        const asyncResponse = listener(message, {}, resolve);
        if (!asyncResponse) reject(new Error("Message handler did not accept request"));
      });
    }
  };
}

test("installation adds Toplist defaults while preserving saved URLs and queued jobs", async () => {
  const items = [{ id: "facility-17", facility_id: 17, prompt: "Giữ nguyên", status: "chờ" }];
  const api = loadBackground({ ...customUrls, items });
  await api.installed();
  for (const [key, value] of Object.entries(customUrls)) assert.equal(api.state[key], value);
  assert.deepEqual(api.state.items, items);
  const fresh = loadBackground();
  await fresh.installed();
  await new Promise(setImmediate);
  for (const [key, value] of Object.entries(defaultUrls)) assert.equal(fresh.state[key], value);
});

test("startup migrates saved legacy API endpoints to medreview.vn without changing custom endpoints", async () => {
  const saved = {
    facilitiesUrl: "https://top.top/api/medical/facilities-needing-content.php?page=7&limit=5&type=facility",
    updateUrl: "https://www.top.top/api/medical/facility-content-update.php",
    toplistsUrl: "https://top.top/api/medical/toplists-needing-facilities.php?page=4&limit=3",
    toplistUpdateUrl: "https://top.top/api/medical/toplist-facilities-update.php",
    aiImagesUrl: "https://top.top/api/medical/facilities-needing-ai-images.php?page=2&limit=1&min_images=4",
    aiImageUpdateUrl: "https://example.invalid/keep-my-custom-image-update?token=abc"
  };
  const api = loadBackground(saved);

  // The installed callback intentionally starts its async migration without
  // blocking Chrome's event dispatch. Yield once so the mocked storage write
  // mirrors the real service-worker startup/install path.
  await api.installed();
  await new Promise(setImmediate);

  assert.equal(api.state.facilitiesUrl, "https://medreview.vn/api/medical/facilities-needing-content.php?page=7&limit=5&type=facility");
  assert.equal(api.state.updateUrl, "https://medreview.vn/api/medical/facility-content-update.php");
  assert.equal(api.state.toplistsUrl, "https://medreview.vn/api/medical/toplists-needing-members.php?page=4&limit=3");
  assert.equal(api.state.toplistUpdateUrl, "https://medreview.vn/api/medical/toplist-members-update.php");
  assert.equal(api.state.aiImagesUrl, "https://medreview.vn/api/medical/facilities-needing-ai-images.php?page=2&limit=1&min_images=4");
  assert.equal(api.state.aiImageUpdateUrl, saved.aiImageUpdateUrl, "a non-top.top custom API must be preserved exactly");
});

test("fetch-toplists dispatch uses its default GET URL and required API headers", async () => {
  const api = loadBackground();
  const response = await api.dispatch({ type: "fetch-toplists" });
  assert.equal(response.ok, true);
  assert.deepEqual(plain(response.items), [{ id: 17, title: "Nha khoa Đà Nẵng", prompt: "API prompt nguyên vẹn", prompt_type: "toplist" }]);
  assert.equal(api.calls[0].url, defaultUrls.toplistsUrl);
  assert.equal(api.calls[0].options.method ?? "GET", "GET");
  assert.deepEqual(plain(api.calls[0].options.headers), { "X-Medical-Api-Key": "test-medical-key", Accept: "application/json" });
});

test("legacy global and per-tab Toplist settings migrate without erasing jobs or custom APIs", async () => {
  const saved = {
    toplistsUrl: "https://medreview.vn/api/medical/toplists-needing-facilities.php?page=2&entity_type=doctor",
    toplistUpdateUrl: "https://medreview.vn/api/medical/toplist-facilities-update.php",
    "tab-api-settings:33": { toplistsUrl: "https://top.top/api/medical/toplists-needing-facilities.php?page=3", toplistUpdateUrl: "https://medreview.vn/api/medical/toplist-facilities-update.php", account_label: "Giữ nhãn" },
    "tab-api-settings:44": { toplistsUrl: "https://example.invalid/custom-queue", toplistUpdateUrl: "https://medreview.vn/custom-save" },
    "article-content:toplist-17": { result: { toplist_id: 17, doctors: [{ doctor_id: 7 }] }, rawResponse: "Giữ JSON" }
  };
  const api = loadBackground(saved);
  // Reads use migrated URLs even before the asynchronous startup write finishes.
  await api.fetchToplists(33);
  assert.equal(api.calls[0].url, "https://medreview.vn/api/medical/toplists-needing-members.php?page=3&limit=1");
  await api.initializeExtensionStorage();
  assert.equal(api.state.toplistsUrl, "https://medreview.vn/api/medical/toplists-needing-members.php?page=2&entity_type=doctor");
  assert.equal(api.state["tab-api-settings:33"].toplistUpdateUrl, defaultUrls.toplistUpdateUrl);
  assert.equal(api.state["tab-api-settings:33"].account_label, "Giữ nhãn");
  assert.deepEqual(api.state["tab-api-settings:44"], saved["tab-api-settings:44"]);
  assert.deepEqual(api.state["article-content:toplist-17"], saved["article-content:toplist-17"]);
});

test("doctor and mixed Toplist JSON preserve IDs, ranks, sources and wrapper metadata", async () => {
  const api = loadBackground();
  const doctor = { toplist_id: 132, entity_type: "doctor", doctors: [
    { doctor_id: 7, rank_order: 2, sources: ["https://example.invalid/doctor"] },
    { doctor_id: 0, name: "Bác sĩ mẫu", specialty_text: "Mắt", city: "Hà Nội", rank_order: 1 }
  ] };
  const mixed = { toplist_id: 132, entity_type: "mixed", members: [
    { type: "facility", facility_id: 7, rank_order: 2 },
    { type: "doctor", doctor_id: 7, rank_order: 1 }
  ] };
  for (const record of [doctor, mixed]) {
    const wrapped = { items: [record], schema_version: 2 };
    const queue = { sourceType: "toplist", toplist_id: 132, entity_type: record.entity_type };
    assert.deepEqual(plain(api.buildUpdatePayload(queue, wrapped)), wrapped);
    await api.updateFacilityContent(queue, wrapped);
    assert.equal(api.calls.at(-1).url, defaultUrls.toplistUpdateUrl);
    assert.deepEqual(JSON.parse(api.calls.at(-1).options.body), wrapped);
  }
  const arrays = { toplist_id: 132, facilities: [{ facility_id: 7, rank_order: 2 }], doctors: [{ doctor_id: 7, rank_order: 1 }] };
  assert.deepEqual(plain(api.buildUpdatePayload({ toplist_id: 132, entity_type: "mixed" }, arrays)), { items: [arrays] });
  const alias = { toplistId: 132, bac_si: [{ id: 7 }] };
  assert.deepEqual(plain(api.buildUpdatePayload({ toplist_id: 132, entity_type: "doctor" }, alias)), { items: [alias] });
});

test("invalid doctor/mixed Toplists are rejected without an API write", async () => {
  const api = loadBackground();
  for (const record of [
    { entity_type: "bad", doctors: [{ doctor_id: 7 }] },
    { entity_type: "doctor", doctors: [] },
    { entity_type: "doctor", doctors: [{}] },
    { entity_type: "doctor", doctors: [{ doctor_id: -1, name: "Sai ID" }] },
    { entity_type: "doctor", doctors: [{ name: "Thiếu chuyên khoa", city: "Huế" }] },
    { entity_type: "doctor", doctors: [{ name: "Thiếu nơi khám", specialty_text: "Mắt" }] },
    { entity_type: "doctor", doctors: [{ doctor_id: 7, facility_id: 9 }] },
    { entity_type: "doctor", doctors: [{ doctor_id: 7, rank_order: 0 }] },
    { entity_type: "facility", facilities: [{ facility_id: 7 }] },
    { entity_type: "mixed", members: [{ type: "unknown", doctor_id: 7 }] },
    { entity_type: "mixed", members: [{ type: "doctor", doctor_id: 7 }], doctors: [{ doctor_id: 7 }] },
    { entity_type: "mixed", members: [{ type: "doctor", member_type: "facility", doctor_id: 7 }] },
    { entity_type: "mixed", doctors: [{ type: "facility", doctor_id: 7 }] }
  ]) {
    const queue = { sourceType: "toplist", toplist_id: 132, entity_type: record.entity_type === "mixed" ? "mixed" : "doctor" };
    await assert.rejects(api.updateFacilityContent(queue, { toplist_id: 132, ...record }));
  }
  assert.equal(api.calls.length, 0);
});

test("Toplist queue keeps the dedicated doctor prompt, schema and type across refresh", async () => {
  const record = { id: 132, title: "Bác sĩ mắt Hà Nội", entity_type: "doctor", prompt: "Danh sách bác sĩ nguyên bản API\n", prompt_key_used: "toplist_doctor", output_template: { toplist_id: 132, doctors: [] }, receive_endpoint: "/api/medical/toplist-members-update.php" };
  const api = loadBackground({}, () => ({ ok: true, status: 200, json: async () => ({ ok: true, items: [record] }) }));
  const first = await api.dispatch({ type: "refresh-queue", sourceType: "toplist" });
  assert.equal(first.ok, true);
  assert.equal(first.items[0].toplist_id, 132);
  assert.equal(first.items[0].sourceType, "toplist");
  assert.equal(first.items[0].entity_type, "doctor");
  assert.equal(first.items[0].prompt_key_used, "toplist_doctor");
  const content = api.state["article-content:toplist-132"];
  assert.equal(content.prompt, record.prompt);
  assert.deepEqual(content.output_template, record.output_template);
  await api.dispatch({ type: "refresh-queue", sourceType: "toplist" });
  assert.equal(api.state.items.length, 1);
  assert.equal(api.state["article-content:toplist-132"].prompt, record.prompt);
});

test("list requests read independent custom settings for facilities and Toplists", async () => {
  const api = loadBackground(customUrls);
  await api.fetchFacilities();
  await api.fetchToplists();
  assert.deepEqual(api.calls.map(({ url }) => url), [customUrls.facilitiesUrl + "&limit=1", customUrls.toplistsUrl + "&limit=1"]);
});

test("fetch-toplists reports server errors and does not invent missing API prompts", async () => {
  const failed = loadBackground({}, () => ({ ok: true, json: async () => ({ ok: false, message: "Sai API key" }) }));
  assert.deepEqual(plain(await failed.dispatch({ type: "fetch-toplists" })), { ok: false, error: "Sai API key" });
  const emptyPrompt = loadBackground({}, () => ({ ok: true, json: async () => ({ ok: true, items: [{ id: 17, title: "Thiếu prompt" }] }) }));
  assert.deepEqual(plain((await emptyPrompt.fetchToplists()).items), [{ id: 17, title: "Thiếu prompt" }]);
});

test("Toplist payload preserves nested facility IDs, reviews, unknown fields and wrapper metadata", () => {
  const api = loadBackground();
  const queue = { sourceType: "toplist", toplist_id: 17 };
  const snapshot = plain(toplist);
  assert.deepEqual(plain(api.buildUpdatePayload(queue, toplist)), { items: [toplist] });
  assert.deepEqual(plain(api.buildUpdatePayload(queue, [toplist])), { items: [toplist] });
  const wrapped = { items: [toplist], schema_version: 3, metadata: { verified: true } };
  assert.deepEqual(plain(api.buildUpdatePayload(queue, wrapped)), wrapped);
  assert.deepEqual(toplist, snapshot);
});

test("Toplist root ID aliases and facility collection aliases follow the endpoint contract", () => {
  const api = loadBackground();
  for (const idKey of ["toplist_id", "toplistId", "id"]) {
    for (const facilitiesKey of ["facilities", "co_so", "co_so_y_te"]) {
      const record = { [idKey]: "17", [facilitiesKey]: [{ facility_id: 59 }, { ten: "Cơ sở mới", rank: 2 }] };
      assert.deepEqual(plain(api.buildUpdatePayload({ sourceType: "toplist", toplist_id: 17 }, record)), { items: [record] });
    }
  }
});

test("a missing Toplist ID is supplied from its queue item, never from nested facility IDs", () => {
  const api = loadBackground();
  const data = { facilities: [{ id: 900, rank_order: 1 }] };
  assert.deepEqual(plain(api.buildUpdatePayload({ sourceType: "toplist", toplist_id: 17 }, data)), {
    items: [{ facilities: [{ id: 900, rank_order: 1 }], toplist_id: 17 }]
  });
  assert.equal(Object.hasOwn(data, "toplist_id"), false);
  assert.throws(() => api.buildUpdatePayload({ sourceType: "toplist" }, data), /ID Toplist/);
});

test("wrong Toplist IDs and invalid Toplist shapes are rejected before sending", async () => {
  const api = loadBackground();
  const invalid = [
    { ...toplist, toplist_id: 18 }, { ...toplist, toplist_id: 0 },
    { ...toplist, toplist_id: "17oops" }, { ...toplist, toplist_id: 17.5 },
    { ...toplist, facilities: [] }, { ...toplist, facilities: {} },
    { ...toplist, facilities: ["Dental"] }, { ...toplist, facilities: [null] },
    { ...toplist, facilities: [{}] }, { ...toplist, facilities: [{ name: " " }] },
    { id: 17, content: "Cơ sở y tế" }, [toplist, { ...toplist, toplist_id: 18 }]
  ];
  for (const data of invalid) {
    await assert.rejects(api.updateFacilityContent({ sourceType: "toplist", toplist_id: 17 }, data));
  }
  assert.equal(api.calls.length, 0);
});

test("Toplist POST uses default URL, full payload and API key", async () => {
  const api = loadBackground();
  await api.updateFacilityContent({ sourceType: "toplist", toplist_id: 17 }, toplist);
  const { url, options } = api.calls[0];
  assert.equal(url, defaultUrls.toplistUpdateUrl);
  assert.equal(options.method, "POST");
  assert.equal(options.headers["X-Medical-Api-Key"], "test-medical-key");
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(options.body), { items: [toplist] });
});

test("mixed queue completion routes identical numeric IDs by each job's saved type", async () => {
  const api = loadBackground({ ...customUrls, items: [
    { id: "facility-17", facility_id: 17, status: "đang viết" },
    { id: "toplist-17", sourceType: "toplist", toplist_id: 17, status: "đang viết" }
  ] });
  await api.finishJob("facility-17", { id: 17, content: "Facility", reviews: [] }, "raw facility");
  await api.finishJob("toplist-17", toplist, "raw toplist");
  assert.deepEqual(api.calls.map(({ url }) => url), [customUrls.updateUrl, customUrls.toplistUpdateUrl]);
  assert.deepEqual(api.state.items.map(({ status }) => status), ["hoàn tất", "hoàn tất"]);
  assert.deepEqual(api.state["article-content:" + api.state.items[1].id].result, toplist);
  assert.deepEqual(api.state.items[1].api_update.created_facility_ids, [71]);
});

test("retry-update resends a successful Toplist through the current Toplist URL regardless of selected list", async () => {
  const api = loadBackground({ ...customUrls, sourceType: "facility", items: [
    { id: "toplist-17", sourceType: "toplist", toplist_id: 17, status: "hoàn tất", result: toplist },
    { id: "facility-17", facility_id: 17, status: "lỗi cập nhật", result: { id: 17, content: "Facility" } }
  ] });
  assert.equal((await api.dispatch({ type: "retry-update", articleId: "toplist-17" })).ok, true);
  assert.equal((await api.retryUpdate("facility-17")).ok, true);
  assert.deepEqual(api.calls.map(({ url }) => url), [customUrls.toplistUpdateUrl, defaultUrls.writerClaimUrl, customUrls.updateUrl]);
  assert.deepEqual(JSON.parse(api.calls[0].options.body), { items: [toplist] });
});

test("a queue item retaining only toplist_id still uses the Toplist endpoint", async () => {
  const api = loadBackground(customUrls);
  await api.updateFacilityContent({ id: "toplist-17", toplist_id: 17 }, toplist);
  assert.equal(api.calls[0].url, customUrls.toplistUpdateUrl);
});

test("Toplist API errors preserve JSON for retry and cannot be shown as success", async () => {
  const api = loadBackground({ items: [{ id: "toplist-17", sourceType: "toplist", toplist_id: 17 }] }, () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ ok: true, updated_toplist_ids: [], errors: ["Cơ sở không tồn tại"] })
  }));
  assert.deepEqual(plain(await api.finishJob("toplist-17", toplist, "raw")), { ok: true, updated: false });
  assert.equal(api.state.items[0].status, "lỗi cập nhật");
  assert.match(api.state.items[0].api_error, /Cơ sở không tồn tại/);
  assert.deepEqual(api.state["article-content:" + api.state.items[0].id].result, toplist);
});

test("a stale in-flight API send becomes an explicit uncertain state and keeps its JSON for retry", async () => {
  const now = Date.now();
  const result = { id: 59, content: "Đã viết", reviews: [{ rating: 5 }] };
  const api = loadBackground({
    runner: { active: true, currentId: "facility-59", workers: {
      "tab-404": { active: true, provider: "gemini", currentId: "facility-59", targetTabId: 404 }
    } },
    items: [{
      id: "facility-59", facility_id: 59, title: "Nha khoa", status: "đang cập nhật", result,
      api_request_started_at: new Date(now - 31 * 60 * 1000).toISOString()
    }]
  });

  const reconciled = await api.reconcileStaleApiUpdates(now);
  assert.equal(reconciled.recovered, 1);
  assert.equal(api.state.items[0].status, "chưa xác nhận");
  assert.deepEqual(api.state["article-content:" + api.state.items[0].id].result, result);
  assert.match(api.state.items[0].api_error, /có thể đã tới server/);
  assert.equal(api.state.runner.workers["tab-404"].active, false);
  assert.equal(api.state.runner.active, false);

  const resent = await api.retryUpdate("facility-59");
  assert.equal(resent.ok, true);
  assert.equal(api.state.items[0].status, "hoàn tất");
  assert.deepEqual(api.state["article-content:" + api.state.items[0].id].result, result);
  assert.equal(api.state.items[0].api_attempt_count, 1);
  assert.ok(api.state.items[0].api_last_attempt_at);
  assert.equal("api_request_started_at" in api.state.items[0], false);
});

test("legacy pending sends without a timestamp start a safe observation window", async () => {
  const now = Date.now();
  const api = loadBackground({ items: [
    { id: "facility-59", facility_id: 59, status: "đang cập nhật", result: { id: 59, content: "JSON" } }
  ] });

  const reconciled = await api.reconcileStaleApiUpdates(now);
  assert.equal(reconciled.recovered, 0);
  assert.equal(api.state.items[0].status, "đang cập nhật");
  assert.equal(Date.parse(api.state.items[0].api_request_started_at), now);
  assert.deepEqual(api.state["article-content:" + api.state.items[0].id].result, { id: 59, content: "JSON" });
});

test("an already-running article without a start time gets a persistent tracking clock", async () => {
  const now = Date.now();
  const result = { id: 59, content: "JSON đã lưu" };
  const api = loadBackground({
    runner: { active: true, workers: {
      "tab-404": { active: true, provider: "gemini", targetTabId: 404, currentId: "facility-59" }
    } },
    items: [{ id: "facility-59", facility_id: 59, title: "Nha khoa", status: "đang viết", result }]
  });

  await api.reconcileStaleApiUpdates(now);
  const startedAt = Date.parse(api.state.items[0].write_started_at);
  assert.equal(startedAt, now);
  assert.equal(api.state.items[0].write_timer_backfilled, true);
  assert.deepEqual(api.state["article-content:" + api.state.items[0].id].result, result);

  await api.reconcileStaleApiUpdates(now + 15000);
  assert.equal(Date.parse(api.state.items[0].write_started_at), now, "reopening the panel must not reset the tracked duration");
});

test("Toplist success must confirm the submitted Toplist ID", async () => {
  for (const updated_toplist_ids of [undefined, [], [18]]) {
    const api = loadBackground({}, () => ({ ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, updated_toplist_ids, errors: [] }) }));
    await assert.rejects(api.updateFacilityContent({ sourceType: "toplist", toplist_id: 17 }, toplist), /chưa xác nhận/);
  }
});

test("a null HTTP error body retains its status instead of throwing a property-access error", async () => {
  const api = loadBackground({}, () => ({ ok: false, status: 500, text: async () => "null" }));
  await assert.rejects(api.updateFacilityContent({ sourceType: "toplist", toplist_id: 17 }, toplist),
    /API cập nhật trả về 500: null/);
});
