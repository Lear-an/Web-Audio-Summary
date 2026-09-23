(function initializeLectureDiscard(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LectureDiscard = api;
})(globalThis, function createLectureDiscard() {
  async function deleteServerThenLocal(deleteServer, listRecords, removeRecord) {
    await deleteServer();
    let records;
    try {
      records = await listRecords();
      for (const record of records) await removeRecord(record);
    } catch (error) {
      if (error && typeof error === "object") error.serverDeleted = true;
      throw error;
    }
    return records.length;
  }

  return Object.freeze({ deleteServerThenLocal });
});
