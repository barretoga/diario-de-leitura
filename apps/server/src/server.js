import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore, sync } from './store.js';
import { getServerId } from './identity.js';
import { sendJson, readJson } from './http.js';
import { handleKOReader } from './koreader/routes.js';
import { validateTimeZone, associatePendingDocuments } from './koreader/store.js';

function tokenMatches(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createAppServer({ token, databasePath, koreaderTimeZone = 'America/Sao_Paulo' }) {
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error('READING_LOG_TOKEN deve ter pelo menos 32 caracteres');
  }
  const db = openStore(databasePath);
  try {
    validateTimeZone(db, koreaderTimeZone);
    associatePendingDocuments(db, {now: () => new Date()});
  } catch(error) { db.close(); throw error; }
  const server = createHttpServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/health' && request.method === 'GET') {
        return sendJson(response, 200, { status: 'ok' });
      }
      if (!tokenMatches(request.headers.authorization, token)) {
        if (path === '/v1/koreader' || path.startsWith('/v1/koreader/')) return sendJson(response, 401, { error: { code: 'auth', message: 'Token inválido' } });
        return sendJson(response, 401, { error: 'Não autorizado' });
      }
      if (path === '/v1/server' && request.method === 'GET') {
        return sendJson(response, 200, { protocolVersion: 1, serverId: getServerId(db) });
      }
      if (await handleKOReader(request, response, db, { timeZone: koreaderTimeZone, now: () => new Date() })) return;
      if (path === '/v1/sync' && request.method === 'POST') {
        const body = await readJson(request);
        return sendJson(response, 200, { ...sync(db, body), serverId: getServerId(db) });
      }
      return sendJson(response, 404, { error: 'Rota não encontrada' });
    } catch (error) {
      if (error instanceof TypeError || error.status === 400 || error.status === 413) {
        return sendJson(response, error.status ?? 400, { error: error.message });
      }
      console.error(error);
      return sendJson(response, 500, { error: 'Erro interno' });
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createAppServer({
    token: process.env.READING_LOG_TOKEN,
    databasePath: process.env.DATABASE_PATH ?? './data/reading-log.db',
    koreaderTimeZone: process.env.KOREADER_TIME_ZONE ?? 'America/Sao_Paulo',
  });
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, '0.0.0.0', () => console.log(`Reading Log API na porta ${port}`));
}
