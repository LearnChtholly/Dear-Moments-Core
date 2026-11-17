export const day = (date = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(date);
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
