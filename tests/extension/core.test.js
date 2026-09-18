const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../../extension/core.js");

test("normalizeText removes spaces and punctuation", () => {
  assert.equal(Core.normalizeText("데이터 중복을 줄입니다."), "데이터중복을줄입니다");
});

test("diceSimilarity recognizes near-duplicate Korean captions", () => {
  const score = Core.diceSimilarity(
    "데이터 중복을 줄이는 과정입니다.",
    "중복을 줄이는 과정입니다"
  );
  assert.ok(score >= 0.68);
});

test("dedupeIncoming only removes overlapping duplicate segments", () => {
  const previous = [
    { start_ms: 9000, end_ms: 10100, text: "정규화는 중복을 줄이는 과정입니다." }
  ];
  const incoming = [
    { start_ms: 9500, end_ms: 10400, text: "중복을 줄이는 과정입니다." },
    { start_ms: 10500, end_ms: 13000, text: "이후 테이블을 분리합니다." }
  ];
  assert.deepEqual(Core.dedupeIncoming(previous, incoming), [incoming[1]]);
});

test("reconcileCaptionBoundary removes an exact overlapping duplicate", () => {
  const previous = [
    { id: "old", start_ms: 9000, end_ms: 11000, text: "정규화는 중복을 줄입니다.", uncertain: false }
  ];
  const incoming = [
    { id: "new", start_ms: 10000, end_ms: 12000, text: "정규화는 중복을 줄입니다", uncertain: false }
  ];
  const result = Core.reconcileCaptionBoundary(previous, incoming);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "final");
  assert.equal(result[0].end_ms, 12000);
});

test("reconcileCaptionBoundary keeps the more complete contained sentence", () => {
  const previous = [
    { id: "old", start_ms: 9000, end_ms: 11000, text: "중복을 줄입니다", uncertain: false }
  ];
  const incoming = [
    { id: "new", start_ms: 10000, end_ms: 13000, text: "정규화는 데이터 중복을 줄입니다", uncertain: false }
  ];
  const result = Core.reconcileCaptionBoundary(previous, incoming);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "정규화는 데이터 중복을 줄입니다");
});

test("reconcileCaptionBoundary merges suffix and prefix text locally", () => {
  const previous = [
    { id: "old", start_ms: 9000, end_ms: 11000, text: "데이터베이스 정규화는", uncertain: false }
  ];
  const incoming = [
    { id: "new", start_ms: 10500, end_ms: 14000, text: "정규화는 중복을 줄이는 과정입니다", uncertain: true }
  ];
  const result = Core.reconcileCaptionBoundary(previous, incoming);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "데이터베이스 정규화는 중복을 줄이는 과정입니다");
  assert.equal(result[0].uncertain, true);
});

test("reconcileCaptionBoundary preserves ambiguous overlapping sentences", () => {
  const previous = [
    { id: "old", start_ms: 9000, end_ms: 11000, text: "첫 번째 표를 확인합니다", uncertain: false }
  ];
  const incoming = [
    { id: "new", start_ms: 10500, end_ms: 13000, text: "이제 모델을 학습합니다", uncertain: false }
  ];
  const result = Core.reconcileCaptionBoundary(previous, incoming);
  assert.equal(result.length, 2);
  assert.equal(result[1].status, "final");
});

test("reconcileCaptionBoundary does not discard a short contained utterance", () => {
  const previous = [
    { id: "old", start_ms: 9000, end_ms: 11000, text: "네", uncertain: false }
  ];
  const incoming = [
    { id: "new", start_ms: 10500, end_ms: 13000, text: "네트워크 설정을 확인합니다", uncertain: false }
  ];
  assert.equal(Core.reconcileCaptionBoundary(previous, incoming).length, 2);
});

test("reconcileCaptionBoundary does not merge similar text outside the time boundary", () => {
  const previous = [
    { id: "old", start_ms: 1000, end_ms: 2000, text: "정규화는 중복을 줄입니다", uncertain: false }
  ];
  const incoming = [
    { id: "new", start_ms: 10000, end_ms: 12000, text: "정규화는 중복을 줄입니다", uncertain: false }
  ];
  assert.equal(Core.reconcileCaptionBoundary(previous, incoming).length, 2);
});

test("formatTimestamp supports SRT and VTT separators", () => {
  assert.equal(Core.formatTimestamp(3_723_045), "01:02:03.045");
  assert.equal(Core.formatTimestamp(3_723_045, ","), "01:02:03,045");
});

test("isRetryableStatus never retries quota exhaustion", () => {
  assert.equal(Core.isRetryableStatus(429), false);
  assert.equal(Core.isRetryableStatus(502), true);
  assert.equal(Core.isRetryableStatus(400), false);
});

test("isSessionResumeRequired recognizes new and legacy preserved records", () => {
  assert.equal(Core.isSessionResumeRequired({ state: "SESSION_RESUME_REQUIRED" }), true);
  assert.equal(Core.isSessionResumeRequired({ code: "session_resume_required" }), true);
  assert.equal(
    Core.isSessionResumeRequired({ state: "NEEDS_ACTION", detail: "서버 세션을 먼저 복구해 주세요." }),
    true
  );
  assert.equal(
    Core.isSessionResumeRequired({ state: "NEEDS_ACTION", detail: "파일 형식이 올바르지 않습니다." }),
    false
  );
});

test("transientRetryDelayMs uses 15, 30, 45 second capped backoff", () => {
  assert.equal(Core.transientRetryDelayMs(1), 15_000);
  assert.equal(Core.transientRetryDelayMs(2), 30_000);
  assert.equal(Core.transientRetryDelayMs(3), 45_000);
  assert.equal(Core.transientRetryDelayMs(9), 45_000);
});

test("queueDrainTimeoutMs scales between five and fifteen minutes", () => {
  assert.equal(Core.queueDrainTimeoutMs(1), 300_000);
  assert.equal(Core.queueDrainTimeoutMs(6), 360_000);
  assert.equal(Core.queueDrainTimeoutMs(20), 900_000);
});
