const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionRoot = path.resolve(__dirname, "..");
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const CLAIM_URL = "https://medreview.vn/api/medical/writer-claim.php";
const UPDATE_URL = "https://medreview.vn/api/medical/facility-content-update.php";
const TAB_ID = 744;
const TAB_URL = "https://chatgpt.com/c/medreview-test";
const HEARTBEAT_ALARM = "medreview-writer-claim-heartbeat";

function loadBackground({ initial = {}, conflicts = [], heartbeatLost = false, simulateClaimTimeout = false, receiverReady = false, missingReceiver = false, existingAlarms = [], fetchOverride } = {}) {
  const state = clone({
    sourceType: "facility",
    instance_label: "Máy văn phòng",
    account_label: "ChatGPT biên tập",
    updateUrl: UPDATE_URL,
    nextJobDelayMs: 0,
    items: [{ id: "facility-53", facility_id: 53, title: "Nha khoa mẫu", prompt: "Viết JSON", status: "chờ" }],
    runner: { active: false },
    ...initial
  });
  const calls = [];
  const events = [];
  const alarms = new Map(existingAlarms.map((alarm) => [alarm.name, clone(alarm)]));
  const alarmCreates = [];
  const alarmGets = [];
  let alarmListener;
  let counter = 0;
  let observedClaimSignal = null;
  const claimTimeouts = [];
  const clearedTimeouts = [];
  const fakeTimeoutHandles = new Set();
  let nextTimerId = 0;
  class TestAbortController {
    constructor() {
      const listeners = [];
      this.signal = {
        aborted: false,
        addEventListener(type, listener) { if (type === "abort") listeners.push(listener); }
      };
      this.listeners = listeners;
    }
    abort() {
      this.signal.aborted = true;
      for (const listener of this.listeners) listener();
    }
  }
  const testSetTimeout = (callback, delay) => {
    if (simulateClaimTimeout && delay === 20000) {
      const handle = { id: ++nextTimerId };
      fakeTimeoutHandles.add(handle);
      claimTimeouts.push({ callback, delay, handle });
      return handle;
    }
    return setTimeout(callback, delay);
  };
  const testClearTimeout = (handle) => {
    if (fakeTimeoutHandles.has(handle)) clearedTimeouts.push(handle);
    else clearTimeout(handle);
  };
  const tab = { id: TAB_ID, url: TAB_URL };
  const chrome = {
    runtime: { id: "test-extension", onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: {
      async get(keys) {
        const wanted = keys == null ? Object.keys(state) : Array.isArray(keys) ? keys : [keys];
        return clone(Object.fromEntries(wanted.filter((key) => key in state).map((key) => [key, state[key]])));
      },
      async set(values) { Object.assign(state, clone(values)); }
    } },
    tabs: {
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      async get(id) { if (Number(id) !== TAB_ID) throw new Error("missing tab"); return clone(tab); },
      async query(query) { return query.active ? [clone(tab)] : [clone(tab)]; },
      async sendMessage(id, message) {
        events.push({ kind: "tab-message", id, message: clone(message) });
        if (message.type === "runner-ready") {
          if (missingReceiver) throw new Error("Could not establish connection. Receiving end does not exist.");
          return { ok: true, ready: receiverReady };
        }
        return { ok: true, started: true };
      },
      async update() {}, async reload() {}
    },
    scripting: { async executeScript() { events.push({ kind: "inject" }); } },
    alarms: {
      async get(name) { alarmGets.push(name); return clone(alarms.get(name)); },
      create(name, options) { alarmCreates.push({ name, options: clone(options) }); alarms.set(name, { name, ...clone(options) }); },
      onAlarm: { addListener(listener) { alarmListener = listener; } }
    }
  };
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), options: clone(options), body });
    events.push({ kind: "fetch", url: String(url), body });
    const override = fetchOverride && await fetchOverride(String(url), options, body, { state, calls, events });
    if (override !== undefined) return override;
    if (String(url) === CLAIM_URL) {
      if (body.action === "claim") {
        observedClaimSignal = options.signal;
        if (simulateClaimTimeout) {
          return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => {
            const error = new Error("request aborted");
            error.name = "AbortError";
            reject(error);
          }));
        }
        if (conflicts.map(String).includes(String(body.id))) {
          return response({ ok: true, claimed: false, reason: "already_claimed", writer: {
            provider: "gemini", model: "Gemini 2.5 Pro", instance_label: "Máy văn phòng",
            account_label: "Gemini content", worker_id: "tab-9", task: "content ai"
          } }, 409);
        }
        counter += 1;
        return response({ ok: true, claimed: true, claim_token: `claim-token-${body.id}-${counter}`, lease_seconds: 180 });
      }
      if (body.action === "heartbeat" && heartbeatLost) {
        return response({ ok: false, reason: "lease_lost", writer: { provider: "grok", instance_label: "Máy khác", account_label: "Grok work" } }, 409);
      }
      return response({ ok: true, lease_seconds: 180, released: body.action === "release" });
    }
    if (String(url) === UPDATE_URL) {
      const ids = (body?.items || []).map((item) => item.id);
      return response({ ok: true, updated_ids: ids, updated_count: ids.length, errors: [] });
    }
    if (String(url).includes("facilities-needing-content.php")) return response({ ok: true, items: [] });
    throw new Error(`Unexpected mocked URL ${url}`);
  };
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    chrome, fetch, URL, setTimeout: testSetTimeout, clearTimeout: testClearTimeout,
    AbortController: simulateClaimTimeout ? TestAbortController : AbortController, structuredClone
  });
  const source = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8") + `
    globalThis.__writerClaimTests = {
      startRun, stopRun, handleArticleComplete, handleArticleFailed,
      heartbeatActiveWriterClaims, mergeQueueItems, updateFacilityContent,
      retryUpdate, getCurrentArticle, writerClaimType, writerClaimDisplay, requestWriterClaim,
      registerWriterClaimHeartbeatAlarm
    };
  `;
  vm.runInContext(source, context, { filename: "background.js" });
  return {
    ...context.__writerClaimTests, state, calls, events, tab, claimTimeouts, clearedTimeouts, alarms, alarmCreates, alarmGets,
    getClaimSignal: () => observedClaimSignal, getAlarmListener: () => alarmListener
  };
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(data); } };
}

function sender() { return { tab: { id: TAB_ID, url: TAB_URL } }; }

test("service-worker wakes preserve an existing heartbeat alarm deadline", async () => {
  const existing = { name: HEARTBEAT_ALARM, scheduledTime: Date.now() + 5000, periodInMinutes: 0.75 };
  const api = loadBackground({ existingAlarms: [existing] });
  await api.registerWriterClaimHeartbeatAlarm();
  await api.registerWriterClaimHeartbeatAlarm();
  assert.ok(api.alarmGets.includes(HEARTBEAT_ALARM));
  assert.equal(api.alarmCreates.filter((alarm) => alarm.name === HEARTBEAT_ALARM).length, 0);
  assert.deepEqual(api.alarms.get(HEARTBEAT_ALARM), existing);
});

test("a missing heartbeat alarm is created once without subsequent postponement", async () => {
  const api = loadBackground();
  await Promise.all([api.registerWriterClaimHeartbeatAlarm(), api.registerWriterClaimHeartbeatAlarm()]);
  await api.registerWriterClaimHeartbeatAlarm();
  assert.deepEqual(api.alarmCreates.filter((alarm) => alarm.name === HEARTBEAT_ALARM), [
    { name: HEARTBEAT_ALARM, options: { periodInMinutes: 0.75 } }
  ]);
});

test("claim expiry uses 600 seconds of server remaining duration despite either direction of clock skew", async () => {
  for (const offsetSeconds of [-6 * 3600, 6 * 3600]) {
    const serverNow = Math.floor(Date.now() / 1000) + offsetSeconds;
    const api = loadBackground({ receiverReady: true, fetchOverride(url, options, body) {
      if (url === CLAIM_URL && body.action === "claim") return response({
        ok: true, claimed: true, claim_token: "same-server-token", server_now: serverNow,
        expires_at: serverNow + 600, lease_seconds: 600
      });
    } });
    const before = Date.now();
    await api.startRun({ provider: "chatgpt", targetTabId: TAB_ID }, sender());
    const expiry = Date.parse(api.state.items[0].writer_claim_expires_at);
    assert.ok(expiry >= before + 597000 && expiry <= Date.now() + 600000,
      `local lease must last about 600 seconds, not follow server epoch offset ${offsetSeconds}: ${expiry - before}ms`);
    assert.equal(api.state.items[0].writer_claim_token, "same-server-token");
    assert.equal(api.events.filter((event) => event.message?.type === "run-article").length, 1);
  }
});

test("locally expired leases ask the server and renew the same token instead of losing ownership", async () => {
  const expiredToken = "expired-local-server-valid";
  const api = loadBackground({ initial: { items: [{
    id: "facility-53", facility_id: 53, sourceType: "facility", status: "đang viết",
    writer_claim_required: true, writer_claim_type: "facility", writer_claim_id: 53,
    writer_claim_token: expiredToken, writer_claim_expires_at: new Date(Date.now() - 120000).toISOString()
  }] } });
  await api.heartbeatActiveWriterClaims();
  const heartbeats = api.calls.filter((call) => call.body?.action === "heartbeat");
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].body.claim_token, expiredToken);
  assert.equal(api.state.items[0].status, "đang viết");
  assert.equal(api.state.items[0].writer_claim_token, expiredToken);
  assert.ok(Date.parse(api.state.items[0].writer_claim_expires_at) > Date.now());
  assert.equal(api.events.some((event) => event.message?.type === "writer-lease-lost"), false);
});

test("overlapping heartbeat ticks are single-flight and renew workers in bounded parallel batches", async () => {
  const jobs = Array.from({ length: 8 }, (_, index) => ({
    id: `facility-${index + 53}`, facility_id: index + 53, sourceType: "facility", status: "đang viết",
    writer_claim_required: true, writer_claim_type: "facility", writer_claim_id: index + 53,
    writer_claim_token: `lease-${index + 53}`, writer_claim_expires_at: new Date(Date.now() + 180000).toISOString()
  }));
  let inFlight = 0, maxInFlight = 0;
  const pending = [];
  const api = loadBackground({ initial: { items: jobs }, fetchOverride(url, options, body) {
    if (url !== CLAIM_URL || body.action !== "heartbeat") return undefined;
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => pending.push(() => {
      inFlight -= 1;
      resolve(response({ ok: true, lease_seconds: 180 }));
    }));
  } });
  const ticks = [api.heartbeatActiveWriterClaims(), api.heartbeatActiveWriterClaims()];
  await new Promise(setImmediate);
  assert.equal(pending.length, 3, "a slow worker must not serialize all renewals or create unbounded requests");
  for (let batch = 0; batch < jobs.length; batch += 1) {
    for (const complete of pending.splice(0)) complete();
    await new Promise(setImmediate);
  }
  await Promise.all(ticks);
  const heartbeats = api.calls.filter((call) => call.body?.action === "heartbeat");
  assert.equal(heartbeats.length, jobs.length, "overlapping ticks must not send duplicate token renewals");
  assert.deepEqual(heartbeats.map((call) => call.body.id).sort((a, b) => a - b), jobs.map((job) => job.facility_id));
  assert.equal(maxInFlight, 3);
  assert.equal(api.state.items.every((item) => Date.parse(item.writer_claim_expires_at) > Date.now()), true);
});

test("facility claim is persisted per profile and acquired immediately before the prompt, without leaking token to the tab", async () => {
  const api = loadBackground();
  const started = await api.startRun({ provider: "chatgpt", targetTabId: TAB_ID }, sender());

  const claim = api.calls.find((call) => call.url === CLAIM_URL && call.body.action === "claim");
  const promptDispatch = api.events.find((event) => event.kind === "tab-message" && event.message.type === "run-article");
  const claimIndex = api.events.findIndex((event) => event.kind === "fetch" && event.body?.action === "claim");
  const promptIndex = api.events.findIndex((event) => event.kind === "tab-message" && event.message.type === "run-article");
  assert.ok(claimIndex >= 0 && promptIndex > claimIndex, `server claim must precede prompt dispatch: ${JSON.stringify({ started, runner: api.state.runner, items: api.state.items, events: api.events, calls: api.calls })}`);
  assert.equal(claim.body.type, "facility");
  assert.equal(claim.body.id, 53);
  assert.ok(claim.body.request_id);
  assert.deepEqual(claim.body.client, {
    instance_id: api.state.instance_id,
    instance_label: "Máy văn phòng",
    account_label: "ChatGPT biên tập",
    worker_id: `tab-${TAB_ID}`,
    provider: "chatgpt",
    model: "not-specified",
    task: "Nha khoa mẫu"
  });
  assert.ok(api.state.instance_id, "profile ID is persisted once in extension storage");
  assert.equal(api.state.items[0].writer_claim_token, "claim-token-53-1");
  assert.equal(promptDispatch.message.article.writer_claim_token, undefined);
  assert.equal(promptDispatch.message.article.writer_claim_request_id, undefined);
});

test("ready receiver skips reinjection while preserving lease before prompt dispatch", async () => {
  const api = loadBackground({ receiverReady: true });
  await api.startRun({ provider: "chatgpt", targetTabId: TAB_ID }, sender());
  assert.equal(api.events.some((event) => event.kind === "inject"), false);
  const claimIndex = api.events.findIndex((event) => event.kind === "fetch" && event.body?.action === "claim");
  const promptIndex = api.events.findIndex((event) => event.message?.type === "run-article");
  assert.ok(claimIndex >= 0 && promptIndex > claimIndex);
  const timing = api.events[promptIndex].message.startupTiming;
  assert.equal(timing.scriptInjected, false);
  assert.ok(timing.writerClaimMs >= 0);
  assert.ok(timing.dispatchAt >= timing.startedAt);
});

test("missing receiver is injected before taking a lease and sending a prompt", async () => {
  const api = loadBackground({ missingReceiver: true });
  await api.startRun({ provider: "chatgpt", targetTabId: TAB_ID }, sender());
  const injectIndex = api.events.findIndex((event) => event.kind === "inject");
  const claimIndex = api.events.findIndex((event) => event.kind === "fetch" && event.body?.action === "claim");
  const promptIndex = api.events.findIndex((event) => event.message?.type === "run-article");
  assert.ok(injectIndex >= 0 && claimIndex > injectIndex && promptIndex > claimIndex);
  assert.equal(api.events[promptIndex].message.startupTiming.scriptInjected, true);
});

test("writer claim requests abort after 20 seconds and always clear the timeout", async () => {
  const api = loadBackground({ simulateClaimTimeout: true });
  const request = api.requestWriterClaim("claim", { facility_id: 53 }, {
    type: "facility", id: 53, requestId: "request-timeout-53", client: { instance_id: "profile-1" }
  });
  await new Promise(setImmediate);

  assert.equal(api.claimTimeouts.length, 1);
  assert.equal(api.claimTimeouts[0].delay, 20000);
  api.claimTimeouts[0].callback();
  await assert.rejects(request, /quá thời gian 20 giây/);
  assert.equal(api.getClaimSignal().aborted, true);
  assert.deepEqual(api.clearedTimeouts, [api.claimTimeouts[0].handle]);
});

test("a 409 conflict marks the row with writer metadata and advances without sending its prompt", async () => {
  const api = loadBackground({
    conflicts: [53],
    initial: { items: [
      { id: "facility-53", facility_id: 53, title: "Đang có máy giữ", prompt: "Không gửi prompt này", status: "chờ" },
      { id: "facility-54", facility_id: 54, title: "Bài tiếp", prompt: "Prompt tiếp", status: "chờ" }
    ] }
  });
  await api.startRun({ provider: "chatgpt", targetTabId: TAB_ID }, sender());

  const prompts = api.events.filter((event) => event.kind === "tab-message" && event.message.type === "run-article");
  const first = api.state.items.find((item) => item.facility_id === 53);
  assert.deepEqual(prompts.map((event) => event.message.article.facility_id), [54]);
  assert.equal(first.status, "chờ");
  assert.equal(first.writer_claimed, true);
  assert.equal(first.writer_claim.provider, "gemini");
  assert.equal(first.writer_claim.instance_label, "Máy văn phòng");
  assert.equal(first.writer_claim.account_label, "Gemini content");
});

test("manual retry preserves the remote writer-conflict state instead of showing API failure", async () => {
  const result = { id: 53, content: "JSON đã viết" };
  const api = loadBackground({ conflicts: [53], initial: {
    items: [{ id: "facility-53", facility_id: 53, title: "Nha khoa mẫu", status: "lỗi cập nhật", result }]
  } });

  const retry = await api.retryUpdate("facility-53");
  const item = api.state.items[0];
  assert.equal(retry.ok, false);
  assert.match(retry.error, /đang được viết bởi Gemini/);
  assert.equal(item.status, "chờ");
  assert.equal(item.writer_claimed, true);
  assert.equal(item.writer_claim.account_label, "Gemini content");
  assert.equal(item.api_error, null);
  assert.deepEqual(api.state["article-content:facility-53"].result, result);
  assert.equal(api.calls.some((call) => call.url === UPDATE_URL), false);
});

test("heartbeat renews active lease and lease_lost stops the tab and blocks result ownership", async () => {
  const api = loadBackground({ heartbeatLost: true });
  await api.startRun({ provider: "chatgpt", targetTabId: TAB_ID }, sender());
  const token = api.state.items[0].writer_claim_token;
  assert.ok(token);

  const heartbeat = await api.heartbeatActiveWriterClaims();
  const item = api.state.items[0];
  assert.equal(heartbeat.ok, true);
  assert.equal(item.status, "chờ");
  assert.equal(item.writer_claimed, true);
  assert.equal(item.writer_claim.provider, "grok");
  assert.equal(item.writer_claim_token, undefined);
  assert.ok(api.events.some((event) => event.kind === "tab-message" && event.message.type === "writer-lease-lost"));
});

test("facility update sends the complete AI record plus only that record's claim token", async () => {
  const api = loadBackground();
  const aiResult = { id: 53, name: "Nha khoa mẫu", content: "Bài", reviews: [{ rating: 5 }], future_field: { yes: true } };
  const queueItem = { id: "facility-53", facility_id: 53, sourceType: "facility", writer_claim_required: true, writer_claim_token: "secret-53" };
  const result = await api.updateFacilityContent(queueItem, aiResult);
  const post = api.calls.find((call) => call.url === UPDATE_URL);

  assert.equal(result.ok, true);
  assert.deepEqual(post.body, { items: [{ ...aiResult, writer_claim_token: "secret-53" }] });
  assert.equal(aiResult.writer_claim_token, undefined, "the saved AI JSON itself is not mutated");
});

test("stopping a facility writer releases its server token", async () => {
  const api = loadBackground();
  await api.startRun({ provider: "chatgpt", targetTabId: TAB_ID }, sender());
  const token = api.state.items[0].writer_claim_token;
  const stopped = await api.stopRun({ provider: "chatgpt", targetTabId: TAB_ID }, sender());

  const release = api.calls.find((call) => call.url === CLAIM_URL && call.body.action === "release");
  assert.equal(stopped.ok, true);
  assert.equal(release.body.claim_token, token);
  assert.equal(api.state.items[0].writer_claim_token, undefined);
  assert.equal(api.state.items[0].status, "chờ");
});

test("valid facility JSON is token-checked, posted, and the local claim is cleared only after server success", async () => {
  const api = loadBackground();
  await api.startRun({ provider: "chatgpt", targetTabId: TAB_ID }, sender());
  const articleId = api.state.runner.workers[`tab-${TAB_ID}`].currentId;
  const runToken = api.state.runner.workers[`tab-${TAB_ID}`].runToken;
  const response = await api.handleArticleComplete({
    articleId, runToken, article: { id: 53, content: "JSON", reviews: [{ source: "test" }] }, rawResponse: '{"id":53}'
  }, sender());

  const post = api.calls.find((call) => call.url === UPDATE_URL);
  assert.equal(response.ok, true);
  assert.equal(post.body.items[0].writer_claim_token, "claim-token-53-1");
  assert.equal(api.state.items[0].status, "hoàn tất");
  assert.equal(api.state.items[0].writer_claim_token, undefined);
  assert.equal(api.calls.some((call) => call.url === CLAIM_URL && call.body.action === "release"), false,
    "a successful content update clears the lease server-side; do not release it twice");
});

test("doctor records resolve a doctor claim type and cannot fall through to facility update API", async () => {
  const api = loadBackground();
  const doctor = { id: "doctor-8", doctor_id: 8, sourceType: "doctor" };
  assert.equal(api.writerClaimType(doctor), "doctor");
  await assert.rejects(api.updateFacilityContent(doctor, { id: 8, content: "Doctor article" }), /Tên bác sĩ/);
  assert.equal(api.calls.some((call) => call.url === UPDATE_URL), false);
});
