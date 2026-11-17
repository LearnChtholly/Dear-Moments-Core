import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { stableKindList } from "./memory-quality.mjs";

export const supervisorDefaults = {
  enabled: false,
  mode: "observe",
  providerId: "",
  sampleRate: 1,
  includeDsh: false,
};
export const stableKinds = stableKindList;
export function migrateSupervisor(db, filename, oldVersion) {
  if (oldVersion < 5 && filename !== ":memory:") {
    const folder = path.join(path.dirname(filename), "backups");
    mkdirSync(folder, { recursive: true });
    db.prepare("VACUUM INTO ?").run(
      path.join(folder, "before-memory-quality-" + randomUUID() + ".sqlite"),
    );
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = db.prepare("PRAGMA table_info(memory_facts)").all();
    if (!columns.some((c) => c.name === "why"))
      db.exec("ALTER TABLE memory_facts ADD COLUMN why TEXT");
    if (!columns.some((c) => c.name === "supervisor_log_id"))
      db.exec("ALTER TABLE memory_facts ADD COLUMN supervisor_log_id TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_supervisor_log(
        id TEXT PRIMARY KEY, conversation_id TEXT, message_id TEXT, provider TEXT, model TEXT,
        plan TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, reject_reason TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_candidates(
        id TEXT PRIMARY KEY, character_id TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
        subject TEXT NOT NULL, predicate TEXT NOT NULL, value TEXT NOT NULL, quote TEXT NOT NULL,
        why TEXT, confidence REAL NOT NULL DEFAULT 0, seen_count INTEGER NOT NULL DEFAULT 1,
        source_refs TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, promoted_fact_id TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_tool_diagnostics(
        id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, quote TEXT NOT NULL, why TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS experience_pool_time ON agent_experiences(character_id,scope,pool,created_at);
      PRAGMA user_version=5;
    `);
    // Keep operational telemetry out of the reusable experience pools. This is
    // idempotent so databases that already report v4 are repaired as well.
    const telemetryKinds = new Set([
      "dsh.tool",
      "tool_result",
      "mcp.call",
      "mcp.tool",
      "qq.send",
      "dear_moments_expression",
      "edit",
      "read",
      "write",
      "grep",
      "glob",
      "present",
    ]);
    for (const row of db
      .prepare("SELECT id,task_id,pool,content FROM agent_experiences")
      .all()) {
      let data = {};
      try {
        data = JSON.parse(row.content);
      } catch {}
      const telemetry =
        row.task_id.startsWith("dsh:") ||
        row.task_id.startsWith("qq:") ||
        row.task_id.startsWith("mcp:") ||
        row.task_id.startsWith("plugin:") ||
        telemetryKinds.has(data.kind);
      if (!telemetry || row.pool === "telemetry") continue;
      const content = JSON.stringify({ ...data, originalTaskId: row.task_id });
      db.prepare(
        "UPDATE agent_experiences SET pool='telemetry',task_id=?,content=? WHERE id=?",
      ).run("telemetry:" + row.id, content, row.id);
    }
    // Retire legacy candidates that can be rejected without model judgment:
    // missing evidence, question/request quotes, tool results and placeholders.
    const legacy = db
      .prepare(
        `
      SELECT f.id,f.kind,f.quote,f.value,u.user_text
      FROM memory_facts f LEFT JOIN memory_units u ON u.id=f.unit_id
      WHERE f.state='candidate'
    `,
      )
      .all();
    const badQuote =
      /[?？]\\s*$|^(?:请|帮我|能不能|可不可以|可以吗|能否|有没有|是不是|会不会|要不要|为什么|怎么|你去哪|你能|你可以)/;
    const badValue =
      /^(?:未知|不详|未提供|没有|无|unknown|null|undefined|可能包括|待定)$/i;
    for (const row of legacy) {
      const invalid =
        row.kind === "tool_result" ||
        !row.quote ||
        !row.user_text?.includes(row.quote) ||
        badQuote.test(row.quote) ||
        badValue.test(String(row.value || ""));
      if (invalid)
        db.prepare(
          "UPDATE memory_facts SET state='rejected',why=COALESCE(why,?) WHERE id=?",
        ).run("quality_gate:legacy_candidate", row.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
