const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionRoot = path.resolve(__dirname, "..");
const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function loadBackground(initial, harnessOptions = {}) {
  const state = plain(initial);
  const tabs = new Map([
    [101, { id: 101, url: "https://grok.com/c/first" }],
    [202, { id: 202, url: "https://grok.com/c/second" }],
    [303, { id: 303, url: "https://claude.ai/chat/third" }],
    [505, { id: 505, url: "https://chatgpt.com/c/fifth" }],
    [404, { id: 404, url: "https://gemini.google.com/spark/chat/4fd44b00d57b4bc9?hl=vi" }]
  ]);
  const sent = [];
  const tabUpdates = [];
  const reloadedTabs = [];
  const fetchCalls = [];
  let removedListener;
  let messageListener;
  let alarmListener;
  const createdAlarms = [];
  const storageReads = [];
  const storageWrites = [];
  const chrome = {
    runtime: {
      ...(harnessOptions.runtimeId ? { id: harnessOptions.runtimeId } : {}),
      onMessage: { addListener(listener) { messageListener = listener; } },
      onInstalled: { addListener() {} }
    },
    storage: { local: {
      async get(keys) {
        const wanted = keys == null ? Object.keys(state) : Array.isArray(keys) ? keys : [keys];
        storageReads.push([...wanted]);
        return plain(Object.fromEntries(wanted.filter((key) => key in state).map((key) => [key, state[key]])));
      },
      async set(values) { storageWrites.push(plain(values)); Object.assign(state, plain(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; }
    } },
    tabs: {
      onRemoved: { addListener(listener) { removedListener = listener; } },
      async get(tabId) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error("No tab");
        return plain(tab);
      },
      async query(query) {
        if (query.active) return [plain(tabs.get(101))];
        return [...tabs.values()].filter((tab) => {
          if (query.url === "*://grok.com/*") return tab.url.startsWith("https://grok.com/");
          if (query.url === "*://claude.ai/*") return tab.url.startsWith("https://claude.ai/");
          return false;
        }).map(plain);
      },
      async update(tabId, values) { tabUpdates.push({ tabId, values: plain(values) }); },
      async reload(tabId) { reloadedTabs.push(Number(tabId)); },
      async sendMessage(tabId, message) {
        sent.push({ tabId, message: plain(message) });
        if (message.type === "read-existing-article-json") {
          return plain(state.recoveryResponse || { ok: true, article: { id: 53, name: "Nha Khoa Huế", content: "JSON đã có trong Spark" }, rawResponse: '{"id":53}' });
        }
        return { ok: true };
      }
    },
    alarms: {
      create(name, options) { createdAlarms.push({ name, options: plain(options) }); },
      onAlarm: { addListener(listener) { alarmListener = listener; } }
    },
    scripting: { async executeScript() {} }
  };
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    if (String(url).includes("writer-claim.php")) {
      const result = body.action === "claim"
        ? { ok: true, claimed: true, claim_token: `test-claim-${body.id}`, lease_seconds: 180 }
        : { ok: true, lease_seconds: 180, released: body.action === "release" };
      return { ok: true, status: 200, async text() { return JSON.stringify(result); } };
    }
    fetchCalls.push({ url, options: plain(options) });
    const id = body.items?.[0]?.id;
    const responseBody = options.body ? { ok: true, updated_ids: [id], updated_count: 1, errors: [] } : { ok: true, items: [] };
    const fixture = harnessOptions.fetchResponse ? await harnessOptions.fetchResponse(url, body, options) : responseBody;
    return {
      ok: true,
      status: 200,
      async json() { return plain(fixture); },
      async text() {
        return JSON.stringify(fixture);
      }
    };
  };
  const source = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8") + `
    globalThis.__multiTabTests = {
      startRun, stopRun, getCurrentArticle, handleArticleComplete, handleArticleFailed, recoverExistingArticle,
      resolveControlTab, stopWorkerIfProviderChanged, checkGeminiSparkStalls,
      recordArticleProgress, markGeminiSparkStallReload, recordArticleRetryCountdown,
      scheduleSparkJobRetry, dispatchSparkJobRetry, continueAfterReload, recordArticlePromptSent,
      prepareNextArticle, recordArticlePromptPrepared, resumeNextJobDeadline, restoreNextJobAlarms, recordSystemNotice, pruneCompletedHistory, retryUpdate, clearCurrent, jobStorage, getJobMetadata, hydrateArticle, getArticleContent,
      refreshQueue, refillWorkerQueue, mergeQueueItems, runNext, getTabSettings, recoverIdleWorkers, waitBeforeNextJob, fetchTranslations
    };
  `;
  const retryTimers = [];
  const testSetTimeout = (callback, ms) => {
    if (harnessOptions.setTimeout) return harnessOptions.setTimeout(callback, ms);
    if (ms === 5000) { retryTimers.push(callback); return retryTimers.length; }
    return setTimeout(callback, ms);
  };
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key", chrome, fetch, URL, structuredClone, AbortController, setTimeout: testSetTimeout, clearTimeout: harnessOptions.clearTimeout || clearTimeout });
  vm.runInContext(source, context, { filename: "background.js" });
  return { ...context.__multiTabTests, state, sent, tabUpdates, reloadedTabs, fetchCalls, tabs,
    getRemovedListener: () => removedListener, getAlarmListener: () => alarmListener, createdAlarms, retryTimers, storageReads, storageWrites,
    dispatch(message, sender = {}) { return new Promise((resolve) => messageListener(message, sender, resolve)); }
  };
}

test("failed Spark article keeps its queue slot and retries before the next queued article", async () => {
  const api = loadBackground({ sourceType: "facility", runner: { active: false }, items: [
    { id: "facility-41", facility_id: 41, title: "A", prompt: "Prompt A", status: "chờ" },
    { id: "facility-42", facility_id: 42, title: "B", prompt: "Prompt B", status: "chờ" }
  ] });
  const sparkSender = sender(404, api.tabs.get(404).url);
  await api.startRun({ provider: "gemini", targetTabId: 404 }, sparkSender);
  const worker = api.state.runner.workers["tab-404"];
  const failed = await api.handleArticleFailed({ articleId: worker.currentId, runToken: worker.runToken, error: "Spark failed" }, sparkSender);
  assert.equal(failed.retrying, true);
  assert.equal(api.state.runner.workers["tab-404"].currentId, "facility-41");
  assert.equal(api.state.items[0].status, "đang viết");
  assert.equal(api.state.items[1].status, "chờ");
  const deadline = Date.parse(api.state.items[0].gemini_spark_dispatch_retry_at);
  const before = api.sent.filter((entry) => entry.message.type === "run-article").length;
  await api.dispatchSparkJobRetry("tab-404", deadline - 1);
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, before);
  await Promise.all([api.dispatchSparkJobRetry("tab-404", deadline), api.checkGeminiSparkStalls(deadline)]);
  const prompts = api.sent.filter((entry) => entry.message.type === "run-article");
  assert.equal(prompts.length, before + 1);
  assert.equal(prompts.at(-1).message.article.id, "facility-41");
  assert.equal(prompts.at(-1).message.prompt, "Prompt A");
  assert.equal(api.state.items[1].status, "chờ");
  await api.handleArticleFailed({ articleId: worker.currentId, runToken: worker.runToken, error: "Spark failed again" }, sparkSender);
  await api.stopRun({ provider: "gemini", targetTabId: 404 }, sparkSender);
  await api.dispatchSparkJobRetry("tab-404", Date.now() + 10000);
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, prompts.length);
});

test("reload resumes an idle Spark worker with a saved failed article before its next-job countdown", async () => {
  const api = loadBackground({ sourceType: "facility", items: [
    { id: "facility-new", facility_id: 42, title: "Bài mới", prompt: "Prompt new", status: "chờ" },
    { id: "facility-quoc-binh", facility_id: 41, title: "Nha khoa Quốc Bình", prompt: "Prompt Quốc Bình", status: "lỗi", provider: "gemini" }
  ], runner: { active: true, sourceType: "facility", workers: {
    "tab-404": { active: true, provider: "gemini", targetTabId: 404, sparkTaskId: "4fd44b00d57b4bc9", currentId: null, runToken: "old-run", nextJobAt: Date.now() + 60000 }
  } } });
  await api.continueAfterReload(sender(404, api.tabs.get(404).url));
  const worker = api.state.runner.workers["tab-404"];
  assert.equal(worker.currentId, "facility-quoc-binh");
  assert.equal(worker.nextJobAt, undefined);
  assert.equal(api.state.items[1].status, "đang viết");
  assert.equal(api.state.items[0].status, "chờ");
  const prompts = api.sent.filter((entry) => entry.message.type === "run-article");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].message.prompt, "Prompt Quốc Bình");
});

test("Spark alarm repairs an old failed current slot and does not start a new article", async () => {
  const api = loadBackground({ sourceType: "facility", items: [
    { id: "facility-41", facility_id: 41, title: "Quốc Bình", prompt: "Prompt A", status: "lỗi", provider: "gemini" },
    { id: "facility-42", facility_id: 42, title: "B", prompt: "Prompt B", status: "chờ" }
  ], runner: { active: true, sourceType: "facility", workers: {
    "tab-404": { active: true, provider: "gemini", targetTabId: 404, sparkTaskId: "4fd44b00d57b4bc9", currentId: "facility-41", runToken: "old-run" }
  } } });
  await api.checkGeminiSparkStalls();
  assert.equal(api.state.runner.workers["tab-404"].currentId, "facility-41");
  assert.notEqual(api.state.runner.workers["tab-404"].runToken, "old-run");
  assert.equal(api.state.items[0].status, "đang viết");
  assert.equal(api.state.items[1].status, "chờ");
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, 1);
});

test("starting Spark prioritizes saved failures but excludes failures belonging to another task", async () => {
  const api = loadBackground({ sourceType: "facility", runner: { active: false }, items: [
    { id: "facility-43", facility_id: 43, title: "Other", prompt: "Other", status: "lỗi", provider: "gemini", sparkTaskId: "other-task" },
    { id: "facility-42", facility_id: 42, title: "B", prompt: "Prompt B", status: "chờ" },
    { id: "facility-41", facility_id: 41, title: "Quốc Bình", prompt: "Prompt A", status: "lỗi", provider: "gemini" }
  ] });
  await api.startRun({ provider: "gemini", targetTabId: 404 }, sender(404, api.tabs.get(404).url));
  assert.equal(api.state.runner.workers["tab-404"].currentId, "facility-41");
  assert.equal(api.state.items[0].status, "lỗi");
  assert.equal(api.state.items[1].status, "chờ");
});

test("a newly sent Spark prompt resets the old reload clock and rejects an immediate reload", async () => {
  const stale = new Date(Date.now() - 20 * 60000).toISOString();
  const api = loadBackground({ sourceType: "facility", items: [
    { id: "facility-41", facility_id: 41, status: "đang viết", provider: "gemini", write_started_at: stale, last_progress_at: stale, gemini_spark_reload_attempted_at: stale }
  ], runner: { active: true, sourceType: "facility", workers: {
    "tab-404": { active: true, provider: "gemini", targetTabId: 404, sparkTaskId: "4fd44b00d57b4bc9", currentId: "facility-41", runToken: "run-41" }
  } } });
  const source = sender(404, api.tabs.get(404).url);
  assert.equal((await api.recordArticlePromptSent({ articleId: "facility-41", runToken: "run-41" }, source)).ok, true);
  const sentAt = Date.parse(api.state.items[0].prompt_sent_at);
  assert.equal(api.state.items[0].gemini_spark_reload_attempted_at, undefined);
  const early = await api.markGeminiSparkStallReload({ articleId: "facility-41", runToken: "run-41" }, source, sentAt + 1000);
  assert.equal(early.reload, false);
  await api.checkGeminiSparkStalls(sentAt + 599999);
  assert.equal(api.reloadedTabs.length, 0);
  await api.checkGeminiSparkStalls(sentAt + 600000);
  assert.deepEqual(api.reloadedTabs, [404]);
});

test("Spark prepares the next prompt and acquires its lease during the countdown", async () => {
  const deadline = Date.now() + 60000;
  const api = loadBackground({ sourceType: "facility", items: [
    { id: "facility-41", facility_id: 41, title: "Next", prompt: "Prompt next", status: "chờ" }
  ], runner: { active: true, sourceType: "facility", workers: {
    "tab-404": { active: true, provider: "gemini", targetTabId: 404, sparkTaskId: "4fd44b00d57b4bc9", currentId: null, runToken: "old-run", nextJobAt: deadline }
  } } });
  const prepared = await api.prepareNextArticle("tab-404");
  assert.equal(prepared.dispatched, true);
  assert.equal(api.state.runner.workers["tab-404"].nextJobAt, deadline);
  const item = api.state.items[0];
  assert.equal(item.status, "đang viết");
  assert.ok(item.writer_claim_token, "lease is obtained before preparing the scheduled prompt");
  const prompt = api.sent.find((entry) => entry.message.type === "run-article");
  assert.equal(Date.parse(prompt.message.article.prompt_scheduled_at), deadline);
  assert.equal(prompt.message.article.prompt_dispatch_ready, true);
  assert.equal(prompt.message.article.writer_claim_token, undefined);
  const source = sender(404, api.tabs.get(404).url);
  const message = { articleId: item.id, runToken: api.state.runner.workers["tab-404"].runToken };
  assert.equal((await api.recordArticlePromptPrepared(message, source)).ok, true);
  assert.ok(api.state.items[0].prompt_prepared_at);
  await api.checkGeminiSparkStalls(deadline - 1);
  assert.deepEqual(api.reloadedTabs, []);
  await api.stopRun({ provider: "gemini", targetTabId: 404 }, source);
  assert.equal(api.state.items[0].status, "chờ");
});

function expiredCountdownState({ current = false, ready = true, active = true, future = false, refilling = false } = {}) {
  const deadline = Date.now() + (future ? 60000 : -1000);
  return { sourceType: "facility", items: [
    { id: "facility-41", facility_id: 41, title: "Next", prompt: "Prompt next", provider: "gemini",
      status: current ? "đang viết" : "chờ",
      ...(current ? { workerKey: "tab-404", prompt_scheduled_at: new Date(deadline).toISOString(), prompt_dispatch_ready: ready } : {}) }
  ], runner: { active, refilling, sourceType: "facility", workers: {
    "tab-404": { active, provider: "gemini", targetTabId: 404, sparkTaskId: "4fd44b00d57b4bc9", currentId: current ? "facility-41" : null, runToken: "run-next", nextJobAt: deadline }
  } } };
}

test("deadline alarm resumes a persisted idle countdown after background restart exactly once", async () => {
  const api = loadBackground(expiredCountdownState({ refilling: true }));
  await Promise.all([
    api.getAlarmListener()({ name: "medreview-next-job:tab-404" }),
    api.resumeNextJobDeadline("tab-404")
  ]);
  assert.equal(api.state.runner.workers["tab-404"].currentId, "facility-41");
  assert.equal(api.state.runner.workers["tab-404"].nextJobAt, undefined);
  assert.equal(api.state.runner.refilling, false);
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, 1);
});

test("deadline alarm wakes the same prefilled article without claiming a new article", async () => {
  const api = loadBackground(expiredCountdownState({ current: true }));
  await api.resumeNextJobDeadline("tab-404");
  const messages = api.sent.filter((entry) => entry.message.type === "resume-scheduled-article");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.article.id, "facility-41");
  assert.equal(messages[0].message.article.runToken, "run-next");
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, 0);
});

test("deadline recovery obtains a lease if preparation was interrupted before readiness", async () => {
  const api = loadBackground(expiredCountdownState({ current: true, ready: false }));
  await api.resumeNextJobDeadline("tab-404");
  assert.ok(api.state.items[0].writer_claim_token);
  assert.equal(api.state.items[0].prompt_dispatch_ready, true);
  assert.equal(api.sent.filter((entry) => entry.message.type === "run-article").length, 1);
});

test("split storage migrates content and updates progress without reading or writing large payloads", async () => {
  const initial = expiredCountdownState({ current: true });
  const prompt = "Prompt dài\n".repeat(10000);
  initial.items[0].prompt = prompt;
  initial.items[0].result = { id: 41, content: "Nội dung dài".repeat(10000) };
  initial.items[0].rawResponse = JSON.stringify(initial.items[0].result);
  const api = loadBackground(initial);
  await api.jobStorage.set({ items: api.state.items });
  assert.equal(api.state.items[0].prompt, undefined);
  assert.equal(api.state.items[0].result, undefined);
  assert.equal(api.state.items[0].has_result, true);
  assert.equal(api.state["article-content:facility-41"].prompt, prompt);
  const readIndex = api.storageReads.length;
  const writeIndex = api.storageWrites.length;
  await api.recordArticleProgress({ articleId: "facility-41", runToken: "run-next", progressAt: new Date().toISOString() }, sender(404, api.tabs.get(404).url));
  assert.equal(api.storageReads.slice(readIndex).some((keys) => keys.some((key) => key.startsWith("article-content:"))), false);
  assert.equal(api.storageWrites.slice(writeIndex).some((values) => Object.keys(values).some((key) => key.startsWith("article-content:"))), false);
  const recovered = await api.getCurrentArticle("gemini", sender(404, api.tabs.get(404).url));
  assert.equal(recovered.article.prompt, prompt, "recovery hydrates only the current article on demand");
  const cold = loadBackground(api.state);
  assert.equal((await cold.getCurrentArticle("gemini", sender(404, cold.tabs.get(404).url))).article.prompt, prompt, "content survives background restart");
  const { items } = await api.getJobMetadata("items");
  items[0].result = { id: 41, content: "New result" };
  await api.jobStorage.set({ items });
  const updated = await api.getArticleContent("facility-41");
  assert.equal(updated.content.prompt, prompt, "a new JSON result cannot erase an existing prompt");
  assert.equal(updated.content.result.content, "New result");
  await api.jobStorage.set({ items: [] });
  assert.equal(api.state["article-content:facility-41"], undefined, "removed history also removes its content key");
});

test("completed history retains the two latest successes and all pending or failed JSON", async () => {
  const complete = (id, minute) => ({ id: `facility-${id}`, facility_id: id, status: "hoàn tất", prompt: `Prompt ${id}`, rawResponse: `Raw ${id}`, result: { id, content: "Saved" }, completed_at: `2026-09-29T10:${minute}:00.000Z` });
  const api = loadBackground({ runner: { active: false }, items: [
    complete(1, "04"), complete(2, "01"), complete(3, "03"), complete(4, "02"),
    { id: "facility-5", status: "lỗi cập nhật", result: { id: 5, content: "Retry me" } },
    { id: "facility-6", status: "chưa xác nhận", result: { id: 6 } },
    { id: "facility-7", status: "đang cập nhật", result: { id: 7 } },
    { id: "facility-8", status: "chờ", prompt: "Next" }
  ] });
  await api.pruneCompletedHistory();
  assert.deepEqual(api.state.items.filter((item) => item.status === "hoàn tất").map((item) => item.id), ["facility-1", "facility-3"]);
  assert.equal(api.state.items.some((item) => item.id === "facility-2" || item.id === "facility-4"), false, "old prompt, raw response and JSON rows are removed from storage");
  assert.equal((await api.getArticleContent("facility-5")).content.result.content, "Retry me");
  assert.equal(api.state.items.length, 6);
});

test("successful API resend prunes completed history while a rejected resend preserves its JSON", async () => {
  const successes = [1, 2].map((id) => ({ id: `facility-${id}`, facility_id: id, status: "hoàn tất", result: { id, content: "Saved" }, completed_at: `2026-09-28T10:0${id}:00.000Z` }));
  const api = loadBackground({ runner: { active: false }, items: [ ...successes,
    { id: "facility-3", facility_id: 3, status: "lỗi cập nhật", result: { id: 3, content: "Retry" } },
    { id: "facility-4", facility_id: 4, status: "lỗi cập nhật", result: { id: 999, content: "Wrong ID" } }
  ] });
  assert.equal((await api.retryUpdate("facility-3")).ok, true);
  assert.deepEqual(api.state.items.filter((item) => item.status === "hoàn tất").map((item) => item.id), ["facility-2", "facility-3"]);
  assert.equal((await api.retryUpdate("facility-4")).ok, false);
  assert.equal((await api.getArticleContent("facility-4")).content.result.content, "Wrong ID");
});

test("history cleanup protects an in-flight worker until its current slot is released", async () => {
  const initial = expiredCountdownState({ current: true });
  initial.items[0].status = "hoàn tất";
  initial.items[0].completed_at = "2026-09-28T10:00:00Z";
  initial.items.push(...[42, 43].map((id) => ({ id: `facility-${id}`, facility_id: id, status: "hoàn tất", completed_at: `2026-09-29T10:00:${id}Z` })));
  const api = loadBackground(initial);
  await api.pruneCompletedHistory();
  assert.equal(api.state.items.length, 3);
  await api.clearCurrent("facility-41", "run-next", "tab-404");
  assert.equal(api.state.items.length, 2);
  assert.equal(api.state.runner.workers["tab-404"].currentId, null);
});

test("system notices reject stale ownership and keep a bounded metadata-only history", async () => {
  const api = loadBackground(expiredCountdownState({ current: true }));
  const source = sender(404, api.tabs.get(404).url);
  const message = { articleId: "facility-41", runToken: "run-next", phase: "filling", detail: "Đang nạp prompt" };
  assert.equal((await api.recordSystemNotice({ ...message, runToken: "old" }, source)).ok, false);
  assert.equal((await api.recordSystemNotice(message, sender(202, api.tabs.get(202).url))).ok, false);
  assert.equal((await api.recordSystemNotice(message, source)).ok, true);
  await api.recordSystemNotice(message, source);
  assert.equal(api.state.systemNotices["tab-404"].history.length, 1, "same phase should not create repeated storage logs");
  for (let i = 0; i < 20; i++) await api.recordSystemNotice({ ...message, detail: `Bước ${i}` }, source);
  const notice = api.state.systemNotices["tab-404"];
  assert.equal(notice.history.length, 12);
  assert.equal(notice.prompt, undefined);
  assert.equal(notice.result, undefined);
  await api.stopRun({ provider: "gemini", targetTabId: 404 }, source);
  assert.equal((await api.recordSystemNotice(message, source)).ok, false);
});

test("future deadline is restored and rearmed without sending early", async () => {
  const api = loadBackground(expiredCountdownState({ future: true }));
  await api.restoreNextJobAlarms();
  await api.resumeNextJobDeadline("tab-404");
  assert.ok(api.createdAlarms.some((alarm) => alarm.name === "medreview-next-job:tab-404" && alarm.options.when === api.state.runner.workers["tab-404"].nextJobAt));
  assert.equal(api.sent.length, 0);
});

test("stopped and navigated workers cannot send a prompt from a stale deadline", async () => {
  const stopped = loadBackground(expiredCountdownState({ current: true, active: false }));
  await stopped.resumeNextJobDeadline("tab-404");
  assert.equal(stopped.sent.length, 0);
  const moved = loadBackground(expiredCountdownState({ current: true }));
  moved.tabs.set(404, { id: 404, url: "https://gemini.google.com/spark/chat/other-task?hl=vi" });
  await moved.resumeNextJobDeadline("tab-404");
  assert.equal(moved.sent.filter((entry) => entry.message.type === "resume-scheduled-article").length, 0);
  assert.equal(moved.state.items[0].status, "chờ");
});

test("Gemini Spark normal Run stays on the open task; content ai lookup is not part of startup", async () => {
  const api = loadBackground({
    sourceType: "facility",
    runner: { active: false },
    items: [
      { id: "facility-41", facility_id: 41, title: "A", prompt: "Prompt A", status: "chờ" },
      { id: "facility-42", facility_id: 42, title: "B", prompt: "Prompt B", status: "chờ" }
    ]
  });
  const selectedUrl = "https://gemini.google.com/spark/chat/4fd44b00d57b4bc9?hl=vi";
  const otherUrl = "https://gemini.google.com/spark/chat/another-task?hl=vi";

  const started = await api.startRun({ provider: "gemini", targetTabId: 404 }, sender(404, selectedUrl));
  assert.equal(started.ok, true);
  assert.equal(api.state.runner.workers["tab-404"].sparkTaskId, "4fd44b00d57b4bc9");
  assert.equal(api.sent.some((entry) => entry.message.type === "resolve-gemini-content-task"), false);
  assert.deepEqual(api.tabUpdates, [], "starting a worker must not redirect the Spark tab");
  assert.equal(api.sent.find((entry) => entry.message.type === "run-article").message.article.sparkTaskId, "4fd44b00d57b4bc9");
  const articleId = api.state.runner.workers["tab-404"].currentId;
  const runToken = api.state.runner.workers["tab-404"].runToken;
  const retryCountdown = await api.recordArticleRetryCountdown({
    articleId, runToken, retryCount: 1, retryAt: Date.now() + 5000
  }, sender(404, selectedUrl));
  assert.equal(retryCountdown.ok, true);
  assert.equal(api.state.items.find((item) => item.id === articleId).gemini_spark_json_retry_count, 1);
  assert.ok(api.state.items.find((item) => item.id === articleId).gemini_spark_json_retry_at);
  await api.recordArticleRetryCountdown({ articleId, runToken, clear: true }, sender(404, selectedUrl));
  assert.equal(api.state.items.find((item) => item.id === articleId).gemini_spark_json_retry_at, undefined);

  const otherTaskContext = await api.resolveControlTab({ provider: "gemini", targetTabId: 404 }, sender(404, otherUrl));
  assert.equal(otherTaskContext.sparkTaskId, "another-task");
  assert.deepEqual(api.tabUpdates, [], "resolving a tab must never switch it to content ai");
  api.tabs.set(405, { id: 405, url: selectedUrl });
  const duplicate = await api.startRun({ provider: "gemini", targetTabId: 405 }, sender(405, selectedUrl));
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /đang chạy ở tab 404/);

  const current = await api.getCurrentArticle("gemini", sender(404, selectedUrl));
  assert.equal(current.article.id, articleId);
  assert.equal(current.article.sparkTaskId, "4fd44b00d57b4bc9");
  const onOtherTask = await api.getCurrentArticle("gemini", sender(404, otherUrl));
  assert.equal(onOtherTask.article, null);
  const spoofed = await api.handleArticleComplete({
    articleId, runToken, article: { id: 41, content: "Không được lấy từ task khác" }
  }, sender(404, otherUrl));
  assert.equal(spoofed.ignored, true);
  assert.equal(api.fetchCalls.length, 0);

  await api.stopWorkerIfProviderChanged(404, { id: 404, url: otherUrl });
  assert.equal(api.state.runner.workers["tab-404"], undefined);
  assert.equal(api.state.items.find((item) => item.id === articleId).status, "chờ");
});

test("MV3 alarm reloads a stalled Gemini tab, respects cooldown, then retries recovery", async () => {
  const now = Date.now();
  const started = new Date(now - 11 * 60 * 1000).toISOString();
  const api = loadBackground({
    items: [{ id: "facility-98", facility_id: 98, sourceType: "facility", status: "đang viết", write_started_at: started, last_progress_at: started }],
    runner: { active: true, workers: { "tab-404": {
      active: true, provider: "gemini", targetTabId: 404, currentId: "facility-98",
      runToken: "run-98", sparkTaskId: "4fd44b00d57b4bc9"
    } } }
  });

  assert.equal(api.createdAlarms.some((entry) => entry.options.periodInMinutes === 1), true);
  assert.equal(typeof api.getAlarmListener(), "function");
  const result = await api.checkGeminiSparkStalls(now);
  assert.equal(result.ok, true);
  assert.equal(result.reloaded, 1);
  assert.deepEqual(api.reloadedTabs, [404]);
  assert.ok(api.state.items[0].gemini_spark_reload_attempted_at, "persist recovery marker before reloading the page");
  assert.equal(api.state.items[0].gemini_spark_reload_source, "background");

  const repeated = await api.checkGeminiSparkStalls(now + 60000);
  assert.equal(repeated.reloaded, 0, "an article may not trigger another reload inside the cooldown");
  assert.deepEqual(api.reloadedTabs, [404]);

  const retried = await api.checkGeminiSparkStalls(now + 10 * 60 * 1000);
  assert.equal(retried.reloaded, 1, "the same article can be reloaded again after cooldown while still awaiting JSON");
  assert.deepEqual(api.reloadedTabs, [404, 404]);
  assert.equal(api.state.items[0].gemini_spark_reload_count, 2);
});

test("Gemini progress heartbeat prevents the independent alarm from reloading an active research task", async () => {
  const now = Date.now();
  const stale = new Date(now - 6 * 60 * 1000).toISOString();
  const recent = new Date(now - 20 * 1000).toISOString();
  const api = loadBackground({
    items: [{ id: "facility-99", facility_id: 99, sourceType: "facility", status: "đang viết", write_started_at: stale, last_progress_at: stale }],
    runner: { active: true, workers: { "tab-404": {
      active: true, provider: "gemini", targetTabId: 404, currentId: "facility-99",
      runToken: "run-99", sparkTaskId: "4fd44b00d57b4bc9"
    } } }
  });
  const heartbeat = await api.recordArticleProgress({
    articleId: "facility-99", runToken: "run-99", progressAt: recent
  }, { tab: { id: 404, url: "https://gemini.google.com/spark/chat/4fd44b00d57b4bc9" } });
  assert.equal(heartbeat.ok, true);
  const result = await api.checkGeminiSparkStalls(now);
  assert.equal(result.reloaded, 0);
  assert.deepEqual(api.reloadedTabs, []);
});

function sender(tabId, url) {
  return { tab: { id: tabId, url } };
}

function idleTranslationState(extraWorker = {}, extraItems = []) {
  return { sourceType: "translation", translationType: "facility", nextJobDelayMs: 60000,
    runner: { active: true, sourceType: "translation", translationType: "facility", workers: {
      "tab-505": { active: true, targetTabId: 505, provider: "chatgpt", sourceType: "translation", translationType: "facility", currentId: null, runToken: "idle-token", ...extraWorker }
    } }, items: [
      { id: "tab-505:translation-facility-74", ownerTabId: 505, sourceType: "translation", type: "facility", source_id: 74,
        prompt: "Prompt dịch đang chờ", title: "Dịch 74", translation_fields: ["name_en"], output_template: { name_en: "" }, status: "chờ" }, ...extraItems
    ] };
}

test("cold active idle translation is scheduled on startup and recovered exactly once without another Run click", async () => {
  const api = loadBackground(idleTranslationState());
  await api.restoreNextJobAlarms();
  assert.ok(api.createdAlarms.some(({ name }) => name === "medreview-next-job:tab-505"));
  await Promise.all([
    api.getAlarmListener()({ name: "medreview-runner-recovery" }),
    api.getAlarmListener()({ name: "medreview-next-job:tab-505" }),
    api.recoverIdleWorkers()
  ]);
  assert.equal(api.state.runner.workers["tab-505"].currentId, "tab-505:translation-facility-74");
  assert.equal(api.sent.filter(({ message }) => message.type === "run-article").length, 1);
  assert.equal(api.fetchCalls.length, 0, "cached queued data is dispatched without fetching or posting again");
});

test("an already-active Start and reload continuation heal a dangling translation slot", async () => {
  for (const action of ["start", "reload", "watchdog"]) {
    const api = loadBackground(idleTranslationState({ currentId: "missing-job" }));
    if (action === "start") await api.startRun({ targetTabId: 505, sourceType: "translation", translationType: "facility" });
    else if (action === "reload") await api.continueAfterReload(sender(505, api.tabs.get(505).url));
    else await api.recoverIdleWorkers();
    assert.equal(api.state.runner.workers["tab-505"].currentId, "tab-505:translation-facility-74", action);
    assert.equal(api.sent.filter(({ message }) => message.type === "run-article").length, 1, action);
    assert.equal(api.fetchCalls.length, 0, action);
  }
});

test("completed or failed non-Spark current pointers are released without resending their saved JSON", async () => {
  for (const status of ["hoàn tất", "lỗi", "lỗi cập nhật", "chưa xác nhận"]) {
    const api = loadBackground(idleTranslationState({ currentId: "tab-505:translation-facility-73" }, [
      { id: "tab-505:translation-facility-73", ownerTabId: 505, sourceType: "translation", type: "facility", source_id: 73, status,
        result: { type: "facility", source_id: 73, translated: { name_en: "Saved" } } }
    ]));
    await api.recoverIdleWorkers();
    assert.equal(api.state.runner.workers["tab-505"].currentId, "tab-505:translation-facility-74", status);
    assert.equal(api.fetchCalls.length, 0, "repair is never an API resend");
    assert.equal((await api.getArticleContent("tab-505:translation-facility-73", 505)).content.result.translated.name_en, "Saved");
  }
});

test("watchdog never clears live translation generation/upload or sends before the pause deadline", async () => {
  for (const status of ["đang viết", "đang cập nhật"]) {
    const api = loadBackground(idleTranslationState({ currentId: "tab-505:translation-facility-73" }, [
      { id: "tab-505:translation-facility-73", ownerTabId: 505, sourceType: "translation", type: "facility", source_id: 73, status }
    ]));
    await api.recoverIdleWorkers();
    assert.equal(api.state.runner.workers["tab-505"].currentId, "tab-505:translation-facility-73");
    assert.equal(api.sent.length, 0);
  }
  const deadline = Date.now() + 60000;
  const api = loadBackground(idleTranslationState({ nextJobAt: deadline }));
  await api.recoverIdleWorkers();
  assert.equal(api.sent.length, 0);
  assert.equal(api.state.runner.workers["tab-505"].nextJobAt, deadline);
  assert.ok(api.createdAlarms.some(({ options }) => options.when === deadline));
});

test("cold interrupted translation prefetch fetches once at expiry instead of stopping an empty local queue", async () => {
  const initial = idleTranslationState({ nextJobAt: Date.now() - 1, refilling: true, refillToken: "lost-process" });
  const row = initial.items[0];
  initial.items = [];
  const api = loadBackground(initial, { fetchResponse: () => ({ ok: true, items: [{ ...row, id: 74 }] }) });
  await api.resumeNextJobDeadline("tab-505");
  assert.equal(api.fetchCalls.length, 1);
  assert.equal(api.sent.filter(({ message }) => message.type === "run-article").length, 1);
  assert.equal(api.state.runner.workers["tab-505"].currentId, row.id);
  assert.equal(api.state.runner.workers["tab-505"].refilling, false);
  assert.equal(api.state.runner.workers["tab-505"].active, true);
});

test("cold translation handoff before prefetch starts fetches the next job once", async () => {
  const initial = idleTranslationState({ nextJobAt: Date.now() - 1 });
  const row = initial.items[0];
  initial.items = [];
  const api = loadBackground(initial, { fetchResponse: () => ({ ok: true, items: [{ ...row, id: 74 }] }) });
  await Promise.all([api.recoverIdleWorkers(), api.resumeNextJobDeadline("tab-505")]);
  assert.equal(api.fetchCalls.length, 1, "a completed pause without any prefetch must not lose its next list request");
  assert.equal(api.sent.filter(({ message }) => message.type === "run-article").length, 1);
  assert.equal(api.state.runner.workers["tab-505"].currentId, row.id);
});

test("confirmed empty or failed translation prefetch is durable and never loops list reads after restart", async () => {
  for (const failed of [false, true]) {
    const deadline = Date.now() - 1;
    const initial = idleTranslationState({ nextJobAt: deadline });
    initial.items = [];
    const api = loadBackground(initial, { fetchResponse() {
      if (failed) throw new Error("API dịch lỗi 503");
      return { ok: true, items: [] };
    } });
    await api.refillWorkerQueue("tab-505", true);
    assert.equal(api.state.runner.workers["tab-505"].prefetchCompletedFor, deadline);
    const cold = loadBackground(api.state);
    await Promise.all([cold.recoverIdleWorkers(), cold.resumeNextJobDeadline("tab-505")]);
    await cold.recoverIdleWorkers();
    assert.equal(cold.fetchCalls.length, 0, "confirmed empty/error data must not be polled repeatedly");
    assert.equal(cold.sent.length, 0);
    assert.equal(cold.state.runner.workers["tab-505"].active, false);
    if (failed) assert.match(cold.state.runner.workers["tab-505"].lastError, /503/);
  }
});

test("recovery only heals active owned queues and never restarts a stopped tab or steals another subtype", async () => {
  const initial = idleTranslationState({ active: false });
  initial.runner.workers["tab-101"] = { active: true, targetTabId: 101, provider: "grok", sourceType: "translation", translationType: "doctor", currentId: null };
  initial.items.push({ ...initial.items[0], id: "tab-101:translation-doctor-80", ownerTabId: 101, type: "doctor", source_id: 80, prompt: "Prompt dịch bác sĩ" });
  const api = loadBackground(initial);
  await api.recoverIdleWorkers();
  assert.equal(api.sent.filter(({ message }) => message.type === "run-article").length, 1);
  assert.equal(api.sent.find(({ message }) => message.type === "run-article").tabId, 101);
  assert.equal(api.state.items.find(({ ownerTabId }) => ownerTabId === 505).status, "chờ");
  assert.equal(api.state.runner.workers["tab-505"].active, false);
});

test("completion handoff stores its one-minute deadline atomically and restart recovery respects it", async () => {
  const completedAt = Date.now();
  const initial = idleTranslationState({ currentId: "tab-505:translation-facility-73", runToken: "done", prefetchCompletedFor: completedAt - 60000 }, [
    { id: "tab-505:translation-facility-73", ownerTabId: 505, sourceType: "translation", type: "facility", source_id: 73,
      status: "hoàn tất", completed_at: new Date(completedAt).toISOString() }
  ]);
  const api = loadBackground(initial, { runtimeId: "extension-id" });
  await api.clearCurrent("tab-505:translation-facility-73", "done", "tab-505", { pauseBeforeNext: true });
  const write = api.storageWrites.find(({ runner }) => runner?.workers?.["tab-505"]?.currentId === null);
  assert.ok(write.runner.workers["tab-505"].nextJobAt >= completedAt + 60000, "null current and deadline must be persisted in one write");
  assert.equal(write.runner.workers["tab-505"].prefetchCompletedFor, undefined, "a fresh pause must not inherit an older prefetch result");
  await api.recoverIdleWorkers();
  assert.equal(api.sent.length, 0);
  const cold = loadBackground(initial, { runtimeId: "extension-id" });
  await cold.recoverIdleWorkers();
  assert.equal(cold.sent.length, 0, "a stale completed current pointer still preserves the remaining minute");
  assert.equal(cold.state.runner.workers["tab-505"].nextJobAt, completedAt + 60000);
});

test("a hung translation list read aborts after 60 seconds with a clear error", async () => {
  const timers = [];
  const api = loadBackground({ items: [], runner: { active: false } }, {
    setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length; }, clearTimeout() {},
    fetchResponse(_url, _body, request) { return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); }
  });
  const reading = api.fetchTranslations("facility", 505);
  await new Promise(setImmediate);
  const timer = timers.find(({ callback }) => callback.name === "abortQueueRead");
  assert.equal(timer.ms, 60000);
  timer.callback();
  await assert.rejects(reading, /danh sách bản dịch quá thời gian 60 giây/);
});

test("Gemini facility and ChatGPT translation run concurrently with independent sources, prompts and API routes", async () => {
  const api = loadBackground({ sourceType: "facility", runner: { active: false }, items: [
    { id: "tab-404:facility-74", ownerTabId: 404, sourceType: "facility", facility_id: 74, title: "Viết bài", prompt: "Prompt cơ sở", status: "chờ" },
    { id: "tab-505:translation-facility-74", ownerTabId: 505, sourceType: "translation", type: "facility", source_id: 74,
      title: "Dịch bài", prompt: "Prompt dịch", translation_fields: ["name_en"], output_template: { name_en: "" }, status: "chờ" }
  ], "tab-api-settings:505": { translationUrl: "https://example.invalid/tab-505-translate" } }, {
    fetchResponse(url, body, request) {
      if (request.method !== "POST") return { ok: true, items: [] };
      return String(url).includes("translate") ? { ok: true, status: "draft", saved_fields: ["name_en"] }
        : { ok: true, updated_ids: [body.items[0].id], updated_count: 1, errors: [] };
    }
  });
  await Promise.all([
    api.startRun({ targetTabId: 404, provider: "gemini", sourceType: "facility" }),
    api.startRun({ targetTabId: 505, provider: "chatgpt", sourceType: "translation", translationType: "facility" })
  ]);
  const facilityWorker = plain(api.state.runner.workers["tab-404"]);
  const translationWorker = plain(api.state.runner.workers["tab-505"]);
  assert.equal(facilityWorker.sourceType, "facility");
  assert.equal(translationWorker.sourceType, "translation");
  assert.equal(facilityWorker.currentId, "tab-404:facility-74");
  assert.equal(translationWorker.currentId, "tab-505:translation-facility-74");
  assert.deepEqual(api.sent.filter(({ message }) => message.type === "run-article").map(({ tabId, message }) => [tabId, message.prompt]).sort(),
    [[404, "Prompt cơ sở"], [505, "Prompt dịch"]]);
  const article = { type: "facility", source_id: 74, translated: { name_en: "English name" } };
  await api.handleArticleComplete({ articleId: translationWorker.currentId, runToken: translationWorker.runToken, article, rawResponse: JSON.stringify(article) }, sender(505, api.tabs.get(505).url));
  assert.deepEqual(api.state.runner.workers["tab-404"], facilityWorker, "finishing translation cannot change the facility worker");
  const upload = api.fetchCalls.find(({ options }) => options.method === "POST");
  assert.equal(upload.url, "https://example.invalid/tab-505-translate");
  assert.deepEqual(JSON.parse(upload.options.body), { type: "facility", items: [{ source_id: 74, translated: { name_en: "English name" } }] });
  assert.equal(api.state["tab-job-items:505"][0].status, "hoàn tất");
  assert.equal(api.state["tab-job-items:404"][0].status, "đang viết");
});

test("owned waiting jobs stay in their tab after Stop, even when another tab runs the same source", async () => {
  const api = loadBackground({ sourceType: "facility", runner: { active: false }, items: [
    { id: "tab-101:facility-1", ownerTabId: 101, facility_id: 1, prompt: "A", status: "chờ" },
    { id: "tab-101:facility-2", ownerTabId: 101, facility_id: 2, prompt: "B", status: "chờ" },
    { id: "tab-202:facility-3", ownerTabId: 202, facility_id: 3, prompt: "C", status: "chờ" }
  ] });
  await api.startRun({ targetTabId: 101, sourceType: "facility" });
  await api.startRun({ targetTabId: 202, sourceType: "facility" });
  await api.stopRun({ targetTabId: 101 });
  assert.equal(api.state.runner.workers["tab-202"].currentId, "tab-202:facility-3");
  assert.deepEqual(api.state["tab-job-items:101"].map(({ status }) => status), ["chờ", "chờ"]);
  await api.clearCurrent("tab-202:facility-3", api.state.runner.workers["tab-202"].runToken, "tab-202");
  await api.runNext("tab-202", false);
  assert.equal(api.state.runner.workers["tab-202"].active, false);
  assert.equal(api.sent.some(({ tabId, message }) => tabId === 202 && message.prompt === "B"), false);
});

test("refresh namespaces identical API IDs and does not change another tab's preference, prompt or content", async () => {
  let prompt = "Prompt thứ nhất";
  const api = loadBackground({ runner: { active: false }, items: [], sourceType: "toplist" }, {
    fetchResponse: () => ({ ok: true, items: [{ id: 51, name: "Cơ sở 51", prompt }] })
  });
  await api.refreshQueue("facility", "facility", 101);
  prompt = "Prompt thứ hai";
  await api.refreshQueue("facility", "facility", 202);
  assert.deepEqual(api.state.items.map(({ id }) => id), ["tab-101:facility-51", "tab-202:facility-51"]);
  assert.equal((await api.getArticleContent("tab-101:facility-51", 101)).content.prompt, "Prompt thứ nhất");
  assert.equal((await api.getArticleContent("tab-202:facility-51", 202)).content.prompt, "Prompt thứ hai");
  assert.equal((await api.getArticleContent("tab-101:facility-51", 202)).ok, false);
  assert.equal(api.state["tab-task-source:101"].sourceType, "facility");
  assert.equal(api.state.sourceType, "toplist", "a scoped refresh must not rewrite the legacy global preference");
  assert.deepEqual(api.state["tab-job-items:101"].map(({ ownerTabId }) => ownerTabId), [101]);
  assert.deepEqual(api.state["tab-job-items:202"].map(({ ownerTabId }) => ownerTabId), [202]);
});

test("two tabs never dispatch the same facility simultaneously even if the API returned duplicate IDs", async () => {
  const api = loadBackground({ runner: { active: false }, items: [], sourceType: "facility" }, {
    fetchResponse: () => ({ ok: true, items: [{ id: 51, name: "Cơ sở 51", prompt: "Prompt 51" }] })
  });
  await api.refreshQueue("facility", "facility", 101);
  await api.refreshQueue("facility", "facility", 202);
  await Promise.all([api.startRun({ targetTabId: 101, sourceType: "facility" }), api.startRun({ targetTabId: 202, sourceType: "facility" })]);
  assert.equal(api.sent.filter(({ message }) => message.type === "run-article").length, 1);
  assert.equal(api.state.items.filter(({ status }) => status === "đang viết").length, 1);
  assert.equal(api.state.items.length, 2, "a duplicate cannot erase the other tab's memory");
});

test("one tab's stalled refill cannot block another source or leak its late response after Stop", async () => {
  let resolveList, notifyRequest;
  const requestStarted = new Promise((resolve) => { notifyRequest = resolve; });
  const list = new Promise((resolve) => { resolveList = resolve; });
  const api = loadBackground({ runner: { active: false }, items: [
    { id: "tab-303:toplist-7", ownerTabId: 303, sourceType: "toplist", toplist_id: 7, prompt: "Prompt toplist", status: "chờ" }
  ] }, { fetchResponse() { notifyRequest(); return list; } });
  const refilling = api.startRun({ targetTabId: 101, sourceType: "facility" });
  await requestStarted;
  await api.startRun({ targetTabId: 303, sourceType: "toplist" });
  assert.equal(api.state.runner.workers["tab-303"].currentId, "tab-303:toplist-7");
  await api.stopRun({ targetTabId: 101 });
  resolveList({ ok: true, items: [{ id: 99, name: "Muộn", prompt: "Không được thêm" }] });
  await refilling;
  assert.equal(api.state.items.some(({ facility_id }) => facility_id === 99), false);
  assert.equal(api.state.runner.workers["tab-303"].active, true);
});

test("clear uses explicit owned IDs so a stale panel cannot delete another tab or a newly fetched job", async () => {
  const api = loadBackground({ items: [
    { id: "tab-101:facility-1", ownerTabId: 101, facility_id: 1, status: "chờ", prompt: "A" },
    { id: "tab-101:facility-2", ownerTabId: 101, facility_id: 2, status: "chờ", prompt: "B" },
    { id: "tab-202:facility-3", ownerTabId: 202, facility_id: 3, status: "chờ", prompt: "C" }
  ], runner: { active: false } });
  const result = await api.dispatch({ type: "replace-queue-items", targetTabId: 101, sourceType: "facility", items: [], removeArticleIds: ["tab-101:facility-1", "tab-202:facility-3"] });
  assert.equal(result.ok, true);
  assert.deepEqual(api.state.items.map(({ id }) => id), ["tab-101:facility-2", "tab-202:facility-3"]);
});

test("completed history keeps two successes per tab/source rather than evicting another tab's results", async () => {
  const items = [101, 202].flatMap((tabId) => [1, 2, 3].map((id) => ({ id: `tab-${tabId}:facility-${id}`, ownerTabId: tabId,
    facility_id: id, status: "hoàn tất", completed_at: `2026-10-01T10:0${id}:00Z`, result: { id, content: "Saved" } })));
  items.push({ id: "tab-101:translation-facility-1", ownerTabId: 101, sourceType: "translation", source_id: 1, type: "facility", status: "hoàn tất", result: { name_en: "Saved" } });
  const api = loadBackground({ items, runner: { active: false } });
  await api.pruneCompletedHistory();
  assert.deepEqual(api.state["tab-job-items:101"].map(({ id }) => id), ["tab-101:facility-2", "tab-101:facility-3", "tab-101:translation-facility-1"]);
  assert.deepEqual(api.state["tab-job-items:202"].map(({ id }) => id), ["tab-202:facility-2", "tab-202:facility-3"]);
});

test("per-tab queue API settings are independent and an owned progress write does not rewrite other tab memory", async () => {
  const api = loadBackground({ items: [], runner: { active: false }, facilitiesUrl: "https://medreview.vn/api/medical/facilities-needing-content.php",
    "tab-api-settings:101": { facilitiesUrl: "https://example.invalid/a", account_label: "Account A" },
    "tab-api-settings:202": { facilitiesUrl: "https://example.invalid/b", account_label: "Account B" }
  }, { fetchResponse: () => ({ ok: true, items: [{ id: 1, name: "A", prompt: "P" }] }) });
  await api.refreshQueue("facility", "facility", 101);
  await api.refreshQueue("facility", "facility", 202);
  assert.deepEqual(api.fetchCalls.map(({ url }) => new URL(url).pathname), ["/a", "/b"]);
  assert.equal((await api.getTabSettings(101, "account_label")).account_label, "Account A");
  const metadata = (await api.getJobMetadata("items")).items;
  metadata.find(({ ownerTabId }) => ownerTabId === 101).last_progress_at = "2026-10-01T10:00:00Z";
  const writesBefore = api.storageWrites.length;
  await api.jobStorage.set({ items: metadata });
  assert.equal(api.storageWrites.slice(writesBefore).some((write) => Object.hasOwn(write, "tab-job-items:202")), false);
});

test("opening a panel migrates legacy memory once, creates an empty independent new tab, and preserves its memory across reload", async () => {
  const api = loadBackground({ sourceType: "facility", items: [
    { id: "facility-1", facility_id: 1, prompt: "Prompt tồn tại", status: "hoàn tất", result: { id: 1, content: "Kết quả tồn tại" } },
    { id: "facility-2", facility_id: 2, prompt: "Prompt đợi", status: "chờ" }
  ], runner: { active: false }, updateUrl: "https://example.invalid/old-update" });
  assert.equal((await api.dispatch({ type: "get-tab-context", targetTabId: 101 })).ok, true);
  assert.deepEqual(api.state["tab-job-items:101"].map(({ ownerTabId }) => ownerTabId), [101, 101]);
  assert.equal((await api.dispatch({ type: "get-tab-context", targetTabId: 202 })).ok, true);
  assert.deepEqual(api.state["tab-job-items:202"], []);
  assert.equal(api.state["tab-api-settings:101"].updateUrl, "https://example.invalid/old-update");
  api.state.updateUrl = "https://example.invalid/new-global-update";
  await api.dispatch({ type: "get-tab-context", targetTabId: 101 });
  assert.equal((await api.getTabSettings(101, "updateUrl")).updateUrl, "https://example.invalid/old-update", "a tab's settings never follow later global changes");
  assert.equal((await api.getArticleContent("facility-1", 101)).content.result.content, "Kết quả tồn tại");
  assert.equal((await api.getArticleContent("facility-1", 202)).ok, false);
  await api.startRun({ targetTabId: 101, sourceType: "facility" });
  assert.equal(api.state.runner.workers["tab-101"].currentId, "facility-2");
  await api.dispatch({ type: "get-tab-context", targetTabId: 101 });
  assert.equal(api.state.runner.workers["tab-101"].currentId, "facility-2", "reload cannot clear or replace the current job");
});

test("two Grok tabs and one Claude tab claim different articles without focusing another tab", async () => {
  const api = loadBackground({
    sourceType: "facility",
    runner: { active: false },
    items: [
      { id: "facility-1", facility_id: 1, title: "A", prompt: "Prompt A", status: "chờ" },
      { id: "facility-2", facility_id: 2, title: "B", prompt: "Prompt B", status: "chờ" },
      { id: "facility-3", facility_id: 3, title: "C", prompt: "Prompt C", status: "chờ" },
      { id: "facility-4", facility_id: 4, title: "D", prompt: "Prompt D", status: "chờ" }
    ]
  });

  await Promise.all([
    api.startRun({ provider: "grok", targetTabId: 101 }, sender(101, "https://grok.com/c/first")),
    api.startRun({ provider: "grok", targetTabId: 202 }, sender(202, "https://grok.com/c/second")),
    api.startRun({ provider: "claude", targetTabId: 303 }, sender(303, "https://claude.ai/chat/third"))
  ]);

  assert.deepEqual(Object.keys(api.state.runner.workers).sort(), ["tab-101", "tab-202", "tab-303"]);
  assert.equal(api.state.runner.workers["tab-101"].provider, "grok");
  assert.equal(api.state.runner.workers["tab-202"].provider, "grok");
  assert.equal(api.state.runner.workers["tab-303"].provider, "claude");
  assert.equal(new Set(Object.values(api.state.runner.workers).map((worker) => worker.currentId)).size, 3);
  assert.deepEqual(api.sent.filter((entry) => entry.message.type === "run-article").map((entry) => entry.tabId).sort(), [101, 202, 303]);
  assert.deepEqual(api.sent.filter((entry) => entry.message.type === "run-article").map((entry) => entry.message.article.id).sort(), ["facility-1", "facility-2", "facility-3"]);
  assert.equal(api.state.items.filter((item) => item.status === "đang viết").length, 3);
  assert.equal(api.state.items.filter((item) => item.status === "chờ").length, 1);
  assert.deepEqual(api.tabUpdates, [], "workers must not activate or redirect another browser tab");

  const sendCount = api.sent.length;
  const duplicateStart = await api.startRun(
    { provider: "grok", targetTabId: 101 },
    sender(101, "https://grok.com/c/first")
  );
  assert.equal(duplicateStart.alreadyActive, true);
  assert.equal(api.sent.length, sendCount, "clicking Run twice in one tab must not claim another article");
});

test("article lookup, completion and stop are isolated to the exact sender tab", async () => {
  const api = loadBackground({
    sourceType: "facility",
    runner: { active: false },
    items: [
      { id: "facility-11", facility_id: 11, title: "A", prompt: "Prompt A", status: "chờ" },
      { id: "facility-12", facility_id: 12, title: "B", prompt: "Prompt B", status: "chờ" },
      { id: "facility-13", facility_id: 13, title: "C", prompt: "Prompt C", status: "chờ" }
    ]
  });

  await api.startRun({ provider: "grok", targetTabId: 101 }, sender(101, "https://grok.com/c/first"));
  await api.startRun({ provider: "grok", targetTabId: 202 }, sender(202, "https://grok.com/c/second"));

  const firstId = api.state.runner.workers["tab-101"].currentId;
  const secondId = api.state.runner.workers["tab-202"].currentId;
  const firstToken = api.state.runner.workers["tab-101"].runToken;
  assert.notEqual(firstId, secondId);

  const firstLookup = await api.getCurrentArticle("grok", sender(101, "https://grok.com/c/first"));
  const secondLookup = await api.getCurrentArticle("grok", sender(202, "https://grok.com/c/second"));
  const wrongProviderLookup = await api.getCurrentArticle("claude", sender(101, "https://grok.com/c/first"));
  assert.equal(firstLookup.article.id, firstId);
  assert.equal(secondLookup.article.id, secondId);
  assert.equal(wrongProviderLookup.article, null);

  const spoofed = await api.handleArticleComplete({
    articleId: firstId,
    runToken: firstToken,
    article: { id: 11, content: "Không được nhận" },
    rawResponse: '{"id":11}'
  }, sender(202, "https://grok.com/c/second"));
  assert.equal(spoofed.ignored, true);
  assert.equal(api.fetchCalls.length, 0);
  assert.equal(api.state.runner.workers["tab-101"].currentId, firstId);

  const completed = await api.handleArticleComplete({
    articleId: firstId,
    runToken: firstToken,
    article: { id: 11, content: "Đúng tab" },
    rawResponse: '{"id":11,"content":"Đúng tab"}'
  }, sender(101, "https://grok.com/c/first"));
  assert.equal(completed.ok, true);
  assert.equal(api.fetchCalls.length, 1);
  assert.equal(api.state.items.find((item) => item.id === firstId).status, "hoàn tất");
  assert.equal(api.state.runner.workers["tab-202"].currentId, secondId, "completion in tab 101 must not alter tab 202");
  assert.deepEqual(api.reloadedTabs, [], "finishing an article dispatches the next job without reloading the worker tab");

  const replacementId = api.state.runner.workers["tab-101"].currentId;
  assert.equal(replacementId, "facility-13", "the same worker should claim the next waiting article");
  const stopResult = await api.stopRun(
    { provider: "grok", targetTabId: 101 },
    sender(101, "https://grok.com/c/first")
  );
  assert.equal(stopResult.ok, true);
  assert.equal(stopResult.requeued, true);
  assert.equal(api.state.runner.workers["tab-101"], undefined);
  assert.equal(api.state.runner.workers["tab-202"].currentId, secondId);
  assert.equal(api.state.items.find((item) => item.id === replacementId).status, "chờ");
  assert.equal(api.state.items.find((item) => item.id === secondId).status, "đang viết");
  assert.equal(api.state.runner.active, true, "stopping one tab must leave the other tab running");
  assert.ok(api.sent.some((entry) => entry.tabId === 101 && entry.message.type === "stop-article"));
  assert.ok(!api.sent.some((entry) => entry.tabId === 202 && entry.message.type === "stop-article"));
});

test("manual Gemini recovery reads an existing matching JSON and publishes it without re-running the AI", async () => {
  const api = loadBackground({
    sourceType: "facility",
    runner: { active: false },
    items: [{ id: "facility-53", facility_id: 53, title: "Nha Khoa Huế", prompt: "Prompt", sourceType: "facility", status: "lỗi", error: "Không đọc được JSON" }]
  });
  const recovered = await api.recoverExistingArticle({
    articleId: "facility-53", targetTabId: 404, provider: "gemini"
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true);
  assert.equal(api.sent.some((entry) => entry.message.type === "run-article"), false);
  assert.equal(api.sent.some((entry) => entry.message.type === "read-existing-article-json"), true);
  assert.equal(api.fetchCalls.length, 1);
  assert.equal(api.state.items[0].status, "hoàn tất");
  assert.deepEqual(plain((await api.getArticleContent("facility-53")).content.result), { id: 53, name: "Nha Khoa Huế", content: "JSON đã có trong Spark" });
});

test("manual Gemini recovery refuses JSON whose ID belongs to a different facility", async () => {
  const api = loadBackground({
    sourceType: "facility",
    runner: { active: false },
    items: [{ id: "facility-53", facility_id: 53, title: "Nha Khoa Huế", sourceType: "facility", status: "lỗi", error: "Không đọc được JSON" }],
    recoveryResponse: { ok: true, article: { id: 99, content: "JSON bài khác" }, rawResponse: '{"id":99}' }
  });
  await assert.rejects(api.recoverExistingArticle({ articleId: "facility-53", targetTabId: 404, provider: "gemini" }), /không khớp ID 53/i);
  assert.equal(api.fetchCalls.length, 0);
  assert.equal(api.state.items[0].status, "lỗi");
});
