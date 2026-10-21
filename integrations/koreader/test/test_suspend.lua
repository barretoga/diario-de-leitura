-- Catch cancellation losing a frozen batch, retries while asleep, and a resume
-- acknowledgement racing an interrupted pre-suspend request. SQLite and the
-- transport/coordinator are real; only the network and clock are controlled.
local Queue=require('queue');local Coordinator=require('coordinator');local Transport=require('transport');local json=require('dkjson')
local now=200;local sequence=0
local function setup(name,configOverrides)
    local q=Queue.open(TEST_DIR..'/'..name..'.sqlite',{});q:activate(100,'device','generation','https://books.example')
    local doc={documentId=string.rep('a',32),title='Livro',author=''}
    local requests={};local jobs={};local online=true
    local source={active=true,isActive=function(self)return self.active end,isOnline=function()return online end}
    local collector={collect=function()
        q:discover(doc,{{nativeBookId=1,page=1,startTime=120,durationSeconds=40,totalPages=300}},nil);return true
    end}
    local adapter={request=function(_,args,cb)
        local request={args=args,callback=cb};requests[#requests+1]=request
        return function()request.cancelled=true end
    end}
    local scheduler={schedule=function(_,seconds,fn)local job={at=now+seconds,fn=fn};jobs[#jobs+1]=job;return job end,cancel=function(_,job)job.cancelled=true end}
    local config={url='https://books.example',token=string.rep('t',32),paused=false,uuid=function()sequence=sequence+1;return 'batch-'..sequence end}
    for key,value in pairs(configOverrides or {})do config[key]=value end
    local c=Coordinator.new(source,collector,q,Transport.new(adapter),scheduler,config)
    return {q=q,c=c,requests=requests,jobs=jobs,online=function(value)online=value end,doc=doc}
end
local function accepted(request,status)
    local batch=json.decode(request.args.body)
    local events={};for i=1,#batch.events do events[i]={index=i-1,status=status or 'accepted'}end
    request.callback({status=200,body=json.encode({protocolVersion=1,batchId=batch.batchId,document={status='accepted'},events=events})})
end
local s=setup('suspend-success')
s.c:onEvent('suspend')
assert(#s.requests==1,'suspension captures and sends immediately with Wi-Fi')
assert(s.requests[1].args.timeout==5,'pre-suspend request is bounded to five seconds')
assert(s.q:status().pending==1 and not s.c:status().active)
accepted(s.requests[1]);assert(s.q:status().pending==0 and s.q:status().lastReceipt)
assert(#s.jobs==0,'no retries or periodic work while asleep');s.q:close()

s=setup('suspend-timeout');s.c:syncNow();local first=s.requests[1]
s.c:onEvent('suspend');assert(first.cancelled and #s.requests==2)
local interrupted=s.requests[2]
assert(interrupted.args.body==first.args.body,'suspend resends exact frozen payload')
interrupted.callback({error={kind='transient',code='timeout'}})
assert(#s.jobs==0 and s.q:status().pending==1 and not s.c.busy)
local path=TEST_DIR..'/suspend-timeout.sqlite';s.q:close()
s.q=Queue.open(path,{});s.c.queue=s.q;s.c.collector.collect=function()return true end
s.c:onEvent('resume');assert(#s.requests==3 and s.requests[3].args.timeout==15)
assert(s.requests[3].args.body==first.args.body,'restart and resume preserve payload and batch ID')
accepted(first);assert(s.q:status().pending==1,'late cancelled acknowledgement cannot clear current batch')
accepted(s.requests[3],'duplicate');assert(s.q:status().pending==0)
local periodic=false;for _,job in ipairs(s.jobs)do if not job.cancelled and job.at==now+300 then periodic=true end end
assert(periodic,'resuming restarts periodic capture');s.c:stop();s.q:close()

s=setup('suspend-offline');s.online(false);s.c:onEvent('suspend')
assert(#s.requests==0 and s.q:status().pending==1)
s.c:onEvent('network');assert(#s.requests==0,'reconnection event does not send while asleep')
s.c:onEvent('resume');assert(#s.requests==0)
s.online(true);s.c:onEvent('network');assert(#s.requests==1,'reconnection sends immediately when awake')
s.c:stop();s.q:close()

s=setup('suspend-disabled',{syncOnSuspend=false});s.c:onEvent('suspend')
assert(#s.requests==0 and s.q:status().pending==1,'disabled option preserves capture')
s.c:onEvent('resume');assert(#s.requests==1);s.c:stop();s.q:close()
s=setup('suspend-paused',{paused=true});s.c:onEvent('suspend');s.c:onEvent('resume')
assert(#s.requests==0 and s.q:status().pending==1);s.q:close()

s=setup('suspend-auth');s.c:onEvent('suspend');s.requests[1].callback({status=401})
assert(s.c:status().blocked=='auth' and s.q:status().pending==1 and #s.jobs==0)
s.c:onEvent('resume');assert(#s.requests==1,'invalid token requires correction')
s.c.config.token=string.rep('x',32);s.c:onEvent('credentials');s.c:syncNow();assert(#s.requests==2)
s.c:stop();s.q:close()

s=setup('suspend-resume-race');s.c:onEvent('suspend');local sleeping=s.requests[1]
s.c:onEvent('resume');assert(sleeping.cancelled and #s.requests==2)
assert(s.requests[2].args.body==sleeping.args.body)
accepted(sleeping);assert(s.q:status().pending==1)
accepted(s.requests[2],'duplicate');assert(s.q:status().pending==0);s.c:stop();s.q:close()

s=setup('suspend-batch-limit');local events={}
for page=2,102 do events[#events+1]={nativeBookId=1,page=page,startTime=120+page,durationSeconds=40,totalPages=300}end
s.q:discover(s.doc,events,nil);s.c:onEvent('suspend')
assert(#json.decode(s.requests[1].args.body).events==100)
accepted(s.requests[1]);assert(s.q:status().pending==2 and #s.requests==1 and #s.jobs==0,'one bounded batch per suspension')
s.c:onEvent('resume');assert(#s.requests==2);accepted(s.requests[2]);assert(s.q:status().pending==0);s.c:stop();s.q:close()

-- A page scan may already be yielding when Suspend arrives. The bounded
-- request must include the final native capture, not freeze an earlier subset.
s=setup('suspend-capture-race');s.c:capture();local collects=0
s.c.collector.collect=function()
 collects=collects+1;if collects==1 then coroutine.yield()end
 s.q:discover(s.doc,{{nativeBookId=1,page=2,startTime=150,durationSeconds=30,totalPages=300}},nil);return true
end
local thread=coroutine.create(function()s.c:onEvent('page')end);assert(coroutine.resume(thread))
s.c:onEvent('suspend');assert(#s.requests==0,'suspend waits for ongoing native capture')
s.c:onEvent('page');s.c:onEvent('network')
assert(coroutine.resume(thread));assert(#s.requests==1 and #json.decode(s.requests[1].args.body).events==2)
accepted(s.requests[1]);assert(s.q:status().pending==0);s.q:close()

s=setup('resume-capture-race');s.c:capture();collects=0
s.c.collector.collect=function()collects=collects+1;if collects==1 then coroutine.yield()end;return true end
thread=coroutine.create(function()s.c:onEvent('page')end);assert(coroutine.resume(thread))
s.c:onEvent('suspend');s.c:onEvent('resume');assert(#s.requests==0)
assert(coroutine.resume(thread));assert(#s.requests==1 and s.requests[1].args.timeout==15,'resume replaces deferred suspension attempt')
s.c:stop();s.q:close()
