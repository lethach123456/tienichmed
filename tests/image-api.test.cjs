const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const DEFAULT_LIST_URL = "https://medreview.vn/api/medical/facilities-needing-ai-images.php?page=1&limit=1&min_images=3";
const DEFAULT_UPDATE_URL = "https://medreview.vn/api/medical/facility-ai-image-update.php";

function makeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => plain(body),
    text: async () => JSON.stringify(body)
  };
}

function loadBackground(initial = {}, responder) {
  const state = plain(initial);
  const calls = [];
  const sentMessages = [];
  let listener;
  let installed;
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    chrome: {
      runtime: {
        onMessage: { addListener(callback) { listener = callback; } },
        onInstalled: { addListener(callback) { installed = callback; } }
      },
      storage: { local: {
        async get(keys) {
          const wanted = keys == null ? Object.keys(state) : Array.isArray(keys) ? keys : [keys];
          return plain(Object.fromEntries(wanted.filter((key) => key in state).map((key) => [key, state[key]])));
        },
        async set(values) { Object.assign(state, plain(values)); }
      } },
      tabs: {
        async query() { return [{ id: 33, url: "https://chatgpt.com/c/test", lastAccessed: 1 }]; },
        async get(id) { return { id, url: "https://chatgpt.com/c/test" }; },
        async sendMessage(id, message) { if (message.type !== "runner-ready") sentMessages.push({ id, message: plain(message) }); return { ok: true }; }
      },
      scripting: { async executeScript() {} }
    },
    AbortController, URL, setTimeout, clearTimeout,
    fetch: async (url, options = {}) => {
      const call = { url, options: plain(options) };
      calls.push(call);
      if (responder) return responder(call, calls.length) || makeResponse({ ok: true, items: [] });
      if (options.method === "POST") return makeResponse({ ok: true, updated_count: 1, updated: [] });
      return makeResponse({ ok: true, items: [] });
    }
  });
  const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8") + `
    globalThis.__imageApi = {
      fetchAiImages, refreshQueue, mergeQueueItems, queueItemKey, queueItemSource,
      buildAiImageUpdatePayload, updateFacilityAiImage, finishJob, retryUpdate,
      runNext, startRun, handleImageComplete, failJob,
      isUnsupportedAiImageProviderFailure, requeueUnsupportedAiImageFailures
    };
  `;
  vm.runInContext(source, context, { filename: "background.js" });
  return {
    ...context.__imageApi,
    state, calls, sentMessages, installed,
    dispatch(message, sender = {}) {
      return new Promise((resolve, reject) => {
        const accepted = listener(message, sender, resolve);
        if (!accepted) reject(new Error("Message handler did not accept request"));
      });
    }
  };
}

test("installation includes independent AI image API defaults", async () => {
  const api = loadBackground({
    aiImagesUrl: "https://example.invalid/images?page=2",
    aiImageUpdateUrl: "https://example.invalid/receive-image"
  });
  await api.installed();
  assert.equal(api.state.aiImagesUrl, "https://example.invalid/images?page=2");
  assert.equal(api.state.aiImageUpdateUrl, "https://example.invalid/receive-image");

  const fresh = loadBackground();
  await fresh.installed();
  await new Promise(setImmediate);
  assert.equal(fresh.state.aiImagesUrl, DEFAULT_LIST_URL);
  assert.equal(fresh.state.aiImageUpdateUrl, DEFAULT_UPDATE_URL);
});

test("fetch-ai-images uses the documented GET endpoint and API key", async () => {
  const fixture = {
    id: 51,
    name: "Nha Khoa Nụ Cười Việt",
    gallery_count: 3,
    reference_images: ["https://xxhihi.site/uploads/reference.jpg"],
    prompt: "Tạo ảnh nha khoa"
  };
  const api = loadBackground({}, () => makeResponse({ ok: true, items: [fixture] }));
  const response = await api.dispatch({ type: "fetch-ai-images" });
  assert.deepEqual(plain(response.items), [fixture]);
  assert.equal(api.calls[0].url, DEFAULT_LIST_URL);
  assert.deepEqual(api.calls[0].options.headers, {
    "X-Medical-Api-Key": "test-medical-key", Accept: "application/json"
  });
});

test("AI image queue stays separate from article queue and retains reference metadata", () => {
  const api = loadBackground();
  const existing = [{ id: "facility-51", sourceType: "facility", facility_id: 51, prompt: "Bài viết", status: "hoàn tất" }];
  const incoming = [{
    id: 51, name: "Nha Khoa Nụ Cười Việt", prompt: "Tạo ảnh AI", gallery_count: 4,
    reference_images: [{ url: "https://xxhihi.site/uploads/ref-1.jpg" }], prompt_source: "facility_image_prompt"
  }];
  const merged = api.mergeQueueItems(existing, incoming, "ai-image");
  assert.equal(merged.added, 1);
  const job = merged.items.at(-1);
  assert.equal(job.id, "ai-image-51");
  assert.equal(job.sourceType, "ai-image");
  assert.equal(job.facility_id, 51);
  assert.equal(job.gallery_count, 4);
  assert.deepEqual(plain(job.reference_images), incoming[0].reference_images);
  assert.equal(api.queueItemKey(job), "ai-image-51");
});

test("AI image job dispatches run-ai-image instead of a JSON article job", async () => {
  const api = loadBackground({
    sourceType: "ai-image",
    runner: { active: true, provider: "chatgpt", currentId: null, runToken: "legacy-run", refilling: false },
    items: [{ id: "ai-image-51", sourceType: "ai-image", facility_id: 51, prompt: "Tạo ảnh", status: "chờ" }]
  });
  await api.runNext();
  assert.equal(api.sentMessages.length, 1);
  assert.equal(api.sentMessages[0].message.type, "run-ai-image");
  assert.equal(api.sentMessages[0].message.article.id, "ai-image-51");
  assert.equal(api.sentMessages[0].message.article.facility_id, 51);
});

test("the active ChatGPT job alone can prepare its direct multipart upload", async () => {
  const api = loadBackground({
    aiImageUpdateUrl: "https://example.invalid/facility-ai-image-update",
    runner: {
      active: true,
      workers: {
        "tab-33": {
          active: true, provider: "chatgpt", targetTabId: 33,
          currentId: "ai-image-51", runToken: "upload-run"
        }
      }
    },
    items: [{
      id: "ai-image-51", sourceType: "ai-image", facility_id: 51,
      status: "đang viết", workerKey: "tab-33", workerTabId: 33
    }]
  });
  const sender = { tab: { id: 33, url: "https://chatgpt.com/c/test" } };
  const prepared = await api.dispatch({
    type: "prepare-ai-image-upload", articleId: "ai-image-51", runToken: "upload-run", provider: "chatgpt"
  }, sender);
  assert.deepEqual(plain(prepared), {
    ok: true,
    url: "https://example.invalid/facility-ai-image-update",
    apiKey: "test-medical-key",
    facilityId: 51,
    workerKey: "tab-33"
  });

  const stale = await api.dispatch({
    type: "prepare-ai-image-upload", articleId: "ai-image-51", runToken: "old-run", provider: "chatgpt"
  }, sender);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /dừng hoặc chuyển sang cơ sở khác/);
});

test("an AI-image run on Gemini is rejected before it creates a worker or claims a job", async () => {
  const api = loadBackground({
    sourceType: "ai-image",
    runner: { active: false },
    items: [{ id: "ai-image-51", sourceType: "ai-image", facility_id: 51, prompt: "Tạo ảnh", status: "chờ" }]
  });

  const result = await api.startRun(
    { provider: "gemini", targetTabId: 77 },
    { tab: { id: 77, url: "https://gemini.google.com/app" } }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /ChatGPT hoặc Grok/);
  assert.equal(api.state.runner.active, false);
  assert.equal(api.state.runner.workers, undefined);
  assert.equal(api.state.items[0].status, "chờ");
  assert.equal(api.sentMessages.length, 0);
});

test("starting Image AI on ChatGPT requeues only prior Gemini/Claude provider-support failures", async () => {
  const supportError = "Tạo ảnh AI hiện hỗ trợ ChatGPT hoặc Grok. Hãy mở một tab ChatGPT/Grok để chạy hàng đợi Ảnh AI.";
  const api = loadBackground({
    sourceType: "ai-image",
    runner: { active: false },
    items: [
      { id: "ai-image-51", sourceType: "ai-image", facility_id: 51, prompt: "P1", status: "lỗi", provider: "gemini", error: supportError },
      { id: "ai-image-52", sourceType: "ai-image", facility_id: 52, prompt: "P2", status: "lỗi", provider: "claude", error: supportError },
      { id: "ai-image-53", sourceType: "ai-image", facility_id: 53, prompt: "P3", status: "lỗi", provider: "gemini", error: "Hết thời gian xử lý tạo ảnh AI (10 phút)." },
      { id: "ai-image-54", sourceType: "ai-image", facility_id: 54, prompt: "P4", status: "lỗi", provider: "grok", error: supportError },
      { id: "ai-image-55", sourceType: "ai-image", facility_id: 55, prompt: "P5", status: "lỗi cập nhật", provider: "gemini", error: supportError },
      { id: "facility-56", sourceType: "facility", facility_id: 56, prompt: "P6", status: "lỗi", provider: "gemini", error: supportError }
    ]
  });

  const result = await api.startRun(
    { provider: "chatgpt", targetTabId: 33 },
    { tab: { id: 33, url: "https://chatgpt.com/c/test" } }
  );

  assert.equal(result.ok, true);
  assert.equal(result.requeuedUnsupportedImageJobs, 2);
  assert.equal(api.state.items[0].status, "đang viết", "the first recovered job should run immediately");
  assert.equal(api.state.items[1].status, "chờ", "the second recovered job stays available for another supported tab");
  assert.equal(api.state.items[2].status, "lỗi");
  assert.equal(api.state.items[3].status, "lỗi");
  assert.equal(api.state.items[4].status, "lỗi cập nhật");
  assert.equal(api.state.items[5].status, "lỗi");
  assert.equal(api.state.items[0].error, undefined);
  assert.equal(api.state.items[1].provider, undefined);
  assert.equal(api.sentMessages.length, 1);
  assert.equal(api.sentMessages[0].message.type, "run-ai-image");
  assert.equal(api.sentMessages[0].message.article.id, "ai-image-51");
});

test("a freshly recorded unsupported-provider failure is marked and can be safely recovered", async () => {
  const api = loadBackground({
    items: [{
      id: "ai-image-51", sourceType: "ai-image", facility_id: 51, status: "đang viết", provider: "claude"
    }]
  });
  await api.failJob(
    "ai-image-51",
    "Tạo ảnh AI hiện chỉ hỗ trợ ChatGPT hoặc Grok. Claude vẫn dùng được để viết bài và Toplist."
  );
  assert.equal(api.state.items[0].failure_code, "unsupported-ai-image-provider");
  assert.equal(api.isUnsupportedAiImageProviderFailure(api.state.items[0]), true);
  assert.equal(api.requeueUnsupportedAiImageFailures(api.state.items), 1);
  assert.equal(api.state.items[0].status, "chờ");
  assert.equal(api.state.items[0].failure_code, undefined);
});

test("a direct multipart upload finishes from the local URL without reposting ChatGPT's signed URL", async () => {
  const api = loadBackground({
    sourceType: "ai-image",
    runner: {
      active: true, sourceType: "ai-image", sessionToken: "session",
      workers: {
        "tab-33": { active: true, provider: "chatgpt", targetTabId: 33, currentId: "ai-image-51", runToken: "image-run" }
      }
    },
    items: [{ id: "ai-image-51", sourceType: "ai-image", facility_id: 51, prompt: "Tạo ảnh", status: "đang viết" }]
  });
  const privateChatGptUrl = "https://chatgpt.com/backend-api/estuary/content?id=file-generated-51&ts=123&sig=signed";
  const localImageUrl = "/uploads/library/co-so-y-te-ai/facility-51-nha-khoa-nu-cuoi-viet/generated-51.png";
  const apiUpdate = {
    ok: true,
    updated_count: 1,
    updated: [{ facility_id: 51, ai_image_url: localImageUrl, storage: "local_library" }]
  };
  const response = await api.dispatch({
    type: "image-complete", articleId: "ai-image-51", runToken: "image-run",
    // Content already fetched this signed URL while logged into ChatGPT and
    // uploaded its Blob directly. Only the server-owned replacement URL may
    // cross the extension message boundary at this point.
    imageResult: { id: 51, ai_image_url: localImageUrl },
    imageUploaded: true,
    apiUpdate,
    rawResponse: "ảnh đã tạo"
  }, { tab: { id: 33, url: "https://chatgpt.com/c/test" } });

  assert.equal(response.ok, true);
  assert.equal(api.calls.filter((call) => call.options.method === "POST").length, 0,
    "background must not re-post the expiring/private ChatGPT URL after content uploaded its Blob");
  const item = api.state.items[0];
  assert.equal(item.status, "hoàn tất");
  assert.deepEqual(api.state["article-content:" + item.id].result, { id: 51, ai_image_url: localImageUrl });
  assert.equal(item.aiImageUrl, localImageUrl);
  assert.deepEqual(item.api_update, apiUpdate);
  assert.equal(JSON.stringify(item).includes(privateChatGptUrl), false);
});

test("base64 fallback uses documented image_data and never promotes the cover", async () => {
  const api = loadBackground();
  const base64 = "data:image/png;base64,aGVsbG8=";
  assert.deepEqual(plain(api.buildAiImageUpdatePayload(
    { sourceType: "ai-image", facility_id: 51 }, { aiImageBase64: base64 }
  )), { id: 51, image_data: base64 });
  await api.updateFacilityAiImage({ sourceType: "ai-image", facility_id: 51 }, { aiImageBase64: base64 });
  assert.deepEqual(JSON.parse(api.calls[0].options.body), { id: 51, image_data: base64 });
});

test("image-complete preserves a blob/data fallback as image_data", async () => {
  const api = loadBackground({
    sourceType: "ai-image",
    runner: {
      active: true, sourceType: "ai-image", sessionToken: "session",
      workers: {
        "tab-33": { active: true, provider: "grok", targetTabId: 33, currentId: "ai-image-51", runToken: "base64-run" }
      }
    },
    items: [{ id: "ai-image-51", sourceType: "ai-image", facility_id: 51, prompt: "Tạo ảnh", status: "đang viết" }]
  });
  const base64 = "data:image/webp;base64,aGVsbG8=";
  const response = await api.dispatch({
    type: "image-complete", articleId: "ai-image-51", runToken: "base64-run", aiImageBase64: base64
  }, { tab: { id: 33, url: "https://grok.com/c/test" } });

  assert.equal(response.ok, true);
  const update = api.calls.find((call) => call.options.method === "POST");
  assert.deepEqual(JSON.parse(update.options.body), { id: 51, image_data: base64 });
  assert.deepEqual(api.state["article-content:" + api.state.items[0].id].result, { image_data: base64 });
});

test("retrying an image job accepts only a server-owned local image URL", async () => {
  const api = loadBackground({
    aiImageUpdateUrl: "https://example.invalid/ai-image-update",
    items: [{
      id: "ai-image-51", sourceType: "ai-image", facility_id: 51, status: "lỗi cập nhật",
      result: { ai_image_url: "/uploads/library/co-so-y-te-ai/facility-51/source-again.webp" }
    }]
  });
  assert.equal((await api.retryUpdate("ai-image-51")).ok, true);
  assert.equal(api.calls[0].url, "https://example.invalid/ai-image-update");
  assert.deepEqual(JSON.parse(api.calls[0].options.body), {
    id: 51,
    ai_image_url: "/uploads/library/co-so-y-te-ai/facility-51/source-again.webp"
  });
  assert.equal(api.state.items[0].status, "hoàn tất");
});

test("retrying an image job refuses an AI provider URL instead of relaying it to the API", async () => {
  const api = loadBackground({
    aiImageUpdateUrl: "https://example.invalid/ai-image-update",
    items: [{
      id: "ai-image-51", sourceType: "ai-image", facility_id: 51, status: "lỗi cập nhật",
      result: { ai_image_url: "https://assets.grok.com/media/generated/again.webp?sig=private" }
    }]
  });

  const result = await api.retryUpdate("ai-image-51");
  assert.equal(result.ok, false);
  assert.match(result.error, /Không gửi URL tạm\/private/);
  assert.equal(api.calls.length, 0, "the private provider URL must never be posted to the website API");
  assert.equal(api.state.items[0].status, "lỗi cập nhật");
  assert.match(api.state.items[0].api_error, /Ảnh phải được upload multipart/);

  assert.throws(() => api.buildAiImageUpdatePayload(
    { sourceType: "ai-image", facility_id: 51 }, { id: 52, ai_image_url: "https://images.example/wrong.png" }
  ), /khác ID cơ sở/);
});

// This is the current ChatGPT generated-image card: an image is nested in a
// `section[data-turn="assistant"]` response and has a signed Estuary URL.
// That URL only works while the user is signed into ChatGPT, so it is a source
// to fetch as a Blob inside content.js — never a URL for background/API to
// persist or relay.
function createChatGptGeneratedImageFixture() {
  const generatedUrl = "https://chatgpt.com/backend-api/estuary/content?id=file-generated-dental&ts=123&sig=signed";
  const imageCard = {
    className: "group/image-card",
    getAttribute: (name) => name === "data-testid" ? "image-block" : null
  };
  const generatedImage = {
    currentSrc: generatedUrl,
    src: generatedUrl,
    alt: "Ảnh đã tạo: Phòng khám nha khoa hiện đại sáng sủa",
    className: "rounded-2xl object-cover",
    naturalWidth: 1536,
    naturalHeight: 1024,
    parentElement: imageCard,
    getAttribute: (name) => name === "src" ? generatedUrl : null,
    getBoundingClientRect: () => ({ width: 768, height: 512 }),
    closest: () => null
  };
  const assistantTurn = {
    textContent: "",
    innerText: "",
    getClientRects: () => [{}],
    getAttribute: (name) => name === "data-message-id" ? "assistant-image-turn-51" : null,
    matches: () => false,
    closest(selector) {
      return selector.includes("[data-message-id]") ? assistantTurn : null;
    },
    querySelector: () => null,
    querySelectorAll: (selector) => selector === "img" ? [generatedImage] : [],
    cloneNode() { return { textContent: "", querySelectorAll: () => [] }; }
  };
  return {
    generatedUrl, generatedImage, assistantTurn
  };
}

function loadChatGptGeneratedImageProbe(fixture = createChatGptGeneratedImageFixture()) {
  const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__chatGptImageProbe = { latestGeneratedImages };
  }`);
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    location: { hostname: "chatgpt.com" },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document: {
      body: null,
      querySelector: () => null,
      querySelectorAll(selector) {
        return selector.includes("section[data-turn") && selector.includes("assistant") ? [fixture.assistantTurn] : [];
      }
    },
    getComputedStyle: () => ({ visibility: "visible" }),
    setTimeout,
    clearTimeout
  });
  vm.runInContext(source, context, { filename: "content.js" });
  return { ...context.__chatGptImageProbe, fixture };
}

test("collects a ChatGPT section[data-turn=assistant] generated image and identifies its signed source URL", () => {
  const probe = loadChatGptGeneratedImageProbe();
  const snapshot = probe.latestGeneratedImages();

  assert.equal(snapshot.images.length, 1);
  assert.equal(snapshot.images[0].key, "assistant-image-turn-51|" + probe.fixture.generatedUrl + "|0");
  assert.equal(snapshot.images[0].url, probe.fixture.generatedUrl);
});

function runDirectChatGptImageHarness() {
  const fixture = createChatGptGeneratedImageFixture();
  const localImageUrl = "/uploads/library/co-so-y-te-ai/facility-51-nha-khoa-nu-cuoi-viet/generated-51.png";
  const uploadResponse = {
    ok: true,
    updated_count: 1,
    updated: [{ facility_id: 51, ai_image_url: localImageUrl, storage: "local_library" }]
  };
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
  const send = {
    disabled: false, offsetParent: {},
    tagName: "BUTTON",
    getClientRects: () => [{}],
    getAttribute: (name) => name === "aria-label" ? "Gửi" : null,
    click() {
      state.sent.push(input.value);
      input.value = "";
      // ChatGPT may honor the first art-director prompt by immediately
      // generating an image instead of first returning an image_prompt JSON.
      state.nodes = [fixture.assistantTurn];
    }
  };
  const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__directChatGptImageRun = { runImageArticle };
  }`);
  const selection = { removeAllRanges() {}, addRange() {} };
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    location: { hostname: "chatgpt.com" },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          messages.push(plain(message));
          if (message.type === "prepare-ai-image-upload") {
            return { ok: true, url: DEFAULT_UPDATE_URL, apiKey: "test-medical-key", facilityId: 51 };
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
        if (selector.includes("section[data-turn") && selector.includes("assistant")) return state.nodes;
        return [];
      },
      createRange() { return { selectNodeContents() {} }; },
      execCommand(command, _ui, value) { if (command === "insertText") input.value = value; return true; }
    },
    window: { getSelection: () => selection },
    getComputedStyle: () => ({ visibility: "visible" }),
    Date: class extends Date { static now() { return state.time; } },
    setTimeout(callback, ms) { state.time += ms; callback(); return state.time; },
    clearTimeout,
    Event: class Event {},
    InputEvent: class InputEvent {},
    KeyboardEvent: class KeyboardEvent {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    Blob,
    FormData,
    fetch: async (url, options = {}) => {
      state.fetchCalls.push({ url, options });
      if (url === fixture.generatedUrl) {
        return { ok: true, status: 200, blob: async () => generatedBlob };
      }
      if (url === DEFAULT_UPDATE_URL) return makeResponse(uploadResponse);
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });
  vm.runInContext(source, context, { filename: "content.js" });
  return {
    runImageArticle: context.__directChatGptImageRun.runImageArticle,
    state, messages, fixture, generatedBlob, localImageUrl, uploadResponse
  };
}

test("a direct first-phase ChatGPT image downloads its signed source as a Blob and uploads multipart before notifying background", async () => {
  const harness = runDirectChatGptImageHarness();
  await harness.runImageArticle(
    { id: "ai-image-51", sourceType: "ai-image", facility_id: 51, runToken: "direct-image-run" },
    "Server art-director prompt for facility 51"
  );

  assert.deepEqual(harness.state.sent, ["Server art-director prompt for facility 51"]);
  const preparation = harness.messages.find((message) => message.type === "prepare-ai-image-upload");
  assert.deepEqual(preparation, {
    type: "prepare-ai-image-upload", articleId: "ai-image-51", runToken: "direct-image-run", provider: "chatgpt"
  });
  assert.equal(harness.state.fetchCalls.length, 2);
  const [sourceFetch, uploadFetch] = harness.state.fetchCalls;
  assert.equal(sourceFetch.url, harness.fixture.generatedUrl);
  assert.equal(sourceFetch.options.credentials, "include", "signed ChatGPT asset must be read in the logged-in page session");
  assert.equal(uploadFetch.url, DEFAULT_UPDATE_URL);
  assert.equal(uploadFetch.options.method, "POST");
  assert.equal(uploadFetch.options.headers["X-Medical-Api-Key"], "test-medical-key");
  assert.equal(Object.keys(uploadFetch.options.headers).some((key) => key.toLowerCase() === "content-type"), false,
    "the browser must set the multipart boundary for FormData");
  assert.equal(uploadFetch.options.body instanceof FormData, true);
  assert.equal(uploadFetch.options.body.get("id"), "51");
  const file = uploadFetch.options.body.get("image");
  assert.equal(file instanceof Blob, true);
  assert.equal(file.type, "image/png");
  assert.equal(file.size, harness.generatedBlob.size);
  assert.equal(uploadFetch.options.body.get("ai_image_url"), null);

  const completed = harness.messages.find((message) => message.type === "image-complete");
  assert.equal(completed.articleId, "ai-image-51");
  assert.equal(completed.runToken, "direct-image-run");
  assert.equal(completed.imageUploaded, true);
  assert.equal(completed.imageResult.id, 51);
  assert.equal(completed.imageResult.ai_image_url, harness.localImageUrl);
  assert.deepEqual(completed.apiUpdate, harness.uploadResponse);
  assert.equal(JSON.stringify(completed).includes(harness.fixture.generatedUrl), false,
    "the signed URL must never be handed to background after direct upload");

  const api = loadBackground({
    sourceType: "ai-image",
    runner: {
      active: true, sourceType: "ai-image", sessionToken: "session",
      workers: {
        "tab-33": { active: true, provider: "chatgpt", targetTabId: 33, currentId: "ai-image-51", runToken: "direct-image-run" }
      }
    },
    items: [{ id: "ai-image-51", sourceType: "ai-image", facility_id: 51, status: "đang viết" }]
  });
  const response = await api.dispatch(completed, { tab: { id: 33, url: "https://chatgpt.com/c/test" } });
  assert.equal(response.ok, true);
  assert.equal(api.calls.filter((call) => call.options.method === "POST").length, 0,
    "background must trust the direct upload acknowledgement instead of sending a second update");
  assert.equal(api.state.items[0].aiImageUrl, harness.localImageUrl);
});
