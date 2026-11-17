
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store}from'../app/store.mjs';
import {MemoryCore}from'../app/memory.mjs';
import {CoreRuntime}from'../app/core-runtime.mjs';
import {DurableQueue}from'../plugins/dsh-dear-moments-core/queue.mjs';
test('failed derivation rolls back receipt and messages; retry produces one complete unit',()=>{
 const s=new Store(':memory:'),m=new MemoryCore(s),r=new CoreRuntime(s,m);
 const real=m.ingestTurn.bind(m);let fail=true;
 m.ingestTurn=(...args)=>{if(fail)throw Error('fixture failure');return real(...args)};
 const p={sessionId:'test',eventId:'e1',role:'user',text:'我喜欢茶'};
 try{
  assert.throws(()=>r.ingest(p),/fixture/);
  assert.equal(s.db.prepare('SELECT count(*) n FROM bridge_receipts').get().n,0);
  assert.equal(s.db.prepare('SELECT count(*) n FROM messages').get().n,0);
  fail=false;const one=r.ingest(p);assert.equal(r.ingest(p).id,one.id);
  assert.equal(s.db.prepare('SELECT count(*) n FROM memory_units').get().n,1);
  s.db.prepare('DELETE FROM memory_units').run();
  assert.equal(r.ingest(p).duplicate,true);
  assert.equal(s.db.prepare('SELECT count(*) n FROM memory_units').get().n,1);
 }finally{s.close();}
});
test('outbox survives reload, keeps failed items, and enforces finite capacity',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dm-queue-'));
 try{const file=path.join(dir,'outbox.json'),q=new DurableQueue(file,2);
 q.enqueue({eventId:'a'});q.enqueue({eventId:'a'});q.enqueue({eventId:'b'});
 assert.throws(()=>q.enqueue({eventId:'c'}),/full/);
 await assert.rejects(()=>q.drain(async()=>{throw Error('offline')}));
 const again=new DurableQueue(file);assert.equal(again.pending.length,2);
 const sent=[];await again.drain(async item=>sent.push(item.eventId));assert.deepEqual(sent,['a','b']);
 assert.equal(new DurableQueue(file).pending.length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('unchanged search never scans original text for all units',()=>{
 const s=new Store(':memory:'),m=new MemoryCore(s);
 try{const c=s.conversation('test'),u=s.message(c.id,'user','蓝鲸面包');m.ingestTurn(u.id);
 m.longText.syncAll(m.character());
 m.longText.syncAll=()=>{throw Error('full scan')};
 assert.ok(m.search('蓝鲸')[0]);
 }finally{s.close();}
});

import http from 'node:http';
test('embedding background work completes beyond the first eight chunks',async()=>{
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const p=JSON.parse(body||'{}');
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({data:(p.input||[]).map((_,index)=>({index,embedding:[1,0,0]}))}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const s=new Store(':memory:'),m=new MemoryCore(s),runtime=new CoreRuntime(s,m);
 const oldKey=process.env.DM_EMBEDDING_API_KEY;process.env.DM_EMBEDDING_API_KEY='fixture-not-secret';
 try{
  s.configure('memoryModel',{...s.setting('memoryModel'),embedding:'fixture',embeddingKind:'compatible',embeddingBaseUrl:'http://127.0.0.1:'+server.address().port,embeddingCloudConsent:true});
  const result=runtime.ingest({sessionId:'long',eventId:'long',role:'user',text:'这是一段很长的历史证据。'.repeat(650)});
  assert.equal(result.indexed,false);
  m.longText.syncAll(m.character());
  const counts=()=>s.db.prepare('SELECT count(*) total,sum(embedding IS NOT NULL) done FROM memory_chunks').get();
  assert.ok(counts().total>8);
  await runtime.indexTick();assert.equal(counts().done,8);
  for(let i=0;i<30&&counts().done<counts().total;i++)await runtime.indexTick();
  assert.equal(counts().done,counts().total);
 }finally{if(oldKey===undefined)delete process.env.DM_EMBEDDING_API_KEY;else process.env.DM_EMBEDDING_API_KEY=oldKey;await runtime.stop();s.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
