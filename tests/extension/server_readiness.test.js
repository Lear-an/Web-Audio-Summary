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
      chunk_seconds: 60,
      chunk_overlap_seconds: 2,
      max_chunk_bytes: 6_000_000
    })
  };
}

test("server readiness caches panel checks and forced checks bypass the cache", async () => {
  let requests = 0;
  const worker = createWorker(async () => {
    requests += 1;
    return readyResponse();
  });
  const payload = { serverBaseUrl: "https://web-audio-summary.onrender.com" };

  const opened = await worker.send("CHECK_SERVER_READY", payload);
  const reopened = await worker.send("CHECK_SERVER_READY", payload);
  const captureStart = await worker.send("CHECK_SERVER_READY", { ...payload, force: true });

  assert.equal(opened.ok, true);
  assert.equal(opened.state, "ready");
  assert.equal(reopened.cached, true);
  assert.equal(captureStart.cached, undefined);
  assert.equal(requests, 2);
  assert.equal(worker.sessionStorage.serverReadyLastState, "ready");
});

test("panel warm-up and capture-start check share the same in-flight request", async () => {
  let requests = 0;
  let signalRequestStarted;
  let releaseResponse;
  const requestStarted = new Promise((resolve) => { signalRequestStarted = resolve; });
  const responsePromise = new Promise((resolve) => { releaseResponse = resolve; });
  const worker = createWorker(async () => {
    requests += 1;
    signalRequestStarted();
    return responsePromise;
  });
  const payload = { serverBaseUrl: "https://web-audio-summary.onrender.com" };

  const panelCheck = worker.send("CHECK_SERVER_READY", payload);
  await requestStarted;
  const captureCheck = worker.send("CHECK_SERVER_READY", { ...payload, force: true });
  await Promise.resolve();
  assert.equal(requests, 1);

  releaseResponse(readyResponse());
  const [panelResult, captureResult] = await Promise.all([panelCheck, captureCheck]);
  assert.equal(panelResult.ok, true);
  assert.equal(captureResult.ok, true);
  assert.equal(requests, 1);
});

test("failed panel warm-up can be retried with a forced capture-start check", async () => {
  let requests = 0;
  const worker = createWorker(async () => {
    requests += 1;
    if (requests === 1) return { ok: false, status: 503, json: async () => ({ detail: "storage unavailable" }) };
    return readyResponse();
  });
  const payload = { serverBaseUrl: "https://web-audio-summary.onrender.com" };

  const warmup = await worker.send("CHECK_SERVER_READY", payload);
  const retry = await worker.send("CHECK_SERVER_READY", { ...payload, force: true });

  assert.equal(warmup.ok, false);
  assert.equal(warmup.state, "unavailable");
  assert.equal(retry.ok, true);
  assert.equal(worker.sessionStorage.serverReadyLastState, "ready");
  assert.equal(requests, 2);
});
