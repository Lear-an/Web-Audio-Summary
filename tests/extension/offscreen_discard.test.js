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
