// Browser-only attachment transport. Never post file references to MedReview.
(() => {
  if (globalThis.MedReviewHandbookFiles) return;
  const fail = (message) => Object.assign(new Error(message), { code: "handbook_image_file", handbookError: true });
  const maxText = Math.ceil(5 * 1024 * 1024 / 3) * 4 + 128;
  const check = (signal) => { if (signal?.aborted) throw fail("Đã dừng đọc file ảnh Cẩm nang; chưa gửi bài."); };
  const attr = (node, name) => String(node?.getAttribute?.(name) || "");
  const fileName = (value) => {
    try { return decodeURIComponent(String(value).split(/[?#]/)[0].split("/").at(-1)); } catch { return ""; }
  };
  function hasReferences(data) {
    return Object.hasOwn(data || {}, "image_files") || MedReviewHandbook.imageTags(data?.content_html).some(t => /^link[1-4]$/.test(t.uri));
  }
  function manifest(data) {
    const tags = MedReviewHandbook.imageTags(data?.content_html);
    const refs = new Set(tags.filter(t => /^link[1-4]$/.test(t.uri)).map(t => t.uri));
    const files = data?.image_files;
    if (!Array.isArray(files) || !refs.size || files.length !== refs.size || files.length > 4) {
      throw fail("JSON cần image_files khớp đúng từng src=linkN và file linkN_base64.txt của câu trả lời hiện tại.");
    }
    const seen = new Set();
    let total = 0;
    for (const entry of files) {
      if (!entry || !refs.has(entry.key) || seen.has(entry.key) || entry.filename !== `${entry.key}_base64.txt` ||
          !["image/png", "image/jpeg", "image/webp"].includes(entry.mime) ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MedReviewHandbook.limits.imageBytes ||
          typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw fail("image_files cần mã/tên file duy nhất, MIME PNG/JPEG/WebP, bytes và SHA-256 thật của bytes ảnh gốc.");
      }
      total += entry.bytes;
      seen.add(entry.key);
    }
    if (total > MedReviewHandbook.limits.totalBytes) throw fail("Tổng ảnh Cẩm nang tối đa 12 MiB.");
    return files;
  }
  function root(node) {
    if (!node) return null;
    const owner = node.closest?.("[data-chatgpt-selection-message-id]") || node.closest?.("[data-message-author-role='assistant'], article, section[data-testid^='conversation-turn'], model-response, [id^='response-']");
    if (!owner || /^(?:HTML|BODY|MAIN)$/i.test(owner.tagName || "") || owner.nodeType === 9 ||
        owner.matches?.("[data-message-author-role='user'], [data-role='user']") ||
        owner.querySelector?.("[data-message-author-role='user'], [data-role='user']")) return null;
    const ids = new Set([attr(owner, "data-chatgpt-selection-message-id"), ...[...owner.querySelectorAll("[data-chatgpt-selection-message-id]")].map(n => attr(n, "data-chatgpt-selection-message-id"))].filter(Boolean));
    if (ids.size > 1) return null;
    return owner;
  }
  function bindings(data, node) {
    const owner = root(node);
    if (!owner || owner.isConnected === false) throw fail("Không còn câu trả lời chứa file ảnh; mở đúng cuộc trò chuyện rồi kiểm tra lại.");
    const found = new Map();
    for (const entry of manifest(data)) {
      const names = [entry.filename, `medreview${data.id}_${entry.filename}`];
      const urls = new Set();
      for (const link of owner.querySelectorAll("a[href]")) {
        const href = attr(link, "href");
        if (attr(link, "aria-busy") !== "true" && attr(link, "aria-disabled") !== "true" && [attr(link, "download"), attr(link, "title"), String(link.textContent || "").trim(), fileName(href)].some(n => names.includes(n))) {
          if (/^(?:https?:|blob:|\/)/i.test(href)) urls.add(link.href || href);
        }
      }
      const previews = [...owner.querySelectorAll("button[aria-label]")].filter(button => {
        if (button.disabled || attr(button, "aria-busy") === "true" || attr(button, "aria-disabled") === "true") return false;
        const label = attr(button, "aria-label");
        return names.some(name => label === `Mở bản xem trước của ${name}` || label === `Open preview of ${name}` || label === `Preview ${name}`);
      });
      if (urls.size > 1 || previews.length > 1) throw fail(`Có nhiều file ${entry.filename} khác nhau trong cùng câu trả lời; chưa tự chọn file.`);
      if (previews.length) found.set(entry.key, { button: previews[0], name: names.find(name => ["Mở bản xem trước của ", "Open preview of ", "Preview "].some(prefix => attr(previews[0], "aria-label") === prefix + name)), entry });
      else if (urls.size) found.set(entry.key, { url: [...urls][0], entry });
    }
    return found;
  }
  function ready(data, node) {
    try { return bindings(data, node).size === manifest(data).length; } catch { return false; }
  }
  function signature(node) {
    const owner = root(node);
    return [...(owner?.querySelectorAll?.("a[href], button[aria-label]") || [])]
      .filter(n => /link[1-4]_base64\.txt/.test([attr(n, "href"), attr(n, "download"), attr(n, "aria-label"), n.textContent].join(" ")))
      .map(n => [attr(n, "href"), attr(n, "download"), attr(n, "aria-label"), attr(n, "aria-busy"), String(Boolean(n.disabled)), attr(n, "aria-disabled")].join("|")).join("\n").slice(0, 16000);
  }
  function safeUrl(value, origin) {
    let url;
    try { url = new URL(value, origin); } catch { throw fail("Link tải file ảnh không hợp lệ."); }
    const page = new URL(origin);
    if (url.protocol === "blob:" && url.origin === page.origin) return url;
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw fail("Link tải file ảnh không an toàn.");
    const same = url.origin === page.origin;
    const path = /\/(?:backend-api\/(?:files|estuary)|api\/(?:files|attachments)|files|attachments|download)\//i.test(url.pathname) || /\.txt$/i.test(url.pathname);
    const asset = /^(?:[a-z0-9-]+\.)*(?:oaiusercontent\.com|usercontent\.google\.com|googleusercontent\.com|claudeusercontent\.com)$/.test(url.hostname);
    if (!(same && path) && !asset) throw fail("Chỉ đọc file đính kèm từ máy chủ AI của câu trả lời hiện tại; không tải TXT từ URL tùy ý.");
    return url;
  }
  async function readBounded(response, limit, signal) {
    if (!response.ok || Number(response.headers?.get?.("content-length")) > limit) throw fail("File ảnh tải lỗi hoặc vượt giới hạn.");
    if (!response.body?.getReader) {
      const text = await response.text();
      if (new Blob([text]).size > limit) throw fail("File TXT ảnh vượt giới hạn.");
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "", size = 0;
    try {
      while (true) {
        check(signal);
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw fail("File TXT ảnh vượt giới hạn.");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  }
  async function download(url, options, depth = 0) {
    check(options.signal);
    if (depth > 2) throw fail("Link tải file ảnh chuyển hướng quá nhiều.");
    const target = safeUrl(url, options.origin);
    const same = target.origin === new URL(options.origin).origin;
    const response = await options.fetch(target.href, { signal: options.signal, credentials: same ? "include" : "omit", redirect: "error", referrerPolicy: "no-referrer" });
    const text = await readBounded(response, maxText, options.signal);
    if (text.trim().startsWith("{")) {
      let data;
      try { data = JSON.parse(text); } catch { throw fail("Máy chủ AI không trả file TXT hợp lệ."); }
      if (typeof data.download_url !== "string") throw fail("Chưa lấy được link tải file TXT từ máy chủ AI.");
      return download(data.download_url, options, depth + 1);
    }
    return text;
  }
  function visible(node) { return node?.isConnected !== false && !node?.hidden && (!node.getClientRects || node.getClientRects().length > 0); }
  async function preview(binding, options) {
    if (options.provider !== "chatgpt") throw fail("Provider này chưa có link tải TXT có thể đọc; hãy đính kèm file TXT thật trong câu trả lời.");
    const doc = options.document;
    const panels = () => [...doc.querySelectorAll("[role='tabpanel'][data-app-shell-tab-panel-controller='right']")].filter(visible);
    // Do not replace or close a viewer that the user already owns.
    if (panels().length) throw fail("Đóng bản xem trước file đang mở rồi bấm kiểm tra lại để đọc file ảnh Cẩm nang.");
    check(options.signal);
    if (binding.button.isConnected === false) throw fail("Thẻ file TXT không còn trên câu trả lời hiện tại.");
    binding.button.click();
    let opened = null, openedTabId = "";
    try {
      const start = Date.now();
      while (Date.now() - start < 20000) {
        check(options.signal);
        const currentPanels = panels();
        const matches = currentPanels.filter(p => attr(p, "aria-label") === binding.name);
        if (matches.length > 1) throw fail("Bản xem trước file TXT không rõ ràng.");
        if (opened && (!matches.includes(opened) || attr(opened, "data-tab-id") !== openedTabId)) throw fail("Bản xem trước đã đổi file; chưa gửi bài, hãy kiểm tra lại.");
        if (!opened && currentPanels.length && !matches.length) throw fail("Đang mở file khác trong trình xem; chưa gửi bài.");
        if (matches.length && !opened) { opened = matches[0]; openedTabId = attr(opened, "data-tab-id"); }
        if (opened) {
          let text = "";
          const walk = doc.createTreeWalker(opened, 4);
          while (walk.nextNode()) {
            const current = walk.currentNode;
            if (current.parentElement?.closest("header, button, [role='button'], script, style, nav")) continue;
            text += current.textContent;
            if (text.length > maxText + 1000) throw fail("File TXT ảnh vượt giới hạn.");
          }
          // The viewer title can appear once before its plain-text content.
          text = text.trim();
          if (text.startsWith(binding.name)) text = text.slice(binding.name.length).trim();
          const expectedLength = `data:${binding.entry.mime};base64,`.length + Math.ceil(binding.entry.bytes / 3) * 4;
          if (text.startsWith("data:image/") && text.length >= expectedLength) return text;
        }
        await options.wait(200);
      }
      throw fail(`Chưa đọc được ${binding.entry.filename}; file có thể chưa tạo xong hoặc đã hết hạn.`);
    } finally {
      if (opened && visible(opened) && attr(opened, "aria-label") === binding.name && attr(opened, "data-tab-id") === openedTabId) {
        const close = opened.querySelector("button[aria-label='Đóng trình xem'], button[aria-label='Close viewer']");
        close?.click();
        const closingAt = Date.now();
        while (visible(opened) && Date.now() - closingAt < 3000) await options.wait(100);
      }
    }
  }
  async function verify(text, entry, options) {
    if (typeof text !== "string" || text.length > maxText) throw fail("File TXT ảnh vượt giới hạn.");
    const uri = String(text).replace(/^\uFEFF/, "").trim();
    const info = MedReviewHandbook.imageData(uri);
    if (info.length !== entry.bytes || info.mime !== entry.mime) throw fail(`${entry.filename}: MIME/số bytes không khớp ảnh gốc; chưa gửi bài.`);
    const encoded = uri.split(",")[1];
    let binary;
    try { binary = atob(encoded); } catch { throw fail("File TXT không chứa BASE64 hoàn chỉnh."); }
    if (btoa(binary) !== encoded) throw fail("File TXT có BASE64 không chuẩn hoặc đã bị thay đổi.");
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    if (entry.mime === "image/webp" && new DataView(bytes.buffer).getUint32(4, true) + 8 !== bytes.length) throw fail("WebP bị cắt hoặc sai độ dài file.");
    const hash = [...new Uint8Array(await options.crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
    if (hash !== entry.sha256) throw fail(`${entry.filename}: SHA-256 không khớp bytes ảnh gốc; cần tạo lại file, không chép BASE64 qua chat.`);
    check(options.signal);
    let bitmap;
    try { bitmap = await options.decodeImage(new Blob([bytes], { type: entry.mime })); } catch { throw fail("Không giải mã được raster ảnh từ TXT."); }
    try {
      if (!bitmap?.width || !bitmap.height || bitmap.width * bitmap.height > 12000000 || Math.max(bitmap.width, bitmap.height) > 8192) throw fail("Ảnh TXT bị hỏng hoặc vượt giới hạn kích thước.");
    } finally { bitmap?.close?.(); }
    return uri;
  }
  async function resolve(data, settings = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    settings.signal?.addEventListener("abort", abort, { once: true });
    if (settings.signal?.aborted) abort();
    const timer = setTimeout(abort, 60000);
    const options = { origin: globalThis.location?.origin, document: globalThis.document, provider: "", fetch: globalThis.fetch?.bind(globalThis),
      crypto: globalThis.crypto, decodeImage: globalThis.createImageBitmap?.bind(globalThis), wait: ms => new Promise(r => setTimeout(r, ms)), ...settings, signal: controller.signal };
    try {
      const files = manifest(data), bound = bindings(data, settings.node);
      if (bound.size !== files.length) throw fail("Thiếu link tải hoặc thẻ file TXT của chính câu trả lời hiện tại; chưa gửi bài.");
      if (!options.crypto?.subtle || !options.decodeImage) throw fail("Trình duyệt chưa hỗ trợ kiểm tra hash/giải mã ảnh; chưa gửi bài.");
      const replacements = new Map(), hashes = new Set();
      for (const entry of files) {
        check(options.signal);
        const binding = bound.get(entry.key);
        const text = binding.url ? await download(binding.url, options) : await preview(binding, options);
        const uri = await verify(text, entry, options);
        if (hashes.has(entry.sha256)) throw fail("Các mã ảnh trùng cùng một file; cần ảnh minh hoạ khác nhau.");
        hashes.add(entry.sha256);
        replacements.set(entry.key, uri);
      }
      let html = data.content_html;
      for (const tag of MedReviewHandbook.imageTags(html).reverse()) {
        if (!replacements.has(tag.uri)) continue;
        const replacement = tag.tag.replace(/((?:^|\s)src\s*=\s*)(["'])(.*?)\2/is, (_m, prefix, quote) => `${prefix}${quote}${replacements.get(tag.uri)}${quote}`);
        html = html.slice(0, tag.index) + replacement + html.slice(tag.index + tag.tag.length);
      }
      check(options.signal);
      const result = { ...data, content_html: html };
      delete result.image_files;
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw fail("Đã dừng hoặc quá thời gian đọc file TXT ảnh; chưa gửi bài.");
      throw error;
    } finally { clearTimeout(timer); settings.signal?.removeEventListener("abort", abort); }
  }
  globalThis.MedReviewHandbookFiles = { hasReferences, manifest, root, bindings, ready, signature, safeUrl, verify, resolve };
})();
