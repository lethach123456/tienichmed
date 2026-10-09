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

test("Grok pages may load both the content script and embedded panel files", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
  const contentMatches = manifest.content_scripts.flatMap((entry) => entry.matches || []);
  const resource = manifest.web_accessible_resources.find((entry) => (entry.resources || []).includes("popup.html"));
  assert.ok(contentMatches.includes("https://grok.com/*"));
  assert.ok(resource.matches.includes("https://grok.com/*"));
});

test("Grok composer detection chooses the visible TipTap editor, not its hidden textarea mirror", async () => {
  const hiddenTextarea = {
    disabled: false,
    getAttribute: (name) => name === "aria-hidden" ? "true" : null,
    getClientRects: () => [{}]
  };
  const visibleEditor = {
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{}]
  };
  const document = {
    body: null,
    querySelectorAll(selector) {
      if (selector.startsWith("[contenteditable='true'][role='textbox']")) return [visibleEditor];
      if (selector.startsWith("textarea")) return [hiddenTextarea];
      return [];
    }
  };
  const source = fs.readFileSync(path.join(extensionRoot, "content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__grokTest = { provider: PROVIDER, inputSelectors, waitForInput };
  }`);
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    location: { hostname: "grok.com" }, document,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    getComputedStyle: () => ({ visibility: "visible" }),
    setTimeout, clearTimeout
  });
  vm.runInContext(source, context, { filename: "content.js" });
  assert.equal(context.__grokTest.provider, "grok");
  assert.match(context.__grokTest.inputSelectors()[0], /contenteditable/);
  assert.equal(await context.__grokTest.waitForInput(20), visibleEditor);
});

test("a new run forgets the previous ChatGPT provider and starts the available Grok worker", async () => {
  const state = {
    sourceType: "facility",
    runner: { active: false, provider: "chatgpt", currentId: null },
    items: [{ id: "facility-9", facility_id: 9, title: "Grok test", prompt: "Prompt", status: "chờ" }]
  };
  const sent = [];
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in state).map((key) => [key, state[key]]));
      },
      async set(values) { Object.assign(state, values); }
    } },
    tabs: {
      async query(query) {
        if (query.active) return [{ id: 77, url: "https://grok.com/" }];
        if (query.url === "*://grok.com/*") return [{ id: 77, url: "https://grok.com/" }];
        return [];
      },
      async update() {},
      async sendMessage(tabId, message) { if (message.type !== "runner-ready") sent.push({ tabId, message }); return { ok: true }; }
    },
    scripting: { async executeScript() {} }
  };
  const source = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8") + "\nglobalThis.__grokBackgroundTest = { startRun };";
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key", chrome, URL, AbortController, fetch: mockClaimFetch, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: "background.js" });
  await context.__grokBackgroundTest.startRun();
  assert.equal(state.runner.provider, "grok");
  assert.equal(state.runner.currentId, "facility-9");
  assert.equal(state.runner.workers["tab-77"].provider, "grok");
  assert.equal(state.runner.workers["tab-77"].currentId, "facility-9");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tabId, 77);
  assert.equal(sent[0].message.type, "run-article");
  assert.equal(state.runner.targetProvider, "grok");
  assert.equal(state.runner.targetTabId, 77);
});

test("an explicit ChatGPT run does not start Grok even when both tabs are open", async () => {
  const state = {
    sourceType: "facility",
    runner: { active: false },
    items: [
      { id: "facility-101", facility_id: 101, title: "Bài A", prompt: "Prompt A", status: "chờ" },
      { id: "facility-102", facility_id: 102, title: "Bài B", prompt: "Prompt B", status: "chờ" }
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
        return [];
      },
      async update() {},
      async sendMessage(tabId, message) { if (message.type !== "runner-ready") sent.push({ tabId, message }); return { ok: true }; }
    },
    scripting: { async executeScript() {} }
  };
  const source = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8") + "\nglobalThis.__parallelTest = { startRun };";
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key", chrome, URL, structuredClone, AbortController, fetch: mockClaimFetch, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: "background.js" });
  await context.__parallelTest.startRun(
    { provider: "chatgpt", targetTabId: 11 },
    { tab: { id: 11, url: "https://chatgpt.com/c/live" } }
  );

  assert.equal(state.runner.active, true);
  assert.equal(state.runner.parallel, false);
  assert.deepEqual(Object.keys(state.runner.workers), ["tab-11"]);
  assert.equal(state.runner.workers["tab-11"].provider, "chatgpt");
  assert.equal(state.runner.workers["tab-11"].currentId, "facility-101");
  assert.equal(state.items.find((item) => item.id === "facility-102").status, "chờ");
  assert.deepEqual(sent.map(({ tabId }) => tabId), [11]);
});

test("Grok jobs prefer the active Grok tab when duplicate conversation tabs exist", async () => {
  const state = {
    sourceType: "facility",
    runner: { active: false, provider: "auto", currentId: null },
    items: [{ id: "facility-76", facility_id: 76, title: "Westcoast", prompt: "Prompt", status: "chờ" }]
  };
  const sent = [];
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in state).map((key) => [key, state[key]]));
      },
      async set(values) { Object.assign(state, values); }
    } },
    tabs: {
      async query(query) {
        if (query.active) return [{ id: 202, url: "https://grok.com/c/current", active: true }];
        if (query.url === "*://grok.com/*") return [
          { id: 101, url: "https://grok.com/c/old", lastAccessed: 1 },
          { id: 202, url: "https://grok.com/c/current", lastAccessed: 2 }
        ];
        return [];
      },
      async update() {},
      async sendMessage(tabId, message) { if (message.type !== "runner-ready") sent.push({ tabId, message }); return { ok: true }; }
    },
    scripting: { async executeScript() {} }
  };
  const source = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8") + "\nglobalThis.__grokBackgroundTest = { startRun };";
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key", chrome, URL, AbortController, fetch: mockClaimFetch, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: "background.js" });
  await context.__grokBackgroundTest.startRun();
  assert.equal(sent[0].tabId, 202);
  assert.equal(state.runner.targetTabId, 202);
});

// Grok serves generated pictures from a short-lived, session-bound asset URL.
// The content script must read `img.currentSrc` while the Grok tab is logged in
// and transfer the binary straight to our API.  The provider URL must never be
// handed to background or saved as the facility image URL.
function loadGrokMultipartImageProbe(options = {}) {
  const facilityId = 53;
  const grokImageUrl = "https://assets.grok.com/images/generated/facility-53.webp?token=private-signed-token";
  const localImageUrl = "/uploads/library/co-so-y-te-ai/facility-53-nha-khoa/generated-53.webp";
  const uploaded = {
    ok: true,
    updated: [{ facility_id: facilityId, ai_image_url: localImageUrl, storage: "local_library" }]
  };
  const generatedBlob = new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: "image/webp" });
  const fetchCalls = [];
  const messages = [];
  const sourceResponse = options.sourceResponse || {
    ok: true,
    status: 200,
    headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "image/webp" : null },
    blob: async () => generatedBlob,
    text: async () => ""
  };
  const uploadResponse = options.uploadResponse || {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(uploaded)
  };
  const source = fs.readFileSync(path.join(extensionRoot, "content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__grokMultipartProbe = { imageSource, completeGeneratedImage };
  }`);
  const context = vm.createContext({
    MEDREVIEW_MEDICAL_API_KEY: "test-medical-key",
    location: { hostname: "grok.com" },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          messages.push(JSON.parse(JSON.stringify(message)));
          if (message.type === "prepare-ai-image-upload") {
            return {
              ok: true,
              url: "https://xxhihi.site/api/medical/facility-ai-image-update.php",
              apiKey: "test-medical-key",
              facilityId
            };
          }
          if (message.type === "image-complete") return { ok: true };
          return { ok: true };
        }
      }
    },
    document: { body: null, querySelector: () => null, querySelectorAll: () => [] },
    Blob,
    FormData,
    fetch: async (url, request = {}) => {
      fetchCalls.push({ url, request });
      if (url === grokImageUrl) return sourceResponse;
      if (url === "https://xxhihi.site/api/medical/facility-ai-image-update.php") return uploadResponse;
      throw new Error(`Unexpected fetch: ${url}`);
    },
    setTimeout,
    clearTimeout
  });
  vm.runInContext(source, context, { filename: "content.js" });
  return {
    ...context.__grokMultipartProbe,
    facilityId,
    grokImageUrl,
    localImageUrl,
    generatedBlob,
    fetchCalls,
    messages,
    uploaded
  };
}

test("a Grok img.currentSrc is downloaded in-session and uploaded as multipart, never as an assets.grok URL", async () => {
  const probe = loadGrokMultipartImageProbe();
  const image = {
    // `src` intentionally differs: currentSrc is the real rendered signed
    // image and must take priority when Grok uses a responsive image card.
    currentSrc: probe.grokImageUrl,
    src: "https://cdn.grok.com/placeholder.webp",
    getAttribute: (name) => name === "src" ? "https://cdn.grok.com/placeholder.webp" : null
  };
  const sourceUrl = probe.imageSource(image);
  assert.equal(sourceUrl, probe.grokImageUrl);

  await probe.completeGeneratedImage(
    { id: "ai-image-53", sourceType: "ai-image", facility_id: probe.facilityId, runToken: "grok-upload-run" },
    { url: sourceUrl },
    "Grok has generated the facility image.",
    "Professional dental clinic interior, 16:9"
  );

  assert.equal(probe.fetchCalls.length, 2);
  const [download, upload] = probe.fetchCalls;
  assert.equal(download.url, probe.grokImageUrl);
  assert.deepEqual(JSON.parse(JSON.stringify(download.request)), {
    credentials: "include",
    cache: "no-store"
  });

  assert.equal(upload.url, "https://xxhihi.site/api/medical/facility-ai-image-update.php");
  assert.equal(upload.request.method, "POST");
  assert.equal(upload.request.headers["X-Medical-Api-Key"], "test-medical-key");
  assert.equal(upload.request.headers.Accept, "application/json");
  assert.equal(Object.keys(upload.request.headers).some((key) => key.toLowerCase() === "content-type"), false,
    "the browser must generate the multipart boundary");
  assert.equal(upload.request.body instanceof FormData, true);
  assert.equal(upload.request.body.get("id"), "53");
  const uploadedFile = upload.request.body.get("image");
  assert.equal(uploadedFile instanceof Blob, true);
  assert.equal(uploadedFile.size, probe.generatedBlob.size);
  assert.equal(uploadedFile.type, "image/webp");
  assert.equal(uploadedFile.name, "facility-53-ai.webp");
  assert.equal(upload.request.body.get("ai_image_url"), null);

  const completed = probe.messages.find((message) => message.type === "image-complete");
  assert.equal(completed.imageUploaded, true);
  assert.deepEqual(completed.imageResult, {
    id: 53,
    image_prompt: "Professional dental clinic interior, 16:9",
    ai_image_url: probe.localImageUrl
  });
  assert.equal(completed.aiImageUrl, probe.localImageUrl);
  assert.deepEqual(completed.apiUpdate, probe.uploaded);
  assert.equal(JSON.stringify(probe.messages).includes(probe.grokImageUrl), false,
    "the expiring assets.grok URL must never reach background");
});

test("a valid Grok image Blob is accepted when the source response uses generic application/octet-stream", async () => {
  // Signed AI-asset endpoints occasionally serve an otherwise valid WebP file
  // with a generic download header. The Blob still carries its image MIME, so
  // the direct multipart path must use that MIME rather than reject the job.
  const webpBlob = new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: "image/webp" });
  const probe = loadGrokMultipartImageProbe({
    sourceResponse: {
      ok: true,
      status: 200,
      headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "application/octet-stream" : null },
      blob: async () => webpBlob,
      text: async () => ""
    }
  });

  await probe.completeGeneratedImage(
    { id: "ai-image-53", sourceType: "ai-image", facility_id: probe.facilityId, runToken: "grok-octet-stream-run" },
    { url: probe.grokImageUrl },
    "Grok image with a generic response header"
  );

  assert.equal(probe.fetchCalls.length, 2, "the valid image must proceed to website upload");
  const upload = probe.fetchCalls[1];
  const uploadedFile = upload.request.body.get("image");
  assert.equal(uploadedFile instanceof Blob, true);
  assert.equal(uploadedFile.type, "image/webp");
  assert.equal(uploadedFile.size, webpBlob.size);
  assert.equal(probe.messages.find((message) => message.type === "image-complete")?.aiImageUrl, probe.localImageUrl);
});

test("a Grok image download failure reports the source HTTP status and skips the website upload", async () => {
  const probe = loadGrokMultipartImageProbe({
    sourceResponse: {
      ok: false,
      status: 403,
      text: async () => "Signed asset URL has expired"
    }
  });
  await assert.rejects(
    probe.completeGeneratedImage(
      { id: "ai-image-53", sourceType: "ai-image", facility_id: probe.facilityId, runToken: "grok-upload-run" },
      { url: probe.grokImageUrl },
      "Grok image failed"
    ),
    /HTTP 403\): Signed asset URL has expired/
  );
  assert.equal(probe.fetchCalls.length, 1);
  assert.equal(probe.fetchCalls[0].url, probe.grokImageUrl);
  assert.equal(probe.messages.some((message) => message.type === "image-complete"), false);
});
