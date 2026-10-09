const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// All requests stay inside this VM mock: these tests never contact MedReview or AI.
const BASE = "https://medreview.vn/api/medical/";
const QUEUE_URL = BASE + "facilities-needing-image-fix.php";
const UPDATE_URL = BASE + "facility-image-fix-update.php";
const CLAIM_URL = BASE + "writer-claim.php";
const token = "c".repeat(64);
const revision = "a".repeat(64);
const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const cover = "/uploads/library/clinic/cover.jpg";
const aiImage = "/uploads/library/clinic/ai.jpg";
const blockedImage = "https://clinic.example/blocked.jpg?size=large&branch=71";
const googleImage = "https://lh3.googleusercontent.com/p/verified-photo-id=w1600-h1200?authuser=0&hl=vi&foo=a%2Bb";

function imageFixSource(id = 71, extra = {}) {
  const images = [
    { url: cover, inspection_url: "https://medreview.vn" + cover, fields: ["image_url", "gallery_json[0]"], metadata: [{ caption: "Mặt tiền", custom: "preserved" }] },
    { url: aiImage, inspection_url: "https://medreview.vn" + aiImage, fields: ["ai_image_url"], metadata: [] },
    { url: blockedImage, inspection_url: blockedImage, fields: ["gallery_json[1]"], metadata: [] }
  ];
  return {
    id, name: "Phòng khám đúng chi nhánh", title: "Phòng khám đúng chi nhánh", type: "facility",
    address_text: "71 Nguyễn Huệ", language_code: "vi", status: "published",
    content: "<p>Existing article content is not a disqualifier.</p>",
    image_url: cover, ai_image_url: aiImage,
    gallery_json: [{ url: cover, caption: "Mặt tiền", custom: "preserved" }, blockedImage],
    images, images_count: images.length, images_revision: revision, target_images: 6,
    prompt: `SERVER-IMAGE-FIX-PROMPT-${id}`, prompt_type: "facility_image_fix",
    prompt_label: "Fix ảnh cơ sở y tế", prompt_source: "custom", writer_claimed: false,
    output_template: {
      id, images_revision: revision,
      inspected_images: images.map(({ url }) => ({ url, decision: "uncertain", reason: "Chưa xác minh", evidence_url: "", http_status: null })),
      added_images: [], image_url: cover, ai_image_url: aiImage, insufficient_images: false, notes: ""
    },
    ...extra
  };
}

function imageFixJob(id = 71, ownerTabId = 101, extra = {}) {
  return { ...imageFixSource(id), id: `tab-${ownerTabId}:facility_image_fix-${id}`,
    facility_id: id, sourceType: "facility_image_fix", ownerTabId, status: "chờ", ...extra };
}

function imageFixResult(id = 71, extra = {}) {
  return {
    id, images_revision: revision,
    inspected_images: [
      { url: cover, decision: "keep", reason: "Đúng chi nhánh", evidence_url: "https://maps.google.com/?cid=71", http_status: 200 },
      { url: aiImage, decision: "keep", reason: "Ảnh nguồn còn dùng được", evidence_url: "", http_status: 200 },
      { url: blockedImage, decision: "uncertain", reason: "Host trả 403, chưa đủ bằng chứng ảnh hỏng", evidence_url: "", http_status: 403 }
    ],
    added_images: [{ url: googleImage, angle: "Mặt tiền", caption: "Đúng biển hiệu", source: "Google Maps", source_url: "https://maps.google.com/?cid=71" }],
    image_url: cover, ai_image_url: aiImage, insufficient_images: false, notes: "Đã đối chiếu đúng địa chỉ.",
    ...extra
  };
}

function replacementImages(count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    url: index === 0 ? googleImage : `https://clinic.example/replacement-${index}.jpg`,
    angle: `Góc ảnh ${index + 1}`, caption: "Đúng chi nhánh", source: "Trang chính thức",
    source_url: "https://clinic.example/official-gallery"
  }));
}

function insufficientRemovalFixture(id = 91) {
  const images = Array.from({ length: 7 }, (_, index) => ({
    url: `https://clinic.example/facility-${id}/original-${index}.jpg`,
    inspection_url: `https://clinic.example/facility-${id}/original-${index}.jpg`,
    fields: index === 0 ? ["image_url", "gallery_json[0]"] : [`gallery_json[${index}]`], metadata: []
  }));
  const source = imageFixSource(id, { image_url: images[0].url, ai_image_url: "", images,
    images_count: images.length, gallery_json: images.map(({ url }) => ({ url })) });
  const result = imageFixResult(id, { image_url: source.image_url, ai_image_url: "", added_images: [],
    inspected_images: images.map(({ url }, index) => index < 5
      ? { url, decision: "uncertain", reason: "Chưa xem được ảnh thật", evidence_url: "", http_status: 403 }
      : { url, decision: "remove", reason: "Xác nhận ảnh thuộc cơ sở khác", evidence_url: "https://clinic.example/official-gallery", http_status: 200 }),
    insufficient_images: true, notes: { inspected: 7, uncertain: 5, removed: 2, added: 0 } });
  return { source, result };
}

function claimedJob(id = 71, ownerTabId = 101, extra = {}) {
  return imageFixJob(id, ownerTabId, {
    writer_claim_token: token, writer_claim_required: true, writer_claim_type: "facility",
    writer_claim_id: id, writer_claim_task: "facility_image_fix", writer_claim_request_id: `attempt-${id}`,
    writer_claim_expires_at: new Date(Date.now() + 150000).toISOString(), ...extra
  });
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status,
    async text() { return typeof data === "string" ? data : JSON.stringify(data); },
    async json() { return plain(data); } };
}

function synchronousImageReceipt(id = 71, processing = "completed", extra = {}) {
  const partial = processing === "partial";
  return {
    ok: true, updated_count: 1, errors: [],
    image_processing: processing,
    warnings: partial ? [{ index: 0, id, message: "Đã lưu JSON; một ảnh chưa tải được." }] : [],
    updated: [{
      id, already_processed: false, images_queued: 0,
      images_imported: partial ? 1 : 2, images_failed: partial ? 1 : 0,
      image_processing: processing, images_revision: "b".repeat(64),
      image_results: [
        { source_url: googleImage, local_url: "/uploads/library/facility-71/source.webp", ok: true, updated: true },
        partial
          ? { source_url: blockedImage, ok: false, error: "Không tải được ảnh: HTTP 403" }
          : { source_url: blockedImage, local_url: "/uploads/library/facility-71/second.webp", ok: true, updated: true }
      ],
      ...extra
    }]
  };
}

function loadBackground(initial = {}, fetchOverride) {
  const state = plain({ sourceType: "facility_image_fix", nextJobDelayMs: 0, items: [], runner: { active: false }, ...initial });
  const tabs = new Map([
    [101, { id: 101, url: "https://grok.com/c/fix-one" }],
    [202, { id: 202, url: "https://chatgpt.com/c/fix-two" }],
    [303, { id: 303, url: "https://gemini.google.com/spark/chat/image-fix-task" }]
  ]);
  const calls = [], sent = [], events = [], alarms = [], retryTimers = [], owned = new Map();
  let alarmListener;
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: {
      async get(keys) { const wanted = keys == null ? Object.keys(state) : Array.isArray(keys) ? keys : [keys];
        return plain(Object.fromEntries(wanted.filter((key) => key in state).map((key) => [key, state[key]]))); },
      async set(values) { Object.assign(state, plain(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; }
    } },
    tabs: {
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      async get(id) { const tab = tabs.get(Number(id)); if (!tab) throw new Error("No tab"); return plain(tab); },
      async query(query) { return query.active ? [plain(tabs.get(101))] : [...tabs.values()].map(plain); },
      async sendMessage(id, message) { const entry = { id, message: plain(message) }; sent.push(entry); events.push({ kind: "message", ...entry });
        return message.type === "runner-ready" ? { ok: true, ready: true } : { ok: true, started: true }; },
      async update() {}, async reload() {}
    },
    scripting: { async executeScript() {} },
    alarms: { create(name, options) { alarms.push({ name, options: plain(options) }); },
      onAlarm: { addListener(listener) { alarmListener = listener; } } }
  };
  const fetch = async (url, options = {}) => {
    const address = String(url), body = options.body ? JSON.parse(options.body) : null;
    const call = { url: address, options: plain(options), body }; calls.push(call); events.push({ kind: "fetch", ...call });
    const override = fetchOverride && await fetchOverride(address, options, body, { state, calls, sent, events, owned });
    if (override !== undefined) return override;
    if (address.startsWith(CLAIM_URL)) {
      const key = `${body.type}-${body.id}`;
      if (body.action === "claim") {
        const previous = owned.get(key);
        if (previous && previous !== body.request_id) return response({ ok: true, claimed: false, reason: "already_claimed" }, 409);
        owned.set(key, body.request_id);
        return response({ ok: true, claimed: true, claim_token: token, expires_at: Math.floor(Date.now() / 1000) + 180,
          lease_seconds: 180, heartbeat_interval_seconds: 45 });
      }
      if (body.action === "release") { owned.delete(key); return response({ ok: true, released: true }); }
      return response({ ok: true, expires_at: Math.floor(Date.now() / 1000) + 180, lease_seconds: 180 });
    }
    if (address.startsWith(QUEUE_URL)) {
      const params = new URL(address).searchParams, ids = params.get("ids");
      return response({ ok: true, contract_version: 1, task: "facility_image_fix", prompt_type: "facility_image_fix",
        claim_required: true, claim_task: "facility_image_fix", language: params.get("language") || "vi", next_after_id: null,
        items: ids ? ids.split(",").map((id) => imageFixSource(Number(id), { language_code: params.get("language") || "vi" })) : [], errors: [] });
    }
    if (address.startsWith(UPDATE_URL)) return response({ ok: true, updated_count: 1,
      updated: [{ id: body.items[0].id, already_processed: false, images_revision: "b".repeat(64), images_queued: body.items[0].added_images.length }],
      errors: [], warnings: [], image_processing: "queued" });
    if (options.method === "POST") return response({ ok: true, updated_ids: [body.items[0].id], updated_count: 1, errors: [] });
    return response({ ok: true, items: [] });
  };
  const testSetTimeout = (callback, delay) => {
    if (delay === 5000) { const handle = { mockRetry: retryTimers.length }; retryTimers.push(callback); return handle; }
    return setTimeout(callback, delay);
  };
  const testClearTimeout = (handle) => { if (!handle || handle.mockRetry == null) clearTimeout(handle); };
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key", chrome, fetch, URL, AbortController, setTimeout: testSetTimeout,
    clearTimeout: testClearTimeout, structuredClone });
  const code = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8") + `
    globalThis.__imageFixApiTests = {
      fetchFacilityImageFixes, buildFacilityImageFixPayload, updateFacilityImageFix,
      revalidateFacilityImageFixJob, retryFacilityImageFixUpdate, isFacilityImageFixItem, replaceQueueItems, handleArticleFailed,
      mergeQueueItems, startRun, stopRun, heartbeatActiveWriterClaims, handleArticleComplete,
      refreshQueue, runNext, finishJob, retryUpdate, jobStorage, getJobMetadata, getArticleContent, retryFacilityImageFixResearch, reconcileStaleApiUpdates,
      queueItemIdentityKey, queueItemSource, recoverIdleWorkers
    };
  `;
  vm.runInContext(code, context, { filename: "background.js" });
  return { ...context.__imageFixApiTests, state, calls, sent, events, alarms, tabs, owned, retryTimers,
    getAlarmListener() { return alarmListener; }, sender(id) { return { tab: plain(tabs.get(id)) }; } };
}

const posts = (api) => api.calls.filter((call) => call.url.startsWith(UPDATE_URL));
const prompts = (api) => api.sent.filter((entry) => entry.message.type === "run-article");
const hydrated = async (api, id) => (await api.jobStorage.get("items")).items.find((item) => item.id === id);

test("expired Fix ảnh token is authoritatively renewed before POST; takeover blocks POST", async () => {
  for (const lost of [false, true]) {
    const job = claimedJob(71, 101, { status: "lỗi cập nhật", result: imageFixResult(),
      writer_claim_expires_at: new Date(Date.now() - 60000).toISOString() });
    const api = loadBackground({ items: [job] }, (url, options, body) => {
      if (url.startsWith(CLAIM_URL) && body.action === "heartbeat" && lost)
        return response({ ok: false, reason: "lease_lost" }, 409);
    });
    if (lost) await assert.rejects(api.updateFacilityImageFix(job, job.result), /Khóa|khóa/);
    else await api.updateFacilityImageFix(job, job.result);
    assert.equal(posts(api).length, lost ? 0 : 1);
    assert.equal(api.calls[0].body.action, "heartbeat");
    assert.equal(api.calls[0].body.claim_token, token);
    assert.equal(api.calls.some((call) => call.body?.action === "claim"), false);
  }
});

test("worker restart hydrates exact pending receipt and never revokes it as lease_lost", async () => {
  const job = claimedJob(71, 101, { status: "chưa xác nhận", image_fix_api_pending: true,
    result: imageFixResult(), writer_claim_expires_at: new Date(Date.now() - 60000).toISOString() });
  const first = loadBackground();
  const body = JSON.stringify(first.buildFacilityImageFixPayload(job, job.result));
  job.image_fix_payload = body;
  await first.jobStorage.set({ items: [job] });
  assert.equal(first.state.items[0].image_fix_payload, undefined);
  const restarted = loadBackground(first.state, (url, options, request) =>
    url.startsWith(CLAIM_URL) && request.action === "heartbeat" ? response({ ok: false, reason: "lease_lost" }, 409) : undefined);
  await restarted.heartbeatActiveWriterClaims();
  assert.equal(restarted.calls.some((call) => call.body?.action === "heartbeat"), false);
  const saved = await hydrated(restarted, job.id);
  assert.equal(saved.writer_claim_token, token);
  assert.equal(saved.writer_claim_lost, undefined);
  assert.equal(saved.image_fix_payload, body);
  await restarted.updateFacilityImageFix(saved, {});
  assert.equal(posts(restarted)[0].options.body, body);
});

test("pending flag with malformed receipt cannot suppress actual lease loss", async () => {
  const job = claimedJob(71, 101, { status: "chưa xác nhận", image_fix_api_pending: true,
    image_fix_payload: JSON.stringify({ items: [{ id: 99, images_revision: revision, writer_claim_token: token }] }) });
  const api = loadBackground({ items: [job] }, (url, options, body) =>
    url.startsWith(CLAIM_URL) && body.action === "heartbeat" ? response({ ok: false, reason: "lease_lost" }, 409) : undefined);
  await api.heartbeatActiveWriterClaims();
  const saved = await hydrated(api, job.id);
  assert.equal(saved.writer_claim_lost, true);
  assert.equal(saved.image_fix_api_pending, false);
  assert.equal(saved.image_fix_requires_research, true);
});

test("completed JSON survives transient renewal failure with expired local lease", async () => {
  let offline = false;
  const api = loadBackground({ items: [imageFixJob()] }, (url, options, body) => {
    if (offline && url.startsWith(CLAIM_URL) && body.action === "heartbeat") throw new Error("Offline");
  });
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  const state = await api.jobStorage.get("items");
  state.items[0].writer_claim_expires_at = new Date(Date.now() - 60000).toISOString();
  await api.jobStorage.set(state);
  offline = true;
  const result = imageFixResult();
  const response = await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
    article: result, rawResponse: "RAW JSON" }, api.sender(101));
  assert.equal(response.retryable, true);
  const saved = await hydrated(api, worker.currentId);
  assert.deepEqual(plain(saved.result), result);
  assert.equal(saved.rawResponse, "RAW JSON");
  assert.equal(saved.api_error_code, "heartbeat_unconfirmed");
  assert.equal(saved.writer_claim_token, token);
  assert.equal(posts(api).length, 0);
});

test("image-fix GET uses its own tab endpoint, remembered IDs, language and untouched server contract", async () => {
  const api = loadBackground({ "tab-api-settings:101": {
    facilityImageFixUrl: QUEUE_URL + "?page=3&limit=25&language=en&only_pending=0&target_images=9&recheck_days=60"
  } });
  const list = await api.fetchFacilityImageFixes([71, 72], 101, "en");
  const request = api.calls[0], url = new URL(request.url);
  assert.equal(url.origin + url.pathname, QUEUE_URL);
  assert.equal(url.searchParams.get("ids"), "71,72");
  for (const [key, value] of Object.entries({ language: "en", limit: "25", only_pending: "0", target_images: "9", recheck_days: "60" })) assert.equal(url.searchParams.get(key), value);
  assert.equal(request.options.headers["X-Medical-Api-Key"], "test-medical-key");
  assert.equal(list.items[0].prompt, "SERVER-IMAGE-FIX-PROMPT-71");
  assert.deepEqual(plain(list.items[0].output_template), imageFixSource().output_template);
  assert.deepEqual(plain(list.items[0].images), imageFixSource().images);
  await api.fetchFacilityImageFixes([], 101, "en", 72);
  assert.equal(new URL(api.calls[1].url).searchParams.get("after_id"), "72");
});

test("undeployed image-fix endpoint and schema/prompt failures are errors, never an empty queue", async () => {
  for (const status of [404, 503]) {
    const api = loadBackground({}, (url) => url.startsWith(QUEUE_URL)
      ? response({ ok: false, reason: "schema_not_ready", message: "Run image-fix migration separately" }, status) : undefined);
    await assert.rejects(api.fetchFacilityImageFixes([], 101), new RegExp(String(status)));
    await assert.rejects(api.refreshQueue("facility_image_fix", "facility", 101), new RegExp(String(status)));
    assert.equal(api.state.items.length, 0);
    assert.equal(prompts(api).length, 0);
  }
});

test("image-fix source is distinct from article/image generation and refreshes waiting snapshots only", () => {
  const api = loadBackground();
  const waiting = imageFixJob(), writing = imageFixJob(72, 101, { status: "đang viết" }), completed = imageFixJob(73, 101, { status: "hoàn tất" });
  const fresh = (id) => imageFixSource(id, { images_revision: "b".repeat(64), image_url: googleImage,
    images: [{ url: googleImage, inspection_url: googleImage, fields: ["image_url"], metadata: [] }],
    gallery_json: [{ url: googleImage }], prompt: `NEW-${id}`, output_template: { ...imageFixResult(id), images_revision: "b".repeat(64) } });
  const merged = api.mergeQueueItems([waiting, writing, completed], [fresh(71), fresh(72), fresh(73)], "facility_image_fix", "facility", 101);
  const pending = merged.items.find((item) => item.facility_id === 71);
  assert.equal(api.isFacilityImageFixItem(pending), true);
  assert.equal(api.queueItemSource(pending), "facility_image_fix");
  assert.equal(pending.images_revision, "b".repeat(64));
  assert.equal(pending.image_url, googleImage);
  assert.deepEqual(plain(pending.images), fresh(71).images);
  assert.deepEqual(plain(pending.gallery_json), fresh(71).gallery_json);
  assert.deepEqual(plain(pending.output_template), fresh(71).output_template);
  assert.equal(pending.prompt, "NEW-71");
  assert.equal(merged.items.find((item) => item.facility_id === 72).images_revision, revision);
  assert.equal(merged.items.find((item) => item.facility_id === 73).prompt, completed.prompt);
  assert.notEqual(api.queueItemIdentityKey(pending), api.queueItemIdentityKey({ ...pending, sourceType: "facility" }));
  assert.notEqual(api.queueItemIdentityKey(pending), api.queueItemIdentityKey({ ...pending, sourceType: "ai-image" }));
});

test("image-fix claims facility/task first, then re-fetches same EN ID, then dispatches the fresh prompt privately", async () => {
  const fresh = imageFixSource(71, { language_code: "en", images_revision: "b".repeat(64), prompt: "FRESH-ADMIN-FIX-PROMPT" });
  const api = loadBackground({ items: [imageFixJob(71, 101, { language_code: "en", prompt: "STALE-PROMPT" })] },
    (url) => url.startsWith(QUEUE_URL) ? response({ ok: true, items: [fresh] }) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const claimIndex = api.events.findIndex((event) => event.body?.action === "claim");
  const refreshIndex = api.events.findIndex((event) => event.kind === "fetch" && event.url.startsWith(QUEUE_URL) && new URL(event.url).searchParams.get("ids") === "71");
  const dispatchIndex = api.events.findIndex((event) => event.message?.type === "run-article");
  assert.ok(claimIndex >= 0 && refreshIndex > claimIndex && dispatchIndex > refreshIndex, "claim → current source by ID → AI dispatch is mandatory");
  const claim = api.events[claimIndex], refresh = api.events[refreshIndex], dispatch = api.events[dispatchIndex];
  assert.equal(claim.body.type, "facility");
  assert.equal(claim.body.id, 71);
  assert.equal(claim.body.client.task, "facility_image_fix");
  assert.equal(new URL(refresh.url).searchParams.get("language"), "en");
  assert.equal(dispatch.message.prompt, fresh.prompt);
  assert.equal(dispatch.message.article.images_revision, fresh.images_revision);
  for (const field of ["writer_claim_token", "claim_token", "writer_claim_request_id", "apiKey", "api_key"]) assert.equal(dispatch.message.article[field], undefined);
  assert.equal(JSON.stringify(dispatch.message).includes(token), false);
  assert.equal(JSON.stringify(dispatch.message).includes('"X-Medical-Api-Key"'), false);
});

test("post-claim image-fix disappearance releases lease and never dispatches stale prompt", async () => {
  const api = loadBackground({ items: [imageFixJob()] }, (url) => url.startsWith(QUEUE_URL) ? response({ ok: true, items: [] }) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  assert.equal(prompts(api).length, 0);
  assert.equal(api.calls.filter((call) => call.body?.action === "claim").length, 1);
  const release = api.calls.find((call) => call.body?.action === "release");
  assert.ok(release);
  assert.equal(release.body.type, "facility");
  assert.equal(release.body.id, 71);
  assert.equal(release.body.claim_token, token);
});

test("remote image-fix claim conflict cannot start AI", async () => {
  const api = loadBackground({ items: [imageFixJob()] }, (url, options, body) => url.startsWith(CLAIM_URL) && body.action === "claim"
    ? response({ ok: true, claimed: false, reason: "already_claimed", writer: { instance_label: "Other machine" } }, 409) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  assert.equal(prompts(api).length, 0);
  assert.equal(posts(api).length, 0);
});

test("two tabs cannot dispatch the same image-fix facility twice", async () => {
  const api = loadBackground({ items: [imageFixJob(71, 101), imageFixJob(71, 202)] });
  await Promise.all([api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101)),
    api.startRun({ sourceType: "facility_image_fix", targetTabId: 202 }, api.sender(202))]);
  assert.equal(prompts(api).length, 1);
  assert.equal(api.calls.filter((call) => call.body?.action === "claim").length, 1);
});

test("facility article and image-fix tasks share an anti-duplicate facility lease", async () => {
  const article = { id: "tab-202:facility-71", facility_id: 71, ownerTabId: 202, sourceType: "facility", title: "Article", prompt: "ARTICLE-PROMPT", status: "chờ" };
  const api = loadBackground({ items: [imageFixJob(71, 101), article] });
  await Promise.all([api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101)),
    api.startRun({ sourceType: "facility", targetTabId: 202 }, api.sender(202))]);
  assert.equal(prompts(api).length, 1);
  assert.equal(api.calls.filter((call) => call.body?.action === "claim" && call.body.type === "facility").length, 1);
});

test("different task queues remain per-tab and stopping image-fix does not stop an article worker", async () => {
  const article = { id: "tab-202:facility-72", facility_id: 72, ownerTabId: 202, sourceType: "facility", title: "Article", prompt: "ARTICLE-PROMPT", status: "chờ" };
  const api = loadBackground({ items: [imageFixJob(71, 101), article] });
  await Promise.all([api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101)),
    api.startRun({ sourceType: "facility", targetTabId: 202 }, api.sender(202))]);
  assert.equal(prompts(api).length, 2);
  for (const entry of prompts(api)) assert.equal(entry.message.article.ownerTabId, entry.id);
  const original = plain(api.state.runner.workers["tab-101"]);
  const publicStop = await api.stopRun({ targetTabId: 101 }, api.sender(101));
  assert.equal(JSON.stringify(publicStop).includes(token), false);
  assert.equal(api.state.runner.workers["tab-202"].active, true);
  const releases = api.calls.filter((call) => call.body?.action === "release");
  assert.deepEqual(releases.map((call) => call.body.id), [71]);
  await api.handleArticleComplete({ articleId: original.currentId, runToken: original.runToken, article: imageFixResult() }, api.sender(101));
  assert.equal(posts(api).length, 0, "late result from a cancelled tab cannot write");
});

test("image-fix payload is a strict image-only contract with private token and untouched query strings", () => {
  const api = loadBackground(), result = imageFixResult(), job = claimedJob();
  const payload = api.buildFacilityImageFixPayload(job, result);
  assert.deepEqual(plain(payload), { items: [{ ...result, writer_claim_token: token }] });
  assert.equal(result.writer_claim_token, undefined);
  assert.equal(payload.items[0].added_images[0].url, googleImage);
  assert.equal(payload.items[0].inspected_images[2].url, blockedImage);
  for (const field of ["content", "name", "address_text", "gallery_json", "rating_avg", "status", "prices_json", "reviews_json", "sources_json"]) {
    assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, [field]: "do-not-edit" }), new RegExp(`${field}|trường|field`));
  }
});

test("ID 91 with five uncertain, two removals and no additions cannot build a destructive payload", () => {
  const api = loadBackground(), { source, result } = insufficientRemovalFixture();
  const job = claimedJob(91, 101, source), original = plain(result);
  for (const insufficient_images of [false, true]) {
    assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, insufficient_images }),
      (error) => error.imageFixErrorCode === "insufficient_replacement_images");
  }
  assert.deepEqual(result, original, "failed validation never rewrites the original AI audit JSON");
  assert.equal(api.calls.length, 0);
});

test("blocked, unavailable or unevidenced keep decisions cannot satisfy the removal minimum", () => {
  const api = loadBackground(), { source, result } = insufficientRemovalFixture();
  const job = claimedJob(91, 101, source);
  const validKeep = { decision: "keep", reason: "Đã xem và xác minh đúng chi nhánh",
    evidence_url: "https://clinic.example/official-gallery", http_status: 200 };
  const invalidKeeps = [
    { ...validKeep, http_status: 403 },
    { ...validKeep, http_status: 404 },
    { ...validKeep, http_status: 410 },
    { ...validKeep, http_status: 500 },
    { ...validKeep, reason: "timeout - not viewable", http_status: null },
    { ...validKeep, reason: "Không thể truy cập ảnh do CAPTCHA", http_status: null },
    { ...validKeep, reason: "   " },
    { ...validKeep, evidence_url: "" }
  ];
  for (const invalidKeep of invalidKeeps) {
    const invalid = { ...result, inspected_images: result.inspected_images.map((review, index) =>
      index < 5 ? { ...review, ...invalidKeep } : review) };
    for (const insufficient_images of [false, true]) {
      assert.throws(() => api.buildFacilityImageFixPayload(job, { ...invalid, insufficient_images }),
        (error) => error.imageFixErrorCode === "insufficient_replacement_images",
        JSON.stringify(invalidKeep));
    }
  }
  assert.equal(api.calls.length, 0);
});

test("visually verified keep decisions with evidence and null HTTP status can satisfy the removal minimum", () => {
  const api = loadBackground(), { source, result } = insufficientRemovalFixture();
  const job = claimedJob(91, 101, source);
  const inspected_images = result.inspected_images.map((review, index) => index < 5
    ? { ...review, decision: "keep", reason: "Đã xem ảnh và đối chiếu biển hiệu, địa chỉ đúng chi nhánh",
      evidence_url: "https://clinic.example/official-gallery", http_status: null }
    : review);
  const verified = { ...result, inspected_images };
  assert.deepEqual(plain(api.buildFacilityImageFixPayload(job, verified).items[0]),
    { ...verified, notes: JSON.stringify(verified.notes), writer_claim_token: token });
  assert.equal(api.calls.length, 0);
});

test("removal minimum counts real keep decisions plus valid additions, not the AI image or uncertain sources", () => {
  const api = loadBackground(), job = claimedJob(71, 101, { target_images: 9 }), result = imageFixResult();
  const inspected_images = result.inspected_images.map((review) => review.url === blockedImage
    ? { ...review, decision: "remove", reason: "HTTP 404 confirmed", evidence_url: blockedImage, http_status: 404 } : review);
  // One real kept cover + three additions is four; the kept AI source cannot make five.
  assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, inspected_images, added_images: replacementImages(3) }),
    (error) => error.imageFixErrorCode === "insufficient_replacement_images");
  const boundary = { ...result, inspected_images, added_images: replacementImages(4), insufficient_images: true };
  assert.deepEqual(plain(api.buildFacilityImageFixPayload(job, boundary).items[0]), { ...boundary, writer_claim_token: token });
  assert.doesNotThrow(() => api.buildFacilityImageFixPayload(job, { ...boundary, added_images: replacementImages(5) }));
  const uncertainCover = inspected_images.map((review) => review.url === cover ? { ...review, decision: "uncertain" } : review);
  assert.throws(() => api.buildFacilityImageFixPayload(job, { ...boundary, inspected_images: uncertainCover }),
    (error) => error.imageFixErrorCode === "insufficient_replacement_images");
});

test("kept real source URLs can meet the removal minimum, and AI-only removal still requires five", () => {
  const api = loadBackground();
  for (const aiOnlyRemoval of [false, true]) {
    for (const [keptCount, addedCount, accepted] of [[4, 0, false], [4, 1, true], [5, 0, true]]) {
      const kept = Array.from({ length: keptCount }, (_, index) => ({
        url: `https://clinic.example/kept-${index}.jpg`, fields: [`gallery_json[${index}]`]
      }));
      const removed = { url: aiOnlyRemoval ? aiImage : blockedImage, fields: [aiOnlyRemoval ? "ai_image_url" : "gallery_json[5]"] };
      const job = claimedJob(71, 101, { image_url: kept[0].url, ai_image_url: aiOnlyRemoval ? aiImage : "",
        images: [...kept, removed], target_images: 9 });
      const result = imageFixResult(71, { image_url: kept[0].url, ai_image_url: "", added_images: replacementImages(addedCount),
        inspected_images: [...kept.map(({ url }) => ({ url, decision: "keep", reason: "Đã xác minh đúng chi nhánh", evidence_url: "https://clinic.example/official-gallery", http_status: 200 })),
          { url: removed.url, decision: "remove", reason: "HTTP 404 confirmed", evidence_url: removed.url, http_status: 404 }] });
      if (accepted) assert.doesNotThrow(() => api.buildFacilityImageFixPayload(job, result));
      else assert.throws(() => api.buildFacilityImageFixPayload(job, result),
        (error) => error.imageFixErrorCode === "insufficient_replacement_images");
    }
  }
});

test("AI-marked or duplicate source URLs never inflate the verified real keep count", () => {
  const api = loadBackground();
  for (const aiMarked of [false, true]) {
    const kept = Array.from({ length: 4 }, (_, index) => ({ url: `https://clinic.example/kept-${index}.jpg`, fields: [`gallery_json[${index}]`] }));
    const excluded = aiMarked
      ? { url: "https://clinic.example/metadata-ai.jpg", fields: ["image_url", "gallery_json[4]", "ai_image_url"] }
      : { ...kept[0], fields: ["image_url", "gallery_json[4]"] };
    const images = [...kept, excluded, { url: blockedImage, fields: ["gallery_json[5]"] }];
    const sourceUrls = [...new Set(images.map(({ url }) => url))];
    const job = claimedJob(71, 101, { image_url: kept[0].url, ai_image_url: "", images });
    const result = imageFixResult(71, { image_url: kept[0].url, ai_image_url: "", added_images: [],
      inspected_images: sourceUrls.map((url) => url === blockedImage
        ? { url, decision: "remove", reason: "HTTP 404 confirmed", evidence_url: url, http_status: 404 }
        : { url, decision: "keep", reason: "Đã kiểm tra", evidence_url: "https://clinic.example/official-gallery", http_status: 200 }) });
    assert.throws(() => api.buildFacilityImageFixPayload(job, result),
      (error) => error.imageFixErrorCode === "insufficient_replacement_images");
    assert.doesNotThrow(() => api.buildFacilityImageFixPayload(job, { ...result, added_images: replacementImages(1) }));
  }
});

test("insufficient results without remove remain valid even with no verified real images or additions", () => {
  const api = loadBackground(), job = claimedJob(), base = imageFixResult();
  const inspected_images = base.inspected_images.map((review) => ({ ...review, decision: "uncertain", http_status: 403 }));
  for (const insufficient_images of [false, true]) {
    const result = { ...base, inspected_images, added_images: [], insufficient_images };
    assert.deepEqual(plain(api.buildFacilityImageFixPayload(job, result).items[0]), { ...result, writer_claim_token: token });
  }
});

test("publishing insufficient removal requires research, preserves JSON/raw response and never POSTs", async () => {
  const { source, result } = insufficientRemovalFixture(), original = plain(result), rawResponse = JSON.stringify(result, null, 2);
  const api = loadBackground({ items: [imageFixJob(91, 101, { ...source, id: "tab-101:facility_image_fix-91", status: "chờ" })] },
    (url) => url.startsWith(QUEUE_URL) ? response({ ok: true, items: [source] }) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  const completion = await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
    article: result, rawResponse }, api.sender(101));
  const failed = await hydrated(api, worker.currentId);
  assert.equal(completion.updated, false, JSON.stringify(completion));
  assert.equal(failed.status, "lỗi cập nhật");
  assert.equal(failed.image_fix_requires_research, true);
  assert.equal(failed.image_fix_error_code, "insufficient_replacement_images");
  assert.equal(failed.api_error_code, "insufficient_replacement_images");
  assert.equal(failed.image_fix_api_pending, false);
  assert.equal(Boolean(failed.image_fix_import_pending), false);
  assert.equal(Boolean(failed.image_fix_payload), false, "a rejected contract cannot create a durable POST receipt");
  assert.deepEqual(plain(failed.result), original);
  assert.equal(failed.rawResponse, rawResponse);
  assert.deepEqual(result, original);
  assert.equal(api.state.runner.workers["tab-101"].active, false);
  assert.equal(posts(api).length, 0);
  await assert.rejects(api.retryFacilityImageFixUpdate(worker.currentId), /kiểm tra AI|ảnh nguồn|khóa/i);
  assert.equal(posts(api).length, 0);
  assert.equal(prompts(api).length, 1);
});

test("legacy below-minimum removal receipts replay byte-for-byte without applying a new destructive guard", async () => {
  const { source, result } = insufficientRemovalFixture();
  const originalBody = JSON.stringify({ items: [{ ...result, writer_claim_token: token }] }, null, 2);
  for (const importPending of [false, true]) {
    const job = claimedJob(91, 101, { ...source, id: "tab-101:facility_image_fix-91", result,
      status: importPending ? "ảnh chưa đủ" : "chưa xác nhận", image_fix_payload: originalBody,
      image_fix_api_pending: !importPending, image_fix_import_pending: importPending,
      image_fix_requires_research: true, writer_claim_lost: true, writer_claim_token: undefined,
      writer_claim_expires_at: new Date(Date.now() - 60000).toISOString() });
    const api = loadBackground({ items: [job] }, (url) => url.startsWith(UPDATE_URL)
      ? response(synchronousImageReceipt(91, "completed", { already_processed: true })) : undefined);
    assert.throws(() => api.buildFacilityImageFixPayload({ ...job, writer_claim_lost: false, writer_claim_token: token }, result),
      (error) => error.imageFixErrorCode === "insufficient_replacement_images");
    await api.retryFacilityImageFixUpdate(job.id);
    assert.equal((await hydrated(api, job.id)).status, "hoàn tất");
    assert.deepEqual(api.calls.map((call) => call.url), [UPDATE_URL]);
    assert.equal(posts(api)[0].options.body, originalBody);
    assert.equal(prompts(api).length, 0);
  }
});

test("image-fix payload rejects mismatched/string IDs, stale/missing revisions and missing required fields", () => {
  const api = loadBackground(), job = claimedJob(), valid = imageFixResult();
  for (const invalid of [{ ...valid, id: "71" }, { ...valid, id: 72 }, { ...valid, images_revision: "b".repeat(64) }, { ...valid, images_revision: "bad" }]) {
    assert.throws(() => api.buildFacilityImageFixPayload(job, invalid), /id|ID|revision|nguyên/);
  }
  for (const key of Object.keys(valid)) { const invalid = { ...valid }; delete invalid[key]; assert.throws(() => api.buildFacilityImageFixPayload(job, invalid), new RegExp(`${key}|thiếu|contract`)); }
  assert.throws(() => api.buildFacilityImageFixPayload({ ...job, writer_claim_token: null }, valid), /token|claim|khóa/i);
  assert.throws(() => api.buildFacilityImageFixPayload(job, { ...valid, insufficient_images: "false" }), /boolean/);
});

test("notes normalization accepts null and JSON values without mutating the original AI result", () => {
  const api = loadBackground(), job = claimedJob();
  const values = [[null, ""], ["  Ngắn gọn  ", "Ngắn gọn"], [["Maps đã rà", "Thiếu 2 ảnh"], '["Maps đã rà","Thiếu 2 ảnh"]'],
    [{ kept: 2, added: 5 }, '{"kept":2,"added":5}'], [false, "false"], [123, "123"]];
  for (const [notes, expected] of values) {
    const result = imageFixResult(71, { notes });
    const original = JSON.stringify(result);
    const payload = api.buildFacilityImageFixPayload(job, result);
    assert.equal(payload.items[0].notes, expected);
    assert.equal(JSON.stringify(result), original, "raw result remains available in extension storage");
    assert.deepEqual(plain(payload.items[0].inspected_images), result.inspected_images);
    assert.deepEqual(plain(payload.items[0].added_images), result.added_images);
  }
});

test("notes length uses Unicode code points and bounds only the transport text to 4000", () => {
  const api = loadBackground(), job = claimedJob();
  for (const character of ["a", "ệ", "🦷"]) {
    const boundary = imageFixResult(71, { notes: character.repeat(4000) });
    assert.equal(api.buildFacilityImageFixPayload(job, boundary).items[0].notes, boundary.notes);
    const result = imageFixResult(71, { notes: character.repeat(4001) });
    const payload = api.buildFacilityImageFixPayload(job, result);
    assert.equal(Array.from(payload.items[0].notes).length, 4000);
    assert.match(payload.items[0].notes, /Ghi chú đã rút gọn/);
    assert.equal(result.notes, character.repeat(4001), "unabridged original is not modified");
  }
  const structured = imageFixResult(71, { notes: { audit: "ệ".repeat(7000) } });
  assert.equal(Array.from(api.buildFacilityImageFixPayload(job, structured).items[0].notes).length, 4000);
  assert.equal(structured.notes.audit.length, 7000);
});

test("normalizing notes never relaxes destructive image validation or rewrites a retry receipt", async () => {
  const api = loadBackground(), job = claimedJob(), result = imageFixResult(71, { notes: "a".repeat(5000) });
  assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, images_revision: "b".repeat(64) }), /revision/);
  assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, inspected_images: [] }), /inspected_images/);
  assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, ai_image_url: "" }), /ai_image_url|remove/);
  const body = JSON.stringify(api.buildFacilityImageFixPayload(job, result));
  await api.updateFacilityImageFix({ ...job, image_fix_api_pending: true, image_fix_payload: body }, result);
  assert.equal(api.calls.find(call => call.url.startsWith(UPDATE_URL)).options.body, body);
});

test("every exact source URL must be inspected once; unknown/duplicate/inspection URLs cannot replace source URLs", () => {
  const api = loadBackground(), job = claimedJob(), result = imageFixResult();
  const invalidLists = [result.inspected_images.slice(1), [...result.inspected_images, result.inspected_images[0]],
    [result.inspected_images[0], result.inspected_images[0], result.inspected_images[2]],
    result.inspected_images.map((review, index) => index ? review : { ...review, url: "https://medreview.vn" + cover }),
    result.inspected_images.map((review, index) => index ? review : { ...review, url: "https://other.example/unknown.jpg" })];
  for (const inspected_images of invalidLists) assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, inspected_images }), /URL|url|inspected_images|nguồn|trùng/);
  assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result,
    inspected_images: result.inspected_images.map((review, index) => index ? review : { ...review, decision: "delete" }) }), /decision|keep|remove|uncertain/);
});

test("image-fix cannot remove temporary HTTP access failures or timeout uncertainty", () => {
  const api = loadBackground(), job = claimedJob(), result = imageFixResult(71, { added_images: replacementImages() });
  for (const http_status of [401, 403, 408, 429, 500, 503, 599]) {
    const inspected_images = result.inspected_images.map((review, index) => index === 2
      ? { ...review, decision: "remove", reason: "HTTP access failure", evidence_url: blockedImage, http_status } : review);
    assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, inspected_images }), /uncertain|tạm|remove|xóa|HTTP/);
  }
  const timeout = result.inspected_images.map((review, index) => index === 2
    ? { ...review, decision: "remove", reason: "timeout khi truy cập ảnh", evidence_url: blockedImage, http_status: null } : review);
  assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, inspected_images: timeout }), /uncertain|timeout|tạm|remove|xóa/i);
  assert.doesNotThrow(() => api.buildFacilityImageFixPayload(job, result));
  for (const status of [404, 410]) {
    const inspected_images = result.inspected_images.map((review, index) => index === 2
      ? { ...review, decision: "remove", reason: `URL không truy cập được (HTTP ${status} đã xác nhận)`, evidence_url: blockedImage, http_status: status } : review);
    assert.doesNotThrow(() => api.buildFacilityImageFixPayload(job, { ...result, inspected_images }));
  }
});

test("empty AI-image source accepts null or empty output without mutating AI JSON", () => {
  const api = loadBackground();
  for (const sourceAi of [null, ""]) {
    const job = claimedJob(85, 101, { ai_image_url: sourceAi,
      images: imageFixSource(85).images.filter((image) => image.url !== aiImage) });
    for (const resultAi of [null, ""]) {
      const result = imageFixResult(85, { ai_image_url: resultAi,
        inspected_images: imageFixResult(85).inspected_images.filter((review) => review.url !== aiImage) });
      const original = plain(result);
      const payload = plain(api.buildFacilityImageFixPayload(job, result));
      assert.equal(payload.items[0].ai_image_url, "");
      assert.deepEqual(payload.items[0], { ...original, ai_image_url: "", writer_claim_token: token });
      assert.deepEqual(result, original, "normalizing transport must not rewrite the saved AI response");
      assert.equal(job.ai_image_url, sourceAi, "source snapshot must remain unchanged");
    }
  }
  assert.equal(api.calls.length, 0, "contract validation performs no network requests");
});

test("null cannot clear a populated kept or uncertain AI image or coerce invalid types", () => {
  const api = loadBackground(), job = claimedJob();
  for (const decision of ["keep", "uncertain"]) {
    const result = imageFixResult();
    result.inspected_images = result.inspected_images.map((review) => review.url === aiImage ? { ...review, decision } : review);
    assert.equal(api.buildFacilityImageFixPayload(job, result).items[0].ai_image_url, aiImage);
    for (const ai_image_url of [null, "", googleImage]) {
      assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, ai_image_url }), /ai_image_url|ảnh AI/);
    }
  }
  const emptyJob = claimedJob(71, 101, { ai_image_url: null });
  for (const ai_image_url of [false, 0, [], {}, undefined]) {
    assert.throws(() => api.buildFacilityImageFixPayload(emptyJob, { ...imageFixResult(), ai_image_url }), /ai_image_url|ảnh AI/);
  }
  const missing = imageFixResult();
  delete missing.ai_image_url;
  assert.throws(() => api.buildFacilityImageFixPayload(emptyJob, missing), /thiếu ai_image_url/);
});

test("confirmed AI-image removal accepts null and empty output but not a replacement URL", () => {
  const api = loadBackground(), job = claimedJob(), result = imageFixResult(71, { added_images: replacementImages() });
  const inspected_images = result.inspected_images.map((review) => review.url === aiImage
    ? { ...review, decision: "remove", reason: "HTTP 404 confirmed", evidence_url: aiImage, http_status: 404 } : review);
  for (const ai_image_url of [null, ""]) {
    assert.equal(api.buildFacilityImageFixPayload(job, { ...result, inspected_images, ai_image_url }).items[0].ai_image_url, "");
  }
  assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, inspected_images, ai_image_url: googleImage }), /ai_image_url|ảnh AI/);
  for (const missing of ["reason", "evidence_url"]) {
    const invalidReviews = inspected_images.map((review) => review.url === aiImage ? { ...review, [missing]: "" } : review);
    assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, inspected_images: invalidReviews, ai_image_url: null }), /bằng chứng|remove/);
  }
});

test("null AI-image POST is canonicalized once and retry preserves its exact receipt bytes", async () => {
  const job = claimedJob(85, 101, { ai_image_url: null,
    images: imageFixSource(85).images.filter((image) => image.url !== aiImage) });
  const result = imageFixResult(85, { ai_image_url: null,
    inspected_images: imageFixResult(85).inspected_images.filter((review) => review.url !== aiImage) });
  let attempts = 0;
  const api = loadBackground({ items: [job] }, (url) => {
    if (!url.startsWith(UPDATE_URL)) return undefined;
    if (++attempts === 1) throw new Error("Simulated lost response");
    return response({ ok: true, updated: [{ id: 85, already_processed: true, images_queued: 0 }] });
  });
  await assert.rejects(api.updateFacilityImageFix(job, result), (error) => error.imageFixUnconfirmed === true);
  assert.equal(posts(api)[0].body.items[0].ai_image_url, "");
  assert.equal(result.ai_image_url, null, "the original AI result remains available for inspection");
  const pending = await hydrated(api, job.id);
  assert.equal(pending.image_fix_api_pending, true);
  assert.equal(pending.image_fix_payload, posts(api)[0].options.body);
  const claimCallsBeforeRetry = api.calls.filter((call) => call.url.startsWith(CLAIM_URL)).length;
  const saved = await api.updateFacilityImageFix(pending, { ...result, ai_image_url: "https://untrusted.example/ignored.jpg" });
  assert.equal(saved.updated[0].already_processed, true);
  assert.equal(posts(api)[1].options.body, posts(api)[0].options.body);
  assert.equal(api.calls.filter((call) => call.url.startsWith(CLAIM_URL)).length, claimCallsBeforeRetry);
  assert.equal(api.calls.some((call) => call.url.startsWith(QUEUE_URL)), false);
});

test("a removal requires reason/evidence and a kept AI image cannot be cleared or replaced", () => {
  const api = loadBackground(), job = claimedJob(), result = imageFixResult(71, { added_images: replacementImages() });
  const removal = result.inspected_images.map((review, index) => index === 1
    ? { ...review, decision: "remove", reason: "HTTP 404 confirmed", evidence_url: aiImage, http_status: 404 } : review);
  assert.doesNotThrow(() => api.buildFacilityImageFixPayload(job, { ...result, inspected_images: removal, ai_image_url: "" }));
  for (const missing of ["reason", "evidence_url"]) assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, ai_image_url: "",
    inspected_images: removal.map((review, index) => index === 1 ? { ...review, [missing]: "" } : review) }), /reason|evidence|bằng chứng|remove|xóa/i);
  for (const value of ["", googleImage]) assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, ai_image_url: value }), /ai_image_url|ảnh AI/);
  assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, image_url: "https://unverified.example/cover.jpg" }), /image_url|nguồn|cover/);
});

test("added images require public direct URLs and source attribution, without credentials or duplicate sources", () => {
  const api = loadBackground(), job = claimedJob(), result = imageFixResult();
  const badUrls = ["data:image/png;base64,AAAA", "blob:https://clinic.example/id", "/uploads/new.jpg", "http://localhost/image.jpg",
    "http://127.0.0.1/image.jpg", "http://192.168.1.2/image.jpg", "https://user:pass@clinic.example/a.jpg",
    "https://clinic.example/a.jpg?api_key=secret", "https://clinic.example/a.jpg?access_token=secret",
    "https://maps.google.com/?cid=71", "https://maps.app.goo.gl/place", "https://clinic.example/gallery.html", "https://clinic.example/photo.php"];
  for (const url of badUrls) assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result,
    added_images: [{ ...result.added_images[0], url }] }), /url|URL|ảnh|source|token|key/i, url);
  for (const field of ["source", "source_url"]) assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result,
    added_images: [{ ...result.added_images[0], [field]: "" }] }), /source|nguồn|URL/);
  for (const added_images of [[{ ...result.added_images[0], url: blockedImage }], [result.added_images[0], result.added_images[0]],
    Array.from({ length: 13 }, (_, index) => ({ ...result.added_images[0], url: `https://clinic.example/new-${index}.jpg` }))]) {
    assert.throws(() => api.buildFacilityImageFixPayload(job, { ...result, added_images }), /12|trùng|nguồn|added_images|duplicate/);
  }
});

test("image-fix update sends to its own configured endpoint and accepts only current-ID 200/mixed-207 receipts", async () => {
  const job = claimedJob(), result = imageFixResult();
  for (const status of [200, 207]) {
    const api = loadBackground({ "tab-api-settings:101": { facilityImageFixUpdateUrl: UPDATE_URL + "?target=one" } }, (url) => url.startsWith(UPDATE_URL)
      ? response({ ok: status === 200, updated_count: 1, updated: [{ id: 71, already_processed: false, images_queued: 1 }],
        errors: status === 207 ? [{ index: 1, id: 99, status: 422, reason: "invalid_payload", message: "other item invalid" }] : [], image_processing: "queued" }, status) : undefined);
    const saved = await api.updateFacilityImageFix(job, result);
    assert.ok(saved.updated.some((item) => item.id === 71));
    const post = posts(api)[0];
    assert.equal(post.url, UPDATE_URL + "?target=one");
    assert.deepEqual(post.body, { items: [{ ...result, writer_claim_token: token }] });
    assert.equal(post.options.headers["X-Medical-Api-Key"], "test-medical-key");
    assert.equal(post.options.signal, undefined);
    assert.equal(api.calls.some((call) => /facility-content-update|facility-ai-image-update/.test(call.url)), false);
  }
});

test("synchronous completed receipt persists per-image results and finishes only after images are saved", async () => {
  const receipt = synchronousImageReceipt();
  const api = loadBackground({ items: [imageFixJob()] }, (url) => url.startsWith(UPDATE_URL) ? response(receipt) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]), result = imageFixResult();
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken, article: result }, api.sender(101));
  const saved = await hydrated(api, worker.currentId);
  assert.equal(saved.status, "hoàn tất");
  assert.equal(saved.image_fix_api_pending, false);
  assert.equal(Boolean(saved.image_fix_import_pending), false);
  assert.equal(saved.image_fix_payload, null);
  assert.equal(saved.writer_claim_token, undefined);
  assert.deepEqual(plain(saved.api_update.updated[0].image_results), receipt.updated[0].image_results);
  assert.equal(saved.api_update.updated[0].images_imported, 2);
  assert.equal(saved.api_update.updated[0].images_failed, 0);
  assert.equal(posts(api)[0].options.signal, undefined);
  const callsBeforeRetry = api.calls.length;
  const retry = await api.retryFacilityImageFixUpdate(saved.id);
  assert.equal(retry.already_processed, true);
  assert.equal(api.calls.length, callsBeforeRetry, "completed image imports must not send another POST");
});

test("synchronous partial saves JSON without reporting all images complete, and keeps exact private retry bytes", async () => {
  const receipt = synchronousImageReceipt(71, "partial");
  const api = loadBackground({ items: [imageFixJob()] }, (url) => url.startsWith(UPDATE_URL) ? response(receipt) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]), result = imageFixResult();
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken, article: result }, api.sender(101));
  const partial = await hydrated(api, worker.currentId);
  assert.equal(partial.status, "ảnh chưa đủ");
  assert.equal(partial.image_fix_import_pending, true);
  assert.equal(partial.image_fix_api_pending, false, "JSON receipt is confirmed, only image import needs retry");
  assert.equal(partial.image_fix_requires_research, false);
  assert.equal(partial.writer_claim_token, undefined, "server has already returned the original claim");
  assert.equal(partial.image_fix_payload, posts(api)[0].options.body);
  assert.equal(JSON.parse(partial.image_fix_payload).items[0].writer_claim_token, token);
  assert.equal(partial.images_revision, revision, "response revision must not replace the original retry revision");
  assert.deepEqual(plain(partial.result), result);
  assert.deepEqual(plain(partial.api_update), receipt);
  assert.match(partial.api_update.updated[0].image_results[1].error, /HTTP 403/);
  const panel = await api.getArticleContent(partial.id, 101);
  assert.equal(panel.content.image_fix_payload, undefined);
  assert.equal(JSON.stringify(panel).includes(token), false);
});

test("synchronous partial retry replays the original payload after claim expiry/clear, without GET, claim or AI", async () => {
  const result = imageFixResult();
  // Whitespace makes re-stringification detectable as well as field changes.
  const originalBody = JSON.stringify({ items: [{ ...result, writer_claim_token: token }] }, null, 2);
  for (const claim of [
    { writer_claim_expires_at: new Date(Date.now() - 60000).toISOString() },
    { writer_claim_token: undefined, writer_claim_expires_at: undefined, writer_claim_lost: true }
  ]) {
    const job = claimedJob(71, 101, { status: "ảnh chưa đủ", result,
      image_fix_import_pending: true, image_fix_api_pending: false, image_fix_payload: originalBody,
      api_update: synchronousImageReceipt(71, "partial"), ...claim });
    let attempts = 0;
    const api = loadBackground({ items: [job] }, (url) => url.startsWith(UPDATE_URL)
      ? response(synchronousImageReceipt(71, ++attempts === 1 ? "partial" : "completed", { already_processed: true })) : undefined);
    await api.retryFacilityImageFixUpdate(job.id);
    const stillPartial = await hydrated(api, job.id);
    assert.equal(stillPartial.status, "ảnh chưa đủ");
    assert.equal(stillPartial.image_fix_import_pending, true);
    assert.equal(stillPartial.image_fix_payload, originalBody);
    await api.retryFacilityImageFixUpdate(job.id);
    const completed = await hydrated(api, job.id);
    assert.equal(completed.status, "hoàn tất");
    assert.equal(Boolean(completed.image_fix_import_pending), false);
    assert.equal(completed.image_fix_payload, null);
    assert.equal(posts(api).length, 2);
    assert.deepEqual(api.calls.map((call) => call.url), [UPDATE_URL, UPDATE_URL]);
    for (const call of posts(api)) {
      assert.equal(call.options.body, originalBody);
      assert.equal(call.body.items[0].images_revision, revision);
      assert.equal(call.body.items[0].writer_claim_token, token);
      assert.equal(call.options.signal, undefined);
    }
    assert.equal(prompts(api).length, 0);
    await api.retryFacilityImageFixUpdate(job.id);
    assert.equal(posts(api).length, 2);
  }
});

test("image import status comes from the matching updated[] ID, not global or another item's status", async () => {
  for (const processing of ["partial", "completed"]) {
    const receipt = synchronousImageReceipt(71, processing);
    const opposite = processing === "partial" ? "completed" : "partial";
    receipt.image_processing = opposite;
    receipt.updated.unshift(synchronousImageReceipt(99, opposite).updated[0]);
    receipt.warnings = [{ index: 1, id: 99, message: "Other facility warning" }];
    const api = loadBackground({ items: [imageFixJob()] }, (url) => url.startsWith(UPDATE_URL) ? response(receipt) : undefined);
    await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
    const worker = plain(api.state.runner.workers["tab-101"]);
    await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken, article: imageFixResult() }, api.sender(101));
    const saved = await hydrated(api, worker.currentId);
    assert.equal(saved.status, processing === "partial" ? "ảnh chưa đủ" : "hoàn tất");
    assert.equal(Boolean(saved.image_fix_import_pending), processing === "partial");
  }
});

test("completed with zero external images is still completed, not queued for a nonexistent worker", async () => {
  const receipt = synchronousImageReceipt(71, "completed", { images_imported: 0, images_failed: 0, image_results: [] });
  const api = loadBackground({ items: [imageFixJob()] }, (url) => url.startsWith(UPDATE_URL) ? response(receipt) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken, article: imageFixResult() }, api.sender(101));
  const saved = await hydrated(api, worker.currentId);
  assert.equal(saved.status, "hoàn tất");
  assert.equal(Boolean(saved.image_fix_import_pending), false);
  assert.deepEqual(plain(saved.api_update.updated[0].image_results), []);
});

test("synchronous image download POST stays active until its response and has no client abort timeout", async () => {
  const job = claimedJob(71, 101, { status: "lỗi cập nhật", result: imageFixResult() });
  let releaseResponse;
  const deferred = new Promise((resolve) => { releaseResponse = resolve; });
  const api = loadBackground({ items: [job] }, (url) => url.startsWith(UPDATE_URL) ? deferred : undefined);
  const upload = api.retryFacilityImageFixUpdate(job.id);
  for (let attempt = 0; attempt < 30 && posts(api).length === 0; attempt++) await new Promise(setImmediate);
  assert.equal(posts(api).length, 1);
  const running = await hydrated(api, job.id);
  assert.equal(running.status, "đang cập nhật");
  assert.equal(running.image_fix_api_pending, true);
  assert.equal(running.image_fix_payload, posts(api)[0].options.body);
  assert.equal(posts(api)[0].options.signal, undefined);
  await assert.rejects(api.retryFacilityImageFixUpdate(job.id), /đang gửi|chưa gửi trùng/i);
  assert.equal(posts(api).length, 1);
  releaseResponse(response(synchronousImageReceipt()));
  await upload;
  assert.equal((await hydrated(api, job.id)).status, "hoàn tất");
});

test("lease loss and Stop during synchronous POST retain its receipt and never abort or release the in-flight import", async () => {
  let downloading = false, releaseResponse;
  const deferred = new Promise((resolve) => { releaseResponse = resolve; });
  const api = loadBackground({ items: [imageFixJob()] }, (url, options, body) => {
    if (url.startsWith(UPDATE_URL)) { downloading = true; return deferred; }
    if (downloading && url.startsWith(CLAIM_URL) && body.action === "heartbeat") {
      return response({ ok: false, reason: "lease_lost", message: "JSON committed; receiver already returned claim" }, 409);
    }
    return undefined;
  });
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  const upload = api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken,
    article: imageFixResult() }, api.sender(101));
  for (let attempt = 0; attempt < 30 && posts(api).length === 0; attempt++) await new Promise(setImmediate);
  try {
    assert.equal(posts(api).length, 1);
    const originalBody = posts(api)[0].options.body;
    await api.heartbeatActiveWriterClaims();
    let pending = await hydrated(api, worker.currentId);
    assert.equal(pending.status, "đang cập nhật", "lease loss after commit must not end the active download POST");
    assert.equal(pending.image_fix_api_pending, true);
    assert.equal(pending.image_fix_payload, originalBody);
    assert.equal(api.state.runner.workers["tab-101"].currentId, worker.currentId);
    const beforeStop = api.calls.length;
    await api.stopRun({ targetTabId: 101 }, api.sender(101));
    pending = await hydrated(api, worker.currentId);
    assert.equal(pending.status, "đang cập nhật");
    assert.equal(pending.image_fix_api_pending, true);
    assert.equal(pending.image_fix_payload, originalBody);
    assert.equal(Boolean(api.state.runner.workers?.["tab-101"]?.active), false);
    assert.equal(api.calls.slice(beforeStop).some((call) => call.body?.action === "release"), false);
    assert.equal(posts(api)[0].options.signal, undefined);
    assert.equal(posts(api).length, 1);
    assert.equal(prompts(api).length, 1);
  } finally {
    releaseResponse(response(synchronousImageReceipt()));
    await upload;
  }
  assert.equal((await hydrated(api, worker.currentId)).status, "hoàn tất");
  assert.equal(Boolean(api.state.runner.workers?.["tab-101"]?.active), false);
  assert.equal(prompts(api).length, 1);
});

test("other-ID receipts and matching indexed errors in 207/422/409 cannot confirm image-fix success", async () => {
  const job = claimedJob(), result = imageFixResult();
  const cases = [
    [200, { ok: true, updated_count: 1, updated: [{ id: 99 }], errors: [] }],
    [207, { ok: false, updated_count: 1, updated: [{ id: 99 }], errors: [{ index: 0, id: 71, status: 422, reason: "invalid_payload", message: "bad current item" }] }],
    [422, { ok: false, updated_count: 0, updated: [], errors: [{ index: 0, id: 71, status: 422, reason: "invalid_payload", message: "bad current item" }] }],
    [409, { ok: false, updated_count: 0, updated: [], errors: [{ index: 0, id: 71, status: 409, reason: "lease_lost", message: "lost lease" }] }]
  ];
  for (const [status, body] of cases) {
    const api = loadBackground({}, (url) => url.startsWith(UPDATE_URL) ? response(body, status) : undefined);
    await assert.rejects(api.updateFacilityImageFix(job, result), /99|ID|71|422|409|bad current|lease|xác nhận/i);
  }
});

test("heartbeat protects image-fix during upload, validation repair and ambiguous retry", async () => {
  for (const status of ["đang viết", "đang cập nhật", "lỗi cập nhật", "chưa xác nhận"]) {
    const job = claimedJob(71, 101, { status, result: imageFixResult(), image_fix_api_pending: status === "chưa xác nhận" });
    const api = loadBackground({ items: [job] });
    await api.heartbeatActiveWriterClaims();
    const heartbeat = api.calls.find((call) => call.body?.action === "heartbeat");
    assert.ok(heartbeat, status);
    assert.deepEqual(heartbeat.body, { action: "heartbeat", type: "facility", task: "facility_image_fix", id: 71, claim_token: token });
    assert.ok(Date.parse(api.state.items[0].writer_claim_expires_at) > Date.now());
  }
});

test("lost image-fix heartbeat lease prevents a late AI completion from posting", async () => {
  const api = loadBackground({ items: [imageFixJob()] }, (url, options, body) => url.startsWith(CLAIM_URL) && body.action === "heartbeat"
    ? response({ ok: false, reason: "lease_lost", message: "Expired claim" }, 409) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  await api.heartbeatActiveWriterClaims();
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken, article: imageFixResult() }, api.sender(101));
  assert.equal(posts(api).length, 0);
  assert.equal(api.calls.some((call) => /facility-content-update|facility-ai-image-update/.test(call.url)), false);
});

test("422 image-fix retains JSON and private lease for repair/retry without a second AI prompt", async () => {
  let rejectUpdate = true;
  const api = loadBackground({ items: [imageFixJob()] }, (url) => url.startsWith(UPDATE_URL) && rejectUpdate
    ? response({ ok: false, updated: [], errors: [{ index: 0, id: 71, status: 422, reason: "invalid_payload", message: "repair required" }] }, 422) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]), result = imageFixResult();
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken, article: result, rawResponse: JSON.stringify(result) }, api.sender(101));
  const failed = await hydrated(api, worker.currentId);
  assert.notEqual(failed.status, "hoàn tất");
  assert.deepEqual(plain(failed.result), result);
  assert.equal(failed.writer_claim_token, token);
  await api.heartbeatActiveWriterClaims();
  assert.ok(api.calls.some((call) => call.body?.action === "heartbeat"));
  rejectUpdate = false;
  await api.retryFacilityImageFixUpdate(worker.currentId);
  assert.equal((await hydrated(api, worker.currentId)).status, "hoàn tất");
  assert.equal(prompts(api).length, 1);
  assert.equal(posts(api).length, 2);
});

test("images_changed invalidates old output and never swaps a new revision into an old payload", async () => {
  const api = loadBackground({ items: [imageFixJob()] }, (url) => url.startsWith(UPDATE_URL)
    ? response({ ok: false, updated: [], errors: [{ index: 0, id: 71, status: 409, reason: "images_changed", message: "Investigate new images again" }] }, 409) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken, article: imageFixResult() }, api.sender(101));
  const failed = await hydrated(api, worker.currentId);
  assert.notEqual(failed.status, "hoàn tất");
  assert.equal(failed.image_fix_requires_research, true);
  assert.equal(posts(api)[0].body.items[0].images_revision, revision);
  await assert.rejects(api.retryFacilityImageFixUpdate(worker.currentId), /images_changed|điều tra|kiểm tra|AI|revision|nguồn|ảnh/i);
  assert.equal(posts(api).length, 1);
  assert.ok(api.calls.some((call) => call.body?.action === "release"));
});

test("network-ambiguous image-fix retry resends byte-identical payload/token without claiming or refreshing first", async () => {
  let attempts = 0;
  const api = loadBackground({ items: [imageFixJob()] }, (url) => {
    if (!url.startsWith(UPDATE_URL)) return undefined;
    if (++attempts === 1) throw new Error("connection closed after server saved POST");
    return response(synchronousImageReceipt(71, "completed", { already_processed: true }));
  });
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]), result = imageFixResult();
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken, article: result, rawResponse: JSON.stringify(result) }, api.sender(101));
  const uncertain = await hydrated(api, worker.currentId);
  assert.notEqual(uncertain.status, "hoàn tất");
  assert.equal(uncertain.writer_claim_token, token);
  assert.deepEqual(plain(uncertain.result), result);
  const beforeRetry = api.calls.length;
  await api.retryFacilityImageFixUpdate(worker.currentId);
  assert.equal((await hydrated(api, worker.currentId)).status, "hoàn tất");
  assert.equal(posts(api).length, 2);
  assert.equal(posts(api)[0].options.body, posts(api)[1].options.body);
  assert.equal(posts(api)[1].body.items[0].writer_claim_token, token);
  assert.deepEqual(api.calls.slice(beforeRetry).map((call) => call.url), [UPDATE_URL]);
  assert.equal(prompts(api).length, 1);
});

test("pending image-fix recovery keeps the original job isolated from generic article timeout recovery", async () => {
  const result = imageFixResult(), payload = JSON.stringify({ items: [{ ...result, writer_claim_token: token }] });
  const job = claimedJob(71, 101, { status: "chưa xác nhận", result, image_fix_payload: payload,
    image_fix_api_pending: true, api_request_started_at: new Date(Date.now() - 40 * 60000).toISOString() });
  const api = loadBackground({ items: [job], runner: { active: true, workers: { "tab-101": {
    active: true, currentId: job.id, sourceType: "facility_image_fix", provider: "grok", targetTabId: 101, runToken: "run-fix-71"
  } } } });
  await api.getAlarmListener()({ name: "medreview-runner-recovery" });
  const retained = await hydrated(api, job.id);
  assert.notEqual(retained.status, "hoàn tất");
  assert.equal(retained.writer_claim_token, token);
  assert.equal(retained.image_fix_payload, payload);
  assert.equal(api.state.runner.workers["tab-101"].currentId, job.id);
  assert.equal(prompts(api).length, 0);
  assert.equal(posts(api).length, 0);
});

test("stopping after 422 releases an idle retained lease and prohibits sending old JSON under a new lease", async () => {
  const api = loadBackground({ items: [imageFixJob()] }, (url) => url.startsWith(UPDATE_URL)
    ? response({ ok: false, updated: [], errors: [{ index: 0, id: 71, status: 422, reason: "invalid_payload", message: "repair required" }] }, 422) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken, article: imageFixResult() }, api.sender(101));
  assert.equal(api.state.runner.workers["tab-101"].active, false);
  await api.stopRun({ targetTabId: 101 }, api.sender(101));
  const stopped = await hydrated(api, worker.currentId);
  assert.equal(stopped.writer_claim_token, undefined);
  assert.equal(stopped.image_fix_requires_research, true);
  assert.ok(stopped.result);
  await assert.rejects(api.retryFacilityImageFixUpdate(worker.currentId), /khóa|kiểm tra AI/);
  assert.equal(posts(api).length, 1);
  assert.equal(api.calls.filter((call) => call.body?.action === "release").length, 1);
});

test("private image-fix replay payload never leaks to panel content or another tab", async () => {
  const job = claimedJob(71, 101, { result: imageFixResult(), image_fix_api_pending: true,
    image_fix_payload: JSON.stringify({ items: [{ ...imageFixResult(), writer_claim_token: token }] }) });
  const api = loadBackground({ items: [job] });
  const visible = await api.getArticleContent(job.id, 101);
  assert.ok(visible.content.result);
  assert.equal(visible.content.image_fix_payload, undefined);
  assert.equal(JSON.stringify(visible).includes(token), false);
  assert.equal((await api.getArticleContent(job.id, 202)).ok, false);
});

test("manual image-fix research queues a fresh attempt, archives old JSON, and never silently edits its revision", async () => {
  const job = imageFixJob(71, 101, { status: "lỗi cập nhật", result: imageFixResult(), image_fix_requires_research: true,
    image_fix_error_code: "images_changed" });
  const api = loadBackground({ items: [job] });
  await api.retryFacilityImageFixResearch(job.id);
  const queued = await hydrated(api, job.id);
  assert.equal(queued.status, "chờ");
  assert.equal(queued.result, null);
  assert.equal(queued.image_fix_previous_result.images_revision, revision);
  assert.equal(prompts(api).length, 0);
  assert.equal(api.calls.length, 0);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  assert.equal(prompts(api).length, 1);
  assert.equal(JSON.stringify(prompts(api)[0]).includes("image_fix_previous_result"), false);
});

test("503 pauses only image-fix and surfaces readiness status without claiming success", async () => {
  const api = loadBackground({ items: [imageFixJob()] }, (url) => url.startsWith(UPDATE_URL)
    ? response({ ok: false, reason: "schema_not_ready", message: "migration required", updated: [] }, 503) : undefined);
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 101 }, api.sender(101));
  const worker = plain(api.state.runner.workers["tab-101"]);
  await api.handleArticleComplete({ articleId: worker.currentId, runToken: worker.runToken, article: imageFixResult() }, api.sender(101));
  const failed = await hydrated(api, worker.currentId);
  assert.equal(failed.status, "lỗi cập nhật");
  assert.match(failed.api_error, /503.*schema_not_ready.*migration/);
  assert.equal(failed.image_fix_requires_research, true);
  assert.equal(failed.writer_claim_token, undefined);
  assert.equal(api.state.runner.workers["tab-101"].active, false);
});

test("image-fix preserves Google URLs longer than 255 characters byte-for-byte", () => {
  const api = loadBackground(), result = imageFixResult();
  const url = googleImage + "&metadata=" + "a%2Fb%2Bc".repeat(100);
  result.added_images[0].url = url;
  assert.equal(api.buildFacilityImageFixPayload(claimedJob(), result).items[0].added_images[0].url, url);
});

test("image-fix waits for an exact ID receipt after local lease expiry, without refreshing or acquiring a new lease", async () => {
  const result = imageFixResult();
  const job = claimedJob(71, 101, { status: "chưa xác nhận", result, image_fix_api_pending: true,
    writer_claim_expires_at: new Date(Date.now() - 60000).toISOString(),
    image_fix_payload: JSON.stringify({ items: [{ ...result, writer_claim_token: token }] }) });
  const api = loadBackground({ items: [job] }, (url) => url.startsWith(UPDATE_URL)
    ? response({ ok: true, updated: [{ id: 71, already_processed: true }], image_processing: "queued", errors: [] }) : undefined);
  await api.retryFacilityImageFixUpdate(job.id);
  assert.equal((await hydrated(api, job.id)).status, "hoàn tất");
  assert.deepEqual(api.calls.map((call) => call.url), [UPDATE_URL]);
  assert.equal(posts(api)[0].options.body, job.image_fix_payload);
});

test("minimal added_images preserves optional angle/caption omissions and validates them only when supplied", () => {
  const api = loadBackground(), result = imageFixResult();
  const image = { url: googleImage, source: "Google Maps", source_url: "https://maps.google.com/?cid=71" };
  result.added_images = [image];
  assert.deepEqual(plain(api.buildFacilityImageFixPayload(claimedJob(), result).items[0].added_images), [image]);
  for (const [field, limit] of [["angle", 120], ["caption", 500]]) {
    for (const value of [null, 123, "a".repeat(limit + 1)]) assert.throws(() => api.buildFacilityImageFixPayload(claimedJob(),
      { ...result, added_images: [{ ...image, [field]: value }] }), new RegExp(field));
  }
});

test("source cover removal is passed unchanged for the backend's atomic gallery fallback", () => {
  const api = loadBackground(), result = imageFixResult(71, { added_images: replacementImages() });
  result.inspected_images[0] = { url: cover, decision: "remove", reason: "HTTP 404 confirmed", evidence_url: cover, http_status: 404 };
  const payload = api.buildFacilityImageFixPayload(claimedJob(), result);
  assert.equal(payload.items[0].image_url, cover);
  assert.equal(payload.items[0].images_revision, revision);
});

test("failed release while restarting research retains the original token and release-pending marker", async () => {
  const job = claimedJob(71, 101, { status: "lỗi cập nhật", result: imageFixResult(), image_fix_requires_research: true });
  const api = loadBackground({ items: [job] }, (url, options, body) => url.startsWith(CLAIM_URL) && body.action === "release"
    ? response({ ok: false, message: "temporary outage" }, 503) : undefined);
  await assert.rejects(api.retryFacilityImageFixResearch(job.id), /Chưa trả được khóa/);
  const retained = await hydrated(api, job.id);
  assert.equal(retained.writer_claim_token, token);
  assert.equal(retained.writer_claim_release_pending, true);
  assert.equal(retained.status, "lỗi cập nhật");
  assert.deepEqual(plain(retained.result), imageFixResult());
  assert.equal(prompts(api).length, 0);
});

test("crash between JSON staging and durable POST body is recoverable, not a permanent ambiguous slot", async () => {
  const job = claimedJob(71, 101, { status: "đang cập nhật", result: imageFixResult(),
    api_request_started_at: new Date(Date.now() - 120000).toISOString() });
  const api = loadBackground({ items: [job], runner: { active: true, workers: { "tab-101": {
    active: true, currentId: job.id, sourceType: "facility_image_fix", provider: "grok", targetTabId: 101, runToken: "crash-gap"
  } } } });
  await api.reconcileStaleApiUpdates();
  const recovered = await hydrated(api, job.id);
  assert.equal(recovered.status, "lỗi cập nhật");
  assert.equal(recovered.image_fix_api_pending, false);
  assert.equal(recovered.image_fix_requires_research, true);
  assert.equal(recovered.writer_claim_token, undefined);
  assert.equal(api.state.runner.workers["tab-101"].active, false);
  await api.retryFacilityImageFixResearch(job.id);
  assert.equal((await hydrated(api, job.id)).status, "chờ");
  assert.equal(posts(api).length, 0);
});

test("deleting an idle failed Fix ảnh releases its claim, without deleting another tab's queue", async () => {
  const job = claimedJob(71, 101, { status: "lỗi cập nhật", result: imageFixResult() });
  const other = imageFixJob(72, 202);
  const api = loadBackground({ items: [job, other] });
  await api.replaceQueueItems({ targetTabId: 101, sourceType: "facility_image_fix", removeArticleIds: [job.id, other.id] }, api.sender(101));
  assert.deepEqual(api.state.items.map((item) => item.id), [other.id]);
  assert.deepEqual(api.calls.filter((call) => call.body?.action === "release").map((call) => call.body.id), [71]);
});

test("failed release cancels deletion without losing JSON, token or the release retry marker", async () => {
  const job = claimedJob(71, 101, { status: "lỗi cập nhật", result: imageFixResult() });
  const api = loadBackground({ items: [job] }, (url, options, body) => url.startsWith(CLAIM_URL) && body.action === "release"
    ? response({ ok: false, message: "outage" }, 503) : undefined);
  await assert.rejects(api.replaceQueueItems({ targetTabId: 101, sourceType: "facility_image_fix", removeArticleIds: [job.id] }, api.sender(101)), /chưa trả được khóa/i);
  const retained = await hydrated(api, job.id);
  assert.deepEqual(plain(retained.result), imageFixResult());
  assert.equal(retained.writer_claim_token, token);
  assert.equal(retained.writer_claim_release_pending, true);
});

test("a final Fix ảnh JSON-read failure stops Spark instead of scheduling unbounded original prompt retries", async () => {
  const api = loadBackground({ items: [imageFixJob(71, 303)] });
  await api.startRun({ sourceType: "facility_image_fix", targetTabId: 303 }, api.sender(303));
  const worker = plain(api.state.runner.workers["tab-303"]);
  await api.handleArticleFailed({ articleId: worker.currentId, runToken: worker.runToken,
    error: "JSON vẫn không đúng contract sau một yêu cầu định dạng lại", rawResponse: "incomplete" }, api.sender(303));
  const failed = await hydrated(api, worker.currentId);
  assert.equal(failed.status, "lỗi");
  assert.equal(failed.rawResponse, "incomplete");
  assert.equal(failed.writer_claim_token, undefined);
  assert.equal(api.state.runner.workers["tab-303"].active, false);
  assert.equal(api.retryTimers.length, 0);
  assert.equal(prompts(api).length, 1);
});
