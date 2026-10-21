local Queue=require('queue');local Coordinator=require('coordinator')
local q=Queue.open(TEST_DIR..'/coordinator.sqlite',{});q:activate(100,'device','generation','https://books.example')
local doc={documentId=string.rep('a',32),title='Livro',author=''}
q:discover(doc,{{nativeBookId=1,page=1,startTime=120,durationSeconds=40,totalPages=300}},nil)
local now=200;local jobs={};local sends={};local callback;local cancelled=false;local active=true;local online=true;local collected=0
local scheduler={schedule=function(_,seconds,fn)local job={at=now+seconds,fn=fn};jobs[#jobs+1]=job;return job end,cancel=function(_,job)job.cancelled=true end}
local source={isActive=function()return active end,isOnline=function()return online end}
local collector={collect=function()collected=collected+1;return true end}
local transport={send=function(_,url,token,b,cb)sends[#sends+1]=b;callback=cb end,cancel=function()cancelled=true end}
local uuidCounter=0;local config={url='https://books.example',token='test-token',paused=false,clock=function()return now end,uuid=function()uuidCounter=uuidCounter+1;return 'batch-'..uuidCounter end}
local c=Coordinator.new(source,collector,q,transport,scheduler,config)
c:onEvent('page');assert(collected==1);assert(#sends==0);assert(jobs[1].at==230)
now=230;jobs[1].fn();assert(#sends==1);local frozen=sends[1]
c:syncNow();assert(#sends==1)
q:discover(doc,{{nativeBookId=1,page=2,startTime=130,durationSeconds=35,totalPages=300}},nil)
callback(nil,{kind='transient',code='timeout',message='Timeout'});assert(jobs[#jobs].at==231)
now=231;jobs[#jobs].fn();assert(#sends==2);assert(sends[2].json==frozen.json and sends[2].batchId==frozen.batchId)
callback({protocolVersion=1,batchId=frozen.batchId,events={{index=0,status='accepted'}}},nil)
c:syncNow();assert(#sends==3);assert(sends[3].batchId~=frozen.batchId)
callback(nil,{kind='auth',code='auth',message='Token inválido'});c:syncNow();assert(#sends==3)
c:onEvent('credentials');c:syncNow();assert(#sends==4)
c:setPaused(true);assert(cancelled);local captureCount=collected;c:onEvent('page');assert(collected>captureCount);assert(#sends==4)
online=false;c:setPaused(false);c:syncNow();assert(#sends==4)
active=false;c:onEvent('suspend');assert(c:status().active==false);q:close()
local q2=Queue.open(TEST_DIR..'/invalid.sqlite',{});q2:activate(100,'device','generation','https://books.example');q2:discover(doc,{{nativeBookId=1,page=1,startTime=120,durationSeconds=40,totalPages=300}},nil)
active=true;online=true;local c2=Coordinator.new(source,collector,q2,transport,scheduler,config);c2:syncNow();local old=sends[#sends]
callback(nil,{kind='protocol',code='invalid_request',message='Metadados inválidos'});assert(q2:status().diagnostics==1)
q2:discover({documentId=doc.documentId,title='Corrigido',author=''}, {},nil);q2:revalidate();c2:onEvent('revalidate');c2:syncNow();assert(sends[#sends].batchId~=old.batchId);assert(sends[#sends].json:find('Corrigido',1,true));q2:close()
local q3=Queue.open(TEST_DIR..'/tls.sqlite',{});q3:activate(100,'device','generation','https://books.example');q3:discover(doc,{ {nativeBookId=1,page=1,startTime=120,durationSeconds=40,totalPages=300} },nil)
local c3=Coordinator.new(source,collector,q3,transport,scheduler,config);c3:syncNow();local original=sends[#sends]
callback(nil,{kind='protocol',code='tls',message='TLS inválido'});assert(c3:status().blocked=='protocol')
assert(not c3:connectionVerified('https://other.example'))
assert(c3:connectionVerified('https://books.example'));assert(not c3:status().blocked)
c3:syncNow();assert(sends[#sends].batchId==original.batchId and sends[#sends].json==original.json)
for _,delay in ipairs({1,2,4,8,16,30,30})do
 callback(nil,{kind='transient',code='timeout',message='Timeout'});assert(jobs[#jobs].at==now+delay);now=jobs[#jobs].at;jobs[#jobs].fn()
 assert(sends[#sends].json==original.json)
end
c3:stop();q3:close()
local q4=Queue.open(TEST_DIR..'/closed.sqlite',{});q4:activate(100,'device','generation','https://books.example');q4:discover(doc,{ {nativeBookId=1,page=1,startTime=120,durationSeconds=40,totalPages=300} },nil)
local c4=Coordinator.new(source,collector,q4,transport,scheduler,config);c4:syncNow();local jobsBefore=#jobs
callback(nil,{kind='transient',code='network',stage='handshake',reason='closed',message='x'})
assert(not c4:status().blocked and #jobs>jobsBefore and c4:status().lastFailure.reason=='closed','transient handshake failure retries instead of blocking');q4:close()
local q5=Queue.open(TEST_DIR..'/identity.sqlite',{});q5:activate(100,'device','generation','https://books.example')
q5:discover(doc,{ {nativeBookId=1,page=1,startTime=120,durationSeconds=40,totalPages=300} },nil)
local c5=Coordinator.new(source,collector,q5,transport,scheduler,config);c5:syncNow();local b5=sends[#sends]
callback({protocolVersion=1,batchId=b5.batchId,events={{index=0,status='accepted'}},serverId='s1'},nil)
assert(q5:get('serverId')=='s1' and q5:status().pending==0)
q5:discover(doc,{ {nativeBookId=1,page=2,startTime=130,durationSeconds=40,totalPages=300} },nil)
c5:cancelTimer();c5:syncNow();local b6=sends[#sends];assert(b6.batchId~=b5.batchId);local pendingBefore=q5:status().pending
callback({protocolVersion=1,batchId=b6.batchId,events={{index=0,status='accepted'}},serverId='s2'},nil)
assert(q5:status().pending==pendingBefore and pendingBefore==1,'divergent server must not ack')
assert(c5.blocked=='protocol' and q5:get('transportBlockCode')=='server_mismatch' and q5:get('serverId')=='s1')
assert(c5:status().error=='Servidor diferente do vinculado; fila preservada' and c5:status().lastFailure.code=='server_mismatch')
assert(not c5:connectionVerified('https://books.example','s1') and c5.blocked=='protocol','test connection never clears server_mismatch')
local count=#sends;c5:syncNow();assert(#sends==count)
local c5r=Coordinator.new(source,collector,q5,transport,scheduler,config)
assert(c5r.blocked=='protocol' and c5r:status().error=='Servidor diferente do vinculado; fila preservada','a restarted coordinator explains a persisted server_mismatch block')
c5r:serverMigrated();assert(not c5r.blocked and not c5r:status().error and not q5:get('transportBlocked') and not q5:get('transportBlockCode'),'migration clears server_mismatch')
q5:set('transportBlocked','protocol');q5:set('transportBlockCode','batch_conflict')
local c5c=Coordinator.new(source,collector,q5,transport,scheduler,config);assert(c5c:status().error==nil)
c5c:serverMigrated();assert(c5c.blocked=='protocol' and q5:get('transportBlocked')=='protocol' and q5:get('transportBlockCode')=='batch_conflict','migration never clears a non-recoverable block')
q5:set('transportBlocked','auth');q5:set('transportBlockCode','auth')
local c5a=Coordinator.new(source,collector,q5,transport,scheduler,config);c5a:serverMigrated();assert(c5a.blocked=='auth' and q5:get('transportBlocked')=='auth','auth blocks are left to connectionVerified')
c5:stop();c5r:stop();c5c:stop();c5a:stop();q5:close()
local q6=Queue.open(TEST_DIR..'/legacy-server.sqlite',{});q6:activate(100,'device','generation','https://books.example')
q6:discover(doc,{ {nativeBookId=1,page=1,startTime=120,durationSeconds=40,totalPages=300} },nil)
local c6=Coordinator.new(source,collector,q6,transport,scheduler,config);c6:syncNow();local b7=sends[#sends]
callback({protocolVersion=1,batchId=b7.batchId,events={{index=0,status='accepted'}}},nil)
assert(q6:status().pending==0 and q6:get('serverId')==nil,'old server without serverId acks normally and stores nothing')
assert(c6:connectionVerified('https://books.example',nil) and q6:get('serverId')==nil)
assert(c6:connectionVerified('https://books.example','s9') and q6:get('serverId')=='s9','test connection remembers identity when empty')
assert(not c6:connectionVerified('https://books.example','s8') and c6.blocked=='protocol' and q6:get('transportBlockCode')=='server_mismatch' and q6:get('serverId')=='s9')
c6:stop();q6:close()
