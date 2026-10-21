local Collector={};Collector.__index=Collector
function Collector.new(source,queue,clock) return setmetatable({source=source,queue=queue,clock=clock},Collector) end
function Collector:collect()
    if not self.queue:get('activationUnix') then return true end
    self.source.activationUnix=self.queue:get('activationUnix')
    local ok,err=self.source:check();if not ok then return nil,err end
    ok,err=self.source:flush();if not ok then return nil,err end
    local after=0
    repeat
        local rows,nextAfter=self.source:scan(after,100)
        for _,row in ipairs(rows) do
            self.queue:discover({documentId=row.documentId,title=row.title,author=row.author},{{nativeBookId=row.nativeBookId,page=row.page,startTime=row.startTime,durationSeconds=row.durationSeconds,totalPages=row.totalPages}},nil)
        end
        after=nextAfter
        if after and self.source.yield then self.source:yield() end
    until not after
    self:collectProgress()
    return true
end
function Collector:collectProgress()
    if not self.queue:get('activationUnix') then return end
    local p=self.source:currentProgress()
    if p then self.queue:discover(p.document,{},p.snapshot) end
end
return Collector
