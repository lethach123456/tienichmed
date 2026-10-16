const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(onTick = () => {}) {
  const state = { time: 0, busy: true, gap: false, image: false, loaded: false, json: false,
    reads: [], retries: [], fills: [], sends: [], inputs: [], cancel: false };
  const status = { textContent: 'Đang tạo ảnh', children: [], getClientRects: () => [{}] };
  const storage = new Map();
  const context = vm.createContext({
    location: { hostname: 'chatgpt.com' },
    chrome: { runtime: { onMessage: { addListener() {} }, async sendMessage() { return { ok: true }; } } },
    document: { querySelector: () => null, querySelectorAll(selector) {
      if (selector.startsWith('button[') || selector.includes("aria-label='Bỏ qua'")) return [];
      return selector.includes("[role='status']") && state.busy && !state.gap ? [status] : [];
    } },
    sessionStorage: { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    Date: class extends Date { static now() { return state.time; } },
    setTimeout(callback, ms) { state.time += ms; onTick(state); queueMicrotask(callback); return state.time; },
    clearTimeout() {}
  });
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8').replace(/}\s*$/, `
    globalThis.probe = { waitForResponse, waitForHandbookIdle, requestJsonFormatRetry, jsonFormatRetryPrompt,
      parseOriginal: parseAssistantResponse,
      configure(fn) {
        latestAssistantResponse = fn.snapshot;
        latestGeneratedImages = fn.images;
        parseAssistantResponse = fn.parse;
        responseHasJsonCodeBlock = () => true;
        waitForInput = fn.input;
        setInputValue = fn.fill;
        waitForPromptInComposer = async () => true;
        submitPrompt = fn.send;
        if (fn.sendReady) findChatGPTSendButton = fn.sendReady;
        if (fn.retry) requestJsonFormatRetry = fn.retry;
      }, cancel(id) { cancelledArticleId = id; }
    };
  }`);
  vm.runInContext(source, context);
  const snapshot = () => {
    state.reads.push(state.time);
    return { node: {}, id: state.json ? 'final' : 'planning', count: state.json ? 2 : 1,
      signature: state.json ? 'final-json' : 'stable-planning-text', sources: ['AI đang chuẩn bị nội dung và ảnh.'] };
  };
  const image = { get complete() { return state.loaded; }, get naturalWidth() { return state.loaded ? 1024 : 0; }, get naturalHeight() { return state.loaded ? 768 : 0; } };
  const images = () => ({ signature: state.image ? 'new-image' : '', images: state.image
    ? [{ key: 'new-image', url: 'https://chatgpt.com/backend-api/estuary/content?id=fixture', image, rawResponse: 'Generated illustration' }] : [] });
  const config = { snapshot, images, parse: () => state.json ? { idMatched: true, data: { id: 32, language: 'vi', content_html: '<p>Final</p>' } } : null,
    input: async () => { state.inputs.push(state.time); return {}; },
    fill: (_input, prompt) => state.fills.push({ time: state.time, prompt }),
    send: async () => { state.sends.push(state.time); return true; }, sendReady: () => ({}) };
  context.probe.configure(config);
  return { api: context.probe, state, config, context };
}
const expected = { sourceType: 'handbook', id: 32, language: 'vi' };
const baseline = { node: null, id: '', count: 0, signature: '', sources: [] };
const imageBaseline = { signature: '', images: [], keys: new Set() };

test('handbook waits beyond 15s for image generation and loaded final pixels, without typing JSON retry', async () => {
  const h = harness(s => { s.busy = s.time < 24000; s.image = s.time >= 24000; s.loaded = s.time >= 28800; });
  const result = await h.api.waitForResponse(baseline, 'handbook-32', 60000, expected, { imagePrevious: imageBaseline });
  assert.ok(result.directImage);
  assert.ok(h.state.time >= 28800);
  assert.equal(h.state.reads.some(time => time < 24000), false, 'do not parse the unfinished answer while tool controls remain active');
  assert.deepEqual(h.state.fills, []);
  assert.deepEqual(h.state.sends, []);
});

test('one missing progress poll during long image generation never triggers malformed JSON retry', async () => {
  const h = harness(s => { s.busy = s.time < 24000; s.gap = s.time === 16800; s.image = s.loaded = s.time >= 24000; });
  const result = await h.api.waitForResponse(baseline, 'handbook-32', 60000, expected, { imagePrevious: imageBaseline });
  assert.ok(result.directImage);
  assert.deepEqual(h.state.fills, []);
  assert.deepEqual(h.state.sends, []);
});

test('valid early handbook JSON is not accepted while AI still generates its illustrations', async () => {
  const h = harness(s => { s.json = true; s.busy = s.time < 24000; });
  const result = await h.api.waitForResponse(baseline, 'handbook-32', 45000, expected);
  assert.equal(result.data.id, 32);
  assert.ok(h.state.time >= 27200);
  assert.equal(h.state.reads.some(time => time < 24000), false);
});

test('a ready first illustration does not finish the turn while a second fresh image is loading', async () => {
  const h = harness(s => { s.busy = s.time < 24000; s.loaded = s.time >= 32000; });
  const loaded = { complete: true, naturalWidth: 1024, naturalHeight: 768 };
  const loading = { get complete() { return h.state.loaded; }, get naturalWidth() { return h.state.loaded ? 1024 : 0; }, get naturalHeight() { return h.state.loaded ? 768 : 0; } };
  h.api.configure({ ...h.config, images: () => ({ signature: 'two-images', images: [
    { key: 'first', image: loaded }, { key: 'second', image: loading }
  ] }) });
  const result = await h.api.waitForResponse(baseline, 'handbook-32', 60000, expected, { imagePrevious: imageBaseline });
  assert.equal(result.directImage.key, 'second');
  assert.ok(h.state.time >= 35200, 'all final image bytes settle before requesting JSON');
  assert.deepEqual(h.state.fills, []);
});

test('format follow-up waits for idle before filling composer, and identifies the handbook ID', async () => {
  const h = harness(s => { s.busy = s.time < 24000; });
  await h.api.requestJsonFormatRetry('handbook-32', expected, 'run-32', baseline);
  assert.equal(h.state.fills.length, 1);
  assert.ok(h.state.fills[0].time >= 27200);
  assert.match(h.state.fills[0].prompt, /ID 32/);
  assert.doesNotMatch(h.state.fills[0].prompt, /\[object Object\]/);
  assert.equal(h.state.sends.length, 1);
  assert.ok(h.state.sends[0] > h.state.fills[0].time);
});

test('a truly idle malformed response still gets one formatting request then accepts corrected JSON', async () => {
  const h = harness(s => { s.busy = false; });
  h.api.configure({ ...h.config, retry: async () => {
    h.state.retries.push(h.state.time); h.state.json = true;
    return { id: 'planning', count: 1, signatureHash: 'old' };
  } });
  const result = await h.api.waitForResponse(baseline, 'handbook-32', 45000, expected);
  assert.equal(result.data.id, 32);
  assert.equal(h.state.retries.length, 1);
  assert.ok(h.state.retries[0] >= 15000);
});

test('download-only reply gets one formatting retry, then accepts corrected inline JSON without reading a file', async () => {
  const h = harness(s => { s.busy = false; });
  const corrected = { id: 32, language: 'vi', content_html: '<p>Full content after formatting retry</p>' };
  h.api.configure({ ...h.config,
    snapshot: () => ({ node: {}, id: h.state.json ? 'final' : 'download', count: h.state.json ? 2 : 1,
      signature: h.state.json ? 'final-json' : 'download-only', sources: [h.state.json
        ? '```json\n' + JSON.stringify(corrected) + '\n```'
        : 'Đã tạo bài viết. [Tải JSON hoàn chỉnh](sandbox:/mnt/data/medreview-32.json)'] }),
    parse: (snapshot, id) => h.api.parseOriginal(snapshot, id),
    retry: async (_articleId, id) => {
      const prompt = h.api.jsonFormatRetryPrompt(id);
      assert.match(prompt, /Không dùng link tải\/file JSON thay block/);
      h.state.retries.push(h.state.time); h.state.json = true;
      return { id: 'download', count: 1, signatureHash: 'old' };
    }
  });
  const result = await h.api.waitForResponse(baseline, 'handbook-32', 45000, expected);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), corrected);
  assert.equal(h.state.retries.length, 1);
  assert.ok(h.state.retries[0] >= 15000);
});

test('final matching JSON wins over an already loaded generated illustration', async () => {
  const h = harness(s => { s.busy = false; s.image = s.loaded = s.json = true; });
  const result = await h.api.waitForResponse(baseline, 'handbook-32', 45000, expected, { imagePrevious: imageBaseline });
  assert.equal(result.data.id, 32);
  assert.equal(result.directImage, undefined);
  assert.equal(result.responseSnapshot.id, 'final');
  assert.deepEqual(h.state.sends, []);
});

test('same-ID JSON from the previous turn does not suppress new-image handling', async () => {
  const h = harness(s => { s.busy = false; s.image = s.loaded = true; });
  const old = { node: {}, id: 'old', count: 1, signature: 'old-json', sources: ['old-json'] };
  h.api.configure({ ...h.config, snapshot: () => old, parse: () => ({ idMatched: true, data: { id: 32 } }) });
  const result = await h.api.waitForResponse(old, 'handbook-32', 45000, expected, { imagePrevious: imageBaseline });
  assert.ok(result.directImage);
  assert.deepEqual(h.state.sends, []);
});

test('compact JSON waits for attachments in its own response snapshot', async () => {
  const h = harness(s => { s.busy = false; s.json = true; });
  const node = {};
  const compact = { id: 32, language: 'vi', content_html: '<img src="link1">', image_files: [{ key: 'link1' }] };
  h.context.MedReviewHandbookFiles = { ready(data, scope) { assert.equal(data.id, 32); assert.equal(scope, node); return h.state.time >= 12000; } };
  h.api.configure({ ...h.config,
    snapshot: () => ({ node, id: 'final', count: 2, signature: h.state.time < 12000 ? 'json-files-pending' : 'json-files-ready', sources: ['compact-json'] }),
    parse: () => ({ idMatched: true, data: compact })
  });
  const result = await h.api.waitForResponse(baseline, 'handbook-32', 45000, expected);
  assert.equal(result.responseSnapshot.node, node);
  assert.ok(h.state.time >= 15200);
  assert.deepEqual(h.state.sends, []);
});

test('missing attachments get one reattachment request then fail without returning a payload', async () => {
  const h = harness(s => { s.busy = false; s.json = true; });
  const compact = { id: 32, language: 'vi', content_html: '<img src="link1">', image_files: [{ key: 'link1' }] };
  h.context.MedReviewHandbookFiles = { ready: () => false };
  h.api.configure({ ...h.config,
    snapshot: () => ({ node: {}, id: h.state.retries.length ? 'retry' : 'final', count: h.state.retries.length + 1, signature: h.state.retries.length ? 'retry-json' : 'first-json', sources: ['compact-json'] }),
    parse: () => ({ idMatched: true, data: compact }),
    retry: async () => { h.state.retries.push(h.state.time); return { id: 'final', count: 1, signatureHash: 'old' }; }
  });
  await assert.rejects(h.api.waitForResponse(baseline, 'handbook-32', 60000, expected), /thiếu file/);
  assert.equal(h.state.retries.length, 1);
});

test('format follow-up watches Send readiness instead of failing while the composer is disabled', async () => {
  const h = harness(s => { s.busy = s.time < 24000; });
  h.api.configure({ ...h.config, sendReady: () => h.state.time >= 40000 ? {} : null });
  await h.api.requestJsonFormatRetry('handbook-32', expected, 'run-32', baseline);
  assert.equal(h.state.sends.length, 1);
  assert.ok(h.state.sends[0] >= 43200);
});

test('cancel while waiting for image completion does not fill or send the composer', async () => {
  let h;
  h = harness(s => { if (s.time >= 1600) h.api.cancel('handbook-32'); });
  await assert.rejects(h.api.requestJsonFormatRetry('handbook-32', expected, 'run-32', baseline), /Đã dừng/);
  assert.deepEqual(h.state.fills, []);
  assert.deepEqual(h.state.sends, []);
});
