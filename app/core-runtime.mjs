import { meanEmbedding } from "./text-chunks.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { embeddingIdentity } from "./providers.mjs";
import { MemoryWorker } from "./memory.mjs";
export class CoreRuntime {
  constructor(store, memory) {
    Object.assign(this, { store, memory });
    this.worker = new MemoryWorker(memory, { busy: () => this.indexing });
    this.worker.onError = () => this.noteError("extraction");
    this.indexing = false;
  }
  ingest(p) {
    if (
      !p ||
      typeof p.sessionId !== "string" ||
      !p.sessionId ||
      p.sessionId.length > 200 ||
      typeof p.eventId !== "string" ||
      !p.eventId ||
      p.eventId.length > 400 ||
      !["user", "assistant", "tool"].includes(p.role) ||
      typeof p.text !== "string" ||
      p.text.length > 1000000
    )
      throw Error("invalid ingest");
    return this.store.transaction(() => {
      const receipt = this.store.db
        .prepare(
          "SELECT message_id FROM bridge_receipts WHERE connector=? AND event_id=?",
        )
        .get("dsh-core", p.eventId);
      let message;
      if (receipt)
        message = this.store.db
          .prepare("SELECT * FROM messages WHERE id=?")
          .get(receipt.message_id);
      if (!message) {
        const title = "DSH " + p.sessionId;
        const c =
          this.store.conversations().find((x) => x.title === title) ||
          this.store.conversation(title, "private");
        message = this.store.message(
          c.id,
          p.role,
          p.text,
          p.interrupted ? "interrupted" : "complete",
        );
        if (p.time) {
          const time = new Date(p.time);
          if (!Number.isFinite(time.getTime())) throw Error("invalid time");
          this.store.db
            .prepare("UPDATE messages SET created_at=? WHERE id=?")
            .run(time.toISOString(), message.id);
        }
      }
      const user = this.store
        .messages(message.conversation_id)
        .findLast((x) => x.role === "user" && x.status === "complete");
      if (user) this.memory.ingestTurn(user.id);
      if (!receipt)
        this.store.db
          .prepare("INSERT INTO bridge_receipts VALUES(?,?,?)")
          .run("dsh-core", p.eventId, message.id);
      return {
        accepted: true,
        id: message.id,
        duplicate: !!receipt,
        indexed: false,
        indexing: "background",
      };
    });
  }
  start() {
    const previous = this.store.db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='core_dirty_conversations'",
      )
      .get();
    if (!previous && this.store.filename !== ":memory:") {
      const folder = path.join(path.dirname(this.store.filename), "backups");
      fs.mkdirSync(folder, { recursive: true });
      this.store.db
        .prepare("VACUUM INTO ?")
        .run(
          path.join(
            folder,
            "before-core-maintenance-" + randomUUID() + ".sqlite",
          ),
        );
    }
    this.store.db.exec(`
          CREATE TABLE IF NOT EXISTS core_dirty_conversations(id TEXT PRIMARY KEY);
          CREATE TRIGGER IF NOT EXISTS core_messages_insert AFTER INSERT ON messages BEGIN
            INSERT OR IGNORE INTO core_dirty_conversations VALUES(new.conversation_id); END;
          CREATE TRIGGER IF NOT EXISTS core_messages_update AFTER UPDATE ON messages BEGIN
            INSERT OR IGNORE INTO core_dirty_conversations VALUES(new.conversation_id); END;
          CREATE TRIGGER IF NOT EXISTS core_messages_delete AFTER DELETE ON messages BEGIN
            INSERT OR IGNORE INTO core_dirty_conversations VALUES(old.conversation_id); END;
        `);
    const initialized = this.store.db
      .prepare("SELECT 1 FROM meta WHERE key='coreBackfillInitialized'")
      .get();
    if (!initialized) {
      this.memory.backfill();
      this.store.db
        .prepare("INSERT INTO meta VALUES('coreBackfillInitialized','true')")
        .run();
    }
    for (const row of this.store.db
      .prepare("SELECT id FROM core_dirty_conversations")
      .all()) {
      this.store.transaction(() => {
        this.memory.backfill(row.id);
        this.store.db
          .prepare("DELETE FROM core_dirty_conversations WHERE id=?")
          .run(row.id);
      });
    }
    this.memory.longText.syncMissing(this.memory.character());
    this.worker.start();
    this.timer = setInterval(
      () => this.indexTick().catch(() => this.noteError("embedding")),
      3000,
    );
    this.timer.unref?.();
  }
  async indexTick() {
    if (this.indexing || this.worker.running || this.closed) return;
    const profile = this.store.setting("memoryModel");
    if (
      !profile.embedding ||
      !this.store.setting("memoryPolicy").enabled ||
      this.store.setting("memoryPolicy").paused
    )
      return;
    this.indexing = true;
    this.controller = new AbortController();
    try {
      this.memory.longText.syncMissing(this.memory.character());
      const identity = await embeddingIdentity(profile, {
        signal: this.controller.signal,
      });
      const row = this.store.db
        .prepare(
          "SELECT DISTINCT unit_id FROM memory_chunks WHERE character_id=? AND (embedding IS NULL OR json_extract(embedding,'$.model')!=?) AND unit_id IS NOT NULL LIMIT 1",
        )
        .get(this.memory.character(), identity);
      if (row) {
        const unit = this.memory.unit(row.unit_id);
        if (unit?.status === "active") {
          const complete = await this.memory.longText.fillUnit(
            unit,
            profile,
            AbortSignal.any([
              this.controller.signal,
              AbortSignal.timeout(30000),
            ]),
          );
          if (complete) {
            const vectors = this.store.db
              .prepare(
                "SELECT embedding FROM memory_chunks WHERE unit_id=? ORDER BY part",
              )
              .all(unit.id)
              .map((row) => JSON.parse(row.embedding));
            const combined = meanEmbedding(vectors);
            this.store.db
              .prepare("UPDATE memory_keys SET embedding=? WHERE unit_id=?")
              .run(JSON.stringify(combined), unit.id);
          }
        }
      } else
        await this.memory.longText.fillManual(
          this.memory.character(),
          profile,
          this.controller.signal,
        );
      this.lastSuccessAt = new Date().toISOString();
    } finally {
      this.indexing = false;
      this.controller = null;
    }
  }
  noteError(stage) {
    this.lastError = {
      stage,
      code: "background_task_failed",
      at: new Date().toISOString(),
    };
    console.warn(JSON.stringify(this.lastError));
  }
  status() {
    const profile = this.store.setting("memoryModel");
    return {
      indexing: this.indexing,
      extracting: this.worker.running,
      closed: !!this.closed,
      extractionConfigured: !!profile.name,
      embeddingConfigured: !!profile.embedding,
      paused: this.store.setting("memoryPolicy").paused,
      lastError: this.lastError || null,
      lastSuccessAt: this.lastSuccessAt || null,
      embeddingModel: profile.embedding,
      jobs: this.store.db
        .prepare(
          "SELECT status,count(*) count FROM memory_jobs GROUP BY status",
        )
        .all(),
    };
  }
  async stop() {
    this.closed = true;
    clearInterval(this.timer);
    this.worker.stop();
    this.controller?.abort();
    while (this.indexing || this.worker.running)
      await new Promise((r) => setTimeout(r, 20));
  }
}
