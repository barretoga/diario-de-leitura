import test from 'node:test';
import assert from 'node:assert/strict';
import { client } from './koreader-helpers.mjs';
import { SyncEngine } from '../src/sync/engine.ts';
import { SyncStore } from '../src/sync/store.ts';
import { openStore, sync } from '../../server/src/store.js';
import { ingestBatch } from '../../server/src/koreader/store.js';
import { batch, options, bookOperation } from '../../server/test/koreader-fixtures.js';

const google={source:'google',id:'dom_123',title:'Dom Casmurro — edição do catálogo',authors:['Machado de Assis'],language:'pt',categories:['Ficção'],coverUri:null,publishedYear:1899,sourceUrl:'https://books.google.com/books?id=dom_123'};
const open={source:'openlibrary',workKey:'/works/OL123W',title:'Dom Casmurro — Open Library',authors:['Machado de Assis'],editionLanguage:'por',coverId:123,subjects:['Fiction'],firstPublishYear:1899,sourceUrl:'https://openlibrary.org/works/OL123W'};
async function setup(t,lookup,{existing=false}={}) {
 const previous=process.env.EXPO_PUBLIC_CATALOG_API_URL;process.env.EXPO_PUBLIC_CATALOG_API_URL='https://catalog.example';
 t.after(()=>{if(previous===undefined)delete process.env.EXPO_PUBLIC_CATALOG_API_URL;else process.env.EXPO_PUBLIC_CATALOG_API_URL=previous;});
 const calls=[];t.mock.method(globalThis,'fetch',async (input,init)=>{const params=Object.fromEntries(new URL(input).searchParams);calls.push(params);return lookup(params,init);});
 const remote=openStore(':memory:');t.after(()=>remote.close());if(existing)sync(remote,{cursor:0,operations:[bookOperation()]});
 const receipt=ingestBatch(remote,batch(),options);const {store,raw}=await client(t);
 const engine=new SyncEngine(store,async()=> 't'.repeat(32),async(_url,_token,request)=>sync(remote,request));t.after(()=>engine.setActive(false));
 const drain=async()=>{engine.setActive(true);await engine.settled();assert.equal(engine.status.message,null);};
 return {store,raw,remote,receipt,engine,calls,drain};
}
const response=(source,items)=>new Response(JSON.stringify({source,items}));

test('new Kindle book takes first Google result, persists catalog link and synchronizes title without changing IDs',async t=>{
 const c=await setup(t,()=>response('google',[google,{...google,id:'second',title:'Segunda edição',sourceUrl:'https://books.google.com/books?id=second'}]));
 await c.drain();const book=(await c.store.listBooks())[0];
 assert.equal(book.title,google.title);assert.equal(book.id,c.receipt.document.bookId);
 assert.deepEqual(await c.store.listGoogleBookLinks(),[{book_id:book.id,volume_id:'dom_123'}]);
 assert.equal(c.remote.prepare('SELECT title FROM books WHERE id=?').get(book.id).title,google.title);
 assert.equal((await c.store.listLogs())[0].book_id,book.id);assert.equal(await c.store.pendingCount(),0);
 assert.deepEqual(c.calls.map(x=>x.source),['google']);await c.drain();assert.equal(c.calls.length,1);
 assert.equal(c.calls[0].language,'all');
});
test('empty Google search falls back to first Open Library result with cover and subjects',async t=>{
 const c=await setup(t,p=>response(p.source,p.source==='google'?[]:[open]));await c.drain();
 assert.deepEqual(c.calls.map(x=>x.source),['google','openlibrary']);
 assert.equal((await c.store.listBooks())[0].title,open.title);
 assert.deepEqual(await c.store.listBookMetadata(),[{book_id:c.receipt.document.bookId,work_key:open.workKey,cover_id:123,subjects:['Fiction'],first_publish_year:1899}]);
});
test('no catalog match or failed connection keeps Kindle metadata and never repeats the lookup',async t=>{
 for(const unavailable of [false,true]) {
  await t.test(unavailable?'unavailable':'no results',async t=>{
   const c=await setup(t,p=>{if(unavailable)throw Error('offline');return response(p.source,[]);});await c.drain();
   assert.equal((await c.store.listBooks())[0].title,batch().document.title);assert.equal((await c.store.listLogs()).length,1);
   const count=c.calls.length;assert.equal(count,unavailable?1:2);await c.drain();assert.equal(c.calls.length,count);assert.equal(await c.store.pendingCount(),0);
  });
 }
});
test('cancelled foreground lookup stays pending and can finish on the next resume',async t=>{
 let c;let interrupt=true;c=await setup(t,async()=>{
  if(interrupt){interrupt=false;c.engine.setActive(false);}return response('google',[google]);
 });await c.drain();assert.equal((await c.store.listBooks())[0].title,batch().document.title);
 assert.equal((await c.store.pendingKindleCatalogBooks()).length,1);
 await c.drain();assert.equal((await c.store.listBooks())[0].title,google.title);assert.equal(c.calls.length,2);
});
test('book deletion during lookup does not resurrect the book or import catalog metadata',async t=>{
 let c;c=await setup(t,async()=>{await c.store.remove('book',c.receipt.document.bookId);return response('google',[google]);});
 await c.drain();assert.deepEqual(await c.store.listBooks(),[]);assert.deepEqual(await c.store.listGoogleBookLinks(),[]);
});
test('lookup queue survives a new store instance and empty page after receiving the book',async t=>{
 const c=await setup(t,()=>response('google',[google]));
 const request=await c.store.prepare();await c.store.apply(request,sync(c.remote,request));
 const raw=c.raw;const store=new SyncStore({async execAsync(sql){raw.exec(sql);},async runAsync(sql,...args){return raw.prepare(sql).run(...args);},async getFirstAsync(sql,...args){return raw.prepare(sql).get(...args)??null;},async getAllAsync(sql,...args){return raw.prepare(sql).all(...args);}});
 await store.initialize();assert.equal((await store.pendingKindleCatalogBooks()).length,1);
 const engine=new SyncEngine(store,async()=> 't'.repeat(32),async(_url,_token,request)=>sync(c.remote,request));t.after(()=>engine.setActive(false));
 engine.setActive(true);await engine.settled();assert.equal((await store.listBooks())[0].title,google.title);assert.equal(c.calls.length,1);
});
test('v6 migration rolls back on failure and preserves old books without retroactive catalog lookup',async t=>{
 const {raw,store}=await client(t);await store.save('book','old-book',{title:'Original',author:'Autor',created_at:options.now().toISOString()});
 raw.exec('DROP TABLE kindle_catalog_lookup; PRAGMA user_version=6');
 const original=raw.prepare('SELECT * FROM books').get();const originalCursor=(await store.settings()).cursor;
 const api={async execAsync(sql){raw.exec(sql);if(sql.includes('PRAGMA user_version=7'))throw Error('migration failure');},async runAsync(sql,...args){return raw.prepare(sql).run(...args);},async getFirstAsync(sql,...args){return raw.prepare(sql).get(...args)??null;},async getAllAsync(sql,...args){return raw.prepare(sql).all(...args);}};
 await assert.rejects(new SyncStore(api).initialize(),/migration failure/);
 assert.equal(raw.prepare('PRAGMA user_version').get().user_version,6);assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='kindle_catalog_lookup'").get(),undefined);
 await store.initialize();await store.initialize();assert.deepEqual(raw.prepare('SELECT * FROM books').get(),original);
 assert.equal((await store.settings()).cursor,originalCursor);assert.deepEqual(await store.pendingKindleCatalogBooks(),[]);
});
test('Kindle association to a book already in the library must not trigger automatic metadata replacement',async t=>{
 const c=await setup(t,()=>{throw Error('must not search');},{existing:true});await c.drain();assert.equal(c.calls.length,0);
 assert.equal((await c.store.listBooks())[0].title,batch().document.title);
});
test('manual edit during lookup wins over automatic catalog selection',async t=>{
 let c;c=await setup(t,async()=>{
  const book=(await c.store.listBooks())[0];await c.store.save('book',book.id,{title:'Minha edição',author:'Meu autor',created_at:book.created_at});
  return response('google',[google]);
 });await c.drain();assert.equal((await c.store.listBooks())[0].title,'Minha edição');assert.deepEqual(await c.store.listGoogleBookLinks(),[]);
});
