local settings={};local shown
package.preload['luasettings']=function()return {open=function()return {readSetting=function(_,key,default)return settings[key] or default end,saveSetting=function(_,key,value)settings[key]=value end,flush=function()end}end}end
local widget={};function widget:extend(value)value.__index=value;function value:new(args)args=args or {};setmetatable(args,value);return args end;return value end
package.preload['ui/widget/container/widgetcontainer']=function()return widget end
local UI={show=function(_,value)shown=value end,close=function()end,scheduleIn=function()end,unschedule=function()end,tickAfterNext=function(_,fn)fn()end}
package.preload['ui/uimanager']=function()return UI end
for _,name in ipairs({'infomessage','inputdialog','confirmbox','textviewer'})do package.preload['ui/widget/'..name]=function()return {new=function(_,value)return value end}end end
package.preload['ui/trapper']=function()return {wrap=function(_,fn)fn()end}end
package.preload['ui/network/manager']=function()return {isConnected=function()return true end,runWhenConnected=function(_,fn)fn()end}end
local Plugin=require('main')
local plugin=Plugin:new{ui={menu={registerToMainMenu=function()end}},path=PLUGIN_DIR};plugin:init()
plugin.config.uuid=function()return 'menu-empty-batch'end
assert(plugin.queue:status().activationUnix==nil)
local menu={};plugin:addToMainMenu(menu);assert(menu.booksproject.sub_item_table)
local function findOption(m,text)for _,item in ipairs(m.booksproject.sub_item_table)do if item.text==text then return item end end end
local migrateOption=findOption(menu,'Migrar servidor');assert(migrateOption and not migrateOption.enabled_func(),'migration is disabled before activation')
plugin.ui.document={};assert(not plugin:activate());assert(plugin.queue:status().activationUnix==nil);plugin.ui.document=nil
assert(not plugin:configure('url','http://example.com'))
assert(plugin:configure('url','https://books.example'));assert(plugin:configure('token',string.rep('t',32)))
local before=plugin.queue:status();assert(before.deviceId==nil)
plugin:input('token');assert(shown.text_type=='password');assert(shown.input=='')
plugin.queue:activate(100,'device','generation','https://books.example');assert(migrateOption.enabled_func(),'migration is enabled after activation');assert(not plugin:configure('url','https://other.example'))
assert(plugin:configure('token',string.rep('x',32)));assert(plugin.queue:status().deviceId=='device')
plugin.queue:discover({documentId=string.rep('a',32),title='Sociedade liquida',author=''},{{nativeBookId=1,page=1,startTime=120,durationSeconds=60,totalPages=300}},nil)
plugin.coordinator.captureError=nil;plugin.queue:set('captureError',false)
plugin.queue:set('lastAttempt',{at=200,pending=1})
plugin.queue:set('lastFailure',{at=200,kind='protocol',code='tls',stage='handshake'})
local diagnosticOption,stateOption;for _,item in ipairs(menu.booksproject.sub_item_table)do if item.text=='Diagnóstico' then diagnosticOption=item elseif item.text=='Estado' then stateOption=item end end
assert(diagnosticOption,'diagnostics must be accessible from the real menu')
diagnosticOption.callback()
assert(shown.text:find('Sociedade liquida',1,true) and shown.text:find('handshake',1,true),'diagnostics must identify pending book and transport stage')
assert(shown.text:find('Última tentativa',1,true) and shown.text:find('leituras',1,true))
assert(not shown.text:find(plugin.config.token,1,true) and not shown.text:find(plugin.config.url,1,true),'menu diagnostics must omit credentials and server URL')
stateOption.callback();assert(shown.text:find('Aguardando envio',1,true),'Estado must distinguish pending work from success')
local diagnosticBatch=plugin.queue:freezeNext('menu-diagnostic-batch')
plugin.queue:ack(diagnosticBatch.batchId,{protocolVersion=1,batchId=diagnosticBatch.batchId,events={{index=0,status='accepted'}}})
plugin.transport.adapter.request=function()return function()end end
local deferred={};UI.tickAfterNext=function(_,fn)deferred[#deferred+1]=fn end
local waitingNetwork={};local manager=require('ui/network/manager');local originalRun=manager.runWhenConnected
manager.runWhenConnected=function(_,fn)waitingNetwork[#waitingNetwork+1]=fn end
for _,item in ipairs(menu.booksproject.sub_item_table)do if item.text=='Sincronizar agora' or item.text=='Testar conexão' then item.callback()end end
local closeCapture=0;plugin.collector.collect=function()closeCapture=closeCapture+1;return true end
plugin:onCloseDocument();plugin:onCloseWidget();assert(closeCapture==1,'close captures before queue disposal')
for _,fn in ipairs(deferred)do fn()end
assert(closeCapture==1)
for _,fn in ipairs(waitingNetwork)do assert(pcall(fn),'connection callbacks must not access a closed queue')end
manager.runWhenConnected=originalRun

-- Existing configurations gain the enabled option, and changing it survives
-- reinitialization. Deferred lifecycle callbacks cannot suspend a resumed UI.
deferred={}
local updated=Plugin:new{ui={menu={registerToMainMenu=function()end}},path=PLUGIN_DIR};updated:init()
local ids=0;updated.config.uuid=function()ids=ids+1;return 'menu-batch-'..ids end
local requests={}
updated.transport.adapter.request=function(_,args,cb)
 local request={args=args,cb=cb};requests[#requests+1]=request;return function()request.cancelled=true end
end
updated.collector.collect=function()
 updated.queue:discover({documentId=string.rep('b',32),title='Livro',author=''},{{nativeBookId=2,page=1,startTime=120,durationSeconds=30,totalPages=100}},nil);return true
end
local function drain()local tasks=deferred;deferred={};for _,fn in ipairs(tasks)do fn()end end
drain();menu={};updated:addToMainMenu(menu)
local option;for _,item in ipairs(menu.booksproject.sub_item_table)do if item.text=='Sincronizar ao suspender' then option=item end end
assert(option and option.checked_func(),'suspend sync is available and enabled for existing configuration')
option.callback();assert(not option.checked_func() and settings.config.syncOnSuspend==false)
updated:onSuspend();drain();assert(#requests==0 and updated.queue:status().pending==1)
updated:onResume();drain();assert(#requests==1)
option.callback();assert(option.checked_func() and settings.config.syncOnSuspend==true)
updated:onSuspend();assert(requests[1].cancelled);drain()
assert(#requests==2 and requests[2].args.timeout==5,'plugin actually dispatches bounded suspension request')
updated:onResume();drain();assert(requests[2].cancelled and #requests==3)
updated:onSuspend();updated:onResume();drain()
assert(updated.coordinator:status().active,'stale deferred suspension cannot override resume')
assert(requests[#requests].args.timeout==15)
option.callback();assert(settings.config.syncOnSuspend==false)
updated:onCloseWidget()
local reloaded=Plugin:new{ui={menu={registerToMainMenu=function()end}},path=PLUGIN_DIR};reloaded:init()
reloaded.config.uuid=function()return 'menu-reloaded-batch'end
reloaded.transport.adapter.request=function()return function()end end
assert(reloaded.config.syncOnSuspend==false,'disabled choice survives plugin reinitialization')
reloaded:onCloseWidget();drain()

-- Migrar servidor: the bound URL changes only after the new URL proves the
-- memorized serverId; every refusal leaves URL and configuration untouched.
local NEEDS_IDENTITY='Sincronize uma vez pelo endereço atual antes de migrar'
local OTHER_SERVER='O novo endereço leva a outro servidor; nada foi alterado'
local SAME_URL='Esta já é a URL vinculada'
local MIGRATED='Servidor migrado; enviando pendências'
local migrating=Plugin:new{ui={menu={registerToMainMenu=function()end}},path=PLUGIN_DIR};migrating:init();drain()
migrating.config.uuid=function()return 'menu-migrate-batch'end
menu={};migrating:addToMainMenu(menu);assert(findOption(menu,'Migrar servidor').enabled_func())
local served={};local reply
migrating.transport.adapter.request=function(_,args,cb)served[#served+1]=args;cb(reply);return function()end end
local syncs=0;migrating.coordinator.syncNow=function()syncs=syncs+1 end
local activation,device=migrating.queue:get('activationUnix'),migrating.queue:status().deviceId
local function migrate(url)local result;migrating:migrate(url,function(ok,message)result={ok=ok,message=message}end);assert(result,'migrate reports its outcome');assert(shown.text==result.message);return result end
local function unchanged()return migrating.queue:get('url')=='https://books.example' and migrating.config.url=='https://books.example' and settings.config.url=='https://books.example' and syncs==0 end
local function identity(id)return {status=200,body='{"protocolVersion":1,"serverId":"'..id..'"}'}end
reply=identity('s1')
assert(migrating.queue:get('serverId')==nil)
local result=migrate('https://new.example');assert(not result.ok and result.message:find(NEEDS_IDENTITY,1,true)==1 and #served==0 and unchanged())
assert(result.message:find('No Kindle, use Testar conexão pelo endereço atual.',1,true),'the Kindle hint points to Testar conexão, which also works while TLS-blocked')
migrating.queue:set('serverId','s1')
for _,same in ipairs({'https://books.example','https://books.example/','https://BOOKS.Example//'})do result=migrate(same);assert(not result.ok and result.message==SAME_URL,same)end
assert(#served==0 and unchanged())
result=migrate('http://new.example');assert(not result.ok and result.message=='Informe uma URL HTTPS sem usuário, senha ou parâmetros' and #served==0)
migrating.coordinator.busy=true;result=migrate('https://new.example');assert(not result.ok and result.message=='Aguarde o envio atual' and #served==0 and unchanged());migrating.coordinator.busy=false
reply=identity('s2');result=migrate('https://new.example/')
assert(not result.ok and result.message==OTHER_SERVER and #served==1 and served[1].url=='https://new.example/v1/server' and served[1].method=='GET' and unchanged())
assert(migrating.queue:get('serverId')=='s1' and not migrating.coordinator.blocked,'a foreign identity at the new URL does not block the bound server')
reply={status=401,body=''};result=migrate('https://new.example');assert(not result.ok and result.message=='Token pessoal inválido' and #served==2 and unchanged())
assert(not migrating.coordinator.blocked,'a failed migration probe does not block sending')
-- A mismatch at the old URL can only be resolved by proving identity elsewhere.
assert(not migrating.coordinator:rememberServer('elsewhere') and migrating.coordinator.blocked=='protocol' and migrating.queue:get('transportBlockCode')=='server_mismatch')
reply=identity('s1');result=migrate('https://new.example/')
assert(result.ok and result.message==MIGRATED and #served==3)
assert(migrating.queue:get('url')=='https://new.example' and migrating.config.url=='https://new.example' and settings.config.url=='https://new.example' and syncs==1)
assert(not migrating.coordinator.blocked and not migrating.coordinator.error and not migrating.queue:get('transportBlocked') and not migrating.queue:get('transportBlockCode'),'migration clears the mismatch block')
assert(migrating.queue:get('activationUnix')==activation and migrating.queue:status().deviceId==device and migrating.queue:get('serverId')=='s1')
assert(not findOption(menu,'Servidor HTTPS').enabled_func(),'Servidor HTTPS stays disabled after migration')
-- Paused sending: the migration succeeds but must not promise to send.
migrating.config.paused=true;result=migrate('https://third.example')
assert(result.ok and result.message=='Servidor migrado; envios pausados' and migrating.queue:get('url')=='https://third.example','paused migration does not claim to send')
migrating.config.paused=false;migrating:saveConfig();result=migrate('https://new.example')
assert(result.ok and result.message==MIGRATED and migrating.queue:get('url')=='https://new.example' and settings.config.url=='https://new.example' and not settings.config.paused)
migrating.transport.adapter.request=function()return function()end end;migrating:onCloseWidget();drain()
-- Review Focus 5: a reinitialized plugin sends to the migrated URL.
local fresh=Plugin:new{ui={menu={registerToMainMenu=function()end}},path=PLUGIN_DIR};fresh:init()
fresh.config.uuid=function()return 'menu-fresh-batch'end
local sent={};fresh.transport.adapter.request=function(_,args)sent[#sent+1]=args;return function()end end
drain();fresh.queue:discover({documentId=string.rep('c',32),title='Migrado',author=''},{{nativeBookId=3,page=1,startTime=130,durationSeconds=40,totalPages=50}},nil)
fresh.coordinator:send()
assert(fresh.coordinator.error~='URL vinculada difere da configuração' and fresh.config.url=='https://new.example')
assert(#sent>=1 and sent[#sent].url=='https://new.example/v1/koreader/ingest','reloaded plugin sends to the migrated URL')
fresh:onCloseWidget();drain()
