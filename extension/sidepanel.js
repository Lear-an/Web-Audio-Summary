(function initializeSidePanel() {
  const { TARGET, MESSAGE, SESSION_STATE } = LectureProtocol;
  const Core = LectureCore;

  const elements = {
    statusBadge: document.querySelector("#statusBadge"),
    serverUrl: document.querySelector("#serverUrl"),
    accessToken: document.querySelector("#accessToken"),
    geminiApiKey: document.querySelector("#geminiApiKey"),
    startButton: document.querySelector("#startButton"),
    stopButton: document.querySelector("#stopButton"),
    connectionMessage: document.querySelector("#connectionMessage"),
    elapsedValue: document.querySelector("#elapsedValue"),
    queueValue: document.querySelector("#queueValue"),
    sequenceValue: document.querySelector("#sequenceValue"),
    latencyValue: document.querySelector("#latencyValue"),
    searchInput: document.querySelector("#searchInput"),
    copyButton: document.querySelector("#copyButton"),
    captionsList: document.querySelector("#captionsList"),
    summaryText: document.querySelector("#summaryText"),
    conceptsList: document.querySelector("#conceptsList"),
    termsList: document.querySelector("#termsList"),
    highlightsList: document.querySelector("#highlightsList"),
    checklistList: document.querySelector("#checklistList"),
    bookmarkMemo: document.querySelector("#bookmarkMemo"),
    bookmarkButton: document.querySelector("#bookmarkButton"),
    bookmarksList: document.querySelector("#bookmarksList")
  };

  let snapshot = { state: SESSION_STATE.IDLE, captions: [], bookmarks: [], notes: {} };
  let snapshotReceivedAt = Date.now();

  const statusPresentation = {
    IDLE: ["대기", "status-idle"],
    STARTING: ["준비 중", "status-starting"],
    CAPTURING: ["캡처 중", "status-capturing"],
    PAUSED_BACKPRESSURE: ["큐 대기", "status-paused"],
    PAUSED_QUOTA: ["할당량 소진", "status-error"],
    STOPPING: ["종료 중", "status-starting"],
    STOPPED: ["종료됨", "status-stopped"],
    ERROR: ["오류", "status-error"]
  };

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }

  function isRunning() {
    return [
      SESSION_STATE.STARTING,
      SESSION_STATE.CAPTURING,
      SESSION_STATE.PAUSED_BACKPRESSURE,
      SESSION_STATE.PAUSED_QUOTA,
      SESSION_STATE.STOPPING
    ].includes(snapshot.state);
  }

  function renderStatus() {
    const [label, className] = statusPresentation[snapshot.state] || statusPresentation.IDLE;
    elements.statusBadge.textContent = label;
    elements.statusBadge.className = `status ${className}`;
    const active = isRunning();
    const awaitingNewKey = snapshot.state === SESSION_STATE.PAUSED_QUOTA;
    elements.startButton.textContent = awaitingNewKey ? "새 키로 계속" : "캡처 시작";
    elements.startButton.disabled = active && !awaitingNewKey;
    elements.stopButton.disabled = !active || snapshot.state === SESSION_STATE.STOPPING;
    elements.serverUrl.disabled = active;
    elements.accessToken.disabled = active;
    elements.geminiApiKey.disabled = active && !awaitingNewKey;
    elements.geminiApiKey.placeholder = awaitingNewKey
      ? "계속할 새 Gemini API 키"
      : "캡처 시작 시에만 사용";
    elements.connectionMessage.textContent = snapshot.error || snapshot.notice || "";
  }

  function renderMetrics() {
    elements.elapsedValue.textContent = Core.formatClock(snapshot.elapsedMs || 0);
    elements.queueValue.textContent = formatBytes(snapshot.estimatedQueueBytes || snapshot.queueBytes || 0);
    elements.sequenceValue.textContent = String((snapshot.stats?.lastSequence ?? -1) + 1);
    elements.latencyValue.textContent = snapshot.stats?.lastLatencyMs == null
      ? "-"
      : `${(snapshot.stats.lastLatencyMs / 1000).toFixed(1)}초`;
  }

  function appendHighlightedText(container, text, query) {
    const value = String(text || "");
    if (!query) {
      container.textContent = value;
      return;
    }
    const normalizedQuery = query.toLocaleLowerCase();
    const lower = value.toLocaleLowerCase();
    let cursor = 0;
    while (cursor < value.length) {
      const index = lower.indexOf(normalizedQuery, cursor);
      if (index < 0) {
        container.append(document.createTextNode(value.slice(cursor)));
        break;
      }
      if (index > cursor) container.append(document.createTextNode(value.slice(cursor, index)));
      const mark = document.createElement("mark");
      mark.textContent = value.slice(index, index + query.length);
      container.append(mark);
      cursor = index + query.length;
    }
  }

  function seekTo(timestampMs) {
    if (!Number.isInteger(Number(snapshot.sourceTabId))) return;
    chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.SEEK_TO,
      payload: { tabId: snapshot.sourceTabId, timestampMs }
    }).catch((error) => {
      elements.connectionMessage.textContent = error.message;
    });
  }

  function renderCaptions() {
    const query = elements.searchInput.value.trim();
    const all = [...(snapshot.captions || [])].sort((left, right) => left.start_ms - right.start_ms);
    const filtered = query
      ? all.filter((item) => String(item.text || "").toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      : all;
    const visible = filtered.slice(-500);

    elements.captionsList.replaceChildren();
    if (visible.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = query ? "검색 결과가 없습니다." : "자막을 기다리는 중입니다.";
      elements.captionsList.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const caption of visible) {
      const row = document.createElement("article");
      row.className = "caption-row";
      const time = document.createElement("button");
      time.className = "timestamp";
      time.type = "button";
      time.textContent = Core.formatClock(caption.start_ms);
      time.addEventListener("click", () => seekTo(caption.start_ms));
      const text = document.createElement("div");
      text.className = `caption-text ${caption.uncertain ? "uncertain" : ""}`;
      appendHighlightedText(text, caption.text, query);
      const state = document.createElement("span");
      state.className = "empty-state";
      state.textContent = caption.uncertain ? "불확실" : "";
      row.append(time, text, state);
      fragment.append(row);
    }
    elements.captionsList.append(fragment);
    if (!query) elements.captionsList.scrollTop = elements.captionsList.scrollHeight;
  }

  function renderList(element, values, emptyText) {
    element.replaceChildren();
    const items = Array.isArray(values) ? values : [];
    if (items.length === 0) {
      const item = document.createElement("li");
      item.className = "empty-state";
      item.textContent = emptyText;
      element.append(item);
      return;
    }
    for (const value of items) {
      const item = document.createElement("li");
      item.textContent = typeof value === "string" ? value : (value?.text || JSON.stringify(value));
      element.append(item);
    }
  }

  function renderNotes() {
    const notes = snapshot.notes || {};
    elements.summaryText.textContent = notes.summary || "요약이 아직 없습니다.";
    elements.summaryText.classList.toggle("empty-state", !notes.summary);
    renderList(elements.conceptsList, notes.concepts, "주요 개념이 아직 없습니다.");
    renderList(elements.termsList, notes.terms, "전문 용어가 아직 없습니다.");
    renderList(elements.highlightsList, notes.highlights, "강조 내용이 아직 없습니다.");
    renderList(elements.checklistList, notes.checklist, "복습 항목이 아직 없습니다.");
  }

  function renderBookmarks() {
    elements.bookmarksList.replaceChildren();
    const bookmarks = snapshot.bookmarks || [];
    if (bookmarks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "저장한 북마크가 없습니다.";
      elements.bookmarksList.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const bookmark of bookmarks) {
      const row = document.createElement("article");
      row.className = "bookmark-row";
      const time = document.createElement("button");
      time.className = "timestamp";
      time.type = "button";
      time.textContent = Core.formatClock(bookmark.timestamp_ms);
      time.addEventListener("click", () => seekTo(bookmark.timestamp_ms));
      const memo = document.createElement("div");
      memo.className = "caption-text";
      memo.textContent = bookmark.memo || "메모 없음";
      const remove = document.createElement("button");
      remove.className = "delete-button";
      remove.type = "button";
      remove.textContent = "삭제";
      remove.addEventListener("click", () => deleteBookmark(bookmark.id));
      row.append(time, memo, remove);
      fragment.append(row);
    }
    elements.bookmarksList.append(fragment);
  }

  function render(nextSnapshot) {
    snapshot = { ...snapshot, ...(nextSnapshot || {}) };
    snapshotReceivedAt = Date.now();
    renderStatus();
    renderMetrics();
    renderCaptions();
    renderNotes();
    renderBookmarks();
  }

  async function startCapture() {
    const accessToken = elements.accessToken.value.trim();
    if (!accessToken) {
      elements.connectionMessage.textContent = "로컬 서버 실행 화면에 표시된 액세스 토큰을 입력해 주세요.";
      elements.accessToken.focus();
      return;
    }
    const geminiApiKey = elements.geminiApiKey.value.trim();
    if (!geminiApiKey) {
      elements.connectionMessage.textContent = "Gemini API 키를 입력해 주세요.";
      elements.geminiApiKey.focus();
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("현재 탭을 찾을 수 없습니다.");
    elements.connectionMessage.textContent = "캡처를 준비하고 있습니다.";
    elements.startButton.disabled = true;
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.START_SESSION,
      payload: {
        tabId: tab.id,
        serverBaseUrl: elements.serverUrl.value.trim(),
        accessToken,
        geminiApiKey
      }
    });
    if (!response?.ok) throw new Error(response?.error || "캡처를 시작하지 못했습니다.");
    elements.geminiApiKey.value = "";
    if (response.snapshot) render(response.snapshot);
  }

  async function stopCapture() {
    elements.stopButton.disabled = true;
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.STOP_SESSION,
      payload: { reason: "사용자가 캡처를 종료했습니다." }
    });
    if (!response?.ok) throw new Error(response?.error || "캡처를 종료하지 못했습니다.");
    if (response.snapshot) render(response.snapshot);
  }

  async function continueWithNewKey() {
    const geminiApiKey = elements.geminiApiKey.value.trim();
    if (!geminiApiKey) {
      elements.connectionMessage.textContent = "계속 사용할 새 Gemini API 키를 입력해 주세요.";
      elements.geminiApiKey.focus();
      return;
    }
    elements.startButton.disabled = true;
    elements.connectionMessage.textContent = "새 Gemini API 키를 적용하고 있습니다.";
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.UPDATE_GEMINI_KEY,
      payload: { geminiApiKey }
    });
    if (!response?.ok) throw new Error(response?.error || "Gemini API 키를 교체하지 못했습니다.");
    elements.geminiApiKey.value = "";
    if (response.snapshot) render(response.snapshot);
  }

  async function addBookmark() {
    if (!Number.isInteger(Number(snapshot.sourceTabId))) {
      throw new Error("활성 캡처 세션이 없습니다.");
    }
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.ADD_BOOKMARK,
      payload: {
        tabId: snapshot.sourceTabId,
        memo: elements.bookmarkMemo.value.trim()
      }
    });
    if (!response?.ok) throw new Error(response?.error || "북마크를 저장하지 못했습니다.");
    elements.bookmarkMemo.value = "";
    if (response.snapshot) render(response.snapshot);
  }

  async function deleteBookmark(id) {
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.DELETE_BOOKMARK,
      payload: { id }
    });
    if (!response?.ok) throw new Error(response?.error || "북마크를 삭제하지 못했습니다.");
    if (response.snapshot) render(response.snapshot);
  }

  function finalCaptions() {
    return [...(snapshot.captions || [])].sort((left, right) => left.start_ms - right.start_ms);
  }

  function exportContent(format) {
    const captions = finalCaptions();
    const notes = snapshot.notes || {};
    if (format === "srt") {
      return captions.map((item, index) => [
        index + 1,
        `${Core.formatTimestamp(item.start_ms, ",")} --> ${Core.formatTimestamp(item.end_ms, ",")}`,
        item.text,
        ""
      ].join("\n")).join("\n");
    }
    if (format === "vtt") {
      return "WEBVTT\n\n" + captions.map((item) => [
        `${Core.formatTimestamp(item.start_ms)} --> ${Core.formatTimestamp(item.end_ms)}`,
        item.text,
        ""
      ].join("\n")).join("\n");
    }
    if (format === "txt") {
      return [
        notes.summary || "",
        "",
        ...captions.map((item) => `[${Core.formatClock(item.start_ms)}] ${item.text}`),
        "",
        "북마크",
        ...(snapshot.bookmarks || []).map((item) => `[${Core.formatClock(item.timestamp_ms)}] ${item.memo || ""}`)
      ].join("\n");
    }
    return [
      "# Lecture Memo",
      "",
      "## 핵심 요약",
      "",
      notes.summary || "요약 없음",
      "",
      "## 주요 개념",
      "",
      ...(notes.concepts || []).map((item) => `- ${item}`),
      "",
      "## 복습 체크리스트",
      "",
      ...(notes.checklist || []).map((item) => `- [ ] ${item}`),
      "",
      "## 전문 용어",
      "",
      ...(notes.terms || []).map((item) => `- ${item}`),
      "",
      "## 강사가 강조한 내용",
      "",
      ...(notes.highlights || []).map((item) => `- ${item}`),
      "",
      "## 북마크",
      "",
      ...(snapshot.bookmarks || []).map((item) => `- [${Core.formatClock(item.timestamp_ms)}] ${item.memo || ""}`),
      "",
      "## 자막",
      "",
      ...captions.map((item) => `- [${Core.formatClock(item.start_ms)}] ${item.text}`),
      "",
      ...(snapshot.gaps?.length ? ["## 누락 구간", "", ...snapshot.gaps.map((gap) => `- ${Core.formatClock(gap.start_ms)}–${Core.formatClock(gap.end_ms || gap.start_ms)}: ${gap.reason}`)] : [])
    ].join("\n");
  }

  function download(format) {
    const mimeTypes = { md: "text/markdown", txt: "text/plain", srt: "application/x-subrip", vtt: "text/vtt" };
    const blob = new Blob([exportContent(format)], { type: `${mimeTypes[format] || "text/plain"};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `lecture-memo-${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function loadSnapshot() {
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.GET_SESSION_SNAPSHOT
    });
    if (response?.snapshot) render(response.snapshot);
  }

  elements.startButton.addEventListener("click", () => {
    const action = snapshot.state === SESSION_STATE.PAUSED_QUOTA
      ? continueWithNewKey
      : startCapture;
    action().catch((error) => {
      elements.connectionMessage.textContent = error.message;
      elements.startButton.disabled = false;
    });
  });
  elements.stopButton.addEventListener("click", () => {
    stopCapture().catch((error) => {
      elements.connectionMessage.textContent = error.message;
      elements.stopButton.disabled = false;
    });
  });
  elements.searchInput.addEventListener("input", renderCaptions);
  elements.copyButton.addEventListener("click", () => {
    const text = finalCaptions().map((item) => `[${Core.formatClock(item.start_ms)}] ${item.text}`).join("\n");
    navigator.clipboard.writeText(text).catch((error) => {
      elements.connectionMessage.textContent = `복사 실패: ${error.message}`;
    });
  });
  elements.bookmarkButton.addEventListener("click", () => {
    addBookmark().catch((error) => { elements.connectionMessage.textContent = error.message; });
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelectorAll(".panel").forEach((panel) => {
        panel.classList.toggle("active", panel.id === `${button.dataset.tab}Panel`);
      });
    });
  });

  document.querySelectorAll("[data-export]").forEach((button) => {
    button.addEventListener("click", () => download(button.dataset.export));
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target === TARGET.SIDEPANEL && message.type === MESSAGE.SESSION_SNAPSHOT) {
      render(message.payload || {});
    }
  });

  setInterval(() => {
    if (!isRunning() || !snapshot.startedAtEpochMs) return;
    const drift = Date.now() - snapshotReceivedAt;
    elements.elapsedValue.textContent = Core.formatClock((snapshot.elapsedMs || 0) + drift);
  }, 1000);

  void loadSnapshot();
})();
