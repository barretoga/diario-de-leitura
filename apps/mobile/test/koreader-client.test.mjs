import test from 'node:test';import assert from 'node:assert/strict';
import { createKOReaderClient } from '../src/koreader/client.ts';
const status={protocolVersion:1,timeZone:'America/Sao_Paulo',counts:{pending:1,linked:0,blocked:0},lastReceiptAt:null};
test('client uses personal origin and bearer, rejects redirects and validates response',async()=>{
  let called;const client=createKOReaderClient({getUrl:async()=> 'https://personal.example',getToken:async()=> 'test-token',fetchImpl:async(url,options)=>{called={url,options};return new Response(JSON.stringify(status));}});
  assert.deepEqual(await client.status(),status);assert.equal(called.url,'https://personal.example/v1/koreader/status');assert.equal(called.options.headers.Authorization,'Bearer test-token');assert.equal(called.options.redirect,'error');
  const malformed=createKOReaderClient({getUrl:async()=> 'https://personal.example',getToken:async()=> 'test-token',fetchImpl:async()=>new Response('{}')});await assert.rejects(malformed.status(),e=>e.kind==='protocol');
  const insecure=createKOReaderClient({getUrl:async()=> 'http://example.com',getToken:async()=> 'test-token'});await assert.rejects(insecure.status(),e=>e.kind==='configuration');
});
test('client errors are actionable and never echo response or credential',async()=>{
  for(const[code,kind]of[[401,'auth'],[403,'auth'],[503,'network'],[409,'conflict'],[400,'request']]){
    const client=createKOReaderClient({getUrl:async()=> 'https://personal.example',getToken:async()=> 'private-test-token',fetchImpl:async()=>new Response('private-test-token',{status:code})});
    await assert.rejects(client.status(),e=>e.kind===kind&&!e.message.includes('private-test-token'));
  }
  const missing=createKOReaderClient({getUrl:async()=>null,getToken:async()=>null});await assert.rejects(missing.status(),e=>e.kind==='configuration');
});
test('client abort and timeout cancel network without leaking raw errors',async()=>{
  const fetchImpl=async(_,options)=>new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('private-test-token')));if(options.signal.aborted)reject(new Error('private-test-token'));});
  const client=createKOReaderClient({getUrl:async()=> 'https://personal.example',getToken:async()=> 'private-test-token',fetchImpl,timeoutMs:5});
  await assert.rejects(client.status(),e=>e.kind==='network'&&!e.message.includes('private-test-token'));
  const controller=new AbortController();controller.abort();await assert.rejects(client.status(controller.signal),e=>e.kind==='cancelled');
});
