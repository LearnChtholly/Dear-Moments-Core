import { generate, isLocal } from "./providers.mjs";
import { needsTestReview, reviewTestUnit } from "./test-memory-review.mjs";
import { extractionParts, meanEmbedding } from "./text-chunks.mjs";
import { stableKinds } from "./schema-migration.mjs";
import {
  localKinds,
  extractionPrompt,
  factQuality,
} from "./memory-quality.mjs";
import { stamp, signature, parse } from "./memory-utils.mjs";
import { extractionSchema, stablePrompt } from "./memory-extraction.mjs";
export class MemoryWorker {
  constructor(
    core,
    {
      busy = () => false,
      notify = () => {},
      ensureLocal = async () => {},
    } = {},
  ) {
    this.core = core;
    this.ensureLocal = ensureLocal;
    this.busy = busy;
    this.notify = notify;
    this.running = false;
    this.controller = null;
    this.timer = null;
  }
  start() {
    this.timer = setInterval(
      () =>
        this.tick().catch(() => {
          this.onError?.();
        }),
      3000,
    );
    this.timer.unref?.();
  }
  stop() {
    clearInterval(this.timer);
    this.controller?.abort();
  }
  interrupt() {
    this.controller?.abort();
  }
  async tick() {
    const policy = this.core.store.setting("memoryPolicy");
    if (this.running || this.busy() || policy.paused || !policy.enabled) return;
    const profile = this.core.store.setting("memoryModel");
    if (!profile.name || profile.kind !== "ollama" || !isLocal(profile.baseUrl))
      return;
    const job = this.core.db
      .prepare(
        "SELECT j.* FROM memory_jobs j JOIN memory_units u ON u.id=j.unit_id WHERE (j.status='pending' OR (j.status='failed' AND julianday('now')-julianday(j.updated_at)>1.0/1440)) AND j.attempts<3 AND u.status='active' AND u.character_id=? ORDER BY j.updated_at LIMIT 1",
      )
      .get(this.core.character());
    if (!job && policy.autoExcludeTests !== false) {
      const candidate = this.core.db
        .prepare(
          "SELECT * FROM memory_units WHERE character_id=? AND status='active' ORDER BY recorded_at DESC LIMIT 500",
        )
        .all(this.core.character())
        .find((u) => needsTestReview(this.core, u, profile));
      if (candidate) {
        this.running = true;
        this.controller = new AbortController();
        try {
          await this.ensureLocal();
          await reviewTestUnit(
            this.core,
            candidate,
            profile,
            AbortSignal.any([
              this.controller.signal,
              AbortSignal.timeout(180000),
            ]),
          );
        } finally {
          this.running = false;
          this.controller = null;
          this.notify();
        }
        return;
      }
    }
    if (!job) {
      if (!profile.embedding) return;
      this.running = true;
      this.controller = new AbortController();
      try {
        await this.ensureLocal();
        await this.core.longText.fillManual(
          this.core.character(),
          profile,
          AbortSignal.any([this.controller.signal, AbortSignal.timeout(90000)]),
        );
      } finally {
        this.running = false;
        this.controller = null;
        this.notify();
      }
      return;
    }
    const unit = this.core.unit(job.unit_id);
    if (!unit || unit.revision !== job.revision) {
      this.core.db
        .prepare("UPDATE memory_jobs SET status='cancelled' WHERE id=?")
        .run(job.id);
      return;
    }
    this.running = true;
    this.controller = new AbortController();
    this.core.db
      .prepare(
        "UPDATE memory_jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?",
      )
      .run(stamp(), job.id);
    this.notify();
    try {
      await this.ensureLocal();
      if (
        policy.autoExcludeTests !== false &&
        (await reviewTestUnit(this.core, unit, profile, this.controller.signal))
          .isolated
      )
        return;
      const defer = () => {
        this.core.db
          .prepare(
            "UPDATE memory_jobs SET status='pending',attempts=0,error=NULL,updated_at=? WHERE id=? AND status='running'",
          )
          .run(stamp(), job.id);
      };
      if (
        profile.embedding &&
        !(await this.core.longText.fillUnit(
          unit,
          profile,
          AbortSignal.any([this.controller.signal, AbortSignal.timeout(90000)]),
        ))
      ) {
        defer();
        return;
      }
      const revised = this.core.store.setting("memorySupervisor").enabled;
      const schema = structuredClone(extractionSchema);
      {
        const item = schema.properties.facts.items;
        item.kind = item.kind || {};
        item.properties.kind.enum = revised ? stableKinds : [...localKinds];
        if (revised) {
          item.required.push("why");
          item.properties.why = { type: "string", maxLength: 40 };
        }
      }
      const sourceMeta = parse(
          this.core.db
            .prepare("SELECT meta FROM messages WHERE id=?")
            .get(unit.source_id)?.meta || "{}",
          {},
        ),
        parts =
          sourceMeta.input_kind === "document-import"
            ? []
            : extractionParts(unit.user_text, profile.context || 4096),
        profileKey = signature(
          JSON.stringify({
            name: profile.name,
            baseUrl: profile.baseUrl,
            context: profile.context,
            prompt: revised ? 4 : 3,
          }),
        );
      const saved = this.core.db
          .prepare(
            "SELECT * FROM memory_extract_progress WHERE unit_id=? AND revision=? AND profile_key=?",
          )
          .all(unit.id, unit.revision, profileKey),
        byPart = new Map(saved.map((p) => [p.part, p]));
      const missing = parts.findIndex(
        (part, i) => byPart.get(i)?.text_hash !== signature(part.text),
      );
      if (missing >= 0) {
        let text = "";
        for await (const chunk of generate(
          {
            ...profile,
            jsonMode: true,
            jsonSchema: schema,
            keepAlive: "2m",
            maxTokens: Math.min(
              1400,
              Math.floor((profile.context || 4096) * 0.35),
            ),
          },
          [
            {
              role: "system",
              content: revised ? stablePrompt : extractionPrompt,
            },
            {
              role: "user",
              content: JSON.stringify({
                recorded_at: unit.recorded_at,
                untrusted_user_text: parts[missing].text,
              }),
            },
          ],
          {
            signal: AbortSignal.any([
              this.controller.signal,
              AbortSignal.timeout(180000),
            ]),
          },
        ))
          text += chunk;
        const result = JSON.parse(
          text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
        );
        this.controller.signal.throwIfAborted();
        if (this.core.unit(unit.id)?.revision !== unit.revision)
          throw Error("原始记录已变化，分块结果未提交");
        const checked = {
          facts: (Array.isArray(result.facts) ? result.facts : [])
            .slice(0, 8)
            .filter((f) => factQuality(f, parts[missing].text).ok),
        };
        this.core.db
          .prepare(
            "INSERT OR REPLACE INTO memory_extract_progress VALUES(?,?,?,?,?,?)",
          )
          .run(
            unit.id,
            unit.revision,
            profileKey,
            missing,
            signature(parts[missing].text),
            JSON.stringify(checked),
          );
        byPart.set(missing, { result: JSON.stringify(checked) });
        if (parts.some((_, i) => !byPart.has(i))) {
          defer();
          return;
        }
      }
      if (!byPart.has(-1)) {
        const all = parts.flatMap(
            (_, i) => JSON.parse(byPart.get(i).result).facts,
          ),
          unique = [
            ...new Map(
              all.map((f) => [
                JSON.stringify([
                  f.kind,
                  f.subject,
                  f.predicate,
                  f.value,
                  f.quote,
                ]),
                f,
              ]),
            ).values(),
          ];
        this.core.applyExtraction(
          unit.id,
          unit.revision,
          { facts: unique },
          profile.name,
          null,
          {
            maxFacts: parts.length * 8,
            finalize: () =>
              this.core.db
                .prepare(
                  "INSERT OR REPLACE INTO memory_extract_progress VALUES(?,?,?,?,?,?)",
                )
                .run(
                  unit.id,
                  unit.revision,
                  profileKey,
                  -1,
                  signature(unit.user_text),
                  "{}",
                ),
          },
        );
      }
      if (profile.embedding) {
        const embeddings = this.core.db
          .prepare(
            "SELECT embedding FROM memory_chunks WHERE unit_id=? ORDER BY part",
          )
          .all(unit.id)
          .filter((c) => c.embedding)
          .map((c) => JSON.parse(c.embedding));
        const average = meanEmbedding(embeddings);
        if (average)
          this.core.db
            .prepare("UPDATE memory_keys SET embedding=? WHERE unit_id=?")
            .run(JSON.stringify(average), unit.id);
      }
      this.core.db
        .prepare(
          "UPDATE memory_jobs SET status='done',error=NULL,model_id=?,updated_at=? WHERE id=? AND status='running'",
        )
        .run(profile.name, stamp(), job.id);
    } catch (e) {
      if (!this.controller.signal.aborted) this.onError?.();
      this.core.db
        .prepare(
          "UPDATE memory_jobs SET status=?,error=?,updated_at=?,attempts=max(0,attempts-?) WHERE id=? AND status='running'",
        )
        .run(
          this.controller.signal.aborted ? "pending" : "failed",
          this.controller.signal.aborted
            ? "聊天优先，稍后继续"
            : "background_extraction_failed",
          stamp(),
          this.controller.signal.aborted ? 1 : 0,
          job.id,
        );
    } finally {
      this.running = false;
      this.controller = null;
      this.notify();
    }
  }
}
