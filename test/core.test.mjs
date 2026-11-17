import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../app/store.mjs";
import { MemoryCore } from "../app/memory.mjs";
test("core sqlite memory ingest", () => {
  const s = new Store(":memory:");
  const m = new MemoryCore(s);
  const c = s.conversation("t");
  const u = s.message(c.id, "user", "我喜欢蓝色");
  s.message(c.id, "assistant", "记住了");
  m.ingestTurn(u.id);
  assert.equal(s.db.prepare("SELECT count(*) n FROM memory_units").get().n, 1);
  s.close();
});
