import test from 'node:test';
import assert from 'node:assert/strict';
import { syncConfirmed } from '../src/sync/confirmed.ts';
test('confirmed sync distinguishes resolved engine failures, pause and completion',async()=>{
  let settings={url:'https://books.example',paused:false,fatal:null};
  const store={settings:async()=>settings,pendingCount:async()=>0};
  const engine={status:{phase:'idle',message:null},request:async()=>{engine.status={phase:'error',message:'Offline'};}};
  await assert.rejects(syncConfirmed(engine,store),/pendente/);
  settings={...settings,paused:true};let called=false;engine.request=async()=>{called=true;};
  await assert.rejects(syncConfirmed(engine,store),/pendente/);assert.equal(called,false);
  settings={...settings,paused:false};engine.status={phase:'idle',message:null};await syncConfirmed(engine,store);assert.equal(called,true);
  store.pendingCount=async()=>1;await assert.rejects(syncConfirmed(engine,store),/pendente/);
});
