const $ = (id) => document.getElementById(id);
const PAGE_PARAMS = new URLSearchParams(location.search);
const PROVIDERS = ["chatgpt", "grok", "claude", "gemini"];
// Image generation depends on the provider being able to create and expose a
// generated image URL to the extension.  Text/Toplist jobs remain available
// on every provider in PROVIDERS.
const AI_IMAGE_PROVIDERS = ["chatgpt", "grok"];
const EMBEDDED = window.top !== window || PAGE_PARAMS.get("embedded") === "1";
if (EMBEDDED) document.documentElement.classList.add("embedded");
if (EMBEDDED && PAGE_PARAMS.get("spark") === "1") document.documentElement.classList.add("spark-panel");
// Keep the runner dark by default, whether it is opened as the embedded panel
// or from Chrome's extension popup. `theme=light` remains an explicit opt-in.
document.documentElement.classList.add(PAGE_PARAMS.get("theme") === "light" ? "light-theme" : "dark-theme");
let state = { items: [], runner: { active: false } };
let runCountdownTimer = null;
let apiStatusTimer = null;
let systemNoticeTimer = null;
let systemHistoryReference = null;
let queueLayoutKey = "";
let resultLayoutKey = "";
let apiLayoutKey = "";
let apiElapsedUpdaters = [];
let viewerRequestId = 0;
const queueRows = new Map();
const resultRows = new Map();
const apiRows = new Map();
const hasSavedResult = (item) => Boolean(item?.result || item?.has_result);
function syncRows(parent, rows, registry, ids) {
  for (const key of registry.keys()) if (!ids.has(key)) registry.delete(key);
  if (!parent.insertBefore || !parent.removeChild) { parent.innerHTML = ""; rows.forEach((row) => parent.append(row)); return; }
  const wanted = new Set(rows);
  for (const child of [...parent.children]) if (!wanted.has(child)) parent.removeChild(child);
  rows.forEach((row, index) => { if (parent.children[index] !== row) parent.insertBefore(row, parent.children[index] || null); });
}
let panelContext = {
  embedded: EMBEDDED,
  targetTabId: Number.isInteger(Number(PAGE_PARAMS.get("tabId"))) && Number(PAGE_PARAMS.get("tabId")) > 0
    ? Number(PAGE_PARAMS.get("tabId"))
    : null,
  provider: PROVIDERS.includes(PAGE_PARAMS.get("provider")) ? PAGE_PARAMS.get("provider") : "",
  supported: false
};
const API_SETTINGS = {
  facilitiesUrl: "https://medreview.vn/api/medical/facilities-needing-content.php?page=1&limit=1&type=facility",
  updateUrl: "https://medreview.vn/api/medical/facility-content-update.php",
  doctorsUrl: "https://medreview.vn/api/medical/doctors-needing-content.php?page=1&limit=25",
  doctorUpdateUrl: "https://medreview.vn/api/medical/doctor-content-update.php",
  doctorContentUrl: "https://medreview.vn/api/medical/doctor-content.php",
  handbooksUrl: "https://medreview.vn/api/medical/handbooks-needing-content.php?limit=10&language=vi",
  handbookUpdateUrl: "https://medreview.vn/api/medical/handbook-content-update.php",
  toplistsUrl: "https://medreview.vn/api/medical/toplists-needing-members.php?page=1&limit=1",
  toplistUpdateUrl: "https://medreview.vn/api/medical/toplist-members-update.php",
  aiImagesUrl: "https://medreview.vn/api/medical/facilities-needing-ai-images.php?page=1&limit=1&min_images=3",
  aiImageUpdateUrl: "https://medreview.vn/api/medical/facility-ai-image-update.php",
  facilityImageFixUrl: "https://medreview.vn/api/medical/facilities-needing-image-fix.php?limit=10",
  facilityImageFixUpdateUrl: "https://medreview.vn/api/medical/facility-image-fix-update.php",
  translationUrl: "https://medreview.vn/api/medical/translate-content.php"
};

function migrateApiHost(value) {
  if (typeof value !== "string" || !value.trim()) return value;
  try {
    const url = new URL(value);
    if (!["top.top", "www.top.top", "xxhihi.site", "www.xxhihi.site"].includes(url.hostname.toLowerCase())) return value;
    url.protocol = "https:";
    url.hostname = "medreview.vn";
    return url.href;
  } catch {
    return value;
  }
}
function migrateApiSetting(key, value) {
  value = migrateApiHost(value);
  if (!["toplistsUrl", "toplistUpdateUrl"].includes(key) || typeof value !== "string") return value;
  try {
    const url = new URL(value);
    if (!["medreview.vn", "www.medreview.vn"].includes(url.hostname.toLowerCase())) return value;
    const oldPath = key === "toplistsUrl" ? "/api/medical/toplists-needing-facilities.php" : "/api/medical/toplist-facilities-update.php";
    if (url.pathname !== oldPath) return value;
    url.pathname = key === "toplistsUrl" ? "/api/medical/toplists-needing-members.php" : "/api/medical/toplist-members-update.php";
    return url.href;
  } catch { return value; }
}
const SOURCE_INFO = {
  handbook: {
    label: "Cẩm nang", pluralLabel: "bài Cẩm nang", queueHeading: "Chủ đề Cẩm nang",
    resultsHeading: "Cẩm nang đã xử lý", resultsKicker: "HTML + ẢNH",
    promptTitle: "Prompt Cẩm nang từ website", resultFormat: "HTML"
  },
  facility: {
    label: "Cơ sở", pluralLabel: "cơ sở", queueHeading: "Danh sách bài",
    resultsHeading: "Kết quả đã viết", resultsKicker: "JSON",
    promptTitle: "Prompt đã gửi AI", resultFormat: "JSON"
  },
  doctor: {
    label: "Bác sĩ", pluralLabel: "bác sĩ", queueHeading: "Hồ sơ cần nghiên cứu",
    resultsHeading: "Hồ sơ đã nghiên cứu", resultsKicker: "JSON",
    promptTitle: "Prompt nghiên cứu bác sĩ", resultFormat: "JSON"
  },
  toplist: {
    label: "Toplist", pluralLabel: "Toplist", queueHeading: "Danh sách bài",
    resultsHeading: "Kết quả đã viết", resultsKicker: "JSON",
    promptTitle: "Prompt đã gửi AI", resultFormat: "JSON"
  },
  "ai-image": {
    label: "Ảnh AI", pluralLabel: "cơ sở có gallery", queueHeading: "Danh sách tạo ảnh AI",
    resultsHeading: "Ảnh AI đã tạo", resultsKicker: "IMAGE",
    promptTitle: "Prompt tạo ảnh AI", resultFormat: "ẢNH"
  },
  facility_image_fix: {
    label: "Fix ảnh cơ sở y tế", pluralLabel: "cơ sở cần Fix ảnh", queueHeading: "Danh sách Fix ảnh cơ sở y tế",
    resultsHeading: "Kết quả kiểm tra ảnh", resultsKicker: "JSON",
    promptTitle: "Prompt Fix ảnh cơ sở y tế", resultFormat: "JSON"
  },
  translation: {
    label: "Dịch Việt → Anh", pluralLabel: "bản dịch", queueHeading: "Danh sách cần dịch",
    resultsHeading: "Bản dịch đã xử lý", resultsKicker: "JSON",
    promptTitle: "Prompt dịch đã gửi AI", resultFormat: "DỊCH"
  }
};
let loadingArticles = false;

function normalizeSourceType(sourceType) {
  return Object.hasOwn(SOURCE_INFO, sourceType) ? sourceType : "facility";
}

function sourceInfo(sourceType) {
  return SOURCE_INFO[normalizeSourceType(sourceType)];
}

function normalizeTranslationType(value) {
  return ["facility", "doctor", "toplist"].includes(String(value || "").toLowerCase())
    ? String(value).toLowerCase() : "facility";
}

function selectedTranslationType() {
  return normalizeTranslationType($("translationType")?.value || state.translationType);
}

function selectedSourceType() {
  return normalizeSourceType($("sourceType")?.value || state.sourceType);
}

function tabSourcePreferenceKey() {
  return panelContext.targetTabId ? `tab-task-source:${panelContext.targetTabId}` : null;
}

function tabItemsKey() {
  return panelContext.targetTabId ? `tab-job-items:${panelContext.targetTabId}` : null;
}

function tabSettingsKey() {
  return panelContext.targetTabId ? `tab-api-settings:${panelContext.targetTabId}` : null;
}

function doctorQueueStateKey() { return `tab-doctor-queue:${panelContext.targetTabId || "legacy"}`; }
function isStorageQuotaError(error) {
  return error?.storageError === true || error?.code === "storage_quota_exceeded" || error?.errorCode === "storage_quota_exceeded" ||
    /kQuotaBytes|QUOTA_BYTES|storage.{0,30}quota.{0,30}exceeded/i.test(String(error?.message || error || ""));
}
function storageQuotaFailure() {
  return { storageError: true, code: "storage_quota_exceeded", status: "error", httpStatus: null, schemaUnavailable: false,
    message: "Bộ nhớ lưu dữ liệu của tiện ích đã vượt giới hạn Chrome, không phải lỗi API.",
    help: "Cập nhật tiện ích rồi bấm Tải lại (Reload) tại chrome://extensions để áp dụng quyền lưu trữ mới; sau đó tải lại tab AI và bấm Thử lại. Không gỡ tiện ích hoặc xóa dữ liệu: JSON đang chờ/gửi lỗi cần được giữ lại." };
}
function doctorQueueError() {
  const failure = selectedSourceType() === "doctor" && state.doctorQueueState?.status === "error" ? state.doctorQueueState : null;
  // Recover old installations that persisted the raw quota exception as an
  // API error. Never repeat their stale API/configuration instructions.
  return failure && isStorageQuotaError(failure) ? storageQuotaFailure() : failure;
}
function queueLoadFailure() { return state.storageFailure || doctorQueueError(); }
function doctorQueueFailure(error) {
  if (isStorageQuotaError(error)) return { ...storageQuotaFailure(), sourceType: "doctor" };
  const httpStatus = Number(error?.httpStatus) || Number(String(error?.message || "").match(/HTTP\s+(\d{3})/)?.[1]) || null;
  return { sourceType: "doctor", status: "error", httpStatus, schemaUnavailable: httpStatus === 503,
    message: String(error?.message || "Không tải được hồ sơ bác sĩ."),
    help: httpStatus === 503
      ? "Quản trị website: kiểm tra DB/schema và bản deploy; chạy php scripts/migrate_doctor_content.php trên đúng DB server. API sẵn sàng rồi bấm Thử lại. Tiện ích không tự chạy migration."
      : "Kiểm tra kết nối, endpoint và quyền API trong cấu hình rồi bấm Thử lại. JSON đã lưu vẫn được giữ." };
}
function renderDoctorQueueError() {
  const failure = queueLoadFailure();
  const box = $("queueLoadError");
  if (!box) return;
  box.hidden = !failure;
  if (!failure) return;
  $("queueErrorTitle").textContent = failure.storageError ? "Bộ nhớ tiện ích đã đầy" : "Không tải được hồ sơ bác sĩ";
  $("queueErrorMessage").textContent = failure.message;
  $("queueErrorHelp").textContent = failure.help || doctorQueueFailure({ message: failure.message, httpStatus: failure.httpStatus }).help;
  $("queueRetry").disabled = loadingArticles || currentTabIsRunning();
  $("queueRetry").textContent = loadingArticles ? "Đang thử lại…" : "Thử lại";
}

function panelOwnsItem(item) {
  const owner = Number(item.ownerTabId || item.workerTabId);
  return !owner || owner === panelContext.targetTabId;
}

async function saveTabSourcePreference() {
  const preference = { sourceType: selectedSourceType(), translationType: selectedTranslationType() };
  state.sourceType = preference.sourceType;
  state.translationType = preference.translationType;
  const key = tabSourcePreferenceKey();
  await chrome.storage.local.set(key ? { [key]: preference } : preference);
}

function panelItemMatchesSource(item) {
  const sourceType = selectedSourceType();
  return panelOwnsItem(item) && articleSource(item) === sourceType && (sourceType !== "translation" || normalizeTranslationType(item.type || item.translation_type) === selectedTranslationType());
}

function panelWorkerMatchesSource(worker) {
  const sourceType = selectedSourceType();
  return Boolean(worker) && (!worker.sourceType || normalizeSourceType(worker.sourceType) === sourceType) &&
    (sourceType !== "translation" || !worker.translationType || normalizeTranslationType(worker.translationType) === selectedTranslationType());
}

function panelIsRefilling() {
  return state.runner?.workers ? Boolean(currentTabWorker()?.refilling) : Boolean(state.runner?.refilling);
}

function canRunSourceOnProvider(sourceType, provider) {
  return normalizeSourceType(sourceType) !== "ai-image" || AI_IMAGE_PROVIDERS.includes(provider);
}

function imageProviderMessage(provider) {
  const name = providerName(provider) || "AI này";
  return `Tạo ảnh AI chưa hỗ trợ trên ${name}. Hãy mở ChatGPT hoặc Grok để tạo ảnh; ${name} vẫn chạy Cơ sở y tế và Toplist.`;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let changed = false;
  if (changes[doctorQueueStateKey()]) { state.doctorQueueState = changes[doctorQueueStateKey()].newValue; changed = true; }
  const tabItemsChange = changes[tabItemsKey()];
  if (tabItemsChange) { state.items = tabItemsChange.newValue || []; state.tabItemsInitialized = true; changed = true; }
  else if (changes.items && !state.tabItemsInitialized) { state.items = (changes.items.newValue || []).filter(panelOwnsItem); changed = true; }
  if (changes.runner) {
    state.runner = changes.runner.newValue || { active: false };
    changed = true;
    const worker = currentTabWorker();
    if (currentTabIsRunning() && worker.sourceType) {
      $("sourceType").value = state.sourceType = normalizeSourceType(worker.sourceType);
      $("translationType").value = state.translationType = normalizeTranslationType(worker.translationType);
    }
    if (worker?.lastMessage) setStatus(worker.lastMessage, Boolean(worker.lastError));
  }
  const preferenceChange = changes[tabSourcePreferenceKey()];
  if (preferenceChange?.newValue && !currentTabIsRunning()) {
    const preference = preferenceChange.newValue;
    $("sourceType").value = state.sourceType = normalizeSourceType(preference.sourceType);
    $("translationType").value = state.translationType = normalizeTranslationType(preference.translationType);
    changed = true;
  }
  if (changes.systemNotices) { state.systemNotices = changes.systemNotices.newValue || {}; renderSystemNotice(); }
  if (changed) render();
});

async function init() {
  await resolvePanelContext();
  try { await chrome.runtime.sendMessage({ type: "reconcile-api-status" }); } catch {}
  const preferenceKey = tabSourcePreferenceKey();
  const itemsKey = tabItemsKey();
  const settingsKey = tabSettingsKey();
  state = await chrome.storage.local.get(["items", "runner", "systemNotices", "sourceType", "translationType", "instance_label", "account_label", doctorQueueStateKey(), ...Object.keys(API_SETTINGS), ...(preferenceKey ? [preferenceKey, itemsKey, settingsKey] : [])]);
  state.doctorQueueState = state[doctorQueueStateKey()];
  if (settingsKey) Object.assign(state, state[settingsKey] || {});
  state.tabItemsInitialized = Boolean(itemsKey && Object.hasOwn(state, itemsKey));
  state.items = state.tabItemsInitialized ? state[itemsKey] || [] : (state.items || []).filter(panelOwnsItem);
  state.items = state.items.filter((item) => !String(item.id).startsWith("demo-"));
  state.runner = state.runner || { active: false };
  const migratedSettings = {};
  for (const [key, defaultUrl] of Object.entries(API_SETTINGS)) {
    const value = migrateApiSetting(key, state[key] || defaultUrl);
    $(key).value = value;
    if (state[key] && state[key] !== value) migratedSettings[key] = value;
    state[key] = value;
  }
  if (Object.keys(migratedSettings).length) await chrome.storage.local.set(settingsKey ? { [settingsKey]: { ...(state[settingsKey] || {}), ...migratedSettings } } : migratedSettings);
  state.instance_label = String(state.instance_label || "Máy chưa đặt tên");
  state.account_label = String(state.account_label || "AI account chưa đặt tên");
  $("instanceLabel").value = state.instance_label;
  $("accountLabel").value = state.account_label;
  const worker = currentTabWorker();
  const preference = state[preferenceKey];
  const runningScope = currentTabIsRunning() ? worker : null;
  state.sourceType = normalizeSourceType(runningScope?.sourceType || preference?.sourceType || (runningScope ? state.runner.sourceType : state.sourceType));
  $("sourceType").value = state.sourceType;
  state.translationType = normalizeTranslationType(runningScope?.translationType || preference?.translationType || (runningScope ? state.runner.translationType : state.translationType));
  $("translationType").value = state.translationType;
  $("translationType").disabled = currentTabIsRunning();
  render();
  updateRunButton();
  if (!currentTabIsRunning() && !queueLoadFailure() && !state.items.some(panelItemMatchesSource)) loadArticles();
}

async function resolvePanelContext() {
  const request = { type: "get-tab-context" };
  if (panelContext.targetTabId) request.targetTabId = panelContext.targetTabId;
  if (panelContext.provider) request.provider = panelContext.provider;
  try {
    const result = await chrome.runtime.sendMessage(request);
    if (!result?.ok) throw new Error(result?.error || "Không xác định được tab AI.");
    const targetTabId = Number(result?.targetTabId ?? result?.tabId ?? panelContext.targetTabId);
    const provider = PROVIDERS.includes(result?.provider) ? result.provider : panelContext.provider;
    panelContext = {
      ...panelContext,
      targetTabId: Number.isInteger(targetTabId) && targetTabId > 0 ? targetTabId : null,
      provider,
      supported: result?.supported !== false && Boolean(provider) && Number.isInteger(targetTabId) && targetTabId > 0
    };
  } catch (error) {
    panelContext.supported = false;
    setStatus(error.message || "Không xác định được tab AI.", true);
  }
  return panelContext;
}
async function loadArticles() {
  if (loadingArticles) return;
  loadingArticles = true;
  renderDoctorQueueError();
  updateRunButton();
  const sourceType = selectedSourceType();
  const { pluralLabel: label } = sourceInfo(sourceType);
  setStatus(`Đang tải ${label}…`);
  try {
    const translationType = selectedTranslationType();
    const request = { type: "refresh-queue", sourceType, targetTabId: panelContext.targetTabId };
    if (sourceType === "translation") request.translationType = translationType;
    const data = await chrome.runtime.sendMessage(request);
    if (!data?.ok) {
      const error = new Error(data?.error || "Không lấy được danh sách.");
      error.httpStatus = data?.httpStatus;
      error.queueState = data?.queueState;
      error.storageError = data?.storageError;
      error.errorCode = data?.errorCode;
      throw error;
    }
    delete state.storageFailure;
    if (sourceType === "doctor") state.doctorQueueState = data.queueState || { sourceType: "doctor", status: "ready", httpStatus: 200 };
    state.items = (data.items || state.items).filter(panelOwnsItem);
    render();
    const missingLabel = sourceType === "facility_image_fix" ? "cơ sở thiếu ID, prompt hoặc dữ liệu ảnh hợp lệ" : sourceType === "ai-image" ? "cơ sở không có ID/prompt" : sourceType === "translation" ? "mục dịch thiếu source_id, prompt hoặc schema" : "bài thiếu ID/prompt";
    const queueErrors = sourceType === "facility_image_fix" && data.errors?.length
      ? ` · ${data.errors.length} lỗi nguồn: ${data.errors.map((entry) => `ID ${entry.id}: ${entry.message}`).join("; ").slice(0, 350)}` : "";
    setStatus(`Đã thêm ${data.added} ${label}${data.skipped ? ` · ${data.skipped} ${missingLabel}` : ""}${queueErrors}`, data.skipped > 0 || Boolean(queueErrors));
  } catch (error) {
    if (isStorageQuotaError(error) || isStorageQuotaError(error.queueState)) state.storageFailure = storageQuotaFailure();
    if (sourceType === "doctor") state.doctorQueueState = state.storageFailure || error.queueState || doctorQueueFailure(error);
    setStatus(state.storageFailure?.message || error.message, true);
  }
  finally { loadingArticles = false; render(); }
}

function articleSource(item) {
  if (item?.sourceType === "handbook") return "handbook";
  if (item?.sourceType === "facility_image_fix") return "facility_image_fix";
  if (item?.sourceType === "translation") return "translation";
  if (item?.sourceType === "doctor" || item?.doctor_id != null) return "doctor";
  if (item?.sourceType === "ai-image") return "ai-image";
  return item?.sourceType === "toplist" || item?.toplist_id != null ? "toplist" : "facility";
}

function displayArticleTitle(item) {
  const type = articleSource(item);
  const prefix = type === "facility_image_fix" ? "Fix ảnh · " : type === "doctor" ? "Bác sĩ · " : type === "toplist" ? "Toplist · " : type === "ai-image" ? "Ảnh AI · " : type === "translation" ? "Dịch · " : "";
  return `${prefix}${item.title || item.prompt || (type === "ai-image" ? "Cơ sở có gallery" : type === "translation" ? `source_id ${item.source_id}` : "Bài viết")}`;
}

function providerName(provider) {
  return { chatgpt: "ChatGPT", grok: "Grok", claude: "Claude", gemini: "Gemini" }[provider] || "";
}

function elapsedLabel(startedAt) {
  const start = Date.parse(startedAt || "");
  if (!Number.isFinite(start)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `đã ${minutes} phút ${remainder} giây` : `đã ${remainder} giây`;
}

function workerTabId(key, worker) {
  const explicit = Number(worker?.targetTabId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const match = String(key || "").match(/^tab-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function currentTabWorkerEntry() {
  if (!panelContext.targetTabId) return null;
  return Object.entries(state.runner?.workers || {}).find(([key, worker]) =>
    workerTabId(key, worker) === panelContext.targetTabId) || null;
}

function currentTabWorker() {
  return currentTabWorkerEntry()?.[1] || null;
}

function currentTabIsRunning() {
  return Boolean(state.runner?.active && currentTabWorker()?.active);
}

function updateLocalWorker(active) {
  const workers = { ...(state.runner?.workers || {}) };
  const found = currentTabWorkerEntry();
  const key = found?.[0] || `tab-${panelContext.targetTabId}`;
  if (active) {
    workers[key] = {
      ...(found?.[1] || {}), active: true,
      provider: panelContext.provider, targetTabId: panelContext.targetTabId,
      sourceType: selectedSourceType(), translationType: selectedTranslationType()
    };
  } else if (found) {
    workers[key] = { ...found[1], active: false, currentId: null };
  }
  state.runner = {
    ...(state.runner || {}), workers,
    active: Object.values(workers).some((worker) => worker?.active)
  };
}

function mergeApiArticles(current, incoming, sourceType) {
  if (!Array.isArray(incoming)) throw new Error("API không trả về danh sách items hợp lệ.");
  sourceType = normalizeSourceType(sourceType);
  const items = [...(current || [])];
  const existing = new Map(items.map((item) => {
    const type = articleSource(item);
    const sourceId = type === "handbook" ? item.handbook_id : type === "translation" ? item.source_id : type === "doctor" ? item.doctor_id : type === "toplist" ? item.toplist_id : item.facility_id;
    const subtype = type === "translation" ? normalizeTranslationType(item.type || item.translation_type) : "";
    return [type === "translation" ? `translation-${subtype}-${sourceId ?? item.id}` : `${type}-${sourceId ?? item.id}`, item];
  }));
  const seenIncoming = new Set();
  let added = 0;
  let skipped = 0;
  for (const entry of incoming) {
    const type = sourceType === "translation" ? normalizeTranslationType(entry.type || entry.translation_type || selectedTranslationType()) : "";
    const sourceId = sourceType === "translation" ? entry?.source_id : entry?.id;
    if (sourceId == null || String(sourceId).trim() === "" || typeof entry.prompt !== "string" || !entry.prompt.trim()) { skipped += 1; continue; }
    const id = sourceType === "translation" ? `translation-${type}-${sourceId}` : `${sourceType}-${entry.id}`;
    if (existing.has(id)) {
      const currentItem = existing.get(id);
      if (sourceType === "facility_image_fix" && !seenIncoming.has(id) && currentItem?.status === "chờ") {
        // Refresh the complete inspection snapshot only before work begins.
        // A running or saved result must stay paired with its original revision.
        for (const field of ["prompt", "images", "images_count", "images_revision", "output_template", "image_url", "ai_image_url", "gallery_json", "target_images", "writer_claimed", "writer_claim", "name", "slug", "category", "city", "address_text", "phone_text", "website_url", "google_maps_url", "language_code", "prompt_type", "prompt_label", "prompt_source", "prompt_variant_id", "prompt_key_used", "receive_endpoint"]) {
          if (Object.hasOwn(entry, field)) currentItem[field] = entry[field];
        }
        currentItem.title = entry.name || entry.title || currentItem.title;
      }
      if (["translation", "doctor"].includes(sourceType) && !seenIncoming.has(id) && currentItem?.status === "chờ") {
        for (const field of ["prompt", "translation_fields", "output_template"]) {
          if (Object.hasOwn(entry, field)) currentItem[field] = entry[field];
        }
      }
      // Existing rows from older extension versions may not have the API's
      // category prompt metadata.  Refresh only waiting rows, and only when
      // this response actually contains metadata; completed history and
      // duplicate entries remain untouched.
      if (!seenIncoming.has(id) && currentItem?.status === "chờ" &&
          ["prompt_label", "prompt_source", "prompt_variant_id", "prompt_key_used", "category", "entity_type", "output_template", "receive_endpoint"].some((field) => Object.hasOwn(entry, field))) {
        currentItem.prompt = entry.prompt;
        for (const field of ["prompt_label", "prompt_source", "prompt_variant_id", "prompt_key_used", "category", "entity_type", "output_template", "receive_endpoint"]) {
          if (Object.hasOwn(entry, field)) currentItem[field] = entry[field];
        }
      }
      seenIncoming.add(id);
      continue;
    }
    items.push({
      ...entry,
      id, sourceType,
      ...(sourceType === "translation"
        ? { type, translation_type: type, source_id: sourceId }
        : sourceType === "handbook" ? { handbook_id: entry.id } : sourceType === "doctor" ? { doctor_id: entry.id }
          : sourceType === "toplist" ? { toplist_id: entry.id } : { facility_id: entry.id }),
      title: sourceType === "translation"
        ? entry.title || entry.name || entry.source?.name || entry.source?.title || `Bản dịch ${type} #${sourceId}`
        : sourceType === "toplist" ? entry.title || entry.name || "Toplist" : entry.name || entry.title || (sourceType === "doctor" ? "Bác sĩ" : sourceType === "ai-image" ? "Cơ sở có gallery" : "Cơ sở y tế"),
      prompt: entry.prompt, status: "chờ", created_at: new Date().toISOString()
    });
    existing.set(id, items.at(-1));
    seenIncoming.add(id);
    added += 1;
  }
  return { items, added, skipped };
}

async function saveSettings() {
  const settings = {};
  for (const [key, defaultUrl] of Object.entries(API_SETTINGS)) {
    const value = $(key).value.trim() || defaultUrl;
    let url;
    try { url = new URL(value); } catch { throw new Error("URL API chưa hợp lệ. Kiểm tra lại trong cài đặt."); }
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("URL API phải bắt đầu bằng https:// hoặc http://.");
    settings[key] = migrateApiSetting(key, value);
  }
  settings.instance_label = $("instanceLabel").value.trim().slice(0, 80) || "Máy chưa đặt tên";
  settings.account_label = $("accountLabel").value.trim().slice(0, 80) || "AI account chưa đặt tên";
  const namespace = tabSettingsKey();
  const previous = namespace ? (await chrome.storage.local.get([namespace]))[namespace] || {} : {};
  await chrome.storage.local.set(namespace ? { [namespace]: { ...previous, ...settings } } : settings);
  Object.assign(state, settings);
  for (const [key, value] of Object.entries(settings)) $(key).value = value;
}

function updateSourcePresentation() {
  const info = sourceInfo(selectedSourceType());
  $("queueHeading").textContent = info.queueHeading;
  $("resultsHeading").textContent = info.resultsHeading;
  $("resultsKicker").textContent = info.resultsKicker;
  $("translationTypeWrap").hidden = selectedSourceType() !== "translation";
  $("translationType").disabled = currentTabIsRunning() || loadingArticles;
}

function isImageJob(item) {
  return articleSource(item) === "ai-image";
}

function isFacilityImageFixJob(item) {
  return articleSource(item) === "facility_image_fix";
}

function imageFixImportSummary(item) {
  const api = item?.api_update || (item?.image_fix_import_pending ? item.api_previous_update : null) || {};
  const row = Array.isArray(api.updated) ? api.updated.find((entry) => Number(entry.id ?? entry.facility_id) === Number(item?.facility_id ?? item?.result?.id)) : null;
  const receipt = row || (Array.isArray(api.updated) ? {} : api);
  const processing = receipt.image_processing ?? api.image_processing ?? api.images_processing ?? "";
  const results = Array.isArray(receipt.image_results) ? receipt.image_results : [];
  const imported = Number(receipt.images_imported) || results.filter((entry) => entry.ok === true).length;
  const failed = Number(receipt.images_failed) || results.filter((entry) => entry.ok === false).length;
  return { processing, imported, failed, results,
    partial: item?.image_fix_import_pending === true || processing === "partial" || processing === "not_started" || failed > 0 };
}

function imageFixImagesQueued(item) {
  return imageFixImportSummary(item).processing === "queued";
}

function imageFixSuccessMessage(item) {
  const summary = imageFixImportSummary(item);
  if (summary.partial) return `Đã lưu JSON · ${summary.imported} ảnh lưu · ${summary.failed} ảnh lỗi${summary.failed ? "" : " · chưa tải xong"}`;
  if (summary.processing === "completed") return `Đã lưu JSON · ${summary.imported} ảnh đã lưu${summary.imported ? "" : " · không có ảnh cần tải"}`;
  return `Đã nhận kết quả Fix ảnh${imageFixImagesQueued(item) ? " · chờ worker xử lý ảnh" : " · chưa có xác nhận tải ảnh"}`;
}

function imageFixErrorCode(item) {
  if (!isFacilityImageFixJob(item)) return "";
  return String(item.image_fix_error_code || item.api_update?.error || item.api_update?.code || "").toLowerCase();
}

function imageFixNeedsResearch(item) {
  const code = imageFixErrorCode(item);
  if (code === "insufficient_replacement_images" || /Chưa cập nhật xóa ảnh:.*\/5 ảnh thật đã xác minh/i.test(String(item?.api_error || item?.error || ""))) {
    return false;
  }
  return !item.image_fix_api_pending && !item.image_fix_import_pending && (item.image_fix_requires_research || ["images_changed", "lease_lost"].includes(code));
}

function imageFixErrorDetail(item) {
  const summary = imageFixImportSummary(item);
  if (summary.partial) return `${item.api_error ? `${item.api_error}\n` : ""}${imageFixSuccessMessage(item)}. Bấm Gửi lại để tải/lưu ảnh còn thiếu bằng đúng JSON và biên nhận cũ; không chạy AI lại.\n${formatImageErrorsForDisplay(summary.results.filter((entry) => entry.ok === false))}`;
  const code = imageFixErrorCode(item);
  if (code === "images_changed") return "Ảnh hoặc thông tin cơ sở đã thay đổi (images_changed). JSON cũ vẫn được lưu để đối chiếu; bấm Kiểm tra lại để lấy ảnh hiện tại và chạy AI lại, không gửi đè revision cũ.";
  if (code === "lease_lost") return "Đã mất quyền giữ cơ sở (lease_lost). JSON cũ vẫn được lưu để đối chiếu; bấm Kiểm tra lại để nhận quyền xử lý và kiểm tra ảnh hiện tại trước khi gửi.";
  return String(item.api_error || item.error || "Không xác định");
}

function imageFixImageCount(item) {
  return Array.isArray(item.images) ? item.images.length : Math.max(0, Number(item.images_count) || 0);
}

function displaySourceLabel(item) {
  if (isFacilityImageFixJob(item)) return "Fix ảnh";
  return sourceInfo(articleSource(item)).label;
}

function isDoctorInsufficient(item) {
  return articleSource(item) === "doctor" && (item.insufficient_data === true || item.result?.insufficient_data === true);
}

function promptDebugLabel(item) {
  if (articleSource(item) === "translation") {
    return `Dịch: ${normalizeTranslationType(item.type || item.translation_type)} · source_id ${item.source_id}`;
  }
  const label = item?.prompt_label || item?.label || item?.category || "—";
  const source = item?.prompt_source || "—";
  const key = item?.prompt_key_used || "—";
  return `Prompt: ${label} — ${source} — ${key}`;
}

function displayJobStatus(item) {
  const status = item?.status || "chờ";
  if (articleSource(item) === "handbook") {
    if (status === "hoàn tất") return "đã xuất bản · bài Cẩm nang đã lên website";
    if (["missing_images", "image_decode_failed", "image_mime_mismatch", "image_too_large"].includes(item.handbook_error_code)) return "thiếu hoặc lỗi file minh hoạ AI";
    if (item.handbook_error_code === "handbook_capability_error") return "AI chưa cung cấp file ảnh thật";
    if (["source_revision_changed", "not_eligible", "idempotency_conflict", "lease_lost"].includes(item.handbook_error_code)) return "chủ đề/quyền giữ đã đổi · cần đối chiếu";
    return { "đang viết": "đang viết HTML + tạo ảnh", "đang cập nhật": "đang gửi HTML + ảnh", "chưa xác nhận": "chưa xác nhận · giữ payload để gửi lại" }[status] || status;
  }
  if (item?.writer_claimed === true && status === "chờ") {
    return `${isFacilityImageFixJob(item) ? "đang giữ bài" : "đang viết"} · ${writerClaimDisplayLabel(item.writer_claim)}`;
  }
  if (isFacilityImageFixJob(item)) {
    if (["hoàn tất", "ảnh chưa đủ"].includes(status)) return imageFixSuccessMessage(item);
    if (imageFixNeedsResearch(item)) return `${imageFixErrorCode(item) === "images_changed" ? "ảnh đã thay đổi" : "mất quyền giữ cơ sở"} · cần kiểm tra lại`;
    const fixStatus = { "chờ": "chờ kiểm tra ảnh", "đang viết": "đang kiểm tra ảnh", "đang cập nhật": "đang tải/lưu ảnh trên website", "lỗi": "lỗi kiểm tra ảnh", "lỗi cập nhật": "lỗi gửi kết quả Fix ảnh", "chưa xác nhận": "chưa xác nhận nhận kết quả Fix ảnh" }[status] || status;
    return status === "đang viết" && providerName(item.provider) ? `${fixStatus} · ${providerName(item.provider)}` : fixStatus;
  }
  if (articleSource(item) === "translation") {
    if (status === "hoàn tất") {
      const apiStatus = String(item.api_update?.status || item.api_update?.translation?.status || "").toLowerCase();
      return !apiStatus || ["draft", "nháp", "saved_draft", "success", "ok"].includes(apiStatus)
        ? "đã lưu bản dịch nháp" : `đã lưu bản dịch · ${apiStatus}`;
    }
    const provider = providerName(item?.provider);
    return provider && status === "đang viết" ? `đang dịch · ${provider}` : status;
  }
  if (articleSource(item) === "doctor") {
    if (status === "hoàn tất") return isDoctorInsufficient(item) ? "đã nghiên cứu · thiếu dữ liệu" : "đã lưu hồ sơ · chờ duyệt";
    if (status === "đang viết") return `đang nghiên cứu${providerName(item?.provider) ? ` · ${providerName(item.provider)}` : ""}`;
  }
  if (!isImageJob(item)) {
    const provider = providerName(item?.provider);
    if (status === "chưa xác nhận") return "chưa xác nhận gửi website";
    return provider && status === "đang viết" ? `${status} · ${provider}` : status;
  }
  const imageStatus = {
    "chờ": "chờ tạo ảnh",
    "đang viết": "đang tạo ảnh",
    "đang cập nhật": "đang gửi ảnh",
    "hoàn tất": "đã tạo ảnh",
    "lỗi": "lỗi tạo ảnh",
    "lỗi cập nhật": "lỗi gửi ảnh",
    "chưa xác nhận": "chưa xác nhận gửi ảnh"
  }[status] || status;
  const provider = providerName(item?.provider);
  return provider && status === "đang viết" ? `${imageStatus} · ${provider}` : imageStatus;
}

function writerClaimDisplayLabel(value) {
  const writer = value && typeof value === "object" ? value : {};
  const knownProvider = PROVIDERS.includes(String(writer.provider || "").toLowerCase())
    ? providerName(String(writer.provider).toLowerCase()) : String(writer.provider || "AI");
  return [knownProvider, writer.instance_label, writer.account_label].filter(Boolean).join(" · ");
}

function imageUrlFromItem(item) {
  const candidate = item?.aiImageUrl || item?.imageUrl || item?.result?.ai_image_url || item?.result?.image_url || item?.result?.url;
  if (typeof candidate !== "string" || !candidate.trim()) return "";
  try {
    const url = new URL(candidate);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}

function displayImageResult(item) {
  const imageUrl = imageUrlFromItem(item);
  const savedResult = item?.result && typeof item.result === "object" ? item.result : null;
  if (savedResult) return JSON.stringify(savedResult, null, 2);
  return imageUrl ? `Ảnh AI đã tạo:\n${imageUrl}` : "Ảnh đã được AI tạo nhưng chưa nhận được URL.";
}

function render() {
  renderDoctorQueueError();
  renderSystemNotice();
  updateSourcePresentation();
  const nextKey = JSON.stringify([selectedSourceType(), selectedTranslationType(), currentTabIsRunning(), panelIsRefilling(), queueLoadFailure()?.code || Boolean(queueLoadFailure()),
    (state.items || []).map((item) => [item.id, item.title, item.status, item.provider, item.workerKey, articleSource(item), item.type, item.source_id, hasSavedResult(item), item.content_version, item.writer_claimed, item.writer_claim, isFacilityImageFixJob(item) ? [imageFixImageCount(item), item.images_revision, item.image_fix_error_code] : null, promptDebugLabel(item)])]);
  if (queueLayoutKey !== nextKey) {
  queueLayoutKey = nextKey;
  const box = $("items");
  const desired = [];
  const queueEntries = (state.items || []).map((item, index) => ({ item, index })).filter(({ item }) => !["hoàn tất", "ảnh chưa đủ", "bỏ qua"].includes(item.status) && panelItemMatchesSource(item));
  $("queueCount").textContent = String(queueEntries.length);
  if (!queueEntries.length) {
    const imageMode = selectedSourceType() === "ai-image";
    const imageFixMode = selectedSourceType() === "facility_image_fix";
    const translationMode = selectedSourceType() === "translation";
    const hasHistory = state.items?.some(panelItemMatchesSource);
    const title = queueLoadFailure() ? "Chưa tải được danh sách" : panelIsRefilling() ? (imageMode || imageFixMode ? "Đang tải thêm cơ sở" : "Đang tải thêm bài") : hasHistory ? "Đã xử lý hết" : imageFixMode ? "Chưa có cơ sở cần Fix ảnh" : imageMode ? "Chưa có cơ sở có gallery đủ ảnh" : translationMode ? "Chưa có mục cần dịch" : "Chưa có bài";
    const detail = queueLoadFailure()?.storageError ? "Đây là lỗi bộ nhớ Chrome, không phải lỗi API hay hết bài. Reload tiện ích và tab AI rồi bấm Thử lại; không xóa JSON đã lưu." : doctorQueueError() ? "Đây là lỗi tải API, không phải hết bác sĩ cần nghiên cứu. Bấm Thử lại khi website sẵn sàng." : panelIsRefilling() ? "Tiện ích đang gọi lại API của nguồn đã chọn." : hasHistory ? "Kết quả vẫn được lưu ở các mục bên dưới." : imageFixMode ? "Tải danh sách để kiểm tra ảnh hiện tại bằng prompt của website." : imageMode ? "Chọn Tạo ảnh AI để tải cơ sở có gallery đủ ảnh từ website." : translationMode ? `Chọn loại dữ liệu (${selectedTranslationType()}) rồi tải prompt dịch từ website.` : "Chọn nguồn rồi tải danh sách từ website.";
    box.innerHTML = emptyState("inbox", title, detail);
  }
  queueEntries.forEach(({ item, index }, position) => {
    const key = JSON.stringify([index, position, selectedSourceType(), Boolean(state.runner?.active), item.title, item.status, item.provider, articleSource(item), item.type, item.source_id, item.writer_claimed, item.writer_claim, hasSavedResult(item), item.content_version, isFacilityImageFixJob(item) ? [imageFixImageCount(item), item.images_revision, item.image_fix_error_code] : null, promptDebugLabel(item)]);
    const cached = queueRows.get(item.id);
    if (cached?.key === key) { desired.push(cached.row); return; }
    const row = document.createElement("div");
    row.className = "queue-item";
    row.tabIndex = 0;
    const source = displaySourceLabel(item);
    const status = item.status || "chờ";
    const statusText = displayJobStatus(item);
    const jobTitle = item.title || item.prompt || (isImageJob(item) ? "Cơ sở có gallery" : articleSource(item) === "translation" ? `source_id ${item.source_id}` : "Bài viết");
    const resultAction = hasSavedResult(item) ? `<button class="tiny-button view" title="${isImageJob(item) ? "Xem kết quả ảnh" : "Xem JSON"}">${isImageJob(item) ? "ẢNH" : "JSON"}</button>` : "";
    const recoverAction = item.status === "lỗi" && !isImageJob(item) && !isFacilityImageFixJob(item) && !imageFixNeedsResearch(item) && panelContext.provider === "gemini"
      ? '<button class="tiny-button recover-result" title="Đọc lại JSON đã có trong task Gemini Spark">Lấy JSON</button>'
      : "";
    const retryAction = item.status === "lỗi" && !isImageJob(item) && !imageFixNeedsResearch(item)
      ? '<button class="icon-button retry-item" title="Đưa bài lỗi vào hàng đợi để chạy lại" aria-label="Chạy lại bài">↻</button>'
      : "";
    const promptDebug = isFacilityImageFixJob(item) && item.writer_claimed
      ? `Máy giữ: ${writerClaimDisplayLabel(item.writer_claim)}` : promptDebugLabel(item);
    const imageCountMeta = isFacilityImageFixJob(item) ? `<span class="meta-separator">·</span><span>${imageFixImageCount(item)} ảnh</span>` : "";
    row.innerHTML = `<span class="queue-index ${isImageJob(item) ? "image-job-index" : ""}" aria-hidden="true">${isImageJob(item) ? "✦" : String(position + 1).padStart(2, "0")}</span><div class="item-copy"><span class="item-title" title="${escapeHtml(jobTitle)}">${escapeHtml(jobTitle)}</span><div class="item-meta"><span class="type-label">${escapeHtml(source)}</span>${imageCountMeta}<span class="meta-separator">·</span><span class="status-label" data-status="${escapeHtml(status)}">${escapeHtml(statusText)}</span></div><div class="prompt-debug" title="${escapeHtml(promptDebug)}">${escapeHtml(promptDebug)}</div></div><div class="row-actions">${resultAction}${recoverAction}${retryAction}<button class="icon-button delete-item" title="${isImageJob(item) ? "Xoá tác vụ ảnh" : "Xoá bài"}" aria-label="${isImageJob(item) ? "Xoá tác vụ ảnh" : "Xoá bài"}">×</button></div>`;
    const showPrompt = () => showArticleContent(item, "prompt");
    row.onclick = showPrompt;
    row.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showPrompt(); } };
    const deleteButton = row.querySelector(".delete-item");
    if (deleteButton) deleteButton.disabled = Boolean(state.runner?.active && (item.status === "đang viết" || item.status === "đang cập nhật"));
    deleteButton?.addEventListener("click", async (event) => {
      event.stopPropagation(); if (event.currentTarget.disabled) return;
      const previous = [...state.items];
      state.items.splice(index, 1);
      try { await persistItems([item.id]); }
      catch (error) { state.items = previous; render(); setStatus(error.message, true); }
    });
    row.querySelector(".retry-item")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: "retry-article", articleId: item.id, targetTabId: panelContext.targetTabId });
        if (!response?.ok) throw new Error(response?.error || "Không thể chạy lại bài.");
        const key = tabItemsKey() || "items";
        state.items = ((await chrome.storage.local.get([key]))[key] || []).filter(panelOwnsItem);
        render();
        setStatus(`Đã đưa ${item.title || "bài"} vào hàng đợi. Bấm Chạy để gửi lại prompt.`);
      } catch (error) {
        button.disabled = false;
        setStatus(error.message || "Không thể chạy lại bài.", true);
      }
    });
    row.querySelector(".view")?.addEventListener("click", (event) => { event.stopPropagation(); return showArticleContent(item, "result"); });
    row.querySelector(".recover-result")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = "Đang đọc…";
      setStatus(`Đang quét JSON của ${item.title || "bài viết"} trong task content ai…`);
      try {
        const recovered = await chrome.runtime.sendMessage({
          type: "recover-existing-article", articleId: item.id,
          targetTabId: panelContext.targetTabId, provider: panelContext.provider
        });
        if (!recovered?.ok) throw new Error(recovered?.error || "Không khôi phục được JSON.");
        setStatus(recovered.updated ? (isFacilityImageFixJob(item) ? imageFixSuccessMessage({ api_update: recovered }) : "Đã khôi phục JSON và gửi cập nhật website.") : `Đã khôi phục JSON nhưng gửi website lỗi: ${recovered.error || "xem trạng thái API"}`, !recovered.updated || recovered.partial);
      } catch (error) {
        setStatus(error.message || "Không khôi phục được JSON.", true);
        button.disabled = false;
        button.textContent = "Lấy JSON";
      }
    });
    queueRows.set(item.id, { key, row });
    desired.push(row);
  });
  if (queueEntries.length) syncRows(box, desired, queueRows, new Set(queueEntries.map(({ item }) => item.id)));
  else queueRows.clear();
  }
  renderResults();
  renderApiStatus();
  updateRunButton();
}
function doctorUrlRepairGuide(item) {
  const error = item.api_error || item.error || "";
  if (articleSource(item) !== "doctor" || !/URL|website_url|booking_url|image_url/i.test(error)) return "";
  return `\n\nHướng dẫn sửa JSON bằng AI (chưa tự gửi):\n` +
    `Hãy sửa TOÀN BỘ JSON hồ sơ bác sĩ có id ${item.doctor_id}, name ${JSON.stringify(item.name ?? item.title)}. Giữ nguyên id, name và các trường dữ liệu/chứng cứ đã có; chỉ sửa giá trị sai kiểu/định dạng URL được báo ở trên.\n` +
    `URL phải là chuỗi HTTP(S) thô, không Markdown/HTML, object, mảng, số, boolean hoặc chuỗi "null". Các URL tùy chọn có thể là null khi không có bằng chứng; không suy đoán hay tạo URL.\n` +
    `website_url, booking_url, image_url, professional_profile_url, practice_registry_url là chuỗi URL hoặc null. Mọi khóa url/website_url/booking_url lồng trong JSON cũng phải đúng kiểu này.\n` +
    `gallery_json[i].url và sources_json[i].url bắt buộc là URL thật không rỗng, không null. social_links_json ưu tiên object nền tảng:CHUỖI URL (hoặc []); tiện ích cũng nhận danh sách object chỉ gồm platform và url, giữ tên nền tảng (bỏ khoảng trắng ngoài), không trùng/trống, URL phải là chuỗi HTTP(S) thật. video_urls_json là mảng CHUỖI URL. Không đổi object URL thành chuỗi JSON, không tự chọn URL từ object nhiều trường, không xoá ảnh/nguồn/chứng cứ để che lỗi; nếu không xác minh được, báo thiếu dữ liệu để biên tập viên xem xét.\n` +
    `Chỉ trả toàn bộ JSON đã sửa trong một block code json, không rút gọn các trường khác và không thêm claim token/khóa API. JSON gốc trong tiện ích vẫn được giữ nguyên; gửi lại JSON cũ sẽ vẫn bị chặn nếu chưa sửa.`;
}

function renderApiStatus() {
  const box = $("apiStatus");
  const items = (state.items || []).filter((item) => panelItemMatchesSource(item) && ["hoàn tất", "ảnh chưa đủ", "lỗi cập nhật", "đang cập nhật", "chưa xác nhận", "lỗi"].includes(item.status));
  if (apiStatusTimer != null && !items.some((item) => item.status === "đang cập nhật")) {
    clearInterval(apiStatusTimer);
    apiStatusTimer = null;
  }
  if (apiStatusTimer == null && items.some((item) => item.status === "đang cập nhật") && typeof setInterval === "function") {
    apiStatusTimer = setInterval(renderApiStatus, 1000);
  }
  const nextKey = JSON.stringify([selectedSourceType(), items.map((item) => [item.id, item.title, item.status, articleSource(item), isDoctorInsufficient(item), item.api_error, item.error, item.api_update, item.image_fix_error_code, item.api_request_started_at, hasSavedResult(item), item.content_version])]);
  if (apiLayoutKey === nextKey) { apiElapsedUpdaters.forEach((update) => update()); return; }
  apiLayoutKey = nextKey;
  apiElapsedUpdaters = [];
  $("apiCount").textContent = String(items.length);
  if (!items.length) {
    apiRows.clear();
  const imageMode = selectedSourceType() === "ai-image";
    const imageFixMode = selectedSourceType() === "facility_image_fix";
    const translationMode = selectedSourceType() === "translation";
    box.innerHTML = emptyState("send", imageFixMode ? "Chưa gửi kết quả Fix ảnh" : imageMode ? "Chưa gửi ảnh AI" : translationMode ? "Chưa lưu bản dịch" : "Chưa gửi dữ liệu", imageFixMode ? "Website tải/lưu ảnh ngay trong request và báo riêng từng ảnh lỗi." : imageMode ? "Trạng thái gửi ảnh sẽ xuất hiện tại đây." : translationMode ? "Trạng thái lưu bản dịch nháp sẽ xuất hiện tại đây." : "Trạng thái API sẽ xuất hiện tại đây.");
    return;
  }
  const desired = [];
  items.slice().reverse().forEach((item) => {
    const key = JSON.stringify([item.title, item.status, articleSource(item), isDoctorInsufficient(item), item.api_error, item.error, item.api_update, item.image_fix_error_code, item.api_request_started_at, hasSavedResult(item), item.content_version]);
    const cached = apiRows.get(item.id);
    if (cached?.key === key) { desired.push(cached.row); if (cached.update) apiElapsedUpdaters.push(cached.update); return; }
    const row = document.createElement("div"); row.className = "api-row";
    const success = item.status === "hoàn tất";
    const imageJob = isImageJob(item);
    const imageFixJob = isFacilityImageFixJob(item);
    const fixImport = imageFixJob ? imageFixImportSummary(item) : null;
    const imageFixPartial = imageFixJob && item.status !== "đang cập nhật" && !["chưa xác nhận", "lỗi cập nhật"].includes(item.status) && fixImport.partial;
    const imageFixQueued = imageFixJob && success && imageFixImagesQueued(item);
    const translationJob = articleSource(item) === "translation";
    const doctorJob = articleSource(item) === "doctor";
    const handbookJob = articleSource(item) === "handbook";
    const imageErrors = imageFixJob ? fixImport.results.filter((entry) => entry.ok === false) : Array.isArray(item.api_update?.image_errors) ? item.api_update.image_errors : [];
    const galleryRequested = Number(item.api_update?.gallery_images_requested ?? item.api_update?.images_requested ?? 0);
    const galleryImported = Number(item.api_update?.gallery_images_imported ?? item.api_update?.images_imported ?? 0);
    const galleryQueued = Number(item.api_update?.gallery_images_queued ?? item.api_update?.images_queued ?? 0);
    const imagesQueuedForWorker = item.api_update?.image_processing === "queued" || galleryQueued > 0;
    const imageProgress = galleryRequested > 0
      ? (imagesQueuedForWorker ? ` · ${galleryQueued || galleryRequested} ảnh chờ Worker` : ` · ${galleryImported}/${galleryRequested} ảnh đã lưu`)
      : "";
    const updateCount = item.api_update?.updated_count;
    const uncertain = item.status === "chưa xác nhận";
    const sendingElapsed = item.status === "đang cập nhật" ? elapsedLabel(item.api_request_started_at) : "";
    const translatedStatus = String(item.api_update?.status || item.api_update?.translation?.status || "").toLowerCase();
    const savedDraft = translationJob && (!translatedStatus || ["draft", "nháp", "saved_draft", "success", "ok"].includes(translatedStatus));
    const detail = handbookJob && success ? `Đã xuất bản Cẩm nang · ${item.api_update?.images_count || 0} ảnh nội bộ` : imageFixPartial ? imageFixErrorDetail(item) : success
      ? imageFixJob ? imageFixSuccessMessage(item) : translationJob ? `${savedDraft ? "Đã lưu bản dịch nháp" : "Đã lưu bản dịch"}${item.api_update?.slug ? ` · ${item.api_update.slug}` : ""}${item.api_update?.translation_id != null ? ` · ID ${item.api_update.translation_id}` : ""}${Array.isArray(item.api_update?.saved_fields) ? ` · ${item.api_update.saved_fields.length} trường` : ""}` : doctorJob ? (isDoctorInsufficient(item) ? "Đã lưu nghiên cứu thiếu dữ liệu · hoàn tất, không tự viết lại" : "Đã lưu hồ sơ bác sĩ · chờ duyệt") : `${imageJob ? "Đã gửi ảnh AI thành công" : "Đã gửi thành công"}${updateCount != null ? ` · ${updateCount} mục` : ""}${imageProgress}${imageErrors.length ? ` · ${imageErrors.length} ảnh chưa xếp hàng` : ""}`
      : item.status === "đang cập nhật" ? `${imageFixJob ? "Website đang tải/lưu ảnh" : imageJob ? "Đang gửi ảnh AI" : "Đang gửi website"}${sendingElapsed ? ` · ${sendingElapsed}` : ""} · JSON đã lưu`
        : uncertain ? `${item.api_error || "Chưa có xác nhận sau 30 phút"} JSON vẫn được lưu.`
          : `Lỗi: ${imageFixJob ? imageFixErrorDetail(item) : item.api_error || item.error || "không xác định"}`;
    const stateIcon = imageFixQueued ? "◷" : imageFixPartial ? "!" : success ? "✓" : item.status === "đang cập nhật" ? "…" : uncertain ? "?" : "×";
    const stateClass = imageFixQueued || imageFixPartial ? "pending" : success ? "ok" : item.status === "đang cập nhật" ? "pending" : uncertain ? "uncertain" : "error";
    const imageBadge = imageFixPartial ? `<button class="image-progress partial image-errors" title="${escapeHtml(detail)}" aria-label="Xem chi tiết ảnh chưa lưu">${fixImport.imported} lưu · ${fixImport.failed} lỗi</button>` : imageFixJob && success && fixImport.processing === "completed" ? `<span class="image-progress ok" title="${escapeHtml(detail)}">${fixImport.imported} ảnh lưu</span>` : imageFixQueued ? `<span class="image-progress queued" title="${escapeHtml(detail)}">Chờ worker</span>` : galleryRequested > 0 && !imageFixJob ? (imagesQueuedForWorker
      ? `<span class="image-progress queued" title="${escapeHtml(imageProgress.trim())}"><span aria-hidden="true">◷</span> ${galleryQueued || galleryRequested} ảnh chờ</span>`
      : `<span class="image-progress ${galleryImported >= galleryRequested ? "ok" : "partial"}" title="${escapeHtml(imageProgress.trim())}">${galleryImported}/${galleryRequested} ảnh</span>`) : "";
    const canRetryUpdate = hasSavedResult(item) && item.status !== "đang cập nhật" && !((doctorJob || handbookJob) && success) && !(imageFixJob && (success && !imageFixPartial || imageFixNeedsResearch(item)));
    const researchAction = imageFixNeedsResearch(item) && !success && item.status !== "đang cập nhật" ? '<button class="tiny-button retry-image-fix-research" title="Lấy ảnh hiện tại và đưa vào hàng đợi kiểm tra lại bằng AI">Kiểm tra lại</button>' : "";
    row.innerHTML = `<span class="api-state ${stateClass}" title="${escapeHtml(detail)}">${stateIcon}</span><span class="api-name" title="${escapeHtml(detail)}">${escapeHtml(displayArticleTitle(item))}</span>${imageBadge}${imageErrors.length && !imageFixJob ? `<button class="image-errors" title="Xem chi tiết ${imageErrors.length} ảnh không lưu">${imageErrors.length} ảnh lỗi</button>` : ""}${canRetryUpdate ? `<button class="retry-api">${imageJob ? "Gửi lại ảnh" : "Gửi lại"}</button>` : ""}${researchAction}`;
    const update = item.status === "đang cập nhật" ? () => {
      const detail = `${imageFixJob ? "Website đang tải/lưu ảnh" : "Đang gửi website"} · ${elapsedLabel(item.api_request_started_at)} · JSON đã lưu`;
      row.querySelector(".api-state")?.setAttribute("title", detail);
      row.querySelector(".api-name")?.setAttribute("title", detail);
    } : null;
    if (update) apiElapsedUpdaters.push(update);
    if (!success && item.status !== "đang cập nhật") {
      const icon = row.querySelector(".api-state");
      icon.style.cursor = "pointer";
      icon.onclick = (event) => {
        event.stopPropagation();
        openViewer(uncertain ? "Chưa xác nhận gửi website" : imageFixJob ? "Lỗi Fix ảnh cơ sở y tế" : item.status === "lỗi" ? (imageJob ? "Lỗi tạo ảnh AI" : "Lỗi đọc kết quả AI") : "Mã lỗi gửi website",
          `${imageJob || imageFixJob ? "Cơ sở" : "Bài"}: ${item.title || (imageJob ? "Ảnh AI" : "Bài viết")}\nTrạng thái: ${displayJobStatus(item)}\nLỗi: ${imageFixJob ? imageFixErrorDetail(item) : item.api_error || item.error || "Không xác định"}${doctorUrlRepairGuide(item)}`, displayArticleTitle(item));
      };
    }
    row.querySelector(".image-errors")?.addEventListener("click", (event) => { event.stopPropagation(); openViewer("Chi tiết ảnh không được lưu", imageFixJob ? imageFixErrorDetail(item) : formatImageErrorsForDisplay(imageErrors), displayArticleTitle(item)); });
    row.querySelector(".retry-api")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const button = event.currentTarget;
      button.disabled = true;
      setStatus(`Đang gửi lại ${displayArticleTitle(item)}…`);
      try {
        const response = await chrome.runtime.sendMessage({ type: "retry-update", articleId: item.id, targetTabId: panelContext.targetTabId });
        if (!response?.ok) throw new Error(response?.error || "Không gửi lại được dữ liệu.");
        setStatus(response.updated ? (imageFixJob ? imageFixSuccessMessage({ api_update: response }) : `Đã gửi lại ${displayArticleTitle(item)} thành công.`) : "JSON vẫn được lưu nhưng website chưa xác nhận cập nhật.", !response.updated || response.partial);
      } catch (error) {
        setStatus(error.message || "Không gửi lại được dữ liệu.", true);
      } finally {
        button.disabled = false;
      }
    });
    row.querySelector(".retry-image-fix-research")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: "retry-image-fix-research", articleId: item.id, targetTabId: panelContext.targetTabId });
        if (!response?.ok) throw new Error(response?.error || "Không thể kiểm tra lại ảnh.");
        const key = tabItemsKey() || "items";
        state.items = ((await chrome.storage.local.get([key]))[key] || []).filter(panelOwnsItem);
        render();
        setStatus("Đã đưa cơ sở vào hàng đợi kiểm tra ảnh hiện tại. Bấm Chạy để kiểm tra lại bằng AI.");
      } catch (error) {
        button.disabled = false;
        setStatus(error.message || "Không thể kiểm tra lại ảnh.", true);
      }
    });
    apiRows.set(item.id, { key, row, update });
    desired.push(row);
  });
  syncRows(box, desired, apiRows, new Set(items.map((item) => item.id)));
}
function renderResults() {
  const results = $("results");
  const completed = (state.items || []).filter((item) => panelItemMatchesSource(item) && hasSavedResult(item));
  const nextKey = JSON.stringify([selectedSourceType(), completed.map((item) => [item.id, item.title, articleSource(item), isDoctorInsufficient(item), item.completed_at, item.created_at, item.content_version, item.aiImageUrl, item.imageUrl, isFacilityImageFixJob(item) ? displayJobStatus(item) : null, promptDebugLabel(item)])]);
  if (resultLayoutKey === nextKey) return;
  resultLayoutKey = nextKey;
  $("resultCount").textContent = String(completed.length);
  const desired = [];
  if (!completed.length) {
    resultRows.clear();
    const imageMode = selectedSourceType() === "ai-image";
    const imageFixMode = selectedSourceType() === "facility_image_fix";
    const translationMode = selectedSourceType() === "translation";
    results.innerHTML = emptyState("file", imageFixMode ? "Chưa có kết quả kiểm tra ảnh" : imageMode ? "Chưa có ảnh AI" : translationMode ? "Chưa có bản dịch" : "Chưa có kết quả", imageFixMode ? "JSON kiểm tra ảnh được giữ lại cả khi gửi website lỗi." : imageMode ? "Ảnh AI hoàn tất sẽ được lưu ở đây." : translationMode ? "Kết quả dịch sẽ được lưu ở đây." : "JSON hoàn tất sẽ được lưu ở đây.");
    return;
  }
  completed.slice().reverse().forEach((item) => {
    const key = JSON.stringify([item.title, articleSource(item), isDoctorInsufficient(item), item.completed_at, item.created_at, item.content_version, item.aiImageUrl, item.imageUrl, isFacilityImageFixJob(item) ? displayJobStatus(item) : null, promptDebugLabel(item)]);
    const cached = resultRows.get(item.id);
    if (cached?.key === key) { desired.push(cached.row); return; }
    const row = document.createElement("div"); row.className = "result-row"; row.tabIndex = 0;
    const imageJob = isImageJob(item);
    const source = displaySourceLabel(item);
    const icon = imageJob
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.25"/><path d="m5.5 17 4.5-4 3 2.5 2-2 3.5 3.5"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/></svg>';
    const resultFormat = isDoctorInsufficient(item) ? "THIẾU DL" : sourceInfo(articleSource(item)).resultFormat;
    const imageUrl = imageJob ? imageUrlFromItem(item) : "";
    const imageUrlTitle = imageUrl ? ` title="${escapeHtml(imageUrl)}"` : "";
    const promptDebug = promptDebugLabel(item);
    row.classList?.toggle?.("result-row-image", imageJob);
    const resultStatus = articleSource(item) === "doctor" || isFacilityImageFixJob(item) ? `<span class="meta-separator">·</span><span>${escapeHtml(displayJobStatus(item))}</span>` : "";
    row.innerHTML = `<span class="file-icon ${imageJob ? "image-result-icon" : ""}" aria-hidden="true">${icon}</span><div class="item-copy"><span class="item-title"${imageUrlTitle}>${escapeHtml(item.title || (imageJob ? "Cơ sở có gallery" : "Bài viết"))}</span><div class="item-meta"><span>${escapeHtml(source)}</span><span class="meta-separator">·</span><time>${formatDate(item.completed_at || item.created_at)}</time>${resultStatus}</div><div class="prompt-debug" title="${escapeHtml(promptDebug)}">${escapeHtml(promptDebug)}</div></div><span class="result-format ${imageJob ? "image-result-format" : ""}">${resultFormat}</span>`;
    const showResult = () => showArticleContent(item, "result");
    row.onclick = showResult;
    row.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showResult(); } };
    resultRows.set(item.id, { key, row });
    desired.push(row);
  });
  syncRows(results, desired, resultRows, new Set(completed.map((item) => item.id)));
}
async function persistItems(removeArticleIds) {
  const result = await chrome.runtime.sendMessage({ type: "replace-queue-items", items: state.items,
    targetTabId: panelContext.targetTabId, sourceType: selectedSourceType(), translationType: selectedTranslationType(), removeArticleIds });
  if (result?.ok === false) throw new Error(result.error);
  render();
}
async function showArticleContent(item, field) {
  const requestId = ++viewerRequestId;
  try {
    let content = item;
    if (!Object.hasOwn(item, field)) {
      const response = await chrome.runtime.sendMessage({ type: "get-article-content", articleId: item.id, targetTabId: panelContext.targetTabId });
      if (!response?.ok) throw new Error(response?.error || "Không tải được nội dung bài.");
      content = { ...item, ...response.content };
    }
    if (requestId !== viewerRequestId) return;
    openViewer(field === "prompt" ? sourceInfo(articleSource(item)).promptTitle : isImageJob(item) ? "Ảnh AI đã tạo" : "Kết quả JSON",
      field === "prompt" ? content.prompt || "(Tác vụ này chưa có prompt)" : isImageJob(item) ? displayImageResult(content) : JSON.stringify(content.result, null, 2), displayArticleTitle(item));
  } catch (error) { setStatus(error.message, true); }
}
function escapeHtml(value) { const el = document.createElement("span"); el.textContent = value; return el.innerHTML; }
function formatImageErrorsForDisplay(errors) {
  if (!Array.isArray(errors) || !errors.length) return "Không có lỗi ảnh.";
  return errors.map((entry, index) => {
    const field = entry?.input_field || "gallery_json";
    const position = entry?.position != null ? `, ảnh số ${entry.position}` : "";
    const lines = [`${index + 1}. ${field}${position}`, `URL: ${entry?.source_url || entry?.url || "(không có URL)"}`, `Lý do: ${entry?.error || entry?.message || "Không thể nhập ảnh."}`];
    if (entry?.http_status) lines.push(`HTTP: ${entry.http_status}`);
    if (entry?.curl_error) lines.push(`Kết nối: ${entry.curl_error}`);
    return lines.join("\n");
  }).join("\n\n");
}
function formatDate(value) { return value ? new Date(value).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : ""; }
function emptyState(icon, title, text) {
  const paths = icon === "send" ? '<path d="m4 12 16-8-6 16-3-6z"/><path d="m11 14 4-4"/>' : icon === "file" ? '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M10 13h5m-5 3h5"/>' : '<path d="M4 7h16l-2 13H6z"/><path d="M8 7l2-3h4l2 3M9 12h6"/>';
  return `<div class="empty-state"><span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg></span><div><strong>${title}</strong><p>${text}</p></div></div>`;
}
function openViewer(title, content, subtitle = "") {
  $("modalTitle").textContent = title;
  $("modalSubtitle").textContent = subtitle;
  $("modalJson").textContent = content;
  $("jsonModal").hidden = false;
  $("modalJson").focus?.();
}
function setStatus(text, error = false) {
  $("status").textContent = text;
  $("statusLine").dataset.state = error ? "error" : /đang|bắt đầu|tải/i.test(text) ? "live" : "ready";
}
const SYSTEM_PHASE_LABELS = {
  "writing-images": "Đang viết và tạo ảnh Cẩm nang", "attaching-images": "Đang gắn file ảnh thật vào HTML",
  preparing: "Đang chuẩn bị bài", connecting: "Đang kết nối tab AI", claiming: "Đang xin quyền xử lý bài",
  "finding-input": "Đang tìm ô nhập prompt", filling: "Đang nạp prompt", "waiting-send": "Prompt đã điền · chờ gửi",
  sending: "Đang gửi prompt", "waiting-ai": "Đang chờ AI viết xong", "reading-json": "Đang lấy JSON",
  "validating-json": "Đang kiểm tra JSON", "saving-json": "Đang nạp JSON vào tiện ích", recovering: "Đang khôi phục sau khi tải lại", retrying: "Chuẩn bị gửi lại bài"
};

function systemNoticeView({ active, worker, current, notice, runner, latest, waitingCount = 0, now = Date.now() }) {
  const view = { phase: "Sẵn sàng", detail: "Chưa có tác vụ đang chạy trên tab này.", countdown: "", level: "ready" };
  const remaining = (deadline) => Math.max(0, Math.ceil((deadline - now) / 1000));
  const time = (seconds) => `${Math.floor(seconds / 60)} phút ${String(seconds % 60).padStart(2, "0")} giây`;
  const same = current && notice?.articleId === current.id && notice.runToken === worker?.runToken;
  const statusOwner = runner?.workers ? worker : runner;
  const waitReason = String(statusOwner?.waitReason || "").trim();
  const inactiveWait = !active && !current && (waitReason || statusOwner?.lastError);
  if (!active) {
    if (inactiveWait) {
      view.phase = waitReason ? "Hàng đợi đang tạm chờ" : "Hàng đợi gặp lỗi";
      view.detail = waitReason || String(statusOwner.lastError);
      if (statusOwner?.lastError && String(statusOwner.lastError).trim() !== waitReason && waitReason) {
        view.detail += `\nThông báo: ${String(statusOwner.lastError).slice(0, 600)}`;
      }
      view.level = "warning";
    }
    else if (isFacilityImageFixJob(latest) && latest?.status === "ảnh chưa đủ") {
      view.phase = "JSON đã lưu · còn ảnh lỗi"; view.detail = imageFixErrorDetail(latest); view.level = "warning";
    }
    else if (["lỗi", "lỗi cập nhật", "chưa xác nhận"].includes(latest?.status)) {
      view.phase = isFacilityImageFixJob(latest) && imageFixNeedsResearch(latest) ? "Fix ảnh cần kiểm tra lại" : latest.status === "chưa xác nhận" ? "Chưa xác nhận kết quả gửi website" : latest.status === "lỗi cập nhật" ? "Gửi JSON lên website gặp lỗi" : "Bài gặp lỗi";
      view.detail = isFacilityImageFixJob(latest) && imageFixNeedsResearch(latest) ? imageFixErrorDetail(latest) : String(latest.api_error || latest.error || "Chưa có thông tin lỗi.") + (hasSavedResult(latest) ? "\nJSON đã được lưu trong tiện ích, có thể gửi lại từ mục Gửi lên website." : "");
      view.level = latest.status === "chưa xác nhận" ? "warning" : "error";
    }
    else if (latest?.status === "hoàn tất") {
      view.phase = isFacilityImageFixJob(latest) ? imageFixSuccessMessage(latest) : isDoctorInsufficient(latest) ? "Đã lưu nghiên cứu thiếu dữ liệu" : articleSource(latest) === "doctor" ? "Đã lưu hồ sơ bác sĩ" : "Đã gửi bài thành công";
      view.detail = isFacilityImageFixJob(latest) ? imageFixImagesQueued(latest) ? "API phiên bản cũ đã nhận JSON và xếp hàng worker; chưa xác nhận ảnh đã tải." : `${imageFixSuccessMessage(latest)}. Có thể nhấn Chạy để kiểm tra cơ sở tiếp theo.` : isDoctorInsufficient(latest) ? `Nghiên cứu đã hoàn tất nhưng chưa đủ bằng chứng. Hồ sơ chờ duyệt, không tự viết lại.\n${latest.notes_for_editor || latest.result?.notes_for_editor || ""}` : articleSource(latest) === "doctor" ? "Website đã nhận hồ sơ và giữ trạng thái chưa duyệt. Có thể nhấn Chạy để nghiên cứu bác sĩ tiếp theo." : "Website đã nhận kết quả. Có thể nhấn Chạy để tiếp tục.";
    }
    else if (notice) { view.phase = "Đã dừng"; view.detail = "Tab này hiện không chạy. Mở Các bước gần đây để xem tiến trình trước khi dừng."; }
  } else if (!current) {
    const deadline = Number(worker?.nextJobAt || 0);
    view.phase = statusOwner?.refilling ? "Đang tải bài tiếp theo" : deadline ? "Đang chuẩn bị bài tiếp theo" : "Đang chờ bài tiếp theo";
    view.detail = statusOwner?.refilling ? "Đang gọi API để lấy bài và prompt cho tab này. Khi nhận được dữ liệu, tiện ích sẽ chuẩn bị bài tiếp theo." : "Tiện ích xử lý từng bài. Bài tiếp theo sẽ được lấy và chuẩn bị trước khi đến lượt gửi.";
    if (!statusOwner?.refilling && !deadline) {
      if (waitReason) {
        view.phase = "Hàng đợi đang tạm chờ";
        view.detail = waitReason;
        view.level = "warning";
      } else if (waitingCount > 0) {
        view.phase = "Đang tiếp tục hàng đợi";
        view.detail = `Có ${waitingCount} bài chờ trên tab này. Tiện ích đang tiếp tục xử lý hàng đợi.`;
      }
    }
    if (deadline) view.countdown = deadline > now ? `Gửi bài tiếp theo sau ${time(remaining(deadline))}.` : "Đã hết thời gian chờ · đang chuyển sang bài tiếp theo.";
    if (statusOwner?.lastError) {
      if (String(statusOwner.lastError).trim() !== waitReason) view.detail += `\nThông báo: ${String(statusOwner.lastError).slice(0, 600)}`;
      if (!statusOwner.refilling && !deadline && !waitReason) view.phase = "Hàng đợi gặp lỗi";
      view.level = "warning";
    }
  } else if (current.status === "đang cập nhật") {
    view.phase = isFacilityImageFixJob(current) ? "Website đang tải/lưu ảnh" : "Đang gửi JSON lên website";
    view.detail = isFacilityImageFixJob(current) ? "JSON đã được giữ trong tiện ích. Website tải và lưu ảnh trực tiếp trước khi trả kết quả; không cắt thời gian POST, chưa chuyển sang cơ sở tiếp theo." : "JSON đã được lưu trong tiện ích. Đang gửi API và chờ website xác nhận; chưa chuyển sang bài tiếp theo.";
    const started = Date.parse(current.api_request_started_at || "");
    if (Number.isFinite(started)) view.countdown = `Đã chờ phản hồi website ${time(Math.max(0, Math.floor((now - started) / 1000)))}.`;
  } else {
    const retry = Date.parse(current.gemini_spark_dispatch_retry_at || current.gemini_spark_json_retry_at || "");
    const scheduled = Date.parse(current.prompt_scheduled_at || "");
    if (Number.isFinite(retry)) {
      view.phase = "Chuẩn bị gửi lại bài"; view.level = "warning";
      view.detail = `Giữ nguyên bài này, chưa chuyển sang bài khác. Lần gửi lại: ${Number(current.gemini_spark_json_retry_count || current.gemini_spark_dispatch_retry_count) || 1}.\n${same && notice.phase === "retrying" ? notice.detail : current.error || "Lần trước chưa nhận được JSON hợp lệ đúng ID, hoặc chưa gửi được prompt."}`;
      view.countdown = retry > now ? `Gửi lại sau ${time(remaining(retry))}.` : "Đã hết thời gian chờ · đang chuẩn bị gửi lại prompt.";
    } else if (Number.isFinite(scheduled) && !current.prompt_sent_at) {
      view.phase = current.prompt_prepared_at ? "Prompt đã điền · chờ gửi" : same ? SYSTEM_PHASE_LABELS[notice.phase] : "Đang chuẩn bị prompt";
      view.detail = current.prompt_prepared_at ? "Prompt đã nằm trong ô nhập của Spark. Khi hết đếm ngược, tiện ích kiểm tra prompt và bấm Gửi." : same ? notice.detail : "Đang kết nối tab, xin quyền xử lý và điền prompt vào ô nhập.";
      view.countdown = scheduled > now ? `Đến lượt gửi sau ${time(remaining(scheduled))}.` : "Đã hết thời gian chờ · đang đợi xác nhận gửi prompt.";
    } else {
      view.phase = same ? SYSTEM_PHASE_LABELS[notice.phase] : "Đang xử lý bài";
      view.detail = same ? notice.detail : "Đang chờ trạng thái xử lý từ tab AI.";
      if (current.gemini_spark_reload_error) { view.detail += `\nKhông tải lại được: ${current.gemini_spark_reload_error}`; view.level = "warning"; }
      const waiting = !same || ["waiting-ai", "recovering"].includes(notice.phase);
      if (worker?.provider === "gemini" && waiting && current.prompt_sent_at) {
        const reference = Date.parse(current.gemini_spark_reload_attempted_at || current.prompt_sent_at);
        if (Number.isFinite(reference)) {
          const seconds = remaining(reference + 10 * 60000);
          view.countdown = seconds > 0 ? `Tải lại Spark theo lịch 10 phút · còn ${time(seconds)}.` : "Đã đến lịch tải lại Spark · đang chờ nền xử lý.";
          if (seconds <= 10 && seconds > 0) view.phase = "Chuẩn bị tải lại Spark";
        }
        if (current.gemini_spark_reload_attempted_at && !same) { view.phase = "Đang tải lại và khôi phục bài"; view.detail = "Đang mở lại Spark. Nếu Stop đã đóng, tiện ích đọc JSON của đúng bài; nếu AI còn viết, tiếp tục chờ."; }
      }
    }
    if (current.status === "lỗi") { view.phase = "Bài gặp lỗi"; view.detail = String(current.error || "Chưa có thông tin lỗi."); view.level = "error"; }
  }
  const article = current || (inactiveWait ? null : latest);
  if (article) view.detail = `${active && !current ? "Bài vừa xử lý" : "Bài"}: ${displayArticleTitle(article)}\nID: ${article.doctor_id ?? article.facility_id ?? article.source_id ?? article.id}\n${view.detail}`;
  return view;
}

function renderSystemNotice() {
  if (!$("systemPhase")) return;
  const entry = currentTabWorkerEntry();
  const worker = currentTabIsRunning() || panelWorkerMatchesSource(entry?.[1]) ? entry?.[1] : null;
  const notice = worker ? state.systemNotices?.[entry[0]] : null;
  const current = state.items?.find((item) => item.id === worker?.currentId);
  const latest = state.items?.find((item) => item.id === notice?.articleId);
  const waitingCount = (state.items || []).filter((item) => item.status === "chờ" && panelItemMatchesSource(item)).length;
  const failure = queueLoadFailure();
  const view = failure && !current ? { phase: failure.storageError ? "Bộ nhớ tiện ích đã đầy" : "Không tải được hồ sơ", detail: `${failure.message}\n${failure.help || "Bấm Thử lại sau khi website sẵn sàng."}`, countdown: "", level: "error" }
    : selectedSourceType() === "doctor" && state.doctorQueueState?.status === "loading" && !current
      ? { phase: "Đang tải hồ sơ bác sĩ", detail: "Đang chờ API trả danh sách; chưa gửi prompt hoặc nhận khóa bài.", countdown: "", level: "info" }
    : systemNoticeView({ active: currentTabIsRunning(), worker, current, notice, runner: state.runner, latest, waitingCount });
  $("systemPhase").textContent = view.phase;
  $("systemDetail").textContent = view.detail;
  $("systemCountdown").textContent = view.countdown;
  $("systemCountdown").hidden = !view.countdown;
  $("systemPhase").closest?.(".system-card")?.setAttribute("data-level", view.level);
  $("systemClock").textContent = notice?.at ? new Date(notice.at).toLocaleTimeString("vi-VN") : "";
  if (systemHistoryReference !== notice?.history) {
    systemHistoryReference = notice?.history;
    $("systemHistory").replaceChildren();
    for (const event of notice?.history || []) {
      const li = document.createElement("li");
      li.textContent = `${new Date(event.at).toLocaleTimeString("vi-VN")} · ${SYSTEM_PHASE_LABELS[event.phase] || event.phase}\n${event.title}\n${event.detail}`;
      $("systemHistory").appendChild(li);
    }
  }
  if (systemNoticeTimer == null && typeof setInterval === "function") systemNoticeTimer = setInterval(renderSystemNotice, 1000);
}

function updateRunButton() {
  if (runCountdownTimer != null && typeof clearInterval === "function") clearInterval(runCountdownTimer);
  runCountdownTimer = null;
  const button = $("runToggle");
  const worker = currentTabWorker();
  const statusOwner = state.runner?.workers ? worker : state.runner;
  const nextJobAt = Number(statusOwner?.nextJobAt || 0);
  const activeHere = currentTabIsRunning();
  const provider = panelContext.provider;
  const label = providerName(provider) || "AI";
  const activeSourceType = normalizeSourceType(activeHere ? worker?.sourceType || selectedSourceType() : selectedSourceType());
  const activeTranslationType = normalizeTranslationType(activeHere ? worker?.translationType || selectedTranslationType() : selectedTranslationType());
  const activeSource = sourceInfo(activeSourceType);
  const canRunSelectedSource = canRunSourceOnProvider(activeSourceType, provider);
  const imageProviderUnavailable = !activeHere && !canRunSelectedSource;
  const queueFailure = !activeHere ? queueLoadFailure() : null;
  const queueLoading = !activeHere && activeSourceType === "doctor" && state.doctorQueueState?.status === "loading";
  const waiting = (state.items || []).filter((item) => item.status === "chờ" && panelItemMatchesSource(item)).length;
  const current = worker?.currentId
    ? (state.items || []).find((item) => item.id === worker.currentId)
    : null;
  const otherWorkers = Object.entries(state.runner?.workers || {}).filter(([key, entry]) =>
    entry?.active && workerTabId(key, entry) !== panelContext.targetTabId).length;

  $("runProvider").textContent = label;
  $("runLabel").textContent = activeHere ? "Dừng" : imageProviderUnavailable ? "Không hỗ trợ" : "Chạy";
  button.dataset.provider = provider || "unknown";
  button.dataset.unavailable = String(imageProviderUnavailable);
  button.classList.toggle("is-stop", activeHere);
  button.classList.toggle("is-unavailable", imageProviderUnavailable);
  button.setAttribute?.("aria-pressed", String(activeHere));
  button.setAttribute?.("aria-label", activeHere ? `Dừng ${label} trên tab này` : imageProviderUnavailable ? `Tạo ảnh AI chưa hỗ trợ trên ${label}` : `Chạy bằng ${label} trên tab này`);
  button.disabled = loadingArticles || !panelContext.supported || imageProviderUnavailable || Boolean(queueFailure) || queueLoading;
  const capabilityHint = $("providerCapabilityHint");
  if (capabilityHint) {
    capabilityHint.hidden = !imageProviderUnavailable;
    capabilityHint.textContent = imageProviderUnavailable ? imageProviderMessage(provider) : "";
  }

  if (!panelContext.supported) {
    $("runCaption").textContent = "Chưa nhận diện tab AI";
    $("runDetail").textContent = "Mở ChatGPT, Grok, Claude hoặc Gemini để chạy";
  } else if (queueLoading) {
    $("runCaption").textContent = "Đang tải hồ sơ";
    $("runDetail").textContent = "Chờ API trả danh sách rồi bấm Chạy";
  } else if (queueFailure) {
    $("runCaption").textContent = queueFailure.storageError ? "Bộ nhớ tiện ích đã đầy" : "Không tải được hồ sơ";
    $("runDetail").textContent = queueFailure.storageError ? "Reload tiện ích và tab AI · giữ nguyên JSON đã lưu" : queueFailure.schemaUnavailable ? "Website chưa sẵn sàng · quản trị kiểm tra schema, sau đó Thử lại" : "API bác sĩ gặp lỗi · kiểm tra cấu hình, sau đó Thử lại";
    setStatus(queueFailure.message, true);
  } else if (imageProviderUnavailable) {
    $("runCaption").textContent = `Ảnh AI chưa hỗ trợ trên ${label}`;
    $("runDetail").textContent = "Dùng ChatGPT hoặc Grok để tạo ảnh";
  } else if (panelIsRefilling() && activeHere && !nextJobAt) {
    $("runCaption").textContent = `Đang tải thêm cho ${label}`;
    $("runDetail").textContent = "Đang gọi lại API danh sách";
  } else if (activeHere) {
    $("runCaption").textContent = `Đang chạy ${label}`;
    if (current) {
      const isSending = current.status === "đang cập nhật";
      const renderCurrentProgress = () => {
        const elapsed = elapsedLabel(isSending ? current.api_request_started_at : current.write_started_at);
        const retryAt = Date.parse(current.gemini_spark_json_retry_at || "");
        const retrySeconds = Number.isFinite(retryAt) ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
        const retryCount = Number(current.gemini_spark_json_retry_count) || 1;
        const scheduledAt = Date.parse(current.prompt_scheduled_at || "");
        const scheduledSeconds = Number.isFinite(scheduledAt) ? Math.max(0, Math.ceil((scheduledAt - Date.now()) / 1000)) : 0;
        const phase = isSending
          ? "Đang gửi website"
          : retryAt > Date.now()
            ? `Chuẩn bị gửi lại prompt · lần ${retryCount} · còn ${retrySeconds} giây`
            : current.prompt_scheduled_at && !current.prompt_sent_at
              ? scheduledSeconds > 0
                ? `${current.prompt_prepared_at ? "Prompt đã điền · chờ gửi" : "Đang chuẩn bị prompt"} · còn ${scheduledSeconds} giây`
                : current.prompt_prepared_at ? "Prompt đã điền · đang chờ xác nhận gửi" : "Đang chuẩn bị prompt để gửi"
            : current.gemini_spark_reload_attempted_at
              ? "Đang khôi phục JSON sau khi tải lại Gemini Spark"
              : current.status === "đang viết" ? (isFacilityImageFixJob(current) ? "Đang kiểm tra ảnh" : articleSource(current) === "translation" ? "Đang dịch" : "Đang viết bài") : displayJobStatus(current);
        const elapsedText = elapsed && current.write_timer_backfilled && !isSending
          ? `theo dõi ${elapsed.replace(/^đã\s+/, "")}`
          : elapsed;
        const saved = isSending ? " · JSON đã lưu" : "";
        $("runDetail").textContent = `${phase}${elapsedText ? ` · ${elapsedText}` : ""}${saved} · ${displayArticleTitle(current)}`;
      };
      renderCurrentProgress();
      if ((isSending || current.status === "đang viết") && typeof setInterval === "function") {
        runCountdownTimer = setInterval(renderCurrentProgress, 1000);
      }
    } else if (nextJobAt > 0) {
      const renderCountdown = () => {
        const seconds = Math.max(0, Math.ceil((nextJobAt - Date.now()) / 1000));
        const nextArticle = (state.items || []).find((item) => item.status === "chờ" && panelItemMatchesSource(item));
        const preparation = seconds === 0 ? "Đang chuyển sang bài tiếp theo" : panelIsRefilling() ? "Đang tải bài tiếp theo" : nextArticle ? "Đã tải dữ liệu bài tiếp theo" : "Đang chờ bài tiếp theo";
        $("runDetail").textContent = `${preparation}${seconds > 0 ? ` · còn ${seconds} giây` : ""}${nextArticle ? ` · ${displayArticleTitle(nextArticle)}` : ""}`;
        if (seconds === 0 && runCountdownTimer != null) {
          clearInterval(runCountdownTimer);
          runCountdownTimer = null;
        }
      };
      renderCountdown();
      if (typeof setInterval === "function") runCountdownTimer = setInterval(renderCountdown, 1000);
    } else {
      $("runDetail").textContent = statusOwner?.waitReason || statusOwner?.lastError ||
        (waiting ? `Có ${waiting} bài chờ · đang tiếp tục hàng đợi` : "Đang chờ bài tiếp theo");
    }
  } else if (panelWorkerMatchesSource(statusOwner) && (statusOwner?.waitReason || statusOwner?.lastError)) {
    $("runCaption").textContent = statusOwner.waitReason ? "Hàng đợi đang tạm chờ" : "Hàng đợi gặp lỗi";
    $("runDetail").textContent = statusOwner.waitReason || statusOwner.lastError;
  } else if (otherWorkers) {
    $("runCaption").textContent = `${otherWorkers} tab AI khác đang chạy`;
    $("runDetail").textContent = waiting ? `Nhấn Chạy để tab này nhận một ${activeSourceType === "facility_image_fix" ? "cơ sở kiểm tra ảnh" : activeSourceType === "ai-image" ? "cơ sở tạo ảnh" : activeSourceType === "translation" ? `bản dịch ${activeTranslationType}` : "bài"} riêng` : `Không còn ${activeSource.pluralLabel} đang chờ`;
  } else {
    $("runCaption").textContent = waiting ? `${waiting} ${activeSourceType === "facility_image_fix" ? "cơ sở chờ Fix ảnh" : activeSourceType === "ai-image" ? "ảnh AI đang chờ" : activeSourceType === "translation" ? `bản dịch ${activeTranslationType} đang chờ` : "bài đang chờ"}` : "Sẵn sàng";
    $("runDetail").textContent = waiting ? `${label} sẽ chỉ chạy trên tab này${activeSourceType === "translation" ? ` · ${activeTranslationType}` : ""}` : `Không còn ${activeSource.pluralLabel} đang chờ`;
  }
  $("sourceType").disabled = activeHere || loadingArticles;
  $("translationType").disabled = activeHere || loadingArticles;
  $("refresh").disabled = activeHere || loadingArticles;
  $("clear").disabled = activeHere || (state.items || []).some((item) => panelItemMatchesSource(item) && ["đang viết", "đang cập nhật"].includes(item.status));
}

$("clear").onclick = async () => {
  const previous = [...state.items];
  const removed = state.items.filter(panelItemMatchesSource).map((item) => item.id);
  state.items = state.items.filter((item) => !panelItemMatchesSource(item));
  try { await persistItems(removed); }
  catch (error) { state.items = previous; render(); setStatus(error.message, true); }
};
$("refresh").onclick = loadArticles;
$("queueRetry").onclick = loadArticles;
$("sourceType").onchange = async () => {
  try {
    await saveTabSourcePreference();
    await loadArticles();
  } catch (error) { setStatus(error.message, true); }
};
$("translationType").onchange = async () => {
  try {
    await saveTabSourcePreference();
    if (selectedSourceType() === "translation") await loadArticles();
    else render();
  } catch (error) { setStatus(error.message, true); }
};
function closeSettings() { $("settings").hidden = true; $("settingsToggle").focus?.(); }
$("settingsToggle").onclick = () => { $("settingsMessage").textContent = ""; $("settings").hidden = false; $("closeSettings").focus?.(); };
$("closeSettings").onclick = closeSettings;
$("saveSettings").onclick = async () => {
  try { await saveSettings(); closeSettings(); setStatus("Đã lưu cấu hình API và nhãn máy/tài khoản AI"); }
  catch (error) { $("settingsMessage").textContent = error.message; setStatus(error.message, true); }
};
async function toggleCurrentTabRun() {
  const button = $("runToggle");
  const provider = panelContext.provider;
  const targetTabId = panelContext.targetTabId;
  if (!panelContext.supported || !provider || !targetTabId) {
    setStatus("Không xác định được tab AI. Hãy mở ChatGPT, Grok, Claude hoặc Gemini.", true);
    return;
  }
  const stopping = currentTabIsRunning();
  const sourceType = normalizeSourceType(stopping ? currentTabWorker()?.sourceType || selectedSourceType() : selectedSourceType());
  if (!stopping && queueLoadFailure()) { setStatus(queueLoadFailure().message, true); updateRunButton(); return; }
  if (!stopping && !canRunSourceOnProvider(sourceType, provider)) {
    const message = imageProviderMessage(provider);
    setStatus(message, true);
    updateRunButton();
    return;
  }
  if (stopping) {
    button.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "stop-run", targetTabId, provider });
      if (!result?.ok) throw new Error(result?.error || "Không dừng được tab này.");
      const latest = await chrome.storage.local.get(["runner"]);
      if (latest.runner) state.runner = latest.runner;
      if (currentTabIsRunning()) updateLocalWorker(false);
      setStatus(`Đã dừng ${providerName(provider)} trên tab này`);
    } catch (error) { setStatus(error.message, true); }
    finally { updateRunButton(); }
    return;
  }
  setStatus(`Đang mở hàng đợi bằng ${providerName(provider)}…`); button.disabled = true;
  try {
    await saveTabSourcePreference();
    const request = { type: "start-run", targetTabId, provider, sourceType };
    if (sourceType === "translation") request.translationType = selectedTranslationType();
    const result = await chrome.runtime.sendMessage(request);
    if (!result || result.ok !== true) {
      if (sourceType === "doctor" && result?.doctorQueueError) state.doctorQueueState = result.queueState || doctorQueueFailure({ message: result.error, httpStatus: result.httpStatus });
      throw new Error(result?.error || "Không nhận được phản hồi từ extension. Hãy Reload extension rồi tải lại tab AI.");
    }
    const latest = await chrome.storage.local.get(["runner"]);
    if (latest.runner) state.runner = latest.runner;
    if (!latest.runner && !currentTabIsRunning()) updateLocalWorker(true);
    updateRunButton();
    setStatus(currentTabIsRunning() ? `Đang chạy ${providerName(provider)} trên tab này.` : "Đã kiểm tra hàng đợi; hiện không có bài chạy trên tab này.");
  } catch (error) { setStatus(error.message, true); }
  finally { render(); }
}
$("runToggle").onclick = toggleCurrentTabRun;
init();
function closeJsonViewer() { viewerRequestId++; $("jsonModal").hidden = true; $("modalJson").textContent = ""; }
$("closeJson").onclick = closeJsonViewer;
$("copyJson").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("modalJson").textContent || "");
    $("copyJson").title = "Đã sao chép";
    setTimeout(() => { $("copyJson").title = "Sao chép nội dung"; }, 1200);
  } catch { setStatus("Không thể sao chép nội dung", true); }
};
$("settings").onclick = (event) => { if (event.target === $("settings")) closeSettings(); };
$("jsonModal").onclick = (event) => { if (event.target === $("jsonModal")) closeJsonViewer(); };
document.addEventListener?.("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("jsonModal").hidden) closeJsonViewer();
  else if (!$("settings").hidden) closeSettings();
});
