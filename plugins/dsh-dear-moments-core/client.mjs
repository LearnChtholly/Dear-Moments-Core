import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export class CoreClient {
    constructor(config = {}) { this.file = config.coreFile || process.env.DM_CORE_DESCRIPTOR || path.join(os.homedir(), '.dear-moments-core', 'core.json'); this.abort = new AbortController(); }
    descriptor() { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    async request(route, body = {}, signal) { const d = this.descriptor(); const u = new URL(d.url); if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password)
        throw Error('Core must use localhost'); const r = await fetch(d.url + route, { method: 'POST', headers: { Authorization: 'Bearer ' + d.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(route === '/ingest' ? 120000 : 8000)]) }); const j = await r.json(); if (!r.ok || !j.ok)
        throw Error(j.error || 'Dear Moments Core unavailable'); return j.value; }
    close() { this.abort.abort(); }
}
