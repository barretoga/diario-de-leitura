import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer } from '../src/server.js';
import { batch } from './koreader-fixtures.js';
const token='test-personal-token-000000000000000000';
async function withServer(run){const server=createAppServer({token,databasePath:':memory:'});server.listen(0,'127.0.0.1');await once(server,'listening');try{await run(`http://127.0.0.1:${server.address().port}`);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
function currentBatch(){const b=batch();const now=new Date();b.activationUnix=Math.floor(now.getTime()/1000)-200;b.events[0].startTime=b.activationUnix+10;b.progress.capturedAt=now.toISOString();return b;}
test('all personal KOReader routes require bearer; sync retains existing contract',()=>withServer(async url=>{
  for(const[method,path]of[['GET','status'],['GET','documents'],['POST','ingest'],['PUT','documents/1/link']]){
    const response=await fetch(`${url}/v1/koreader/${path}`,{method});assert.equal(response.status,401);assert.equal((await response.json()).error.code,'auth');
  }
  const response=await fetch(`${url}/v1/koreader/status`,{headers});assert.equal(response.status,200);assert.deepEqual((await response.json()).counts,{pending:0,linked:0,blocked:0});
  const unauthorized=await fetch(`${url}/v1/sync`,{method:'POST'});assert.deepEqual(await unauthorized.json(),{error:'Não autorizado'});
}));
test('malformed JSON, oversized body and invalid paging return safe errors',()=>withServer(async url=>{
  for(const[body,expected]of[['{',400],[JSON.stringify({title:'x'.repeat(1_000_001)}),413]]){
    const response=await fetch(`${url}/v1/koreader/ingest`,{method:'POST',headers,body});assert.equal(response.status,expected);assert.ok((await response.json()).error.code);
  }
  for(const path of ['documents?limit=101','documents?after=-1','documents?state=wrong'])assert.equal((await fetch(`${url}/v1/koreader/${path}`,{headers})).status,400);
  assert.equal((await fetch(`${url}/v1/koreader/unknown`,{headers})).status,404);
  const b=currentBatch();b.document.title='a'.repeat(501);const response=await fetch(`${url}/v1/koreader/ingest`,{method:'POST',headers,body:JSON.stringify(b)});const text=await response.text();assert.equal(response.status,400);assert.equal(text.includes(token),false);assert.equal(text.includes(b.document.title),false);
}));
test('HTTP receipt replay and automatic association expose book before exactly one derived log',()=>withServer(async url=>{
  const send=(path,body,method='POST')=>fetch(url+path,{method,headers,body:JSON.stringify(body)}).then(async r=>({status:r.status,body:await r.json()}));
  const b=currentBatch();const first=await send('/v1/koreader/ingest',b);assert.equal(first.status,200);
  const again=await send('/v1/koreader/ingest',b);assert.deepEqual(again.body,first.body);
  const linked=await send(`/v1/koreader/documents/${first.body.document.id}/link`,{bookId:first.body.document.bookId,expectedVersion:0},'PUT');assert.equal(linked.status,200);
  const change=await send('/v1/sync',{cursor:0,operations:[]});assert.deepEqual(change.body.changes.map(x=>x.entity),['book','log']);assert.match(change.body.changes[1].id,/^koreader-[a-f0-9]{64}$/);
  assert.equal((await send('/v1/sync',{cursor:change.body.cursor,operations:[]})).body.changes.length,0);
}));
