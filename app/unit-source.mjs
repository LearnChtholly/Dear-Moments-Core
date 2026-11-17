export function readUnitSource(id, { chunkId, offset, limit = 2000 } = {}) {
  const u = this.unit(id);
  if (!u || u.scope !== "private") return null;
  const { messages, user_text: _userText, original: _original, ...meta } = u;
  if (chunkId) {
    const c = this.db
      .prepare("SELECT * FROM memory_chunks WHERE id=? AND unit_id=?")
      .get(chunkId, u.id);
    if (!c || String(u.revision) !== c.source_version) return null;
    const text = c.asset_id
      ? this.db.prepare("SELECT text FROM assets WHERE id=?").get(c.asset_id)
          ?.text
      : messages.find((m) => m.id === c.message_id)?.content;
    if (typeof text !== "string") return null;
    const start = Math.max(
        0,
        Number.isFinite(offset) ? offset : c.start_offset,
      ),
      length = Math.max(256, Math.min(Number(limit) || 2000, 8000)),
      end = Math.min(text.length, start + length);
    return {
      ...meta,
      messages: [
        { id: c.message_id, role: c.role, content: text.slice(start, end) },
      ],
      chunk_id: c.id,
      asset_id: c.asset_id,
      page: {
        offset: start,
        next_offset: end < text.length ? end : null,
        total_characters: text.length,
      },
    };
  }
  const text = messages
    .map((m) => (m.role === "user" ? "用户：" : "伙伴：") + m.content)
    .join("\n");
  if (text.length <= 4000 && !offset) return u;
  const start = Math.max(0, Number(offset) || 0),
    end = Math.min(
      text.length,
      start + Math.max(256, Math.min(Number(limit) || 2000, 8000)),
    );
  return {
    ...meta,
    messages: [
      { id: u.source_id, role: "source", content: text.slice(start, end) },
    ],
    page: {
      offset: start,
      next_offset: end < text.length ? end : null,
      total_characters: text.length,
    },
  };
}
