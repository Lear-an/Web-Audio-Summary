(function initializeOffscreenWorker() {
  const { TARGET, MESSAGE, SESSION_STATE } = LectureProtocol;
  const Core = LectureCore;

  const DEFAULT_WINDOW_MS = 10_000;
  const DEFAULT_OVERLAP_MS = 1_000;
  const MIN_PARTIAL_CHUNK_MS = 1_000;
  const SOFT_LIMIT = 24 * 1024 * 1024;
  const HARD_LIMIT = 32 * 1024 * 1024;
  const RESUME_LIMIT = 12 * 1024 * 1024;
  const REQUEST_TIMEOUT_MS = 45_000;
  const MAX_ATTEMPTS = 3;
  const SUMMARY_CHUNK_INTERVAL = 3;
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
      serverBaseUrl: "",
      accessToken: "",
      serverSessionId: null,
      stream: null,
      audioContext: null,
      sourceNode: null,
      mimeType: "",
      windowMs: DEFAULT_WINDOW_MS,
      windowIntervalMs: DEFAULT_WINDOW_MS - DEFAULT_OVERLAP_MS,
      overlapMs: DEFAULT_OVERLAP_MS,
      startedAtEpochMs: null,
      captureOriginPerf: null,
      stoppedAtEpochMs: null,
      schedulerTimer: null,
      schedulerGeneration: 0,
      nextSequence: 0,
      activeRecorders: new Map(),
      queue: [],
      queuedBytes: 0,
      inFlightBytes: 0,
      inFlightChunk: null,
      processing: false,
      processTimer: null,
      captions: [],
      bookmarks: [],
      gaps: [],
      openGap: null,
      notes: emptyNotes(),
      summaryCursor: 0,
      successfulChunksSinceSummary: 0,
      summaryInFlight: false,
      summaryPromise: null,
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
      activeRecorderCount: session.activeRecorders.size,
      captions: sortedCaptions,
      bookmarks: [...session.bookmarks],
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
    if (url.protocol !== "http:") throw new Error("로컬 서버는 HTTP 주소여야 합니다.");
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error("로컬 서버는 127.0.0.1 또는 localhost만 사용할 수 있습니다.");
    }
    if ((url.port || "80") !== "8050") {
      throw new Error("현재 Manifest가 허용한 로컬 서버 포트는 8050입니다.");
    }
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
      throw new HttpResponseError(
        payload?.detail || payload?.error || `서버 요청 실패 (${response.status})`,
        response.status,
        response.headers.get("Retry-After")
      );
    }
    return payload;
  }

  async function verifyServer() {
    const response = await fetchWithTimeout(`${session.serverBaseUrl}/health`, {}, 5_000);
    const payload = await assertResponse(response);
    if (payload?.status !== "ok") throw new Error("로컬 서버 상태가 정상적이지 않습니다.");
    const chunkSeconds = Core.clampNumber(payload.chunk_seconds, 5, 600);
    const overlapSeconds = Core.clampNumber(payload.chunk_overlap_seconds, 0, 30);
    if (overlapSeconds >= chunkSeconds) {
      throw new Error("서버의 오디오 청크 겹침 설정이 청크 길이보다 짧아야 합니다.");
    }
    session.windowMs = Math.round(chunkSeconds * 1000);
    session.overlapMs = Math.round(overlapSeconds * 1000);
    session.windowIntervalMs = session.windowMs - session.overlapMs;
  }

  async function createServerSession(geminiApiKey) {
    const response = await fetchWithTimeout(`${session.serverBaseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        source_tab_id: session.sourceTabId,
        source_url: session.sourceUrl,
        language: "ko",
        gemini_api_key: geminiApiKey
      })
    });
    const payload = await assertResponse(response);
    if (!payload?.session_id) throw new Error("서버가 세션 ID를 반환하지 않았습니다.");
    session.serverSessionId = payload.session_id;
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
    session.sourceNode.connect(session.audioContext.destination);
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
    context.stopTimer = setTimeout(() => stopRecorder(context), session.windowMs);
    broadcastSnapshot();
  }

  function stopRecorder(context) {
    if (!context) return;
    clearTimeout(context.stopTimer);
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
    session.activeRecorders.delete(context.sequence);
    const captureEndMs = Math.max(context.captureStartMs, Math.round(performance.now() - session.captureOriginPerf));
    const durationMs = captureEndMs - context.captureStartMs;
    const blob = new Blob(context.parts, { type: context.recorder.mimeType || session.mimeType });

    if (durationMs >= MIN_PARTIAL_CHUNK_MS && blob.size > 0) {
      session.queue.push({
        sequence: context.sequence,
        blob,
        captureStartMs: context.captureStartMs,
        captureEndMs,
        durationMs,
        videoStartMs: context.videoStartMs,
        playbackRate: context.playbackRate,
        overlapMs: context.overlapMs,
        mimeType: blob.type || session.mimeType,
        unavailableAttempts: 0
      });
      session.queue.sort((left, right) => left.sequence - right.sequence);
      session.queuedBytes += blob.size;
    }

    context.parts.length = 0;
    context.resolveDone();
    enforceMemoryLimits();
    scheduleQueueProcessing();
    broadcastSnapshot();
  }

  async function stopAllRecorders() {
    const contexts = [...session.activeRecorders.values()];
    for (const context of contexts) stopRecorder(context);
    await Promise.allSettled(contexts.map((context) => context.donePromise));
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
      setState(SESSION_STATE.PAUSED_BACKPRESSURE, "오디오 큐가 32MB에 도달하여 캡처를 일시정지했습니다.");
      openGap("memory_backpressure");
      cancelWindowScheduler();
      void stopAllRecorders();
    } else if (bytes >= SOFT_LIMIT && session.state === SESSION_STATE.CAPTURING) {
      session.notice = "오디오 큐가 24MB를 넘어 처리 지연을 감시하고 있습니다.";
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
      session.state === SESSION_STATE.PAUSED_QUOTA
    ) return;
    session.queue.sort((left, right) => left.sequence - right.sequence);
    if (lowerSequenceStillRecording(session.queue[0].sequence)) {
      scheduleQueueProcessing();
      return;
    }

    const chunk = session.queue.shift();
    session.queuedBytes -= chunk.blob.size;
    session.inFlightBytes = chunk.blob.size;
    session.inFlightChunk = chunk;
    session.processing = true;
    let nextProcessingDelayMs = 75;
    broadcastSnapshot();

    try {
      const startedAt = performance.now();
      const response = await uploadWithRetry(chunk);
      const latencyMs = Math.round(performance.now() - startedAt);
      session.stats.lastLatencyMs = latencyMs;
      session.stats.recentLatenciesMs.push(latencyMs);
      if (session.stats.recentLatenciesMs.length > 100) session.stats.recentLatenciesMs.shift();
      applyTranscriptResponse(chunk, response);
    } catch (error) {
      if (error?.status === 429 || error?.status === 503) {
        session.queue.unshift(chunk);
        session.queuedBytes += chunk.blob.size;
        if (error?.status === 503) {
          chunk.unavailableAttempts = (chunk.unavailableAttempts || 0) + 1;
          nextProcessingDelayMs = Core.transientRetryDelayMs(chunk.unavailableAttempts);
          session.stats.retries += 1;
          session.notice = `Gemini 모델 혼잡: 청크 ${chunk.sequence}을 보존했습니다. ${Math.ceil(nextProcessingDelayMs / 1000)}초 후 재시도합니다.`;
        }
      } else {
        session.stats.failedChunks += 1;
        session.gaps.push({
          reason: "chunk_failed",
          start_ms: chunk.videoStartMs,
          end_ms: Math.round(chunk.videoStartMs + chunk.durationMs * chunk.playbackRate)
        });
      }
      if (error?.status === 429) {
        await pauseForQuota();
      } else if (error?.status !== 503) {
        session.notice = `청크 ${chunk.sequence} 처리 실패: ${serializeError(error)}`;
      }
    } finally {
      session.inFlightBytes = 0;
      session.inFlightChunk = null;
      session.processing = false;
      enforceMemoryLimits();
      maybeResumeAfterBackpressure();
      broadcastSnapshot();
      if (session.queue.length > 0 && session.state !== SESSION_STATE.PAUSED_QUOTA) {
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
    session.state = SESSION_STATE.PAUSED_QUOTA;
    session.notice = "Gemini API 할당량이 소진되었습니다. 실패 청크를 보존했습니다. 새 API 키를 입력하고 '새 키로 계속'을 눌러 주세요.";
    cancelWindowScheduler();
    openGap("gemini_quota_exhausted");
    await stopAllRecorders();
    broadcastSnapshot();
  }

  async function uploadChunk(chunk) {
    const form = new FormData();
    form.append("audio", chunk.blob, `chunk-${chunk.sequence}.webm`);
    form.append("sequence", String(chunk.sequence));
    form.append("capture_start_ms", String(chunk.captureStartMs));
    form.append("capture_end_ms", String(chunk.captureEndMs));
    form.append("video_start_ms", String(chunk.videoStartMs));
    form.append("playback_rate", String(chunk.playbackRate));
    form.append("overlap_ms", String(chunk.overlapMs));
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
          status: "final"
        };
      })
      .filter((segment) => segment.text && segment.end_ms >= segment.start_ms);

    session.captions = Core.reconcileCaptionBoundary(session.captions, incoming, 4);
    session.stats.lastSequence = chunk.sequence;
    session.notice = "";
    session.successfulChunksSinceSummary += 1;
    if (session.successfulChunksSinceSummary >= SUMMARY_CHUNK_INTERVAL && !session.summaryInFlight) {
      session.successfulChunksSinceSummary = 0;
      void requestSummary("intermediate");
    }
  }

  function requestSummary(kind) {
    if (!session.serverSessionId) return Promise.resolve();
    if (session.summaryPromise) {
      if (kind === "final") {
        return session.summaryPromise.then(() => requestSummary("final"));
      }
      return session.summaryPromise;
    }

    session.summaryInFlight = true;
    session.summaryPromise = performSummary(kind).finally(() => {
      session.summaryInFlight = false;
      session.summaryPromise = null;
      broadcastSnapshot();
    });
    return session.summaryPromise;
  }

  async function performSummary(kind) {
    const newCaptions = session.captions.slice(session.summaryCursor);
    if (kind === "intermediate" && newCaptions.length === 0) return;
    const transcript = newCaptions
      .map((item) => `[${Core.formatClock(item.start_ms)}] ${item.text}`)
      .join("\n")
      .slice(-180_000);
    const endpoint = kind === "final" ? "summaries/final" : "summaries/intermediate";

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          `${session.serverBaseUrl}/v1/sessions/${encodeURIComponent(session.serverSessionId)}/${endpoint}`,
          {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              previous_summary: session.notes,
              transcript,
              bookmarks: session.bookmarks
            })
          },
          60_000
        );
        const payload = await assertResponse(response);
        session.notes = {
          summary: String(payload?.summary || ""),
          concepts: Array.isArray(payload?.concepts) ? payload.concepts : [],
          terms: Array.isArray(payload?.terms) ? payload.terms : [],
          highlights: Array.isArray(payload?.highlights) ? payload.highlights : [],
          checklist: Array.isArray(payload?.checklist) ? payload.checklist : []
        };
        session.summaryCursor = session.captions.length;
        return;
      } catch (error) {
        if (error?.status === 429) {
          await pauseForQuota();
          return;
        }
        if (error?.status === 503 && attempt < 4) {
          const retryDelayMs = Core.transientRetryDelayMs(attempt);
          session.stats.retries += 1;
          session.notice = `Gemini 모델 혼잡: 요약을 ${Math.ceil(retryDelayMs / 1000)}초 후 재시도합니다.`;
          broadcastSnapshot();
          await delay(retryDelayMs);
          continue;
        }
        session.notice = `요약 생성 실패: ${serializeError(error)}`;
        return;
      }
    }
  }

  async function startSession(payload) {
    if (isActiveState()) throw new Error("이미 캡처 세션이 실행 중입니다.");
    await releaseMediaResources();
    session = createEmptySession();
    session.state = SESSION_STATE.STARTING;
    session.sourceTabId = Number(payload.sourceTabId);
    session.sourceUrl = String(payload.sourceUrl || "");
    session.serverBaseUrl = normalizeServerBaseUrl(payload.serverBaseUrl || "http://127.0.0.1:8050");
    session.accessToken = String(payload.accessToken || "").trim();
    let geminiApiKey = String(payload.geminiApiKey || "").trim();
    payload.geminiApiKey = "";
    session.videoState = { ...session.videoState, ...(payload.videoState || {}) };
    session.startedAtEpochMs = Date.now();
    if (!session.accessToken) throw new Error("로컬 서버 액세스 토큰을 입력해 주세요.");
    if (!geminiApiKey) throw new Error("Gemini API 키를 입력해 주세요.");
    broadcastSnapshot();

    try {
      await verifyServer();
      await createServerSession(geminiApiKey);
      geminiApiKey = "";
      session.mimeType = chooseMimeType();
      await connectMediaStream(payload.streamId);
      session.captureOriginPerf = performance.now();
      session.state = SESSION_STATE.CAPTURING;
      session.notice = session.videoState.hasVideo && session.videoState.paused
        ? "영상 재생을 기다리고 있습니다."
        : "캡처 중";
      if (!session.videoState.hasVideo || !session.videoState.paused) {
        scheduleRecordingWindows(true);
      }
      broadcastSnapshot();
      return { ok: true, snapshot: publicSnapshot() };
    } catch (error) {
      geminiApiKey = "";
      await deleteServerSession();
      await releaseMediaResources();
      setError(error);
      throw error;
    }
  }

  async function updateGeminiKey(payload) {
    if (session.state !== SESSION_STATE.PAUSED_QUOTA || !session.serverSessionId) {
      throw new Error("할당량 소진으로 일시정지된 세션에서만 API 키를 교체할 수 있습니다.");
    }
    let geminiApiKey = String(payload.geminiApiKey || "").trim();
    payload.geminiApiKey = "";
    if (!geminiApiKey) throw new Error("새 Gemini API 키를 입력해 주세요.");

    try {
      const response = await fetchWithTimeout(
        `${session.serverBaseUrl}/v1/sessions/${encodeURIComponent(session.serverSessionId)}/gemini-key`,
        {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ gemini_api_key: geminiApiKey })
        }
      );
      await assertResponse(response);
    } finally {
      geminiApiKey = "";
    }

    closeGap();
    if (audioBytes() >= HARD_LIMIT) {
      session.state = SESSION_STATE.PAUSED_BACKPRESSURE;
      session.notice = "새 API 키를 적용했습니다. 큐를 먼저 처리한 뒤 캡처를 재개합니다.";
      openGap("memory_backpressure");
    } else {
      session.state = SESSION_STATE.CAPTURING;
      session.notice = "새 API 키를 적용해 캡처와 청크 처리를 재개했습니다.";
      if (!session.videoState?.hasVideo || !session.videoState.paused) scheduleRecordingWindows(true);
    }
    scheduleQueueProcessing(0);
    broadcastSnapshot();
    return { ok: true, snapshot: publicSnapshot() };
  }

  function dropQueuedChunks(reason) {
    if (session.processTimer) clearTimeout(session.processTimer);
    session.processTimer = null;
    const droppedChunks = [...session.queue];
    if (session.processing && session.inFlightChunk) droppedChunks.unshift(session.inFlightChunk);
    const seenSequences = new Set();
    for (const chunk of droppedChunks) {
      if (seenSequences.has(chunk.sequence)) continue;
      seenSequences.add(chunk.sequence);
      session.gaps.push({
        reason,
        start_ms: chunk.videoStartMs,
        end_ms: Math.round(chunk.videoStartMs + chunk.durationMs * chunk.playbackRate)
      });
    }
    session.stats.failedChunks += seenSequences.size;
    session.queue.length = 0;
    session.queuedBytes = 0;
    return seenSequences.size;
  }

  async function waitForQueueDrain(maxWaitMs = null) {
    const pendingAtStart = session.queue.length + (session.processing ? 1 : 0);
    const waitMs = maxWaitMs == null ? Core.queueDrainTimeoutMs(pendingAtStart) : maxWaitMs;
    const deadline = Date.now() + waitMs;
    let lastNoticeAt = 0;
    while ((session.queue.length > 0 || session.processing) && Date.now() < deadline) {
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

    let droppedCount = 0;
    if (session.queue.length > 0 || session.processing) {
      droppedCount = dropQueuedChunks("stop_timeout");
      session.notice = `종료 대기시간을 초과해 청크 ${droppedCount}개를 누락 처리했습니다.`;
      broadcastSnapshot();
    }
    return { drained: droppedCount === 0, droppedCount };
  }

  async function stopSession(reason = "사용자가 캡처를 종료했습니다.") {
    if (!isActiveState() && session.state !== SESSION_STATE.ERROR) {
      return { ok: true, snapshot: publicSnapshot() };
    }
    if (session.stopping) return { ok: true, snapshot: publicSnapshot() };
    const quotaWasExhausted = session.state === SESSION_STATE.PAUSED_QUOTA;
    session.stopping = true;
    session.state = SESSION_STATE.STOPPING;
    session.notice = reason;
    cancelWindowScheduler();
    broadcastSnapshot();

    await stopAllRecorders();
    const drainResult = quotaWasExhausted
      ? { drained: false, droppedCount: dropQueuedChunks("quota_abandoned") }
      : await waitForQueueDrain();
    if (session.captions.length > 0 && !quotaWasExhausted) await requestSummary("final");
    closeGap();
    await releaseMediaResources();
    await deleteServerSession();

    session.stopping = false;
    session.state = SESSION_STATE.STOPPED;
    session.stoppedAtEpochMs = Date.now();
    if (quotaWasExhausted && drainResult.droppedCount > 0) {
      session.notice = `${reason} 새 키 없이 종료하여 보존 청크 ${drainResult.droppedCount}개가 처리되지 않았습니다.`;
    } else {
      session.notice = drainResult.droppedCount > 0
        ? `${reason} 종료 대기시간 초과로 청크 ${drainResult.droppedCount}개가 누락되었습니다.`
        : reason;
    }
    session.accessToken = "";
    broadcastSnapshot();
    return { ok: true, snapshot: publicSnapshot() };
  }

  async function deleteServerSession() {
    if (!session.serverSessionId || !session.serverBaseUrl || !session.accessToken) return;
    try {
      await fetchWithTimeout(
        `${session.serverBaseUrl}/v1/sessions/${encodeURIComponent(session.serverSessionId)}`,
        { method: "DELETE", headers: authHeaders() },
        5_000
      );
    } catch {
      // 세션 종료 중 서버 정리 실패는 로컬 미디어 정리를 막지 않습니다.
    } finally {
      session.serverSessionId = null;
    }
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
    if (session.audioContext && session.audioContext.state !== "closed") {
      try {
        await session.audioContext.close();
      } catch {}
    }
    session.audioContext = null;
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

  function addBookmark(payload) {
    const bookmark = {
      id: crypto.randomUUID(),
      timestamp_ms: Math.max(0, Math.round(Number(payload.videoTimeMs) || 0)),
      memo: String(payload.memo || "").trim(),
      created_at: new Date().toISOString()
    };
    session.bookmarks.push(bookmark);
    broadcastSnapshot();
    return { ok: true, bookmark, snapshot: publicSnapshot() };
  }

  function deleteBookmark(payload) {
    const id = String(payload.id || "");
    session.bookmarks = session.bookmarks.filter((bookmark) => bookmark.id !== id);
    broadcastSnapshot();
    return { ok: true, snapshot: publicSnapshot() };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== TARGET.OFFSCREEN) return undefined;

    void (async () => {
      switch (message.type) {
        case MESSAGE.START_SESSION:
          return startSession(message.payload || {});
        case MESSAGE.UPDATE_GEMINI_KEY:
          return updateGeminiKey(message.payload || {});
        case MESSAGE.STOP_SESSION:
          return stopSession(message.payload?.reason || "사용자가 캡처를 종료했습니다.");
        case MESSAGE.GET_SESSION_SNAPSHOT:
          return { ok: true, snapshot: publicSnapshot() };
        case MESSAGE.TIMELINE_EVENT:
          return handleTimelineEvent(message.payload || {});
        case MESSAGE.ADD_BOOKMARK:
          return addBookmark(message.payload || {});
        case MESSAGE.DELETE_BOOKMARK:
          return deleteBookmark(message.payload || {});
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
