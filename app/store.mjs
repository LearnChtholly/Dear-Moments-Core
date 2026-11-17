import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync,appendFileSync,statSync,existsSync } from "node:fs";
import path from "node:path";
import { migrateMemory } from "./memory.mjs";
import{MAX_TEXT_CHARACTERS,queryText}from'./text-chunks.mjs';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const day = (date = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(date);
import { migrateSupervisor, supervisorDefaults } from "./memory-supervisor.mjs";
import { hasEvidence } from "./memory-query.mjs";

export const defaults = {
  memorySupervisor: supervisorDefaults,
  chatSync:{mode:'auto',sessionId:''},
  diary:{mode:'local',modelName:'',autoWrite:false,maxTokens:1200},
  character: {
    id: null,
    createdAt: null,
    name: "",
    persona: "",
    mode: "fixed",
    asset: null,
    dragAsset: null,
    renderer: "mesh",
    scale: 1,
    userTitle: "",
    language: "zh-CN",
    style: "自然、亲切，表达清楚，不要过度讨好。",
  },
  model: {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    name: "",
    context: 4096,
    maxTokens: 1024,
    cloudConsent: false,
    fallback: "",
    embedding: "",
  },
  speech: {
    engine: "compatible",
    referenceAudio: "",
    referenceText: "",
    referenceLanguage: "zh",
    sttUrl: "",
    sttModel: "",
    ttsUrl: "",
    ttsModel: "",
    voice: "",
    enabled: false,
    cloudConsent: false,
    rate: 1,
    volume: 0.8,
    device: "",
  },
  appearance: {
    dark: false,
    reducedMotion: false,
    petVisible: true,
    clickThrough: false,
    petLocked: false,
    petAlwaysOnTop: true,
    petControlsVersion: 1,
  },
  integrations: { mcpUrl: "", onebotUrl: "" },
  localModel: {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    name: "",
    context: 4096,
    maxTokens: 1024,
    cloudConsent: false,
    keepAlive: "2m",
  },
  memoryModel: {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    name: "",
    context: 4096,
    maxTokens: 1600,
    embedding: "",
    embeddingKind: "ollama",
    embeddingBaseUrl: "",
    embeddingApiKeyEnv: "DM_EMBEDDING_API_KEY",
    embeddingCloudConsent: false,
    embeddingNumGpu: 0,
    numGpu: 0,
    keepAlive: "0",
  },
  memoryPolicy: { enabled: true, paused: false,autoDiary:false,autoExcludeTests:true },
  styleLearning: { enabled: true, frozen: false },
  privacy: { cloudApprovals: [] },
  routing: { mode: "cloud-first", useDshWhenConnected: true },
  expressions: {
    enabled: false,
    ownerCharacter: null,
    baseAssets: [],
    normalAsset: null,
    chibiAsset: null,
    atlas: null,
    bonk: null,
    feeding: null,
    mode: "auto",
    allowModelStickers: true,
    stickers: [],
  },
  onboarding: false,
};
export const tokenize = (text) => [
  ...new Set(text.toLowerCase().match(/[a-z0-9_.-]+|[\u3400-\u9fff]/g) || []),
];
export function timeRange(query, clock = new Date()) {
  const today = day(clock),
    midnight = new Date(today + "T00:00:00+08:00").getTime(),
    span = 86400000;
  const explicit = query.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  let start = null,
    end = null;
  if (explicit) {
    start = new Date(explicit + "T00:00:00+08:00").getTime();
    end = start + span;
  } else if (/前天/.test(query)) {
    start = midnight - 2 * span;
    end = start + span;
  } else if (/昨天/.test(query)) {
    start = midnight - span;
    end = midnight;
  } else if (/今天/.test(query)) {
    start = midnight;
    end = midnight + span;
  } else if (/最近(?:7|七)天|近一周/.test(query)) {
    start = midnight - 6 * span;
    end = midnight + span;
  } else if (/上周|本周/.test(query)) {
    const weekday = new Date(midnight + 8 * 3600000).getUTCDay() || 7;
    start = midnight - (weekday - 1) * span;
    if (/上周/.test(query)) start -= 7 * span;
    end = start + 7 * span;
  }
  return start !== null && Number.isFinite(start)
    ? {
        from: new Date(start).toISOString(),
        to: new Date(end - 1).toISOString(),
      }
    : {};
}

export class Store {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.filename=filename;this.auditFile=filename===':memory:'?null:filename+'.audit.jsonl';
    this.audit('opening',{walBytes:existsSync(filename+'-wal')?statSync(filename+'-wal').size:0,mainBytes:existsSync(filename)?statSync(filename).size:0});
    if(existsSync(filename)&&statSync(filename).size){let checking;try{checking=new DatabaseSync(filename,{readOnly:true});const check=checking.prepare('PRAGMA quick_check').all();if(check.some(row=>Object.values(row)[0]!=='ok'))throw Error('integrity check failed');}catch(error){this.audit('open-failed',{sqliteCode:error.errcode});if(error.errcode===5||error.errcode===6)throw Error('数据库由正在运行的 Dear Moments 核心占用，请通过本地接口访问，或关闭软件后重试。');throw Error('数据库完整性异常，已停止写入且未重置原库。请使用完整备份恢复。');}finally{checking?.close();}}
    this.db = new DatabaseSync(filename);
    const oldVersion = this.db
      .prepare("PRAGMA user_version")
      .get().user_version;
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,scope TEXT NOT NULL DEFAULT 'private',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,assets TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,type TEXT NOT NULL,payload TEXT NOT NULL,source_id TEXT,scope TEXT NOT NULL DEFAULT 'private',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,content TEXT NOT NULL,source_id TEXT REFERENCES messages(id) ON DELETE CASCADE,entity TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'confirmed',scope TEXT NOT NULL DEFAULT 'private',embedding TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,tokens);
      CREATE TABLE IF NOT EXISTS diaries(id TEXT PRIMARY KEY,day TEXT UNIQUE NOT NULL,content TEXT NOT NULL,sources TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personas(id TEXT PRIMARY KEY,content TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL,type TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,kind TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_time ON messages(conversation_id,created_at);
      CREATE INDEX IF NOT EXISTS event_source_type ON events(source_id,type,created_at);
      CREATE INDEX IF NOT EXISTS event_time ON events(created_at);
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(scope,status,created_at);
      `);
    this.audit('opened',{sqlite:this.db.prepare('SELECT sqlite_version() version,sqlite_source_id() source').get(),journal:this.db.prepare('PRAGMA journal_mode').get(),locking:this.db.prepare('PRAGMA locking_mode').get()});
    migrateMemory(this.db, filename, oldVersion);
    try { migrateSupervisor(this.db, filename, oldVersion); }
    catch (error) { this.db.close(); throw error; }
    this.db
      .prepare(
        "UPDATE tasks SET status='interrupted',result='应用退出时任务中断，未自动重试。' WHERE status='running'",
      )
      .run();
    this.db
      .prepare(
        "UPDATE messages SET status='interrupted' WHERE status='streaming'",
      )
      .run();
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  setting(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    if (!row) return structuredClone(defaults[key]);
    let value;
    try { value = JSON.parse(row.value); } catch { return structuredClone(defaults[key]); }
    if (defaults[key] && typeof defaults[key] === "object" && !Array.isArray(defaults[key]))
      return value && typeof value === "object" && !Array.isArray(value)
        ? { ...structuredClone(defaults[key]), ...value }
        : structuredClone(defaults[key]);
    return value;
  }
  configure(key, value) {
    if (!(key in defaults)) throw Error("未知设置");
    this.db
      .prepare("INSERT OR REPLACE INTO meta VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  settings() {
    return Object.fromEntries(
      Object.keys(defaults).map((k) => [k, this.setting(k)]),
    );
  }
  event(type, payload = {}, source = null, scope = "private") {
    const event = {
      id: id(),
      type,
      payload,
      source_id: source,
      scope,
      created_at: now(),
    };
    this.db
      .prepare("INSERT INTO events VALUES(?,?,?,?,?,?)")
      .run(
        event.id,
        type,
        JSON.stringify(payload),
        source,
        scope,
        event.created_at,
      );
    return event;
  }
  conversations() {
    return this.db
      .prepare(
        "SELECT * FROM conversations WHERE character_id=? ORDER BY created_at DESC",
      )
      .all(this.setting("character").id || "default");
  }
  conversation(title = "新的一段时光", scope = "private") {
    const row = { id: id(), title, scope, created_at: now() };
    this.db
      .prepare(
        "INSERT INTO conversations(id,title,scope,created_at,character_id) VALUES(?,?,?,?,?)",
      )
      .run(
        row.id,
        title,
        scope,
        row.created_at,
        this.setting("character").id || "default",
      );
    return row;
  }
  messages(cid) {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",
      )
      .all(cid)
      .map((m) => ({
        ...m,
        assets: JSON.parse(m.assets),
        meta: JSON.parse(m.meta || "{}"),
      }));
  }
  message(cid, role, content, status = "complete", assets = []) {
    const row = {
      id: id(),
      conversation_id: cid,
      role,
      content,
      status,
      assets,
      created_at: now(),
    };
    this.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,role,content,status,assets,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        cid,
        role,
        content,
        status,
        JSON.stringify(assets),
        row.created_at,
      );
    if (role === "assistant" && status === "complete" && cid.startsWith("dsh:")) {
      this.onDshReply?.(row.id);
    }
    return row;
  }
  finishMessage(mid, content, status = "complete", meta = {}) {
    this.db
      .prepare("UPDATE messages SET content=?,status=?,meta=? WHERE id=?")
      .run(content, status, JSON.stringify(meta), mid);
  }
  remember(
    content,
    source = null,
    entity = "",
    scope = "private",
    embedding = null,
  ) {
    if (!content?.trim()) throw Error("记忆内容不能为空");
    if(content.length>MAX_TEXT_CHARACTERS)throw Error('记忆超过100万字符，请分段导入');
    if (
      source &&
      !this.db
        .prepare(
          "SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.status='complete' AND c.character_id=? AND c.scope=?",
        )
        .get(source, this.setting("character").id || "default", scope)
    )
      throw Error("记忆来源不存在或未完成");
    const mem = {
      id: id(),
      content: content.trim(),
      source_id: source,
      entity,
      status: "confirmed",
      scope,
      embedding,
      created_at: now(),
      updated_at: now(),
    };
    return this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO memories(id,content,source_id,entity,status,scope,embedding,created_at,updated_at,character_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          mem.id,
          mem.content,
          source,
          entity,
          mem.status,
          scope,
          embedding ? JSON.stringify(embedding) : null,
          mem.created_at,
          mem.updated_at,
          this.setting("character").id || "default",
        );
      this.db
        .prepare("INSERT INTO memory_fts VALUES(?,?)")
        .run(mem.id, tokenize(content).join(" "));
      this.event("memory.updated", { memory_id: mem.id }, source, scope);
      return mem;
    });
  }
  correctMemory(mid, content) {
    return this.transaction(() => {
      if (!content?.trim()) throw Error("记忆不能为空");
      if(content.length>MAX_TEXT_CHARACTERS)throw Error('记忆超过100万字符，请分段导入');
      this.db
        .prepare(
          "UPDATE memories SET content=?,embedding=NULL,updated_at=? WHERE id=?",
        )
        .run(content, now(), mid);
      this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(mid);
      this.db
        .prepare("INSERT INTO memory_fts VALUES(?,?)")
        .run(mid, tokenize(content).join(" "));
      this.db.prepare('DELETE FROM diaries WHERE character_id=?').run(this.setting('character').id||'default');
      this.event("memory.corrected", { memory_id: mid });
    });
  }
  deleteMemory(mid) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(mid);
      this.db.prepare("DELETE FROM memories WHERE id=?").run(mid);
      this.db.prepare('DELETE FROM diaries WHERE character_id=?').run(this.setting('character').id||'default');
      this.event("memory.deleted", { memory_id: mid });
    });
  }
  deleteConversation(cid) {
    this.transaction(() => {
      this.memoryCore?.removeConversation(cid);
      const mids = this.db
        .prepare("SELECT id FROM messages WHERE conversation_id=?")
        .all(cid)
        .map((m) => m.id);
      for (const mid of mids) {
        const mems = this.db
          .prepare("SELECT id FROM memories WHERE source_id=?")
          .all(mid);
        for (const m of mems)
          this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(m.id);
        this.db.prepare("DELETE FROM events WHERE source_id=?").run(mid);
      }
      this.db.prepare("DELETE FROM conversations WHERE id=?").run(cid);
      this.db.prepare('DELETE FROM diaries WHERE character_id=?').run(this.setting('character').id||'default');
    });
  }
  search(
    query = "",
    {
      scope = "private",
      limit = 12,
      vector = null,
      entity = "",
      from = "",
      to = "",
      lexical = [],
      evidenceOnly = false,
    } = {},
  ) {
    query=queryText(query);
    const range = evidenceOnly ? {} : timeRange(query);
    from = from || range.from || "";
    to = to || range.to || "";
    const all = this.db
      .prepare(
        "SELECT * FROM memories WHERE scope=? AND character_id=? AND status='confirmed' ORDER BY updated_at DESC",
      )
      .all(scope, this.setting("character").id || "default")
      .filter(
        (m) => (!from || m.created_at >= from) && (!to || m.created_at <= to),
      );
    entity =
      entity ||
      all.find((m) => m.entity && query.includes(m.entity))?.entity ||
      "";
    if (/最早/.test(query))
      all.sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (!query.trim() && !vector && !entity) return evidenceOnly ? [] : all.slice(0, limit);
    const tokens = tokenize(query),
      scores = new Map();
    const add = (rows) =>
      rows.forEach((m, i) =>
        scores.set(m.id, (scores.get(m.id) || 0) + 1 / (60 + i + 1)),
      );
    const allowed = new Map(all.map((m) => [m.id, m]));
    if (tokens.length) {
      const matches = this.db
        .prepare(
          "SELECT id,bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT 100",
        )
        .all(
          tokens
            .slice(0, 64)
            .map((t) => '"' + t.replaceAll('"', "") + '"')
            .join(" OR "),
        )
        .filter((m) => allowed.has(m.id) && (!evidenceOnly || hasEvidence(allowed.get(m.id).content, lexical)));
      add(matches);
    }
    if (vector) {
      const cosine = (record) => {
        if (
          record.model !== vector.model ||
          record.vector.length !== vector.vector.length
        )
          return -1;
        const a = record.vector,
          b = vector.vector;
        let dot = 0,
          aa = 0,
          bb = 0;
        for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i];
          aa += a[i] * a[i];
          bb += b[i] * b[i];
        }
        return dot / Math.sqrt(aa * bb || 1);
      };
      add(
        all
          .filter((m) => m.embedding)
          .map((m) => ({ ...m, score: cosine(JSON.parse(m.embedding)) }))
          .filter((m) => m.score > 0.3)
          .sort((a, b) => b.score - a.score)
          .slice(0, 40),
      );
    }
    if (entity && !evidenceOnly) add(all.filter((m) => m.entity === entity));
    if (!evidenceOnly && (from || to || /最近|最早/.test(query))) add(all.slice(0, 40));
    return [...scores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([mid, score]) => ({ ...allowed.get(mid), score }));
  }
  replaceEmbeddings(records) {
    return this.transaction(() => {
      for (const { id, updated_at, embedding } of records) {
        const row = this.db
          .prepare("SELECT updated_at FROM memories WHERE id=?")
          .get(id);
        if (!row || row.updated_at !== updated_at)
          throw Error("记忆在重建期间发生变化，请重新运行");
        this.db
          .prepare("UPDATE memories SET embedding=? WHERE id=?")
          .run(JSON.stringify(embedding), id);
      }
      this.event("memory.index.rebuilt", {
        count: records.length,
        model: records[0]?.embedding.model,
      });
      return records.length;
    });
  }
  diaryRecords(date,character=this.setting('character').id||'default') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error("日期格式错误");
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE status='complete' AND date(created_at,'+8 hours')=? AND conversation_id IN (SELECT id FROM conversations WHERE scope='private' AND character_id=?) ORDER BY created_at",
      )
      .all(date,character)
      .filter(m=>['user','assistant'].includes(m.role)&&!this.db.prepare("SELECT 1 FROM memory_units u,json_each(u.source_refs) r WHERE u.character_id=? AND u.status!='active' AND r.value=?").get(character,m.id));
    return rows;
  }
  diary(date) {
    const rows=this.diaryRecords(date);
    if (!rows.length) throw Error("这一天还没有已完成的对话，不生成虚构日记。");
    const body =
      `# ${date} · 一起度过的时光\n\n以下摘录来自当天的实际对话，保留原话供回溯。\n\n` +
      rows
        .map(
          (m) =>
            `> ${m.role === "user" ? "你" : "伙伴"}：${m.content.slice(0, 2000).replaceAll("\n", "\n> ")}\n\n来源：${m.id}`,
        )
        .join("\n\n");
    const diary = {
      id: id(),
      day: date,
      content: body,
      sources: rows.map((m) => m.id),
      created_at: now(),
    };
    this.db
      .prepare(
        "INSERT INTO diaries(id,day,content,sources,created_at,character_id) VALUES(?,?,?,?,?,?) ON CONFLICT(day,character_id) DO UPDATE SET content=excluded.content,sources=excluded.sources,created_at=excluded.created_at",
      )
      .run(
        diary.id,
        date,
        body,
        JSON.stringify(diary.sources),
        diary.created_at,this.setting('character').id||'default',
      );
    this.event("diary.generated", { day: date, sources: diary.sources });
    const saved=this.db.prepare('SELECT * FROM diaries WHERE day=? AND character_id=?').get(date,this.setting('character').id||'default');return {...saved,sources:JSON.parse(saved.sources)};
  }
  snapshot() {
    return {
      settings: this.settings(),
      conversations: this.conversations(),
      memories: this.search("", { limit: 500 }),
      counts: {
        memories: this.db.prepare("SELECT count(*) AS n FROM memories").get().n,
      },
      diaries: this.db
        .prepare('SELECT * FROM diaries WHERE character_id=? ORDER BY day DESC')
        .all(this.setting('character').id||'default')
        .map((d) => {const row=this.db.prepare("SELECT payload FROM events WHERE source_id=? AND type='diary.composed' ORDER BY created_at DESC LIMIT 1").get(d.id);let model;try{model=JSON.parse(row?.payload||'{}').model;}catch{}return {...d,sources:JSON.parse(d.sources),model};}),
      personas: this.db
        .prepare("SELECT * FROM personas ORDER BY created_at DESC")
        .all(),
      tasks: this.db
        .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100")
        .all(),
      events: this.db
        .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 100")
        .all(),
      assets: this.db
        .prepare(
          "SELECT id,name,type,created_at FROM assets ORDER BY created_at DESC",
        )
        .all(),
    };
  }
  export() {
    const tables = [
      "meta",
      "conversations",
      "messages",
      "events",
      "memories",
      "diaries",
      "personas",
      "assets",
      "tasks",
      "memory_units",
      "memory_keys",
      "memory_facts",
      "memory_jobs",
      "memory_tombstones",
      "agent_experiences",
      "style_observations",
      "bridge_receipts",
      "memory_chunks","memory_chunk_state","memory_extract_progress",
      "memory_supervisor_log","memory_candidates","memory_tool_diagnostics",
    ];
    return {
      format: "dear-moments",
      version: 2,
      created_at: now(),
      tables: Object.fromEntries(
        tables.map((t) => [t, this.db.prepare(`SELECT * FROM ${t}`).all()]),
      ),
    };
  }
  restore(data) {
    if (data?.format !== "dear-moments" || ![1, 2].includes(data.version))
      throw Error("备份格式不支持");
    const order = [
      "meta",
      "conversations",
      "messages",
      "events",
      "memories",
      "diaries",
      "personas",
      "assets",
      "tasks",
      "memory_units",
      "memory_keys",
      "memory_facts",
      "memory_jobs",
      "memory_tombstones",
      "agent_experiences",
      "style_observations",
      "bridge_receipts",
      "memory_chunks","memory_chunk_state","memory_extract_progress",
      "memory_supervisor_log","memory_candidates","memory_tool_diagnostics",
    ];
    for (const t of order) {
      if(['memory_chunks','memory_chunk_state','memory_extract_progress','memory_supervisor_log','memory_candidates','memory_tool_diagnostics'].includes(t))data.tables[t]??=[];
      if (
        (data.version === 1 && t.startsWith("memory_")) ||
        (data.version === 1 &&
          [
            "agent_experiences",
            "style_observations",
            "bridge_receipts",
          ].includes(t))
      )
        data.tables[t] ??= [];
      if (!Array.isArray(data.tables[t])) throw Error("备份缺少数据表：" + t);
    }
    this.transaction(() => {
      for (const t of [...order].reverse()) this.db.exec(`DELETE FROM ${t}`);
      this.db.exec("DELETE FROM memory_fts");
      this.db.exec("DELETE FROM unit_fts");
      this.db.exec("DELETE FROM chunk_fts");
      for (const t of order) {
        const columns = this.db
          .prepare(`PRAGMA table_info(${t})`)
          .all()
          .map((c) => c.name);
        const stmt = this.db.prepare(
          `INSERT INTO ${t}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        );
        for (const row of data.tables[t])
          stmt.run(
            ...columns.map(
              (c) =>
                row[c] ??
                (c === "meta"
                  ? "{}"
                  : c === "character_id"
                    ? JSON.parse(
                        data.tables.meta.find((m) => m.key === "character")
                          ?.value || "{}",
                      ).id || "default"
                    : null),
            ),
          );
      }
      this.configure("memorySupervisor", { ...this.setting("memorySupervisor"), enabled: false, mode: "observe" });
      for (const m of this.db.prepare("SELECT id,content FROM memories").all())
        this.db
          .prepare("INSERT INTO memory_fts VALUES(?,?)")
          .run(m.id, tokenize(m.content).join(" "));
      for (const key of this.db
        .prepare("SELECT unit_id,search_text FROM memory_keys")
        .all())
        this.db
          .prepare("INSERT INTO unit_fts VALUES(?,?)")
          .run(key.unit_id, tokenize(key.search_text).join(" "));
      for(const c of this.db.prepare('SELECT id,text FROM memory_chunks').all())this.db.prepare('INSERT INTO chunk_fts VALUES(?,?)').run(c.id,tokenize(c.text).join(' '));
    });
  }
  close() {
    this.db.close();
    this.audit('closed');
  }
  audit(event,details={}){try{if(this.auditFile)appendFileSync(this.auditFile,JSON.stringify({time:new Date().toISOString(),event,pid:process.pid,runtime:process.versions.electron?'electron':'node',...details})+'\n');}catch{}}
}
