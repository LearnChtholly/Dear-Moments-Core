export function readMemorySource(store, memory, id, options = {}) {
  const unit = memory.readSource(id, options);
  if (unit) return unit.status === "active" ? unit : null;
  const row = store.db
    .prepare(
      "SELECT * FROM memories WHERE id=? AND character_id=? AND scope='private' AND status='confirmed'",
    )
    .get(id, memory.character());
  if (!row || (row.source_id && memory.suppressedMessage(row.source_id)))
    return null;
  const chunk = options.chunkId
    ? store.db
        .prepare(
          "SELECT start_offset FROM memory_chunks WHERE id=? AND memory_id=?",
        )
        .get(options.chunkId, id)
    : null;
  if (options.chunkId && !chunk) return null;
  const offset = Math.max(
    0,
    Number(options.offset ?? chunk?.start_offset) || 0,
  );
  const limit = Math.max(256, Math.min(Number(options.limit) || 2000, 8000));
  if (row.content.length <= 4000 && !offset && !options.chunkId) return row;
  const end = Math.min(row.content.length, offset + limit);
  return {
    ...row,
    content: row.content.slice(offset, end),
    page: {
      offset,
      next_offset: end < row.content.length ? end : null,
      total_characters: row.content.length,
    },
  };
}
