const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createWorker(fetchImpl) {
  let messageListener;
  const sessionStorage = {};
  const publishedStatuses = [];
  const extensionPath = path.resolve(__dirname, "../../extension");
  const context = vm.createContext({
    AbortController,
    URL,
    clearTimeout,
    setTimeout,
    performance,
    fetch: fetchImpl,
    chrome: {
      action: { onClicked: { addListener: () => {} } },
      runtime: {
        onMessage: { addListener: (callback) => { messageListener = callback; } },
        sendMessage: async (message) => { publishedStatuses.push(message); return { ok: true }; }
      },
      storage: {
        session: {
          get: async (keys) => Object.fromEntries(keys.map((key) => [key, sessionStorage[key]])),
          set: async (values) => { Object.assign(sessionStorage, values); }
        }
      },
      tabs: {
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} }
      }
    }
  });

  context.importScripts = (...files) => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(extensionPath, file), "utf8");
      vm.runInContext(source, context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(extensionPath, "service_worker.js"), "utf8"), context, {
    filename: "service_worker.js"
  });

  function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const keepChannelOpen = messageListener({
        target: "service-worker",
        type,
        payload
      }, {}, resolve);
      if (keepChannelOpen !== true) reject(new Error("Expected an asynchronous service-worker response."));
    });
  }

  return { send, sessionStorage, publishedStatuses };
}

function readyResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: "ok",
      mock_mode: false,
      storage: "mongodb",
      chunk_seconds: 60,
      chunk_overlap_seconds: 2,
      max_chunk_bytes: 6_000_000
    })
  };
}

function liveResponse() {
  return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
}

test("panel liveness checks /health/live and caches duplicate opens", async () => {
  let requests = 0;
  const paths = [];
  const worker = createWorker(async (url) => {
    requests += 1;
    paths.push(new URL(url).pathname);
    return liveResponse();
  });
  const payload = { serverBaseUrl: "https://web-audio-summary.onrender.com" };

  const opened = await worker.send("CHECK_SERVER_LIVE", payload);
  const reopened = await worker.send("CHECK_SERVER_LIVE", payload);

  assert.equal(opened.ok, true);
  assert.equal(opened.state, "connected");
  assert.equal(reopened.cached, true);
  assert.equal(requests, 1);
  assert.deepEqual(paths, ["/health/live"]);
  assert.equal(worker.sessionStorage.serverLiveLastState, "connected");
});

test("Render liveness and storage readiness use separate endpoints", async () => {
  const paths = [];
  const worker = createWorker(async (url) => {
    const pathName = new URL(url).pathname;
    paths.push(pathName);
    return pathName === "/health/live" ? liveResponse() : readyResponse();
  });
  const payload = { serverBaseUrl: "https://web-audio-summary.onrender.com" };

  const live = await worker.send("CHECK_SERVER_LIVE", payload);
  const ready = await worker.send("CHECK_SERVER_READY", payload);

  assert.equal(live.state, "connected");
  assert.equal(ready.state, "ready");
  assert.deepEqual(paths, ["/health/live", "/health/ready"]);
});

test("storage failure keeps Render connected and marks storage unavailable", async () => {
  const worker = createWorker(async (url) => {
    assert.equal(new URL(url).pathname, "/health/ready");
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "storage_unavailable", message: "Atlas ping failed" } })
    };
  });
  const payload = { serverBaseUrl: "https://web-audio-summary.onrender.com" };

  const result = await worker.send("CHECK_SERVER_READY", payload);
  const statuses = worker.publishedStatuses.map((message) => [message.type, message.payload.state]);

  assert.equal(result.ok, false);
  assert.equal(result.state, "unavailable");
  assert.equal(worker.sessionStorage.serverLiveLastState, "connected");
  assert.equal(worker.sessionStorage.serverStorageLastState, "unavailable");
  assert.ok(statuses.some(([type, state]) => type === "SERVER_LIVE_STATUS" && state === "connected"));
  assert.ok(statuses.some(([type, state]) => type === "SERVER_READY_STATUS" && state === "unavailable"));
});

test("a readiness network failure leaves storage unknown and Render unverified", async () => {
  const worker = createWorker(async () => { throw new Error("network unavailable"); });
  const result = await worker.send("CHECK_SERVER_READY", {
    serverBaseUrl: "https://web-audio-summary.onrender.com"
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, "unknown");
  assert.equal(worker.sessionStorage.serverLiveLastState, "unavailable");
  assert.equal(worker.sessionStorage.serverStorageLastState, "unknown");
});
