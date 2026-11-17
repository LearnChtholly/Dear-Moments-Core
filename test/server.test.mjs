import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
test("real server ingests, deduplicates, rejects origins and exits cleanly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-server-"));
  const discovery = path.join(dir, "discovery.json");
  const child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      DM_CORE_DATA_DIR: dir,
      DM_CORE_DISCOVERY_FILE: discovery,
      DM_CORE_MEMORY_MODEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let errors = "";
  child.stderr.on("data", (c) => (errors += c));
  child.stdout.resume();
  const exit = new Promise((resolve) => child.once("exit", resolve));
  try {
    for (
      let i = 0;
      i < 120 && !fs.existsSync(discovery) && child.exitCode === null;
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    assert(fs.existsSync(discovery), errors);
    const d = JSON.parse(fs.readFileSync(discovery));
    const call = async (p) => {
      const r = await fetch(d.url + "/ingest", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + d.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(p),
      });
      return r.json();
    };
    const p = {
      sessionId: "one",
      eventId: "one",
      role: "user",
      text: "我喜欢香草茶",
    };
    const first = await call(p),
      again = await call(p);
    assert.equal(first.ok, true);
    assert.equal(again.value.duplicate, true);
    assert.equal(first.value.id, again.value.id);
    const rejected = await fetch(d.url + "/ingest", {
      method: "POST",
      headers: {
        Origin: "https://example.invalid",
        Authorization: "Bearer " + d.token,
      },
      body: "{}",
    });
    assert.equal(rejected.status, 403);
    for (const asset of ["/dashboard.css", "/dashboard.js"]) {
      const response = await fetch(d.url + asset);
      assert.equal(response.status, 200);
      assert.ok((await response.text()).length > 30);
    }
    const status = await fetch(d.url + "/jobs/status", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + d.token,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const state = await status.json();
    assert.equal(state.ok, true);
    assert.ok(Array.isArray(state.value.jobs));

    const own = await fetch(d.url + "/status", {
      method: "POST",
      headers: {
        Origin: d.url,
        Authorization: "Bearer " + d.token,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).ok, true);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      exit,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("shutdown timed out")), 5000).unref(),
      ),
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
