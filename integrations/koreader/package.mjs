import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = resolve(root, 'integrations/koreader/booksproject.koplugin');
const files = ['_meta.lua','main.lua','sqlite.lua','queue.lua','collector.lua','native.lua','transport.lua','coordinator.lua','native_http.lua','cacert.pem','CACERT-LICENSE.txt'];
const bundleHash = 'a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (hash(readFileSync(resolve(source,'cacert.pem'))) !== bundleHash) throw new Error('CA bundle differs from the verified 2026-09-25 snapshot; verify and update the pinned hash explicitly');
if (readdirSync(source).some(name=> !files.includes(name))) throw new Error('Unexpected file in plugin folder; packaging stopped');
const output = resolve(root, '.local/koreader-adapter/booksproject.koplugin.zip');
mkdirSync(dirname(output), {recursive:true});
const result = spawnSync(process.env.KOREADER_TEST_PYTHON || 'python', ['-c', `
import json,sys,zipfile,os
from pathlib import Path
source,output,names=Path(sys.argv[1]),Path(sys.argv[2]),json.loads(sys.argv[3])
temporary=output.with_suffix('.zip.tmp')
try:
    with zipfile.ZipFile(temporary,'w',zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            file=source/name
            if file.is_symlink() or not file.is_file(): raise ValueError('Invalid package source')
            info=zipfile.ZipInfo('booksproject.koplugin/'+name,date_time=(2026,10,2,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=0o100644 << 16
            archive.writestr(info,file.read_bytes())
    with zipfile.ZipFile(temporary) as archive:
        assert archive.testzip() is None
        assert archive.namelist()==['booksproject.koplugin/'+n for n in names]
    os.replace(temporary,output)
finally:
    if temporary.exists(): temporary.unlink()
`, source, output, JSON.stringify(files)], {encoding:'utf8'});
if (result.error || result.status !== 0) throw new Error('Packaging failed. Set KOREADER_TEST_PYTHON to a Python 3 executable. No partial archive was published.');
console.log(JSON.stringify({path:output, files:files.map(name=>'booksproject.koplugin/'+name), sha256:hash(readFileSync(output))},null,2));
