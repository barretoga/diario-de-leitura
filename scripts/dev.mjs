import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runServices, ServiceFailure } from './service-runner.mjs';

class StartupError extends Error {}

const filename = fileURLToPath(import.meta.url);
const root = resolve(dirname(filename), '..');
const local = resolve(root, '.local/personal-sync');
const essentialEnv = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']);
const credentialKeys = ['READING_LOG_TOKEN', 'NGROK_AUTHTOKEN', 'GOOGLE_BOOKS_API_KEY', 'CATALOG_CONTACT_EMAIL'];

export function serviceEnv(base, config, service) {
  const env = { ...base };
  for (const key of [...Object.keys(config), ...credentialKeys]) {
    if (!essentialEnv.has(key.toUpperCase()) && !key.startsWith('EXPO_PUBLIC_')) delete env[key];
  }
  if (service === 'api') {
    env.READING_LOG_TOKEN = config.READING_LOG_TOKEN;
    env.KOREADER_TIME_ZONE = config.KOREADER_TIME_ZONE ?? 'America/Sao_Paulo';
  }
  if (service === 'tunnel') env.NGROK_AUTHTOKEN = config.NGROK_AUTHTOKEN;
  if (service === 'app') {
    for (const [key, value] of Object.entries(config)) if (key.startsWith('EXPO_PUBLIC_')) env[key] = value;
  }
  return env;
}

function occupied(port) {
  return new Promise(resolveResult => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolveResult(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function request(url, options = {}) {
  try { return await fetch(url, { ...options, signal: AbortSignal.timeout(1500) }); }
  catch { return null; }
}

async function apiMode() {
  const { createAppServer } = await import('../apps/server/src/server.js');
  const server = createAppServer({
    token: process.env.READING_LOG_TOKEN,
    databasePath: process.env.DATABASE_PATH ?? resolve(root, 'data/reading-log.db'),
    koreaderTimeZone: process.env.KOREADER_TIME_ZONE ?? 'America/Sao_Paulo',
  });
  server.on('error', () => { console.error('[API] Falha ao iniciar. Confira a porta e a configuração.'); process.exitCode = 1; });
  server.listen(Number(process.env.API_PORT ?? 8080), '127.0.0.1', () => console.log(`[API] http://127.0.0.1:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}

function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new StartupError('O endereço salvo do ngrok deve ser uma URL base HTTPS.');
  }
  return url.origin;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('pnpm dev — API pessoal + ngrok + Expo, no mesmo terminal.\nCtrl+C encerra somente os processos iniciados pelo comando.\npnpm dev --no-app — inicia API e túnel para usar o APK instalado.\nRequer Node 24.15+, dependências, .env e ngrok local configurados.');
    return;
  }
  if (args.length === 1 && args[0] === '--api') { await apiMode(); return; }
  if (args.some(arg => arg !== '--no-app')) throw new StartupError('Opção desconhecida. Use pnpm dev --help.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) throw new StartupError('Use Node.js 24.15 ou superior.');
  const envPath = resolve(root, '.env');
  const fileConfig = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const config = { ...fileConfig };
  for (const key of [...Object.keys(fileConfig), ...credentialKeys, 'API_PORT', 'KOREADER_TIME_ZONE']) {
    if (process.env[key] !== undefined) config[key] = process.env[key];
  }
  if ((config.READING_LOG_TOKEN ?? '').length < 32) throw new StartupError('Defina READING_LOG_TOKEN (32+ caracteres) no .env da raiz.');
  if (!config.NGROK_AUTHTOKEN?.trim()) throw new StartupError('Defina NGROK_AUTHTOKEN no .env da raiz.');
  const port = Number(config.API_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new StartupError('API_PORT inválida.');
  const upstream = `http://127.0.0.1:${port}`;
  const endpointPath = resolve(local, 'endpoint.json');
  let previous;
  try { previous = existsSync(endpointPath) ? httpsOrigin(JSON.parse(readFileSync(endpointPath, 'utf8')).url) : null; }
  catch { throw new StartupError('Confira o endereço salvo em .local/personal-sync/endpoint.json.'); }
  const ngrok = resolve(local, 'ngrok/bin/ngrok.exe');
  if (!existsSync(ngrok)) throw new StartupError('ngrok não encontrado em .local/personal-sync/ngrok/bin/ngrok.exe. Consulte o README.');
  const expoCli = resolve(root, 'apps/mobile/node_modules/expo/bin/cli');
  if (!args.includes('--no-app') && !existsSync(expoCli)) throw new StartupError('Instale as dependências com pnpm install antes de iniciar o Expo.');
  const appConfig = JSON.parse(readFileSync(resolve(root, 'apps/mobile/app.json'), 'utf8')).expo;
  mkdirSync(local, { recursive: true });
  const ngrokConfig = resolve(local, 'ngrok.yml');
  if (!existsSync(ngrokConfig)) writeFileSync(ngrokConfig, 'version: "3"\nagent:\n  web_addr: 127.0.0.1:4041\n  inspect_db_size: -1\n  remote_management: false\n  log: stdout\n  log_format: json\n  log_level: info\n');
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
  const apiEnv = { ...serviceEnv(process.env, config, 'api'), API_PORT: String(port), DATABASE_PATH: resolve(root, 'data/reading-log.db') };
  let ownApi = false;
  let ownTunnel = false;
  let ownApp = false;
  let publicUrl;
  const services = [{ name: 'API', probe: async () => {
    const health = await request(`${upstream}/health`);
    if (health?.ok && (await health.json()).status === 'ok') {
      const sync = await request(`${upstream}/v1/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.READING_LOG_TOKEN}` }, body: JSON.stringify({ cursor: 0, operations: [] }) });
      if (!sync?.ok) throw new StartupError('A API ativa não aceita o token configurado. Confira .env; ela não será reiniciada.');
      const data = await sync.json();
      if (Array.isArray(data.changes) && Array.isArray(data.results)) return true;
    }
    if (!ownApi && await occupied(port)) throw new StartupError(`Porta ${port} ocupada por um serviço que não é a API configurada.`);
    return false;
  }, start: () => {
    ownApi = true;
    return spawn(process.execPath, [filename, '--api'], { cwd: root, env: apiEnv, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
  } }, { name: 'ngrok', probe: async () => {
    const response = await request('http://127.0.0.1:4041/api/tunnels');
    if (response?.ok) {
      const tunnels = (await response.json()).tunnels;
      const tunnel = tunnels?.find(item => item.proto === 'https' && item.config?.addr === upstream);
      if (tunnel) {
        publicUrl = httpsOrigin(tunnel.public_url);
        if (previous && previous !== publicUrl) throw new StartupError('O túnel ativo usa outro endereço. O endereço salvo será preservado.');
        if (!previous) { writeFileSync(endpointPath, JSON.stringify({ url: publicUrl, upstream }, null, 2) + '\n'); previous = publicUrl; }
        return true;
      }
    }
    if (!ownTunnel && await occupied(4041)) throw new StartupError('Já existe uma sessão na porta 4041, mas ela não encaminha a API configurada.');
    return false;
  }, start: () => {
    ownTunnel = true;
    const tunnelArgs = ['http', upstream, '--config', ngrokConfig, '--inspect=false'];
    if (previous) tunnelArgs.push('--url', previous);
    const child = spawn(ngrok, tunnelArgs, { cwd: root, env: serviceEnv(process.env, config, 'tunnel'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let lastCode;
    const report = chunk => {
      const code = chunk.toString().match(/ERR_NGROK_\d+/)?.[0];
      if (code && code !== lastCode) { lastCode = code; console.error(`[ngrok] ${code}. Confira a conta e o authtoken no .env.`); }
    };
    child.stdout.on('data', report);
    child.stderr.on('data', report);
    return child;
  } }];
  if (!args.includes('--no-app')) services.push({ name: 'Expo', probe: async () => {
    const response = await request('http://127.0.0.1:8082/status');
    if (response?.ok && (await response.text()).trim() === 'packager-status:running') {
      if (ownApp) return true;
      const manifest = await request('http://127.0.0.1:8082/', { headers: { 'expo-platform': 'android', accept: 'application/expo+json' } });
      if (manifest?.ok) {
        const client = (await manifest.json()).extra?.expoClient;
        if (client?.slug === appConfig.slug && client.extra?.eas?.projectId === appConfig.extra.eas.projectId) return true;
      }
      throw new StartupError('O Expo na porta 8082 pertence a outro app ou não pôde ser identificado.');
    }
    if (!ownApp && await occupied(8082)) throw new StartupError('A porta 8082 está ocupada por outro serviço.');
    return false;
  }, start: () => {
    ownApp = true;
    return spawn(process.execPath, [expoCli, 'start', '--port', '8082'], { cwd: resolve(root, 'apps/mobile'), env: serviceEnv(process.env, config, 'app'), windowsHide: true, stdio: 'inherit' });
  } });
  try {
    const stack = await runServices(services, { signal: controller.signal });
    console.log(`\nServiços prontos. API: ${upstream}\nSincronização HTTPS: ${publicUrl}\nCtrl+C encerra apenas os processos iniciados nesta execução.`);
    const result = await stack.closed;
    if (result.message) console.error(result.message);
    process.exitCode = result.code;
  } catch (error) {
    if (controller.signal.aborted || (error instanceof ServiceFailure && error.exitCode === 0)) console.log('Inicialização interrompida; processos iniciados foram encerrados.');
    else throw error;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // Configuration errors are authored above; never print a raw child/provider exception.
    console.error(error instanceof StartupError || error instanceof ServiceFailure ? error.message : 'Falha ao iniciar os serviços. Confira .env, portas e ngrok; use pnpm dev --help.');
    process.exitCode = 1;
  });
}
