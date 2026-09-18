(function initializeLectureConfig(root) {
  if (root.LectureConfig) return;

  root.LectureConfig = Object.freeze({
    // Render URL이 확정되면 이 값과 manifest.json의 host_permissions를 함께 교체합니다.
    SERVER_BASE_URL: "http://127.0.0.1:8050",
    OUTBOX_MAX_BYTES: 128 * 1024 * 1024,
    OUTBOX_RETENTION_HOURS: 72
  });
})(globalThis);
