import { createServer } from 'node:http';
import { CatalogError, validVolumeId } from './providers.js';

const messages = {
  invalid_request: 'Confira os parâmetros da busca.',
  invalid_response: 'Resposta do fornecedor inválida. Tente novamente mais tarde.',
  provider_unavailable: 'Catálogo indisponível. Tente mais tarde ou mantenha o cadastro manual.',
  provider_timeout: 'A consulta demorou demais. Tente novamente.',
  rate_limited: 'Limite de consultas atingido. Aguarde e tente novamente.',
};
function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...(status === 429 ? { 'Retry-After': '1' } : {}) });
  response.end(JSON.stringify(value));
}
function searchParams(url) {
  for (const key of url.searchParams.keys()) {
    if (!['source', 'title', 'author', 'language'].includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw new CatalogError(400, 'invalid_request');
    }
  }
  const normalize = value => (value ?? '').trim().replace(/\s+/g, ' ');
  const source = url.searchParams.get('source'), language = url.searchParams.get('language');
  const title = normalize(url.searchParams.get('title')), author = normalize(url.searchParams.get('author'));
  if (!['google', 'openlibrary'].includes(source) || !['pt', 'all'].includes(language) ||
    title.length < 2 || title.length > 200 || author.length > 200 || /[\u0000-\u001f\u007f]/.test(title + author)) {
    throw new CatalogError(400, 'invalid_request');
  }
  return { source, title, author, language };
}

export function createCatalogServer({ googleProvider, openLibraryProvider, now = Date.now }) {
  const windows = { google: [], openlibrary: [] };
  function acquire(source) {
    const time = now();
    windows[source] = windows[source].filter(started => time - started < 1000);
    if (windows[source].length >= (source === 'google' ? 10 : 3)) throw new CatalogError(429, 'rate_limited');
    windows[source].push(time);
  }
  const server = createServer(async (request, response) => {
    try {
      if ((request.url?.length ?? 0) > 4096) throw new CatalogError(400, 'invalid_request');
      const url = new URL(request.url, 'http://localhost');
      if (request.method !== 'GET') return send(response, 404, { code: 'not_found', error: 'Rota não encontrada.' });
      if (url.pathname === '/health') return send(response, 200, { status: 'ok' });
      if (url.pathname === '/v1/catalog/search') {
        const { source, title, author, language } = searchParams(url);
        acquire(source);
        const provider = source === 'google' ? googleProvider : openLibraryProvider;
        return send(response, 200, { source, items: await provider.search(title, author, language) });
      }
      const prefix = '/v1/catalog/google/volumes/';
      if (url.pathname.startsWith(prefix)) {
        const id = url.pathname.slice(prefix.length);
        if (!validVolumeId(id) || url.searchParams.size) throw new CatalogError(400, 'invalid_request');
        acquire('google');
        return send(response, 200, await googleProvider.getVolume(id));
      }
      return send(response, 404, { code: 'not_found', error: 'Rota não encontrada.' });
    } catch (error) {
      const known = error instanceof CatalogError && Object.hasOwn(messages, error.code);
      const code = known ? error.code : 'provider_unavailable';
      return send(response, known ? error.status : 503, { code, error: messages[code] });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  return server;
}
