local json=require('dkjson');local Transport={};Transport.__index=Transport
local function errorValue(kind,code,message,stage,reason) return {kind=kind,code=code,message=message,stage=stage,reason=reason} end
local stageMessages={
    deadline='Tempo de espera esgotado; fila preservada para nova tentativa',
    ui_dismissed='Envio interrompido por interação com a interface; fila preservada para nova tentativa',
    ca_file='Arquivo cacert.pem ausente ou inacessível. Reinstale a pasta completa do plugin (ca_file)',
    ssl_module='Falha ao carregar a biblioteca TLS do KOReader (ssl_module)',
    socket_module='Falha ao carregar a biblioteca de rede do KOReader (socket_module)',
    http_module='Falha ao carregar o cliente HTTP do KOReader (http_module)',
    ltn12_module='Falha ao carregar a biblioteca de transporte do KOReader (ltn12_module)',
    tls_wrap='Falha ao preparar TLS no KOReader (tls_wrap)',
    sni='Falha ao configurar o nome do servidor no TLS (sni)',
    handshake='Falha na negociação TLS. Confira data/hora do Kindle e certificados (handshake)',
    peer_certificate='Falha ao examinar o certificado do servidor (peer_certificate)',
    hostname='Certificado não corresponde à URL configurada (hostname)',
    origin='Destino HTTPS difere da URL configurada (origin)',
    url='URL HTTPS não reconhecida pelo cliente (url)',
    tcp_socket='Falha ao criar conexão de rede (tcp_socket)',
    tcp_connect='Não foi possível alcançar o servidor (tcp_connect)',
    http_request='Falha no cliente HTTPS do plugin (http_request)',
    http_io='Falha ao transmitir a requisição HTTPS (http_io)',
}
function Transport.normalizeUrl(url)
    if type(url)~='string' or url:find('[%s?#@]') then return nil end
    local authority=url:match('^https://([^/]+)');if not authority then return nil end
    local host,port=authority:match('^([a-zA-Z0-9.-]+):(%d+)$');host=host or authority
    if not host:match('^[a-zA-Z0-9][a-zA-Z0-9.-]+$') or host:find('..',1,true) or host:match('^%d+%.%d+%.%d+%.%d+$') then return nil end
    if port and (tonumber(port)<1 or tonumber(port)>65535) then return nil end
    return url:gsub('/+$','')
end
function Transport.validServerId(value) return type(value)=='string' and #value>=1 and #value<=64 end
function Transport.new(adapter,clock) return setmetatable({adapter=adapter,clock=clock},Transport) end
function Transport:cancel() if self.cancelRequest then self.cancelRequest();self.cancelRequest=nil end;self.serial=(self.serial or 0)+1;self.busy=false end
function Transport:request(url,token,path,body,callback,timeout)
    local normalized=Transport.normalizeUrl(url)
    if not normalized or type(token)~='string' or token=='' or token:find('[\r\n]') then callback(nil,errorValue('protocol','configuration','Confira URL HTTPS e token pessoal'));return end
    if self.busy then callback(nil,errorValue('transient','busy','Envio em andamento'));return end
    self.serial=(self.serial or 0)+1;local serial=self.serial;self.busy=true
    local returned=false
    local cancel=self.adapter:request({url=normalized..path,method=body and 'POST' or 'GET',headers={Authorization='Bearer '..token,['Content-Type']='application/json'},body=body,timeout=timeout or 15},function(response)
        returned=true;if self.serial~=serial then return end;self.busy=false;self.cancelRequest=nil
        if response.error then
            local stageMessage=stageMessages[response.error.stage];if response.error.kind=='transient' and response.error.stage=='handshake' then stageMessage=nil end
            local message=response.error.code=='timeout' and 'Tempo de conexão esgotado; pendências preservadas para nova tentativa' or response.error.code=='cancelled' and 'Envio interrompido; fila preservada para nova tentativa' or stageMessage or (response.error.kind=='protocol' and 'HTTPS não verificado; confira certificados e servidor' or 'Não foi possível conectar ao servidor pessoal')
            callback(nil,errorValue(response.error.kind or 'transient',response.error.code or 'network',message,response.error.stage and stageMessages[response.error.stage] and response.error.stage or nil,response.error.reason));return
        end
        local status=tonumber(response.status)
        if status==401 or status==403 then callback(nil,errorValue('auth','auth','Token pessoal inválido'));return end
        if status==429 or (status and status>=500) then callback(nil,errorValue('transient','server','Servidor indisponível; envio será repetido'));return end
        if status~=200 then
            local ok,decoded=pcall(json.decode,response.body or '')
            local code=ok and type(decoded)=='table' and type(decoded.error)=='table' and decoded.error.code or 'protocol'
            callback(nil,errorValue('protocol',code,'Integração recusada; revise as pendências'));return
        end
        local ok,decoded=pcall(json.decode,response.body or '')
        if not ok or type(decoded)~='table' or decoded.protocolVersion~=1 then callback(nil,errorValue('protocol','response','Resposta da integração incompatível'));return end
        callback(decoded,nil)
    end)
    if not returned then self.cancelRequest=cancel end
end
function Transport:testConnection(url,token,callback) self:request(url,token,'/v1/koreader/status',nil,function(response,err)
    if response and (type(response.timeZone)~='string' or type(response.counts)~='table') then callback(nil,errorValue('protocol','response','Resposta de conexão incompatível')) else callback(response,err) end
end) end
function Transport:send(url,token,batch,callback,timeout) self:request(url,token,'/v1/koreader/ingest',batch.json,function(response,err)
    if response and (response.batchId~=batch.batchId or type(response.events)~='table' or type(response.document)~='table') then callback(nil,errorValue('protocol','response','Confirmação de lote incompatível')) else callback(response,err) end
end,timeout) end
function Transport:serverInfo(url,token,callback) self:request(url,token,'/v1/server',nil,function(response,err)
    if response and not Transport.validServerId(response.serverId) then callback(nil,errorValue('protocol','response','Resposta de identidade do servidor incompatível')) else callback(response,err) end
end) end
return Transport
