const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BASE = "https://medreview.vn/api/medical/";
const DOCTORS_URL = BASE + "doctors-needing-content.php";
const UPDATE_URL = BASE + "doctor-content-update.php";
const CONTENT_URL = BASE + "doctor-content.php";
const CLAIM_URL = BASE + "writer-claim.php";
const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const token = "a".repeat(64);

function doctorSource(id = 12, name = "BS. Nguyễn Văn An", extra = {}) {
  return {
    id, name, type: "doctor", prompt_type: "doctor", needs_content: true,
    status: "published", language_code: "vi", content: null, last_researched_at: null,
    prompt: `SERVER-DOCTOR-PROMPT-${id}`, prompt_label: "Hồ sơ bác sĩ",
    prompt_source: "custom", writer_claimed: false,
    output_template: { id, name, content: null, insufficient_data: true },
    ...extra
  };
}

function doctorJob(id = 12, ownerTabId = 101, extra = {}) {
  const source = doctorSource(id);
  return {
    ...source, id: `tab-${ownerTabId}:doctor-${id}`, doctor_id: id,
    ownerTabId, sourceType: "doctor", title: source.name, status: "chờ", ...extra
  };
}

function doctorResult(id = 12, name = "BS. Nguyễn Văn An", extra = {}) {
  return {
    id, name, subtitle: "Bác sĩ chuyên khoa", content: "<p>Hồ sơ có nguồn.</p>",
    practice_license_json: null,
    education_json: [{ institution: "Đại học Y", degree: "Bác sĩ", source_ids: ["s1"] }],
    experience_json: [], gallery_json: [],
    sources_json: [{ id: "s1", url: "https://example.org/doctor", title: "Hồ sơ chính thức" }],
    evidence_json: { identity_status: "matched", missing_fields: [], conflicts: [] },
    insufficient_data: false, notes_for_editor: null,
    future_editorial_field: { nullable: null, values: [1, false, { nested: "kept" }] },
    ...extra
  };
}

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    async text() { return typeof data === "string" ? data : JSON.stringify(data); },
    async json() { return plain(data); }
  };
}

function loadBackground(initial = {}, fetchOverride) {
  const state = plain({ sourceType: "doctor", nextJobDelayMs: 0, items: [], runner: { active: false }, ...initial });
  const tabs = new Map([
    [101, { id: 101, url: "https://grok.com/c/doctor-one" }],
    [202, { id: 202, url: "https://chatgpt.com/c/doctor-two" }],
    [303, { id: 303, url: "https://claude.ai/chat/translation-three" }],
    [404, { id: 404, url: "https://gemini.google.com/spark/chat/doctor-content-task" }]
  ]);
  const calls = [], sent = [], alarms = [];
  const retryTimers = [];
  let alarmListener, runtimeListener;
  const owned = new Map();
  const chrome = {
    runtime: { onMessage: { addListener(listener) { runtimeListener = listener; } }, onInstalled: { addListener() {} } },
    storage: { local: {
      async get(keys) {
        const wanted = keys == null ? Object.keys(state) : Array.isArray(keys) ? keys : [keys];
        return plain(Object.fromEntries(wanted.filter((key) => key in state).map((key) => [key, state[key]])));
      },
      async set(values) { Object.assign(state, plain(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; }
    } },
    tabs: {
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      async get(id) { const tab = tabs.get(Number(id)); if (!tab) throw new Error("No tab"); return plain(tab); },
      async query(query) { return query.active ? [plain(tabs.get(101))] : [...tabs.values()].map(plain); },
      async sendMessage(id, message) {
        sent.push({ id, message: plain(message) });
        return message.type === "runner-ready" ? { ok: true, ready: true } : { ok: true, started: true };
      },
      async update() {}, async reload() {}
    },
    scripting: { async executeScript() {} },
    alarms: { create(name, options) { alarms.push({ name, options: plain(options) }); }, onAlarm: { addListener(listener) { alarmListener = listener; } } }
  };
  const fetch = async (url, options = {}) => {
    const address = String(url), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: address, options: plain(options), body });
    const override = fetchOverride && await fetchOverride(address, options, body, { calls, state, owned });
    if (override !== undefined) return override;
    if (address.startsWith(CLAIM_URL)) {
      const key = `${body.type}-${body.id}`;
      if (body.action === "claim") {
        const previous = owned.get(key);
        if (previous && previous !== body.request_id) return response({ ok: true, claimed: false, reason: "already_claimed" }, 409);
        owned.set(key, body.request_id);
        return response({ ok: true, claimed: true, claim_token: token,
          expires_at: Math.floor(Date.now() / 1000) + 180, lease_seconds: 180, heartbeat_interval_seconds: 45 });
      }
      if (body.action === "release") { owned.delete(key); return response({ ok: true, released: true }); }
      return response({ ok: true, expires_at: Math.floor(Date.now() / 1000) + 180, lease_seconds: 180 });
    }
    if (address.startsWith(DOCTORS_URL)) {
      const ids = new URL(address).searchParams.get("ids");
      return response({ ok: true, type: "doctor", claim_required: true,
        items: ids ? ids.split(",").map((id) => doctorSource(Number(id))) : [] });
    }
    if (address.startsWith(CONTENT_URL)) return response({ ok: true, item: doctorSource(Number(new URL(address).searchParams.get("id"))) });
    if (address.startsWith(UPDATE_URL)) {
      const record = body.items[0];
      const savedJob = state.items.find((item) => Number(item.doctor_id) === Number(record.id));
      const requestId = savedJob?.doctor_writer_request_id || savedJob?.writer_claim_request_id || owned.get(`doctor-${record.id}`) || "saved-request";
      const updated = [{ id: record.id, writer_request_id: requestId, insufficient_data: record.insufficient_data, writer_released: true }];
      return response({ ok: true, updated_count: 1, updated, results: updated, errors: [] });
    }
    if (options.method === "POST") {
      if (address.includes("translate-content.php")) return response({ ok: true, translation_id: 801, status: "draft", saved_fields: ["content"] });
      return response({ ok: true, updated_ids: [body.items[0].id], updated_count: 1, errors: [] });
    }
    return response({ ok: true, items: [] });
  };
  const code = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8") + `
    globalThis.__doctorApiTests = {
      fetchDoctors, buildDoctorUpdatePayload, updateDoctorContent, readDoctorReceipt,
      revalidateDoctorJob, reconcileDoctorPendingUpdates, mergeQueueItems,
      startRun, stopRun, heartbeatActiveWriterClaims, handleArticleComplete,
      refreshQueue, runNext, finishJob, retryUpdate, jobStorage, getJobMetadata,
      queueItemIdentityKey, queueItemSource, clearWriterClaimAfterSave, recoverIdleWorkers,
      dispatchSparkJobRetry
    };
  `;
  const testSetTimeout = (callback, delay) => {
    if (delay === 5000) { const handle = { mockRetry: retryTimers.length }; retryTimers.push(callback); return handle; }
    return setTimeout(callback, delay);
  };
  const testClearTimeout = (handle) => { if (!handle || handle.mockRetry == null) clearTimeout(handle); };
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key", chrome, fetch, URL, AbortController, setTimeout: testSetTimeout, clearTimeout: testClearTimeout, structuredClone });
  vm.runInContext(code, context, { filename: "background.js" });
  return { ...context.__doctorApiTests, state, calls, sent, alarms, tabs, owned, retryTimers,
    getAlarmListener() { return alarmListener; },
    getRuntimeListener() { return runtimeListener; },
    sender(id) { return { tab: plain(tabs.get(id)) }; } };
}

test("doctor GET uses its configured endpoint, supports remembered ids, and preserves server prompts", async () => {
  const api = loadBackground({ "tab-api-settings:101": { doctorsUrl: DOCTORS_URL + "?page=2&limit=25" } });
  const list = await api.fetchDoctors([12, 34], 101);
  const request = api.calls[0], url = new URL(request.url);
  assert.equal(url.origin + url.pathname, DOCTORS_URL);
  assert.equal(url.searchParams.get("ids"), "12,34");
  assert.equal(request.options.headers["X-Medical-Api-Key"], "test-medical-key");
  assert.equal(list.items[0].prompt, "SERVER-DOCTOR-PROMPT-12");
  assert.deepEqual(plain(list.items[0].output_template), doctorSource().output_template);
});

test("undeployed doctor endpoint and schema errors remain errors, not empty queues", async () => {
  for (const status of [404, 503]) {
    const api = loadBackground({}, (url) => url.startsWith(DOCTORS_URL)
      ? response({ ok: false, message: "Doctor backend is not deployed" }, status) : undefined);
    await assert.rejects(api.fetchDoctors([], 101), new RegExp(String(status)));
    await assert.rejects(api.refreshQueue("doctor", "facility", 101), new RegExp(String(status)));
    assert.equal(api.state.items.length, 0);
    assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
  }
});

test("an older doctor 503 refresh reply cannot replace the latest HTTP 200 ready queue state", async () => {
  let enteredFirst, enteredSecond;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  const secondEntered = new Promise((resolve) => { enteredSecond = resolve; });
  const replies = [];
  const retained = doctorJob(12, 101, { status: "chưa xác nhận", result: doctorResult(), writer_claim_token: token,
    writer_claim_request_id: "kept-attempt", doctor_writer_request_id: "kept-attempt" });
  const otherQueue = { sourceType: "doctor", status: "ready", httpStatus: 200, count: 1 };
  const api = loadBackground({ items: [retained], "tab-doctor-queue:202": otherQueue }, (url) => {
    if (!url.startsWith(DOCTORS_URL)) return undefined;
    return new Promise((resolve) => {
      replies.push(resolve);
      (replies.length === 1 ? enteredFirst : enteredSecond)();
    });
  });
  const request = () => new Promise((resolve) => {
    const handled = api.getRuntimeListener()({ type: "refresh-queue", sourceType: "doctor", targetTabId: 101 }, api.sender(101), resolve);
    assert.equal(handled, true);
  });
  const older = request();
  await firstEntered;
  const latest = request();
  await secondEntered;
  replies[1](response({ ok: true, type: "doctor", items: [] }));
  const freshReply = await latest;
  assert.equal(freshReply.ok, true);
  assert.equal(freshReply.queueState.status, "ready");
  const freshState = plain(api.state["tab-doctor-queue:101"]);

  replies[0](response({ ok: false, message: "Chưa sẵn sàng schema bác sĩ." }, 503));
  const staleReply = await older;

  assert.equal(staleReply.ok, false, "the old transport failure still reports its own request outcome");
  assert.match(staleReply.error, /HTTP 503/);
  assert.deepEqual(plain(staleReply.queueState), freshState, "runtime must return the requestId-protected state, not reconstruct a stale 503 error");
  assert.deepEqual(plain(api.state["tab-doctor-queue:101"]), freshState);
  assert.deepEqual(plain(api.state["tab-doctor-queue:202"]), otherQueue);
  const stored = (await api.jobStorage.get("items")).items[0];
  assert.deepEqual(plain(stored.result), retained.result);
  assert.equal(stored.writer_claim_token, token);
  assert.equal(stored.doctor_writer_request_id, "kept-attempt");
  assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
});

test("doctor queue 503 blocks Run until a manual HTTP 200 empty refresh clears only its paused worker error", async () => {
  let ready = false;
  const retained = doctorJob(12, 101, { status: "chưa xác nhận", result: doctorResult(), writer_claim_token: token,
    writer_claim_request_id: "kept-attempt", doctor_writer_request_id: "kept-attempt" });
  const other = doctorJob(34, 202, { status: "đang viết", workerKey: "tab-202", runToken: "other-run" });
  const api = loadBackground({ items: [retained, other], runner: { active: true, workers: {
    "tab-101": { active: false, sourceType: "doctor", provider: "grok", targetTabId: 101, currentId: null,
      waitReason: "doctor-queue-error", lastError: "API danh sách bác sĩ HTTP 503" },
    "tab-202": { active: true, sourceType: "doctor", provider: "chatgpt", targetTabId: 202, currentId: other.id, runToken: "other-run" }
  } } }, (url) => url.startsWith(DOCTORS_URL)
    ? ready ? response({ ok: true, type: "doctor", items: [] }) : response({ ok: false, message: "Chưa sẵn sàng schema bác sĩ." }, 503)
    : undefined);
  await assert.rejects(api.refreshQueue("doctor", "facility", 101), /HTTP 503/);
  const blocked = await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.doctorQueueError, true);
  assert.equal(blocked.queueState.status, "error");
  assert.equal(api.state.runner.workers["tab-101"].active, false);
  assert.equal(api.state.runner.workers["tab-202"].active, true);

  ready = true;
  const refreshed = await api.refreshQueue("doctor", "facility", 101);

  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.queueState.status, "ready");
  assert.equal(refreshed.queueState.httpStatus, 200);
  assert.equal(refreshed.queueState.count, 0);
  assert.equal(api.state.runner.workers["tab-101"].active, false, "manual refresh never starts an AI worker automatically");
  assert.equal(api.state.runner.workers["tab-101"].waitReason, undefined);
  assert.equal(api.state.runner.workers["tab-101"].lastError, null);
  assert.equal(api.state.runner.workers["tab-202"].active, true);
  assert.equal(api.state.runner.workers["tab-202"].currentId, other.id);
  const stored = (await api.jobStorage.get("items")).items.find((item) => item.id === retained.id);
  assert.deepEqual(plain(stored.result), retained.result);
  assert.equal(stored.writer_claim_token, token);
  assert.equal(stored.doctor_writer_request_id, "kept-attempt");
  assert.equal(api.calls.some((call) => call.body?.action === "claim" || call.body?.action === "release" || call.url.startsWith(UPDATE_URL)), false);
  assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
});

test("a doctor queue loading in another panel blocks a direct Run without becoming a stored failure", async () => {
  const loading = { sourceType: "doctor", status: "loading", requestId: "pending-refresh" };
  const api = loadBackground({ items: [doctorJob()], "tab-doctor-queue:101": loading });

  const blocked = await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));

  assert.equal(blocked.ok, false);
  assert.equal(blocked.doctorQueueLoading, true);
  assert.notEqual(blocked.doctorQueueError, true, "an in-progress request is not an API failure");
  assert.deepEqual(plain(blocked.queueState), loading);
  assert.deepEqual(plain(api.state["tab-doctor-queue:101"]), loading);
  assert.equal(api.state.runner.active, false);
  assert.equal(api.calls.some((call) => call.body?.action === "claim" || call.url.startsWith(UPDATE_URL)), false);
  assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
});

test("doctor payload preserves arrays, objects, nulls and future fields and privately adds its token", () => {
  const api = loadBackground(), job = doctorJob(12, 101, { writer_claim_token: token }), result = doctorResult();
  const payload = api.buildDoctorUpdatePayload(job, result);
  assert.deepEqual(plain(payload), { items: [{ ...result, writer_claim_token: token }] });
  assert.equal(result.writer_claim_token, undefined, "AI result must not be mutated with private credentials");
  assert.throws(() => api.buildDoctorUpdatePayload(job, { ...result, id: "12" }), /id|ID|nguyên/);
  assert.throws(() => api.buildDoctorUpdatePayload(job, { ...result, id: 13 }), /id|ID/);
  assert.throws(() => api.buildDoctorUpdatePayload(job, { ...result, name: "Bác sĩ khác" }), /name|tên|Tên/);
  assert.throws(() => api.buildDoctorUpdatePayload(job, { ...result, name: undefined }), /name|tên|Tên/);
  assert.throws(() => api.buildDoctorUpdatePayload({ ...job, writer_claim_token: null }, result), /token|khóa|Khóa/);
});

function assertDoctorUrlError(error, field) {
  assert.equal(error.doctorPayloadError, true, `invalid ${field} needs a local payload error, not a transport error`);
  assert.equal(error.doctorPayloadField, field);
  assert.ok(error.message.includes(field), `the error must identify the exact URL path ${field}: ${error.message}`);
  assert.match(error.message, /URL/);
  return true;
}

test("doctor URL preflight rejects malformed root scalars and aliases with exact field errors without coercion", () => {
  const api = loadBackground(), job = doctorJob(12, 101, { writer_claim_token: token });
  const fields = ["website_url", "booking_url", "image_url", "professional_profile_url", "practice_registry_url", "website", "booking"];
  const malformed = [
    { url: "https://example.org/profile" }, ["https://example.org/profile"], 7, false,
    "null", "[Hồ sơ](https://example.org/profile)", '<a href="https://example.org/profile">Hồ sơ</a>',
    "https://user:password@example.org/profile", "data:image/png;base64,aGVsbG8=", "javascript:alert(1)",
    "ftp://example.org/profile", "/doctor/profile", "https://",
    "https://-example.org/profile", "https://example-.org/profile", "https://exa..mple.org/profile",
    "https://.example.org/profile", "https://./profile", "https://éxample.org/profile", "https://example.org/é",
    "https://%65xample.org/profile", "https://example%2eorg/profile", "https://" + "a".repeat(64) + ".org/profile"
  ];
  for (const field of fields) {
    for (const value of malformed) {
      const result = doctorResult(12, undefined, { [field]: value }), before = plain(result);
      assert.throws(() => api.buildDoctorUpdatePayload(job, result), (error) => assertDoctorUrlError(error, field),
        `must reject ${field}=${JSON.stringify(value)}`);
      assert.deepEqual(result, before, `rejecting ${field} must not stringify, flatten or discard the original value`);
    }
  }
  for (const field of ["website_url", "booking_url", "professional_profile_url", "practice_registry_url"]) {
    const prefix = "https://example.org/";
    const tooLong = prefix + "a".repeat(4001 - prefix.length);
    assert.throws(() => api.buildDoctorUpdatePayload(job, doctorResult(12, undefined, { [field]: tooLong })),
      (error) => assertDoctorUrlError(error, field));
    const overByteLimit = prefix + "é".repeat(2000);
    assert.ok(Buffer.byteLength(overByteLimit, "utf8") > 4000 && overByteLimit.length < 4000);
    assert.throws(() => api.buildDoctorUpdatePayload(job, doctorResult(12, undefined, { [field]: overByteLimit })),
      (error) => assertDoctorUrlError(error, field));
  }
  const imagePrefix = "https://example.org/";
  assert.throws(() => api.buildDoctorUpdatePayload(job, doctorResult(12, undefined, {
    image_url: imagePrefix + "a".repeat(256 - imagePrefix.length)
  })), (error) => assertDoctorUrlError(error, "image_url"));
  for (const [field, maximum] of [["image_url", 255], ["website_url", 4000]]) {
    assert.throws(() => api.buildDoctorUpdatePayload(job, doctorResult(12, undefined, {
      [field]: " ".repeat(maximum + 1) + "https://example.org/profile"
    })), (error) => assertDoctorUrlError(error, field), "root text length is checked before trimming, matching the backend");
  }
  assert.equal(api.calls.length, 0, "local preflight never contacts an API");
});

test("doctor URL preflight validates required list URLs and every nested URL using indexed paths", () => {
  const api = loadBackground(), job = doctorJob(12, 101, { writer_claim_token: token });
  const invalid = [
    ["gallery_json[1].url", { gallery_json: [{ url: "https://example.org/portrait.jpg" }, { url: null }] }],
    ["gallery_json[0].url", { gallery_json: [{}] }],
    ["gallery_json[0].url", { gallery_json: ["[Ảnh](https://example.org/portrait.jpg)"] }],
    ["sources_json[0].url", { sources_json: [{ id: "s1", url: null }] }],
    ["sources_json[0].url", { sources_json: [{ id: "s1", url: ["https://example.org/profile"] }] }],
    ["social_links_json[facebook]", { social_links_json: { facebook: { url: "https://example.org/facebook" } } }],
    ["social_links_json[facebook]", { social_links_json: { facebook: null } }],
    ["video_urls_json[1]", { video_urls_json: ["https://example.org/video", null] }],
    ["video_urls_json[0]", { video_urls_json: [{ url: "https://example.org/video" }] }],
    ["publications_json[0].url", { publications_json: [{ title: "Bài nghiên cứu", url: { href: "https://example.org/publication" }, source_ids: ["s1"] }] }],
    ["legal_documents_json[1].url", { legal_documents_json: [{ title: "Giấy tờ", url: null }, { title: "Giấy tờ khác", url: false }] }],
    ["locations_json[0].website_url", { locations_json: [{ facility_name: "Bệnh viện", website_url: [], booking_url: null, source_ids: ["s1"] }] }],
    ["locations_json[0].booking_url", { locations_json: [{ facility_name: "Bệnh viện", website_url: null, booking_url: 8, source_ids: ["s1"] }] }],
    ["education_json[0].details.links[0].url", { education_json: [{ institution: "Đại học Y", source_ids: ["s1"], details: { links: [{ url: { value: "https://example.org/school" } }] } }] }],
    ["evidence_json.conflicts[0].reference.website_url", { evidence_json: { identity_status: "matched", conflicts: [{ reference: { website_url: ["https://example.org/conflict"] } }] } }],
    ["practice_license_json.reference.booking_url", { practice_license_json: { source_ids: ["s1"], reference: { booking_url: false } } }],
    ["locations_json[0].schedule_json[0].url", { locations_json: [{ facility_name: "Bệnh viện", source_ids: ["s1"], schedule_json: [{ url: "data:text/plain,schedule" }] }] }],
    ["education_json[0].url", { education_json: JSON.stringify([{ institution: "Đại học Y", source_ids: ["s1"], url: { href: "https://example.org/school" } }]) }]
  ];
  for (const [field, extra] of invalid) {
    const result = doctorResult(12, undefined, extra), before = plain(result);
    assert.throws(() => api.buildDoctorUpdatePayload(job, result), (error) => assertDoctorUrlError(error, field), `must reject ${field}`);
    assert.deepEqual(result, before, `invalid ${field} must remain available for the editor to correct`);
  }
  for (const [field, extra] of [
    ["gallery_json[0].url", { gallery_json: [{ url: "" }] }],
    ["sources_json[0].url", { sources_json: [{ id: "s1", url: "" }] }],
    ["social_links_json[facebook]", { social_links_json: { facebook: "" } }],
    ["video_urls_json[0]", { video_urls_json: [""] }]
  ]) assert.throws(() => api.buildDoctorUpdatePayload(job, doctorResult(12, undefined, extra)),
    (error) => assertDoctorUrlError(error, field));
  assert.equal(api.calls.length, 0);
});

test("doctor URL preflight preserves valid nullable, legacy and nested URL payloads exactly", () => {
  const api = loadBackground(), job = doctorJob(12, 101, { writer_claim_token: token });
  const prefix = "https://example.org/";
  const result = doctorResult(12, undefined, {
    website_url: "", booking_url: null, professional_profile_url: prefix + "a".repeat(4000 - prefix.length), practice_registry_url: null,
    image_url: prefix + "p".repeat(255 - prefix.length),
    gallery_json: [{ url: "https://example.org/portrait.jpg", caption: "Ảnh thật", source_ids: ["s1"] }, "https://example.org/legacy.jpg"],
    social_links_json: { facebook: "https://example.org/doctor/facebook", youtube: "https://example.org/doctor/channel" },
    video_urls_json: ["https://example.org/doctor/video"],
    publications_json: [{ title: "Bài nghiên cứu", url: null, source_ids: ["s1"] }, { title: "Bài khác", url: "https://example.org/paper", source_ids: ["s1"] }],
    legal_documents_json: [{ title: "Tài liệu", url: null, source_ids: ["s1"] }],
    locations_json: [{ facility_name: "Bệnh viện A", website_url: "https://example.org/hospital", booking_url: null,
      source_ids: ["s1"], schedule_json: [{ url: null, day: "Thứ hai", source_ids: ["s1"] }] }],
    education_json: JSON.stringify([{ institution: "Đại học Y", source_ids: ["s1"], url: "https://example.org/school" }]),
    evidence_json: { identity_status: "matched", missing_fields: [], conflicts: [], reference: { url: null,
      links: [{ website_url: "https://example.org/profile", booking_url: null }] } },
    future_editorial_field: { url: { unknown_contract_kept: true }, nested: [false, null] }
  });
  const before = plain(result);
  assert.deepEqual(plain(api.buildDoctorUpdatePayload(job, result)), { items: [{ ...before, writer_claim_token: token }] });
  assert.deepEqual(result, before, "URL checking must not normalize or delete valid original fields");
  const aliases = doctorResult(12, undefined, { website: "https://example.org/website", booking: null });
  assert.deepEqual(plain(api.buildDoctorUpdatePayload(job, aliases).items[0]), { ...aliases, writer_claim_token: token });
  const unknowns = doctorResult(12, undefined, {
    website_url: null, booking_url: "", image_url: null, professional_profile_url: null, practice_registry_url: "",
    social_links_json: [], video_urls_json: [], gallery_json: []
  });
  assert.deepEqual(plain(api.buildDoctorUpdatePayload(job, unknowns).items[0]), { ...unknowns, writer_claim_token: token });
  assert.equal(api.calls.length, 0);
});

test("doctor payload adapts native and legacy social-link pairs only for transport and preserves the full AI record", async () => {
  const platform = "Website Hệ thống Y tế Thu Cúc TCI";
  const pairs = [
    { platform, url: "https://benhvienthucuc.vn" },
    { platform: "  facebook  ", url: "https://example.org/doctor/facebook" },
    { platform: "__proto__", url: "https://example.org/doctor/profile" },
    { platform: "Đ".repeat(190), url: "https://example.org/doctor/official" }
  ];
  const canonical = Object.fromEntries(pairs.map((entry) => [entry.platform.trim(), entry.url]));
  for (const socialLinks of [pairs, JSON.stringify(pairs, null, 2)]) {
    const job = doctorJob(12, 101, {
      writer_claim_token: token, writer_claim_request_id: "social-links-attempt"
    });
    const api = loadBackground({ items: [job] });
    const result = doctorResult(12, undefined, { social_links_json: socialLinks,
      future_editorial_field: { nullable: null, values: [1, false, { evidence: "kept" }], url: { unknown_contract_kept: true } } });
    const before = plain(result);
    const expected = { items: [{ ...before, social_links_json: canonical, writer_claim_token: token }] };

    assert.deepEqual(plain(api.buildDoctorUpdatePayload(job, result)), expected);
    assert.deepEqual(result, before, "building transport JSON must not rewrite the native or JSON-encoded AI social links");
    assert.equal(api.calls.length, 0, "the builder and preflight remain local");

    await api.updateDoctorContent(job, result);

    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].url, UPDATE_URL);
    assert.deepEqual(api.calls[0].body, expected, "native and legacy pairs must both POST a canonical object with all other fields intact");
    assert.deepEqual(result, before);
    assert.equal(result.writer_claim_token, undefined);
  }
});

test("doctor payload keeps canonical native and JSON-encoded social-link objects byte-for-byte unchanged", () => {
  const api = loadBackground(), job = doctorJob(12, 101, { writer_claim_token: token });
  const canonical = { "Website Hệ thống Y tế Thu Cúc TCI": "https://benhvienthucuc.vn",
    "  facebook  ": " https://example.org/doctor/facebook " };
  for (const socialLinks of [canonical, JSON.stringify(canonical, null, 2), [], " [] ", null]) {
    const result = doctorResult(12, undefined, { social_links_json: socialLinks });
    const before = plain(result);
    assert.deepEqual(plain(api.buildDoctorUpdatePayload(job, result)), { items: [{ ...before, writer_claim_token: token }] });
    assert.deepEqual(result, before, "canonical data and legacy formatting must not be normalized as a compatibility list");
  }
  assert.equal(api.calls.length, 0);
});

test("doctor social-link compatibility rejects ambiguous pairs with exact indexed paths and no mutation or POST", async () => {
  const api = loadBackground(), job = doctorJob(12, 101, { writer_claim_token: token });
  const validUrl = "https://benhvienthucuc.vn";
  const invalid = [
    ["social_links_json[0].platform", [{ url: validUrl }]],
    ...[null, 7, false, {}, [], "", " \t\n ", "a".repeat(191), "  " + "a".repeat(189), "Facebook\0Official", "Đ".repeat(191)]
      .map((platform) => ["social_links_json[0].platform", [{ platform, url: validUrl }]]),
    ["social_links_json[0].url", [{ platform: "Website" }]],
    ...[null, "", " ", 7, false, { url: validUrl }, [validUrl], "javascript:alert(1)", "ftp://example.org/profile",
      "[Website](https://benhvienthucuc.vn)", "https://user:password@example.org/profile", "/doctor/profile"]
      .map((url) => ["social_links_json[0].url", [{ platform: "Website", url }]]),
    ["social_links_json[1].platform", [{ platform: "facebook", url: validUrl }, { platform: " facebook ", url: validUrl }]],
    ["social_links_json[0].source_ids", [{ platform: "Website", url: validUrl, source_ids: ["s1"] }]],
    ["social_links_json[0].alternative_url", [{ platform: "Website", url: validUrl, alternative_url: "https://example.org/profile" }]],
    ["social_links_json[0].", [{ platform: "Website", url: validUrl, "": { evidence: "must not discard" } }]],
    ...[validUrl, null, 7, false, [validUrl]].map((entry) => ["social_links_json[0]", [entry]]),
    ["social_links_json.platform", [{ platform: "0", url: validUrl }]],
    ["social_links_json.platform", [{ platform: "0", url: validUrl }, { platform: "1", url: validUrl }]],
    ["social_links_json.platform", [{ platform: "1", url: validUrl }, { platform: "0", url: validUrl }]]
  ];
  for (const [field, pairs] of invalid) {
    for (const socialLinks of [pairs, JSON.stringify(pairs)]) {
      const result = doctorResult(12, undefined, { social_links_json: socialLinks }), before = plain(result);
      assert.throws(() => api.buildDoctorUpdatePayload(job, result), (error) => assertDoctorUrlError(error, field),
        `must reject ${field}=${JSON.stringify(socialLinks)}`);
      await assert.rejects(api.updateDoctorContent(job, result), (error) => assertDoctorUrlError(error, field));
      assert.deepEqual(result, before, "failed compatibility conversion must retain all original pairs, including extra evidence fields");
    }
  }
  assert.equal(api.calls.length, 0, "all malformed social-link results must be rejected before contacting the doctor endpoint");
});

test("doctor completion sends normalized social links but stores the original full native or legacy JSON and raw response", async () => {
  const pairs = [{ platform: "Website Hệ thống Y tế Thu Cúc TCI", url: "https://benhvienthucuc.vn" }];
  const canonical = { "Website Hệ thống Y tế Thu Cúc TCI": "https://benhvienthucuc.vn" };
  for (const socialLinks of [pairs, JSON.stringify(pairs)]) {
    const result = doctorResult(12, undefined, { social_links_json: socialLinks }), before = plain(result);
    const rawResponse = "```json\n" + JSON.stringify(result, null, 2) + "\n```";
    const api = loadBackground({ items: [doctorJob()] });
    await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
    const worker = plain(api.state.runner.workers["tab-101"]);

    const completed = await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
      article: result, rawResponse }, api.sender(101));

    assert.equal(completed.updated, true);
    const posts = api.calls.filter((call) => call.url.startsWith(UPDATE_URL));
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, { items: [{ ...before, social_links_json: canonical, writer_claim_token: token }] });
    const stored = (await api.jobStorage.get("items")).items.find((item) => item.doctor_id === 12);
    assert.equal(stored.status, "hoàn tất");
    assert.equal(stored.has_result, true);
    assert.deepEqual(plain(stored.result), before, "the saved audit result is the full original AI JSON, not the transport adaptation");
    assert.equal(stored.rawResponse, rawResponse);
    assert.deepEqual(result, before);
    assert.equal(api.calls.some((call) => call.url.includes("facility-content-update.php")), false);
  }
});

test("malformed doctor URL completion retains full JSON and raw output without sending a POST", async () => {
  const invalid = doctorResult(12, undefined, { website_url: { url: "https://example.org/doctor" },
    future_editorial_field: { nullable: null, nested: [1, false, { original: "kept" }] } });
  const api = loadBackground({ items: [doctorJob()] });
  await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  const rawResponse = "```json\n" + JSON.stringify(invalid) + "\n```";
  const completed = await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
    article: invalid, rawResponse }, api.sender(101));
  assert.equal(completed.updated, false);
  const stored = (await api.jobStorage.get("items")).items.find((item) => item.doctor_id === 12);
  assert.equal(stored.status, "lỗi cập nhật");
  assert.equal(stored.has_result, true);
  assert.deepEqual(plain(stored.result), invalid, "the complete malformed research stays recoverable, not replaced by a sanitized subset");
  assert.equal(stored.rawResponse, rawResponse);
  assert.match(stored.api_error, /website_url/);
  assert.match(stored.api_error, /URL/);
  assert.equal(api.calls.some((call) => call.url.startsWith(UPDATE_URL)), false, "preflight rejects the result before any doctor update request");
  const direct = loadBackground(), job = doctorJob(12, 101, { writer_claim_token: token });
  await assert.rejects(direct.updateDoctorContent(job, invalid), (error) => assertDoctorUrlError(error, "website_url"));
  assert.equal(direct.calls.length, 0, "the direct update path also guards against malformed URL submissions");
});

test("doctor payload cannot modify operational fields or omit the current server contract", () => {
  const api = loadBackground(), result = doctorResult();
  const job = doctorJob(12, 101, { writer_claim_token: token,
    output_template: { id: 12, name: result.name, content: null, sources_json: [], evidence_json: {}, insufficient_data: true, newly_required_field: null } });
  assert.throws(() => api.buildDoctorUpdatePayload(job, result), /newly_required_field/);
  const complete = { ...result, newly_required_field: null };
  for (const field of ["verified", "slug", "facility_slug", "display_order", "created_at", "updated_at", "rating_avg", "ratings_count", "view_count", "rating", "reviews_count", "language_code", "translation_of_id", "reviewed_by", "last_researched_at"]) {
    assert.throws(() => api.buildDoctorUpdatePayload(job, { ...complete, [field]: "do-not-modify" }), new RegExp(field));
  }
  assert.throws(() => api.buildDoctorUpdatePayload(job, { ...complete, insufficient_data: "false" }), /boolean/);
  assert.throws(() => api.buildDoctorUpdatePayload(job, { ...complete, insufficient_data: true, notes_for_editor: "" }), /notes_for_editor/);
  assert.deepEqual(plain(api.buildDoctorUpdatePayload(job, complete).items[0].newly_required_field), null);
});

test("doctor update uses doctor endpoint and only confirms the current record in 200 or mixed 207", async () => {
  const job = doctorJob(12, 101, { writer_claim_token: token, writer_claim_request_id: "attempt-12" });
  for (const status of [200, 207]) {
    const success = { id: 12, writer_request_id: "attempt-12", insufficient_data: false, writer_released: true };
    const api = loadBackground({}, (url) => url.startsWith(UPDATE_URL) ? response({
      ok: status === 200, updated_count: 1, updated: [success], results: [success],
      errors: status === 207 ? [{ index: 1, id: 99, status: 422, message: "another record invalid" }] : []
    }, status) : undefined);
    const saved = await api.updateDoctorContent(job, doctorResult());
    assert.ok(saved.updated.some((item) => item.id === 12));
    const post = api.calls.find((call) => call.options.method === "POST");
    assert.equal(post.url, UPDATE_URL);
    assert.equal(post.body.items[0].writer_claim_token, token);
    assert.equal(post.options.headers["X-Medical-Api-Key"], "test-medical-key");
    assert.equal(post.options.signal, undefined, "website writes are not aborted by a list timeout");
  }
  const absent = loadBackground({}, (url) => url.startsWith(UPDATE_URL)
    ? response({ ok: true, updated_count: 1, updated: [{ id: 99 }], results: [{ id: 99 }], errors: [] }) : undefined);
  await assert.rejects(absent.updateDoctorContent(job, doctorResult()), /99|ID|xác nhận/);
});

test("doctor 409 and indexed 422/207 errors cannot be reported as successful saves", async () => {
  const job = doctorJob(12, 101, { writer_claim_token: token, writer_claim_request_id: "attempt-12" });
  for (const status of [409, 422, 207]) {
    const api = loadBackground({}, (url) => url.startsWith(UPDATE_URL) ? response({
      ok: false, updated_count: status === 207 ? 1 : 0,
      updated: status === 207 ? [{ id: 99 }] : [], results: status === 207 ? [{ id: 99 }] : [],
      errors: [{ index: 0, id: 12, status: status === 409 ? 409 : 422,
        reason: status === 409 ? "lease_lost_or_expired" : undefined, message: "index zero validation failed" }]
    }, status) : undefined);
    await assert.rejects(api.updateDoctorContent(job, doctorResult()), new RegExp(`${status}|422|409|index zero`));
  }
});

test("ambiguous doctor POST is confirmed by matching server request receipt, never another owner's receipt", async () => {
  const job = doctorJob(12, 101, { writer_claim_token: token, writer_claim_request_id: "attempt-12", doctor_writer_request_id: "attempt-12" });
  for (const requestId of ["attempt-12", "other-owner"]) {
    const api = loadBackground({}, (url) => {
      if (url.startsWith(UPDATE_URL)) throw new Error("connection closed after POST");
      if (url.startsWith(CONTENT_URL)) return response({ ok: true, item: doctorSource(12, job.name, {
        content: "<p>Saved</p>", last_researched_at: "2026-10-02 06:00:00",
        full_json: { ...doctorResult(), writer_request_id: requestId }
      }) });
      return undefined;
    });
    const receipt = await api.readDoctorReceipt(job);
    assert.equal(receipt.confirmed, requestId === "attempt-12");
    if (requestId === "attempt-12") {
      const saved = await api.updateDoctorContent(job, doctorResult());
      assert.ok(saved, "saved receipt can resolve an ambiguous POST without another AI run");
    } else await assert.rejects(api.updateDoctorContent(job, doctorResult()), /connection|khác|xác nhận|request/i);
    assert.equal(api.calls.filter((call) => call.url.startsWith(UPDATE_URL)).length, 1);
    assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, 0);
  }
});

test("doctor receipt requires completed research and a stable request id", async () => {
  for (const override of [{ last_researched_at: null }, { full_json: { writer_request_id: "other" } }]) {
    const api = loadBackground({}, (url) => url.startsWith(CONTENT_URL) ? response({ ok: true, item: doctorSource(12, undefined, {
      last_researched_at: "2026-10-02 06:00:00", full_json: { writer_request_id: "attempt-12" }, ...override
    }) }) : undefined);
    assert.equal((await api.readDoctorReceipt(doctorJob(12, 101, { writer_claim_request_id: "attempt-12" }))).confirmed, false);
  }
});

test("doctor recheck replaces a stale prompt with the fresh item contract and rejects no-longer-eligible jobs", async () => {
  const job = doctorJob(12, 101, { prompt: "OLD-CACHED-PROMPT", prompt_source: "old" });
  const api = loadBackground({ items: [job] }, (url) => url.startsWith(DOCTORS_URL) ? response({ ok: true, items: [doctorSource(12, job.name, {
    prompt: "NEW-SERVER-CONTRACT", prompt_source: "admin", output_template: { id: 12, name: job.name, new_field: null }
  })] }) : undefined);
  const refreshed = await api.revalidateDoctorJob(job);
  assert.equal(refreshed.prompt, "NEW-SERVER-CONTRACT");
  assert.equal(refreshed.prompt_source, "admin");
  assert.equal(refreshed.id, job.id, "source refresh must not replace the tab-local job identifier");
  assert.equal(refreshed.doctor_id, 12);
  assert.deepEqual(plain(refreshed.output_template), { id: 12, name: job.name, new_field: null });
  assert.equal(new URL(api.calls[0].url).searchParams.get("ids"), "12");
  const ineligible = loadBackground({}, (url) => url.startsWith(DOCTORS_URL) ? response({ ok: true, items: [] }) : undefined);
  await assert.rejects(ineligible.revalidateDoctorJob(job), (error) => error.doctorIneligible === true);
});

test("two doctor tabs receive different server claims and never leak claim/API credentials into prompts", async () => {
  const api = loadBackground({ items: [doctorJob(12, 101), doctorJob(34, 202, { name: "BS. Bình", title: "BS. Bình" })] });
  await Promise.all([
    api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101)),
    api.startRun({ sourceType: "doctor", targetTabId: 202 }, api.sender(202))
  ]);
  const prompts = api.sent.filter((entry) => entry.message.type === "run-article");
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.map((entry) => entry.message.article.doctor_id).sort((a, b) => a - b), [12, 34]);
  for (const call of api.calls.filter((call) => call.body?.action === "claim")) {
    assert.equal(call.body.type, "doctor");
    assert.equal(call.body.client.task, "doctor_article");
  }
  for (const entry of prompts) {
    assert.equal(entry.message.article.writer_claim_token, undefined);
    assert.equal(entry.message.article.writer_claim_request_id, undefined);
    assert.equal(entry.message.prompt.includes(token), false);
    assert.equal(entry.message.prompt, `SERVER-DOCTOR-PROMPT-${entry.message.article.doctor_id}`);
  }
});

test("two doctor tabs competing for the same doctor cannot both dispatch its prompt", async () => {
  const api = loadBackground({ items: [doctorJob(12, 101), doctorJob(12, 202)] });
  await Promise.all([
    api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101)),
    api.startRun({ sourceType: "doctor", targetTabId: 202 }, api.sender(202))
  ]);
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, 1);
  assert.equal(api.calls.filter((call) => call.body?.action === "claim" && call.body.type === "doctor").length, 1);
});

test("remote doctor claim conflicts skip the stale record without starting AI", async () => {
  for (const reason of ["already_claimed", "content_exists", "not_published"]) {
    const api = loadBackground({ items: [doctorJob()] }, (url, options, body) => url.startsWith(CLAIM_URL) && body.action === "claim"
      ? response({ ok: true, claimed: false, reason, writer: { provider: "gemini", worker_id: "remote-owner" } }, 409) : undefined);
    await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
    assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
    assert.equal(api.state.runner.workers["tab-101"].currentId, null);
  }
});

test("doctor, facility and doctor translation queues remain independent in three concurrent tabs", async () => {
  const facility = { id: "tab-202:facility-12", facility_id: 12, ownerTabId: 202, sourceType: "facility",
    title: "Cơ sở A", prompt: "FACILITY-PROMPT", status: "chờ" };
  const translation = { id: "tab-303:translation-doctor-12", source_id: 12, ownerTabId: 303,
    sourceType: "translation", type: "doctor", translation_type: "doctor", title: "Dịch bác sĩ",
    prompt: "TRANSLATION-PROMPT", translation_fields: ["content"], output_template: { content: "" }, status: "chờ" };
  const api = loadBackground({ items: [doctorJob(), facility, translation] });
  await Promise.all([
    api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101)),
    api.startRun({ sourceType: "facility", targetTabId: 202 }, api.sender(202)),
    api.startRun({ sourceType: "translation", translationType: "doctor", targetTabId: 303 }, api.sender(303))
  ]);
  const prompts = api.sent.filter((entry) => entry.message.type === "run-article");
  assert.equal(prompts.length, 3);
  assert.deepEqual(prompts.map((entry) => entry.message.article.sourceType).sort(), ["doctor", "facility", "translation"]);
  assert.deepEqual(api.calls.filter((call) => call.body?.action === "claim").map((call) => call.body.type).sort(), ["doctor", "facility"]);
  for (const entry of prompts) assert.equal(entry.message.article.ownerTabId, entry.id);
});

test("insufficient doctor research is completed once and is not sent to facility endpoint or retried as AI failure", async () => {
  const job = doctorJob(12, 101, { writer_claim_token: token, writer_claim_required: true,
    writer_claim_request_id: "attempt-12", status: "đang viết" });
  const result = doctorResult(12, job.name, { content: null, sources_json: [],
    education_json: [], evidence_json: { identity_status: "insufficient", missing_fields: ["identity"], conflicts: [] },
    insufficient_data: true, notes_for_editor: "Không thể đối chiếu đúng người từ nguồn công khai." });
  const api = loadBackground({ items: [job] });
  await api.finishJob(job.id, result, JSON.stringify(result));
  const saved = api.state.items.find((item) => item.id === job.id);
  assert.equal(saved.status, "hoàn tất");
  assert.equal(saved.api_update.updated[0].insufficient_data, true);
  assert.equal(api.calls.some((call) => call.url.includes("facility-content-update.php")), false);
  assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
});

test("cold pending doctor updates reconcile matching saved receipts without another POST or prompt", async () => {
  const job = doctorJob(12, 101, { status: "đang cập nhật", result: doctorResult(),
    doctor_writer_request_id: "attempt-12", writer_claim_request_id: "attempt-12",
    api_request_started_at: new Date(Date.now() - 35 * 60000).toISOString() });
  const api = loadBackground({ items: [job] }, (url) => url.startsWith(CONTENT_URL) ? response({ ok: true,
    item: doctorSource(12, job.name, { last_researched_at: "2026-10-02 06:00:00", content: "saved",
      full_json: { ...doctorResult(), writer_request_id: "attempt-12" } }) }) : undefined);
  await api.reconcileDoctorPendingUpdates();
  assert.equal(api.state.items.find((item) => item.id === job.id).status, "hoàn tất");
  assert.equal(api.calls.some((call) => call.options.method === "POST"), false);
  assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
});

test("doctor heartbeat continues while JSON is being uploaded and normalizes Unix-second expiry", async () => {
  const job = doctorJob(12, 101, { status: "đang cập nhật", writer_claim_token: token,
    writer_claim_required: true, writer_claim_type: "doctor", writer_claim_id: 12,
    writer_claim_expires_at: new Date(Date.now() + 90000).toISOString() });
  const api = loadBackground({ items: [job] });
  await api.heartbeatActiveWriterClaims();
  const heartbeat = api.calls.find((call) => call.body?.action === "heartbeat");
  assert.ok(heartbeat, "upload/parse/retry work must not silently let the 180-second lease expire");
  assert.equal(heartbeat.body.type, "doctor");
  assert.equal(heartbeat.body.id, 12);
  const storedExpiry = api.state.items.find((item) => item.id === job.id).writer_claim_expires_at;
  assert.ok(Number.isFinite(Date.parse(storedExpiry)), "the actual API returns Unix seconds, not an ISO string");
  assert.ok(Date.parse(storedExpiry) > Date.now());
});

test("lost doctor heartbeat lease cannot submit stale AI output under another record", async () => {
  const api = loadBackground({ items: [doctorJob()] }, (url, options, body) => url.startsWith(CLAIM_URL) && body.action === "heartbeat"
    ? response({ ok: false, reason: "lease_lost" }, 409) : undefined);
  await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  await api.heartbeatActiveWriterClaims();
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
    article: doctorResult(), rawResponse: JSON.stringify(doctorResult()) }, api.sender(101));
  assert.equal(api.calls.some((call) => call.url.startsWith(UPDATE_URL)), false);
  assert.equal(api.calls.some((call) => call.url.includes("facility-content-update.php")), false);
});

test("canceling doctor work releases the current owner token and does not stop another tab", async () => {
  const api = loadBackground({ items: [doctorJob(12, 101), doctorJob(34, 202)] });
  await Promise.all([
    api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101)),
    api.startRun({ sourceType: "doctor", targetTabId: 202 }, api.sender(202))
  ]);
  await api.stopRun({ targetTabId: 101 }, api.sender(101));
  const released = api.calls.filter((call) => call.body?.action === "release");
  assert.deepEqual(released.map((call) => call.body.id), [12]);
  assert.equal(released[0].body.claim_token, token);
  assert.equal(api.state.runner.workers["tab-202"].active, true);
  assert.ok(api.state.runner.workers["tab-202"].currentId);
});

test("doctor queue 401/403/503 stops Spark safely without an endless provider retry", async () => {
  for (const status of [401, 403, 503]) {
    const job = doctorJob(12, 404);
    const api = loadBackground({ items: [job] }, (url) => url.startsWith(DOCTORS_URL)
      ? response({ ok: false, message: "Doctor API unavailable" }, status) : undefined);
    await api.startRun({ sourceType: "doctor", targetTabId: 404 }, api.sender(404));
    const worker = api.state.runner.workers?.["tab-404"];
    assert.notEqual(worker?.active, true, `HTTP ${status} requires configuration/backend repair, not another Spark prompt`);
    assert.equal(api.retryTimers.length, 0);
    assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
    assert.equal(api.calls.some((call) => call.body?.action === "claim"), false);
    const diagnostic = [worker?.lastError, worker?.lastMessage, ...api.state.items.map((item) => item.error)].join(" ");
    assert.match(diagnostic, new RegExp(String(status)));
  }
});

test("doctor claim auth/schema failures pause Spark without sending AI or scheduling repeated AI retries", async () => {
  for (const status of [401, 403, 503]) {
    const api = loadBackground({ items: [doctorJob(12, 404)] }, (url, options, body) => url.startsWith(CLAIM_URL) && body.action === "claim"
      ? response({ ok: false, message: "Writer claim configuration unavailable" }, status) : undefined);
    await api.startRun({ sourceType: "doctor", targetTabId: 404 }, api.sender(404));
    assert.notEqual(api.state.runner.workers?.["tab-404"]?.active, true);
    assert.equal(api.retryTimers.length, 0);
    assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
  }
});

test("ambiguous doctor claim retries retain request id, worker and install identity", async () => {
  let requests = 0;
  const api = loadBackground({ items: [doctorJob()] }, (url, options, body) => {
    if (url.startsWith(CLAIM_URL) && body.action === "claim" && ++requests === 1) throw new Error("Claim response connection lost");
    return undefined;
  });
  await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
  const claims = api.calls.filter((call) => call.body?.action === "claim");
  assert.equal(claims.length, 2);
  assert.equal(claims[0].body.request_id, claims[1].body.request_id);
  assert.deepEqual(claims[0].body.client, claims[1].body.client);
  assert.ok(claims[0].body.request_id);
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, 1);
});

test("a stale ineligible queued doctor is skipped before claiming and the next eligible doctor can run", async () => {
  const api = loadBackground({ items: [doctorJob(12, 101), doctorJob(34, 101)] }, (url) => {
    if (!url.startsWith(DOCTORS_URL)) return undefined;
    const ids = new URL(url).searchParams.get("ids");
    return ids === "12" ? response({ ok: true, items: [] }) : undefined;
  });
  await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
  const prompts = api.sent.filter((entry) => entry.message.type === "run-article");
  assert.deepEqual(prompts.map((entry) => entry.message.article.doctor_id), [34]);
  assert.equal(api.calls.some((call) => call.body?.action === "claim" && call.body.id === 12), false);
  assert.equal(api.state.runner.workers["tab-101"].currentId, "tab-101:doctor-34");
});

test("doctor manual retry checks its already-saved receipt before claiming or POSTing again", async () => {
  const job = doctorJob(12, 101, { status: "lỗi cập nhật", result: doctorResult(),
    doctor_writer_request_id: "attempt-12", writer_claim_request_id: "attempt-12" });
  const api = loadBackground({ items: [job] }, (url) => url.startsWith(CONTENT_URL) ? response({ ok: true,
    item: doctorSource(12, job.name, { last_researched_at: "2026-10-02 06:00:00", content: "saved",
      full_json: { ...doctorResult(), writer_request_id: "attempt-12" } }) }) : undefined);
  const result = await api.retryUpdate(job.id);
  assert.equal(result.ok, true);
  assert.equal(api.state.items.find((item) => item.id === job.id).status, "hoàn tất");
  assert.equal(api.calls.some((call) => call.options.method === "POST"), false);
  assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
});

test("doctor manual retry of an unsaved result keeps its original claim attempt and only resends JSON", async () => {
  const job = doctorJob(12, 101, { status: "lỗi cập nhật", result: doctorResult(),
    doctor_writer_request_id: "attempt-12", writer_claim_request_id: "attempt-12",
    workerKey: "tab-101", provider: "grok" });
  const api = loadBackground({ items: [job] });
  const result = await api.retryUpdate(job.id);
  assert.equal(result.ok, true);
  const claim = api.calls.find((call) => call.body?.action === "claim");
  assert.ok(claim);
  assert.equal(claim.body.request_id, "attempt-12");
  assert.equal(claim.body.client.worker_id, "tab-101");
  assert.equal(claim.body.client.task, "doctor_article");
  assert.equal(api.calls.filter((call) => call.url.startsWith(UPDATE_URL)).length, 1);
  assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
});

test("doctor manual retry of a prior social-link shape error sends the full normalized record on its doctor endpoint", async () => {
  const pairs = [{ platform: "Website Hệ thống Y tế Thu Cúc TCI", url: "https://benhvienthucuc.vn" }];
  const canonical = { "Website Hệ thống Y tế Thu Cúc TCI": "https://benhvienthucuc.vn" };
  const configuredUrl = "https://doctor-api.example.org/doctor-content-update.php";
  for (const socialLinks of [pairs, JSON.stringify(pairs)]) {
    const original = doctorResult(12, undefined, { social_links_json: socialLinks });
    const rawResponse = "```json\n" + JSON.stringify(original, null, 2) + "\n```";
    const job = doctorJob(12, 101, { status: "lỗi cập nhật", result: original, rawResponse, has_result: true,
      api_error: "social_links_json: cần object tên nền tảng:chuỗi URL hoặc mảng rỗng [].",
      doctor_writer_request_id: "prior-social-attempt", writer_claim_request_id: "prior-social-attempt",
      workerKey: "tab-101", provider: "grok" });
    const api = loadBackground({ items: [job], "tab-api-settings:101": { doctorUpdateUrl: configuredUrl } },
      (url, options, body) => url === configuredUrl ? response({ ok: true, updated_count: 1,
        updated: [{ id: body.items[0].id, writer_request_id: "prior-social-attempt", insufficient_data: false, writer_released: true }], errors: [] }) : undefined);

    const retried = await api.retryUpdate(job.id);

    assert.equal(retried.ok, true);
    const updates = api.calls.filter((call) => call.options.method === "POST" && call.body?.items);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].url, configuredUrl, "a stored doctor retry must retain that tab's doctor endpoint");
    assert.deepEqual(updates[0].body, { items: [{ ...original, social_links_json: canonical, writer_claim_token: token }] });
    assert.equal(api.calls.find((call) => call.body?.action === "claim").body.request_id, "prior-social-attempt");
    const stored = (await api.jobStorage.get("items")).items.find((item) => item.id === job.id);
    assert.equal(stored.status, "hoàn tất");
    assert.deepEqual(plain(stored.result), original);
    assert.equal(stored.rawResponse, rawResponse);
    assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false, "manual retry must not rerun the AI prompt");
  }
});

test("periodic runner recovery confirms cold doctor save before scheduling another job", async () => {
  const job = doctorJob(12, 101, { status: "đang cập nhật", result: doctorResult(),
    doctor_writer_request_id: "attempt-12", writer_claim_request_id: "attempt-12",
    api_request_started_at: new Date(Date.now() - 2 * 60000).toISOString() });
  const api = loadBackground({ items: [job], runner: {
    active: true, workers: { "tab-101": { active: true, currentId: job.id, sourceType: "doctor",
      provider: "grok", targetTabId: 101, runToken: "run-12" } }
  } }, (url) => url.startsWith(CONTENT_URL) ? response({ ok: true,
    item: doctorSource(12, job.name, { last_researched_at: "2026-10-02 06:00:00", content: "saved",
      full_json: { ...doctorResult(), writer_request_id: "attempt-12" } }) }) : undefined);
  await api.getAlarmListener()({ name: "medreview-runner-recovery" });
  assert.equal(api.state.items.find((item) => item.id === job.id).status, "hoàn tất");
  assert.equal(api.calls.some((call) => call.options.method === "POST"), false);
  assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
});

test("an ambiguous unsaved doctor POST retains JSON and its lease without advancing the queue", async () => {
  const api = loadBackground({ items: [doctorJob(12), doctorJob(34)] }, (url) => {
    if (url.startsWith(UPDATE_URL)) throw new Error("POST response disconnected");
    return undefined;
  });
  await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  const completed = await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
    article: doctorResult() }, api.sender(101));
  assert.equal(completed.unconfirmed, true);
  assert.equal(api.state.items.find((item) => item.doctor_id === 12).status, "chưa xác nhận");
  assert.equal(api.state.items.find((item) => item.doctor_id === 12).writer_claim_token, token);
  assert.equal(api.state.items.find((item) => item.doctor_id === 12).has_result, true);
  await api.getAlarmListener()({ name: "medreview-runner-recovery" });
  assert.equal(api.state.runner.workers["tab-101"].currentId, worker.currentId);
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, 1);
  assert.equal(api.calls.some((call) => call.body?.action === "release"), false);
});

test("receipt recovery wins over a late original POST and does not advance a new job twice", async () => {
  let rejectPost, enteredPost;
  const entered = new Promise((resolve) => { enteredPost = resolve; });
  let receiptSaved = false;
  const api = loadBackground({ items: [doctorJob(12), doctorJob(34)] }, (url, options, body, context) => {
    if (url.startsWith(UPDATE_URL)) {
      enteredPost();
      return new Promise((resolve, reject) => { rejectPost = reject; });
    }
    if (url.startsWith(CONTENT_URL) && receiptSaved) {
      const job = context.state.items.find((item) => item.doctor_id === 12);
      return response({ ok: true, item: doctorSource(12, job.name, {
        last_researched_at: "2026-10-02 06:00:00", insufficient_data: "0",
        full_json: { ...doctorResult(), writer_request_id: job.doctor_writer_request_id }
      }) });
    }
    return undefined;
  });
  await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
  const original = plain(api.state.runner.workers["tab-101"]);
  const finishing = api.handleArticleComplete({ articleId: original.currentId, runToken: original.runToken,
    article: doctorResult() }, api.sender(101));
  await entered;
  const { items } = await api.jobStorage.get("items");
  items.find((item) => item.doctor_id === 12).api_request_started_at = new Date(Date.now() - 120000).toISOString();
  await api.jobStorage.set({ items });
  receiptSaved = true;
  await api.getAlarmListener()({ name: "medreview-runner-recovery" });
  assert.equal(api.state.items.find((item) => item.doctor_id === 12).status, "hoàn tất");
  assert.equal(api.state.items.find((item) => item.doctor_id === 12).insufficient_data, false);
  assert.equal(api.state.runner.workers["tab-101"].currentId, "tab-101:doctor-34");
  rejectPost(new Error("Late network failure"));
  await finishing;
  assert.equal(api.state.runner.workers["tab-101"].currentId, "tab-101:doctor-34");
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, 2);
  assert.equal(api.calls.filter((call) => call.url.startsWith(UPDATE_URL)).length, 1);
});

test("doctor upload auth/schema errors pause only their worker and preserve output", async () => {
  for (const status of [401, 403, 503]) {
    const api = loadBackground({ items: [doctorJob(12, 101), doctorJob(34, 202)] }, (url) => url.startsWith(UPDATE_URL)
      ? response({ ok: false, message: "Doctor save unavailable" }, status) : undefined);
    await Promise.all([api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101)),
      api.startRun({ sourceType: "doctor", targetTabId: 202 }, api.sender(202))]);
    const worker = plain(api.state.runner.workers["tab-101"]);
    await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
      article: doctorResult() }, api.sender(101));
    assert.equal(api.state.runner.workers["tab-101"].active, false);
    assert.equal(api.state.runner.workers["tab-202"].active, true);
    const current = api.state.items.find((item) => item.doctor_id === 12);
    assert.equal(current.status, "lỗi cập nhật");
    assert.equal(current.has_result, true);
    assert.match(current.api_error, new RegExp(String(status)));
  }
});

test("stopping while a doctor save is pending retains its receipt lease and stops subsequent jobs", async () => {
  const job = doctorJob(12, 101, { status: "đang cập nhật", has_result: true,
    writer_claim_token: token, writer_claim_request_id: "attempt-12", doctor_writer_request_id: "attempt-12" });
  const api = loadBackground({ items: [job], runner: { active: true, workers: { "tab-101": {
    active: true, currentId: job.id, sourceType: "doctor", provider: "grok", targetTabId: 101, runToken: "run-12"
  } } } });
  await api.stopRun({ targetTabId: 101 }, api.sender(101));
  assert.equal(api.state.items[0].writer_claim_token, token);
  assert.equal(api.calls.some((call) => call.body?.action === "release"), false);
  assert.equal(api.state.runner.active, false);
});

test("missing save request identity cannot be accepted as a doctor success", async () => {
  const job = doctorJob(12, 101, { writer_claim_token: token, writer_claim_request_id: "attempt-12" });
  const api = loadBackground({}, (url) => url.startsWith(UPDATE_URL)
    ? response({ ok: true, updated: [{ id: 12 }], errors: [] }) : undefined);
  await assert.rejects(api.updateDoctorContent(job, doctorResult()), /ID 12|mã yêu cầu/);
});

test("doctor save lease_lost response remains a terminal stale-result marker after release", async () => {
  const api = loadBackground({ items: [doctorJob()] }, (url) => url.startsWith(UPDATE_URL)
    ? response({ ok: false, errors: [{ index: 0, id: 12, status: 409, reason: "lease_lost_or_expired", message: "Lease expired" }] }, 409)
    : undefined);
  await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken, article: doctorResult() }, api.sender(101));
  const stored = api.state.items.find((item) => item.doctor_id === 12);
  assert.equal(stored.writer_claim_lost, true);
  assert.equal(stored.has_result, true);
  await assert.rejects(api.retryUpdate(stored.id), /Khóa bác sĩ đã mất/);
  assert.equal(api.calls.filter((call) => call.url.startsWith(UPDATE_URL)).length, 1);
});

function doctorLegalFields() {
  return {
    professional_profile_url: "https://example.org/doctor/12",
    practice_license_type: "Giấy phép hành nghề", practice_license_number: "012345/AB",
    practice_license_issuer: "Sở Y tế", practice_license_issued_date: "2024-02-29",
    practice_license_scope: "Nội khoa", practice_registry_url: null,
    practice_registration_json: [{ facility_name: "Bệnh viện A", department: "Nội khoa",
      scope: null, schedule_text: "Theo lịch công khai", source_ids: ["s1"] }],
    legal_documents_json: [{ document_type: "Giấy phép", title: "Thông tin công khai",
      number: "012345/AB", issuer: "Sở Y tế", issued_date: "2024-02-29", url: null, source_ids: ["s1"] }],
    legal_notes: "Chỉ ghi thông tin có nguồn; không kết luận hiệu lực giấy phép.", legal_source_ids_json: ["s1"]
  };
}

test("all 11 additive legal fields preserve their types and values and follow the dynamic template", () => {
  const api = loadBackground(), legal = doctorLegalFields();
  assert.equal(Object.keys(legal).length, 11);
  const result = doctorResult(12, undefined, legal);
  const job = doctorJob(12, 101, { writer_claim_token: token,
    output_template: { ...doctorSource().output_template, ...Object.fromEntries(Object.keys(legal).map((key) => [key, null])) } });
  const before = plain(result);
  assert.deepEqual(plain(api.buildDoctorUpdatePayload(job, result)), { items: [{ ...result, writer_claim_token: token }] });
  assert.deepEqual(result, before);
  for (const key of Object.keys(legal)) {
    const incomplete = { ...result };
    delete incomplete[key];
    assert.throws(() => api.buildDoctorUpdatePayload(job, incomplete), new RegExp(key));
  }
});

test("fatal doctor heartbeat pauses only its tab and preserves late complete JSON without a POST", async () => {
  for (const status of [401, 403, 503]) {
    for (const body of [{ ok: false, message: "Heartbeat unavailable" }, "<html>Heartbeat unavailable</html>"]) {
      const api = loadBackground({ items: [doctorJob(12, 101), doctorJob(34, 202)] }, (url, options, request) =>
        url.startsWith(CLAIM_URL) && request.action === "heartbeat" && request.id === 12 ? response(body, status) : undefined);
      await Promise.all([api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101)),
        api.startRun({ sourceType: "doctor", targetTabId: 202 }, api.sender(202))]);
      const worker = plain(api.state.runner.workers["tab-101"]);
      const original = plain(api.state.items.find((item) => item.doctor_id === 12));
      await api.heartbeatActiveWriterClaims();
      assert.equal(api.state.runner.workers["tab-101"].active, false);
      assert.equal(api.state.runner.workers["tab-202"].active, true);
      assert.equal(api.state["tab-doctor-queue:101"].httpStatus, status);
      assert.ok(api.sent.some((entry) => entry.id === 101 && entry.message.type === "stop-article"));
      assert.equal(api.sent.some((entry) => entry.id === 202 && entry.message.type === "stop-article"), false);
      const result = doctorResult(12, undefined, doctorLegalFields());
      await api.handleArticleComplete({ articleId: worker.currentId, runToken: "stale-run", article: result }, api.sender(101));
      assert.equal(api.state.items.find((item) => item.doctor_id === 12).has_result, false);
      const completed = await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
        article: result, rawResponse: "complete legal research JSON" }, api.sender(101));
      assert.equal(completed.updated, false);
      const stored = (await api.jobStorage.get("items")).items.find((item) => item.doctor_id === 12);
      assert.deepEqual(plain(stored.result), result);
      assert.equal(stored.rawResponse, "complete legal research JSON");
      assert.equal(stored.writer_claim_token, original.writer_claim_token);
      assert.equal(stored.writer_claim_request_id, original.writer_claim_request_id);
      assert.equal(stored.doctor_writer_request_id, original.doctor_writer_request_id);
      assert.equal(api.calls.some((call) => call.url.startsWith(UPDATE_URL)), false);
      assert.equal(api.calls.some((call) => call.body?.action === "release"), false);
    }
  }
});

test("fatal doctor heartbeat at completion retains the entire result and does not submit", async () => {
  for (const status of [401, 403, 503]) {
    const api = loadBackground({ items: [doctorJob()] }, (url, options, request) =>
      url.startsWith(CLAIM_URL) && request.action === "heartbeat" ? response({ ok: false, message: "Heartbeat unavailable" }, status) : undefined);
    await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
    const worker = plain(api.state.runner.workers["tab-101"]);
    const result = doctorResult(12, undefined, doctorLegalFields());
    const completed = await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
      article: result, rawResponse: "full response" }, api.sender(101));
    assert.equal(completed.paused, true);
    const stored = (await api.jobStorage.get("items")).items[0];
    assert.deepEqual(plain(stored.result), result);
    assert.equal(stored.rawResponse, "full response");
    assert.equal(api.state.runner.workers["tab-101"].active, false);
    assert.equal(api.calls.some((call) => call.url.startsWith(UPDATE_URL)), false);
  }
});

test("doctor manual retry retains the original lease on fatal heartbeat and resends only JSON after recovery", async () => {
  let unavailable = true;
  const api = loadBackground({ items: [doctorJob()] }, (url, options, request) =>
    url.startsWith(CLAIM_URL) && request.action === "heartbeat" && unavailable
      ? response({ ok: false, message: "Heartbeat unavailable" }, 503) : undefined);
  await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
    article: doctorResult(), rawResponse: "kept research" }, api.sender(101));
  const original = plain(api.state.items[0]);
  const failedRetry = await api.retryUpdate(worker.currentId);
  assert.equal(failedRetry.ok, false);
  assert.equal(api.state.items[0].writer_claim_token, original.writer_claim_token);
  assert.equal(api.state.items[0].writer_claim_request_id, original.writer_claim_request_id);
  assert.equal(api.state.items[0].doctor_writer_request_id, original.doctor_writer_request_id);
  assert.equal(api.calls.some((call) => call.body?.action === "release"), false);
  assert.equal(api.calls.some((call) => call.url.startsWith(UPDATE_URL)), false);
  unavailable = false;
  assert.equal((await api.retryUpdate(worker.currentId)).ok, true);
  assert.equal(api.calls.filter((call) => call.body?.action === "claim").length, 1);
  assert.equal(api.calls.filter((call) => call.url.startsWith(UPDATE_URL)).length, 1);
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, 1);
  const stored = (await api.jobStorage.get("items")).items[0];
  assert.equal(stored.status, "hoàn tất");
  assert.equal(stored.rawResponse, "kept research");
  assert.equal(stored.doctor_heartbeat_halt, undefined);
});

test("fatal heartbeat during a pending doctor POST never releases or duplicates its receipt lease", async () => {
  let fatal = false, resolvePost, enteredPost;
  const entered = new Promise((resolve) => { enteredPost = resolve; });
  const api = loadBackground({ items: [doctorJob(12), doctorJob(34)] }, (url, options, request, context) => {
    if (url.startsWith(CLAIM_URL) && request.action === "heartbeat" && fatal) return response({ ok: false, message: "Heartbeat unavailable" }, 503);
    if (url.startsWith(UPDATE_URL)) {
      enteredPost();
      return new Promise((resolve) => { resolvePost = () => {
        const job = context.state.items.find((item) => item.doctor_id === 12);
        const updated = [{ id: 12, writer_request_id: job.doctor_writer_request_id, insufficient_data: false }];
        resolve(response({ ok: true, updated_count: 1, updated, errors: [] }));
      }; });
    }
    return undefined;
  });
  await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  const finishing = api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
    article: doctorResult(), rawResponse: "full JSON" }, api.sender(101));
  await entered;
  const original = plain(api.state.items.find((item) => item.doctor_id === 12));
  fatal = true;
  await api.heartbeatActiveWriterClaims();
  const pending = (await api.jobStorage.get("items")).items.find((item) => item.doctor_id === 12);
  assert.equal(pending.status, "đang cập nhật");
  assert.equal(pending.writer_claim_token, original.writer_claim_token);
  assert.equal(pending.doctor_writer_request_id, original.doctor_writer_request_id);
  assert.deepEqual(plain(pending.result), doctorResult());
  assert.equal(pending.rawResponse, "full JSON");
  assert.equal(api.state.runner.workers["tab-101"].active, false);
  assert.equal(api.calls.some((call) => call.body?.action === "release"), false);
  resolvePost();
  await finishing;
  assert.equal(api.state.items.find((item) => item.doctor_id === 12).status, "hoàn tất");
  assert.equal(api.state.runner.workers["tab-101"].active, false);
  assert.equal(api.calls.filter((call) => call.url.startsWith(UPDATE_URL)).length, 1);
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, 1);
});

test("a transient doctor heartbeat network error still lets the atomic update validate its token", async () => {
  const api = loadBackground({ items: [doctorJob()] }, (url, options, request) => {
    if (url.startsWith(CLAIM_URL) && request.action === "heartbeat") throw new Error("Transient network error");
    return undefined;
  });
  await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  const completed = await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
    article: doctorResult() }, api.sender(101));
  assert.equal(completed.updated, true);
  assert.equal(api.calls.filter((call) => call.url.startsWith(UPDATE_URL)).length, 1);
});

test("non-JSON doctor upload auth/schema responses retain HTTP status and pause without dropping JSON", async () => {
  for (const status of [401, 403, 503]) {
    const api = loadBackground({ items: [doctorJob()] }, (url) => url.startsWith(UPDATE_URL)
      ? response("<html>Upstream unavailable</html>", status) : undefined);
    await api.startRun({ sourceType: "doctor", targetTabId: 101 }, api.sender(101));
    const worker = plain(api.state.runner.workers["tab-101"]);
    await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
      article: doctorResult(), rawResponse: "original JSON" }, api.sender(101));
    assert.equal(api.state.runner.workers["tab-101"].active, false);
    const stored = (await api.jobStorage.get("items")).items[0];
    assert.equal(stored.status, "lỗi cập nhật");
    assert.deepEqual(plain(stored.result), doctorResult());
    assert.equal(stored.rawResponse, "original JSON");
    assert.match(stored.api_error, new RegExp(`HTTP ${status}`));
  }
});

test("doctor receipt failures preserve HTTP status for both JSON and non-JSON responses", async () => {
  for (const status of [401, 403, 503]) {
    for (const body of [{ ok: false, message: "Read unavailable" }, "<html>Read unavailable</html>"]) {
      const api = loadBackground({}, (url) => url.startsWith(CONTENT_URL) ? response(body, status) : undefined);
      await assert.rejects(api.readDoctorReceipt(doctorJob(12, 101, { doctor_writer_request_id: "attempt-12" })),
        (error) => error.httpStatus === status && error.message.includes(`HTTP ${status}`));
    }
  }
});
