import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export class ServiceFailure extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (process.platform === 'win32') {
    // The PID comes only from a child created by this invocation.
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('exit', resolve);
    });
  } else {
    child.kill('SIGTERM');
  }
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

export async function runServices(services, { signal, log = console.log, timeoutMs = 90000 } = {}) {
  const owned = [];
  let result;
  let stopping;
  let keepAlive;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  function stop(next = { code: 0 }) {
    if (result) return stopping;
    result = next;
    clearInterval(keepAlive);
    signal?.removeEventListener('abort', interrupted);
    stopping = Promise.all(owned.map(stopChild)).then(() => resolveClosed(result));
    return stopping;
  }
  function interrupted() { void stop(); }
  signal?.addEventListener('abort', interrupted, { once: true });
  try {
    for (const service of services) {
      if (signal?.aborted || result) throw new ServiceFailure(result?.message ?? 'Inicialização interrompida.', result?.code ?? 0);
      if (await service.probe()) {
        log(`[${service.name}] já ativo; reutilizando.`);
        continue;
      }
      if (signal?.aborted || result) throw new ServiceFailure(result?.message ?? 'Inicialização interrompida.', result?.code ?? 0);
      log(`[${service.name}] iniciando...`);
      const child = service.start();
      owned.push(child);
      child.once('error', () => { void stop({ code: 1, message: `${service.name}: não foi possível iniciar o processo.` }); });
      child.once('exit', code => {
        // Interactive Expo can consume Ctrl+C before the supervisor sees SIGINT.
        if (!result) void stop(code === 0 ? { code: 0 } : { code: 1, message: `${service.name}: processo encerrou (código ${code ?? 'sinal'}).` });
      });
      const deadline = Date.now() + timeoutMs;
      let ready = false;
      while (!result && !signal?.aborted && Date.now() < deadline) {
        ready = await service.probe();
        if (ready) break;
        await delay(100);
      }
      if (result || signal?.aborted) throw new ServiceFailure(result?.message ?? 'Inicialização interrompida.', result?.code ?? 0);
      if (!ready) throw new ServiceFailure(`${service.name}: não ficou pronto dentro do prazo.`);
      log(`[${service.name}] pronto.`);
    }
    if (signal?.aborted || result) throw new ServiceFailure(result?.message ?? 'Inicialização interrompida.', result?.code ?? 0);
    // Keep the terminal command alive even when every service was reused.
    keepAlive = setInterval(() => {}, 1000);
    return { stop, closed };
  } catch (error) {
    await stop({ code: signal?.aborted ? 0 : 1, message: error.message });
    throw error;
  }
}
