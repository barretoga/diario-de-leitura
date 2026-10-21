local DB=require('booksproject.sqlite');local DataStorage=require('datastorage');local Native={};Native.__index=Native
function Native.new(ui,options) return setmetatable({ui=ui,options=options or {},active=true},Native) end
function Native:path() return (self.options.settingsDir or DataStorage:getSettingsDir())..'/statistics.sqlite3' end
function Native:check()
    local stats=self.ui.statistics
    if not stats and G_reader_settings then local settings=G_reader_settings:readSetting('statistics',{is_enabled=true});if settings.is_enabled==false then return nil,'Ative as estatísticas do KOReader' end end
    if stats and not stats.settings.is_enabled then return nil,'Ative as estatísticas do KOReader' end
    if self.ui.document and self.ui.document.is_pic then return nil,'Estatísticas indisponíveis no modo PIC' end
    if self.ui.document and not self.ui.doc_settings:readSetting('partial_md5_checksum') then return nil,'Documento sem checksum' end
    local ok,err=pcall(function()
        local db=DB.open(self:path(),'ro')
        local passed,why=pcall(function()
            assert(DB.one(db,'PRAGMA user_version').user_version==20221111,'Esquema de estatísticas incompatível')
            for tableName,columns in pairs({book={'id','title','authors','md5'},page_stat_data={'id_book','page','start_time','duration','total_pages'}}) do
                local found={};for _,column in ipairs(DB.all(db,'PRAGMA table_info('..tableName..')')) do found[column.name]=true end
                for _,column in ipairs(columns) do assert(found[column],'Esquema de estatísticas incompatível') end
            end
        end)
        db:close();if not passed then error(why) end
    end)
    if not ok then return nil,'Banco de estatísticas ausente ou incompatível; preserve os arquivos e verifique o KOReader' end
    return true
end
function Native:flush()
    if self.ui.statistics then local ok=pcall(self.ui.statistics.insertDB,self.ui.statistics);if not ok then return nil,'Falha ao salvar estatísticas nativas' end end
    return true
end
function Native:scan(after,limit)
    local db=DB.open(self:path(),'ro')
    local ok,rows=pcall(DB.all,db,[[SELECT p.rowid rowid,b.md5 documentId,b.title title,b.authors author,p.id_book nativeBookId,p.page page,p.start_time startTime,p.duration durationSeconds,p.total_pages totalPages
      FROM page_stat_data p JOIN book b ON b.id=p.id_book WHERE p.rowid>? AND p.duration>0 AND p.start_time>=? ORDER BY p.rowid LIMIT ?]],after,self.activationUnix or 0,limit)
    db:close();if not ok then error('Falha ao ler estatísticas nativas') end
    for _,row in ipairs(rows) do
        assert(type(row.documentId)=='string' and #row.documentId==32,'Documento nativo sem checksum')
        row.title=row.title or '';row.author=row.author or ''
    end
    return rows,#rows==limit and rows[#rows].rowid or nil
end
function Native:currentProgress()
    if not self.ui.document or not self.ui.doc_settings then return nil end
    local checksum=self.ui.doc_settings:readSetting('partial_md5_checksum');if not checksum then return nil end
    local engine=self.ui.document.info.has_pages and self.ui.paging or self.ui.rolling
    if not engine then return nil end
    local percent=engine:getLastPercent()*100
    local db=DB.open(self:path(),'ro');local row=DB.one(db,'SELECT title,authors FROM book WHERE md5=? ORDER BY id DESC LIMIT 1',checksum);db:close()
    if not row then return nil end
    return {document={documentId=checksum,title=row.title or '',author=row.authors or ''},snapshot={capturedAt=os.date('!%Y-%m-%dT%H:%M:%S.000Z'),percent=percent}}
end
function Native:isReaderOpen() return self.ui.document~=nil end
function Native:isActive() return self.active end
function Native:isOnline() return require('ui/network/manager'):isConnected() end
function Native:yield()
    if not self.active then return end
    local thread=coroutine.running();if not thread then return end
    require('ui/uimanager'):tickAfterNext(function()coroutine.resume(thread)end);coroutine.yield()
end
return Native
