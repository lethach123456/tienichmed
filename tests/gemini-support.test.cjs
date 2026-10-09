const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionRoot = path.resolve(__dirname, "..");

function mockClaimFetch(url, options = {}) {
  if (!String(url).includes("writer-claim.php")) throw new Error(`unexpected fetch ${url}`);
  const request = JSON.parse(options.body || "{}");
  const body = request.action === "claim"
    ? { ok: true, claimed: true, claim_token: `test-claim-${request.id}`, lease_seconds: 180 }
    : { ok: true, lease_seconds: 180 };
  return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}

function loadGeminiContent(overrides = {}) {
  const source = fs.readFileSync(path.join(extensionRoot, "content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__geminiTest = {
      provider: PROVIDER, inputSelectors, waitForInput, clickSend, submitPrompt,
      dispatchEnterKey, triggerButtonClick, isGenerating, getSparkSidebarCandidates,
      selectGeminiSparkInput, sparkAccountPrefix, extractGeminiSparkTaskId,
      latestAssistantResponse, parseAssistantResponse, waitForResponse,
      promptForProvider, isGeminiSparkContentTask, geminiSparkProgressSignature
      , findGeminiSparkContentTask, resolveGeminiSparkContentTask,
      ensureGeminiSparkContentTask, isGeminiSparkStallRecovery, clearGeminiSparkStallRecovery,
      readExistingArticleJson, geminiResponseNodesForRecovery, claimGeminiSparkJsonRetry,
      setInputValue, sparkComposerText, retryGeminiSparkArticle, isGeminiSparkStopVisible, yieldSparkComposerFrame, runArticle, recoverPendingArticle
    };
  }`);
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    location: { hostname: "gemini.google.com" },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document: { querySelector: () => null, querySelectorAll: () => [], body: null },
    getComputedStyle: () => ({ visibility: "visible" }),
    setTimeout,
    clearTimeout,
    ...overrides
  });
  vm.runInContext(source, context, { filename: "content.js" });
  return context.__geminiTest;
}

function geminiResponse(id, text, blocks = []) {
  const node = {
    textContent: text,
    innerText: text,
    getClientRects: () => [{}],
    getAttribute: (name) => name === "id" ? id : null,
    closest(selector) {
      return selector.includes("model-response") ? node : null;
    },
    querySelector: () => null,
    querySelectorAll: (selector) => selector.includes("pre") ? blocks : [],
    cloneNode() {
      return { textContent: node.textContent, querySelectorAll: () => [] };
    }
  };
  return node;
}

test("Gemini pages may load the content script and embedded panel", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
  const contentMatches = manifest.content_scripts.flatMap((entry) => entry.matches || []);
  const resource = manifest.web_accessible_resources.find((entry) => (entry.resources || []).includes("popup.html"));
  assert.ok(manifest.host_permissions.includes("https://gemini.google.com/*"));
  assert.ok(contentMatches.includes("https://gemini.google.com/*"));
  assert.ok(resource.matches.includes("https://gemini.google.com/*"));
});

test("Gemini content-ai recovery is enabled only by the matching stall-reload marker", () => {
  const values = new Map();
  const sessionStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const api = loadGeminiContent({ sessionStorage });
  assert.equal(api.isGeminiSparkStallRecovery("article-1"), false);
  sessionStorage.setItem("medreview-gemini-spark-reload", JSON.stringify({ articleId: "article-1", at: 123 }));
  assert.equal(api.isGeminiSparkStallRecovery("article-1"), true);
  assert.equal(api.isGeminiSparkStallRecovery("article-2"), false);
  api.clearGeminiSparkStallRecovery("article-2");
  assert.equal(api.isGeminiSparkStallRecovery("article-1"), true, "an unrelated article must not clear the recovery marker");
  api.clearGeminiSparkStallRecovery("article-1");
  assert.equal(api.isGeminiSparkStallRecovery("article-1"), false);
});

test("Spark invalid-JSON retry has no attempt limit and keeps counters separate per run", () => {
  const values = new Map();
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/retry-test" },
    sessionStorage: {
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, String(value)); }
    }
  });
  const article = { id: "facility-53", runToken: "run-53" };
  assert.equal(api.claimGeminiSparkJsonRetry(article), 1);
  assert.equal(api.claimGeminiSparkJsonRetry(article), 2);
  for (let attempt = 3; attempt <= 100; attempt += 1) {
    assert.equal(api.claimGeminiSparkJsonRetry(article), attempt);
  }
  assert.equal(api.claimGeminiSparkJsonRetry({ ...article, runToken: "new-run" }), 1);
});

test("stopping during the Spark retry countdown prevents another prompt attempt", async () => {
  let listener;
  const values = new Map();
  const messages = [];
  const article = { id: "facility-53", runToken: "run-53" };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/retry-test" },
    sessionStorage: {
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, String(value)); }
    },
    chrome: { runtime: {
      onMessage: { addListener(callback) { listener = callback; } },
      async sendMessage(message) { messages.push(message); return { ok: true }; }
    } },
    setTimeout(callback, ms) {
      assert.equal(ms, 5000);
      listener({ type: "stop-article", articleId: article.id }, {}, () => {});
      queueMicrotask(callback);
    }
  });
  await assert.rejects(api.retryGeminiSparkArticle(article, "original prompt"), /Đã dừng bài viết/);
  assert.equal(messages[0].type, "article-retry-countdown");
  assert.equal(messages[0].retryCount, 1);
});

test("Spark completion watches the actual Vietnamese Stop button only in the right composer", () => {
  const stop = { getClientRects: () => [{}], getAttribute: (name) => name === "aria-label" ? "Ngừng tạo câu trả lời" : null };
  const composer = { querySelectorAll(selector) { return selector.includes("button[aria-label='Ngừng tạo câu trả lời']") ? [stop] : []; } };
  const pane = { querySelector: () => composer };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/current" },
    document: {
      body: null,
      querySelector: (selector) => selector === ".right-pane" ? pane : null,
      querySelectorAll() { throw new Error("Stop detection must not scan the left pane"); }
    }
  });
  assert.equal(api.isGeminiSparkStopVisible(), true);
  composer.querySelectorAll = () => [];
  assert.equal(api.isGeminiSparkStopVisible(), false);
});

test("Spark accepts new plain JSON after missing the Stop pulse without sending a formatting prompt", async () => {
  let time = 0;
  const expected = { id: 41, content: "Quốc Bình" };
  const old = geminiResponse("old", '{"id":42}');
  const fresh = geminiResponse("fresh", JSON.stringify(expected));
  const composer = { querySelectorAll: () => [] };
  const pane = {
    querySelector: (selector) => selector === "input-area-v2" ? composer : null,
    querySelectorAll: (selector) => selector === "model-response" ? [fresh] : []
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/current" },
    Date: class extends Date { static now() { return time; } },
    document: { body: null, querySelector: (selector) => selector === ".right-pane" ? pane : null, querySelectorAll: () => [] },
    setTimeout(callback, ms) { time += ms; queueMicrotask(callback); return time; }
  });
  const result = await api.waitForResponse({ node: old, id: "old", count: 1, sources: [], signature: "" }, "facility-41", 10000, 41);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), expected);
  assert.ok(time < 10000);
});

test("Spark leaves JSON unread while its Vietnamese Stop button is active then accepts it", async () => {
  let time = 0;
  const expected = { id: 41, content: "Quốc Bình" };
  const fresh = geminiResponse("fresh", JSON.stringify(expected));
  Object.defineProperty(fresh, "innerText", { get() {
    assert.ok(time >= 3000, "JSON must not be read during generation");
    return JSON.stringify(expected);
  } });
  const stop = { getClientRects: () => [{}], getAttribute: () => null };
  const composer = { querySelectorAll: (selector) => time < 3000 && selector.includes("Ngừng tạo câu trả lời") ? [stop] : [] };
  const pane = {
    querySelector: (selector) => selector === "input-area-v2" ? composer : null,
    querySelectorAll: (selector) => selector === "model-response" ? [fresh] : []
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/current" },
    Date: class extends Date { static now() { return time; } },
    document: { body: null, querySelector: (selector) => selector === ".right-pane" ? pane : null, querySelectorAll: () => [] },
    setTimeout(callback, ms) { time += ms; queueMicrotask(callback); return time; }
  });
  const result = await api.waitForResponse({ node: null, id: "", count: 0, sources: [], signature: "" }, "facility-41", 10000, 41);
  assert.equal(result.data.id, 41);
});

function sparkDraftFixture(nativeInsert, overrides = {}) {
  const listeners = new Map();
  const events = [];
  const textNode = (text) => ({ textContent: text });
  const input = {
    childNodes: [{ tagName: "P", childNodes: [textNode("old draft")] }],
    matches: () => false,
    getAttribute: (name) => name === "data-placeholder" ? "Chúng ta có thể làm gì tiếp theo?" : null,
    closest: () => null,
    focus(options) { input.focusOptions = options; },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
    dispatchEvent(event) { events.push(event.type); listeners.get(event.type)?.(event); return true; },
    get innerText() { throw new Error("Spark draft must not force layout through innerText"); },
    set textContent(value) { input.childNodes = [textNode(value)]; }
  };
  const Event = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  const draftDocument = {
    body: null, querySelector: () => null, querySelectorAll: () => [],
    createRange: () => ({ selectNodeContents() {} }),
    execCommand(_command, _ui, value) {
      if (!nativeInsert) return false;
      input.childNodes = value.split("\n").map(line => ({ tagName: "P", childNodes: [textNode(line)] }));
      input.dispatchEvent(new Event("input"));
      return true;
    }
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/prompt-test" },
    Event, InputEvent: Event,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    document: draftDocument,
    ...overrides
  });
  return { api, input, events, listeners, document: draftDocument };
}

function sparkScheduledFixture(stopDuringWait = false, initialTime = 0, dispatchReady = true) {
  let time = initialTime;
  let clicks = 0;
  let preparedAt;
  let sentAt;
  let listener;
  const expected = { id: 41, content: "Completed" };
  const article = { id: "facility-41", facility_id: 41, runToken: "run-41", prompt: "Write JSON", prompt_dispatch_ready: dispatchReady, prompt_scheduled_at: new Date(60000).toISOString() };
  const fixture = sparkDraftFixture(true, {
    Date: class extends Date { static now() { return time; } },
    setTimeout(callback, ms) {
      time += ms;
      if (stopDuringWait && ms === 250) listener({ type: "stop-article", articleId: "facility-41" }, {}, () => {});
      queueMicrotask(callback);
      return time;
    },
    chrome: { runtime: {
      onMessage: { addListener(callback) { listener = callback; } },
      async sendMessage(message) {
        if (message.type === "get-current-article") return { ok: true, article };
        if (message.type === "article-prompt-prepared") preparedAt = time;
        if (message.type === "article-prompt-sent") sentAt = time;
        return { ok: true };
      }
    } }
  });
  const { api, input, document } = fixture;
  input.getClientRects = () => [{}];
  const send = { tagName: "BUTTON", getClientRects: () => [{}], getAttribute: (name) => name === "aria-label" ? "Gửi tin nhắn" : null, click() {
    assert.equal(time, 60000, "button must not be clicked while the countdown runs");
    clicks += 1;
  } };
  const composer = { querySelectorAll: (selector) => selector.includes("Ngừng tạo câu trả lời") ? [] : [send] };
  input.closest = (selector) => selector === "input-area-v2" ? composer : null;
  const old = geminiResponse("old", '{"id":42}');
  const fresh = geminiResponse("fresh", JSON.stringify(expected));
  const pane = {
    querySelector: (selector) => selector === "input-area-v2" ? composer : null,
    querySelectorAll: (selector) => selector === "model-response" ? [clicks ? fresh : old] : []
  };
  document.querySelector = (selector) => selector === ".right-pane" ? pane : null;
  document.querySelectorAll = (selector) => selector.includes(".right-pane input-area-v2 .ql-editor") ? [input] : [];
  const prompt = "Write JSON";
  return { ...fixture, article, run: () => api.runArticle(article, prompt), stats: () => ({ time, clicks, preparedAt, sentAt }) };
}

test("Spark fills once during the countdown and clicks Send only at the deadline", async () => {
  const fixture = sparkScheduledFixture();
  await fixture.run();
  assert.equal(fixture.stats().preparedAt, 0, "fill and acknowledge prompt before the countdown ends");
  assert.equal(fixture.stats().sentAt, 60000);
  assert.equal(fixture.stats().clicks, 1);
  assert.deepEqual(fixture.events, ["input"], "fill in one operation without typing chunks");
  assert.equal(fixture.article.prompt_scheduled_at, undefined, "resends must not reuse the countdown");
});

test("stopping a prefilled Spark article during the countdown prevents Send", async () => {
  const fixture = sparkScheduledFixture(true);
  await assert.rejects(fixture.run(), /Đã dừng bài viết/);
  assert.equal(fixture.stats().clicks, 0);
  assert.equal(fixture.stats().sentAt, undefined);
  assert.equal(fixture.stats().preparedAt, 0);
});

test("Spark reload recovery resumes a scheduled prompt without sending before its original deadline", async () => {
  const fixture = sparkScheduledFixture(false, 30000);
  assert.equal(await fixture.api.recoverPendingArticle(), true);
  assert.equal(fixture.stats().preparedAt, 30000);
  assert.equal(fixture.stats().sentAt, 60000);
  assert.equal(fixture.stats().clicks, 1);
});

test("scheduled prompt recovery waits for background lease readiness", async () => {
  const fixture = sparkScheduledFixture(false, 30000, false);
  assert.equal(await fixture.api.recoverPendingArticle(), false);
  assert.equal(fixture.stats().clicks, 0);
  assert.deepEqual(fixture.events, []);
});

test("Spark fills a long multiline prompt without duplicate editor events or layout reads", () => {
  const { api, input, events, listeners } = sparkDraftFixture(true);
  const prompt = "Viết bài\n" + "Nội dung dài ".repeat(3000) + "\nTrả JSON";
  api.setInputValue(input, prompt);
  assert.equal(api.sparkComposerText(input).trim(), prompt.trim());
  assert.deepEqual(events, ["input"], "native insertion already updated the editor");
  assert.equal(input.focusOptions.preventScroll, true);
  assert.equal(listeners.size, 0);
});

test("retrying the same Spark draft does not rebuild it or dispatch another input event", () => {
  const { api, input, events } = sparkDraftFixture(true);
  const prompt = "Prompt dài\n" + "Dữ liệu ".repeat(3000);
  api.setInputValue(input, prompt);
  input.focus = () => { throw new Error("an unchanged draft must not be focused again"); };
  api.setInputValue(input, prompt);
  assert.deepEqual(events, ["input"]);
  assert.equal(api.sparkComposerText(input).trim(), prompt.trim());
});

test("Spark allows a paint between composer operations and bounds waiting in hidden tabs", async () => {
  let frames = 0;
  const visible = loadGeminiContent({ requestAnimationFrame(callback) {
    frames += 1;
    queueMicrotask(callback);
    return frames;
  }, cancelAnimationFrame() {} });
  await visible.yieldSparkComposerFrame();
  assert.equal(frames, 2);
  const hidden = loadGeminiContent({
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    setTimeout(callback, ms) { assert.equal(ms, 50); queueMicrotask(callback); return 1; }, clearTimeout() {}
  });
  await hidden.yieldSparkComposerFrame();
});

test("Spark insertion fallback replaces the whole draft and emits one input event", () => {
  const { api, input, events } = sparkDraftFixture(false);
  api.setInputValue(input, "Prompt mới\nTrả JSON");
  assert.equal(api.sparkComposerText(input), "Prompt mới\nTrả JSON");
  assert.deepEqual(events, ["input"]);
});

test("Spark waits for its right Send button without re-dispatching input or Enter", async () => {
  let onMutation;
  let disconnected = 0;
  let clicks = 0;
  let send = null;
  const composer = { querySelectorAll: () => send ? [send] : [], querySelector: () => send };
  const events = [];
  const input = { closest: (selector) => selector === "input-area-v2" ? composer : null,
    getAttribute: () => null, dispatchEvent(event) { events.push(event.type); } };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/delayed-send" },
    MutationObserver: class {
      constructor(callback) { onMutation = callback; }
      observe(target) { assert.equal(target, composer); }
      disconnect() { disconnected += 1; }
    }
  });
  const pending = api.submitPrompt(input);
  assert.deepEqual(events, []);
  send = { tagName: "BUTTON", getAttribute: () => null, click() { clicks += 1; } };
  onMutation();
  assert.equal(await pending, true);
  assert.equal(clicks, 1);
  assert.equal(disconnected, 1);
  assert.deepEqual(events, []);
});

test("Spark refuses the left new-task editor even when it has a Send button", () => {
  let clicks = 0;
  const input = { getAttribute: (name) => name === "data-placeholder" ? "Mô tả tác vụ" : null,
    matches: () => false, closest: () => ({ querySelectorAll: () => [{ tagName: "BUTTON", click() { clicks += 1; } }] }) };
  const api = loadGeminiContent({ location: { hostname: "gemini.google.com", pathname: "/spark/chat/right-only" } });
  assert.equal(api.selectGeminiSparkInput([input]), null);
  assert.equal(api.clickSend(input), false);
  assert.throws(() => api.setInputValue(input, "Prompt"), /ô tạo task bên trái/);
  assert.equal(clicks, 0);
});

test("Spark recovery trusts the saved current task ID while the sidebar is still hydrating", async () => {
  const sent = [];
  const values = new Map([["medreview-spark-task-article-527", JSON.stringify({
    taskId: "spark-content-task",
    url: "https://gemini.google.com/spark/chat/spark-content-task"
  })]]);
  const api = loadGeminiContent({
    location: {
      hostname: "gemini.google.com",
      pathname: "/spark/chat/spark-content-task",
      href: "https://gemini.google.com/spark/chat/spark-content-task"
    },
    sessionStorage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, String(value)); }
    },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (message) => { sent.push(message); return { ok: true }; }
    } },
    document: { body: null, querySelector: () => null, querySelectorAll: () => [] }
  });
  const task = await api.ensureGeminiSparkContentTask({ id: "article-527", runToken: "run-1" });
  assert.equal(task.onTask, true);
  assert.equal(task.taskId, "spark-content-task");
  assert.equal(sent.find((message) => message.type === "bind-spark-task")?.sparkTaskId, "spark-content-task");
});

test("extension does not programmatically scroll and input focus prevents browser auto-scroll", () => {
  const pageScripts = ["background.js", "content.js", "popup.js"]
    .map((file) => fs.readFileSync(path.join(extensionRoot, file), "utf8").replace(/\.focus\(\{\s*preventScroll:\s*true\s*\}\)/g, ""));
  for (const source of pageScripts) {
    assert.doesNotMatch(source, /\.\s*(?:scrollIntoView(?:IfNeeded)?|scrollTo|scrollBy|scroll)\s*\(|\.\s*scroll(?:Top|Left)\s*=/i,
      "extension scripts must not move the webpage or force it to either end of the conversation");
  }
  assert.match(fs.readFileSync(path.join(extensionRoot, "content.js"), "utf8"), /\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
});

test("Gemini Spark receives a fenced-JSON output contract", () => {
  const api = loadGeminiContent({ location: { hostname: "gemini.google.com", pathname: "/spark/chat/test" } });
  const prompt = api.promptForProvider("Prompt API");
  assert.match(prompt, /Prompt API/);
  assert.match(prompt, /```json/);
  assert.match(prompt, /JSON\.parse/i);
  assert.match(prompt, /escape thành/);
});

test("Gemini picks the visible Quill composer instead of its hidden clipboard", async () => {
  const editor = {
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{}]
  };
  const clipboard = {
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => []
  };
  const document = {
    body: null,
    querySelectorAll(selector) {
      if (selector === "rich-textarea [contenteditable='true'][role='textbox']") return [editor];
      if (selector.includes("ql-clipboard")) return [clipboard];
      return [];
    }
  };
  const api = loadGeminiContent({ document });
  assert.equal(api.provider, "gemini");
  assert.equal(api.inputSelectors()[0], "rich-textarea [contenteditable='true'][role='textbox']");
  assert.equal(await api.waitForInput(20), editor);
});

test("Gemini uses its visible Gửi tin nhắn button", () => {
  let clicked = 0;
  const sendButton = {
    disabled: false,
    offsetParent: {},
    click() { clicked += 1; }
  };
  const document = {
    body: null,
    querySelector(selector) {
      return selector.includes("button[aria-label='Gửi tin nhắn']") ? sendButton : null;
    },
    querySelectorAll: () => []
  };
  const api = loadGeminiContent({ document });
  assert.equal(api.clickSend({ closest: () => null }), true);
  assert.equal(clicked, 1);
});

test("Spark code-block fast path avoids whole-response layout reads and reuses parsed JSON", () => {
  const json = '{"id":41,"content":"Complete","reviews":[]}';
  let parses = 0;
  const assistant = geminiResponse("reply-41", "", [{ textContent: json }]);
  Object.defineProperty(assistant, "innerText", { get() { throw new Error("whole reply innerText must not be read"); } });
  Object.defineProperty(assistant, "textContent", { get() { throw new Error("whole reply textContent must not be read"); } });
  const api = loadGeminiContent({
    JSON: { parse(value) { parses++; return JSON.parse(value); }, stringify: JSON.stringify },
    document: { body: null, querySelector: () => null, querySelectorAll: (selector) => selector === "model-response" ? [assistant] : [] }
  });
  const first = api.parseAssistantResponse(api.latestAssistantResponse(41), 41);
  const count = parses;
  for (let i = 0; i < 10; i++) {
    const repeated = api.parseAssistantResponse(api.latestAssistantResponse(41), 41);
    assert.equal(repeated.data, first.data, "stable text should reuse the parsed object");
    assert.equal(repeated.idMatched, true);
  }
  assert.equal(parses, count, "stable JSON should not be parsed repeatedly");
});

test("Spark wrong-ID code block falls back to matching plain JSON", () => {
  const expected = { id: 41, content: "Plain reply" };
  const assistant = geminiResponse("reply-41", JSON.stringify(expected), [{ textContent: '{"id":42,"content":"Wrong article"}' }]);
  const api = loadGeminiContent({ document: { body: null, querySelector: () => null, querySelectorAll: (selector) => selector === "model-response" ? [assistant] : [] } });
  const result = api.parseAssistantResponse(api.latestAssistantResponse(41), 41);
  assert.equal(result.idMatched, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), expected);
});

test("Gemini reads complete JSON from model-response", () => {
  const expected = { id: 76, name: "Westcoast", content: "Bài Gemini", reviews: [{ rating: 5 }] };
  const json = JSON.stringify(expected);
  const assistant = geminiResponse("model-response-76", `JSON\n${json}`, [{ textContent: json, innerText: json }]);
  const api = loadGeminiContent({
    document: {
      body: null,
      querySelector: () => null,
      querySelectorAll: (selector) => selector === "model-response" ? [assistant] : []
    }
  });
  const snapshot = api.latestAssistantResponse();
  assert.equal(snapshot.node, assistant);
  assert.deepEqual(JSON.parse(JSON.stringify(api.parseAssistantResponse(snapshot, 76).data)), expected);
});

test("Gemini Spark reads completed JSON from its message-content preformatted response", () => {
  // Spark currently renders a completed answer inside:
  // model-response > response-container > structured-content-container
  // .model-response-text > message-content#message-content-id-r_* >
  // .markdown.markdown-main-panel.  The message-content element is the
  // narrowest stable selector already supported by content.js.
  const expected = {
    id: 914,
    name: "Phòng khám Spark",
    content: "<p>Nội dung đã hoàn tất.</p>",
    highlights: ["Phản hồi JSON trong Spark"],
    reviews: [{ rating: 5, content: "Tư vấn rõ ràng" }]
  };
  const json = JSON.stringify(expected);
  const modelResponse = {
    id: "model-response-spark-914",
    getAttribute: (name) => name === "id" ? "model-response-spark-914" : null
  };
  const pre = { textContent: json, innerText: json };
  const sparkMessage = {
    textContent: `JSON\n${json}`,
    innerText: `JSON\n${json}`,
    getClientRects: () => [{}],
    getAttribute: (name) => name === "id" ? "message-content-id-r_spark-914" : null,
    closest(selector) {
      return /model-response|response-container|message-content/.test(selector) ? modelResponse : null;
    },
    querySelector: () => null,
    // Spark's code block is ordinary preformatted text rather than a special
    // JSON component, so preserve both the `pre` and surrounding text paths.
    querySelectorAll: (selector) => selector.includes("pre") ? [pre] : [],
    cloneNode() {
      return { textContent: this.textContent, querySelectorAll: () => [] };
    }
  };
  const api = loadGeminiContent({
    document: {
      body: null,
      querySelector: () => null,
      querySelectorAll: (selector) => selector === "message-content[id^='message-content-id-']" ? [sparkMessage] : []
    }
  });

  const snapshot = api.latestAssistantResponse();
  assert.equal(snapshot.node, sparkMessage);
  assert.ok(snapshot.sources.includes(json), "Spark pre text must remain a JSON parsing source");
  assert.deepEqual(JSON.parse(JSON.stringify(api.parseAssistantResponse(snapshot, 914).data)), expected);
});

test("Gemini Spark reads only the newest response from its split pane without scanning page history", () => {
  const makeResponse = (text) => ({
    textContent: text,
    innerText: text,
    getClientRects: () => [{}],
    getAttribute: () => null,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  });
  const oldResponse = makeResponse('{"id":1}');
  const latestResponse = makeResponse('{"id":2}');
  const queried = [];
  const pane = {
    querySelectorAll(selector) {
      queried.push(selector);
      return selector === "model-response" ? [oldResponse, latestResponse] : [];
    }
  };
  const document = {
    querySelector(selector) { return selector.startsWith(".right-pane") ? pane : null; },
    querySelectorAll() { throw new Error("Gemini watcher must not scan the full page history"); }
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/current" },
    document,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" })
  });

  const snapshot = api.latestAssistantResponse();
  assert.equal(snapshot.node, latestResponse);
  assert.equal(snapshot.sources[0], '{"id":2}');
  assert.deepEqual(queried, ["model-response"]);
});

test("manual recovery scans Spark history and selects the completed JSON matching the failed facility ID", async () => {
  const old = geminiResponse("old-response", JSON.stringify({ id: 52, content: "Bài cũ" }));
  const current = geminiResponse("current-response", JSON.stringify({ id: 53, content: "JSON đã hoàn tất" }));
  const sidebarTask = {
    id: "goal-c_spark-current-task",
    textContent: "Nghiên cứu dữ liệu khác Vừa xong",
    matches: () => false,
    querySelector: () => null,
    getAttribute: (name) => name === "id" ? "goal-c_spark-current-task" : null,
    closest: () => null
  };
  const root = { querySelectorAll: (selector) => selector === "model-response" ? [old, current] : [] };
  const document = {
    querySelector: (selector) => selector === ".right-pane" ? root : null,
    querySelectorAll(selector) {
      return selector.startsWith("[id^='goal-c_") || selector.startsWith("[id^='goal-c-") ? [sidebarTask] : [];
    }
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/spark-current-task", href: "https://gemini.google.com/spark/chat/spark-current-task" },
    document
  });
  const recovered = await api.readExistingArticleJson({ id: "facility-53", facility_id: 53, sourceType: "facility" });
  assert.equal(recovered.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.article)), { id: 53, content: "JSON đã hoàn tất" });
});

test("Gemini Spark selector is reached even when its displayed object is malformed JSON", () => {
  // This reflects the failure seen in the live Spark tab: inner quotation
  // marks in `content` were rendered without JSON escaping.  A selector bug
  // and invalid JSON must remain distinguishable in diagnostics.
  const malformed = [
    "{",
    '  "id": 915,',
    '  "content": "<p>Người bệnh ghi nhận: "Y bác sĩ nhiệt tình."</p>",',
    '  "reviews": []',
    "}"
  ].join("\n");
  const sparkMessage = geminiResponse(
    "message-content-id-r_spark-915",
    malformed,
    [{ textContent: malformed, innerText: malformed }]
  );
  const api = loadGeminiContent({
    document: {
      body: null,
      querySelector: () => null,
      querySelectorAll: (selector) => selector === "message-content[id^='message-content-id-']" ? [sparkMessage] : []
    }
  });

  const snapshot = api.latestAssistantResponse();
  assert.equal(snapshot.node, sparkMessage, "the Spark answer was found, not skipped");
  assert.equal(api.parseAssistantResponse(snapshot, 915), null, "invalid JSON must not be silently fabricated");
});

test("Gemini accepts JSON that fills an already-mounted response container", async () => {
  const placeholder = geminiResponse("model-response-77", "Gemini đang suy nghĩ…");
  const result = { id: 77, content: "Đã hoàn tất từ Gemini", reviews: [] };
  const state = { time: 0, generating: true };
  const stop = { getClientRects: () => [{}] };
  const api = loadGeminiContent({
    Date: class extends Date { static now() { return state.time; } },
    getComputedStyle: () => ({ visibility: "visible" }),
    document: {
      body: null,
      querySelector: () => null,
      querySelectorAll(selector) {
        if (selector === "model-response") return [placeholder];
        if (selector.includes("button[")) return state.generating ? [stop] : [];
        return [];
      }
    },
    setTimeout(callback, ms) {
      state.time += ms;
      if (state.time >= 1600) placeholder.textContent = placeholder.innerText = `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``;
      if (state.time >= 3200) state.generating = false;
      queueMicrotask(callback);
      return state.time;
    }
  });
  const before = api.latestAssistantResponse();
  const parsed = await api.waitForResponse(before, "facility-77", 10000, 77);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.data)), result);
  assert.ok(state.time >= 4800, "must wait for the Gemini response to become stable");
});

test("Gemini starts exactly one tab-bound worker and claims one article", async () => {
  const state = {
    sourceType: "facility",
    runner: { active: false },
    items: [
      { id: "facility-301", facility_id: 301, title: "Bài Gemini", prompt: "Prompt", status: "chờ" },
      { id: "facility-302", facility_id: 302, title: "Bài kế", prompt: "Prompt 2", status: "chờ" }
    ]
  };
  const sent = [];
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in state).map((key) => [key, structuredClone(state[key])]));
      },
      async set(values) { Object.assign(state, structuredClone(values)); }
    } },
    tabs: {
      async query(query) {
        if (query.active) return [{ id: 404, url: "https://gemini.google.com/app/live", active: true }];
        if (query.url === "*://gemini.google.com/*") return [{ id: 404, url: "https://gemini.google.com/app/live" }];
        return [];
      },
      async sendMessage(tabId, message) { if (message.type !== "runner-ready") sent.push({ tabId, message }); return { ok: true }; }
    },
    scripting: { async executeScript() {} }
  };
  const source = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8")
    + "\nglobalThis.__geminiBackgroundTest = { startRun };";
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key", chrome, URL, structuredClone, AbortController, fetch: mockClaimFetch, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: "background.js" });
  await context.__geminiBackgroundTest.startRun(
    { provider: "gemini", targetTabId: 404 },
    { tab: { id: 404, url: "https://gemini.google.com/app/live" } }
  );
  assert.equal(state.runner.workers["tab-404"].provider, "gemini");
  assert.equal(state.runner.workers["tab-404"].currentId, "facility-301");
  assert.equal(state.items[0].provider, "gemini");
  assert.equal(state.items[1].status, "chờ");
  assert.deepEqual(sent.map(({ tabId }) => tabId), [404]);
});

test("Gemini Spark prioritizes input inside .right-pane rather than other inputs", async () => {
  const leftInput = {
    disabled: false,
    getAttribute: (name) => name === "aria-label" ? "Mô tả tác vụ" : null,
    getClientRects: () => [{ left: 50 }],
    closest: (selector) => selector.includes("left-pane") ? {} : null
  };
  const rightPaneInput = {
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{ left: 800 }],
    closest: (selector) => selector.includes("right-pane") ? {} : null
  };
  const document = {
    body: null,
    querySelectorAll(selector) {
      if (selector.includes(".right-pane")) return [rightPaneInput];
      if (selector.includes("rich-textarea")) return [leftInput, rightPaneInput];
      return [];
    }
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/81bc79ba9f5aed3e" },
    document
  });
  const input = await api.waitForInput(20);
  assert.equal(input, rightPaneInput);
});

test("Gemini Spark clicks send button inside .right-pane", () => {
  let rightClicked = 0;
  const rightSendBtn = {
    tagName: "BUTTON",
    disabled: false,
    offsetParent: {},
    click() { rightClicked += 1; }
  };
  const rightPane = {
    querySelector(selector) {
      return selector.includes("button[aria-label*='Gửi']") ? rightSendBtn : null;
    },
    querySelectorAll(selector) {
      return selector.includes("aria-label='Gửi tin nhắn'") ? [rightSendBtn] : [];
    }
  };
  const rightInput = {
    closest: (selector) => selector.includes("right-pane") ? rightPane : null,
    parentElement: rightPane
  };
  const document = {
    body: null,
    querySelector(selector) {
      if (selector.includes(".right-pane")) return rightPane;
      return null;
    },
    querySelectorAll: () => []
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/81bc79ba9f5aed3e" },
    document
  });
  assert.equal(api.clickSend(rightInput), true);
  assert.equal(rightClicked, 1);
});

test("Gemini Spark with multi-account /u/1/ selects input-area-v2 and send-button-container", async () => {
  const newTaskInput = {
    disabled: false,
    getAttribute: (name) => name === "data-placeholder" ? "Mô tả tác vụ" : null,
    getClientRects: () => [{ left: 50 }],
    closest: (selector) => selector.includes("left-pane") ? {} : null
  };
  const rightSendBtn = {
    tagName: "BUTTON",
    disabled: false,
    offsetParent: {},
    click() { rightSendClicks += 1; }
  };
  let rightSendClicks = 0;
  const inputAreaV2 = {
    querySelector(selector) {
      if (selector.includes("send-button-container") || selector.includes("Gửi")) return rightSendBtn;
      return null;
    }
  };
  const sparkFollowUpInput = {
    disabled: false,
    getAttribute: (name) => name === "data-placeholder" ? "Chúng ta có thể làm gì tiếp theo?" : null,
    getClientRects: () => [{ left: 750 }],
    closest: (selector) => (selector.includes("input-area-v2") || selector.includes("remy-mode")) ? inputAreaV2 : null
  };
  const document = {
    body: null,
    querySelector(selector) {
      if (selector.includes("input-area-v2") || selector.includes("remy-split-pane")) return inputAreaV2;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("data-placeholder*='tiếp theo'") || selector.includes("input-area-v2")) {
        return [sparkFollowUpInput];
      }
      if (selector.includes("rich-textarea")) {
        return [newTaskInput, sparkFollowUpInput];
      }
      return [];
    }
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/u/1/spark/chat/81bc79ba9f5aed3e" },
    document
  });
  const input = await api.waitForInput(20);
  assert.equal(input, sparkFollowUpInput, "must choose Chúng ta có thể làm gì tiếp theo instead of Mô tả tác vụ");
  assert.equal(api.clickSend(input), true);
  assert.equal(rightSendClicks, 1, "must click send button inside input-area-v2");
});



test("Gemini Spark sends only through the composer belonging to the selected input", () => {
  let leftClicks = 0;
  let rightClicks = 0;
  const leftSend = {
    tagName: "BUTTON",
    disabled: false,
    getAttribute: () => null,
    click() { leftClicks += 1; }
  };
  const rightSend = {
    tagName: "BUTTON",
    disabled: false,
    getAttribute: () => null,
    click() { rightClicks += 1; }
  };
  const rightComposer = { querySelectorAll: () => [rightSend] };
  const input = {
    closest(selector) {
      return selector === "input-area-v2" ? rightComposer : null;
    }
  };
  const document = {
    body: null,
    // Another enabled Send exists earlier in the DOM; it belongs to a
    // different composer and must never be used as a fallback.
    querySelector: () => leftSend,
    querySelectorAll: () => [leftSend, rightSend]
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/wrong-send-guard" },
    document
  });

  assert.equal(api.clickSend(input), true);
  assert.equal(leftClicks, 0, "must not click the other composer’s Send button");
  assert.equal(rightClicks, 1, "must click Send inside the selected input-area-v2");
});

test("Gemini Spark submitPrompt clicks Send once and does not also press Enter", async () => {
  let clicks = 0;
  let enters = 0;
  const sendBtn = {
    tagName: "BUTTON",
    disabled: false,
    offsetParent: {},
    click() { clicks += 1; }
  };
  const rightPane = {
    querySelector(selector) {
      return selector.includes("send-button-container") || selector.includes("Gửi") ? sendBtn : null;
    }
  };
  const input = {
    closest: (selector) => selector.includes("right-pane") || selector.includes("input-area") ? rightPane : null,
    parentElement: rightPane,
    focus() {},
    dispatchEvent(evt) {
      if (evt?.type === "keydown" && (evt.key === "Enter" || evt.keyCode === 13)) enters += 1;
      return true;
    }
  };
  const document = {
    body: null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/dup-check" },
    document,
    KeyboardEvent: class KeyboardEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    MouseEvent: class MouseEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    }
  });
  const sent = await api.submitPrompt(input);
  assert.equal(sent, true);
  assert.equal(clicks, 1, "Send must be clicked exactly once");
  assert.equal(enters, 0, "Enter must not fire after a successful Send click");
});


test("Live Spark /u/1/ path keeps account prefix in chat URLs", () => {
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/u/1/spark/chat/dbd093fcf39d88a8" }
  });
  assert.equal(api.sparkAccountPrefix(), "/u/1");
  assert.equal(api.extractGeminiSparkTaskId("/u/1/spark/chat/dbd093fcf39d88a8"), "dbd093fcf39d88a8");
});

test("Live Spark sidebar role=option rows are candidates and nav links are skipped", () => {
  const tasksNav = { textContent: "Tasks", matches: () => false, querySelector: () => null, getAttribute: () => null };
  const option = {
    textContent: "Hồ Sơ Y Tế Aman Spa — Đang xác thực dữ liệu cơ sở Aman Spa",
    matches: () => false,
    querySelector: () => null,
    getAttribute: () => null
  };
  const document = {
    body: null,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector.includes("role='option'")) return [option];
      if (selector.includes("a[href*='/spark/']")) return [tasksNav];
      return [];
    }
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/u/1/spark/chat/x" },
    document
  });
  const candidates = api.getSparkSidebarCandidates();
  assert.ok(candidates.includes(option));
  assert.equal(candidates.includes(tasksNav), false);
});

test("Stopped Spark task is not treated as still generating", () => {
  const stopped = {
    textContent: "Bạn đã dừng việc này",
    hidden: false,
    getAttribute: () => null,
    getClientRects: () => [{}]
  };
  const processingBtn = {
    textContent: "Xác thực địa chỉ Aman Spa",
    hidden: false,
    getAttribute: (name) => name === "data-test-id" ? "processing-state-container-button" : null,
    getClientRects: () => [{}]
  };
  const document = {
    body: null,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector.includes("stopped-task-message")) return [stopped];
      if (selector.includes("processing-state-container-button") || selector.includes("remy-processing-state-text")) return [processingBtn];
      if (selector.includes("aria-busy")) return [];
      if (selector.includes("data-testid*='stop'") || selector.includes("aria-label*='Stop'") || selector.includes("aria-label*='Dừng'")) return [];
      if (selector === "button,[role='button']" || selector.includes("[role='button']")) return [processingBtn];
      return [];
    }
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/x" },
    document,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" })
  });
  assert.equal(api.isGenerating(), false);
});

test("Gemini ignores processing controls retained by older turns and tracks only the newest response", () => {
  const oldStatus = {
    textContent: "Đang xử lý tác vụ cũ",
    innerText: "Đang xử lý tác vụ cũ",
    getClientRects: () => [{}],
    getAttribute: (name) => name === "data-test-id" ? "processing-state-container-button" : null
  };
  const oldResponse = {
    innerText: "Kết quả task cũ",
    textContent: "Kết quả task cũ",
    getClientRects: () => [{}],
    closest: () => null,
    querySelector: () => null,
    querySelectorAll(selector) { return selector.includes("processing-state-container-button") ? [oldStatus] : []; }
  };
  const completedTaskStep = {
    textContent: "Đã hoàn tất phần nghiên cứu hồ sơ",
    innerText: "Đã hoàn tất phần nghiên cứu hồ sơ",
    getClientRects: () => [{}],
    getAttribute: (name) => name === "data-test-id" ? "processing-state-container-button" : null
  };
  const latestResponse = {
    innerText: "JSON hoàn tất",
    textContent: "JSON hoàn tất",
    getClientRects: () => [{}],
    closest: () => null,
    querySelector: () => null,
    querySelectorAll(selector) { return selector.includes("processing-state-container-button") ? [completedTaskStep] : []; }
  };
  const rightPane = {
    querySelectorAll(selector) { return selector === "model-response" ? [oldResponse, latestResponse] : []; }
  };
  const document = {
    body: null,
    querySelector(selector) { return selector === ".right-pane" ? rightPane : null; },
    querySelectorAll: () => []
  };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/task" },
    document,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" })
  });

  assert.equal(api.isGenerating(), false, "old and completed research-step cards must not count as live generation");
  const signature = api.geminiSparkProgressSignature("new response", latestResponse);
  assert.doesNotMatch(signature, /tác vụ cũ/i);
});

test("Gemini Spark finds the visible content ai task instead of relying on a fixed conversation ID", async () => {
  const row = {
    id: "goal-c_dynamic-content-task",
    // Spark concatenates the row title and its status without a separator.
    textContent: "content aiĐang thực hiện kiểm chứng dữ liệu y tế chuyên sâu",
    matches: () => false,
    querySelector: () => null,
    getAttribute(name) { return name === "id" ? this.id : null; }
  };
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector.includes("role='option'") ? [row] : [];
    }
  };
  const selected = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/dynamic-content-task" },
    document
  });
  const other = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/another-task" },
    document
  });
  assert.equal(selected.isGeminiSparkContentTask(), true);
  assert.equal((await selected.resolveGeminiSparkContentTask()).taskId, "dynamic-content-task");
  assert.equal(other.isGeminiSparkContentTask(), false);
});

test("Spark reloads after ten minutes even when generation reports progress", async () => {
  const expected = { id: 778, content: "JSON đã có nhưng Spark vẫn ghi đang xử lý" };
  const answer = geminiResponse("message-content-id-r_spark-778", "Gemini đang xử lý…");
  const state = { time: 0, stage: 0, reloads: 0 };
  const progress = { textContent: "Đang tìm kiếm nguồn 1", getClientRects: () => [{}], getAttribute: () => null };
  const processing = { textContent: "Đang xử lý…", getClientRects: () => [{}], getAttribute: () => null };
  const stopButton = { textContent: "", getClientRects: () => [{}], getAttribute: (name) => name === "aria-label" ? "Ngừng tạo câu trả lời" : null };
  answer.querySelectorAll = (selector) => {
    if (selector === "pre, code") return [];
    if (selector.includes("aria-live") || selector.includes("progress")) return [progress];
    if (selector.includes("processing-state-container-button") || selector.includes("remy-processing-state-text")) return [processing];
    return [];
  };
  const api = loadGeminiContent({
    location: {
      hostname: "gemini.google.com", pathname: "/spark/chat/4fd44b00d57b4bc9",
      reload() { state.reloads += 1; }
    },
    Date: class extends Date { static now() { return state.time; } },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    document: {
      body: null,
      querySelector: () => null,
      querySelectorAll(selector) {
        if (selector === "message-content[id^='message-content-id-']") return [answer];
        if (selector.includes("data-testid*='stop'") || selector.includes("aria-label*='Stop'") || selector.includes("aria-label*='Dừng'")) return [stopButton];
        if (selector.includes("aria-live") || selector.includes("progress")) return [progress];
        if (selector.includes("processing-state-container-button")) return [processing];
        return [];
      }
    },
    setTimeout(callback, ms) {
      state.time += ms;
      if (state.time >= 1600) answer.textContent = answer.innerText = JSON.stringify(expected);
      if (state.time >= 90000 && state.stage < 1) { state.stage = 1; progress.textContent = "Đã tìm thấy nguồn 2"; }
      if (state.time >= 170000 && state.stage < 2) { state.stage = 2; progress.textContent = "Đang phân tích dữ liệu"; }
      queueMicrotask(callback);
      return state.time;
    }
  });
  await assert.rejects(api.waitForResponse(api.latestAssistantResponse(), "facility-778", 900000, 778), (error) => {
    assert.equal(error.code, "gemini-spark-reload");
    return true;
  });
  assert.ok(state.time >= 600000 && state.time < 602000, "reload follows the ten-minute cycle regardless of visible progress");
  assert.equal(state.reloads, 1);
});

test("Spark reload watchdog also catches an idle send that never starts generation", async () => {
  const answer = geminiResponse("message-content-id-r_spark-old", "Câu trả lời cũ không có JSON cho bài hiện tại");
  const state = { time: 0, reloads: 0 };
  const rightPane = {
    querySelectorAll(selector) { return selector === "model-response" ? [answer] : []; }
  };
  const api = loadGeminiContent({
    location: {
      hostname: "gemini.google.com", pathname: "/spark/chat/content-task",
      href: "https://gemini.google.com/spark/chat/content-task",
      reload() { state.reloads += 1; }
    },
    Date: class extends Date { static now() { return state.time; } },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    document: {
      body: null,
      querySelector(selector) { return selector === ".right-pane" ? rightPane : null; },
      querySelectorAll: () => []
    },
    setTimeout(callback, ms) { state.time += ms; queueMicrotask(callback); return state.time; }
  });

  const before = api.latestAssistantResponse();
  await assert.rejects(api.waitForResponse(before, "facility-780", 900000, 780), (error) => {
    assert.equal(error.code, "gemini-spark-reload");
    return true;
  });
  assert.ok(state.time >= 600000 && state.time < 602000, "an idle send also waits for the ten-minute reload cycle");
  assert.equal(state.reloads, 1);
});

test("a resent Spark prompt waits ten minutes even when the same article has an expired reload marker", async () => {
  const state = { time: 1000000, reloads: 0 };
  const stopButton = { getClientRects: () => [{}], getAttribute: (name) => name === "aria-label" ? "Ngừng tạo câu trả lời" : null };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/retry-test", reload() { state.reloads += 1; } },
    Date: class extends Date { static now() { return state.time; } },
    sessionStorage: {
      getItem(key) { return key === "medreview-gemini-spark-reload" ? JSON.stringify({ articleId: "facility-41", at: 1 }) : null; },
      setItem() {}
    },
    document: {
      body: null, querySelector: () => null,
      querySelectorAll(selector) { return selector.includes("stop") || selector.includes("Stop") || selector.includes("Dừng") ? [stopButton] : []; }
    },
    setTimeout(callback, ms) { state.time += ms; queueMicrotask(callback); return state.time; }
  });
  await assert.rejects(api.waitForResponse(api.latestAssistantResponse(), "facility-41", 900000, 41), (error) => error.code === "gemini-spark-reload");
  assert.ok(state.time >= 1600000 && state.time < 1602000);
  assert.equal(state.reloads, 1);
});

test("Spark recovery accepts stable current JSON after the reload", async () => {
  const expected = { id: 779, content: "Recovered JSON" };
  const answer = geminiResponse("message-content-id-r_spark-779", `\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``);
  const processing = { textContent: "Đang xử lý…", getClientRects: () => [{}], getAttribute: () => null };
  const state = { time: 0 };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/4fd44b00d57b4bc9" },
    Date: class extends Date { static now() { return state.time; } },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    document: {
      body: null,
      querySelector: () => null,
      querySelectorAll(selector) {
        if (selector === "message-content[id^='message-content-id-']") return [answer];
        if (selector.includes("remy-processing-state")) return [processing];
        return [];
      }
    },
    setTimeout(callback, ms) { state.time += ms; queueMicrotask(callback); return state.time; }
  });
  const recovered = await api.waitForResponse(api.latestAssistantResponse(), "facility-779", 10000, 779, { acceptCurrent: true });
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.data)), expected);
  assert.ok(state.time >= 3200);
});

test("Spark recovery waits past the ordinary timeout for JSON from the same task", async () => {
  const expected = { id: 779, content: "Appeared after reload" };
  const answer = geminiResponse("message-content-id-r_spark-779", "Đang hoàn tất dữ liệu…");
  const state = { time: 0 };
  const api = loadGeminiContent({
    location: { hostname: "gemini.google.com", pathname: "/spark/chat/4fd44b00d57b4bc9" },
    Date: class extends Date { static now() { return state.time; } },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    document: {
      body: null,
      querySelector: () => null,
      querySelectorAll: (selector) => selector === "message-content[id^='message-content-id-']" ? [answer]
        : selector.includes("button[aria-label='Ngừng tạo câu trả lời']") && state.time < 5000
          ? [{ getClientRects: () => [{}], getAttribute: () => null }] : []
    },
    setTimeout(callback, ms) {
      state.time += ms;
      if (state.time >= 5000) answer.textContent = answer.innerText = `\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``;
      queueMicrotask(callback);
      return state.time;
    }
  });
  const recovered = await api.waitForResponse(api.latestAssistantResponse(), "facility-779", 1000, 779, {
    acceptCurrent: true,
    waitUntilJson: true
  });
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.data)), expected);
  assert.ok(state.time > 5000, "recovery must not time out and release the next queue item");
});
