importScripts("protocol.js", "config.js");

const { TARGET, MESSAGE } = LectureProtocol;
const SERVER_CHECK_TIMEOUT_MS = 65_000;
const SERVER_READY_GESTURE_BUDGET_MS = 2_500;
const SERVER_LIVE_CACHE_KEYS = ["serverLiveLastAttemptAt", "serverLiveLastSuccessAt", "serverLiveLastState"];
let creatingOffscreen = null;
let serverLiveRequest = null;
let serverReadyRequest = null;

function serializeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeServerBaseUrl(rawValue) {
  const url = new URL(String(rawValue || LectureConfig.SERVER_BASE_URL));
  const isLocal = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && (url.port || "80") === "8050";
  const configured = new URL(LectureConfig.SERVER_BASE_URL);
  const isConfiguredProduction = url.protocol === "https:" && url.origin === configured.origin;
  if (!isLocal && !isConfiguredProduction) throw new Error("확장 프로그램에 등록되지 않은 서버 주소입니다.");
  return url.origin;
}

function serverLiveCacheMs() {
  const configured = Number(LectureConfig.SERVER_LIVE_CACHE_SECONDS) || 180;
  return Math.min(300, Math.max(120, configured)) * 1000;
}

function publishServerLiveStatus(state, detail = "") {
  chrome.runtime.sendMessage({
    target: TARGET.SIDEPANEL,
    type: MESSAGE.SERVER_LIVE_STATUS,
    payload: { state, detail }
  }).catch(() => {});
}

function publishServerReadyStatus(state, detail = "") {
  chrome.runtime.sendMessage({
    target: TARGET.SIDEPANEL,
    type: MESSAGE.SERVER_READY_STATUS,
    payload: { state, detail }
  }).catch(() => {});
}

async function fetchServerLive(serverBaseUrl) {
  const attemptedAt = Date.now();
  await chrome.storage.session.set({
    serverLiveLastAttemptAt: attemptedAt,
    serverLiveLastState: "checking"
  });
  publishServerLiveStatus("checking");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${serverBaseUrl}/health/live`, { signal: controller.signal });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || payload?.status !== "ok") {
      const detail = payload?.error?.message || payload?.detail || `Render 서버 응답 상태가 비정상입니다 (${response.status})`;
      await chrome.storage.session.set({ serverLiveLastSuccessAt: Date.now(), serverLiveLastState: "degraded" });
      publishServerLiveStatus("degraded", detail);
      return { ok: false, state: "degraded", error: detail, checkedAt: Date.now() };
    }

    const checkedAt = Date.now();
    await chrome.storage.session.set({
      serverLiveLastSuccessAt: checkedAt,
      serverLiveLastState: "connected"
    });
    publishServerLiveStatus("connected");
    return { ok: true, state: "connected", payload, checkedAt };
  } catch (error) {
    const detail = error?.name === "AbortError"
      ? `Render 서버 응답이 ${Math.round(SERVER_CHECK_TIMEOUT_MS / 1000)}초 안에 오지 않았습니다.`
      : serializeError(error);
    await chrome.storage.session.set({ serverLiveLastState: "unavailable" });
    publishServerLiveStatus("unavailable", detail);
    return { ok: false, state: "unavailable", error: detail, checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

async function performServerLiveCheck(serverBaseUrl, force) {
  const now = Date.now();
  if (!force) {
    const saved = await chrome.storage.session.get(SERVER_LIVE_CACHE_KEYS);
    const lastAttemptAt = Number(saved.serverLiveLastAttemptAt) || 0;
    const lastSuccessAt = Number(saved.serverLiveLastSuccessAt) || 0;
    const cacheMs = serverLiveCacheMs();
    const successAge = now - lastSuccessAt;
    if (saved.serverLiveLastState === "connected" && lastSuccessAt && successAge >= 0 && successAge < cacheMs) {
      return { ok: true, state: "connected", cached: true, checkedAt: lastSuccessAt };
    }
    const attemptAge = now - lastAttemptAt;
    if (["degraded", "unavailable"].includes(saved.serverLiveLastState) && lastAttemptAt && attemptAge >= 0 && attemptAge < cacheMs) {
      return {
        ok: false,
        state: saved.serverLiveLastState,
        cached: true,
        error: saved.serverLiveLastState === "degraded"
          ? "Render는 응답했지만 상태 확인이 정상적이지 않았습니다."
          : "최근 Render 연결 확인에 실패했습니다. 캡처 시작 시 저장소 준비를 다시 확인합니다."
      };
    }
  }
  return fetchServerLive(serverBaseUrl);
}

function checkServerLive(payload = {}) {
  let serverBaseUrl;
  try {
    serverBaseUrl = normalizeServerBaseUrl(payload.serverBaseUrl);
  } catch (error) {
    return Promise.resolve({ ok: false, state: "unavailable", error: serializeError(error) });
  }

  if (serverLiveRequest?.serverBaseUrl === serverBaseUrl) {
    return serverLiveRequest.promise;
  }

  const request = { serverBaseUrl, promise: null };
  request.promise = performServerLiveCheck(serverBaseUrl, Boolean(payload.force));
  serverLiveRequest = request;
  request.promise.finally(() => {
    if (serverLiveRequest === request) serverLiveRequest = null;
  }).catch(() => {});
  return request.promise;
}

async function fetchServerReadiness(serverBaseUrl) {
  await chrome.storage.session.set({ serverStorageLastState: "checking" });
  publishServerReadyStatus("checking");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${serverBaseUrl}/health/ready`, { signal: controller.signal });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }

    // Receiving any HTTP response proves that the Render app answered, even if Atlas is unavailable.
    await chrome.storage.session.set({ serverLiveLastSuccessAt: Date.now(), serverLiveLastState: "connected" });
    publishServerLiveStatus("connected");

    if (!response.ok || payload?.status !== "ok") {
      const storageUnavailable = payload?.error?.code === "storage_unavailable";
      const state = storageUnavailable ? "unavailable" : "unknown";
      const detail = payload?.error?.message || payload?.detail || `저장소 준비 확인 실패 (${response.status})`;
      await chrome.storage.session.set({ serverStorageLastState: state });
      publishServerReadyStatus(state, detail);
      return { ok: false, state, error: detail, payload, checkedAt: Date.now() };
    }

    const checkedAt = Date.now();
    await chrome.storage.session.set({ serverStorageLastState: "ready", serverStorageLastSuccessAt: checkedAt });
    publishServerReadyStatus("ready");
    return { ok: true, state: "ready", payload, checkedAt };
  } catch (error) {
    const detail = error?.name === "AbortError"
      ? `저장소 준비 확인이 ${Math.round(SERVER_CHECK_TIMEOUT_MS / 1000)}초 안에 끝나지 않았습니다.`
      : serializeError(error);
    await chrome.storage.session.set({ serverStorageLastState: "unknown", serverLiveLastState: "unavailable" });
    publishServerLiveStatus("unavailable", detail);
    publishServerReadyStatus("unknown", detail);
    return { ok: false, state: "unknown", error: detail, checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

function checkServerReady(payload = {}) {
  let serverBaseUrl;
  try {
    serverBaseUrl = normalizeServerBaseUrl(payload.serverBaseUrl);
  } catch (error) {
    const detail = serializeError(error);
    publishServerReadyStatus("unknown", detail);
    return Promise.resolve({ ok: false, state: "unknown", error: detail });
  }

  if (serverReadyRequest?.serverBaseUrl === serverBaseUrl) return serverReadyRequest.promise;
  const request = { serverBaseUrl, promise: null };
  request.promise = fetchServerReadiness(serverBaseUrl);
  serverReadyRequest = request;
  request.promise.finally(() => {
    if (serverReadyRequest === request) serverReadyRequest = null;
  }).catch(() => {});
  return request.promise;
}

function assertCapturableTab(tab) {
  if (!tab?.id) throw new Error("활성 탭을 찾을 수 없습니다.");
  if (!tab.url) return;
  const url = new URL(tab.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("일반 HTTP/HTTPS 페이지에서만 캡처할 수 있습니다.");
  }
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "사용자가 선택한 탭의 오디오를 자막으로 변환합니다."
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function sendToOffscreen(type, payload = {}) {
  if (!(await hasOffscreenDocument())) {
    if (type === MESSAGE.GET_SESSION_SNAPSHOT) {
      return { ok: true, snapshot: { state: "IDLE" } };
    }
    throw new Error("오디오 처리 문서가 열려 있지 않습니다.");
  }
  return chrome.runtime.sendMessage({
    target: TARGET.OFFSCREEN,
    type,
    payload
  });
}

async function prepareTab(tab) {
  assertCapturableTab(tab);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["protocol.js", "content.js"]
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["styles.css"]
    });
  } catch (error) {
    throw new Error(`이 페이지에 자막 UI를 연결할 수 없습니다: ${serializeError(error)}`);
  }
}

async function getVideoState(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      target: TARGET.CONTENT,
      type: MESSAGE.GET_VIDEO_STATE
    });
    return response?.videoState || { hasVideo: false, paused: false, currentTimeMs: 0, playbackRate: 1 };
  } catch {
    return { hasVideo: false, paused: false, currentTimeMs: 0, playbackRate: 1 };
  }
}

async function startSession(payload) {
  const startRequestedAt = performance.now();
  const tabId = Number(payload?.tabId);
  const tab = await chrome.tabs.get(tabId);
  assertCapturableTab(tab);

  const readiness = await checkServerReady({ serverBaseUrl: payload.serverBaseUrl });
  if (!readiness.ok) throw new Error(`저장소 준비 확인에 실패했습니다: ${readiness.error || "다시 시도해 주세요."}`);
  if (performance.now() - startRequestedAt > SERVER_READY_GESTURE_BUDGET_MS) {
    return {
      ok: true,
      readinessOnly: true,
      message: "서버가 준비됐습니다. 캡처 시작을 다시 눌러 주세요."
    };
  }

  await prepareTab(tab);
  await ensureOffscreenDocument();
  if (performance.now() - startRequestedAt > SERVER_READY_GESTURE_BUDGET_MS) {
    return {
      ok: true,
      readinessOnly: true,
      message: "서버가 준비됐습니다. 캡처 시작을 다시 눌러 주세요."
    };
  }

  const videoState = await getVideoState(tabId);
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    throw new Error(
      `탭 오디오 권한을 얻지 못했습니다. 확장 아이콘으로 패널을 연 뒤 다시 시도해 주세요: ${serializeError(error)}`
    );
  }

  const response = await sendToOffscreen(MESSAGE.START_SESSION, {
    streamId,
    sourceTabId: tabId,
    sourceUrl: tab.url || "",
    sourceTitle: tab.title || "",
    serverBaseUrl: payload.serverBaseUrl,
    userId: payload.userId,
    accessToken: payload.accessToken,
    videoState,
    serverHealth: readiness.payload
  });

  if (!response?.ok) throw new Error(response?.error || "캡처를 시작하지 못했습니다.");
  return response;
}

async function recoverSession(payload) {
  const tabId = Number(payload?.tabId);
  const tab = await chrome.tabs.get(tabId);
  assertCapturableTab(tab);
  await prepareTab(tab);
  await ensureOffscreenDocument();

  const videoState = await getVideoState(tabId);
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    throw new Error(
      `탭 오디오 권한을 얻지 못했습니다. 확장 아이콘으로 패널을 연 뒤 다시 시도해 주세요: ${serializeError(error)}`
    );
  }

  return sendToOffscreen(MESSAGE.RECOVER_SESSION, {
    streamId,
    sourceTabId: tabId,
    sourceUrl: tab.url || "",
    sourceTitle: tab.title || "",
    videoState
  });
}

function sendSnapshotToViews(snapshot) {
  chrome.runtime.sendMessage({
    target: TARGET.SIDEPANEL,
    type: MESSAGE.SESSION_SNAPSHOT,
    payload: snapshot
  }).catch(() => {});

  const tabId = Number(snapshot?.sourceTabId);
  if (!Number.isInteger(tabId)) return;
  const recent = (snapshot.captions || []).slice(-2);
  chrome.tabs.sendMessage(tabId, {
    target: TARGET.CONTENT,
    type: MESSAGE.OVERLAY_UPDATE,
    payload: {
      state: snapshot.state,
      message: snapshot.error || snapshot.notice || "",
      latestSegments: recent
    }
  }).catch(() => {});
}

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    try {
      assertCapturableTab(tab);
      await chrome.sidePanel.open({ tabId: tab.id });
      await prepareTab(tab);
    } catch (error) {
      chrome.runtime.sendMessage({
        target: TARGET.SIDEPANEL,
        type: MESSAGE.SESSION_SNAPSHOT,
        payload: { state: "ERROR", error: serializeError(error) }
      }).catch(() => {});
    }
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== TARGET.SERVICE_WORKER) return undefined;

  if (message.type === MESSAGE.SESSION_SNAPSHOT) {
    sendSnapshotToViews(message.payload || {});
    sendResponse({ ok: true });
    return false;
  }

  void (async () => {
    switch (message.type) {
      case MESSAGE.CHECK_SERVER_READY:
        return checkServerReady(message.payload || {});
      case MESSAGE.CHECK_SERVER_LIVE:
        return checkServerLive(message.payload || {});
      case MESSAGE.START_SESSION:
        return startSession(message.payload || {});
      case MESSAGE.RECOVER_SESSION:
        return recoverSession(message.payload || {});
      case MESSAGE.RETRY_SESSION:
        return sendToOffscreen(MESSAGE.RETRY_SESSION);
      case MESSAGE.STOP_SESSION:
        return sendToOffscreen(MESSAGE.STOP_SESSION, message.payload || {});
      case MESSAGE.GET_SESSION_SNAPSHOT:
        return sendToOffscreen(MESSAGE.GET_SESSION_SNAPSHOT);
      case MESSAGE.TIMELINE_EVENT:
        return sendToOffscreen(MESSAGE.TIMELINE_EVENT, {
          ...(message.payload || {}),
          sourceTabId: sender.tab?.id
        });
      case MESSAGE.SEEK_TO:
        await chrome.tabs.sendMessage(Number(message.payload?.tabId), {
          target: TARGET.CONTENT,
          type: MESSAGE.SEEK_TO,
          payload: { timestampMs: Number(message.payload?.timestampMs) || 0 }
        });
        return { ok: true };
      case MESSAGE.EXPORT_PRESERVED_CHUNKS:
        return sendToOffscreen(MESSAGE.EXPORT_PRESERVED_CHUNKS);
      case MESSAGE.DISCARD_SESSION:
        return sendToOffscreen(MESSAGE.DISCARD_SESSION, message.payload || {});
      default:
        return { ok: false, error: `알 수 없는 메시지: ${message.type}` };
    }
  })()
    .then((result) => sendResponse(result || { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void sendToOffscreen(MESSAGE.TAB_REMOVED, { tabId }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "loading") return;
  void sendToOffscreen(MESSAGE.TAB_UPDATED, {
    tabId,
    url: changeInfo.url || "",
    status: changeInfo.status || ""
  }).catch(() => {});
});
