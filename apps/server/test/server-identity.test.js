import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { getServerId } from '../src/identity.js';
import { batch } from './koreader-fixtures.js';

const token = 'test-token-with-at-least-thirty-two-characters';
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function withServer(run) {
  const server = createAppServer({ token, databasePath: ':memory:' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function currentBatch() {
  const b = batch(); const now = new Date();
  b.activationUnix = Math.floor(now.getTime() / 1000) - 200;
  b.events[0].startTime = b.activationUnix + 10;
  b.progress.capturedAt = now.toISOString();
  return b;
}

test('identidade criada uma vez e estável entre aberturas', () => {
  const directory = mkdtempSync(join(tmpdir(), 'id-'));
  try {
    const path = join(directory, 'db.sqlite');
    const a = openStore(path); const id = getServerId(a); a.close();
    const b = openStore(path); assert.equal(getServerId(b), id); b.close();
    assert.match(id, /^[0-9a-f-]{36}$/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GET /v1/server exige token e devolve serverId', () => withServer(async (base) => {
  assert.equal((await fetch(`${base}/v1/server`)).status, 401);
  assert.equal((await fetch(`${base}/v1/server`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const response = await fetch(`${base}/v1/server`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.protocolVersion, 1);
  assert.match(body.serverId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(body).sort(), ['protocolVersion', 'serverId']);
}));

test('serverId presente em /v1/sync, /v1/koreader/status e ingest', () => withServer(async (base) => {
  const { serverId } = await (await fetch(`${base}/v1/server`, { headers })).json();
  const sync = await (await fetch(`${base}/v1/sync`, { method: 'POST', headers, body: JSON.stringify({ operations: [], cursor: 0 }) })).json();
  const status = await (await fetch(`${base}/v1/koreader/status`, { headers })).json();
  const ingestResponse = await fetch(`${base}/v1/koreader/ingest`, { method: 'POST', headers, body: JSON.stringify(currentBatch()) });
  assert.equal(ingestResponse.status, 200);
  const ingest = await ingestResponse.json();
  assert.equal(sync.serverId, serverId);
  assert.equal(status.serverId, serverId);
  assert.equal(ingest.serverId, serverId);
}));
