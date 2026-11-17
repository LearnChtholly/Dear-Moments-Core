// Expand only verified message anchors. The search result remains the primary evidence.
export function expandMemoryNeighborhood(
  db,
  hits,
  characterId,
  scope = "private",
) {
  const anchor = db.prepare(`
    SELECT m.id,m.created_at,m.rowid,m.conversation_id
    FROM messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE m.id=? AND c.character_id=? AND c.scope=? AND m.status='complete'
      AND m.role IN ('user','assistant')
      AND NOT EXISTS (
        SELECT 1 FROM memory_units u,json_each(u.source_refs) r
        WHERE u.conversation_id=m.conversation_id AND u.status!='active' AND r.value=m.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_tombstones t
        WHERE t.source_type='message' AND t.source_id=m.id
      )
  `);
  const neighbors = (direction) =>
    db.prepare(`
    SELECT m.id,m.role,m.content,m.created_at
    FROM messages m
    WHERE m.conversation_id=? AND (m.created_at,m.rowid) ${direction === "ASC" ? ">" : "<"} (?,?)
      AND m.status='complete' AND m.role IN ('user','assistant')
      AND NOT EXISTS (
        SELECT 1 FROM memory_units u,json_each(u.source_refs) r
        WHERE u.conversation_id=m.conversation_id AND u.status!='active' AND r.value=m.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_tombstones t
        WHERE t.source_type='message' AND t.source_id=m.id
      )
    ORDER BY m.created_at ${direction},m.rowid ${direction} LIMIT 3
  `);
  const before = neighbors("DESC"),
    after = neighbors("ASC");
  const anchorIds = new Set(
    hits.map((hit) => hit.source_message_id || hit.source_id),
  );
  const seen = new Set(anchorIds);
  let expanded = 0;
  return hits.map((hit) => {
    if (
      expanded >= 3 ||
      !["raw_evidence", "confirmed_memory"].includes(hit.kind) ||
      hit.asset_id
    )
      return hit;
    const row = anchor.get(
      hit.source_message_id || hit.source_id || "",
      characterId,
      scope,
    );
    if (!row) return hit;
    const args = [row.conversation_id, row.created_at, row.rowid];
    const window = [...before.all(...args).reverse(), ...after.all(...args)]
      .filter((m) => {
        if (
          seen.has(m.id) ||
          Math.abs(Date.parse(m.created_at) - Date.parse(row.created_at)) >
            60 * 60 * 1000
        )
          return false;
        seen.add(m.id);
        return true;
      })
      .map((m) => ({
        id: m.id,
        role: m.role,
        time: m.created_at,
        content:
          m.content.length > 200 ? m.content.slice(0, 200) + "…" : m.content,
      }));
    if (!window.length) return hit;
    expanded++;
    return { ...hit, nearby_messages: window };
  });
}
