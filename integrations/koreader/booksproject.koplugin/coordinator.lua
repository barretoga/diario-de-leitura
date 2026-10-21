local Transport=require('booksproject.transport');local Coordinator={};Coordinator.__index=Coordinator
local failureCodes={auth=true,tls=true,network=true,timeout=true,busy=true,cancelled=true,configuration=true,response=true,protocol=true,invalid_request=true,body_too_large=true,protocol_incompatible=true,batch_conflict=true,activation_bound=true,timezone_bound=true,invalid_timezone=true,server=true,server_mismatch=true}
local SERVER_MISMATCH='Servidor diferente do vinculado; fila preservada'
function Coordinator.new(source,collector,queue,transport,scheduler,config)
    local blocked=queue:get('transportBlocked');local mismatch=blocked and queue:get('transportBlockCode')=='server_mismatch'
    return setmetatable({source=source,collector=collector,queue=queue,transport=transport,scheduler=scheduler,config=config,active=true,retries=0,blocked=blocked,error=mismatch and SERVER_MISMATCH or nil,captureError=queue:get('captureError') or nil},Coordinator)
end
function Coordinator:cancelTimer() if self.timer then self.scheduler:cancel(self.timer);self.timer=nil end end
function Coordinator:schedule(seconds)
    self:cancelTimer();self.timer=self.scheduler:schedule(seconds,function()self.timer=nil;self:send()end)
end
function Coordinator:cancelPeriodic()
    if self.periodic then self.scheduler:cancel(self.periodic);self.periodic=nil end
end
function Coordinator:startPeriodic()
    if self.periodic or not self.active then return end
    self.periodic=self.scheduler:schedule(300,function()
        self.periodic=nil
        if not self.active then return end
        self:onEvent('periodic')
        self:startPeriodic()
    end)
end
function Coordinator:capture()
    if self.collecting then self.captureAgain=true;return end
    self.collecting=true;local ok,value,why=pcall(self.collector.collect,self.collector);self.collecting=false
    if not ok or not value then self.captureError=ok and why or 'Falha ao capturar estatísticas; preserve os bancos';self.queue:set('captureError',self.captureError)
    else self.captureError=nil;self.queue:set('captureError',false) end
    if self.captureAgain then self.captureAgain=false;self:capture() end
    if self.afterCapture then local callback=self.afterCapture;self.afterCapture=nil;callback() end
end
function Coordinator:captureProgress()
    local ok=pcall(self.collector.collectProgress,self.collector)
    if not ok then
        self.captureError='Falha ao capturar o progresso final; pendências preservadas'
        self.queue:set('captureError',self.captureError)
    end
end
function Coordinator:rememberServer(serverId)
    if not Transport.validServerId(serverId) then return true end
    local known=self.queue:get('serverId');if not known then self.queue:set('serverId',serverId);return true end
    if known==serverId then return true end
    self.blocked='protocol';self.error=SERVER_MISMATCH;self.queue:set('transportBlocked','protocol');self.queue:set('transportBlockCode','server_mismatch')
    return false
end
function Coordinator:send(beforeSuspend,finished)
    local permitted=beforeSuspend and self.suspending or (self.active and self.source:isActive())
    if self.busy or self.blocked or self.config.paused or not permitted or not self.source:isOnline() then return false end
    if not self.queue:get('activationUnix') then return false end
    local url=self.queue:get('url');if self.config.url~=url then self.error='URL vinculada difere da configuração';return false end
    local batch=self.queue:freezeNext(self.config.uuid());if not batch then return false end
    local clock=self.config.clock or os.time
    self.queue:set('lastAttempt',{at=clock(),pending=self.queue:status().pending})
    self.busy=true;local current=(self.serial or 0)+1;self.serial=current
    self.transport:send(url,self.config.token,batch,function(response,err)
        if self.serial~=current then return end;self.busy=false
        if response and not self:rememberServer(response.serverId) then
            self.queue:set('lastFailure',{at=clock(),kind='protocol',code='server_mismatch'})
            if finished then finished() end;return
        end
        if response then
            local ok=pcall(self.queue.ack,self.queue,batch.batchId,response)
            if not ok then err={kind='protocol',code='response',message='Confirmação incompleta; lote preservado'} end
        end
        if err then
            self.error=err.message
            self.queue:set('lastFailure',{at=clock(),kind=err.kind=='auth' and 'auth' or err.kind=='transient' and 'transient' or 'protocol',code=failureCodes[err.code] and err.code or 'protocol',stage=err.stage,reason=err.reason})
            if err.kind=='transient' then self.retries=self.retries+1;if self.active and not self.config.paused then self:schedule(math.min(30,2^(math.min(self.retries-1,5)))) end
            elseif err.kind~='cancelled' then
                self.blocked=err.kind;self.queue:set('transportBlocked',err.kind);self.queue:set('transportBlockCode',err.code or 'protocol')
                if err.kind=='protocol' and (err.code=='invalid_request' or err.code=='body_too_large') then self.queue:rejectBatch(batch.batchId,err.code) end
            end
        else
            -- A confirmed batch may leave many progress snapshots/documents.
            -- Continue on the next UI tick instead of adding 30s per batch.
            self.queue:set('lastOutcome',{at=clock(),pending=self.queue:status().pending})
            self.retries=0;self.error=nil;if self.active and not self.config.paused then self:schedule(0) end
        end
        if finished then finished() end
    end,beforeSuspend and 5 or 15)
    return true
end
function Coordinator:onEvent(name)
    if self.config.ensureActivation then local _,why=self.config.ensureActivation();self.activationError=why end
    if name=='credentials' and self.blocked=='auth' then self.blocked=nil;self.queue:set('transportBlocked',false) end
    if name=='revalidate' and self.blocked=='protocol' then
        local code=self.queue:get('transportBlockCode');if code=='invalid_request' or code=='body_too_large' then self.blocked=nil;self.queue:set('transportBlocked',false) end
    end
    if name=='resume' then self:stop() end
    if name=='resume' or name=='startup' or name=='readerReady' then self.active=true;self.source.active=true end
    if name=='suspend' or name=='close' then self:stop();self.suspending=true end
    local current=self.serial
    local function captured()
        if self.serial~=current then return end
        -- Native capture stays inactive (no UI yield) during suspension. Only
        -- this attempt may send; its callback cannot schedule sleeping retries.
        if name=='suspend' or name=='close' then
            if name=='close' or self.config.syncOnSuspend~=false then self:send(true) end
            return
        end
        if name=='resume' or name=='network' or name=='periodic' then self:cancelTimer();self:send();return end
        if self.active and not self.config.paused and not self.blocked and not self.timer and not self.busy then self:schedule(30) end
    end
    self:capture()
    if self.collecting then
        -- Page/network chatter must not replace a pending lifecycle action.
        if name=='suspend' or name=='close' or name=='resume' or not self.afterCapture then self.afterCapture=captured end
    else captured() end
    self:startPeriodic()
end
function Coordinator:syncNow() self:capture();self:cancelTimer();self:send() end
function Coordinator:connectionVerified(url,serverId)
    if url~=self.queue:get('url') or url~=self.config.url then return false end
    if not self:rememberServer(serverId) then return false end
    local code=self.queue:get('transportBlockCode')
    local recoverable={tls=true,configuration=true,protocol_incompatible=true,response=true,protocol=true}
    if self.blocked=='auth' or (self.blocked=='protocol' and recoverable[code]) then
        self.blocked=nil;self.error=nil;self.retries=0
        self.queue:set('transportBlocked',false);self.queue:set('transportBlockCode',false)
    end
    return not self.blocked
end
function Coordinator:serverMigrated()
    -- The new URL proved the memorized identity: migration is the only exit from server_mismatch.
    -- Auth/recoverable blocks are cleared by connectionVerified; non-recoverable ones stay.
    if not self.blocked or self.queue:get('transportBlockCode')~='server_mismatch' then return end
    self.blocked=nil;self.error=nil;self.retries=0;self.queue:set('transportBlocked',false);self.queue:set('transportBlockCode',false)
end
function Coordinator:setPaused(value) self.config.paused=value;if value then self:cancelTimer();self.serial=(self.serial or 0)+1;self.transport:cancel();self.busy=false else self:onEvent('resume') end end
function Coordinator:stop() self.active=false;self.source.active=false;self.suspending=false;self:cancelTimer();self:cancelPeriodic();self.serial=(self.serial or 0)+1;self.transport:cancel();self.busy=false end
function Coordinator:finishClose(dispose)
    if self.disposing then return end
    self.disposing=true;self:stop();self.suspending=true
    local done=false
    local function finish()
        if done then return end;done=true
        if self.disposeTimer then self.scheduler:cancel(self.disposeTimer);self.disposeTimer=nil end
        self:stop();self.disposing=false;dispose()
    end
    local function captured()
        -- Start the deadline after native capture completes, so a collector
        -- already yielding can never resume against a closed SQLite connection.
        self.disposeTimer=self.scheduler:schedule(5,finish)
        if not self:send(true,finish) then finish() end
    end
    if self.collecting then self.captureAgain=true;self.afterCapture=captured
    else self:capture();captured() end
end
function Coordinator:status()
    local status=self.queue:status();status.active=self.active and self.source:isActive();status.paused=self.config.paused
    status.error=self.error or self.activationError or self.captureError;status.blocked=self.blocked
    status.lastAttempt=self.queue:get('lastAttempt');status.lastFailure=self.queue:get('lastFailure');status.lastOutcome=self.queue:get('lastOutcome')
    if status.paused then status.phase='paused'
    elseif status.blocked then status.phase='blocked'
    elseif self.collecting then status.phase='capturing'
    elseif self.busy then status.phase='sending'
    elseif self.captureError then status.phase='capture_error'
    elseif not status.activationUnix then status.phase='unconfigured'
    elseif not status.active then status.phase='sleeping'
    elseif not self.source:isOnline() then status.phase='offline'
    elseif status.diagnostics>0 and status.pending==0 then status.phase='issues'
    elseif status.pending>0 then status.phase='waiting'
    else status.phase='synced' end
    return status
end
return Coordinator
