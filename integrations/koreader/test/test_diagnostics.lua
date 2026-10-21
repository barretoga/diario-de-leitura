local Queue=require('queue');local Coordinator=require('coordinator');local Transport=require('transport');local json=require('dkjson')
local path=TEST_DIR..'/diagnostics-state.sqlite'
local q=Queue.open(path,{});q:activate(100,'device','generation','https://books.example')
local doc={documentId=string.rep('a',32),title='Sociedade liquida',author=''}
q:discover(doc,{{nativeBookId=1,page=1,startTime=120,durationSeconds=60,totalPages=300}},{capturedAt='2026-10-08T20:00:00.000Z',percent=20})
local source={active=true,isActive=function(self)return self.active end,isOnline=function(self)return self.online~=false end}
local jobs={};local scheduler={schedule=function(_,seconds,fn)local job={fn=fn};jobs[#jobs+1]=job;return job end,cancel=function(_,job)job.cancelled=true end}
local requests={};local adapter={request=function(_,args,cb)local r={args=args,cb=cb};requests[#requests+1]=r;return function()r.cancelled=true end end}
local now=200;local config={url='https://books.example',token=string.rep('secret',8),clock=function()return now end,uuid=function()return 'diagnostic-batch' end}
local c=Coordinator.new(source,{collect=function()return true end},q,Transport.new(adapter),scheduler,config)
assert(c:status().phase=='waiting','pending queue must be distinguished from a completed sync')
source.online=false;assert(c:status().phase=='offline');source.online=true
c:syncNow();assert(c:status().phase=='sending')
local waiting=json.decode(requests[1].args.body)
assert(c:status().lastAttempt.at==200 and c:status().lastAttempt.pending==2)
requests[1].cb({error={kind='protocol',code='tls',stage='handshake',reason='unknown',message=config.token}})
local failure=c:status().lastFailure
assert(failure.at==200 and failure.kind=='protocol' and failure.code=='tls' and failure.stage=='handshake' and failure.reason=='unknown')
assert(not json.encode(failure):find(config.token,1,true),'diagnostic never persists raw remote exceptions or token')
assert(c:status().phase=='blocked')
c:stop();q:close();q=Queue.open(path,{});source.active=true;c=Coordinator.new(source,{collect=function()return true end},q,Transport.new(adapter),scheduler,config)
assert(c:status().lastFailure.stage=='handshake','last failure must remain visible after restart')
local documents=q:pendingDocuments(10)
assert(#documents==1 and documents[1].title=='Sociedade liquida' and documents[1].events==1 and documents[1].progress==1)
assert(c:connectionVerified(config.url));c:syncNow()
assert(requests[2].args.body==requests[1].args.body,'diagnostics must not alter frozen data')
now=210
requests[2].cb({status=200,body=json.encode({protocolVersion=1,batchId=waiting.batchId,events={{index=0,status='accepted',reason=json.null}},progress={status='accepted',reason=json.null},document={state='linked'}})})
assert(c:status().phase=='synced' and c:status().lastOutcome.at==210 and c:status().lastOutcome.pending==0)
assert(#q:pendingDocuments(10)==0)
q:diagnostic('source_conflict',1,doc.documentId,'Evento nativo alterado','event')
assert(c:status().phase=='issues','rejected documents cannot be shown as synchronized')
assert(q:pendingDocuments(10)[1].problems==1)
c:setPaused(true);assert(c:status().phase=='paused');c:stop();q:close()
do
 local widget={};function widget:extend(value)value.__index=value;function value:new(args)args=args or {};setmetatable(args,value);return args end;return value end
 package.preload['ui/widget/container/widgetcontainer']=function()return widget end
 package.preload['luasettings']=package.preload['luasettings'] or function()return {open=function()return {readSetting=function(_,_,d)return d end,saveSetting=function()end,flush=function()end}end}end
 for _,name in ipairs({'infomessage','inputdialog','confirmbox','textviewer'})do package.preload['ui/widget/'..name]=package.preload['ui/widget/'..name] or function()return {new=function(_,v)return v end}end end
 package.preload['ui/uimanager']=package.preload['ui/uimanager'] or function()return {show=function()end,close=function()end}end
 local Plugin=require('main')
 local text=Plugin.diagnosticText({queue={pendingDocuments=function()return {} end},coordinator={status=function()return {phase='blocked',pending=0,diagnostics=0,lastFailure={at=200,kind='protocol',code='tls',stage='handshake',reason='unknown'}}end}})
 assert(text:find('protocol / tls / handshake / unknown',1,true),text)
end
