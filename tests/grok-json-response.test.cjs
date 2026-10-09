const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Observed Grok DOM: response-UUID > div[data-testid=assistant-message]
// with one shiki pre > code. The inner test id is not a response identity.
function grokReply(uuid, data, order) {
  const text = JSON.stringify(data);
  const code = { textContent: text, innerText: text };
  const pre = { textContent: text, innerText: text, querySelector: () => code };
  const reply = {
    textContent: text, innerText: text, order: order + 1,
    getAttribute(name) { return name === "data-testid" ? "assistant-message" : name === "aria-label" ? "Grok" : null; },
    getClientRects: () => [{}],
    closest(selector) {
      if (selector === "[id^='response-']") return root;
      return selector.includes("[data-testid*='assistant']") ? reply : null;
    },
    querySelector: () => null,
    querySelectorAll(selector) { return selector === "pre" ? [pre] : selector.startsWith("pre, code") ? [pre, code] : []; },
    cloneNode() { return { textContent: text, querySelectorAll: () => [] }; },
    compareDocumentPosition(other) { return reply.order < other.order ? 4 : 2; }
  };
  const root = {
    id: `response-${uuid}`, textContent: text, innerText: text, order,
    getAttribute: () => null, getClientRects: () => [{}], closest: () => null,
    querySelector: () => null, querySelectorAll: () => [reply],
    compareDocumentPosition(other) { return root.order < other.order ? 4 : 2; }
  };
  return { root, reply };
}

function loadContent(turns) {
  const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__grokJsonTests = { latestAssistantResponse, parseAssistantResponse };
  }`);
  const context = vm.createContext({
    location: { hostname: "grok.com" },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document: { querySelectorAll(selector) {
      if (selector === "[id^='response-']") return turns.map((turn) => turn.root);
      if (selector === "[data-testid='assistant-message']" || selector === "[id^='response-'] [data-testid*='assistant']") return turns.map((turn) => turn.reply);
      return [];
    } },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    setTimeout, clearTimeout
  });
  vm.runInContext(source, context, { filename: "content.js" });
  return context.__grokJsonTests;
}

test("Grok response identity uses the unique UUID instead of the repeated assistant-message test id", () => {
  const data = { id: 86, images_revision: "revision", inspected_images: [], notes: "complete" };
  const turns = [grokReply("original", data, 0)];
  const api = loadContent(turns);
  const original = api.latestAssistantResponse();
  assert.equal(original.id, "response-original");
  // A formatting follow-up can repeat the exact same JSON. Its content alone
  // cannot distinguish it, but its response wrapper UUID must distinguish it.
  turns.push(grokReply("follow-up", data, 2));
  const latest = api.latestAssistantResponse();
  assert.equal(latest.id, "response-follow-up");
  assert.notEqual(latest.id, original.id);
  assert.equal(latest.signature, original.signature);
  const parsed = api.parseAssistantResponse(latest, { sourceType: "facility_image_fix", id: 86, images_revision: "revision" });
  assert.equal(parsed.idMatched, true);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.data)), data);
});
