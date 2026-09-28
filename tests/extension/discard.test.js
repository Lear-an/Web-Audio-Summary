const test = require("node:test");
const assert = require("node:assert/strict");
const Discard = require("../../extension/discard.js");

test("server deletion failure preserves every local record", async () => {
  const records = [{ id: "audio" }, { id: "session" }];
  let listed = false;
  let removed = false;
  await assert.rejects(
    Discard.deleteServerThenLocal(
      async () => { throw new Error("network unavailable"); },
      async () => { listed = true; return records; },
      async () => { removed = true; }
    ),
    /network unavailable/
  );
  assert.equal(listed, false);
  assert.equal(removed, false);
  assert.equal(records.length, 2);
});

test("local records are removed only after server deletion succeeds", async () => {
  const events = [];
  const count = await Discard.deleteServerThenLocal(
    async () => { events.push("server"); },
    async () => [{ id: "audio" }, { id: "session" }],
    async (record) => { events.push(record.id); }
  );
  assert.equal(count, 2);
  assert.deepEqual(events, ["server", "audio", "session"]);
});
