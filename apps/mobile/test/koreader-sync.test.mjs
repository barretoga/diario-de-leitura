import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { client } from './koreader-helpers.mjs';
import { SyncEngine } from '../src/sync/engine.ts';
import { openStore, sync } from '../../server/src/store.js';
import { ingestBatch } from '../../server/src/koreader/store.js';
import { batch, options, unix, bookOperation } from '../../server/test/koreader-fixtures.js';
function engine(t,store,remote,hook=()=>{}) {
  const pages=[];
  const value=new SyncEngine(store,async()=> 't'.repeat(32),async (_url,_token,request)=>{ await hook(request); const response=sync(remote,request);pages.push(response.changes.length);return response; });
  t.after(()=>value.setActive(false));
  return {value,pages, async drain(){value.setActive(true);await value.settled();assert.equal(value.status.message,null);}};
}
test('two clients receive automatically created books and daily records once, deletion does not resurrect', async t=> {
  const remote=openStore(':memory:');t.after(()=>remote.close());
  const input=batch();const receipt=ingestBatch(remote,input,options);
  const a=await client(t),b=await client(t); const ea=engine(t,a.store,remote),eb=engine(t,b.store,remote);
  await ea.drain();await eb.drain();const id=(await a.store.listLogs())[0].id;assert.equal((await b.store.listLogs())[0].id,id);
  assert.equal((await a.store.get('book',receipt.document.bookId)).title,input.document.title);
  assert.equal((await b.store.get('book',receipt.document.bookId)).author,input.document.author);
  ingestBatch(remote,input,options);await ea.drain();assert.equal((await a.store.listLogs()).length,1);
  await a.store.remove('log',id);
  ingestBatch(remote,batch({events:[{...input.events[0],page:13,startTime:unix-50,durationSeconds:70}],progress:null}),options);
  await ea.drain();assert.equal((await a.store.issues()).length,1);
  await a.store.resolve('log',id,'local');await ea.drain();await eb.drain();assert.equal((await b.store.listLogs()).length,0);
  ingestBatch(remote,batch({events:[{...input.events[0],page:14,startTime:unix-30}],progress:null}),options);
  await ea.drain();assert.equal((await a.store.listLogs()).length,0);
});
test('engine drains more than 500 projections and preserves a concurrent manual edit',async t=>{
  const remote=openStore(':memory:');t.after(()=>remote.close());sync(remote,{cursor:0,operations:[bookOperation()]});
  for(let n=0;n<501;n++){
    const request=batch({document:{documentId:n.toString(16).padStart(32,'0'),title:`Livro ${n}`,author:''}});
    ingestBatch(remote,request,options);
  }
  const a=await client(t),b=await client(t);const ea=engine(t,a.store,remote),eb=engine(t,b.store,remote);await ea.drain();await eb.drain();
  assert.equal((await a.store.listLogs()).length,501);assert.ok(ea.pages.includes(500));assert.equal((await b.store.listLogs()).length,501);
  const data={book_id:'book-00000001',started_at:options.now().toISOString(),minutes:5,progress_value:null,progress_unit:null,note:'',created_at:options.now().toISOString()};
  await a.store.save('log','manual-concurrent',data);let edited=false;
  const concurrent=engine(t,a.store,remote,async request=>{if(!edited && request.operations.some(op=>op.id==='manual-concurrent')){edited=true;await a.store.save('log','manual-concurrent',{...data,minutes:9});}});
  await concurrent.drain();await eb.drain();assert.equal((await b.store.get('log','manual-concurrent')).minutes,9);assert.equal(await a.store.pendingCount(),0);
});
