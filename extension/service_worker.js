importScripts("protocol.js");

const { TARGET, MESSAGE } = LectureProtocol;
let creatingOffscreen = null;

function serializeError(error) {
  return error instanceof Error ? error.message : String(error);
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

  const response = await sendToOffscreen(MESSAGE.START_SESSION, {
    streamId,
    sourceTabId: tabId,
    sourceUrl: tab.url || "",
    sourceTitle: tab.title || "",
    serverBaseUrl: payload.serverBaseUrl,
    userId: payload.userId,
    accessToken: payload.accessToken,
    videoState
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

async function addBookmark(payload) {
  const tabId = Number(payload?.tabId);
  const videoState = await getVideoState(tabId);
  return sendToOffscreen(MESSAGE.ADD_BOOKMARK, {
    memo: String(payload?.memo || "").slice(0, 200),
    videoTimeMs: videoState.currentTimeMs || 0
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
      case MESSAGE.ADD_BOOKMARK:
        return addBookmark(message.payload || {});
      case MESSAGE.DELETE_BOOKMARK:
        return sendToOffscreen(MESSAGE.DELETE_BOOKMARK, message.payload || {});
      case MESSAGE.EXPORT_PRESERVED_CHUNKS:
        return sendToOffscreen(MESSAGE.EXPORT_PRESERVED_CHUNKS);
      case MESSAGE.DISCARD_SESSION:
        return sendToOffscreen(MESSAGE.DISCARD_SESSION);
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
