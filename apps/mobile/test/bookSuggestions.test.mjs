import test from 'node:test';
import assert from 'node:assert/strict';
import { BookSuggestions } from '../src/catalog/bookSuggestions.ts';
import { registrationDraft } from '../src/catalog/bookDraft.ts';

const google = { source: 'google', id: 'duna_123', title: 'Duna', authors: ['Frank Herbert'], language: 'pt',
  categories: ['Ficção'], coverUri: null, publishedYear: 1965, sourceUrl: 'https://books.google.com/books?id=duna_123' };
const open = { source: 'openlibrary', workKey: '/works/OL123W', title: 'Duna', authors: ['Frank Herbert'],
  editionLanguage: 'por', coverId: 456, subjects: ['Fiction'], firstPublishYear: 1965, sourceUrl: 'https://openlibrary.org/works/OL123W' };
const response = (source, items) => new Response(JSON.stringify({ source, items }));
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t, fetchImpl) {
  const previous = process.env.EXPO_PUBLIC_CATALOG_API_URL;
  process.env.EXPO_PUBLIC_CATALOG_API_URL = 'https://catalog.example.org';
  t.after(() => { if (previous === undefined) delete process.env.EXPO_PUBLIC_CATALOG_API_URL; else process.env.EXPO_PUBLIC_CATALOG_API_URL = previous; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', fetchImpl);
  const controller = new BookSuggestions(() => {});
  t.after(() => controller.dispose());
  return controller;
}

test('rapid typing waits for debounce and sends only the latest query after three characters', async t => {
  const calls = [];
  const c = setup(t, async input => { calls.push(new URL(input)); return response('google', [google]); });
  c.update('Du', '', 'pt'); t.mock.timers.tick(1000); await flush();
  assert.equal(calls.length, 0);
  c.update('Dun', '', 'pt'); t.mock.timers.tick(300);
  c.update('  Duna  ', 'Frank Herbert', 'pt'); t.mock.timers.tick(599); await flush();
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('title'), 'Duna');
  assert.equal(calls[0].searchParams.get('author'), 'Frank Herbert');
  assert.equal(c.state.phase, 'ready');
});

test('Google is primary; first suggestion is default and explicit choice uses the chosen edition', async t => {
  const second = { ...google, id: 'edition_2', title: 'Duna — edição ilustrada', sourceUrl: 'https://books.google.com/books?id=edition_2' };
  let calls = 0;
  const c = setup(t, async () => { calls++; return response('google', [google, second]); });
  c.update('Duna', '', 'pt'); t.mock.timers.tick(600); await flush();
  assert.equal(c.candidate().id, 'duna_123');
  c.select(c.state.items[1]);
  assert.equal(c.candidate().id, 'edition_2');
  assert.equal(c.state.phase, 'selected');
  assert.equal(calls, 1);
  assert.deepEqual(registrationDraft('Duna', '', c.candidate()), {
    title: 'Duna — edição ilustrada', author: 'Frank Herbert', catalog: { source: 'google', volume_id: 'edition_2' },
  });
});

test('no Google results triggers Open Library with the same title, author and language', async t => {
  const calls = [];
  const c = setup(t, async input => {
    const params = Object.fromEntries(new URL(input).searchParams); calls.push(params);
    return response(params.source, params.source === 'google' ? [] : [open]);
  });
  c.update('Duna', 'Frank Herbert', 'all'); t.mock.timers.tick(600); await flush();
  assert.deepEqual(calls, [
    { source: 'google', title: 'Duna', author: 'Frank Herbert', language: 'all' },
    { source: 'openlibrary', title: 'Duna', author: 'Frank Herbert', language: 'all' },
  ]);
  assert.equal(c.candidate().source, 'openlibrary');
  assert.equal(c.state.source, 'openlibrary');
});

test('provider-specific Google failure falls back once and does not mix sources', async t => {
  const calls = [];
  const c = setup(t, async input => {
    const source = new URL(input).searchParams.get('source'); calls.push(source);
    return source === 'google' ? new Response(JSON.stringify({ code: 'provider_unavailable' }), { status: 503 }) : response(source, [open]);
  });
  c.update('Duna', '', 'pt'); t.mock.timers.tick(600); await flush();
  assert.deepEqual(calls, ['google', 'openlibrary']);
  assert.deepEqual(c.state.items, [open]);
});

test('rate limit, configuration and gateway connection failures do not trigger repeated fallback requests', async t => {
  let calls = 0;
  const c = setup(t, async () => { calls++; return new Response(JSON.stringify({ code: 'rate_limited' }), { status: 429 }); });
  c.update('Duna', '', 'pt'); t.mock.timers.tick(600); await flush();
  assert.equal(c.state.phase, 'error'); assert.equal(c.candidate(), null);
  c.update('Duna', '', 'pt'); t.mock.timers.tick(6000); await flush();
  assert.equal(calls, 1);
  process.env.EXPO_PUBLIC_CATALOG_API_URL = 'http://invalid.example';
  c.update('Outro', '', 'pt'); t.mock.timers.tick(600); await flush();
  assert.equal(c.state.phase, 'error'); assert.equal(calls, 1);
  process.env.EXPO_PUBLIC_CATALOG_API_URL = 'https://catalog.example.org';
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('offline'); });
  c.update('Mais outro', '', 'pt'); t.mock.timers.tick(600); await flush();
  assert.equal(c.state.phase, 'error'); assert.equal(calls, 2);
});

test('out-of-order responses cannot replace current suggestions or trigger an old fallback', async t => {
  const requests = [];
  const c = setup(t, (input, options) => new Promise(resolve => {
    requests.push({ title: new URL(input).searchParams.get('title'), signal: options.signal, resolve });
  }));
  c.update('Antigo', '', 'pt'); t.mock.timers.tick(600); await flush();
  c.update('Atual', '', 'pt');
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(c.candidate(), null);
  t.mock.timers.tick(600); await flush();
  requests[1].resolve(response('google', [{ ...google, title: 'Atual' }])); await flush();
  requests[0].resolve(response('google', [])); await flush();
  assert.equal(c.candidate().title, 'Atual');
  assert.equal(requests.length, 2);
});

test('returning to a completed query reuses suggestions without another request and short text clears selection', async t => {
  let calls = 0;
  const c = setup(t, async () => { calls++; return response('google', [google]); });
  c.update('Duna', '', 'pt'); t.mock.timers.tick(600); await flush();
  c.update('Outro', '', 'pt'); assert.equal(c.candidate(), null);
  c.update('Duna', '', 'pt'); await flush();
  assert.equal(c.candidate().title, 'Duna'); assert.equal(calls, 1);
  c.update('Du', '', 'pt'); assert.equal(c.candidate(), null);
  t.mock.timers.tick(1000); await flush(); assert.equal(calls, 1);
});

test('leaving the form cancels scheduled and active requests', async t => {
  let calls = 0, signal;
  const c = setup(t, async (_input, options) => {
    calls++; signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  c.update('Duna', '', 'pt'); c.dispose(); t.mock.timers.tick(600); await flush(); assert.equal(calls, 0);
  c.update('Outro', '', 'pt'); t.mock.timers.tick(600); await flush();
  c.dispose(); assert.equal(signal.aborted, true); await flush(); assert.equal(calls, 1);
});

test('explicit retry is possible after a failed query, without automatic retry loops', async t => {
  let calls = 0;
  const c = setup(t, async () => { calls++; return calls === 1 ? new Response('{}', { status: 429 }) : response('google', [google]); });
  c.update('Duna', '', 'pt'); t.mock.timers.tick(600); await flush();
  c.retry(); t.mock.timers.tick(600); await flush();
  assert.equal(calls, 2); assert.equal(c.candidate().title, 'Duna');
});

test('manual draft stays available with pending search and validates local limits independently', async t => {
  let calls = 0;
  const c = setup(t, async () => { calls++; return response('google', [google]); });
  c.update('Duna', '', 'pt');
  assert.deepEqual(registrationDraft('  Meu título  ', '  Autora  ', c.candidate()), { title: 'Meu título', author: 'Autora', catalog: null });
  c.update('L'.repeat(201), '', 'pt'); t.mock.timers.tick(1000); await flush(); assert.equal(calls, 0);
  assert.equal(registrationDraft('L'.repeat(500), '', null).title.length, 500);
  assert.throws(() => registrationDraft('L'.repeat(501), '', null), /500/);
  assert.throws(() => registrationDraft('   ', '', null), /título/i);
  assert.equal(registrationDraft('Livro', 'Autor informado', { ...google, authors: [] }).author, 'Autor informado');
  assert.throws(() => registrationDraft('Livro', '', { ...google, authors: ['A'.repeat(500), 'B'] }), /500/);
});

test('editing a selected edition back to the original query clears the explicit selection', async t => {
  const second = { ...google, id: 'edition_2', title: 'Duna — edição ilustrada', sourceUrl: 'https://books.google.com/books?id=edition_2' };
  let calls = 0;
  const c = setup(t, async () => { calls++; return response('google', [google, second]); });
  c.update('Duna', 'Frank Herbert', 'pt'); t.mock.timers.tick(600); await flush();
  c.select(c.state.items[1]);
  c.update('Duna', 'Frank Herbert', 'pt');
  assert.equal(c.state.phase, 'ready');
  assert.equal(c.state.selection, null);
  assert.equal(c.candidate().id, 'duna_123');
  assert.equal(calls, 1);
});

test('provider timeout falls back while gateway timeout leaves manual registration available', async t => {
  let calls = 0;
  const c = setup(t, async input => {
    calls++;
    const source = new URL(input).searchParams.get('source');
    return source === 'google' ? new Response(JSON.stringify({ code: 'provider_timeout' }), { status: 504 }) : response(source, [open]);
  });
  c.update('Duna', '', 'pt'); t.mock.timers.tick(600); await flush();
  assert.equal(c.candidate().source, 'openlibrary'); assert.equal(calls, 2);
  t.mock.method(globalThis, 'fetch', (_input, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout'))));
  });
  c.update('Outro', '', 'pt'); t.mock.timers.tick(600); await flush();
  t.mock.timers.tick(12000); await flush();
  assert.equal(c.state.phase, 'error'); assert.equal(calls, 3);
  assert.deepEqual(registrationDraft('Outro', '', c.candidate()), { title: 'Outro', author: '', catalog: null });
});

test('failed fallback stops after two requests and an empty fallback does not select an unrelated record', async t => {
  const calls = [];
  const c = setup(t, async input => {
    const source = new URL(input).searchParams.get('source'); calls.push(source);
    return source === 'google' ? response(source, []) : new Response(JSON.stringify({ code: 'provider_unavailable' }), { status: 503 });
  });
  c.update('Duna', '', 'pt'); t.mock.timers.tick(600); await flush(); t.mock.timers.tick(30000); await flush();
  assert.equal(c.state.phase, 'error'); assert.equal(c.candidate(), null);
  assert.deepEqual(calls, ['google', 'openlibrary']);
  t.mock.method(globalThis, 'fetch', async input => response(new URL(input).searchParams.get('source'), []));
  c.update('Outro', '', 'pt'); t.mock.timers.tick(600); await flush();
  assert.equal(c.state.phase, 'ready'); assert.equal(c.state.items.length, 0); assert.equal(c.candidate(), null);
});

test('language and authors are part of the query cache and a manual draft can override ready suggestions', async t => {
  const calls = [];
  const c = setup(t, async input => { calls.push(Object.fromEntries(new URL(input).searchParams)); return response('google', [google]); });
  c.update('Duna', '', 'pt'); t.mock.timers.tick(600); await flush();
  assert.deepEqual(registrationDraft('Meu nome para o livro', 'Autoria digitada', null), { title: 'Meu nome para o livro', author: 'Autoria digitada', catalog: null });
  c.update('Duna', 'Frank Herbert', 'pt'); assert.equal(c.candidate(), null); t.mock.timers.tick(600); await flush();
  c.update('Duna', 'Frank Herbert', 'all'); assert.equal(c.candidate(), null); t.mock.timers.tick(600); await flush();
  assert.deepEqual(calls.map(({author, language}) => ({author, language})), [
    {author: '', language: 'pt'}, {author: 'Frank Herbert', language: 'pt'}, {author: 'Frank Herbert', language: 'all'},
  ]);
});

test('submission cannot import a changed suggestion or one not yet displayed to the reader', () => {
  const changed = { ...google, title: 'Outra edição' };
  assert.throws(() => registrationDraft('Duna', '', google, changed), /sugestões/i);
  assert.deepEqual(registrationDraft('Meu título', '', null, google), { title: 'Meu título', author: '', catalog: null });
  assert.equal(registrationDraft('Duna', '', google, google).catalog.volume_id, 'duna_123');
});
