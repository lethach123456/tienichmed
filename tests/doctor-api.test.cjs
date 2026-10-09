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
  let alarmListener;
  const owned = new Map();
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
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
