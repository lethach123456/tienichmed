const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Only exercise local prompt construction/parsing: no provider, browser or API calls.
function load(hostname = 'chatgpt.com') {
  const context = vm.createContext({
    location: { hostname, pathname: '/app' },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    setTimeout, clearTimeout,
    fetch() { throw new Error('Download links must not be fetched'); }
  });
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8').replace(/}\s*$/, `
    globalThis.probe = { handbookInlineJsonRules, handbookJsonAfterImagesPrompt,
      promptForProvider, jsonFormatRetryPrompt, parseAssistantResponse, expectedArticleId };
  }`);
  vm.runInContext(source, context);
  return context.probe;
}
const article = { sourceType: 'handbook', handbook_id: 32, language: 'vi' };
function repeatedContract(api, prompt) {
  const rules = api.handbookInlineJsonRules();
  assert.ok(prompt.startsWith(rules), 'inline contract leads the prompt');
  assert.ok(prompt.endsWith(rules), 'inline contract closes the prompt');
  for (const literal of ['```json', 'file .json', 'Tải JSON hoàn chỉnh', 'sandbox:/mnt/data', 'Canvas', 'artifact', 'File ẢNH thật', 'không rút gọn nội dung/BASE64',
    'BASE64 đầy đủ HOẶC link HTTP(S) công khai trực tiếp', 'API sẽ tải, kiểm tra, nén và lưu cả hai dạng ảnh trên hosting']) {
    assert.ok(rules.includes(literal), `contract includes ${literal}`);
  }
}

for (const hostname of ['chatgpt.com', 'gemini.google.com', 'grok.com', 'claude.ai']) {
  test(`handbook initial prompt repeats inline JSON contract on ${hostname}`, () => {
    const api = load(hostname);
    const serverPrompt = 'Chủ đề: niềng răng Đà Nẵng. Schema và nội dung server phải giữ nguyên.';
    const prompt = api.promptForProvider(serverPrompt, article);
    repeatedContract(api, prompt);
    assert.ok(prompt.includes(serverPrompt));
    assert.doesNotMatch(prompt, /claim_token|source_revision|request_id/);
    assert.equal(api.promptForProvider(serverPrompt, { sourceType: 'doctor' }), serverPrompt);
    assert.equal(api.promptForProvider(serverPrompt, { sourceType: 'translation' }), serverPrompt);
  });
}

test('post-image prompt retains exact bound image slots and rejects JSON-download substitution', () => {
  const api = load();
  for (const count of [1, 2, 4]) {
    const prompt = api.handbookJsonAfterImagesPrompt(article, count);
    repeatedContract(api, prompt);
    assert.ok(prompt.includes(`id 32, language vi`));
    assert.ok(prompt.includes(`src="handbook-image:1" đến src="handbook-image:${count}"`));
    assert.ok(prompt.includes('không tạo lại ảnh'));
    assert.ok(prompt.includes('Không trả file JSON, link tải'));
  }
});

test('format retry explicitly corrects download-only replies and preserves numeric ID/language', () => {
  const api = load();
  const expected = api.expectedArticleId(article);
  const prompt = api.jsonFormatRetryPrompt(expected);
  repeatedContract(api, prompt);
  assert.match(prompt, /ID 32/);
  assert.match(prompt, /language chính xác là "vi"/);
  assert.match(prompt, /kể cả khi đã tạo file JSON ở phản hồi trước/);
  assert.doesNotMatch(prompt, /\[object Object\]/);
  assert.ok(!api.jsonFormatRetryPrompt(32).includes('ĐẦU RA CẨM NANG'), 'non-handbook retry unchanged');
});

test('download-only JSON links are not an inline answer and never trigger file fetches', () => {
  const api = load();
  for (const href of ['sandbox:/mnt/data/medreview-32.json', 'https://example.org/article.json']) {
    const text = `Đã tạo bài viết MedReview ID 32. [Tải JSON hoàn chỉnh](${href}). JSON có content_html và ảnh BASE64 thật.`;
    assert.equal(api.parseAssistantResponse({ sources: [text] }, api.expectedArticleId(article)), null);
  }
});

test('corrected single fenced JSON preserves full HTML and BASE64 exactly', () => {
  const api = load();
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/VlsAAAAASUVORK5CYII=';
  const result = { id: 32, language: 'vi', title: 'Niềng răng Đà Nẵng',
    content_html: `<h2>Thông tin</h2><p>${'Nội dung đầy đủ. '.repeat(100)}</p><figure><img src="${image}" alt="Minh hoạ AI"></figure>`,
    sources_json: [{ url: 'https://www.who.int/health-topics', title: 'WHO' }] };
  const raw = JSON.stringify(result);
  const parsed = api.parseAssistantResponse({ sources: ['```json\n' + raw + '\n```'] }, api.expectedArticleId(article));
  assert.equal(parsed.idMatched, true);
  assert.equal(parsed.rawResponse, raw);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.data)), result);
});
