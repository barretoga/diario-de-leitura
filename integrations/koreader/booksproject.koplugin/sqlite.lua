local SQ=require('lua-ljsqlite3/init')
local ffi=require('ffi')
local DB={open=SQ.open}
function DB.all(conn,sql,...)
    local args={...};local count=select('#',...);local stmt=conn:prepare(sql);local rows={}
    local ok,err=pcall(function()
        stmt:bind(unpack(args,1,count))
    end)
    if not ok then stmt:close();error(err) end
    local success,value=pcall(function()
        while true do local header={};local row=stmt:step(nil,header);if not row then break end
            local named={};for i,key in ipairs(header) do
                local value=row[i]
                -- LJSQLite3 returns INTEGER columns as int64_t cdata. Convert
                -- at the database boundary before concat, JSON and bindings.
                if type(value)=='cdata' then
                    assert(ffi.istype('int64_t',value) or ffi.istype('uint64_t',value),'Tipo SQLite não suportado')
                    value=tonumber(value)
                    assert(value and math.abs(value)<=9007199254740991,'Inteiro SQLite fora do intervalo seguro; preserve os bancos')
                end
                named[key]=value
            end;rows[#rows+1]=named
        end
        return rows
    end)
    stmt:close();if not success then error(value) end;return value
end
function DB.one(conn,sql,...) return DB.all(conn,sql,...)[1] end
function DB.run(conn,sql,...) DB.all(conn,sql,...) end
function DB.transaction(conn,fn)
    conn:exec('BEGIN IMMEDIATE;');local ok,result=pcall(fn)
    if ok then conn:exec('COMMIT;');return result end
    conn:exec('ROLLBACK;');error(result)
end
return DB
