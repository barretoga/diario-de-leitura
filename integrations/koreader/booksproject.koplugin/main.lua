local path=debug.getinfo(1,'S').source:sub(2):match('^(.*[/\\])')
for _,name in ipairs({'sqlite','queue','collector','native','transport','coordinator','native_http'})do
    package.preload['booksproject.'..name]=function()return dofile(path..name..'.lua')end
end
local Widget=require('ui/widget/container/widgetcontainer');local UI=require('ui/uimanager');local DataStorage=require('datastorage')
local Settings=require('luasettings');local Info=require('ui/widget/infomessage');local Input=require('ui/widget/inputdialog')
local Queue=require('booksproject.queue');local Native=require('booksproject.native');local Collector=require('booksproject.collector')
local Transport=require('booksproject.transport');local Coordinator=require('booksproject.coordinator');local HTTP=require('booksproject.native_http')
local Plugin=Widget:extend{name='booksproject',is_doc_only=false}
local function uuid()
    local file=assert(io.open('/dev/urandom','rb'),'Identidade indisponível');local bytes=file:read(16);file:close();assert(bytes and #bytes==16,'Identidade indisponível')
    local values={bytes:byte(1,16)};values[7]=64+values[7]%16;values[9]=128+values[9]%64
    local hex={};for i,v in ipairs(values)do hex[i]=string.format('%02x',v)end
    return table.concat(hex,'',1,4)..'-'..table.concat(hex,'',5,6)..'-'..table.concat(hex,'',7,8)..'-'..table.concat(hex,'',9,10)..'-'..table.concat(hex,'',11,16)
end
local phaseLabels={paused='Envios pausados',blocked='Envio bloqueado; consulte Diagnóstico',capturing='Capturando estatísticas',sending='Enviando lote',capture_error='Falha na captura; consulte Diagnóstico',unconfigured='Coleta ainda não ativada',sleeping='Leitor inativo; envio aguardando retomada',offline='Sem rede; fila preservada',issues='Itens com problemas; consulte Problemas',waiting='Aguardando envio',synced='Nenhuma pendência para enviar'}
local function timestamp(value)return value and os.date('%d/%m %H:%M:%S',value) or '—'end
function Plugin:info(message)UI:show(Info:new{text=message})end
function Plugin:diagnosticText()
    local state=self.coordinator:status()
    local lines={phaseLabels[state.phase] or 'Confira o estado',string.format('%d pendências · %d problemas',state.pending,state.diagnostics)}
    if state.error then lines[#lines+1]=state.error end
    lines[#lines+1]='Última tentativa: '..timestamp(state.lastAttempt and state.lastAttempt.at)
    if state.lastAttempt then lines[#lines+1]=string.format('Na tentativa: %d itens na fila',state.lastAttempt.pending)end
    lines[#lines+1]='Última confirmação: '..timestamp(state.lastReceipt)
    if state.lastOutcome then lines[#lines+1]=string.format('Após a confirmação: %d pendências',state.lastOutcome.pending)end
    if state.lastFailure then
        local failure=state.lastFailure
        lines[#lines+1]='Último erro: '..timestamp(failure.at)..' · '..failure.kind..' / '..failure.code..(failure.stage and ' / '..failure.stage or '')..(failure.reason and ' / '..failure.reason or '')
    else lines[#lines+1]='Último erro de envio: nenhum registrado' end
    lines[#lines+1]='\nFila por livro (até 10):'
    local documents=self.queue:pendingDocuments(10)
    for _,doc in ipairs(documents)do
        lines[#lines+1]=string.format('%s\n%d leituras · %d progressos · %d problemas',doc.title:sub(1,200),doc.events,doc.progress,doc.problems)
    end
    if #documents==0 then lines[#lines+1]='Nenhum item aguardando envio ou correção' end
    lines[#lines+1]='\nTestar conexão verifica o acesso. A confirmação é do servidor; o celular precisa sincronizar sua biblioteca.'
    return table.concat(lines,'\n')
end
function Plugin:init()
    self.settings_file=DataStorage:getSettingsDir()..'/booksproject.lua';self.settings_obj=Settings:open(self.settings_file)
    self.config=self.settings_obj:readSetting('config',{url='',token='',paused=false});self.config.clock=os.time;self.config.uuid=uuid
    if self.config.syncOnSuspend==nil then self.config.syncOnSuspend=true end
    local ok,queue=pcall(Queue.open,DataStorage:getSettingsDir()..'/booksproject-queue.sqlite',{})
    if not ok then self.initializationError='Fila indisponível ou incompatível. Preserve os arquivos do plugin.';self.ui.menu:registerToMainMenu(self);return end
    self.queue=queue;self.source=Native.new(self.ui);self.collector=Collector.new(self.source,queue,os.time)
    self.transport=Transport.new(HTTP.new{caFile=self.path..'/cacert.pem'},os.time)
    local scheduler={schedule=function(_,seconds,fn)UI:scheduleIn(seconds,fn);return fn end,cancel=function(_,fn)UI:unschedule(fn)end}
    self.coordinator=Coordinator.new(self.source,self.collector,queue,self.transport,scheduler,self.config)
    self.config.ensureActivation=function()return self:ensureActivation()end
    self.ui.menu:registerToMainMenu(self);self:deferEvent('startup')
end
function Plugin:saveConfig()
    self.settings_obj:saveSetting('config',{url=self.config.url,token=self.config.token,paused=self.config.paused,syncOnSuspend=self.config.syncOnSuspend});self.settings_obj:flush()
end
function Plugin:configure(key,value)
    if not self.queue then return nil end
    if key=='url' then
        local normalized=Transport.normalizeUrl(value);if not normalized then self:info('Informe uma URL HTTPS sem usuário, senha ou parâmetros');return nil end
        local bound=self.queue:get('url');if bound and normalized~=bound then self:info('Servidor já vinculado; preserve esta URL');return nil end
        self.config.url=normalized
    elseif key=='token' then
        if type(value)~='string' or #value<32 or value:find('[\r\n]')then self:info('Informe o token pessoal com pelo menos 32 caracteres');return nil end
        self.config.token=value
    else return nil end
    self:saveConfig();self:deferEvent('credentials');return true
end
function Plugin:input(key)
    local dialog;dialog=Input:new{title=key=='url' and 'Servidor pessoal HTTPS' or 'Token pessoal',input=key=='token' and '' or self.config.url,text_type=key=='token' and 'password' or nil,
      buttons={{{text='Cancelar',callback=function()UI:close(dialog)end},{text='Salvar',is_enter_default=true,callback=function()if self:configure(key,dialog:getInputText())then UI:close(dialog)end end}}}}
    UI:show(dialog);if dialog.onShowKeyboard then dialog:onShowKeyboard()end
end
local function sameServerUrl(a,b)
    local function key(url)local host,rest=url:match('^https://([^/:]+)(.*)$');return host and 'https://'..host:lower()..rest or url end
    return a and b and key(a)==key(b)
end
function Plugin:migrate(newUrl,done)
    local function finish(ok,message)self:info(message);if done then done(ok,message)end;return ok end
    if not self.queue then return nil end
    local normalized=Transport.normalizeUrl(newUrl);if not normalized then return finish(false,'Informe uma URL HTTPS sem usuário, senha ou parâmetros')end
    if sameServerUrl(normalized,self.queue:get('url'))then return finish(false,'Esta já é a URL vinculada')end
    local known=self.queue:get('serverId');if not known then return finish(false,'Sincronize uma vez pelo endereço atual antes de migrar\nNo Kindle, use Testar conexão pelo endereço atual.')end
    if self.coordinator.busy then return finish(false,'Aguarde o envio atual')end
    self.transport:serverInfo(normalized,self.config.token,function(response,err)
        if self.closed then return end
        if not response then return finish(false,err.message)end
        if response.serverId~=known then return finish(false,'O novo endereço leva a outro servidor; nada foi alterado')end
        if not pcall(self.queue.migrateUrl,self.queue,normalized,response.serverId)then return finish(false,'O novo endereço leva a outro servidor; nada foi alterado')end
        self.config.url=normalized;self:saveConfig();self.coordinator:serverMigrated();self.coordinator:connectionVerified(normalized,response.serverId)
        finish(true,self.config.paused and 'Servidor migrado; envios pausados' or 'Servidor migrado; enviando pendências');self.coordinator:syncNow()
    end)
end
function Plugin:activate()
    if not self.queue then return nil end
    if self.source:isReaderOpen()then self:info('Feche o livro antes de ativar a coleta');return nil end
    if not Transport.normalizeUrl(self.config.url) or #self.config.token<32 then self:info('Configure a URL e o token pessoais primeiro');return nil end
    local checked,why=self.source:check();if not checked then self:info(why);return nil end
    if self.queue:get('activationUnix')then self:info('Coleta já ativada');return true end
    if not self:ensureActivation() then self:info('Não foi possível ativar. Preserve a configuração e a fila.');return nil end
    self:deferEvent('startup');self:info('Coleta ativada para novas leituras');return true
end
function Plugin:ensureActivation()
    if not self.queue then return nil end
    if self.queue:get('activationUnix') then return true end
    if not Transport.normalizeUrl(self.config.url) or type(self.config.token)~='string' or #self.config.token<32 then return nil,'Configure o servidor HTTPS e o token pessoal' end
    local checked,why=self.source:check();if not checked then return nil,why end
    local idsOK,device,generation=pcall(function()return self.config.uuid(),self.config.uuid()end);if not idsOK then return nil,'Não foi possível gerar a identidade do dispositivo' end
    local ok=pcall(self.queue.activate,self.queue,os.time(),device,generation,self.config.url)
    if not ok then return nil,'Não foi possível ativar a coleta. Preserve a configuração e a fila.' end
    return true
end
function Plugin:deferEvent(name)
    if not self.coordinator then return end
    if name=='suspend' or name=='close' or name=='resume' then
        self.lifecycleSerial=(self.lifecycleSerial or 0)+1;self.coordinator:stop()
    end
    local serial=self.lifecycleSerial
    UI:tickAfterNext(function()
        if self.closed or self.lifecycleSerial~=serial then return end
        require('ui/trapper'):wrap(function()if not self.closed and self.lifecycleSerial==serial then self.coordinator:onEvent(name)end end)
    end)
end
function Plugin:addToMainMenu(menu)
    if self.initializationError then menu.booksproject={text='Books Project',callback=function()self:info(self.initializationError)end};return end
    menu.booksproject={text='Books Project',sub_item_table={
      {text='Servidor HTTPS',enabled_func=function()return not self.queue:get('activationUnix')end,callback=function()self:input('url')end},
      {text='Migrar servidor',enabled_func=function()return self.queue:get('activationUnix')~=nil end,callback=function()
          local dialog;dialog=Input:new{title='Novo endereço do servidor HTTPS',input=self.queue:get('url') or self.config.url,
            buttons={{{text='Cancelar',callback=function()UI:close(dialog)end},{text='Migrar',is_enter_default=true,callback=function()
                local value=dialog:getInputText();UI:close(dialog)
                require('ui/network/manager'):runWhenConnected(function()if not self.closed then self:migrate(value)end end)
            end}}}}
          UI:show(dialog);if dialog.onShowKeyboard then dialog:onShowKeyboard()end
      end},
      {text='Token pessoal',callback=function()self:input('token')end},
      {text='Testar conexão',callback=function()require('ui/network/manager'):runWhenConnected(function()
          if self.closed then return end
          if self.coordinator.busy then self:info('Aguarde o envio atual');return end
          self.transport:testConnection(self.config.url,self.config.token,function(response,err)
              if self.closed then return end
              if response then self.coordinator:connectionVerified(self.config.url,response.serverId)end
              self:info(response and 'Conexão confirmada. Este teste não envia leituras; consulte Estado ou Diagnóstico.' or err.message)
          end)
      end)end},
      {text_func=function()return self.config.paused and 'Retomar envios' or 'Pausar envios'end,callback=function()self.coordinator:setPaused(not self.config.paused);self:saveConfig()end},
      {text='Sincronizar ao suspender',checked_func=function()return self.config.syncOnSuspend end,callback=function()self.config.syncOnSuspend=not self.config.syncOnSuspend;self:saveConfig()end},
      {text='Sincronizar agora',callback=function()require('ui/network/manager'):runWhenConnected(function()if self.closed then return end;require('ui/trapper'):wrap(function()if not self.closed then self.coordinator:syncNow()end end)end)end},
      {text='Revalidar pendências',callback=function()require('ui/trapper'):wrap(function()if self.closed then return end;self.coordinator:capture();if self.closed then return end;self.queue:revalidate();self.coordinator:onEvent('revalidate');if self.closed then return end;self.coordinator:syncNow()end)end},
      {text='Estado',callback=function()local state=self.coordinator:status();self:info(string.format('%d pendências · %d problemas\n%s\n%s\nÚltima tentativa: %s\nÚltima confirmação: %s',state.pending,state.diagnostics,phaseLabels[state.phase] or 'Confira o diagnóstico',state.error or '',timestamp(state.lastAttempt and state.lastAttempt.at),timestamp(state.lastReceipt)))end},
      {text='Diagnóstico',callback=function()UI:show(require('ui/widget/textviewer'):new{title='Diagnóstico Books Project',text=self:diagnosticText(),show_menu=false})end},
      {text='Problemas',callback=function()
          local rows=self.queue:issues(20);local messages={}
          for _,row in ipairs(rows)do messages[#messages+1]=(row.title or 'Documento')..' · '..row.item_kind..' '..row.item_id..'\n'..row.message end
          self:info(#messages>0 and table.concat(messages,'\n\n') or 'Nenhuma pendência rejeitada. Para falhas de conexão ou itens aguardando envio, consulte Diagnóstico.')
      end},
    }}
end
function Plugin:onPageUpdate()self:deferEvent('page')end
function Plugin:onPosUpdate()self:deferEvent('page')end
function Plugin:onReaderReady()self:deferEvent('readerReady')end
function Plugin:onDocumentRerendered()self:deferEvent('page')end
function Plugin:onNetworkConnected()self:deferEvent('network')end
function Plugin:onSuspend()self:deferEvent('suspend')end
function Plugin:onResume()self:deferEvent('resume')end
function Plugin:onCloseDocument()
    if self.closed or not self.coordinator then return end
    -- KOReader clears ui.document before CloseWidget. Persist this snapshot
    -- now, without yielding; native time is collected after statistics flush.
    self.coordinator:captureProgress();self:deferEvent('close')
end
function Plugin:onCloseWidget()
    if self.closed then return end
    self.closed=true
    if self.coordinator then
        self.coordinator:finishClose(function()self.queue:close()end)
    end
end
return Plugin
