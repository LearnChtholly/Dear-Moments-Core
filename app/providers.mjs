export const isLocal = (value) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(value).hostname,
    );
  } catch {
    return false;
  }
};
export function endpoint(value) {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw Error("服务地址必须是 HTTP/HTTPS，凭据请填写在密钥框。");
  if (!isLocal(value) && u.protocol !== "https:")
    throw Error("远程服务必须使用 HTTPS。");
  return value.replace(/\/+$/, "");
}
export async function jsonFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw Error(
      `服务返回 ${res.status}：${text.slice(0, 250).replace(/sk-[\w-]+/g, "[已隐藏]")}`,
    );
  }
  return res.json();
}
export async function* generate(profile, messages, { key = "", signal } = {}) {
  const base = endpoint(profile.baseUrl),
    local = profile.kind === "ollama";
  if (!isLocal(base) && !profile.cloudConsent)
    throw Error("此服务位于远程。请先在模型中心允许发送聊天与检索到的记忆。");
  if (!profile.name) throw Error("请先在模型中心选择并检测一个模型。");
  const body = local
    ? {
        model: profile.name,
        messages,
        stream: true,
        think: false,
        keep_alive: profile.keepAlive ?? "2m",
        ...(profile.jsonMode ? { format: profile.jsonSchema || "json" } : {}),
        options: {
          ...(Number.isInteger(profile.numGpu)
            ? { num_gpu: profile.numGpu }
            : {}),
          num_ctx: Math.min(Number(profile.context) || 4096, 16384),
          num_predict: Math.min(Number(profile.maxTokens) || 1024, 8192),
          temperature: 0.75,
        },
      }
    : {
        model: profile.name,
        messages: messages.map((m) =>
          m.images?.length
            ? {
                role: m.role,
                content: [
                  { type: "text", text: m.content },
                  ...m.images.map((image) => ({
                    type: "image_url",
                    image_url: { url: "data:image/png;base64," + image },
                  })),
                ],
              }
            : m,
        ),
        stream: true,
        ...(profile.jsonSchema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "memory_plan",
                  strict: true,
                  schema: profile.jsonSchema,
                },
              },
            }
          : profile.jsonMode
            ? { response_format: { type: "json_object" } }
            : {}),
        max_tokens: Math.min(Number(profile.maxTokens) || 1024, 8192),
      };
  const res = await fetch(base + (local ? "/api/chat" : "/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: "Bearer " + key } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 1000);
    const error = Error(`模型服务返回 ${res.status}：${detail.slice(0, 200)}`);
    error.schemaUnsupported = Boolean(
      profile.jsonSchema &&
        [400, 422].includes(res.status) &&
        /response_format|json_schema/i.test(detail) &&
        /support|invalid|allowed|不支持/i.test(detail),
    );
    throw error;
  }
  if (!res.body) throw Error("服务没有返回响应流");
  const reader = res.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  const parse = (line) => {
    if (!line.trim() || line.startsWith(":")) return "";
    if (!local && !line.startsWith("data:")) return "";
    const data = local ? line : line.slice(5).trim();
    if (data === "[DONE]") return "";
    const obj = JSON.parse(data);
    if (obj.error)
      throw Error(
        typeof obj.error === "string" ? obj.error : obj.error.message,
      );
    return local
      ? obj.message?.content || ""
      : obj.choices?.[0]?.delta?.content || "";
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        const token = parse(line);
        if (token) yield token;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const token = parse(buffer);
      if (token) yield token;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const embeddingKind = (profile) =>
  String(profile.embeddingKind || profile.kind || "ollama").toLowerCase();
const embeddingBase = (profile) =>
  endpoint(profile.embeddingBaseUrl || profile.baseUrl);
export async function embed(profile, text, options = {}) {
  if (!profile.embedding) return null;
  return (await embedMany(profile, [text], options))[0];
}
export async function embeddingIdentity(profile, { signal } = {}) {
  const kind = embeddingKind(profile),
    base = embeddingBase(profile);
  if (kind === "ollama") {
    if (!isLocal(base)) throw Error("本地 Ollama Embedding 必须使用 localhost");
    const tags = await jsonFetch(base + "/api/tags", {
        signal: signal || AbortSignal.timeout(5000),
      }),
      entry = tags.models?.find(
        (m) =>
          m.name === profile.embedding ||
          m.name === profile.embedding + ":latest",
      );
    if (!entry?.digest) throw Error("未找到 Embedding 模型");
    return profile.embedding + "@" + entry.digest;
  }
  if (!profile.embeddingCloudConsent && !profile.cloudConsent)
    throw Error("云端 Embedding 尚未授权");
  return kind + ":" + base + ":" + profile.embedding;
}
export async function embedMany(
  profile,
  texts,
  { query = false, signal } = {},
) {
  if (!profile.embedding) return [];
  if (!texts.length) return [];
  if (texts.some((t) => typeof t !== "string" || t.length > 8000))
    throw Error("向量输入需要先分块，单段不能超过8000字符");
  const kind = embeddingKind(profile),
    base = embeddingBase(profile),
    requestSignal = signal || AbortSignal.timeout(90000);
  if (kind === "ollama") {
    if (!isLocal(base)) throw Error("本地 Ollama Embedding 必须使用 localhost");
    const before = await jsonFetch(base + "/api/tags", {
      signal: requestSignal,
    });
    const beforeDigest = before.models?.find(
      (m) =>
        m.name === profile.embedding ||
        m.name === profile.embedding + ":latest",
    )?.digest;
    const prefix =
      query && profile.embedding.startsWith("qwen3-embedding")
        ? "Instruct: Retrieve relevant personal conversation evidence for this question.\nQuery: "
        : "";
    const data = await jsonFetch(base + "/api/embed", {
      signal: requestSignal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: profile.embedding,
        input:
          texts.length === 1
            ? prefix + texts[0]
            : texts.map((text) => prefix + text),
        keep_alive: profile.embeddingKeepAlive || "2m",
        ...(Number.isInteger(profile.embeddingNumGpu)
          ? { options: { num_gpu: profile.embeddingNumGpu } }
          : {}),
      }),
    });
    const tags = await jsonFetch(base + "/api/tags", { signal: requestSignal });
    const version = tags.models?.find(
      (m) =>
        m.name === profile.embedding ||
        m.name === profile.embedding + ":latest",
    );
    if (beforeDigest && beforeDigest !== version?.digest)
      throw Error("Embedding 模型在请求期间发生变化，丢弃本次向量");
    if (
      data.embeddings?.length !== texts.length ||
      data.embeddings.some(
        (v) => !v.length || v.some((x) => !Number.isFinite(x)),
      )
    )
      throw Error("模型返回的向量数量或内容无效");
    return data.embeddings.map((vector) => ({
      model: profile.embedding + (version?.digest ? "@" + version.digest : ""),
      vector,
    }));
  }
  if (!profile.embeddingCloudConsent && !profile.cloudConsent)
    throw Error("云端 Embedding 尚未授权");
  const keyEnv = profile.embeddingApiKeyEnv || "DM_EMBEDDING_API_KEY",
    key = process.env[keyEnv] || profile.embeddingApiKey || "";
  if (!key) throw Error("未配置云端 Embedding API Key，请设置 " + keyEnv);
  const data = await jsonFetch(base + "/embeddings", {
    signal: requestSignal,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
    },
    body: JSON.stringify({ model: profile.embedding, input: texts }),
  });
  const rows = Array.isArray(data.data)
    ? [...data.data]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((x) => x.embedding)
    : data.embeddings;
  if (
    !Array.isArray(rows) ||
    rows.length !== texts.length ||
    rows.some(
      (v) =>
        !Array.isArray(v) || !v.length || v.some((x) => !Number.isFinite(x)),
    )
  )
    throw Error("云端 Embedding 返回的向量数量或内容无效");
  return rows.map((vector) => ({
    model: kind + ":" + base + ":" + profile.embedding,
    vector,
  }));
}
export function selectMemoryContext(
  memories,
  { maxItems = 6, maxChars = 3600, maxNearbyChars = 1000 } = {},
) {
  const priority = new Map([
    ["confirmed_memory", 0],
    ["fact_match", 1],
    ["task_experience", 2],
    ["raw_evidence", 3],
  ]);
  const seen = new Set(),
    selected = [];
  let used = 0;
  const ordered = [...(Array.isArray(memories) ? memories : [])].sort(
    (a, b) => (priority.get(a.kind) ?? 4) - (priority.get(b.kind) ?? 4),
  );
  for (const m of ordered) {
    const key = String(m.unit_id || m.id || m.source_id || "");
    if (!key || seen.has(key)) continue;
    if (
      /^(?:tool_result|telemetry|plugin|dsh\.tool|mcp\.)/.test(
        String(m.kind || ""),
      )
    )
      continue;
    const raw = String(m.content || "").trim();
    if (!raw) continue;
    const remaining = maxChars - used;
    if (remaining < 80) break;
    const content =
      raw.length > Math.min(700, remaining)
        ? raw.slice(0, Math.min(700, remaining)) + "\\n[记忆片段已截断]"
        : raw;
    const record = {
      id: m.id,
      chunk_id: m.chunk_id,
      source_message_id: m.source_message_id,
      source_range: m.source_range,
      asset_id: m.asset_id,
      content,
      source: m.source_id,
      time: m.event_time || m.recorded_at,
      kind: m.kind,
      status: m.status,
      facts: m.facts,
    };
    selected.push(record);
    seen.add(key);
    used += content.length;
    if (selected.length >= maxItems) break;
  }
  let nearbyBudget = Math.min(maxNearbyChars, maxChars - used);
  for (const item of selected) {
    const hit = ordered.find(
      (m) => m.id === item.id && m.source_message_id === item.source_message_id,
    );
    for (const neighbor of hit?.nearby_messages || []) {
      const cost = JSON.stringify(neighbor).length;
      if (cost > nearbyBudget) continue;
      (item.nearby_messages ??= []).push(neighbor);
      nearbyBudget -= cost;
    }
  }
  return selected;
}
