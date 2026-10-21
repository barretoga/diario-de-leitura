local saved={};local deferred={};local jobs={};local requests={}
package.preload['luasettings']=function()return {open=function()return {readSetting=function(_,key,default)return saved[key] or default end,saveSetting=function(_,key,value)saved[key]=value end,flush=function()end}end}end
local widget={};function widget:extend(value)value.__index=value;function value:new(args)args=args or {};setmetatable(args,value);return args end;return value end
package.preload['ui/widget/container/widgetcontainer']=function()return widget end
local UI={show=function()end,close=function()end,scheduleIn=function(_,seconds,fn)jobs[#jobs+1]={seconds=seconds,fn=fn}end,unschedule=function()end,tickAfterNext=function(_,fn)deferred[#deferred+1]=fn end}
package.preload['ui/uimanager']=function()return UI end
for _,name in ipairs({'infomessage','inputdialog','confirmbox'})do package.preload['ui/widget/'..name]=function()return {new=function(_,value)return value end}end end
package.preload['ui/trapper']=function()return {wrap=function(_,fn)fn()end}end
package.preload['ui/network/manager']=function()return {isConnected=function()return true end}end
local DB=require('sqlite');local Plugin=require('main')
local db=DB.open(TEST_DIR..'/statistics.sqlite3')
db:exec([[PRAGMA user_version=20221111;CREATE TABLE book(id INTEGER,title TEXT,authors TEXT,md5 TEXT);CREATE TABLE page_stat_data(id_book INTEGER,page INTEGER,start_time INTEGER,duration INTEGER,total_pages INTEGER);]])
db:close()
local function drain()local tasks=deferred;deferred={};for _,fn in ipairs(tasks)do fn()end end
local plugin=Plugin:new{ui={menu={registerToMainMenu=function()end}},path=PLUGIN_DIR};plugin:init()
local ids=0;plugin.config.uuid=function()ids=ids+1;return 'identity-'..ids end
drain();assert(not plugin.queue:get('activationUnix'),'configuration is required')
assert(plugin.coordinator:status().error=='Configure o servidor HTTPS e o token pessoal','inactive collection explains missing configuration')
assert(plugin:configure('url','https://books.example'));assert(not plugin.queue:get('activationUnix'))
plugin.ui.document={info={has_pages=false}};plugin.ui.doc_settings={readSetting=function()return string.rep('a',32)end}
assert(plugin:configure('token',string.rep('t',32)))
drain();assert(plugin.queue:get('activationUnix'),'valid configuration activates automatically, also with a book open')
assert(plugin.queue:get('deviceId')=='identity-1' and plugin.queue:get('generationId')=='identity-2')
local activated=plugin.queue:get('activationUnix')
assert(plugin:configure('token',string.rep('x',32)));drain()
assert(plugin.queue:get('activationUnix')==activated and ids==2,'credential updates preserve identity and cutoff')
plugin.ui.document=nil
plugin.ui.document={info={has_pages=true}}
plugin.ui.paging={getLastPercent=function()return 0.89 end}
local native=DB.open(TEST_DIR..'/statistics.sqlite3')
native:exec("INSERT INTO book VALUES(1,'Livro','Autor','"..string.rep('a',32).."');")
native:close()
plugin.queue:discover({documentId=string.rep('a',32),title='Livro',author='Autor'},{{nativeBookId=1,page=1,startTime=activated+1,durationSeconds=40,totalPages=300}},nil)
plugin.transport.adapter.request=function(_,args,cb)local r={args=args,callback=cb};requests[#requests+1]=r;return function()r.cancelled=true end end
plugin:onCloseDocument();plugin.ui.document=nil;plugin:onCloseWidget();drain()
assert(#requests==1 and requests[1].args.timeout==5,'widget teardown sends without waiting for deferred CloseDocument')
local sent=require('dkjson').decode(requests[1].args.body)
assert(sent.progress and sent.progress.percent==89,'final progress is captured before KOReader clears the document')
assert(plugin.queue:status().pending==2,'event and final progress stay available until transport completes')
requests[1].callback({error={kind='transient',code='timeout'}})
local q=require('queue').open(TEST_DIR..'/booksproject-queue.sqlite',{})
assert(q:status().pending==2 and q:get('deviceId')=='identity-1','teardown preserves pending content and identity')
q:close()

-- Revalidation can yield once per scan. Closing during its second capture
-- must cancel the remaining UI command rather than reopen the disposed queue.
native=DB.open(TEST_DIR..'/statistics.sqlite3')
for page=2,102 do DB.run(native,'INSERT INTO page_stat_data VALUES(?,?,?,?,?)',1,page,activated+1,40,300)end
native:close()
package.loaded['ui/network/manager'].isConnected=function()return false end
local reopened=Plugin:new{ui={menu={registerToMainMenu=function()end}},path=PLUGIN_DIR};reopened:init()
reopened.config.uuid=function()return 'revalidation-batch'end;drain()
local menu={};reopened:addToMainMenu(menu);local revalidate
for _,item in ipairs(menu.booksproject.sub_item_table)do if item.text=='Revalidar pendências' then revalidate=item.callback end end
local thread=coroutine.create(revalidate)
assert(coroutine.resume(thread));assert(coroutine.status(thread)=='suspended')
assert(coroutine.resume(thread));assert(coroutine.status(thread)=='suspended')
reopened:onCloseWidget()
local resumed,why=coroutine.resume(thread);assert(resumed,'revalidation continuation after close: '..tostring(why))
assert(coroutine.status(thread)=='dead')
