import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../src/server.js';

const token = 'test-token-with-at-least-thirty-two-characters';
const book = {
  opId: 'create-book-001', entity: 'book', id: 'book-0001', baseVersion: 0, deleted: false,
  data: { title: 'Um livro', author: 'Autora', created_at: '2026-09-21T12:00:00.000Z' },
};
const log = {
  opId: 'create-log-0001', entity: 'log', id: 'reading-log-0001', baseVersion: 0, deleted: false,
  data: {
    book_id: 'book-0001', started_at: '2026-09-21T12:30:00.000Z', minutes: 25,
    progress_value: 40, progress_unit: 'percent', note: 'Leitura boa',
    created_at: '2026-09-21T12:30:00.000Z',
  },
};

async function withServer(run) {
  const server = createAppServer({ token, databasePath: ':memory:' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function syncRequest(base, operations, cursor = 0, auth = token) {
  return fetch(`${base}/v1/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({ operations, cursor }),
  });
}

test('exige token para sincronização', async () => {
  await withServer(async (base) => {
    const response = await syncRequest(base, [book], 0, 'wrong-token');
    assert.equal(response.status, 401);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  });
});

test('cria dados, reenvia sem duplicar e detecta edição concorrente', async () => {
  await withServer(async (base) => {
    const first = await (await syncRequest(base, [book, log])).json();
    assert.deepEqual(first.results.map((result) => result.status), ['accepted', 'accepted']);
    assert.equal(first.changes.length, 2);
    assert.equal(first.cursor, 2);

    const retry = await (await syncRequest(base, [book, log], first.cursor)).json();
    assert.deepEqual(retry.results.map((result) => result.version), [1, 1]);
    assert.equal(retry.changes.length, 0);

    const update = { ...book, opId: 'update-book-001', baseVersion: 1,
      data: { ...book.data, title: 'Título novo' } };
    const updated = await (await syncRequest(base, [update], first.cursor)).json();
    assert.equal(updated.results[0].version, 2);

    const stale = { ...book, opId: 'stale-book-001', baseVersion: 1,
      data: { ...book.data, title: 'Título antigo' } };
    const conflict = await (await syncRequest(base, [stale], first.cursor)).json();
    assert.equal(conflict.results[0].status, 'conflict');
    assert.equal(conflict.results[0].current.title, 'Título novo');
    assert.equal(conflict.changes.length, 1);
  });
});

test('recusa log para livro inexistente sem gravar evento', async () => {
  await withServer(async (base) => {
    const result = await (await syncRequest(base, [log])).json();
    assert.equal(result.results[0].status, 'invalid');
    assert.equal(result.changes.length, 0);
  });
});

test('rejeita reutilização de opId e cursor futuro', async () => {
  await withServer(async (base) => {
    await syncRequest(base, [book]);
    const changed = { ...book, data: { ...book.data, title: 'Outro título' } };
    const reused = await (await syncRequest(base, [changed])).json();
    assert.equal(reused.results[0].status, 'invalid');
    assert.match(reused.results[0].reason, /opId reutilizado/);

    const future = await syncRequest(base, [], 999);
    assert.equal(future.status, 400);
  });
});
