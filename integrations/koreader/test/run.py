import sys
import tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / '.local/koreader-adapter/python'))
from harness import runtime

def main():
    names = sys.argv[1:] or ['native_integer','capture','queue','transport','coordinator','suspend','automatic','backlog','diagnostics','activation','native_http','http_lifecycle','menu']
    passed = 0
    for name in names:
        path = Path(__file__).with_name('test_' + name + '.lua')
        if not path.exists(): raise RuntimeError('Teste ausente: ' + str(path))
        with tempfile.TemporaryDirectory(prefix='books-koreader-test-') as directory:
            lua, connections = runtime(directory)
            print(lua.eval('jit.version'), name, flush=True)
            try:
                lua.execute(path.read_text(encoding='utf-8'))
                passed += 1
                print('PASS', name, flush=True)
            finally:
                for db in connections:
                    try: db.close()
                    except Exception: pass
    print('Lua modules:', passed, 'PASS, 0 failures')
if __name__ == '__main__': main()
