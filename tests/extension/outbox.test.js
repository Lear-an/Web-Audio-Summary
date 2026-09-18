const test = require("node:test");
const assert = require("node:assert/strict");
const Outbox = require("../../extension/outbox.js");

test("recordId is stable per session and sequence", () => {
  assert.equal(Outbox.recordId("session-a", 3), "session-a:3");
});

test("canAdd enforces the configured byte ceiling", () => {
  assert.equal(Outbox.canAdd(100, 50, 150), true);
  assert.equal(Outbox.canAdd(100, 51, 150), false);
});

test("isExpired compares the explicit expiry timestamp", () => {
  assert.equal(Outbox.isExpired({ expiresAtEpochMs: 999 }, 1000), true);
  assert.equal(Outbox.isExpired({ expiresAtEpochMs: 1001 }, 1000), false);
});
