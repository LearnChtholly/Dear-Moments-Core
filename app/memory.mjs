import {needsTestReview,reviewTestUnit} from './test-memory-review.mjs';
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { generate, embed, isLocal } from "./providers.mjs";
import {LongTextIndex,migrateLongText} from './long-text-index.mjs';
import {extractionParts,queryText,meanEmbedding} from './text-chunks.mjs';
import {interpretMemoryQuery,evidenceTerms,hasEvidence} from './memory-query.mjs';
const stamp = () => new Date().toISOString();
const uid = () => randomUUID();
const signature = (s) => createHash("sha256").update(s).digest("hex");
const parse = (s, fallback = []) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
import { stableKinds } from "./memory-supervisor.mjs";
import { extractionPrompt, factQuality, shouldPromoteRepeated, localKinds } from "./memory-quality.mjs";
const kinds = new Set([
  ...stableKinds,
  "fact",
  "preference",
  "intention",
  "hypothesis",
  "event",
  "tool_result",
]);
const terms = (s) => [
  ...new Set(
    String(s)
      .toLowerCase()
      .match(/[a-z0-9_.-]+|[\u3400-\u9fff]/g) || [],
  ),
];
const stablePrompt = extractionPrompt + "\n补充：优先抽取口味、作息、习惯、忌讳、在乎的人、长期项目和明确承诺；why 在 40 字以内。";
const extractionSchema={type:'object',additionalProperties:false,required:['facts'],properties:{facts:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,required:['kind','subject','predicate','value','quote'],properties:{kind:{type:'string',enum:[...kinds]},subject:{type:'string',maxLength:24},predicate:{type:'string',maxLength:24},value:{type:'string',maxLength:60},quote:{type:'string',minLength:2,maxLength:80},confidence:{type:'number',minimum:0,maximum:1}}}}}};
export function migrateMemory(db, filename, oldVersion) {
  if ((oldVersion === 1||oldVersion===2) && existsSync(filename)) {
    const folder = path.join(path.dirname(filename), "backups");
    mkdirSync(folder, { recursive: true });
    db.prepare("VACUUM INTO ?").run(
      path.join(folder, (oldVersion===1?'before-0.2.0-':'before-longtext-') + Date.now() + ".sqlite"),
    );
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      !db
        .prepare("PRAGMA table_info(messages)")
        .all()
        .some((c) => c.name === "meta")
    )
      db.exec(
        "ALTER TABLE messages ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'",
      );
    if (
      !db
        .prepare("PRAGMA table_info(conversations)")
        .all()
        .some((c) => c.name === "character_id")
    ) {
      db.exec(
        "ALTER TABLE conversations ADD COLUMN character_id TEXT NOT NULL DEFAULT 'default'",
      );
      const row = db
        .prepare("SELECT value FROM meta WHERE key='character'")
        .get();
      const owner = row ? parse(row.value, {}).id : null;
      if (owner)
        db.prepare("UPDATE conversations SET character_id=?").run(owner);
    }
    if (
      !db
        .prepare("PRAGMA table_info(memories)")
        .all()
        .some((c) => c.name === "character_id")
    ) {
      db.exec(
        "ALTER TABLE memories ADD COLUMN character_id TEXT NOT NULL DEFAULT 'default'",
      );
      const row = db
        .prepare("SELECT value FROM meta WHERE key='character'")
        .get();
      const owner = row ? parse(row.value, {}).id : null;
      if (owner) db.prepare("UPDATE memories SET character_id=?").run(owner);
    }
    if(!db.prepare('PRAGMA table_info(diaries)').all().some(c=>c.name==='character_id')){db.exec("ALTER TABLE diaries RENAME TO diaries_v1;CREATE TABLE diaries(id TEXT PRIMARY KEY,day TEXT NOT NULL,content TEXT NOT NULL,sources TEXT NOT NULL,created_at TEXT NOT NULL,character_id TEXT NOT NULL DEFAULT 'default',UNIQUE(day,character_id));");const row=db.prepare("SELECT value FROM meta WHERE key='character'").get(),owner=row?parse(row.value,{}).id||'default':'default';db.prepare('INSERT INTO diaries SELECT id,day,content,sources,created_at,? FROM diaries_v1').run(owner);db.exec('DROP TABLE diaries_v1');}
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_units(id TEXT PRIMARY KEY,source_type TEXT NOT NULL,source_id TEXT NOT NULL,character_id TEXT NOT NULL,scope TEXT NOT NULL,conversation_id TEXT,source_refs TEXT NOT NULL,assets TEXT NOT NULL,original TEXT NOT NULL,user_text TEXT NOT NULL,recorded_at TEXT NOT NULL,event_time TEXT,event_time_basis TEXT NOT NULL DEFAULT 'unknown',revision INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active',UNIQUE(source_type,source_id));
      CREATE TABLE IF NOT EXISTS memory_keys(unit_id TEXT PRIMARY KEY REFERENCES memory_units(id) ON DELETE CASCADE,search_text TEXT NOT NULL,embedding TEXT,model_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'raw',updated_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS unit_fts USING fts5(id UNINDEXED,tokens);
      CREATE TABLE IF NOT EXISTS memory_facts(id TEXT PRIMARY KEY,unit_id TEXT NOT NULL REFERENCES memory_units(id) ON DELETE CASCADE,character_id TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,subject TEXT NOT NULL,predicate TEXT NOT NULL,value TEXT NOT NULL,quote TEXT NOT NULL,event_time TEXT,state TEXT NOT NULL,confidence REAL NOT NULL DEFAULT 0,previous_id TEXT,version INTEGER NOT NULL DEFAULT 1,valid_from TEXT NOT NULL,valid_to TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_jobs(id TEXT PRIMARY KEY,unit_id TEXT NOT NULL REFERENCES memory_units(id) ON DELETE CASCADE,revision INTEGER NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,model_id TEXT,updated_at TEXT NOT NULL,UNIQUE(unit_id,revision));
      CREATE TABLE IF NOT EXISTS memory_tombstones(source_type TEXT NOT NULL,source_id TEXT NOT NULL,character_id TEXT NOT NULL,scope TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_type,source_id,character_id,scope));
      CREATE TABLE IF NOT EXISTS agent_experiences(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,character_id TEXT NOT NULL,scope TEXT NOT NULL,pool TEXT NOT NULL,content TEXT NOT NULL,source_refs TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,pool));
      CREATE INDEX IF NOT EXISTS unit_scope ON memory_units(character_id,scope,status,recorded_at);
      CREATE INDEX IF NOT EXISTS fact_scope ON memory_facts(character_id,scope,state,subject,predicate);
      CREATE INDEX IF NOT EXISTS memory_job_state ON memory_jobs(status,updated_at);
      CREATE TABLE IF NOT EXISTS style_observations(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,source_id TEXT NOT NULL,dimension TEXT NOT NULL,value TEXT NOT NULL,quote TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(character_id,source_id,dimension,value));
      CREATE TABLE IF NOT EXISTS bridge_receipts(connector TEXT NOT NULL,event_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(connector,event_id));
      UPDATE memory_jobs SET status='pending',error='上次退出中断，等待空闲后继续' WHERE status='running';
      PRAGMA user_version=${Math.max(3,oldVersion)};`);
    migrateLongText(db);
    if(oldVersion<3)db.exec("UPDATE memory_jobs SET status='pending',attempts=0,error=NULL WHERE status='done' AND unit_id IN(SELECT id FROM memory_units WHERE length(user_text)>1600 AND status='active')");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export class MemoryCore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    store.memoryCore = this;
    this.longText=new LongTextIndex(store);
  }
  character() {
    return this.store.setting("character").id || "default";
  }
  index(unitId, text) {
    this.db.prepare("DELETE FROM unit_fts WHERE id=?").run(unitId);
    this.db
      .prepare("INSERT INTO unit_fts VALUES(?,?)")
      .run(unitId, terms(text).join(" "));
  }
  ingestTurn(userId) {
    const user = this.db
      .prepare(
        "SELECT m.*,c.scope,c.character_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.role='user' AND m.status='complete'",
      )
      .get(userId);
    if (!user) return null;
    if (user.character_id !== this.character()) return null;
    const character = this.character();
    if (
      this.db
        .prepare(
          "SELECT 1 FROM memory_tombstones WHERE source_type=? AND source_id=? AND character_id=? AND scope=?",
        )
        .get("message", userId, character, user.scope)
    )
      return null;
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",
      )
      .all(user.conversation_id);
    const start = rows.findIndex((m) => m.id === user.id);
    const tail = rows.slice(start + 1),
      nextUser = tail.findIndex((m) => m.role === "user");
    const legacy=new Set(tail.slice(0,nextUser<0?undefined:nextUser).map(m=>m.id));
    const replies = rows.filter((message) => {
      if (message.role !== "assistant" || message.status !== "complete") return false;
      const meta = parse(message.meta || "{}", {});
      if (meta.standalone) return false;
      return meta.replyToUserId ? meta.replyToUserId === userId : legacy.has(message.id);
    });
    const pair = [user, ...replies];
    const original = JSON.stringify(
        pair.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          created_at: m.created_at,
          expression: parse(m.meta || "{}", {}).expression,
        })),
      ),
      refs = JSON.stringify(pair.map((m) => m.id)),
      assets = JSON.stringify([
        ...new Set(
          pair.flatMap((m) =>
            [
              ...parse(m.assets),
              parse(m.meta || "{}", {}).expression?.stickerAsset,
            ].filter(Boolean),
          ),
        ),
      ]);
    const existing = this.db
      .prepare("SELECT * FROM memory_units WHERE source_type=? AND source_id=?")
      .get("message", userId);
    if (existing?.status !== "active" && existing) return existing;
    if (existing?.original === original) return existing;
    const unit = {
      id: existing?.id || uid(),
      revision: (existing?.revision || 0) + 1,
    };
    this.store.transaction(() => {
      if (existing)
        this.db
          .prepare(
            "UPDATE memory_units SET original=?,source_refs=?,assets=?,revision=?,user_text=? WHERE id=?",
          )
          .run(original, refs, assets, unit.revision, user.content, unit.id);
      else
        this.db
          .prepare(
            "INSERT INTO memory_units(id,source_type,source_id,character_id,scope,conversation_id,source_refs,assets,original,user_text,recorded_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            unit.id,
            "message",
            userId,
            character,
            user.scope,
            user.conversation_id,
            refs,
            assets,
            original,
            user.content,
            user.created_at,
            unit.revision,
          );
      this.db
        .prepare(
          "INSERT INTO memory_keys(unit_id,search_text,state,updated_at) VALUES(?,?,'raw',?) ON CONFLICT(unit_id) DO UPDATE SET search_text=excluded.search_text,embedding=NULL,state='raw',updated_at=excluded.updated_at",
        )
        .run(unit.id, pair.map((m) => m.content).join("\n"), stamp());
      this.index(unit.id, pair.map((m) => m.content).join("\n"));
      this.db
        .prepare(
          "INSERT OR IGNORE INTO memory_jobs(id,unit_id,revision,status,updated_at) VALUES(?,?,?,'pending',?)",
        )
        .run(uid(), unit.id, unit.revision, stamp());
    });
    return this.unit(unit.id);
  }
  backfill(conversationId = null) {
    const rows = conversationId
      ? this.db
          .prepare(
            "SELECT id FROM messages WHERE role='user' AND status='complete' AND conversation_id=?",
          )
          .all(conversationId)
      : this.db
          .prepare(
            "SELECT id FROM messages WHERE role='user' AND status='complete'",
          )
          .all();
    for (const row of rows) this.ingestTurn(row.id);
    return { checked: rows.length };
  }
  unit(id) {
    id = String(id).replace(/^unit:/, "");
    const u = this.db
      .prepare("SELECT * FROM memory_units WHERE id=? AND character_id=?")
      .get(id, this.character());
    return u
      ? {
          ...u,
          source_refs: parse(u.source_refs),
          assets: parse(u.assets),
          messages: parse(u.original),
        }
      : null;
  }
  suppressedMessage(mid) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM memory_units u,json_each(u.source_refs) r WHERE u.character_id=? AND u.status!='active' AND r.value=?",
      )
      .get(this.character(), mid);
  }
  search(
    
    query = "",
    { scope = "private", limit = 12, vector = null, from = "", to = "", clock = new Date() } = {},
  ) {
    query=queryText(query);
    const parsed = interpretMemoryQuery(query, clock);
    from = [from, parsed.from].filter(Boolean).sort().at(-1) || "";
    to = [to, parsed.to].filter(Boolean).sort()[0] || "";
    if (from && to && from > to) return [];
    const topical = parsed.text;
    const lexical = evidenceTerms(topical);
    const dated = Boolean(from || to);
    const browsing = !query.trim() || (dated && !lexical.length && !terms(topical).length);
    const chunks=this.longText.search(topical,{character:this.character(),scope,limit,vector,from,to,lexical}).filter(m=>!m.source_id||!this.suppressedMessage(m.source_id));
    const rows = this.db
      .prepare(
        "SELECT u.*,k.embedding,k.state AS index_state FROM memory_units u JOIN memory_keys k ON k.unit_id=u.id WHERE u.character_id=? AND u.scope=? AND u.status='active' ORDER BY u.recorded_at DESC",
      )
      .all(this.character(), scope);
    const allowed = new Map(
        rows
          .filter(
            (u) =>
              (!from || (u.event_time || u.recorded_at) >= from) && (!to || (u.event_time || u.recorded_at) <= to),
          )
          .map((u) => [u.id, u]),
      ),
      scores = new Map();
    const add = (list, weight = 1) =>
      list.forEach((u, i) =>
        scores.set(u.id, (scores.get(u.id) || 0) + weight / (61 + i)),
      );
    const tokens = terms(topical);
    if (tokens.length)
      add(
        this.db
          .prepare(
            "SELECT unit_fts.id,k.search_text,bm25(unit_fts) AS rank FROM unit_fts JOIN memory_units u ON u.id=unit_fts.id JOIN memory_keys k ON k.unit_id=u.id WHERE unit_fts MATCH ? AND u.character_id=? AND u.scope=? AND u.status='active' ORDER BY rank",
          )
          .all(
            tokens
              .slice(0, 60)
              .map((t) => '"' + t.replaceAll('"', "") + '"')
              .join(" OR "),this.character(),scope,
          )
          .filter((u) => allowed.has(u.id) && hasEvidence(u.search_text, lexical)).slice(0, 100),
      );
    if (vector) {
      const cosine = (embedding) => {
        const e = parse(embedding, null);
        if (
          !e ||
          e.model !== vector.model ||
          e.vector.length !== vector.vector.length
        )
          return -1;
        let d = 0,
          a = 0,
          b = 0;
        e.vector.forEach((v, i) => {
          d += v * vector.vector[i];
          a += v * v;
          b += vector.vector[i] * vector.vector[i];
        });
        return d / Math.sqrt(a * b || 1);
      };
      add(
        [...allowed.values()]
          .filter((u) => u.embedding)
          .map((u) => ({ ...u, similarity: cosine(u.embedding) }))
          .filter((u) => u.similarity > 0.3)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 40),
      );
    }
    const factHits = this.db.prepare(`
      SELECT f.unit_id AS id,f.kind,f.subject,f.predicate,f.value,f.quote,f.state
      FROM memory_facts f JOIN memory_units u ON u.id=f.unit_id
      WHERE f.character_id=? AND f.scope=? AND u.status='active'
        AND f.state IN ('confirmed','superseded')
      ORDER BY (f.state='confirmed') DESC, f.created_at DESC, f.version DESC
    `).all(this.character(), scope).filter(f => allowed.has(f.id)
      && (dated || f.state === "confirmed")
      && hasEvidence([f.subject, f.predicate, f.value, f.quote].join(" "), lexical));
    const factOwners = [...new Map(factHits.map(f => [f.id, f])).values()];
    add(factOwners, 1.3);
    if (browsing)
      add([...allowed.values()].slice(0, limit));
    const raw = [...scores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => {
        const u = allowed.get(id);
        return {
          id: "unit:" + id,
          unit_id: id,
          content: parse(u.original)
            .map(
              (m) => (m.role === "user" ? "用户" : "伙伴") + "：" + m.content,
            )
            .join("\n"),
          source_id: u.source_id,
          source_refs: parse(u.source_refs),
          recorded_at: u.recorded_at,
          event_time: u.event_time,
          scope: u.scope,
          kind: "raw_evidence",
          status: u.index_state,
          facts: this.db
            .prepare(
              "SELECT kind,subject,predicate,value,state,version FROM memory_facts WHERE unit_id=? AND state IN ('confirmed','superseded','conflict')",
            )
            .all(id),
          score,
        };
      });
    const manual = this.store
      .search(topical, { scope, limit, vector, from, to, lexical, evidenceOnly: !browsing })
      .filter((m) => !m.source_id || !this.suppressedMessage(m.source_id));
    const owners=new Set(chunks.map(m=>m.unit_id?'unit:'+m.unit_id:m.id));
    for(const m of chunks)if(m.unit_id)m.facts=this.db.prepare("SELECT kind,subject,predicate,value,state,version FROM memory_facts WHERE unit_id=? AND state IN ('confirmed','superseded','conflict')").all(m.unit_id);
    const factEvidence = factOwners.flatMap(f => {
      const unit = allowed.get(f.id);
      const start = unit.user_text.indexOf(f.quote);
      if (start < 0 || !f.quote) return [];
      return [{
        id: "unit:" + f.id, unit_id: f.id, source_id: unit.source_id,
        source_message_id: unit.source_id, source_range: { start, end: start + f.quote.length },
        content: "用户：" + f.quote, recorded_at: unit.recorded_at, event_time: unit.event_time,
        scope, kind: "raw_evidence", status: "fact_match",
        facts: [{ kind: f.kind, subject: f.subject, predicate: f.predicate, value: f.value, state: f.state }],
      }];
    });
    const selectedFacts = new Set(factEvidence.map(m => m.id));
    return [...factEvidence,...chunks.filter(m=>!selectedFacts.has(m.id)),
      ...raw.filter(m=>!owners.has(m.id)&&!selectedFacts.has(m.id)),
      ...manual.filter(m=>!owners.has(m.id)).map(m=>({...m,kind:'confirmed_memory'}))].slice(0,limit);
  }
  async recall(query,options={}){const started=Date.now();let vector=null;try{vector=await embed(this.store.setting("memoryModel"),queryText(query),{query:true,signal:AbortSignal.timeout(options.timeoutMs||6000)});}catch{}if(vector)this.db.prepare("UPDATE memory_jobs SET status='pending',attempts=0 WHERE status='done' AND unit_id IN(SELECT unit_id FROM memory_chunks WHERE embedding IS NOT NULL AND json_extract(embedding,'$.model')!=?)").run(vector.model);const result=this.search(query,{...options,vector});options.observe?.({method:vector?'hybrid':'text',embeddingConfigured:!!this.store.setting('memoryModel').embedding,embeddingUsed:!!vector,dimensions:vector?.vector.length||0,count:result.length,elapsedMs:Date.now()-started});return result;}
  applyExtraction(unitId, revision, result, modelId, embedding = null,options={}) {
    const unit = this.unit(unitId);
    if (!unit || unit.status !== "active" || unit.revision !== revision)
      throw Error("原始记录已更改，丢弃过期提取结果");
    const rawCandidates = (Array.isArray(result.facts) ? result.facts : [])
      .slice(0, options.maxFacts||12)
      .filter(
        (f) =>
          kinds.has(f.kind) &&
          typeof f.quote === "string" &&
          f.quote.length > 1 &&
          unit.user_text.includes(f.quote) &&
          typeof f.value === "string" &&
          f.value.trim(),
      );
    const candidates = rawCandidates.filter(f => factQuality(f, unit.user_text).ok);
    const facts = candidates.filter(f => f.kind !== "tool_result");
    const enhanced =
      unit.messages.map((m) => m.content).join("\n") +
      "\n" +
      facts
        .map((f) => [f.subject, f.predicate, f.value, f.quote].join(" "))
        .join("\n");
    return this.store.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM memory_facts WHERE unit_id=? AND state IN ('candidate','conflict') AND supervisor_log_id IS NULL",
        )
        .run(unitId);
      for (const f of rawCandidates.filter(f => f.kind === "tool_result")) {
        this.db.prepare("INSERT OR IGNORE INTO memory_tool_diagnostics VALUES(?,?,?,?,?)")
          .run(signature(unitId + "\0" + f.quote), unitId, f.quote, String(f.why || "").slice(0,40), stamp());
      }
      for (const fact of facts) {
        const subject = String(fact.subject || "用户").slice(0, 100),
          predicate = String(fact.predicate || fact.kind).slice(0, 100),
          value = fact.value.trim().slice(0, 1500);
        const same = this.db
          .prepare(
            "SELECT * FROM memory_facts WHERE character_id=? AND scope=? AND subject=? AND predicate=? AND state='confirmed' ORDER BY created_at DESC LIMIT 1",
          )
          .get(unit.character_id, unit.scope, subject, predicate);
        if (same?.value === value) continue;
        const event = resolveEventTime(fact.quote, new Date(unit.recorded_at));
        const confidence = Math.min(1, Math.max(0, Number(fact.confidence) || 0.5));
        const factId = uid();
        this.db
          .prepare(
            "INSERT INTO memory_facts(id,unit_id,character_id,scope,kind,subject,predicate,value,quote,event_time,state,confidence,previous_id,version,valid_from,valid_to,created_at,why) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            factId,
            unitId,
            unit.character_id,
            unit.scope,
            fact.kind,
            subject,
            predicate,
            value,
            fact.quote,
            event.time,
            same ? "conflict" : "candidate",
            confidence,
            same?.id || null,
            (same?.version || 0) + 1,
            stamp(),
            null,
            stamp(),
            typeof fact.why === "string" ? [...fact.why].slice(0,40).join("") : null,
          );
        if (!same && shouldPromoteRepeated({ ...fact, kind: fact.kind }, 2)) {
          const repeated = this.db.prepare(
            "SELECT count(DISTINCT unit_id) AS n FROM memory_facts WHERE character_id=? AND scope=? AND kind=? AND subject=? AND predicate=? AND value=? AND state='candidate'",
          ).get(unit.character_id, unit.scope, fact.kind, subject, predicate, value).n;
          if (repeated >= 2) {
            this.db.prepare(
              "UPDATE memory_facts SET state='confirmed',confidence=max(confidence,0.75) WHERE character_id=? AND scope=? AND kind=? AND subject=? AND predicate=? AND value=? AND state='candidate'",
            ).run(unit.character_id, unit.scope, fact.kind, subject, predicate, value);
          }
        }
      }
      const event = resolveEventTime(
        unit.user_text,
        new Date(unit.recorded_at),
      );
      this.db
        .prepare(
          "UPDATE memory_units SET event_time=?,event_time_basis=? WHERE id=?",
        )
        .run(event.time, event.basis, unitId);
      this.db
        .prepare(
          "UPDATE memory_keys SET search_text=?,embedding=?,model_id=?,state='ready',updated_at=? WHERE unit_id=?",
        )
        .run(
          enhanced,
          embedding ? JSON.stringify(embedding) : null,
          modelId,
          stamp(),
          unitId,
        );
      this.index(unitId, enhanced);
      options.finalize?.();
      return candidates.length;
    });
  }
  async reindex(profile){return this.longText.reindex(this.character(),profile);}
  readSource(id,{chunkId,offset,limit=2000}={}){
    const u=this.unit(id);if(!u||u.scope!=='private')return null;
    const {messages,user_text,original,...meta}=u;
    if(chunkId){const c=this.db.prepare('SELECT * FROM memory_chunks WHERE id=? AND unit_id=?').get(chunkId,u.id);if(!c||String(u.revision)!==c.source_version)return null;const text=c.asset_id?this.db.prepare('SELECT text FROM assets WHERE id=?').get(c.asset_id)?.text:messages.find(m=>m.id===c.message_id)?.content;const start=Math.max(0,Number.isFinite(offset)?offset:c.start_offset),length=Math.max(256,Math.min(Number(limit)||2000,8000)),end=Math.min(text.length,start+length);return {...meta,messages:[{id:c.message_id,role:c.role,content:text.slice(start,end)}],chunk_id:c.id,asset_id:c.asset_id,page:{offset:start,next_offset:end<text.length?end:null,total_characters:text.length}};}
    const text=messages.map(m=>(m.role==='user'?'用户：':'伙伴：')+m.content).join('\n');if(text.length<=4000&&!offset)return u;const start=Math.max(0,Number(offset)||0),end=Math.min(text.length,start+Math.max(256,Math.min(Number(limit)||2000,8000)));return {...meta,messages:[{id:u.source_id,role:'source',content:text.slice(start,end)}],page:{offset:start,next_offset:end<text.length?end:null,total_characters:text.length}};
  }
  refreshKey(unitId) {
    const u = this.unit(unitId);
    if (!u || u.status !== "active") return;
    const facts = this.db
      .prepare(
        "SELECT subject,predicate,value,state FROM memory_facts WHERE unit_id=? AND state NOT IN ('rejected','deleted')",
      )
      .all(unitId);
    const text =
      u.messages.map((m) => m.content).join("\n") +
      "\n" +
      facts
        .map((f) => [f.state, f.subject, f.predicate, f.value].join(" "))
        .join("\n");
    this.db
      .prepare(
        "UPDATE memory_keys SET search_text=?,embedding=NULL,updated_at=? WHERE unit_id=?",
      )
      .run(text, stamp(), unitId);
    this.index(unitId, text);
  }
  review(factId, accept, correction = null) {
    return this.store.transaction(() => {
      const f = this.db
        .prepare("SELECT * FROM memory_facts WHERE id=? AND character_id=?")
        .get(factId, this.character());
      if (!f) throw Error("事实不存在");
      if (f.state === 'deleted') throw Error('事实已忘记');
      if (!accept) {
        this.db
          .prepare("UPDATE memory_facts SET state='rejected' WHERE id=?")
          .run(factId);
        this.refreshKey(f.unit_id);
        return true;
      }
      if (f.previous_id)
        this.db
          .prepare(
            "UPDATE memory_facts SET state='superseded',valid_to=? WHERE id=?",
          )
          .run(stamp(), f.previous_id);
      const corrected = correction?.trim();
      if (corrected && corrected !== f.value) {
        const time=stamp(), nextId=uid();
        const version=this.db.prepare('SELECT max(version) AS n FROM memory_facts WHERE character_id=? AND scope=? AND subject=? AND predicate=?').get(f.character_id,f.scope,f.subject,f.predicate).n+1;
        this.db.prepare("UPDATE memory_facts SET state='superseded',valid_to=? WHERE id=?").run(time,f.id);
        this.db.prepare('INSERT INTO memory_facts(id,unit_id,character_id,scope,kind,subject,predicate,value,quote,event_time,state,confidence,previous_id,version,valid_from,valid_to,created_at,why) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(nextId,f.unit_id,f.character_id,f.scope,f.kind,f.subject,f.predicate,corrected.slice(0,1500),f.quote,f.event_time,'confirmed',1,f.id,version,time,null,time,f.why);
        this.store.event('memory.fact.corrected',{fact_id:nextId,previous_id:f.id,basis:'用户在事实审核中纠正'});
      } else {
        this.db.prepare("UPDATE memory_facts SET state='confirmed' WHERE id=?").run(factId);
      }
      this.refreshKey(f.unit_id);
      this.store.event("memory.fact.reviewed", {
        fact_id: factId,
        accepted: true,
      });
      return true;
    });
  }
  forget(unitId) {
    const u = this.unit(unitId);
    if (!u) throw Error("记忆单元不存在");
    this.store.transaction(() => {
      for (const source of u.source_refs) {
        this.db.prepare('DELETE FROM style_observations WHERE source_id=? AND character_id=?').run(source,this.character());
        for (const m of this.db
          .prepare(
            "SELECT id FROM memories WHERE source_id=? AND character_id=?",
          )
          .all(source, this.character())) {
          this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(m.id);
          this.db.prepare("DELETE FROM memories WHERE id=?").run(m.id);
        }
      }
      this.db
        .prepare("INSERT OR IGNORE INTO memory_tombstones VALUES(?,?,?,?,?)")
        .run(u.source_type, u.source_id, u.character_id, u.scope, stamp());
      this.db
        .prepare("UPDATE memory_units SET status='suppressed' WHERE id=?")
        .run(unitId);
      this.db.prepare("DELETE FROM unit_fts WHERE id=?").run(unitId);
      this.db.prepare("DELETE FROM memory_keys WHERE unit_id=?").run(unitId);
      this.db
        .prepare(
          "UPDATE memory_facts SET state='deleted',value='',quote='' WHERE unit_id=?",
        )
        .run(unitId);
      this.db
        .prepare("UPDATE memory_jobs SET status='cancelled' WHERE unit_id=?")
        .run(unitId);
      this.db.prepare('DELETE FROM diaries WHERE character_id=?').run(this.character());
    });
  }
  forgetSource(messageId) {
    const u = this.db
      .prepare(
        "SELECT id FROM memory_units u,json_each(u.source_refs) r WHERE u.character_id=? AND r.value=?",
      )
      .get(this.character(), messageId);
    if (u) this.forget(u.id);
  }
  retry(unitId) {
    const u = this.unit(unitId);
    if (!u || u.status !== "active") throw Error("记录已删除或不存在");
    this.db
      .prepare(
        "UPDATE memory_jobs SET status='pending',attempts=0,error=NULL WHERE unit_id=? AND revision=?",
      )
      .run(unitId, u.revision);
    return true;
  }
  snapshot() {
    return {
      units: this.db
        .prepare(
          "SELECT u.*,k.state AS index_state FROM memory_units u LEFT JOIN memory_keys k ON k.unit_id=u.id WHERE u.character_id=? ORDER BY recorded_at DESC LIMIT 200",
        )
        .all(this.character())
        .map((u) => ({
          ...u,
          source_refs: parse(u.source_refs),
          original: undefined,
          user_text:u.user_text.slice(0,1200),user_text_length:u.user_text.length,
        })),
      facts: this.db
        .prepare(
          "SELECT f.* FROM memory_facts f JOIN memory_units u ON u.id=f.unit_id WHERE f.character_id=? AND f.state!='deleted' AND u.status='active' ORDER BY f.created_at DESC LIMIT 300",
        )
        .all(this.character()),
      jobs: this.db
        .prepare(
          "SELECT j.*,u.user_text,m.meta AS input_meta FROM memory_jobs j JOIN memory_units u ON u.id=j.unit_id LEFT JOIN messages m ON m.id=u.source_id WHERE u.character_id=? ORDER BY j.updated_at DESC LIMIT 150",
        )
        .all(this.character()).map(({user_text,input_meta,...j})=>{const p=this.store.setting('memoryModel'),key=signature(JSON.stringify({name:p.name,baseUrl:p.baseUrl,context:p.context,prompt:this.store.setting("memorySupervisor").enabled?4:3}));return {...j,total_parts:parse(input_meta||'{}',{}).input_kind==='document-import'?0:extractionParts(user_text,p.context||4096).length,completed_parts:this.db.prepare('SELECT count(*) n FROM memory_extract_progress WHERE unit_id=? AND revision=? AND profile_key=? AND part>=0').get(j.unit_id,j.revision,key).n,indexed_parts:this.db.prepare('SELECT count(*) n FROM memory_chunks WHERE unit_id=? AND embedding IS NOT NULL').get(j.unit_id).n,total_index_parts:this.db.prepare('SELECT count(*) n FROM memory_chunks WHERE unit_id=?').get(j.unit_id).n};}),
      experiences: this.db
        .prepare(
          "SELECT * FROM agent_experiences WHERE character_id=? AND pool IN ('strategy','feedback','preference') ORDER BY created_at DESC LIMIT 100",
        )
        .all(this.character()),
    };
  }
  recordExperience(taskId, kind, input, result, error = null) {
    const source = JSON.stringify([taskId]),
      time = stamp(),
      base = { kind, status: error ? "failed" : "completed" };
    const telemetryKinds = new Set([
      "dsh.tool", "tool_result", "mcp.call", "mcp.tool", "qq.send",
      "dear_moments_expression", "edit", "read", "write", "grep", "glob",
      "present", "bili_comments", "bili_search", "bili_subtitle", "bili_frames",
    ]);
    const telemetry = taskId.startsWith("dsh:") || taskId.startsWith("qq:") ||
      taskId.startsWith("mcp:") || taskId.startsWith("plugin:") || telemetryKinds.has(kind) ||
      String(kind).startsWith("mcp.") || String(kind).startsWith("qq.") ||
      String(input?.source || "").toLowerCase() === "dsh";
    const rows = telemetry ? [["telemetry", { ...base, arguments: input, result, error }]] : [
      ["state", { kind, arguments: input }],
      ["event", { ...base, result, error }],
      ...(!error
        ? [
            [
              "strategy",
              {
                kind,
                basis: "一次实际成功执行；仅供参考，不自动重放",
                outcome:
                  typeof result === "string"
                    ? result.slice(0, 1000)
                    : JSON.stringify(result).slice(0, 1000),
              },
            ],
          ]
        : []),
    ];
    for (const [pool, data] of rows)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO agent_experiences VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          uid(),
          taskId,
          this.character(),
          "private",
          pool,
          JSON.stringify(data),
          source,
          time,
        );
  }
  saveTaskNote(input) {
    const note = { kind: "verified_task_note" };
    for (const [field, max] of Object.entries({ goal: 120, changes: 500, steps: 1200, verification: 500, evidence: 400 })) {
      const value = typeof input[field] === "string" ? input[field].trim() : "";
      if (!value || value.length > max) throw Error("请填写完整的任务目标、变化、步骤、验证和证据，并遵守长度限制");
      note[field] = value;
    }
    const id = uid();
    this.db.prepare("INSERT INTO agent_experiences VALUES(?,?,?,?,?,?,?,?)")
      .run(id,id,this.character(),"private","strategy",JSON.stringify(note),JSON.stringify([note.evidence]),stamp());
    return id;
  }
  taskEvidence(query, limit = 2) {
    if (!/上次|之前|曾经|以前|经验|步骤|怎么修|如何修/.test(query)) return [];
    const tokens = evidenceTerms(query.replace(/上次|之前|曾经|以前|经验|步骤|怎么修|如何修|怎么做/g," "));
    const {from,to} = interpretMemoryQuery(query);
    return this.db.prepare(`
      SELECT * FROM agent_experiences
      WHERE character_id=? AND scope='private' AND pool='strategy'
        AND json_extract(content,'$.kind')='verified_task_note'
      ORDER BY created_at DESC LIMIT 100
    `).all(this.character()).flatMap(row => {
      if ((from && row.created_at < from) || (to && row.created_at > to)) return [];
      const n = parse(row.content,{});
      const score = tokens.filter(t => hasEvidence([n.goal,n.changes,n.steps,n.verification].join(" "),[t])).length;
      return score ? [{
        id: "experience:" + row.id,
        kind: "task_experience", status: "user_recorded", recorded_at: row.created_at,
        content: `目标：${n.goal}\n验证：${n.verification}\n证据：${n.evidence}\n状态变化：${n.changes}\n步骤：${n.steps}`,
        source_id: row.id, score,
      }] : [];
    }).sort((a,b) => b.score-a.score).slice(0,limit);
  }
  removeConversation(cid) {
    this.db.prepare('DELETE FROM style_observations WHERE source_id IN (SELECT id FROM messages WHERE conversation_id=?)').run(cid);
    const units = this.db
      .prepare("SELECT id FROM memory_units WHERE conversation_id=?")
      .all(cid);
    for (const u of units) {
      this.db.prepare("DELETE FROM unit_fts WHERE id=?").run(u.id);
      this.db.prepare("DELETE FROM memory_units WHERE id=?").run(u.id);
    }
  }
}
export function resolveEventTime(text, date) {
  const base = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
    }).format(date),
    mid = new Date(base + "T12:00:00+08:00");
  const explicit = String(text).match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (explicit && Number.isFinite(Date.parse(explicit)))
    return { time: explicit + "T04:00:00.000Z", basis: "explicit-date" };
  const n = /前天/.test(text)
    ? -2
    : /昨天/.test(text)
      ? -1
      : /明天/.test(text)
        ? 1
        : /今天/.test(text)
          ? 0
          : null;
  if (n !== null)
    return {
      time: new Date(mid.getTime() + n * 86400000).toISOString(),
      basis: "relative-to-recorded-at",
    };
  return { time: null, basis: "unknown" };
}
export class MemoryWorker {
  constructor(core, { busy = () => false, notify = () => {},ensureLocal=async()=>{} } = {}) {
    this.core = core;
    this.ensureLocal=ensureLocal;
    this.busy = busy;
    this.notify = notify;
    this.running = false;
    this.controller = null;
    this.timer = null;
  }
  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 3000);
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
    if(!job&&policy.autoExcludeTests!==false){
      const candidate=this.core.db.prepare("SELECT * FROM memory_units WHERE character_id=? AND status='active' ORDER BY recorded_at DESC LIMIT 500").all(this.core.character()).find(u=>needsTestReview(this.core,u,profile));
      if(candidate){this.running=true;this.controller=new AbortController();try{await this.ensureLocal();await reviewTestUnit(this.core,candidate,profile,AbortSignal.any([this.controller.signal,AbortSignal.timeout(180000)]));}finally{this.running=false;this.controller=null;this.notify();}return;}
    }
    if (!job) {if(!profile.embedding)return;this.running=true;this.controller=new AbortController();try{await this.ensureLocal();await this.core.longText.fillManual(this.core.character(),profile,AbortSignal.any([this.controller.signal,AbortSignal.timeout(90000)]));}finally{this.running=false;this.controller=null;this.notify();}return;}
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
      if(policy.autoExcludeTests!==false&&(await reviewTestUnit(this.core,unit,profile,this.controller.signal)).isolated)return;
      const defer=()=>{this.core.db.prepare("UPDATE memory_jobs SET status='pending',attempts=0,error=NULL,updated_at=? WHERE id=? AND status='running'").run(stamp(),job.id);};
      if(profile.embedding&&!(await this.core.longText.fillUnit(unit,profile,AbortSignal.any([this.controller.signal,AbortSignal.timeout(90000)])))){defer();return;}
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
      const sourceMeta=parse(this.core.db.prepare('SELECT meta FROM messages WHERE id=?').get(unit.source_id)?.meta||'{}',{}),parts=sourceMeta.input_kind==='document-import'?[]:extractionParts(unit.user_text,profile.context||4096),profileKey=signature(JSON.stringify({name:profile.name,baseUrl:profile.baseUrl,context:profile.context,prompt:revised?4:3}));
      const saved=this.core.db.prepare('SELECT * FROM memory_extract_progress WHERE unit_id=? AND revision=? AND profile_key=?').all(unit.id,unit.revision,profileKey),byPart=new Map(saved.map(p=>[p.part,p]));
      const missing=parts.findIndex((part,i)=>byPart.get(i)?.text_hash!==signature(part.text));
      if(missing>=0){
      let text = "";
      for await (const chunk of generate(
        { ...profile, jsonMode: true,jsonSchema:schema, keepAlive: "2m", maxTokens: Math.min(1400,Math.floor((profile.context||4096)*.35)) },
        [
          {
            role: "system",
            content:
              revised ? stablePrompt : extractionPrompt,
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
      this.controller.signal.throwIfAborted();if(this.core.unit(unit.id)?.revision!==unit.revision)throw Error('原始记录已变化，分块结果未提交');
      const checked={facts:(Array.isArray(result.facts)?result.facts:[]).slice(0,8).filter(f=>factQuality(f,parts[missing].text).ok)};
      this.core.db.prepare('INSERT OR REPLACE INTO memory_extract_progress VALUES(?,?,?,?,?,?)').run(unit.id,unit.revision,profileKey,missing,signature(parts[missing].text),JSON.stringify(checked));
      byPart.set(missing,{result:JSON.stringify(checked)});
      if(parts.some((_,i)=>!byPart.has(i))){defer();return;}
      }
      if(!byPart.has(-1)){const all=parts.flatMap((_,i)=>JSON.parse(byPart.get(i).result).facts),unique=[...new Map(all.map(f=>[JSON.stringify([f.kind,f.subject,f.predicate,f.value,f.quote]),f])).values()];this.core.applyExtraction(unit.id,unit.revision,{facts:unique},profile.name,null,{maxFacts:parts.length*8,finalize:()=>this.core.db.prepare('INSERT OR REPLACE INTO memory_extract_progress VALUES(?,?,?,?,?,?)').run(unit.id,unit.revision,profileKey,-1,signature(unit.user_text),'{}')});}
      if(profile.embedding){const embeddings=this.core.db.prepare('SELECT embedding FROM memory_chunks WHERE unit_id=? ORDER BY part').all(unit.id).filter(c=>c.embedding).map(c=>JSON.parse(c.embedding));const average=meanEmbedding(embeddings);if(average)this.core.db.prepare('UPDATE memory_keys SET embedding=? WHERE unit_id=?').run(JSON.stringify(average),unit.id);}
      this.core.db
        .prepare(
          "UPDATE memory_jobs SET status='done',error=NULL,model_id=?,updated_at=? WHERE id=? AND status='running'",
        )
        .run(profile.name, stamp(), job.id);
    } catch (e) {
      this.core.db
        .prepare(
          "UPDATE memory_jobs SET status=?,error=?,updated_at=?,attempts=max(0,attempts-?) WHERE id=? AND status='running'",
        )
        .run(
          this.controller.signal.aborted ? "pending" : "failed",
          this.controller.signal.aborted
            ? "聊天优先，稍后继续"
            : String(e.message).slice(0, 300),
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
