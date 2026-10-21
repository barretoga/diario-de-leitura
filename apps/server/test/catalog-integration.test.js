import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogServer } from '../src/catalog/server.js';
import { createGoogleProvider, createOpenLibraryProvider } from '../src/catalog/providers.js';
import { searchCatalog, getGoogleVolume } from '../../mobile/src/catalog/catalogClient.ts';

test('mobile consumes actual gateway HTTP responses from both normalized providers', async t => {
  const upstream = async input => {
    const url = new URL(input);
    const volume = { id: 'test123', volumeInfo: { title: 'O Livro', authors: ['Autora'], language: 'pt', categories: ['Ficção'] } };
    return new Response(JSON.stringify(url.hostname === 'openlibrary.org'
      ? { docs: [{ key: '/works/OL123W', title: 'The Book', editions: { docs: [{ title: 'O Livro', language: ['por'] }] } }] }
      : url.pathname.endsWith('/test123') ? volume : { items: [volume] }));
  };
  const server = createCatalogServer({ googleProvider: createGoogleProvider({ key: 'server-secret', fetchImpl: upstream }),
    openLibraryProvider: createOpenLibraryProvider({ contactEmail: 'test@example.org', fetchImpl: upstream }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const originalUrl = process.env.EXPO_PUBLIC_CATALOG_API_URL;
  process.env.EXPO_PUBLIC_CATALOG_API_URL = 'https://catalog.example.org';
  t.after(() => { if (originalUrl === undefined) delete process.env.EXPO_PUBLIC_CATALOG_API_URL; else process.env.EXPO_PUBLIC_CATALOG_API_URL = originalUrl; });
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://catalog.example.org');
    assert.equal(url.searchParams.has('key'), false);
    assert.equal(options.headers.Authorization, undefined);
    return realFetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, options);
  });
  assert.equal((await searchCatalog('google', 'Livro', '', 'pt'))[0].title, 'O Livro');
  assert.equal((await searchCatalog('openlibrary', 'Livro', '', 'pt'))[0].editionLanguage, 'por');
  assert.equal((await getGoogleVolume('test123')).id, 'test123');
});
