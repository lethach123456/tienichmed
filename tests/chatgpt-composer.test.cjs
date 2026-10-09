const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadChatGPTContent(input, responsePre = null, options = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__chatgptComposerTest = { provider: PROVIDER, inputSelectors, prepareArticleInput, inputContainsPrompt, waitForPromptInComposer, clickSend, latestAssistantResponse, parseAssistantResponse, responseHasJsonCodeBlock, waitForResponse, isGenerating };
  }`);
  const selectorQueries = [];
  const document = {
    body: null,
    querySelector(selector) {
      selectorQueries.push(selector);
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "main pre" && responsePre) return [responsePre];
      if (selector === "[data-markdown-text-style='assistant-message']") return options.responses || [];
      if (selector === "main [data-markdown-copy='code-block'] code" || selector === "main [class*='InlineCodePane-'] > code") return options.codeNodes || [];
      if (selector === "main button, button[aria-label='Bỏ qua'], button[aria-label='Skip']") return options.chatGPTButtons || [];
      if (selector.includes("[role='status']") || selector.includes("[aria-live]") || selector.includes("[data-testid*='progress']") || selector.includes("[data-testid*='search']")) return options.processingStatuses || [];
      if (selector.startsWith("button[") && options.clock?.generating) return [composer()];
      return selector.includes("data-composer-markdown") ? [input] : [];
    }
  };
  const context = vm.createContext({
    location: { hostname: "chatgpt.com" },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    setTimeout(callback, ms) {
      if (options.clock) {
        options.clock.time += ms;
        options.onTick?.(options.clock);
        queueMicrotask(callback);
      } else callback();
      return 0;
    },
    clearTimeout() {},
    ...(options.clock ? { Date: class extends Date { static now() { return options.clock.time; } } } : {})
  });
  vm.runInContext(source, context, { filename: "content.js" });
  return { api: context.__chatgptComposerTest, selectorQueries };
}

function composer() {
  return {
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{}]
  };
}

test("ChatGPT Search controls count as active generation until the search finishes", () => {
  const skip = {
    innerText: "Bỏ qua",
    getAttribute: () => null,
    getClientRects: () => [{}]
  };
  const status = {
    textContent: "Đang tìm kiếm trên web",
    getClientRects: () => [{}]
  };
  const options = { chatGPTButtons: [skip], processingStatuses: [] };
  const { api } = loadChatGPTContent(composer(), null, options);

  assert.equal(api.isGenerating(), true, "the Skip button means ChatGPT is still processing its web search");
  options.chatGPTButtons = [];
  options.processingStatuses = [status];
  assert.equal(api.isGenerating(), true, "a live web-search status also means the turn is still active");
  options.processingStatuses = [];
  assert.equal(api.isGenerating(), false, "once active controls/status disappear, the turn can be treated as complete");
});

test("ChatGPT article jobs find the current contenteditable composer without querying the plus button", async () => {
  const input = composer();
  const { api, selectorQueries } = loadChatGPTContent(input);

  assert.equal(api.provider, "chatgpt");
  assert.equal(await api.prepareArticleInput({ sourceType: "facility" }), input);
  assert.ok(api.inputSelectors().includes("main [data-composer-markdown][contenteditable='true'][role='textbox']"));
  assert.equal(selectorQueries.some((selector) => selector.includes("composer-plus-btn")), false);
});

test("all ChatGPT job types use the same direct-composer path", async () => {
  for (const sourceType of ["facility", "toplist", "translation", "ai-image"]) {
    const input = composer();
    const { api, selectorQueries } = loadChatGPTContent(input);

    assert.equal(await api.prepareArticleInput({ sourceType }), input, `${sourceType} should use the live composer`);
    assert.equal(selectorQueries.some((selector) => selector.includes("composer-plus-btn")), false);
  }
});

test("ChatGPT prompt verification requires the whole prompt but tolerates editor whitespace", () => {
  const editor = { innerText: "Hãy viết bài giới thiệu\n\nTrả về JSON hợp lệ." };
  const { api } = loadChatGPTContent(composer());

  assert.equal(api.inputContainsPrompt(editor, "Hãy viết bài giới thiệu Trả về JSON hợp lệ."), true);
  assert.equal(api.inputContainsPrompt(editor, "Hãy viết bài khác"), false);
  assert.equal(api.inputContainsPrompt(editor, ""), false);
});

test("large ChatGPT drafts are verified without reading layout-heavy innerText", () => {
  const prompt = "Mở đầu ".repeat(80) + "https://example.com/path" + " nội dung y tế ".repeat(800) + " KẾT THÚC";
  const editor = (text) => ({
    childNodes: [{ tagName: "P", childNodes: [{ textContent: text }] }],
    get innerText() { throw new Error("innerText must not be read for large drafts"); }
  });
  const { api } = loadChatGPTContent(composer());

  assert.equal(api.inputContainsPrompt(editor(prompt), prompt), true);
  assert.equal(api.inputContainsPrompt(editor(prompt.replace("https://example.com/path", " https://example.com/path ")), prompt), true);
  assert.equal(api.inputContainsPrompt(editor(prompt.slice(0, -500)), prompt), false);
  assert.equal(api.inputContainsPrompt(editor("Sai bài ".repeat(2500)), prompt), false);
});

test("ChatGPT prompt verification waits for the complete draft", async () => {
  let reads = 0;
  const prompt = "Nội dung đầy đủ";
  const editor = { get innerText() { reads += 1; return reads < 3 ? "Nội dung" : prompt; } };
  const { api } = loadChatGPTContent(composer());

  assert.equal(await api.waitForPromptInComposer(editor, prompt, 5000), true);
  assert.ok(reads >= 3);
});

test("ChatGPT send targets the Gửi button in the live composer footer once", () => {
  let clicks = 0;
  const send = {
    disabled: false,
    tagName: "BUTTON",
    getClientRects: () => [{}],
    getAttribute: (name) => name === "aria-label" ? "Gửi" : null,
    click() { clicks += 1; }
  };
  const footer = { querySelectorAll: () => [send] };
  const input = {
    closest: (selector) => selector.includes("data-composer-footer-responsive") ? footer : null
  };
  const { api } = loadChatGPTContent(input);

  assert.equal(api.clickSend(input), true);
  assert.equal(clicks, 1);
});

test("ChatGPT virtualized conversation JSON is recovered from its direct code block", () => {
  const data = { type: "facility", source_id: 74, translated: { name: "Worldwide Dental Hospital" } };
  const pre = {
    textContent: JSON.stringify(data),
    getClientRects: () => [{}],
    getAttribute: () => null,
    closest: () => null,
    matches: (selector) => selector.split(", ").includes("pre"),
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const { api } = loadChatGPTContent(composer(), pre);
  const expectedId = { sourceType: "translation", type: "facility", source_id: 74 };
  const response = api.latestAssistantResponse(expectedId);
  const parsed = api.parseAssistantResponse(response, expectedId);

  assert.equal(response.node, pre);
  assert.equal(parsed.idMatched, true);
  assert.equal(parsed.data.source_id, 74);
  assert.equal(api.responseHasJsonCodeBlock(response, expectedId), true);
});

function offscreenReply(messageId, data) {
  const code = {
    textContent: JSON.stringify(data),
    getClientRects: () => [{ top: 5000, bottom: 5500 }],
    getAttribute: () => null,
    matches: (selector) => selector.split(", ").includes("code"),
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView() { throw new Error("Must not scroll to read JSON"); },
    get innerText() { throw new Error("Must read offscreen text without layout"); }
  };
  const owner = { getAttribute: (name) => name === "data-chatgpt-selection-message-id" ? messageId : null };
  const reply = {
    getClientRects: () => [{ top: 5000, bottom: 5500 }],
    getAttribute: () => null,
    matches: () => false,
    closest: (selector) => selector.includes("data-chatgpt-selection-message-id") ? owner : null,
    querySelector: () => null,
    querySelectorAll: (selector) => selector.includes("code") ? [code] : [],
    contains: (node) => node === code,
    compareDocumentPosition: () => 0,
    scrollIntoView() { throw new Error("Must not scroll to read JSON"); },
    cloneNode() { throw new Error("Must not clone the complete response"); },
    get innerText() { throw new Error("Must not force layout of the response"); }
  };
  code.closest = reply.closest;
  return { code, reply };
}

test("ChatGPT reads offscreen div > code JSON before scrolling creates pre", () => {
  const data = { type: "facility", source_id: 80, translated: { name: "Nha Khoa Paris", reviews_json: [{ text: "Review" }] } };
  const { code, reply } = offscreenReply("message-80", data);
  const { api } = loadChatGPTContent(composer(), null, { responses: [reply], codeNodes: [code] });
  const expected = { sourceType: "translation", type: "facility", source_id: 80 };
  const snapshot = api.latestAssistantResponse(expected);

  assert.equal(snapshot.node, reply);
  assert.equal(snapshot.count, 1, "code is not counted again as a separate reply");
  assert.equal(snapshot.id, "message-80");
  assert.equal(JSON.stringify(api.parseAssistantResponse(snapshot, expected).data), JSON.stringify(data));
  assert.equal(api.responseHasJsonCodeBlock(snapshot, expected), true, "must not ask for a redundant code block");
});

test("ChatGPT recognizes an uncovered offscreen code block alongside older semantic turns", () => {
  const old = offscreenReply("message-79", { type: "facility", source_id: 79, translated: {} });
  const newest = offscreenReply("message-80", { type: "facility", source_id: 80, translated: { content: "Complete translation" } });
  old.reply.compareDocumentPosition = () => 4;
  newest.code.compareDocumentPosition = () => 2;
  const { api } = loadChatGPTContent(composer(), null, { responses: [old.reply], codeNodes: [newest.code] });
  const expected = { sourceType: "translation", type: "facility", source_id: 80 };
  const snapshot = api.latestAssistantResponse(expected);

  assert.equal(snapshot.node, newest.code);
  assert.equal(snapshot.id, "message-80");
  assert.equal(api.parseAssistantResponse(snapshot, expected).idMatched, true);
  assert.equal(api.responseHasJsonCodeBlock(snapshot, expected), true);
});

test("ChatGPT watcher finishes the correct offscreen translation after generation without scrolling", async () => {
  const old = offscreenReply("old", { type: "facility", source_id: 79, translated: { name: "Previous" } });
  const data = { type: "facility", source_id: 80, translated: { content: "<p>Complete translation</p>" } };
  const newest = offscreenReply("new", data);
  const options = {
    responses: [old.reply],
    clock: { time: 0, generating: true },
    onTick(clock) {
      if (clock.time >= 1600) options.responses = [newest.reply];
      clock.generating = clock.time < 3200;
    }
  };
  const { api } = loadChatGPTContent(composer(), null, options);
  const expected = { sourceType: "translation", type: "facility", source_id: 80 };
  const result = await api.waitForResponse(api.latestAssistantResponse(expected), "translation-facility-80", 10000, expected);

  assert.equal(JSON.stringify(result.data), JSON.stringify(data));
  assert.ok(options.clock.time >= 6400, "waits for completed, stable JSON");
});
