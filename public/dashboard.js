const TOKEN = document.querySelector('meta[name="core-token"]').content,
  $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s).replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
}
function status(el, text, kind = "") {
  el.textContent = text;
  el.className = "status " + kind;
}
async function api(path, body = {}) {
  const r = await fetch(path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw Error(j.error || "Request failed");
  return j.value;
}
async function refresh() {
  try {
    const s = await api("/status");
    $("messages").textContent = s.messages;
    $("units").textContent = s.units;
    $("chunks").textContent = s.chunks;
    $("indexed").textContent = s.indexedChunks;
    $("conn").textContent = "Core online";
    $("conn").className = "badge";
  } catch (e) {
    $("conn").textContent = "Core unavailable";
    $("conn").className = "badge err";
  }
}
async function loadConfig() {
  try {
    const c = await api("/embedding/config");
    $("kind").value = c.kind === "ollama" ? "ollama" : "compatible";
    $("model").value = c.model || "";
    $("baseUrl").value = c.baseUrl || "";
    $("consent").checked = !!c.cloudConsent;
    status(
      $("configStatus"),
      c.keyConfigured
        ? "Loaded; API key detected"
        : "Loaded; API key not detected",
      "ok",
    );
  } catch (e) {
    status($("configStatus"), e.message, "err");
  }
}
async function search() {
  const q = $("query").value.trim();
  if (!q) return;
  status($("searchStatus"), "Searching...");
  $("results").innerHTML = "";
  try {
    const rows = await api("/search", { query: q, limit: +$("limit").value });
    status($("searchStatus"), "Found " + rows.length + " results", "ok");
    for (const x of rows) {
      const el = document.createElement("div");
      el.className = "item";
      el.innerHTML =
        '<div class="head"><span>' +
        esc(x.kind || "memory") +
        " · " +
        esc(x.event_time || x.recorded_at || "") +
        '</span><span class="link">View source</span></div><div>' +
        esc(x.content || "") +
        "</div>";
      el.querySelector(".link").onclick = async () => {
        try {
          $("source").textContent = JSON.stringify(
            await api("/source", { id: x.id, chunkId: x.chunk_id }),
            null,
            2,
          );
        } catch (e) {
          $("source").textContent = e.message;
        }
      };
      $("results").appendChild(el);
    }
  } catch (e) {
    status($("searchStatus"), e.message, "err");
  }
}
$("searchBtn").onclick = search;
$("query").onkeydown = (e) => {
  if (e.key === "Enter") search();
};
$("saveConfig").onclick = async () => {
  try {
    await api("/embedding/configure", {
      kind: $("kind").value,
      baseUrl: $("baseUrl").value.trim(),
      model: $("model").value.trim(),
      apiKeyEnv: $("keyEnv").value.trim() || "DM_EMBEDDING_API_KEY",
      cloudConsent: $("consent").checked,
    });
    status($("configStatus"), "Saved; new indexing will use it", "ok");
    refresh();
  } catch (e) {
    status($("configStatus"), e.message, "err");
  }
};
$("reloadConfig").onclick = loadConfig;
refresh();
loadConfig();
setInterval(refresh, 10000);
