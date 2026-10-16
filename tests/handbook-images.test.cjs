const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/VlsAAAAASUVORK5CYII=';
const remote = 'https://images.example.org/illustration.webp?width=1280';
const article = { id: 'handbook-9', sourceType: 'handbook', handbook_id: 9, language: 'vi', runToken: 'run-one' };
const result = html => ({ id: 9, language: 'vi', title: 'Chủ đề', excerpt: 'Tóm tắt', seo_title: 'Chủ đề', seo_description: 'Mô tả',
  content_html: html, sources_json: [{ url: 'https://www.who.int/health-topics', title: 'Nguồn chính thức' }] });

function load({ decode = true, files = false } = {}) {
  const fetched = [], generated = [], resolvedFiles = [];
  const context = vm.createContext({ URL, Blob, atob, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    ...(files ? { MedReviewHandbookFiles: { hasReferences: data => 'image_files' in data, async resolve(data, options) {
      resolvedFiles.push(options);
      const result = { ...data, content_html: data.content_html.replace('src="link1"', `src="${png}"`) };
      delete result.image_files;
      return result;
    } } } : {}),
    location: { hostname: 'chatgpt.com', pathname: '/' },
    chrome: { runtime: { onMessage: { addListener() {} }, async sendMessage() { return { ok: true }; } } },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    async fetch(url) {
      fetched.push(url);
      assert.ok(String(url).startsWith('data:image/'), 'never fetch a remote illustration in provider tab');
      return { async blob() { return new Blob([Buffer.from(String(url).split(',')[1], 'base64')], { type: 'image/png' }); } };
    },
    async createImageBitmap() { return decode ? { width: 1, height: 1, close() {} } : null; },
    FileReader: class {
      async readAsDataURL(blob) {
        this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
        this.onload();
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../handbook.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8').replace(/}\s*$/, `
    globalThis.probe = { prepareHandbookOutput, setGenerated(fn) { fetchGeneratedImageBlob = fn; } };
  }`);
  vm.runInContext(source, context);
  context.probe.setGenerated(async image => {
    generated.push(image.url);
    return { blob: new Blob([Buffer.from(png.split(',')[1], 'base64')], { type: 'image/png' }), mimeType: 'image/png' };
  });
  return { api: context.probe, fetched, generated, resolvedFiles };
}

test('handbook preparation passes matching response scope and cancellation into file resolver, then final-validates resolved output', async () => {
  const ctx = load({ files: true });
  const node = {};
  const original = { ...result('<img src="link1"><img src="https://images.example.org/direct.webp">'), image_files: [{ key: 'link1' }] };
  const prepared = await ctx.api.prepareHandbookOutput(article, original, null, { node });
  assert.equal(ctx.resolvedFiles.length, 1);
  assert.equal(ctx.resolvedFiles[0].node, node);
  assert.equal(ctx.resolvedFiles[0].provider, 'chatgpt');
  assert.equal(ctx.resolvedFiles[0].signal.aborted, false);
  assert.equal('image_files' in prepared, false);
  assert.equal(prepared.content_html, original.content_html.replace('src="link1"', `src="${png}"`));
  assert.deepEqual(ctx.fetched, [png]);
});

test('mixed handbook output pixel-decodes only BASE64 and leaves public URL untouched for API', async () => {
  const ctx = load();
  const original = result(`<h2>Minh hoạ</h2><img src="${remote}"><img src="${png}">`);
  assert.equal(await ctx.api.prepareHandbookOutput(article, original, null), original);
  assert.deepEqual(ctx.fetched, [png]);
  assert.deepEqual(ctx.generated, []);
});

test('public image links alone never request cross-origin images from AI tab', async () => {
  const ctx = load();
  const original = result(`<img src="${remote}"><img src="http://cdn.example.org/another-image">`);
  assert.equal(await ctx.api.prepareHandbookOutput(article, original, null), original);
  assert.deepEqual(ctx.fetched, []);
});

test('invalid BASE64 still blocks mixed output instead of bypassing decode via public image', async () => {
  const ctx = load({ decode: false });
  await assert.rejects(ctx.api.prepareHandbookOutput(article, result(`<img src="${remote}"><img src="${png}">`), null), /giải mã/);
  assert.deepEqual(ctx.fetched, [png]);
});

test('unsafe public-image-shaped URL fails before any image fetching', async () => {
  const ctx = load();
  await assert.rejects(ctx.api.prepareHandbookOutput(article, result(`<img src="http://[::ffff:127.0.0.1]/image.png"><img src="${png}">`), null), /URL/);
  assert.deepEqual(ctx.fetched, []);
});

test('bound generated-image slot still becomes actual BASE64 alongside untouched public link', async () => {
  const ctx = load();
  const original = result(`<img data-src="untrusted-metadata" src="handbook-image:1" alt="Minh hoạ AI"><img src="${remote}">`);
  const output = await ctx.api.prepareHandbookOutput(article, original, { bound: [{ url: 'https://provider.invalid/generated-current-turn.png' }] });
  assert.equal(output.content_html, original.content_html.replace('handbook-image:1', png));
  assert.deepEqual(ctx.generated, ['https://provider.invalid/generated-current-turn.png']);
  assert.deepEqual(ctx.fetched, [png]);
});
