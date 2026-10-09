const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const defaults = {
  facilitiesUrl: "https://medreview.vn/api/medical/facilities-needing-content.php?page=1&limit=1&type=facility",
  toplistsUrl: "https://medreview.vn/api/medical/toplists-needing-members.php?page=1&limit=1"
};

function loadBackground(initial = {}, getResponses = [], options = {}) {
  const state = plain(initial);
  const fetchCalls = [];
  const sentMessages = [];
  const tabUpdates = [];
  let responseIndex = 0;
  let messageListener;
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    chrome: {
      runtime: {
        ...(options.runtimeId ? { id: options.runtimeId } : {}),
        onMessage: { addListener(callback) { messageListener = callback; } },
        onInstalled: { addListener() {} }
      },
      storage: { local: {
        async get(keys) {
          const wanted = keys == null ? Object.keys(state) : Array.isArray(keys) ? keys : [keys];
          return plain(Object.fromEntries(wanted.filter((key) => key in state).map((key) => [key, state[key]])));
        },
        async set(values) { Object.assign(state, plain(values)); options.onSet?.(state); }
      } },
      tabs: {
        async query() { return [{ id: 33, url: "https://chatgpt.com/c/test" }]; },
        async update(id, values) { tabUpdates.push({ id, values: plain(values) }); },
        async sendMessage(id, message) { if (message.type !== "runner-ready") sentMessages.push({ id, message: plain(message) }); return { ok: true }; }
      },
      scripting: { async executeScript() {} }
    },
    AbortController, setTimeout: options.setTimeout || setTimeout, clearTimeout, URL,
    fetch: async (url, options = {}) => {
      if (String(url).includes("writer-claim.php")) {
        const request = JSON.parse(options.body || "{}");
        const body = request.action === "claim"
          ? { ok: true, claimed: true, claim_token: `test-claim-${request.id}`, lease_seconds: 180 }
          : { ok: true, lease_seconds: 180, released: request.action === "release" };
        return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
      }
      fetchCalls.push({ url, options: plain({ ...options, signal: undefined }) });
      const fixture = getResponses[Math.min(responseIndex++, Math.max(getResponses.length - 1, 0))] ?? { ok: true, items: [] };
      if (fixture.throw) throw new Error(fixture.throw);
      const status = fixture.status ?? 200;
      const body = fixture.body ?? fixture;
      return {
        ok: fixture.httpOk ?? (status >= 200 && status < 300), status,
        async json() { return plain(body); },
        async text() { return JSON.stringify(body); }
      };
    }
  });
  const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8") + `
    globalThis.__queueTests = { runNext, refillQueue, mergeQueueItems, queueItemKey, finishJob, waitBeforeNextJob, prepareNextArticle };
  `;
  vm.runInContext(source, context, { filename: "background.js" });
  return {
    ...context.__queueTests, state, fetchCalls, sentMessages, tabUpdates,
    dispatch(message, sender = {}) {
      return new Promise((resolve, reject) => {
        const accepted = messageListener(message, sender, resolve);
        if (!accepted) reject(new Error("Message handler did not accept request"));
      });
    }
  };
}

test("countdown loads and prepares only one next article without sending it early", async () => {
  let finishPause;
  let notifyPrepared;
  const prepared = new Promise((resolve) => { notifyPrepared = resolve; });
  const api = loadBackground({
    sourceType: "facility", nextJobDelayMs: 60000,
    runner: { active: true, provider: "chatgpt", currentId: null, runToken: "run-1" },
    items: [{ id: "facility-1", facility_id: 1, status: "hoàn tất", result: { id: 1 } }]
  }, [{ ok: true, items: [
    { id: 2, name: "Bài kế tiếp", prompt: "Prompt đã chuẩn bị" },
    { id: 3, name: "Không nạp trước", prompt: "Prompt 3" }
  ] }], {
    runtimeId: "test-extension",
    setTimeout(callback, ms) {
      if (ms > 50000 && callback.name !== "abortQueueRead") { finishPause = callback; return 1; }
      return setTimeout(callback, ms);
    },
    onSet(state) { if (state.items?.some((item) => item.id === "facility-2")) notifyPrepared(); }
  });
  const waiting = api.waitBeforeNextJob();
  await prepared;
  assert.equal(api.state["article-content:facility-2"].prompt, "Prompt đã chuẩn bị");
  assert.equal(api.state.items.find((item) => item.id === "facility-2").status, "chờ");
  assert.equal(api.state.items.some((item) => item.id === "facility-3"), false);
  assert.equal(new URL(api.fetchCalls[0].url).searchParams.get("limit"), "1");
  assert.equal(api.sentMessages.length, 0);
  await api.runNext();
  assert.equal(api.sentMessages.length, 0, "prepared prompt must wait for the countdown");
  assert.ok(api.state.runner.nextJobAt > Date.now(), "the persisted countdown remains until dispatch consumes it");
  api.state.runner.nextJobAt = Date.now() - 1; // Simulate the captured timer actually reaching its deadline.
  finishPause();
  const result = await waiting;
  assert.equal(result.attempted, true);
  await api.runNext(undefined, false);
  const prompts = api.sentMessages.filter((entry) => entry.message.type === "run-article");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].message.prompt, "Prompt đã chuẩn bị");
  assert.equal(api.fetchCalls.length, 1, "use the prepared item without fetching again");
});

test("preparing the next article reuses queued data and leaves saved Spark failures first", async () => {
  const api = loadBackground({ sourceType: "facility", items: [
    { id: "facility-41", facility_id: 41, prompt: "Retry", status: "lỗi", provider: "gemini" }
  ], runner: { active: true, sourceType: "facility", workers: {
    "tab-404": { active: true, provider: "gemini", currentId: null, targetTabId: 404, sparkTaskId: "task" }
  } } });
  const result = await api.prepareNextArticle("tab-404");
  assert.equal(result.attempted, false);
  assert.equal(api.fetchCalls.length, 0);
});

test("completing the last queued article immediately refills and starts the next article", async () => {
  const api = loadBackground({
    sourceType: "facility",
    runner: { active: true, provider: "chatgpt", currentId: "facility-1", refilling: false },
    items: [{ id: "facility-1", facility_id: 1, title: "Bài đầu", prompt: "P1", status: "đang viết" }]
  }, [
    { ok: true, errors: [], updated_count: 1, updated_ids: [1] },
    { ok: true, items: [{ id: 2, name: "Bài kế tiếp", prompt: "P2" }] }
  ]);

  const response = await api.dispatch({
    type: "article-complete", articleId: "facility-1",
    article: { id: 1, content: "Nội dung hoàn tất" }, rawResponse: '{"id":1}'
  });

  assert.equal(response.ok, true);
  assert.equal(api.fetchCalls.length, 2, "one update POST followed by one list GET");
  assert.equal(api.fetchCalls[0].options.method, "POST");
  assert.equal(api.fetchCalls[1].url, defaults.facilitiesUrl);
  assert.deepEqual(api.state.items.map(({ id, status }) => ({ id, status })), [
    { id: "facility-1", status: "hoàn tất" },
    { id: "facility-2", status: "đang viết" }
  ]);
  assert.equal(api.state.runner.active, true);
  assert.equal(api.state.runner.currentId, "facility-2");
  assert.equal(api.sentMessages.length, 1);
  assert.equal(api.sentMessages[0].message.prompt, "P2");
});

test("parallel API completions preserve both AI results without overwriting storage", async () => {
  const api = loadBackground({
    items: [
      { id: "facility-101", facility_id: 101, provider: "chatgpt", status: "đang viết" },
      { id: "facility-102", facility_id: 102, provider: "grok", status: "đang viết" }
    ]
  }, [
    { ok: true, errors: [], updated_count: 1, updated_ids: [101] },
    { ok: true, errors: [], updated_count: 1, updated_ids: [102] }
  ]);

  await Promise.all([
    api.finishJob("facility-101", { id: 101, content: "ChatGPT" }, '{"id":101}'),
    api.finishJob("facility-102", { id: 102, content: "Grok" }, '{"id":102}')
  ]);

  assert.deepEqual(api.state.items.map(({ id, status }) => ({ id, status, content: api.state["article-content:" + id].result.content })), [
    { id: "facility-101", status: "hoàn tất", content: "ChatGPT" },
    { id: "facility-102", status: "hoàn tất", content: "Grok" }
  ]);
});

test("when one parallel worker finishes it takes the next waiting article without touching the other worker", async () => {
  const api = loadBackground({
    sourceType: "facility",
    runner: {
      active: true, parallel: true, sourceType: "facility", sessionToken: "session-1",
      currentId: "facility-1", targetProvider: "chatgpt", targetTabId: 33,
      workers: {
        "tab-33": { active: true, provider: "chatgpt", currentId: "facility-1", runToken: "chat-token", targetTabId: 33 },
        "tab-44": { active: true, provider: "grok", currentId: "facility-2", runToken: "grok-token", targetTabId: 44 }
      }
    },
    items: [
      { id: "facility-1", facility_id: 1, title: "Bài ChatGPT", prompt: "P1", provider: "chatgpt", status: "đang viết" },
      { id: "facility-2", facility_id: 2, title: "Bài Grok", prompt: "P2", provider: "grok", status: "đang viết" },
      { id: "facility-3", facility_id: 3, title: "Bài kế", prompt: "P3", status: "chờ" }
    ]
  }, [{ ok: true, errors: [], updated_count: 1, updated_ids: [1] }]);

  const response = await api.dispatch({
    type: "article-complete", articleId: "facility-1", runToken: "chat-token",
    article: { id: 1, content: "Xong" }, rawResponse: '{"id":1}'
  }, { tab: { id: 33, url: "https://chatgpt.com/c/test" } });

  assert.equal(response.ok, true);
  assert.equal(api.state.runner.workers["tab-44"].currentId, "facility-2");
  assert.equal(api.state.runner.workers["tab-33"].currentId, "facility-3");
  assert.equal(api.state.items.find((item) => item.id === "facility-2").status, "đang viết");
  assert.equal(api.state.items.find((item) => item.id === "facility-3").provider, "chatgpt");
  assert.equal(api.sentMessages.at(-1).message.article.id, "facility-3");
});

test("an empty active facility queue reloads the custom URL, preserves history, and starts the new exact prompt", async () => {
  const prompt = "  Prompt API nguyên vẹn\nGiữ cả khoảng trắng cuối.  ";
  const api = loadBackground({
    sourceType: "facility",
    facilitiesUrl: "https://example.invalid/facilities?page=8",
    runner: { active: true, provider: "chatgpt", currentId: null },
    items: [
      { id: "facility-7", facility_id: 7, title: "Đã xong", prompt: "Prompt cũ", status: "hoàn tất", result: { id: 7 } },
      { id: "facility-8", facility_id: 8, title: "Đã lỗi", prompt: "Prompt lỗi", status: "lỗi", error: "AI lỗi" }
    ]
  }, [{ ok: true, items: [
    { id: 7, name: "Bản trùng lịch sử", prompt: "Prompt mới không được ghi đè" },
    { id: 8, name: "Bản trùng bài lỗi", prompt: "Không chạy lại tự động" },
    { id: 9, name: "Bài mới", prompt }
  ] }]);

  await api.runNext();

  assert.equal(api.fetchCalls.length, 1);
  assert.equal(api.fetchCalls[0].url, "https://example.invalid/facilities?page=8&limit=1");
  assert.deepEqual(api.fetchCalls[0].options.headers, { "X-Medical-Api-Key": "test-medical-key", Accept: "application/json" });
  assert.equal(api.state.items.length, 3);
  assert.deepEqual(api.state.items.slice(0, 2).map(({ id, status }) => ({ id, status })), [
    { id: "facility-7", status: "hoàn tất" }, { id: "facility-8", status: "lỗi" }
  ]);
  assert.equal(api.state.items[2].id, "facility-9");
  assert.equal(api.state["article-content:" + api.state.items[2].id].prompt, prompt);
  assert.equal(api.state.items[2].status, "đang viết");
  assert.equal(api.state.runner.active, true);
  assert.equal(api.state.runner.currentId, "facility-9");
  assert.equal(api.state.runner.refilling, false);
  assert.equal(api.sentMessages.length, 1);
  assert.equal(api.sentMessages[0].message.article.id, "facility-9");
  assert.equal(api.sentMessages[0].message.prompt, prompt);
});

test("facility and Toplist histories with the same numeric ID stay distinct during Toplist refill", async () => {
  const api = loadBackground({
    sourceType: "toplist",
    toplistsUrl: "https://example.invalid/toplists?page=3",
    runner: { active: true, provider: "chatgpt", currentId: null },
    items: [{ id: "facility-7", facility_id: 7, prompt: "Cơ sở", status: "hoàn tất", result: { id: 7 } }]
  }, [{ ok: true, items: [
    { id: 7, title: "Top 7", prompt: "Viết Toplist 7" },
    { id: 8, title: "Top 8", prompt: "Viết Toplist 8" }
  ] }]);

  await api.runNext();

  assert.equal(api.fetchCalls[0].url, "https://example.invalid/toplists?page=3&limit=1");
  assert.deepEqual(api.state.items.map(({ id }) => id), ["facility-7", "toplist-7", "toplist-8"]);
  assert.equal(api.state.items[0].status, "hoàn tất");
  assert.equal(api.state.items[1].status, "đang viết");
  assert.equal(api.state.items[2].status, "chờ");
  assert.equal(api.sentMessages[0].message.article.sourceType, "toplist");
  assert.equal(api.sentMessages[0].message.article.toplist_id, 7);
});

test("an empty refill or a response containing only historical IDs stops once without looping", async () => {
  for (const fixture of [
    { ok: true, items: [] },
    { ok: true, items: [{ id: 5, name: "Đã xử lý", prompt: "Không thêm lại" }] }
  ]) {
    const api = loadBackground({
      sourceType: "facility",
      runner: { active: true, provider: "chatgpt", currentId: null },
      items: [{ id: "facility-5", facility_id: 5, prompt: "Cũ", status: "hoàn tất", result: { id: 5 } }]
    }, [fixture]);

    await api.runNext();

    assert.equal(api.fetchCalls.length, 1);
    assert.equal(api.sentMessages.length, 0);
    assert.equal(api.state.items.length, 1);
    assert.equal(api.state.runner.active, false);
    assert.equal(api.state.runner.currentId, null);
    assert.equal(api.state.runner.refilling, false);
    assert.equal(api.state.runner.lastError, null);
    assert.match(api.state.runner.lastMessage, /Không còn .* mới/);
  }
});

test("a refill API error stops cleanly and saves a useful diagnostic", async () => {
  const api = loadBackground({
    sourceType: "toplist",
    runner: { active: true, provider: "chatgpt", currentId: null },
    items: []
  }, [{ status: 503, httpOk: false, body: { ok: false, message: "Bảo trì" } }]);

  await api.runNext();

  assert.equal(api.fetchCalls.length, 1);
  assert.equal(api.sentMessages.length, 0);
  assert.equal(api.state.runner.active, false);
  assert.equal(api.state.runner.refilling, false);
  assert.match(api.state.runner.lastError, /503/);
  assert.match(api.state.runner.lastMessage, /Toplist.*thất bại/);
});

test("auto refill runs only while active and with no pending or current job", async () => {
  const inactive = loadBackground({ runner: { active: false }, items: [] }, [{ ok: true, items: [{ id: 1, name: "Mới", prompt: "P" }] }]);
  await inactive.runNext();
  assert.equal(inactive.fetchCalls.length, 0);

  const pending = loadBackground({
    sourceType: "facility", runner: { active: true, provider: "chatgpt", currentId: null },
    items: [{ id: "facility-2", facility_id: 2, title: "Có sẵn", prompt: "P2", status: "chờ" }]
  }, [{ ok: true, items: [{ id: 3, name: "Không cần tải", prompt: "P3" }] }]);
  await pending.runNext();
  assert.equal(pending.fetchCalls.length, 0);
  assert.equal(pending.sentMessages.length, 1);
  assert.equal(pending.state.runner.currentId, "facility-2");

  const current = loadBackground({
    sourceType: "toplist", runner: { active: true, provider: "chatgpt", currentId: "toplist-4" },
    items: [{ id: "toplist-4", sourceType: "toplist", toplist_id: 4, prompt: "P4", status: "đang viết" }]
  });
  await current.runNext();
  assert.equal(current.fetchCalls.length, 0);
  assert.equal(current.sentMessages.length, 0);
});

test("legacy installs without a saved source selection refill facilities through the default URL", async () => {
  const api = loadBackground({
    runner: { active: true, provider: "chatgpt", currentId: null }, items: []
  }, [{ ok: true, items: [{ id: 21, name: "Cơ sở mặc định", prompt: "P21" }] }]);

  await api.runNext();

  assert.equal(api.fetchCalls.length, 1);
  assert.equal(api.fetchCalls[0].url, defaults.facilitiesUrl);
  assert.equal(api.state.runner.currentId, "facility-21");
  assert.equal(api.sentMessages[0].message.article.facility_id, 21);
});
