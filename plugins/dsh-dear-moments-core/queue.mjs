import fs from 'node:fs';
import path from 'node:path';
export class DurableQueue {
    constructor(file, limit = 10000) { Object.assign(this, { file, limit }); this.pending = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []; this.chain = Promise.resolve(); }
    save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const temp = this.file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(this.pending), { mode: 0o600 }); fs.renameSync(temp, this.file); }
    enqueue(item) { if (this.pending.some(x => x.eventId === item.eventId))
        return; if (this.pending.length >= this.limit)
        throw Error('Memory outbox full; restore Core connection'); this.pending.push(item); try {
        this.save();
    }
    catch (error) {
        this.pending.pop();
        throw error;
    } }
    drain(send) { this.chain = this.chain.catch(() => { }).then(async () => { while (this.pending.length) {
        await send(this.pending[0]);
        const item = this.pending.shift();
        try {
            this.save();
        }
        catch (error) {
            this.pending.unshift(item);
            throw error;
        }
    } }); return this.chain; }
}
