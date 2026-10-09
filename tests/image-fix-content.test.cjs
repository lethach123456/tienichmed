const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const revision = "a".repeat(64);
const item = {
  id: "tab-505:facility-image-fix-71", sourceType: "facility_image_fix", facility_id: 71,
  name: "Phòng khám đúng chi nhánh", images_revision: revision,
  prompt: "Điều tra ảnh bằng công cụ web/xem ảnh.\nGiữ nguyên mọi query string.\nChỉ trả một block JSON.\n"
};
const result = {
  id: 71, images_revision: revision,
  inspected_images: [
    { url: "/uploads/library/clinic/cover.jpg", decision: "keep", reason: "Đúng chi nhánh", evidence_url: "https://clinic.example/contact", http_status: 200 },
    { url: "https://clinic.example/blocked.jpg", decision: "uncertain", reason: "Bị chặn", evidence_url: "", http_status: 403 }
  ],
  added_images: [{ url: "https://lh3.googleusercontent.com/p/real-photo=s1600?authuser=0&hl=vi", angle: "Mặt tiền", caption: null,
    source: "Google Maps", source_url: "https://maps.google.com/?cid=123" }],
  image_url: "/uploads/library/clinic/cover.jpg", ai_image_url: "", insufficient_images: false, notes: null,
  future_field: { values: [null, 0, false, ""], nested: { status: null } }
};
const fenced = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function loadContent(hostname = "grok.com", overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__imageFixContentTests = { expectedArticleId, promptForProvider, jsonMatchesExpectedId,
      parseAssistantResponse, responseHasJsonCodeBlock, jsonFormatRetryPrompt, expectedJsonKey,
      latestAssistantResponse, waitForResponse, isGenerating, isAiImageArticle, executeArticle, responseSignatureHash,
      imageFixReplacementSummary, imageFixReplacementPrompt,
      setRunHandlers(textHandler, imageHandler) { runArticle = textHandler; runImageArticle = imageHandler; },
      setResponseHandlers(snapshot, retry) {
        latestAssistantResponse = snapshot;
        latestAssistantResponseIdentity = snapshot;
        requestJsonFormatRetry = retry;
      }
    };
  }`);
  const context = vm.createContext({
    location: { hostname, pathname: "/" },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    URL, setTimeout, clearTimeout, ...overrides
  });
  vm.runInContext(source, context, { filename: "content.js" });
  return context.__imageFixContentTests;
}

test("image-fix identity is distinct and old facility, AI-image, doctor, toplist and translation identities are unchanged", () => {
  const api = loadContent();
  assert.deepEqual(plain(api.expectedArticleId(item)), { sourceType: "facility_image_fix", id: 71, images_revision: revision });
  assert.equal(api.expectedArticleId({ sourceType: "facility", facility_id: 71 }), 71);
  assert.equal(api.expectedArticleId({ sourceType: "ai-image", facility_id: 71 }), 71);
  assert.deepEqual(plain(api.expectedArticleId({ sourceType: "doctor", doctor_id: 12, name: "BS. An" })),
    { sourceType: "doctor", id: 12, name: "BS. An" });
  assert.deepEqual(plain(api.expectedArticleId({ sourceType: "toplist", toplist_id: 9, entity_type: "doctor" })),
    { sourceType: "toplist", id: 9, entity_type: "doctor" });
  assert.deepEqual(plain(api.expectedArticleId({ sourceType: "translation", type: "doctor", source_id: 12 })),
    { sourceType: "translation", type: "doctor", source_id: 12 });
  assert.equal(api.jsonMatchesExpectedId([{ id: "71" }], 71), true);
  assert.equal(api.jsonMatchesExpectedId({ items: [{ id: 71 }] }, 71), true);
  assert.equal(api.jsonMatchesExpectedId({ type: "doctor", source_id: "12", translated: {} },
    api.expectedArticleId({ sourceType: "translation", type: "doctor", source_id: 12 })), true);
});

test("image-fix uses the fresh item prompt verbatim on Gemini, ChatGPT, Grok and Claude", () => {
  for (const hostname of ["gemini.google.com", "chatgpt.com", "grok.com", "claude.ai"]) {
    for (const pathname of ["/", "/spark/chat/current"]) {
      const api = loadContent(hostname, { location: { hostname, pathname } });
      const output = api.promptForProvider("Unrelated article/image-generation prompt", {
        ...item, writer_claim_token: "PRIVATE-TOKEN", apiKey: "PRIVATE-KEY", writer_claim: { token: "PRIVATE-NESTED" }
      });
      assert.equal(output, item.prompt);
      assert.doesNotMatch(output, /PRIVATE-TOKEN|PRIVATE-KEY|PRIVATE-NESTED|QUY ĐỊNH ĐỊNH DẠNG BẮT BUỘC|Unrelated/);
      assert.equal(api.promptForProvider(item.prompt, { ...item, prompt: undefined }), item.prompt);
    }
  }
});

test("old prompt contracts are unchanged while image-fix stays separate", () => {
  const api = loadContent();
  assert.equal(api.promptForProvider("doctor prompt\n", { sourceType: "doctor" }), "doctor prompt\n");
  assert.equal(api.promptForProvider("translation prompt\n", { sourceType: "translation" }), "translation prompt\n");
  assert.match(api.promptForProvider("facility prompt", { sourceType: "facility" }), /QUY ĐỊNH ĐỊNH DẠNG BẮT BUỘC/);
  assert.match(api.promptForProvider("toplist prompt", { sourceType: "toplist" }), /QUY ĐỊNH ĐỊNH DẠNG BẮT BUỘC/);
  assert.equal(loadContent("chatgpt.com").promptForProvider("facility prompt", { sourceType: "facility" }), "facility prompt");
});

test("image-fix executes text research and never enters the AI-image generation branch", async () => {
  for (const hostname of ["gemini.google.com", "chatgpt.com", "grok.com", "claude.ai"]) {
    const api = loadContent(hostname);
    const calls = [];
    api.setRunHandlers(async (article, prompt) => { calls.push({ article, prompt }); return { ok: true }; },
      () => { throw new Error("Image-fix must not generate AI images"); });
    assert.equal(api.isAiImageArticle(item), false);
    assert.equal(api.isAiImageArticle({ sourceType: "ai-image" }), true);
    assert.equal(api.isAiImageArticle({ sourceType: "ai_image" }), true);
    assert.equal(api.isAiImageArticle({ sourceType: "image" }), true);
    assert.deepEqual(plain(await api.executeArticle(item, item.prompt)), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prompt, item.prompt);
  }
});

test("image-fix requires one root object with positive numeric ID and exact source revision", () => {
  const api = loadContent();
  const expected = api.expectedArticleId(item);
  assert.equal(api.jsonMatchesExpectedId(result, expected), true);
  for (const candidate of [
    { ...result, id: "71" }, { ...result, id: 71.5 }, { ...result, id: 0 }, { ...result, id: -71 },
    { ...result, id: 72 }, { ...result, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...result, images_revision: "b".repeat(64) }, { ...result, images_revision: revision + " " },
    { ...result, images_revision: revision.toUpperCase() }, { ...result, images_revision: null },
    { ...result, images_revision: undefined }, [result], { items: [result] }, { result }
  ]) assert.equal(api.jsonMatchesExpectedId(candidate, expected), false);
  for (const invalidExpected of [
    { ...expected, id: "71" }, { ...expected, id: 0 }, { ...expected, id: 71.5 },
    { ...expected, images_revision: undefined }, { ...expected, images_revision: null }, { ...expected, images_revision: "" }
  ]) assert.equal(api.jsonMatchesExpectedId(result, invalidExpected), false);
});

test("image-fix preserves the complete object, query strings, arrays, nulls and future fields", () => {
  for (const hostname of ["gemini.google.com", "chatgpt.com", "grok.com", "claude.ai"]) {
    const api = loadContent(hostname);
    const parsed = api.parseAssistantResponse({ sources: [fenced(result)] }, api.expectedArticleId(item));
    assert.equal(parsed.idMatched, true);
    assert.deepEqual(plain(parsed.data), result);
    assert.equal(api.responseHasJsonCodeBlock({ sources: [fenced(result)] }, api.expectedArticleId(item)), true);
    const insufficient = { ...result, added_images: [], insufficient_images: true, image_url: "", notes: null };
    assert.deepEqual(plain(api.parseAssistantResponse({ sources: [fenced(insufficient)] }, api.expectedArticleId(item)).data), insufficient);
  }
});

test("image-fix refuses unfenced JSON, multiple blocks, split objects, arrays and envelopes", () => {
  const api = loadContent();
  const expected = api.expectedArticleId(item);
  const malformed = [
    JSON.stringify(result), `${fenced(result)}\n${fenced(result)}`, `${fenced(result)}\n${fenced({ id: 72 })}`,
    fenced([result]), fenced({ items: [result] }), fenced({ result }),
    `\`\`\`json\n${JSON.stringify(result)}\n${JSON.stringify(result)}\n\`\`\``,
    "```json\n{\"id\":71,\n```", "```javascript\n" + JSON.stringify(result) + "\n```"
  ];
  for (const text of malformed) {
    assert.equal(Boolean(api.parseAssistantResponse({ sources: [text] }, expected)?.idMatched), false);
    assert.equal(api.responseHasJsonCodeBlock({ sources: [text] }, expected), false);
  }
  assert.equal(api.parseAssistantResponse({ sources: [fenced(result), fenced(result)] }, expected).idMatched, true,
    "two representations of one reply are not two blocks");
  assert.equal(Boolean(api.parseAssistantResponse({ sources: [fenced(result), `${fenced(result)}\n${fenced(result)}`] }, expected)?.idMatched), false);
});

test("revision is part of the generic response cache identity and stale same-ID answers remain unmatched", () => {
  const api = loadContent();
  const expected = api.expectedArticleId(item);
  const changed = { ...expected, images_revision: "b".repeat(64) };
  assert.notEqual(api.expectedJsonKey(expected), api.expectedJsonKey(changed));
  const snapshot = { sources: [fenced(result)] };
  assert.equal(api.parseAssistantResponse(snapshot, expected).idMatched, true);
  assert.equal(api.parseAssistantResponse(snapshot, changed).idMatched, false);
  assert.equal(api.responseHasJsonCodeBlock(snapshot, changed), false);
  assert.equal(api.parseAssistantResponse(snapshot, expected).idMatched, true);
});

test("format retry requests only one complete JSON block with the same ID/revision and no secret metadata", () => {
  const api = loadContent();
  const prompt = api.jsonFormatRetryPrompt({ ...api.expectedArticleId(item), writer_claim_token: "PRIVATE-TOKEN", apiKey: "PRIVATE-KEY" });
  assert.match(prompt, /ID 71/);
  assert.ok(prompt.includes(JSON.stringify(revision)));
  assert.match(prompt, /số nguyên JSON dương/);
  assert.match(prompt, /đúng một khối Markdown/);
  assert.match(prompt, /không thay revision/);
  assert.match(prompt, /không tạo ảnh AI/);
  assert.doesNotMatch(prompt, /PRIVATE-TOKEN|PRIVATE-KEY|\[object Object\]/);
});

test("offscreen ChatGPT JSON uses textContent without layout, scrolling or composer changes", () => {
  const api = loadContent("chatgpt.com", {
    document: { querySelector() { throw new Error("Must not touch composer"); }, querySelectorAll: () => [] }
  });
  const code = { textContent: JSON.stringify(result), querySelector: () => null,
    get innerText() { throw new Error("Must not read layout text"); }, scrollIntoView() { throw new Error("Must not scroll"); } };
  const pre = { textContent: "JSON header", querySelector: () => code, contains: (element) => element === code };
  for (const blocks of [[code], [pre, code]]) {
    const node = { querySelectorAll: () => blocks,
      get innerText() { throw new Error("Must not force layout"); }, scrollIntoView() { throw new Error("Must not scroll"); } };
    const parsed = api.parseAssistantResponse({ node, sources: ["clipped preview"] }, api.expectedArticleId(item));
    assert.equal(parsed.idMatched, true);
    assert.deepEqual(plain(parsed.data), result);
    assert.equal(api.responseHasJsonCodeBlock({ node, sources: [] }, api.expectedArticleId(item)), true);
  }
});

test("multiple rendered JSON blocks cannot be selected as one matching image-fix result", () => {
  for (const hostname of ["chatgpt.com", "gemini.google.com", "grok.com", "claude.ai"]) {
    const api = loadContent(hostname);
    const blocks = [result, { ...result, id: 72 }].map((value) => ({ textContent: JSON.stringify(value), querySelector: () => null }));
    const snapshot = { node: { querySelectorAll: () => blocks }, sources: [fenced(result)] };
    assert.equal(api.parseAssistantResponse(snapshot, api.expectedArticleId(item)), null);
    assert.equal(api.responseHasJsonCodeBlock(snapshot, api.expectedArticleId(item)), false);
  }
});

function watcher(hostname, afterRetry) {
  const state = { time: 0, generating: true, retries: 0, reply: fenced(result), id: "image-fix-reply" };
  const api = loadContent(hostname, {
    location: { hostname, pathname: hostname === "gemini.google.com" ? "/spark/chat/current" : "/" },
    Date: class extends Date { static now() { return state.time; } },
    setTimeout(callback, ms) {
      state.time += ms;
      state.generating = state.time < 6400;
      queueMicrotask(callback); return state.time;
    }
  });
  const node = {};
  api.setResponseHandlers(() => ({ node, id: state.id, count: 1, sources: [state.reply], signature: state.reply }),
    async (_articleId, expected, _runToken, baseline) => {
      state.retries += 1;
      assert.deepEqual(plain(expected), plain(api.expectedArticleId(item)));
      state.id += "-retry";
      state.reply = afterRetry;
      return { id: baseline.id, count: baseline.count, signatureHash: "old" };
    });
  return { api, state };
}

test("response watcher waits for stable matching fenced JSON and provider completion", async () => {
  for (const hostname of ["grok.com", "chatgpt.com"]) {
    const { api, state } = watcher(hostname, fenced(result));
    // Use the actual provider completion signal while leaving answer extraction independent of layout.
    const stop = { getClientRects: () => [{}] };
    const other = loadContent(hostname, {
      Date: class extends Date { static now() { return state.time; } },
      getComputedStyle: () => ({ visibility: "visible" }),
      document: { querySelector: () => null, querySelectorAll: (selector) => selector.includes("button[") && state.generating ? [stop] : [] },
      setTimeout(callback, ms) { state.time += ms; state.generating = state.time < 6400; queueMicrotask(callback); return state.time; }
    });
    other.setResponseHandlers(() => ({ node: {}, id: state.id, count: 1, sources: [state.reply], signature: state.reply }),
      () => { throw new Error("Valid block must not trigger a follow-up"); });
    const parsed = await other.waitForResponse({ node: null, sources: [], signature: "" }, item.id, 12000, api.expectedArticleId(item));
    assert.deepEqual(plain(parsed.data), result);
    assert.ok(state.time >= 6400);
    assert.equal(state.retries, 0);
  }
});

test("malformed image-fix output gets one formatting follow-up, including Gemini Spark", async () => {
  for (const hostname of ["gemini.google.com", "chatgpt.com", "grok.com", "claude.ai"]) {
    const { api, state } = watcher(hostname, fenced(result));
    state.reply = JSON.stringify(result);
    const parsed = await api.waitForResponse({ node: null, sources: [], signature: "" }, item.id, 30000, api.expectedArticleId(item));
    assert.equal(parsed.idMatched, true);
    assert.deepEqual(plain(parsed.data), result);
    assert.equal(state.retries, 1);
  }
});

test("Grok accepts the formatting retry when its response ID and count are reused", async () => {
  const state = { time: 0, retries: 0, reply: JSON.stringify(result) };
  const api = loadContent("grok.com", {
    Date: class extends Date { static now() { return state.time; } },
    setTimeout(callback, ms) {
      state.time += ms;
      queueMicrotask(callback);
      return state.time;
    }
  });
  const node = {};
  const snapshot = () => ({ node, id: "same-grok-response", count: 1, sources: [state.reply], signature: state.reply });
  api.setResponseHandlers(snapshot, async (_articleId, expected, _runToken, baseline) => {
    assert.deepEqual(plain(expected), plain(api.expectedArticleId(item)));
    assert.equal(baseline.id, "same-grok-response");
    assert.equal(baseline.count, 1);
    state.retries += 1;
    state.reply = fenced(result);
    return { id: baseline.id, count: baseline.count, signatureHash: api.responseSignatureHash(baseline.signature) };
  });

  const parsed = await api.waitForResponse({ node: null, id: "", count: 0, sources: [], signature: "" },
    item.id, 30000, api.expectedArticleId(item));
  assert.equal(parsed.idMatched, true);
  assert.deepEqual(plain(parsed.data), result);
  assert.equal(state.retries, 1);
});

function missingReplacementFixture() {
  const source = { ...item, facility_id: 91, name: "Metal Dental", images: Array.from({ length: 7 }, (_, i) => ({ url: `https://clinic.example/source-${i}.jpg` })) };
  const output = { ...result, id: 91, added_images: [], insufficient_images: true,
    inspected_images: source.images.map(({ url }, i) => ({ url, decision: i < 5 ? "uncertain" : "remove",
      reason: i < 5 ? "Chưa xem được ảnh" : "Thumbnail phỏng vấn đã xác minh", evidence_url: i < 5 ? "" : "https://clinic.example/video", http_status: null })) };
  return { source, output };
}

test("replacement minimum excludes uncertain, AI and duplicate added URLs", () => {
  const api = loadContent();
  const { source, output } = missingReplacementFixture();
  assert.deepEqual(plain(api.imageFixReplacementSummary(source, output)), { removed: 2, kept: 0, added: 0, verified: 0, minimum: 5 });
  source.ai_image_url = source.images[0].url;
  output.inspected_images[0].decision = "keep";
  output.inspected_images[1].decision = "keep";
  output.inspected_images[1].reason = "Đã xem và đối chiếu đúng chi nhánh";
  output.inspected_images[1].evidence_url = "https://clinic.example/about";
  const newImage = { url: "https://clinic.example/new.jpg", source: "Website", source_url: "https://clinic.example/about" };
  output.added_images = [newImage, { ...newImage }, { ...newImage, url: source.images[1].url }];
  assert.deepEqual(plain(api.imageFixReplacementSummary(source, output)), { removed: 2, kept: 1, added: 1, verified: 2, minimum: 5 });
  const prompt = api.imageFixReplacementPrompt({ ...source, writer_claim_token: "PRIVATE-TOKEN", apiKey: "PRIVATE-KEY" }, output,
    api.imageFixReplacementSummary(source, output));
  assert.match(prompt, /bổ sung ít nhất 3/);
  assert.match(prompt, /uncertain.*KHÔNG tính/);
  assert.match(prompt, /TOÀN BỘ JSON/);
  assert.doesNotMatch(prompt, /PRIVATE-TOKEN|PRIVATE-KEY/);
});

test("replacement counting tolerates malformed entries and does not count private or non-image URLs", () => {
  const api = loadContent();
  const { source, output } = missingReplacementFixture();
  output.inspected_images.push(null);
  output.added_images = [null, { url: "http://127.0.0.1/private.jpg", source: "Website", source_url: "https://clinic.example/about" },
    { url: "https://clinic.example/not-an-image.html", source: "Website", source_url: "https://clinic.example/about" },
    { url: "https://clinic.example/photo.jpg", source: "Website", source_url: "not-a-url" },
    { url: "https://clinic.example/photo.jpg?token=private", source: "Website", source_url: "https://clinic.example/about" }];
  assert.equal(api.imageFixReplacementSummary(source, output).verified, 0);
});

test("blocked or unviewable keep labels cannot satisfy the replacement minimum", () => {
  const api = loadContent();
  const { source, output } = missingReplacementFixture();
  for (const bad of [
    { http_status: 403, reason: "Đúng chi nhánh" },
    { http_status: 404, reason: "Đúng chi nhánh" },
    { http_status: null, reason: "timeout - not viewable" },
    { http_status: 200, reason: "Công cụ không xem được ảnh" },
    { http_status: null, reason: "Chưa xác minh được ảnh" },
    { http_status: 200, reason: "" }
  ]) {
    for (const review of output.inspected_images.slice(0, 5)) Object.assign(review, bad, { decision: "keep" });
    assert.equal(api.imageFixReplacementSummary(source, output).verified, 0);
  }
  for (const review of output.inspected_images.slice(0, 5)) Object.assign(review, {
    decision: "keep", reason: "Đã xem và đối chiếu đúng chi nhánh", evidence_url: "https://clinic.example/about", http_status: null
  });
  assert.equal(api.imageFixReplacementSummary(source, output).verified, 5);
});

test("replacement research starts only after provider completion and returns the full improved JSON", async () => {
  for (const hostname of ["grok.com", "chatgpt.com", "gemini.google.com"]) {
    const { source, output } = missingReplacementFixture();
    const improved = { ...output, insufficient_images: false, added_images: Array.from({ length: 5 }, (_, i) => ({
      url: `https://clinic.example/new-${i}.jpg`, source: "Website", source_url: "https://clinic.example/about"
    })) };
    const state = { time: 0, active: true, retries: 0, reply: fenced(output), id: "original" };
    const stop = { getClientRects: () => [{}], getAttribute: () => null };
    const session = new Map();
    const api = loadContent(hostname, {
      location: { hostname, pathname: "/" },
      sessionStorage: { getItem: (key) => session.get(key) ?? null, setItem: (key, value) => session.set(key, value), removeItem: (key) => session.delete(key) },
      getComputedStyle: () => ({ visibility: "visible" }),
      document: { querySelector: () => null, querySelectorAll: (selector) => selector.includes("button[data-testid*='stop']") && state.active ? [stop] : [] },
      Date: class extends Date { static now() { return state.time; } },
      setTimeout(callback, ms) { state.time += ms; state.active = state.time < 6400; queueMicrotask(callback); return state.time; },
      chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) } }
    });
    api.setResponseHandlers(() => ({ node: {}, id: state.id, count: 1, sources: [state.reply], signature: state.reply }),
      async (_articleId, expected, _runToken, baseline, followup) => {
        assert.equal(state.active, false, "never ask for replacement images while AI is still generating");
        assert.ok(state.time >= 6400);
        assert.match(followup, /bổ sung ít nhất 5/);
        assert.ok(followup.includes(JSON.stringify(revision)));
        state.retries += 1; state.id = "improved"; state.reply = fenced(improved);
        return { id: baseline.id, count: baseline.count, signatureHash: api.responseSignatureHash(baseline.signature) };
      });
    const parsed = await api.waitForResponse({ node: null, signature: "" }, source.id, 30000, api.expectedArticleId(source),
      { imageFixArticle: source, runToken: "replacement-run" });
    assert.deepEqual(plain(parsed.data), improved);
    assert.equal(state.retries, 1);
    assert.ok([...session.values()].includes("sent"), "remember replacement request across page reloads");
  }
});

test("one insufficient replacement follow-up returns intact JSON for the background no-POST guard", async () => {
  const { source, output } = missingReplacementFixture();
  const { api, state } = watcher("grok.com", fenced(output));
  state.reply = fenced(output);
  const parsed = await api.waitForResponse({ node: null, signature: "" }, source.id, 30000, api.expectedArticleId(source), { imageFixArticle: source });
  assert.equal(state.retries, 1);
  assert.deepEqual(plain(parsed.data), output);
});

test("recovery does not send another replacement request already persisted for the same run", async () => {
  const { source, output } = missingReplacementFixture();
  let time = 0;
  const api = loadContent("grok.com", {
    sessionStorage: { getItem: (key) => key.startsWith("medreview-image-replacement-retry:") ? "sent" : null, removeItem() {} },
    Date: class extends Date { static now() { return time; } },
    setTimeout(callback, ms) { time += ms; queueMicrotask(callback); return time; }
  });
  api.setResponseHandlers(() => ({ node: {}, id: "done", count: 1, sources: [fenced(output)], signature: fenced(output) }),
    () => { throw new Error("must not send a duplicate replacement follow-up"); });
  const parsed = await api.waitForResponse({ node: null, signature: "" }, source.id, 30000, api.expectedArticleId(source),
    { imageFixArticle: source, runToken: "same-run", acceptCurrent: true });
  assert.deepEqual(plain(parsed.data), output);
});

test("ChatGPT waits for web-search activity to finish before requesting JSON formatting", async () => {
  const state = { time: 0, searching: true, retries: 0, id: "image-fix-reply", reply: JSON.stringify(result) };
  const skipButton = { innerText: "Bỏ qua", textContent: "Bỏ qua", getAttribute: () => null, getClientRects: () => [{}] };
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "main button, button[aria-label='Bỏ qua'], button[aria-label='Skip']") {
        return state.searching ? [skipButton] : [];
      }
      return [];
    }
  };
  const api = loadContent("chatgpt.com", {
    document,
    Date: class extends Date { static now() { return state.time; } },
    setTimeout(callback, ms) {
      state.time += ms;
      if (state.time >= 16000) state.searching = false;
      queueMicrotask(callback);
      return state.time;
    },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) } }
  });
  const responseNode = {};
  const snapshot = () => ({
    node: responseNode,
    id: state.id,
    count: 1,
    sources: [state.reply],
    signature: state.reply
  });
  api.setResponseHandlers(snapshot, async (_articleId, _expected, _runToken, beforeRetry) => {
    assert.equal(state.searching, false, "must not send a follow-up while ChatGPT still shows its web-search Skip button");
    assert.ok(state.time >= 16000, "wait until the web-search control disappears before asking for formatting");
    state.retries += 1;
    state.id = "image-fix-reply-after-format";
    state.reply = fenced(result);
    return { id: beforeRetry.id, count: beforeRetry.count, signatureHash: "before-retry" };
  });

  const parsed = await api.waitForResponse({ node: null, id: "", count: 0, sources: [], signature: "" }, item.id, 60000,
    api.expectedArticleId(item));
  assert.equal(parsed.idMatched, true);
  assert.equal(state.retries, 1);
});

test("a second malformed/stale image-fix reply fails without another formatting follow-up", async () => {
  for (const hostname of ["gemini.google.com", "chatgpt.com", "grok.com", "claude.ai"]) {
    const stale = fenced({ ...result, images_revision: "b".repeat(64) });
    const { api, state } = watcher(hostname, stale);
    state.reply = JSON.stringify(result);
    await assert.rejects(api.waitForResponse({ node: null, sources: [], signature: "" }, item.id, 45000, api.expectedArticleId(item)),
      /sau một lần yêu cầu bổ sung/);
    assert.equal(state.retries, 1);
  }
});
