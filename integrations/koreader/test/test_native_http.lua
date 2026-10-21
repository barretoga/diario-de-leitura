local HTTP=require('native_http')
assert(HTTP.matchesHost('books.example','books.example'))
assert(HTTP.matchesHost('a.books.example','*.books.example'))
assert(not HTTP.matchesHost('a.b.books.example','*.books.example'))
assert(not HTTP.matchesHost('books.example','*.books.example'))
assert(not HTTP.matchesHost('evilbooks.example','*.books.example'))
assert(not HTTP.matchesHost('books.example','books.example\0evil.example'))
assert(not HTTP.matchesHost('a.com','*.com'))
local sent=false
local socket={settimeout=function()end,connect=function()return true end,close=function()end}
local tls={settimeout=function()end,sni=function()end,dohandshake=function()return true end,close=function()end,
 getpeercertificate=function()return {extensions=function()return {['2.5.29.17']={dNSName={'evil.example'}}}end}end}
local options={socket={tcp=function()return socket end},ssl={wrap=function(_,params)assert(params.verify[1]=='peer');return tls end},
 http={request=function(args)local connection=args.create();local ok=connection:connect('books.example',443);if ok then sent=true end;return nil,'TLS mismatch' end},
 ltn12={source={string=function(value)return value end}},caFile=TEST_DIR..'/ca.pem'}
local f=io.open(options.caFile,'w');f:write('public CA test fixture');f:close()
local response=HTTP.perform({url='https://books.example/v1/koreader/status',method='GET',headers={Authorization='Bearer test-token'},timeout=15},options)
assert(not sent);assert(response.error.code=='tls')
assert(response.error.stage=='hostname','certificate mismatch identifies hostname stage')
local actualCA=options.caFile;options.caFile=TEST_DIR..'/missing-ca.pem'
response=HTTP.perform({url='https://books.example/v1/koreader/status',method='GET',headers={Authorization='Bearer private-secret'},timeout=15},options)
assert(response.error.stage=='ca_file','missing CA has an actionable local diagnostic');assert(not sent)
options.caFile=actualCA
local actualWrap=options.ssl.wrap;options.ssl.wrap=function()error('untrusted error containing private-secret')end
response=HTTP.perform({url='https://books.example/v1/koreader/status',method='GET',headers={Authorization='Bearer private-secret'},timeout=15},options)
assert(response.error.stage=='tls_wrap');assert(response.error.message==nil,'raw runtime errors never leave the transport')
options.ssl.wrap=actualWrap
local actualHandshake=tls.dohandshake;tls.dohandshake=function()return nil,'certificate expired private-secret' end
response=HTTP.perform({url='https://books.example/v1/koreader/status',method='GET',headers={Authorization='Bearer private-secret'},timeout=15},options)
assert(response.error.stage=='handshake');assert(response.error.message==nil)
assert(response.error.code=='tls' and response.error.reason=='unknown','unlisted handshake text is never exported');tls.dohandshake=actualHandshake
tls.dohandshake=function()return nil,'timeout' end
response=HTTP.perform({url='https://books.example/v1/koreader/status',method='GET',headers={Authorization='Bearer test-token'},timeout=5},options)
assert(response.error.kind=='transient' and response.error.code=='timeout','slow TLS handshake preserves automatic recovery instead of blocking as a certificate error')
for _,reason in ipairs({'wantread','wantwrite','timeout'})do
 tls.dohandshake=function()return nil,reason end
 response=HTTP.perform({url='https://books.example/v1/koreader/status',method='GET',headers={Authorization='Bearer test-token'},timeout=5},options)
 assert(response.error.kind=='transient' and response.error.code=='timeout' and response.error.stage=='handshake' and response.error.reason==reason,reason)
end
tls.dohandshake=function()return nil,'closed' end
response=HTTP.perform({url='https://books.example/v1/koreader/status',method='GET',headers={Authorization='Bearer test-token'},timeout=5},options)
assert(response.error.kind=='transient' and response.error.code=='network' and response.error.stage=='handshake' and response.error.reason=='closed','closed handshake is a transient network failure')
tls.dohandshake=function()return nil,'certificate verify failed' end
response=HTTP.perform({url='https://books.example/v1/koreader/status',method='GET',headers={Authorization='Bearer test-token'},timeout=5},options)
assert(response.error.kind=='protocol' and response.error.code=='tls' and response.error.reason=='certificate verify failed')
tls.dohandshake=actualHandshake
local calls={}
tls.getpeercertificate=function()return {extensions=function()return {['2.5.29.17']={dNSName={'books.example'}}}end}end
tls.send=function(_,data)calls.send=data;return #data end
tls.receive=function()calls.receive=true;return 'OK' end
tls.getfd=function()return 42 end;tls.dirty=function()return false end
options.http.request=function(args)
 assert(args.redirect==false and args.proxy==false)
 local connection=args.create();assert(connection:connect('books.example',443))
 assert(connection:send(args.headers.Authorization)>0);assert(connection:receive()=='OK');assert(connection:getfd()==42);assert(connection:dirty()==false)
 args.sink('{"protocolVersion":1}');return 1,200
end
response=HTTP.perform({url='https://books.example/v1/koreader/status',method='GET',headers={Authorization='Bearer test-token'},timeout=15},options)
assert(response.status==200 and response.body=='{"protocolVersion":1}');assert(calls.send=='Bearer test-token' and calls.receive)

-- A slow subprocess must be dismissed at the caller's deadline, not the
-- ordinary fifteen-second timeout; late completion cannot acknowledge twice.
local scheduled;local work;local timeoutRemoved=false;local callbacks=0;local dismissed=false
package.preload['ui/uimanager']=function()return {
 scheduleIn=function(_,seconds,fn)scheduled={seconds=seconds,fn=fn}end,
 unschedule=function(_,fn)if fn==scheduled.fn then timeoutRemoved=true end end,
 show=function()end,close=function()end,
}end
package.preload['ui/widget/trapwidget']=function()return {new=function(_,args)
 args.dismiss_callback=function()dismissed=true end;return args
end}end
package.preload['ui/trapper']=function()return {
 wrap=function(_,fn)work=fn end,
 dismissableRunInSubprocess=function()return true,{status=200,body='late'}end,
}end
HTTP.new():request({timeout=5},function(result)callbacks=callbacks+1;assert(result.error.code=='timeout')end)
assert(scheduled.seconds==5,'UI deadline uses the bounded suspension timeout')
scheduled.fn();assert(dismissed and timeoutRemoved and callbacks==1)
work();assert(callbacks==1,'late subprocess completion is ignored')
HTTP.new():request({timeout=15},function()callbacks=callbacks+1 end)
assert(scheduled.seconds==15);work();assert(callbacks==2)
