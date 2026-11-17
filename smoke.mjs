import { Store } from './app/store.mjs';
import { MemoryCore } from './app/memory.mjs';
const s=new Store(':memory:'); new MemoryCore(s); console.log('ok'); s.close();