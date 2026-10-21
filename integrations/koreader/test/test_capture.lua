local Queue=require('queue')
local Collector=require('collector')
local q=Queue.open(TEST_DIR..'/queue.sqlite',{uuid=function() return 'bc5ba97b-d778-416f-a488-026e9955a09f' end})
q:activate(100,'device','generation','https://books.example')
local rows={{rowid=1,documentId=string.rep('a',32),title='Livro',author='',nativeBookId=1,page=1,startTime=99,durationSeconds=40,totalPages=300},
 {rowid=2,documentId=string.rep('a',32),title='Livro',author='',nativeBookId=1,page=2,startTime=120,durationSeconds=40,totalPages=300}}
local flushed=false
local source={check=function()return true end,flush=function()flushed=true;return true end,currentProgress=function()return nil end,
 scan=function(_,after,limit) assert(flushed);local out={};for _,r in ipairs(rows) do if r.rowid>after then table.insert(out,r) end end;return out,nil end}
local collector=Collector.new(source,q,function()return 200 end)
assert(collector:collect());assert(q:status().events==1)
table.insert(rows,{rowid=3,documentId=string.rep('a',32),title='Renomeado',author='',nativeBookId=1,page=3,startTime=110,durationSeconds=35,totalPages=300})
assert(collector:collect());assert(q:status().events==2)
assert(collector:collect());assert(q:status().events==2)
rows[2].durationSeconds=41;assert(collector:collect());assert(q:status().diagnostics==1)
q:close()
local Native=require('native')
local source2=Native.new({}, {settingsDir=TEST_DIR})
local ok=source2:check();assert(not ok);assert(io.open(TEST_DIR..'/statistics.sqlite3','rb')==nil)
local SQ=require('lua-ljsqlite3/init');local db=SQ.open(TEST_DIR..'/statistics.sqlite3')
db:exec('CREATE TABLE book(id INTEGER PRIMARY KEY,title TEXT,authors TEXT,md5 TEXT); CREATE TABLE page_stat_data(id_book INTEGER,page INTEGER,start_time INTEGER,duration INTEGER,total_pages INTEGER); PRAGMA user_version=99;');db:close()
assert(not source2:check())
db=SQ.open(TEST_DIR..'/statistics.sqlite3');db:exec('PRAGMA user_version=20221111');db:close()
assert(source2:check())
local result=source2:scan(0,100);assert(#result==0)
local stats={settings={is_enabled=false}};assert(not Native.new({statistics=stats},{settingsDir=TEST_DIR}):check())
assert(not Native.new({document={is_pic=true},statistics={settings={is_enabled=true}}},{settingsDir=TEST_DIR}):check())

