local HTTP={};HTTP.__index=HTTP
function HTTP.matchesHost(host,name)
    if type(name)~='string' or name:find('%z') then return false end
    host=host:lower();name=name:lower()
    if name==host then return true end
    local suffix=name:match('^%*%.([a-z0-9.-]+)$')
    if not suffix or not suffix:find('.',1,true) then return false end
    local tail=host:match('^[^.]+%.(.+)$');return tail==suffix
end
HTTP.reasons={timeout=true,wantread=true,wantwrite=true,closed=true,['certificate verify failed']=true}
function HTTP.perform(args,options)
    options=options or {};local tlsFailure=false;local networkTimeout=false;local networkClosed=false;local handshakeReason;local stage='runtime'
    local ok,result=pcall(function()
        stage='socket_module';local socket=options.socket or require('socket')
        stage='ssl_module';local ssl=options.ssl or require('ssl')
        stage='http_module';local http=options.http or require('socket.http')
        stage='ltn12_module';local ltn12=options.ltn12 or require('ltn12')
        stage='url'
        local authority=args.url:match('^https://([^/]+)');local host,port=authority:match('^([^:]+):(%d+)$');host=host or authority;port=tonumber(port) or 443
        stage='ca_file';local ca=options.caFile;local f=ca and io.open(ca,'rb');if not f then tlsFailure=true;error('CA indisponível') end;f:close()
        local start=socket.gettime and socket.gettime() or os.time()
        local function remaining()return math.max(0.01,args.timeout-((socket.gettime and socket.gettime() or os.time())-start))end
        local connection
        local function create()
            stage='tcp_socket'
            local c={sock=socket.tcp()};connection=c
            function c:settimeout()return self.sock:settimeout(remaining())end
            function c:connect(target,targetPort)
                stage='origin'
                if target:lower()~=host:lower() or tonumber(targetPort)~=port then tlsFailure=true;return nil,'Origem recusada' end
                stage='tcp_connect';self.sock:settimeout(remaining());local connected,why=self.sock:connect(host,port);if not connected then networkTimeout=why=='timeout';return nil,why end
                stage='tls_wrap'
                local peer=ssl.wrap(self.sock,{mode='client',protocol='tlsv1_2',verify={'peer','fail_if_no_peer_cert'},cafile=ca,options={'all','no_sslv2','no_sslv3'}})
                if not peer then tlsFailure=true;return nil,'TLS indisponível' end
                self.sock=peer;stage='sni';peer:sni(host);peer:settimeout(remaining());stage='handshake';local established,handshakeError=peer:dohandshake()
                if not established then
                    handshakeReason=HTTP.reasons[handshakeError] and handshakeError or 'unknown'
                    networkTimeout=handshakeReason=='timeout' or handshakeReason=='wantread' or handshakeReason=='wantwrite';networkClosed=handshakeReason=='closed';tlsFailure=not networkTimeout and not networkClosed
                    return nil,networkTimeout and 'timeout' or networkClosed and 'closed' or 'Certificado inválido'
                end
                stage='peer_certificate';local cert=peer:getpeercertificate();local ext=cert and cert:extensions();local san=ext and ext['2.5.29.17'];local matched=false
                stage='hostname'
                for _,name in ipairs(san and san.dNSName or {})do if HTTP.matchesHost(host,name) then matched=true;break end end
                if not matched then tlsFailure=true;peer:close();return nil,'Hostname inválido' end
                stage='http_io';return 1
            end
            for _,method in ipairs({'send','receive','close','getfd','dirty'})do c[method]=function(self,...)if method~='close' then self.sock:settimeout(remaining())end;return self.sock[method](self.sock,...)end end
            return c
        end
        local chunks={};local size=0
        local sink=function(chunk)if chunk then size=size+#chunk;if size>1000000 then return nil,'Resposta excessiva' end;chunks[#chunks+1]=chunk end;return 1 end
        local headers={};for k,v in pairs(args.headers)do headers[k]=v end
        if args.body then headers['Content-Length']=tostring(#args.body)end
        http.PROXY=nil
        stage='http_request';local succeeded,status=http.request({url=args.url,method=args.method,headers=headers,source=args.body and ltn12.source.string(args.body) or nil,sink=sink,create=create,redirect=false,proxy=false})
        if connection then pcall(connection.close,connection)end
        if not succeeded then return {error={kind=tlsFailure and 'protocol' or 'transient',code=tlsFailure and 'tls' or networkTimeout and 'timeout' or 'network',stage=stage,reason=handshakeReason}}end
        return {status=tonumber(status),body=table.concat(chunks)}
    end)
    -- The exception may contain credentials or remote text. Only export a fixed
    -- local stage identifier, never the exception or request headers.
    if not ok then return {error={kind='protocol',code='tls',stage=stage}}end
    return result
end
function HTTP.new(options)return setmetatable({options=options or {}},HTTP)end
function HTTP:request(args,callback)
    local UI=require('ui/uimanager');local Trapper=require('ui/trapper');local Widget=require('ui/widget/trapwidget')
    local widget=Widget:new{text=nil,resend_event=true};local done=false;local timeout
    local function finish(response,dismiss)
        if done then return end;done=true
        if timeout then UI:unschedule(timeout)end
        -- Dismissal resumes the subprocess coroutine synchronously. Mark the
        -- request done first so that cancellation cannot replace this timeout.
        if dismiss and widget.dismiss_callback then widget.dismiss_callback()end
        UI:close(widget);callback(response)
    end
    local cancel=function()if done then return end;done=true;if timeout then UI:unschedule(timeout)end;if widget.dismiss_callback then widget.dismiss_callback()end;UI:close(widget)end
    timeout=function()finish({error={kind='transient',code='timeout',stage='deadline'}},true)end
    UI:scheduleIn(args.timeout or 15,timeout);UI:show(widget)
    Trapper:wrap(function()
        local completed,response=Trapper:dismissableRunInSubprocess(function()return HTTP.perform(args,self.options)end,widget)
        if not done then finish(completed and response or {error={kind='transient',code='cancelled',stage='ui_dismissed'}})end
    end)
    return cancel
end
return HTTP
