import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { validateIngest, canonicalJson } from '../src/koreader/contracts.js';
import { batch, unix } from './koreader-fixtures.js';
test('shared native plugin request fixture satisfies the server contract', () => {
  const request = JSON.parse(readFileSync(new URL('../../../integrations/koreader/fixtures/ingest-v1.json', import.meta.url)));
  const result = validateIngest(request, unix);
  assert.deepEqual(result.eventErrors,[null]); assert.equal(result.progressError,null);
});
test('validates envelope and individual items separately', () => {
  const input = batch(); input.events.push({ ...input.events[0], durationSeconds: 7201 }); input.progress.percent = 101;
  const result = validateIngest(input, unix);
  assert.equal(result.eventErrors[0], null); assert.match(result.eventErrors[1], /Duração/);
  assert.match(result.progressError, /Progresso/);
  assert.equal(validateIngest(batch({events:Array(100).fill(input.events[0])}), unix).eventErrors.length, 100);
  assert.throws(() => validateIngest(batch({events:Array(101).fill(input.events[0])}), unix), e => e.status === 400);
});
test('clock and duration limits include boundary', () => {
  const input = batch(); input.events[0].durationSeconds = 7200; input.events[0].startTime = unix + 300;
  assert.equal(validateIngest(input, unix).eventErrors[0], null);
  input.events[0].startTime++; assert.match(validateIngest(input, unix).eventErrors[0], /Relógio/);
});
test('rejects unsafe numeric values, invalid date and missing metadata', () => {
  for (const bad of [NaN, Infinity, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const input = batch(); input.events[0].nativeBookId = bad;
    assert.notEqual(validateIngest(input, unix).eventErrors[0], null);
  }
  for (const change of [{ document: {documentId:'a'.repeat(32),title:' ',author:''} }, {batchId:'not-uuid'}, {protocolVersion:2}]) {
    assert.throws(() => validateIngest(batch(change), unix), e => e.status === 400);
  }
  const input = batch(); input.progress.capturedAt = '2026-02-30T00:00:00.000Z';
  assert.notEqual(validateIngest(input, unix).progressError, null);
  input.document.author = 'a'.repeat(501); assert.throws(() => validateIngest(input, unix));
});
test('canonical ordering keeps array semantics and hostile text', () => {
  assert.equal(canonicalJson({b:1,a:2}), '{"a":2,"b":1}');
  assert.notEqual(canonicalJson([1,2]), canonicalJson([2,1]));
  const input = batch(); input.document.title = "'); DROP TABLE books;--"; input.document.author = '';
  assert.equal(validateIngest(input, unix).eventErrors[0], null);
});
