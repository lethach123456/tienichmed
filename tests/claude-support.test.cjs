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

test("Claude pages may load both the content script and embedded panel files", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
  const contentMatches = manifest.content_scripts.flatMap((entry) => entry.matches || []);
  const resource = manifest.web_accessible_resources.find((entry) => (entry.resources || []).includes("popup.html"));
  assert.ok(contentMatches.includes("https://claude.ai/*"));
  assert.ok(resource.matches.includes("https://claude.ai/*"));
});

test("Claude composer detection chooses its visible ProseMirror editor", async () => {
  const visibleEditor = {
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{}]
  };
  const document = {
    body: null,
    querySelectorAll(selector) {
      if (selector === "div.ProseMirror[contenteditable='true']") return [visibleEditor];
      return [];
    }
  };
  const source = fs.readFileSync(path.join(extensionRoot, "content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__claudeTest = { provider: PROVIDER, inputSelectors, waitForInput };
  }`);
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    location: { hostname: "claude.ai" }, document,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    getComputedStyle: () => ({ visibility: "visible" }),
    setTimeout, clearTimeout
  });
  vm.runInContext(source, context, { filename: "content.js" });
  assert.equal(context.__claudeTest.provider, "claude");
  assert.ok(context.__claudeTest.inputSelectors().some((selector) => selector.includes("ProseMirror")));
  assert.equal(await context.__claudeTest.waitForInput(20), visibleEditor);
});

test("Claude response detection reads complete JSON from its assistant message", () => {
  const json = '{"id":204,"content":"Bài Claude hoàn tất","reviews":[{"rating":5}]}';
  const codeBlock = { textContent: json, innerText: json };
  const assistant = {
    textContent: `JSON\n${json}`,
    innerText: `JSON\n${json}`,
    getClientRects: () => [{}],
    getAttribute: (name) => name === "data-message-id" ? "claude-response-204" : null,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: (selector) => selector.includes("pre") ? [codeBlock] : [],
    cloneNode() {
      return { textContent: this.textContent, querySelectorAll: () => [] };
    }
  };
  const document = {
    body: null,
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector === "[data-testid='assistant-message']" ? [assistant] : [];
    }
  };
  const source = fs.readFileSync(path.join(extensionRoot, "content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__claudeResponseTest = { provider: PROVIDER, latestAssistantResponse, parseAssistantResponse };
  }`);
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    location: { hostname: "claude.ai" }, document,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    getComputedStyle: () => ({ visibility: "visible" }),
    setTimeout, clearTimeout
  });
  vm.runInContext(source, context, { filename: "content.js" });
  const snapshot = context.__claudeResponseTest.latestAssistantResponse();
  const parsed = context.__claudeResponseTest.parseAssistantResponse(snapshot, 204);
  assert.equal(snapshot.node, assistant);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.data)), JSON.parse(json));
});

test("an explicit Claude run starts only Claude and claims one article", async () => {
  const state = {
    sourceType: "facility",
    runner: { active: false },
    items: [
      { id: "facility-201", facility_id: 201, title: "Bài A", prompt: "Prompt A", status: "chờ" },
      { id: "facility-202", facility_id: 202, title: "Bài B", prompt: "Prompt B", status: "chờ" },
      { id: "facility-203", facility_id: 203, title: "Bài C", prompt: "Prompt C", status: "chờ" }
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
        if (query.active) return [{ id: 11, url: "https://chatgpt.com/c/live", active: true }];
        if (query.url === "*://chatgpt.com/*") return [{ id: 11, url: "https://chatgpt.com/c/live" }];
        if (query.url === "*://grok.com/*") return [{ id: 22, url: "https://grok.com/c/live" }];
        if (query.url === "*://claude.ai/*") return [{ id: 33, url: "https://claude.ai/chat/live" }];
        return [];
      },
      async update() {},
      async sendMessage(tabId, message) { if (message.type !== "runner-ready") sent.push({ tabId, message }); return { ok: true }; }
    },
    scripting: { async executeScript() {} }
  };
  const source = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8")
    + "\nglobalThis.__claudeBackgroundTest = { startRun };";
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    chrome, URL, structuredClone, AbortController,
    fetch: mockClaimFetch,
    setTimeout, clearTimeout
  });
  vm.runInContext(source, context, { filename: "background.js" });
  await context.__claudeBackgroundTest.startRun(
    { provider: "claude", targetTabId: 33 },
    { tab: { id: 33, url: "https://claude.ai/chat/live" } }
  );

  assert.equal(state.runner.active, true);
  assert.equal(state.runner.parallel, false);
  assert.deepEqual(Object.keys(state.runner.workers), ["tab-33"]);
  assert.equal(state.runner.workers["tab-33"].provider, "claude");
  assert.equal(state.runner.workers["tab-33"].currentId, "facility-201");
  assert.equal(state.items.filter((item) => item.status === "chờ").length, 2);
  assert.deepEqual(sent.map(({ tabId }) => tabId), [33]);
  assert.deepEqual(sent.map(({ message }) => message.article.id), ["facility-201"]);
});
