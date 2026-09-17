(function initializeLectureContent() {
  if (globalThis.__lectureMemoContentLoaded) return;
  globalThis.__lectureMemoContentLoaded = true;

  const { TARGET, MESSAGE } = LectureProtocol;
  let boundVideo = null;
  let lastTimeUpdateSentAt = 0;
  let overlayHost = null;
  let overlayRoot = null;
  let overlayText = null;
  let overlayStatus = null;
  let overlayCollapsed = false;
  let fontSize = 22;
  let dragState = null;

  function findBestVideo() {
    const videos = [...document.querySelectorAll("video")];
    if (videos.length === 0) return null;
    return videos
      .map((video) => {
        const rect = video.getBoundingClientRect();
        return { video, area: Math.max(0, rect.width) * Math.max(0, rect.height) };
      })
      .sort((left, right) => right.area - left.area)[0]?.video || null;
  }

  function getVideoState() {
    const video = boundVideo && boundVideo.isConnected ? boundVideo : findBestVideo();
    if (!video) {
      return {
        hasVideo: false,
        paused: false,
        ended: false,
        currentTimeMs: 0,
        durationMs: null,
        playbackRate: 1,
        observedAtEpochMs: Date.now()
      };
    }
    if (video !== boundVideo) bindVideo(video);
    return {
      hasVideo: true,
      paused: video.paused,
      ended: video.ended,
      currentTimeMs: Math.max(0, Math.round(video.currentTime * 1000)),
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
      playbackRate: Number(video.playbackRate) || 1,
      observedAtEpochMs: Date.now()
    };
  }

  function sendTimelineEvent(eventName) {
    chrome.runtime.sendMessage({
      target: TARGET.SERVICE_WORKER,
      type: MESSAGE.TIMELINE_EVENT,
      payload: {
        event: eventName,
        ...getVideoState()
      }
    }).catch(() => {});
  }

  const videoHandlers = {
    play: () => sendTimelineEvent("play"),
    pause: () => sendTimelineEvent("pause"),
    seeking: () => sendTimelineEvent("seeking"),
    seeked: () => sendTimelineEvent("seeked"),
    ratechange: () => sendTimelineEvent("ratechange"),
    ended: () => sendTimelineEvent("ended"),
    timeupdate: () => {
      const now = Date.now();
      if (now - lastTimeUpdateSentAt >= 1000) {
        lastTimeUpdateSentAt = now;
        sendTimelineEvent("timeupdate");
      }
    }
  };

  function unbindVideo() {
    if (!boundVideo) return;
    for (const [name, handler] of Object.entries(videoHandlers)) {
      boundVideo.removeEventListener(name, handler);
    }
    boundVideo = null;
  }

  function bindVideo(video) {
    if (video === boundVideo) return;
    unbindVideo();
    boundVideo = video;
    for (const [name, handler] of Object.entries(videoHandlers)) {
      boundVideo.addEventListener(name, handler, { passive: true });
    }
    sendTimelineEvent("video-bound");
  }

  function ensureOverlay() {
    if (overlayHost?.isConnected) return;
    overlayHost = document.createElement("div");
    overlayHost.id = "lecture-memo-overlay-host";
    overlayRoot = overlayHost.attachShadow({ mode: "open" });
    overlayRoot.innerHTML = `
      <style>
        .box {
          pointer-events: auto;
          border: 1px solid rgba(255,255,255,.16);
          border-radius: 14px;
          background: rgba(7,11,21,.78);
          box-shadow: 0 12px 34px rgba(0,0,0,.35);
          color: white;
          font-family: Inter, Pretendard, "Noto Sans KR", system-ui, sans-serif;
          backdrop-filter: blur(8px);
          overflow: hidden;
        }
        .bar { display:flex; align-items:center; gap:6px; padding:5px 7px; cursor:move; background:rgba(13,20,38,.76); }
        .status { flex:1; font-size:10px; color:#aebaf0; letter-spacing:.04em; }
        button { border:0; border-radius:6px; padding:2px 7px; background:#263352; color:white; cursor:pointer; }
        .text { padding:10px 15px 13px; text-align:center; font-weight:650; line-height:1.45; text-shadow:0 2px 4px black; }
        .text.collapsed { display:none; }
      </style>
      <div class="box">
        <div class="bar">
          <span class="status">LECTURE MEMO</span>
          <button type="button" data-action="smaller" aria-label="글자 작게">−</button>
          <button type="button" data-action="larger" aria-label="글자 크게">＋</button>
          <button type="button" data-action="toggle">숨김</button>
        </div>
        <div class="text">자막을 기다리는 중입니다.</div>
      </div>
    `;
    overlayText = overlayRoot.querySelector(".text");
    overlayStatus = overlayRoot.querySelector(".status");
    overlayText.style.fontSize = `${fontSize}px`;

    overlayRoot.addEventListener("click", (event) => {
      const action = event.target?.dataset?.action;
      if (action === "smaller") fontSize = Math.max(14, fontSize - 2);
      if (action === "larger") fontSize = Math.min(42, fontSize + 2);
      if (action === "toggle") {
        overlayCollapsed = !overlayCollapsed;
        overlayText.classList.toggle("collapsed", overlayCollapsed);
        event.target.textContent = overlayCollapsed ? "표시" : "숨김";
      }
      overlayText.style.fontSize = `${fontSize}px`;
    });

    const bar = overlayRoot.querySelector(".bar");
    bar.addEventListener("pointerdown", (event) => {
      const rect = overlayHost.getBoundingClientRect();
      dragState = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      bar.setPointerCapture(event.pointerId);
    });
    bar.addEventListener("pointermove", (event) => {
      if (!dragState) return;
      overlayHost.style.left = `${Math.max(0, event.clientX - dragState.offsetX)}px`;
      overlayHost.style.top = `${Math.max(0, event.clientY - dragState.offsetY)}px`;
      overlayHost.style.bottom = "auto";
      overlayHost.style.transform = "none";
    });
    bar.addEventListener("pointerup", () => { dragState = null; });
    bar.addEventListener("pointercancel", () => { dragState = null; });

    (document.fullscreenElement || document.body || document.documentElement).appendChild(overlayHost);
  }

  function moveOverlayForFullscreen() {
    if (!overlayHost) return;
    const parent = document.fullscreenElement || document.body || document.documentElement;
    if (overlayHost.parentElement !== parent) parent.appendChild(overlayHost);
  }

  function renderOverlay(payload) {
    ensureOverlay();
    const state = String(payload?.state || "IDLE");
    const activeStates = new Set(["STARTING", "CAPTURING", "PAUSED_BACKPRESSURE", "STOPPING", "ERROR"]);
    overlayHost.style.display = activeStates.has(state) ? "block" : "none";
    overlayStatus.textContent = payload?.message || state;
    const segments = Array.isArray(payload?.latestSegments) ? payload.latestSegments : [];
    const text = segments.map((item) => item.text).filter(Boolean).slice(-2).join("\n");
    overlayText.textContent = text || (state === "ERROR" ? "캡처 오류가 발생했습니다." : "자막을 기다리는 중입니다.");
    overlayText.style.whiteSpace = "pre-line";
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== TARGET.CONTENT) return undefined;
    if (message.type === MESSAGE.GET_VIDEO_STATE) {
      sendResponse({ ok: true, videoState: getVideoState() });
      return false;
    }
    if (message.type === MESSAGE.SEEK_TO) {
      const video = boundVideo || findBestVideo();
      if (!video) {
        sendResponse({ ok: false, error: "영상 요소를 찾을 수 없습니다." });
        return false;
      }
      const seconds = Math.max(0, Number(message.payload?.timestampMs || 0) / 1000);
      video.currentTime = Number.isFinite(video.duration) ? Math.min(seconds, video.duration) : seconds;
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === MESSAGE.OVERLAY_UPDATE) {
      renderOverlay(message.payload || {});
      sendResponse({ ok: true });
      return false;
    }
    return undefined;
  });

  document.addEventListener("fullscreenchange", moveOverlayForFullscreen);
  window.addEventListener("pagehide", () => sendTimelineEvent("pagehide"), { once: true });

  const observer = new MutationObserver(() => {
    if (!boundVideo?.isConnected) {
      const next = findBestVideo();
      if (next) bindVideo(next);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const initialVideo = findBestVideo();
  if (initialVideo) bindVideo(initialVideo);
  ensureOverlay();
  overlayHost.style.display = "none";
})();
