const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the actual content script without starting a browser, sending prompts,
// touching extension storage, or calling the website API.
function loadContentScript(overrides = {}) {
  const script = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
  const instrumented = script.replace(/}\s*$/, `
    globalThis.__jsonResponseTests = {
      extractJson,
      parseAssistantResponse,
      expectedArticleId,
      promptForProvider,
      latestAssistantResponse,
      waitForResponse,
      jsonMatchesExpectedId,
      isAiImageArticle,
      imagePromptFromPlan,
      buildImageGenerationRequest,
      imageLooksLikeGeneratedAsset,
      runImageArticle
    };
  }`);
  const context = vm.createContext({
    location: { hostname: "grok.com" },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    setTimeout,
    clearTimeout,
    ...overrides
  });
  vm.runInContext(instrumented, context, { filename: "content.js" });
  return context.__jsonResponseTests;
}

// JSON round-trip removes VM-specific prototypes before strict comparisons.
const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
let functions;
test.before(() => { functions = loadContentScript(); });

test("accepts a direct JSON object and preserves future API fields", () => {
  const expected = {
    id: 59,
    name: "Dana Dental",
    content: "<p>Thông tin phòng khám</p>",
    reviews: [{ author: "An", rating: 5, content: "Tư vấn rõ ràng" }],
    future_field: { verified: false, values: [null, 0, ""] }
  };
  assert.deepEqual(plain(functions.extractJson(JSON.stringify(expected))), expected);
});

test("accepts arbitrary objects without requiring content, name or id", () => {
  assert.deepEqual(plain(functions.extractJson('{"reviews":[],"new_field":true}')), {
    reviews: [], new_field: true
  });
  assert.deepEqual(plain(functions.extractJson("{}")), {});
});

test("recognizes the separate AI-image job source", () => {
  assert.equal(functions.isAiImageArticle({ sourceType: "ai-image" }), true);
  assert.equal(functions.isAiImageArticle({ sourceType: "facility" }), false);
});

test("translation jobs preserve the API's complete per-record prompt and require a matching envelope", () => {
  const article = {
    sourceType: "translation", type: "facility", source_id: 53,
    translation_fields: ["subtitle_en", "content_en"],
    output_template: { subtitle_en: "", content_en: "" }
  };
  assert.deepEqual(plain(functions.expectedArticleId(article)), {
    sourceType: "translation", type: "facility", source_id: 53
  });
  assert.equal(functions.promptForProvider("API prompt with full Vietnamese row and output envelope", article), "API prompt with full Vietnamese row and output envelope");
  const envelope = {
    type: "facility", source_id: 53,
    translated: { subtitle_en: "Dental clinic", content_en: "<p>English content</p>", seo_title: "Dental clinic in Hanoi" }
  };
  assert.equal(functions.jsonMatchesExpectedId(envelope, functions.expectedArticleId(article)), true);
  assert.equal(functions.jsonMatchesExpectedId({ ...envelope, source_id: 99 }, functions.expectedArticleId(article)), false);
  assert.deepEqual(plain(functions.extractJson(JSON.stringify(envelope), functions.expectedArticleId(article))), envelope,
    "the parser keeps the metadata envelope rather than selecting its nested translated fields");
});

test("uses the server's image_prompt JSON for the second, image-generation request", () => {
  const plan = { id: 51, image_prompt: "Professional 16:9 dental clinic interior, natural light" };
  const prompt = functions.imagePromptFromPlan(plan, { id: "ai-image-51", facility_id: 51 });
  assert.equal(prompt, plan.image_prompt);
  const request = functions.buildImageGenerationRequest(prompt);
  assert.match(request, /Tạo ngay 01 ảnh/i);
  assert.match(request, /Chỉ trả ảnh đã tạo/i);
  assert.match(request, /Professional 16:9 dental clinic interior/);
  assert.throws(() => functions.imagePromptFromPlan({ id: 52, image_prompt: "Sai cơ sở" }, { facility_id: 51 }), /khác ID cơ sở/);
  assert.throws(() => functions.imagePromptFromPlan({ id: 51 }, { facility_id: 51 }), /image_prompt/);
});

test("accepts generated image elements but rejects avatars and user reference images", () => {
  const generated = {
    currentSrc: "https://images.example/generated.png", naturalWidth: 1536, naturalHeight: 1024,
    alt: "Generated dental clinic", className: "generated-image",
    getAttribute: () => null, closest: () => null
  };
  const avatar = {
    currentSrc: "https://images.example/avatar.png", naturalWidth: 512, naturalHeight: 512,
    alt: "Avatar", className: "avatar", getAttribute: () => null, closest: () => null
  };
  const userReference = {
    currentSrc: "https://images.example/reference.jpg", naturalWidth: 1200, naturalHeight: 800,
    alt: "Reference", className: "", getAttribute: () => null,
    closest: (selector) => selector.includes("user-message") ? {} : null
  };
  assert.equal(functions.imageLooksLikeGeneratedAsset(generated), true);
  assert.equal(functions.imageLooksLikeGeneratedAsset(avatar), false);
  assert.equal(functions.imageLooksLikeGeneratedAsset(userReference), false);
});

function imageAssistantNode(id, text, images = []) {
  const node = {
    textContent: text,
    innerText: text,
    getClientRects: () => [{}],
    getAttribute: (name) => name === "data-message-id" ? id : null,
    closest(selector) { return selector.includes("[data-message-id]") ? node : null; },
    querySelector: () => null,
    querySelectorAll: (selector) => selector === "img" ? images : [],
    cloneNode() { return { textContent: node.textContent, querySelectorAll: () => [] }; }
  };
  return node;
}

function imageRunHarness(options = {}) {
  const localImageUrl = "/uploads/library/co-so-y-te-ai/facility-51-nha-khoa/generated-51.png";
  const apiUpdate = options.apiUpdate || {
    ok: true,
    updated_count: 1,
    updated: [{ facility_id: 51, ai_image_url: localImageUrl, storage: "local_library" }]
  };
  const sourceResponse = options.sourceResponse || { ok: true, status: 200, blob: async () => generatedBlob };
  const uploadResponse = options.uploadResponse || { ok: true, status: 200, text: async () => JSON.stringify(apiUpdate) };
  const state = { time: 0, sent: [], nodes: [], fetchCalls: [] };
  const messages = [];
  const generatedBlob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
  const input = {
    value: "", disabled: false,
    get innerText() { return this.value; },
    getClientRects: () => [{}], getAttribute: () => null,
    matches: () => false, focus() {}, dispatchEvent() {},
    closest(selector) {
      return selector.includes("data-composer-footer-responsive") ? composerFooter : null;
    }
  };
  const composerFooter = { querySelectorAll: () => [send] };
  const outputImage = {
    currentSrc: "https://images.example/facility-51.png", naturalWidth: 1536, naturalHeight: 1024,
    alt: "Generated facility image", className: "generated-image",
    getAttribute: () => null, closest: () => null
  };
  const plan = imageAssistantNode("plan-51", `\`\`\`json\n${JSON.stringify({ id: 51, image_prompt: "Clean professional dental clinic, 16:9" })}\n\`\`\``);
  const imageReply = imageAssistantNode("image-51", "Ảnh đã tạo", [outputImage]);
  let sendCount = 0;
  const send = {
    disabled: false, offsetParent: {},
    tagName: "BUTTON",
    getClientRects: () => [{}],
    getAttribute: (name) => name === "aria-label" ? "Gửi" : null,
    click() {
      state.sent.push(input.value);
      input.value = "";
      sendCount += 1;
      state.nodes = sendCount === 1 ? [plan] : [plan, imageReply];
    }
  };
  const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__imageRunTests = { runImageArticle };
  }`);
  const selection = { removeAllRanges() {}, addRange() {} };
  const context = vm.createContext({
    location: { hostname: "chatgpt.com" },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          messages.push(plain(message));
          if (message.type === "prepare-ai-image-upload") {
            return {
              ok: true,
              url: "https://xxhihi.site/api/medical/facility-ai-image-update.php",
              apiKey: "test-medical-key",
              facilityId: 51
            };
          }
          return { ok: true };
        }
      }
    },
    document: {
      body: null,
      querySelector(selector) {
        if (selector.includes("button[data-testid='send-button']")) return send;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "#prompt-textarea") return [input];
        if (selector === "[data-message-author-role='assistant']") return state.nodes;
        return [];
      },
      createRange() { return { selectNodeContents() {} }; },
      execCommand(command, _ui, value) { if (command === "insertText") input.value = value; return true; }
    },
    window: { getSelection: () => selection },
    getComputedStyle: () => ({ visibility: "visible" }),
    Date: class extends Date { static now() { return state.time; } },
    setTimeout(callback, ms) { state.time += ms; queueMicrotask(callback); return state.time; },
    clearTimeout,
    Event: class Event {},
    InputEvent: class InputEvent {},
    KeyboardEvent: class KeyboardEvent {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    Blob,
    FormData,
    fetch: async (url, options = {}) => {
      state.fetchCalls.push({ url, options });
      if (url === outputImage.currentSrc) return sourceResponse;
      if (url === "https://xxhihi.site/api/medical/facility-ai-image-update.php") {
        return uploadResponse;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });
  vm.runInContext(source, context, { filename: "content.js" });
  return {
    runImageArticle: context.__imageRunTests.runImageArticle,
    state, messages, localImageUrl, apiUpdate, generatedBlob, outputImageUrl: outputImage.currentSrc
  };
}

test("AI-image run turns the API planner JSON into a second image-generation request", async () => {
  const harness = imageRunHarness();
  await harness.runImageArticle({ id: "ai-image-51", sourceType: "ai-image", facility_id: 51 }, "API planner prompt");
  assert.deepEqual(harness.state.sent, [
    "API planner prompt",
    "Tạo ngay 01 ảnh bằng công cụ tạo ảnh của bạn theo prompt dưới đây.\nChỉ trả ảnh đã tạo; không trả JSON, markdown, mô tả, link hay giải thích.\nGiữ đúng tỷ lệ, các ràng buộc an toàn và không tự thêm chữ/logo/watermark.\n\nClean professional dental clinic, 16:9"
  ]);
  const completed = harness.messages.find((message) => message.type === "image-complete");
  assert.deepEqual(completed.imageResult, {
    id: 51,
    image_prompt: "Clean professional dental clinic, 16:9",
    ai_image_url: harness.localImageUrl
  });
  assert.equal(completed.imageUploaded, true);
  assert.deepEqual(completed.apiUpdate, harness.apiUpdate);
  assert.equal(harness.state.fetchCalls.length, 2, "the generated file is fetched then uploaded once");
  const [imageFetch, uploadFetch] = harness.state.fetchCalls;
  assert.equal(imageFetch.url, harness.outputImageUrl);
  assert.deepEqual(plain(imageFetch.options), { credentials: "include", cache: "no-store" });
  assert.equal(uploadFetch.options.method, "POST");
  assert.equal(uploadFetch.options.headers["X-Medical-Api-Key"], "test-medical-key");
  assert.equal(uploadFetch.options.headers.Accept, "application/json");
  assert.equal(Object.keys(uploadFetch.options.headers).some((key) => key.toLowerCase() === "content-type"), false,
    "multipart boundary must be supplied by the browser, not content.js");
  assert.equal(uploadFetch.options.body instanceof FormData, true);
  assert.equal(uploadFetch.options.body.get("id"), "51");
  assert.equal(uploadFetch.options.body.get("image") instanceof Blob, true);
  assert.equal(uploadFetch.options.body.get("image").size, harness.generatedBlob.size);
  assert.equal(uploadFetch.options.body.get("ai_image_url"), null);
  assert.equal(JSON.stringify(completed).includes(harness.outputImageUrl), false,
    "the temporary provider URL must never cross the extension message boundary");
  assert.equal(harness.state.time >= 6400, true, "each AI phase must settle before progressing");
});

test("AI-image upload rejects an API response that confirms a different facility", async () => {
  const harness = imageRunHarness({
    apiUpdate: {
      ok: true,
      updated: [{ facility_id: 52, ai_image_url: "/uploads/library/co-so-y-te-ai/facility-52/source.webp", storage: "local_library" }]
    }
  });
  await assert.rejects(
    harness.runImageArticle({ id: "ai-image-51", sourceType: "ai-image", facility_id: 51 }, "API planner prompt"),
    /chưa xác nhận ảnh nội bộ cho cơ sở 51/
  );
  assert.equal(harness.messages.some((message) => message.type === "image-complete"), false,
    "a mismatched API response must not finish the current job");
});

test("AI-image upload reports HTTP status and API error text", async () => {
  const harness = imageRunHarness({
    uploadResponse: {
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ ok: false, message: "Thiếu file image hợp lệ" })
    }
  });
  await assert.rejects(
    harness.runImageArticle({ id: "ai-image-51", sourceType: "ai-image", facility_id: 51 }, "API planner prompt"),
    /HTTP 422: Thiếu file image hợp lệ/
  );
});

test("AI-image download reports provider HTTP status and response detail", async () => {
  const harness = imageRunHarness({
    sourceResponse: {
      ok: false,
      status: 403,
      text: async () => "Signed asset URL has expired"
    }
  });
  await assert.rejects(
    harness.runImageArticle({ id: "ai-image-51", sourceType: "ai-image", facility_id: 51 }, "API planner prompt"),
    /HTTP 403\): Signed asset URL has expired/
  );
});

test("accepts top-level JSON arrays without reducing them to their first object", () => {
  const expected = [{ id: 59, reviews: [] }, { id: 60, future_field: "giữ nguyên" }];
  assert.deepEqual(plain(functions.extractJson(JSON.stringify(expected))), expected);
  assert.deepEqual(plain(functions.extractJson("[]")), []);
});

test("finds a JSON code fence surrounded by explanatory text", () => {
  const text = 'Dữ liệu đã kiểm tra:\n```json\n{"id":59,"reviews":[]}\n```\nĐã hoàn tất.';
  assert.deepEqual(plain(functions.extractJson(text)), { id: 59, reviews: [] });
});

test("isolates fenced JSON even after unmatched delimiters in ordinary prose", () => {
  const text = 'Ghi chú [bản mới\n```json\n{"id":59,"reviews":[]}\n```';
  assert.deepEqual(plain(functions.extractJson(text, 59)), { id: 59, reviews: [] });
});

test("accepts a code block label without markdown fences", () => {
  assert.deepEqual(plain(functions.extractJson('JSON\n{\n"id":59,\n"content":"Đầy đủ"\n}')),
    { id: 59, content: "Đầy đủ" });
});

test("finds direct JSON embedded in an ordinary assistant response", () => {
  const text = 'Đây là dữ liệu cho cơ sở:\n{"id":59,"subtitle":"Nha khoa"}\nNguồn: website chính thức.';
  assert.deepEqual(plain(functions.extractJson(text)), { id: 59, subtitle: "Nha khoa" });
});

test("finds direct JSON after an unmatched prose delimiter", () => {
  const text = 'Ghi chú [bản mới\n{"id":59,"content":"Dữ liệu trực tiếp"}';
  assert.deepEqual(plain(functions.extractJson(text, 59)), { id: 59, content: "Dữ liệu trực tiếp" });
});

test("balances nested arrays and escaped string delimiters correctly", () => {
  const expected = {
    id: 59,
    content: '<p title="{nội dung}">Ký tự ] } [ { và dấu \\</p> ```json',
    reviews: [{ name: 'Người "A"', extra: { text: "{không phải object}" } }]
  };
  assert.deepEqual(plain(functions.extractJson(`Kết quả:\n${JSON.stringify(expected)}\nHết.`)), expected);
});

test("ignores citation metadata outside a complete JSON object", () => {
  const text = ':contentReference[oaicite:0]{index=0}\n{"id":59,"content":"Đầy đủ"}\n'
    + ':contentReference[oaicite:1]{index=1}';
  assert.deepEqual(plain(functions.extractJson(text, 59)), { id: 59, content: "Đầy đủ" });
});

test("prefers a complete candidate matching the facility ID", () => {
  const text = 'Ví dụ: {"id":1,"name":"Mẫu"}\nKết quả: {"id":59,"name":"Dana Dental","reviews":[]}';
  assert.deepEqual(plain(functions.extractJson(text, 59)), { id: 59, name: "Dana Dental", reviews: [] });
});

test("ID ranking does not rewrite the JSON ID or remove fields", () => {
  const expected = { id: "59", metadata: { schema_version: 4 } };
  assert.deepEqual(plain(functions.extractJson(JSON.stringify(expected), 59)), expected);
});

test("prefers fuller JSON over same-ID samples regardless of source order", () => {
  const sample = { id: 59, content: "…", reviews: [] };
  const full = { id: 59, content: "<p>Nội dung giới thiệu cơ sở y tế đầy đủ, đã hoàn thành.</p>", reviews: [{ rating: 5 }] };
  for (const candidates of [[sample, full], [full, sample]]) {
    assert.deepEqual(plain(functions.extractJson(candidates.map(JSON.stringify).join("\n"), 59)), full);
    assert.deepEqual(plain(functions.parseAssistantResponse({ sources: candidates.map(JSON.stringify) }, 59)?.data), full);
  }
});

test("rejects a truncated outer object instead of accepting a nested review", () => {
  const truncated = '{"id":59,"reviews":[{"name":"Khách hàng","content":"Tốt"}],"content":"chưa xong';
  assert.equal(functions.extractJson(truncated), null);
});

test("rejects a truncated outer array instead of returning a nested facility", () => {
  const truncated = '[{"id":59,"content":"Đã viết xong mục đầu"},';
  assert.equal(functions.extractJson(truncated), null);
});

test("rejects nested reviews after a mismatched closer in the outer JSON", () => {
  const malformed = '{"id":59,"bad":],"reviews":[{"name":"An","content":"Tốt"}]}';
  assert.equal(functions.extractJson(malformed, 59), null);
});

test("rejects invalid or non-JSON text without inventing a fallback article", () => {
  for (const input of ["", "Đang nghiên cứu…", "null", "42", '"Đây là chuỗi"', '{"id":59,"reviews":[}']) {
    assert.equal(functions.extractJson(input), null, input);
  }
});

test("reads JSON from an earlier source when the last code block is not JSON", () => {
  const expected = { id: 59, reviews: [{ rating: 5 }], new_field: "còn nguyên" };
  const result = functions.parseAssistantResponse({
    sources: [JSON.stringify(expected), "curl https://example.invalid/medical", "Đã hoàn tất"]
  }, 59);
  assert.deepEqual(plain(result?.data), expected);
  assert.equal(typeof result.rawResponse, "string");
  assert.deepEqual(plain(functions.extractJson(result.rawResponse, 59)), expected);
});

test("tries ordinary message text when code sources contain no valid JSON", () => {
  const result = functions.parseAssistantResponse({
    sources: ["console.log('ví dụ');", 'Thông tin:\n{"id":59,"content":"Nội dung trực tiếp"}\nXong.']
  }, 59);
  assert.deepEqual(plain(result?.data), { id: 59, content: "Nội dung trực tiếp" });
});

test("ranks matching IDs across all response sources", () => {
  const result = functions.parseAssistantResponse({
    sources: ['{"id":1,"name":"Bài trước"}', '{"id":59,"name":"Dana Dental"}', "Nguồn tham khảo"]
  }, 59);
  assert.deepEqual(plain(result?.data), { id: 59, name: "Dana Dental" });
});

test("returns null when every response source is empty, invalid or truncated", () => {
  assert.equal(functions.parseAssistantResponse({ sources: ["", "Không có dữ liệu", '{"id":59,'] }, 59), null);
});

function messageNode(id, text, blocks = [], { user = false, cleanText } = {}) {
  return {
    textContent: text,
    innerText: text,
    getClientRects: () => [{}],
    getAttribute: (name) => name === "data-message-id" ? id : null,
    closest: (selector) => user && selector.includes("user") ? {} : null,
    querySelector: () => null,
    querySelectorAll: () => blocks,
    cloneNode() {
      const clone = {
        textContent: this.textContent,
        querySelectorAll: () => cleanText === undefined ? [] : [
          { remove() { clone.textContent = cleanText; } }
        ]
      };
      return clone;
    }
  };
}

function responseHarness(onTick = () => {}) {
  const state = { time: 0, nodes: [], generating: false };
  const stopButton = { getClientRects: () => [{}] };
  const functions = loadContentScript({
    Date: class extends Date { static now() { return state.time; } },
    getComputedStyle: () => ({ visibility: "visible" }),
    document: {
      querySelector: () => null,
      querySelectorAll: (selector) => selector.includes("button[")
        ? state.generating ? [stopButton] : []
        : state.nodes
    },
    setTimeout(callback, ms) {
      state.time += ms;
      onTick(state);
      queueMicrotask(callback);
      return state.time;
    }
  });
  return { state, functions };
}

test("captures every code block and ordinary text from the latest assistant", () => {
  const { state, functions } = responseHarness();
  const json = '{"id":59,"reviews":[]}';
  const node = messageNode("assistant-2", `JSON\n${json}\nDữ liệu đầy đủ`, [
    { textContent: json, innerText: '{"id":59,' },
    { textContent: "console.log('example')", innerText: "console.log('example')" }
  ]);
  state.nodes = [messageNode("assistant-1", '{"id":1}'), node, messageNode("user-3", '{"id":999}', [], { user: true })];
  const snapshot = functions.latestAssistantResponse();
  assert.equal(snapshot.node, node);
  assert.ok(snapshot.sources.includes(json));
  assert.ok(snapshot.sources.includes("console.log('example')"));
  assert.ok(snapshot.sources.includes(node.textContent));
  assert.deepEqual(plain(functions.parseAssistantResponse(snapshot, 59)?.data), { id: 59, reviews: [] });
});

test("reads complete direct DOM text when innerText is truncated and code is unrelated", () => {
  const { state, functions } = responseHarness();
  const json = '{"id":59,"content":"Đầy đủ từ các span","reviews":[{"rating":5}]}';
  const node = messageNode("new", json, [{ textContent: "curl example.invalid", innerText: "curl example.invalid" }]);
  node.innerText = '{"id":59,"content":"Đầy';
  state.nodes = [node];
  assert.deepEqual(plain(functions.parseAssistantResponse(functions.latestAssistantResponse(), 59)?.data), JSON.parse(json));
});

test("retains clean JSON when outside citation UI is removed from the cloned message", () => {
  const { state, functions } = responseHarness();
  const json = '{"id":59,"content":"Nội dung","reviews":[]}';
  state.nodes = [messageNode("new", `JSON\n${json}\n:contentReference[oaicite:0]{index=0}`, [], { cleanText: json })];
  const snapshot = functions.latestAssistantResponse();
  assert.ok(snapshot.sources.includes(json));
  assert.deepEqual(plain(functions.parseAssistantResponse(snapshot, 59)?.data), JSON.parse(json));
});

test("waits for complete stable JSON and the generation button to disappear", async () => {
  const partial = '{"id":59,"reviews":[{"name":"Khách hàng"}],"content":"chưa';
  const full = { id: 59, content: "Đã viết xong", reviews: [{ name: "Khách hàng" }] };
  const old = messageNode("old", '{"id":58}');
  const reply = messageNode("new", partial);
  const { state, functions } = responseHarness((state) => {
    state.nodes = [old, reply];
    if (state.time >= 2400) reply.innerText = reply.textContent = `\`\`\`json\n${JSON.stringify(full)}\n\`\`\``;
    state.generating = state.time < 6400;
  });
  state.nodes = [old];
  const result = await functions.waitForResponse(functions.latestAssistantResponse(), "facility-59", 10000, 59);
  assert.deepEqual(plain(result.data), full);
  assert.ok(state.time >= 6400, "must not finish while the AI is still generating");
});

test("does not mistake changes to an old assistant reply for a new article", async () => {
  const old = messageNode("old", '{"id":58,"content":"Bài cũ"}');
  const { state, functions } = responseHarness(() => {
    old.innerText = old.textContent = '{"id":58,"content":"Bài cũ"}\nNguồn tham khảo mới hiện ra';
  });
  state.nodes = [old];
  const before = functions.latestAssistantResponse();
  await assert.rejects(functions.waitForResponse(before, "facility-59", 6400, 59));
  assert.ok(state.time >= 6400);
});

test("Grok accepts completed JSON when it fills a response container that already existed", async () => {
  const placeholder = messageNode("same-grok-response", "Worked for 1m 20s");
  const full = { id: 76, name: "Westcoast International Dental Clinic", content: "Đã hoàn tất" };
  const { state, functions } = responseHarness((state) => {
    state.nodes = [placeholder];
    if (state.time >= 1600) placeholder.innerText = placeholder.textContent = `\`\`\`json\n${JSON.stringify(full)}\n\`\`\``;
    state.generating = state.time < 3200;
  });
  state.nodes = [placeholder];
  const before = functions.latestAssistantResponse();
  const result = await functions.waitForResponse(before, "facility-76", 10000, 76);
  assert.deepEqual(plain(result.data), full);
  assert.ok(state.time >= 4800, "must wait until Grok is done and the JSON is stable");
});

test("same-container recovery requires the current facility ID", async () => {
  const old = messageNode("same-grok-response", '{"id":75,"content":"Bài trước"}');
  const { state, functions } = responseHarness(() => {
    old.innerText = old.textContent = '{"id":75,"content":"Bài trước"}\n42 sources';
  });
  state.nodes = [old];
  const before = functions.latestAssistantResponse();
  await assert.rejects(functions.waitForResponse(before, "facility-76", 6400, 76));
});

test("times out on truncated JSON and preserves raw text for diagnosis", async () => {
  const partial = '{"id":59,"reviews":[{"name":"Khách hàng","content":"Tốt"}],';
  const reply = messageNode("new", partial);
  const { state, functions } = responseHarness((state) => { state.nodes = [reply]; });
  const before = functions.latestAssistantResponse();
  await assert.rejects(functions.waitForResponse(before, "facility-59", 6400, 59), (error) => {
    assert.equal(error.rawResponse, partial);
    return true;
  });
  assert.ok(state.time >= 6400);
});

test("facility and Toplist JSON watchers use the 30-minute article timeout, not the 10-minute image timeout", async () => {
  const cases = [
    { label: "facility", articleId: "facility-59", expected: 59 },
    { label: "Toplist", articleId: "toplist-7", expected: { id: 7, sourceType: "toplist" } }
  ];

  for (const { label, articleId, expected } of cases) {
    const { state, functions } = responseHarness();
    const before = functions.latestAssistantResponse();
    await assert.rejects(
      functions.waitForResponse(before, articleId, undefined, expected),
      (error) => {
        assert.match(error.message, /30 phút/);
        assert.doesNotMatch(error.message, /10 phút/);
        return true;
      },
      `${label} must report the regular article timeout`
    );
    assert.equal(state.time, 30 * 60 * 1000, `${label} must wait exactly 30 minutes by default`);
  }
});

test("matches each supported top-level Toplist ID without changing its payload", () => {
  for (const key of ["toplist_id", "toplistId", "id"]) {
    const expected = {
      [key]: "7", title: "Nha khoa tại Huế", intro: "Mô tả danh sách",
      facilities: [{ id: 51, name: "Nha khoa A", rank: 1, future_field: { verified: true } }],
      future_root_field: { source_count: 2 }
    };
    assert.deepEqual(plain(functions.extractJson(JSON.stringify(expected), { id: 7, sourceType: "toplist" })), expected);
  }
});

test("prefers the correct Toplist over a different Toplist containing facility ID 7", () => {
  const expected = { toplist_id: 7, facilities: [{ id: 51, rank: 1, name: "Nha khoa A" }] };
  const other = { toplist_id: 8, facilities: [{ id: 7, rank: 1, content: "Nội dung cơ sở khác" }] };
  const facility = { id: 7, name: "Cơ sở y tế số 7", content: "Bài viết dành cho cơ sở y tế" };
  for (const candidates of [[expected, other, facility], [facility, other, expected]]) {
    const sources = candidates.map((candidate) => JSON.stringify(candidate));
    assert.deepEqual(plain(functions.extractJson(sources.join("\n"), { id: 7, sourceType: "toplist" })), expected);
    assert.deepEqual(plain(functions.parseAssistantResponse({ sources }, { id: 7, sourceType: "toplist" })?.data), expected);
  }
});

test("preserves Toplist root fields, facility ranks and nested reviews from a code fence", () => {
  const expected = {
    toplist_id: 7, title: "Top cơ sở y tế", introduction_html: "<p>Giới thiệu</p>",
    facilities: [
      { facility_id: 51, rank: 2, review: "Tư vấn kỹ", reviews: [{ rating: 5, title: "Tốt" }] },
      { facility_id: 52, rank: 1, unknown_field: [0, false, null] }
    ],
    metadata: { generated_from: "prompt API", schema_version: 3 }
  };
  const result = functions.parseAssistantResponse({ sources: [`Dữ liệu:\n\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``] }, { id: 7, sourceType: "toplist" });
  assert.deepEqual(plain(result?.data), expected);
});

test("does not accept a nested facility while the outer Toplist JSON is truncated", () => {
  const truncated = '{"toplist_id":7,"facilities":[{"id":7,"name":"Cơ sở A","rank":1}],"intro":"chưa xong';
  assert.equal(functions.extractJson(truncated, { id: 7, sourceType: "toplist" }), null);
});

test("reads doctor/mixed Toplist code blocks and chooses the expected entity type", () => {
  const doctor = { toplist_id: 132, entity_type: "doctor", doctors: [{ doctor_id: 7, name: "Bác sĩ mẫu", rank_order: 1 }] };
  const mixed = { toplist_id: 132, entity_type: "mixed", members: [{ type: "facility", facility_id: 7, rank_order: 1 }, { type: "doctor", doctor_id: 7, rank_order: 2 }] };
  const facility = { toplist_id: 132, facilities: [{ facility_id: 7, rank_order: 1 }] };
  for (const record of [doctor, mixed]) {
    const expected = { id: 132, sourceType: "toplist", entity_type: record.entity_type };
    assert.deepEqual(plain(functions.expectedArticleId({ toplist_id: 132, sourceType: "toplist", entity_type: record.entity_type })), expected);
    assert.equal(functions.jsonMatchesExpectedId(facility, expected), false);
    assert.equal(functions.jsonMatchesExpectedId(record, expected), true);
    for (const candidates of [[record, facility], [facility, record]]) {
      const sources = candidates.map((candidate) => "```json\n" + JSON.stringify(candidate) + "\n```");
      assert.deepEqual(plain(functions.parseAssistantResponse({ sources }, expected)?.data), record);
    }
  }
  const inferred = { toplist_id: 132, bac_si: [{ id: 7 }] };
  assert.equal(functions.jsonMatchesExpectedId(inferred, { id: 132, sourceType: "toplist", entity_type: "doctor" }), true);
});
