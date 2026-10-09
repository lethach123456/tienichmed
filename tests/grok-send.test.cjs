const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("Grok send control gets one native click, never a second synthetic click", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8").replace(/}\s*$/, `
    globalThis.__test = { provider: PROVIDER, triggerButtonClick };
  }`);
  const api = vm.createContext({
    location: { hostname: "grok.com" },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document: { querySelector: () => null, querySelectorAll: () => [], body: null },
    getComputedStyle: () => ({ visibility: "visible" })
  });
  vm.runInContext(source, api, { filename: "content.js" });

  let clicks = 0;
  const dispatched = [];
  const button = {
    focus() {},
    click() { clicks += 1; },
    dispatchEvent(event) { dispatched.push(event.type); return true; },
    closest() { return null; }
  };

  assert.equal(api.__test.provider, "grok");
  assert.equal(api.__test.triggerButtonClick(button), true);
  assert.equal(clicks, 1, "one prompt must produce at most one send activation");
  assert.deepEqual(dispatched, [], "Grok must not receive a synthetic click before the native click");
});
