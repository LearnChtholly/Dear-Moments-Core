import { MemoryWorker } from './memory.mjs';
export class CoreRuntime {
    constructor(store, memory) {
        Object.assign(this, { store, memory });
        this.worker = new MemoryWorker(memory, { busy: () => this.indexing });
        this.indexing = false;
    }
    ingest(p) {
        if (!p || typeof p.sessionId !== 'string' || !p.sessionId || p.sessionId.length > 200 ||
            typeof p.eventId !== 'string' || !p.eventId || p.eventId.length > 400 ||
            !['user', 'assistant', 'tool'].includes(p.role) || typeof p.text !== 'string' || p.text.length > 1000000)
            throw Error('invalid ingest');
        return this.store.transaction(() => {
            const receipt = this.store.db.prepare('SELECT message_id FROM bridge_receipts WHERE connector=? AND event_id=?').get('dsh-core', p.eventId);
            let message;
            if (receipt)
                message = this.store.db.prepare('SELECT * FROM messages WHERE id=?').get(receipt.message_id);
            if (!message) {
                const title = 'DSH ' + p.sessionId;
                const c = this.store.conversations().find(x => x.title === title) || this.store.conversation(title, 'private');
                message = this.store.message(c.id, p.role, p.text, p.interrupted ? 'interrupted' : 'complete');
                if (p.time) {
                    const time = new Date(p.time);
                    if (!Number.isFinite(time.getTime()))
                        throw Error('invalid time');
                    this.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(time.toISOString(), message.id);
                }
            }
            const user = this.store.messages(message.conversation_id).findLast(x => x.role === 'user' && x.status === 'complete');
            if (user)
                this.memory.ingestTurn(user.id);
            if (!receipt)
                this.store.db.prepare('INSERT INTO bridge_receipts VALUES(?,?,?)').run('dsh-core', p.eventId, message.id);
            return { accepted: true, id: message.id, duplicate: !!receipt, indexed: false, indexing: 'background' };
        });
    }
    start() {
        this.memory.backfill();
        this.memory.longText.syncAll(this.memory.character());
        this.worker.start();
        this.timer = setInterval(() => this.indexTick().catch(() => { }), 3000);
        this.timer.unref?.();
    }
    async indexTick() {
        if (this.indexing || this.worker.running || this.closed)
            return;
        const profile = this.store.setting('memoryModel');
        if (!profile.embedding || !this.store.setting('memoryPolicy').enabled || this.store.setting('memoryPolicy').paused)
            return;
        this.indexing = true;
        this.controller = new AbortController();
        try {
            this.memory.longText.syncMissing(this.memory.character());
            const row = this.store.db.prepare("SELECT DISTINCT unit_id FROM memory_chunks WHERE character_id=? AND embedding IS NULL AND unit_id IS NOT NULL LIMIT 1").get(this.memory.character());
            if (row) {
                const unit = this.memory.unit(row.unit_id);
                if (unit?.status === 'active')
                    await this.memory.longText.fillUnit(unit, profile, AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]));
            }
            else
                await this.memory.longText.fillManual(this.memory.character(), profile, this.controller.signal);
        }
        finally {
            this.indexing = false;
            this.controller = null;
        }
    }
    async stop() {
        this.closed = true;
        clearInterval(this.timer);
        this.worker.stop();
        this.controller?.abort();
        while (this.indexing || this.worker.running)
            await new Promise(r => setTimeout(r, 20));
    }
}
