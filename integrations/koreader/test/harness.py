import json
import sqlite3
from pathlib import Path
from lupa.luajit21 import LuaRuntime, lua_type

ROOT = Path(__file__).resolve().parents[3]
PLUGIN = ROOT / 'integrations/koreader/booksproject.koplugin'

def runtime(directory):
    lua = LuaRuntime(unpack_returned_tuples=True)
    # LJSQLite3 returns SQLite INTEGER columns as FFI int64_t, not Lua numbers.
    # Preserve that native boundary so tests catch concat/JSON/binding failures.
    native_integer = lua.eval("function(value) return require('ffi').new('int64_t', value) end")
    null = lua.table()
    equal = lua.eval('rawequal')
    getmeta = lua.eval('getmetatable')
    def from_lua(value):
        if lua_type(value) != 'table': return value
        if equal(value, null): return None
        meta = getmeta(value)
        keys = list(value.keys())
        if (meta and meta['__jsontype'] == 'array') or (keys and all(isinstance(k, (int, float)) for k in keys)):
            return [from_lua(value[i]) for i in range(1, len(value) + 1)]
        return {str(k): from_lua(v) for k, v in value.items()}
    def to_lua(value):
        if value is None: return null
        if isinstance(value, dict): return lua.table_from({k: to_lua(v) for k, v in value.items()})
        if isinstance(value, list):
            result = lua.table_from([to_lua(v) for v in value]); lua.eval('setmetatable')(result, lua.table_from({'__jsontype':'array'})); return result
        return value
    connections = []
    def open_db(path, mode='rwc'):
        if mode == 'ro': db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, isolation_level=None)
        else: db = sqlite3.connect(path, isolation_level=None)
        connections.append(db)
        def exec_sql(sql):
            statement = ''
            for char in sql:
                statement += char
                if char == ';' and sqlite3.complete_statement(statement): db.execute(statement); statement = ''
            if statement.strip(): db.execute(statement)
        def run(sql, values):
            cursor = db.execute(sql, tuple(from_lua(values)))
            return cursor
        def step(cursor):
            row = cursor.fetchone()
            if row is None: return None
            return lua.table_from([native_integer(v) if isinstance(v, int) else v for v in row]), lua.table_from([c[0] for c in cursor.description])
        return lua.globals().make_sql_connection(exec_sql, run, step, db.close)
    lua.globals().py_open = open_db
    lua.globals().py_encode = lambda v: json.dumps(from_lua(v), ensure_ascii=False, separators=(',', ':'))
    lua.globals().py_decode = lambda v: to_lua(json.loads(v))
    lua.globals().TEST_DIR = str(directory).replace('\\','/')
    lua.globals().NULL = null
    lua.globals().PLUGIN_DIR = str(PLUGIN).replace('\\','/')
    lua.execute('''
      package.path = [[%s/?.lua;]] .. package.path
      for _,name in ipairs({'sqlite','queue','collector','native','transport','coordinator','native_http'}) do package.preload['booksproject.'..name]=function() return require(name) end end
      function make_sql_connection(exec_sql,run,step,close)
        return {exec=function(_,sql) return exec_sql(sql) end, close=function() close() end,
          prepare=function(_,sql)
            local stmt={params=setmetatable({}, {__jsontype='array'})}
            function stmt:reset() self.cursor=nil; return self end
            function stmt:bind(...) self.params=setmetatable({},{__jsontype='array'});for i=1,select('#',...) do local v=select(i,...);self.params[i]=v==nil and NULL or v end;return self end
            function stmt:step(_,header)
              if not self.cursor then self.cursor=run(sql,self.params) end
              local row,keys=step(self.cursor)
              if header and keys then for k,v in pairs(keys) do header[k]=v end end
              return row
            end
            function stmt:close() end
            return stmt
          end}
      end
      package.preload['lua-ljsqlite3/init']=function() return {open=function(path,mode) return py_open(path,mode or 'rwc') end} end
      package.preload['dkjson']=function() return {null=NULL,encode=function(v) return py_encode(v) end,decode=function(v) return py_decode(v) end} end
      package.preload['datastorage']=function() return {getSettingsDir=function() return TEST_DIR end} end
      package.preload['lfs']=function() return {attributes=function(path) local f=io.open(path,'rb');if f then f:close();return 'file' end end} end
    ''' % str(PLUGIN).replace('\\','/'))
    return lua, connections
