(function initializeLectureConfig(root) {
  if (root.LectureConfig) return;

  root.LectureConfig = Object.freeze({
    // 운영 Render 주소를 확장 프로그램에 고정합니다.
    SERVER_BASE_URL: "https://web-audio-summary.onrender.com",
    // 패널 재오픈 시 Render 생존 확인 중복을 억제하는 시간입니다 (120~300초).
    SERVER_LIVE_CACHE_SECONDS: 180,
    OUTBOX_MAX_BYTES: 128 * 1024 * 1024,
    OUTBOX_RETENTION_HOURS: 72
  });
})(globalThis);
