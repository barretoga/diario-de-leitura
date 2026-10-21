-- Real queue/coordinator/transport; clock and native/network boundaries controlled.
local Queue=require('queue');local Coordinator=require('coordinator');local Transport=require('transport');local json=require('dkjson')
local now=0;local jobs={};local requests={};local online=true;local captures=0;local ids=0
local q=Queue.open(TEST_DIR..'/automatic.sqlite',{});q:activate(100,'device','generation','https://books.example')
local doc={documentId=string.rep('a',32),title='Livro',author=''}
local source={active=true,isActive=function(self)return self.active end,isOnline=function()return online end}
local collector={collect=function()
 captures=captures+1
 if captures>=2 then q:discover(doc,{{nativeBookId=1,page=captures,startTime=120+captures,durationSeconds=40,totalPages=300}},nil)end
 return true
end}
local scheduler={schedule=function(_,seconds,fn)local job={at=now+seconds,fn=fn};jobs[#jobs+1]=job;return job end,cancel=function(_,job)job.cancelled=true end}
local adapter={request=function(_,args,cb)local r={args=args,callback=cb};requests[#requests+1]=r;return function()r.cancelled=true end end}
local c=Coordinator.new(source,collector,q,Transport.new(adapter),scheduler,{url='https://books.example',token=string.rep('t',32),uuid=function()ids=ids+1;return 'auto-batch-'..ids end})
local function advance(target)
 while true do
  local chosen;for _,job in ipairs(jobs)do if not job.cancelled and not job.ran and job.at<=target and (not chosen or job.at<chosen.at)then chosen=job end end
  if not chosen then break end;now=chosen.at;chosen.ran=true;chosen.fn()
 end;now=target
end
local function ack(r)
 local b=json.decode(r.args.body);local events={};for i=1,#b.events do events[i]={index=i-1,status='accepted'}end
 r.callback({status=200,body=json.encode({protocolVersion=1,batchId=b.batchId,events=events,document={state='linked'}})})
end
c:onEvent('startup');advance(299);assert(captures==1 and #requests==0)
advance(300);assert(captures==2,'timer captures without page turns even after an empty queue');assert(#requests==1)
ack(requests[1]);advance(600);assert(captures==3 and #requests==2,'capture continues every five minutes')
ack(requests[2]);online=false;advance(900);assert(captures==4 and q:status().pending==1)
online=true;c:onEvent('network');assert(#requests==3);ack(requests[3])
c:setPaused(true);local count=captures;advance(1200);assert(captures>count and #requests==3,'pause keeps local capture without sending')
c:onEvent('suspend');count=captures;advance(1800);assert(captures==count,'no timer while asleep')
c:setPaused(false);assert(#requests==4);ack(requests[4])
local closed=false;c:finishClose(function()closed=true;q:close()end)
assert(#requests==5 and requests[5].args.timeout==5 and not closed,'close holds queue until bounded send finishes')
ack(requests[5]);assert(closed)
-- Late ACK after teardown cannot touch the closed connection.
ack(requests[5]);advance(2400)

local q2=Queue.open(TEST_DIR..'/close-retry.sqlite',{});q2:activate(100,'device','generation','https://books.example')
q2:discover(doc,{{nativeBookId=1,page=1,startTime=120,durationSeconds=40,totalPages=300}},nil)
local c2=Coordinator.new(source,{collect=function()return true end},q2,Transport.new(adapter),scheduler,c.config)
closed=false;c2:finishClose(function()closed=true;q2:close()end)
local interrupted=requests[#requests];interrupted.callback({error={kind='transient',code='timeout'}});assert(closed)
q2=Queue.open(TEST_DIR..'/close-retry.sqlite',{});c2.queue=q2;c2:onEvent('resume')
assert(requests[#requests].args.body==interrupted.args.body,'close timeout retains frozen payload through restart')
ack(interrupted);assert(q2:status().pending==1)
ack(requests[#requests]);assert(q2:status().pending==0);c2:stop();q2:close()
