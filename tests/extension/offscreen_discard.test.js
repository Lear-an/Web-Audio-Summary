const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("offscreen discard keeps outbox after network failure and succeeds on retry", async () => {
  let listener;
  let networkFails = true;
  const removed = [];
  const records = [{ id: "audio" }, { id: "session" }];
  const context = vm.createContext({
    AbortController,
    clearTimeout,
    setTimeout,
    LectureCore: {},
    LectureConfig: { OUTBOX_MAX_BYTES: 128 * 1024 * 1024 },
    LectureOutbox: {
      listSession: async () => records.filter((record) => !removed.includes(record.id)),
      remove: async (id) => { removed.push(id); }
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (callback) => { listener = callback; } },
        sendMessage: async () => ({ ok: true })
      }
    },
    fetch: async () => {
      if (networkFails) throw new Error("network unavailable");
      return { ok: true, status: 200, json: async () => ({}), headers: { get: () => null } };
    }
  });
  const extension = path.resolve(__dirname, "../../extension");
  vm.runInContext(fs.readFileSync(path.join(extension, "protocol.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(extension, "discard.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(extension, "offscreen.js"), "utf8");
  const instrumented = source.replace(/\}\)\(\);\s*$/, "globalThis.__setSessionForTest = (patch) => Object.assign(session, patch);\n})();");
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context);
  context.__setSessionForTest({
    serverSessionId: "test-session",
    serverBaseUrl: "https://example.test",
    state: context.LectureProtocol.SESSION_STATE.PAUSED_ACTION,
    queue: records,
    queuedBytes: 100
  });

  const discard = () => new Promise((resolve) => {
    listener({
      target: context.LectureProtocol.TARGET.OFFSCREEN,
      type: context.LectureProtocol.MESSAGE.DISCARD_SESSION,
      payload: { userId: "user", accessToken: "test-token" }
    }, {}, resolve);
  });

  const failed = await discard();
  assert.equal(failed.ok, false);
  assert.equal(failed.snapshot.state, "PAUSED_ACTION");
  assert.equal(failed.snapshot.queueCount, 2);
  assert.deepEqual(removed, []);

  networkFails = false;
  const retried = await discard();
  assert.equal(retried.ok, true);
  assert.equal(retried.snapshot.state, "STOPPED");
  assert.deepEqual(removed, ["audio", "session"]);
});

test("preserved session finalizes without requesting a new tab capture stream", async () => {
  let listener;
  const calls = [];
  const marker = {
    id: "saved-session:session", kind: "session", sessionId: "saved-session",
    sourceUrl: "https://example.test/lecture", sourceTitle: "강의", state: "FINALIZE_PENDING",
    startedAtEpochMs: Date.now() - 60_000, stoppedAtEpochMs: Date.now(), sequence: -1
  };
  const context = vm.createContext({
    AbortController, clearTimeout, setTimeout, performance, URL,
    LectureCore: { queueDrainTimeoutMs: () => 100 },
    LectureDiscard: {},
    LectureConfig: { SERVER_BASE_URL: "https://example.test", OUTBOX_MAX_BYTES: 128 * 1024 * 1024 },
    LectureOutbox: {
      markExpired: async () => {}, latestRecoverable: async () => marker,
      listSession: async () => [marker], remove: async () => {}, put: async () => {}
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (callback) => { listener = callback; } },
        sendMessage: async () => ({ ok: true })
      }
    },
    fetch: async (url) => {
      calls.push(url);
      const body = url.endsWith("/resume")
        ? { session_id: "saved-session", next_sequence: 0, segments: [] }
        : { saved: true, status: "completed", document_id: "saved-document" };
      return { ok: true, status: 200, json: async () => body, headers: { get: () => null } };
    }
  });
  const extension = path.resolve(__dirname, "../../extension");
  vm.runInContext(fs.readFileSync(path.join(extension, "protocol.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(extension, "offscreen.js"), "utf8"), context);
  const response = await new Promise((resolve) => listener({
    target: context.LectureProtocol.TARGET.OFFSCREEN,
    type: context.LectureProtocol.MESSAGE.PROCESS_PRESERVED_CHUNKS,
    payload: { serverBaseUrl: "https://example.test", userId: "user", accessToken: "token", sourceUrl: marker.sourceUrl }
  }, {}, resolve));
  assert.equal(response.ok, true, JSON.stringify(response));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.map((url) => url.slice(url.lastIndexOf("/"))), ["/resume", "/archive"]);
});

test("archive retries a retryable server failure before completing", async () => {
  let attempts = 0;
  const removed = [];
  const context = vm.createContext({
    AbortController, clearTimeout, setTimeout, URL,
    LectureCore: { transientRetryDelayMs: () => 0 },
    LectureDiscard: {},
    LectureConfig: { SERVER_BASE_URL: "https://example.test", OUTBOX_MAX_BYTES: 128 * 1024 * 1024 },
    LectureOutbox: { remove: async (id) => removed.push(id) },
    chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: async () => ({ ok: true }) } },
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false, status: 502,
          json: async () => ({ error: { code: "openai_request_failed", message: "일시적 오류", retryable: true } }),
          headers: { get: () => null }
        };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ saved: true, status: "completed", document_id: "doc", summary: { summary: "복구된 요약" } }),
        headers: { get: () => null }
      };
    }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../extension/protocol.js"), "utf8"), context);
  const source = fs.readFileSync(path.resolve(__dirname, "../../extension/offscreen.js"), "utf8");
  const instrumented = source.replace(/\}\)\(\);\s*$/, "globalThis.__setSessionForTest = (patch) => Object.assign(session, patch);\nglobalThis.__archiveForTest = archiveServerSessionWithRetry;\n})();");
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context);
  context.__setSessionForTest({
    serverSessionId: "session", serverBaseUrl: "https://example.test",
    userId: "user", accessToken: "code", nextSequence: 1,
    startedAtEpochMs: Date.now() - 60_000, stoppedAtEpochMs: Date.now()
  });
  const result = await context.__archiveForTest();
  assert.equal(result.saved, true);
  assert.equal(attempts, 2);
  assert.deepEqual(removed, ["session:session"]);
});

test("unverified empty transcript displays dots, preserves audio, and permits review retry", async () => {
  const removed = [];
  const states = [];
  let requestCount = 0;
  const context = vm.createContext({
    AbortController, Blob, FormData, clearTimeout, setTimeout, performance, URL,
    LectureConfig: { SERVER_BASE_URL: "https://example.test", OUTBOX_MAX_BYTES: 128 * 1024 * 1024 },
    LectureDiscard: {},
    LectureOutbox: {
      updateState: async (_id, state) => states.push(state),
      remove: async (id) => removed.push(id)
    },
    chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: async () => ({ ok: true }) } },
    fetch: async (_url, options) => {
      assert.equal(options.body.get("audio_signal_status"), "non_silent");
      assert.equal(options.body.get("review_retry"), requestCount === 0 ? "false" : "true");
      requestCount += 1;
      return {
        ok: true, status: 200,
        json: async () => ({
          review_required: requestCount === 1,
          segments: [{ relative_start_ms: 0, relative_end_ms: 15_000, text: requestCount === 1 ? "..." : "복구된 발화", uncertain: true }]
        }),
        headers: { get: () => null }
      };
    }
  });
  const extension = path.resolve(__dirname, "../../extension");
  vm.runInContext(fs.readFileSync(path.join(extension, "protocol.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(extension, "core.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(extension, "offscreen.js"), "utf8");
  const instrumented = source.replace(/\}\)\(\);\s*$/, "globalThis.__setSessionForTest = (patch) => Object.assign(session, patch);\nglobalThis.__processQueueForTest = processQueue;\nglobalThis.__snapshotForTest = publicSnapshot;\n})();");
  vm.runInContext(instrumented, context);
  const blob = new Blob(["audio"], { type: "audio/webm" });
  context.__setSessionForTest({
    state: context.LectureProtocol.SESSION_STATE.CAPTURING,
    serverSessionId: "session", serverBaseUrl: "https://example.test", userId: "user", accessToken: "code",
    captureOriginPerf: performance.now() - 1000,
    queue: [{ id: "session:0", sequence: 0, blob, durationMs: 15_000, captureStartMs: 0, captureEndMs: 15_000, videoStartMs: 0, playbackRate: 1, overlapMs: 0, mimeType: "audio/webm", audioSignalStatus: "non_silent" }],
    queuedBytes: blob.size
  });
  await context.__processQueueForTest();
  let snapshot = context.__snapshotForTest();
  assert.equal(snapshot.state, "CAPTURING");
  assert.equal(snapshot.queueCount, 0);
  assert.equal(snapshot.reviewCount, 1);
  assert.equal(snapshot.captions[0].text, "...");
  assert.equal(snapshot.captions[0].review_required, true);
  assert.deepEqual(states, ["SENDING", "REVIEW"]);
  assert.deepEqual(removed, []);
  context.__setSessionForTest({ queue: [{ id: "session:0", sequence: 0, blob, durationMs: 15_000, captureStartMs: 0, captureEndMs: 15_000, videoStartMs: 0, playbackRate: 1, overlapMs: 0, mimeType: "audio/webm", audioSignalStatus: "non_silent", reviewRetry: true }], queuedBytes: blob.size });
  await context.__processQueueForTest();
  snapshot = context.__snapshotForTest();
  assert.equal(snapshot.reviewCount, 0);
  assert.equal(snapshot.captions[0].text, "복구된 발화");
  assert.deepEqual(removed, ["session:0"]);
});

test("explicit preserved-chunk action retries a stored review record", async () => {
  let listener;
  const removed = [];
  const requests = [];
  const marker = {
    id: "saved-session:session", kind: "session", sessionId: "saved-session",
    sourceUrl: "https://example.test/lecture", sourceTitle: "강의", state: "INCOMPLETE",
    startedAtEpochMs: Date.now() - 60_000, stoppedAtEpochMs: Date.now(), sequence: -1, nextSequence: 1
  };
  const blob = new Blob(["audio"], { type: "audio/webm" });
  const review = {
    id: "saved-session:0", kind: "chunk", sessionId: "saved-session", sourceUrl: marker.sourceUrl,
    state: "REVIEW", sequence: 0, blob, size: blob.size, durationMs: 15_000,
    captureStartMs: 0, captureEndMs: 15_000, videoStartMs: 0, playbackRate: 1,
    overlapMs: 0, mimeType: "audio/webm", audioSignalStatus: "non_silent"
  };
  const context = vm.createContext({
    AbortController, Blob, FormData, clearTimeout, setTimeout, performance, URL,
    LectureConfig: { SERVER_BASE_URL: "https://example.test", OUTBOX_MAX_BYTES: 128 * 1024 * 1024, OUTBOX_RETENTION_HOURS: 72 },
    LectureDiscard: {},
    LectureOutbox: {
      markExpired: async () => {}, latestRecoverable: async () => marker,
      listSession: async () => [marker, review].filter((record) => !removed.includes(record.id)),
      updateState: async () => {}, remove: async (id) => removed.push(id), put: async () => {}
    },
    chrome: { runtime: { onMessage: { addListener: (callback) => { listener = callback; } }, sendMessage: async () => ({ ok: true }) } },
    fetch: async (url, options) => {
      requests.push(url);
      if (url.endsWith("/chunks")) assert.equal(options.body.get("review_retry"), "true");
      const body = url.endsWith("/resume")
        ? { session_id: "saved-session", next_sequence: 1, segments: [{ sequence: 0, start_ms: 0, end_ms: 15_000, text: "...", uncertain: true, review_required: true }] }
        : url.endsWith("/chunks")
          ? { review_required: false, segments: [{ relative_start_ms: 0, relative_end_ms: 15_000, text: "복구된 발화", uncertain: true }] }
          : { saved: true, status: "completed", document_id: "saved-document" };
      return { ok: true, status: 200, json: async () => body, headers: { get: () => null } };
    }
  });
  const extension = path.resolve(__dirname, "../../extension");
  vm.runInContext(fs.readFileSync(path.join(extension, "protocol.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(extension, "core.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(extension, "offscreen.js"), "utf8");
  const instrumented = source.replace(/\}\)\(\);\s*$/, "globalThis.__snapshotForTest = publicSnapshot;\n})();");
  vm.runInContext(instrumented, context);
  const result = await new Promise((resolve) => listener({
    target: context.LectureProtocol.TARGET.OFFSCREEN,
    type: context.LectureProtocol.MESSAGE.PROCESS_PRESERVED_CHUNKS,
    payload: { serverBaseUrl: "https://example.test", userId: "user", accessToken: "code", sourceUrl: marker.sourceUrl }
  }, {}, resolve));
  assert.equal(result.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(requests.filter((url) => url.endsWith("/chunks")).length, 1);
  assert.equal(context.__snapshotForTest().reviewCount, 0);
  assert.ok(removed.includes("saved-session:0"));
});
