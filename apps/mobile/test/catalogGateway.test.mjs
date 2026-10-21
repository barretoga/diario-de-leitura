import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCatalog, getGoogleVolume } from '../src/catalog/catalogClient.ts';
import { clearLegacyGoogleCredentials } from '../src/catalog/googleCredentials.ts';

const google = { source: 'google', id: 'abc_123', title: 'O Livro', authors: ['Autora'], language: 'pt',
  categories: ['Ficção'], coverUri: 'https://books.google.com/books/content?id=abc_123', publishedYear: 2020,
  sourceUrl: 'https://books.google.com/books?id=abc_123' };
const open = { source: 'openlibrary', workKey: '/works/OL123W', title: 'O Livro', authors: ['Autora'],
  editionLanguage: 'por', coverId: 456, subjects: ['Fiction'], firstPublishYear: 1999,
  sourceUrl: 'https://openlibrary.org/works/OL123W' };
function config(t) {
  const original = process.env.EXPO_PUBLIC_CATALOG_API_URL;
  process.env.EXPO_PUBLIC_CATALOG_API_URL = 'https://catalog.example.org/';
  t.after(() => { if (original === undefined) delete process.env.EXPO_PUBLIC_CATALOG_API_URL; else process.env.EXPO_PUBLIC_CATALOG_API_URL = original; });
}

test('gateway requests contain only catalog parameters and no credential headers', async t => {
  config(t);
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://catalog.example.org');
    assert.equal(url.pathname, '/v1/catalog/search');
    assert.deepEqual(Object.fromEntries(url.searchParams), { source: 'google', title: 'Café & Livro', author: 'Autora', language: 'pt' });
    assert.equal(options.headers?.Authorization, undefined);
    assert.equal(options.headers?.['x-goog-api-key'], undefined);
    return new Response(JSON.stringify({ source: 'google', items: [{ ...google, leaked: 'secret' }] }));
  });
  const result = await searchCatalog('google', ' Café & Livro ', ' Autora ', 'pt');
  assert.equal(result[0].id, google.id);
  assert.equal('leaked' in result[0], false);
});

test('gateway validates both source shapes and detail ID', async t => {
  config(t);
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    return new Response(JSON.stringify(url.pathname.includes('/volumes/') ? google : { source: 'openlibrary', items: [open] }));
  });
  assert.equal((await searchCatalog('openlibrary', 'Livro', '', 'pt'))[0].coverId, 456);
  assert.equal((await getGoogleVolume('abc_123')).id, 'abc_123');
  await assert.rejects(getGoogleVolume('https://evil.example'), /Identificador/);
});

test('configuration must be HTTPS without credentials, query or fragment', async t => {
  config(t);
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error(); });
  for (const value of ['', 'http://catalog.example.org', 'https://user:secret@catalog.example.org', 'https://catalog.example.org?key=bad', 'https://catalog.example.org#bad']) {
    process.env.EXPO_PUBLIC_CATALOG_API_URL = value;
    await assert.rejects(searchCatalog('google', 'Livro', '', 'pt'), /catálogo/i);
  }
  assert.equal(calls, 0);
});

test('invalid payload, oversized result count and unsafe links are rejected', async t => {
  config(t);
  for (const body of [{}, { source: 'google', items: [open] }, { source: 'google', items: Array(21).fill(google) },
    { source: 'google', items: [{ ...google, sourceUrl: 'https://evil.example' }] },
    { source: 'google', items: [{ ...google, coverUri: 'javascript:alert(1)' }] },
    { source: 'openlibrary', items: Array(11).fill(open) }]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body)));
    await assert.rejects(searchCatalog(body.source === 'openlibrary' ? 'openlibrary' : 'google', 'Livro', '', 'pt'), /Resposta inesperada/);
    t.mock.restoreAll();
  }
});

test('HTTP and connection failures produce actionable errors without raw provider text', async t => {
  config(t);
  for (const [status, match] of [[429, /Aguarde/], [502, /resposta/i], [503, /manual/], [504, /demorou/]]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('secret upstream body', { status }));
    await assert.rejects(searchCatalog('google', 'Livro', '', 'pt'), error => match.test(error.message) && !error.message.includes('secret'));
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('secret'); });
  await assert.rejects(searchCatalog('google', 'Livro', '', 'pt'), /conexão/i);
});

test('legacy credentials are deleted idempotently and both removals are attempted on failure', async () => {
  const deleted = [];
  await clearLegacyGoogleCredentials(async key => { deleted.push(key); });
  await clearLegacyGoogleCredentials(async key => { deleted.push(key); });
  assert.deepEqual(deleted, ['google_books_api_key', 'google_books_android_certificate', 'google_books_api_key', 'google_books_android_certificate']);
  const attempted = [];
  await assert.rejects(clearLegacyGoogleCredentials(async key => { attempted.push(key); throw new Error('secret'); }),
    error => !error.message.includes('secret'));
  assert.equal(attempted.length, 2);
});
