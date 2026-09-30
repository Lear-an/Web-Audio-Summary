(function initializeOffscreenWorker() {
  const { TARGET, MESSAGE, SESSION_STATE } = LectureProtocol;
  const Core = LectureCore;
  const Outbox = LectureOutbox;
  const Discard = LectureDiscard;
  const Config = LectureConfig;

  const DEFAULT_WINDOW_MS = 15_000;
  const DEFAULT_OVERLAP_MS = 1_000;
  const MIN_PARTIAL_CHUNK_MS = 1_000;
  const SOFT_LIMIT = 96 * 1024 * 1024;
  const HARD_LIMIT = Config.OUTBOX_MAX_BYTES;
  const RESUME_LIMIT = 64 * 1024 * 1024;
  const REQUEST_TIMEOUT_MS = 480_000;
  const MAX_ATTEMPTS = 3;
  const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm"];

  function emptyNotes() {
    return {
      summary: "",
      concepts: [],
      terms: [],
      highlights: [],
      checklist: []
    };
  }

  function createEmptySession() {
    return {
      state: SESSION_STATE.IDLE,
      sourceTabId: null,
      sourceUrl: "",
      sourceTitle: "",
      serverBaseUrl: "",
      userId: "",
      accessToken: "",
      mockMode: false,
      providerStatus: { state: "not_checked", detail: "", updatedAtEpochMs: null },
      serverSessionId: null,
      stream: null,
      audioContext: null,
      sourceNode: null,
      analyserNode: null,
      mimeType: "",
      windowMs: DEFAULT_WINDOW_MS,
      windowIntervalMs: DEFAULT_WINDOW_MS - DEFAULT_OVERLAP_MS,
      overlapMs: DEFAULT_OVERLAP_MS,
      maxChunkBytes: 6_000_000,
      maxRequestBytes: 6_500_000,
      startedAtEpochMs: null,
      captureOriginPerf: null,
      stoppedAtEpochMs: null,
      schedulerTimer: null,
      schedulerGeneration: 0,
      nextSequence: 0,
      activeRecorders: new Map(),
      reviewRecorders: new Map(),
      reviewClips: new Map(),
      queue: [],
      queuedBytes: 0,
      inFlightBytes: 0,
      inFlightChunk: null,
      processing: false,
      processTimer: null,
      recoveryRequired: false,
      captions: [],
      gaps: [],
      openGap: null,
      notes: emptyNotes(),
      documentId: null,
      finalizePending: false,
      reviewCount: 0,
      archivedIncomplete: false,
      videoState: {
        hasVideo: false,
        paused: false,
        ended: false,
        currentTimeMs: 0,
        playbackRate: 1,
        observedAtEpochMs: Date.now()
      },
      timelineSuspended: false,
      stopping: false,
      notice: "",
      error: "",
      stats: {
        lastSequence: -1,
        lastLatencyMs: null,
        recentLatenciesMs: [],
        retries: 0,
        failedChunks: 0
      }
    };
  }

  let session = createEmptySession();

  function serializeError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  class HttpResponseError extends Error {
    constructor(message, status, retryAfter = null) {
      super(message);
      this.name = "HttpResponseError";
      this.status = Number(status) || 0;
      this.retryAfter = retryAfter;
    }
  }

  function isActiveState(state = session.state) {
    return [
      SESSION_STATE.STARTING,
      SESSION_STATE.CAPTURING,
      SESSION_STATE.PAUSED_BACKPRESSURE,
      SESSION_STATE.PAUSED_QUOTA,
      SESSION_STATE.PAUSED_ACTION,
      SESSION_STATE.STOPPING
    ].includes(state);
  }

  function audioBytes() {
    return session.queuedBytes + session.inFlightBytes;
  }

  function publicSnapshot() {
    const endAt = session.stoppedAtEpochMs || Date.now();
    const elapsedMs = session.startedAtEpochMs ? Math.max(0, endAt - session.startedAtEpochMs) : 0;
    const sortedCaptions = [...session.captions].sort((a, b) => a.start_ms - b.start_ms);
    return {
      state: session.state,
      sourceTabId: session.sourceTabId,
      sourceUrl: session.sourceUrl,
      startedAtEpochMs: session.startedAtEpochMs,
      elapsedMs,
      mimeType: session.mimeType,
      chunkSeconds: session.windowMs / 1000,
      chunkOverlapSeconds: session.overlapMs / 1000,
      queueBytes: audioBytes(),
      estimatedQueueBytes: Math.round(audioBytes() * 1.5),
      queueCount: session.queue.length + (session.processing ? 1 : 0),
      recoveryRequired: Boolean(session.recoveryRequired),
      archivedIncomplete: Boolean(session.archivedIncomplete),
      finalizePending: Boolean(session.finalizePending),
      reviewCount: session.reviewCount,
      hasStream: Boolean(session.stream),
      mockMode: Boolean(session.mockMode),
      providerStatus: { ...session.providerStatus },
      activeRecorderCount: session.activeRecorders.size,
      captions: sortedCaptions,
      gaps: [...session.gaps, ...(session.openGap ? [{ ...session.openGap, open: true }] : [])],
      notes: { ...session.notes },
      stats: {
        ...session.stats,
        p95LatencyMs: calculateP95(session.stats.recentLatenciesMs)
      },
      notice: session.notice,
      error: session.error
    };
  }

  function calculateP95(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  }

  function broadcastSnapshot() {
    chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.SESSION_SNAPSHOT,
      payload: publicSnapshot()
    }).catch(() => {});
  }

  function setState(state, notice = "") {
    session.state = state;
    session.notice = notice;
    if (state !== SESSION_STATE.ERROR) session.error = "";
    broadcastSnapshot();
  }

  function setError(error) {
    session.error = serializeError(error);
    session.notice = "";
    session.state = SESSION_STATE.ERROR;
    broadcastSnapshot();
  }

  function normalizeServerBaseUrl(rawValue) {
    const url = new URL(String(rawValue || ""));
    const isLocal = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && (url.port || "80") === "8050";
    const configured = new URL(Config.SERVER_BASE_URL);
    const isConfiguredProduction = url.protocol === "https:" && url.origin === configured.origin;
    if (!isLocal && !isConfiguredProduction) throw new Error("확장 프로그램에 등록되지 않은 서버 주소입니다.");
    return url.origin;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`요청이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${session.accessToken}`,
      "X-User-ID": session.userId,
      ...extra
    };
  }

  async function assertResponse(response) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new HttpResponseError(
        payload?.error?.message || payload?.detail || payload?.error || `서버 요청 실패 (${response.status})`,
        response.status,
        response.headers.get("Retry-After") || payload?.error?.retry_after_seconds
      );
      error.code = payload?.error?.code || "http_error";
      error.action = payload?.error?.action || null;
      error.retryable = payload?.error?.retryable === true;
      throw error;
    }
    return payload;
  }

  function applyServerHealth(payload) {
    if (payload?.status !== "ok") throw new Error("서버 상태가 정상적이지 않습니다.");
    const chunkSeconds = Core.clampNumber(payload.chunk_seconds, 15, 180);
    const overlapSeconds = Core.clampNumber(payload.chunk_overlap_seconds, 0, 30);
    if (overlapSeconds >= chunkSeconds) {
      throw new Error("서버의 오디오 청크 겹침 설정이 청크 길이보다 짧아야 합니다.");
    }
    session.windowMs = Math.round(chunkSeconds * 1000);
    session.overlapMs = Math.round(overlapSeconds * 1000);
    session.windowIntervalMs = session.windowMs - session.overlapMs;
    session.maxChunkBytes = Math.max(100_000, Number(payload.max_chunk_bytes) || 6_000_000);
    session.maxRequestBytes = Math.max(session.maxChunkBytes, Number(payload.max_request_bytes) || 6_500_000);
    session.mockMode = Boolean(payload.mock_mode);
    session.providerStatus = {
      state: session.mockMode ? "mock_mode" : "not_checked",
      detail: session.mockMode ? "서버가 모의 모드로 실행 중입니다." : "실제 GPT 요청 전입니다.",
      updatedAtEpochMs: Date.now()
    };
  }

  function recordProviderSuccess() {
    session.providerStatus = {
      state: session.mockMode ? "mock_mode" : "success",
      detail: session.mockMode ? "모의 응답이 반환되었습니다." : "최근 AI 처리 결과가 정상 반환되었습니다.",
      updatedAtEpochMs: Date.now()
    };
  }

  function recordProviderFailure(error) {
    const providerStates = {
      openai_quota_exhausted: "quota_exhausted",
      openai_rate_limited: "rate_limited",
      openai_overloaded: "overloaded",
      openai_invalid_request: "invalid_request",
      openai_invalid_response: "request_failed",
      openai_request_failed: "request_failed"
    };
    const state = providerStates[error?.code];
    if (!state) return;
    session.providerStatus = {
      state,
      detail: serializeError(error),
      updatedAtEpochMs: Date.now()
    };
  }

  async function createServerSession() {
    const response = await fetchWithTimeout(`${session.serverBaseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        source_tab_id: session.sourceTabId,
        source_url: session.sourceUrl,
        source_title: session.sourceTitle,
        language: "auto"
      })
    });
    const payload = await assertResponse(response);
    if (!payload?.session_id) throw new Error("서버가 세션 ID를 반환하지 않았습니다.");
    session.serverSessionId = payload.session_id;
    await preserveSessionMarker("ACTIVE");
  }

  async function preserveSessionMarker(state, detail = "") {
    if (!session.serverSessionId) return;
    const now = Date.now();
    await Outbox.put({
      id: `${session.serverSessionId}:session`,
      kind: "session",
      sessionId: session.serverSessionId,
      sourceUrl: session.sourceUrl,
      sourceTitle: session.sourceTitle,
      sequence: -1,
      size: 0,
      state,
      detail,
      createdAtEpochMs: now,
      updatedAtEpochMs: now,
      expiresAtEpochMs: now + Config.OUTBOX_RETENTION_HOURS * 60 * 60 * 1000,
      startedAtEpochMs: session.startedAtEpochMs,
      stoppedAtEpochMs: session.stoppedAtEpochMs,
      nextSequence: session.nextSequence,
      gaps: session.gaps
    }, Config.OUTBOX_MAX_BYTES);
  }

  async function resumeServerSession(sessionId) {
    const response = await fetchWithTimeout(
      `${session.serverBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/resume`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({})
      }
    );
    const payload = await assertResponse(response);
    session.serverSessionId = sessionId;
    session.captions = Array.isArray(payload?.segments) ? payload.segments : [];
    session.nextSequence = Math.max(
      Number(session.nextSequence) || 0,
      Math.max(0, Number(payload?.next_sequence) || 0)
    );
  }

  async function restoreRecoverableOutbox(includeReview = false) {
    await Outbox.markExpired();
    const latest = await Outbox.latestRecoverable(session.sourceUrl);
    if (!latest) return false;
    if (latest.state === "EXPIRED") {
      session.serverSessionId = latest.sessionId;
      const expiredRecords = await Outbox.listSession(latest.sessionId);
      session.queue = expiredRecords.filter((record) => record.kind !== "session");
      session.queuedBytes = session.queue.reduce((sum, chunk) => sum + Number(chunk.size || chunk.blob?.size || 0), 0);
      session.state = SESSION_STATE.PAUSED_ACTION;
      session.notice = "72시간이 지난 보존 청크가 있습니다. 내보내기 후 폐기하거나 세션을 정리해 주세요.";
      return true;
    }
    await resumeServerSession(latest.sessionId);
    const records = await Outbox.listSession(latest.sessionId);
    const marker = records.find((record) => record.kind === "session");
    if (marker) {
      session.sourceTitle = marker.sourceTitle || session.sourceTitle;
      session.startedAtEpochMs = marker.startedAtEpochMs || session.startedAtEpochMs;
      session.stoppedAtEpochMs = marker.stoppedAtEpochMs || null;
      session.finalizePending = marker.state === "FINALIZE_PENDING";
      session.archivedIncomplete = marker.state === "INCOMPLETE";
      session.gaps = Array.isArray(marker.gaps) ? marker.gaps : [];
    }
    const reviewRecords = records.filter((record) => record.kind === "chunk" && record.state === "REVIEW");
    session.reviewCount = reviewRecords.length;
    const pending = records.filter((record) => record.kind !== "session" && !["ACKED", "EXPIRED", "REVIEW"].includes(record.state));
    if (marker?.state === "INCOMPLETE" && pending.length === 0 && reviewRecords.length === 0) {
      await Outbox.remove(marker.id);
      session.serverSessionId = null;
      session.archivedIncomplete = false;
      session.notice = "이전 미완료 문서는 서버에 남아 있습니다. 새 캡처를 시작합니다.";
      return false;
    }
    session.queue = [...pending, ...(includeReview ? reviewRecords : [])].map((record) => ({ ...record, reviewRetry: record.state === "REVIEW", unavailableAttempts: record.unavailableAttempts || 0 }));
    session.queue.sort((left, right) => left.sequence - right.sequence);
    session.queuedBytes = session.queue.reduce((sum, chunk) => sum + Number(chunk.size || chunk.blob?.size || 0), 0);
    session.nextSequence = Math.max(
      session.nextSequence,
      ...records.filter((record) => record.kind !== "session").map((record) => Number(record.sequence) + 1)
    );
    session.notice = `보존된 세션과 청크 ${session.queue.length}개를 복구했습니다.`;
    for (const chunk of session.queue.filter((record) => Core.isSessionResumeRequired(record))) {
      chunk.state = "PENDING";
      await Outbox.updateState(chunk.id, "PENDING", "서버 세션 복원 완료");
    }
    session.recoveryRequired = false;
    if (pending.some((record) => record.state === "NEEDS_ACTION")) {
      session.state = SESSION_STATE.PAUSED_ACTION;
      session.notice = "사용자 조치가 필요한 원본 청크가 보존되어 있습니다.";
    }
    if (!includeReview && reviewRecords.length > 0 && pending.length === 0) {
      session.state = SESSION_STATE.PAUSED_ACTION;
      session.notice = `전사 확인이 필요한 청크 ${reviewRecords.length}개가 보존되어 있습니다. 원본을 내보내거나 재전사해 주세요.`;
    }
    if (!session.finalizePending && !session.archivedIncomplete) await preserveSessionMarker("ACTIVE");
    return true;
  }

  function chooseMimeType() {
    const supported = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
    if (!supported) throw new Error("이 Chrome에서는 WebM/Opus 오디오 녹음을 지원하지 않습니다.");
    return supported;
  }

  async function connectMediaStream(streamId) {
    session.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    const track = session.stream.getAudioTracks()[0];
    if (!track) throw new Error("탭에서 오디오 트랙을 찾을 수 없습니다.");
    track.addEventListener("ended", () => {
      if (isActiveState() && !session.stopping) void stopSession("오디오 스트림이 종료되었습니다.");
    }, { once: true });

    session.audioContext = new AudioContext();
    session.sourceNode = session.audioContext.createMediaStreamSource(session.stream);
    session.analyserNode = session.audioContext.createAnalyser();
    session.analyserNode.fftSize = 2048;
    session.sourceNode.connect(session.analyserNode);
    session.analyserNode.connect(session.audioContext.destination);
    await session.audioContext.resume();
  }

  function estimateVideoTimeMs() {
    const state = session.videoState;
    if (!state?.hasVideo) {
      return session.captureOriginPerf == null ? 0 : Math.max(0, performance.now() - session.captureOriginPerf);
    }
    if (state.paused || state.ended) return Math.max(0, Number(state.currentTimeMs) || 0);
    const observedAt = Number(state.observedAtEpochMs) || Date.now();
    const elapsed = Math.max(0, Date.now() - observedAt);
    return Math.max(0, (Number(state.currentTimeMs) || 0) + elapsed * (Number(state.playbackRate) || 1));
  }

  function cancelWindowScheduler() {
    session.schedulerGeneration += 1;
    if (session.schedulerTimer) clearTimeout(session.schedulerTimer);
    session.schedulerTimer = null;
  }

  function scheduleRecordingWindows(firstWindow = true) {
    if (session.state !== SESSION_STATE.CAPTURING || session.stopping) return;
    if (session.videoState?.hasVideo && (session.videoState.paused || session.timelineSuspended)) return;

    cancelWindowScheduler();
    const generation = session.schedulerGeneration;
    const firstTarget = performance.now();

    function scheduleAt(targetPerf, isFirst) {
      if (generation !== session.schedulerGeneration) return;
      const waitMs = Math.max(0, targetPerf - performance.now());
      session.schedulerTimer = setTimeout(() => {
        if (generation !== session.schedulerGeneration || session.state !== SESSION_STATE.CAPTURING) return;
        startRecorderWindow(isFirst);
        scheduleAt(targetPerf + session.windowIntervalMs, false);
      }, waitMs);
    }

    scheduleAt(firstTarget, firstWindow);
  }

  function createDeferred() {
    let resolve;
    const promise = new Promise((resolver) => { resolve = resolver; });
    return { promise, resolve };
  }

  function startRecorderWindow(firstAfterReset) {
    if (!session.stream || session.state !== SESSION_STATE.CAPTURING) return;
    const sequence = session.nextSequence;
    session.nextSequence += 1;
    const recorder = new MediaRecorder(session.stream, {
      mimeType: session.mimeType,
      audioBitsPerSecond: 64_000
    });
    const deferred = createDeferred();
    const context = {
      sequence,
      recorder,
      parts: [],
      startedPerf: performance.now(),
      captureStartMs: Math.max(0, Math.round(performance.now() - session.captureOriginPerf)),
      videoStartMs: Math.round(estimateVideoTimeMs()),
      playbackRate: Number(session.videoState?.playbackRate) || 1,
      overlapMs: firstAfterReset ? 0 : session.overlapMs,
      activitySamples: 0,
      audibleSamples: 0,
      failedActivitySamples: 0,
      activityTimer: null,
      stopTimer: null,
      donePromise: deferred.promise,
      resolveDone: deferred.resolve
    };

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size > 0) context.parts.push(event.data);
    });
    recorder.addEventListener("error", (event) => {
      session.notice = `녹음 오류: ${event.error?.message || "알 수 없는 오류"}`;
      broadcastSnapshot();
    });
    recorder.addEventListener("stop", () => void finalizeRecorder(context), { once: true });

    session.activeRecorders.set(sequence, context);
    recorder.start();
    // A separate window spans this chunk and the following one. The server
    // uses it only when the next chunk needs a second transcription.
    try {
      startReviewWindow(sequence + 1, context.captureStartMs);
    } catch {
      session.reviewRecorders.delete(sequence + 1);
      session.reviewClips.delete(sequence + 1);
    }
    if (session.analyserNode) {
      const waveform = new Float32Array(session.analyserNode.fftSize);
      const sample = () => {
        try {
          session.analyserNode.getFloatTimeDomainData(waveform);
          let squared = 0;
          let peak = 0;
          for (const value of waveform) {
            squared += value * value;
            peak = Math.max(peak, Math.abs(value));
          }
          context.activitySamples += 1;
          if (Math.sqrt(squared / waveform.length) >= 0.001 || peak >= 0.005) context.audibleSamples += 1;
        } catch {
          context.failedActivitySamples += 1;
        }
      };
      sample();
      context.activityTimer = setInterval(sample, 50);
    }
    context.stopTimer = setTimeout(() => stopRecorder(context), session.windowMs);
    broadcastSnapshot();
  }

  function startReviewWindow(targetSequence, captureStartMs) {
    const recorder = new MediaRecorder(session.stream, {
      mimeType: session.mimeType,
      audioBitsPerSecond: 64_000
    });
    const deferred = createDeferred();
    const context = {
      recorder,
      parts: [],
      captureStartMs,
      stopTimer: null,
      donePromise: deferred.promise,
      resolveDone: deferred.resolve
    };
    session.reviewRecorders.set(targetSequence, context);
    session.reviewClips.set(targetSequence, deferred.promise);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size > 0) context.parts.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      clearTimeout(context.stopTimer);
      session.reviewRecorders.delete(targetSequence);
      const durationMs = Math.max(0, Math.round(performance.now() - session.captureOriginPerf) - captureStartMs);
      deferred.resolve({
        blob: new Blob(context.parts, { type: recorder.mimeType || session.mimeType }),
        durationMs,
        captureStartMs
      });
      context.parts.length = 0;
    }, { once: true });
    recorder.addEventListener("error", () => stopRecorder(context), { once: true });
    try {
      recorder.start();
      context.stopTimer = setTimeout(() => stopRecorder(context), session.windowMs + session.windowIntervalMs);
    } catch {
      session.reviewRecorders.delete(targetSequence);
      session.reviewClips.delete(targetSequence);
      deferred.resolve(null);
    }
  }

  function stopRecorder(context) {
    if (!context) return;
    clearTimeout(context.stopTimer);
    if (context.activityTimer) clearInterval(context.activityTimer);
    context.activityTimer = null;
    if (context.recorder.state !== "inactive") {
      try {
        context.recorder.stop();
      } catch {
        context.resolveDone();
      }
    }
  }

  async function finalizeRecorder(context) {
    clearTimeout(context.stopTimer);
    if (context.activityTimer) clearInterval(context.activityTimer);
    session.activeRecorders.delete(context.sequence);
    const captureEndMs = Math.max(context.captureStartMs, Math.round(performance.now() - session.captureOriginPerf));
    const durationMs = captureEndMs - context.captureStartMs;
    const blob = new Blob(context.parts, { type: context.recorder.mimeType || session.mimeType });

    try {
      if (durationMs >= MIN_PARTIAL_CHUNK_MS && blob.size > 0) {
      const reviewPromise = session.reviewClips.get(context.sequence);
      const review = reviewPromise ? await reviewPromise : null;
      session.reviewClips.delete(context.sequence);
      const reviewBlob = review && Math.abs(context.captureStartMs - review.captureStartMs - session.windowIntervalMs) < 2_000
        && review.durationMs > session.windowMs && review.durationMs <= 30_000 && review.blob.size > 0
        && review.blob.size <= session.maxChunkBytes
        && review.blob.size + blob.size + 8_192 < session.maxRequestBytes ? review.blob : null;
      const oversized = blob.size > session.maxChunkBytes;
      if (blob.size > session.maxChunkBytes) {
        session.state = SESSION_STATE.PAUSED_ACTION;
        session.notice = `청크 ${context.sequence}이 서버 제한을 초과했습니다. 원본을 보존하고 캡처를 중단합니다.`;
        cancelWindowScheduler();
      }
      const chunk = {
        id: Outbox.recordId(session.serverSessionId, context.sequence),
        kind: "chunk",
        sessionId: session.serverSessionId,
        sourceUrl: session.sourceUrl,
        sequence: context.sequence,
        blob,
        reviewBlob,
        reviewDurationMs: reviewBlob ? review.durationMs : 0,
        size: blob.size + (reviewBlob?.size || 0),
        captureStartMs: context.captureStartMs,
        captureEndMs,
        durationMs,
        videoStartMs: context.videoStartMs,
        playbackRate: context.playbackRate,
        overlapMs: context.overlapMs,
        audioSignalStatus: Core.classifyAudioActivity(context.activitySamples, context.audibleSamples, durationMs, context.failedActivitySamples),
        mimeType: blob.type || session.mimeType,
        unavailableAttempts: 0,
        state: oversized ? "NEEDS_ACTION" : "PENDING",
        createdAtEpochMs: Date.now(),
        updatedAtEpochMs: Date.now(),
        expiresAtEpochMs: Date.now() + Config.OUTBOX_RETENTION_HOURS * 60 * 60 * 1000
      };
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (
          estimate?.quota &&
          Number(estimate.usage || 0) + chunk.size > Number(estimate.quota)
        ) {
          throw new Error("브라우저 저장 공간이 부족합니다.");
        }
        await Outbox.put(chunk, Config.OUTBOX_MAX_BYTES);
        session.queue.push(chunk);
        session.queue.sort((left, right) => left.sequence - right.sequence);
        session.queuedBytes += chunk.size;
      } catch (error) {
        session.state = SESSION_STATE.PAUSED_ACTION;
        session.notice = `오디오 보관 한도에 도달했습니다: ${serializeError(error)}`;
        cancelWindowScheduler();
        session.queue.push(chunk);
        session.queuedBytes += chunk.size;
      }
      }
    } finally {
      context.parts.length = 0;
      context.resolveDone();
    }
    enforceMemoryLimits();
    scheduleQueueProcessing();
    broadcastSnapshot();
  }

  async function stopAllRecorders() {
    const contexts = [...session.activeRecorders.values()];
    const reviews = [...session.reviewRecorders.values()];
    for (const context of contexts) stopRecorder(context);
    for (const context of reviews) stopRecorder(context);
    await Promise.allSettled([...contexts, ...reviews].map((context) => context.donePromise));
    session.reviewClips.clear();
  }

  function openGap(reason) {
    if (session.openGap) return;
    session.openGap = {
      reason,
      start_ms: Math.round(estimateVideoTimeMs()),
      end_ms: null
    };
  }

  function closeGap() {
    if (!session.openGap) return;
    session.openGap.end_ms = Math.max(session.openGap.start_ms, Math.round(estimateVideoTimeMs()));
    session.gaps.push(session.openGap);
    session.openGap = null;
  }

  function enforceMemoryLimits() {
    const bytes = audioBytes();
    if (bytes >= HARD_LIMIT && session.state === SESSION_STATE.CAPTURING) {
      setState(SESSION_STATE.PAUSED_BACKPRESSURE, "오디오 큐가 128MiB에 도달하여 캡처를 일시정지했습니다.");
      openGap("memory_backpressure");
      cancelWindowScheduler();
      void stopAllRecorders();
    } else if (bytes >= SOFT_LIMIT && session.state === SESSION_STATE.CAPTURING) {
      session.notice = "오디오 큐가 96MiB를 넘어 처리 지연을 감시하고 있습니다.";
    }
  }

  function maybeResumeAfterBackpressure() {
    if (session.state !== SESSION_STATE.PAUSED_BACKPRESSURE || session.stopping) return;
    if (audioBytes() > RESUME_LIMIT) return;
    closeGap();
    session.state = SESSION_STATE.CAPTURING;
    session.notice = "오디오 큐가 감소하여 캡처를 재개했습니다.";
    if (!session.videoState?.hasVideo || !session.videoState.paused) {
      scheduleRecordingWindows(true);
    }
  }

  function scheduleQueueProcessing(delayMs = 75) {
    if (session.processTimer || session.processing) return;
    session.processTimer = setTimeout(() => {
      session.processTimer = null;
      void processQueue();
    }, Math.max(0, Number(delayMs) || 0));
  }

  function lowerSequenceStillRecording(sequence) {
    return [...session.activeRecorders.keys()].some((activeSequence) => activeSequence < sequence);
  }

  async function processQueue() {
    if (
      session.processing ||
      session.queue.length === 0 ||
      !session.serverSessionId ||
      [SESSION_STATE.PAUSED_QUOTA, SESSION_STATE.PAUSED_ACTION].includes(session.state)
    ) return;
    session.queue.sort((left, right) => left.sequence - right.sequence);
    if (lowerSequenceStillRecording(session.queue[0].sequence)) {
      scheduleQueueProcessing();
      return;
    }

    const chunk = session.queue.shift();
    session.queuedBytes -= chunk.size || chunk.blob.size;
    session.inFlightBytes = chunk.size || chunk.blob.size;
    session.inFlightChunk = chunk;
    session.processing = true;
    let nextProcessingDelayMs = 75;
    broadcastSnapshot();

    try {
      const startedAt = performance.now();
      await Outbox.updateState(chunk.id, "SENDING");
      const response = await uploadWithRetry(chunk);
      const latencyMs = Math.round(performance.now() - startedAt);
      session.stats.lastLatencyMs = latencyMs;
      session.stats.recentLatenciesMs.push(latencyMs);
      if (session.stats.recentLatenciesMs.length > 100) session.stats.recentLatenciesMs.shift();
      applyTranscriptResponse(chunk, response);
      recordProviderSuccess();
      if (response?.review_required) {
        await Outbox.updateState(chunk.id, "REVIEW", "전사 결과가 두 번 비었습니다. 원본을 확인하거나 명시적으로 재전사해 주세요.");
        if (!chunk.reviewRetry) session.reviewCount += 1;
        session.notice = `청크 ${chunk.sequence}은 전사 결과가 없어 ...으로 표시했습니다. 원본 오디오는 보존했습니다.`;
      } else {
        await Outbox.remove(chunk.id);
        if (chunk.reviewRetry) session.reviewCount = Math.max(0, session.reviewCount - 1);
      }
    } catch (error) {
      recordProviderFailure(error);
      const quotaExhausted = error?.code === "openai_quota_exhausted" || (error?.status === 429 && (!error?.code || error.code === "http_error"));
      const rateLimited = error?.code === "openai_rate_limited";
      const retryable = !error?.status || error?.status === 503 || Core.isRetryableStatus(error?.status) || rateLimited;
      if (error?.code === "session_resume_required") {
        session.queue.unshift(chunk);
        session.queuedBytes += chunk.size || chunk.blob.size;
        await Outbox.updateState(chunk.id, "RETRY_WAIT", "서버 세션 자동 복원 중");
        try {
          await resumeServerSession(session.serverSessionId);
          session.recoveryRequired = false;
          nextProcessingDelayMs = 0;
          session.notice = "서버 세션을 복원했습니다. 보존 청크를 다시 전송합니다.";
        } catch (resumeError) {
          chunk.unavailableAttempts = (chunk.unavailableAttempts || 0) + 1;
          nextProcessingDelayMs = Core.transientRetryDelayMs(chunk.unavailableAttempts);
          session.notice = `서버 복원이 지연되어 청크를 보존했습니다. ${Math.ceil(nextProcessingDelayMs / 1000)}초 후 재시도합니다: ${serializeError(resumeError)}`;
          if ([401, 403, 404, 410].includes(resumeError?.status)) {
            session.recoveryRequired = true;
            session.state = SESSION_STATE.PAUSED_ACTION;
            await Outbox.updateState(chunk.id, "SESSION_RESUME_REQUIRED", serializeError(resumeError));
            cancelWindowScheduler();
            openGap("session_resume_failed");
            await stopAllRecorders();
          }
        }
      } else if (quotaExhausted || retryable) {
        session.queue.unshift(chunk);
        session.queuedBytes += chunk.size || chunk.blob.size;
        chunk.unavailableAttempts = (chunk.unavailableAttempts || 0) + 1;
        const retryAfterSeconds = Number(error?.retryAfter);
        nextProcessingDelayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(3_600_000, Math.max(1_000, retryAfterSeconds * 1000))
          : Core.transientRetryDelayMs(chunk.unavailableAttempts);
        session.stats.retries += 1;
        await Outbox.updateState(chunk.id, quotaExhausted ? "PAUSED_QUOTA" : "RETRY_WAIT", serializeError(error));
        session.notice = quotaExhausted
          ? "OpenAI 운영 한도에 도달하여 원본 청크를 보존했습니다. 관리자에게 문의해 주세요."
          : rateLimited
            ? `GPT 요청 속도 제한으로 청크 ${chunk.sequence}을 보존했습니다. ${Math.ceil(nextProcessingDelayMs / 1000)}초 후 재시도합니다.`
            : `청크 ${chunk.sequence}을 보존했습니다. ${Math.ceil(nextProcessingDelayMs / 1000)}초 후 재시도합니다.`;
      } else {
        const requiresSessionResume = error?.code === "session_resume_required";
        session.stats.failedChunks += 1;
        await Outbox.updateState(
          chunk.id,
          requiresSessionResume ? "SESSION_RESUME_REQUIRED" : "NEEDS_ACTION",
          serializeError(error)
        );
        chunk.state = requiresSessionResume ? "SESSION_RESUME_REQUIRED" : "NEEDS_ACTION";
        session.queue.unshift(chunk);
        session.queuedBytes += chunk.size || chunk.blob.size;
        session.state = SESSION_STATE.PAUSED_ACTION;
        session.recoveryRequired = requiresSessionResume;
        session.notice = `청크 ${chunk.sequence}을 원본 보존 상태로 전환했습니다: ${serializeError(error)}`;
        cancelWindowScheduler();
        openGap(error?.code || "chunk_needs_action");
        await stopAllRecorders();
      }
      if (quotaExhausted) {
        await pauseForQuota();
      }
    } finally {
      session.inFlightBytes = 0;
      session.inFlightChunk = null;
      session.processing = false;
      enforceMemoryLimits();
      maybeResumeAfterBackpressure();
      broadcastSnapshot();
      if (session.queue.length > 0 && ![SESSION_STATE.PAUSED_QUOTA, SESSION_STATE.PAUSED_ACTION].includes(session.state)) {
        scheduleQueueProcessing(nextProcessingDelayMs);
      }
    }
  }

  async function uploadWithRetry(chunk) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await uploadChunk(chunk);
      } catch (error) {
        lastError = error;
        if (error?.status === 503) break;
        if (!Core.isRetryableStatus(error?.status)) break;
        if (attempt >= MAX_ATTEMPTS) break;
        session.stats.retries += 1;
        session.notice = `청크 ${chunk.sequence} 재시도 ${attempt}/${MAX_ATTEMPTS - 1}`;
        broadcastSnapshot();
        const backoffMs = 700 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 350);
        await delay(backoffMs);
      }
    }
    throw lastError || new Error("청크 처리에 실패했습니다.");
  }

  async function pauseForQuota() {
    if (session.state === SESSION_STATE.PAUSED_QUOTA) return;
    session.recoveryRequired = false;
    session.state = SESSION_STATE.PAUSED_QUOTA;
    session.notice = "OpenAI 운영 한도에 도달했습니다. 실패 청크를 보존했습니다. 관리자에게 문의해 주세요.";
    cancelWindowScheduler();
    openGap("openai_quota_exhausted");
    await stopAllRecorders();
    broadcastSnapshot();
  }

  async function uploadChunk(chunk) {
    const form = new FormData();
    form.append("audio", chunk.blob, `chunk-${chunk.sequence}.webm`);
    if (chunk.reviewBlob instanceof Blob && chunk.reviewDurationMs > 15_000) {
      form.append("review_audio", chunk.reviewBlob, `review-${chunk.sequence}.webm`);
      form.append("review_duration_ms", String(chunk.reviewDurationMs));
    }
    form.append("sequence", String(chunk.sequence));
    form.append("capture_start_ms", String(chunk.captureStartMs));
    form.append("capture_end_ms", String(chunk.captureEndMs));
    form.append("video_start_ms", String(chunk.videoStartMs));
    form.append("playback_rate", String(chunk.playbackRate));
    form.append("overlap_ms", String(chunk.overlapMs));
    form.append("audio_signal_status", chunk.audioSignalStatus || "unknown");
    form.append("review_handling_version", "1");
    form.append("review_retry", String(Boolean(chunk.reviewRetry)));
    form.append("mime_type", chunk.mimeType);

    const response = await fetchWithTimeout(
      `${session.serverBaseUrl}/v1/sessions/${encodeURIComponent(session.serverSessionId)}/chunks`,
      { method: "POST", headers: authHeaders(), body: form }
    );
    return assertResponse(response);
  }

  function applyTranscriptResponse(chunk, response) {
    const incoming = (Array.isArray(response?.segments) ? response.segments : [])
      .map((segment) => {
        const relativeStart = Core.clampNumber(segment.relative_start_ms, 0, chunk.durationMs);
        const relativeEnd = Core.clampNumber(segment.relative_end_ms, relativeStart, chunk.durationMs);
        return {
          id: `${chunk.sequence}-${Math.round(relativeStart)}-${Math.round(relativeEnd)}`,
          sequence: chunk.sequence,
          start_ms: Math.round(chunk.videoStartMs + relativeStart * chunk.playbackRate),
          end_ms: Math.round(chunk.videoStartMs + relativeEnd * chunk.playbackRate),
          text: String(segment.text || "").trim(),
          uncertain: Boolean(segment.uncertain),
          review_required: Boolean(segment.review_required || response?.review_required),
          status: "final"
        };
      })
      .filter((segment) => segment.text && segment.end_ms >= segment.start_ms);

    session.captions = session.captions.filter((item) => item.sequence !== chunk.sequence).concat(incoming);
    session.captions.sort((left, right) => left.start_ms - right.start_ms);
    session.stats.lastSequence = chunk.sequence;
    session.notice = "";
  }

  async function startSession(payload) {
    if (isActiveState()) throw new Error("이미 캡처 세션이 실행 중입니다.");
    await releaseMediaResources();
    session = createEmptySession();
    session.state = SESSION_STATE.STARTING;
    session.sourceTabId = Number(payload.sourceTabId);
    session.sourceUrl = String(payload.sourceUrl || "");
    session.sourceTitle = String(payload.sourceTitle || "");
    session.serverBaseUrl = normalizeServerBaseUrl(payload.serverBaseUrl || Config.SERVER_BASE_URL);
    session.userId = String(payload.userId || "").trim();
    session.accessToken = String(payload.accessToken || "").trim();
    session.videoState = { ...session.videoState, ...(payload.videoState || {}) };
    session.startedAtEpochMs = Date.now();
    if (!session.userId) throw new Error("사용자 ID를 입력해 주세요.");
    if (!session.accessToken) throw new Error("접속 코드를 입력해 주세요.");
    broadcastSnapshot();

    try {
      applyServerHealth(payload.serverHealth);
      await navigator.storage?.persist?.().catch(() => false);
      const resumed = await restoreRecoverableOutbox();
      if (!resumed) await createServerSession();
      if ((session.finalizePending || session.archivedIncomplete) && (session.queue.length > 0 || session.reviewCount > 0)) {
        session.state = SESSION_STATE.PAUSED_ACTION;
        session.notice = "종료된 세션의 보존 청크가 있습니다. 원본을 내보내거나 '보존 청크 처리'를 눌러 주세요.";
        broadcastSnapshot();
        return { ok: true, snapshot: publicSnapshot() };
      }
      if (session.finalizePending) {
        session.notice = "보류된 최종 요약과 저장을 다시 시도하고 있습니다.";
        broadcastSnapshot();
        const archive = await archiveServerSessionWithRetry();
        session.state = SESSION_STATE.STOPPED;
        session.notice = archive?.saved
          ? `최종 자막${archive.summary ? "과 요약을" : "을"} 저장했습니다.${archive.accepted_untranscribed_sequences?.length ? ` 전사되지 않은 청크 ${archive.accepted_untranscribed_sequences.length}개는 ...으로 남겼습니다.` : ""} 문서 ID: ${archive.document_id}`
          : archive?.summary ? "누락 구간이 있어 확보된 자막의 부분 요약을 저장했습니다." : "처리되지 않은 청크가 있어 미완료 세션으로 유지했습니다.";
        session.accessToken = "";
        session.userId = "";
        broadcastSnapshot();
        return { ok: true, snapshot: publicSnapshot() };
      }
      if (session.state === SESSION_STATE.PAUSED_ACTION) {
        broadcastSnapshot();
        return { ok: true, snapshot: publicSnapshot() };
      }
      session.mimeType = chooseMimeType();
      await connectMediaStream(payload.streamId);
      session.captureOriginPerf = performance.now();
      if (session.state !== SESSION_STATE.PAUSED_ACTION) {
        session.state = SESSION_STATE.CAPTURING;
        session.notice = session.videoState.hasVideo && session.videoState.paused
          ? "영상 재생을 기다리고 있습니다."
          : "캡처 중";
        if (!session.videoState.hasVideo || !session.videoState.paused) {
          scheduleRecordingWindows(true);
        }
        if (session.queue.length > 0) scheduleQueueProcessing(0);
      }
      broadcastSnapshot();
      return { ok: true, snapshot: publicSnapshot() };
    } catch (error) {
      await releaseMediaResources();
      setError(error);
      throw error;
    }
  }

  async function recoverSession(payload) {
    if (session.state !== SESSION_STATE.PAUSED_ACTION || !session.recoveryRequired || !session.serverSessionId) {
      throw new Error("복구가 필요한 서버 세션이 없습니다.");
    }

    const sourceTabId = Number(payload.sourceTabId);
    if (!Number.isInteger(sourceTabId) || sourceTabId !== Number(session.sourceTabId)) {
      throw new Error("기존 캡처 탭을 다시 선택해 주세요.");
    }

    session.notice = "서버 세션과 보존 청크를 복구하는 중입니다.";
    broadcastSnapshot();

    try {
      await resumeServerSession(session.serverSessionId);
      session.videoState = { ...session.videoState, ...(payload.videoState || {}) };

      for (const chunk of session.queue) {
        chunk.state = "PENDING";
        chunk.detail = "";
        await Outbox.updateState(chunk.id, "PENDING", "");
      }

      if (!session.stream) {
        if (!payload.streamId) throw new Error("캡처 탭의 오디오 스트림을 다시 열지 못했습니다.");
        await connectMediaStream(payload.streamId);
        session.captureOriginPerf ||= performance.now();
      }

      await preserveSessionMarker("ACTIVE");
      session.recoveryRequired = false;
      closeGap();
      if (audioBytes() >= HARD_LIMIT) {
        session.state = SESSION_STATE.PAUSED_BACKPRESSURE;
        session.notice = "서버 세션을 복구했습니다. 큐를 먼저 처리한 뒤 캡처를 재개합니다.";
        openGap("memory_backpressure");
      } else {
        session.state = SESSION_STATE.CAPTURING;
        session.notice = "서버 세션을 복구했습니다. 보존 청크부터 다시 처리합니다.";
        if (!session.videoState?.hasVideo || !session.videoState.paused) scheduleRecordingWindows(true);
      }
      scheduleQueueProcessing(0);
      broadcastSnapshot();
      return { ok: true, snapshot: publicSnapshot() };
    } catch (error) {
      session.recoveryRequired = true;
      if (error?.status === 429) {
        await pauseForQuota();
      } else {
        session.state = SESSION_STATE.PAUSED_ACTION;
        session.notice = `서버 세션 복구에 실패했습니다: ${serializeError(error)}`;
        broadcastSnapshot();
      }
      return { ok: false, error: serializeError(error), snapshot: publicSnapshot() };
    }
  }

  async function processPreservedChunks(payload) {
    if (isActiveState() && session.state !== SESSION_STATE.PAUSED_ACTION) {
      return { ok: false, error: "진행 중인 캡처를 먼저 종료해 주세요.", snapshot: publicSnapshot() };
    }
    if (session.stream) {
      return { ok: false, error: "녹음 중인 세션은 기존 서버 세션 복구를 이용해 주세요.", snapshot: publicSnapshot() };
    }
    session.serverBaseUrl = normalizeServerBaseUrl(payload.serverBaseUrl || Config.SERVER_BASE_URL);
    session.userId = String(payload.userId || "").trim();
    session.accessToken = String(payload.accessToken || "").trim();
    session.sourceUrl = String(payload.sourceUrl || session.sourceUrl || "");
    if (!session.userId || !session.accessToken) {
      return { ok: false, error: "사용자 ID와 접속 코드를 입력해 주세요.", snapshot: publicSnapshot() };
    }
    try {
      const restored = await restoreRecoverableOutbox(true);
      if (!restored) return { ok: false, error: "처리할 보존 청크가 없습니다.", snapshot: publicSnapshot() };
      if (session.queue.some((chunk) => chunk.state === "EXPIRED")) {
        return { ok: false, error: "72시간 보존 기간이 지났습니다. 원본 오디오를 내보내 확인해 주세요.", snapshot: publicSnapshot() };
      }
      session.recoveryRequired = false;
      session.state = SESSION_STATE.STOPPING;
      session.error = "";
      session.notice = "보존 청크를 서버로 전송하고 있습니다. 이 패널을 유지해 주세요.";
      broadcastSnapshot();
      void (async () => {
        try {
          const result = await waitForQueueDrain();
          if (!result.drained) {
            session.state = SESSION_STATE.PAUSED_ACTION;
            session.notice = `청크 ${result.pendingCount}개가 남아 있습니다. 다시 처리를 눌러 주세요.`;
            return;
          }
          const archive = await archiveServerSessionWithRetry();
          session.state = SESSION_STATE.STOPPED;
          session.notice = archive?.saved
            ? `보존 청크 처리와 최종 문서 저장을 완료했습니다.${archive.accepted_untranscribed_sequences?.length ? ` 전사되지 않은 청크 ${archive.accepted_untranscribed_sequences.length}개는 ...으로 남겼습니다.` : ""}`
            : archive?.unverified_sequences?.length ? `전사 확인 필요 청크 ${archive.unverified_sequences.length}개를 원본과 함께 보존했습니다.${archive?.summary ? " 확보된 자막만 부분 요약했습니다." : " 요약할 자막은 아직 없습니다."}`
            : archive?.summary ? "미완료 문서에 확보된 자막의 부분 요약을 저장했습니다. 누락 구간을 확인해 주세요." : "보존 청크를 처리했지만 서버 문서가 미완료 상태입니다. 누락 구간을 확인해 주세요.";
        } catch (error) {
          session.state = SESSION_STATE.PAUSED_ACTION;
          session.finalizePending = true;
          session.notice = `보존 청크 처리가 지연됐습니다: ${serializeError(error)}`;
          await preserveSessionMarker("FINALIZE_PENDING", serializeError(error));
        } finally {
          session.accessToken = "";
          session.userId = "";
          broadcastSnapshot();
        }
      })();
      return { ok: true, snapshot: publicSnapshot() };
    } catch (error) {
      session.state = SESSION_STATE.PAUSED_ACTION;
      session.notice = `보존 청크 복구에 실패했습니다: ${serializeError(error)}`;
      broadcastSnapshot();
      return { ok: false, error: serializeError(error), snapshot: publicSnapshot() };
    }
  }

  async function retrySession() {
    if (session.state !== SESSION_STATE.PAUSED_QUOTA || !session.serverSessionId) {
      throw new Error("다시 시도할 보존 세션이 없습니다.");
    }
    closeGap();
    session.state = audioBytes() >= HARD_LIMIT ? SESSION_STATE.PAUSED_BACKPRESSURE : SESSION_STATE.CAPTURING;
    session.notice = "보존 청크 처리를 다시 시도합니다.";
    if (session.state === SESSION_STATE.CAPTURING && (!session.videoState?.hasVideo || !session.videoState.paused)) {
      scheduleRecordingWindows(true);
    }
    scheduleQueueProcessing(0);
    broadcastSnapshot();
    return { ok: true, snapshot: publicSnapshot() };
  }

  async function waitForQueueDrain(maxWaitMs = null) {
    const pendingAtStart = session.queue.length + (session.processing ? 1 : 0);
    const waitMs = maxWaitMs == null ? Core.queueDrainTimeoutMs(pendingAtStart) : maxWaitMs;
    const deadline = Date.now() + waitMs;
    let lastNoticeAt = 0;
    while ((session.queue.length > 0 || session.processing) && Date.now() < deadline) {
      if (!session.processing && [SESSION_STATE.PAUSED_QUOTA, SESSION_STATE.PAUSED_ACTION].includes(session.state)) break;
      if (!session.processing) scheduleQueueProcessing();
      if (Date.now() - lastNoticeAt >= 1_000) {
        const pending = session.queue.length + (session.processing ? 1 : 0);
        session.notice = `캡처 종료 중: 남은 청크 ${pending}개를 처리하고 있습니다.`;
        broadcastSnapshot();
        lastNoticeAt = Date.now();
      }
      await delay(100);
    }

    if (session.processing && Date.now() >= deadline) {
      session.notice = "종료 제한시간에 도달해 현재 전송 중인 청크의 완료를 기다리고 있습니다.";
      broadcastSnapshot();
      const inFlightDeadline = Date.now() + REQUEST_TIMEOUT_MS + 5_000;
      while (session.processing && Date.now() < inFlightDeadline) await delay(100);
    }

    const pendingCount = session.queue.length + (session.processing ? 1 : 0);
    if (pendingCount > 0) {
      if (![SESSION_STATE.PAUSED_QUOTA, SESSION_STATE.PAUSED_ACTION].includes(session.state)) session.notice = `종료 대기시간을 초과했습니다. 청크 ${pendingCount}개는 IndexedDB에 보존됩니다.`;
      broadcastSnapshot();
    }
    return { drained: pendingCount === 0, pendingCount };
  }

  async function retryReviewChunksBeforeArchive() {
    if (!session.serverSessionId || session.reviewCount <= 0) return { drained: true, pendingCount: 0 };
    const records = await Outbox.listSession(session.serverSessionId);
    const reviews = records.filter((record) => record.kind === "chunk" && record.state === "REVIEW" && record.blob instanceof Blob);
    for (const record of reviews) {
      if (session.queue.some((queued) => queued.id === record.id)) continue;
      session.queue.push({ ...record, reviewRetry: true });
      session.queuedBytes += record.size || record.blob.size;
    }
    if (session.queue.length === 0) return { drained: true, pendingCount: 0 };
    session.notice = `전사되지 않은 청크 ${reviews.length}개를 종료 전 최대 2회씩 다시 확인하고 있습니다.`;
    broadcastSnapshot();
    scheduleQueueProcessing(0);
    return waitForQueueDrain();
  }

  async function archiveServerSession() {
    if (!session.serverSessionId) return null;
    const response = await fetchWithTimeout(
      `${session.serverBaseUrl}/v1/sessions/${encodeURIComponent(session.serverSessionId)}/archive`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          source_title: session.sourceTitle,
          duration_ms: Math.max(0, (session.stoppedAtEpochMs || Date.now()) - (session.startedAtEpochMs || Date.now())),
          expected_chunk_count: session.nextSequence,
          capture_gaps: session.gaps
        })
      },
      REQUEST_TIMEOUT_MS
    );
    const payload = await assertResponse(response);
    if (payload?.summary) {
      session.notes = {
        summary: String(payload.summary.summary || ""),
        concepts: Array.isArray(payload.summary.concepts) ? payload.summary.concepts : [],
        terms: Array.isArray(payload.summary.terms) ? payload.summary.terms : [],
        highlights: Array.isArray(payload.summary.highlights) ? payload.summary.highlights : [],
        checklist: Array.isArray(payload.summary.checklist) ? payload.summary.checklist : []
      };
      recordProviderSuccess();
    }
    session.documentId = payload?.document_id || null;
    session.archivedIncomplete = !payload?.saved;
    session.finalizePending = false;
    if (payload?.saved) {
      await Outbox.remove(`${session.serverSessionId}:session`);
    } else {
      await preserveSessionMarker("INCOMPLETE", `누락 청크: ${(payload?.missing_sequences || []).join(", ")}; 전사 확인 필요: ${(payload?.unverified_sequences || []).join(", ")}; 녹음 누락 구간: ${(payload?.missing_time_ranges || []).length}`);
    }
    return payload;
  }

  async function archiveServerSessionWithRetry() {
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await archiveServerSession();
      } catch (error) {
        lastError = error;
        recordProviderFailure(error);
        const retryable = !error?.status || error?.retryable === true || (error?.status === 409 && error?.code === "finalize_in_progress");
        if (!retryable || error?.code === "openai_quota_exhausted" || attempt >= 3) break;
        const retryAfterSeconds = Number(error?.retryAfter);
        const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(300_000, Math.max(1_000, retryAfterSeconds * 1_000))
          : Core.transientRetryDelayMs(attempt + 1);
        session.notice = `최종 저장이 지연되어 ${Math.ceil(waitMs / 1000)}초 후 다시 시도합니다.`;
        broadcastSnapshot();
        await delay(waitMs);
      }
    }
    throw lastError || new Error("최종 저장에 실패했습니다.");
  }

  async function stopSession(reason = "사용자가 캡처를 종료했습니다.") {
    if (!isActiveState() && session.state !== SESSION_STATE.ERROR) {
      return { ok: true, snapshot: publicSnapshot() };
    }
    if (session.stopping) return { ok: true, snapshot: publicSnapshot() };
    const processingWasBlocked = [SESSION_STATE.PAUSED_QUOTA, SESSION_STATE.PAUSED_ACTION].includes(session.state);
    session.stopping = true;
    session.state = SESSION_STATE.STOPPING;
    session.error = "";
    session.notice = reason;
    cancelWindowScheduler();
    broadcastSnapshot();

    await stopAllRecorders();
    let drainResult = processingWasBlocked
      ? { drained: false, pendingCount: session.queue.length + (session.processing ? 1 : 0) }
      : await waitForQueueDrain();
    if (drainResult.drained && !processingWasBlocked && session.reviewCount > 0) {
      drainResult = await retryReviewChunksBeforeArchive();
    }
    closeGap();
    session.stoppedAtEpochMs = Date.now();
    try {
      session.finalizePending = true;
      await preserveSessionMarker("FINALIZE_PENDING");
      session.notice = "최종 요약과 문서를 저장하고 있습니다.";
      broadcastSnapshot();
      const archive = await archiveServerSessionWithRetry();
      session.notice = archive?.saved
        ? `${reason} 자막${archive.summary ? "과 요약을" : "을"} 저장했습니다.${archive.accepted_untranscribed_sequences?.length ? ` 전사되지 않은 청크 ${archive.accepted_untranscribed_sequences.length}개는 ...으로 남겼습니다.` : ""} 문서 ID: ${archive.document_id}`
        : archive?.unverified_sequences?.length ? `${reason} 전사 확인 필요 청크 ${archive.unverified_sequences.length}개를 원본과 함께 보존했습니다.${archive?.summary ? " 확보된 자막만 부분 요약했습니다." : " 요약할 자막은 아직 없습니다."}`
        : archive?.summary ? `${reason} 미완료 문서와 확보된 자막의 부분 요약을 저장했습니다.` : `${reason} 처리되지 않은 청크를 보존한 미완료 세션으로 저장했습니다.`;
    } catch (error) {
      session.finalizePending = true;
      await preserveSessionMarker("FINALIZE_PENDING", serializeError(error));
      session.notice = `${reason} 최종 저장은 보류됐습니다: ${serializeError(error)}`;
    }
    await releaseMediaResources();

    session.stopping = false;
    session.state = SESSION_STATE.STOPPED;
    if (!drainResult.drained && !session.notice.includes("미완료")) {
      session.notice += ` 청크 ${drainResult.pendingCount || 0}개는 IndexedDB에 남아 있습니다.`;
    }
    session.accessToken = "";
    session.userId = "";
    broadcastSnapshot();
    return { ok: true, snapshot: publicSnapshot() };
  }

  async function releaseMediaResources() {
    cancelWindowScheduler();
    if (session.processTimer) clearTimeout(session.processTimer);
    session.processTimer = null;
    for (const track of session.stream?.getTracks?.() || []) track.stop();
    session.stream = null;
    try {
      session.sourceNode?.disconnect();
    } catch {}
    session.sourceNode = null;
    try {
      session.analyserNode?.disconnect();
    } catch {}
    session.analyserNode = null;
    if (session.audioContext && session.audioContext.state !== "closed") {
      try {
        await session.audioContext.close();
      } catch {}
    }
    session.audioContext = null;
  }

  async function discardSession(payload = {}) {
    if (!session.serverSessionId) return { ok: true, snapshot: publicSnapshot() };
    cancelWindowScheduler();
    await stopAllRecorders();
    await releaseMediaResources();
    const userId = String(payload.userId || session.userId || "").trim();
    const accessToken = String(payload.accessToken || session.accessToken || "").trim();
    if (!userId || !accessToken) {
      session.state = SESSION_STATE.PAUSED_ACTION;
      session.notice = "서버 초안을 삭제하려면 사용자 ID와 접속 코드를 다시 입력해 주세요. 로컬 청크는 보존했습니다.";
      broadcastSnapshot();
      return { ok: false, error: session.notice, snapshot: publicSnapshot() };
    }
    try {
      await Discard.deleteServerThenLocal(
        async () => {
          const response = await fetchWithTimeout(
            `${session.serverBaseUrl}/v1/sessions/${encodeURIComponent(session.serverSessionId)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}`, "X-User-ID": userId } },
            10_000
          );
          if (response.status !== 404) await assertResponse(response);
        },
        () => Outbox.listSession(session.serverSessionId),
        (record) => Outbox.remove(record.id)
      );
    } catch (error) {
      session.state = SESSION_STATE.PAUSED_ACTION;
      session.notice = error.serverDeleted
        ? `서버 초안은 삭제됐지만 로컬 청크 정리가 끝나지 않았습니다. 다시 시도해 주세요: ${serializeError(error)}`
        : `서버 초안 삭제에 실패했습니다. 로컬 청크는 보존했습니다: ${serializeError(error)}`;
      broadcastSnapshot();
      return { ok: false, error: session.notice, snapshot: publicSnapshot() };
    }
    session.queue = [];
    session.queuedBytes = 0;
    session.serverSessionId = null;
    session.state = SESSION_STATE.STOPPED;
    session.stoppedAtEpochMs = Date.now();
    session.notice ||= "보존된 원본 청크와 미완료 세션을 폐기했습니다.";
    broadcastSnapshot();
    return { ok: true, snapshot: publicSnapshot() };
  }

  async function exportPreservedChunks() {
    if (!session.serverSessionId) throw new Error("내보낼 보존 세션이 없습니다.");
    const records = await Outbox.listSession(session.serverSessionId);
    const chunks = records.filter((record) => record.kind === "chunk" && record.blob instanceof Blob);
    for (const chunk of chunks) {
      const url = URL.createObjectURL(chunk.blob);
      try {
        await chrome.downloads.download({
          url,
          filename: `lecture-memo-${session.serverSessionId}-chunk-${chunk.sequence}.webm`,
          conflictAction: "uniquify",
          saveAs: false
        });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    }
    return { ok: true, count: chunks.length };
  }

  async function resetRecordingWindows(restart, notice) {
    cancelWindowScheduler();
    await stopAllRecorders();
    session.notice = notice;
    if (
      restart &&
      session.state === SESSION_STATE.CAPTURING &&
      !session.stopping &&
      (!session.videoState.hasVideo || !session.videoState.paused)
    ) {
      scheduleRecordingWindows(true);
    }
    broadcastSnapshot();
  }

  async function handleTimelineEvent(payload) {
    if (Number(payload.sourceTabId) !== session.sourceTabId || !isActiveState()) return { ok: true };
    const eventName = String(payload.event || "");
    session.videoState = {
      hasVideo: Boolean(payload.hasVideo),
      paused: Boolean(payload.paused),
      ended: Boolean(payload.ended),
      currentTimeMs: Math.max(0, Number(payload.currentTimeMs) || 0),
      durationMs: Number.isFinite(Number(payload.durationMs)) ? Number(payload.durationMs) : null,
      playbackRate: Math.max(0.1, Number(payload.playbackRate) || 1),
      observedAtEpochMs: Number(payload.observedAtEpochMs) || Date.now()
    };

    if (eventName === "ended") {
      void stopSession("영상 재생이 끝났습니다.");
      return { ok: true };
    }
    if (eventName === "pagehide") {
      void stopSession("소스 페이지가 닫히거나 이동했습니다.");
      return { ok: true };
    }
    if (eventName === "pause" || eventName === "seeking") {
      session.timelineSuspended = true;
      await resetRecordingWindows(false, eventName === "pause" ? "영상 재생을 기다리고 있습니다." : "영상 탐색 중입니다.");
      return { ok: true };
    }
    if (eventName === "ratechange") {
      session.timelineSuspended = false;
      await resetRecordingWindows(!session.videoState.paused, "재생속도 변경을 반영했습니다.");
      return { ok: true };
    }
    if (eventName === "play" || eventName === "seeked" || eventName === "video-bound") {
      session.timelineSuspended = false;
      if (session.state === SESSION_STATE.CAPTURING && session.activeRecorders.size === 0) {
        scheduleRecordingWindows(true);
      }
      session.notice = "캡처 중";
      broadcastSnapshot();
    }
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== TARGET.OFFSCREEN) return undefined;

    void (async () => {
      switch (message.type) {
        case MESSAGE.START_SESSION:
          return startSession(message.payload || {});
        case MESSAGE.RECOVER_SESSION:
          return recoverSession(message.payload || {});
        case MESSAGE.PROCESS_PRESERVED_CHUNKS:
          return processPreservedChunks(message.payload || {});
        case MESSAGE.RETRY_SESSION:
          return retrySession();
        case MESSAGE.STOP_SESSION:
          return stopSession(message.payload?.reason || "사용자가 캡처를 종료했습니다.");
        case MESSAGE.GET_SESSION_SNAPSHOT:
          return { ok: true, snapshot: publicSnapshot() };
        case MESSAGE.TIMELINE_EVENT:
          return handleTimelineEvent(message.payload || {});
        case MESSAGE.EXPORT_PRESERVED_CHUNKS:
          return exportPreservedChunks();
        case MESSAGE.DISCARD_SESSION:
          return discardSession(message.payload || {});
        case MESSAGE.TAB_REMOVED:
          if (Number(message.payload?.tabId) === session.sourceTabId) {
            void stopSession("캡처 중인 탭이 닫혔습니다.");
          }
          return { ok: true };
        case MESSAGE.TAB_UPDATED:
          if (
            Number(message.payload?.tabId) === session.sourceTabId &&
            message.payload?.status === "loading" &&
            isActiveState()
          ) {
            void stopSession("캡처 중인 페이지가 이동하거나 새로고침되었습니다.");
          }
          return { ok: true };
        default:
          return { ok: false, error: `알 수 없는 메시지: ${message.type}` };
      }
    })()
      .then((result) => sendResponse(result || { ok: true }))
      .catch((error) => {
        setError(error);
        sendResponse({ ok: false, error: serializeError(error) });
      });
    return true;
  });
})();
