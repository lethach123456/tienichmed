const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const doctor = { id: "tab-505:doctor-12", sourceType: "doctor", doctor_id: 12, name: "BS. Nguyễn Văn An", title: "BS. Nguyễn Văn An" };
const researched = {
  id: 12, name: doctor.name, subtitle: "Bác sĩ chuyên khoa", content: "<p>Hồ sơ có nguồn</p>",
  practice_license_json: null, education_json: [{ institution: "Trường Y", degree: "Bác sĩ", source_ids: ["s1"] }],
  sources_json: [{ id: "s1", url: "https://hospital.example/doctor", title: "Hồ sơ", publisher: null, accessed_at: "2026-10-02" }],
  evidence_json: { identity_status: "matched", missing_fields: [], conflicts: [] },
  locations_json: [{ facility_id: null, facility_name: "Bệnh viện", fees_json: [{ amount_min: null, amount_max: null }] }],
  insufficient_data: false, future_field: { values: [null, 0, false, ""], nested: { status: null } }
};
const fenced = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function loadContent(hostname = "grok.com", overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__doctorContentTests = { expectedArticleId, promptForProvider, jsonMatchesExpectedId,
      parseAssistantResponse, responseHasJsonCodeBlock, jsonFormatRetryPrompt, expectedJsonKey,
      latestAssistantResponse, waitForResponse };
  }`);
  const context = vm.createContext({
    location: { hostname, pathname: hostname === "gemini.google.com" ? "/spark/chat/current" : "/" },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    setTimeout, clearTimeout, ...overrides
  });
  vm.runInContext(source, context, { filename: "content.js" });
  return context.__doctorContentTests;
}

test("doctor research identity is distinct from doctor translation and facility jobs", () => {
  const api = loadContent();
  assert.deepEqual(plain(api.expectedArticleId(doctor)), { sourceType: "doctor", id: 12, name: doctor.name });
  assert.deepEqual(plain(api.expectedArticleId({ sourceType: "translation", type: "doctor", source_id: 12 })), {
    sourceType: "translation", type: "doctor", source_id: 12
  });
  assert.equal(api.expectedArticleId({ sourceType: "facility", facility_id: 12 }), 12);
});

test("doctor prompts remain verbatim on all providers without appending private article metadata", () => {
  const prompt = "Prompt bác sĩ từ API\nChỉ trả một block JSON đầy đủ.\n";
  for (const hostname of ["grok.com", "chatgpt.com", "claude.ai", "gemini.google.com"]) {
    const api = loadContent(hostname);
    const output = api.promptForProvider(prompt, { ...doctor, writer_claim_token: "PRIVATE-TOKEN", apiKey: "PRIVATE-KEY" });
    assert.equal(output, prompt);
    assert.doesNotMatch(output, /PRIVATE-TOKEN|PRIVATE-KEY|QUY ĐỊNH ĐỊNH DẠNG BẮT BUỘC/);
  }
});

test("doctor JSON requires a positive JSON integer and the exact queue name", () => {
  const api = loadContent();
  const expected = api.expectedArticleId(doctor);
  assert.equal(api.jsonMatchesExpectedId(researched, expected), true);
  for (const candidate of [
    { ...researched, id: "12" }, { ...researched, id: 12.5 }, { ...researched, id: 0 },
    { ...researched, id: -12 }, { ...researched, id: 13 }, { ...researched, name: doctor.name + " " },
    { ...researched, name: "Bác sĩ cùng ID khác tên" }, [researched], { items: [researched] }
  ]) assert.equal(api.jsonMatchesExpectedId(candidate, expected), false);
  assert.equal(api.jsonMatchesExpectedId(researched, { ...expected, name: undefined }), false);
  assert.equal(api.jsonMatchesExpectedId(researched, { ...expected, id: "12" }), false);
});

test("doctor code-block parsing preserves the entire payload including nulls and future fields", () => {
  const api = loadContent();
  const result = api.parseAssistantResponse({ sources: [fenced(researched)] }, api.expectedArticleId(doctor));
  assert.equal(result.idMatched, true);
  assert.deepEqual(plain(result.data), researched);
  assert.equal(api.responseHasJsonCodeBlock({ sources: [fenced(researched)] }, api.expectedArticleId(doctor)), true);
});

test("insufficient-data research with null content is still a complete matching doctor result", () => {
  const api = loadContent();
  const insufficient = { ...researched, content: null, insufficient_data: true,
    evidence_json: { identity_status: "insufficient", missing_fields: ["identity"], conflicts: [] }, notes_for_editor: "Chưa đủ bằng chứng." };
  const result = api.parseAssistantResponse({ sources: [fenced(insufficient)] }, api.expectedArticleId(doctor));
  assert.equal(result.idMatched, true);
  assert.deepEqual(plain(result.data), insufficient);
});

test("doctor parser refuses direct prose JSON, multiple JSON blocks and array/envelope submissions", () => {
  const api = loadContent();
  const expected = api.expectedArticleId(doctor);
  const other = { ...researched, id: 13 };
  for (const text of [JSON.stringify(researched), `${fenced(researched)}\n${fenced(other)}`, fenced([researched]),
    fenced({ items: [researched] }), "```json\n{\"id\":12,\n```", "```javascript\n" + JSON.stringify(researched) + "\n```"]) {
    const parsed = api.parseAssistantResponse({ sources: [text] }, expected);
    assert.equal(Boolean(parsed?.idMatched), false);
  }
  // Multiple source representations of one reply must not count as extra blocks.
  assert.equal(api.parseAssistantResponse({ sources: [fenced(researched), fenced(researched)] }, expected).idMatched, true);
});

test("doctor identity cache includes exact name and cannot reuse another doctor's same-ID match", () => {
  const api = loadContent();
  const expected = api.expectedArticleId(doctor);
  const renamed = { ...expected, name: "BS. Trần Văn Bình" };
  assert.notEqual(api.expectedJsonKey(expected), api.expectedJsonKey(renamed));
  const snapshot = { sources: [fenced(researched)] };
  assert.equal(api.parseAssistantResponse(snapshot, expected).idMatched, true);
  assert.equal(api.parseAssistantResponse(snapshot, renamed).idMatched, false);
});

test("doctor formatting retry identifies the correct person without private claim data", () => {
  const api = loadContent();
  const expected = { ...api.expectedArticleId(doctor), writer_claim_token: "PRIVATE-TOKEN" };
  const prompt = api.jsonFormatRetryPrompt(expected);
  assert.match(prompt, /ID 12/);
  assert.ok(prompt.includes(JSON.stringify(doctor.name)));
  assert.match(prompt, /số nguyên JSON dương/);
  assert.doesNotMatch(prompt, /PRIVATE-TOKEN|\[object Object\]/);
});

test("doctor result uses a rendered code block without reading or scrolling offscreen ChatGPT text", () => {
  const api = loadContent("chatgpt.com");
  const code = { textContent: JSON.stringify(researched), querySelector: () => null };
  const pre = { textContent: "JSON header", querySelector: () => code, contains: (element) => element === code };
  const node = {
    querySelectorAll: () => [pre, code],
    get innerText() { throw new Error("Must not force layout"); },
    scrollIntoView() { throw new Error("Must not scroll"); }
  };
  const snapshot = { node, sources: ["clipped preview"] };
  const result = api.parseAssistantResponse(snapshot, api.expectedArticleId(doctor));
  assert.equal(result.idMatched, true);
  assert.deepEqual(plain(result.data), researched);
});

test("doctor response watcher waits for stable matching fenced JSON and provider completion", async () => {
  const state = { time: 0, nodes: [], generating: true };
  const reply = { textContent: "", innerText: "", querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, getAttribute: () => "doctor-response", getClientRects: () => [{}],
    cloneNode() { return { textContent: reply.textContent, querySelectorAll: () => [] }; } };
  const stop = { getClientRects: () => [{}] };
  const api = loadContent("grok.com", {
    Date: class extends Date { static now() { return state.time; } },
    getComputedStyle: () => ({ visibility: "visible" }),
    document: { querySelector: () => null, querySelectorAll: (selector) => selector.includes("button[")
      ? state.generating ? [stop] : [] : state.nodes },
    setTimeout(callback, ms) {
      state.time += ms; state.nodes = [reply];
      reply.textContent = reply.innerText = state.time < 1600 ? "```json\n{\"id\":12," : fenced(researched);
      state.generating = state.time < 6400;
      queueMicrotask(callback); return state.time;
    }
  });
  const before = api.latestAssistantResponse();
  const result = await api.waitForResponse(before, doctor.id, 12000, api.expectedArticleId(doctor));
  assert.deepEqual(plain(result.data), researched);
  assert.ok(state.time >= 6400);
});
