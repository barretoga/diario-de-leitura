import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = new URL('../dev.mjs', import.meta.url);
const cliPath = fileURLToPath(cli);

test('o comando explica como iniciar os três serviços sem carregar credenciais', () => {
  const result = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pnpm dev/);
  assert.match(result.stdout, /API.*ngrok.*Expo/);
  assert.match(result.stdout, /--no-app/);
});

test('a API iniciada pelo comando usa o banco indicado e encerra sem outros processos', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reading-log-dev-'));
  const child = spawn(process.execPath, [cliPath, '--api'], {
    env: { ...process.env, READING_LOG_TOKEN: 'test-token-'.repeat(4), API_PORT: '0', DATABASE_PATH: join(directory, 'books.db') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    for (let attempt = 0; attempt < 100 && !/http:\/\/127.0.0.1:\d+/.test(output) && child.exitCode === null; attempt++) await delay(25);
    const url = output.match(/http:\/\/127.0.0.1:\d+/)?.[0];
    assert.ok(url, output);
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    const unauthorized = await fetch(`${url}/v1/sync`, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
    assert.doesNotMatch(output, /test-token-/);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('o encerramento mantém serviços reutilizados e para os iniciados pelo comando', async () => {
  const { runServices } = await import('../service-runner.mjs');
  let owned;
  let output = '';
  const events = [];
  const controller = new AbortController();
  const stack = await runServices([
    { name: 'existente', probe: async () => true, start: () => assert.fail('não deve duplicar o processo') },
    { name: 'novo', probe: async () => output.includes('ready'), start: () => {
      owned = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      owned.stdout.on('data', chunk => { output += chunk; });
      return owned;
    } },
  ], { signal: controller.signal, log: message => events.push(message), timeoutMs: 3000 });
  try {
    assert.match(events.join('\n'), /existente.*já ativo/);
    assert.match(events.join('\n'), /novo.*pronto/);
    controller.abort();
    assert.equal((await stack.closed).code, 0);
    assert.ok(owned.exitCode !== null || owned.signalCode !== null);
  } finally { await stack.stop(); }
});

test('uma falha posterior encerra o serviço anterior e informa qual falhou', async () => {
  const { runServices } = await import('../service-runner.mjs');
  let first;
  let ready = false;
  await assert.rejects(runServices([
    { name: 'API', probe: async () => ready, start: () => {
      first = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      first.stdout.on('data', () => { ready = true; });
      return first;
    } },
    { name: 'túnel', probe: async () => false, start: () => spawn(process.execPath, ['-e', 'process.exit(2)'], { windowsHide: true, stdio: 'ignore' }) },
  ], { timeoutMs: 3000, log: () => {} }), /túnel.*encerrou/);
  assert.ok(first.exitCode !== null || first.signalCode !== null);
});

test('falha de um processo já pronto encerra o conjunto e preserva o código de erro', async () => {
  const { runServices } = await import('../service-runner.mjs');
  let child;
  let output = '';
  const stack = await runServices([{ name: 'app', probe: async () => output.includes('ready'), start: () => {
    child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', chunk => { output += chunk; });
    return child;
  } }], { log: () => {}, timeoutMs: 3000 });
  child.kill();
  const result = await stack.closed;
  assert.equal(result.code, 1);
  assert.match(result.message, /app/);
});

test('as credenciais pessoais e do catálogo não são herdadas pelo Expo ou ngrok', async () => {
  const { serviceEnv } = await import('../dev.mjs');
  const base = { PATH: 'tools', READING_LOG_TOKEN: 'reading-secret', GOOGLE_BOOKS_API_KEY: 'google-secret', NGROK_AUTHTOKEN: 'ngrok-secret', CUSTOM_PRIVATE: 'secret' };
  const config = { ...base, CATALOG_CONTACT_EMAIL: 'email@example.com', EXPO_PUBLIC_CATALOG_API_URL: 'https://catalog.example.com' };
  const expo = serviceEnv(base, config, 'app');
  assert.equal(expo.PATH, 'tools');
  for (const key of ['READING_LOG_TOKEN', 'GOOGLE_BOOKS_API_KEY', 'NGROK_AUTHTOKEN', 'CUSTOM_PRIVATE', 'CATALOG_CONTACT_EMAIL']) assert.equal(expo[key], undefined);
  const tunnel = serviceEnv(base, config, 'tunnel');
  assert.equal(tunnel.NGROK_AUTHTOKEN, 'ngrok-secret');
  assert.equal(tunnel.READING_LOG_TOKEN, undefined);
  assert.equal(tunnel.GOOGLE_BOOKS_API_KEY, undefined);
});

test('interromper durante a inicialização encerra o processo ainda não pronto', async () => {
  const { runServices } = await import('../service-runner.mjs');
  const controller = new AbortController();
  let child;
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await assert.rejects(runServices([{ name: 'lento', probe: async () => false, start: () => {
      child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
      return child;
    } }], { signal: controller.signal, timeoutMs: 3000, log: () => {} }), /interrompida/);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally { clearTimeout(timer); }
});

test('timeout de prontidão limpa os processos iniciados', async () => {
  const { runServices } = await import('../service-runner.mjs');
  let child;
  await assert.rejects(runServices([{ name: 'lento', probe: async () => false, start: () => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    return child;
  } }], { timeoutMs: 150, log: () => {} }), /lento.*prazo/);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('a saída normal do Expo encerra o conjunto sem informar falha', async () => {
  const { runServices } = await import('../service-runner.mjs');
  let child;
  let ready = false;
  const stack = await runServices([{ name: 'Expo', probe: async () => ready, start: () => {
    child = spawn(process.execPath, ['-e', "console.log('ready');process.on('message',()=>process.exit(0));setInterval(()=>{},1000)"], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
    });
    child.stdout.on('data', () => { ready = true; });
    return child;
  } }], { timeoutMs: 3000, log: () => {} });
  child.send('quit');
  const result = await stack.closed;
  assert.equal(result.code, 0);
  assert.equal(result.message, undefined);
});

test('a saída normal antes da prontidão preserva código de interrupção 0', async () => {
  const { runServices, ServiceFailure } = await import('../service-runner.mjs');
  await assert.rejects(runServices([{ name: 'Expo', probe: async () => false, start: () =>
    spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' }),
  }], { timeoutMs: 3000, log: () => {} }), error => {
    assert.ok(error instanceof ServiceFailure);
    assert.equal(error.exitCode, 0);
    return true;
  });
});

test('o inicializador usa o Node indicado e repassa as opções do comando', () => {
  const launcher = fileURLToPath(new URL('../dev-launch.cjs', import.meta.url));
  const result = spawnSync(process.execPath, [launcher, '--help'], {
    env: { ...process.env, READING_LOG_NODE_PATH: process.execPath }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /API.*ngrok.*Expo/);
});
