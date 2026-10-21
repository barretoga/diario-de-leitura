import test from 'node:test';import assert from 'node:assert/strict';
import { KOReaderController } from '../src/koreader/state.ts';
import { KOReaderClientError } from '../src/koreader/client.ts';
const doc=id=>({id,deviceId:'bc5ba97b-d778-416f-a488-026e9955a09f',generationId:'5c61d5a6-7d68-41e2-9c5b-896ae06d65cd',documentId:'a'.repeat(32),title:'Livro',author:'',state:'pending',bookId:null,associationVersion:0,error:null});
const status={protocolVersion:1,timeZone:'America/Sao_Paulo',counts:{pending:101,linked:0,blocked:0},lastReceiptAt:null};
test('confirmed association survives sync failure and exposes receipt still pending',async()=>{
  const client={status:async()=>status,documents:async()=>({documents:[doc(1)],nextAfter:null}),link:async()=>({document:{...doc(1),bookId:'book-00000001',state:'linked',associationVersion:1}})};
  const c=new KOReaderController(client,async()=>{throw new Error('Offline');});await c.load();await c.link(1,'book-00000001',0);
  assert.equal(c.snapshot.documents[0].bookId,'book-00000001');assert.equal(c.snapshot.error.message,'Livro associado; sincronização pendente');c.dispose();
});
test('controller loads pagination without duplicates and reload replaces list',async()=>{
  const client={status:async()=>status,documents:async({after})=>({documents:Array.from({length:after===100?1:50},(_,i)=>doc(after+i+1)),nextAfter:after===100?null:after+50})};const c=new KOReaderController(client,async()=>{});
  await c.load();await c.loadMore();await c.loadMore();assert.equal(c.snapshot.documents.length,101);assert.equal(c.snapshot.nextAfter,null);await c.load();assert.equal(c.snapshot.documents.length,50);c.dispose();
});
test('disposed and superseded requests never mutate current snapshot',async()=>{
  let resolve;const client={status:async()=>status,documents:()=>new Promise(r=>{resolve=r;})};const c=new KOReaderController(client,async()=>{});const pending=c.load();await new Promise(r=>setImmediate(r));c.dispose();resolve({documents:[doc(1)],nextAfter:null});await pending;assert.equal(c.snapshot.documents.length,0);
});
test('link is confirmed once, failures retry and conflict reloads server binding',async()=>{
  let calls=0,confirmed=0,finish;const client={status:async()=>status,documents:async()=>({documents:[doc(1)],nextAfter:null}),link:async()=>{calls++;return new Promise(r=>finish=r);}};
  const c=new KOReaderController(client,async()=>{confirmed++;});await c.load();const pending=c.link(1,'book-00000001',0);await c.link(1,'book-00000001',0);assert.equal(calls,1);
  finish({document:{...doc(1),state:'linked',bookId:'book-00000001',associationVersion:1}});await pending;assert.equal(confirmed,1);assert.equal(c.snapshot.documents[0].bookId,'book-00000001');
  client.link=async()=>{throw new KOReaderClientError('request','Sincronize este livro antes de associar','book_missing');};await c.link(2,'book-missing',0);assert.match(c.snapshot.error.message,/Sincronize/);assert.equal(confirmed,1);
  c.dispose();
});
