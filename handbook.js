// Shared contract helpers. No credentials, remote code, or provider UI scraping.
(() => {
  if (globalThis.MedReviewHandbook) return;
  const MiB = 1024 * 1024;
  const limits = { images: 4, imageBytes: 5 * MiB, totalBytes: 12 * MiB, bodyBytes: 24 * MiB };
  const error = (code, message) => Object.assign(new Error(message), { code, handbookError: true });
  const bytes = (text) => new Blob([text]).size;
  function httpUrl(value) {
    try {
      const url = new URL(value);
      return typeof value === "string" && /^https?:\/\//i.test(value) && !/\s|[<>]/.test(value) &&
        ["https:", "http:"].includes(url.protocol) && !url.username && !url.password &&
        ![...url.searchParams.keys()].some((key) => /^(?:token|api[_-]?key|access[_-]?token|signature|auth)$/i.test(key));
    } catch { return false; }
  }
  // Shape checks only. Never fetch arbitrary remote illustrations from a
  // provider tab: the receiver resolves/pins public DNS and validates bytes.
  function imageHttpUrl(value) {
    if (typeof value !== "string" || !value || value.length > 8000 ||
        /[\s\u0000-\u001f\u007f\\<>"']|%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) return false;
    const source = value.replace(/&(?:amp|#0*38|#x0*26);/gi, "&");
    if (!httpUrl(source) || source.includes("#")) return false;
    let url;
    try { url = new URL(source); } catch { return false; }
    if (url.port) return false; // WHATWG strips only the protocol's default port.
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const authority = source.match(/^https?:\/\/([^/?#]+)/i)?.[1] || "";
    const rawHost = authority.replace(/:\d+$/, "").toLowerCase();
    // Literal IPv6 is conservatively left unsupported in the browser, including
    // mapped private IPv4. Normal public hostnames may still resolve to IPv6.
    if (!host.includes(".") || host.includes(":") || rawHost.includes("%") ||
        !/^[a-z0-9.-]+$/i.test(rawHost) ||
        /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(host) ||
        host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
    if (/^\d+(?:\.\d+){3}$/.test(host)) {
      if (rawHost !== host) return false; // Reject decimal/octal/hex IP spellings.
      const [a, b, c] = host.split(".").map(Number);
      if ([0, 10, 127].includes(a) || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
          a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
          a === 192 && (b === 0 && [0, 2].includes(c) || b === 88 && c === 99 || b === 168) ||
          a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return false;
    }
    if ([...url.searchParams.keys()].some((key) => /^(?:key|api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|auth|authorization|signature)$/i.test(key))) return false;
    if (/(?:^|\.)(?:placeholder\.com|placehold\.co|placehold\.it|dummyimage\.com)$/.test(host) ||
        /(?:^|[\/_-])placeholder(?:[\/_.-]|$)/i.test(url.pathname)) return false;
    return true;
  }
  function imageData(uri) {
    const match = typeof uri === "string" && uri.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length % 4) throw error("missing_images", "Ảnh Cẩm nang cần PNG/JPEG/WebP BASE64 đầy đủ hoặc URL HTTP(S) ảnh công khai trực tiếp; không URL tạm/placeholder.");
    const length = match[2].length * 3 / 4 - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
    if (!length || length > limits.imageBytes) throw error("image_too_large", "Mỗi ảnh Cẩm nang tối đa 5 MiB sau giải mã.");
    let header;
    try { header = atob(match[2].slice(0, 32)); } catch { throw error("missing_images", "BASE64 ảnh không hợp lệ."); }
    const magic = match[1] === "png" ? header.startsWith("\x89PNG\r\n\x1a\n") : match[1] === "jpeg"
      ? header.startsWith("\xff\xd8\xff") : header.startsWith("RIFF") && header.slice(8, 12) === "WEBP";
    if (!magic) throw error("image_mime_mismatch", "MIME ảnh Cẩm nang không khớp bytes file thật.");
    return { length, mime: `image/${match[1]}` };
  }
  function imageTags(html) {
    return [...String(html || "").matchAll(/<img\b[^>]*>/gi)].map((tag) => {
      const source = tag[0].match(/(?:^|\s)src\s*=\s*(["'])(.*?)\1/is);
      if (!source) throw error("missing_images", "Mỗi thẻ img phải có src trong dấu nháy chứa ảnh thật.");
      return { tag: tag[0], uri: source[2], index: tag.index };
    });
  }
  function validate(job, result, { allowPlaceholders = false, allowFileRefs = false } = {}) {
    if (!result || typeof result !== "object" || Array.isArray(result) ||
        !Number.isSafeInteger(result.id) || result.id !== Number(job.handbook_id) || result.language !== job.language) {
      throw error("identity_mismatch", "JSON Cẩm nang phải đúng id nguyên và language của chủ đề đang nhận.");
    }
    for (const [field, max] of [["title", 160], ["excerpt", 1200], ["seo_title", 160], ["seo_description", 300]]) {
      if (typeof result[field] !== "string" || !result[field].trim() || [...result[field]].length > max) {
        throw error("invalid_payload", `${field} Cẩm nang cần chuỗi không rỗng, tối đa ${max} ký tự.`);
      }
    }
    if (typeof result.content_html !== "string" || !result.content_html.trim() || /<\/?(?:html|body|script|iframe|form|style|h1)\b/i.test(result.content_html)) {
      throw error("invalid_html", "Cẩm nang cần HTML fragment có nội dung, không script, CSS, iframe hoặc document wrapper.");
    }
    if (!Array.isArray(result.sources_json) || result.sources_json.length < 1 || result.sources_json.length > 12 ||
        result.sources_json.some((source) => !httpUrl(source?.url) || typeof source.title !== "string" || !source.title.trim())) {
      throw error("invalid_sources", "Cẩm nang cần 1–12 nguồn thật có url HTTP(S) và title, không token riêng tư.");
    }
    for (const field of ["claim_token", "writer_claim_token", "request_id", "source_revision", "status", "slug", "category_id"]) {
      if (Object.hasOwn(result, field)) throw error("protected_field", `AI không được gửi trường vận hành Cẩm nang: ${field}.`);
    }
    if (!allowFileRefs && Object.hasOwn(result, "image_files")) throw error("unresolved_image_files", "Phải đọc file TXT, xác minh ảnh và loại image_files trước gửi API.");
    const tags = imageTags(result.content_html);
    if (!tags.length || tags.length > limits.images) throw error("missing_images", "Cẩm nang cần 1–4 ảnh minh hoạ AI thật (nên 2 ảnh).");
    const unique = new Set();
    let total = 0;
    for (const image of tags) {
      if (allowPlaceholders && /^handbook-image:[1-4]$/.test(image.uri)) continue;
      if (allowFileRefs && /^link[1-4]$/.test(image.uri)) continue;
      if (/^https?:\/\//i.test(image.uri)) {
        if (!imageHttpUrl(image.uri)) throw error("invalid_image_url", "URL ảnh Cẩm nang cần HTTP(S) công khai trực tiếp, không nội bộ, token, URL tạm hay placeholder.");
        continue;
      }
      const info = imageData(image.uri);
      if (!unique.has(image.uri)) { unique.add(image.uri); total += info.length; }
    }
    if (total > limits.totalBytes) throw error("image_too_large", "Tổng ảnh riêng biệt Cẩm nang tối đa 12 MiB.");
    if (bytes(JSON.stringify(result)) > limits.bodyBytes) throw error("payload_too_large", "JSON Cẩm nang vượt giới hạn 24 MiB.");
    return tags;
  }
  function payload(job, result) {
    validate(job, result);
    if (!job.writer_claim_token || !job.writer_claim_request_id || !/^[a-f0-9]{64}$/.test(job.source_revision || "")) {
      throw error("missing_claim", "Cẩm nang thiếu quyền giữ bài, mã yêu cầu hoặc revision; không nhận khóa mới để gửi JSON cũ.");
    }
    const body = { ...result, claim_token: job.writer_claim_token, request_id: job.writer_claim_request_id, source_revision: job.source_revision };
    if (bytes(JSON.stringify(body)) > limits.bodyBytes) throw error("payload_too_large", "Request Cẩm nang vượt giới hạn 24 MiB.");
    return body;
  }
  function safeError(cause) {
    const text = String(cause?.message || cause || "Không xử lý được Cẩm nang.");
    return text.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[dữ liệu ảnh đã ẩn]").slice(0, 700);
  }
  function compact(result, response) {
    const { id, title, language, excerpt, seo_title, seo_description, sources_json } = result;
    return { id, title, language, excerpt, seo_title, seo_description, sources_json,
      status: response?.status || "draft", images: response?.images || [], images_count: response?.images_count || 0 };
  }
  let database;
  const db = () => database || (database = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(error("payload_storage_unavailable", "Không mở được IndexedDB để giữ bài Cẩm nang; chưa gửi hoặc bỏ dữ liệu."));
    const request = indexedDB.open("medreview-handbook-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("payloads");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(error("payload_storage_unavailable", "Không lưu được dữ liệu Cẩm nang trong IndexedDB.")); };
  }));
  async function transaction(mode, action) {
    const connection = await db();
    return new Promise((resolve, reject) => {
      const tx = connection.transaction("payloads", mode);
      const request = action(tx.objectStore("payloads"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(error("payload_storage_unavailable", "Lỗi kho payload Cẩm nang; dữ liệu chưa được xác nhận lưu."));
    });
  }
  const store = {
    put: (id, value) => transaction("readwrite", (table) => table.put(value, id)),
    get: (id) => transaction("readonly", (table) => table.get(id)),
    remove: (id) => transaction("readwrite", (table) => table.delete(id))
  };
  globalThis.MedReviewHandbook = { limits, error, bytes, httpUrl, imageHttpUrl, imageData, imageTags, validate, payload, compact, safeError, store };
})();
