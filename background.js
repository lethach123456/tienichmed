const DEFAULTS = {
  provider: "chatgpt",
  facilitiesUrl: "https://medreview.vn/api/medical/facilities-needing-content.php?page=1&limit=1&type=facility",
  updateUrl: "https://medreview.vn/api/medical/facility-content-update.php",
  doctorsUrl: "https://medreview.vn/api/medical/doctors-needing-content.php?page=1&limit=25",
  doctorUpdateUrl: "https://medreview.vn/api/medical/doctor-content-update.php",
  doctorContentUrl: "https://medreview.vn/api/medical/doctor-content.php",
  handbooksUrl: "https://medreview.vn/api/medical/handbooks-needing-content.php?limit=10&language=vi",
  handbookUpdateUrl: "https://medreview.vn/api/medical/handbook-content-update.php",
  facilityImageFixUrl: "https://medreview.vn/api/medical/facilities-needing-image-fix.php?limit=10",
  facilityImageFixUpdateUrl: "https://medreview.vn/api/medical/facility-image-fix-update.php",
  toplistsUrl: "https://medreview.vn/api/medical/toplists-needing-members.php?page=1&limit=1",
  toplistUpdateUrl: "https://medreview.vn/api/medical/toplist-members-update.php",
  aiImagesUrl: "https://medreview.vn/api/medical/facilities-needing-ai-images.php?page=1&limit=1&min_images=3",
  aiImageUpdateUrl: "https://medreview.vn/api/medical/facility-ai-image-update.php",
  writerClaimUrl: "https://medreview.vn/api/medical/writer-claim.php",
  instance_id: "",
  instance_label: "Máy chưa đặt tên",
  account_label: "AI account chưa đặt tên",
  translationUrl: "https://medreview.vn/api/medical/translate-content.php",
  translationType: "facility",
  nextJobDelayMs: 60000,
  items: []
};
const API_URL_KEYS = [
  "facilitiesUrl", "updateUrl", "doctorsUrl", "doctorUpdateUrl", "doctorContentUrl", "handbooksUrl", "handbookUpdateUrl", "facilityImageFixUrl", "facilityImageFixUpdateUrl", "toplistsUrl", "toplistUpdateUrl", "aiImagesUrl", "aiImageUpdateUrl", "writerClaimUrl", "translationUrl"
];
// Kept in the background worker so normal page scripts never receive it.
// It is passed only to this extension's isolated content script immediately
// before the authenticated, one-off multipart upload.
// Private installation config is intentionally ignored by Git. Missing config
// never falls back to a credential embedded in the distributed source.
try { if (typeof importScripts === "function") importScripts("api-key.local.js"); } catch {}
const MEDICAL_API_KEY = String(globalThis.MEDREVIEW_MEDICAL_API_KEY || "");
try { if (typeof importScripts === "function") importScripts("handbook.js"); } catch {}
// Spark conversation IDs are account/session specific.  The content script
// resolves this visible task label to the current account's conversation ID.
const GEMINI_SPARK_CONTENT_TASK_LABEL = "content ai";
const PROVIDER_CONFIG = {
  chatgpt: { label: "ChatGPT", host: "chatgpt.com" },
  grok: { label: "Grok", host: "grok.com" },
  claude: { label: "Claude", host: "claude.ai" },
  gemini: { label: "Gemini", host: "gemini.google.com" }
};
let refillPromise = null;
const workerRefillPromises = new Map();
let schedulerLock = Promise.resolve();
const activeApiRequests = new Set();
const writerClaimRenewals = new Map();
let writerClaimHeartbeatPromise = null;
let writerClaimAlarmPromise = null;
let closedTabRecoveryPromise = null;
const activeSparkDispatchRetries = new Set();
const activeNextJobResumes = new Set();
const NEXT_JOB_ALARM_PREFIX = "medreview-next-job:";
const RUNNER_RECOVERY_ALARM = "medreview-runner-recovery";
const QUEUE_FETCH_TIMEOUT_MS = 60000;
const COMPLETED_HISTORY_LIMIT = 2;
// items contains only small queue/status rows. Large content is read on demand.
const RAW_JOB_STORAGE = chrome.storage.local;
const ARTICLE_CONTENT_FIELDS = ["prompt", "result", "rawResponse", "output_template", "translation_fields", "source", "gallery_json", "notes", "images", "image_fix_payload", "image_fix_previous_result"];
const ARTICLE_CONTENT_PREFIX = "article-content:";
const TAB_ITEMS_PREFIX = "tab-job-items:";
const hydratedContentOrigins = new WeakMap();
function isStorageQuotaError(error) {
  return error?.code === "storage_quota_exceeded" || error?.storageError === true ||
    /kQuotaBytes|QUOTA_BYTES|storage.{0,30}quota.{0,30}exceeded/i.test(String(error?.message || error || ""));
}
function storageQuotaFailure() {
  return { storageError: true, code: "storage_quota_exceeded", status: "error", httpStatus: null, schemaUnavailable: false,
    message: "Bộ nhớ lưu dữ liệu của tiện ích đã vượt giới hạn Chrome, không phải lỗi API.",
    help: "Cập nhật tiện ích rồi bấm Tải lại (Reload) tại chrome://extensions để áp dụng quyền lưu trữ mới; sau đó tải lại tab AI và bấm Thử lại. Không gỡ tiện ích hoặc xóa dữ liệu: JSON đang chờ/gửi lỗi cần được giữ lại." };
}
async function writeJobStorage(values) {
  try { return await RAW_JOB_STORAGE.set(values); }
  catch (error) {
    if (!isStorageQuotaError(error)) throw error;
    // No emergency clear/truncation: failed/unsent JSON and staged receipts
    // must remain byte-identical for a safe retry after the extension reload.
    const failure = new Error(storageQuotaFailure().message);
    failure.code = "storage_quota_exceeded";
    failure.storageError = true;
    throw failure;
  }
}
function extensionErrorResponse(error) {
  const storage = isStorageQuotaError(error);
  return { ok: false, error: storage ? storageQuotaFailure().message : error.message,
    ...(storage ? { storageError: true, errorCode: "storage_quota_exceeded", queueState: storageQuotaFailure() } : {}),
    ...(!storage && error.doctorQueueError ? { httpStatus: error.httpStatus || null, doctorQueueError: true,
      queueState: error.queueState || doctorQueueStateFromError(error) } : {}) };
}
function articleMetadata(item) {
  const metadata = { ...item };
  for (const field of ARTICLE_CONTENT_FIELDS) delete metadata[field];
  metadata.has_result = Boolean(item.result || item.has_result);
  return metadata;
}
async function hydrateArticle(metadata) {
  if (!metadata) return metadata;
  const key = ARTICLE_CONTENT_PREFIX + metadata.id;
  const stored = metadata.content_version ? (await RAW_JOB_STORAGE.get(key))[key] || {} : {};
  const item = { ...metadata, ...stored };
  hydratedContentOrigins.set(item, Object.fromEntries(ARTICLE_CONTENT_FIELDS.map((field) => [field, item[field]])));
  return item;
}
const jobStorage = {
  async get(keys, { metadataOnly = false } = {}) {
    const values = await RAW_JOB_STORAGE.get(keys);
    if (Array.isArray(values.items)) values.items = metadataOnly
      ? values.items.map((item) => item.content_version ? articleMetadata(item) : item)
      : await Promise.all(values.items.map(hydrateArticle));
    return values;
  },
  async set(values) {
    if (!Array.isArray(values.items)) return writeJobStorage(values);
    const oldItems = (await RAW_JOB_STORAGE.get("items")).items || [];
    const oldById = new Map(oldItems.map((item) => [item.id, item]));
    const writes = { ...values };
    writes.items = await Promise.all(values.items.map(async (item) => {
      const previous = oldById.get(item.id);
      const origin = hydratedContentOrigins.get(item);
      const metadata = articleMetadata(item);
      const changed = ARTICLE_CONTENT_FIELDS.some((field) => Object.hasOwn(item, field) && (!origin || item[field] !== origin[field]));
      const legacy = previous && ARTICLE_CONTENT_FIELDS.some((field) => Object.hasOwn(previous, field));
      if (changed || legacy || !previous) {
        const oldContent = previous?.content_version ? (await RAW_JOB_STORAGE.get(ARTICLE_CONTENT_PREFIX + item.id))[ARTICLE_CONTENT_PREFIX + item.id] || {} : {};
        // Include existing content for metadata-only writes during migration.
        writes[ARTICLE_CONTENT_PREFIX + item.id] = { ...oldContent, ...Object.fromEntries(ARTICLE_CONTENT_FIELDS
          .filter((field) => Object.hasOwn(item, field) || Object.hasOwn(previous || {}, field))
          .map((field) => [field, Object.hasOwn(item, field) ? item[field] : previous[field]])) };
        metadata.content_version = (Number(previous?.content_version) || 0) + 1;
        metadata.has_result = Boolean(writes[ARTICLE_CONTENT_PREFIX + item.id].result);
      } else {
        metadata.content_version = previous?.content_version || item.content_version;
        metadata.has_result = previous?.has_result || metadata.has_result;
      }
      return metadata;
    }));
    // Each panel reads only its own persisted queue/history. `items` remains
    // a small scheduler index, never a shared queue handed to another tab.
    const tabIds = new Set([...oldItems, ...writes.items].map(itemOwnerTabId).filter(Boolean));
    for (const tabId of tabIds) {
      const tabItems = writes.items.filter((item) => itemOwnerTabId(item) === tabId);
      const previousTabItems = oldItems.filter((item) => itemOwnerTabId(item) === tabId);
      if (JSON.stringify(tabItems) !== JSON.stringify(previousTabItems)) writes[TAB_ITEMS_PREFIX + tabId] = tabItems;
    }
    await writeJobStorage(writes);
    const retainedIds = new Set(values.items.map((item) => item.id));
    const removedKeys = oldItems.filter((item) => !retainedIds.has(item.id)).map((item) => ARTICLE_CONTENT_PREFIX + item.id);
    if (removedKeys.length) {
      if (typeof RAW_JOB_STORAGE.remove === "function") await RAW_JOB_STORAGE.remove(removedKeys);
      else await RAW_JOB_STORAGE.set(Object.fromEntries(removedKeys.map((key) => [key, null])));
    }
  }
};
const getJobMetadata = (keys) => jobStorage.get(keys, { metadataOnly: true });
async function getTabSettings(tabId, keys) {
  const wanted = Array.isArray(keys) ? keys : [keys];
  const namespace = Number(tabId) > 0 ? `tab-api-settings:${Number(tabId)}` : null;
  const stored = await jobStorage.get([...wanted, ...(namespace ? [namespace] : [])]);
  const settings = { ...stored, ...(namespace ? stored[namespace] || {} : {}) };
  for (const key of wanted) if (API_URL_KEYS.includes(key)) settings[key] = migrateApiSetting(key, settings[key]);
  return settings;
}
const SYSTEM_PHASES = new Set(["preparing", "connecting", "claiming", "finding-input", "filling", "waiting-send", "sending", "waiting-ai", "writing-images", "attaching-images", "reading-json", "validating-json", "saving-json", "recovering", "retrying"]);

const SOURCE_TYPES = new Set(["facility", "doctor", "handbook", "facility_image_fix", "toplist", "ai-image", "translation"]);
const TRANSLATION_TYPES = new Set(["facility", "doctor", "toplist"]);
// Image generation is intentionally kept narrower than text generation. The
// ChatGPT and Grok integrations have a reliable two-step image flow; Claude
// and Gemini currently only support the article/Toplist flow.
const AI_IMAGE_PROVIDERS = new Set(["chatgpt", "grok"]);
const UNSUPPORTED_IMAGE_PROVIDER_FAILURE = "unsupported-ai-image-provider";
// Website updates are never aborted. If Chrome restarts during a request,
// preserve the JSON and surface an uncertain outcome after 30 minutes rather
// than leaving a pending spinner indefinitely. Live requests are excluded.
const API_UPDATE_STALE_MS = 30 * 60 * 1000;
const API_UPDATE_UNCONFIRMED_MESSAGE = "Chrome không còn nhận được phản hồi xác nhận từ website sau 30 phút. JSON vẫn được lưu trong tiện ích; yêu cầu trước có thể đã tới server, hãy kiểm tra website trước khi gửi lại.";
// The page timer reloads every ten minutes. This MV3 alarm is the fallback
// when a frozen Gemini renderer prevents its content script from running.
const GEMINI_SPARK_STALL_ALARM = "medreview-gemini-spark-stall-watchdog";
const GEMINI_SPARK_RELOAD_INTERVAL_MS = 10 * 60 * 1000;
const GEMINI_SPARK_RELOAD_COOLDOWN_MS = 10 * 60 * 1000;
const WRITER_CLAIM_HEARTBEAT_ALARM = "medreview-writer-claim-heartbeat";
const WRITER_CLAIM_HEARTBEAT_MINUTES = 0.75;
const WRITER_CLAIM_LEASE_MS = 180 * 1000;
const WRITER_CLAIM_REQUEST_TIMEOUT_MS = 20000;
let writerIdentityPromise = null;

function normalizeSourceType(value, fallback = "facility") {
  return SOURCE_TYPES.has(value) ? value : fallback;
}

function sourceLabel(sourceType) {
  if (sourceType === "handbook") return "bài Cẩm nang";
  if (sourceType === "facility_image_fix") return "Fix ảnh cơ sở y tế";
  if (sourceType === "doctor") return "hồ sơ bác sĩ";
  if (sourceType === "toplist") return "Toplist";
  if (sourceType === "ai-image") return "ảnh AI";
  if (sourceType === "translation") return "bản dịch Việt → Anh";
  return "cơ sở";
}

function normalizeTranslationType(value, fallback = "facility") {
  const normalized = String(value || "").toLowerCase();
  return TRANSLATION_TYPES.has(normalized) ? normalized : fallback;
}

function isAiImageProvider(provider) {
  return AI_IMAGE_PROVIDERS.has(String(provider || "").toLowerCase());
}

function unsupportedAiImageProviderMessage(provider) {
  const label = providerLabel(provider);
  return `Tạo ảnh AI hiện chỉ hỗ trợ ChatGPT hoặc Grok. ${label} vẫn dùng được để viết bài và Toplist.`;
}

function normalizeFailureProvider(item) {
  return String(item?.failed_provider ?? item?.failedProvider ?? item?.provider ?? "").toLowerCase();
}

function isUnsupportedAiImageProvider(provider) {
  return ["claude", "gemini"].includes(String(provider || "").toLowerCase());
}

function isUnsupportedAiImageProviderError(error) {
  const message = String(error || "").toLowerCase();
  const normalized = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!message || !(message.includes("ảnh ai") || normalized.includes("tao anh ai"))) {
    return false;
  }
  // Require both supported provider names plus an explicit support constraint.
  // That keeps generic generation/API failures out of automatic retries.
  return message.includes("chatgpt") && message.includes("grok") &&
    /(?:chi|hien|khong|chua)[^.!\n]{0,80}(?:ho tro|support)|(?:ho tro|support)[^.!\n]{0,80}(?:chi|hien|khong|chua)/.test(normalized);
}

function isUnsupportedAiImageProviderFailure(item) {
  if (!isAiImageItem(item) || item?.status !== "lỗi") return false;
  const provider = normalizeFailureProvider(item);
  if (!isUnsupportedAiImageProvider(provider)) return false;
  return item?.failure_code === UNSUPPORTED_IMAGE_PROVIDER_FAILURE ||
    item?.failureCode === UNSUPPORTED_IMAGE_PROVIDER_FAILURE ||
    isUnsupportedAiImageProviderError(item?.error);
}

function requeueUnsupportedAiImageFailures(items) {
  let requeued = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!isUnsupportedAiImageProviderFailure(item)) continue;
    item.status = "chờ";
    delete item.error;
    delete item.rawResponse;
    delete item.provider;
    delete item.workerKey;
    delete item.workerTabId;
    delete item.failure_code;
    delete item.failureCode;
    delete item.failed_provider;
    delete item.failedProvider;
    item.requeued_at = new Date().toISOString();
    requeued += 1;
  }
  return requeued;
}

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
    // Only migrate known MedReview legacy endpoints, never an arbitrary custom API.
    if (!["medreview.vn", "www.medreview.vn"].includes(url.hostname.toLowerCase())) return value;
    const oldPath = key === "toplistsUrl" ? "/api/medical/toplists-needing-facilities.php" : "/api/medical/toplist-facilities-update.php";
    if (url.pathname !== oldPath) return value;
    url.pathname = key === "toplistsUrl" ? "/api/medical/toplists-needing-members.php" : "/api/medical/toplist-members-update.php";
    return url.href;
  } catch { return value; }
}

async function initializeExtensionStorage() {
  const current = await jobStorage.get(Object.keys(DEFAULTS));
  const instanceId = await ensureWriterInstanceId(current.instance_id);
  await withSchedulerLock(async () => {
    // Re-read under the queue lock: startRun may have claimed a row while the
    // service-worker startup migration was waiting for the persistent profile
    // ID. Never write an older startup snapshot over a live queue/lease.
    const latest = await jobStorage.get(Object.keys(DEFAULTS));
    if (Array.isArray(latest.items)) {
      latest.items = latest.items.map((item) => isLegacyInsufficientReplacementFailure(item)
        ? { ...item, image_fix_requires_research: false, image_fix_reclaim_allowed: true, image_fix_error_code: null, api_error_code: null }
        : item);
    }
    const migrated = Object.fromEntries(API_URL_KEYS
      .filter((key) => Object.hasOwn(latest, key))
      .map((key) => [key, migrateApiSetting(key, latest[key])])
    );
    await jobStorage.set({ ...DEFAULTS, ...latest, ...migrated, instance_id: instanceId });
    const keys = typeof RAW_JOB_STORAGE.getKeys === "function" ? await RAW_JOB_STORAGE.getKeys() : Object.keys(await RAW_JOB_STORAGE.get(null));
    const tabKeys = keys.filter((key) => key.startsWith("tab-api-settings:"));
    if (tabKeys.length) {
      const tabs = await RAW_JOB_STORAGE.get(tabKeys);
      const writes = {};
      for (const key of tabKeys) {
        const saved = tabs[key];
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) continue;
        const updated = { ...saved };
        for (const field of API_URL_KEYS) if (Object.hasOwn(saved, field)) updated[field] = migrateApiSetting(field, saved[field]);
        if (JSON.stringify(updated) !== JSON.stringify(saved)) writes[key] = updated;
      }
      if (Object.keys(writes).length) await RAW_JOB_STORAGE.set(writes);
    }
  });
  await reconcileClosedTabJobs();
  await reconcileStaleApiUpdates();
  await pruneCompletedHistory();
}

function trimCompletedHistory(items, runner) {
  const protectedIds = new Set(Object.values(runner?.workers || {}).map((worker) => worker.currentId).filter(Boolean));
  if (runner?.currentId) protectedIds.add(runner.currentId);
  const recent = items.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === "hoàn tất")
    .sort((a, b) => (Date.parse(b.item.completed_at || b.item.api_last_attempt_at || "") || 0) - (Date.parse(a.item.completed_at || a.item.api_last_attempt_at || "") || 0) || b.index - a.index);
  const keep = new Set();
  const counts = new Map();
  for (const { item } of recent) {
    const group = `${itemOwnerTabId(item) || "legacy"}:${queueItemSource(item)}:${isTranslationItem(item) ? normalizeTranslationType(item.type || item.translation_type) : ""}`;
    const count = counts.get(group) || 0;
    if (count < COMPLETED_HISTORY_LIMIT) keep.add(item);
    counts.set(group, count + 1);
  }
  return items.filter((item) => item.status !== "hoàn tất" || keep.has(item) || protectedIds.has(item.id) ||
    activeApiRequests.has(String(item.id)) || item.writer_claim_token || item.writer_claim_release_pending);
}

async function pruneCompletedHistory() {
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const retained = trimCompletedHistory(items, runner);
    if (retained.length !== items.length) await jobStorage.set({ items: retained });
    return { removed: items.length - retained.length };
  });
}

chrome.runtime.onInstalled.addListener(() => {
  registerGeminiSparkStallAlarm();
  registerWriterClaimHeartbeatAlarm();
  registerRunnerRecoveryAlarm();
  initializeExtensionStorage().catch(() => {});
});
// Also migrate users' saved URLs when Chrome wakes an existing service
// worker, including unpacked-extension reloads that do not fire onInstalled.
registerGeminiSparkStallAlarm();
registerWriterClaimHeartbeatAlarm();
registerRunnerRecoveryAlarm();
initializeExtensionStorage().then(restoreNextJobAlarms).catch(() => {});

function registerGeminiSparkStallAlarm() {
  try {
    chrome.alarms?.create?.(GEMINI_SPARK_STALL_ALARM, { periodInMinutes: 1 });
  } catch {}
}

function registerWriterClaimHeartbeatAlarm() {
  if (writerClaimAlarmPromise) return writerClaimAlarmPromise;
  writerClaimAlarmPromise = (async () => {
    try {
      // Recreating a named alarm on each service-worker wake postpones it.
      const existing = await chrome.alarms?.get?.(WRITER_CLAIM_HEARTBEAT_ALARM);
      if (!existing) await chrome.alarms?.create?.(WRITER_CLAIM_HEARTBEAT_ALARM, { periodInMinutes: WRITER_CLAIM_HEARTBEAT_MINUTES });
    } catch { /* A later startup/install will check again. */ }
  })().finally(() => { writerClaimAlarmPromise = null; });
  return writerClaimAlarmPromise;
}

function registerRunnerRecoveryAlarm() {
  try { chrome.alarms?.create?.(RUNNER_RECOVERY_ALARM, { periodInMinutes: 1 }); } catch {}
}

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === RUNNER_RECOVERY_ALARM) return recoverIdleWorkers().catch(() => {});
  if (alarm?.name?.startsWith(NEXT_JOB_ALARM_PREFIX)) {
    return resumeNextJobDeadline(alarm.name.slice(NEXT_JOB_ALARM_PREFIX.length)).catch(() => {});
  }
  if (alarm?.name === GEMINI_SPARK_STALL_ALARM) {
    checkGeminiSparkStalls().catch(() => {});
  }
  if (alarm?.name === WRITER_CLAIM_HEARTBEAT_ALARM) {
    heartbeatActiveWriterClaims().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "get-article-content") {
    getArticleContent(message.articleId, Number(sender?.tab?.id || message.targetTabId) || null).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "replace-queue-items") {
    replaceQueueItems(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "fetch-facilities") {
    fetchFacilities().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "fetch-toplists") {
    fetchToplists().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "fetch-ai-images") {
    fetchAiImages().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "refresh-queue") {
    refreshQueue(message.sourceType, message.translationType, Number(sender?.tab?.id || message.targetTabId) || null).then((result) => sendResponse({ ...result, items: result.items?.map(articleMetadata) })).catch((error) => sendResponse(extensionErrorResponse(error)));
    return true;
  }
  if (message.type === "retry-update") {
    assertArticleTab(message.articleId, message, sender).then(() => retryUpdate(message.articleId)).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "retry-image-fix-research") {
    assertArticleTab(message.articleId, message, sender).then(() => retryFacilityImageFixResearch(message.articleId)).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "retry-article") {
    assertArticleTab(message.articleId, message, sender).then(() => retryFailedArticle(message.articleId)).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "reconcile-api-status") {
    reconcileStaleApiUpdates().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "article-progress") {
    recordArticleProgress(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "article-system-notice") {
    recordSystemNotice(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "article-prompt-sent") {
    recordArticlePromptSent(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "article-prompt-prepared") {
    recordArticlePromptPrepared(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "article-retry-countdown") {
    recordArticleRetryCountdown(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "mark-gemini-spark-stall-reload") {
    markGeminiSparkStallReload(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "recover-existing-article") {
    recoverExistingArticle(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "get-tab-context") {
    getTabContext(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "bind-spark-task" || message.type === "save-task-meta") {
    bindSparkTask(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "start-run") {
    startRun(message, sender).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "continue-after-reload") {
    continueAfterReload(sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "stop-run") {
    stopRun(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "get-current-article") {
    getCurrentArticle(message.provider, sender).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "prepare-ai-image-upload") {
    prepareAiImageUpload(message, sender).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "article-complete") {
    handleArticleComplete(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "image-complete" || message.type === "image-result") {
    handleImageComplete(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "article-failed") {
    handleArticleFailed(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "image-failed") {
    handleArticleFailed(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

async function assertArticleTab(articleId, request, sender) {
  const tabId = Number(sender?.tab?.id || request?.targetTabId) || null;
  if (!tabId) return;
  const { items = [] } = await getJobMetadata("items");
  const item = items.find((entry) => entry.id === articleId);
  if (itemOwnerTabId(item) && itemOwnerTabId(item) !== tabId) throw new Error("Bài này thuộc bộ nhớ của tab khác.");
}

async function getArticleContent(articleId, ownerTabId = null) {
  const { items = [] } = await getJobMetadata("items");
  const metadata = items.find((item) => item.id === articleId);
  if (!metadata) return { ok: false, error: "Bài không còn trong tiện ích." };
  if (ownerTabId && itemOwnerTabId(metadata) && itemOwnerTabId(metadata) !== ownerTabId) return { ok: false, error: "Bài này thuộc bộ nhớ của tab khác." };
  const item = await hydrateArticle(metadata);
  if (isHandbookItem(item) && item.handbook_payload_saved) {
    const saved = await MedReviewHandbook.store.get(item.id);
    if (saved?.result) return { ok: true, content: { prompt: item.prompt, result: saved.result } };
  }
  return { ok: true, content: Object.fromEntries(ARTICLE_CONTENT_FIELDS.filter((field) => field !== "image_fix_payload" && Object.hasOwn(item, field)).map((field) => [field, item[field]])) };
}

async function replaceQueueItems(message, sender = {}) {
  const pending = await withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const keep = new Set((message.items || []).map((item) => item.id));
    const explicit = Array.isArray(message.removeArticleIds) ? new Set(message.removeArticleIds) : null;
    const tabId = Number(sender?.tab?.id || message.targetTabId) || null;
    const scope = { ownerTabId: tabId, sourceType: normalizeSourceType(message.sourceType), translationType: normalizeTranslationType(message.translationType) };
    const removed = items.filter((item) => (explicit ? explicit.has(item.id) : !keep.has(item.id)) && (!tabId || queueItemMatchesRunner(item, scope)));
    const owned = new Set([...Object.values(runner?.workers || {}).map((worker) => worker.currentId), runner?.currentId]);
    if (removed.some((item) => owned.has(item.id) || activeApiRequests.has(String(item.id)))) throw new Error("Bài này đang xử lý, chưa thể xoá.");
    const claims = removed.filter((item) => isFacilityImageFixItem(item) && item.writer_claim_token);
    const ids = new Set(removed.map((item) => item.id));
    if (!claims.length) { await jobStorage.set({ items: items.filter((item) => !ids.has(item.id)) }); return null; }
    // Reserve idle fix jobs while releasing, so a retry cannot race cancellation.
    for (const item of claims) activeApiRequests.add(String(item.id));
    return { claims, ids };
  });
  if (!pending) return { ok: true };
  try {
    for (const item of pending.claims) {
      const released = await releaseWriterClaim(item);
      if (released.ok === false) throw new Error(`Chưa xóa Fix ảnh vì chưa trả được khóa: ${released.error}. Dữ liệu vẫn được giữ để thử lại.`);
    }
    await withSchedulerLock(async () => {
      const { items = [], runner } = await getJobMetadata(["items", "runner"]);
      const owned = [...Object.values(runner?.workers || {}).map((worker) => worker.currentId), runner?.currentId];
      if (owned.some((id) => pending.ids.has(id))) throw new Error("Bài đã bắt đầu xử lý; chưa xóa.");
      await jobStorage.set({ items: items.filter((item) => !pending.ids.has(item.id)) });
    });
    return { ok: true };
  } finally { for (const item of pending.claims) activeApiRequests.delete(String(item.id)); }
}

chrome.tabs?.onRemoved?.addListener((tabId) => {
  return cleanupClosedTabJobs(tabId).then(() => runNext()).catch(() => {});
});

chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo?.url) return;
  stopWorkerIfProviderChanged(tabId, tab).catch(() => {});
});

async function startRun(request = {}, sender = {}) {
  if (typeof request === "string") request = { provider: request };
  const context = await resolveControlTab(request, sender);
  await reconcileClosedTabJobs();
  const result = await withSchedulerLock(async () => {
    const { runner: savedRunner, sourceType, translationType: savedTranslationType, items = [] } = await getJobMetadata(["runner", "sourceType", "translationType", "items"]);
    const workers = savedRunner?.active ? normalizeRunnerWorkers(savedRunner, items) : {};
    const wasActive = Object.values(workers).some((worker) => worker?.active);
    // Resolve the active source before changing worker state. An unsupported
    // Image AI click must not claim a job or leave behind a phantom worker.
    const preferenceKey = `tab-task-source:${context.tabId}`;
    const preference = (await jobStorage.get(preferenceKey))[preferenceKey];
    const selectedSource = normalizeSourceType(request.sourceType || preference?.sourceType || sourceType);
    const selectedTranslationType = normalizeTranslationType(
      request.translationType || preference?.translationType || savedTranslationType || savedRunner?.translationType
    );
    if (selectedSource === "doctor") {
      const key = doctorQueueStateKey(context.tabId);
      const queueState = (await jobStorage.get(key))[key];
      if (queueState?.status === "error") return { ok: false, error: queueState.message, httpStatus: queueState.httpStatus,
        doctorQueueError: true, queueState, sourceType: selectedSource, ...context };
      if (queueState?.status === "loading") return { ok: false, error: "Đang tải danh sách hồ sơ bác sĩ; chờ API phản hồi rồi bấm Chạy.",
        doctorQueueLoading: true, queueState, sourceType: selectedSource, ...context };
    }
    if (selectedSource === "ai-image" && !isAiImageProvider(context.provider)) {
      return {
        ok: false,
        error: unsupportedAiImageProviderMessage(context.provider),
        sourceType: selectedSource,
        ...context
      };
    }
    if (context.sparkTaskId) {
      let conflicting = null;
      for (const [key, worker] of Object.entries(workers)) {
        if (key === context.workerKey || !worker?.active || worker.provider !== "gemini") continue;
        let workerTaskId = worker.sparkTaskId || null;
        if (!workerTaskId && Number(worker.targetTabId) > 0 && typeof chrome.tabs.get === "function") {
          try { workerTaskId = geminiSparkTaskIdFromTab(await chrome.tabs.get(Number(worker.targetTabId))); } catch {}
        }
        if (workerTaskId === context.sparkTaskId) { conflicting = [key, worker]; break; }
      }
      if (conflicting) {
        return {
          ok: false,
          error: `Task Gemini Spark này đang chạy ở tab ${conflicting[1].targetTabId}; dùng hoặc dừng tab đó trước.`,
          ...context
        };
      }
    }
    const existing = findWorkerForTab({ workers }, context.tabId, context.provider);
    if (existing && existing[0] !== context.workerKey) delete workers[existing[0]];
    const alreadyActive = Boolean(existing?.[1]?.active);
    if (!alreadyActive) {
      workers[context.workerKey] = {
        ...(existing?.[1] || {}), active: true, provider: context.provider,
        sourceType: selectedSource, translationType: selectedTranslationType,
        sessionToken: createRunToken(), refilling: false,
        currentId: null, runToken: createRunToken(), targetTabId: context.tabId,
        ...(context.sparkTaskId ? { sparkTaskId: context.sparkTaskId } : {}),
        lastError: null
      };
    } else if (existing[0] !== context.workerKey) {
      workers[context.workerKey] = {
        ...existing[1], provider: context.provider, targetTabId: context.tabId,
        ...(context.sparkTaskId ? { sparkTaskId: context.sparkTaskId } : {})
      };
    }
    const activeWorkers = Object.values(workers).filter((worker) => worker?.active);
    // Old releases could fail an image job only because it was sent to Gemini
    // or Claude. Let a newly started supported provider retry exactly those
    // jobs; other failures remain visible for manual review.
    const requeuedUnsupportedImageJobs = selectedSource === "ai-image" && !alreadyActive
      ? requeueUnsupportedAiImageFailures(items.filter((item) => !itemOwnerTabId(item) || itemOwnerTabId(item) === context.tabId))
      : 0;
    const runner = {
      ...(savedRunner || {}), active: true, parallel: activeWorkers.length > 1,
      provider: activeWorkers.length > 1 ? "multi-tab" : context.provider,
      sourceType: wasActive ? savedRunner.sourceType : selectedSource,
      translationType: wasActive ? savedRunner.translationType : selectedTranslationType,
      sessionToken: wasActive && savedRunner.sessionToken ? savedRunner.sessionToken : createRunToken(),
      workers, refilling: wasActive ? Boolean(savedRunner.refilling) : false,
      lastError: null,
      lastMessage: `Đã bắt đầu ${providerLabel(context.provider)} trên tab này`
    };
    refreshRunnerSummary(runner, items);
    await jobStorage.set({ items, runner, [preferenceKey]: {
      sourceType: workers[context.workerKey].sourceType,
      translationType: workers[context.workerKey].translationType
    } });
    return { ok: true, alreadyActive, requeuedUnsupportedImageJobs, ...context };
  });
  if (!result.ok) return result;
  if (!result.alreadyActive) await runNext(result.workerKey);
  else {
    if (result.sparkTaskId) await resumeIdleSparkWorkers(result.workerKey);
    await resumeNextJobDeadline(result.workerKey);
  }
  if (request.sourceType === "doctor" || (await getJobMetadata("runner")).runner?.workers?.[result.workerKey]?.sourceType === "doctor") {
    const key = doctorQueueStateKey(context.tabId);
    const queueState = (await jobStorage.get(key))[key];
    if (queueState?.status === "error") return { ...result, ok: false, error: queueState.message,
      httpStatus: queueState.httpStatus, doctorQueueError: true, queueState };
  }
  return result;
}

function createRunToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function ensureWriterInstanceId(preferred = "") {
  if (String(preferred || "").trim()) return String(preferred).trim();
  if (!writerIdentityPromise) {
    writerIdentityPromise = withSchedulerLock(async () => {
      const stored = await jobStorage.get("instance_id");
      if (String(stored.instance_id || "").trim()) return String(stored.instance_id).trim();
      const instanceId = createRunToken();
      await jobStorage.set({ instance_id: instanceId });
      return instanceId;
    }).finally(() => { writerIdentityPromise = null; });
  }
  return writerIdentityPromise;
}

function writerClaimType(item) {
  if (item?.sourceType === "handbook") return "handbook";
  // The current supported article writer queue is facilities. Keep the type
  // resolver generic for a future doctor-content queue, without routing any
  // doctor result through facility-content-update.php.
  const explicit = String(item?.writer_type || item?.source_type || item?.sourceType || "").toLowerCase();
  if (isFacilityImageFixItem(item)) return "facility";
  if (["toplist", "ai-image", "ai_image", "image", "translation"].includes(explicit)) return null;
  if (explicit === "doctor" || item?.doctor_id != null) return "doctor";
  if (explicit === "facility" || item?.facility_id != null) return "facility";
  return null;
}

function writerClaimRecordId(item, type = writerClaimType(item)) {
  if (type === "handbook") return item.handbook_id;
  if (type === "doctor") return item?.doctor_id ?? item?.source_id ?? item?.id;
  if (type === "facility") return item?.facility_id ?? item?.source_id ?? item?.id;
  return null;
}

function writerMetadata(value = {}, fallback = {}) {
  let source = value?.writer || value?.writer_claim || value || {};
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { source = {}; }
  }
  const result = {};
  for (const key of ["provider", "model", "instance_label", "account_label", "worker_id", "task"]) {
    const candidate = source[key] ?? fallback[key];
    if (candidate != null && String(candidate).trim()) result[key] = String(candidate).trim();
  }
  return result;
}

function truthyApiFlag(value) {
  return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
}

function writerClaimDisplay(item) {
  const writer = writerMetadata(item?.writer_claim);
  const parts = [writer.provider ? providerLabel(writer.provider.toLowerCase()) : "AI"];
  if (writer.instance_label) parts.push(writer.instance_label);
  if (writer.account_label) parts.push(writer.account_label);
  return parts.join(" · ");
}

function isQueueItemRunnable(item) {
  return item?.status === "chờ" && item?.writer_claimed !== true && item?.writer_claim_release_pending !== true;
}

async function retryFailedArticle(articleId) {
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const item = items.find((entry) => String(entry.id) === String(articleId));
    if (!item || item.status !== "lỗi") throw new Error("Bài không còn ở trạng thái lỗi để chạy lại.");
    if (item.writer_claimed || item.writer_claim_release_pending) throw new Error("Bài đang được một phiên khác giữ; chưa thể chạy lại.");
    if (Object.values(runner?.workers || {}).some((worker) => worker?.currentId === item.id)) {
      throw new Error("Bài vẫn đang được xử lý trên một tab khác.");
    }
    item.status = "chờ";
    delete item.error;
    delete item.provider;
    delete item.workerKey;
    delete item.workerTabId;
    delete item.runToken;
    await jobStorage.set({ items });
    return { ok: true, articleId: item.id };
  });
}

function sparkFailedArticle(items, runner, worker) {
  if (worker?.provider !== "gemini" || !worker.sparkTaskId) return null;
  const failed = items.filter((item) => item.status === "lỗi" && !isAiImageItem(item) &&
    queueItemMatchesRunner(item, workerSourceScope(worker, runner)) &&
    !hasOtherTabJobInFlight(items, item, worker.targetTabId) &&
    (!item.provider || item.provider === "gemini") &&
    (!item.sparkTaskId || item.sparkTaskId === worker.sparkTaskId) &&
    item.writer_claimed !== true && !item.writer_claim_release_pending && !item.writer_claim_lost && !item.writer_claim_conflict &&
    !(isFacilityImageFixItem(item) && item.image_fix_requires_research) &&
    !Object.values(runner.workers || {}).some((other) => other !== worker && other.active && other.currentId === item.id));
  return failed.find((item) => item.id === worker.currentId) || failed[0] || null;
}

async function resumeIdleSparkWorkers(onlyWorkerKey) {
  const { items = [], runner } = await jobStorage.get(["items", "runner"]);
  if (!runner?.active || !runner.workers) return;
  for (const [key, worker] of Object.entries(runner.workers)) {
    if (onlyWorkerKey && key !== onlyWorkerKey) continue;
    if (!worker.active || worker.refilling || worker.provider !== "gemini" || !worker.sparkTaskId) continue;
    const current = items.find((item) => item.id === worker.currentId);
    if (current && current.status !== "lỗi") continue;
    if (!sparkFailedArticle(items, runner, worker)) continue;
    let tab;
    try { tab = await chrome.tabs.get(worker.targetTabId); } catch { continue; }
    if (!tabMatchesWorker(tab, worker)) continue;
    await runNext(key, false);
  }
}

async function continueAfterReload(sender = {}) {
  const context = await resolveControlTab({}, sender);
  if (context.sparkTaskId) await resumeIdleSparkWorkers(context.workerKey);
  const { runner } = await jobStorage.get("runner");
  const worker = runner?.workers?.[context.workerKey];
  if (!runner?.active || !worker?.active) return { ok: true };
  const deadline = Number(worker.nextJobAt || 0);
  if (deadline > Date.now()) return { ok: true, waiting: true };
  if (deadline) {
    await resumeNextJobDeadline(context.workerKey);
    return { ok: true };
  }
  await resumeNextJobDeadline(context.workerKey);
  return { ok: true };
}

function clearWriterClaimFields(item, { clearPublic = true } = {}) {
  if (!item) return;
  for (const key of ["writer_claim_token", "writer_claim_request_id", "writer_claim_expires_at", "writer_claim_lost", "writer_claim_release_pending", "writer_claim_release_error", "writer_claim_required"]) {
    delete item[key];
  }
  if (clearPublic) {
    delete item.writer_claimed;
    delete item.writer_claim;
    delete item.writer_claim_conflict;
  }
}

async function requestWriterClaim(action, item, options = {}) {
  if (action !== "heartbeat") return performWriterClaimRequest(action, item, options);
  const key = JSON.stringify([options.type || writerClaimType(item), options.id ?? writerClaimRecordId(item), options.claimToken]);
  if (writerClaimRenewals.has(key)) return writerClaimRenewals.get(key);
  const pending = performWriterClaimRequest(action, item, options).finally(() => {
    if (writerClaimRenewals.get(key) === pending) writerClaimRenewals.delete(key);
  });
  writerClaimRenewals.set(key, pending);
  return pending;
}

async function performWriterClaimRequest(action, item, options = {}) {
  const type = options.type || writerClaimType(item);
  const id = options.id ?? writerClaimRecordId(item, type);
  if (!type || !id) throw new Error("Thiếu loại hoặc ID hợp lệ để khóa bài viết.");
  const settings = await getTabSettings(itemOwnerTabId(item), type === "handbook" ? "handbooksUrl" : "writerClaimUrl");
  const url = migrateApiHost(type === "handbook" ? settings.handbooksUrl || DEFAULTS.handbooksUrl : settings.writerClaimUrl || DEFAULTS.writerClaimUrl);
  const body = { action, type, id };
  if (action === "claim") {
    body.request_id = options.requestId;
    body.client = options.client;
    if (type === "handbook") body.source_revision = item.source_revision;
  } else {
    body.claim_token = options.claimToken;
    if (action === "heartbeat" && isFacilityImageFixItem(item)) body.task = "facility_image_fix";
  }
  let response;
  let responseText;
  let timeoutId;
  let didTimeout = false;
  const controller = new AbortController();
  const monotonicNow = () => typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now();
  const requestStarted = monotonicNow();
  timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, WRITER_CLAIM_REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Medical-Api-Key": MEDICAL_API_KEY, Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    responseText = await response.text();
  } catch (error) {
    if (didTimeout) {
      const timeoutError = new Error(`API khóa bài quá thời gian ${WRITER_CLAIM_REQUEST_TIMEOUT_MS / 1000} giây.`);
      timeoutError.retryableWriterClaim = true;
      throw timeoutError;
    }
    error.retryableWriterClaim = true;
    throw error;
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
  let data;
  try { data = JSON.parse(responseText); }
  catch {
    const error = new Error(`API khóa bài trả về HTTP ${response.status}: ${responseText.slice(0, 300) || "phản hồi không phải JSON"}`);
    error.httpStatus = response.status;
    error.retryableWriterClaim = response.status >= 500 && response.status !== 503;
    throw error;
  }
  const conflict = action === "claim" && ((response.status === 409 && (type !== "handbook" || data?.reason === "already_claimed")) || data?.reason === "already_claimed" || (data?.ok === true && data?.claimed === false));
  if (conflict) {
    return { ok: true, claimed: false, reason: data?.reason || "already_claimed", writer: writerMetadata(data), response: data };
  }
  const leaseStatus = String(data?.reason || data?.status || data?.code || data?.error_code || "").toLowerCase();
  // Exact-token release can race a committed save or a newer owner. The
  // server's explicit lease_lost response confirms only OUR old token is gone.
  if (action === "release" && response.status === 409 && leaseStatus === "lease_lost") {
    return { ok: true, released: false, leaseLost: true, response: data };
  }
  const leaseLost = action === "heartbeat" && (response.status === 409 || response.status === 410 ||
    truthyApiFlag(data?.lease_lost) || truthyApiFlag(data?.expired) || ["lease_lost", "expired", "already_claimed"].includes(leaseStatus));
  if (leaseLost) return { ok: true, leaseLost: true, writer: writerMetadata(data), response: data };
  if (!response.ok || data?.ok !== true) {
    const detail = data?.message || data?.error || responseText.slice(0, 300) || "phản hồi không thành công";
    const error = new Error(`API khóa bài trả về HTTP ${response.status}: ${detail}`);
    error.httpStatus = response.status;
    error.reason = data?.reason;
    error.retryableWriterClaim = response.status >= 500 && response.status !== 503;
    throw error;
  }
  if (action === "claim" && (data.claimed !== true || !String(data.claim_token || "").trim())) {
    throw new Error("API khóa bài không trả về claim_token hợp lệ.");
  }
  // Use the server's remaining duration, not its epoch against the PC clock.
  // Subtract the whole round trip so a slow response cannot extend the lease.
  data.writer_local_expires_at = writerLeaseExpiry(data, Math.max(0, monotonicNow() - requestStarted));
  return { ok: true, claimed: action !== "claim" || data.claimed === true, response: data, writer: writerMetadata(data) };
}

async function claimWriterLease(item, { provider, workerKey, runToken, tab, retry = false } = {}) {
  const type = writerClaimType(item);
  if (!type) return { claimed: true, required: false };
  if (type === "doctor" && String(item?.sourceType || item?.source_type || "") !== "doctor") {
    // A translated doctor row is not a doctor article writer job.
    return { claimed: true, required: false };
  }
  if (item.writer_claim_token) {
    if (isDoctorItem(item) || isFacilityImageFixItem(item)) {
      if (!await validateWriterLeaseForCompletion(item.id, { strict: true })) throw workerReleasedError("Khóa xử lý đã hết hạn; chưa gửi lại prompt AI.");
      const current = (await getJobMetadata("items")).items?.find((row) => String(row.id) === String(item.id));
      if (!current || current.writer_claim_token !== item.writer_claim_token) throw workerReleasedError();
      item.writer_claim_expires_at = current.writer_claim_expires_at;
    }
    return { claimed: true, required: true, claimToken: item.writer_claim_token };
  }
  if (!retry) {
    const { items = [], runner } = await jobStorage.get(["items", "runner"]);
    const current = items.find((entry) => String(entry.id) === String(item.id));
    if (!current || !currentJobStillOwned(runner, current, workerKey, runToken, tab?.id)) throw workerReleasedError();
  }

  const requestId = String(item.writer_claim_request_id || (isDoctorItem(item) && item.doctor_writer_request_id) || createRunToken());
  await withSchedulerLock(async () => {
    const { items = [] } = await jobStorage.get("items");
    const current = items.find((entry) => String(entry.id) === String(item.id));
    if (!current) throw new Error("Không còn bài trong hàng đợi để khóa.");
    current.writer_claim_request_id = requestId;
    if (isDoctorItem(current) || isFacilityImageFixItem(current) || isHandbookItem(current)) current.writer_claim_worker_id = String(workerKey || current.workerKey || `tab-${itemOwnerTabId(current)}`);
    current.writer_claim_required = true;
    current.writer_claim_type = type;
    current.writer_claim_id = writerClaimRecordId(current, type);
    await jobStorage.set({ items });
  });
  const identity = await ensureWriterInstanceId();
  const settings = await getTabSettings(itemOwnerTabId(item), ["instance_label", "account_label"]);
  const client = {
    instance_id: identity,
    instance_label: String(settings.instance_label || DEFAULTS.instance_label).trim(),
    account_label: String(settings.account_label || DEFAULTS.account_label).trim(),
    worker_id: String(workerKey || `tab-${tab?.id || "retry"}`),
    provider: String(provider || item.provider || "unknown"),
    model: String(item.model || item.model_name || item.modelId || "not-specified"),
    task: type === "handbook" ? "handbook_article" : isFacilityImageFixItem(item) ? "facility_image_fix" : type === "doctor" ? "doctor_article" : String(item.sparkTaskId || item.title || "article-writing").slice(0, 180)
  };
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      result = await requestWriterClaim("claim", item, {
        type, id: writerClaimRecordId(item, type), requestId, client
      });
      break;
    } catch (error) {
      if (attempt === 0 && error.retryableWriterClaim) continue;
      error.writerClaimRequestId = requestId;
      throw error;
    }
  }
  if (!result.claimed) return { claimed: false, required: true, writer: result.writer, reason: result.reason };

  const token = String(result.response.claim_token);
  if (type === "handbook" && result.response.source_revision !== item.source_revision) throw new Error("Revision khóa Cẩm nang không khớp chủ đề; chưa gửi AI.");
  const expiry = writerLeaseExpiry(result.response);
  const saved = await withSchedulerLock(async () => {
    const { items = [], runner } = await jobStorage.get(["items", "runner"]);
    const current = items.find((entry) => String(entry.id) === String(item.id));
    if (!current || current.writer_claim_request_id !== requestId) return false;
    if (!retry && !currentJobStillOwned(runner, current, workerKey, runToken, tab?.id)) return false;
    current.writer_claim_token = token;
    if (type === "doctor") current.doctor_writer_request_id = requestId;
    current.writer_claim_expires_at = expiry;
    current.writer_claimed = true;
    current.writer_claim = writerMetadata(result.response, client);
    current.writer_claimed_at = new Date().toISOString();
    await jobStorage.set({ items });
    Object.assign(item, current);
    return true;
  });
  if (!saved) {
    await requestWriterClaim("release", item, { type, id: writerClaimRecordId(item, type), claimToken: token }).catch(() => {});
    throw workerReleasedError("Bài đã được dừng trong lúc xin khóa; đã không gửi prompt AI.");
  }
  return { claimed: true, required: true, claimToken: token, writer: writerMetadata(result.response, client) };
}

function currentJobStillOwned(runner, item, workerKey, runToken, tabId) {
  if (runner?.workers) {
    const worker = runner.workers[workerKey];
    return Boolean(runner.active && worker?.active && worker.currentId === item.id && worker.runToken === runToken &&
      Number(worker.targetTabId) === Number(tabId) && item.status === "đang viết" && item.workerKey === workerKey);
  }
  return Boolean(runner?.active && runner.currentId === item.id && (!runner.runToken || runner.runToken === runToken) && item.status === "đang viết");
}

async function releaseWriterClaim(item, { preservePublic = false } = {}) {
  const token = String(item?.writer_claim_token || "");
  const type = item?.writer_claim_type || writerClaimType(item);
  const id = item?.writer_claim_id ?? writerClaimRecordId(item, type);
  if (!token || !type || !id) return { ok: true, released: false };
  try {
    const result = await requestWriterClaim("release", item, { type, id, claimToken: token });
    await withSchedulerLock(async () => {
      const { items = [] } = await getJobMetadata("items");
      const current = items.find((entry) => String(entry.id) === String(item.id));
      if (!current || current.writer_claim_token !== token) return;
      clearWriterClaimFields(current, { clearPublic: !preservePublic });
      await jobStorage.set({ items });
      Object.assign(item, current);
    });
    return { ...result, released: true };
  } catch (error) {
    await withSchedulerLock(async () => {
      const { items = [] } = await getJobMetadata("items");
      const current = items.find((entry) => String(entry.id) === String(item.id));
      if (!current || current.writer_claim_token !== token) return;
      current.writer_claim_release_pending = true;
      current.writer_claim_release_error = error.message;
      current.writer_claimed = true;
      await jobStorage.set({ items });
      Object.assign(item, current);
    });
    return { ok: false, released: false, error: error.message };
  }
}

async function clearWriterClaimAfterSave(item) {
  const token = String(item?.writer_claim_token || "");
  if (!token) return;
  await withSchedulerLock(async () => {
    const { items = [] } = await getJobMetadata("items");
    const current = items.find((entry) => String(entry.id) === String(item.id));
    if (!current || current.writer_claim_token !== token) return;
    clearWriterClaimFields(current);
    current.writer_claimed = false;
    await jobStorage.set({ items });
    Object.assign(item, current);
  });
}

function heartbeatActiveWriterClaims() {
  if (writerClaimHeartbeatPromise) return writerClaimHeartbeatPromise;
  writerClaimHeartbeatPromise = renewActiveWriterClaims().finally(() => { writerClaimHeartbeatPromise = null; });
  return writerClaimHeartbeatPromise;
}

async function renewActiveWriterClaims() {
  await reconcileClosedTabJobs();
  const { items = [] } = await getJobMetadata("items");
  const toRelease = items.filter((item) => item.writer_claim_release_pending && item.writer_claim_token && !jobHasUnconfirmedSave(item));
  const claims = items.filter((item) => !item.writer_claim_release_pending && item.writer_claim_token && item.writer_claim_required &&
    (item.status === "đang viết" || isDoctorItem(item) && ["đang cập nhật", "chưa xác nhận"].includes(item.status) ||
      isHandbookItem(item) && ["đang cập nhật", "chưa xác nhận", "lỗi cập nhật"].includes(item.status) ||
      isFacilityImageFixItem(item) && ["đang cập nhật", "chưa xác nhận", "lỗi cập nhật"].includes(item.status)) && !item.writer_claim_lost);
  let cursor = 0;
  const renew = async (metadata) => {
    // A committed save releases its claim before synchronous downloads finish.
    // Receipt bytes survive worker restarts; no new lease is needed to replay.
    const item = isFacilityImageFixItem(metadata) ? await hydrateArticle(metadata) : metadata;
    if (hasFacilityImageFixReceipt(item)) return;
    let result;
    try {
      result = await requestWriterClaim("heartbeat", item, {
        type: item.writer_claim_type || writerClaimType(item),
        id: item.writer_claim_id ?? writerClaimRecordId(item),
        claimToken: item.writer_claim_token
      });
    } catch (error) {
      if (isDoctorItem(item) && [401, 403, 503].includes(error.httpStatus)) {
        await haltDoctorForFatalHeartbeat(item, error);
        return;
      }
      await withSchedulerLock(async () => {
        const { items: latest = [] } = await getJobMetadata("items");
        const current = latest.find((entry) => String(entry.id) === String(item.id));
        if (current?.writer_claim_token === item.writer_claim_token) {
          current.writer_claim_heartbeat_error = error.message;
          await jobStorage.set({ items: latest });
        }
      });
      return;
    }
    if (result.leaseLost) {
      if (isDoctorItem(item) && (await readDoctorReceipt(item).catch(() => ({ confirmed: false }))).confirmed) return;
      await loseWriterClaim(item.id, item.writer_claim_token, result.writer);
      return;
    }
    const renewedExpiry = writerLeaseExpiry(result.response);
    await withSchedulerLock(async () => {
      const { items: latest = [] } = await getJobMetadata("items");
      const current = latest.find((entry) => String(entry.id) === String(item.id));
      if (current?.writer_claim_token === item.writer_claim_token) {
        current.writer_claim_expires_at = renewedExpiry;
        current.writer_claim_heartbeat_at = new Date().toISOString();
        delete current.writer_claim_heartbeat_error;
        await jobStorage.set({ items: latest });
      }
    });
  };
  // One timed-out connection must not hold every other worker's renewal.
  await Promise.all(Array.from({ length: Math.min(3, claims.length) }, async () => {
    while (cursor < claims.length) await renew(claims[cursor++]);
  }));
  for (const item of toRelease) await releaseWriterClaim({ ...item });
  await reconcileDoctorPendingUpdates();
  if (toRelease.length) await runNext();
  return { ok: true, heartbeats: claims.length, releases: toRelease.length };
}

async function loseWriterClaim(articleId, claimToken, writer = {}) {
  const handbook = (await getJobMetadata("items")).items?.find((row) => row.id === articleId && isHandbookItem(row));
  if (handbook?.writer_claim_token === claimToken) {
    // A save may have committed and released its lease before its reply. Keep
    // the exact idempotent POST; never clear its private transport identity.
    const pending = handbook.handbook_payload_saved || ["đang cập nhật", "chưa xác nhận"].includes(handbook.status);
    await withSchedulerLock(async () => {
      const { items = [] } = await getJobMetadata("items");
      const current = items.find((row) => row.id === articleId);
      if (!current || current.writer_claim_token !== claimToken) return;
      current.writer_claim_lost = true;
      current.status = pending ? "chưa xác nhận" : "lỗi";
      current.api_error = pending ? "Chưa xác nhận lưu Cẩm nang; giữ nguyên request và payload để gửi lại kiểm tra biên nhận idempotent." : "Quyền giữ bài Cẩm nang đã mất; chưa gửi kết quả dưới khóa khác.";
      await jobStorage.set({ items });
    });
    await pauseHandbookWorker(articleId, "Quyền giữ bài Cẩm nang đã mất; cần kiểm tra kết quả đã lưu.", pending ? "network_unconfirmed" : "lease_lost");
    return { ok: true, paused: true };
  }
  const stopped = await withSchedulerLock(async () => {
    const { items = [], runner } = await jobStorage.get(["items", "runner"]);
    const item = items.find((entry) => String(entry.id) === String(articleId));
    if (!item || item.writer_claim_token !== claimToken) return null;
    // The synchronous receiver returns the DB claim before downloading images.
    // A heartbeat can race that commit; the in-flight POST/receipt owns the
    // outcome now, not the released lease. Never stop or requeue its AI slot.
    if (hasFacilityImageFixReceipt(item)) return null;
    const entry = Object.entries(runner?.workers || {}).find(([, worker]) => String(worker.currentId) === String(articleId));
    const [workerKey, worker] = entry || [];
    item.writer_claimed = true;
    item.writer_claim = writerMetadata(writer, item.writer_claim);
    item.writer_claim_conflict = true;
    item.status = (isDoctorItem(item) || isFacilityImageFixItem(item)) && item.has_result ? "lỗi cập nhật" : "chờ";
    if (isFacilityImageFixItem(item)) {
      // Valid durable receipts returned above. Pending flags without a matching
      // receipt must not trap a genuinely lost job in the ambiguous-save state.
      item.status = item.has_result ? "lỗi cập nhật" : "lỗi";
      item.image_fix_api_pending = false;
      item.image_fix_import_pending = false;
      item.image_fix_requires_research = true;
      item.image_fix_error_code = item.api_error_code = "lease_lost";
      item.api_error = "Khóa Fix ảnh đã mất. Không gửi kết quả cũ dưới khóa mới; kiểm tra lại nguồn ảnh.";
    }
    if (isDoctorItem(item)) item.api_error = "Khóa hồ sơ bác sĩ đã mất/hết hạn; không gửi lại kết quả cũ nếu chưa kiểm tra xác nhận lưu.";
    clearWriterClaimFields(item, { clearPublic: false });
    if (isDoctorItem(item) || isFacilityImageFixItem(item)) item.writer_claim_lost = true;
    delete item.provider;
    delete item.workerKey;
    delete item.workerTabId;
    if (worker) {
      worker.currentId = null;
      if (isFacilityImageFixItem(item) || isDoctorItem(item) && (item.has_result || activeApiRequests.has(String(item.id)))) worker.active = false;
    }
    if (runner) refreshRunnerSummary(runner, items);
    await jobStorage.set({ items, ...(runner ? { runner } : {}) });
    return { tabId: worker?.targetTabId, workerKey, runToken: worker?.runToken };
  });
  if (!stopped) return { ok: false, ignored: true };
  if (stopped.tabId) await chrome.tabs.sendMessage(Number(stopped.tabId), { type: "writer-lease-lost", articleId, runToken: stopped.runToken }).catch(() => {});
  if (stopped.workerKey) await runNext(stopped.workerKey);
  return { ok: true, lost: true };
}

async function markArticleWriterConflict(articleId, writer = {}) {
  await withSchedulerLock(async () => {
    const { items = [] } = await jobStorage.get("items");
    const item = items.find((entry) => String(entry.id) === String(articleId));
    if (!item || item.writer_claim_token) return;
    clearWriterClaimFields(item);
    item.status = "chờ";
    item.writer_claimed = true;
    item.writer_claim = writerMetadata(writer);
    item.writer_claim_conflict = true;
    delete item.provider;
    delete item.error;
    delete item.rawResponse;
    await jobStorage.set({ items });
  });
}

async function fetchFacilities(tabId) {
  return fetchArticleList("facilitiesUrl", "cơ sở", tabId);
}

function doctorQueueStateKey(tabId) { return `tab-doctor-queue:${Number(tabId) || "legacy"}`; }

function doctorQueueStateFromError(error) {
  if (isStorageQuotaError(error)) return { ...storageQuotaFailure(), sourceType: "doctor" };
  const httpStatus = Number(error?.httpStatus) || null;
  const schemaUnavailable = httpStatus === 503;
  return { sourceType: "doctor", status: "error", httpStatus,
    message: String(error?.message || "Không tải được danh sách hồ sơ bác sĩ."), schemaUnavailable,
    help: schemaUnavailable
      ? "Quản trị website: kiểm tra log DB/schema và bản deploy; chạy php scripts/migrate_doctor_content.php trên đúng DB server để cập nhật schema/prompt. Sau khi API sẵn sàng, bấm Thử lại. Tiện ích không tự chạy migration."
      : [401, 403].includes(httpStatus) ? "Quản trị website: kiểm tra khóa API/quyền truy cập trong cấu hình cục bộ. Sửa cấu hình rồi bấm Thử lại."
        : "Kiểm tra kết nối hoặc endpoint bác sĩ trong Cài đặt rồi bấm Thử lại. Kết quả đã lưu vẫn được giữ." };
}

async function saveDoctorQueueState(tabId, state, expectedRequestId = null) {
  return withSchedulerLock(async () => {
    const key = doctorQueueStateKey(tabId);
    const previous = (await jobStorage.get(key))[key];
    if (expectedRequestId && previous?.requestId !== expectedRequestId) return previous;
    const value = { ...state, sourceType: "doctor", checkedAt: new Date().toISOString() };
    await jobStorage.set({ [key]: value });
    return value;
  });
}

async function fetchDoctors(ids = [], tabId) {
  const requestId = createRunToken();
  try {
  await saveDoctorQueueState(tabId, { status: "loading", requestId });
  const settings = await getTabSettings(tabId, "doctorsUrl");
  const url = new URL(migrateApiHost(settings.doctorsUrl || DEFAULTS.doctorsUrl));
  url.searchParams.set("page", "1");
  // Inspect a bounded batch so a row claimed by another installation cannot
  // starve this worker. Each worker still dispatches exactly one doctor.
  url.searchParams.set("limit", String(Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 25))));
  url.searchParams.delete("type");
  url.searchParams.delete("ids");
  if (ids.length) { url.searchParams.set("ids", ids.map(Number).join(",")); url.searchParams.set("limit", String(Math.min(ids.length, 100))); }
  const data = await withQueueFetchTimeout(async (signal) => {
    const response = await fetch(url.href, { headers: { "X-Medical-Api-Key": MEDICAL_API_KEY, Accept: "application/json" }, cache: "no-store", signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {
      const error = new Error(`API danh sách bác sĩ HTTP ${response.status}: ${text.slice(0, 400) || "phản hồi không phải JSON"}`);
      error.httpStatus = response.status;
      error.doctorQueueError = true;
      throw error;
    }
    if (!response.ok || data?.ok !== true || !Array.isArray(data.items)) {
      const error = new Error(`API danh sách bác sĩ HTTP ${response.status}: ${data?.message || "dữ liệu không hợp lệ; kiểm tra backend đã triển khai chưa"}`);
      error.httpStatus = response.status;
      error.doctorQueueError = true;
      throw error;
    }
    return data;
  }, "bác sĩ");
  await saveDoctorQueueState(tabId, { status: "ready", requestId, httpStatus: 200, count: data.items.length }, requestId);
  return data;
  } catch (error) {
    error.doctorQueueError = !isStorageQuotaError(error);
    const failure = { ...doctorQueueStateFromError(error), requestId };
    error.queueState = failure;
    try { error.queueState = await saveDoctorQueueState(tabId, failure, requestId) || failure; }
    catch { /* Error reporting must not mask the original failure if storage is full. */ }
    throw error;
  }
}

function isDoctorItem(item) { return item?.sourceType === "doctor"; }

function isFacilityImageFixItem(item) { return item?.sourceType === "facility_image_fix"; }
function imageFixQueueKey(tabId) { return `tab-image-fix-queue:${Number(tabId) || "legacy"}`; }
function imageFixQueueState(data, tabId) {
  return { [imageFixQueueKey(tabId)]: { next_after_id: data.next_after_id ?? null, exhausted: !data.items?.length && data.next_after_id == null,
    language: data.language || "vi", errors: data.errors || [], at: Date.now() } };
}
function validImageFixSource(item) {
  return item && isPositiveId(item.id) && (!item.status || item.status === "published") &&
    (!item.language_code || ["vi", "en"].includes(item.language_code)) &&
    typeof item.prompt === "string" && Boolean(item.prompt.trim()) &&
    /^[a-f0-9]{64}$/i.test(item.images_revision || "") && Array.isArray(item.images) &&
    item.images.every((image) => typeof image?.url === "string" && image.url.length > 0) &&
    new Set(item.images.map((image) => image.url)).size === item.images.length;
}
function copyImageFixSource(target, source) {
  for (const key of ["name", "prompt", "images_revision", "images", "images_count", "gallery_json", "image_url", "ai_image_url",
    "target_images", "language_code", "output_template", "category", "city", "address_text", "phone_text", "website_url", "google_maps_url",
    ...PROMPT_METADATA_FIELDS]) {
    if (Object.hasOwn(source, key)) target[key] = source[key];
  }
  target.title = source.name || source.title;
  return target;
}
async function fetchFacilityImageFixes(ids = [], tabId, language = null, cursor = null) {
  try {
    const settings = await getTabSettings(tabId, "facilityImageFixUrl");
    const url = new URL(settings.facilityImageFixUrl || DEFAULTS.facilityImageFixUrl);
    if (ids.length) {
      if (ids.length > 50 || ids.some((id) => !isPositiveId(id))) throw new Error("ID Fix ảnh không hợp lệ.");
      url.searchParams.delete("id"); url.searchParams.delete("page"); url.searchParams.delete("after_id");
      url.searchParams.set("ids", ids.join(","));
    } else {
      url.searchParams.delete("id"); url.searchParams.delete("ids");
      if (cursor != null) { url.searchParams.set("after_id", String(cursor)); url.searchParams.delete("page"); }
    }
    if (!url.searchParams.has("limit")) url.searchParams.set("limit", "10");
    if (language) url.searchParams.set("language", language);
    return await withQueueFetchTimeout(async (signal) => {
      const response = await fetch(url.href, { cache: "no-store", signal,
        headers: { "X-Medical-Api-Key": MEDICAL_API_KEY, Accept: "application/json" } });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { /* Report the HTTP status and bounded body below. */ }
      if (!response.ok || data?.ok !== true || !Array.isArray(data?.items)) {
        const error = new Error(`API Fix ảnh HTTP ${response.status}: ${data?.message || text.slice(0, 300) || "schema/prompt chưa sẵn sàng"}`);
        error.httpStatus = response.status; throw error;
      }
      if (data.items.some((item) => !validImageFixSource(item))) throw new Error("API Fix ảnh thiếu ID, prompt, images hoặc images_revision hợp lệ; chưa gửi AI.");
      return data;
    }, "Fix ảnh");
  } catch (error) { error.imageFixQueueError = true; throw error; }
}
async function revalidateFacilityImageFixJob(item) {
  if (!item.writer_claim_token || !writerLeaseIsCurrent(item)) throw workerReleasedError("Khóa Fix ảnh đã hết hạn.");
  const data = await fetchFacilityImageFixes([item.facility_id], itemOwnerTabId(item), item.language_code || "vi");
  const fresh = data.items.find((entry) => Number(entry.id) === Number(item.facility_id));
  if (!fresh) {
    const error = new Error("Cơ sở không còn trong nguồn Fix ảnh; đã bỏ qua và trả khóa.");
    error.imageFixIneligible = true; throw error;
  }
  await withSchedulerLock(async () => {
    const { items = [] } = await getJobMetadata("items");
    const current = items.find((entry) => entry.id === item.id);
    if (!current || current.status !== "đang viết" || current.writer_claim_token !== item.writer_claim_token || !writerLeaseIsCurrent(current)) throw workerReleasedError();
    copyImageFixSource(current, fresh);
    await jobStorage.set({ items });
    Object.assign(item, current);
  });
  return item;
}

// This validates public URLs without requesting any image. The website receiver
// performs redirect, MIME and download checks while handling the POST.
function validImageFixUrl(value, { local = false, image = false } = {}) {
  if (typeof value !== "string" || !value || value.length > 8000 || /[\s\u0000-\u001f\\]/.test(value)) return false;
  if (local && value.startsWith("/uploads/")) {
    try { return !decodeURIComponent(value).split(/[/?#]/).includes("..") && !/%(?:00|2f|5c)/i.test(value); } catch { return false; }
  }
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port && !["80", "443"].includes(url.port)) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || host.includes(":")) return false;
  if (/^\d+(?:\.\d+){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if ([0, 10, 127].includes(a) || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127) return false;
  }
  for (const key of url.searchParams.keys()) if (/^(?:key|api_key|apikey|access_token|auth_token|token)$/i.test(key)) return false;
  if (image && (/(?:^|\.)google\.[a-z.]+$/.test(host) || host === "maps.app.goo.gl" || /\.(?:html?|php)(?:$|\/)/i.test(url.pathname))) return false;
  return true;
}
// Notes are audit text only. Keep the original AI result untouched for review;
// transport normalization must never alter image decisions, URLs or lease data.
function normalizeFacilityImageFixNotes(value) {
  let text;
  try {
    text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    throw new Error("notes không thể chuyển thành ghi chú văn bản hợp lệ.");
  }
  if (typeof text !== "string") throw new Error("notes không thể chuyển thành ghi chú văn bản hợp lệ.");
  text = text.trim();
  const characters = Array.from(text);
  if (characters.length <= 4000) return text;
  const suffix = "\n[Ghi chú đã rút gọn để gửi API; JSON gốc được giữ trong tiện ích.]";
  return characters.slice(0, 4000 - Array.from(suffix).length).join("") + suffix;
}
function imageFixReviewIsVerifiedKeep(review) {
  if (review?.decision !== "keep" || typeof review.reason !== "string" || !review.reason.trim() || typeof review.evidence_url !== "string" || !review.evidence_url.trim()) return false;
  if (Number.isInteger(review.http_status) && review.http_status >= 400) return false;
  const reason = review.reason.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d");
  return !/timeout|captcha|(?:khong|chua)(?: (?:the|du|truc tiep|co the))* (?:truy cap|xem|xac minh|doi chieu)|(?:unable|cannot|can't) (?:to )?(?:access|view|verify)|not (?:accessible|viewable|verified)|timed out/i.test(reason);
}

function buildFacilityImageFixPayload(queueItem, result) {
  const required = ["id", "images_revision", "inspected_images", "added_images", "image_url", "ai_image_url", "insufficient_images", "notes"];
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Fix ảnh cần một JSON object.");
  for (const field of required) if (!Object.hasOwn(result, field)) throw new Error(`JSON Fix ảnh thiếu ${field}.`);
  for (const field of Object.keys(result)) if (!required.includes(field)) throw new Error(`JSON Fix ảnh có trường ngoài contract: ${field}.`);
  if (!Number.isSafeInteger(result.id) || result.id <= 0 || result.id !== Number(queueItem.facility_id)) throw new Error("ID Fix ảnh phải là số nguyên dương và giữ nguyên ID cơ sở.");
  if (!/^[a-f0-9]{64}$/i.test(result.images_revision || "") || result.images_revision !== queueItem.images_revision) throw new Error("images_revision không khớp nguồn; cần kiểm tra AI lại, không thay revision của JSON cũ.");
  if (!queueItem.writer_claim_token || queueItem.writer_claim_lost) throw new Error("Thiếu token khóa Fix ảnh hợp lệ.");
  if (!Array.isArray(queueItem.images)) throw new Error("Thiếu images nguồn để kiểm tra contract.");
  const source = new Set(queueItem.images.map((image) => image.url));
  const inspected = new Map();
  if (!Array.isArray(result.inspected_images) || result.inspected_images.length !== source.size) throw new Error("inspected_images phải đủ mọi URL nguồn, mỗi URL đúng một lần.");
  for (const review of result.inspected_images) {
    if (!review || !source.has(review.url) || inspected.has(review.url)) throw new Error("inspected_images có URL lạ, trùng hoặc inspection_url thay URL nguồn.");
    if (!["keep", "remove", "uncertain"].includes(review.decision)) throw new Error("decision phải là keep, remove hoặc uncertain.");
    if (typeof review.reason !== "string" || typeof review.evidence_url !== "string" || !(review.http_status === null || Number.isInteger(review.http_status) && review.http_status >= 100 && review.http_status <= 599)) throw new Error("reason/evidence_url/http_status không đúng contract.");
    if (review.evidence_url && !validImageFixUrl(review.evidence_url, { local: true })) throw new Error("evidence_url không phải URL bằng chứng hợp lệ.");
    const uncertainReason = String(review.reason).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const terminalHttp = [404, 410].includes(review.http_status);
    const uncertainAccess = !terminalHttp && /timeout|captcha|khong (?:the )?(?:truy cap|xem)|not (?:accessible|viewable)|timed out/i.test(uncertainReason);
    if (review.decision === "remove" && (!review.reason.trim() || !review.evidence_url || [401, 403, 408, 429].includes(review.http_status) || review.http_status >= 500 || uncertainAccess)) throw new Error("Không được remove ảnh khi thiếu bằng chứng hoặc lỗi truy cập tạm thời; dùng uncertain.");
    inspected.set(review.url, review.decision);
  }
  if (!Array.isArray(result.added_images) || result.added_images.length > 12) throw new Error("added_images tối đa 12 ảnh.");
  const added = new Set();
  for (const image of result.added_images) {
    if (!image || !validImageFixUrl(image.url, { image: true })) throw new Error("URL ảnh bổ sung phải là HTTP(S) công khai, không token/credentials hay trang HTML/Maps.");
    if (source.has(image.url) || added.has(image.url)) throw new Error("added_images trùng ảnh nguồn hoặc ảnh bổ sung.");
    if (typeof image.source !== "string" || !image.source.trim() || image.source.length > 120 || !validImageFixUrl(image.source_url)) throw new Error("Ảnh bổ sung cần source/source_url thật.");
    for (const [field, limit] of [["angle", 120], ["caption", 500]]) {
      if (Object.hasOwn(image, field) && (typeof image[field] !== "string" || image[field].length > limit)) throw new Error(`${field} ảnh bổ sung phải là chuỗi, tối đa ${limit} ký tự.`);
    }
    added.add(image.url);
  }
  // A removed source cover is valid input: the receiver selects the remaining
  // gallery cover atomically. Preserve the AI JSON instead of rewriting it here.
  if (typeof result.image_url !== "string" || result.image_url && !added.has(result.image_url) && !inspected.has(result.image_url)) throw new Error("image_url phải chọn ảnh nguồn hoặc ảnh bổ sung; server tự thay bìa nguồn đã remove.");
  // The receiver treats null as an empty AI-image field. Normalize only that
  // representation; a populated source still needs an explicit remove decision.
  const oldAi = queueItem.ai_image_url ?? "";
  const proposedAi = result.ai_image_url === null ? "" : result.ai_image_url;
  if (typeof oldAi !== "string" || typeof proposedAi !== "string" || proposedAi !== oldAi && !(proposedAi === "" && inspected.get(oldAi) === "remove")) throw new Error("ai_image_url chỉ giữ nguyên hoặc xóa khi ảnh AI nguồn được remove.");
  if (typeof result.insufficient_images !== "boolean") throw new Error("insufficient_images phải là boolean.");
  const notes = normalizeFacilityImageFixNotes(result.notes);
  const payload = { items: [{ ...result, notes, ai_image_url: proposedAi, writer_claim_token: queueItem.writer_claim_token }] };
  if (unescape(encodeURIComponent(JSON.stringify(payload))).length > 2 * 1024 * 1024) throw new Error("JSON Fix ảnh vượt giới hạn 2MB.");
  return payload;
}
function isLegacyInsufficientReplacementFailure(item) {
  if (!isFacilityImageFixItem(item)) return false;
  const code = String(item.image_fix_error_code || item.api_error_code || "").toLowerCase();
  const message = String(item.api_error || item.error || "");
  return Boolean(item.image_fix_reclaim_allowed || code === "insufficient_replacement_images" ||
    /Chưa cập nhật xóa ảnh:.*\/5 ảnh thật đã xác minh/i.test(message));
}
function imageFixApiError(status, data, text) {
  const own = data?.errors?.find((entry) => entry.index === 0) || data?.errors?.[0];
  const error = new Error(`API Fix ảnh HTTP ${status}: ${own?.reason || data?.reason || ""} ${own?.message || data?.message || text.slice(0, 500)}`.trim());
  error.httpStatus = Number(own?.status || status);
  error.imageFixErrorCode = own?.reason || data?.reason || "invalid_response";
  return error;
}
function imageFixImportState(data, facilityId) {
  const row = data?.updated?.find((entry) => Number(entry.id ?? entry.facility_id) === Number(facilityId));
  const processing = row?.image_processing ?? data?.image_processing ?? "";
  const results = Array.isArray(row?.image_results) ? row.image_results : [];
  const failed = Number(row?.images_failed) || results.filter((entry) => entry.ok === false).length;
  const imported = Number(row?.images_imported) || results.filter((entry) => entry.ok === true).length;
  return { processing, imported, failed, partial: processing === "partial" || processing === "not_started" || failed > 0 };
}
async function updateFacilityImageFix(queueItem, result) {
  const replay = (queueItem.image_fix_api_pending || queueItem.image_fix_import_pending) && typeof queueItem.image_fix_payload === "string";
  let body;
  if (replay) {
    body = queueItem.image_fix_payload;
    if (!hasFacilityImageFixReceipt(queueItem)) throw new Error("Payload gửi lại Fix ảnh không khớp bài gốc.");
  } else {
    const { items = [] } = await getJobMetadata("items");
    const current = items.find((row) => row.id === queueItem.id);
    if (current) {
      if (current.writer_claim_token !== queueItem.writer_claim_token || current.images_revision !== queueItem.images_revision ||
          !await validateWriterLeaseForCompletion(queueItem.id, { strict: true })) throw workerReleasedError("Khóa Fix ảnh đã mất trước khi gửi API.");
      const latest = (await getJobMetadata("items")).items?.find((row) => row.id === queueItem.id);
      if (!latest || latest.writer_claim_token !== queueItem.writer_claim_token) throw workerReleasedError();
      queueItem = { ...queueItem, writer_claim_expires_at: latest.writer_claim_expires_at };
    }
    if (!writerLeaseIsCurrent(queueItem)) throw new Error("Khóa Fix ảnh hết hạn; không gửi JSON cũ dưới khóa mới.");
    body = JSON.stringify(buildFacilityImageFixPayload(queueItem, result));
  }
  // Persist the exact bytes BEFORE dispatch. A lost response is retried with
  // this original receipt token, never under a newly acquired lease/revision.
  await withSchedulerLock(async () => {
    const { items = [] } = await getJobMetadata("items");
    const current = items.find((item) => item.id === queueItem.id);
    if (!current) return; // Pure contract callers can validate/post an isolated fixture.
    if (!replay && (current.writer_claim_token !== queueItem.writer_claim_token || !writerLeaseIsCurrent(current))) throw workerReleasedError("Khóa Fix ảnh đã mất trước khi gửi API.");
    current.image_fix_payload = body; current.image_fix_api_pending = true;
    await jobStorage.set({ items });
  });
  const settings = await getTabSettings(itemOwnerTabId(queueItem), "facilityImageFixUpdateUrl");
  let response, text, data;
  try {
    // No POST timeout: the synchronous receiver downloads/stores images before
    // returning. A proxy/network failure retains this exact receipt for retry.
    response = await fetch(settings.facilityImageFixUpdateUrl || DEFAULTS.facilityImageFixUpdateUrl, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Medical-Api-Key": MEDICAL_API_KEY, Accept: "application/json" }, body
    });
    text = await response.text();
    try { data = JSON.parse(text); } catch { /* Unknown outcome, not permission to create a new attempt. */ }
  } catch (cause) {
    const error = new Error(`Chưa xác nhận API Fix ảnh: ${cause.message}. Giữ nguyên JSON/token để gửi lại.`);
    error.imageFixUnconfirmed = true; throw error;
  }
  const saved = data?.updated?.find((row) => Number(row.id ?? row.facility_id) === Number(queueItem.facility_id));
  const ownError = data?.errors?.find((row) => Number(row.id) === Number(queueItem.facility_id) || row.index === 0);
  if ([200, 207].includes(response.status) && saved && !ownError) return data;
  const error = imageFixApiError(response.status, data, text);
  if (response.ok && !saved && !ownError) error.message = `API Fix ảnh HTTP ${response.status}: chưa xác nhận đúng ID ${queueItem.facility_id}.`;
  if (!data && response.ok || response.status >= 500 && response.status !== 503) error.imageFixUnconfirmed = true;
  throw error;
}
async function pauseImageFixWorker(articleId, error, workerKey) {
  await pauseDoctorWorker(articleId, error, workerKey);
  await withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const worker = runner?.workers?.[workerKey] || (!runner?.workers ? runner : null);
    if (worker && !worker.active) {
      worker.lastMessage = "Đã dừng Fix ảnh; kiểm tra lỗi trước khi chạy lại";
      worker.waitReason = "image-fix-api-error";
      refreshRunnerSummary(runner, items); await jobStorage.set({ runner });
    }
  });
}
async function publishFacilityImageFix(articleId, queueItem, result) {
  const key = String(articleId);
  if (activeApiRequests.has(key)) return { ok: false, updated: false, error: "API Fix ảnh đang gửi; chưa gửi trùng." };
  activeApiRequests.add(key);
  let data = null, failure = null;
  try {
    try { data = await updateFacilityImageFix(queueItem, result); } catch (error) { failure = error; }
    const ineligible = failure?.imageFixErrorCode === "not_published";
    const importState = data ? imageFixImportState(data, queueItem.facility_id) : null;
    const partial = importState?.partial === true;
    const status = data ? partial ? "ảnh chưa đủ" : "hoàn tất" : ineligible ? "bỏ qua" : failure.imageFixUnconfirmed ? "chưa xác nhận" : "lỗi cập nhật";
    const research = ["images_changed", "lease_lost"].includes(failure?.imageFixErrorCode) ||
      !failure?.imageFixUnconfirmed && [401, 403, 404, 503].includes(failure?.httpStatus);
    await withSchedulerLock(async () => {
      const { items = [] } = await getJobMetadata("items");
      const current = items.find((item) => item.id === articleId);
      if (!current || current.status === "hoàn tất") return;
      finalizeApiRequest(current, status, data, failure?.message || null);
      current.image_fix_api_pending = status === "chưa xác nhận";
      current.image_fix_import_pending = data ? partial : !research && Boolean(current.image_fix_import_pending);
      current.image_fix_requires_research = research;
      current.image_fix_error_code = current.api_error_code = failure?.imageFixErrorCode || null;
      if (data) {
        delete current.image_fix_reclaim_allowed;
        clearWriterClaimFields(current);
        current.writer_claimed = false;
        // A partial import has committed JSON and released its lease already.
        // Keep only the private original receipt for retry, never a new claim.
        if (!partial) current.image_fix_payload = null;
      }
      await jobStorage.set({ items });
    });
    if (data) await clearWriterClaimAfterSave(queueItem);
    else if (research || [401, 403, 404, 409, 503].includes(failure.httpStatus)) await releaseWriterClaim(queueItem);
    // Invalid JSON keeps its lease alive for repair/retry, but this worker must
    // not silently abandon it and claim a different facility in the meantime.
    if (failure && !failure.imageFixUnconfirmed && !ineligible) await pauseImageFixWorker(articleId, failure, queueItem.workerKey);
    return { ok: true, updated: Boolean(data), ...(importState ? { partial, image_processing: importState.processing,
      images_imported: importState.imported, images_failed: importState.failed } : {}),
      ...(failure ? { error: failure.message } : {}), ...(status === "chưa xác nhận" ? { unconfirmed: true } : {}) };
  } finally { activeApiRequests.delete(key); await pruneCompletedHistory(); }
}
async function retryFacilityImageFixUpdate(articleId) {
  const { items = [] } = await jobStorage.get("items");
  const item = items.find((row) => row.id === articleId);
  if (!isFacilityImageFixItem(item) || !item.result) throw new Error("Không có JSON Fix ảnh để gửi lại.");
  if (item.status === "hoàn tất") return { ok: true, updated: true, already_processed: true };
  if (activeApiRequests.has(String(articleId))) throw new Error("API Fix ảnh vẫn đang gửi; chưa gửi trùng.");
  if (!hasFacilityImageFixReceipt(item) && !item.writer_claim_token && isLegacyInsufficientReplacementFailure(item)) {
    await withSchedulerLock(async () => {
      const { items: latest = [] } = await getJobMetadata("items");
      const current = latest.find((row) => row.id === articleId);
      if (!current) return;
      delete current.writer_claim_request_id;
      delete current.writer_claim_lost;
      current.image_fix_requires_research = false;
      current.image_fix_error_code = current.api_error_code = null;
      await jobStorage.set({ items: latest });
    });
    delete item.writer_claim_request_id;
    delete item.writer_claim_lost;
    const lease = await claimWriterLease(item, {
      provider: item.provider || "manual-retry",
      workerKey: item.writer_claim_worker_id || item.workerKey || `tab-${itemOwnerTabId(item)}`,
      retry: true
    });
    if (!lease.claimed) throw new Error(`Không thể nhận lại khóa cơ sở để gửi lại: ${lease.reason || "đang được máy khác giữ"}.`);
    const refreshed = (await jobStorage.get("items")).items?.find((row) => row.id === articleId);
    if (refreshed) Object.assign(item, refreshed);
    item.image_fix_requires_research = false;
    item.image_fix_error_code = item.api_error_code = null;
    delete item.image_fix_reclaim_allowed;
  }
  if (!hasFacilityImageFixReceipt(item) && (item.image_fix_requires_research || item.writer_claim_lost || !item.writer_claim_token)) throw new Error("Ảnh nguồn/khóa đã thay đổi; cần kiểm tra AI lại, không gửi JSON cũ dưới khóa mới.");
  await withSchedulerLock(async () => {
    const { items: latest = [] } = await getJobMetadata("items");
    const current = latest.find((row) => row.id === articleId);
    if (!current) throw new Error("Không tìm thấy bài Fix ảnh.");
    if (current.writer_claim_release_pending && !((current.image_fix_api_pending || current.image_fix_import_pending) &&
        hasFacilityImageFixReceipt(await hydrateArticle(current)))) {
      throw new Error("Đang trả khóa của tab cũ; chờ hoàn tất rồi gửi lại. JSON vẫn được giữ.");
    }
    markApiRequestStarted(current); await jobStorage.set({ items: latest });
  });
  const result = await publishFacilityImageFix(articleId, item, item.result);
  if (result.updated) {
    const { runner } = await getJobMetadata("runner");
    const entry = Object.entries(runner?.workers || {}).find(([, worker]) => worker.currentId === articleId);
    if (entry) await clearCurrent(articleId, entry[1].runToken, entry[0], { pauseBeforeNext: true });
  }
  return result;
}
async function retryFacilityImageFixResearch(articleId) {
  const { items = [] } = await jobStorage.get("items");
  const item = items.find((row) => row.id === articleId);
  if (!isFacilityImageFixItem(item) || item.status === "hoàn tất" || activeApiRequests.has(String(articleId)) || item.image_fix_api_pending || item.image_fix_import_pending) throw new Error("Không thể kiểm tra AI lại khi đã lưu JSON hoặc API chưa xác nhận; gửi lại đúng biên nhận để tải ảnh còn thiếu.");
  const released = await releaseWriterClaim(item);
  if (released.ok === false) throw new Error(`Chưa trả được khóa Fix ảnh: ${released.error || "lỗi kết nối"}. Giữ khóa cũ để thử lại, chưa chạy AI mới.`);
  await withSchedulerLock(async () => {
    const { items: latest = [] } = await getJobMetadata("items");
    const current = latest.find((row) => row.id === articleId);
    if (!current) throw new Error("Không tìm thấy bài Fix ảnh.");
    if (current.status === "đang viết" || current.image_fix_api_pending || current.image_fix_import_pending || activeApiRequests.has(String(articleId))) throw new Error("Trạng thái Fix ảnh đã thay đổi; chưa xếp lại bài đang xử lý.");
    current.status = "chờ"; current.error = null; current.api_error = null;
    current.image_fix_requires_research = false; current.image_fix_error_code = current.api_error_code = null;
    current.image_fix_api_pending = false; current.image_fix_import_pending = false; current.image_fix_payload = null;
    current.image_fix_previous_result = item.result || item.image_fix_previous_result || null;
    current.result = null; current.has_result = false; current.rawResponse = null;
    clearWriterClaimFields(current);
    for (const field of ["workerKey", "workerTabId", "runToken", "provider"]) delete current[field];
    await jobStorage.set({ items: latest });
  });
  return { ok: true, message: "Đã xếp lại Fix ảnh. Nhấn Chạy để nhận khóa và lấy nguồn/prompt mới trước khi gửi AI." };
}
async function handleImageFixDispatchError(article, error, workerKey, runToken) {
  if (!isFacilityImageFixItem(article)) return false;
  const ineligible = error.imageFixIneligible || error.writerClaimConflict && error.writerClaimReason === "not_published";
  if (!ineligible && !error.imageFixQueueError && !error.writerClaimConflict && ![401, 403, 404, 503].includes(error.httpStatus)) return false;
  if (ineligible) {
    await withSchedulerLock(async () => {
      const { items = [] } = await getJobMetadata("items");
      const current = items.find((item) => item.id === article.id);
      if (current) { current.status = "bỏ qua"; current.error = error.message; await jobStorage.set({ items }); }
    });
    await releaseWriterClaim(article);
  } else if (error.writerClaimConflict) await markArticleWriterConflict(article.id, error.writer);
  else {
    await failJob(article.id, error.message); await releaseWriterClaim(article);
    await pauseImageFixWorker(article.id, error, workerKey); return true;
  }
  await clearCurrent(article.id, runToken, workerKey === "legacy" ? undefined : workerKey);
  await runNext(workerKey === "legacy" ? undefined : workerKey, false);
  return true;
}

async function pauseDoctorWorker(articleId, error, workerKey) {
  await withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    if (!runner) return;
    const key = workerKey || Object.keys(runner.workers || {}).find((key) => runner.workers[key]?.currentId === articleId);
    const worker = runner.workers ? runner.workers[key] : runner;
    if (!worker || (articleId != null && worker.currentId && worker.currentId !== articleId)) return;
    worker.active = false;
    worker.currentId = null;
    worker.refilling = false;
    worker.lastError = error.message;
    worker.lastMessage = "Đã dừng hồ sơ bác sĩ; kiểm tra lỗi API trước khi chạy lại";
    worker.waitReason = "doctor-api-error";
    delete worker.nextJobAt;
    refreshRunnerSummary(runner, items);
    await jobStorage.set({ runner });
  });
}

async function haltDoctorForFatalHeartbeat(item, error) {
  error.doctorHeartbeatFatal = true;
  const halted = await withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const current = items.find((row) => row.id === item.id);
    if (!isDoctorItem(current) || current.status === "hoàn tất" || current.writer_claim_token !== item.writer_claim_token) return null;
    const entry = Object.entries(runner?.workers || {}).find(([, worker]) => worker.currentId === current.id);
    const [workerKey, worker] = entry || [current.workerKey, runner?.workers?.[current.workerKey] || runner];
    current.doctor_heartbeat_halt = { httpStatus: error.httpStatus, message: error.message,
      runToken: current.runToken || worker?.runToken, tabId: worker?.targetTabId || itemOwnerTabId(current) };
    current.writer_claim_heartbeat_error = current.api_error = error.message;
    // A pending POST may already have committed. Keep its JSON, lease and
    // receipt state; pausing the worker must never turn it into a fresh save.
    if (!["đang cập nhật", "chưa xác nhận"].includes(current.status) && !activeApiRequests.has(String(current.id))) {
      current.status = current.has_result ? "lỗi cập nhật" : "lỗi";
      current.error = error.message;
      current.writer_claimed = false;
    }
    await jobStorage.set({ items });
    return { articleId: current.id, workerKey, ...current.doctor_heartbeat_halt };
  });
  if (!halted) return false;
  await pauseDoctorWorker(halted.articleId, error, halted.workerKey);
  await saveDoctorQueueState(halted.tabId, doctorQueueStateFromError(error));
  if (halted.tabId) {
    const { runner } = await getJobMetadata("runner");
    const worker = runner?.workers?.[halted.workerKey] || (!runner?.workers ? runner : null);
    if (worker && !worker.active && worker.runToken === halted.runToken) {
      await chrome.tabs.sendMessage(Number(halted.tabId), { type: "stop-article", articleId: halted.articleId,
        runToken: halted.runToken }).catch(() => {});
    }
  }
  return true;
}

async function preserveHaltedDoctorCompletion(message, sender, completedResult) {
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const item = items.find((row) => row.id === message.articleId);
    const halt = item?.doctor_heartbeat_halt;
    if (!isDoctorItem(item) || !halt || !message.runToken || halt.runToken !== message.runToken ||
        Number(halt.tabId) !== Number(sender?.tab?.id) || item.status === "hoàn tất" ||
        ["đang cập nhật", "chưa xác nhận"].includes(item.status) || activeApiRequests.has(String(item.id))) return null;
    const worker = runner?.workers?.[item.workerKey] || (!runner?.workers ? runner : null);
    if (sender?.tab?.url && worker && !tabMatchesWorker(sender.tab, worker)) return null;
    item.result = completedResult;
    if (message.rawResponse != null) item.rawResponse = message.rawResponse;
    item.status = "lỗi cập nhật";
    item.insufficient_data = completedResult?.insufficient_data === true;
    item.api_error = halt.message;
    await jobStorage.set({ items });
    return { ok: false, updated: false, paused: true, error: halt.message };
  });
}

async function handleDoctorDispatchError(article, error, workerKey, runToken) {
  if (!isDoctorItem(article)) return false;
  const fatal = error.doctorQueueError || [401, 403, 503].includes(error.httpStatus);
  const ineligible = error.doctorIneligible || error.writerClaimConflict &&
    ["content_exists", "not_published", "content_exists_or_not_eligible"].includes(error.writerClaimReason);
  if (!fatal && !ineligible && !error.writerClaimConflict) return false;
  if (fatal) {
    await failJob(article.id, error.message);
    await pauseDoctorWorker(article.id, error, workerKey);
    return true;
  }
  if (ineligible) {
    await withSchedulerLock(async () => {
      const { items = [] } = await getJobMetadata("items");
      const current = items.find((item) => item.id === article.id);
      if (!current) return;
      current.status = "bỏ qua";
      current.error = error.message;
      await jobStorage.set({ items });
    });
    await releaseWriterClaim(article);
  } else await markArticleWriterConflict(article.id, error.writer);
  await clearCurrent(article.id, runToken, workerKey === "legacy" ? undefined : workerKey);
  await runNext(workerKey === "legacy" ? undefined : workerKey, false);
  return true;
}

async function retainDoctorLeaseLoss(articleId) {
  await withSchedulerLock(async () => {
    const { items = [] } = await getJobMetadata("items");
    const current = items.find((item) => item.id === articleId);
    if (!isDoctorItem(current) || current.status === "hoàn tất") return;
    current.writer_claim_lost = true;
    await jobStorage.set({ items });
  });
}

function doctorQueueEligible(item) {
  return item && item.needs_content !== false && (!item.status || item.status === "published") &&
    (!item.language_code || item.language_code === "vi") && !item.last_researched_at && !String(item.content || "").trim();
}

async function revalidateDoctorJob(item) {
  const data = await fetchDoctors([item.doctor_id], itemOwnerTabId(item));
  const fresh = data.items.find((entry) => Number(entry.id) === Number(item.doctor_id));
  if (!doctorQueueEligible(fresh)) {
    const error = new Error("Hồ sơ bác sĩ không còn đủ điều kiện nghiên cứu (đã viết, đã nghiên cứu, bản tiếng Anh hoặc chưa xuất bản).");
    error.doctorIneligible = true;
    throw error;
  }
  if (typeof fresh.prompt !== "string" || !fresh.prompt.trim()) {
    const error = new Error("API bác sĩ chưa trả prompt hợp lệ; chưa gửi AI.");
    error.doctorQueueError = true;
    throw error;
  }
  await withSchedulerLock(async () => {
    const { items = [] } = await getJobMetadata("items");
    const current = items.find((entry) => entry.id === item.id);
    if (!current) throw workerReleasedError();
    Object.assign(current, { prompt: fresh.prompt, name: fresh.name, title: fresh.name, output_template: fresh.output_template });
    for (const field of PROMPT_METADATA_FIELDS) if (Object.hasOwn(fresh, field)) current[field] = fresh[field];
    await jobStorage.set({ items });
    Object.assign(item, current, { prompt: fresh.prompt, output_template: fresh.output_template });
  });
  return item;
}

function hasFacilityImageFixReceipt(item) {
  if (!isFacilityImageFixItem(item) || !(item.image_fix_api_pending || item.image_fix_import_pending) ||
      typeof item.image_fix_payload !== "string") return false;
  try {
    const saved = JSON.parse(item.image_fix_payload)?.items;
    const row = Array.isArray(saved) && saved.length === 1 ? saved[0] : null;
    return Boolean(row && Number.isSafeInteger(row.id) && row.id > 0 && row.id === Number(item.facility_id) &&
      typeof row.images_revision === "string" && /^[a-f0-9]{64}$/i.test(row.images_revision) && row.images_revision === item.images_revision &&
      typeof row.writer_claim_token === "string" && /^[a-f0-9]{64}$/.test(row.writer_claim_token) &&
      (!item.writer_claim_token || row.writer_claim_token === item.writer_claim_token));
  } catch { return false; }
}

function writerLeaseExpiry(response = {}, elapsedMs = 0) {
  if (response.writer_local_expires_at) return response.writer_local_expires_at;
  const serverValue = response.server_now;
  const serverNumeric = Number(serverValue);
  const serverNow = serverValue == null ? NaN : Number.isFinite(serverNumeric) ? serverNumeric < 1e12 ? serverNumeric * 1000 : serverNumeric : Date.parse(serverValue);
  const value = response.lease_expires_at || response.expires_at;
  const numeric = typeof value === "number" || /^\d{10,13}$/.test(String(value || "")) ? Number(value) : NaN;
  const timestamp = Number.isFinite(numeric) ? numeric < 1e12 ? numeric * 1000 : numeric : Date.parse(value || "");
  const leaseMs = Number(response.lease_seconds) > 0 ? Number(response.lease_seconds) * 1000 : WRITER_CLAIM_LEASE_MS;
  const remaining = Number.isFinite(serverNow) && Number.isFinite(timestamp) ? Math.min(leaseMs, Math.max(0, timestamp - serverNow)) : leaseMs;
  return new Date(Date.now() + Math.max(0, remaining - elapsedMs - 1000)).toISOString();
}

async function fetchToplists(tabId) {
  return fetchArticleList("toplistsUrl", "Toplist", tabId);
}

async function fetchAiImages(tabId) {
  return fetchArticleList("aiImagesUrl", "cơ sở có gallery đủ ảnh", tabId);
}

async function fetchTranslations(translationType = "facility", tabId) {
  const type = normalizeTranslationType(translationType);
  const settings = await getTabSettings(tabId, "translationUrl");
  const url = new URL(migrateApiHost(settings.translationUrl || DEFAULTS.translationUrl));
  if (!url.searchParams.has("page")) url.searchParams.set("page", "1");
  // Translate one full DB row at a time: it keeps the prompt/API payload
  // bounded and makes each result unambiguously belong to one source row.
  url.searchParams.set("limit", "1");
  url.searchParams.set("type", type);
  return withQueueFetchTimeout(async (signal) => {
    const response = await fetch(url.href, {
      headers: { "X-Medical-Api-Key": MEDICAL_API_KEY, Accept: "application/json" }, signal
    });
    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); }
    catch { throw new Error(`API dịch trả về ${response.status}: ${responseText.slice(0, 300) || "phản hồi không phải JSON"}`); }
    if (!response.ok) throw new Error(`API dịch trả về ${response.status}: ${data?.message || responseText.slice(0, 300)}`);
    if (!data?.ok) throw new Error(data?.message || "Không lấy được danh sách cần dịch.");
    return { ok: true, translationType: type, items: Array.isArray(data.items) ? data.items : [] };
  }, "bản dịch");
}

// Bound list reads (including body parsing), not POST uploads. A list request
// must not hold an idle worker/refill latch forever when the network stalls.
async function withQueueFetchTimeout(read, label) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(function abortQueueRead() { timedOut = true; controller.abort(); }, QUEUE_FETCH_TIMEOUT_MS);
  try { return await read(controller.signal); }
  catch (error) {
    if (timedOut) throw new Error(`API lấy danh sách ${label} quá thời gian ${QUEUE_FETCH_TIMEOUT_MS / 1000} giây. Có thể tải lại danh sách để thử lại.`);
    throw error;
  } finally { clearTimeout(timer); }
}

async function fetchArticleList(settingKey, label, tabId) {
  const settings = await getTabSettings(tabId, settingKey);
  // A saved URL from the former domain is migrated here too, so an immediate
  // request can never race the startup migration and call top.top again.
  const url = new URL(migrateApiHost(settings[settingKey] || DEFAULTS[settingKey]));
  // Keep just one not-yet-processed record in extension storage. The next
  // record is requested only after the current one reaches a successful save.
  url.searchParams.set("limit", "1");
  return withQueueFetchTimeout(async (signal) => {
    const response = await fetch(url.href, { headers: { "X-Medical-Api-Key": MEDICAL_API_KEY, Accept: "application/json" }, signal });
    if (!response.ok) throw new Error(`API trả về ${response.status}`);
    const data = await response.json();
    if (!data?.ok) throw new Error(data?.message || `Không lấy được danh sách ${label}.`);
    return { ok: true, items: Array.isArray(data.items) ? data.items : [] };
  }, label);
}

async function refreshQueue(requestedSource, requestedTranslationType, ownerTabId = null) {
  const sourceType = normalizeSourceType(requestedSource);
  const translationType = normalizeTranslationType(requestedTranslationType || (await jobStorage.get("translationType")).translationType);
  const data = await fetchQueueSource(sourceType, translationType, ownerTabId);
  return withSchedulerLock(async () => {
    const latest = await jobStorage.get("items");
    if (ownerTabId) adoptLegacyTabItems(latest.items || [], ownerTabId, { sourceType, translationType });
    const merged = mergeQueueItems(latest.items || [], data.items, sourceType, translationType, ownerTabId);
    if (sourceType === "doctor") {
      const { runner } = await jobStorage.get("runner");
      const worker = runner?.workers ? runner.workers[workerKeyForTab(ownerTabId)] : runner;
      if (worker && !worker.active && worker.sourceType === "doctor" && ["doctor-api-error", "doctor-queue-error"].includes(worker.waitReason)) {
        worker.lastError = null;
        delete worker.waitReason;
        worker.lastMessage = "Đã tải danh sách hồ sơ bác sĩ; bấm Chạy để tiếp tục";
        refreshRunnerSummary(runner, merged.items);
        await jobStorage.set({ runner });
      }
    }
    await jobStorage.set({ items: merged.items, ...(sourceType === "facility_image_fix" ? imageFixQueueState(data, ownerTabId) : {}), ...(ownerTabId
      ? { [`tab-task-source:${ownerTabId}`]: { sourceType, translationType } }
      : { sourceType, ...(sourceType === "translation" ? { translationType } : {}) }) });
    const key = sourceType === "doctor" ? doctorQueueStateKey(ownerTabId) : null;
    return { ok: true, ...merged, ...(key ? { queueState: (await jobStorage.get(key))[key] } : {}), ...(sourceType === "facility_image_fix" ? { errors: data.errors || [], next_after_id: data.next_after_id, language: data.language } : {}), items: ownerTabId ? merged.items.filter((item) => itemOwnerTabId(item) === ownerTabId) : merged.items };
  });
}

function isHandbookItem(item) { return item?.sourceType === "handbook"; }

async function fetchHandbooks(tabId) {
  const settings = await getTabSettings(tabId, "handbooksUrl");
  const url = new URL(migrateApiHost(settings.handbooksUrl || DEFAULTS.handbooksUrl));
  return withQueueFetchTimeout(async (signal) => {
    const response = await fetch(url.href, { signal, cache: "no-store", headers: { "X-Medical-Api-Key": MEDICAL_API_KEY, Accept: "application/json" } });
    let data;
    try { data = JSON.parse(await response.text()); } catch { throw new Error(`API Cẩm nang HTTP ${response.status}: phản hồi không phải JSON.`); }
    if (!response.ok || data?.ok !== true || data.contract_version !== 1 || !Array.isArray(data.items)) {
      throw new Error(`API Cẩm nang HTTP ${response.status}: ${data?.message || "hợp đồng không hợp lệ"}`);
    }
    for (const key of ["claim_endpoint", "receive_endpoint"]) {
      const endpoint = new URL(data[key], url);
      if (!data[key] || endpoint.origin !== url.origin) throw new Error(`API Cẩm nang ${key} không cùng website; chưa chuyển khóa API.`);
    }
    return { ...data, items: data.items.map((item) => ({ ...item, contract_version: 1 })) };
  }, "Cẩm nang");
}

async function pauseHandbookWorker(articleId, message, code) {
  await withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const item = items.find((entry) => entry.id === articleId);
    if (item) item.handbook_error_code = code || "handbook_error";
    const worker = runner?.workers?.[item?.workerKey] || (!runner?.workers ? runner : null);
    if (worker) { worker.active = false; worker.lastError = message; worker.waitReason = "handbook-error"; delete worker.nextJobAt; }
    if (runner) refreshRunnerSummary(runner, items);
    await jobStorage.set({ items, ...(runner ? { runner } : {}) });
  });
}

async function stageHandbookResult(message, sender, result) {
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const workerKey = currentJobKeyFromState(runner, items, message.articleId, message.runToken, sender, { allowExpiredLease: true });
    const item = items.find((row) => row.id === message.articleId);
    if (!workerKey || !isHandbookItem(item)) return null;
    // Save original output even when validation fails. Never put BASE64 in the
    // small queue, storage.sync, system notices, or raw-response logs.
    await MedReviewHandbook.store.put(item.id, { result });
    item.handbook_payload_saved = true;
    item.has_result = true;
    delete item.rawResponse;
    delete item.handbook_error_code;
    try {
      const payload = MedReviewHandbook.payload(item, result);
      await MedReviewHandbook.store.put(item.id, { result, payload });
      markApiRequestStarted(item);
    } catch (error) {
      item.status = "lỗi cập nhật";
      item.api_error = MedReviewHandbook.safeError(error);
      item.handbook_error_code = error.code || "invalid_payload";
    }
    await jobStorage.set({ items });
    return { workerKey, queueItem: { ...item } };
  });
}

async function publishHandbook(item) {
  const key = String(item.id);
  if (activeApiRequests.has(key)) return { ok: false, updated: false, error: "Cẩm nang đang gửi, chưa gửi trùng." };
  activeApiRequests.add(key);
  let responseData, failure;
  try {
    const saved = await MedReviewHandbook.store.get(item.id);
    if (!saved?.payload) throw MedReviewHandbook.error("invalid_payload", "Chưa có HTML và ảnh Cẩm nang hợp lệ để gửi; JSON gốc vẫn được giữ.");
    const settings = await getTabSettings(itemOwnerTabId(item), "handbookUpdateUrl");
    let response;
    try {
      response = await fetch(migrateApiHost(settings.handbookUpdateUrl || DEFAULTS.handbookUpdateUrl), {
        method: "POST", headers: { "Content-Type": "application/json", "X-Medical-Api-Key": MEDICAL_API_KEY, Accept: "application/json" }, body: JSON.stringify(saved.payload)
      });
    } catch { throw MedReviewHandbook.error("network_unconfirmed", "Mất phản hồi gửi Cẩm nang; giữ nguyên payload, token, revision và request_id để gửi lại idempotent."); }
    let data;
    try { data = JSON.parse(await response.text()); } catch { throw MedReviewHandbook.error("response_unconfirmed", `API Cẩm nang HTTP ${response.status}: chưa xác nhận JSON phản hồi; giữ nguyên payload để kiểm tra/gửi lại.`); }
    if (!response.ok || data?.ok !== true) {
      const error = MedReviewHandbook.error(data?.reason || "api_error", `API Cẩm nang HTTP ${response.status}: ${MedReviewHandbook.safeError(data?.message || "chưa lưu được bài")}`);
      error.httpStatus = response.status;
      throw error;
    }
    if (data.type !== "handbook" || data.id !== Number(item.handbook_id) || data.status !== "draft" ||
        !Array.isArray(data.images) || !data.images.length || data.images.length > 4 ||
        data.images.some((image) => typeof image.url !== "string" || !image.url.startsWith("/uploads/handbook/") || image.url.includes(".."))) {
      throw MedReviewHandbook.error("response_unconfirmed", "API chưa xác nhận đúng ID, trạng thái draft và URL ảnh nội bộ Cẩm nang; giữ nguyên payload.");
    }
    responseData = data;
    await withSchedulerLock(async () => {
      const { items = [] } = await getJobMetadata("items");
      const current = items.find((row) => row.id === item.id);
      if (!current) return;
      current.result = MedReviewHandbook.compact(saved.result, data);
      current.handbook_payload_saved = false;
      delete current.handbook_error_code;
      finalizeApiRequest(current, "hoàn tất", data, null);
      clearWriterClaimFields(current);
      await jobStorage.set({ items });
    });
    // Delete large bytes only AFTER the lightweight success is durable.
    await MedReviewHandbook.store.remove(item.id);
    return { ok: true, updated: true, status: "draft", images: data.images };
  } catch (error) {
    failure = error;
    const message = MedReviewHandbook.safeError(error);
    await withSchedulerLock(async () => {
      const { items = [] } = await getJobMetadata("items");
      const current = items.find((row) => row.id === item.id);
      if (!current || current.status === "hoàn tất") return;
      finalizeApiRequest(current, /unconfirmed/.test(error.code || "") || error.httpStatus >= 500 ? "chưa xác nhận" : "lỗi cập nhật", null, message);
      current.handbook_error_code = error.code || "api_error";
      await jobStorage.set({ items });
    });
    await pauseHandbookWorker(item.id, message, error.code);
    return { ok: false, updated: false, error: message, code: error.code, unconfirmed: /unconfirmed/.test(error.code || "") };
  } finally { activeApiRequests.delete(key); }
}

async function completeHandbook(message, sender, result) {
  const staged = await stageHandbookResult(message, sender, result);
  if (!staged) return { ok: false, ignored: true, error: "Kết quả Cẩm nang không thuộc đúng tab/lượt đang viết." };
  if (staged.queueItem.handbook_error_code) {
    await pauseHandbookWorker(message.articleId, staged.queueItem.api_error, staged.queueItem.handbook_error_code);
    return { ok: true, updated: false, error: staged.queueItem.api_error };
  }
  const published = await publishHandbook(staged.queueItem);
  if (published.updated) {
    await clearCurrent(message.articleId, message.runToken, staged.workerKey === "legacy" ? undefined : staged.workerKey, { pauseBeforeNext: true });
    const prepared = await waitBeforeNextJob(staged.workerKey === "legacy" ? undefined : staged.workerKey);
    if (!prepared?.dispatched) await runNext(staged.workerKey === "legacy" ? undefined : staged.workerKey, !prepared?.attempted);
  }
  return { ...published, ok: true };
}

async function retryHandbook(item) {
  if (item.status === "hoàn tất") throw new Error("Cẩm nang đã lưu nháp; không tự ghi đè.");
  if (["already_claimed", "lease_lost", "not_eligible", "source_revision_changed", "idempotency_conflict"].includes(item.handbook_error_code)) {
    throw new Error("Bài hoặc quyền giữ Cẩm nang đã thay đổi. JSON được giữ để đối chiếu; không nhận khóa khác để gửi đè.");
  }
  return publishHandbook(item);
}

async function fetchQueueSource(sourceType, translationType, tabId, { refill = false } = {}) {
  if (sourceType === "handbook") return fetchHandbooks(tabId);
  if (sourceType === "facility_image_fix") {
    const state = refill ? (await jobStorage.get(imageFixQueueKey(tabId)))[imageFixQueueKey(tabId)] : null;
    if (state?.exhausted) return { ok: true, items: [], errors: state.errors || [], next_after_id: null, language: state.language };
    return fetchFacilityImageFixes([], tabId, null, state?.next_after_id ?? null);
  }
  if (sourceType === "doctor") return fetchDoctors([], tabId);
  if (sourceType === "toplist") return fetchToplists(tabId);
  if (sourceType === "ai-image") return fetchAiImages(tabId);
  if (sourceType === "translation") return fetchTranslations(translationType, tabId);
  return fetchFacilities(tabId);
}

async function runNext(workerKey, allowRefill = true) {
  const { runner } = await jobStorage.get("runner");
  if (runner?.workers) {
    if (workerKey) return runParallelNext(workerKey, allowRefill);
    const workerKeys = Object.keys(runner.workers).filter((key) => runner.workers[key]?.active);
    await Promise.all(workerKeys.map((key) => runParallelNext(key, allowRefill)));
    return;
  }
  return runNextLegacy(allowRefill);
}

function providerLabel(provider) {
  return PROVIDER_CONFIG[provider]?.label || "AI";
}

function workerKeyForTab(tabId) {
  return `tab-${Number(tabId)}`;
}

function tabIdFromWorker(key, worker) {
  const explicit = Number(worker?.targetTabId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const match = String(key || "").match(/^tab-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function releaseOrphanedItem(items, currentId) {
  const item = items.find((candidate) => candidate.id === currentId);
  if (item?.status !== "đang viết") return;
  item.status = "chờ";
  delete item.provider;
  delete item.workerKey;
  delete item.workerTabId;
}

function normalizeRunnerWorkers(runner, items = []) {
  const sourceEntries = Object.entries(runner?.workers || {});
  if (!sourceEntries.length && runner?.active && runner.currentId) {
    sourceEntries.push([runner.targetProvider || runner.provider, {
      active: true,
      provider: runner.targetProvider || runner.provider,
      targetTabId: runner.targetTabId,
      currentId: runner.currentId,
      runToken: runner.runToken,
      lastError: runner.lastError || null
    }]);
  }
  const workers = {};
  for (const [oldKey, savedWorker] of sourceEntries) {
    if (!savedWorker?.active) continue;
    const tabId = tabIdFromWorker(oldKey, savedWorker);
    const provider = PROVIDER_CONFIG[savedWorker.provider]
      ? savedWorker.provider
      : PROVIDER_CONFIG[oldKey] ? oldKey : null;
    if (!tabId || !provider) {
      releaseOrphanedItem(items, savedWorker.currentId);
      continue;
    }
    const key = workerKeyForTab(tabId);
    const worker = {
      ...savedWorker,
      active: true,
      provider,
      targetTabId: tabId
    };
    const current = items.find((candidate) => candidate.id === worker.currentId);
    worker.sourceType = normalizeSourceType(savedWorker.sourceType || (current ? queueItemSource(current) : runner.sourceType));
    worker.translationType = normalizeTranslationType(savedWorker.translationType || current?.type || current?.translation_type || runner.translationType);
    worker.sessionToken ||= runner.sessionToken || createRunToken();
    if (current?.status === "đang viết") {
      current.ownerTabId ||= tabId;
      current.provider = provider;
      current.workerKey = key;
      current.workerTabId = tabId;
    }
    // A tab can own only one worker. Prefer the entry that still owns a live
    // queue item when upgrading storage written by an older extension build.
    if (!workers[key]?.currentId || worker.currentId) workers[key] = worker;
  }
  return workers;
}

function providerFromTab(tab) {
  if (!tab?.url) return null;
  return Object.keys(PROVIDER_CONFIG).find((provider) => tabMatchesProvider(tab, provider)) || null;
}

function geminiSparkTaskIdFromTab(tab) {
  if (!tab?.url) return null;
  try {
    const url = new URL(tab.url);
    if (url.hostname !== "gemini.google.com") return null;
    const match = url.pathname.match(/(?:^|\/)spark\/chat\/([^/]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}

function isGeminiSparkTab(tab) {
  if (!tab?.url) return false;
  try {
    const url = new URL(tab.url);
    return url.hostname === "gemini.google.com" && /(?:^|\/)spark(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}

async function resolveGeminiSparkTaskInTab(tabId) {
  if (!Number.isInteger(Number(tabId)) || Number(tabId) <= 0 || typeof chrome.tabs?.sendMessage !== "function") {
    return { ok: false, error: `Không thể tìm task Gemini Spark “${GEMINI_SPARK_CONTENT_TASK_LABEL}”.` };
  }
  // Spark builds the sidebar asynchronously. Retry briefly so opening the
  // extension immediately after a navigation still finds the task row.
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const result = await chrome.tabs.sendMessage(Number(tabId), { type: "resolve-gemini-content-task" });
      if (result?.ok) return result;
      lastError = result?.error || lastError;
    } catch (error) {
      lastError = error?.message || lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return { ok: false, error: lastError || `Không tìm thấy task Gemini Spark “${GEMINI_SPARK_CONTENT_TASK_LABEL}”.` };
}

function tabMatchesWorker(tab, worker) {
  if (!tabMatchesProvider(tab, worker?.provider)) return false;
  if (worker?.provider !== "gemini") return true;
  if (worker.sparkTaskId) return geminiSparkTaskIdFromTab(tab) === worker.sparkTaskId;
  const currentTaskId = geminiSparkTaskIdFromTab(tab);
  return isGeminiSparkTab(tab) ? Boolean(currentTaskId) : true;
}

function findWorkerForTab(runner, tabId, provider) {
  if (!runner?.workers || tabId == null) return null;
  const exactKey = workerKeyForTab(tabId);
  if (runner.workers[exactKey]) return [exactKey, runner.workers[exactKey]];
  return Object.entries(runner.workers).find(([key, worker]) =>
    Number(worker?.targetTabId) === Number(tabId) &&
    (!provider || worker.provider === provider || key === provider)) || null;
}

async function resolveControlTab(request = {}, sender = {}) {
  const requestedTabId = request?.targetTabId ?? request?.tabId;
  let tab = sender?.tab?.id != null ? sender.tab : null;
  if (tab && requestedTabId != null && Number(tab.id) !== Number(requestedTabId)) {
    throw new Error("Panel không thuộc tab AI được yêu cầu.");
  }
  if (!tab && requestedTabId != null && typeof chrome.tabs.get === "function") {
    try { tab = await chrome.tabs.get(Number(requestedTabId)); }
    catch { throw new Error("Tab AI không còn tồn tại."); }
  }
  if (!tab?.id) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && !tab.url && typeof chrome.tabs.get === "function") {
    try { tab = await chrome.tabs.get(tab.id); } catch { /* handled below */ }
  }
  const provider = providerFromTab(tab);
  if (!tab?.id || !provider) {
    throw new Error("Tab này không phải ChatGPT, Grok, Claude hoặc Gemini.");
  }
  if (request?.provider && PROVIDER_CONFIG[request.provider] && request.provider !== provider) {
    throw new Error("Trang AI đã thay đổi; hãy tải lại tab rồi thử lại.");
  }
  // Normal Run stays in the Spark task currently open in this tab. The
  // special `content ai` task is discovered only by the stall-recovery path.
  const sparkTaskId = provider === "gemini" && isGeminiSparkTab(tab) ? geminiSparkTaskIdFromTab(tab) : null;
  return {
    tabId: tab.id, provider, label: providerLabel(provider), workerKey: workerKeyForTab(tab.id),
    ...(sparkTaskId ? { sparkTaskId } : {})
  };
}

async function getTabContext(request, sender) {
  const context = await resolveControlTab(request, sender);
  await initializeTabMemory(context);
  const { runner } = await jobStorage.get("runner");
  const entry = findWorkerForTab(runner, context.tabId, context.provider);
  const worker = entry?.[1] || null;
  return {
    ok: true, ...context, workerKey: entry?.[0] || context.workerKey,
    active: Boolean(runner?.active && worker?.active),
    currentId: worker?.currentId || null
  };
}

function adoptLegacyTabItems(items, tabId, scope) {
  for (const item of items) {
    if (itemOwnerTabId(item)) { item.ownerTabId ||= itemOwnerTabId(item); continue; }
    if (queueItemMatchesRunner(item, scope)) item.ownerTabId = Number(tabId);
  }
}

async function initializeTabMemory(context) {
  return withSchedulerLock(async () => {
    const preferenceKey = `tab-task-source:${context.tabId}`;
    const itemsKey = TAB_ITEMS_PREFIX + context.tabId;
    const settingsKey = `tab-api-settings:${context.tabId}`;
    const saved = await getJobMetadata(["items", "runner", "sourceType", "translationType", "instance_label", "account_label",
      ...API_URL_KEYS, preferenceKey, itemsKey, settingsKey]);
    const items = saved.items || [];
    const writes = {};
    const worker = findWorkerForTab(saved.runner, context.tabId)?.[1];
    const current = items.find((item) => item.id === worker?.currentId);
    const legacyItems = items.some((item) => !itemOwnerTabId(item));
    const scope = saved[preferenceKey] || {
      sourceType: normalizeSourceType(worker?.sourceType || (current ? queueItemSource(current) : legacyItems ? saved.sourceType : "facility")),
      translationType: normalizeTranslationType(worker?.translationType || current?.type || current?.translation_type || (legacyItems ? saved.translationType : "facility"))
    };
    if (worker?.active && !worker.sourceType) {
      worker.sourceType = current ? queueItemSource(current) : scope.sourceType;
      worker.translationType = normalizeTranslationType(current?.type || current?.translation_type || scope.translationType);
      writes.runner = saved.runner;
    }
    if (!saved[preferenceKey]) writes[preferenceKey] = scope;
    if (!saved[settingsKey]) writes[settingsKey] = Object.fromEntries([...API_URL_KEYS, "instance_label", "account_label"].map((key) => [key, saved[key] || DEFAULTS[key]]));
    if (!Object.hasOwn(saved, itemsKey)) {
      // One-time migration: legacy rows are assigned once, never copied to
      // every newly opened panel. Existing live workers keep their own rows.
      for (const [key, oldWorker] of Object.entries(saved.runner?.workers || {})) {
        const current = items.find((item) => item.id === oldWorker.currentId);
        const oldTabId = tabIdFromWorker(key, oldWorker);
        if (current && oldTabId) current.ownerTabId ||= oldTabId;
      }
      adoptLegacyTabItems(items, context.tabId, scope);
      writes.items = items;
      writes[itemsKey] = items.filter((item) => itemOwnerTabId(item) === context.tabId).map(articleMetadata);
    }
    if (Object.keys(writes).length) await jobStorage.set(writes);
  });
}

async function recoverExistingArticle(request = {}, sender = {}) {
  const articleId = String(request.articleId || "");
  if (!articleId) throw new Error("Thiếu mã bài cần khôi phục.");
  const context = await resolveControlTab(request, sender);
  await assertArticleTab(articleId, request, sender);
  if (context.provider !== "gemini") throw new Error("Đọc lại JSON đã có hiện chỉ hỗ trợ Gemini Spark.");
  const tab = await chrome.tabs.get(context.tabId);
  if (!isGeminiSparkTab(tab)) throw new Error("Hãy mở task Gemini Spark có JSON cần đọc lại.");

  const before = await jobStorage.get(["items", "runner"]);
  const item = (before.items || []).find((entry) => String(entry.id) === articleId);
  if (!item || item.status !== "lỗi" || isAiImageItem(item)) {
    throw new Error("Chỉ có thể đọc lại JSON cho bài viết đang ở trạng thái lỗi.");
  }
  const worker = findWorkerForTab(before.runner, context.tabId, context.provider)?.[1];
  if (worker?.active) throw new Error("Tab Gemini này đang chạy bài khác. Dừng hoặc đợi bài đó xong rồi thử lại.");

  const recovered = await chrome.tabs.sendMessage(context.tabId, {
    type: "read-existing-article-json",
    article: contentSafeArticle({ ...item, sourceType: item.sourceType || (item.toplist_id != null ? "toplist" : "facility") })
  });
  if (!recovered?.ok || !recovered.article) {
    throw new Error(recovered?.error || "Không tìm thấy JSON có ID trùng với bài cần khôi phục trong task đang mở.");
  }
  const expectedId = isToplistItem(item) ? item.toplist_id : isDoctorItem(item) ? item.doctor_id : item.facility_id;
  const records = Array.isArray(recovered.article) ? recovered.article : Array.isArray(recovered.article?.items) ? recovered.article.items : [recovered.article];
  const matched = records.some((record) => {
    const recordId = isToplistItem(item)
      ? record?.toplist_id ?? record?.toplistId ?? record?.id
      : record?.id;
    return expectedId != null && String(recordId) === String(expectedId);
  });
  if (!matched) throw new Error(`JSON tìm thấy nhưng không khớp ID ${expectedId ?? "của bài"}; chưa gửi website.`);

  const stagedItem = await withSchedulerLock(async () => {
    const latest = await jobStorage.get(["items", "runner"]);
    const current = (latest.items || []).find((entry) => String(entry.id) === articleId);
    const currentWorker = findWorkerForTab(latest.runner, context.tabId, context.provider)?.[1];
    if (!current || current.status !== "lỗi") throw new Error("Trạng thái bài đã thay đổi; tải lại danh sách rồi thử lại.");
    if (currentWorker?.active) throw new Error("Tab Gemini bắt đầu chạy bài khác; chưa khôi phục để tránh xung đột.");
    current.result = recovered.article;
    current.rawResponse = recovered.rawResponse;
    current.error = null;
    if (isDoctorItem(current) || isFacilityImageFixItem(current)) current.status = "lỗi cập nhật";
    else markApiRequestStarted(current);
    await jobStorage.set({ items: latest.items });
    return { ...current };
  });
  if (isDoctorItem(stagedItem) || isFacilityImageFixItem(stagedItem)) return { ...await retryUpdate(articleId), recovered: true };
  const result = await publishStagedJob(articleId, stagedItem, recovered.article);
  return { ...result, recovered: true, error: result.updated ? null : (await jobStorage.get("items")).items?.find((entry) => entry.id === articleId)?.api_error };
}

function markApiRequestStarted(item, now = Date.now()) {
  item.status = "đang cập nhật";
  item.api_request_started_at = new Date(now).toISOString();
  item.api_attempt_count = Math.max(0, Number(item.api_attempt_count) || 0) + 1;
  if (item.api_update) item.api_previous_update = item.api_update;
  item.api_update = null;
  item.api_error = null;
}

function finalizeApiRequest(item, status, apiUpdate, apiError, now = Date.now()) {
  item.status = status;
  item.api_update = apiUpdate;
  item.api_error = apiError;
  item.api_last_attempt_at = item.api_request_started_at || new Date(now).toISOString();
  delete item.api_request_started_at;
  if (status === "hoàn tất") item.completed_at = new Date(now).toISOString();
}

async function reconcileStaleApiUpdates(now = Date.now()) {
  const doctorRecovery = await reconcileDoctorPendingUpdates(now);
  const fixClaimsToRelease = [];
  const result = await withSchedulerLock(async () => {
    const { items = [], runner: savedRunner } = await getJobMetadata(["items", "runner"]);
    let changed = false;
    let recovered = 0;
    const recoveredIds = new Set();
    const activeWritingIds = new Set();

    if (savedRunner?.workers) {
      for (const worker of Object.values(savedRunner.workers)) {
        if (worker?.active && worker.currentId != null) activeWritingIds.add(String(worker.currentId));
      }
    } else if (savedRunner?.active && savedRunner.currentId != null) {
      activeWritingIds.add(String(savedRunner.currentId));
    }

    for (const item of items) {
      // Existing runs may have been claimed by an older extension build before
      // write_started_at was added. Start a durable *tracking* clock so the UI
      // can still show elapsed seconds without pretending to know the true
      // start time of that already-running job.
      if (item?.status === "đang viết" && activeWritingIds.has(String(item.id)) &&
          !Number.isFinite(Date.parse(item.write_started_at || ""))) {
        item.write_started_at = new Date(now).toISOString();
        item.write_timer_backfilled = true;
        changed = true;
      }
      if (item?.status !== "đang cập nhật" || isDoctorItem(item)) continue;
      if (isFacilityImageFixItem(item) && !activeApiRequests.has(String(item.id))) {
        const persisted = await hydrateArticle(item);
        if (!persisted.image_fix_payload) {
          // Staging is persisted before dispatch. A crash in that short gap
          // has no receipt body to replay and cannot be labelled "POST pending".
          const stagedAt = Date.parse(item.api_request_started_at || "");
          if (Number.isFinite(stagedAt) && now - stagedAt < 60000) continue;
          item.status = "lỗi cập nhật";
          item.image_fix_api_pending = false;
          item.image_fix_requires_research = true;
          item.image_fix_error_code = item.api_error_code = "dispatch_not_persisted";
          item.api_error = "Chrome dừng trước khi lưu payload gửi Fix ảnh. JSON còn giữ; bấm Kiểm tra lại để nhận khóa và nguồn mới.";
          if (item.writer_claim_token) fixClaimsToRelease.push({ ...item });
          recoveredIds.add(String(item.id)); changed = true; recovered += 1;
          continue;
        }
        item.status = "chưa xác nhận";
        item.image_fix_api_pending = true;
        item.api_error = "Chrome mất phản hồi Fix ảnh; dùng Gửi lại để kiểm tra đúng payload/token cũ, không chạy AI lại.";
        item.api_unconfirmed_at = new Date(now).toISOString();
        changed = true;
        continue;
      }
      // A request still running in this service worker must not be called
      // uncertain, even if it legitimately takes a long time.
      if (activeApiRequests.has(String(item.id))) continue;
      const startedAt = Date.parse(item.api_request_started_at || "");
      if (!Number.isFinite(startedAt)) {
        // Legacy pending rows have no durable timestamp. Start the 30-minute
        // observation window now rather than guessing they have failed.
        item.api_request_started_at = new Date(now).toISOString();
        changed = true;
        continue;
      }
      if (now - startedAt < API_UPDATE_STALE_MS) continue;
      item.status = "chưa xác nhận";
      item.api_error = API_UPDATE_UNCONFIRMED_MESSAGE;
      item.api_unconfirmed_at = new Date(now).toISOString();
      recoveredIds.add(String(item.id));
      recovered += 1;
      changed = true;
    }

    if (!changed) return { ok: true, recovered: doctorRecovery.recovered };
    const runner = savedRunner ? { ...savedRunner } : null;
    if (runner) {
      if (runner.workers) {
        runner.workers = { ...runner.workers };
        for (const [workerKey, savedWorker] of Object.entries(runner.workers)) {
          if (!recoveredIds.has(String(savedWorker?.currentId))) continue;
          const worker = { ...savedWorker, active: false, currentId: null };
          delete worker.nextJobAt;
          runner.workers[workerKey] = worker;
        }
        runner.active = Object.values(runner.workers).some((worker) => worker?.active);
        runner.parallel = Object.values(runner.workers).filter((worker) => worker?.active).length > 1;
        if (recovered) runner.lastMessage = `${recovered} bài chưa nhận được xác nhận gửi API; JSON vẫn được lưu để kiểm tra hoặc gửi lại`;
        refreshRunnerSummary(runner, items);
      } else if (recoveredIds.has(String(runner.currentId))) {
        runner.active = false;
        runner.currentId = null;
        delete runner.nextJobAt;
        runner.lastMessage = "API chưa xác nhận; JSON vẫn được lưu để kiểm tra hoặc gửi lại";
      }
    }
    await jobStorage.set({ items, ...(runner ? { runner } : {}) });
    return { ok: true, recovered: recovered + doctorRecovery.recovered };
  });
  for (const item of fixClaimsToRelease) await releaseWriterClaim(item);
  return result;
}

async function bindSparkTask(message = {}, sender = {}) {
  const tabId = Number(sender?.tab?.id);
  const sparkTaskId = String(message.sparkTaskId || "").trim();
  if (!Number.isInteger(tabId) || tabId <= 0 || !sparkTaskId) {
    throw new Error("Thiếu tab hoặc task Gemini Spark để ràng buộc phiên làm việc.");
  }
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const entry = findWorkerForTab(runner, tabId, "gemini");
    const worker = entry?.[1];
    if (message.type === "bind-spark-task" && worker?.runToken && message.runToken && worker.runToken !== message.runToken) {
      throw new Error("Phiên Gemini Spark đã đổi; bài được giữ lại trong hàng đợi.");
    }
    const conflict = Object.entries(runner?.workers || {}).find(([key, candidate]) =>
      key !== entry?.[0] && candidate?.active && candidate.provider === "gemini" && candidate.sparkTaskId === sparkTaskId
    );
    if (conflict) {
      throw new Error(`Task Gemini Spark này đang chạy ở tab ${conflict[1].targetTabId}; dùng hoặc dừng tab đó trước.`);
    }
    const item = message.articleId != null
      ? items.find((candidate) => String(candidate.id) === String(message.articleId))
      : null;
    if (item) {
      item.sparkTaskId = sparkTaskId;
      if (message.sparkChatUrl) item.sparkChatUrl = message.sparkChatUrl;
    }
    if (worker) {
      worker.sparkTaskId = sparkTaskId;
      if (message.sparkChatUrl) worker.sparkChatUrl = message.sparkChatUrl;
    }
    const nextRunner = runner ? { ...runner } : runner;
    if (nextRunner && !nextRunner.workers && nextRunner.targetTabId === tabId) {
      nextRunner.sparkTaskId = sparkTaskId;
    }
    await jobStorage.set({ items, ...(nextRunner ? { runner: nextRunner } : {}) });
    return { ok: true, taskId: sparkTaskId, tabId };
  });
}

async function prepareAiImageUpload(message = {}, sender = {}) {
  const articleId = message.articleId;
  const runToken = message.runToken;
  const senderTabId = sender?.tab?.id;
  if (!articleId || !runToken || !Number.isInteger(Number(senderTabId))) {
    throw new Error("Thiếu thông tin phiên tạo ảnh để upload.");
  }
  const { items = [], runner, aiImageUpdateUrl } = await getJobMetadata([
    "items", "runner", "aiImageUpdateUrl"
  ]);
  const workerKey = currentJobKeyFromState(runner, items, articleId, runToken, sender);
  if (!workerKey) {
    throw new Error("Phiên tạo ảnh đã dừng hoặc chuyển sang cơ sở khác; chưa upload ảnh.");
  }
  const item = items.find((entry) => entry.id === articleId);
  const facilityId = item?.facility_id ?? item?.facilityId;
  if (!isAiImageItem(item) || !isPositiveId(facilityId)) {
    throw new Error("Không tìm thấy cơ sở hợp lệ cho phiên upload ảnh AI.");
  }
  const provider = providerFromTab(sender.tab);
  if (!isAiImageProvider(provider) || (message.provider && provider !== message.provider)) {
    throw new Error("Tab upload không phải phiên ChatGPT/Grok đang tạo ảnh.");
  }
  return {
    ok: true,
    url: migrateApiHost((await getTabSettings(itemOwnerTabId(item), "aiImageUpdateUrl")).aiImageUpdateUrl || aiImageUpdateUrl || DEFAULTS.aiImageUpdateUrl),
    apiKey: MEDICAL_API_KEY,
    facilityId: Number(facilityId),
    workerKey
  };
}

function withSchedulerLock(callback) {
  const operation = schedulerLock.then(callback, callback);
  schedulerLock = operation.catch(() => {});
  return operation;
}

function refreshRunnerSummary(runner, items = []) {
  if (!runner?.workers) return runner;
  const active = Object.values(runner.workers).filter((worker) => worker?.active);
  runner.active = active.length > 0;
  runner.parallel = active.length > 1;
  runner.provider = active.length > 1 ? "multi-tab" : active[0]?.provider || null;
  runner.refilling = active.some((worker) => worker.refilling);
  if (active.length === 1) {
    Object.assign(runner, workerSourceScope(active[0], runner));
  }
  const busy = Object.entries(runner.workers).filter(([, worker]) => worker?.currentId);
  const [, firstWorker] = busy[0] || [];
  runner.currentId = firstWorker?.currentId || null;
  runner.targetProvider = firstWorker?.provider || null;
  runner.targetTabId = firstWorker?.targetTabId || null;
  if (busy.length) {
    runner.lastMessage = busy.map(([, worker]) => {
      const item = items.find((entry) => entry.id === worker.currentId);
      return `${providerLabel(worker.provider)} · Tab ${worker.targetTabId}: ${item?.title || "đang viết"}`;
    }).join(" · ");
  }
  return runner;
}

function repairWorkerCurrentSlot(worker, items, { nextJobDelayMs, now = Date.now() } = {}) {
  if (!worker.currentId) return false;
  const current = items.find((item) => item.id === worker.currentId);
  // Never steal a live AI/write/upload slot, including an API that legitimately
  // takes a long time. Spark failed-slot retries retain their original owner.
  if (current && (["đang viết", "đang cập nhật"].includes(current.status) ||
      isFacilityImageFixItem(current) && current.image_fix_api_pending ||
      activeApiRequests.has(String(current.id)) ||
      current.status === "lỗi" && worker.provider === "gemini" && worker.sparkTaskId)) return false;
  worker.currentId = null;
  if (["hoàn tất", "ảnh chưa đủ"].includes(current?.status) && chrome.runtime?.id) {
    const completedAt = Date.parse(current.completed_at || current.api_last_attempt_at || "");
    const delay = Number(nextJobDelayMs ?? DEFAULTS.nextJobDelayMs);
    if (Number.isFinite(completedAt) && Number.isFinite(delay) && delay > 0) {
      const deadline = completedAt + Math.min(delay, 24 * 60 * 60 * 1000);
      if (deadline > now) worker.nextJobAt = Math.max(Number(worker.nextJobAt) || 0, deadline);
    }
  }
  worker.lastError = null;
  worker.waitReason = "Đang khôi phục lượt chạy bài tiếp theo";
  return true;
}

async function claimParallelArticle(workerKey, { preparing = false, deadline, ownerToken } = {}) {
  await reconcileClosedTabJobs();
  return withSchedulerLock(async () => {
    const { items = [], runner, sourceType: savedSourceType, nextJobDelayMs } = await getJobMetadata(["items", "runner", "sourceType", "nextJobDelayMs"]);
    const worker = runner?.workers?.[workerKey];
    if (!runner?.active || !worker?.active) return null;
    if (repairWorkerCurrentSlot(worker, items, { nextJobDelayMs })) {
      refreshRunnerSummary(runner, items);
      await jobStorage.set({ runner });
    }
    if (worker.refilling && workerRefillPromises.has(workerKey)) return null;
    if (worker.refilling) {
      worker.refilling = false;
      delete worker.refillToken;
      refreshRunnerSummary(runner, items);
      await jobStorage.set({ runner });
    }
    if (preparing && (!Number(worker.nextJobAt) || worker.nextJobAt !== deadline || worker.runToken !== ownerToken)) return null;
    const failedArticle = sparkFailedArticle(items, runner, worker);
    if (!preparing && !failedArticle && Number(worker.nextJobAt || 0) > Date.now()) return null;
    if (worker.currentId) {
      if (!failedArticle || worker.currentId !== failedArticle.id) return null;
      worker.currentId = null;
    }
    const scope = workerSourceScope(worker, runner, savedSourceType);
    const article = failedArticle || items.find((item) => isQueueItemRunnable(item) && queueItemMatchesRunner(item, scope) && !hasOtherTabJobInFlight(items, item, worker.targetTabId));
    if (!article) return null;
    const runToken = createRunToken();
    article.status = "đang viết";
    article.ownerTabId = worker.targetTabId;
    delete article.gemini_spark_dispatch_retry_at;
    delete article.gemini_spark_json_retry_at;
    article.write_started_at = new Date().toISOString();
    article.last_progress_at = article.write_started_at;
    delete article.prompt_sent_at;
    delete article.prompt_prepared_at;
    delete article.prompt_dispatch_ready;
    if (preparing) article.prompt_scheduled_at = new Date(worker.nextJobAt).toISOString();
    else delete article.prompt_scheduled_at;
    delete article.gemini_spark_reload_attempted_at;
    delete article.gemini_spark_reload_source;
    delete article.gemini_spark_reload_error;
    delete article.gemini_spark_reload_count;
    article.provider = worker.provider;
    article.workerKey = workerKey;
    article.workerTabId = worker.targetTabId;
    worker.currentId = article.id;
    if (!preparing) delete worker.nextJobAt;
    worker.runToken = runToken;
    worker.lastError = null;
    delete worker.waitReason;
    refreshRunnerSummary(runner, items);
    await jobStorage.set({ items, runner });
    return { article: await hydrateArticle(article), runToken };
  });
}

async function maybeStopParallel(workerKey) {
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    if (!runner?.active || !runner.workers) return;
    for (const [key, worker] of Object.entries(runner.workers)) {
      if (workerKey && key !== workerKey) continue;
      if (!worker?.active || worker.currentId || worker.refilling) continue;
      const waiting = items.some((item) => isWorkerQueueItemRunnable(items, item, workerSourceScope(worker, runner)));
      if (waiting) continue;
      const queued = items.filter((item) => item.status === "chờ" && queueItemMatchesRunner(item, workerSourceScope(worker, runner)));
      if (queued.length) {
        worker.waitReason = queued.some((item) => hasOtherTabJobInFlight(items, item, worker.targetTabId))
          ? "Bài chờ trùng với bài ở tab khác; chưa gửi lại để tránh trùng dữ liệu"
          : "Bài chờ đang được phiên khác giữ hoặc đang chờ giải phóng khóa";
      } else worker.waitReason = worker.lastError || null;
      worker.active = false;
      delete worker.nextJobAt;
      worker.lastMessage ||= `Không còn ${sourceLabel(workerSourceScope(worker, runner).sourceType)} mới`;
    }
    refreshRunnerSummary(runner, items);
    if (!runner.active) runner.lastMessage = "Không còn bài mới";
    await jobStorage.set({ runner });
  });
}

async function runParallelNext(workerKey, allowRefill = true) {
  const claimed = await claimParallelArticle(workerKey);
  if (claimed) {
    const { article, runToken } = claimed;
    try {
      await startJob(article, article.prompt, workerKey, runToken);
    } catch (error) {
      if (error.workerReleased) return;
      if (await handleImageFixDispatchError(article, error, workerKey, runToken)) return;
      if (await handleDoctorDispatchError(article, error, workerKey, runToken)) return;
      if (error.writerClaimConflict) {
        await markArticleWriterConflict(article.id, error.writer);
        await clearCurrent(article.id, runToken, workerKey);
        await runParallelNext(workerKey, false);
        return;
      }
      if (await scheduleSparkJobRetry(article.id, error.message, runToken, workerKey)) return;
      await failJob(article.id, error.message);
      await clearCurrent(article.id, runToken, workerKey);
      await runParallelNext(workerKey, false);
    }
    return;
  }
  const { items = [], runner } = await getJobMetadata(["items", "runner"]);
  const worker = runner?.workers?.[workerKey];
  if (!runner?.active || !worker?.active || worker.currentId || worker.refilling && workerRefillPromises.has(workerKey)) return;
  if (Number(worker.nextJobAt || 0) > Date.now()) return;
  const waiting = items.some((item) => isWorkerQueueItemRunnable(items, item, workerSourceScope(worker, runner)));
  if (waiting) return runParallelNext(workerKey, false);
  if (allowRefill) {
    await refillQueue({ workerKey });
    return runParallelNext(workerKey, false);
  }
  await maybeStopParallel(workerKey);
}

async function runNextLegacy(allowRefill = true) {
  const { items = [], runner, sourceType: savedSourceType } = await jobStorage.get(["items", "runner", "sourceType"]);
  if (!runner?.active) return;
  if (runner.currentId || runner.refilling) return;
  if (Number(runner.nextJobAt || 0) > Date.now()) return;
  const sourceType = normalizeSourceType(runner.sourceType, normalizeSourceType(savedSourceType));
  const article = items.find((item) => isQueueItemRunnable(item) && queueItemMatchesRunner(item, runner, sourceType));
  if (!article) {
    if (allowRefill) {
      const refill = await refillQueue();
      if (refill.added > 0) await runNext(false);
      return;
    }
    await jobStorage.set({ runner: { ...runner, active: false, currentId: null, refilling: false, lastMessage: "Không còn bài mới" } });
    return;
  }
  article.status = "đang viết";
  delete article.gemini_spark_dispatch_retry_at;
  delete article.gemini_spark_json_retry_at;
  article.write_started_at = new Date().toISOString();
  article.last_progress_at = article.write_started_at;
  delete article.prompt_sent_at;
  delete article.gemini_spark_reload_attempted_at;
  delete article.gemini_spark_reload_source;
  delete article.gemini_spark_reload_error;
  delete article.gemini_spark_reload_count;
  runner.currentId = article.id;
  delete runner.nextJobAt;
  runner.lastMessage = `Đang viết: ${article.title || "Bài viết"}`;
  runner.lastError = null;
  await jobStorage.set({ items, runner });
  const prompt = article.prompt;
  try {
    const provider = runner.provider === "auto" ? await detectProvider() : runner.provider;
    await startJob(article, prompt, provider, runner.runToken);
  }
  catch (error) {
    if (error.workerReleased) return;
    if (await handleImageFixDispatchError(article, error, "legacy", runner.runToken)) return;
    if (await handleDoctorDispatchError(article, error, "legacy", runner.runToken)) return;
    if (error.writerClaimConflict) {
      await markArticleWriterConflict(article.id, error.writer);
      await clearCurrent(article.id, runner.runToken);
      await runNextLegacy(false);
      return;
    }
    if (await scheduleSparkJobRetry(article.id, error.message, runner.runToken, "legacy")) return;
    await failJob(article.id, error.message);
    await clearCurrent(article.id, runner.runToken);
    await runNextLegacy(false);
  }
}

async function waitBeforeNextJob(workerKey) {
  // The one-minute pause is stored as a setting so it survives extension
  // restarts.  A real extension runtime always has chrome.runtime.id; keeping
  // the fallback immediate when that API is absent also makes older embedded
  // test/legacy contexts safe while initializeExtensionStorage provisions the
  // production default of 60 seconds.
  const { nextJobDelayMs } = await jobStorage.get("nextJobDelayMs");
  const delay = chrome.runtime?.id ? Number(nextJobDelayMs ?? DEFAULTS.nextJobDelayMs) : 0;
  if (!Number.isFinite(delay) || delay <= 0) return;
  let deadline = Date.now() + Math.min(delay, 24 * 60 * 60 * 1000);
  const recorded = await withSchedulerLock(async () => {
    const { runner } = await jobStorage.get("runner");
    if (!runner?.active) return false;
    if (runner.workers) {
      const worker = runner.workers[workerKey];
      if (!worker?.active) return false;
      if (Number(worker.nextJobAt) > 0) deadline = Number(worker.nextJobAt);
      else { worker.nextJobAt = deadline; delete worker.prefetchCompletedFor; }
    } else {
      if (Number(runner.nextJobAt) > 0) deadline = Number(runner.nextJobAt);
      else { runner.nextJobAt = deadline; delete runner.prefetchCompletedFor; }
    }
    await jobStorage.set({ runner });
    return true;
  });
  if (!recorded) return;
  scheduleNextJobAlarm(workerKey || "legacy", deadline);
  const pause = new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())));
  // Fetch and normalize the next single API record while the countdown runs.
  // Spark fills its prompt and obtains a lease during the countdown;
  // the content script waits until the persisted deadline before Send.
  const [prepared] = await Promise.all([prepareNextArticle(workerKey), pause]);
  // Keep the deadline durable until the next claim/alarm consumes it. Deleting
  // it here left an un-wakeable idle slot if MV3 slept before runNext executed.
  return prepared;
}

function scheduleNextJobAlarm(workerKey, deadline) {
  try {
    const created = chrome.alarms?.create?.(`${NEXT_JOB_ALARM_PREFIX}${workerKey}`, { when: Math.max(Date.now() + 100, deadline) });
    if (created?.catch) created.catch(() => {});
  } catch {}
}

async function restoreNextJobAlarms() {
  const { items = [], runner } = await getJobMetadata(["items", "runner"]);
  if (!runner?.active) return;
  const workers = runner.workers ? Object.entries(runner.workers) : [["legacy", runner]];
  for (const [key, worker] of workers) {
    if (!worker.active) continue;
    const item = items.find((entry) => entry.id === worker.currentId);
    const deadline = Number(worker.nextJobAt) || (!item?.prompt_sent_at ? Date.parse(item?.prompt_scheduled_at || "") : 0);
    if (Number.isFinite(deadline) && deadline > 0) scheduleNextJobAlarm(key, deadline);
    else if (!item || !["đang viết", "đang cập nhật"].includes(item.status)) scheduleNextJobAlarm(key, Date.now() + 100);
  }
}

async function recoverIdleWorkers(now = Date.now()) {
  await reconcileClosedTabJobs();
  await reconcileDoctorPendingUpdates(now);
  const { items = [], runner } = await getJobMetadata(["items", "runner"]);
  if (!runner?.active) return;
  const workers = runner.workers ? Object.entries(runner.workers) : [["legacy", runner]];
  for (const [key, worker] of workers) {
    if (!worker?.active) continue;
    const item = items.find((entry) => entry.id === worker.currentId);
    // Recovery is scheduling only, not a timeout/retry for a live AI or POST.
    if (item && (["đang viết", "đang cập nhật"].includes(item.status) || (isDoctorItem(item) || isFacilityImageFixItem(item)) && item.status === "chưa xác nhận") && !item.prompt_scheduled_at) continue;
    await resumeNextJobDeadline(key, now);
  }
}

async function resumeNextJobDeadline(workerKey, now = Date.now()) {
  if (activeNextJobResumes.has(workerKey)) return;
  activeNextJobResumes.add(workerKey);
  try {
    const resume = await withSchedulerLock(async () => {
      const { items = [], runner, nextJobDelayMs } = await getJobMetadata(["items", "runner", "nextJobDelayMs"]);
      const worker = workerKey === "legacy" ? runner : runner?.workers?.[workerKey];
      if (!runner?.active || !worker?.active) return null;
      const item = items.find((entry) => entry.id === worker.currentId);
      if ((isDoctorItem(item) || isFacilityImageFixItem(item)) && ["đang cập nhật", "chưa xác nhận"].includes(item.status)) return null;
      const deadline = Number(worker.nextJobAt) || (!item?.prompt_sent_at ? Date.parse(item?.prompt_scheduled_at || "") : 0);
      if (deadline > now) { scheduleNextJobAlarm(workerKey, deadline); return null; }
      const inFlight = workerKey === "legacy" ? refillPromise : workerRefillPromises.get(workerKey);
      const scope = workerSourceScope(worker, runner);
      const queued = items.some((entry) => isWorkerQueueItemRunnable(items, entry, scope));
      const wasRefilling = Boolean(worker.refilling || workerKey === "legacy" && runner.refilling);
      if (wasRefilling && inFlight && !queued) { scheduleNextJobAlarm(workerKey, now + 1000); return null; }
      const repaired = repairWorkerCurrentSlot(worker, items, { nextJobDelayMs, now });
      if (Number(worker.nextJobAt) > now) {
        refreshRunnerSummary(runner, items);
        await jobStorage.set({ runner });
        scheduleNextJobAlarm(workerKey, worker.nextJobAt);
        return null;
      }
      if (sparkFailedArticle(items, runner, worker)) return { worker: { ...worker }, retryFailed: true };
      if (worker.currentId && (!Number.isFinite(deadline) || deadline <= 0)) return null;
      // Chrome can sleep after the completed job stores its countdown but
      // before prefetch starts. Distinguish that gap from a confirmed empty
      // or failed prefetch so recovery fetches once, not indefinitely.
      const allowRefill = wasRefilling || !Number.isFinite(deadline) || deadline <= 0 ||
        !queued && Number(worker.prefetchCompletedFor) !== deadline;
      // refilling is durable, whereas refillPromise is lost when MV3 sleeps.
      if (worker.refilling) { worker.refilling = false; delete worker.refillToken; }
      if (runner.workers) refreshRunnerSummary(runner, items);
      else if (runner.refilling) runner.refilling = false;
      delete worker.nextJobAt;
      await jobStorage.set({ runner });
      return { worker: { ...worker }, article: !repaired && item && { ...item }, allowRefill };
    });
    if (!resume) return;
    if (resume.retryFailed) return runNext(workerKey === "legacy" ? undefined : workerKey, false);
    if (!resume.worker.currentId) {
      await runNext(workerKey === "legacy" ? undefined : workerKey, resume.allowRefill);
      return;
    }
    const article = await hydrateArticle(resume.article);
    if (article?.status !== "đang viết" || !article.prompt_scheduled_at || article.prompt_sent_at) return;
    try {
      if (!article.prompt_dispatch_ready) {
        await startJob(article, article.prompt, workerKey === "legacy" ? resume.worker.provider : workerKey, resume.worker.runToken);
      } else {
        const tab = await chrome.tabs.get(resume.worker.targetTabId);
        if (!tabMatchesWorker(tab, resume.worker)) {
          await stopWorkerByTabId(resume.worker.targetTabId, false);
          throw workerReleasedError("Tab AI đã chuyển trang; bài được trả lại hàng đợi.");
        }
        const latest = await jobStorage.get(["items", "runner"]);
        const current = latest.items?.find((item) => item.id === article.id);
        if (!current || !currentJobStillOwned(latest.runner, current, workerKey, resume.worker.runToken, tab.id) || current.prompt_sent_at) return;
        if (isFacilityImageFixItem(current) && !await validateWriterLeaseForCompletion(current.id, { strict: true })) throw workerReleasedError("Khóa Fix ảnh đã mất trước khi gửi prompt đã chuẩn bị.");
        const response = await chrome.tabs.sendMessage(resume.worker.targetTabId, {
          type: "resume-scheduled-article", article: contentSafeArticle({ ...article, runToken: resume.worker.runToken }), prompt: article.prompt
        });
        if (response?.ok !== true) throw new Error("Tab Spark chưa xác nhận tiếp tục gửi prompt đã chuẩn bị.");
      }
    } catch (error) {
      if (/Receiving end does not exist|Could not establish connection/i.test(String(error.message))) {
        try {
          await startJob(article, article.prompt, workerKey === "legacy" ? resume.worker.provider : workerKey, resume.worker.runToken);
          return;
        } catch (dispatchError) { error = dispatchError; }
      }
      if (error.workerReleased) return;
      if (await handleImageFixDispatchError(article, error, workerKey, resume.worker.runToken)) return;
      if (await handleDoctorDispatchError(article, error, workerKey, resume.worker.runToken)) return;
      await scheduleSparkJobRetry(article.id, error.message, resume.worker.runToken, workerKey);
    }
  } finally {
    activeNextJobResumes.delete(workerKey);
  }
}

async function prepareNextArticle(workerKey) {
  const { items = [], runner } = await getJobMetadata(["items", "runner"]);
  const worker = runner?.workers ? runner.workers[workerKey] : runner;
  if (!runner?.active || !worker?.active || worker.currentId) return { attempted: false };
  if (sparkFailedArticle(items, runner, worker)) return { attempted: false, ready: true };
  const queued = items.some((item) => isWorkerQueueItemRunnable(items, item, workerSourceScope(worker, runner)));
  const result = queued ? { attempted: false, ready: true } : { attempted: true, ...await refillQueue({ prefetch: true, ...(runner.workers ? { workerKey } : {}) }) };
  if (worker.provider !== "gemini" || !worker.sparkTaskId || !Number(worker.nextJobAt)) return result;
  const claimed = await claimParallelArticle(workerKey, { preparing: true, deadline: worker.nextJobAt, ownerToken: worker.runToken });
  if (!claimed) return result;
  try {
    await startJob(claimed.article, claimed.article.prompt, workerKey, claimed.runToken);
  } catch (error) {
    if (error.workerReleased) return { ...result, dispatched: true };
    if (await handleImageFixDispatchError(claimed.article, error, workerKey, claimed.runToken)) return { ...result, dispatched: true };
    if (await handleDoctorDispatchError(claimed.article, error, workerKey, claimed.runToken)) return { ...result, dispatched: true };
    if (error.writerClaimConflict) {
      await markArticleWriterConflict(claimed.article.id, error.writer);
      await stopWorkerByTabId(worker.targetTabId, false);
    } else {
      await scheduleSparkJobRetry(claimed.article.id, error.message, claimed.runToken, workerKey);
    }
  }
  return { ...result, dispatched: true };
}

async function refillQueue({ prefetch = false, workerKey } = {}) {
  if (workerKey) return refillWorkerQueue(workerKey, prefetch);
  if (refillPromise) return refillPromise;
  refillPromise = (async () => {
    const initial = await jobStorage.get(["items", "runner", "sourceType", "translationType"]);
    if (!initial.runner?.active || (!initial.runner.workers && initial.runner.currentId)) return { added: 0, skipped: 0 };
    const runToken = initial.runner.workers ? initial.runner.sessionToken : initial.runner.runToken;
    const prefetchDeadline = prefetch ? Number(initial.runner.nextJobAt) : 0;
    const sourceType = normalizeSourceType(initial.runner.sourceType, normalizeSourceType(initial.sourceType));
    const translationType = normalizeTranslationType(initial.runner.translationType || initial.translationType);
    const label = sourceLabel(sourceType);
    await jobStorage.set({ runner: { ...initial.runner, refilling: true, lastError: null, lastMessage: `Đang tải thêm ${label}…` } });
    let data;
    try {
      data = await fetchQueueSource(sourceType, translationType);
    } catch (error) {
      const latest = await jobStorage.get(["runner", "items"]);
      const sameRun = latest.runner?.workers ? latest.runner.sessionToken === runToken : latest.runner?.runToken === runToken;
      if (latest.runner?.active && sameRun) {
        const busy = latest.runner.workers && Object.values(latest.runner.workers).some((worker) => worker?.currentId);
        const nextRunner = { ...(latest.runner || {}), active: sourceType === "doctor" ? false : prefetch || Boolean(busy), currentId: busy ? latest.runner.currentId : null, refilling: false, lastError: error.message, lastMessage: `Tải lại ${label} thất bại` };
        if (prefetchDeadline > 0 && Number(nextRunner.nextJobAt) === prefetchDeadline) nextRunner.prefetchCompletedFor = prefetchDeadline;
        refreshRunnerSummary(nextRunner, latest.items || []);
        await jobStorage.set({ runner: nextRunner });
      }
      return { added: 0, skipped: 0, error: error.message };
    }
    const latest = await jobStorage.get(["items", "runner"]);
    const sameRun = latest.runner?.workers ? latest.runner.sessionToken === runToken : latest.runner?.runToken === runToken;
    if (!latest.runner?.active || !sameRun) {
      await jobStorage.set({ runner: { ...(latest.runner || {}), refilling: false } });
      return { added: 0, skipped: 0, stopped: true };
    }
    const merged = mergeQueueItems(latest.items || [], prefetch ? data.items?.slice(0, 1) : data.items, sourceType, translationType);
    const busy = latest.runner.workers && Object.values(latest.runner.workers).some((worker) => worker?.currentId);
    const nextRunner = {
      ...latest.runner,
      active: prefetch || merged.added > 0 || Boolean(busy),
      currentId: latest.runner.workers ? latest.runner.currentId : null,
      refilling: false,
      lastError: null,
      lastMessage: merged.added > 0 ? `Đã tải thêm ${merged.added} ${label}` : busy ? latest.runner.lastMessage : `Không còn ${label} mới`
    };
    if (prefetchDeadline > 0 && Number(nextRunner.nextJobAt) === prefetchDeadline) nextRunner.prefetchCompletedFor = prefetchDeadline;
    refreshRunnerSummary(nextRunner, merged.items);
    await jobStorage.set({ items: merged.items, runner: nextRunner });
    return merged;
  })();
  try { return await refillPromise; }
  finally { refillPromise = null; }
}

function itemOwnerTabId(item) {
  const tabId = Number(item?.ownerTabId || item?.workerTabId);
  return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
}

function queueItemIdentityKey(item) {
  const sourceType = queueItemSource(item);
  if (sourceType === "translation") return `translation-${normalizeTranslationType(item.type || item.translation_type)}-${item.source_id}`;
  const sourceId = sourceType === "handbook" ? item.handbook_id : sourceType === "toplist" ? item.toplist_id : sourceType === "doctor" ? item.doctor_id : item.facility_id;
  return sourceId == null ? String(item.id || "") : `${sourceType}-${sourceId}`;
}

function queueItemKey(item) {
  return `${itemOwnerTabId(item) ? `tab-${itemOwnerTabId(item)}:` : ""}${queueItemIdentityKey(item)}`;
}

function hasOtherTabJobInFlight(items, candidate, tabId) {
  const identity = queueItemIdentityKey(candidate);
  return items.some((item) => item.id !== candidate.id && itemOwnerTabId(item) !== Number(tabId) &&
    (!item.owner_tab_closed_at || jobHasUnconfirmedSave(item) || item.writer_claim_token || item.writer_claim_release_pending) && (
    queueItemIdentityKey(item) === identity && (["đang viết", "đang cập nhật", "chưa xác nhận", "lỗi cập nhật", "ảnh chưa đủ", "hoàn tất"].includes(item.status) || item.writer_claim_token || jobHasUnconfirmedSave(item)) ||
    (isFacilityImageFixItem(item) || isFacilityImageFixItem(candidate)) && writerClaimType(item) === "facility" && writerClaimType(candidate) === "facility" &&
      String(writerClaimRecordId(item)) === String(writerClaimRecordId(candidate)) &&
      (["đang viết", "đang cập nhật", "chưa xác nhận"].includes(item.status) || item.writer_claim_token || jobHasUnconfirmedSave(item))
  ));
}

function jobHasUnconfirmedSave(item) {
  return activeApiRequests.has(String(item.id)) || ["đang cập nhật", "chưa xác nhận"].includes(item.status) ||
    Boolean(item.image_fix_api_pending || item.image_fix_import_pending);
}

async function cleanupClosedTabJobs(tabId) {
  const claims = await withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const release = [];
    let changed = false;
    const legacyOwnedIds = new Set(Object.entries(runner?.workers || {})
      .filter(([key, worker]) => tabIdFromWorker(key, worker) === Number(tabId))
      .map(([, worker]) => worker.currentId).filter(Boolean));
    if (!runner?.workers && Number(runner?.targetTabId) === Number(tabId) && runner.currentId) legacyOwnedIds.add(runner.currentId);
    for (const item of items) {
      if (!itemOwnerTabId(item) && legacyOwnedIds.has(item.id)) item.ownerTabId = Number(tabId);
      if (itemOwnerTabId(item) !== Number(tabId)) continue;
      if (!item.owner_tab_closed_at) { item.owner_tab_closed_at = new Date().toISOString(); changed = true; }
      // Preserve JSON, history and save receipts. A dispatched POST can still
      // commit after its tab closes; neither requeue nor release it here.
      if (jobHasUnconfirmedSave(item)) continue;
      if (item.status === "đang viết") {
        item.status = "chờ";
        delete item.workerKey;
        delete item.workerTabId;
        delete item.provider;
        changed = true;
      }
      if (item.writer_claim_token) {
        item.writer_claim_release_pending = true; // stop orphan heartbeat first
        release.push({ ...item });
        changed = true;
      }
    }
    if (runner?.workers) {
      for (const [key, worker] of Object.entries(runner.workers)) {
        if (tabIdFromWorker(key, worker) === Number(tabId)) { delete runner.workers[key]; changed = true; }
      }
      if (changed) refreshRunnerSummary(runner, items);
    } else if (Number(runner?.targetTabId) === Number(tabId)) {
      runner.active = false;
      runner.currentId = null;
      runner.refilling = false;
      runner.runToken = createRunToken();
      changed = true;
    }
    if (changed) await jobStorage.set({ items, ...(runner ? { runner } : {}) });
    return release;
  });
  for (const item of claims) await releaseWriterClaim(item);
  return { ok: true, released: claims.length };
}

function reconcileClosedTabJobs() {
  if (closedTabRecoveryPromise) return closedTabRecoveryPromise;
  if (typeof chrome.tabs?.get !== "function") return Promise.resolve();
  closedTabRecoveryPromise = (async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const owners = new Set(items.filter((item) => !item.owner_tab_closed_at || item.writer_claim_token)
      .map(itemOwnerTabId).filter(Boolean));
    for (const [key, worker] of Object.entries(runner?.workers || {})) {
      const id = tabIdFromWorker(key, worker);
      if (id) owners.add(id);
    }
    if (!runner?.workers && Number(runner?.targetTabId) > 0) owners.add(Number(runner.targetTabId));
    for (const tabId of owners) {
      try { await chrome.tabs.get(tabId); }
      catch (error) {
        // A generic permissions/transport error is not proof that a tab closed.
        if (/^No tab(?: with id:?\s*\d+)?\.?$/i.test(String(error?.message || ""))) await cleanupClosedTabJobs(tabId);
      }
    }
  })().finally(() => { closedTabRecoveryPromise = null; });
  return closedTabRecoveryPromise;
}

function isWorkerQueueItemRunnable(items, item, scope) {
  return isQueueItemRunnable(item) && queueItemMatchesRunner(item, scope) && !hasOtherTabJobInFlight(items, item, scope.ownerTabId);
}

function queueItemSource(item) {
  if (isHandbookItem(item)) return "handbook";
  if (isFacilityImageFixItem(item)) return "facility_image_fix";
  if (isDoctorItem(item)) return "doctor";
  if (item?.sourceType === "translation") return "translation";
  if (item?.sourceType === "ai-image") return "ai-image";
  return isToplistItem(item) ? "toplist" : "facility";
}

function queueItemMatchesRunner(item, runner, fallbackSourceType) {
  // Untagged rows are migrated when first claimed/refreshed. An owned row
  // never migrates to a different tab, even after stopping its original tab.
  if (runner?.ownerTabId && itemOwnerTabId(item) && itemOwnerTabId(item) !== Number(runner.ownerTabId)) return false;
  const sourceType = normalizeSourceType(runner?.sourceType, fallbackSourceType || "facility");
  if (queueItemSource(item) !== sourceType) return false;
  if (sourceType === "translation") {
    return normalizeTranslationType(item.type || item.translation_type) === normalizeTranslationType(runner?.translationType);
  }
  return true;
}

function workerSourceScope(worker, runner, fallbackSourceType) {
  return {
    sourceType: normalizeSourceType(worker?.sourceType || runner?.sourceType, normalizeSourceType(fallbackSourceType)),
    translationType: normalizeTranslationType(worker?.translationType || runner?.translationType),
    ownerTabId: Number(worker?.targetTabId) || null
  };
}

async function clearStaleWorkerRefill(workerKey) {
  return withSchedulerLock(async () => {
    const { runner, items = [] } = await getJobMetadata(["runner", "items"]);
    const worker = runner?.workers?.[workerKey];
    if (!worker?.refilling || workerRefillPromises.has(workerKey)) return;
    worker.refilling = false;
    delete worker.refillToken;
    refreshRunnerSummary(runner, items);
    await jobStorage.set({ runner });
  });
}

async function refillWorkerQueue(workerKey, prefetch = false) {
  if (workerRefillPromises.has(workerKey)) return workerRefillPromises.get(workerKey);
  const operation = (async () => {
    const initial = await withSchedulerLock(async () => {
      const { runner, sourceType, translationType, items = [] } = await getJobMetadata(["runner", "sourceType", "translationType", "items"]);
      const worker = runner?.workers?.[workerKey];
      if (!runner?.active || !worker?.active || worker.currentId) return null;
      const scope = workerSourceScope(worker, runner, sourceType);
      if (scope.sourceType === "translation" && !worker.translationType && !runner.translationType) scope.translationType = normalizeTranslationType(translationType);
      const token = createRunToken();
      worker.refilling = true;
      worker.refillToken = token;
      worker.lastError = null;
      delete worker.waitReason;
      worker.lastMessage = `Đang tải thêm ${sourceLabel(scope.sourceType)}…`;
      refreshRunnerSummary(runner, items);
      await jobStorage.set({ runner });
      return { scope, token, prefetchDeadline: prefetch ? Number(worker.nextJobAt) : 0 };
    });
    if (!initial) return { added: 0, skipped: 0, stopped: true };
    const { scope, token, prefetchDeadline } = initial;
    let data, error;
    try { data = await fetchQueueSource(scope.sourceType, scope.translationType, scope.ownerTabId, { refill: true }); }
    catch (caught) { error = caught; }
    return withSchedulerLock(async () => {
      const { runner, items = [] } = await jobStorage.get(["runner", "items"]);
      const worker = runner?.workers?.[workerKey];
      // A stopped/restarted tab may have a new source while this request was
      // in flight. Its old response must not change the new worker or queue.
      if (!worker?.active || worker.refillToken !== token) return { added: 0, skipped: 0, stopped: true };
      worker.refilling = false;
      delete worker.refillToken;
      if (prefetchDeadline > 0 && Number(worker.nextJobAt) === prefetchDeadline) worker.prefetchCompletedFor = prefetchDeadline;
      if (error) {
        worker.lastError = error.message;
        worker.lastMessage = `Tải lại ${sourceLabel(scope.sourceType)} thất bại`;
        if (["doctor", "facility_image_fix"].includes(scope.sourceType)) { worker.active = false; delete worker.nextJobAt; }
        if (scope.sourceType === "doctor") worker.waitReason = "doctor-queue-error";
        refreshRunnerSummary(runner, items);
        await jobStorage.set({ runner });
        return { added: 0, skipped: 0, error: error.message };
      }
      const merged = mergeQueueItems(items, prefetch && !["doctor", "facility_image_fix"].includes(scope.sourceType) ? data.items?.slice(0, 1) : data.items, scope.sourceType, scope.translationType, scope.ownerTabId);
      worker.lastError = scope.sourceType === "facility_image_fix" && data.errors?.length
        ? data.errors.map((entry) => `ID ${entry.id}: ${entry.message}`).join(" · ").slice(0, 600) : null;
      worker.lastMessage = worker.lastError || (merged.added > 0 ? `Đã tải thêm ${merged.added} ${sourceLabel(scope.sourceType)}` : `Không còn ${sourceLabel(scope.sourceType)} mới`);
      refreshRunnerSummary(runner, merged.items);
      await jobStorage.set({ items: merged.items, runner, ...(scope.sourceType === "facility_image_fix" ? imageFixQueueState(data, scope.ownerTabId) : {}) });
      return merged;
    });
  })();
  workerRefillPromises.set(workerKey, operation);
  try { return await operation; }
  finally { if (workerRefillPromises.get(workerKey) === operation) workerRefillPromises.delete(workerKey); }
}

function isAiImageItem(queueItem) {
  return queueItem?.sourceType === "ai-image";
}

function isTranslationItem(queueItem) {
  return queueItem?.sourceType === "translation";
}

const PROMPT_METADATA_FIELDS = ["prompt_label", "prompt_source", "prompt_variant_id", "prompt_key_used", "category", "entity_type", "output_template", "receive_endpoint"];

function hasPromptMetadata(entry) {
  return PROMPT_METADATA_FIELDS.some((field) => Object.hasOwn(entry || {}, field));
}

function refreshQueuedPromptMetadata(item, entry) {
  // A queue row is the per-item prompt record.  Enrich legacy rows that were
  // created before category metadata was persisted, and refresh a waiting row
  // when the API returns a newer category variant.  Completed/error history
  // remains immutable and duplicate rows in one response never overwrite the
  // first item.
  if (!item || item.status !== "chờ" || !hasPromptMetadata(entry)) return;
  item.prompt = entry.prompt;
  for (const field of PROMPT_METADATA_FIELDS) {
    if (Object.hasOwn(entry, field)) item[field] = entry[field];
  }
}

function refreshQueuedTranslationData(item, entry) {
  if (!item || item.status !== "chờ") return;
  for (const field of ["prompt", "translation_fields", "output_template"]) {
    if (Object.hasOwn(entry || {}, field)) item[field] = entry[field];
  }
  // type/source_id are intentionally immutable after a job enters the queue.
}

function refreshWriterClaimMetadata(item, entry) {
  if (!item || item.status !== "chờ" || !Object.hasOwn(entry || {}, "writer_claimed")) return;
  const claimed = truthyApiFlag(entry.writer_claimed);
  if (claimed) {
    const publicWriter = (entry.writer_claim && typeof entry.writer_claim === "object") ? entry.writer_claim
      : (entry.writer && typeof entry.writer === "object") ? entry.writer : {
      provider: entry.writer_provider,
      model: entry.writer_model,
      instance_label: entry.writer_instance_label,
      account_label: entry.writer_account_label,
      worker_id: entry.writer_worker_id,
      task: entry.writer_task
      };
    item.writer_claimed = true;
    item.writer_claim = writerMetadata(publicWriter);
    item.writer_claim_conflict = true;
  } else {
    if (item.writer_claim_release_pending) return;
    item.writer_claimed = false;
    delete item.writer_claim;
    delete item.writer_claim_conflict;
  }
}

function mergeQueueItems(current, incoming, sourceType, translationType = "facility", ownerTabId = null) {
  sourceType = normalizeSourceType(sourceType);
  translationType = normalizeTranslationType(translationType);
  const items = [...(current || [])];
  const existing = new Map(items.map((item) => [queueItemKey(item), item]));
  const seenIncoming = new Set();
  let added = 0;
  let skipped = 0;
  for (const entry of Array.isArray(incoming) ? incoming : []) {
    const entrySourceId = sourceType === "translation" ? entry?.source_id : entry?.id;
    if (entrySourceId == null || String(entrySourceId).trim() === "" || typeof entry.prompt !== "string" || !entry.prompt.trim()) { skipped += 1; continue; }
    if (sourceType === "doctor" && (!isPositiveId(entry.id) || !doctorQueueEligible(entry))) { skipped += 1; continue; }
    if (sourceType === "handbook" && (!Number.isSafeInteger(entry.id) || entry.id <= 0 || !/^[a-f0-9]{64}$/.test(entry.source_revision || "") || !["vi", "en"].includes(entry.language) || entry.contract_version !== 1)) { skipped += 1; continue; }
    if (sourceType === "facility_image_fix" && (!isPositiveId(entry.id) || !validImageFixSource(entry))) { skipped += 1; continue; }
    if (sourceType === "translation") {
      try { translationAllowedFields(entry); }
      catch { skipped += 1; continue; }
    }
    const perItemTranslationType = sourceType === "translation"
      ? normalizeTranslationType(entry.type || entry.translation_type || translationType, translationType)
      : translationType;
    const identity = sourceType === "translation"
      ? `translation-${perItemTranslationType}-${entrySourceId}`
      : `${sourceType}-${entry.id}`;
    const id = ownerTabId ? `tab-${ownerTabId}:${identity}` : identity;
    // Adopt an unowned legacy row without renaming its content storage key.
    const previous = existing.get(id) || (ownerTabId ? existing.get(identity) : null);
    if (previous) {
      if (ownerTabId && !itemOwnerTabId(previous)) {
        previous.ownerTabId = Number(ownerTabId);
        existing.delete(identity);
        existing.set(id, previous);
      }
      if (!seenIncoming.has(id)) {
        if (sourceType === "translation") refreshQueuedTranslationData(previous, entry);
        else if (sourceType === "facility_image_fix" && previous.status === "chờ") copyImageFixSource(previous, entry);
        else if (sourceType === "handbook" && previous.status === "chờ" && !previous.writer_claim_token) {
          for (const key of ["prompt", "title", "language", "topic", "source_revision", "output_template", "contract_version"]) previous[key] = entry[key];
        } else if (sourceType === "doctor" && previous.status === "chờ") {
          previous.prompt = entry.prompt;
          previous.output_template = entry.output_template;
          previous.name = entry.name;
          previous.title = entry.name;
          refreshQueuedPromptMetadata(previous, entry);
        } else refreshQueuedPromptMetadata(previous, entry);
        refreshWriterClaimMetadata(previous, entry);
      }
      seenIncoming.add(id);
      continue;
    }
    const safeEntry = { ...entry };
    for (const key of ["writer_claim_token", "claim_token"]) delete safeEntry[key];
    const queueItem = {
      // Keep the API record intact.  The facilities endpoint selects a
      // category-specific prompt for every item; dropping these fields here
      // would make the queue lose prompt_source/prompt_variant_id/
      // prompt_key_used/category and the UI could no longer show which
      // variant was used.  Never replace entry.prompt with a shared prompt.
      ...safeEntry,
      id,
      ...(ownerTabId ? { ownerTabId: Number(ownerTabId) } : {}),
      sourceType,
      ...(sourceType === "translation"
        ? { type: perItemTranslationType, translation_type: perItemTranslationType, source_id: entrySourceId }
        : sourceType === "handbook" ? { handbook_id: entry.id } : sourceType === "toplist" ? { toplist_id: entry.id } : sourceType === "doctor" ? { doctor_id: Number(entry.id) } : { facility_id: entry.id }),
      title: sourceType === "translation"
        ? entry.title || entry.name || entry.source?.name || entry.source?.title || `Bản dịch ${perItemTranslationType} #${entrySourceId}`
        : sourceType === "toplist" ? entry.title || entry.name || "Toplist" : entry.name || entry.title || (sourceType === "doctor" ? "Bác sĩ" : "Cơ sở y tế"),
      prompt: entry.prompt,
      status: "chờ",
      created_at: new Date().toISOString()
    };
    refreshWriterClaimMetadata(queueItem, entry);
    items.push(queueItem);
    existing.set(id, items.at(-1));
    seenIncoming.add(id);
    added += 1;
  }
  return { items, added, skipped };
}

async function stopRun(request = {}, sender = {}) {
  const context = await resolveControlTab(request, sender);
  return stopWorkerByTabId(context.tabId, true);
}

async function stopWorkerByTabId(tabId, notifyTab = true) {
  const stopped = await withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const fixClaims = items.filter((item) => isFacilityImageFixItem(item) && itemOwnerTabId(item) === Number(tabId) && item.writer_claim_token &&
      !item.image_fix_api_pending && !item.image_fix_import_pending && !activeApiRequests.has(String(item.id))).map((item) => ({ ...item }));
    const entry = findWorkerForTab(runner, tabId);
    if (!entry) return { ok: true, alreadyStopped: true, tabId, fixClaims };
    const [workerKey, worker] = entry;
    const current = items.find((item) => item.id === worker?.currentId);
    let requeued = false;
    const ownsCurrent = current &&
      (!current.workerKey || current.workerKey === workerKey) &&
      (!current.workerTabId || Number(current.workerTabId) === Number(tabId));
    if (ownsCurrent && current.status === "đang viết") {
      current.status = "chờ";
      delete current.provider;
      delete current.workerKey;
      delete current.workerTabId;
      requeued = true;
    }
    delete runner.workers[workerKey];
    const activeWorkers = Object.values(runner.workers).filter((candidate) => candidate?.active);
    runner.active = activeWorkers.length > 0;
    runner.parallel = activeWorkers.length > 1;
    runner.provider = activeWorkers.length > 1 ? "multi-tab" : activeWorkers[0]?.provider || null;
    if (!runner.active) {
      runner.sessionToken = createRunToken();
      runner.refilling = false;
    }
    refreshRunnerSummary(runner, items);
    runner.lastMessage = runner.active
      ? `Đã dừng tab ${providerLabel(worker.provider)}; ${activeWorkers.length} tab khác vẫn chạy`
      : `Đã dừng ${providerLabel(worker.provider)} trên tab này`;
    await jobStorage.set({ items, runner });
    return {
      ok: true, tabId, provider: worker.provider, workerKey, fixClaims,
      articleId: ownsCurrent ? current.id : null, requeued, stillActive: runner.active,
      // An already-dispatched save can still commit after the user stops.
      // Retain its lease/receipt check; Stop prevents only subsequent AI jobs.
      claimItem: ownsCurrent && current?.writer_claim_token && !(isDoctorItem(current) &&
        ["đang cập nhật", "chưa xác nhận"].includes(current.status)) && !(isFacilityImageFixItem(current) &&
          (current.image_fix_api_pending || current.image_fix_import_pending || activeApiRequests.has(String(current.id)))) ? { ...current } : null
    };
  });
  const releasing = new Map([...(stopped.claimItem ? [stopped.claimItem] : []), ...(stopped.fixClaims || [])].map((item) => [item.id, item]));
  for (const item of releasing.values()) await releaseWriterClaim(item);
  if (stopped.fixClaims?.length) await withSchedulerLock(async () => {
    const { items = [] } = await getJobMetadata("items");
    for (const previous of stopped.fixClaims) {
      const current = items.find((item) => item.id === previous.id);
      if (current && current.has_result && !current.image_fix_api_pending && !current.image_fix_import_pending && current.status !== "hoàn tất") {
        current.image_fix_requires_research = true; current.image_fix_error_code = current.api_error_code = "lease_lost";
      }
    }
    await jobStorage.set({ items });
  });
  if (notifyTab && stopped.requeued && stopped.articleId) {
    await chrome.tabs.sendMessage(Number(tabId), { type: "stop-article", articleId: stopped.articleId }).catch(() => {});
  }
  if (stopped.requeued && stopped.stillActive) await runNext();
  const { claimItem, fixClaims, ...publicStopped } = stopped;
  return publicStopped;
}

async function stopWorkerIfProviderChanged(tabId, tab) {
  const { runner } = await jobStorage.get("runner");
  const entry = findWorkerForTab(runner, tabId);
  if (!entry?.[1]?.active) return;
  if (tabMatchesWorker(tab, entry[1])) return;
  await stopWorkerByTabId(tabId, false);
}

function tabMatchesProvider(tab, provider) {
  if (!tab?.url) return false;
  try {
    const hostname = new URL(tab.url).hostname;
    if (provider === "chatgpt") return hostname === "chatgpt.com" || hostname.endsWith(".openai.com");
    if (provider === "grok") return hostname === "grok.com" || hostname === "x.com" || hostname.endsWith(".x.com");
    if (provider === "claude") return hostname === "claude.ai" || hostname.endsWith(".claude.ai");
    if (provider === "gemini") return hostname === "gemini.google.com" || hostname.endsWith(".gemini.google.com");
    return false;
  } catch { return false; }
}

async function findProviderTab(provider) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabMatchesProvider(active, provider)) return active;
  const host = PROVIDER_CONFIG[provider]?.host;
  if (!host) return null;
  const tabs = (await chrome.tabs.query({ url: `*://${host}/*` })).filter((tab) => tabMatchesProvider(tab, provider));
  return tabs.sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
}

async function detectProvider() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const hostname = active?.url ? new URL(active.url).hostname : "";
  if (hostname === "chatgpt.com" || hostname.endsWith(".openai.com")) return "chatgpt";
  if (hostname === "grok.com" || hostname === "x.com" || hostname.endsWith(".x.com")) return "grok";
  if (hostname === "claude.ai" || hostname.endsWith(".claude.ai")) return "claude";
  if (hostname === "gemini.google.com" || hostname.endsWith(".gemini.google.com")) return "gemini";
  const [chatgpt] = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  if (chatgpt) return "chatgpt";
  const [grok] = await chrome.tabs.query({ url: "https://grok.com/*" });
  if (grok) return "grok";
  const [claude] = await chrome.tabs.query({ url: "https://claude.ai/*" });
  if (claude) return "claude";
  const [gemini] = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  if (gemini) return "gemini";
  throw new Error("Hãy mở ChatGPT, Grok, Claude hoặc Gemini trước.");
}

async function getCurrentArticle(provider, sender) {
  const { items = [], runner } = await getJobMetadata(["items", "runner"]);
  if (runner?.workers) {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(Number(tabId)) || Number(tabId) <= 0) return { ok: true, article: null };
    if (sender?.tab?.url && !tabMatchesProvider(sender.tab, provider)) return { ok: true, article: null };
    const entry = findWorkerForTab(runner, tabId, provider);
    const worker = entry?.[1];
    if (!runner.active || !worker?.active || !worker.currentId) return { ok: true, article: null };
    if (Number(worker.targetTabId) !== Number(tabId)) return { ok: true, article: null };
    const workerProvider = worker.provider || (PROVIDER_CONFIG[entry[0]] ? entry[0] : null);
    if (workerProvider !== provider) return { ok: true, article: null };
    if (sender?.tab?.url && !tabMatchesWorker(sender.tab, worker)) return { ok: true, article: null };
    const item = items.find((candidate) => candidate.id === worker.currentId && candidate.status === "đang viết" &&
      (!candidate.workerTabId || Number(candidate.workerTabId) === Number(tabId)) &&
      (!candidate.provider || candidate.provider === provider));
    const sparkTaskId = worker.sparkTaskId || (provider === "gemini" ? geminiSparkTaskIdFromTab(sender?.tab) : null);
    return { ok: true, article: item ? contentSafeArticle({ ...await hydrateArticle(item), runToken: worker.runToken, ...(sparkTaskId ? { sparkTaskId } : {}) }) : null };
  }
  if (!runner?.active || !runner.currentId) return { ok: true, article: null };
  if (runner.targetProvider && runner.targetProvider !== provider) return { ok: true, article: null };
  if (runner.targetTabId && sender?.tab?.id !== runner.targetTabId) return { ok: true, article: null };
  if (provider === "gemini" && runner.sparkTaskId && sender?.tab?.url && isGeminiSparkTab(sender.tab)
      && geminiSparkTaskIdFromTab(sender.tab) !== runner.sparkTaskId) return { ok: true, article: null };
  // Old saved runs have no targetTabId. Claim the most recently used matching
  // AI tab so background AI tabs can recover after an extension reload while
  // duplicate conversation tabs still cannot submit the same JSON twice.
  if (!runner.targetTabId) {
    const preferred = await findProviderTab(provider);
    if (!preferred?.id || sender?.tab?.id !== preferred.id) return { ok: true, article: null };
    if (provider === "gemini" && runner.sparkTaskId && isGeminiSparkTab(preferred) && geminiSparkTaskIdFromTab(preferred) !== runner.sparkTaskId) return { ok: true, article: null };
    await jobStorage.set({ runner: { ...runner, targetProvider: provider, targetTabId: preferred.id, ...(provider === "gemini" && isGeminiSparkTab(preferred) ? { sparkTaskId: geminiSparkTaskIdFromTab(preferred) } : {}) } });
  }
  const item = items.find((entry) => entry.id === runner.currentId && entry.status === "đang viết");
  return { ok: true, article: item ? contentSafeArticle({ ...await hydrateArticle(item), runToken: runner.runToken, ...(runner.sparkTaskId ? { sparkTaskId: runner.sparkTaskId } : {}) }) : null };
}

function contentSafeArticle(article) {
  const safe = { ...article };
  for (const key of [
    "writer_claim_token", "writer_claim_request_id", "writer_claim_expires_at", "writer_claim_id",
    "writer_claim_type", "writer_claim_release_pending", "writer_claim_release_error",
    "writer_claim_heartbeat_error", "writer_claim_required", "doctor_writer_request_id", "doctor_heartbeat_halt", "writer_claim_worker_id", "claim_token", "ai_writer_claim_json", "full_json", "image_fix_payload", "image_fix_previous_result"
  ]) delete safe[key];
  if (isHandbookItem(article)) {
    for (const key of ["source_revision", "result", "rawResponse", "output_template", "receive_endpoint", "claim_endpoint"]) delete safe[key];
  }
  return safe;
}

function workerReleasedError(message = "Tab này đã dừng; bài được trả lại hàng đợi.") {
  const error = new Error(message);
  error.workerReleased = true;
  return error;
}

async function canDispatchWorkerJob(workerKey, articleId, runToken, tabId, provider) {
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const worker = runner?.workers?.[workerKey];
    const item = items.find((candidate) => candidate.id === articleId);
    return Boolean(
      runner?.active && worker?.active &&
      Number(worker.targetTabId) === Number(tabId) && worker.provider === provider &&
      worker.currentId === articleId && worker.runToken === runToken &&
      item?.status === "đang viết" &&
      (!item.workerKey || item.workerKey === workerKey) &&
      (!item.workerTabId || Number(item.workerTabId) === Number(tabId))
    );
  });
}

async function startJob(article, prompt, workerKeyOrProvider, runToken) {
  const startupTiming = { startedAt: Date.now() };
  const initial = await jobStorage.get("runner");
  const initialWorker = initial.runner?.workers?.[workerKeyOrProvider];
  const provider = initialWorker?.provider || (PROVIDER_CONFIG[workerKeyOrProvider] ? workerKeyOrProvider : null);
  const host = PROVIDER_CONFIG[provider]?.host || "trang AI";
  let tab = initialWorker?.targetTabId ? { id: initialWorker.targetTabId } : await findProviderTab(provider);
  if (!tab?.id) throw new Error(`Hãy mở và đăng nhập ${host} trước.`);
  if (initialWorker && typeof chrome.tabs.get === "function") {
    try { tab = await chrome.tabs.get(tab.id); }
    catch {
      await stopWorkerByTabId(initialWorker.targetTabId, false);
      throw workerReleasedError("Tab AI đã đóng; bài được trả lại hàng đợi.");
    }
    if (!tabMatchesWorker(tab, initialWorker)) {
      await stopWorkerByTabId(initialWorker.targetTabId, false);
      throw workerReleasedError(provider === "gemini"
        ? "Tab đã chuyển sang task Gemini Spark khác; bài được trả lại hàng đợi."
        : "Tab đã chuyển khỏi trang AI; bài được trả lại hàng đợi.");
    }
  }
  const workerMode = Boolean(initialWorker);
  const canSend = workerMode
    ? await canDispatchWorkerJob(workerKeyOrProvider, article.id, runToken, tab.id, provider)
    : Boolean(initial.runner?.active && initial.runner.currentId === article.id &&
        (!initial.runner.runToken || initial.runner.runToken === runToken));
  if (!canSend) throw workerReleasedError();
  const notify = (phase, detail) => recordSystemNotice({ articleId: article.id, runToken, phase, detail }, { tab }).catch(() => {});
  await notify("connecting", "Đang kiểm tra kết nối với tab AI và chuẩn bị bộ điều khiển nhập prompt.");
  // Make sure the receiving end is ready before taking a server lease. This
  // keeps the claim immediately adjacent to the actual prompt dispatch and
  // avoids consuming a lease merely to inject the content script.
  const readyStartedAt = Date.now();
  let receiverReady = false;
  try {
    receiverReady = (await chrome.tabs.sendMessage(tab.id, { type: "runner-ready" }))?.ready === true;
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(error.message))) throw error;
  }
  if (!receiverReady && typeof chrome.scripting?.executeScript === "function") {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: isHandbookItem(article) ? ["handbook.js", "content.js"] : ["content.js"] });
  }
  startupTiming.receiverReadyMs = Date.now() - readyStartedAt;
  startupTiming.scriptInjected = !receiverReady;
  await notify("claiming", "Đang xin quyền xử lý bài từ website. Chỉ nhập và gửi prompt sau khi website xác nhận quyền xử lý.");
  if (isDoctorItem(article)) {
    await revalidateDoctorJob(article);
    prompt = article.prompt;
  }
  const claimStartedAt = Date.now();
  const lease = await claimWriterLease(article, {
    provider, workerKey: workerMode ? workerKeyOrProvider : `tab-${tab.id}`, runToken, tab
  });
  startupTiming.writerClaimMs = Date.now() - claimStartedAt;
  if (!lease.claimed) {
    const error = new Error(`Bài đang được viết bởi ${writerClaimDisplay({ writer_claim: lease.writer })}.`);
    error.writerClaimConflict = true;
    error.writer = lease.writer;
    error.writerClaimReason = lease.reason;
    throw error;
  }
  if (isFacilityImageFixItem(article)) {
    await revalidateFacilityImageFixJob(article);
    prompt = article.prompt;
  }
  const stillCurrent = workerMode
    ? await canDispatchWorkerJob(workerKeyOrProvider, article.id, runToken, tab.id, provider)
    : Boolean((await jobStorage.get("runner")).runner?.currentId === article.id);
  if (!stillCurrent) {
    await releaseWriterClaim(article);
    throw workerReleasedError("Bài đã được dừng trong lúc xin khóa; đã không gửi prompt AI.");
  }
  await notify("preparing", `Đã nhận quyền xử lý. Đang chuyển prompt (${String(prompt || "").length.toLocaleString("vi-VN")} ký tự) sang tab AI.`);
  if (article.prompt_scheduled_at) {
    await withSchedulerLock(async () => {
      const { items = [], runner } = await jobStorage.get(["items", "runner"]);
      const current = items.find((item) => item.id === article.id);
      if (!current || !currentJobStillOwned(runner, current, workerKeyOrProvider, runToken, tab.id)) throw workerReleasedError();
      current.prompt_dispatch_ready = true;
      article.prompt_dispatch_ready = true;
      await jobStorage.set({ items });
    });
  }
  const message = {
    type: isAiImageItem(article) ? "run-ai-image" : "run-article",
    article: contentSafeArticle({
      ...article, runToken,
      ...((initialWorker?.sparkTaskId || (provider === "gemini" && geminiSparkTaskIdFromTab(tab)))
        ? { sparkTaskId: initialWorker?.sparkTaskId || geminiSparkTaskIdFromTab(tab) } : {})
    }),
    prompt,
    startupTiming: { ...startupTiming, dispatchAt: Date.now() }
  };
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response) throw new Error("Tab AI không trả về kết quả.");
    return response;
  } catch (error) {
    // Chat tab was already open before the extension was installed/reloaded.
    if (!String(error.message).includes("Receiving end does not exist")) throw error;
    if (workerMode && !await canDispatchWorkerJob(workerKeyOrProvider, article.id, runToken, tab.id, provider)) {
      throw workerReleasedError();
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: isHandbookItem(article) ? ["handbook.js", "content.js"] : ["content.js"] });
    if (workerMode && !await canDispatchWorkerJob(workerKeyOrProvider, article.id, runToken, tab.id, provider)) {
      throw workerReleasedError();
    }
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response) throw new Error("Không nhận được phản hồi sau khi nạp lại script vào tab AI.");
    return response;
  }
}

async function stageArticleResult(articleId, article, rawResponse, expectedJob = null) {
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const workerKey = expectedJob
      ? currentJobKeyFromState(runner, items, articleId, expectedJob.runToken, expectedJob.sender)
      : null;
    if (expectedJob && !workerKey) return { accepted: false };
    const item = items.find((entry) => entry.id === articleId);
    if (!item) throw new Error("Không tìm thấy bài viết trong hàng đợi.");
    const aiImageUrl = isAiImageItem(item) ? aiImageUrlFromResult(article) : "";
    // A provider URL is intentionally never persisted as an image result.
    // The content script must first finish its multipart upload and send back
    // only the website-owned /uploads/library path.
    if (aiImageUrl && !isLocalAiImageUrl(aiImageUrl)) {
      throw new Error("Ảnh AI chưa được website lưu thành file nội bộ; không dùng URL tạm từ ChatGPT/Grok.");
    }
    item.result = article;
    if (isDoctorItem(item)) item.insufficient_data = article?.insufficient_data === true;
    item.rawResponse = rawResponse;
    item.error = null;
    delete item.gemini_spark_dispatch_retry_at;
    delete item.gemini_spark_json_retry_at;
    delete item.gemini_spark_json_retry_count;
    markApiRequestStarted(item);
    if (isAiImageItem(item)) {
      if (aiImageUrl) {
        item.aiImageUrl = aiImageUrl;
        item.imageUrl = aiImageUrl;
      }
    }
    await jobStorage.set({ items });
    return { accepted: true, workerKey, queueItem: await hydrateArticle(item) };
  });
}

async function publishStagedJob(articleId, queueItem, article) {
  if (isFacilityImageFixItem(queueItem)) return publishFacilityImageFix(articleId, queueItem, article);
  const requestKey = String(articleId);
  if (activeApiRequests.has(requestKey)) {
    return { ok: false, updated: false, error: "Yêu cầu gửi API cho bài này đang chạy." };
  }
  activeApiRequests.add(requestKey);
  let status = "hoàn tất";
  let apiUpdate = null;
  let apiError = null;
  let doctorError = null;
  try {
    try {
      apiUpdate = isAiImageItem(queueItem)
        ? await updateFacilityAiImage(queueItem, article)
        : isTranslationItem(queueItem)
          ? await updateTranslation(queueItem, article)
          : await updateFacilityContent(queueItem, article);
    } catch (error) {
      // Keep the AI result even if the website API is temporarily unavailable.
      status = isDoctorItem(queueItem) && error.doctorUnconfirmed ? "chưa xác nhận" : "lỗi cập nhật";
      apiError = error.message;
      if (isDoctorItem(queueItem)) doctorError = error;
    }
    await withSchedulerLock(async () => {
      const { items = [] } = await getJobMetadata("items");
      const item = items.find((entry) => entry.id === articleId);
      if (!item) return;
      // Receipt recovery can finish the same save while its original POST is
      // still pending. A late rejection must never overwrite that success.
      if (isDoctorItem(item) && item.status === "hoàn tất") {
        status = "hoàn tất";
        apiUpdate = item.api_update;
        apiError = null;
        return;
      }
      finalizeApiRequest(item, status, apiUpdate, apiError);
      await jobStorage.set({ items });
    });
    if (status === "hoàn tất") await clearWriterClaimAfterSave(queueItem);
    else if (status !== "chưa xác nhận") await releaseWriterClaim(queueItem);
    if (doctorError?.doctorLeaseLost && status !== "hoàn tất") await retainDoctorLeaseLoss(articleId);
    if (doctorError && [401, 403, 503].includes(doctorError.httpStatus) && status !== "hoàn tất") {
      await pauseDoctorWorker(articleId, doctorError, queueItem.workerKey);
    }
    return { ok: true, updated: status === "hoàn tất", ...(status === "chưa xác nhận" ? { unconfirmed: true } : {}) };
  } finally {
    activeApiRequests.delete(requestKey);
    await pruneCompletedHistory();
  }
}

async function finishJob(articleId, article, rawResponse) {
  const staged = await stageArticleResult(articleId, article, rawResponse);
  return publishStagedJob(articleId, staged.queueItem, article);
}

function currentJobKeyFromState(runner, items, articleId, runToken, sender = {}, { allowExpiredLease = false } = {}) {
  const ownsLease = (item) => writerLeaseIsCurrent(item) || allowExpiredLease && (isFacilityImageFixItem(item) || isHandbookItem(item)) &&
    item.writer_claim_required && item.writer_claim_token && !item.writer_claim_lost;
  if (!runner?.active) return null;
  if (runner.workers) {
    const senderTabId = sender?.tab?.id;
    if (!Number.isInteger(Number(senderTabId)) || Number(senderTabId) <= 0) return null;
    const entry = findWorkerForTab(runner, senderTabId);
    const workerKey = entry?.[0];
    const worker = entry?.[1];
    if (!worker?.active || Number(worker.targetTabId) !== Number(senderTabId)) return null;
    if (sender?.tab?.url && !tabMatchesWorker(sender.tab, worker)) return null;
    if (worker.currentId !== articleId || (worker.runToken && worker.runToken !== runToken)) return null;
    const item = items.find((candidate) => candidate.id === articleId);
    if (item?.status !== "đang viết") return null;
    if (!ownsLease(item)) return null;
    if (item.workerKey && item.workerKey !== workerKey) return null;
    if (item.workerTabId && Number(item.workerTabId) !== Number(senderTabId)) return null;
    return workerKey;
  }
  if (runner.currentId !== articleId) return null;
  if (runner.runToken && runner.runToken !== runToken) return null;
  if (runner.targetTabId && Number(sender?.tab?.id) !== Number(runner.targetTabId)) return null;
  if (runner.targetProvider && sender?.tab?.url && !tabMatchesProvider(sender.tab, runner.targetProvider)) return null;
  if (runner.targetProvider === "gemini" && runner.sparkTaskId && sender?.tab?.url && isGeminiSparkTab(sender.tab)
      && geminiSparkTaskIdFromTab(sender.tab) !== runner.sparkTaskId) return null;
  const item = items.find((entry) => entry.id === articleId && entry.status === "đang viết");
  if (item && !ownsLease(item)) return null;
  return "legacy";
}

function writerLeaseIsCurrent(item) {
  if (!item?.writer_claim_required) return true;
  if (!item.writer_claim_token || item.writer_claim_lost) return false;
  const expiry = Date.parse(item.writer_claim_expires_at || "");
  return !Number.isFinite(expiry) || expiry > Date.now();
}

async function validateWriterLeaseForCompletion(articleId, { strict = false } = {}) {
  const { items = [] } = await getJobMetadata("items");
  const item = items.find((entry) => String(entry.id) === String(articleId));
  if (!item?.writer_claim_required) return true;
  if (!item.writer_claim_token || item.writer_claim_lost) return false;
  let result;
  try {
    result = await requestWriterClaim("heartbeat", item, {
      type: item.writer_claim_type || writerClaimType(item),
      id: item.writer_claim_id ?? writerClaimRecordId(item),
      claimToken: item.writer_claim_token
    });
  } catch (error) {
    if (isDoctorItem(item) && [401, 403, 503].includes(error.httpStatus)) {
      await haltDoctorForFatalHeartbeat(item, error);
      throw error;
    }
    // The update endpoint validates the same token atomically. If the heartbeat
    // endpoint has a transient network error, let that final validation decide.
    if (strict || isFacilityImageFixItem(item) && !writerLeaseIsCurrent(item)) throw error;
    return true;
  }
  if (result.leaseLost) {
    await loseWriterClaim(item.id, item.writer_claim_token, result.writer);
    return false;
  }
  const expiry = writerLeaseExpiry(result.response);
  return withSchedulerLock(async () => {
    const { items: latest = [] } = await getJobMetadata("items");
    const current = latest.find((entry) => String(entry.id) === String(articleId));
    if (current?.writer_claim_token === item.writer_claim_token) {
      current.writer_claim_expires_at = expiry;
      current.writer_claim_heartbeat_at = new Date().toISOString();
      delete current.writer_claim_heartbeat_error;
      if (isDoctorItem(current)) delete current.doctor_heartbeat_halt;
      await jobStorage.set({ items: latest });
      return true;
    }
    return false;
  });
}

async function recordSystemNotice(message = {}, sender = {}) {
  if (!SYSTEM_PHASES.has(message.phase) || !message.runToken || !sender?.tab?.id) return { ok: false, ignored: true };
  return withSchedulerLock(async () => {
    const { items = [], runner, systemNotices = {} } = await getJobMetadata(["items", "runner", "systemNotices"]);
    const entry = runner?.workers ? findWorkerForTab(runner, sender.tab.id) : ["legacy", runner];
    const key = entry?.[0];
    const worker = entry?.[1];
    const item = items.find((item) => item.id === message.articleId);
    if (!key || !item || !worker || !currentJobStillOwned(runner, item, key, message.runToken, sender.tab.id) ||
        (sender.tab.url && !tabMatchesWorker(sender.tab, { ...worker, provider: worker.provider || worker.targetProvider })) || item.writer_claim_lost) return { ok: false, ignored: true };
    const detail = String(message.detail || "").slice(0, 600);
    const previous = systemNotices[key];
    if (previous?.articleId === item.id && previous.runToken === message.runToken && previous.phase === message.phase && previous.detail === detail) return { ok: true };
    const notice = { articleId: item.id, runToken: message.runToken, title: String(item.title || item.name || item.id).slice(0, 180), phase: message.phase, detail, at: Date.now() };
    systemNotices[key] = { ...notice, history: [notice, ...(previous?.history || [])].slice(0, 12) };
    // Keep a small metadata-only journal; never copy prompts or JSON into it.
    const bounded = Object.fromEntries(Object.entries(systemNotices).sort((a, b) => b[1].at - a[1].at).slice(0, 32));
    await jobStorage.set({ systemNotices: bounded });
    return { ok: true };
  });
}

async function recordArticlePromptPrepared(message = {}, sender = {}) {
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const workerKey = currentJobKeyFromState(runner, items, message.articleId, message.runToken, sender);
    const item = items.find((entry) => entry.id === message.articleId);
    if (!workerKey || !item?.prompt_dispatch_ready || !item.prompt_scheduled_at) return { ok: false, ignored: true };
    item.prompt_prepared_at = new Date().toISOString();
    await jobStorage.set({ items });
    return { ok: true };
  });
}

async function recordArticlePromptSent(message = {}, sender = {}) {
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const workerKey = currentJobKeyFromState(runner, items, message.articleId, message.runToken, sender);
    const item = items.find((entry) => entry.id === message.articleId);
    if (!workerKey || !item) return { ok: false, ignored: true };
    item.prompt_sent_at = new Date().toISOString();
    item.last_progress_at = item.prompt_sent_at;
    delete item.prompt_scheduled_at;
    delete item.prompt_dispatch_ready;
    delete item.gemini_spark_reload_attempted_at;
    delete item.gemini_spark_reload_source;
    delete item.gemini_spark_reload_error;
    await jobStorage.set({ items });
    return { ok: true };
  });
}

async function recordArticleProgress(message = {}, sender = {}) {
  if (message.articleId == null || !message.runToken || !sender?.tab?.id) return { ok: false, ignored: true };
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const workerKey = currentJobKeyFromState(runner, items, message.articleId, message.runToken, sender);
    const item = items.find((entry) => String(entry.id) === String(message.articleId));
    if (!workerKey || item?.status !== "đang viết") return { ok: false, ignored: true };
    const reportedAt = Date.parse(message.progressAt || "");
    const previousAt = Date.parse(item.last_progress_at || "");
    if (Number.isFinite(reportedAt) && (!Number.isFinite(previousAt) || reportedAt > previousAt)) {
      item.last_progress_at = new Date(reportedAt).toISOString();
      await jobStorage.set({ items });
    }
    return { ok: true };
  });
}

async function markGeminiSparkStallReload(message = {}, sender = {}, now = Date.now()) {
  if (message.articleId == null || !message.runToken || !sender?.tab?.id || !isGeminiSparkTab(sender.tab)) {
    return { ok: false, ignored: true };
  }
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const workerKey = currentJobKeyFromState(runner, items, message.articleId, message.runToken, sender);
    const item = items.find((entry) => String(entry.id) === String(message.articleId));
    const worker = workerKey && workerKey !== "legacy" ? runner?.workers?.[workerKey] : null;
    const provider = worker?.provider || runner?.targetProvider || runner?.provider;
    if (!workerKey || provider !== "gemini" || item?.status !== "đang viết") return { ok: false, ignored: true };
    const previousReloadAt = Date.parse(item.gemini_spark_reload_attempted_at || "");
    const promptSentAt = Date.parse(item.prompt_sent_at || "");
    if (Number.isFinite(promptSentAt) && now - promptSentAt < GEMINI_SPARK_RELOAD_INTERVAL_MS) {
      return { ok: true, reload: false, coolingDown: true };
    }
    if (Number.isFinite(previousReloadAt) && now - previousReloadAt < GEMINI_SPARK_RELOAD_COOLDOWN_MS) {
      return {
        ok: true, reload: false,
        source: item.gemini_spark_reload_source || "background",
        coolingDown: true
      };
    }
    const source = message.reloadSource === "content" ? "content" : "background";
    item.gemini_spark_reload_attempted_at = new Date(now).toISOString();
    item.gemini_spark_reload_source = source;
    item.gemini_spark_reload_count = (Number(item.gemini_spark_reload_count) || 0) + 1;
    delete item.gemini_spark_reload_error;
    if (runner) runner.lastMessage = "Gemini Spark đã chạy 10 phút · đang tải lại để kiểm tra kết quả";
    await jobStorage.set({ items, ...(runner ? { runner } : {}) });
    return { ok: true, reload: true, source };
  });
}

async function checkGeminiSparkStalls(now = Date.now()) {
  await resumeIdleSparkWorkers();
  if (typeof chrome.tabs?.get !== "function" || typeof chrome.tabs?.reload !== "function") return { ok: true, reloaded: 0 };
  const { items = [], runner } = await getJobMetadata(["items", "runner"]);
  const workers = runner?.workers
    ? Object.entries(runner.workers).filter(([, worker]) => worker?.active && worker.provider === "gemini" && worker.currentId)
    : runner?.active && runner.currentId && (runner.targetProvider || runner.provider) === "gemini"
      ? [["legacy", { active: true, provider: "gemini", targetTabId: runner.targetTabId, currentId: runner.currentId, runToken: runner.runToken, sparkTaskId: runner.sparkTaskId }]]
      : [];
  let reloaded = 0;
  for (const [workerKey, worker] of workers) {
    const item = items.find((entry) => String(entry.id) === String(worker.currentId));
    if (item?.status !== "đang viết") continue;
    if (!item.prompt_sent_at && Date.parse(item.prompt_scheduled_at || "") > now) continue;
    if (item.gemini_spark_dispatch_retry_at) {
      await dispatchSparkJobRetry(workerKey, now);
      continue;
    }
    const previousReloadAt = Date.parse(item.gemini_spark_reload_attempted_at || "");
    if (Number.isFinite(previousReloadAt) && now - previousReloadAt < GEMINI_SPARK_RELOAD_COOLDOWN_MS) continue;
    const progressAt = Date.parse(item.gemini_spark_reload_attempted_at || item.prompt_sent_at || item.last_progress_at || item.write_started_at || "");
    if (!Number.isFinite(progressAt) || now - progressAt < GEMINI_SPARK_RELOAD_INTERVAL_MS) continue;
    const tabId = Number(worker.targetTabId || (workerKey === "legacy" ? runner.targetTabId : 0));
    if (!Number.isInteger(tabId) || tabId <= 0) continue;
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { continue; }
    if (!isGeminiSparkTab(tab) || !tabMatchesWorker(tab, worker)) continue;
    const marked = await markGeminiSparkStallReload({
      articleId: item.id, runToken: worker.runToken, reloadSource: "background"
    }, { tab }, now);
    // A content-script watchdog may have won the race and is about to reload
    // this same tab. Only the alarm that acquires the marker performs tabs.reload.
    if (!marked?.ok || marked.reload !== true) continue;
    try {
      await chrome.tabs.reload(tabId);
      reloaded += 1;
    } catch (error) {
      await withSchedulerLock(async () => {
        const latest = await getJobMetadata(["items", "runner"]);
        const current = latest.items?.find((entry) => String(entry.id) === String(item.id));
        if (current?.gemini_spark_reload_source !== "background") return;
        delete current.gemini_spark_reload_attempted_at;
        delete current.gemini_spark_reload_source;
        current.gemini_spark_reload_error = error?.message || "Chrome không tải lại được tab Gemini Spark.";
        current.last_progress_at = new Date(now).toISOString();
        await jobStorage.set({ items: latest.items });
      });
    }
  }
  return { ok: true, reloaded };
}

async function currentJobProvider(articleId, runToken, senderTabId) {
  const { runner, items = [] } = await getJobMetadata(["runner", "items"]);
  return currentJobKeyFromState(runner, items, articleId, runToken,
    senderTabId == null ? {} : { tab: { id: senderTabId } });
}

async function recordArticleRetryCountdown(message, sender = {}) {
  const workerKey = await currentJobProvider(message.articleId, message.runToken, sender?.tab?.id);
  if (!workerKey) return { ok: false, ignored: true };
  return withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    if (!currentJobKeyFromState(runner, items, message.articleId, message.runToken,
      sender?.tab?.id == null ? {} : { tab: { id: sender.tab.id } })) {
      return { ok: false, ignored: true };
    }
    const item = items.find((entry) => String(entry.id) === String(message.articleId));
    if (!item || item.status !== "đang viết") return { ok: false, ignored: true };
    if (message.clear) {
      delete item.gemini_spark_json_retry_at;
      delete item.gemini_spark_json_retry_count;
    } else {
      const retryAt = Number(message.retryAt);
      if (!Number.isFinite(retryAt)) return { ok: false, error: "Thời điểm thử lại không hợp lệ." };
      item.gemini_spark_json_retry_at = new Date(retryAt).toISOString();
      item.gemini_spark_json_retry_count = Math.max(1, Number(message.retryCount) || 1);
    }
    await jobStorage.set({ items, runner });
    return { ok: true };
  });
}

async function isCurrentJob(articleId, runToken, senderTabId) {
  return Boolean(await currentJobProvider(articleId, runToken, senderTabId));
}

async function handleArticleComplete(message, sender = {}) {
  const completedResult = completionResult(message);
  const metadata = (await getJobMetadata("items")).items?.find((item) => item.id === message.articleId);
  if (isHandbookItem(metadata)) return completeHandbook(message, sender, completedResult);
  const haltedCompletion = await preserveHaltedDoctorCompletion(message, sender, completedResult);
  if (haltedCompletion) return haltedCompletion;
  let leaseValid;
  try { leaseValid = await validateWriterLeaseForCompletion(message.articleId); }
  catch (error) {
    if (error.doctorHeartbeatFatal) {
      return await preserveHaltedDoctorCompletion(message, sender, completedResult) ||
        { ok: false, updated: false, paused: true, error: error.message };
    }
    if (!error.retryableWriterClaim) throw error;
    // Keep completed JSON locally on a transient renewal failure. Ownership is
    // checked by tab/run/token, but this path never submits or obtains a claim.
    const deferred = await withSchedulerLock(async () => {
      const { items = [], runner } = await getJobMetadata(["items", "runner"]);
      const item = items.find((row) => row.id === message.articleId);
      const workerKey = currentJobKeyFromState(runner, items, message.articleId, message.runToken, sender, { allowExpiredLease: true });
      if (!isFacilityImageFixItem(item) || !workerKey) return null;
      item.result = completedResult;
      item.rawResponse = message.rawResponse;
      item.status = "lỗi cập nhật";
      item.api_error = "Chưa gia hạn được khóa do lỗi kết nối. JSON đã giữ; bấm Gửi lại để xác nhận khóa trước khi gửi.";
      item.image_fix_error_code = item.api_error_code = "heartbeat_unconfirmed";
      item.writer_claim_heartbeat_error = error.message;
      item.image_fix_requires_research = false;
      await jobStorage.set({ items });
      return { workerKey, error: item.api_error };
    });
    if (!deferred) return { ok: false, ignored: true, error: error.message };
    await pauseImageFixWorker(message.articleId, new Error(deferred.error), deferred.workerKey);
    return { ok: false, updated: false, retryable: true, error: deferred.error };
  }
  if (!leaseValid) {
    return { ok: false, ignored: true, error: "Khóa bài đã mất hoặc hết hạn; kết quả này không được lưu lên website." };
  }
  const staged = await stageArticleResult(message.articleId, completedResult, message.rawResponse, {
    runToken: message.runToken,
    sender
  });
  if (!staged.accepted) {
    return { ok: false, ignored: true, error: "Kết quả cũ đã bị bỏ qua vì hàng đợi đã dừng hoặc chuyển sang bài khác." };
  }
  const workerKey = staged.workerKey;
  let publishResult;
  try {
    publishResult = await publishStagedJob(message.articleId, staged.queueItem, completedResult);
  } catch (error) {
    await failJob(message.articleId, error.message, message.rawResponse);
    publishResult = { ok: false, error: error.message };
  } finally {
    const { runner } = await getJobMetadata("runner");
    const owner = workerKey === "legacy" ? runner : runner?.workers?.[workerKey];
    const stillOwnsSlot = owner?.currentId === message.articleId && (!message.runToken || owner.runToken === message.runToken);
    // Keep an ambiguous doctor save pinned until its receipt is confirmed.
    // Also do not schedule twice after a recovery alarm already cleared it.
    if (stillOwnsSlot && !publishResult?.unconfirmed) {
      await clearCurrent(message.articleId, message.runToken, workerKey === "legacy" ? undefined : workerKey, { pauseBeforeNext: publishResult?.updated === true });
    }
    if (stillOwnsSlot && !publishResult?.unconfirmed && publishResult?.updated === true) {
      const prepared = await waitBeforeNextJob(workerKey === "legacy" ? undefined : workerKey);
      if (!prepared?.dispatched) await runNext(workerKey === "legacy" ? undefined : workerKey, !prepared?.attempted);
    } else if (stillOwnsSlot && !publishResult?.unconfirmed) {
      await runNext(workerKey === "legacy" ? undefined : workerKey, false);
    }
  }
  return publishResult;
}

function completionResult(message = {}) {
  if (message.article != null) return message.article;
  if (message.imageResult != null) return message.imageResult;
  if (message.result != null) return message.result;
  const aiImageUrl = message.aiImageUrl ?? message.ai_image_url ?? message.imageUrl ?? message.image_url ?? message.url;
  const imageData = message.aiImageBase64 ?? message.image_data ?? message.imageData ?? message.image_base64 ?? message.imageBase64;
  if (typeof aiImageUrl === "string" && aiImageUrl.trim()) return { ai_image_url: aiImageUrl.trim() };
  if (typeof imageData === "string" && imageData.trim()) return { image_data: imageData.trim() };
  return null;
}

async function handleImageComplete(message, sender = {}) {
  if (message?.imageUploaded === true) {
    return handleDirectImageUploadComplete(message, sender);
  }
  return handleArticleComplete({ ...message, article: completionResult(message) }, sender);
}

function verifiedLocalAiImageUpdate(queueItem, imageResult, apiUpdate) {
  const facilityId = queueItem?.facility_id ?? queueItem?.facilityId;
  const localUrl = aiImageUrlFromResult(imageResult);
  if (!isPositiveId(facilityId) || !isLocalAiImageUrl(localUrl)) {
    throw new Error("Kết quả upload chưa có đường dẫn ảnh nội bộ hợp lệ.");
  }
  if (!apiUpdate?.ok || !Array.isArray(apiUpdate.updated)) {
    throw new Error("Website chưa xác nhận kết quả upload ảnh AI.");
  }
  const saved = apiUpdate.updated.find((entry) => String(entry?.facility_id ?? "") === String(facilityId));
  if (!saved || saved.storage !== "local_library" || String(saved.ai_image_url || "") !== localUrl) {
    throw new Error("Website chưa xác nhận đã lưu đúng file ảnh cho cơ sở này.");
  }
  return saved;
}

async function handleDirectImageUploadComplete(message, sender = {}) {
  const completedResult = completionResult(message);
  const staged = await stageArticleResult(message.articleId, completedResult, message.rawResponse, {
    runToken: message.runToken,
    sender
  });
  if (!staged.accepted) {
    return { ok: false, ignored: true, error: "Kết quả cũ đã bị bỏ qua vì hàng đợi đã dừng hoặc chuyển sang bài khác." };
  }
  const workerKey = staged.workerKey;
  let error = null;
  try {
    verifiedLocalAiImageUpdate(staged.queueItem, completedResult, message.apiUpdate);
    await withSchedulerLock(async () => {
      const { items = [] } = await jobStorage.get("items");
      const item = items.find((entry) => entry.id === message.articleId);
      if (!item) return;
      finalizeApiRequest(item, "hoàn tất", message.apiUpdate, null);
      await jobStorage.set({ items });
    });
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
    await withSchedulerLock(async () => {
      const { items = [] } = await jobStorage.get("items");
      const item = items.find((entry) => entry.id === message.articleId);
      if (!item) return;
      finalizeApiRequest(item, "lỗi cập nhật", null, error.message);
      await jobStorage.set({ items });
    });
  } finally {
    await clearCurrent(message.articleId, message.runToken, workerKey === "legacy" ? undefined : workerKey, { pauseBeforeNext: !error });
    if (!error) {
      const prepared = await waitBeforeNextJob(workerKey === "legacy" ? undefined : workerKey);
      if (!prepared?.dispatched) await runNext(workerKey === "legacy" ? undefined : workerKey, !prepared?.attempted);
    } else {
      await runNext(workerKey === "legacy" ? undefined : workerKey, false);
    }
  }
  return error ? { ok: false, error: error.message } : { ok: true, updated: true };
}

async function handleArticleFailed(message, sender = {}) {
  const handbook = (await getJobMetadata("items")).items?.find((item) => item.id === message.articleId && isHandbookItem(item));
  if (handbook) {
    const failed = await failJob(message.articleId, MedReviewHandbook.safeError(message.error), null, { runToken: message.runToken, sender });
    if (!failed.ignored) await pauseHandbookWorker(message.articleId, MedReviewHandbook.safeError(message.error), message.errorCode || "missing_images");
    return { ok: true, updated: false };
  }
  if (!await validateWriterLeaseForCompletion(message.articleId)) {
    return { ok: false, ignored: true, error: "Khóa bài đã mất hoặc hết hạn; phản hồi lỗi cũ đã được bỏ qua." };
  }
  const state = await getJobMetadata(["items", "runner"]);
  const retryWorkerKey = currentJobKeyFromState(state.runner, state.items || [], message.articleId, message.runToken, sender);
  const imageFix = (state.items || []).find((item) => item.id === message.articleId && isFacilityImageFixItem(item));
  if (imageFix && retryWorkerKey) {
    // The content reader already permits one code-block formatting follow-up.
    // Do not turn a final contract/read failure into an unbounded Spark loop.
    const failed = await failJob(message.articleId, message.error, message.rawResponse, { runToken: message.runToken, sender });
    if (failed.ignored) return { ok: false, ignored: true };
    await pauseImageFixWorker(message.articleId, new Error(message.error || "Không đọc được JSON Fix ảnh."), retryWorkerKey);
    return { ok: true, updated: false, error: message.error };
  }
  if (retryWorkerKey && await scheduleSparkJobRetry(message.articleId, message.error, message.runToken, retryWorkerKey)) {
    return { ok: true, retrying: true };
  }
  const failed = await failJob(message.articleId, message.error, message.rawResponse, {
    runToken: message.runToken,
    sender
  });
  if (failed.ignored) {
    return { ok: false, ignored: true, error: "Phản hồi cũ đã bị bỏ qua." };
  }
  const workerKey = failed.workerKey;
  try {
    return { ok: true };
  } finally {
    await clearCurrent(message.articleId, message.runToken, workerKey === "legacy" ? undefined : workerKey);
    await runNext(workerKey === "legacy" ? undefined : workerKey, false);
  }
}

// Keep ownership of the failed Spark article. Other queued articles cannot
// occupy this worker until this article succeeds or the user stops it.
async function scheduleSparkJobRetry(articleId, error, runToken, workerKey) {
  const scheduled = await withSchedulerLock(async () => {
    const { items = [], runner } = await getJobMetadata(["items", "runner"]);
    const worker = workerKey === "legacy" ? runner : runner?.workers?.[workerKey];
    const item = items.find((entry) => entry.id === articleId);
    const provider = worker?.targetProvider || worker?.provider;
    if (!runner?.active || !worker?.active || provider !== "gemini" ||
        !(worker.sparkTaskId || item?.sparkTaskId) || worker.currentId !== articleId ||
        worker.runToken !== runToken || !item || isAiImageItem(item)) return false;
    if (item.gemini_spark_dispatch_retry_at) return true;
    item.status = "đang viết";
    item.error = error;
    item.gemini_spark_json_retry_count = (Number(item.gemini_spark_json_retry_count) || 0) + 1;
    item.gemini_spark_dispatch_retry_at = new Date(Date.now() + 5000).toISOString();
    item.gemini_spark_json_retry_at = item.gemini_spark_dispatch_retry_at;
    await jobStorage.set({ items });
    return true;
  });
  if (scheduled) setTimeout(() => dispatchSparkJobRetry(workerKey).catch(() => {}), 5000);
  return scheduled;
}

async function dispatchSparkJobRetry(workerKey, now = Date.now()) {
  if (activeSparkDispatchRetries.has(workerKey)) return;
  activeSparkDispatchRetries.add(workerKey);
  try {
    const claimed = await withSchedulerLock(async () => {
      const { items = [], runner } = await jobStorage.get(["items", "runner"]);
      const worker = workerKey === "legacy" ? runner : runner?.workers?.[workerKey];
      const item = items.find((entry) => entry.id === worker?.currentId);
      if (!runner?.active || !worker?.active || item?.status !== "đang viết" ||
          !item.gemini_spark_dispatch_retry_at || Date.parse(item.gemini_spark_dispatch_retry_at) > now) return null;
      delete item.gemini_spark_dispatch_retry_at;
      delete item.gemini_spark_json_retry_at;
      delete item.gemini_spark_reload_attempted_at;
      item.last_progress_at = new Date(now).toISOString();
      await jobStorage.set({ items });
      return { article: item, runToken: worker.runToken, provider: worker.provider || worker.targetProvider };
    });
    if (!claimed) return;
    try {
      await startJob(claimed.article, claimed.article.prompt, workerKey === "legacy" ? claimed.provider : workerKey, claimed.runToken);
    } catch (error) {
      if (error.workerReleased) return;
      if (await handleImageFixDispatchError(claimed.article, error, workerKey, claimed.runToken)) return;
      if (await handleDoctorDispatchError(claimed.article, error, workerKey, claimed.runToken)) return;
      if (error.writerClaimConflict) {
        await markArticleWriterConflict(claimed.article.id, error.writer);
        const { runner } = await jobStorage.get("runner");
        const tabId = workerKey === "legacy" ? runner?.targetTabId : runner?.workers?.[workerKey]?.targetTabId;
        if (tabId) await stopWorkerByTabId(tabId, false);
        return;
      }
      await scheduleSparkJobRetry(claimed.article.id, error.message, claimed.runToken, workerKey);
    }
  } finally {
    activeSparkDispatchRetries.delete(workerKey);
  }
}

function formatImageErrorsForDisplay(errors) {
  if (!Array.isArray(errors) || !errors.length) return "";
  return errors.map((entry, index) => {
    const field = entry?.input_field || "gallery_json";
    const position = entry?.position != null ? `, ảnh số ${entry.position}` : "";
    const lines = [`${index + 1}. ${field}${position}`, `URL: ${entry?.url || "(không có URL)"}`, `Lý do: ${entry?.message || "Không thể nhập ảnh."}`];
    if (entry?.http_status) lines.push(`HTTP: ${entry.http_status}`);
    if (entry?.curl_error) lines.push(`Kết nối: ${entry.curl_error}`);
    return lines.join("\n");
  }).join("\n\n");
}

async function updateFacilityContent(queueItem, aiResult) {
  if (writerClaimType(queueItem) === "doctor") {
    return updateDoctorContent(queueItem, aiResult);
  }
  const payload = buildUpdatePayload(queueItem, aiResult);
  const isToplist = isToplistItem(queueItem);
  if (!isToplist && writerClaimType(queueItem) === "facility" && queueItem.writer_claim_required) {
    if (!queueItem.writer_claim_token) throw new Error("Bài cơ sở không còn claim_token hợp lệ; không gửi kết quả để tránh ghi đè máy khác.");
    const facilityId = writerClaimRecordId(queueItem, "facility");
    payload.items = payload.items.map((record) => String(record.id) === String(facilityId)
      ? { ...record, writer_claim_token: queueItem.writer_claim_token }
      : record);
  }
  const settingKey = isToplist ? "toplistUpdateUrl" : "updateUrl";
  // The API persists article data and queues image URLs only. Downloading and
  // compression happen later in the server-side Worker/Cron, keeping this
  // request short even for a large gallery.
  const settings = await getTabSettings(itemOwnerTabId(queueItem), settingKey);
  const response = await fetch(migrateApiHost(settings[settingKey] || DEFAULTS[settingKey]), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Medical-Api-Key": MEDICAL_API_KEY },
    body: JSON.stringify(payload)
  });
  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); } catch { throw new Error(`API cập nhật trả về ${response.status}: ${responseText.slice(0, 300)}`); }
  if (!response.ok) {
    const imageDetails = formatImageErrorsForDisplay(data?.image_errors);
    const base = `API cập nhật trả về ${response.status}: ${data?.message || JSON.stringify(data?.errors || data).slice(0, 300)}`;
    throw new Error(imageDetails ? `${base}\n\nChi tiết lỗi ảnh:\n${imageDetails}` : base);
  }
  if (!data?.ok) throw new Error(data?.message || "API không cập nhật bài viết.");
  if (Array.isArray(data.errors) && data.errors.length) throw new Error(`API có lỗi: ${JSON.stringify(data.errors).slice(0, 300)}`);
  if (isToplist && (!Array.isArray(data.updated_toplist_ids) ||
      payload.items.some((item) => !data.updated_toplist_ids.some((id) => String(id) === String(getToplistId(item)))))) {
    throw new Error("API chưa xác nhận cập nhật đúng ID Toplist. Kiểm tra URL nhận JSON Toplist và phản hồi API.");
  }
  return data;
}

function doctorPayloadUrlError(path, reason) {
  const error = new Error(`${path}: ${reason} JSON gốc được giữ nguyên, chưa gửi website. Hãy sửa đúng trường URL; không chuyển object/mảng thành chuỗi, không xoá chứng cứ hay suy đoán URL.`);
  error.doctorPayloadError = true;
  error.doctorPayloadField = path;
  return error;
}

function validateDoctorHttpUrl(value, path, required = false, rootLimit = 4000) {
    if (value == null || value === "") {
      if (required) throw doctorPayloadUrlError(path, "Cần URL HTTP(S) dạng chuỗi không rỗng, không null.");
      return;
    }
    if (typeof value !== "string") throw doctorPayloadUrlError(path, "URL phải là chuỗi hoặc null, không phải object, mảng, số hay boolean.");
    if (rootLimit !== null && ([...value].length > rootLimit || value.includes("\0"))) {
      throw doctorPayloadUrlError(path, `URL cần chuỗi tối đa ${rootLimit} ký tự, không chứa ký tự null.`);
    }
    const text = value.trim();
    // Root optional strings are trimmed by the API before URL validation.
    if (!text && !required && rootLimit !== null) return;
    let byteLength;
    try { byteLength = encodeURIComponent(text).replace(/%[0-9A-F]{2}/gi, "x").length; }
    catch { throw doctorPayloadUrlError(path, "URL chứa ký tự không hợp lệ."); }
    if (byteLength > 4000 || (rootLimit !== null && [...text].length > rootLimit)) {
      throw doctorPayloadUrlError(path, `URL quá dài (tối đa ${rootLimit === 255 ? "255 ký tự và " : ""}4000 byte).`);
    }
    let url;
    try { url = new URL(text); } catch { /* reported with the exact field below */ }
    const authority = text.match(/^https?:\/\/([^/?#]+)/i)?.[1] || "";
    const rawHost = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0];
    const host = url?.hostname || "";
    const validHost = rawHost.startsWith("[") ? host.startsWith("[") :
      rawHost.length <= 253 && rawHost.replace(/\.$/, "").split(".").every((label) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
    if (!url || !/^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(text) ||
        /[^\x21-\x7e]|[<>"\\]/.test(text) || !["http:", "https:"].includes(url.protocol) ||
        !host || !validHost || url.username || url.password ||
        /^https?:\/\/[^/?#]*@/i.test(text)) {
      throw doctorPayloadUrlError(path, "URL phải là HTTP(S) thô hợp lệ, không Markdown, HTML hoặc thông tin đăng nhập.");
    }
}

// Only this server-supported, unambiguous shape has a transport adaptation.
// Keep the AI result/raw output stored unchanged; never pick one of several
// links, guess a platform name, or discard additional evidence-bearing fields.
function normalizeDoctorSocialLinks(record) {
  let value = record.social_links_json;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return record; }
  }
  if (!Array.isArray(value) || !value.length) return record;
  const links = new Map();
  value.forEach((entry, index) => {
    const path = `social_links_json[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw doctorPayloadUrlError(path, "Danh sách liên kết cần object chỉ gồm platform và url.");
    }
    if (typeof entry.platform !== "string" || !entry.platform.trim() ||
        [...entry.platform].length > 190 || entry.platform.includes("\0")) {
      throw doctorPayloadUrlError(`${path}.platform`, "Tên nền tảng của URL cần chuỗi không rỗng, tối đa 190 ký tự.");
    }
    const extra = Object.keys(entry).find((key) => !["platform", "url"].includes(key));
    if (extra !== undefined) throw doctorPayloadUrlError(`${path}.${extra}`, "Object liên kết chỉ nhận platform và url; không tự bỏ trường khác hay chọn URL thay thế.");
    const platform = entry.platform.trim();
    if (links.has(platform)) throw doctorPayloadUrlError(`${path}.platform`, "Tên nền tảng URL bị trùng; không thể tự chọn hoặc ghi đè liên kết.");
    validateDoctorHttpUrl(entry.url, `${path}.url`, true, null);
    links.set(platform, entry.url);
  });
  const canonical = Object.fromEntries(links);
  if (Object.keys(canonical).every((platform, index) => platform === String(index))) {
    throw doctorPayloadUrlError("social_links_json.platform", "Cần tên nền tảng URL, không phải chỉ số danh sách.");
  }
  return { ...record, social_links_json: canonical };
}

// Inspect, never rewrite, URL values, including legacy JSON-encoded containers
// and nullable links. Unknown future fields outside the contract stay intact.
function validateDoctorUrlFields(record) {
  const checkUrl = validateDoctorHttpUrl;
  for (const field of ["website_url", "booking_url", "image_url", "professional_profile_url", "practice_registry_url", "website", "booking"]) {
    if (Object.hasOwn(record, field)) checkUrl(record[field], field, false, field === "image_url" ? 255 : 4000);
  }
  const fields = ["education_json", "experience_json", "certifications_json", "practice_license_json", "services_json",
    "conditions_treated_json", "memberships_json", "publications_json", "awards_json", "languages_supported_json",
    "patient_groups_json", "schedule_json", "fees_json", "sources_json", "social_links_json", "video_urls_json",
    "evidence_json", "locations_json", "practice_registration_json", "legal_documents_json", "legal_source_ids_json",
    "bio_json", "specialties_json", "tags_json", "gallery_json"];
  const objectFields = new Set(["practice_license_json", "evidence_json", "social_links_json"]);
  for (const field of fields) {
    if (!Object.hasOwn(record, field) || record[field] == null || record[field] === "") continue;
    let value = record[field];
    if (typeof value === "string") {
      try { value = JSON.parse(value); }
      catch { throw doctorPayloadUrlError(field, "Trường chứa URL phải là JSON array/object hợp lệ."); }
    }
    if (!value || typeof value !== "object" || (!objectFields.has(field) && !Array.isArray(value))) {
      throw doctorPayloadUrlError(field, "Trường chứa URL phải là JSON array/object đúng kiểu API.");
    }
    if (field === "gallery_json" || field === "sources_json") {
      value.forEach((entry, index) => checkUrl(field === "gallery_json" && typeof entry === "string" ? entry : entry?.url,
        `${field}[${index}].url`, true, null));
    }
    if (field === "video_urls_json" || field === "social_links_json") {
      if (field === "social_links_json" && Array.isArray(value) && value.length) {
        throw doctorPayloadUrlError(field, "social_links_json cần object tên nền tảng:chuỗi URL hoặc mảng rỗng [].");
      }
      for (const [key, link] of Object.entries(value)) checkUrl(link, `${field}[${key}]`, true, null);
    }
    const stack = [{ value, path: field }];
    while (stack.length) {
      const current = stack.pop();
      for (const [key, child] of Object.entries(current.value)) {
        const path = Array.isArray(current.value) ? `${current.path}[${key}]` : `${current.path}.${key}`;
        if (["url", "website_url", "booking_url"].includes(key)) checkUrl(child, path, false, null);
        else if (child && typeof child === "object") stack.push({ value: child, path });
      }
    }
  }
}

function buildDoctorUpdatePayload(queueItem, aiResult) {
  if (!isDoctorItem(queueItem) || !aiResult || typeof aiResult !== "object" || Array.isArray(aiResult) || Array.isArray(aiResult.items)) {
    throw new Error("Hồ sơ bác sĩ cần đúng một JSON object, không phải batch hay bản dịch.");
  }
  if (!Number.isSafeInteger(aiResult.id) || aiResult.id <= 0 || aiResult.id !== Number(queueItem.doctor_id)) {
    throw new Error(`JSON bác sĩ phải có id nguyên dương đúng ${queueItem.doctor_id}; chưa gửi website.`);
  }
  const name = queueItem.name ?? queueItem.title;
  if (typeof aiResult.name !== "string" || aiResult.name !== name) throw new Error("Tên bác sĩ trong JSON phải giữ nguyên chính xác từ API.");
  const record = normalizeDoctorSocialLinks(aiResult);
  validateDoctorUrlFields(record);
  if (typeof aiResult.insufficient_data !== "boolean") throw new Error("JSON bác sĩ thiếu insufficient_data dạng boolean.");
  if (aiResult.insufficient_data && !String(aiResult.notes_for_editor || "").trim()) throw new Error("Nghiên cứu thiếu dữ liệu phải có notes_for_editor.");
  if (!aiResult.insufficient_data && (!String(aiResult.content || "").trim() || !Array.isArray(aiResult.sources_json) ||
      !aiResult.sources_json.length || aiResult.evidence_json?.identity_status !== "matched")) {
    throw new Error("Hồ sơ đầy đủ cần content, sources_json và evidence_json.identity_status=matched.");
  }
  const missing = Object.keys(queueItem.output_template || {}).filter((key) => !Object.hasOwn(aiResult, key));
  if (missing.length) throw new Error(`JSON bác sĩ thiếu trường từ output_template: ${missing.join(", ")}.`);
  const protectedKeys = ["verified", "verification_status", "rating", "rating_avg", "rating_score", "rating_count", "ratings_count", "reviews_count", "followers_count", "view_count", "slug", "facility_slug", "display_order", "created_at", "updated_at", "status", "language_code", "translation_of_id", "reviewed_at", "reviewed_by", "last_researched_at", "writer_request_id", "ai_writer_claim_json"];
  const protectedField = protectedKeys.find((key) => Object.hasOwn(aiResult, key));
  if (protectedField) throw new Error(`AI không được sửa trường hệ thống bác sĩ: ${protectedField}.`);
  if (!queueItem.writer_claim_token || queueItem.writer_claim_lost) throw new Error("Khóa bác sĩ đã mất hoặc chưa được cấp; không gửi JSON cũ.");
  const transportRecord = { ...record };
  delete transportRecord.claim_token;
  return { items: [{ ...transportRecord, writer_claim_token: queueItem.writer_claim_token }] };
}

async function readDoctorReceipt(queueItem) {
  const requestId = queueItem.doctor_writer_request_id || queueItem.writer_claim_request_id;
  if (!requestId) return { confirmed: false };
  const settings = await getTabSettings(itemOwnerTabId(queueItem), "doctorContentUrl");
  const url = new URL(migrateApiHost(settings.doctorContentUrl || DEFAULTS.doctorContentUrl));
  url.searchParams.set("id", String(queueItem.doctor_id));
  return withQueueFetchTimeout(async (signal) => {
    const response = await fetch(url.href, { headers: { "X-Medical-Api-Key": MEDICAL_API_KEY, Accept: "application/json" }, cache: "no-store", signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {
      const error = new Error(`API kiểm tra hồ sơ bác sĩ HTTP ${response.status}: ${text.slice(0, 300)}`);
      error.httpStatus = response.status;
      throw error;
    }
    if (!response.ok || data?.ok !== true) {
      const error = new Error(`API kiểm tra hồ sơ bác sĩ HTTP ${response.status}: ${data?.message || text.slice(0, 300)}`);
      error.httpStatus = response.status;
      throw error;
    }
    const row = data.item;
    const full = typeof row?.full_json === "string" ? (() => { try { return JSON.parse(row.full_json); } catch { return null; } })() : row?.full_json;
    const confirmed = Number(row?.id) === Number(queueItem.doctor_id) && Boolean(row?.last_researched_at) && full?.writer_request_id === requestId;
    return { confirmed, record: row, data: confirmed ? {
      ok: true, type: "doctor", updated_count: 1, recovered_receipt: true,
      updated: [{ id: Number(row.id), writer_request_id: requestId, insufficient_data: truthyApiFlag(row.insufficient_data), verification_status: "unreviewed", writer_released: true }], errors: []
    } : null };
  }, "xác nhận hồ sơ bác sĩ");
}

function doctorApiError(status, data, text) {
  const details = (Array.isArray(data?.errors) ? data.errors : []).map((entry) =>
    `[index ${entry.index ?? "?"}, HTTP ${entry.status ?? status}] ${entry.reason ? `${entry.reason}: ` : ""}${entry.message || "Không lưu được"}`).join("\n");
  const error = new Error(`API hồ sơ bác sĩ HTTP ${status}: ${details || data?.message || text?.slice(0, 600) || "chưa xác nhận lưu đúng ID"}`);
  error.httpStatus = status;
  error.doctorApiErrors = data?.errors;
  error.doctorLeaseLost = status === 409 && /lease.*(?:lost|expired)|(?:lost|expired).*lease/i.test(
    [data?.reason, ...(Array.isArray(data?.errors) ? data.errors.map((entry) => entry.reason) : [])].join(" "));
  return error;
}

async function updateDoctorContent(queueItem, aiResult) {
  const payload = buildDoctorUpdatePayload(queueItem, aiResult);
  const settings = await getTabSettings(itemOwnerTabId(queueItem), "doctorUpdateUrl");
  const { items: latest = [] } = await getJobMetadata("items");
  const current = latest.find((item) => item.id === queueItem.id);
  if (current && (current.writer_claim_lost || !current.writer_claim_token ||
      current.writer_claim_token !== queueItem.writer_claim_token ||
      current.writer_claim_request_id !== queueItem.writer_claim_request_id ||
      Number(current.doctor_id) !== Number(queueItem.doctor_id))) {
    throw new Error("Khóa hồ sơ bác sĩ đã thay đổi; chưa gửi JSON cũ.");
  }
  let response, text, data;
  try {
    // No POST timeout: keep the writer heartbeat running for the whole upload.
    response = await fetch(migrateApiHost(settings.doctorUpdateUrl || DEFAULTS.doctorUpdateUrl), {
      method: "POST", headers: { "Content-Type": "application/json", "X-Medical-Api-Key": MEDICAL_API_KEY, Accept: "application/json" }, body: JSON.stringify(payload)
    });
    text = await response.text();
    data = JSON.parse(text);
  } catch (cause) {
    const receipt = await readDoctorReceipt(queueItem).catch(() => ({ confirmed: false }));
    if (receipt.confirmed) return receipt.data;
    if ([401, 403, 503].includes(response?.status)) throw doctorApiError(response.status, null, text);
    const error = new Error(`Chưa xác nhận lưu hồ sơ bác sĩ: ${cause.message}. JSON được giữ; sẽ kiểm tra biên nhận trước khi gửi lại.`);
    error.doctorUnconfirmed = true;
    throw error;
  }
  const records = Array.isArray(data?.results) ? data.results : Array.isArray(data?.updated) ? data.updated : [];
  const ownError = (Array.isArray(data?.errors) ? data.errors : []).find((entry) => Number(entry.id) === Number(queueItem.doctor_id) || entry.index === 0);
  const saved = records.find((entry) => Number(entry.id) === Number(queueItem.doctor_id) &&
    entry.writer_request_id === (queueItem.doctor_writer_request_id || queueItem.writer_claim_request_id));
  if (response.ok && saved && !ownError) return { ...data, ok: true, updated_count: 1, updated: [saved], results: [saved], insufficient_data: saved.insufficient_data === true };
  if (response.status === 409 || response.status >= 500) {
    const receipt = await readDoctorReceipt(queueItem).catch(() => ({ confirmed: false }));
    if (receipt.confirmed) return receipt.data;
  }
  const error = doctorApiError(response.status, data, text);
  if (response.ok && !saved && !ownError) error.message = `API hồ sơ bác sĩ HTTP ${response.status}: chưa xác nhận đúng ID ${queueItem.doctor_id} và mã yêu cầu ghi bài.`;
  if (response.status >= 500 && response.status !== 503) error.doctorUnconfirmed = true;
  throw error;
}

const doctorReceiptChecks = new Set();
async function reconcileDoctorPendingUpdates(now = Date.now()) {
  const { items = [] } = await getJobMetadata("items");
  let recovered = 0;
  for (const item of items) {
    if (!isDoctorItem(item) || !["đang cập nhật", "chưa xác nhận"].includes(item.status) || doctorReceiptChecks.has(item.id)) continue;
    if (activeApiRequests.has(String(item.id)) && now - Date.parse(item.api_request_started_at || "") < 60000) continue;
    if (now - Date.parse(item.doctor_receipt_checked_at || "") < 60000) continue;
    doctorReceiptChecks.add(item.id);
    try {
      const receipt = await readDoctorReceipt(item);
      const stored = await withSchedulerLock(async () => {
        const { items: latest = [], runner } = await getJobMetadata(["items", "runner"]);
        const current = latest.find((entry) => entry.id === item.id);
        if (!current || !["đang cập nhật", "chưa xác nhận"].includes(current.status) ||
            (current.doctor_writer_request_id || current.writer_claim_request_id) !== (item.doctor_writer_request_id || item.writer_claim_request_id)) return null;
        current.doctor_receipt_checked_at = new Date(now).toISOString();
        if (receipt.confirmed) {
          finalizeApiRequest(current, "hoàn tất", receipt.data, null, now);
          current.insufficient_data = truthyApiFlag(receipt.record?.insufficient_data);
          clearWriterClaimFields(current);
        }
        await jobStorage.set({ items: latest });
        return receipt.confirmed ? Object.entries(runner?.workers || {}).find(([, worker]) => worker.currentId === item.id) || ["legacy", runner] : null;
      });
      if (stored && receipt.confirmed) {
        recovered += 1;
        await clearCurrent(item.id, stored[1]?.runToken, stored[0] === "legacy" ? undefined : stored[0], { pauseBeforeNext: true });
      }
    } catch (error) {
      await withSchedulerLock(async () => {
        const { items: latest = [] } = await getJobMetadata("items");
        const current = latest.find((entry) => entry.id === item.id);
        if (!current) return;
        current.doctor_receipt_checked_at = new Date(now).toISOString();
        current.doctor_receipt_error = error.message;
        await jobStorage.set({ items: latest });
      });
    } finally { doctorReceiptChecks.delete(item.id); }
  }
  return { recovered };
}

function aiImageUrlFromResult(result) {
  const value = typeof result === "string"
    ? result
    : result && typeof result === "object" && !Array.isArray(result)
      ? result.ai_image_url ?? result.aiImageUrl ?? result.image_url ?? result.imageUrl ?? result.url
      : "";
  const url = typeof value === "string" ? value.trim() : "";
  // Data URIs are accepted by the endpoint as image_data, never as a URL.
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(url) ? "" : url;
}

function isLocalAiImageUrl(value) {
  return /^\/uploads\/library\//.test(String(value || "").trim());
}

function aiImageDataFromResult(result) {
  const value = typeof result === "string"
    ? result
    : result && typeof result === "object" && !Array.isArray(result)
      ? result.image_data ?? result.imageData ?? result.aiImageBase64 ?? result.image_base64 ?? result.imageBase64 ??
        (/^data:image\/[a-z0-9.+-]+;base64,/i.test(String(result.ai_image_url ?? result.aiImageUrl ?? result.image_url ?? result.imageUrl ?? ""))
          ? result.ai_image_url ?? result.aiImageUrl ?? result.image_url ?? result.imageUrl
          : "")
      : "";
  const imageData = typeof value === "string" ? value.trim() : "";
  if (!imageData) return "";
  // A direct string is treated as base64 only when it is a data URI. Plain
  // base64 should be explicitly named so ordinary URLs are never misrouted.
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(imageData) ||
    (typeof result === "object" && result !== null && !Array.isArray(result))
    ? imageData
    : "";
}

function buildAiImageUpdatePayload(queueItem, imageResult) {
  const id = queueItem?.facility_id ?? queueItem?.facilityId;
  if (!isPositiveId(id)) throw new Error("Thiếu ID cơ sở hợp lệ để cập nhật ảnh AI.");
  const resultId = imageResult && typeof imageResult === "object" && !Array.isArray(imageResult)
    ? imageResult.id ?? imageResult.facility_id ?? imageResult.facilityId
    : null;
  if (resultId != null && String(resultId) !== String(id)) {
    throw new Error(`Kết quả ảnh trả về ID ${resultId}, khác ID cơ sở đang xử lý ${id}. Chưa gửi website.`);
  }
  const aiImageUrl = aiImageUrlFromResult(imageResult);
  const imageData = aiImageDataFromResult(imageResult);
  if (!aiImageUrl && !imageData) throw new Error("Không nhận được URL hoặc dữ liệu ảnh AI để gửi website.");
  if (aiImageUrl && !isLocalAiImageUrl(aiImageUrl)) {
    throw new Error("Không gửi URL tạm/private của ChatGPT hoặc Grok sang website. Ảnh phải được upload multipart từ tab AI trước.");
  }
  // The image endpoint intentionally receives only its documented contract.
  // Do not set `set_as_cover`: the source gallery remains untouched by default.
  return aiImageUrl ? { id, ai_image_url: aiImageUrl } : { id, image_data: imageData };
}

async function updateFacilityAiImage(queueItem, imageResult) {
  const payload = buildAiImageUpdatePayload(queueItem, imageResult);
  const settings = await getTabSettings(itemOwnerTabId(queueItem), "aiImageUpdateUrl");
  const response = await fetch(migrateApiHost(settings.aiImageUpdateUrl || DEFAULTS.aiImageUpdateUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Medical-Api-Key": MEDICAL_API_KEY },
    body: JSON.stringify(payload)
  });
  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); }
  catch { throw new Error(`API cập nhật ảnh AI trả về ${response.status}: ${responseText.slice(0, 300)}`); }
  if (!response.ok) {
    throw new Error(`API cập nhật ảnh AI trả về ${response.status}: ${data?.message || JSON.stringify(data?.errors || data).slice(0, 300)}`);
  }
  if (!data?.ok) throw new Error(data?.message || "API không cập nhật ảnh AI.");
  if (Array.isArray(data.errors) && data.errors.length) throw new Error(`API có lỗi: ${JSON.stringify(data.errors).slice(0, 300)}`);
  return data;
}

function parseTranslationSchemaValue(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); }
  catch { return trimmed.split(/[\s,]+/).filter(Boolean); }
}

function translationAllowedFields(queueItem) {
  const fieldsValue = parseTranslationSchemaValue(queueItem?.translation_fields);
  const templateValue = parseTranslationSchemaValue(queueItem?.output_template);
  const fields = Array.isArray(fieldsValue)
    ? fieldsValue.filter((field) => typeof field === "string" && field.trim()).map((field) => field.trim())
    : fieldsValue && typeof fieldsValue === "object" ? Object.keys(fieldsValue) : [];
  const templateFields = Array.isArray(templateValue)
    ? templateValue.filter((field) => typeof field === "string" && field.trim()).map((field) => field.trim())
    : templateValue && typeof templateValue === "object" ? Object.keys(templateValue) : [];
  let allowed;
  if (fields.length && templateFields.length) {
    const templateSet = new Set(templateFields);
    allowed = fields.filter((field) => templateSet.has(field));
  } else {
    allowed = fields.length ? fields : templateFields;
  }
  const immutable = new Set(["id", "type", "source_id", "sourceId"]);
  allowed = [...new Set(allowed)].filter((field) => !immutable.has(field));
  if (!allowed.length) throw new Error("API dịch thiếu translation_fields/output_template hợp lệ; không gửi JSON để tránh cập nhật sai trường.");
  return { allowed, template: templateValue };
}

function buildTranslationPayload(queueItem, aiResult) {
  if (!isTranslationItem(queueItem)) throw new Error("Bài này không thuộc hàng đợi dịch.");
  const type = normalizeTranslationType(queueItem.type || queueItem.translation_type);
  const sourceId = queueItem.source_id;
  if (sourceId == null || String(sourceId).trim() === "") throw new Error("Bản dịch thiếu source_id gốc; không gửi API.");
  let result = aiResult;
  if (typeof result === "string") {
    const raw = result.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { result = JSON.parse(raw); }
    catch { throw new Error("Kết quả dịch chưa phải JSON hợp lệ."); }
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Kết quả dịch phải là JSON object {type, source_id, translated}.");
  }
  if (!Object.hasOwn(result, "type") || !Object.hasOwn(result, "source_id") || !Object.hasOwn(result, "translated")) {
    throw new Error("Kết quả dịch phải có đủ envelope {type, source_id, translated} theo prompt từ API.");
  }
  if (result.type == null || String(result.type).trim().toLowerCase() !== type) {
    throw new Error(`JSON dịch thiếu hoặc sai type; bài này cần type=\"${type}\".`);
  }
  if (result.source_id == null || String(result.source_id) !== String(sourceId)) {
    throw new Error(`JSON dịch thiếu hoặc sai source_id; bài này cần source_id=${sourceId}.`);
  }
  const translated = result.translated;
  if (!translated || typeof translated !== "object" || Array.isArray(translated)) {
    throw new Error("JSON dịch cần có object translated theo output_template.");
  }
  const { allowed } = translationAllowedFields(queueItem);
  const allowedSet = new Set(allowed);
  const extra = Object.keys(translated).filter((key) => !allowedSet.has(key));
  if (extra.length) throw new Error(`JSON dịch có trường ngoài output_template/translation_fields: ${extra.join(", ")}. Sửa prompt hoặc kết quả rồi gửi lại.`);
  if (!Object.keys(translated).length) throw new Error("JSON dịch đang rỗng; không có trường nào để lưu.");
  const missing = allowed.filter((field) => !Object.hasOwn(translated, field));
  if (missing.length) throw new Error(`JSON dịch thiếu ${missing.length} trường theo output_template: ${missing.join(", ")}. Chưa gửi website.`);
  return { type, items: [{ source_id: sourceId, translated: { ...translated } }] };
}

async function updateTranslation(queueItem, aiResult) {
  const payload = buildTranslationPayload(queueItem, aiResult);
  const settings = await getTabSettings(itemOwnerTabId(queueItem), "translationUrl");
  const response = await fetch(migrateApiHost(settings.translationUrl || DEFAULTS.translationUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Medical-Api-Key": MEDICAL_API_KEY, Accept: "application/json" },
    body: JSON.stringify(payload)
  });
  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); }
  catch { throw new Error(`API dịch trả về ${response.status}: ${responseText.slice(0, 300) || "phản hồi không phải JSON"}`); }
  if (!response.ok) throw new Error(`API dịch trả về ${response.status}: ${data?.message || JSON.stringify(data?.errors || data).slice(0, 300)}`);
  if (data?.ok === false) throw new Error(data?.message || `API dịch không lưu bản nháp: ${JSON.stringify(data.errors || data).slice(0, 300)}`);
  if (Array.isArray(data?.errors) && data.errors.length) throw new Error(`API dịch có lỗi: ${JSON.stringify(data.errors).slice(0, 300)}`);
  const confirmed = data?.ok === true || data?.translation_id != null || typeof data?.slug === "string" ||
    typeof data?.status === "string" || Array.isArray(data?.saved_fields);
  if (!confirmed) throw new Error("API dịch chưa trả xác nhận lưu bản nháp (thiếu translation_id/status/saved_fields). JSON vẫn được giữ để gửi lại.");
  return data;
}

function isToplistItem(queueItem) {
  return queueItem.sourceType === "toplist" || queueItem.toplist_id != null;
}

function getToplistId(record) {
  return record.toplist_id ?? record.toplistId ?? record.id;
}

function isPositiveId(value) {
  return (typeof value === "number" || typeof value === "string") &&
    /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function prepareToplistRecord(queueItem, record, recordCount) {
  const resultId = getToplistId(record);
  const id = resultId ?? (recordCount === 1 ? queueItem.toplist_id : null);
  if (!isPositiveId(id)) throw new Error("Thiếu ID Toplist hợp lệ để cập nhật website.");
  if (queueItem.toplist_id != null && String(id) !== String(queueItem.toplist_id)) {
    throw new Error(`JSON trả về ID Toplist ${id}, khác ID bài đang viết ${queueItem.toplist_id}. Chưa gửi website.`);
  }
  const hasFacilities = ["facilities", "co_so", "co_so_y_te"].some((key) => Object.hasOwn(record, key));
  const hasDoctors = ["doctors", "bac_si"].some((key) => Object.hasOwn(record, key));
  const hasMembers = Object.hasOwn(record, "members");
  const type = record.entity_type ?? record.list_type ?? (hasMembers || hasFacilities && hasDoctors ? "mixed" : hasDoctors ? "doctor" : hasFacilities ? "facility" : queueItem.entity_type || "facility");
  if (!["facility", "doctor", "mixed"].includes(type)) throw new Error("entity_type Toplist phải là facility, doctor hoặc mixed.");
  if (queueItem.entity_type && type !== queueItem.entity_type) throw new Error(`JSON Toplist loại ${type}, khác loại bài ${queueItem.entity_type}. Chưa gửi website.`);
  const facilities = record.facilities ?? record.co_so ?? record.co_so_y_te ?? [];
  const doctors = record.doctors ?? record.bac_si ?? [];
  if ((hasFacilities && !Array.isArray(facilities)) || (hasDoctors && !Array.isArray(doctors))) throw new Error("facilities/doctors Toplist phải là JSON array.");
  if (type !== "mixed" && (hasMembers || (type === "doctor" ? facilities : doctors).length)) throw new Error("Danh sách JSON không khớp loại Toplist; cả cơ sở và bác sĩ cần entity_type=mixed.");
  if (hasMembers && (facilities.length || doctors.length)) throw new Error("Dùng members hoặc facilities/doctors, không dùng cả hai cấu trúc đồng thời.");
  const members = type === "mixed"
    ? hasMembers ? record.members : [...facilities.map((row) => ({ row, type: "facility" })), ...doctors.map((row) => ({ row, type: "doctor" }))]
    : (type === "doctor" ? doctors : facilities).map((row) => ({ row, type }));
  if (!Array.isArray(members) || !members.length || members.length > 1000) throw new Error("JSON Toplist cần danh sách facilities, doctors hoặc members không rỗng, tối đa 1.000 hồ sơ.");
  for (const [index, entry] of members.entries()) {
    const row = type === "mixed" && hasMembers ? entry : entry.row;
    const memberType = type === "mixed" && hasMembers ? row?.type ?? row?.member_type : entry.type;
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Hồ sơ thứ ${index + 1} trong JSON Toplist phải là một object.`);
    if (!["facility", "doctor"].includes(memberType) || (row.type != null && row.type !== memberType) || (row.member_type != null && row.member_type !== memberType)) throw new Error(`type hồ sơ thứ ${index + 1} không khớp danh sách Toplist.`);
    const key = memberType === "doctor" ? "doctor_id" : "facility_id";
    if (Object.hasOwn(row, memberType === "doctor" ? "facility_id" : "doctor_id")) throw new Error(`Hồ sơ ${memberType} thứ ${index + 1} phải dùng ${key}.`);
    const memberId = row[key] ?? row.id ?? 0;
    if (!(memberId === 0 || memberId === "0" || isPositiveId(memberId))) throw new Error(`${key} phải là số nguyên không âm.`);
    const name = row.name ?? row.ten;
    if (!isPositiveId(memberId) && (typeof name !== "string" || !name.trim())) throw new Error(`Hồ sơ thứ ${index + 1} thiếu name hoặc ${key} hợp lệ.`);
    if (memberType === "doctor" && !isPositiveId(memberId)) {
      const text = (value) => typeof value === "string" && value.trim();
      if (!text(row.specialty_text ?? row.specialty ?? row.chuyen_khoa) || !(text(row.city ?? row.province ?? row.tinh_thanh) || text(row.facility_name ?? row.co_so_cong_tac))) throw new Error(`Bác sĩ mới thứ ${index + 1} cần specialty_text và city hoặc facility_name để xác định đúng người.`);
    }
    if (!isPositiveId(row.rank_order ?? row.rank ?? index + 1)) throw new Error("rank_order Toplist phải là số nguyên dương.");
  }
  // A nested facility ID belongs to that facility, never to the parent Toplist.
  // Only supply the Toplist ID when the AI omitted every supported root alias.
  return resultId == null ? { ...record, toplist_id: id } : { ...record };
}

function buildUpdatePayload(queueItem, aiResult) {
  if (!aiResult || typeof aiResult !== "object") throw new Error("Chưa có JSON bài viết hợp lệ để gửi website.");
  // Old versions saved incomplete DOM text as a synthetic article. Do not let
  // the retry button publish that old fallback as though it were AI JSON.
  if (aiResult.format === "text" && aiResult.content === queueItem.rawResponse &&
      Object.keys(aiResult).every((key) => ["title", "content", "format"].includes(key))) {
    throw new Error("Kết quả cũ là đoạn văn bản đọc lỗi, chưa phải JSON gốc của AI. Cần lấy lại JSON trước khi gửi.");
  }
  const records = Array.isArray(aiResult) ? aiResult : Array.isArray(aiResult.items) ? aiResult.items : [aiResult];
  if (!records.length) throw new Error("JSON không chứa bài viết để cập nhật.");
  const items = records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Mỗi bài trong JSON phải là một object.");
    if (isToplistItem(queueItem)) return prepareToplistRecord(queueItem, record, records.length);
    const id = record.id ?? (records.length === 1 ? queueItem.facility_id : null);
    if (!id) throw new Error("Thiếu ID cơ sở để cập nhật website.");
    if (queueItem.facility_id != null && String(id) !== String(queueItem.facility_id)) {
      throw new Error(`JSON trả về ID ${id}, khác ID bài đang viết ${queueItem.facility_id}. Chưa gửi website.`);
    }
    return { ...record, id };
  });
  // Preserve all article fields (including reviews/future fields) and any
  // wrapper metadata. A root array must not be spread into numeric object keys.
  return !Array.isArray(aiResult) && Array.isArray(aiResult.items) ? { ...aiResult, items } : { items };
}

async function retryUpdate(articleId) {
  const snapshot = (await getJobMetadata("items")).items?.find((item) => item.id === articleId);
  if (isHandbookItem(snapshot)) return retryHandbook(snapshot);
  if (isFacilityImageFixItem(snapshot)) return retryFacilityImageFixUpdate(articleId);
  await reconcileStaleApiUpdates();
  const { items: before = [] } = await jobStorage.get("items");
  const doctor = before.find((item) => item.id === articleId && isDoctorItem(item));
  if (doctor) {
    const receipt = await readDoctorReceipt(doctor);
    if (receipt.confirmed) {
      await withSchedulerLock(async () => {
        const { items = [] } = await getJobMetadata("items");
        const current = items.find((item) => item.id === articleId);
        if (!current) return;
        finalizeApiRequest(current, "hoàn tất", receipt.data, null);
        current.insufficient_data = truthyApiFlag(receipt.record?.insufficient_data);
        clearWriterClaimFields(current);
        await jobStorage.set({ items });
      });
      return { ok: true, recovered: true };
    }
    if (doctor.status === "hoàn tất" || receipt.record?.last_researched_at || String(receipt.record?.content || "").trim()) {
      throw new Error("Hồ sơ bác sĩ đã được nghiên cứu hoặc ghi bởi phiên khác; không tự viết đè.");
    }
    if (doctor.writer_claim_lost) throw new Error("Khóa bác sĩ đã mất; không gửi JSON cũ dưới một khóa mới.");
    if (doctor.status === "đang cập nhật" || activeApiRequests.has(String(articleId))) throw new Error("Yêu cầu bác sĩ vẫn đang chạy; chưa gửi trùng.");
    await revalidateDoctorJob(doctor);
  }
  const item = await withSchedulerLock(async () => {
    const { items = [] } = await jobStorage.get("items");
    const current = items.find((entry) => entry.id === articleId);
    if (!current?.result) throw new Error("Không có JSON để gửi lại.");
    if (current.writer_claim_release_pending) {
      throw new Error("Đang trả khóa của tab cũ; chờ hoàn tất rồi gửi lại. JSON vẫn được giữ.");
    }
    if (current.status === "đang cập nhật" || activeApiRequests.has(String(articleId))) {
      throw new Error("Yêu cầu gửi website vẫn đang chạy; JSON đã được lưu, chưa gửi trùng.");
    }
    markApiRequestStarted(current);
    await jobStorage.set({ items });
    return { ...current };
  });
  const requestKey = String(articleId);
  if (activeApiRequests.has(requestKey)) throw new Error("Yêu cầu gửi website cho bài này đang chạy.");
  activeApiRequests.add(requestKey);
  let status = "hoàn tất";
  let apiUpdate = null;
  let apiError = null;
  let operationError = null;
  let doctorLeaseLost = false;
  let doctorHeartbeatFatal = false;
  try {
    try {
      if (isDoctorItem(item)) {
        const lease = await claimWriterLease(item, {
          provider: item.provider || "manual-retry", workerKey: item.writer_claim_worker_id || item.workerKey || `tab-${itemOwnerTabId(item)}`, retry: true
        });
        if (!lease.claimed) {
          const error = new Error(`Không thể gửi lại bác sĩ: ${lease.reason || "already_claimed"}.`);
          error.writerClaimConflict = true;
          throw error;
        }
      }
      if (!isAiImageItem(item) && !isTranslationItem(item) && writerClaimType(item) === "facility") {
        delete item.writer_claim_request_id;
        delete item.writer_claim_required;
        const lease = await claimWriterLease(item, {
          provider: item.provider || "manual-retry", workerKey: "manual-retry", retry: true
        });
        if (!lease.claimed) {
          await markArticleWriterConflict(articleId, lease.writer);
          const conflictError = new Error(`Không thể gửi lại: bài đang được viết bởi ${writerClaimDisplay({ writer_claim: lease.writer })}.`);
          conflictError.writerClaimConflict = true;
          throw conflictError;
        }
      }
      apiUpdate = isAiImageItem(item)
        ? await updateFacilityAiImage(item, item.result)
        : isTranslationItem(item)
          ? await updateTranslation(item, item.result)
          : await updateFacilityContent(item, item.result);
    } catch (error) {
      // A writer conflict is queue ownership, not a failed API send. Preserve
      // the waiting/claimed state so the UI continues to identify the owner.
      operationError = error.message;
      doctorLeaseLost = isDoctorItem(item) && error.doctorLeaseLost === true;
      doctorHeartbeatFatal = isDoctorItem(item) && error.doctorHeartbeatFatal === true;
      status = error.writerClaimConflict ? "chờ" : isDoctorItem(item) && error.doctorUnconfirmed ? "chưa xác nhận" : "lỗi cập nhật";
      apiError = error.writerClaimConflict ? null : error.message;
      if (isDoctorItem(item) && [401, 403, 503].includes(error.httpStatus)) await pauseDoctorWorker(articleId, error, item.workerKey);
    }
    await withSchedulerLock(async () => {
      const { items = [] } = await jobStorage.get("items");
      const current = items.find((entry) => entry.id === articleId);
      if (!current) return;
      if (isDoctorItem(item) && current.status === "hoàn tất") { status = "hoàn tất"; return; }
      finalizeApiRequest(current, status, apiUpdate, apiError);
      await jobStorage.set({ items });
    });
    if (status === "hoàn tất") await clearWriterClaimAfterSave(item);
    else if (status !== "chưa xác nhận" && !doctorHeartbeatFatal) await releaseWriterClaim(item);
    if (doctorLeaseLost && status !== "hoàn tất") await retainDoctorLeaseLoss(articleId);
    return { ok: status === "hoàn tất", error: operationError || apiError };
  } finally {
    activeApiRequests.delete(requestKey);
    await pruneCompletedHistory();
  }
}

async function failJob(articleId, error, rawResponse, expectedJob = null) {
  const failed = await withSchedulerLock(async () => {
    const { items = [], runner } = await jobStorage.get(["items", "runner"]);
    const workerKey = expectedJob
      ? currentJobKeyFromState(runner, items, articleId, expectedJob.runToken, expectedJob.sender)
      : null;
    if (expectedJob && !workerKey) return { ok: false, ignored: true };
    const item = items.find((entry) => entry.id === articleId);
    if (item) {
      item.status = "lỗi";
      item.error = error;
      // Persist a narrow marker so a later ChatGPT/Grok start can recover the
      // jobs that were rejected solely because an old build tried to run them
      // on Gemini/Claude. Never mark normal image-generation/API failures.
      if (isAiImageItem(item) && isUnsupportedAiImageProvider(item.provider) &&
          isUnsupportedAiImageProviderError(error)) {
        item.failure_code = UNSUPPORTED_IMAGE_PROVIDER_FAILURE;
        item.failed_provider = item.provider;
      }
      if (isHandbookItem(item)) {
        item.error = MedReviewHandbook.safeError(error);
        item.handbook_error_code = /ảnh|BASE64|image/i.test(error) ? "missing_images" : "ai_response_error";
        delete item.rawResponse;
      } else if (typeof rawResponse === "string") item.rawResponse = rawResponse;
      await jobStorage.set({ items });
    }
    return { ok: true, workerKey, ...(item?.writer_claim_token ? { claimItem: { ...item } } : {}) };
  });
  if (failed.claimItem) await releaseWriterClaim(failed.claimItem);
  return failed;
}

async function clearCurrent(articleId, runToken, workerKey, { pauseBeforeNext = false } = {}) {
  await withSchedulerLock(async () => {
    const { runner, items = [], nextJobDelayMs } = await getJobMetadata(["runner", "items", "nextJobDelayMs"]);
    const delay = pauseBeforeNext && chrome.runtime?.id ? Number(nextJobDelayMs ?? DEFAULTS.nextJobDelayMs) : 0;
    const deadline = Number.isFinite(delay) && delay > 0 ? Date.now() + Math.min(delay, 24 * 60 * 60 * 1000) : 0;
    if (runner?.workers) {
      if (!workerKey) return;
      const worker = runner.workers[workerKey];
      if (worker && (worker.currentId !== articleId || (runToken && worker.runToken && worker.runToken !== runToken))) return;
      if (!worker) return;
      worker.currentId = null;
      worker.lastError = null;
      delete worker.waitReason;
      if (deadline) { worker.nextJobAt = deadline; delete worker.prefetchCompletedFor; }
      refreshRunnerSummary(runner, items);
      await jobStorage.set({ runner });
      return;
    }
    if (!runner?.currentId) return;
    if (articleId != null && runner.currentId !== articleId) return;
    if (runToken && runner.runToken && runner.runToken !== runToken) return;
    const nextRunner = { ...runner, currentId: null, targetProvider: null, targetTabId: null, ...(deadline ? { nextJobAt: deadline } : {}) };
    if (deadline) delete nextRunner.prefetchCompletedFor;
    await jobStorage.set({ runner: nextRunner });
  });
  await pruneCompletedHistory();
}
