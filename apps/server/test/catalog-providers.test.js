import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleProvider, createOpenLibraryProvider } from '../src/catalog/providers.js';

const volume = (id = 'abc_123') => ({ id, volumeInfo: { title: 'O Livro', authors: ['Autora'], language: 'pt-BR',
  categories: ['Ficção'], publishedDate: '2020-02-03', imageLinks: { thumbnail: 'http://books.google.com/books/content?id=abc' } } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('Google search uses header key, Portuguese filter, fixed origin and preserves valid item order', async () => {
  const google = createGoogleProvider({ key: 'secret-key', fetchImpl: async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(url.searchParams.get('q'), 'intitle:Livro & café inauthor:Autora');
    assert.equal(url.searchParams.get('langRestrict'), 'pt');
    assert.equal(url.searchParams.get('maxResults'), '20');
    assert.equal(url.searchParams.get('key'), null);
    assert.equal(options.headers['x-goog-api-key'], 'secret-key');
    assert.equal(options.redirect, 'error');
    return json({ items: [volume('second'), {}, volume('first')] });
  } });
  const items = await google.search('Livro & café', 'Autora', 'pt');
  assert.deepEqual(items.map(item => item.id), ['second', 'first']);
  assert.equal(items[0].source, 'google');
  assert.equal(items[0].publishedYear, 2020);
  assert.equal(items[0].coverUri.startsWith('https://'), true);
  assert.equal(items[0].sourceUrl, 'https://books.google.com/books?id=second');
});

test('Google detail rejects invalid IDs and empty/malformed results; all languages has no restriction', async () => {
  let calls = 0;
  const google = createGoogleProvider({ key: 'key', fetchImpl: async input => {
    calls++;
    const url = new URL(input);
    assert.equal(url.searchParams.has('langRestrict'), false);
    return json(url.pathname.endsWith('/volumes') ? { totalItems: 0 } : volume());
  } });
  await assert.rejects(google.getVolume('https://evil.example'), { status: 400 });
  assert.equal(calls, 0);
  assert.deepEqual(await google.search('Livro', '', 'all'), []);
  assert.equal((await google.getVolume('abc_123')).id, 'abc_123');
  const bad = createGoogleProvider({ key: 'key', fetchImpl: async () => json({}) });
  await assert.rejects(bad.search('Livro', '', 'pt'), { status: 502 });
});

test('Open Library identifies application and selects Portuguese edition title and cover', async () => {
  const open = createOpenLibraryProvider({ contactEmail: 'catalog@example.org', fetchImpl: async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://openlibrary.org');
    assert.equal(url.searchParams.get('q'), 'Livro language:por');
    assert.equal(url.searchParams.get('lang'), 'pt');
    assert.equal(url.searchParams.get('limit'), '10');
    assert.equal(url.searchParams.get('author'), 'Autora');
    assert.ok(url.searchParams.get('fields').includes('editions.language'));
    assert.match(options.headers['User-Agent'], /catalog@example.org/);
    return json({ docs: [{ key: '/works/OL123W', title: 'The Book', author_name: ['Autora'], cover_i: 1,
      subject: ['Fiction'], editions: { docs: [{ title: 'The Book', language: ['eng'] },
        { title: 'O Livro', language: ['por'], cover_i: 2 }] } },
      { key: '/works/OL456W', title: 'English', editions: { docs: [{ title: 'English', language: ['eng'] }] } }] });
  } });
  const items = await open.search('Livro', 'Autora', 'pt');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'O Livro');
  assert.equal(items[0].coverId, 2);
  assert.equal(items[0].editionLanguage, 'por');
  assert.equal(items[0].sourceUrl, 'https://openlibrary.org/works/OL123W');
});

test('provider errors are sanitized; timeout also covers reading the body', async () => {
  for (const [upstream, expected] of [[429, 429], [403, 503], [500, 503]]) {
    const google = createGoogleProvider({ key: 'secret-key', fetchImpl: async () => new Response('secret-key', { status: upstream }) });
    await assert.rejects(google.search('Livro', '', 'pt'), error => error.status === expected && !error.message.includes('secret-key'));
  }
  const timeout = createGoogleProvider({ key: 'key', timeoutMs: 10, fetchImpl: async (_input, { signal }) => {
    return new Response(new ReadableStream({ start(controller) {
      const timer = setTimeout(() => controller.close(), 100);
      signal.addEventListener('abort', () => { clearTimeout(timer); controller.error(signal.reason); }, { once: true });
    } }));
  } });
  await assert.rejects(timeout.search('Livro', '', 'pt'), { status: 504 });
  const broken = createOpenLibraryProvider({ contactEmail: 'catalog@example.org', fetchImpl: async () => new Response('bad json') });
  await assert.rejects(broken.search('Livro', '', 'all'), { status: 502 });
});

test('large responses, unsafe covers and duplicate results are bounded safely', async () => {
  const unsafe = volume(); unsafe.volumeInfo.imageLinks.thumbnail = 'https://evil.example/cover.jpg';
  const google = createGoogleProvider({ key: 'key', fetchImpl: async () => json({ items: [unsafe, ...Array.from({ length: 30 }, (_, i) => volume(`id${i}`))] }) });
  const items = await google.search('Livro', '', 'all');
  assert.equal(items.length, 20);
  assert.equal(items[0].coverUri, null);
  const huge = createGoogleProvider({ key: 'key', fetchImpl: async () => new Response('x'.repeat(2_000_001)) });
  await assert.rejects(huge.search('Livro', '', 'all'), { status: 502 });
});
