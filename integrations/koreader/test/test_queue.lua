local Queue=require('queue');local json=require('dkjson')
local path=TEST_DIR..'/queue.sqlite';local q=Queue.open(path,{uuid=function()return 'batch-id' end})
q:activate(100,'device','generation','https://books.example')
local doc={documentId=string.rep('a',32),title='Livro',author='Autora'}
local events={};for i=1,101 do events[i]={nativeBookId=1,page=i,startTime=120,durationSeconds=40,totalPages=300} end
q:discover(doc,events,{capturedAt='2026-10-02T12:00:00.000Z',percent=20})
local frozen=q:freezeNext('batch-1');assert(#json.decode(frozen.json).events==100)
q:close();q=Queue.open(path,{uuid=function()return 'batch-2' end});assert(q:freezeNext('ignored').json==frozen.json)
q:discover(doc,{{nativeBookId=1,page=102,startTime=130,durationSeconds=30,totalPages=300}},nil);assert(q:freezeNext('ignored').json==frozen.json)
local response={protocolVersion=1,batchId=frozen.batchId,events={},progress={status='accepted'}}
for i=0,99 do response.events[i+1]={index=i,status=i==1 and 'invalid' or 'accepted',reason=i==1 and 'clock' or nil} end
q:ack(frozen.batchId,response);assert(q:status().events==102);assert(q:status().diagnostics==1)
local next=q:freezeNext('batch-2');assert(#json.decode(next.json).events==2)
assert(q:status().deviceId=='device');assert(q:status().generationId=='generation');assert(q:status().activationUnix==100)
local ok=pcall(function()q:activate(200,'another','generation','https://other.example')end);assert(not ok)
q:close()
local SQ=require('lua-ljsqlite3/init')
q=Queue.open(TEST_DIR..'/failure.sqlite',{})
q:activate(100,'device','generation','https://books.example')
q.db:exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'event failure'); END;")
assert(not pcall(function()q:discover(doc,events,nil)end));assert(q:status().events==0)
q.db:exec('DROP TRIGGER fail_event;');q:discover(doc,{events[1]},nil)
local original=q:freezeNext('failure-batch')
q.db:exec("CREATE TRIGGER fail_ack BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'ack failure'); END;")
assert(not pcall(function()q:ack('failure-batch',{protocolVersion=1,batchId='failure-batch',events={{index=0,status='accepted'}}})end))
assert(q:freezeNext('another').json==original.json)
q.db:exec('DROP TRIGGER fail_ack;');q:ack('failure-batch',{protocolVersion=1,batchId='failure-batch',events={{index=0,status='accepted'}}})
assert(q:status().pending==0);assert(q:status().events==1)
q.db:exec('PRAGMA user_version=99;');q:close()
assert(not pcall(function()Queue.open(TEST_DIR..'/failure.sqlite',{})end))
local DB=require('sqlite');local baseOpen=DB.open
DB.open=function(path,mode)
 local db=baseOpen(path,mode);local exec=db.exec
 db.exec=function(self,sql) exec(self,sql);if sql:find('CREATE TABLE events',1,true) then error('migration failure') end end
 return db
end
assert(not pcall(function()Queue.open(TEST_DIR..'/migration.sqlite',{})end));DB.open=baseOpen
local db=baseOpen(TEST_DIR..'/migration.sqlite');local row=require('sqlite').one(db,"SELECT count(*) n FROM sqlite_master WHERE type='table'");assert(row.n==0);db:close()
q=Queue.open(TEST_DIR..'/migration.sqlite',{});q:close()
q=Queue.open(TEST_DIR..'/diagnostics.sqlite',{});q:activate(100,'device','generation','https://books.example')
local second={documentId=string.rep('b',32),title='Segundo',author=''}
q:discover(doc,{events[1]},nil);q:discover(second,{}, {capturedAt='2026-10-02T12:00:00.000Z',percent=20})
q:diagnostic('source_conflict',1,doc.documentId,'Evento A','event')
q:diagnostic('source_conflict',1,second.documentId,'Progresso B','progress')
assert(q:status().diagnostics==2,'event and progress diagnostics have independent identities')
assert(q:freezeNext('blocked')==nil,'both source-conflict documents stay suspended');q:close()
local f=assert(io.open(PLUGIN_DIR..'/../fixtures/ingest-v1.json','r'));local fixture=json.decode(f:read('*a'));f:close()
q=Queue.open(TEST_DIR..'/contract.sqlite',{});q:activate(fixture.activationUnix,fixture.deviceId,fixture.generationId,'https://books.example')
q:discover(fixture.document,fixture.events,fixture.progress)
local actual=json.decode(q:freezeNext(fixture.batchId).json)
assert(actual.protocolVersion==fixture.protocolVersion and actual.batchId==fixture.batchId and actual.deviceId==fixture.deviceId)
assert(actual.events[1].startTime==fixture.events[1].startTime and actual.events[1].durationSeconds==fixture.events[1].durationSeconds)
assert(actual.progress.sequence==fixture.progress.sequence and actual.progress.percent==fixture.progress.percent)
q:close()
local legacy=SQ.open(TEST_DIR..'/diagnostics.sqlite')
legacy:exec([[ALTER TABLE diagnostics RENAME TO diagnostics_v2;
 CREATE TABLE diagnostics(kind TEXT NOT NULL,item_id INTEGER NOT NULL,doc TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(kind,item_id));
 INSERT INTO diagnostics SELECT kind,item_id,doc,message FROM diagnostics_v2 WHERE item_kind='event';
 DROP TABLE diagnostics_v2;PRAGMA user_version=1;]])
legacy:close()
q=Queue.open(TEST_DIR..'/diagnostics.sqlite',{});assert(q:get('deviceId')=='device');assert(q:status().events==1);assert(q:issues()[1].item_kind=='event');q:close()
q=Queue.open(TEST_DIR..'/migrate.sqlite',{});q:activate(100,'device','generation','https://books.example')
q:set('serverId','s1')
assert(not pcall(function()q:migrateUrl('https://new.example','s2')end));assert(q:get('url')=='https://books.example')
local fresh=Queue.open(TEST_DIR..'/migrate-noid.sqlite',{});fresh:activate(100,'device','generation','https://books.example')
assert(not pcall(function()fresh:migrateUrl('https://new.example','s1')end),'no remembered serverId refuses migration');assert(fresh:get('url')=='https://books.example');fresh:close()
q:migrateUrl('https://new.example','s1');assert(q:get('url')=='https://new.example')
assert(q:get('activationUnix')==100 and q:get('deviceId')=='device' and q:get('generationId')=='generation' and q:get('serverId')=='s1')
q:close()
