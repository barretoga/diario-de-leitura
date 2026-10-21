-- A single manual sync must continue through an accumulated queue while awake.
-- Real queue and transport; only network completion and time are controlled.
local Queue=require('queue');local Coordinator=require('coordinator');local Transport=require('transport');local json=require('dkjson')
local q=Queue.open(TEST_DIR..'/backlog.sqlite',{});q:activate(100,'device','generation','https://books.example')
local old={documentId=string.rep('a',32),title='Livro antigo',author=''}
for i=1,103 do q:discover(old,{}, {capturedAt=string.format('2026-10-08T20:%02d:%02d.000Z',math.floor(i/60),i%60),percent=20})end
for i,title in ipairs({'Sociedade liquida','Livro sobre a China'})do
 q:discover({documentId=string.rep(i==1 and 'b' or 'c',32),title=title,author=''},{{nativeBookId=i,page=1,startTime=120,durationSeconds=60,totalPages=300}},nil)
end
assert(q:status().pending==105)
local now=0;local jobs={};local requests={};local delivered={};local ids=0
local scheduler={schedule=function(_,seconds,fn)local job={at=now+seconds,fn=fn};jobs[#jobs+1]=job;return job end,cancel=function(_,job)job.cancelled=true end}
local adapter={request=function(_,args,callback)
 local r={args=args};requests[#requests+1]=r
 scheduler:schedule(1,function()
  if r.cancelled then return end
  local b=json.decode(args.body);delivered[b.document.title]=true;local events=setmetatable({},{__jsontype='array'})
  for i=1,#b.events do events[i]={index=i-1,status='accepted',reason=json.null}end
  callback({status=200,body=json.encode({protocolVersion=1,batchId=b.batchId,events=events,progress=b.progress~=json.null and {status='accepted',reason=json.null} or json.null,document={state='linked'}})})
 end)
 return function()r.cancelled=true end
end}
local source={active=true,isActive=function(self)return self.active end,isOnline=function()return true end}
local c=Coordinator.new(source,{collect=function()return true end},q,Transport.new(adapter),scheduler,{url='https://books.example',token=string.rep('t',32),uuid=function()ids=ids+1;return 'backlog-'..ids end})
c:syncNow()
while true do
 local nextJob;for _,job in ipairs(jobs)do if not job.cancelled and not job.ran and job.at<=120 and (not nextJob or job.at<nextJob.at)then nextJob=job end end
 if not nextJob then break end
 now=nextJob.at;nextJob.ran=true;nextJob.fn()
end
local remaining=q:status().pending
assert(remaining==0,'one sync left '..remaining..' of 105 queued items behind older progress snapshots')
assert(delivered['Sociedade liquida'] and delivered['Livro sobre a China'],'new books must reach the server behind an older progress backlog')
assert(#requests==105,'all snapshots and reading events must be acknowledged without dropping data')
local DB=require('sqlite')
assert(DB.one(q.db,"SELECT COUNT(*) n FROM progress WHERE state='acked'").n==103,'all original progress snapshots remain stored and acknowledged')
c:stop();q:close()
