const dayMs = 86_400_000;
const localDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" });
const temporal = /\d{4}-\d{2}-\d{2}|去年冬天|上个月|上月|本月|这个月|前天|昨天|今天|最近(?:7|七)天|近一周|上周|本周/g;
const filler = /请问|告诉我|记不记得|还记得|现在|当时|那时|什么|怎么样|如何|哪些|哪种|多少|是不是|是否|有没有|的吗/g;

export function interpretMemoryQuery(query, clock = new Date()) {
  const [year, month] = localDay.format(clock).split("-").map(Number);
  const midnight = Date.parse(localDay.format(clock) + "T00:00:00+08:00");
  const monthStart = (y, m) => Date.UTC(y, m - 1, 1) - 8 * 3_600_000;
  const dates = [...new Set(query.match(temporal) ?? [])];
  let from, end;
  // Several dates can indicate a comparison. Preserve both sides for retrieval.
  if (dates.length === 1) {
    const date = dates[0];
    if (/^\d/.test(date)) {
      const candidate = Date.parse(date + "T00:00:00+08:00");
      if (Number.isFinite(candidate) && localDay.format(candidate) === date) {
        from = candidate;
        end = from + dayMs;
      }
    } else if (date === "去年冬天") {
      from = monthStart(year - 1, 12);
      end = monthStart(year, 3);
    } else if (/上个月|上月|本月|这个月/.test(date)) {
      const offset = date.startsWith("上") ? -1 : 0;
      from = monthStart(year, month + offset);
      end = monthStart(year, month + offset + 1);
    } else if (/上周|本周/.test(date)) {
      const weekday = new Date(midnight + 8 * 3_600_000).getUTCDay() || 7;
      from = midnight - (weekday - 1 + (date === "上周" ? 7 : 0)) * dayMs;
      end = from + 7 * dayMs;
    } else {
      const offset = ({ 前天: -2, 昨天: -1, 今天: 0 })[date];
      from = midnight + (offset ?? -6) * dayMs;
      end = offset === undefined ? midnight + dayMs : from + dayMs;
    }
  }
  const text = (from === undefined ? query : query.replace(temporal, " ")).replace(filler, " ").trim();
  return {
    text,
    from: from === undefined ? "" : new Date(from).toISOString(),
    to: end === undefined ? "" : new Date(end - 1).toISOString(),
  };
}

export function evidenceTerms(query) {
  const segments = query.toLowerCase().match(/[a-z0-9_.-]+|[\u3400-\u9fff]+/g) ?? [];
  const ignored = new Set(["用户", "我", "你", "的", "了", "吗", "呢", "是", "在", "有", "和", "what", "the", "is", "my"]);
  const terms = new Set();
  for (const s of segments) {
    if (ignored.has(s)) continue;
    if (!/^[\u3400-\u9fff]/.test(s) || s.length < 2) {
      if (s.length > 1 || segments.length === 1) terms.add(s);
    } else {
      for (let i = 0; i < s.length - 1; i++) {
        const pair = s.slice(i, i + 2);
        if (!ignored.has(pair)) terms.add(pair);
      }
    }
  }
  return [...terms].slice(-100);
}

export function hasEvidence(text, terms) {
  const value = String(text ?? "").toLowerCase();
  return terms.some(term => /[a-z0-9]/.test(term)
    ? (value.match(/[a-z0-9_.-]+/g) ?? []).includes(term)
    : value.includes(term));
}
