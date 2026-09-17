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

test("formatTimestamp supports SRT and VTT separators", () => {
  assert.equal(Core.formatTimestamp(3_723_045), "01:02:03.045");
  assert.equal(Core.formatTimestamp(3_723_045, ","), "01:02:03,045");
});

test("isRetryableStatus never retries quota exhaustion", () => {
  assert.equal(Core.isRetryableStatus(429), false);
  assert.equal(Core.isRetryableStatus(502), true);
  assert.equal(Core.isRetryableStatus(400), false);
});
