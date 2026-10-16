const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');

// Synthetic 1x1 fixture shared by the existing handbook tests; no user payload.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/VlsAAAAASUVORK5CYII=';
const originalBytes = Buffer.from(png.split(',')[1], 'base64');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const origin = 'https://chatgpt.com';
const url = `${origin}/backend-api/estuary/content?id=current-file`;
const descriptor = (key = 'link1', extra = {}) => ({ key, filename: `${key}_base64.txt`, mime: 'image/png', bytes: originalBytes.length, sha256: sha256(originalBytes), ...extra });
const data = (extra = {}) => ({ id: 32, language: 'vi', title: 'Chủ đề', excerpt: 'Tóm tắt', seo_title: 'Chủ đề', seo_description: 'Mô tả',
  content_html: '<figure><img src="link1" alt="Minh hoạ AI"></figure>',
  sources_json: [{ url: 'https://www.who.int/health-topics', title: 'Nguồn chính thức' }], image_files: [descriptor()], ...extra });
const job = { handbook_id: 32, language: 'vi' };
const isFileError = cause => Boolean(cause?.handbookError);

function element(attrs = {}, extra = {}) {
  return { attrs, isConnected: true, disabled: false, hidden: false, textContent: '',
    getAttribute(name) { return this.attrs[name] ?? null; },
    getClientRects() { return this.isConnected && !this.hidden ? [{}] : []; },
    ...extra };
}
function anchor(filename = 'link1_base64.txt', href = url, attrs = {}) {
  return element({ href, download: filename, ...attrs }, { href, textContent: filename });
}
function previewButton(filename = 'link1_base64.txt', attrs = {}) {
  return element({ 'aria-label': `Mở bản xem trước của ${filename}`, ...attrs }, { click() {} });
}
function responseRoot({ anchors = [], buttons = [], id = 'current-message', nested = [], user = false, semantic = true } = {}) {
  const owner = element(semantic ? { 'data-chatgpt-selection-message-id': id, 'data-message-author-role': 'assistant' } : {}, {
    tagName: 'DIV', nodeType: 1,
    closest(selector) { return semantic ? this : null; },
    matches(selector) { return false; },
    querySelector(selector) { return user && /user/.test(selector) ? element({ 'data-message-author-role': 'user' }) : null; },
    querySelectorAll(selector) {
      if (selector === '[data-chatgpt-selection-message-id]') return nested;
      if (selector === 'a[href]') return anchors;
      if (selector === 'button[aria-label]') return buttons;
      if (selector === 'a[href], button[aria-label]') return [...anchors, ...buttons];
      return [];
    }
  });
  owner.contains = node => node === owner || anchors.includes(node) || buttons.includes(node);
  return owner;
}
function load(settings = {}) {
  const fetched = [], decoded = [], clock = { now: 0 };
  const doc = settings.document || { querySelectorAll: () => [] };
  const wait = async ms => { clock.now += ms; await settings.onWait?.(ms, clock); };
  const decodeImage = settings.decodeImage || (async blob => {
    decoded.push({ type: blob.type, bytes: Buffer.from(await blob.arrayBuffer()) });
    return { width: 1, height: 1, close() {} };
  });
  const fetch = async (target, options) => {
    fetched.push({ url: String(target), options });
    return settings.fetch ? settings.fetch(target, options) : new Response(png, { headers: { 'content-type': 'text/plain' } });
  };
  const context = vm.createContext({ URL, Blob, atob, btoa, TextDecoder, AbortController, setTimeout, clearTimeout,
    location: { origin, hostname: 'chatgpt.com' }, document: doc, fetch, crypto: webcrypto, createImageBitmap: decodeImage,
    Date: class extends Date { static now() { return clock.now; } } });
  for (const file of ['handbook.js', 'handbook-files.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return { F: context.MedReviewHandbookFiles, H: context.MedReviewHandbook, fetched, decoded, clock,
    settings: { origin, document: doc, provider: 'chatgpt', fetch, crypto: webcrypto, decodeImage, wait } };
}

test('manifest requires a one-to-one, bounded filename/key/MIME/byte/hash mapping', () => {
  const { F, H } = load();
  assert.equal(F.manifest(data()).length, 1);
  assert.equal(F.hasReferences(data()), true);
  assert.equal(F.hasReferences({ content_html: `<img src="${png}">` }), false);
  assert.equal(F.hasReferences({ content_html: `<img data-src="link1" src="${png}">` }), false, 'metadata is not the actual src attribute');
  const badEntries = [
    { key: 'link2' }, { filename: '/mnt/data/link1_base64.txt' }, { filename: 'other.txt' },
    { mime: 'image/svg+xml' }, { mime: 'image/gif' }, { bytes: 0 }, { bytes: true }, { bytes: '68' },
    { bytes: H.limits.imageBytes + 1 }, { sha256: 'A'.repeat(64) }, { sha256: 'a'.repeat(63) }, { sha256: null }
  ];
  for (const change of badEntries) assert.throws(() => F.manifest(data({ image_files: [descriptor('link1', change)] })), isFileError, JSON.stringify(change));
  for (const files of [null, {}, [], [descriptor(), descriptor()]]) {
    assert.throws(() => F.manifest(data({ image_files: files })), isFileError);
  }
  assert.throws(() => F.manifest(data({ content_html: '<img src="link1"><img src="link2">', image_files: [descriptor(), descriptor()] })), isFileError);
  assert.throws(() => F.manifest(data({ content_html: '<img src="link1"><img src="link2"><img src="link3">',
    image_files: [1, 2, 3].map(n => descriptor(`link${n}`, { bytes: H.limits.imageBytes })) })), /12 MiB/);
});

test('file references are browser-only and final API validation rejects the intermediate manifest', () => {
  const { H } = load();
  assert.equal(H.validate(job, data(), { allowFileRefs: true }).length, 1);
  assert.throws(() => H.validate(job, data()), /image_files|TXT/);
  assert.throws(() => H.validate(job, data({ content_html: `<img src="${png}">` })), /image_files|TXT/);
  const missing = data(); delete missing.image_files;
  assert.throws(() => H.validate(job, missing), isFileError);
});

test('binding uses only the current semantic reply, never the document or another turn', async () => {
  const old = responseRoot({ anchors: [anchor()], id: 'old-message' });
  const current = responseRoot();
  const ctx = load({ document: { querySelectorAll: () => [old] } });
  assert.equal(ctx.F.ready(data(), current), false);
  await assert.rejects(ctx.F.resolve(data(), { ...ctx.settings, node: current }), isFileError);
  assert.equal(ctx.fetched.length, 0);
  assert.equal(ctx.F.root(responseRoot({ semantic: false })), null, 'bare code containers cannot broaden to main/document');
  assert.equal(ctx.F.root(responseRoot({ user: true })), null, 'a wrapper spanning user turns is not a safe reply');
  assert.equal(ctx.F.root(responseRoot({ nested: [old] })), null, 'a wrapper spanning multiple message IDs is not a safe reply');
  assert.equal(ctx.F.ready(data(), responseRoot({ anchors: [anchor('other_base64.txt')] })), false);
});

test('prefixed preview names bind the exact actual filename rather than its bare suffix', () => {
  const { F } = load();
  for (const name of ['link1_base64.txt', 'medreview32_link1_base64.txt']) {
    const node = responseRoot({ buttons: [previewButton(name)] });
    assert.equal(F.bindings(data(), node).get('link1').name, name);
    assert.equal(F.ready(data(), node), true);
  }
  assert.equal(F.ready(data(), responseRoot({ buttons: [previewButton('medreview31_link1_base64.txt')] })), false);
});

test('loading or disabled file cards are not ready and attachment signatures track readiness', () => {
  const { F } = load();
  const button = previewButton();
  const node = responseRoot({ buttons: [button] });
  const complete = F.signature(node);
  button.attrs['aria-busy'] = 'true';
  assert.equal(F.ready(data(), node), false);
  assert.notEqual(F.signature(node), complete);
  delete button.attrs['aria-busy']; button.disabled = true;
  assert.equal(F.ready(data(), node), false);
  button.disabled = false; button.attrs['aria-disabled'] = 'true';
  assert.equal(F.ready(data(), node), false);
  delete button.attrs['aria-disabled'];
  assert.equal(F.ready(data(), node), true);
  const link = anchor(); link.attrs['aria-busy'] = 'true';
  assert.equal(F.ready(data(), responseRoot({ anchors: [link] })), false);
});

test('ambiguous duplicate attachment candidates are rejected instead of choosing a file', () => {
  const { F } = load();
  assert.throws(() => F.bindings(data(), responseRoot({ anchors: [anchor(), anchor('link1_base64.txt', `${url}-other`)] })), /nhiều file/);
  assert.throws(() => F.bindings(data(), responseRoot({ buttons: [previewButton(), previewButton()] })), /nhiều file/);
});

test('only observed provider attachment locations are eligible for downloading TXT files', () => {
  const { F } = load();
  for (const target of [url, `${origin}/backend-api/files/file-1/download`, 'https://files.oaiusercontent.com/file-1.txt?sig=real', `blob:${origin}/real-file`]) {
    assert.equal(F.safeUrl(target, origin).href, target);
  }
  for (const target of ['https://evil.example/link1_base64.txt', 'https://oaiusercontent.com.evil.example/file.txt',
    'http://chatgpt.com/files/link1_base64.txt', 'https://127.0.0.1/files/link1_base64.txt',
    `${origin}/logout`, `${origin}:444/files/link1_base64.txt`, `${url}#fragment`,
    'https://user:password@chatgpt.com/files/link1_base64.txt', 'sandbox:/mnt/data/link1_base64.txt',
    'javascript:alert(1)', 'data:text/plain,not-an-attachment', 'blob:https://evil.example/file']) {
    assert.throws(() => F.safeUrl(target, origin), isFileError, target);
  }
});

test('TXT bytes, canonical BASE64, original-image metadata and raster are verified before use', async () => {
  const ctx = load();
  assert.equal(await ctx.F.verify(`\uFEFF  ${png}\n`, descriptor(), ctx.settings), png);
  assert.equal(ctx.decoded.length, 1);
  assert.equal(ctx.decoded[0].type, 'image/png');
  assert.deepEqual(ctx.decoded[0].bytes, originalBytes);
  for (const [text, entry] of [
    [png, descriptor('link1', { bytes: originalBytes.length - 1 })],
    [png, descriptor('link1', { mime: 'image/webp' })],
    [png, descriptor('link1', { sha256: '0'.repeat(64) })],
    [png.replace(/I=$/, 'J='), descriptor()],
    [png.slice(0, -4), descriptor()],
    [`\`\`\`\n${png}\n\`\`\``, descriptor()],
    [JSON.stringify({ base64: png }), descriptor()]
  ]) await assert.rejects(ctx.F.verify(text, entry, ctx.settings), isFileError);
  assert.equal(ctx.decoded.length, 1, 'metadata/canonical/hash failures never reach raster decoding');
  const brokenWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([100, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
  await assert.rejects(ctx.F.verify(`data:image/webp;base64,${brokenWebp.toString('base64')}`, descriptor('link1', {
    mime: 'image/webp', bytes: brokenWebp.length, sha256: sha256(brokenWebp)
  }), ctx.settings), /WebP/);
});

test('raster decode failures and unsafe decoded dimensions are rejected and bitmaps are closed', async () => {
  for (const dimensions of [null, { width: 0, height: 1 }, { width: 8193, height: 1 }, { width: 4000, height: 4000 }]) {
    let closes = 0;
    const ctx = load({ decodeImage: async () => dimensions && ({ ...dimensions, close() { closes++; } }) });
    await assert.rejects(ctx.F.verify(png, descriptor(), ctx.settings), isFileError);
    assert.equal(closes, dimensions ? 1 : 0);
  }
  const ctx = load({ decodeImage: async () => { throw new Error('invalid raster'); } });
  await assert.rejects(ctx.F.verify(png, descriptor(), ctx.settings), /raster/);
});

test('resolve inserts exact verified bytes only into img src and strips the intermediate manifest', async () => {
  const ctx = load();
  const input = data({ content_html: '<p>link1 stays prose</p><img data-src="link1" src="link1" alt="link1"><img src="https://images.example.org/real.webp">' });
  const result = await ctx.F.resolve(input, { ...ctx.settings, node: responseRoot({ anchors: [anchor()] }) });
  assert.equal(result.content_html, input.content_html.replace('src="link1" alt=', `src="${png}" alt=`));
  assert.equal(Object.hasOwn(result, 'image_files'), false);
  assert.equal(Object.hasOwn(input, 'image_files'), true, 'the original compact payload is not mutated');
  assert.equal(result.title, input.title);
  assert.equal(ctx.H.validate(job, result).length, 2);
  assert.equal(ctx.fetched.length, 1);
  assert.equal(ctx.fetched[0].options.credentials, 'include');
  assert.equal(ctx.fetched[0].options.redirect, 'error');
  assert.equal(ctx.fetched[0].options.referrerPolicy, 'no-referrer');
  assert.equal(ctx.fetched[0].options.headers, undefined, 'never forward MedReview API credentials to a provider attachment');
});

test('asset downloads omit credentials and provider download_url responses remain constrained', async () => {
  const asset = 'https://files.oaiusercontent.com/file-1.txt?sig=current';
  const ctx = load({ fetch: async target => String(target) === url ? new Response(JSON.stringify({ download_url: asset })) : new Response(png) });
  await ctx.F.resolve(data(), { ...ctx.settings, node: responseRoot({ anchors: [anchor()] }) });
  assert.equal(ctx.fetched[1].url, asset);
  assert.equal(ctx.fetched[1].options.credentials, 'omit');
  const hostile = load({ fetch: async () => new Response(JSON.stringify({ download_url: 'https://evil.example/private.txt' })) });
  await assert.rejects(hostile.F.resolve(data(), { ...hostile.settings, node: responseRoot({ anchors: [anchor()] }) }), isFileError);
  assert.equal(hostile.fetched.length, 1, 'an unsafe resolver target is never fetched');
});

test('duplicate image hashes cannot inflate the requested image count', async () => {
  const ctx = load();
  const input = data({ content_html: '<img src="link1"><img src="link2">', image_files: [descriptor(), descriptor('link2')] });
  const node = responseRoot({ anchors: [anchor(), anchor('link2_base64.txt', `${url}-2`)] });
  await assert.rejects(ctx.F.resolve(input, { ...ctx.settings, node }), /trùng/);
});

test('oversized streamed TXT is stopped before decoding and its reader is cancelled', async () => {
  let cancelled = false;
  const ctx = load({ fetch: async () => ({ ok: true, headers: { get: () => null }, body: { getReader() {
    return { async read() { return { done: false, value: { byteLength: 8 * 1024 * 1024 } }; }, async cancel() { cancelled = true; } };
  } } }) });
  await assert.rejects(ctx.F.resolve(data(), { ...ctx.settings, node: responseRoot({ anchors: [anchor()] }) }), /giới hạn/);
  assert.equal(cancelled, true);
  assert.equal(ctx.decoded.length, 0);
});

test('aborted file resolution never fetches and an in-flight abort never yields an API payload', async () => {
  const controller = new AbortController(); controller.abort();
  const ctx = load();
  await assert.rejects(ctx.F.resolve(data(), { ...ctx.settings, signal: controller.signal, node: responseRoot({ anchors: [anchor()] }) }), /dừng/);
  assert.equal(ctx.fetched.length, 0);
  const mid = new AbortController();
  const pending = load({ fetch: async () => { mid.abort(); return new Response(png); } });
  await assert.rejects(pending.F.resolve(data(), { ...pending.settings, signal: mid.signal, node: responseRoot({ anchors: [anchor()] }) }), /dừng/);
});

function previewHarness({ initialText = png, existingPanel = false } = {}) {
  let closed = 0, clicked = 0, waits = 0;
  const filename = 'medreview32_link1_base64.txt';
  const panel = element({ 'aria-label': filename, 'data-tab-id': `chatgpt-file:conversation:current-message:1:${filename}` }, { text: initialText,
    querySelector() { return { click() { closed++; panel.isConnected = false; } }; } });
  const doc = {
    active: existingPanel ? [panel] : [],
    querySelectorAll() { return this.active; },
    createTreeWalker(target) {
      let index = -1;
      const nodes = [{ textContent: target.text, parentElement: { closest: () => null } }];
      return { currentNode: null, nextNode() { this.currentNode = nodes[++index]; return Boolean(this.currentNode); } };
    }
  };
  const button = previewButton(filename);
  button.click = () => { clicked++; doc.active = [panel]; };
  const ctx = load({ document: doc, onWait() { waits++; panel.text = png; } });
  return { ...ctx, node: responseRoot({ buttons: [button] }), panel,
    stats: () => ({ clicked, closed, waits }) };
}

test('current ChatGPT resource cards resolve through their exact prefixed file preview and close only that viewer', async () => {
  const ctx = previewHarness();
  const output = await ctx.F.resolve(data(), { ...ctx.settings, node: ctx.node });
  assert.equal(output.content_html.includes(png), true);
  assert.deepEqual(ctx.stats(), { clicked: 1, closed: 1, waits: 0 });
  assert.equal(ctx.fetched.length, 0, 'resource cards do not guess private download APIs');
});

test('a hydrating TXT preview is allowed to finish before size/hash verification', async () => {
  const ctx = previewHarness({ initialText: 'data:image/png;base64,iVBORw0KGgo' });
  const output = await ctx.F.resolve(data(), { ...ctx.settings, node: ctx.node });
  assert.equal(output.content_html.includes(png), true);
  assert.ok(ctx.stats().waits >= 1);
  assert.equal(ctx.stats().closed, 1);
});

test('an existing user-owned preview is neither replaced nor closed during attachment resolution', async () => {
  const ctx = previewHarness({ existingPanel: true });
  await assert.rejects(ctx.F.resolve(data(), { ...ctx.settings, node: ctx.node }), /Đóng bản xem trước/);
  assert.equal(ctx.stats().clicked, 0);
  assert.equal(ctx.stats().closed, 0);
  assert.equal(ctx.panel.isConnected, true);
});

test('switching the viewer during TXT loading does not read or close the user-selected file', async () => {
  const ctx = previewHarness({ initialText: 'Đang tải' });
  await assert.rejects(ctx.F.resolve(data(), { ...ctx.settings, node: ctx.node, async wait(ms) {
    ctx.panel.attrs['aria-label'] = 'another-file.txt';
    ctx.panel.attrs['data-tab-id'] = 'user-selected-file';
    await ctx.settings.wait(ms);
  } }), /đổi file/);
  assert.equal(ctx.stats().closed, 0);
  assert.equal(ctx.panel.isConnected, true);
  assert.equal(ctx.decoded.length, 0);
});
