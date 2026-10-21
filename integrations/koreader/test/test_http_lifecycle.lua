-- KOReader dismisses a subprocess by resuming its coroutine synchronously.
-- The deadline must win over that reentrant cancellation callback.
local HTTP=require('native_http');local jobs={};local shown;local workers={}
package.preload['ui/uimanager']=function()return {
 scheduleIn=function(_,seconds,fn)jobs[#jobs+1]={seconds=seconds,fn=fn}end,
 unschedule=function(_,fn)for _,job in ipairs(jobs)do if job.fn==fn then job.cancelled=true end end end,
 show=function(_,widget)shown=widget end,close=function()end,
}end
package.preload['ui/widget/trapwidget']=function()return {new=function(_,args)return args end}end
package.preload['ui/trapper']=function()return {
 wrap=function(_,fn)local thread=coroutine.create(fn);workers[#workers+1]=thread;assert(coroutine.resume(thread))end,
 dismissableRunInSubprocess=function(_,task,widget)
  local thread=coroutine.running();widget.dismiss_callback=function()assert(coroutine.resume(thread,false))end
  return coroutine.yield()
 end,
}end
local callbacks=0;local received
HTTP.new():request({timeout=5},function(response)callbacks=callbacks+1;received=response end)
jobs[1].fn()
assert(callbacks==1 and received.error.code=='timeout','a deadline must report timeout even when dismiss_callback resumes the request immediately')
assert(received.error.stage=='deadline','deadline cancellation must remain distinguishable in diagnostics')
assert(coroutine.status(workers[1])=='dead')

HTTP.new():request({timeout=15},function(response)callbacks=callbacks+1;received=response end)
shown.dismiss_callback()
assert(callbacks==2 and received.error.code=='cancelled' and received.error.stage=='ui_dismissed','user dismissal must be distinct from a deadline')
local afterDismiss=callbacks;jobs[#jobs].fn();assert(callbacks==afterDismiss,'a stale deadline cannot complete a dismissed request twice')

local cancel=HTTP.new():request({timeout=15},function()callbacks=callbacks+1 end)
cancel();assert(callbacks==afterDismiss,'lifecycle cancellation must not invoke the stale callback')
jobs[#jobs].fn();assert(callbacks==afterDismiss)
