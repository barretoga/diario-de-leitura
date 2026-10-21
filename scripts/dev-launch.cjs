const { spawn, spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

function supported(version) {
  const match = version.trim().match(/^v(\d+)\.(\d+)\./);
  return match && (Number(match[1]) > 24 || (Number(match[1]) === 24 && Number(match[2]) >= 15));
}

function selectRuntime() {
  const configured = process.env.READING_LOG_NODE_PATH;
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = configured ? [configured] : [
    process.execPath,
    resolve(__dirname, '../.local/runtime', executable),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const version = candidate === process.execPath ? process.version : spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).stdout ?? '';
    if (supported(version)) return candidate;
  }
  throw new Error('Node 24.15+ não encontrado. Instale essa versão ou defina READING_LOG_NODE_PATH com o caminho do executável.');
}

try {
  const runtime = selectRuntime();
  const args = process.argv.slice(2);
  const command = args[0] === '--test' ? ['--test', resolve(__dirname, 'test/dev.test.mjs'), ...args.slice(1)] : [resolve(__dirname, 'dev.mjs'), ...args];
  const env = { ...process.env, PATH: `${dirname(runtime)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` };
  const child = spawn(runtime, command, { env, stdio: 'inherit', windowsHide: true });
  // Console Ctrl+C reaches the child, which owns service cleanup; keep this
  // launcher alive until the child has completed that cleanup.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('error', () => { console.error('Não foi possível executar o Node selecionado.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
