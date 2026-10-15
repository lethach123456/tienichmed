const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "background.js"), "utf8");
function loadWorker(configPresent) {
  let context;
  const imports = [];
  context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
      storage: { local: { async get() { return {}; }, async set() {} } } },
    importScripts(file) {
      imports.push(file);
      if (!configPresent) throw new Error("private config missing");
      context.MEDREVIEW_MEDICAL_API_KEY = "test-private-installation-key";
    }, URL, setTimeout, clearTimeout
  });
  vm.runInContext(source + "\nglobalThis.__configuredKey = MEDICAL_API_KEY;", context);
  return { key: context.__configuredKey, imports };
}

test("worker loads the installation-only private key without embedding a fallback credential", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.notEqual(manifest.background.type, "module", "importScripts requires a classic service worker");
  assert.deepEqual(loadWorker(true), { key: "test-private-installation-key", imports: ["api-key.local.js", "handbook.js"] });
  assert.deepEqual(loadWorker(false), { key: "", imports: ["api-key.local.js", "handbook.js"] });
  assert.doesNotMatch(source, /["']X-Medical-Api-Key["']\s*:\s*["'][^"']+["']/);
});

test("private key file is Git-ignored and the distributed example has an empty key", () => {
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^\/api-key\.local\.js$/m);
  const example = fs.readFileSync(path.join(root, "api-key.example.js"), "utf8");
  assert.match(example, /MEDREVIEW_MEDICAL_API_KEY\s*=\s*""/);
});
