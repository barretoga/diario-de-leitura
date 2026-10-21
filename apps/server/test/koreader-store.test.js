import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore, sync } from '../src/store.js';
import { ingestBatch, linkDocument, listDocuments, getStatus } from '../src/koreader/store.js';
import { batch, options, unix, bookOperation } from './koreader-fixtures.js';
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
test('lost response replay preserves response and feed; changed batch conflicts', () => {
  const db = openStore(':memory:');
  try {
    const b = batch(); const first = ingestBatch(db,b,options);
    assert.deepEqual(ingestBatch(db,b,options),first); assert.equal(count(db,'koreader_events'),1);
    assert.equal(count(db,'books'),1); assert.equal(count(db,'reading_logs'),1);
    assert.equal(ingestBatch(db,{...b,batchId:randomUUID()},options).events[0].status,'duplicate');
    assert.throws(()=>ingestBatch(db,{...b,events:[]},options),e=>e.status===409);
    const changed = structuredClone(b); changed.batchId=randomUUID(); changed.events[0].durationSeconds=76;
    assert.equal(ingestBatch(db,changed,options).events[0].status,'source_conflict');
    assert.equal(db.prepare('SELECT duration_seconds FROM koreader_events').get().duration_seconds,75);
  } finally { db.close(); }
});
test('pending document link materializes once and conflicting association loses', () => {
  const db=openStore(':memory:');
  try {
    sync(db,{cursor:0,operations:[bookOperation(),bookOperation('book-00000002')]});
    const b=batch(); const doc=ingestBatch(db,b,options).document;
    assert.equal(doc.state,'pending');
    assert.throws(()=>linkDocument(db,doc.id,{bookId:'book-not-sent',expectedVersion:0},options),e=>e.status===400);
    const linked=linkDocument(db,doc.id,{bookId:'book-00000001',expectedVersion:0},options);
    assert.equal(linked.document.state,'linked'); assert.equal(linked.document.associationVersion,1);
    assert.deepEqual(linkDocument(db,doc.id,{bookId:'book-00000001',expectedVersion:0},options),linked);
    assert.throws(()=>linkDocument(db,doc.id,{bookId:'book-00000002',expectedVersion:0},options),e=>e.status===409);
    assert.equal(count(db,'reading_logs'),1);
    assert.deepEqual(ingestBatch(db,b,options).document,doc);
    assert.equal(getStatus(db,options.timeZone).counts.linked,1);
  } finally {db.close();}
});
test('partial rejection and paginated document filters preserve accepted events', () => {
  const db=openStore(':memory:');
  try {
    const b=batch(); b.events.push({...b.events[0],durationSeconds:-1});
    assert.deepEqual(ingestBatch(db,b,options).events.map(x=>x.status),['accepted','invalid']);
    for(let i=1;i<=100;i++) ingestBatch(db,batch({document:{documentId:i.toString(16).padStart(32,'0'),title:'Livro',author:''}}),options);
    let after=0; const ids=[],sizes=[];
    do {const page=listDocuments(db,{state:'linked',after,limit:50}); sizes.push(page.documents.length);ids.push(...page.documents.map(x=>x.id));after=page.nextAfter;}while(after!==null);
    assert.deepEqual(sizes,[50,50,1]);assert.equal(new Set(ids).size,101);
    assert.equal(listDocuments(db,{state:'pending'}).documents.length,0);
    assert.equal(count(db,'books'),2,'different documents with the same title reuse one book');
    assert.throws(()=>listDocuments(db,{state:'all',after:0,limit:101}),e=>e.status===400);
  }finally{db.close();}
});
test('activation timezone and progress sequence cannot silently change', () => {
  const db=openStore(':memory:');
  try {
    const b=batch({events:[]});ingestBatch(db,b,options);assert.equal(count(db,'reading_logs'),0);
    assert.throws(()=>ingestBatch(db,{...b,batchId:randomUUID(),activationUnix:unix-1000},options),e=>e.status===409);
    assert.throws(()=>ingestBatch(db,{...b,batchId:randomUUID()},{...options,timeZone:'UTC'}),e=>e.status===409);
    assert.equal(ingestBatch(db,{...b,batchId:randomUUID(),progress:{...b.progress,percent:20}},options).progress.status,'source_conflict');
    assert.equal(db.prepare('SELECT percent FROM koreader_progress').get().percent,4.1);
  } finally{db.close();}
});
test('feed failure rolls back raw events, projection and batch receipt', () => {
  const db=openStore(':memory:');
  try {
    const b=batch(); ingestBatch(db,b,options);
    const next=batch({events:[{...b.events[0],page:13,durationSeconds:100}],progress:null});
    db.exec("CREATE TRIGGER fail_feed BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT,'feed failure'); END");
    assert.throws(()=>ingestBatch(db,next,options),/feed failure/);assert.equal(count(db,'koreader_events'),1);assert.equal(count(db,'koreader_batches'),1);
    db.exec('DROP TRIGGER fail_feed'); assert.equal(ingestBatch(db,next,options).events[0].status,'accepted');
    assert.equal(db.prepare('SELECT minutes FROM reading_logs').get().minutes,2);
  }finally{db.close();}
});
