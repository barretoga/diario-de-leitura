import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { openStore,sync } from '../src/store.js';
import { ingestBatch,linkDocument,listDocuments } from '../src/koreader/store.js';
import { civilDay } from '../src/koreader/projection.js';
import { batch,options,unix,bookOperation } from './koreader-fixtures.js';
function setup(b=batch()) {const db=openStore(':memory:');sync(db,{cursor:0,operations:[bookOperation()]});const doc=ingestBatch(db,b,options).document;linkDocument(db,doc.id,{bookId:'book-00000001',expectedVersion:0},options);return{db,b,doc};}
const log=db=>db.prepare('SELECT * FROM reading_logs').get();
test('aggregate seconds before floor and no visible change leaves version and feed',()=>{
  const b=batch({progress:null});b.events[0].durationSeconds=40;const {db}=setup(b);
  try{
    assert.equal(log(db).minutes,0);assert.equal(log(db).version,1);
    ingestBatch(db,batch({events:[{...b.events[0],page:13,durationSeconds:35}],progress:null}),options);
    assert.equal(log(db).minutes,1);assert.equal(log(db).version,2);
    const seq=db.prepare('SELECT MAX(seq) AS n FROM changes').get().n;
    ingestBatch(db,batch({events:[{...b.events[0],page:14,durationSeconds:1}],progress:null}),options);
    assert.equal(log(db).version,2);assert.equal(db.prepare('SELECT MAX(seq) AS n FROM changes').get().n,seq);
    assert.equal(db.prepare('SELECT total_seconds FROM koreader_projections').get().total_seconds,76);
  }finally{db.close();}
});
test('midnight uses start day and latest progress may decrease',()=>{
  const ts=Math.floor(Date.parse('2026-10-02T02:59:50.000Z')/1000);
  const b=batch({progress:{sequence:1,capturedAt:'2026-10-02T02:59:55.000Z',percent:80}});b.events[0].startTime=ts;
  const {db}=setup(b);
  try{
    assert.equal(civilDay(ts,options.timeZone),'2026-10-01');assert.equal(log(db).started_at,'2026-10-02T02:59:55.000Z');
    ingestBatch(db,batch({events:[],progress:{sequence:2,capturedAt:'2026-10-02T02:59:59.000Z',percent:70}}),options);
    ingestBatch(db,batch({events:[],progress:{sequence:3,capturedAt:'2026-10-02T02:59:58.000Z',percent:90}}),options);
    assert.equal(log(db).progress_value,70);
    ingestBatch(db,batch({events:[{...b.events[0],page:20,startTime:ts+20}],progress:null}),options);
    assert.equal(db.prepare("SELECT progress_value FROM reading_logs WHERE started_at='2026-10-02T03:00:10.000Z'").get().progress_value,null);
  }finally{db.close();}
});
test('daily excess is quarantined and never changes previous projection',()=>{
  const b=batch({progress:null});b.events=Array.from({length:12},(_,i)=>({...b.events[0],page:i+1,durationSeconds:7200}));const{db}=setup(b);
  try{
    assert.equal(log(db).minutes,1440);const version=log(db).version;
    const response=ingestBatch(db,batch({events:[{...b.events[0],page:50,durationSeconds:1}],progress:null}),options);
    assert.equal(response.events[0].status,'source_conflict');assert.equal(response.document.state,'blocked');assert.equal(log(db).version,version);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM koreader_events WHERE projection_eligible=0').get().n,1);
  }finally{db.close();}
});
test('derived edit is rejected; tombstone wins same day and next day still imports',()=>{
  const{db,b}=setup();
  try{
    const original=log(db);const operation={opId:randomUUID(),entity:'log',id:original.id,baseVersion:original.version,deleted:false,data:{...original,note:'manual'}};
    assert.equal(sync(db,{cursor:0,operations:[operation]}).results[0].status,'invalid');
    assert.equal(sync(db,{cursor:0,operations:[{...operation,opId:randomUUID(),baseVersion:0,deleted:true}]}).results[0].status,'conflict');
    assert.equal(sync(db,{cursor:0,operations:[{...operation,opId:randomUUID(),deleted:true}]}).results[0].status,'accepted');
    ingestBatch(db,batch({events:[{...b.events[0],page:18}],progress:null}),options);assert.ok(log(db).deleted_at);
    const nextOptions={...options,now:()=>new Date('2026-10-03T15:00:00.000Z')};
    ingestBatch(db,batch({events:[{...b.events[0],page:19,startTime:unix+86400}],progress:null}),nextOptions);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reading_logs WHERE deleted_at IS NULL').get().n,1);
  }finally{db.close();}
});
test('restored equal IDs are adopted; different content blocks without overwrite',()=>{
  for(const difference of [false,true]){
    const db=openStore(':memory:');try{
      sync(db,{cursor:0,operations:[bookOperation()]});const b=batch({progress:null});
      const key=JSON.stringify([b.deviceId,b.generationId,b.document.documentId,'2026-10-02']);const id='koreader-'+createHash('sha256').update(key).digest('hex');
      const data={book_id:'book-00000001',started_at:new Date((unix-100)*1000).toISOString(),minutes:difference?9:1,progress_value:null,progress_unit:null,note:'',created_at:'2026-10-01T10:00:00.000Z'};
      sync(db,{cursor:0,operations:[{opId:randomUUID(),entity:'log',id,baseVersion:0,deleted:false,data}]});
      const result=ingestBatch(db,b,options);
      assert.equal(result.document.state,difference?'blocked':'linked');assert.equal(log(db).minutes,difference?9:1);assert.equal(log(db).version,1);assert.equal(log(db).created_at,data.created_at);
    }finally{db.close();}
  }
});
test('deleted linked book pauses projection and other documents continue',()=>{
  const{db,doc}=setup(batch({events:[],progress:null}));try{
    const b=bookOperation();sync(db,{cursor:0,operations:[{...b,opId:randomUUID(),baseVersion:1,deleted:true}]});
    const received=ingestBatch(db,batch(),options);assert.equal(received.document.error.code,'book_deleted');assert.equal(db.prepare('SELECT COUNT(*) n FROM reading_logs').get().n,0);
    assert.equal(listDocuments(db,{state:'linked',after:0,limit:50}).documents[0].id,doc.id);
  }finally{db.close();}
});
