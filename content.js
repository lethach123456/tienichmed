if (!globalThis.__aiArticleRunnerLoaded) {
globalThis.__aiArticleRunnerLoaded = true;
const PAGE_HOSTNAME = String(location.hostname || "").toLowerCase();
const PROVIDER = PAGE_HOSTNAME === "gemini.google.com" || PAGE_HOSTNAME.endsWith(".gemini.google.com")
  ? "gemini"
  : PAGE_HOSTNAME === "claude.ai" || PAGE_HOSTNAME.endsWith(".claude.ai")
    ? "claude"
    : PAGE_HOSTNAME.includes("grok") || PAGE_HOSTNAME === "x.com" || PAGE_HOSTNAME.endsWith(".x.com")
      ? "grok"
      : "chatgpt";
let cancelledArticleId = null;
let activeArticleId = null;
let sparkSendCountdownWake = null;
let recoveryRetryCount = 0;
let recoveryRetryTimer = null;
// Writing a facility article or Toplist can include deep research and a large
// JSON payload, so give that flow 30 minutes. Image generation keeps its own
// shorter 10-minute window below.
const ARTICLE_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const ARTICLE_WAIT_TIMEOUT_LABEL = "30 phút";
// Spark conversation IDs are account/session specific and can change.  Pin the
// workflow by the visible sidebar task label instead of a hard-coded ID.
const GEMINI_SPARK_CONTENT_TASK_LABEL = "content ai";
// Reload the active Spark task every ten minutes. After each reload, recovery
// keeps watching the Stop button and reads the answer once that button closes.
const GEMINI_SPARK_RELOAD_INTERVAL_MS = 10 * 60 * 1000;
const GEMINI_SPARK_RELOAD_COOLDOWN_MS = 10 * 60 * 1000;
const GEMINI_SPARK_RELOAD_STORAGE_KEY = "medreview-gemini-spark-reload";
const JSON_FORMAT_RETRY_STORAGE_PREFIX = "medreview-json-format-retry:";
const IMAGE_FIX_REPLACEMENT_RETRY_STORAGE_PREFIX = "medreview-image-replacement-retry:";
const SPARK_JSON_RETRY_STORAGE_PREFIX = "medreview-gemini-json-retry:";
const GEMINI_SPARK_JSON_RETRY_DELAY_MS = 5000;
let geminiSparkReloadAt = 0;
let geminiSparkReloadArticleId = null;
let sparkJobInitialTaskId = null;
// Generated-image cards can sit outside the ordinary text-response wrapper.
// Keep a stable local key for each DOM image so inserting a new turn never
// makes an older picture look freshly generated.
const generatedImageElementIds = new WeakMap();
let generatedImageElementSequence = 0;

// Show the same embedded work panel on every supported AI website.
const mountPersistentPanel = () => installPersistentPanel().catch(() => {});
if (document.body) mountPersistentPanel();
else if (typeof document.addEventListener === "function") document.addEventListener("DOMContentLoaded", mountPersistentPanel, { once: true });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "runner-ready") {
    sendResponse({ ok: true, ready: true });
    return;
  }
  if (message.type === "resolve-gemini-content-task") {
    resolveGeminiSparkContentTask()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "read-existing-article-json") {
    readExistingArticleJson(message.article)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "resume-scheduled-article" && activeArticleId === message.article.id) {
    if (sparkSendCountdownWake?.articleId === message.article.id) sparkSendCountdownWake.wake();
    sendResponse({ ok: true, alreadyRunning: true });
    return;
  }
  if (message.type === "run-article" || message.type === "run-ai-image" || message.type === "resume-scheduled-article") {
    executeArticle(message.article, message.prompt, message.startupTiming)
      .catch((error) => {
        // A scheduled Spark reload deliberately navigates the tab. Do not mark the job
        // failed while the old document is being replaced; recovery on the
        // new document will collect the answer instead.
        if (error?.code === "gemini-spark-reload" || error?.code === "gemini-spark-navigation") return;
        return chrome.runtime.sendMessage({ type: "article-failed", articleId: message.article.id, runToken: message.article.runToken,
          error: message.article.sourceType === "handbook" ? MedReviewHandbook.safeError(error) : error.message,
          errorCode: error.code, rawResponse: message.article.sourceType === "handbook" ? undefined : error.rawResponse });
      });
    sendResponse({ ok: true, started: true });
  }
  if (message.type === "stop-article" || message.type === "writer-lease-lost") {
    cancelledArticleId = message.articleId;
    if (sparkSendCountdownWake?.articleId === message.articleId) sparkSendCountdownWake.wake();
    document.querySelector("button[data-testid*='stop'], button[aria-label*='Stop'], button[aria-label*='Dừng']")?.click();
    sendResponse({ ok: true });
  }
});

// If the extension or an AI tab reloads while it is researching, the old
// in-memory watcher disappears although the AI keeps working. Reattach to the
// saved job and collect the completed JSON instead of leaving it "đang viết".
async function resumeQueuedRunAfterReload() {
  if (!chrome.runtime?.id) return;
  try {
    await chrome.runtime.sendMessage({ type: "continue-after-reload" });
  } catch {}
}

if (chrome.runtime?.id) {
  setTimeout(() => retryPendingRecovery().catch(() => {}), 1200);
  // After a post-publish reload the MV3 service worker may have slept through
  // the inter-article delay. Ask it to continue once this AI tab is alive again.
  setTimeout(() => resumeQueuedRunAfterReload().catch(() => {}), 2500);
}

// The MV3 worker and Spark's task DOM can become ready at different times
// after a reload. Retry only the lightweight ownership check when no job was
// claimed; once a job is found, recoverPendingArticle owns it until completion.
async function retryPendingRecovery() {
  if (activeArticleId || !chrome.runtime?.id) return;
  const recovered = await recoverPendingArticle();
  if (recovered || activeArticleId || recoveryRetryCount >= 8) return;
  recoveryRetryCount += 1;
  clearTimeout(recoveryRetryTimer);
  recoveryRetryTimer = setTimeout(() => retryPendingRecovery().catch(() => {}), 1800);
}

function expectedArticleId(article) {
  if (article?.sourceType === "handbook") return { sourceType: "handbook", id: article.handbook_id, language: article.language };
  if (article?.sourceType === "translation") {
    return {
      sourceType: "translation",
      type: String(article.type || article.translation_type || "facility").toLowerCase(),
      source_id: article.source_id
    };
  }
  if (article?.sourceType === "doctor") {
    return { sourceType: "doctor", id: article.doctor_id, name: article.name ?? article.title };
  }
  if (article?.sourceType === "facility_image_fix") {
    return { sourceType: "facility_image_fix", id: article.facility_id, images_revision: article.images_revision };
  }
  return article.sourceType === "toplist" || article.toplist_id != null
    ? { id: article.toplist_id, sourceType: "toplist", ...(article.entity_type ? { entity_type: article.entity_type } : {}) }
    : article.facility_id;
}

function isAiImageArticle(article) {
  const source = String(article?.sourceType || article?.source_type || "").toLowerCase();
  return source === "ai-image" || source === "ai_image" || source === "image";
}

async function executeArticle(article, prompt, startupTiming) {
  if (activeArticleId === article.id) return { ok: true, alreadyRunning: true };
  activeArticleId = article.id;
  try { return await (isAiImageArticle(article) ? runImageArticle(article, prompt) : runArticle(article, prompt, startupTiming)); }
  finally { if (activeArticleId === article.id) activeArticleId = null; }
}

async function recoverPendingArticle() {
  if (activeArticleId) return;
  const pending = await chrome.runtime.sendMessage({ type: "get-current-article", provider: PROVIDER });
  if (!pending?.ok || !pending.article || activeArticleId) return;
  const article = pending.article;
  activeArticleId = article.id;
  // The special Spark task lookup is recovery-only: a periodic reload records
  // the article before reloading, then the fresh document returns to the
  // content-ai task to collect the already-generated JSON. Normal runs stay
  // on the task currently open in this tab.
  try {
    // Background owns dispatch retries; do not parse an old answer while it
    // is waiting to resend the failed article's prompt.
    if (article.gemini_spark_dispatch_retry_at) return true;
    if (isGeminiSparkPage() && article.prompt_scheduled_at && !article.prompt_sent_at) {
      if (!article.prompt_dispatch_ready) return false;
      await runArticle(article, article.prompt);
      return true;
    }
    if (isGeminiSparkPage() && (isGeminiSparkStallRecovery(article.id) || article.gemini_spark_reload_attempted_at)) {
      reportSystemPhase(article.id, article.runToken, "recovering", "Trang đã tải lại. Đang khôi phục đúng tác vụ Spark để kiểm tra nút Stop và đọc JSON của bài đang xử lý.");
      await ensureGeminiSparkContentTask(article);
    }
    if (isAiImageArticle(article)) {
      const current = latestGeneratedImages();
      const image = await waitForGeneratedImage(current, article.id, 600000, { acceptCurrent: true });
      await completeGeneratedImage(article, image, image.rawResponse);
      return true;
    }
    const current = isGeminiSparkPage() ? latestAssistantResponseIdentity() : latestAssistantResponse();
    const { data, rawResponse, responseSnapshot } = await waitForResponse(
      current, article.id, ARTICLE_WAIT_TIMEOUT_MS, expectedArticleId(article), {
        acceptCurrent: true,
        runToken: article.runToken,
        imageFixArticle: article.sourceType === "facility_image_fix" ? article : null,
        // Once Spark has needed a recovery reload, keep this queue slot owned
        // until its JSON is recovered or the user explicitly stops the run.
        waitUntilJson: Boolean(article.gemini_spark_reload_attempted_at || isGeminiSparkStallRecovery(article.id))
      }
    );
    reportSystemPhase(article.id, article.runToken, "saving-json", "Đã khôi phục JSON hợp lệ đúng ID. Đang nạp kết quả vào tiện ích và gửi lên website.");
    const recoveredData = article.sourceType === "handbook" ? await prepareHandbookOutput(article, data, null, responseSnapshot) : data;
    if (cancelledArticleId === article.id) throw new Error("Đã dừng bài viết.");
    const saved = await chrome.runtime.sendMessage({
      type: "article-complete", articleId: article.id, runToken: article.runToken,
      article: recoveredData, rawResponse: article.sourceType === "handbook" ? undefined : rawResponse
    });
    if (!saved || saved.ok !== true) throw new Error(saved?.error || "Không thể lưu kết quả bài viết.");
    clearGeminiSparkStallRecovery(article.id);
    clearGeminiSparkJsonRetry(article);
    return true;
  } catch (error) {
    if (error?.code === "gemini-spark-reload" || error?.code === "gemini-spark-navigation") return;
    if (error?.code === "gemini-spark-invalid-json") {
      try {
        if (await retryGeminiSparkArticle(article, article.prompt)) {
          await runArticle(article, article.prompt);
          return true;
        }
      } catch (retryError) {
        error = retryError;
      }
    }
    const mustKeepRecovering = Boolean(article.gemini_spark_reload_attempted_at || isGeminiSparkStallRecovery(article.id));
    if (mustKeepRecovering && error?.message !== "Đã dừng bài viết." && error?.code !== "gemini-spark-invalid-json") {
      // A recovery read is not allowed to fail the queue slot: Spark may still
      // be hydrating the completed answer after navigation. Reattach to this
      // exact current job and retry the DOM read; never advance to another one.
      const pendingAgain = await chrome.runtime.sendMessage({ type: "get-current-article", provider: PROVIDER }).catch(() => null);
      if (String(pendingAgain?.article?.id) === String(article.id)) {
        clearTimeout(recoveryRetryTimer);
        recoveryRetryTimer = setTimeout(() => {
          recoveryRetryTimer = null;
          recoverPendingArticle().catch(() => {});
        }, 10000);
        return true;
      }
    }
    await chrome.runtime.sendMessage({
      type: "article-failed", articleId: article.id, runToken: article.runToken,
      error: error.message, rawResponse: error.rawResponse
    }).catch(() => {});
  } finally {
    if (activeArticleId === article.id) activeArticleId = null;
  }
}

// Small, DOM-readable diagnostics: never store prompt text or response JSON.
function sparkPromptTiming(stats, phase) {
  try {
    document.documentElement?.setAttribute?.("data-medreview-spark-prompt-timing", JSON.stringify({ ...stats, phase, updatedAt: Date.now() }));
  } catch {}
}

async function runArticle(article, prompt, startupTiming) {
  cancelledArticleId = null;
  let timing = startupTiming;
  while (true) {
    try {
      return await runArticleAttempt(article, prompt, timing);
    } catch (error) {
      if (!["gemini-spark-invalid-json", "gemini-spark-send-failed"].includes(error?.code)) throw error;
      reportSystemPhase(article.id, article.runToken, "retrying", `Lần xử lý vừa rồi chưa thành công: ${error.message} Sẽ gửi lại prompt của chính bài này sau 5 giây.`);
      if (!await retryGeminiSparkArticle(article, prompt)) throw error;
      timing = undefined;
    }
  }
}

let lastSystemPhaseKey = "";
function reportSystemPhase(articleId, runToken, phase, detail) {
  if (!runToken) return;
  const key = `${articleId}:${runToken}:${phase}:${detail}`;
  if (key === lastSystemPhaseKey) return;
  lastSystemPhaseKey = key;
  try { Promise.resolve(chrome.runtime.sendMessage({ type: "article-system-notice", articleId, runToken, phase, detail })).catch(() => {}); } catch {}
}

async function runArticleAttempt(article, prompt, startupTiming) {
  const handbookImages = article.sourceType === "handbook" ? latestGeneratedImages() : null;
  if (handbookImages) handbookImages.nodes = new Set(generatedImageResponseNodes());
  clearJsonFormatRetryState(article.id, article.runToken);
  try { sessionStorage.removeItem(`${IMAGE_FIX_REPLACEMENT_RETRY_STORAGE_PREFIX}${jsonFormatRetryKey(article.id, article.runToken)}`); } catch {}
  const spark = isGeminiSparkPage();
  const receivedAt = Date.now();
  const timing = { ...startupTiming, receivedAt, promptChars: String(prompt || "").length };
  if (startupTiming?.dispatchAt) timing.deliveryMs = receivedAt - startupTiming.dispatchAt;
  if (spark) sparkPromptTiming(timing, "finding-composer");
  reportSystemPhase(article.id, article.runToken, "finding-input", "Đang tìm ô nhập prompt trên tab AI" + (spark ? " ở thanh bên phải của Spark." : "."));
  const input = await prepareArticleInput(article);
  timing.findComposerMs = Date.now() - receivedAt;
  // Capture only the latest response's identity before inserting the prompt.
  // Reading its full text here can force layout on Spark's large history.
  const previous = isGeminiSparkPage() ? latestAssistantResponseIdentity() : latestAssistantResponse();
  const outgoingPrompt = promptForProvider(prompt, article);
  if (spark) {
    await yieldSparkComposerFrame();
    if (cancelledArticleId === article.id) throw new Error("Đã dừng bài viết.");
  }
  const insertStartedAt = Date.now();
  if (spark) sparkPromptTiming(timing, "inserting-prompt");
  reportSystemPhase(article.id, article.runToken, "filling", `Đang điền toàn bộ prompt (${outgoingPrompt.length.toLocaleString("vi-VN")} ký tự) vào ô nhập, sau đó kiểm tra nút Gửi.`);
  setInputValue(input, outgoingPrompt);
  timing.insertMs = Date.now() - insertStartedAt;
  if (spark) {
    await yieldSparkComposerFrame();
    if (cancelledArticleId === article.id) throw new Error("Đã dừng bài viết.");
  }
  let sendStartedAt = Date.now();
  if (spark) sparkPromptTiming(timing, "waiting-send");
  if (PROVIDER === "chatgpt") {
    reportSystemPhase(article.id, article.runToken, "verifying-input", "Đã điền prompt; đang đợi ChatGPT cập nhật xong nội dung trong ô soạn trước khi gửi.");
    if (!await waitForPromptInComposer(input, outgoingPrompt, 20000)) {
      throw new Error("ChatGPT chưa nhận đủ prompt vào ô chat sau 20 giây; tiện ích chưa bấm Gửi. Hãy tải lại tab rồi thử lại.");
    }
  } else if (!isGeminiSparkPage()) {
    await delay(250);
  }
  if (spark && article.prompt_scheduled_at && !article.prompt_sent_at) {
    const ready = await chrome.runtime.sendMessage({ type: "article-prompt-prepared", articleId: article.id, runToken: article.runToken });
    if (ready?.ok === false) throw new Error("Đã dừng bài viết.");
    sparkPromptTiming(timing, "waiting-countdown");
    reportSystemPhase(article.id, article.runToken, "waiting-send", "Prompt đã điền sẵn. Đang đợi hết thời gian giữa hai bài để bấm Gửi.");
    const countdownStartedAt = Date.now();
    await waitForSparkSendDeadline(article.prompt_scheduled_at, article.id, input);
    timing.countdownMs = Date.now() - countdownStartedAt;
    if (sparkComposerText(input).replace(/\r\n/g, "\n").trim() !== outgoingPrompt.replace(/\r\n/g, "\n").trim()) {
      throw new Error("Prompt trong ô Spark đã thay đổi trong lúc đếm ngược; chưa bấm Gửi.");
    }
    sendStartedAt = Date.now();
    sparkPromptTiming(timing, "waiting-send");
  }
  reportSystemPhase(article.id, article.runToken, "sending", "Đang tìm nút Gửi và gửi prompt đã điền. Chờ tab AI xác nhận thao tác gửi.");
  const sent = await submitPrompt(input);
  timing.submitMs = Date.now() - sendStartedAt;
  timing.totalMs = Date.now() - (startupTiming?.startedAt || receivedAt);
  if (spark) sparkPromptTiming(timing, sent ? "sent" : "send-failed");
  if (!sent) {
    const error = new Error("Không tìm thấy nút Gửi. Hãy đăng nhập và mở cuộc trò chuyện mới.");
    if (spark) error.code = "gemini-spark-send-failed";
    throw error;
  }
  if (spark) {
    // A resend starts a new cycle; a reload marker from this same article's
    // previous attempt must not reload the newly submitted prompt immediately.
    clearGeminiSparkStallRecovery(article.id);
    const started = await chrome.runtime.sendMessage({ type: "article-prompt-sent", articleId: article.id, runToken: article.runToken });
    if (started?.ok === false) throw new Error("Đã dừng bài viết.");
    article.prompt_sent_at = new Date().toISOString();
    delete article.prompt_scheduled_at;
    delete article.prompt_dispatch_ready;
  }
  const expected = expectedArticleId(article);
  reportSystemPhase(article.id, article.runToken, "waiting-ai", spark ? "Đã gửi prompt. Kiểm tra nút Stop mỗi giây; khi AI đang viết, chưa quét JSON." : "Đã gửi prompt. Đang chờ AI hoàn tất câu trả lời.");
  if (handbookImages) reportSystemPhase(article.id, article.runToken, "writing-images", "Đang chờ nội dung Cẩm nang và ảnh minh hoạ thật từ công cụ AI.");
  let response = await waitForResponse(previous, article.id, ARTICLE_WAIT_TIMEOUT_MS, expected, {
    runToken: article.runToken, imagePrevious: handbookImages,
    imageFixArticle: article.sourceType === "facility_image_fix" ? article : null
  });
  if (handbookImages && response.directImage) {
    await waitForHandbookIdle(article.id, article.runToken);
    const generated = freshHandbookImages(handbookImages);
    if (!generated.length) throw MedReviewHandbook.error("missing_images", "Không xác định được file minh hoạ thuộc đúng bài Cẩm nang.");
    const previousJson = latestAssistantResponse();
    let followup = await waitForInput();
    const followupPrompt = handbookJsonAfterImagesPrompt(article, generated.length);
    setInputValue(followup, followupPrompt);
    if (PROVIDER === "chatgpt" && !await waitForPromptInComposer(followup, followupPrompt, 20000)) throw new Error("Chưa điền đủ yêu cầu nhận HTML Cẩm nang.");
    followup = await waitForHandbookIdle(article.id, article.runToken, followup);
    if (!await submitPrompt(followup)) throw new Error("Không gửi được yêu cầu nhận JSON Cẩm nang sau tạo ảnh.");
    response = await waitForResponse(previousJson, article.id, ARTICLE_WAIT_TIMEOUT_MS, expected, { runToken: article.runToken });
    handbookImages.bound = generated;
  }
  const { data, rawResponse } = response;
  const completedData = article.sourceType === "handbook" ? await prepareHandbookOutput(article, data, handbookImages, response.responseSnapshot) : data;
  if (cancelledArticleId === article.id) throw new Error("Đã dừng bài viết.");
  reportSystemPhase(article.id, article.runToken, "saving-json", "JSON đã hợp lệ và đúng ID bài. Đang chuyển kết quả về tiện ích để lưu và gửi lên website.");
  const saved = await chrome.runtime.sendMessage({ type: "article-complete", articleId: article.id, runToken: article.runToken,
    article: completedData, rawResponse: article.sourceType === "handbook" ? undefined : rawResponse });
  if (!saved || saved.ok !== true) throw new Error(saved?.error || "Không thể lưu kết quả bài viết.");
  clearGeminiSparkStallRecovery(article.id);
  clearGeminiSparkJsonRetry(article);
  return { ok: true, article: data };
}

async function prepareArticleInput(article) {
  // Do not depend on ChatGPT's optional composer tools. Find the live composer
  // directly, fill it, verify the prompt landed, and then submit it.
  return waitForInput();
}

async function waitForSparkSendDeadline(deadline, articleId, input) {
  const until = Date.parse(deadline);
  if (!Number.isFinite(until)) throw new Error("Mốc gửi prompt Spark không hợp lệ; chưa bấm Gửi.");
  while (Date.now() < until) {
    if (cancelledArticleId === articleId) throw new Error("Đã dừng bài viết.");
    if (input?.isConnected === false) throw new Error("Ô nhập Spark đã thay đổi; chưa bấm Gửi.");
    await new Promise((resolve) => {
      let finished = false;
      let timer;
      const wake = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (sparkSendCountdownWake?.wake === wake) sparkSendCountdownWake = null;
        resolve();
      };
      sparkSendCountdownWake = { articleId, wake };
      timer = setTimeout(wake, Math.min(250, until - Date.now()));
    });
  }
  if (cancelledArticleId === articleId) throw new Error("Đã dừng bài viết.");
  if (input?.isConnected === false) throw new Error("Ô nhập Spark đã thay đổi; chưa bấm Gửi.");
}

function isGeminiSparkPage() {
  if (PROVIDER !== "gemini") return false;
  const path = String(location.pathname || "").toLowerCase();
  if (/(?:^|\/)spark(?:\/|$)/i.test(path)) return true;
  if (typeof document?.querySelector === "function") {
    if (document.querySelector(".right-pane, [data-test-id='remy-split-pane'], [data-test-id='remy-left-pane'], chat-window, .simplified-input-area")) {
      return true;
    }
  }
  return false;
}

function isGeminiSparkContentTask() {
  const currentTaskId = extractGeminiSparkTaskId(location.pathname);
  const task = findGeminiSparkContentTask();
  return Boolean(currentTaskId && task?.taskId && currentTaskId === task.taskId);
}

function geminiSparkReloadError() {
  const error = new Error("Đã đến chu kỳ 10 phút; đang tải lại Gemini Spark để kiểm tra kết quả.");
  error.code = "gemini-spark-reload";
  return error;
}

function isGeminiSparkStallRecovery(articleId) {
  try {
    const marker = JSON.parse(globalThis.sessionStorage?.getItem(GEMINI_SPARK_RELOAD_STORAGE_KEY) || "null");
    return marker?.articleId != null && String(marker.articleId) === String(articleId);
  } catch { return false; }
}

function clearGeminiSparkStallRecovery(articleId) {
  try {
    const storage = globalThis.sessionStorage;
    const marker = JSON.parse(storage?.getItem(GEMINI_SPARK_RELOAD_STORAGE_KEY) || "null");
    if (marker?.articleId != null && String(marker.articleId) === String(articleId)) {
      storage.removeItem(GEMINI_SPARK_RELOAD_STORAGE_KEY);
    }
  } catch {}
}

function claimGeminiSparkJsonRetry(article) {
  if (!isGeminiSparkPage() || !article?.id) return false;
  const key = `${SPARK_JSON_RETRY_STORAGE_PREFIX}${String(article.id)}:${String(article.runToken || "")}`;
  try {
    const count = Math.max(0, Number(sessionStorage.getItem(key)) || 0);
    const nextCount = count + 1;
    sessionStorage.setItem(key, String(nextCount));
    return nextCount;
  } catch { return false; }
}

async function retryGeminiSparkArticle(article, prompt) {
  if (cancelledArticleId === article.id) throw new Error("Đã dừng bài viết.");
  const retryCount = claimGeminiSparkJsonRetry(article);
  if (!retryCount) {
    await Promise.resolve(chrome.runtime?.sendMessage?.({
      type: "article-retry-countdown",
      articleId: article.id,
      runToken: article.runToken,
      clear: true
    })).catch(() => {});
    return false;
  }
  const retryAt = Date.now() + GEMINI_SPARK_JSON_RETRY_DELAY_MS;
  await Promise.resolve(chrome.runtime?.sendMessage?.({
    type: "article-retry-countdown",
    articleId: article.id,
    runToken: article.runToken,
    retryCount,
    retryAt
  })).catch(() => {});
  await delay(GEMINI_SPARK_JSON_RETRY_DELAY_MS);
  if (cancelledArticleId === article.id) throw new Error("Đã dừng bài viết.");
  if (chrome.runtime?.id) {
    const pending = await chrome.runtime.sendMessage({ type: "get-current-article", provider: PROVIDER });
    if (!pending?.ok || String(pending.article?.id) !== String(article.id) || pending.article?.runToken !== article.runToken) {
      throw new Error("Đã dừng bài viết.");
    }
  }
  await Promise.resolve(chrome.runtime?.sendMessage?.({
    type: "article-retry-countdown",
    articleId: article.id,
    runToken: article.runToken,
    clear: true
  })).catch(() => {});
  return true;
}

function clearGeminiSparkJsonRetry(article) {
  if (!article?.id) return;
  try {
    sessionStorage.removeItem(`${SPARK_JSON_RETRY_STORAGE_PREFIX}${String(article.id)}:${String(article.runToken || "")}`);
  } catch {}
  Promise.resolve(chrome.runtime?.sendMessage?.({
    type: "article-retry-countdown",
    articleId: article.id,
    runToken: article.runToken,
    clear: true
  })).catch(() => {});
}

function geminiSparkLastReloadAt(articleId) {
  try {
    const marker = JSON.parse(sessionStorage.getItem(GEMINI_SPARK_RELOAD_STORAGE_KEY) || "null");
    return String(marker?.articleId) === String(articleId) ? Number(marker.at) || 0 : 0;
  } catch { return 0; }
}

async function reloadGeminiSparkForStall(articleId, runToken) {
  if (!isGeminiSparkPage() || typeof location.reload !== "function") return false;
  const now = Date.now();
  let previous = null;
  try {
    const storage = globalThis.sessionStorage;
    const raw = storage?.getItem(GEMINI_SPARK_RELOAD_STORAGE_KEY);
    previous = raw ? JSON.parse(raw) : null;
  } catch {}
  const sameArticle = String(previous?.articleId ?? geminiSparkReloadArticleId ?? "") === String(articleId);
  const previousAt = Number(previous?.at ?? geminiSparkReloadAt ?? 0);
  if (sameArticle && previousAt > 0 && now - previousAt < GEMINI_SPARK_RELOAD_COOLDOWN_MS) return false;

  // Persist the reload owner before navigating. The independent MV3 alarm
  // shares this marker, preventing two reloads if both watchdogs fire together.
  let reloadClaim = null;
  try {
    if (typeof chrome.runtime?.sendMessage === "function") {
      reloadClaim = await chrome.runtime.sendMessage({
        type: "mark-gemini-spark-stall-reload",
        articleId,
        runToken,
        reloadSource: "content"
      });
    }
  } catch {}
  if (reloadClaim?.ok === false) return false;
  if (reloadClaim?.ok === true && reloadClaim.reload === false) {
    // A false claim can mean the alarm already owns a reload, or that the
    // shared cooldown has not elapsed. Do not pretend navigation is underway;
    // keep watching this same answer and let the watchdog retry when eligible.
    return false;
  }

  geminiSparkReloadAt = now;
  geminiSparkReloadArticleId = articleId;
  try { globalThis.sessionStorage?.setItem(GEMINI_SPARK_RELOAD_STORAGE_KEY, JSON.stringify({ articleId, at: now })); } catch {}
  try {
    let targetUrl = null;
    try {
      const rawTask = globalThis.sessionStorage?.getItem(`${SPARK_TASK_STORAGE_PREFIX}${articleId}`);
      if (rawTask) targetUrl = JSON.parse(rawTask)?.url;
    } catch {}
    if (targetUrl && location.href !== targetUrl && typeof location.assign === "function") {
      location.assign(targetUrl);
      return true;
    }
    location.reload();
    return true;
  } catch {
    return false;
  }
}

const SPARK_TASK_STORAGE_PREFIX = "medreview-spark-task-";

function sparkAccountPrefix(urlOrPath = location.pathname) {
  const match = String(urlOrPath || "").match(/^(\/u\/\d+)/);
  return match ? match[1] : "";
}

function extractGeminiSparkTaskId(urlOrPath) {
  const match = String(urlOrPath || "").match(/\/spark\/chat\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function isGeminiSparkContentTaskText(text) {
  const normalized = normalizeSearchText(text).replace(/\s+/g, " ").trim();
  // Spark concatenates the task title and its status with no whitespace
  // (e.g. "content aiĐang thực hiện…"), so match the visible title prefix.
  return normalized.startsWith(GEMINI_SPARK_CONTENT_TASK_LABEL);
}

function normalizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^(?:co so|toplist|anh ai)\s*·?\s*/i, "")
    .trim();
}

function getSparkSidebarCandidates() {
  const elements = [
    ...document.querySelectorAll("a[href*='/spark/chat/'], a[href*='/spark/']"),
    ...document.querySelectorAll("bard-sidenav [role='button'], bard-side-nav [role='button'], nav [role='button'], aside [role='button'], [role='navigation'] [role='button']"),
    ...document.querySelectorAll("div.conversation-item, .chat-history-item, [data-test-id*='conversation']"),
    // Current Spark goal rows are custom elements whose only stable hook is
    // id="goal-c_<conversationId>" (no anchor/role attribute).
    ...document.querySelectorAll("[id^='goal-c_'], [id^='goal-c-'], [data-goal-id], [data-task-id], [data-conversation-id]"),
    // Live Spark history rows are often role=option without an <a href>.
    ...document.querySelectorAll("[role='option'], [role='listbox'] [role='option'], [role='listbox'] [role='button']")
  ];
  const unique = [];
  const seen = new Set();
  for (const el of elements) {
    if (!el || seen.has(el)) continue;
    const text = String(el.textContent || "").trim();
    // Skip top nav entries captured in the live dump (Tasks / Schedules / Skills / Apps).
    if (/^(?:tasks|lịch biểu|kỹ năng|các ứng dụng|schedules|skills|apps)\b/i.test(text) && text.length < 48) continue;
    seen.add(el);
    unique.push(el);
  }
  return unique;
}

function getTaskIdFromElement(el) {
  if (!el) return null;
  const link = el.matches?.("a[href]") ? el : el.querySelector?.("a[href]");
  const href = link?.getAttribute?.("href") || link?.href || el.getAttribute?.("data-href") || el.getAttribute?.("href");
  if (href) {
    const match = String(href).match(/\/spark\/chat\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
  }
  const explicit = el.getAttribute?.("data-task-id") || el.getAttribute?.("data-conversation-id") || el.getAttribute?.("data-goal-id");
  if (explicit) return String(explicit).replace(/^goal-c[_-]/i, "");
  // Live Spark rows commonly expose only id="goal-c_<conversationId>".
  const idValues = [el.id, el.getAttribute?.("id"), el.closest?.("[id^='goal-c_'], [id^='goal-c-']")?.id].filter(Boolean);
  for (const value of idValues) {
    const match = String(value).match(/^goal-c[_-]([a-zA-Z0-9_-]+)/i);
    if (match) return match[1];
  }
  return null;
}

function getTaskUrlFromElement(el, taskId) {
  const link = el?.matches?.("a[href]") ? el : el?.querySelector?.("a[href]");
  const href = link?.getAttribute?.("href") || link?.href;
  if (href && href.includes("/spark/chat/")) {
    return href.startsWith("http") ? href : `https://gemini.google.com${href.startsWith("/") ? "" : "/"}${href}`;
  }
  return taskId ? `https://gemini.google.com${sparkAccountPrefix()}/spark/chat/${taskId}` : null;
}

function findGeminiSparkContentTask() {
  if (!isGeminiSparkPage()) return null;
  const currentTaskId = extractGeminiSparkTaskId(location.pathname);
  const matches = getSparkSidebarCandidates()
    .map((element) => ({ element, taskId: getTaskIdFromElement(element), text: String(element.textContent || "") }))
    .filter((entry) => entry.taskId && isGeminiSparkContentTaskText(entry.text));
  // Parent rows and nested labels can both be returned by the live DOM. Use
  // the current row first, otherwise prefer the smallest matching row.
  const current = matches.find((entry) => entry.taskId === currentTaskId);
  const match = current || matches.sort((left, right) => left.text.length - right.text.length)[0];
  if (!match) return null;
  return { taskId: match.taskId, url: getTaskUrlFromElement(match.element, match.taskId), element: match.element };
}

async function resolveGeminiSparkContentTask() {
  if (!isGeminiSparkPage()) return { ok: false, error: "Tab Gemini hiện tại không phải Gemini Spark." };
  const task = findGeminiSparkContentTask();
  if (!task?.taskId || !task.url) {
    return { ok: false, error: `Không tìm thấy task Gemini Spark “${GEMINI_SPARK_CONTENT_TASK_LABEL}”. Hãy mở task đó trong thanh bên rồi thử lại.` };
  }
  return {
    ok: true,
    taskId: task.taskId,
    url: task.url,
    currentTaskId: extractGeminiSparkTaskId(location.pathname),
    onTask: extractGeminiSparkTaskId(location.pathname) === task.taskId
  };
}

function geminiSparkNavigationError() {
  const error = new Error(`Đang mở task Gemini Spark “${GEMINI_SPARK_CONTENT_TASK_LABEL}”…`);
  error.code = "gemini-spark-navigation";
  return error;
}

async function ensureGeminiSparkContentTask(article = null) {
  if (!isGeminiSparkPage()) return null;
  const currentTaskId = extractGeminiSparkTaskId(location.pathname);
  let savedTask = null;
  try { savedTask = JSON.parse(globalThis.sessionStorage?.getItem(`${SPARK_TASK_STORAGE_PREFIX}${article?.id}`) || "null"); } catch {}
  savedTask = {
    ...(savedTask || {}),
    ...(article?.sparkTaskId ? { taskId: article.sparkTaskId } : {}),
    ...(article?.sparkChatUrl ? { url: article.sparkChatUrl } : {})
  };

  // On a reload Spark may not have hydrated its sidebar yet. The worker's
  // persisted task ID (or the per-article session marker) is authoritative;
  // if this document is already on that exact conversation, don't fail
  // recovery just because the sidebar DOM is temporarily empty.
  if (currentTaskId && savedTask?.taskId && currentTaskId === savedTask.taskId) {
    const url = savedTask.url || location.href;
    if (article?.id) {
      await persistSparkTask(article.id, currentTaskId, url);
      const bound = await chrome.runtime.sendMessage({
        type: "bind-spark-task",
        articleId: article.id,
        runToken: article.runToken,
        sparkTaskId: currentTaskId,
        sparkChatUrl: url
      });
      if (!bound?.ok) throw new Error(bound?.error || "Không thể ràng buộc task Gemini Spark content ai.");
    }
    return { ok: true, taskId: currentTaskId, url, currentTaskId, onTask: true };
  }

  const resolved = await resolveGeminiSparkContentTask();
  if (!resolved?.ok) throw new Error(resolved?.error || "Không tìm thấy task Gemini Spark content ai.");
  if (article?.id && resolved.taskId) {
    await persistSparkTask(article.id, resolved.taskId, resolved.url);
    const bound = await chrome.runtime.sendMessage({
      type: "bind-spark-task",
      articleId: article.id,
      runToken: article.runToken,
      sparkTaskId: resolved.taskId,
      sparkChatUrl: resolved.url
    });
    if (!bound?.ok) throw new Error(bound?.error || "Không thể ràng buộc task Gemini Spark content ai.");
  }
  if (!resolved.onTask) {
    if (typeof location.assign !== "function") throw new Error("Không thể mở task Gemini Spark content ai.");
    location.assign(resolved.url);
    throw geminiSparkNavigationError();
  }
  return resolved;
}

function findSparkSidebarTask(articleOrTitle) {
  if (!isGeminiSparkPage()) return null;
  const candidates = getSparkSidebarCandidates();
  if (!candidates.length) return null;

  const rawTitle = typeof articleOrTitle === "string" ? articleOrTitle : articleOrTitle?.title || articleOrTitle?.name;
  const cleanTitle = normalizeSearchText(rawTitle);

  // 1. Match by article keywords in sidebar title (e.g. "Kim", "Dong Nam", "Elite Dental")
  if (cleanTitle) {
    const keywords = cleanTitle.split(/\s+/).filter((w) => w.length >= 2);
    const match = candidates.find((el) => {
      const text = normalizeSearchText(el.textContent);
      return text.includes(cleanTitle);
    }) || candidates.find((el) => {
      const text = normalizeSearchText(el.textContent);
      return keywords.length > 1 && keywords.every((w) => text.includes(w));
    });
    if (match) {
      const taskId = getTaskIdFromElement(match);
      const url = getTaskUrlFromElement(match, taskId);
      return { taskId, url, element: match };
    }
  }

  // 2. Fallback: look for the newest item in sidebar with "Vừa xong" or "Đang"
  for (const el of candidates) {
    const taskId = getTaskIdFromElement(el);
    if (taskId && sparkJobInitialTaskId && taskId === sparkJobInitialTaskId) continue;
    const text = String(el.textContent || "");
    if (/vừa xong|đang thực hiện|đang biên soạn|đang nghiên cứu|đang xử lý|đang xác thực|đang điều tra|đang thu thập|tổng hợp thành công/i.test(text)) {
      const url = getTaskUrlFromElement(el, taskId);
      return { taskId, url, element: el };
    }
  }

  // 3. Fallback to the top candidate whose taskId is not the initial old task
  for (const el of candidates) {
    const taskId = getTaskIdFromElement(el);
    if (taskId && (!sparkJobInitialTaskId || taskId !== sparkJobInitialTaskId)) {
      const url = getTaskUrlFromElement(el, taskId);
      return { taskId, url, element: el };
    }
  }
  return null;
}

async function persistSparkTask(articleId, taskId, url) {
  if (!articleId || !taskId) return;
  try {
    globalThis.sessionStorage?.setItem(`${SPARK_TASK_STORAGE_PREFIX}${articleId}`, JSON.stringify({ taskId, url }));
  } catch {}
  await chrome.runtime.sendMessage({
    type: "save-task-meta",
    articleId,
    sparkTaskId: taskId,
    sparkChatUrl: url
  }).catch(() => {});
}

async function captureGeminiSparkTask(articleId, articleOrTitle) {
  if (!isGeminiSparkPage() || !articleId) return null;
  const currentTaskId = extractGeminiSparkTaskId(location.pathname);
  if (currentTaskId) {
    await persistSparkTask(articleId, currentTaskId, location.href);
    return { taskId: currentTaskId, url: location.href };
  }
  const sidebarTask = findSparkSidebarTask(articleOrTitle);
  if (sidebarTask?.taskId) {
    await persistSparkTask(articleId, sidebarTask.taskId, sidebarTask.url);
    return sidebarTask;
  }
  return null;
}

function needsFencedJsonContract() {
  return PROVIDER === "grok" || isGeminiSparkPage();
}

function needsStrictJsonResponse(expectedId) {
  return ["doctor", "handbook", "facility_image_fix"].includes(expectedId?.sourceType);
}

function responseHasJsonCodeBlock(snapshot, expectedId) {
  if (needsStrictJsonResponse(expectedId)) {
    const parsed = parseStrictJsonResponse(snapshot, expectedId);
    return Boolean(parsed?.idMatched);
  }
  const fencePattern = /^[ \t]*(`{3,}|~{3,})[ \t]*json\b[^\n]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gim;
  for (const source of snapshot?.sources || []) {
    for (const match of String(source || "").matchAll(fencePattern)) {
      const data = extractJson(match[2], expectedId);
      if (data !== null && (expectedId == null || jsonMatchesExpectedId(data, expectedId))) return true;
    }
  }

  // Markdown renderers remove the literal ```json markers from visible text.
  // ChatGPT defers its highlighted <pre> until the block enters the viewport;
  // the offscreen <div><code> representation is already a complete code block.
  const responseNode = snapshot?.node;
  const blocks = PROVIDER === "chatgpt" ? chatgptResponseCodeBlocks(responseNode) : [
    ...(responseNode?.matches?.("pre") ? [responseNode] : []),
    ...(responseNode?.querySelectorAll?.("pre") || [])
  ];
  for (const block of blocks) {
    const code = block.querySelector?.("code");
    const data = extractJson(code?.textContent || block.textContent || "", expectedId);
    if (data !== null && (expectedId == null || jsonMatchesExpectedId(data, expectedId))) return true;
  }
  return false;
}

function jsonFormatRetryKey(articleId, runToken) {
  return `${JSON_FORMAT_RETRY_STORAGE_PREFIX}${String(articleId)}:${String(runToken || "")}`;
}

function responseSignatureHash(signature) {
  let hash = 2166136261;
  const value = String(signature || "");
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${hash >>> 0}`;
}

function readJsonFormatRetryState(articleId, runToken) {
  try {
    const value = sessionStorage.getItem(jsonFormatRetryKey(articleId, runToken));
    return value ? JSON.parse(value) : null;
  } catch { return null; }
}

function saveJsonFormatRetryState(articleId, runToken, snapshot) {
  const state = {
    id: String(snapshot?.id || ""),
    count: Number(snapshot?.count || 0),
    signatureHash: responseSignatureHash(snapshot?.signature)
  };
  try { sessionStorage.setItem(jsonFormatRetryKey(articleId, runToken), JSON.stringify(state)); } catch {}
  return state;
}

function clearJsonFormatRetryState(articleId, runToken) {
  try { sessionStorage.removeItem(jsonFormatRetryKey(articleId, runToken)); } catch {}
}

function handbookInlineJsonRules() {
  return [
    "ĐẦU RA CẨM NANG BẮT BUỘC: MỘT block ```json chứa toàn bộ JSON GỌN ngay trong chat; KHÔNG CHÉP BASE64 DÀI VÀO CHAT. Ngoài block chỉ đính kèm các link tải link1_base64.txt, link2_base64.txt... thật.",
    "Không dùng file .json, link Tải JSON hoàn chỉnh, Canvas hoặc artifact thay block code. Dù đã tạo file JSON, vẫn in JSON đầy đủ với HTML, nguồn, id và language; JSON-escape đúng, không rút gọn nội dung hay chèn dấu ... .",
    'Sau khi ảnh tạo xong, dùng chương trình đọc bytes file PNG/JPEG/WebP gốc, mã hoá BASE64 và GHI FILE linkN_base64.txt thật. Mỗi TXT chỉ chứa một data:image/png;base64,... hoặc image/jpeg hay image/webp đầy đủ. Không Markdown, URL tạm, placeholder hay BASE64 viết tay.',
    'Trong content_html dùng src="link1", src="link2"... (1–4 ảnh). Thêm image_files:[{"key":"link1","filename":"link1_base64.txt","mime":"image/webp","bytes":20392,"sha256":"64 ký tự hex thường"}]. Đây chỉ là mẫu cấu trúc: tính MIME/bytes/SHA-256 của BYTES ẢNH GỐC bằng chương trình, không sao chép số mẫu, không tính hash văn bản TXT/BASE64. Mỗi src có đúng một mục và file tương ứng, không thừa/thiếu/trùng.',
    "Đợi tạo ảnh VÀ ghi TXT xong rồi mới xuất JSON gọn; dưới block đặt link tải thật từng linkN_base64.txt của CHÍNH CÂU TRẢ LỜI NÀY. sandbox:/mnt/data chỉ được dùng làm link tải file thật bên ngoài JSON, không dùng trong src. File ẢNH thật được đính kèm thêm. Thiếu khả năng ghi file/hash thì báo chưa hoàn tất, không bịa.",
    "Tiện ích đọc TXT hiện tại, xác minh số bytes, SHA-256 và giải mã raster rồi thay linkN bằng data URI thật, LOẠI image_files trước POST. API không nhận trực tiếp linkN/TXT/sandbox/image_files. BASE64 thật hoặc URL HTTP(S) ảnh công khai trực tiếp từ luồng cũ vẫn tương thích. Không URL tạm hay trang HTML trong payload cuối.",
    "Chỉ dùng handbook-image:N dự phòng khi tiện ích đã chỉ định đúng các file ảnh thật. NHẮC LẠI: JSON GỌN TRONG MỘT BLOCK CODE + các file linkN_base64.txt RIÊNG, không chép chuỗi BASE64 dài vào chat."
  ].join("\n");
}

function handbookPromptWithInlineJson(prompt) {
  const rules = handbookInlineJsonRules();
  return [rules, String(prompt ?? ""), rules].join("\n\n");
}

function handbookJsonAfterImagesPrompt(article, count) {
  return handbookPromptWithInlineJson([
    `Đã nhận ${count} file minh hoạ do công cụ tạo cho bài Cẩm nang id ${article.handbook_id}, language ${article.language}.`,
    "Hãy trả TOÀN BỘ JSON cuối cùng theo đúng schema trong yêu cầu trước, giữ nội dung đầy đủ. Không bịa BASE64 và không tạo lại ảnh.",
    `Dùng chương trình ghi ${count} file link1_base64.txt đến link${count}_base64.txt từ chính bytes ảnh vừa tạo; tính bytes/SHA-256, khai báo image_files và src="link1" đến src="link${count}". Đính kèm các TXT thật trong chính câu trả lời mới này, không chỉ trỏ về lượt trước.`,
    "Không trả file JSON hay tóm tắt hoàn thành. In JSON gọn trong một block code json và đặt các link TXT thật bên dưới; không token hoặc revision, không in BASE64 dài."
  ].join("\n"));
}

function jsonFormatRetryPrompt(expectedId) {
  const expected = expectedId?.sourceType === "translation"
    ? expectedId.source_id
    : ["toplist", "doctor", "facility_image_fix", "handbook"].includes(expectedId?.sourceType) ? expectedId.id : expectedId;
  const identity = expected == null ? "đúng bài đang xử lý" : `bài có ID ${expected}`;
  const prompt = [
    "Yêu cầu bổ sung: Phản hồi vừa rồi chưa có JSON hợp lệ trong một khối code JSON.",
    `Hãy gửi lại TOÀN BỘ JSON cuối cùng của ${identity}, giữ nguyên đầy đủ tất cả trường và giá trị đã tạo; không rút gọn, không thêm/bớt dữ liệu${expected == null ? "." : `; trường ID phải khớp ${expected}.`}`,
    ...(expectedId?.sourceType === "doctor" ? [`Giữ id là số nguyên JSON dương và name chính xác là ${JSON.stringify(expectedId.name)}; không thay tên bác sĩ, không thêm khóa bảo mật.`] : []),
    ...(expectedId?.sourceType === "facility_image_fix" ? [`Giữ id là số nguyên JSON dương và images_revision chính xác là ${JSON.stringify(expectedId.images_revision)}; không thay revision, không tạo ảnh AI và không thêm khóa bảo mật.`] : []),
    ...(expectedId?.sourceType === "handbook" ? [`Giữ language chính xác là ${JSON.stringify(expectedId.language)}. Không dùng link tải/file JSON thay block; in toàn bộ JSON gọn ngay trong chat, kể cả khi đã tạo file JSON ở phản hồi trước. Các TXT ảnh phải đính kèm lại ở dưới block.`] : []),
    expectedId?.sourceType === "handbook" ? "Chỉ xuất một block json gọn; bên dưới đính kèm đầy đủ file linkN_base64.txt thật của lượt này và image_files có bytes/hash đúng. Không chép lại BASE64 dài, không chỉ trỏ đến file của lượt trước." : "Chỉ xuất đúng một khối Markdown bắt đầu bằng ```json và kết thúc bằng ```; không viết giải thích ở ngoài khối.",
    "Đảm bảo nội dung bên trong là JSON hợp lệ, mọi dấu ngoặc kép trong chuỗi đều được escape đúng chuẩn JSON."
  ].join("\n");
  return expectedId?.sourceType === "handbook" ? handbookPromptWithInlineJson(prompt) : prompt;
}

async function requestJsonFormatRetry(articleId, expectedId, runToken, snapshot, promptOverride = null) {
  if (expectedId?.sourceType === "handbook") await waitForHandbookIdle(articleId, runToken);
  let input = await waitForInput();
  const prompt = promptOverride || jsonFormatRetryPrompt(expectedId);
  setInputValue(input, prompt);
  if (PROVIDER === "chatgpt") {
    if (!await waitForPromptInComposer(input, prompt, 20000)) {
      throw new Error("ChatGPT chưa nhận đủ yêu cầu định dạng lại JSON sau 20 giây; tiện ích chưa bấm Gửi.");
    }
  } else if (!isGeminiSparkPage()) {
    await delay(250);
  }
  if (expectedId?.sourceType === "handbook") input = await waitForHandbookIdle(articleId, runToken, input);
  if (!await submitPrompt(input)) throw new Error("Không tìm thấy nút Gửi cho yêu cầu định dạng lại JSON.");
  return saveJsonFormatRetryState(articleId, runToken, snapshot);
}

function validReplacementImageUrl(value, image = false) {
  if (typeof value !== "string" || !value || value.length > 8000 || /[\s\u0000-\u001f\\]/.test(value)) return false;
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

function imageFixReviewIsVerifiedKeep(review) {
  if (review?.decision !== "keep" || typeof review.reason !== "string" || !review.reason.trim() || typeof review.evidence_url !== "string" || !review.evidence_url.trim()) return false;
  if (Number.isInteger(review.http_status) && review.http_status >= 400) return false;
  const reason = review.reason.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d");
  return !/timeout|captcha|(?:khong|chua)(?: (?:the|du|truc tiep|co the))* (?:truy cap|xem|xac minh|doi chieu)|(?:unable|cannot|can't) (?:to )?(?:access|view|verify)|not (?:accessible|viewable|verified)|timed out/i.test(reason);
}

function imageFixReplacementSummary(article, result) {
  const images = (Array.isArray(article?.images) ? article.images : []).filter((image) => image && typeof image.url === "string");
  const source = new Set(images.map((image) => image.url));
  const ai = new Set([article?.ai_image_url, ...images.filter((image) => image.fields?.includes("ai_image_url")).map((image) => image.url)].filter(Boolean));
  const inspected = (Array.isArray(result?.inspected_images) ? result.inspected_images : []).filter((image) => image && typeof image.url === "string");
  const removed = inspected.filter((image) => image.decision === "remove").length;
  const kept = new Set(inspected.filter((image) => imageFixReviewIsVerifiedKeep(image) && source.has(image.url) && !ai.has(image.url)).map((image) => image.url));
  const added = new Set((Array.isArray(result?.added_images) ? result.added_images : [])
    .filter((image) => image && validReplacementImageUrl(image.url, true) && typeof image.source === "string" && image.source.trim() && validReplacementImageUrl(image.source_url) && !source.has(image.url) && !ai.has(image.url)).map((image) => image.url));
  const minimum = Number.isInteger(article?.minimum_verified_images) && article.minimum_verified_images > 0 ? article.minimum_verified_images : 0;
  return { removed, kept: kept.size, added: added.size, verified: kept.size + added.size, minimum };
}

function imageFixReplacementPrompt(article, _result, summary) {
  const minimum = summary?.minimum > 0 ? summary.minimum : 5;
  return [
    `Kết quả Fix ảnh ID ${article.facility_id} vừa trả đã có ${summary.removed} ảnh remove, nhưng chỉ có K=${summary.kept} ảnh thật keep đã xác minh và N=${summary.added} ảnh mới; tổng ${summary.verified}/${minimum}, chưa đủ để cập nhật xóa ảnh.`,
    `Hãy TIẾP TỤC ĐIỀU TRA và bổ sung ít nhất ${Math.max(1, minimum - summary.verified)} ảnh thật khác nhau đã xem/xác minh của đúng chi nhánh: ${article.name || article.title || ""}, địa chỉ ${article.address_text || ""}.`,
    "Rà nguồn lần lượt Google Maps đúng địa điểm → Facebook/fanpage đúng cơ sở → trang Giới thiệu/chi nhánh/cơ sở vật chất trên website chính thức → nguồn công khai khác. Không dừng chỉ vì một nguồn không trích được URL.",
    `Đủ tối thiểu ${minimum} nghĩa là ảnh thật nguồn keep đã xác minh có reason và evidence_url thật + ảnh mới hợp lệ; uncertain, ảnh AI, ảnh trùng, ảnh lỗi truy cập hoặc chưa xem/xác minh KHÔNG tính. Không đổi uncertain thành keep chỉ để đủ số lượng, không bịa hoặc tự ghép URL.`,
    `Giữ nguyên id ${article.facility_id}, images_revision ${JSON.stringify(article.images_revision)} và đủ mọi inspected_images của nguồn; không bỏ hay thay URL nguồn. Giữ các ảnh keep hợp lệ, bổ sung vào added_images với URL trực tiếp, source và source_url thật.`,
    "Nếu thực sự vẫn chưa đủ sau khi rà hết nguồn, trả đúng ảnh đã xác minh, insufficient_images=true và notes ghi số thiếu/giới hạn truy cập; tiện ích sẽ giữ kết quả để kiểm tra lại, chưa gửi cập nhật xóa ảnh.",
    "Trả lại TOÀN BỘ JSON kết quả trong đúng một block code json, không chỉ trả phần bổ sung; không tạo ảnh AI và không thêm khóa bảo mật."
  ].join("\n");
}

function promptForProvider(prompt, article = null) {
  const value = String(prompt ?? "");
  // Image investigation is not the AI-image generation or article-writing
  // workflow. Its fresh queue item owns the entire server-rendered prompt.
  if (article?.sourceType === "facility_image_fix") return String(article.prompt ?? value);
  const translation = article?.sourceType === "translation";
  // The translation API builds a record-specific prompt from the complete
  // Vietnamese DB row and the Admin translation prompt. Do not append a
  // generic extension contract that contradicts its {type, source_id,
  // translated} response envelope or drops the source record context.
  // Doctor prompts already contain the complete server-controlled research
  // schema and JSON-block contract. Keep them verbatim on every provider.
  if (translation || article?.sourceType === "doctor") return value;
  // Repeat this locally too: cached server prompts may predate the inline-only
  // contract, and a downloadable JSON file is not an answer the parser can read.
  if (article?.sourceType === "handbook") return handbookPromptWithInlineJson(value);
  const pieces = [value];
  if (!needsFencedJsonContract()) return pieces.filter(Boolean).join("\n");
  // Grok and Spark render unfenced JSON as Markdown. Quotes inside HTML/text
  // values can then be displayed without their JSON escape, making an
  // otherwise complete answer impossible to parse. Keep the API prompt intact,
  // but add a strict output contract for these providers.
  return [
    ...pieces,
    "",
    "QUY ĐỊNH ĐỊNH DẠNG BẮT BUỘC CHO TIỆN ÍCH:",
    "Chỉ trả về đúng một khối code Markdown bắt đầu bằng ```json và kết thúc bằng ```; không viết bất kỳ chữ nào bên ngoài khối đó.",
    "Đây phải là JSON hợp lệ có thể JSON.parse ngay. Mọi dấu ngoặc kép nằm bên trong giá trị chuỗi (đặc biệt HTML/content/review) phải được escape thành \\\"; giữ nguyên các trường dữ liệu khác.",
    ""
  ].join("\n");
}

async function runImageArticle(article, prompt) {
  if (!["chatgpt", "grok"].includes(PROVIDER)) {
    throw new Error("Tạo ảnh AI hiện hỗ trợ ChatGPT hoặc Grok. Hãy mở một tab ChatGPT/Grok để chạy hàng đợi Ảnh AI.");
  }
  cancelledArticleId = null;
  const deadline = Date.now() + 600000;
  const input = await waitForInput();
  // The server prompt is the art-director phase: it returns a tailored English
  // `image_prompt` from the facility data and its 3–4 gallery references.
  // Run that phase first, then explicitly ask the provider to generate the
  // actual image from its returned prompt.
  const planningPrevious = latestAssistantResponse();
  const planningImages = latestGeneratedImages();
  setInputValue(input, prompt);
  await delay(250);
  const sent = await submitPrompt(input);
  if (!sent) throw new Error("Không tìm thấy nút Gửi. Hãy đăng nhập và mở cuộc trò chuyện mới.");
  const planning = await waitForResponse(
    planningPrevious, article.id, remainingImageTime(deadline), expectedArticleId(article), {
      // ChatGPT can interpret the art-director prompt as a direct image
      // request. When that happens, it returns a usable picture instead of
      // the intermediate JSON; publish that picture immediately.
      imagePrevious: planningImages
    }
  );
  if (planning.directImage) return completeGeneratedImage(article, planning.directImage, planning.rawResponse);
  const imagePrompt = imagePromptFromPlan(planning.data, article);
  const generationInput = await waitForInput();
  const previous = latestGeneratedImages();
  setInputValue(generationInput, buildImageGenerationRequest(imagePrompt));
  await delay(250);
  if (!await submitPrompt(generationInput)) throw new Error("Không tìm thấy nút Gửi để tạo ảnh AI.");
  const image = await waitForGeneratedImage(previous, article.id, remainingImageTime(deadline));
  return completeGeneratedImage(
    article,
    image,
    [planning.rawResponse, image.rawResponse].filter(Boolean).join("\n\n"),
    imagePrompt
  );
}

async function completeGeneratedImage(article, image, rawResponse, imagePrompt = "") {
  // ChatGPT/Grok image URLs are bound to the signed-in browser session. Read
  // the generated asset while that session is alive, then upload the actual
  // file to the website. Never publish a private provider URL to the database
  // or to the extension worker.
  const uploaded = await uploadGeneratedImageForFacility(article, image);
  const imageResult = {
    id: article.facility_id ?? article.id,
    ...(imagePrompt ? { image_prompt: imagePrompt } : {}),
    ai_image_url: uploaded.aiImageUrl
  };
  const saved = await chrome.runtime.sendMessage({
    type: "image-complete", articleId: article.id, runToken: article.runToken,
    imageResult, aiImageUrl: uploaded.aiImageUrl, rawResponse,
    // The tab has already uploaded the binary file by multipart/form-data.
    // Tell the scheduler to record this confirmed local URL, never to send a
    // second JSON update using a provider URL.
    imageUploaded: true, apiUpdate: uploaded.apiUpdate
  });
  if (!saved || saved.ok !== true) throw new Error(saved?.error || "Không thể lưu ảnh AI.");
  return { ok: true, aiImageUrl: uploaded.aiImageUrl };
}

function aiImageMimeType(blob, response) {
  const fromHeader = String(response?.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
  const fromBlob = String(blob?.type || "").split(";")[0].trim().toLowerCase();
  // Some signed ChatGPT/Grok asset endpoints reply with
  // application/octet-stream even though the Blob keeps the real image MIME.
  // Prefer a verified image Content-Type, then the Blob's own type, so a
  // valid private asset is not rejected just because of that generic header.
  if (/^image\/(?:jpeg|jpg|png|webp|gif|avif)$/i.test(fromHeader)) return fromHeader;
  if (/^image\/(?:jpeg|jpg|png|webp|gif|avif)$/i.test(fromBlob)) return fromBlob;
  return fromHeader || fromBlob;
}

async function fetchGeneratedImageBlob(image) {
  const url = String(image?.url || "").trim();
  if (!/^(?:https?:|blob:|data:image\/)/i.test(url)) {
    throw new Error("AI đã tạo ảnh nhưng không nhận được nguồn ảnh hợp lệ để lưu vào website.");
  }
  let response;
  try {
    // This runs inside the signed-in AI tab, so the provider can authorize a
    // private Estuary/blob URL that the website server itself cannot fetch.
    response = await fetch(url, { credentials: "include", cache: "no-store" });
  } catch (error) {
    throw new Error(`Không thể tải ảnh AI từ phiên ${PROVIDER}: ${error?.message || "lỗi kết nối"}.`);
  }
  if (!response?.ok) {
    const detail = await responseErrorDetail(response);
    throw new Error(`Không thể tải ảnh AI từ phiên ${PROVIDER} (HTTP ${response?.status || "?"})${detail ? `: ${detail}` : ""}. Hãy tạo lại ảnh rồi thử lại.`);
  }
  let blob;
  try {
    blob = await response.blob();
  } catch (error) {
    throw new Error(`Không thể đọc dữ liệu ảnh AI từ phiên ${PROVIDER}: ${error?.message || "lỗi không xác định"}.`);
  }
  const mimeType = aiImageMimeType(blob, response);
  if (!/^image\/(?:jpeg|jpg|png|webp|gif|avif)$/i.test(mimeType)) {
    throw new Error(`Phản hồi ảnh AI không phải file ảnh hợp lệ (${mimeType || "không rõ định dạng"}).`);
  }
  if (!blob.size || blob.size > 12 * 1024 * 1024) {
    throw new Error("Ảnh AI trống hoặc vượt giới hạn 12MB của website.");
  }
  return { blob, mimeType };
}

async function responseErrorDetail(response) {
  if (!response || typeof response.text !== "function") return "";
  try {
    const text = String(await response.text() || "").replace(/\s+/g, " ").trim();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

async function getAiImageUploadConfig(article) {
  const config = await chrome.runtime.sendMessage({
    type: "prepare-ai-image-upload",
    articleId: article?.id,
    runToken: article?.runToken,
    provider: PROVIDER
  });
  if (!config?.ok || !config?.url || !config?.apiKey) {
    throw new Error(config?.error || "Không thể chuẩn bị phiên upload ảnh AI.");
  }
  return config;
}

async function uploadGeneratedImageForFacility(article, image) {
  const facilityId = article?.facility_id ?? article?.id;
  if (!/^\d+$/.test(String(facilityId || "")) || Number(facilityId) < 1) {
    throw new Error("Thiếu ID cơ sở hợp lệ để lưu ảnh AI.");
  }
  // Verify the tab still owns this queue item before moving a file across the
  // network. This prevents a late image from being saved to the next facility.
  const config = await getAiImageUploadConfig(article);
  if (String(config.facilityId || "") !== String(facilityId)) {
    throw new Error("Phiên upload không khớp cơ sở đang tạo ảnh; chưa lưu ảnh để tránh ghi nhầm.");
  }
  const { blob, mimeType } = await fetchGeneratedImageBlob(image);
  const form = new FormData();
  form.append("id", String(facilityId));
  form.append("image", blob, `facility-${facilityId}-ai.webp`);
  let response;
  try {
    // Do not set Content-Type manually: the browser supplies the multipart
    // boundary. This upload happens in the logged-in AI tab so the source
    // image can be fetched before its signed URL expires.
    response = await fetch(config.url, {
      method: "POST",
      headers: { "X-Medical-Api-Key": config.apiKey, Accept: "application/json" },
      body: form
    });
  } catch (error) {
    throw new Error(`Không thể upload ảnh AI về website: ${error?.message || "lỗi kết nối"}.`);
  }
  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); }
  catch { throw new Error(`API lưu ảnh AI trả về HTTP ${response.status}: ${responseText.slice(0, 300) || "phản hồi không phải JSON"}`); }
  if (!response.ok || !data?.ok) {
    throw new Error(`API lưu ảnh AI trả về HTTP ${response.status}: ${data?.message || data?.error || JSON.stringify(data?.errors || data).slice(0, 300)}`);
  }
  const updated = Array.isArray(data.updated) ? data.updated : [];
  // Never use a different facility merely because the API has multiple rows.
  // A successful response must explicitly acknowledge the requested ID.
  const saved = updated.find((entry) => String(entry?.facility_id || "") === String(facilityId));
  const aiImageUrl = typeof saved?.ai_image_url === "string" ? saved.ai_image_url.trim() : "";
  if (!aiImageUrl || saved?.storage !== "local_library") {
    throw new Error(`Website chưa xác nhận ảnh nội bộ cho cơ sở ${facilityId}: ${JSON.stringify(data.updated || data).slice(0, 300)}`);
  }
  return { aiImageUrl, apiUpdate: data };
}

function remainingImageTime(deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 1000) throw new Error("Hết thời gian xử lý tạo ảnh AI (10 phút).");
  return remaining;
}

function imagePlanRecord(data, article) {
  const records = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [data];
  const expectedId = article?.facility_id ?? article?.id;
  const objects = records.filter((record) => record && typeof record === "object" && !Array.isArray(record));
  if (expectedId == null) return objects[0];
  return objects.find((record) => record.id != null && String(record.id) === String(expectedId)) ||
    objects.find((record) => record.id == null) || objects[0];
}

function imagePromptFromPlan(data, article) {
  const record = imagePlanRecord(data, article);
  const prompt = record?.image_prompt ?? record?.imagePrompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("AI chưa trả về trường image_prompt hợp lệ để tạo ảnh. Chưa gửi website.");
  }
  const expectedId = article?.facility_id ?? article?.id;
  if (record?.id != null && expectedId != null && String(record.id) !== String(expectedId)) {
    throw new Error(`Prompt ảnh trả về ID ${record.id}, khác ID cơ sở đang xử lý ${expectedId}.`);
  }
  return prompt.trim();
}

function buildImageGenerationRequest(imagePrompt) {
  return [
    "Tạo ngay 01 ảnh bằng công cụ tạo ảnh của bạn theo prompt dưới đây.",
    "Chỉ trả ảnh đã tạo; không trả JSON, markdown, mô tả, link hay giải thích.",
    "Giữ đúng tỷ lệ, các ràng buộc an toàn và không tự thêm chữ/logo/watermark.",
    "",
    imagePrompt
  ].join("\n");
}

function clickVisibleControl(label) {
  const controls = [...document.querySelectorAll("button, [role='button'], [role='menuitem'], [role='option']")];
  const target = controls.find((element) => {
    const text = (element.innerText || element.getAttribute("aria-label") || "").trim();
    return element.offsetParent !== null && text.toLowerCase().includes(label.toLowerCase());
  });
  if (target) { target.click(); return true; }
  return false;
}

function isGeminiNewTaskInput(el) {
  if (!el) return false;
  const placeholder = `${el.getAttribute?.("data-placeholder") || ""} ${el.getAttribute?.("placeholder") || ""}`.toLowerCase();
  if (placeholder.includes("mô tả tác vụ") || placeholder.includes("describe task")) return true;
  const label = String(el.getAttribute?.("aria-label") || "").toLowerCase();
  if (label.includes("mô tả tác vụ") || label.includes("describe task")) return true;
  if (el.closest?.(".left-pane, [data-test-id='remy-left-pane']")) {
    return true;
  }
  return false;
}

function isGeminiSparkRightPaneInput(el) {
  if (!el) return false;
  if (isGeminiNewTaskInput(el)) return false;
  const placeholder = `${el.getAttribute?.("data-placeholder") || ""} ${el.getAttribute?.("placeholder") || ""}`.toLowerCase();
  if (placeholder.includes("tiếp theo") || placeholder.includes("next") || placeholder.includes("làm gì")) return true;
  if (el.closest?.("input-area-v2.remy-mode, input-area-v2, .right-pane, [data-test-id='remy-split-pane'], chat-window")) {
    return true;
  }
  return false;
}

function inputSelectors() {
  if (PROVIDER === "chatgpt") return [
    // Live ChatGPT composer (2026-09-26) no longer has #prompt-textarea.
    "main [data-composer-markdown][contenteditable='true'][role='textbox']",
    "#prompt-textarea",
    "main [data-composer-input-layout] [contenteditable='true'][role='textbox']",
    "main .ProseMirror[contenteditable='true'][role='textbox']"
  ];
  if (PROVIDER === "gemini") {
    const sparkSelectors = isGeminiSparkPage() ? [
      // Live dump 2026-09-15: ql-editor aria-label="Nhập câu lệnh cho Gemini"
      "input-area-v2.remy-mode .ql-editor[contenteditable='true'][aria-label*='Nhập câu lệnh']",
      "input-area-v2 .ql-editor[contenteditable='true'][aria-label*='Nhập câu lệnh']",
      "[role='textbox'][aria-label='Nhập câu lệnh cho Gemini']",
      "[role='textbox'][aria-label*='Nhập câu lệnh']",
      "input-area-v2.remy-mode rich-textarea [contenteditable='true'][role='textbox']",
      "input-area-v2 rich-textarea [contenteditable='true'][role='textbox']",
      "input-area-v2 [contenteditable='true'][role='textbox']:not(.ql-clipboard)",
      "div.ql-editor[data-placeholder*='tiếp theo']",
      "div.ql-editor[data-placeholder*='làm gì']",
      "[contenteditable='true'][data-placeholder*='tiếp theo']",
      "[contenteditable='true'][data-placeholder*='làm gì']",
      ".right-pane rich-textarea [contenteditable='true'][role='textbox']",
      "[data-test-id='remy-split-pane'] rich-textarea [contenteditable='true'][role='textbox']",
      ".right-pane [contenteditable='true'][role='textbox']:not(.ql-clipboard)",
      "[data-test-id='remy-split-pane'] [contenteditable='true'][role='textbox']:not(.ql-clipboard)",
      "chat-window rich-textarea [contenteditable='true'][role='textbox']",
      "chat-window [contenteditable='true'][role='textbox']:not(.ql-clipboard)",
      "input-area-v2 textarea",
      ".right-pane textarea",
      "[data-test-id='remy-split-pane'] textarea"
    ] : [];
    return [
      ...sparkSelectors,
      // Gemini's visible composer is a Quill editor inside rich-textarea. The
      // hidden ql-clipboard is also contenteditable, so keep it explicitly out.
      "rich-textarea [contenteditable='true'][role='textbox']",
      "div.ql-editor[contenteditable='true'][aria-label*='Gemini']",
      "[contenteditable='true'][aria-label*='Gemini']",
      "rich-textarea [contenteditable='true']:not(.ql-clipboard)",
      "textarea[aria-label*='Gemini']",
      "[contenteditable='true'][role='textbox']:not(.ql-clipboard)"
    ];
  }
  if (PROVIDER === "claude") return [
    "[data-testid='chat-input'][contenteditable='true']",
    "div.ProseMirror[contenteditable='true']",
    "[contenteditable='true'][role='textbox'][data-placeholder]",
    "[contenteditable='true'][role='textbox']",
    "textarea[placeholder*='Claude' i]"
  ];
  return [
      "[contenteditable='true'][role='textbox'][aria-label='Ask Grok anything']",
      ".query-bar-editor[contenteditable='true']",
      "[contenteditable='true'][role='textbox']",
      "textarea:not([aria-hidden='true'])"
  ];
}

function selectGeminiSparkInput(candidates) {
  if (!candidates || !candidates.length) return null;

  // 0. Live dump: exact follow-up composer aria-label / placeholder.
  const byLiveLabel = candidates.filter((el) => {
    const aria = String(el.getAttribute?.("aria-label") || "").toLowerCase();
    const ph = String(el.getAttribute?.("data-placeholder") || el.getAttribute?.("placeholder") || "").toLowerCase();
    return aria.includes("nhập câu lệnh") || ph.includes("tiếp theo") || ph.includes("làm gì");
  }).filter((el) => !isGeminiNewTaskInput(el));
  if (byLiveLabel.length) return byLiveLabel.at(-1);

  // 1. Highest priority: candidate inside input-area-v2 or matching placeholder "Chúng ta có thể làm gì tiếp theo?"
  const rightInputArea = candidates.filter((el) => isGeminiSparkRightPaneInput(el));
  if (rightInputArea.length) {
    return rightInputArea.at(-1);
  }

  // 2. Candidate inside right-pane / split-pane / chat-window
  const inRightPane = candidates.filter((el) => {
    return Boolean(el.closest?.(".right-pane, [data-test-id='remy-split-pane'], .chat-window-wrapper, chat-window"));
  });
  if (inRightPane.length) {
    const valid = inRightPane.filter((el) => !isGeminiNewTaskInput(el));
    if (valid.length) return valid.at(-1);
  }

  // 3. Exclude any new-task / "Mô tả tác vụ" inputs
  const nonNewTask = candidates.filter((el) => !isGeminiNewTaskInput(el));
  if (nonNewTask.length) {
    return nonNewTask.at(-1);
  }

  return null;
}

async function waitForInput(timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (isGeminiSparkPage()) {
      const liveRightInput = [...document.querySelectorAll(".right-pane input-area-v2 .ql-editor[contenteditable='true'][role='textbox']")]
        .find((element) => isVisible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
      if (liveRightInput) return liveRightInput;
    }
    const selectors = inputSelectors();
    const spark = PROVIDER === "gemini" && isGeminiSparkPage();
    // Current Spark uses one of the first, tightly scoped composer selectors.
    // Search those first and only run the legacy compatibility selectors if
    // the live composer is absent; a long Spark history makes broad page-wide
    // selector sweeps unnecessarily expensive.
    let candidates = [...new Set((spark ? selectors.slice(0, 4) : selectors)
      .flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter((element) => isVisible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true" && element.getAttribute("aria-hidden") !== "true");
    if (!candidates.length && spark) {
      candidates = [...new Set(selectors.slice(4)
        .flatMap((selector) => [...document.querySelectorAll(selector)]))]
        .filter((element) => isVisible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true" && element.getAttribute("aria-hidden") !== "true");
    }
    if (PROVIDER === "gemini") {
      const filtered = candidates.filter((el) => !isGeminiNewTaskInput(el));
      if (filtered.length) {
        candidates = filtered;
      }
    }
    if (candidates.length) {
      if (PROVIDER === "gemini" && isGeminiSparkPage()) {
        const preferred = selectGeminiSparkInput(candidates);
        if (preferred) return preferred;
      } else {
        return candidates[0];
      }
    }
    await delay(300);
  }
  if (PROVIDER === "chatgpt") {
    throw new Error("Không tìm thấy ô soạn tin ChatGPT. Tải lại tab ChatGPT rồi thử lại.");
  }
  throw new Error("Không tìm thấy ô nhập chat. Hãy mở ChatGPT, Grok, Claude hoặc Gemini và đăng nhập.");
}

function isButtonUsable(btn) {
  if (!btn) return false;
  if (Boolean(btn.disabled) || Boolean(btn.hasAttribute?.("disabled")) || btn.getAttribute?.("aria-disabled") === "true") return false;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(btn) : null;
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  return true;
}

function isExcludedButton(el) {
  if (!el) return true;
  const label = `${el.getAttribute?.("aria-label") || ""} ${el.textContent || ""} ${el.type || ""} ${el.getAttribute?.("data-mat-icon-name") || ""}`.toLowerCase();
  // Live Spark empty composer shows plus/upload + mic instead of Send.
  return /công cụ|tools|tải|upload|đính kèm|drive|tệp|file|micro|mic|voice|giọng nói|nội dung tải lên|plus|mở rộng|canvas/i.test(label);
}

function dispatchEnterKey(target) {
  if (!target) return false;
  try {
    target.focus?.();
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, view: window };
    target.dispatchEvent?.(new KeyboardEvent("keydown", opts));
    target.dispatchEvent?.(new KeyboardEvent("keypress", opts));
    target.dispatchEvent?.(new KeyboardEvent("keyup", opts));
    const parent = target.closest?.("rich-textarea, input-area-v2, form");
    if (parent && parent !== target) {
      parent.dispatchEvent?.(new KeyboardEvent("keydown", opts));
    }
    return true;
  } catch {
    return false;
  }
}

async function submitPrompt(input) {
  if (PROVIDER === "chatgpt") return submitChatGPTPrompt(input);
  if (isGeminiSparkPage()) return submitSparkPrompt(input);
  // Gemini Spark (and most chat UIs) submit on a single Send click.
  // Pressing Enter after a successful click duplicates the prompt.
  // Live Spark: Send/arrow is not rendered while the composer is empty — wait
  // for button[data-test-id=send-button] after text lands in the ql-editor.
  if (clickSend(input)) return true;
  const start = Date.now();
  const waitMs = PROVIDER === "gemini" ? 8000 : 5000;
  while (Date.now() - start < waitMs) {
    await delay(250);
    try {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.closest?.("rich-textarea, input-area-v2")?.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {}
    if (clickSend(input)) return true;
  }
  // rich-textarea has entrykeyhint="send" on live Spark; Enter is last resort only.
  return dispatchEnterKey(input);
}

function sparkPromptComposer(input) {
  return input?.closest?.("input-area-v2")
    || input?.closest?.("form")
    || input?.closest?.(".right-pane, [data-test-id='remy-split-pane'], chat-window")
    || input?.parentElement;
}

async function submitSparkPrompt(input) {
  if (isGeminiNewTaskInput(input)) return false;
  if (clickSend(input)) return true;
  const composer = sparkPromptComposer(input);
  // Watch only this editor's component. No page-wide observer and no input
  // events while Angular mounts/enables the Send button.
  if (composer && typeof MutationObserver === "function") {
    return new Promise((resolve) => {
      let timeout;
      let finished = false;
      const finish = (sent) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(timeout);
        resolve(sent);
      };
      const observer = new MutationObserver(() => {
        if (finished) return;
        if (input.isConnected === false) finish(false);
        else if (clickSend(input)) finish(true);
      });
      observer.observe(composer, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["disabled", "aria-disabled", "class", "style"] });
      timeout = setTimeout(() => finish(false), 8000);
      if (clickSend(input)) finish(true);
    });
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await delay(100);
    if (clickSend(input)) return true;
  }
  return false;
}

async function submitChatGPTPrompt(input) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (clickSend(input)) {
      // A dispatched keyboard/click event alone is not proof of submission.
      // Click once, then wait for ChatGPT to consume the draft.
      const acceptedDeadline = Date.now() + 8000;
      while (Date.now() < acceptedDeadline) {
        await delay(200);
        const liveInput = inputSelectors().flatMap((selector) => [...document.querySelectorAll(selector)])
          .find((element) => isVisible(element));
        if (liveInput && !String(liveInput.value ?? liveInput.innerText ?? liveInput.textContent ?? "").trim()) return true;
      }
      throw new Error("Đã bấm Gửi nhưng ChatGPT chưa nhận prompt (nội dung vẫn còn trong ô chat). Tiện ích không gửi lặp lại.");
    }
    await delay(200);
  }
  return false;
}

function triggerButtonClick(btn) {
  if (!btn) return false;
  try { btn.focus?.(); } catch {}
  // Chat UIs may handle both a synthetic MouseEvent("click") and the native
  // HTMLElement.click() below. In Grok this submits the same prompt twice;
  // Gemini Spark also duplicates when given a synthetic event sequence. Use
  // exactly one native click for these providers.
  if (PROVIDER === "gemini" || PROVIDER === "grok") {
    try { btn.click?.(); } catch {}
    return true;
  }
  const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const type of eventTypes) {
    try {
      btn.dispatchEvent?.(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    } catch {}
  }
  try { btn.click?.(); } catch {}
  try {
    const parentGem = btn.closest?.("gem-icon-button");
    if (parentGem && parentGem !== btn) {
      parentGem.click?.();
      for (const type of eventTypes) {
        try { parentGem.dispatchEvent?.(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch {}
      }
    }
  } catch {}
  return true;
}

function setInputValue(element, value) {
  if (isGeminiSparkPage() && !element.matches("textarea")) {
    return setSparkInputValue(element, String(value));
  }
  element.focus({ preventScroll: true });
  if (element.matches("textarea")) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const selection = window.getSelection?.();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    let inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, String(value));
    if (!inputContainsPrompt(element, value)) {
      try {
        if (typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
          const dt = new DataTransfer();
          dt.setData("text/plain", String(value));
          const pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
          element.dispatchEvent(pasteEvt);
        }
      } catch {}
      inserted = inputContainsPrompt(element, value);
    }
    if (!inserted && !inputContainsPrompt(element, value)) {
      const p = element.querySelector?.("p");
      if (p) {
        p.textContent = value;
      } else {
        element.textContent = value;
      }
    }
    try {
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: value }));
    } catch {}
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    const rich = element.closest?.("rich-textarea, .text-input-field, input-area-v2");
    if (rich) {
      rich.dispatchEvent(new Event("input", { bubbles: true }));
      rich.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}

function sparkComposerText(element) {
  // Quill separates paragraphs with DOM blocks. Read those separators without
  // innerText, which can force layout for the entire Spark page.
  const parts = [];
  const visit = (node) => {
    const tag = String(node.tagName || "").toUpperCase();
    const block = /^(P|DIV|LI|PRE|BLOCKQUOTE)$/.test(tag);
    if (tag === "BR") { parts.push("\n"); return; }
    if (block && node.childNodes?.length === 1 && node.childNodes[0].tagName === "BR") {
      // Quill's empty paragraph contains a placeholder BR. The paragraph
      // itself supplies the newline; counting both would duplicate blank lines.
    } else if (node.childNodes?.length) {
      for (const child of node.childNodes) visit(child);
    } else {
      parts.push(String(node.textContent || ""));
    }
    if (block) parts.push("\n");
  };
  visit(element);
  return parts.join("");
}

function setSparkInputValue(element, value) {
  if (isGeminiNewTaskInput(element)) throw new Error("Không nhập prompt vào ô tạo task bên trái. Hãy mở bài trong thanh bên phải Spark.");
  // Preserve whitespace inside JSON string values when deciding whether the
  // existing draft is truly identical; only ignore editor trailing newlines.
  if (sparkComposerText(element).replace(/\r\n/g, "\n").trim() === value.replace(/\r\n/g, "\n").trim()) return;
  const normalize = (text) => text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const expected = normalize(value);
  const matches = () => normalize(sparkComposerText(element)) === expected;
  // A failed Send may leave the whole draft intact. Avoid asking Quill to
  // delete, rebuild and process that same large prompt a second time.
  element.focus({ preventScroll: true });
  const selectDraft = () => {
    const selection = window.getSelection?.();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  let receivedInput = false;
  const observeInput = () => { receivedInput = true; };
  element.addEventListener?.("input", observeInput);
  try {
    selectDraft();
    try { document.execCommand?.("insertText", false, value); } catch {}
    let inserted = matches();
    if (!inserted && typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
      selectDraft();
      try {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", value);
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
      } catch {}
      inserted = matches();
    }
    if (!inserted) {
      // Replace the complete draft, including any stale paragraphs.
      element.textContent = value;
      receivedInput = false;
    }
    if (!receivedInput) {
      let event;
      try { event = new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }); }
      catch { event = new Event("input", { bubbles: true, composed: true }); }
      element.dispatchEvent(event);
      if (!matches()) throw new Error("Spark chưa nhận đủ prompt vào ô bên phải; tiện ích chưa bấm Gửi.");
    }
  } finally {
    element.removeEventListener?.("input", observeInput);
  }
}

function yieldSparkComposerFrame() {
  if (typeof requestAnimationFrame !== "function") return delay(0);
  return new Promise((resolve) => {
    let finished = false;
    let frameId;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      if (frameId != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameId);
      resolve();
    };
    // Hidden/background tabs can suspend animation frames: never wait on one
    // indefinitely, and do not turn this into another long send delay.
    const timeoutId = setTimeout(finish, 50);
    frameId = requestAnimationFrame(() => {
      if (!finished) frameId = requestAnimationFrame(finish);
    });
  });
}

function inputContainsPrompt(element, prompt) {
  if (!element || typeof prompt !== "string" || !prompt.trim()) return false;
  const normalize = (text) => String(text).replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  // Reading innerText on a 100 KB+ ProseMirror draft forces layout of the
  // whole ChatGPT page, sometimes making Chrome report it as unresponsive.
  // Walk the text nodes instead, adding separators for editor paragraphs.
  const actualText = element.matches?.("textarea, input")
    ? String(element.value || "")
    : element.childNodes?.length ? sparkComposerText(element) : String(element.innerText ?? element.textContent ?? "");
  const actual = normalize(actualText);
  const expected = normalize(prompt);
  if (actual === expected) return true;
  if (expected.length < 1000) return false;
  // ChatGPT may add spaces around rich-text links. Accept only a near-complete
  // large draft with ordered checkpoints across its full length. A clipped or
  // unrelated prompt must never be sent just because its beginning matches.
  const tolerance = Math.max(100, Math.ceil(expected.length * 0.004));
  if (Math.abs(actual.length - expected.length) > tolerance) return false;
  const checkpointLength = Math.min(180, Math.max(24, Math.floor(expected.length / 20)));
  let cursor = 0;
  for (let index = 0; index <= 12; index += 1) {
    const start = Math.floor((expected.length - checkpointLength) * index / 12);
    const checkpoint = expected.slice(start, start + checkpointLength);
    const found = actual.indexOf(checkpoint, cursor);
    if (found < 0) return false;
    cursor = found + checkpoint.length;
  }
  return true;
}

async function waitForPromptInComposer(element, prompt, timeoutMs = 20000) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    if (inputContainsPrompt(element, prompt)) return true;
    if (element?.isConnected === false) return false;
    if (Date.now() >= deadline) break;
    await delay(500);
  } while (Date.now() <= deadline);
  return inputContainsPrompt(element, prompt);
}

function findChatGPTSendButton(input) {
    const composer = input?.closest?.("[data-composer-footer-responsive]")
      || input?.closest?.("form")
      || input?.closest?.("[data-composer-body]")
      || input?.parentElement;
    const candidates = [...(composer?.querySelectorAll?.("button") || [])];
    const send = candidates.find((button) => {
      const label = String(button.getAttribute("aria-label") || "").trim();
      const testId = String(button.getAttribute("data-testid") || button.getAttribute("data-test-id") || "");
      const buttonText = `${label} ${button.textContent || ""}`.trim();
      return isVisible(button) && isButtonUsable(button)
        && (/^(gửi|gửi tin nhắn|gửi câu lệnh|gửi bản dịch|send|send message|send prompt)$/i.test(label)
          || /^(send-button|send-message)$/.test(testId)
          || (button.type === "submit" && /^(?:gửi|send)(?:\s|$)/i.test(buttonText)));
    });
    return send || null;
}

function clickSend(input) {
  if (PROVIDER === "chatgpt") {
    const send = findChatGPTSendButton(input);
    if (!send) return false;
    send.click();
    return true;
  }

  // Spark has two independent composers on the same screen: "Mô tả tác vụ"
  // for creating a task and the follow-up composer for the open task. Never
  // search the whole document on Spark: the first matching send control can
  // belong to the other composer (or another pane).
  if (PROVIDER === "gemini" && isGeminiSparkPage()) {
    if (isGeminiNewTaskInput(input)) return false;
    const composer = sparkPromptComposer(input);
    const sparkSendSelector = [
      "button[data-test-id='send-button']",
      "button[data-testid='send-button']",
      "button[aria-label='Gửi tin nhắn']",
      "button[aria-label='Send message']",
      "button[aria-label='Gửi câu lệnh']",
      "button[aria-label='Send prompt']",
      ".send-button-container button",
      "[data-test-id='send-button-container'] button",
      "[data-testid='send-button-container'] button"
    ].join(", ");
    const scopedButtons = composer && typeof composer.querySelectorAll === "function"
      ? [...composer.querySelectorAll(sparkSendSelector)]
      : [];
    // A couple of older Spark DOM variants/tests expose querySelector only.
    if (!scopedButtons.length && composer && typeof composer.querySelector === "function") {
      const scopedButton = composer.querySelector(sparkSendSelector);
      if (scopedButton) scopedButtons.push(scopedButton);
    }
    const sendButton = scopedButtons.find((button) => {
      const tag = String(button.tagName || button.localName || "").toLowerCase();
      return (tag === "button" || button.getAttribute?.("role") === "button")
        && isButtonUsable(button)
        && !isExcludedButton(button);
    });
    if (sendButton) {
      // The editor is already focused. Focusing another control can scroll
      // the pane and force extra layout immediately before submission.
      try { sendButton.click(); return true; } catch { return false; }
    }

    // The button may not have mounted yet. The caller waits for it rather
    // than treating a synthetic Enter event as proof that Spark received it.
    return false;
  }

  const iconSelector = "mat-icon[fonticon='arrow_upward'], mat-icon[data-mat-icon-name='arrow_upward'], mat-icon[fonticon='send'], mat-icon[data-mat-icon-name='send']";
  const inputContainer = input?.closest?.("input-area-v2, .input-area, .right-pane, [data-test-id='remy-split-pane'], chat-window, .conversation-container, .chat-container, rich-textarea, form") || input?.parentElement;

  // 0. Live Spark (2026-09-15): prefer the explicit send control once it mounts.
  if (PROVIDER === "gemini" && typeof document?.querySelector === "function") {
    const sendSelector = "button[data-test-id='send-button'], button[data-testid='send-button'], .send-button-container button, [data-test-id='send-button-container'] button";
    const scoped = inputContainer && typeof inputContainer.querySelector === "function" ? inputContainer : null;
    const candidates = [
      scoped?.querySelector?.(sendSelector),
      document.querySelector("input-area-v2 button[data-test-id='send-button']"),
      document.querySelector(".right-pane button[data-test-id='send-button']"),
      document.querySelector("button[data-test-id='send-button']"),
      document.querySelector("button[data-testid='send-button']")
    ].filter(Boolean);
    const liveSend = candidates.find((el) => {
      const tag = String(el.tagName || el.localName || "").toLowerCase();
      return (tag === "button" || el.getAttribute?.("role") === "button")
        && isButtonUsable(el)
        && !isExcludedButton(el);
    });
    if (liveSend) {
      triggerButtonClick(liveSend);
      return true;
    }
  }

  // 1. Search inside local input container first
  if (inputContainer && typeof inputContainer.querySelector === "function") {
    const arrowIcon = inputContainer.querySelector(iconSelector);
    if (arrowIcon) {
      const btn = arrowIcon.closest?.("button") || arrowIcon.parentElement?.closest?.("button") || (arrowIcon.parentElement?.tagName === "BUTTON" ? arrowIcon.parentElement : null);
      if (btn && isButtonUsable(btn) && !isExcludedButton(btn)) {
        triggerButtonClick(btn);
        return true;
      }
    }

    const sendContainerBtn = inputContainer.querySelector(".send-button-container button, [data-test-id='send-button-container'] button, [data-testid='send-button-container'] button");
    if (sendContainerBtn && isButtonUsable(sendContainerBtn) && !isExcludedButton(sendContainerBtn)) {
      triggerButtonClick(sendContainerBtn);
      return true;
    }

    const sendAriaBtn = inputContainer.querySelector("button[aria-label*='Gửi'], button[aria-label*='Send'], button[data-testid='send-button'], button[data-test-id='send-button']");
    if (sendAriaBtn && isButtonUsable(sendAriaBtn) && !isExcludedButton(sendAriaBtn)) {
      triggerButtonClick(sendAriaBtn);
      return true;
    }
  }

  // 2. Search document-wide for Gemini send icon or container
  if (typeof document?.querySelector === "function") {
    const arrowIcon = document.querySelector(".right-pane mat-icon[fonticon='arrow_upward'], input-area-v2 mat-icon[fonticon='arrow_upward'], mat-icon[fonticon='arrow_upward'], mat-icon[data-mat-icon-name='arrow_upward']");
    if (arrowIcon) {
      const btn = arrowIcon.closest?.("button") || arrowIcon.parentElement?.closest?.("button") || (arrowIcon.parentElement?.tagName === "BUTTON" ? arrowIcon.parentElement : null);
      if (btn && isButtonUsable(btn) && !isExcludedButton(btn)) {
        triggerButtonClick(btn);
        return true;
      }
    }

    const docSendContainerBtn = document.querySelector(".right-pane .send-button-container button, input-area-v2 .send-button-container button, .send-button-container button, [data-test-id='send-button-container'] button");
    if (docSendContainerBtn && isButtonUsable(docSendContainerBtn) && !isExcludedButton(docSendContainerBtn)) {
      triggerButtonClick(docSendContainerBtn);
      return true;
    }

    const docSendAria = document.querySelector("button[aria-label='Gửi tin nhắn'], button[aria-label='Send message'], button[aria-label='Gửi câu lệnh'], button[aria-label='Send prompt'], button[data-testid='send-button'], button[data-test-id='send-button'], button[data-testid='send-message']");
    if (docSendAria && isButtonUsable(docSendAria) && !isExcludedButton(docSendAria)) {
      triggerButtonClick(docSendAria);
      return true;
    }
  }

  // 3. Provider-wide general search for buttons with send/gửi/submit labels
  const candidates = [
    ...(inputContainer && typeof inputContainer.querySelectorAll === "function" ? inputContainer.querySelectorAll("button") : []),
    ...(typeof document?.querySelectorAll === "function" ? document.querySelectorAll("button[aria-label*='Send'], button[aria-label*='Gửi'], button[aria-label*='Submit'], button[type='submit']") : [])
  ];
  const matched = candidates.find((el) => {
    if (!isButtonUsable(el) || isExcludedButton(el)) return false;
    const label = `${el.getAttribute?.("aria-label") || ""} ${el.textContent || ""} ${el.type || ""}`.toLowerCase();
    return /send|gửi|submit/i.test(label);
  });
  if (matched) {
    triggerButtonClick(matched);
    return true;
  }

  // 4. Keyboard Enter fallback on input
  return dispatchEnterKey(input);
}

function assistantResponseSelectors() {
  return PROVIDER === "chatgpt"
    ? [
      "[data-markdown-text-style='assistant-message']",
      // Current ChatGPT renders generated-image turns as a section with a
      // data-turn attribute, not as the older data-message-author-role DOM.
      "section[data-turn='assistant']",
      "section[data-testid^='conversation-turn-'][data-turn='assistant']",
      "section[data-testid*='conversation-turn'][data-turn='assistant']",
      "[data-turn='assistant'][data-testid*='conversation-turn']",
      "[data-message-author-role='assistant']",
      "[data-testid*='assistant']",
      "article[data-testid*='conversation-turn']"
    ]
    : PROVIDER === "claude"
      ? [
        "[data-testid='assistant-message']",
        "[data-testid^='assistant-message']",
        "[data-message-author-role='assistant']",
        ".font-claude-response, .font-claude-message",
        "[data-is-streaming] .prose"
      ]
      : PROVIDER === "gemini"
        ? [
          // These are the real containers used by the current Gemini web UI.
          // model-response is preferred because it represents one complete AI
          // turn and never contains the user's preceding prompt.
          "model-response",
          "response-container model-response",
          "response-container .model-response-text",
          ".model-response-text",
          "message-content[id^='message-content-id-']",
          ".markdown.markdown-main-panel",
          "structured-content-container.model-response-text",
          "message-content[id^='message-content-id-r_'] > .markdown.markdown-main-panel",
          "[id^='model-response-message-content']"
        ]
        : [
          "[data-testid='assistant-message']",
          "[role='article'][aria-label='Grok']",
          "[id^='response-'] [data-testid*='assistant']",
          "[data-testid*='assistant-response']",
          "[data-testid*='response-message']",
          "[id^='response-']"
        ];
}

function assistantResponseNodes() {
  if (PROVIDER === "gemini") {
    // Spark keeps long research histories mounted in the split-pane DOM. Only
    // inspect the newest matching answer, rather than enumerating and sorting
    // every answer from every previous task on each watcher tick.
    const latest = latestGeminiSparkResponseNode();
    return latest ? [latest] : [];
  }
  const nodes = [];
  const seen = new Set();
  for (const selector of assistantResponseSelectors()) {
    const found = [...document.querySelectorAll(selector)].filter((node) => {
      if (!isVisible(node) || node.closest?.("[data-message-author-role='user'], [data-role='user'], [data-testid*='user-message']")) return false;
      if (PROVIDER === "grok" && selector === "[id^='response-']" && !grokResponseRootLooksAssistant(node)) return false;
      return !node.querySelector?.("[data-message-author-role='user']");
    });
    for (const node of found) {
      if (!seen.has(node)) {
        seen.add(node);
        nodes.push(node);
      }
    }
  }
  if (PROVIDER === "chatgpt") {
    // ChatGPT's newer virtualized conversation view (observed 2026-09-30)
    // renders its completed assistant JSON in main > ... > pre without any
    // data-turn, data-message-author-role, article or conversation-turn
    // attribute. The old selectors return zero nodes although the JSON is
    // visible. Offscreen blocks use div > code until scrolling mounts pre.
    // Include uncovered code blocks even if an older semantic turn exists.
    const blocks = [
      ...document.querySelectorAll("main pre"),
      ...document.querySelectorAll("main [data-markdown-copy='code-block'] code"),
      ...document.querySelectorAll("main [class*='InlineCodePane-'] > code")
    ];
    for (const node of blocks) {
      if (!isVisible(node) || node.closest?.("form, [contenteditable='true'], [data-message-author-role='user'], [data-turn='user']")) continue;
      if (seen.has(node) || nodes.some((owner) => owner.contains?.(node))) continue;
      seen.add(node);
      nodes.push(node);
    }
  }
  // Individual selector queries are needed for compatibility with the AI
  // sites, then this restores their natural document order for `.at(-1)`.
  return nodes.sort((left, right) => {
    const position = left?.compareDocumentPosition?.(right) || 0;
    return position & 4 ? -1 : position & 2 ? 1 : 0;
  });
}

function latestGeminiSparkResponseNode() {
  if (PROVIDER !== "gemini") return null;
  const root = isGeminiSparkPage() ? document.querySelector(".right-pane") || document : document;
  for (const selector of assistantResponseSelectors()) {
    const found = root.querySelectorAll(selector);
    for (let index = found.length - 1; index >= 0; index -= 1) {
      const node = found[index];
      if (!isVisible(node) || node.closest?.("[data-message-author-role='user'], [data-role='user'], [data-testid*='user-message']")) continue;
      if (node.querySelector?.("[data-message-author-role='user']")) continue;
      return node;
    }
  }
  return null;
}

function grokResponseRootLooksAssistant(node) {
  const semantic = [
    node?.getAttribute?.("data-testid"),
    node?.getAttribute?.("data-role"),
    node?.getAttribute?.("aria-label"),
    ...[...(node?.querySelectorAll?.("[data-testid], [data-role], [aria-label], button") || [])]
      .slice(0, 40)
      .flatMap((element) => [
        element.getAttribute?.("data-testid"),
        element.getAttribute?.("data-role"),
        element.getAttribute?.("aria-label"),
        element.innerText,
        element.textContent
      ])
  ].map((value) => String(value || "").trim()).join(" ");
  if (/(?:assistant|grok|worked for|regenerate|copy response)/i.test(semantic)) return true;
  // The current Grok wrapper exposes a small author label as a direct child
  // ("Grok" for the assistant, "You" for the user). Check only short exact
  // labels so arbitrary prompt text cannot make a user turn look assistant.
  return [...(node?.querySelectorAll?.("*") || [])].slice(0, 30)
    .some((element) => /^(?:grok|assistant)$/i.test(String(element.innerText || element.textContent || "").trim()));
}

function latestAssistantResponse(expectedId) {
  const matches = assistantResponseNodes();
  const node = matches.at(-1);
  if (!node) return { node: null, id: "", count: 0, sources: [], signature: "" };
  return assistantResponseSnapshot(node, matches.length, expectedId);
}

function latestAssistantResponseIdentity() {
  const matches = assistantResponseNodes();
  const node = matches.at(-1);
  if (!node) return { node: null, id: "", count: 0, sources: [], signature: "" };
  return { ...assistantResponseIdentity(node, matches.length), sources: [], signature: "" };
}

function assistantResponseIdentity(node, count = 1) {
  // Grok's inner data-testid="assistant-message" is shared by every reply.
  // closest() with the combined selector stops at that inner element rather
  // than its unique response-UUID wrapper, hiding new replies after a retry.
  const grokOwner = PROVIDER === "grok" ? node.closest("[id^='response-']") : null;
  const owner = grokOwner || node.closest("[data-chatgpt-selection-message-id], [data-message-id], [id^='response-'], article, [data-testid*='assistant'], [data-is-streaming], model-response, response-container, message-content");
  const id = node.getAttribute("data-message-id") || owner?.getAttribute("data-chatgpt-selection-message-id") || owner?.getAttribute("data-message-id") || owner?.id || owner?.getAttribute("data-testid") || "";
  return { node, id, count };
}

function chatgptResponseCodeBlocks(node) {
  if (!node) return [];
  const blocks = [
    ...(node.matches?.("pre, code") ? [node] : []),
    ...(node.querySelectorAll?.("pre, [data-markdown-copy='code-block'] code, [class*='InlineCodePane-'] > code") || [])
  ];
  return [...new Set(blocks)];
}

function assistantResponseSnapshot(node, count = 1, expectedId) {
  // Keep every representation of this reply. Syntax highlighting splits code
  // into spans, while innerText can omit clipped/hidden parts of a code block.
  const sources = [];
  const add = (text) => {
    text = String(text || "").trim();
    if (text && !sources.includes(text)) sources.push(text);
  };
  if (PROVIDER === "chatgpt") {
    // textContent includes offscreen code before the viewport observer turns
    // it into a highlighted pre. Read it without layout, cloning or scrolling.
    for (const block of chatgptResponseCodeBlocks(node)) add(block.textContent);
    if (!sources.length) add(node.textContent);
  } else if (PROVIDER === "gemini") {
    // Accept a complete matching code block without reading the entire reply.
    const blocks = node.querySelectorAll("pre, code");
    for (let index = blocks.length - 1; index >= 0; index--) {
      const text = String(blocks[index].textContent || "").trim();
      if (!text) continue;
      const parsed = parseAssistantResponse({ sources: [text] }, expectedId);
      if (parsed?.idMatched) return { ...assistantResponseIdentity(node, count), sources: [text], signature: text + (expectedId?.sourceType === "handbook" ? "\u0000" + (globalThis.MedReviewHandbookFiles?.signature(node) || "") : "") };
    }
    const text = String(node.textContent || "").trim();
    add(text);
    const parsed = parseAssistantResponse({ sources }, expectedId);
    if (!parsed?.idMatched) add(node.innerText);
  } else {
    for (const block of node.querySelectorAll("pre, code, .markdown, .prose, .font-claude-response, .font-claude-message, message-content, .model-response-text, .markdown-main-panel")) {
      add(block.textContent);
      add(block.innerText);
    }
    const clean = node.cloneNode(true);
    clean.querySelectorAll("button, [role='button'], svg, script, style, [data-testid*='citation'], [data-citation-id]")
      .forEach((element) => element.remove());
    add(clean.textContent);
    add(node.textContent);
    add(node.innerText);
  }
  return { ...assistantResponseIdentity(node, count), sources, signature: (sources.length === 1 ? sources[0] : sources.join("\u0000")) + (expectedId?.sourceType === "handbook" ? "\u0000" + (globalThis.MedReviewHandbookFiles?.signature(node) || "") : "") };
}

function geminiResponseNodesForRecovery() {
  if (PROVIDER !== "gemini" || !isGeminiSparkPage()) return [];
  const root = document.querySelector(".right-pane") || document;
  const selectors = [
    "model-response",
    "response-container .model-response-text",
    ".model-response-text",
    "message-content[id^='message-content-id-']",
    ".markdown.markdown-main-panel",
    "structured-content-container.model-response-text",
    "message-content[id^='message-content-id-r_'] > .markdown.markdown-main-panel",
    "[id^='model-response-message-content']"
  ];
  const nodes = [];
  const seen = new Set();
  for (const selector of selectors) {
    for (const node of root.querySelectorAll(selector)) {
      if (seen.has(node) || !isVisible(node)) continue;
      if (node.closest?.("[data-message-author-role='user'], [data-role='user'], [data-testid*='user-message']")) continue;
      if (node.querySelector?.("[data-message-author-role='user']")) continue;
      seen.add(node);
      nodes.push(node);
    }
  }
  return nodes.sort((left, right) => {
    const position = left?.compareDocumentPosition?.(right) || 0;
    return position & 4 ? -1 : position & 2 ? 1 : 0;
  });
}

async function readExistingArticleJson(article) {
  if (!article?.id || isAiImageArticle(article)) throw new Error("Bài cần khôi phục JSON không hợp lệ.");
  if (PROVIDER !== "gemini" || !isGeminiSparkPage()) throw new Error("Mở task Gemini Spark có phản hồi AI trước khi đọc lại JSON.");
  const expectedId = expectedArticleId(article);
  const nodes = geminiResponseNodesForRecovery();
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const snapshot = assistantResponseSnapshot(nodes[index], nodes.length, expectedId);
    const parsed = parseAssistantResponse(snapshot, expectedId);
    if (!parsed?.data || !parsed.idMatched) continue;
    return { ok: true, article: parsed.data, rawResponse: parsed.rawResponse, responseId: snapshot.id };
  }
  const id = article.doctor_id ?? article.facility_id ?? article.toplist_id ?? "?";
  throw new Error(`Đã quét ${nodes.length} phản hồi trong task Spark đang mở nhưng chưa thấy JSON hợp lệ có ID ${id}.`);
}

function responseNodeKey(node, index) {
  const owner = node.closest?.("[data-message-id], [id^='response-'], article, section[data-testid*='conversation-turn'], [data-testid*='assistant'], model-response, response-container, message-content") || node;
  const id = node.getAttribute?.("data-message-id") || owner?.getAttribute?.("data-message-id") || owner?.id || owner?.getAttribute?.("data-testid");
  return id ? String(id) : `assistant-${index}`;
}

function imageSource(image) {
  const pictureSource = image?.closest?.("picture")?.querySelector?.("source[srcset]")?.getAttribute?.("srcset") || "";
  const srcsetUrl = String(pictureSource).split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).at(-1);
  const linkedUrl = image?.closest?.("a[href]")?.href || image?.closest?.("a[href]")?.getAttribute?.("href");
  return String(
    image?.currentSrc || image?.src || image?.getAttribute?.("src") ||
    image?.getAttribute?.("data-src") || image?.getAttribute?.("data-original") ||
    srcsetUrl || linkedUrl || ""
  ).trim();
}

function freshHandbookImages(previous) {
  if (!previous) return [];
  const oldUrls = new Set(previous.images.map((image) => image.url));
  return latestGeneratedImages().images.filter((image) => !previous.keys.has(image.key) && !oldUrls.has(image.url) &&
    !previous.nodes?.has(image.node) && imageLooksLikeGeneratedAsset(image.image));
}

async function prepareHandbookOutput(article, data, previous, responseSnapshot = null) {
  MedReviewHandbook.validate(article, data, { allowPlaceholders: true, allowFileRefs: true });
  if (globalThis.MedReviewHandbookFiles?.hasReferences(data)) {
    reportSystemPhase(article.id, article.runToken, "reading-image-files", "Đang đọc file TXT của đúng câu trả lời này, đối chiếu bytes/SHA-256 và kiểm tra ảnh thật trước gửi web.");
    const controller = new AbortController();
    const cancellation = setInterval(() => { if (cancelledArticleId === article.id) controller.abort(); }, 200);
    try {
      if (cancelledArticleId === article.id) controller.abort();
      data = await MedReviewHandbookFiles.resolve(data, {
        node: responseSnapshot?.node, provider: PROVIDER, signal: controller.signal,
        onRetry: ({ filename, attempt, attempts }) => reportSystemPhase(article.id, article.runToken, "reading-image-files",
          `Chưa đọc được ${filename}; đang mở lại file lần ${attempt}/${attempts} trước khi báo lỗi.`)
      });
    } finally { clearInterval(cancellation); }
  }
  MedReviewHandbook.validate(article, data, { allowPlaceholders: true });
  const tags = MedReviewHandbook.imageTags(data.content_html);
  const placeholders = tags.filter((image) => /^handbook-image:[1-4]$/.test(image.uri));
  if (!placeholders.length) {
    // Pixel decoding rejects syntactically valid but fabricated/truncated data.
    // Public HTTP(S) links are deliberately not fetched from this AI tab. The
    // API performs SSRF-safe downloads and raster validation on the hosting.
    if (typeof createImageBitmap === "function") for (const image of tags.filter((tag) => /^data:image\//i.test(tag.uri))) {
      const response = await fetch(image.uri);
      const bitmap = await createImageBitmap(await response.blob()).catch(() => null);
      if (!bitmap || !bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 12000000 || Math.max(bitmap.width, bitmap.height) > 8192) {
        bitmap?.close?.();
        throw MedReviewHandbook.error("image_decode_failed", "Không giải mã được file ảnh Cẩm nang hoặc kích thước vượt giới hạn.");
      }
      bitmap.close();
    }
    return data;
  }
  if (!["chatgpt", "grok"].includes(PROVIDER) || !previous) {
    throw MedReviewHandbook.error("handbook_capability_error", "Chưa lấy được bytes ảnh minh hoạ thật từ provider/lượt này. Cần JSON có data ảnh thật hoặc link ảnh công khai trực tiếp, hoặc tạo lại bằng ChatGPT/Grok; không dùng ảnh cũ hay fake BASE64.");
  }
  reportSystemPhase(article.id, article.runToken, "attaching-images", "Đang tải file minh hoạ mới của chính bài này, kiểm tra và gắn BASE64 vào HTML.");
  const images = previous.bound || freshHandbookImages(previous);
  const slots = [...new Set(placeholders.map((image) => Number(image.uri.split(":")[1])))];
  if (!images.length || images.length > 4 || slots.some((slot) => slot > images.length) || slots.length !== images.length) {
    throw MedReviewHandbook.error("missing_images", "Số/vị trí placeholder không khớp file ảnh mới của bài Cẩm nang; chưa tự chọn ảnh bất kỳ trên giao diện.");
  }
  let html = data.content_html;
  for (const slot of slots) {
    const { blob, mimeType } = await fetchGeneratedImageBlob(images[slot - 1]);
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType) || blob.size > MedReviewHandbook.limits.imageBytes) {
      throw MedReviewHandbook.error("image_too_large", "Ảnh Cẩm nang cần PNG/JPEG/WebP tối đa 5 MiB; chưa gắn file khác định dạng.");
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(MedReviewHandbook.error("missing_images", "Không đọc được bytes file minh hoạ."));
      reader.readAsDataURL(blob);
    });
    MedReviewHandbook.imageData(dataUrl);
    for (const image of placeholders.filter((tag) => tag.uri === `handbook-image:${slot}`)) {
      html = html.replace(image.tag, image.tag.replace(/((?:^|\s)src\s*=\s*)(["'])(.*?)\2/is, (_match, prefix, quote) => `${prefix}${quote}${dataUrl}${quote}`));
    }
  }
  const result = { ...data, content_html: html };
  MedReviewHandbook.validate(article, result);
  return prepareHandbookOutput(article, result, null);
}

function generatedImageCard(image) {
  return image?.closest?.([
    "button[aria-label^='Ảnh đã tạo:']",
    "button[aria-label^='Image created:']",
    "[role='button'][aria-label^='Ảnh đã tạo:']",
    "[role='button'][aria-label^='Image created:']"
  ].join(", ")) || null;
}

function generatedImageElementKey(image, responseKey, url) {
  let identity = generatedImageElementIds.get(image);
  if (identity == null) {
    identity = generatedImageElementSequence++;
    generatedImageElementIds.set(image, identity);
  }
  return `${responseKey}|${url}|${identity}`;
}

function imageLooksLikeGeneratedAsset(image) {
  const source = imageSource(image);
  if (!source) return false;
  const card = generatedImageCard(image);
  const details = [
    source,
    image?.alt,
    image?.getAttribute?.("aria-label"),
    image?.className,
    image?.parentElement?.className,
    image?.parentElement?.getAttribute?.("data-testid"),
    card?.getAttribute?.("aria-label"),
    card?.getAttribute?.("data-testid")
  ].map((value) => String(value || "")).join(" ").toLowerCase();
  // Exclude avatar/logo/icon and source images placed in a user's prompt. A
  // generated picture may be inside a clickable lightbox, so a plain button
  // ancestor is deliberately not a rejection condition.
  if (/(?:avatar|profile(?:[_ -]?image)?|favicon|logo|\bicon\b|emoji|reference[_ -]?image|user-upload|attachment-preview)/i.test(details)) return false;
  if (/thumbnail/i.test(details) && !card) return false;
  if (image.closest?.("[data-message-author-role='user'], [data-role='user'], [data-turn='user'], [data-testid*='user-message'], form, rich-textarea, [data-testid*='composer'], aside, nav, [data-testid*='sidebar']")) return false;
  const rect = image.getBoundingClientRect?.();
  const width = Number(image.naturalWidth || image.width || rect?.width || 0);
  const height = Number(image.naturalHeight || image.height || rect?.height || 0);
  // Known small dimensions indicate UI artwork. An unknown size is allowed:
  // the actual generated image can still be loading at this moment.
  return !(width && height && Math.max(width, height) < 180);
}

function generatedImageResponseNodes() {
  const nodes = [...assistantResponseNodes()];
  const seen = new Set(nodes);
  // ChatGPT's current image result is a clickable card. Include it even when
  // the card is mounted outside the text-message wrapper.
  if (PROVIDER === "chatgpt") {
    const cardSelector = [
      "button[aria-label^='Ảnh đã tạo:']",
      "button[aria-label^='Image created:']",
      "[role='button'][aria-label^='Ảnh đã tạo:']",
      "[role='button'][aria-label^='Image created:']"
    ].join(", ");
    for (const node of document.querySelectorAll(cardSelector)) {
      if (isVisible(node) && !seen.has(node)) {
        seen.add(node);
        nodes.push(node);
      }
    }
  }
  return nodes;
}

function latestGeneratedImages() {
  const images = [];
  const seenImages = new Set();
  const nodes = generatedImageResponseNodes();
  nodes.forEach((node, nodeIndex) => {
    const responseKey = responseNodeKey(node, nodeIndex);
    const elements = [
      ...(node.matches?.("img") ? [node] : []),
      ...(node.querySelectorAll?.("img") || [])
    ];
    elements.forEach((image, imageIndex) => {
      if (seenImages.has(image)) return;
      seenImages.add(image);
      if (!imageLooksLikeGeneratedAsset(image)) return;
      const url = imageSource(image);
      const key = generatedImageElementKey(image, responseKey, url || imageIndex);
      const rawResponse = String(node.innerText || node.textContent || "").trim().slice(0, 100000);
      images.push({ key, url, image, node, rawResponse });
    });
  });
  return {
    images,
    keys: new Set(images.map((image) => image.key)),
    signature: images.map((image) => image.key).join("\n")
  };
}

async function waitForGeneratedImage(previous, articleId, timeout = 600000, options = {}) {
  const started = Date.now();
  let changedAt = Date.now();
  let last = previous.signature;
  let rawResponse = "";
  while (Date.now() - started < timeout) {
    if (cancelledArticleId === articleId) throw new Error("Đã dừng tạo ảnh.");
    await delay(800);
    if (cancelledArticleId === articleId) throw new Error("Đã dừng tạo ảnh.");
    const current = latestGeneratedImages();
    if (current.signature !== last) { last = current.signature; changedAt = Date.now(); }
    const fresh = current.images.filter((image) => !previous.keys.has(image.key));
    const image = fresh.at(-1) || (options.acceptCurrent ? current.images.at(-1) : null);
    if (!image) continue;
    rawResponse = image.rawResponse || rawResponse;
    // Wait for a stable answer so a preview thumbnail never gets sent while
    // ChatGPT/Grok is still replacing it with the final generated picture.
    if (isGenerating() || Date.now() - changedAt < 3200) continue;
    // Keep only the provider-side image reference here. `completeGeneratedImage`
    // immediately turns it into a Blob while this signed-in tab is alive and
    // uploads that file to our server by multipart/form-data.
    return { ...image, rawResponse };
  }
  const error = new Error(rawResponse
    ? "AI đã phản hồi nhưng sau 10 phút tiện ích chưa tìm thấy ảnh hoàn chỉnh để gửi website."
    : "Hết thời gian chờ AI tạo ảnh (10 phút).");
  error.rawResponse = rawResponse;
  throw error;
}

function isVisible(node) {
  if (!node || node.hidden || node.getAttribute?.("aria-hidden") === "true") return false;
  if (!(node.getClientRects?.().length > 0)) return false;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
  return style?.visibility !== "hidden" && style?.display !== "none" && style?.opacity !== "0";
}
function isGeminiSparkStopVisible() {
  const pane = document.querySelector(".right-pane");
  const root = pane?.querySelector?.("input-area-v2") || pane || document;
  return [...root.querySelectorAll("button[aria-label='Ngừng tạo câu trả lời'], button[data-test-id*='stop'], button[data-testid*='stop'], button[aria-label*='Stop'], button[aria-label*='Dừng']")].some(isVisible);
}
function isChatGPTToolActivityVisible() {
  if (PROVIDER !== "chatgpt") return false;
  // ChatGPT can hand control to Search/Deep Research between streamed text
  // chunks. During that phase its Stop button may be absent; the visible
  // “Bỏ qua” control and live search status still mean this turn is running.
  const skipButton = [...document.querySelectorAll("main button, button[aria-label='Bỏ qua'], button[aria-label='Skip']")]
    .some((button) => isVisible(button)
      && /^(?:bỏ qua|skip)$/i.test(String(button.getAttribute?.("aria-label") || button.innerText || button.textContent || "").trim()));
  if (skipButton) return true;
  const activityStatus = [...document.querySelectorAll("main [role='status'], main [aria-live], main [data-testid*='progress'], main [data-testid*='search']")]
    .some((node) => isVisible(node)
      && /(?:đang tìm kiếm(?: trên web)?|searching (?:the )?web|đang duyệt web|browsing (?:the )?web|đang mở trang|opening (?:a )?page|đang đọc trang|reading (?:a )?page)/i
        .test(String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim()));
  if (activityStatus) return true;
  // Image generation/thinking may temporarily replace Stop with a compact
  // progress row. Only UI status controls count, never ordinary article text.
  return [...document.querySelectorAll("main [role='status'], main [aria-live], main [role='progressbar'], main [data-testid*='progress'], main [data-testid*='image-generation'], main button")]
    .some((node) => {
      const text = String(node.getAttribute?.("aria-label") || node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      return isVisible(node) && (node.children?.length || 0) <= 2 && text.length <= 300
        && /^(?:đang (?:tạo(?: hình)? ảnh|suy nghĩ|xử lý)|creating (?:an? )?image|generating (?:an? )?image|thinking|processing)(?:\s|[.…:·-]|$)/i.test(text);
    });
}
function isGenerating(responseNode = null) {
  const stopControl = [...document.querySelectorAll("button[data-testid*='stop'], button[data-test-id*='stop'], button[aria-label*='Stop' i], button[aria-label*='Dừng' i], button[aria-label*='Ngừng' i]")].some(isVisible);
  const streamingResponse = document.querySelector("[data-is-streaming='true']");
  // Spark retains many old research turns (and their processing controls) in
  // the task DOM. Only statuses attached to the newest assistant turn can
  // describe the generation currently controlled by the composer Stop button.
  const sparkResponse = isGeminiSparkPage() ? responseNode || latestGeminiSparkResponseNode() : null;
  const sparkRoot = sparkResponse || document;
  const sparkStopped = isGeminiSparkPage()
    && [...sparkRoot.querySelectorAll("[data-test-id='stopped-task-message'], .stopped-task-message")].some(isVisible);
  const sparkBusyResponse = isGeminiSparkPage()
    && [...sparkRoot.querySelectorAll("[aria-busy='true']")].some(isVisible);
  const sparkProcessingStatus = isGeminiSparkPage()
    && [...sparkRoot.querySelectorAll("[data-test-id='remy-processing-state-text'], [aria-live], [role='status']")].some((node) => {
      const text = String(node.textContent || "").trim();
      // Spark renders the progress indicator as a plain text row rather than
      // a button. Match only a small, exact status node so normal article text
      // containing the same words cannot keep a completed answer generating.
      return isVisible(node)
        && node.children?.length <= 2
        && /^(?:đang xử lý|processing|generating|working)(?:\s*(?:\.{3}|…))?$/i.test(text);
    });
  // Do not treat processing-state-container-button as a live signal: Spark
  // retains completed research-step cards in the conversation history.
  return stopControl || sparkBusyResponse || sparkProcessingStatus
    || (PROVIDER === "chatgpt" && isChatGPTToolActivityVisible())
    || Boolean(streamingResponse && isVisible(streamingResponse));
}

async function waitForHandbookIdle(articleId, runToken, input = null) {
  const started = Date.now();
  const deadline = Date.now() + ARTICLE_WAIT_TIMEOUT_MS;
  const sparkPage = isGeminiSparkPage();
  let progressAt = started;
  let idleSince = null;
  let reported = false;
  while (Date.now() < deadline) {
    if (cancelledArticleId === articleId) throw new Error("Đã dừng bài viết.");
    if (input?.isConnected === false) input = await waitForInput();
    const busy = sparkPage ? isGeminiSparkStopVisible() : isGenerating();
    if (sparkPage && runToken && Date.now() - progressAt >= 15000) {
      progressAt = Date.now();
      chrome.runtime.sendMessage({ type: "article-progress", articleId, runToken, progressAt: new Date(progressAt).toISOString() }).catch(() => {});
    }
    if (sparkPage && busy && Date.now() - Math.max(started, geminiSparkLastReloadAt(articleId)) >= GEMINI_SPARK_RELOAD_INTERVAL_MS) {
      if (await reloadGeminiSparkForStall(articleId, runToken)) throw geminiSparkReloadError();
    }
    const sendReady = !input || PROVIDER !== "chatgpt" || Boolean(findChatGPTSendButton(input));
    if (busy || !sendReady) {
      idleSince = null;
      if (!reported) {
        reportSystemPhase(articleId, runToken, "writing-images", "Đang đợi AI tạo ảnh xong và nút Gửi sẵn sàng; chưa gửi yêu cầu JSON.");
        reported = true;
      }
    } else {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 3200) return input;
    }
    await delay(800);
  }
  throw new Error("Hết thời gian chờ AI hoàn tất tạo ảnh; chưa gửi yêu cầu JSON hay dữ liệu lên website.");
}

function geminiSparkProgressSignature(responseSignature = "", responseNode = null) {
  if (!isGeminiSparkPage()) return "";
  // During generation, progress is read from Spark's small status controls.
  // Avoid touching the large answer node until Spark has stopped (or this is
  // a recovery run that must inspect the already-rendered answer).
  const root = responseNode || document.querySelector(".right-pane") || document;
  const selectors = "[data-test-id='remy-processing-state-text'], button[data-test-id='processing-state-container-button'], [aria-live], [role='status'], [role='progressbar'], [data-testid*='progress']";
  const progressWords = /đang|đã|hoàn tất|tìm kiếm|tìm thấy|đọc|phân tích|nguồn|search|reading|analy[sz]|processing|research|source|fetch|open(?:ing|ed)?/i;
  const status = [...root.querySelectorAll(selectors)]
    .filter(isVisible)
    .map((node) => String(node.innerText || node.textContent || node.getAttribute?.("aria-label") || "")
      .replace(/\b(?:worked for|đã làm việc)\s+\d+\s*(?:s|m|h|seconds?|minutes?|hours?)\b/gi, "")
      .replace(/\s+/g, " ").trim())
    .filter((text) => text && text.length <= 300 && progressWords.test(text));
  const answer = String(responseSignature || "")
    .replace(/\b(?:worked for|đã làm việc)\s+\d+\s*(?:s|m|h|seconds?|minutes?|hours?)\b/gi, "");
  return `${answer}\n${[...new Set(status)].join("\n")}`.slice(0, 8000);
}

async function waitForResponse(previous, articleId, timeout = ARTICLE_WAIT_TIMEOUT_MS, expectedId, options = {}) {
  const started = Date.now();
  let changedAt = Date.now();
  let last = previous.signature;
  let rawResponse = "";
  let parsedSignature = "";
  let parsedChangedAt = 0;
  let parsedSourceSignature = null;
  let parsedSourceResult = null;
  let parsedValueReference = null;
  let parsedValueSignature = "";
  // Survives Gemini Spark's recovery reload so the formatting follow-up is
  // sent at most once for this article run.
  let retryBaseline = readJsonFormatRetryState(articleId, options.runToken);
  let formatRetrySent = Boolean(retryBaseline);
  const replacementRetryKey = `${IMAGE_FIX_REPLACEMENT_RETRY_STORAGE_PREFIX}${jsonFormatRetryKey(articleId, options.runToken)}`;
  let replacementRetrySent = false;
  try { replacementRetrySent = sessionStorage.getItem(replacementRetryKey) === "sent"; } catch {}
  let lastProgressMessageAt = 0;
  const sparkPage = isGeminiSparkPage();
  const sparkReloadReferenceAt = options.acceptCurrent ? (geminiSparkLastReloadAt(articleId) || started) : started;
  let sparkStopSeen = false;
  const imagePrevious = options.imagePrevious || null;
  const handbookTurn = expectedId?.sourceType === "handbook";
  let imageLast = imagePrevious?.signature || "";
  let imageChangedAt = Date.now();
  while (options.waitUntilJson || Date.now() - started < timeout) {
    if (cancelledArticleId === articleId) throw new Error("Đã dừng bài viết.");
    await delay(sparkPage ? 1000 : 800);
    if (cancelledArticleId === articleId) throw new Error("Đã dừng bài viết.");
    // While handbook tools own the turn, observe only generation controls.
    // Reset stability on EVERY busy poll, including a long unchanged caption,
    // so one transient missing Stop never triggers a formatting follow-up.
    if (handbookTurn && !sparkPage && isGenerating()) {
      changedAt = Date.now();
      imageChangedAt = Date.now();
      parsedChangedAt = Date.now();
      continue;
    }
    let imageFollowupPending = false;
    if (imagePrevious) {
      const currentImages = latestGeneratedImages();
      const freshImages = currentImages.images.filter((image) => !imagePrevious.keys.has(image.key));
      imageFollowupPending = handbookTurn && freshImages.length > 0;
      const ready = (entry) => entry.image?.complete !== false && entry.image?.naturalWidth > 0 && entry.image?.naturalHeight > 0;
      const imageSignature = handbookTurn ? currentImages.signature + '|' + freshImages.map(entry => `${ready(entry)}:${entry.image?.naturalWidth}:${entry.image?.naturalHeight}`).join('|') : currentImages.signature;
      if (imageSignature !== imageLast) {
        imageLast = imageSignature;
        imageChangedAt = Date.now();
      }
      const freshImage = (!handbookTurn || freshImages.every(ready)) ? freshImages.at(-1) : null;
      if (freshImage) {
        const imageRawResponse = freshImage.rawResponse || rawResponse;
        // A direct image may arrive without a JSON planning response. Wait
        // until its card has settled. `completeGeneratedImage` then fetches
        // the authenticated Blob and uploads it as a real file.
        // A finished JSON + TXT reply wins over its illustrative image card.
        // Leave time for tool/file cards to render before asking another turn.
        const finalSnapshot = handbookTurn ? latestAssistantResponse(expectedId) : null;
        const finalIsCurrent = finalSnapshot?.node && (options.acceptCurrent || !previous.node ||
          (finalSnapshot.id && previous.id ? finalSnapshot.id !== previous.id : finalSnapshot.node !== previous.node || finalSnapshot.count > previous.count) ||
          (["grok", "claude", "gemini"].includes(PROVIDER) && finalSnapshot.signature !== previous.signature));
        const finalJson = finalIsCurrent ? parseAssistantResponse(finalSnapshot, expectedId) : null;
        if (!isGenerating() && !finalJson?.idMatched && Date.now() - imageChangedAt >= (handbookTurn ? 15000 : 3200)) {
          return {
            directImage: { ...freshImage, rawResponse: imageRawResponse },
            rawResponse: imageRawResponse
          };
        }
      }
    }
    if (sparkPage && options.runToken && Date.now() - lastProgressMessageAt >= 15000) {
      lastProgressMessageAt = Date.now();
      chrome.runtime.sendMessage({
        type: "article-progress",
        articleId,
        runToken: options.runToken,
        progressAt: new Date(lastProgressMessageAt).toISOString()
      }).catch(() => {});
    }
    // The Spark Stop button is the only completion signal. Poll it once per
    // second and leave the answer DOM untouched while it remains visible.
    const sparkGenerating = sparkPage ? isGeminiSparkStopVisible() : false;
    if (sparkPage && sparkGenerating) sparkStopSeen = true;
    let sparkAwaitingStart = sparkPage && !sparkStopSeen && !options.acceptCurrent;
    if (sparkAwaitingStart && !sparkGenerating) {
      // Generation can finish between polls (or while the renderer is busy).
      // A new reply identity is sufficient to inspect that reply after Stop
      // has disappeared; do not wait forever for a Stop we already missed.
      const current = latestAssistantResponseIdentity();
      const newReply = current.node && (!previous.node || (current.id && previous.id
        ? current.id !== previous.id : current.node !== previous.node));
      if (newReply) sparkAwaitingStart = false;
    }
    if (sparkPage && (sparkGenerating || sparkAwaitingStart)) {
      const reloadReference = Math.max(sparkReloadReferenceAt, geminiSparkLastReloadAt(articleId));
      if (Date.now() - reloadReference >= GEMINI_SPARK_RELOAD_INTERVAL_MS) {
        if (await reloadGeminiSparkForStall(articleId, options.runToken)) throw geminiSparkReloadError();
      }
      continue;
    }

    if (sparkPage) reportSystemPhase(articleId, options.runToken, "reading-json", "Nút Stop đã đóng. Đang đọc câu trả lời gần nhất, trích JSON và đối chiếu ID bài; chờ nội dung ổn định trước khi nhận kết quả.");
    const now = latestAssistantResponse(expectedId);
    if (now.signature !== last) { last = now.signature; changedAt = Date.now(); }
    rawResponse = now.sources.reduce((longest, text) => text.length > longest.length ? text : longest, rawResponse);
    // Grok, Claude and Gemini may create/reuse their response container before the watcher
    // takes its first snapshot. In that case the identity is unchanged even
    // though the container later becomes the complete JSON for this job.
    const identityChanged = now.node && (!previous.node || (now.id && previous.id
      ? now.id !== previous.id
      : now.node !== previous.node || now.count > previous.count));
    const contentChanged = now.node && now.signature !== previous.signature;
    const retryResponseChanged = retryBaseline && now.node && (
      (retryBaseline.id && now.id && now.id !== retryBaseline.id)
      || now.count !== retryBaseline.count
      || responseSignatureHash(now.signature) !== retryBaseline.signatureHash
    );
    const candidateAvailable = formatRetrySent
      ? Boolean(retryResponseChanged)
      : identityChanged || options.acceptCurrent || (["grok", "claude", "gemini"].includes(PROVIDER) && contentChanged)
        || (sparkPage && !sparkGenerating);
    const generating = sparkPage ? sparkGenerating : isGenerating(now.node);
    if (generating) { changedAt = Date.now(); parsedChangedAt = Date.now(); }
    if (sparkPage && !generating && Date.now() - changedAt >= 3200 && (!now.sources.length || !candidateAvailable)) {
      const error = new Error("Gemini Spark đã dừng nhưng chưa tìm thấy câu trả lời cho bài đang xử lý.");
      error.code = "gemini-spark-invalid-json";
      error.rawResponse = rawResponse;
      throw error;
    }
    if (!candidateAvailable) {
      continue;
    }
    if (!now.sources.length) {
      continue;
    }
    if (now.signature !== parsedSourceSignature) {
      parsedSourceSignature = now.signature;
      parsedSourceResult = parseAssistantResponse(now, expectedId);
      parsedValueReference = null;
    }
    let parsed = parsedSourceResult;
    if (handbookTurn && parsed?.idMatched && (Object.hasOwn(parsed.data || {}, "image_files") || /(?:^|\s)src\s*=\s*["']link[1-4]["']/i.test(parsed.data?.content_html || "")) &&
        !globalThis.MedReviewHandbookFiles?.ready(parsed.data, now.node)) {
      // Missing/unfinished files are not a completed payload. Request the
      // compact JSON and actual files together once, then fail without POST.
      if (formatRetrySent && !generating && Date.now() - changedAt >= 15000) {
        throw new Error("Cẩm nang vẫn thiếu file linkN_base64.txt hoặc image_files không khớp. Cần JSON và file TXT thật trong cùng câu trả lời; chưa gửi web.");
      }
      parsed = null;
    }
    // Require the parsed JSON to match expectedId if specified, so reload or
    // multi-turn chat history never finishes the job with an older facility.
    const idMatched = Boolean(parsed?.idMatched);
    if (sparkPage && !needsStrictJsonResponse(expectedId) && !generating && Date.now() - changedAt >= 3200 && (!parsed || !idMatched)) {
      const error = new Error("Gemini Spark đã dừng nhưng JSON không hợp lệ hoặc không khớp ID bài.");
      error.code = "gemini-spark-invalid-json";
      error.rawResponse = rawResponse;
      throw error;
    }
    if (parsed && idMatched && (!generating || (isGeminiSparkPage() && options.acceptCurrent && !formatRetrySent))) {
      // Wait until the answer has remained stable before publishing it.
      if (parsedValueReference !== parsed) {
        parsedValueReference = parsed;
        parsedValueSignature = now.signature;
      }
      const signature = parsedValueSignature;
      if (signature !== parsedSignature) {
        parsedSignature = signature;
        parsedChangedAt = Date.now();
      }
      if (Date.now() - parsedChangedAt >= 3200) {
        const expectedLabel = expectedId?.sourceType === "doctor" ? `${expectedId.id} và tên ${expectedId.name}`
          : expectedId?.sourceType === "facility_image_fix" ? `${expectedId.id} và revision ${expectedId.images_revision}` : expectedId;
        reportSystemPhase(articleId, options.runToken, "validating-json", `Đã trích được JSON ổn định${expectedId == null ? "" : `, khớp ID ${expectedLabel}`}. Đang hoàn tất kiểm tra kết quả.`);
        if (!sparkPage && !formatRetrySent && !responseHasJsonCodeBlock(now, expectedId)) {
          try {
            retryBaseline = await requestJsonFormatRetry(articleId, expectedId, options.runToken, now);
          } catch (error) {
            error.rawResponse = rawResponse;
            throw error;
          }
          formatRetrySent = true;
          last = now.signature;
          changedAt = Date.now();
          rawResponse = "";
          parsedSignature = "";
          parsedChangedAt = 0;
          parsedSourceSignature = null;
          parsedSourceResult = null;
          parsedValueReference = null;
          parsedValueSignature = "";
          continue;
        }
        if (expectedId?.sourceType === "facility_image_fix" && options.imageFixArticle && !replacementRetrySent) {
          const summary = imageFixReplacementSummary(options.imageFixArticle, parsed.data);
          if (summary.removed > 0 && summary.verified < summary.minimum) {
            // Only request replacement research after the completed, stable
            // JSON is read. Persist the one follow-up across recovery reloads.
            replacementRetrySent = true;
            try { sessionStorage.setItem(replacementRetryKey, "sent"); } catch {}
            reportSystemPhase(articleId, options.runToken, "finding-replacement-images", `Đã loại ${summary.removed} ảnh nhưng mới có ${summary.verified}/${summary.minimum} ảnh thật đã xác minh. Đang yêu cầu AI tìm ảnh thay thế; chưa gửi cập nhật xóa ảnh.`);
            try {
              retryBaseline = await requestJsonFormatRetry(articleId, expectedId, options.runToken, now,
                imageFixReplacementPrompt(options.imageFixArticle, parsed.data, summary));
            } catch (error) {
              // Retain the full parsed result: background's independent guard
              // rejects destructive updates with too few replacement images.
              reportSystemPhase(articleId, options.runToken, "replacement-images-failed", `Không gửi được yêu cầu tìm ảnh thay thế: ${error.message}. Giữ JSON để kiểm tra lại; chưa cập nhật ảnh website.`);
              clearJsonFormatRetryState(articleId, options.runToken);
              return parsed;
            }
            formatRetrySent = true;
            last = now.signature;
            changedAt = Date.now();
            rawResponse = "";
            parsedSignature = "";
            parsedChangedAt = 0;
            parsedSourceSignature = null;
            parsedSourceResult = null;
            parsedValueReference = null;
            parsedValueSignature = "";
            continue;
          }
        }
        clearJsonFormatRetryState(articleId, options.runToken);
        return handbookTurn ? { ...parsed, responseSnapshot: now } : parsed;
      }
      continue;
    }
    // Give the original response a chance to finish before sending the one
    // formatting follow-up; keep waiting while the provider is still generating.
    if (imageFollowupPending && !parsedSourceResult?.idMatched) continue;
    const completedMalformed = !generating && Date.now() - changedAt >= 15000;
    if (!formatRetrySent && candidateAvailable && completedMalformed && rawResponse) {
      try {
        retryBaseline = await requestJsonFormatRetry(articleId, expectedId, options.runToken, now);
      } catch (error) {
        error.rawResponse = rawResponse;
        throw error;
      }
      formatRetrySent = true;
      last = now.signature;
      changedAt = Date.now();
      rawResponse = "";
      parsedSignature = "";
      parsedChangedAt = 0;
      parsedSourceSignature = null;
      parsedSourceResult = null;
      parsedValueReference = null;
      parsedValueSignature = "";
      continue;
    }
    if (formatRetrySent && completedMalformed && rawResponse) {
      const providerLabel = "AI";
      const error = new Error(`${providerLabel} chưa trả về JSON hợp lệ sau một lần yêu cầu bổ sung; tiện ích chưa gửi dữ liệu lên website.`);
      error.rawResponse = rawResponse;
      throw error;
    }
    if (generating || Date.now() - changedAt < 3200) continue;
  }
  const error = new Error(rawResponse
    ? `Sau ${ARTICLE_WAIT_TIMEOUT_LABEL} chưa đọc được JSON đầy đủ, hợp lệ từ AI. Đã giữ nội dung đọc được; chưa gửi website.`
    : `Hết thời gian chờ phản hồi từ AI (${ARTICLE_WAIT_TIMEOUT_LABEL}).`);
  error.rawResponse = rawResponse;
  throw error;
}

function jsonMatchesExpectedId(data, expectedId) {
  if (expectedId?.sourceType === "handbook") return Boolean(data && !Array.isArray(data) && Number.isSafeInteger(data.id) &&
    data.id === expectedId.id && data.language === expectedId.language && typeof data.content_html === "string");
  if (expectedId?.sourceType === "facility_image_fix") {
    // Never accept a stale same-facility answer, a string ID, or an envelope
    // whose nested record happens to match. Background validates image detail.
    return Boolean(data && typeof data === "object" && !Array.isArray(data)
      && Number.isSafeInteger(expectedId.id) && expectedId.id > 0
      && Number.isSafeInteger(data.id) && data.id > 0 && data.id === expectedId.id
      && typeof expectedId.images_revision === "string" && expectedId.images_revision.length > 0
      && data.images_revision === expectedId.images_revision);
  }
  if (expectedId?.sourceType === "doctor") {
    // A doctor submission is one record, not an array/envelope containing a
    // coincidentally matching nested ID. Reject string IDs and renamed people.
    return Boolean(data && typeof data === "object" && !Array.isArray(data)
      && Number.isSafeInteger(expectedId.id) && expectedId.id > 0
      && Number.isSafeInteger(data.id) && data.id > 0 && data.id === expectedId.id
      && typeof expectedId.name === "string" && expectedId.name.length > 0
      && data.name === expectedId.name);
  }
  const translation = expectedId?.sourceType === "translation";
  const toplist = expectedId?.sourceType === "toplist";
  const expected = translation ? expectedId.source_id : toplist ? expectedId.id : expectedId;
  if (expected == null) return true;
  const records = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [data];
  return records.some((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    if (translation) {
      return String(record.type || "").toLowerCase() === expectedId.type
        && record.source_id != null
        && String(record.source_id) === String(expected);
    }
    const id = toplist ? record.toplist_id ?? record.toplistId ?? record.id : record.id;
    return id != null && String(id) === String(expected) && (!toplist || !expectedId.entity_type || toplistJsonEntityType(record) === expectedId.entity_type);
  });
}

const parsedSourceCache = new Map();
const jsonScoreCache = new WeakMap();
function expectedJsonKey(expectedId) {
  const detail = expectedId?.sourceType === "doctor" ? `:${JSON.stringify(expectedId.name)}`
    : expectedId?.sourceType === "facility_image_fix" ? `:${JSON.stringify(expectedId.images_revision)}` : "";
  return expectedId && typeof expectedId === "object"
    ? `${expectedId.sourceType}:${expectedId.type || expectedId.entity_type || ""}:${expectedId.source_id ?? expectedId.id}${detail}`
    : String(expectedId ?? "");
}

function strictJsonCodeBlocks(snapshot) {
  // DOM renderers remove fences, and may defer highlighted <pre> until the
  // answer enters the viewport. Reuse the existing no-scroll block lookup.
  const node = snapshot?.node;
  const blocks = PROVIDER === "chatgpt" ? chatgptResponseCodeBlocks(node) : [
    ...(node?.matches?.("pre") ? [node] : []),
    ...(node?.querySelectorAll?.("pre") || [])
  ];
  const distinct = [...new Set(blocks)].filter((block, index, all) => !all.some((other, otherIndex) =>
    otherIndex !== index && other.contains?.(block)));
  if (distinct.length) {
    return distinct.map((block) => String(block.querySelector?.("code")?.textContent || block.textContent || "").trim());
  }
  // Snapshot sources are several representations of one reply, not separate
  // replies. Choose the representation containing the most fenced blocks so
  // duplicate/split JSON blocks cannot silently be treated as one submission.
  let fenced = [];
  const pattern = /^[ \t]*(`{3,}|~{3,})[ \t]*json\b[^\n]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gim;
  for (const source of snapshot?.sources || []) {
    const candidates = [...String(source || "").matchAll(pattern)].map((match) => match[2].trim());
    if (candidates.length > fenced.length) fenced = candidates;
  }
  return fenced;
}

function parseStrictJsonResponse(snapshot, expectedId) {
  const blocks = strictJsonCodeBlocks(snapshot);
  if (blocks.length !== 1) return null;
  let data;
  try { data = JSON.parse(blocks[0]); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  // Pass through the complete object. Nulls, arrays, nested evidence and
  // future fields belong to the server contract, not an extension allowlist.
  return { data, rawResponse: blocks[0], idMatched: jsonMatchesExpectedId(data, expectedId) };
}

function parseAssistantResponse(snapshot, expectedId) {
  if (needsStrictJsonResponse(expectedId)) return parseStrictJsonResponse(snapshot, expectedId);
  let best = null;
  let bestScore = -Infinity;
  for (const source of snapshot.sources) {
    const key = expectedJsonKey(expectedId);
    let cached = parsedSourceCache.get(source);
    if (!cached || cached.expectedKey !== key) {
      const data = extractJson(source, expectedId);
      cached = { expectedKey: key, data, score: data === null ? -Infinity : jsonCandidateScore(data, expectedId), idMatched: data !== null && jsonMatchesExpectedId(data, expectedId) };
      parsedSourceCache.set(source, cached);
      if (parsedSourceCache.size > 4) parsedSourceCache.delete(parsedSourceCache.keys().next().value);
    }
    if (cached.data === null) continue;
    if (cached.score >= bestScore) { best = { data: cached.data, rawResponse: source, idMatched: cached.idMatched }; bestScore = cached.score; }
  }
  return best;
}

function extractJson(text, expectedId) {
  const source = String(text || "").trim();
  // Read fenced blocks independently: prose before the fence may contain an
  // unmatched bracket which is not part of the JSON at all.
  const sources = [...source.matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm)]
    .map((match) => match[2]);
  sources.push(source);
  let best = null;
  let bestScore = -Infinity;
  for (const candidate of sources) {
    const data = extractJsonContainer(candidate, expectedId);
    if (data === null) continue;
    const score = jsonCandidateScore(data, expectedId);
    if (score >= bestScore) { best = data; bestScore = score; }
  }
  return best;
}

function extractJsonContainer(text, expectedId) {
  const source = String(text || "").trim();
  let best = null;
  let bestScore = -Infinity;
  // Scan complete outer containers only. If an outer object is truncated, its
  // nested reviews must never be mistaken for the finished article.
  let start = -1;
  let stack = [];
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (start < 0) {
      if (char !== "{" && char !== "[") continue;
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next++;
      const first = source[next] || "";
      if (char === "{" && first !== '"' && first !== "}") continue;
      if (char === "[" && !/["{\[\]\d-]/.test(first) && !/^(?:true\b|false\b|null\b)/.test(source.slice(next, next + 6))) continue;
      start = index;
      stack = [char];
      quoted = false;
      escaped = false;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      if ((char === "}" && stack.at(-1) !== "{") || (char === "]" && stack.at(-1) !== "[")) continue;
      stack.pop();
      if (stack.length) continue;
      try {
        const data = JSON.parse(source.slice(start, index + 1));
        const score = jsonCandidateScore(data, expectedId);
        if (score >= bestScore) { best = data; bestScore = score; }
      } catch { /* Leave invalid JSON untouched; never fabricate missing fields. */ }
      start = -1;
    }
  }
  return best;
}

function toplistJsonEntityType(record) {
  const facilities = ["facilities", "co_so", "co_so_y_te"].some((key) => Object.hasOwn(record, key));
  const doctors = ["doctors", "bac_si"].some((key) => Object.hasOwn(record, key));
  return record.entity_type ?? record.list_type ?? (Object.hasOwn(record, "members") || facilities && doctors ? "mixed" : doctors ? "doctor" : "facility");
}

function jsonCandidateScore(data, expectedId) {
  const cacheKey = expectedJsonKey(expectedId);
  const saved = data && typeof data === "object" ? jsonScoreCache.get(data) : null;
  if (saved?.key === cacheKey) return saved.score;
  const translation = expectedId?.sourceType === "translation";
  const toplist = expectedId?.sourceType === "toplist";
  const doctor = ["doctor", "handbook"].includes(expectedId?.sourceType);
  const expected = translation ? expectedId.source_id : toplist || doctor ? expectedId.id : expectedId;
  const records = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [data];
  let score = -Infinity;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    let rank = Math.min(Object.keys(record).length, 100);
    if (typeof record.content === "string" && record.content.trim()) rank += 1000;
    if (doctor) rank += jsonMatchesExpectedId(record, expectedId) ? 1000000 : -1000000;
    if (record.translated && typeof record.translated === "object" && !Array.isArray(record.translated)) {
      // Prefer the whole translation envelope over its nested translated
      // object; the background validates type/source_id before posting.
      rank += 100000;
      if (translation) {
        const matches = String(record.type || "").toLowerCase() === expectedId.type
          && record.source_id != null && String(record.source_id) === String(expected);
        rank += matches ? 1000000 : -1000000;
      }
    }
    const id = toplist ? record.toplist_id ?? record.toplistId ?? record.id : record.id;
    const facilities = record.facilities ?? record.co_so ?? record.co_so_y_te;
    const doctors = record.doctors ?? record.bac_si;
    if (toplist && [facilities, doctors, record.members].some((rows) => Array.isArray(rows) && rows.length)) rank += 2000;
    if (toplist && expectedId.entity_type) rank += toplistJsonEntityType(record) === expectedId.entity_type ? 1000000 : -1000000;
    if (id != null && expected != null) rank += String(id) === String(expected) ? 10000 : -10000;
    score = Math.max(score, rank);
  }
  const size = records.reduce((length, record) => length + (typeof record?.content === "string" ? record.content.length : 0), 0);
  const result = (Number.isFinite(score) ? score : 0) + Math.min(size, 1000000) / 1000000;
  if (data && typeof data === "object") jsonScoreCache.set(data, { key: cacheKey, score: result });
  return result;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function installPersistentPanel() {
  if (document.getElementById("ai-article-runner-panel")) return;
  const app = document.querySelector("bard-app, gemini-app, #__next, #root, #app, #grok-app-root") || document.body.firstElementChild;
  document.documentElement.style.setProperty("overflow-x", "hidden", "important");
  if (app instanceof HTMLElement) {
    // The ChatGPT app must physically be narrower than the viewport, otherwise
    // its internal full-width layers render below the extension panel.
    app.style.setProperty("width", "80vw", "important");
    app.style.setProperty("max-width", "80vw", "important");
    app.style.setProperty("flex", "none", "important");
    app.style.setProperty("min-width", "0", "important");
    app.style.setProperty("height", "100vh", "important");
  }
  const layout = document.createElement("style");
  layout.id = "ai-article-runner-chat-layout";
  layout.textContent = PROVIDER === "chatgpt" ? `
      /* Remove ChatGPT's centered narrow reading column while the work panel is open. */
      main article > div { max-width: none !important; margin-left: 0 !important; margin-right: 0 !important; }
      main article > div > div { max-width: none !important; }
      main form { max-width: none !important; margin-left: 0 !important; margin-right: 20px !important; }
    ` : PROVIDER === "grok" ? `
      /* Grok uses its own content container; keep it inside the 80% workspace. */
      #grok-content-area { max-width: 100% !important; }
    ` : PROVIDER === "gemini" ? `
      /* Gemini currently mounts its chat in bard-app/rich-textarea. */
      /* The app root is narrowed to 80vw; paint the unused right strip dark too. */
      html, body { background-color: #131314 !important; }
      main, .conversation-container, .conversation-container-content, rich-textarea { max-width: 100% !important; }
      .conversation-container, .conversation-container-content { margin-left: 0 !important; margin-right: 0 !important; }
    ` : `
      /* Claude's application root is already reduced to the 80% workspace. */
      main { max-width: 100% !important; }
    `;
  document.documentElement.append(layout);
  // The runner deliberately keeps one dark appearance on every AI website.
  // This prevents the panel from visually changing when a provider uses a
  // different theme class (Gemini uses `dark-theme`, for example).
  const dark = true;
  const panel = document.createElement("aside");
  panel.id = "ai-article-runner-panel";
  panel.setAttribute("aria-label", "MedReview AI content");
  Object.assign(panel.style, {
    position: "fixed", top: "0", right: "0", bottom: "0", width: "20vw", minWidth: "0", maxWidth: "none", height: "100vh",
    zIndex: "2147483647", overflow: "auto", background: dark ? "rgba(23,23,23,.82)" : "rgba(246,247,248,.76)", backdropFilter: "blur(22px) saturate(140%)", borderLeft: "0", boxShadow: dark ? "-4px 0 18px rgba(0,0,0,.25)" : "-4px 0 18px rgba(15,23,42,.10)", transform: "translateX(calc(100% - 10px))", transition: "transform .24s ease"
  });
  if (isGeminiSparkPage()) {
    panel.style.backdropFilter = "none";
    panel.style.background = "#171717";
  }
  const trigger = document.createElement("div");
  trigger.id = "ai-article-runner-hover-zone";
  Object.assign(trigger.style, { position: "fixed", top: "0", right: "0", width: "18px", height: "100vh", zIndex: "2147483646", cursor: "ew-resize" });
  const frame = document.createElement("iframe");
  const frameParams = new URLSearchParams({ embedded: "1", provider: PROVIDER, theme: "dark" });
  if (isGeminiSparkPage()) frameParams.set("spark", "1");
  try {
    // A content-script message always carries sender.tab, so the embedded
    // panel remains tied to this exact tab even when several tabs use the
    // same AI provider at the same time.
    const context = await chrome.runtime.sendMessage({ type: "get-tab-context", provider: PROVIDER });
    const targetTabId = Number(context?.targetTabId ?? context?.tabId);
    if (Number.isInteger(targetTabId) && targetTabId > 0) frameParams.set("tabId", String(targetTabId));
    if (["chatgpt", "grok", "claude", "gemini"].includes(context?.provider)) frameParams.set("provider", context.provider);
  } catch {}
  frame.src = chrome.runtime.getURL(`popup.html?${frameParams.toString()}`);
  frame.title = "MedReview AI content";
  Object.assign(frame.style, { width: "100%", height: "100%", border: "0", display: "block" });
  panel.append(frame);
  let hideTimer;
  const showPanel = () => { clearTimeout(hideTimer); panel.style.transform = "translateX(0)"; trigger.style.width = "6px"; };
  const hidePanel = () => { hideTimer = setTimeout(() => { panel.style.transform = "translateX(calc(100% - 10px))"; trigger.style.width = "18px"; }, 280); };
  trigger.addEventListener("mouseenter", showPanel);
  panel.addEventListener("mouseenter", showPanel);
  panel.addEventListener("mouseleave", hidePanel);
  trigger.addEventListener("mouseleave", hidePanel);
  document.body.append(trigger);
  document.body.append(panel);
  // A Chrome extension reload invalidates old content scripts/iframes. Reload
  // the host tab automatically instead of leaving the panel in an error state.
  const contextWatch = setInterval(() => {
    try { chrome.runtime.getManifest(); }
    catch { clearInterval(contextWatch); window.location.reload(); }
  }, 2500);
}
}
