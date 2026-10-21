local DB=require('booksproject.sqlite');local json=require('dkjson')
local Queue={};Queue.__index=Queue
local function decode(s) local value,_,err=json.decode(s);if err then error('Dados locais inválidos') end;return value end
local function array(values) return setmetatable(values or {},{__jsontype='array'}) end
local function eventKey(e) return table.concat({e.nativeBookId,e.page,e.startTime},':') end
function Queue.open(path,deps)
    local db=DB.open(path);db:exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;')
    local ok,err=pcall(function()DB.transaction(db,function()
        local version=DB.one(db,'PRAGMA user_version').user_version
        if version>2 then error('Banco do plugin de versão mais recente') end
        if version==0 then db:exec([[
          CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE documents(checksum TEXT PRIMARY KEY,title TEXT NOT NULL,author TEXT NOT NULL,progress_sequence INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,doc TEXT NOT NULL REFERENCES documents(checksum),event_key TEXT NOT NULL,content TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(doc,event_key));
          CREATE TABLE progress(id INTEGER PRIMARY KEY AUTOINCREMENT,doc TEXT NOT NULL REFERENCES documents(checksum),sequence INTEGER NOT NULL,content TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(doc,sequence));
          CREATE TABLE batches(id TEXT PRIMARY KEY,doc TEXT NOT NULL,json TEXT NOT NULL,state TEXT NOT NULL,response TEXT);
          CREATE TABLE batch_items(batch_id TEXT NOT NULL,kind TEXT NOT NULL,item_id INTEGER NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(batch_id,kind,item_id));
          CREATE TABLE diagnostics(kind TEXT NOT NULL,item_id INTEGER NOT NULL,doc TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(kind,item_id));
          PRAGMA user_version=1;
        ]]) end
        if version<2 then db:exec([[
          ALTER TABLE diagnostics RENAME TO diagnostics_v1;
          CREATE TABLE diagnostics(kind TEXT NOT NULL,item_id INTEGER NOT NULL,doc TEXT NOT NULL,message TEXT NOT NULL,item_kind TEXT NOT NULL,PRIMARY KEY(kind,item_kind,item_id));
          INSERT INTO diagnostics SELECT kind,item_id,doc,message,CASE WHEN message LIKE 'progress:%' THEN 'progress' ELSE 'event' END FROM diagnostics_v1;
          DROP TABLE diagnostics_v1;
          PRAGMA user_version=2;
        ]]) end
    end)end)
    if not ok then db:close();error(err) end
    return setmetatable({db=db,deps=deps or {}},Queue)
end
function Queue:get(key) local row=DB.one(self.db,'SELECT value FROM state WHERE key=?',key);return row and decode(row.value) end
function Queue:set(key,value) DB.run(self.db,'INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,json.encode(value)) end
function Queue:activate(at,device,generation,url)
    DB.transaction(self.db,function()
        if self:get('activationUnix') then
            if self:get('activationUnix')~=at or self:get('deviceId')~=device or self:get('generationId')~=generation or self:get('url')~=url then error('Integração já vinculada') end
            return
        end
        assert(type(at)=='number' and at>0 and type(device)=='string' and type(generation)=='string' and type(url)=='string','Ativação inválida')
        self:set('activationUnix',at);self:set('deviceId',device);self:set('generationId',generation);self:set('url',url)
    end)
end
function Queue:migrateUrl(url,serverId)
    DB.transaction(self.db,function()
        if type(serverId)~='string' or self:get('serverId')~=serverId then error('Servidor divergente') end
        assert(type(url)=='string','URL inválida');self:set('url',url)
    end)
end
function Queue:diagnostic(kind,id,doc,message,itemKind)
    DB.run(self.db,'INSERT INTO diagnostics VALUES(?,?,?,?,?) ON CONFLICT(kind,item_kind,item_id) DO UPDATE SET message=excluded.message,doc=excluded.doc',kind,id,doc,message,itemKind or 'event')
end
function Queue:discover(doc,events,snapshot)
    local activation=self:get('activationUnix');if not activation then return end
    DB.transaction(self.db,function()
        DB.run(self.db,'INSERT INTO documents(checksum,title,author) VALUES(?,?,?) ON CONFLICT(checksum) DO UPDATE SET title=excluded.title,author=excluded.author',doc.documentId,doc.title,doc.author)
        for _,e in ipairs(events) do
            if e.startTime>=activation and e.durationSeconds>0 then
                local key=eventKey(e);local content=json.encode(e)
                local old=DB.one(self.db,'SELECT * FROM events WHERE doc=? AND event_key=?',doc.documentId,key)
                if old then
                    local previous=decode(old.content)
                    if previous.durationSeconds~=e.durationSeconds or previous.totalPages~=e.totalPages then self:diagnostic('source_conflict',old.id,doc.documentId,'Evento nativo alterado; preserve os bancos para diagnóstico') end
                else DB.run(self.db,"INSERT INTO events(doc,event_key,content,state) VALUES(?,?,?,'pending')",doc.documentId,key,content) end
            end
        end
        if snapshot then
            local last=DB.one(self.db,'SELECT content FROM progress WHERE doc=? ORDER BY sequence DESC LIMIT 1',doc.documentId)
            local previous=last and decode(last.content)
            if not previous or previous.capturedAt~=snapshot.capturedAt or previous.percent~=snapshot.percent then
                local sequence=DB.one(self.db,'SELECT progress_sequence FROM documents WHERE checksum=?',doc.documentId).progress_sequence+1
                DB.run(self.db,'UPDATE documents SET progress_sequence=? WHERE checksum=?',sequence,doc.documentId)
                DB.run(self.db,"INSERT INTO progress(doc,sequence,content,state) VALUES(?,?,?,'pending')",doc.documentId,sequence,json.encode({sequence=sequence,capturedAt=snapshot.capturedAt,percent=snapshot.percent}))
            end
        end
    end)
end
function Queue:freezeNext(batchId)
    return DB.transaction(self.db,function()
        local old=DB.one(self.db,"SELECT id,json FROM batches WHERE state='waiting' ORDER BY rowid LIMIT 1")
        if old then return {batchId=old.id,json=old.json} end
        local doc=DB.one(self.db,[[SELECT * FROM documents WHERE checksum NOT IN(SELECT doc FROM diagnostics WHERE kind='source_conflict')
          AND (EXISTS(SELECT 1 FROM events WHERE doc=checksum AND state='pending') OR EXISTS(SELECT 1 FROM progress WHERE doc=checksum AND state='pending')) ORDER BY rowid LIMIT 1]])
        if not doc then return nil end
        local rows=DB.all(self.db,"SELECT id,content FROM events WHERE doc=? AND state='pending' ORDER BY id LIMIT 100",doc.checksum)
        local p=DB.one(self.db,"SELECT id,content FROM progress WHERE doc=? AND state='pending' ORDER BY sequence LIMIT 1",doc.checksum)
        local events=array();for _,row in ipairs(rows) do events[#events+1]=decode(row.content) end
        local payload={protocolVersion=1,deviceId=self:get('deviceId'),generationId=self:get('generationId'),activationUnix=self:get('activationUnix'),batchId=batchId,
          document={documentId=doc.checksum,title=doc.title,author=doc.author},events=events,progress=p and decode(p.content) or json.null}
        local encoded=json.encode(payload)
        DB.run(self.db,"INSERT INTO batches(id,doc,json,state) VALUES(?,?,?,'waiting')",batchId,doc.checksum,encoded)
        for i,row in ipairs(rows) do DB.run(self.db,"UPDATE events SET state='sending' WHERE id=?",row.id);DB.run(self.db,'INSERT INTO batch_items VALUES(?,?,?,?)',batchId,'event',row.id,i-1) end
        if p then DB.run(self.db,"UPDATE progress SET state='sending' WHERE id=?",p.id);DB.run(self.db,'INSERT INTO batch_items VALUES(?,?,?,?)',batchId,'progress',p.id,0) end
        return {batchId=batchId,json=encoded}
    end)
end
function Queue:ack(batchId,response)
    assert(response.protocolVersion==1 and response.batchId==batchId,'Resposta incompatível')
    DB.transaction(self.db,function()
        local batch=DB.one(self.db,'SELECT * FROM batches WHERE id=?',batchId);assert(batch,'Lote inexistente')
        if batch.state=='acked' then return end
        local items=DB.all(self.db,'SELECT * FROM batch_items WHERE batch_id=? ORDER BY kind,position',batchId);local statuses={}
        local eventCount=0;for _,item in ipairs(items) do if item.kind=='event' then eventCount=eventCount+1 end end
        assert(type(response.events)=='table' and #response.events==eventCount,'Confirmação incompleta')
        for _,r in ipairs(response.events) do assert(type(r.index)=='number' and r.index>=0 and r.index<eventCount and r.index==math.floor(r.index) and not statuses[r.index],'Índice inválido');statuses[r.index]=r end
        for _,item in ipairs(items) do
            local r=item.kind=='event' and statuses[item.position] or response.progress
            assert(r and (r.status=='accepted' or r.status=='duplicate' or r.status=='invalid' or r.status=='source_conflict'),'Resultado inválido')
            local tableName=item.kind=='event' and 'events' or 'progress'
            local accepted=r.status=='accepted' or r.status=='duplicate'
            DB.run(self.db,'UPDATE '..tableName..' SET state=? WHERE id=?',accepted and 'acked' or r.status,item.item_id)
            if not accepted then self:diagnostic(r.status,item.item_id,batch.doc,item.kind..': '..(r.reason or 'Verifique a origem'),item.kind) end
        end
        DB.run(self.db,"UPDATE batches SET state='acked',response=? WHERE id=?",json.encode(response),batchId)
        self:set('lastReceipt',os.time())
    end)
end
function Queue:revalidate()
    DB.transaction(self.db,function()
        DB.run(self.db,"UPDATE events SET state='pending' WHERE state='invalid'");DB.run(self.db,"UPDATE progress SET state='pending' WHERE state='invalid'")
        DB.run(self.db,"DELETE FROM diagnostics WHERE kind='invalid'")
    end)
end
function Queue:rejectBatch(batchId,code)
    DB.transaction(self.db,function()
        local batch=DB.one(self.db,"SELECT * FROM batches WHERE id=? AND state='waiting'",batchId);if not batch then return end
        for _,item in ipairs(DB.all(self.db,'SELECT * FROM batch_items WHERE batch_id=?',batchId))do
            DB.run(self.db,'UPDATE '..(item.kind=='event' and 'events' or 'progress').." SET state='invalid' WHERE id=?",item.item_id)
            self:diagnostic('invalid',item.item_id,batch.doc,item.kind..': Confira metadados/relógio e revalide explicitamente',item.kind)
        end
        DB.run(self.db,"UPDATE batches SET state='rejected',response=? WHERE id=?",json.encode({code=code}),batchId)
    end)
end
function Queue:status()
    return {deviceId=self:get('deviceId'),generationId=self:get('generationId'),activationUnix=self:get('activationUnix'),url=self:get('url'),lastReceipt=self:get('lastReceipt'),
      events=DB.one(self.db,'SELECT COUNT(*) n FROM events').n,pending=DB.one(self.db,"SELECT (SELECT COUNT(*) FROM events WHERE state IN('pending','sending'))+(SELECT COUNT(*) FROM progress WHERE state IN('pending','sending')) n").n,
      diagnostics=DB.one(self.db,'SELECT COUNT(*) n FROM diagnostics').n}
end
function Queue:issues(limit)
    return DB.all(self.db,[[SELECT d.kind,d.item_kind,d.item_id,d.message,b.title FROM diagnostics d
      LEFT JOIN documents b ON b.checksum=d.doc ORDER BY d.doc,d.kind,d.item_kind,d.item_id LIMIT ?]],limit or 20)
end
function Queue:close() self.db:close() end
function Queue:pendingDocuments(limit)
    return DB.all(self.db,[[SELECT d.title,
      (SELECT COUNT(*) FROM events WHERE doc=d.checksum AND state IN('pending','sending')) events,
      (SELECT COUNT(*) FROM progress WHERE doc=d.checksum AND state IN('pending','sending')) progress,
      (SELECT COUNT(*) FROM diagnostics WHERE doc=d.checksum) problems
      FROM documents d WHERE EXISTS(SELECT 1 FROM events WHERE doc=d.checksum AND state IN('pending','sending'))
        OR EXISTS(SELECT 1 FROM progress WHERE doc=d.checksum AND state IN('pending','sending'))
        OR EXISTS(SELECT 1 FROM diagnostics WHERE doc=d.checksum)
      ORDER BY d.rowid LIMIT ?]],limit or 10)
end
return Queue
