const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const QUEUE = "https://medreview.vn/api/medical/handbooks-needing-content.php?limit=10&language=vi";
const UPDATE = "https://medreview.vn/api/medical/handbook-content-update.php";
const token = "c".repeat(64), revision = "b".repeat(64);
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/VlsAAAAASUVORK5CYII=";
const plain = (v) => JSON.parse(JSON.stringify(v));
function result(extra = {}) { return { id: 9, language: "vi", title: "Chủ đề", excerpt: "Tóm tắt", seo_title: "Chủ đề", seo_description: "Mô tả",
  content_html: `<h2>Thông tin tham khảo</h2><p>${"Nội dung y tế có nguồn, không thay thế khám bệnh. ".repeat(10)}</p><figure><img src="${png}" alt="Minh hoạ AI"><figcaption>Minh hoạ tạo bằng AI</figcaption></figure>`,
  sources_json: [{ url: "https://www.who.int/health-topics", title: "Nguồn chính thức" }], ...extra }; }
function job(extra = {}) { return { id: "tab-101:handbook-9", handbook_id: 9, sourceType: "handbook", ownerTabId: 101,
  language: "vi", title: "Chủ đề", source_revision: revision, contract_version: 1, prompt: "SERVER PROMPT giữ nguyên", status: "đang viết",
  runToken: "run-one", workerKey: "tab-101", workerTabId: 101, writer_claim_token: token, writer_claim_request_id: "stable-request",
  writer_claim_required: true, writer_claim_expires_at: new Date(Date.now() + 600000).toISOString(), ...extra }; }
function load(initial = {}, override) {
  const state = { items: [job()], runner: { active: true, workers: { "tab-101": { active: true, targetTabId: 101, provider: "grok", sourceType: "handbook", currentId: job().id, runToken: "run-one" } } }, ...initial };
  const calls = [], sent = [], vault = new Map(), timers = [];
  let listener;
  const response = (data, status = 200) => ({ ok: status < 300, status, async text() { return typeof data === "string" ? data : JSON.stringify(data); } });
  const chrome = {
    storage: { local: { async get(keys) { const fields = keys == null ? Object.keys(state) : Array.isArray(keys) ? keys : [keys]; return plain(Object.fromEntries(fields.filter((key) => key in state).map((key) => [key, state[key]]))); },
      async set(values) { Object.assign(state, plain(values)); }, async remove(keys) { for (const key of [].concat(keys)) delete state[key]; } } },
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, async get(id) { return { id, url: "https://grok.com/c/handbook" }; },
      async query() { return [{ id: 101, url: "https://grok.com/c/handbook" }]; }, async sendMessage(id, message) { sent.push(message); return { ok: true, ready: true }; } },
    alarms: { create() {}, onAlarm: { addListener() {} } }
  };
  const context = vm.createContext({ chrome, URL, Blob, atob, AbortController, structuredClone,
    MEDREVIEW_MEDICAL_API_KEY: "test-private-key", setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    async fetch(url, options = {}) {
      const call = { url: String(url), options, body: options.body ? JSON.parse(options.body) : null }; calls.push(call);
      const supplied = await override?.(call, response);
      if (supplied) return supplied;
      if (options.method === "POST" && String(url).includes("handbooks-needing-content.php")) {
        return response({ ok: true, claimed: true, claim_token: token, source_revision: revision, lease_seconds: 600, server_now: Math.floor(Date.now() / 1000), expires_at: Math.floor(Date.now() / 1000) + 600 });
      }
      if (options.method === "POST") return response({ ok: true, type: "handbook", id: 9, status: "published", images_count: 1, images: [{ url: "/uploads/handbook/9/ai-test.jpg", ai_generated: true }] });
      return response({ ok: true, contract_version: 1, claim_endpoint: "/api/medical/handbooks-needing-content.php", receive_endpoint: "/api/medical/handbook-content-update.php",
        items: [{ id: 9, title: "Chủ đề", language: "vi", source_revision: revision, prompt: "SERVER PROMPT giữ nguyên", output_template: {} }] });
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "handbook.js"), "utf8"), context);
  context.MedReviewHandbook.store.put = async (id, value) => { vault.set(id, plain(value)); };
  context.MedReviewHandbook.store.get = async (id) => vault.get(id);
  context.MedReviewHandbook.store.remove = async (id) => { vault.delete(id); };
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8") + `\nglobalThis.api = { fetchHandbooks, mergeQueueItems, claimWriterLease, requestWriterClaim, contentSafeArticle, handleArticleComplete, retryUpdate, getArticleContent, heartbeatActiveWriterClaims, publishHandbook, getJobMetadata };`, context);
  return { api: context.api, H: context.MedReviewHandbook, state, calls, vault, sent, context, sender: { tab: { id: 101, url: "https://grok.com/c/handbook" } } };
}
test("handbook validates real image format, identity, MIME and all contract size boundaries", () => {
  const { H } = load();
  assert.equal(H.validate(job(), result()).length, 1);
  for (const value of [{ id: "9" }, { id: 8 }, { language: "en" }, { status: "published" }, { claim_token: token }, { sources_json: [] }, { sources_json: [{ url: "https://who.int/?token=secret", title: "x" }] },
    { content_html: "<p>No image</p>" }, { content_html: '<img src="http://127.0.0.1/x.png">' }, { content_html: `<img src="${png.replace("image/png", "image/jpeg")}">` },
    { content_html: '<img src="data:image/png;base64,ZmFrZQ==">' }, { content_html: `<script>x</script><img src="${png}">` }, { content_html: `<img src="${png}">`.repeat(5) }]) {
    assert.throws(() => H.validate(job(), result(value)), (err) => err?.handbookError === true);
  }
  assert.throws(() => H.imageData("data:image/png;base64," + "A".repeat(4 * Math.ceil((H.limits.imageBytes + 1) / 3))), /5 MiB/);
  assert.equal(H.validate(job(), result({ content_html: '<h2>x</h2><img src="handbook-image:1">' }), { allowPlaceholders: true }).length, 1);
  assert.throws(() => H.validate(job(), result({ content_html: '<img src="handbook-image:1">' })), /ảnh|Ảnh/);
  assert.throws(() => H.validate(job(), result({ content_html: `<img data-src="${png}" src="http://127.0.0.1/private.png">` })), /URL/);
  assert.throws(() => H.validate(job(), result({ content_html: `<img data-src="${png}">` })), /src/);
});
test("handbook accepts mixed real BASE64 and public image links without changing their bytes", () => {
  const { H } = load();
  const original = result({ content_html: `<h2>Minh hoạ</h2><img src="${png}"><img src="https://cdn.example.org/illustration?w=1280&amp;format=webp">` });
  assert.equal(H.validate(job(), original).length, 2);
  assert.equal(H.payload(job(), original).content_html, original.content_html);
  for (const url of ["https://cdn.example.org/illustration", "https://8.8.8.8/image.png", "http://images.example.org:80/photo.jpg", "https://xn--bcher-kva.example.org:443/photo.webp"]) {
    assert.equal(H.imageHttpUrl(url), true, url);
  }
});
test("file manifest is browser-only and unresolved compact output never reaches POST", async () => {
  const ctx = load();
  const compact = result({ content_html: '<img src="link1">', image_files: [{ key: 'link1', filename: 'link1_base64.txt' }] });
  assert.equal(ctx.H.validate(job(), compact, { allowFileRefs: true }).length, 1);
  assert.throws(() => ctx.H.validate(job(), compact), /image_files/);
  assert.throws(() => ctx.H.payload(job(), result({ image_files: [] })), /image_files/);
  const saved = await ctx.api.handleArticleComplete({ articleId: job().id, runToken: "run-one", article: compact }, ctx.sender);
  assert.equal(saved.updated, false);
  assert.equal(ctx.calls.length, 0);
});
test("handbook rejects unsafe private, temporary and placeholder image links before POST", async () => {
  const bad = ["http://localhost/a.png", "http://foo.localhost/a.png", "http://clinic.internal/a.png", "http://clinic.home/a.png", "http://clinic.lan/a.png",
    "http://127.0.0.1/a.png", "http://10.0.0.1/a.png", "http://192.168.1.1/a.png", "http://172.16.0.1/a.png", "http://169.254.169.254/a.png", "http://100.64.0.1/a.png",
    "http://0.0.0.0/a.png", "http://192.0.2.1/a.png", "http://198.18.0.1/a.png", "http://198.51.100.1/a.png", "http://203.0.113.1/a.png", "http://224.0.0.1/a.png",
    "http://2130706433/a.png", "http://0177.0.0.1/a.png", "http://0x7f000001/a.png", "http://0x08080808/a.png",
    "http://[::1]/a.png", "http://[::ffff:127.0.0.1]/a.png", "http://[::ffff:7f00:1]/a.png", "http://[fc00::1]/a.png", "http://[fe80::1]/a.png",
    "https://user:pass@images.example.org/a.png", "https://images.example.org:8080/a.png", "http://images.example.org:443/a.png", "https://images.example.org:80/a.png",
    "https://images.example.org/a.png#fragment", "https://images.example.org/a.png?token=private", "https://images.example.org/a.png?api-key=private", "https://images.example.org/a.png?%61uth=private",
    "https://images.example.org/a.png?x=1&amp;access_token=private", "https://images.example.org/a.png?secret=private", "https://images.example.org/a.png?signature=private",
    "https://images.example.org/%0da.png", "https://images.example.org/%5ca.png", "https://images.example.org/\\a.png", "https://images.example.org/\na.png",
    "blob:https://example.org/file", "sandbox:/mnt/data/image.png", "/image.png", "https://placehold.co/100x100.png", "https://images.example.org/placeholder.png"];
  for (const url of bad) {
    const ctx = load();
    assert.equal(ctx.H.imageHttpUrl(url), false, url);
    const saved = await ctx.api.handleArticleComplete({ articleId: job().id, runToken: "run-one", article: result({ content_html: `<img src='${url}'>` }) }, ctx.sender);
    assert.equal(saved.updated, false, url);
    assert.equal(ctx.calls.length, 0, `${url} not sent`);
  }
});
test("handbook completion POST passes mixed BASE64 and public URLs only to receiving API", async () => {
  const ctx = load();
  const original = result({ content_html: `<h2>Minh hoạ</h2><img src="${png}"><img src="https://images.example.org/illustration.webp">` });
  const saved = await ctx.api.handleArticleComplete({ articleId: job().id, runToken: "run-one", article: original }, ctx.sender);
  assert.equal(saved.updated, true);
  const updates = ctx.calls.filter((call) => call.url === UPDATE);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].body.content_html, original.content_html);
  assert.ok(ctx.calls.every((call) => call.url === UPDATE || call.url === QUEUE));
});
test("handbook queue preserves each server prompt and uses a separate scoped source", async () => {
  const ctx = load({ items: [], runner: { active: false } });
  const data = await ctx.api.fetchHandbooks(101);
  assert.equal(ctx.calls[0].url, QUEUE);
  assert.equal(ctx.calls[0].options.headers["X-Medical-Api-Key"], "test-private-key");
  const merged = ctx.api.mergeQueueItems([], data.items, "handbook", "facility", 101);
  assert.equal(merged.items[0].handbook_id, 9);
  assert.equal(merged.items[0].facility_id, undefined);
  assert.equal(merged.items[0].prompt, "SERVER PROMPT giữ nguyên");
  assert.equal(ctx.api.mergeQueueItems([], [{ ...data.items[0], source_revision: "bad" }], "handbook").items.length, 0);
  assert.equal(ctx.api.contentSafeArticle(job()).source_revision, undefined);
  assert.equal(ctx.api.contentSafeArticle(job()).writer_claim_token, undefined);
});
test("handbook claim, renew and release go only to queue endpoint with stable revision identity", async () => {
  const ctx = load({ items: [job({ writer_claim_token: undefined, writer_claim_request_id: "stable-request" })] });
  const source = job({ writer_claim_token: undefined, writer_claim_request_id: "stable-request" });
  await ctx.api.claimWriterLease(source, { provider: "grok", workerKey: "tab-101", runToken: "run-one", tab: ctx.sender.tab });
  const claim = ctx.calls.find((call) => call.body?.action === "claim");
  assert.equal(claim.url, QUEUE);
  assert.equal(claim.body.source_revision, revision);
  assert.equal(claim.body.request_id, "stable-request");
  assert.equal(claim.body.client.task, "handbook_article");
  assert.equal(source.writer_claim_token, token);
  await ctx.api.requestWriterClaim("heartbeat", source, { claimToken: token });
  await ctx.api.requestWriterClaim("release", source, { claimToken: token });
  assert.equal(ctx.calls.some((call) => call.url.includes("writer-claim.php")), false);
  assert.equal(ctx.calls.at(-1).body.claim_token, token);
});
test("handbook claim stale revision is not treated as someone else's successful claim", async () => {
  const ctx = load({}, (call, reply) => call.body?.action === "claim" ? reply({ ok: false, reason: "source_revision_changed", message: "Chủ đề sửa" }, 409) : null);
  await assert.rejects(ctx.api.requestWriterClaim("claim", job(), { requestId: "stable-request", client: {} }), /409/);
});
test("handbook completion uses a single-object POST and only retains response URLs after durable publish success", async () => {
  const ctx = load();
  const original = result();
  const saved = await ctx.api.handleArticleComplete({ articleId: job().id, runToken: "run-one", article: original }, ctx.sender);
  assert.equal(saved.updated, true);
  const call = ctx.calls.find((entry) => entry.url === UPDATE);
  assert.deepEqual(call.body, { ...original, claim_token: token, request_id: "stable-request", source_revision: revision });
  assert.equal(call.body.items, undefined);
  assert.equal(ctx.vault.size, 0);
  const current = (await ctx.api.getJobMetadata("items")).items[0];
  assert.equal(current.status, "hoàn tất");
  assert.equal(current.has_result, true);
  assert.equal(JSON.stringify(ctx.state).includes("data:image"), false);
  assert.equal(current.writer_claim_token, undefined);
});
test("handbook missing images are stored only in payload vault and never POSTed or silently advanced", async () => {
  const ctx = load();
  const original = result({ content_html: "<p>Không có file ảnh</p>" });
  const saved = await ctx.api.handleArticleComplete({ articleId: job().id, runToken: "run-one", article: original }, ctx.sender);
  assert.equal(saved.updated, false);
  assert.equal(ctx.calls.length, 0);
  assert.deepEqual(ctx.vault.get(job().id).result, original);
  assert.equal(ctx.state.runner.workers["tab-101"].active, false);
  assert.equal(ctx.state.items[0].handbook_error_code, "missing_images");
  const retrieved = await ctx.api.getArticleContent(job().id, 101);
  assert.deepEqual(plain(retrieved.content.result), original);
});
test("lost handbook POST response replays exactly the same payload, request and token without a new claim", async () => {
  let offline = true;
  const ctx = load({}, (call) => { if (call.url === UPDATE && offline) throw new Error("offline"); });
  await ctx.api.handleArticleComplete({ articleId: job().id, runToken: "run-one", article: result() }, ctx.sender);
  assert.equal(ctx.state.items[0].status, "chưa xác nhận");
  const original = ctx.calls[0].body;
  assert.equal(JSON.stringify(ctx.state).includes("data:image"), false);
  offline = false;
  assert.equal((await ctx.api.retryUpdate(job().id)).updated, true);
  assert.deepEqual(ctx.calls.at(-1).body, original);
  assert.equal(ctx.calls.some((entry) => entry.body?.action === "claim"), false);
});
test("handbook stale write keeps exact bytes and blocks automatic/manual overwrite under a new claim", async () => {
  const ctx = load({}, (call, reply) => call.url === UPDATE ? reply({ ok: false, reason: "source_revision_changed", message: "Đã sửa chủ đề" }, 409) : null);
  await ctx.api.handleArticleComplete({ articleId: job().id, runToken: "run-one", article: result() }, ctx.sender);
  assert.equal(ctx.state.items[0].handbook_error_code, "source_revision_changed");
  assert.ok(ctx.vault.get(job().id).payload.content_html.includes(png));
  await assert.rejects(ctx.api.retryUpdate(job().id), /khóa khác|khóa|giữ/);
  assert.equal(ctx.calls.length, 1);
});
test("handbook wrong tab or old run cannot persist a payload or upload it", async () => {
  const ctx = load();
  assert.equal((await ctx.api.handleArticleComplete({ articleId: job().id, runToken: "old", article: result() }, ctx.sender)).ignored, true);
  assert.equal((await ctx.api.handleArticleComplete({ articleId: job().id, runToken: "run-one", article: result() }, { tab: { id: 202, url: ctx.sender.tab.url } })).ignored, true);
  assert.equal(ctx.vault.size, 0);
  assert.equal(ctx.calls.length, 0);
});
