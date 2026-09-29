(function initializeSidePanel() {
  const { TARGET, MESSAGE, SESSION_STATE } = LectureProtocol;
  const Core = LectureCore;
  const DOCUMENTS_REQUEST_TIMEOUT_MS = 75_000;
  const PARTIAL_SUMMARY_TIMEOUT_MS = 480_000;

  const elements = {
    statusBadge: document.querySelector("#statusBadge"),
    userId: document.querySelector("#userId"),
    accessToken: document.querySelector("#accessToken"),
    credentialArea: document.querySelector(".credential-area"),
    credentialFields: document.querySelector("#credentialFields"),
    credentialSummary: document.querySelector("#credentialSummary"),
    credentialUserSummary: document.querySelector("#credentialUserSummary"),
    changeCredentialsButton: document.querySelector("#changeCredentialsButton"),
    startButton: document.querySelector("#startButton"),
    stopButton: document.querySelector("#stopButton"),
    exportPreservedButton: document.querySelector("#exportPreservedButton"),
    discardButton: document.querySelector("#discardButton"),
    connectionMessage: document.querySelector("#connectionMessage"),
    serverConnection: document.querySelector("#serverConnection"),
    serverConnectionText: document.querySelector("#serverConnectionText"),
    storageReadiness: document.querySelector("#storageReadiness"),
    storageReadinessText: document.querySelector("#storageReadinessText"),
    providerStatus: document.querySelector("#providerStatus"),
    providerStatusText: document.querySelector("#providerStatusText"),
    elapsedValue: document.querySelector("#elapsedValue"),
    queueValue: document.querySelector("#queueValue"),
    sequenceValue: document.querySelector("#sequenceValue"),
    searchInput: document.querySelector("#searchInput"),
    copyButton: document.querySelector("#copyButton"),
    captionsList: document.querySelector("#captionsList"),
    summaryText: document.querySelector("#summaryText"),
    conceptsList: document.querySelector("#conceptsList"),
    termsList: document.querySelector("#termsList"),
    highlightsList: document.querySelector("#highlightsList"),
    checklistList: document.querySelector("#checklistList"),
    refreshDocumentsButton: document.querySelector("#refreshDocumentsButton"),
    documentsMessage: document.querySelector("#documentsMessage"),
    documentsList: document.querySelector("#documentsList"),
    documentDetail: document.querySelector("#documentDetail"),
    backToDocumentsButton: document.querySelector("#backToDocumentsButton"),
    documentTitle: document.querySelector("#documentTitle"),
    documentMeta: document.querySelector("#documentMeta"),
    documentSummaryHeading: document.querySelector("#documentSummaryHeading"),
    documentCoverage: document.querySelector("#documentCoverage"),
    retryPartialSummaryButton: document.querySelector("#retryPartialSummaryButton"),
    documentSummary: document.querySelector("#documentSummary"),
    documentTranscript: document.querySelector("#documentTranscript")
  };

  let snapshot = { state: SESSION_STATE.IDLE, captions: [], notes: {}, providerStatus: { state: "not_checked" } };
  let snapshotReceivedAt = Date.now();
  let startActionPending = false;
  let localConnectionMessage = "";
  let credentialsCollapsed = false;
  let documentsRequestController = null;

  const statusPresentation = {
    IDLE: ["대기", "status-idle"],
    STARTING: ["준비 중", "status-starting"],
    CAPTURING: ["캡처 중", "status-capturing"],
    PAUSED_BACKPRESSURE: ["큐 대기", "status-paused"],
    PAUSED_QUOTA: ["할당량 소진", "status-error"],
    PAUSED_ACTION: ["사용자 조치 필요", "status-error"],
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
      SESSION_STATE.PAUSED_ACTION,
      SESSION_STATE.STOPPING
    ].includes(snapshot.state);
  }

  function renderStatus() {
    const [label, className] = statusPresentation[snapshot.state] || statusPresentation.IDLE;
    elements.statusBadge.textContent = label;
    elements.statusBadge.className = `status ${className}`;
    const active = isRunning();
    const retryingQuota = snapshot.state === SESSION_STATE.PAUSED_QUOTA;
    const recoveringSession = Boolean(snapshot.recoveryRequired && snapshot.hasStream && snapshot.state === SESSION_STATE.PAUSED_ACTION);
    const processingPreserved = Boolean(!snapshot.hasStream && (snapshot.queueCount > 0 || snapshot.finalizePending) && [SESSION_STATE.STOPPED, SESSION_STATE.ERROR, SESSION_STATE.PAUSED_ACTION].includes(snapshot.state));
    elements.startButton.textContent = processingPreserved ? "보존 청크 처리" : (recoveringSession ? "서버 세션 복구" : (retryingQuota ? "처리 다시 시도" : "캡처 시작"));
    elements.startButton.disabled = startActionPending || (active && !recoveringSession && !retryingQuota && !processingPreserved);
    elements.stopButton.disabled = !active || snapshot.state === SESSION_STATE.STOPPING;
    const needsAction = snapshot.state === SESSION_STATE.PAUSED_ACTION;
    elements.exportPreservedButton.hidden = !(snapshot.queueCount > 0);
    elements.discardButton.hidden = !needsAction;
    elements.userId.disabled = active && !needsAction;
    elements.accessToken.disabled = active && !needsAction;
    elements.changeCredentialsButton.disabled = active && !needsAction;
    renderCredentials();
    elements.connectionMessage.textContent = localConnectionMessage || snapshot.error || snapshot.notice;
  }

  function credentialsComplete() {
    return Boolean(elements.userId.value.trim() && elements.accessToken.value.trim());
  }

  function renderCredentials() {
    const collapsed = credentialsCollapsed && credentialsComplete();
    elements.credentialFields.hidden = collapsed;
    elements.credentialSummary.hidden = !collapsed;
    elements.changeCredentialsButton.hidden = !collapsed;
    elements.credentialUserSummary.textContent = elements.userId.value.trim();
  }

  function expandCredentials(focusTarget = null) {
    credentialsCollapsed = false;
    renderCredentials();
    if (focusTarget) focusTarget.focus();
  }

  function setConnectionMessage(message) {
    localConnectionMessage = String(message || "");
    elements.connectionMessage.textContent = localConnectionMessage;
  }

  function renderServerConnection(state, detail = "") {
    const labels = {
      checking: "연결 확인 중",
      connected: "연결 완료",
      degraded: "응답 상태 비정상",
      unavailable: "연결 확인 필요"
    };
    elements.serverConnection.dataset.state = state;
    elements.serverConnectionText.textContent = labels[state] || labels.unavailable;
    elements.serverConnection.title = detail || "";
  }

  function renderStorageReadiness(state, detail = "") {
    const labels = {
      checking: "확인 중",
      ready: "준비 완료",
      unavailable: "확인 필요",
      unknown: "캡처 시작 시 확인"
    };
    elements.storageReadiness.dataset.state = state;
    elements.storageReadinessText.textContent = labels[state] || labels.unknown;
    elements.storageReadiness.title = detail || "";
  }

  function renderProviderStatus(providerStatus = {}) {
    const state = providerStatus?.state || "not_checked";
    const labels = {
      not_checked: "실제 요청 전",
      mock_mode: "모의 모드",
      success: "최근 GPT 처리 성공",
      quota_exhausted: "할당량 소진",
      rate_limited: "요청 속도 제한",
      overloaded: "GPT 일시 과부하",
      invalid_request: "요청 형식 오류",
      request_failed: "GPT 요청 실패"
    };
    elements.providerStatus.dataset.state = state;
    elements.providerStatusText.textContent = labels[state] || labels.request_failed;
    elements.providerStatus.title = providerStatus?.detail || "상태 시험을 위한 GPT 요청은 보내지 않습니다.";
  }

  function renderMetrics() {
    elements.elapsedValue.textContent = Core.formatClock(snapshot.elapsedMs || 0);
    elements.queueValue.textContent = formatBytes(snapshot.estimatedQueueBytes || snapshot.queueBytes || 0);
    elements.sequenceValue.textContent = String((snapshot.stats?.lastSequence ?? -1) + 1);
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
      setConnectionMessage(error.message);
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
    elements.summaryText.textContent = notes.summary
      ? `${snapshot.archivedIncomplete ? "[부분 요약: 누락된 내용 제외]\n" : ""}${notes.summary}`
      : "요약이 아직 없습니다.";
    elements.summaryText.classList.toggle("empty-state", !notes.summary);
    renderList(elements.conceptsList, notes.concepts, "주요 개념이 아직 없습니다.");
    renderList(elements.termsList, notes.terms, "전문 용어가 아직 없습니다.");
    renderList(elements.highlightsList, notes.highlights, "강조 내용이 아직 없습니다.");
    renderList(elements.checklistList, notes.checklist, "복습 항목이 아직 없습니다.");
  }

  function render(nextSnapshot) {
    if (nextSnapshot) localConnectionMessage = "";
    snapshot = { ...snapshot, ...(nextSnapshot || {}) };
    snapshotReceivedAt = Date.now();
    renderProviderStatus(snapshot.providerStatus);
    renderStatus();
    renderMetrics();
    renderCaptions();
    renderNotes();
  }

  async function startCapture() {
    const userId = elements.userId.value.trim();
    if (!userId) {
      setConnectionMessage("관리자에게 받은 사용자 ID를 입력해 주세요.");
      expandCredentials(elements.userId);
      return;
    }
    const accessToken = elements.accessToken.value.trim();
    if (!accessToken) {
      setConnectionMessage("관리자에게 받은 접속 코드를 입력해 주세요.");
      expandCredentials(elements.accessToken);
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("현재 탭을 찾을 수 없습니다.");
    setConnectionMessage("캡처를 준비하고 있습니다.");
    renderStorageReadiness("checking");
    elements.startButton.disabled = true;
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.START_SESSION,
      payload: {
        tabId: tab.id,
        serverBaseUrl: LectureConfig.SERVER_BASE_URL,
        userId,
        accessToken
      }
    });
    if (!response?.ok) {
      const errorMessage = response?.error || "캡처를 시작하지 못했습니다.";
      if (/401|인증|접속 코드|사용자 ID/i.test(errorMessage)) expandCredentials(elements.accessToken);
      throw new Error(errorMessage);
    }
    if (response.readinessOnly) {
      setConnectionMessage(response.message || "서버가 준비됐습니다. 캡처 시작을 다시 눌러 주세요.");
      return;
    }
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

  async function discardSession() {
    if (!confirm("보존된 원본 청크와 미완료 세션을 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return;
    const userId = elements.userId.value.trim();
    const accessToken = elements.accessToken.value.trim();
    if (!userId || !accessToken) {
      setConnectionMessage("서버 초안을 삭제하려면 사용자 ID와 접속 코드를 다시 입력해 주세요.");
      return;
    }
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.DISCARD_SESSION,
      payload: { userId, accessToken }
    });
    if (response?.snapshot) render(response.snapshot);
    if (!response?.ok) throw new Error(response?.error || "보존 세션을 폐기하지 못했습니다.");
  }

  async function exportPreservedChunks() {
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.EXPORT_PRESERVED_CHUNKS
    });
    if (!response?.ok) throw new Error(response?.error || "보존 오디오를 내보내지 못했습니다.");
    setConnectionMessage(`보존 오디오 ${response.count || 0}개 다운로드를 요청했습니다.`);
  }

  async function recoverSession() {
    const tabId = Number(snapshot.sourceTabId);
    if (!Number.isInteger(tabId)) throw new Error("기존 캡처 탭을 찾을 수 없습니다.");
    elements.startButton.disabled = true;
    setConnectionMessage("서버 세션과 보존 청크를 복구하고 있습니다.");
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.RECOVER_SESSION,
      payload: { tabId }
    });
    if (response?.snapshot) render(response.snapshot);
    if (!response?.ok) throw new Error(response?.error || "서버 세션을 복구하지 못했습니다.");
  }

  async function processPreservedChunks() {
    const userId = elements.userId.value.trim();
    const accessToken = elements.accessToken.value.trim();
    if (!userId || !accessToken) {
      expandCredentials(!userId ? elements.userId : elements.accessToken);
      throw new Error("사용자 ID와 접속 코드를 입력해 주세요.");
    }
    setConnectionMessage("보존된 오디오 청크를 처리하고 있습니다.");
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.PROCESS_PRESERVED_CHUNKS,
      payload: {
        serverBaseUrl: LectureConfig.SERVER_BASE_URL,
        userId,
        accessToken,
        sourceUrl: snapshot.sourceUrl
      }
    });
    if (response?.snapshot) render(response.snapshot);
    if (!response?.ok) throw new Error(response?.error || "보존 청크를 처리하지 못했습니다.");
  }

  async function retrySession() {
    elements.startButton.disabled = true;
    setConnectionMessage("보존 청크 처리를 다시 시도합니다.");
    const response = await chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.RETRY_SESSION
    });
    if (response?.snapshot) render(response.snapshot);
    if (!response?.ok) throw new Error(response?.error || "청크 처리를 다시 시작하지 못했습니다.");
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
        ...captions.map((item) => `[${Core.formatClock(item.start_ms)}] ${item.text}`)
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
      "## 자막",
      "",
      ...captions.map((item) => `- [${Core.formatClock(item.start_ms)}] ${item.text}`),
      "",
      ...(snapshot.gaps?.length ? ["## 누락 구간", "", ...snapshot.gaps.map((gap) => `- ${Core.formatClock(gap.start_ms)}–${Core.formatClock(gap.end_ms || gap.start_ms)}: ${gap.reason}`)] : [])
    ].join("\n");
  }

  function documentStatusLabel(status) {
    const labels = {
      completed: "완료",
      incomplete: "미완료 · 이어서 복구 가능",
      finalize_pending: "최종 요약 처리 중"
    };
    return labels[status] || "저장됨";
  }

  function formatDocumentDate(value) {
    if (!value) return "날짜 없음";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "날짜 없음" : date.toLocaleString("ko-KR");
  }

  async function authenticatedDocumentRequest(path, signal, options = {}) {
    const userId = elements.userId.value.trim();
    const accessToken = elements.accessToken.value.trim();
    if (!userId || !accessToken) {
      expandCredentials(!userId ? elements.userId : elements.accessToken);
      throw new Error("저장 문서를 조회하려면 사용자 ID와 접속 코드를 입력해 주세요.");
    }
    let response;
    try {
      response = await fetch(`${LectureConfig.SERVER_BASE_URL}${path}`, {
        method: options.method || "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-User-ID": userId,
          ...(options.body ? { "Content-Type": "application/json" } : {})
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal
      });
    } catch (error) {
      if (!signal?.aborted || signal?.reason === "timeout") {
        renderServerConnection("unavailable", error.message);
        renderStorageReadiness("unknown", "서버 응답을 받지 못했습니다.");
      }
      throw error;
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    renderServerConnection("connected");
    if (response.ok) renderStorageReadiness("ready");
    else if (payload?.error?.code === "storage_unavailable") {
      renderStorageReadiness("unavailable", payload?.error?.message || "저장소 연결을 확인해 주세요.");
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        expandCredentials(elements.accessToken);
      }
      const detail = payload?.error?.message || payload?.detail || `문서 조회 실패 (${response.status})`;
      throw new Error(detail);
    }
    return payload;
  }

  function beginDocumentsRequest(message) {
    documentsRequestController?.abort();
    documentsRequestController = new AbortController();
    elements.documentsMessage.textContent = message;
    return documentsRequestController;
  }

  async function loadDocuments() {
    elements.documentDetail.hidden = true;
    elements.documentsList.hidden = false;
    elements.documentsMessage.hidden = false;
    const controller = beginDocumentsRequest("저장 문서를 불러오는 중입니다.");
    const timeout = setTimeout(() => controller.abort("timeout"), DOCUMENTS_REQUEST_TIMEOUT_MS);
    try {
      const payload = await authenticatedDocumentRequest("/v1/documents?limit=50", controller.signal);
      if (controller !== documentsRequestController) return;
      const documents = Array.isArray(payload?.items) ? payload.items : [];
      elements.documentsList.replaceChildren();
      if (documents.length === 0) {
        elements.documentsMessage.textContent = "저장된 문서가 없습니다.";
        return;
      }
      elements.documentsMessage.hidden = true;
      const fragment = document.createDocumentFragment();
      for (const item of documents) {
        const row = document.createElement("article");
        row.className = "document-row";
        const button = document.createElement("button");
        button.className = "document-button";
        button.type = "button";
        const title = document.createElement("strong");
        title.className = "document-title";
        title.textContent = item?.source?.title || "제목 없는 강의";
        const meta = document.createElement("span");
        meta.className = "document-meta";
        meta.textContent = `${documentStatusLabel(item?.status)} · ${formatDocumentDate(item?.updated_at || item?.requested_at)}`;
        button.append(title, meta);
        button.addEventListener("click", () => {
          void loadDocumentDetail(item?.document_id).catch((error) => {
            if (error.name !== "AbortError") setConnectionMessage(error.message);
          });
        });
        row.append(button);
        fragment.append(row);
      }
      elements.documentsList.append(fragment);
    } catch (error) {
      if (error.name !== "AbortError" && controller === documentsRequestController) {
        elements.documentsList.replaceChildren();
        elements.documentsMessage.textContent = error.message;
      } else if (error.name === "AbortError" && controller === documentsRequestController) {
        elements.documentsMessage.textContent = "문서 조회 시간이 초과되었습니다. 다시 시도해 주세요.";
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function loadDocumentDetail(documentId) {
    if (!documentId) throw new Error("문서 ID를 찾을 수 없습니다.");
    const controller = beginDocumentsRequest("문서 내용을 불러오는 중입니다.");
    elements.documentsList.hidden = true;
    elements.documentsMessage.hidden = false;
    elements.documentDetail.hidden = true;
    const timeout = setTimeout(() => controller.abort("timeout"), DOCUMENTS_REQUEST_TIMEOUT_MS);
    try {
      const item = await authenticatedDocumentRequest(`/v1/documents/${encodeURIComponent(documentId)}`, controller.signal);
      if (controller !== documentsRequestController) return;
      const segments = Array.isArray(item?.transcript?.segments) ? item.transcript.segments : [];
      const transcript = item?.transcript?.text || segments
        .map((segment) => `[${Core.formatClock(segment.start_ms || 0)}] ${segment.text || ""}`)
        .join("\n");
      const summary = item?.summary?.summary || (typeof item?.summary === "string" ? item.summary : "");
      const missingCount = item?.chunk_state?.missing_sequences?.length || 0;
      const gapCount = item?.missing_time_ranges?.length || 0;
      const incomplete = item?.status === "incomplete";
      elements.documentTitle.textContent = item?.source?.title || "제목 없는 강의";
      elements.documentMeta.textContent = `${documentStatusLabel(item?.status)} · ${formatDocumentDate(item?.updated_at || item?.requested_at)}`;
      elements.documentSummaryHeading.textContent = incomplete && summary ? "부분 요약" : "요약";
      elements.documentCoverage.hidden = !incomplete;
      elements.documentCoverage.textContent = incomplete
        ? `자막 누락 청크 ${missingCount}개 · 녹음 중단 구간 ${gapCount}개. 확보된 자막만 요약할 수 있습니다.`
        : "";
      elements.retryPartialSummaryButton.hidden = !incomplete || Boolean(summary) || !transcript.trim() || item?.resume_status !== "available";
      elements.retryPartialSummaryButton.dataset.sessionId = item?.session_id || "";
      elements.retryPartialSummaryButton.dataset.documentId = item?.document_id || "";
      elements.retryPartialSummaryButton.dataset.expectedCount = String(item?.chunk_state?.expected_chunk_count || 0);
      elements.retryPartialSummaryButton.dataset.durationMs = String(item?.duration_ms || 0);
      elements.retryPartialSummaryButton.dataset.sourceTitle = item?.source?.title || "";
      elements.retryPartialSummaryButton.dataset.gaps = JSON.stringify(item?.missing_time_ranges || []);
      elements.documentSummary.textContent = summary || (item?.summary_error_code
        ? `부분 요약 생성에 실패했습니다 (${item.summary_error_code}). 다시 시도해 주세요.`
        : "확보된 자막의 요약이 아직 없습니다.");
      elements.documentTranscript.textContent = transcript || "저장된 자막이 없습니다.";
      elements.documentsMessage.hidden = true;
      elements.documentDetail.hidden = false;
    } catch (error) {
      if (controller === documentsRequestController) {
        elements.documentsMessage.textContent = error.name === "AbortError"
          ? "문서 상세 조회 시간이 초과되었습니다. 다시 시도해 주세요."
          : error.message;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function retryPartialSummary() {
    const button = elements.retryPartialSummaryButton;
    const sessionId = button.dataset.sessionId;
    if (!sessionId) throw new Error("복구할 세션 ID가 없습니다.");
    button.disabled = true;
    button.textContent = "부분 요약을 생성하고 있습니다.";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), PARTIAL_SUMMARY_TIMEOUT_MS);
    try {
      const result = await authenticatedDocumentRequest(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`, controller.signal, {
        method: "POST",
        body: {
          source_title: button.dataset.sourceTitle,
          duration_ms: Number(button.dataset.durationMs),
          expected_chunk_count: Number(button.dataset.expectedCount),
          capture_gaps: JSON.parse(button.dataset.gaps || "[]")
        }
      });
      await loadDocumentDetail(button.dataset.documentId);
      if (!result?.summary) throw new Error("부분 요약을 생성하지 못했습니다. 문서 상태를 확인하고 다시 시도해 주세요.");
    } finally {
      clearTimeout(timeout);
      button.disabled = false;
      button.textContent = "확보된 자막으로 부분 요약 생성";
    }
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

  async function warmServerOnPanelOpen() {
    renderServerConnection("checking");
    try {
      const response = await chrome.runtime.sendMessage({
        target: TARGET.SERVICE_WORKER,
        type: MESSAGE.CHECK_SERVER_LIVE,
        payload: { serverBaseUrl: LectureConfig.SERVER_BASE_URL }
      });
      if (response?.state) renderServerConnection(response.state, response.error || "");
      else if (!response?.ok) renderServerConnection("unavailable", response?.error || "Render에 연결할 수 없습니다.");
    } catch (error) {
      renderServerConnection("unavailable", error.message);
    }
  }

  elements.startButton.addEventListener("click", () => {
    const processingPreserved = !snapshot.hasStream && (snapshot.queueCount > 0 || snapshot.finalizePending) && [SESSION_STATE.STOPPED, SESSION_STATE.ERROR, SESSION_STATE.PAUSED_ACTION].includes(snapshot.state);
    const action = processingPreserved
      ? processPreservedChunks
      : (snapshot.recoveryRequired && snapshot.hasStream && snapshot.state === SESSION_STATE.PAUSED_ACTION)
      ? recoverSession
      : (snapshot.state === SESSION_STATE.PAUSED_QUOTA ? retrySession : startCapture);
    startActionPending = true;
    renderStatus();
    action()
      .catch((error) => {
        setConnectionMessage(error.message);
      })
      .finally(() => {
        startActionPending = false;
        renderStatus();
      });
  });
  elements.stopButton.addEventListener("click", () => {
    stopCapture().catch((error) => {
      setConnectionMessage(error.message);
      elements.stopButton.disabled = false;
    });
  });
  elements.discardButton.addEventListener("click", () => {
    discardSession().catch((error) => { setConnectionMessage(error.message); });
  });
  elements.exportPreservedButton.addEventListener("click", () => {
    exportPreservedChunks().catch((error) => { setConnectionMessage(error.message); });
  });
  elements.changeCredentialsButton.addEventListener("click", () => {
    const active = isRunning();
    if (active && snapshot.state !== SESSION_STATE.PAUSED_ACTION) return;
    expandCredentials(elements.accessToken);
  });
  for (const input of [elements.userId, elements.accessToken]) {
    input.addEventListener("input", renderCredentials);
  }
  elements.credentialArea.addEventListener("focusout", (event) => {
    if (event.relatedTarget && elements.credentialArea.contains(event.relatedTarget)) return;
    setTimeout(() => {
      if (credentialsComplete() && !elements.credentialArea.contains(document.activeElement)) {
        credentialsCollapsed = true;
        renderCredentials();
      }
    }, 0);
  });
  elements.refreshDocumentsButton.addEventListener("click", () => {
    void loadDocuments();
  });
  elements.backToDocumentsButton.addEventListener("click", () => {
    void loadDocuments();
  });
  elements.retryPartialSummaryButton.addEventListener("click", () => {
    void retryPartialSummary().catch((error) => { setConnectionMessage(error.message); });
  });
  elements.searchInput.addEventListener("input", renderCaptions);
  elements.copyButton.addEventListener("click", () => {
    const text = finalCaptions().map((item) => `[${Core.formatClock(item.start_ms)}] ${item.text}`).join("\n");
    navigator.clipboard.writeText(text).catch((error) => {
      setConnectionMessage(`복사 실패: ${error.message}`);
    });
  });
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelectorAll(".panel").forEach((panel) => {
        panel.classList.toggle("active", panel.id === `${button.dataset.tab}Panel`);
      });
      if (button.dataset.tab === "documents") void loadDocuments();
    });
  });

  document.querySelectorAll("[data-export]").forEach((button) => {
    button.addEventListener("click", () => download(button.dataset.export));
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target === TARGET.SIDEPANEL && message.type === MESSAGE.SESSION_SNAPSHOT) {
      render(message.payload || {});
      return;
    }
    if (message?.target === TARGET.SIDEPANEL && message.type === MESSAGE.SERVER_LIVE_STATUS) {
      const payload = message.payload || {};
      renderServerConnection(payload.state || "unavailable", payload.detail || "");
      return;
    }
    if (message?.target === TARGET.SIDEPANEL && message.type === MESSAGE.SERVER_READY_STATUS) {
      const payload = message.payload || {};
      renderStorageReadiness(payload.state || "unknown", payload.detail || "");
    }
  });

  setInterval(() => {
    if (!isRunning() || !snapshot.startedAtEpochMs) return;
    const drift = Date.now() - snapshotReceivedAt;
    elements.elapsedValue.textContent = Core.formatClock((snapshot.elapsedMs || 0) + drift);
  }, 1000);

  void loadSnapshot();
  void warmServerOnPanelOpen();
})();
