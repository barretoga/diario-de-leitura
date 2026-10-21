import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogServer } from '../src/catalog/server.js';
import { readCatalogConfig } from '../src/catalog/main.js';
import { CatalogError } from '../src/catalog/providers.js';

async function withServer(run, options = {}) {
  const calls = [];
  const googleProvider = { async search(...args) { calls.push(args); return []; }, async getVolume(id) { calls.push(id); return { id }; } };
  const server = createCatalogServer({ googleProvider, openLibraryProvider: googleProvider, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const search = '?source=google&language=pt&title=Livro';

test('catalog validates input before providers and exposes no sync route', async () => {
  await withServer(async (base, calls) => {
    for (const query of ['', '?title=Livro&language=pt', '?source=bad&title=Livro&language=pt',
      '?source=google&title=Livro', '?source=google&title=L&language=pt',
      `${search}&author=${'x'.repeat(201)}`, `?source=google&language=pt&title=${'x'.repeat(201)}`,
      `${search}&source=openlibrary`, `${search}&token=secret`]) {
      assert.equal((await fetch(`${base}/v1/catalog/search${query}`)).status, 400, query);
    }
    assert.equal((await fetch(`${base}/v1/catalog/google/volumes/bad%2Fid`)).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await fetch(`${base}/v1/sync`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/v1/catalog/search${search}`, { method: 'POST' })).status, 404);
    const response = await fetch(`${base}/v1/catalog/search?source=google&title=${encodeURIComponent('  Café & livro  ')}&author=${encodeURIComponent(' Autora  Nome ')}&language=pt`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { source: 'google', items: [] });
    assert.deepEqual(calls, [['Café & livro', 'Autora Nome', 'pt']]);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-type'), /application\/json/);
  });
});

test('rolling global limits cover concurrent searches and Google details', async () => {
  let clock = 1000;
  await withServer(async (base, calls) => {
    const requests = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/v1/catalog/search${search.replace('google', 'openlibrary')}`)));
    assert.deepEqual(requests.map(r => r.status), [200, 200, 200, 429, 429]);
    assert.equal(requests[3].headers.get('retry-after'), '1');
    assert.equal(calls.length, 3);
    clock = 1999;
    assert.equal((await fetch(`${base}/v1/catalog/search${search.replace('google', 'openlibrary')}`)).status, 429);
    clock = 2000;
    assert.equal((await fetch(`${base}/v1/catalog/search${search.replace('google', 'openlibrary')}`)).status, 200);
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/v1/catalog/search${search}`)).status, 200);
    assert.equal((await fetch(`${base}/v1/catalog/google/volumes/abc`)).status, 429);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  }, { now: () => clock });
});

test('public errors never echo provider payloads or arbitrary thrown messages', async () => {
  for (const [status, code] of [[502, 'invalid_response'], [503, 'provider_unavailable'], [504, 'provider_timeout'], [429, 'rate_limited']]) {
    await withServer(async base => {
      const response = await fetch(`${base}/v1/catalog/search${search}`);
      assert.equal(response.status, status);
      const body = await response.json(); assert.equal(body.code, code);
      assert.equal(JSON.stringify(body).includes('secret'), false);
    }, { googleProvider: { async search() { const error = new CatalogError(status, code); error.message = 'secret'; throw error; } } });
  }
  await withServer(async base => {
    const response = await fetch(`${base}/v1/catalog/search${search}`);
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('secret'), false);
  }, { googleProvider: { async search() { throw new Error('secret'); } } });
});

test('catalog environment is validated independently of personal token and DB', () => {
  assert.throws(() => readCatalogConfig({}), /GOOGLE_BOOKS_API_KEY/);
  assert.throws(() => readCatalogConfig({ GOOGLE_BOOKS_API_KEY: 'key' }), /CATALOG_CONTACT_EMAIL/);
  assert.throws(() => readCatalogConfig({ GOOGLE_BOOKS_API_KEY: 'key', CATALOG_CONTACT_EMAIL: 'bad\nheader' }), /CATALOG_CONTACT_EMAIL/);
  assert.throws(() => readCatalogConfig({ GOOGLE_BOOKS_API_KEY: 'key', CATALOG_CONTACT_EMAIL: 'catalog@example.org', PORT: 'bad' }), /PORT/);
  assert.deepEqual(readCatalogConfig({ GOOGLE_BOOKS_API_KEY: 'key', CATALOG_CONTACT_EMAIL: 'catalog@example.org' }),
    { key: 'key', contactEmail: 'catalog@example.org', port: 8080 });
});
