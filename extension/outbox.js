(function initializeLectureOutbox(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LectureOutbox = api;
})(globalThis, function createLectureOutbox() {
  const DB_NAME = "lecture-memo-v5";
  const DB_VERSION = 1;
  const STORE_NAME = "audio-outbox";

  function recordId(sessionId, sequence) {
    return `${sessionId}:${Number(sequence)}`;
  }

  function isExpired(record, now = Date.now()) {
    return Number(record?.expiresAtEpochMs || 0) > 0 && Number(record.expiresAtEpochMs) <= now;
  }

  function canAdd(currentBytes, incomingBytes, maximumBytes) {
    return Math.max(0, Number(currentBytes) || 0) + Math.max(0, Number(incomingBytes) || 0)
      <= Math.max(0, Number(maximumBytes) || 0);
  }

  function openDatabase() {
    if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB를 사용할 수 없습니다."));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("sessionId", "sessionId", { unique: false });
          store.createIndex("sourceUrl", "sourceUrl", { unique: false });
          store.createIndex("createdAtEpochMs", "createdAtEpochMs", { unique: false });
        }
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error || new Error("IndexedDB 열기에 실패했습니다.")));
    });
  }

  async function run(mode, callback) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        let result;
        transaction.addEventListener("complete", () => resolve(result));
        transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB 작업이 중단되었습니다.")));
        transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB 작업에 실패했습니다.")));
        result = callback(store);
      });
    } finally {
      database.close();
    }
  }

  async function all() {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).getAll();
        request.addEventListener("success", () => resolve(request.result || []));
        request.addEventListener("error", () => reject(request.error));
      });
    } finally {
      database.close();
    }
  }

  async function totalBytes() {
    return (await all()).reduce((sum, record) => sum + Math.max(0, Number(record.size) || 0), 0);
  }

  async function put(record, maximumBytes) {
    const current = await totalBytes();
    const prior = (await all()).find((value) => value.id === record.id);
    const adjusted = current - Math.max(0, Number(prior?.size) || 0);
    if (!canAdd(adjusted, record.size, maximumBytes)) {
      throw new Error("IndexedDB 오디오 보관 한도 128MiB를 초과합니다.");
    }
    await run("readwrite", (store) => store.put(record));
  }

  async function remove(id) {
    await run("readwrite", (store) => store.delete(id));
  }

  async function updateState(id, state, detail = "") {
    const records = await all();
    const record = records.find((value) => value.id === id);
    if (!record) return;
    record.state = state;
    record.detail = detail;
    record.updatedAtEpochMs = Date.now();
    await run("readwrite", (store) => store.put(record));
  }

  async function listSession(sessionId) {
    const records = (await all()).filter((value) => value.sessionId === sessionId);
    records.sort((left, right) => Number(left.sequence) - Number(right.sequence));
    return records;
  }

  async function latestRecoverable(sourceUrl) {
    const records = (await all())
      .filter((value) => value.sourceUrl === sourceUrl && value.state !== "ACKED")
      .sort((left, right) => Number(right.createdAtEpochMs) - Number(left.createdAtEpochMs));
    return records[0] || null;
  }

  async function markExpired(now = Date.now()) {
    const records = await all();
    await Promise.all(records.filter((record) => isExpired(record, now)).map((record) => updateState(record.id, "EXPIRED", "72시간 보존 기간 경과")));
  }

  return Object.freeze({
    DB_NAME,
    STORE_NAME,
    recordId,
    isExpired,
    canAdd,
    all,
    totalBytes,
    put,
    remove,
    updateState,
    listSession,
    latestRecoverable,
    markExpired
  });
});
