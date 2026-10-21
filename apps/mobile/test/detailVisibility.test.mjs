import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldExpandLogDetails } from '../src/logs/detailVisibility.ts';
import * as visibility from '../src/logs/detailVisibility.ts';
test('existing notes and progress remain discoverable while editing', () => {
  const empty = { progressText: '', note: '' };
  assert.equal(shouldExpandLogDetails(empty, {}), false);
  assert.equal(shouldExpandLogDetails({ ...empty, note: 'Uma lembrança' }, {}), true);
  assert.equal(shouldExpandLogDetails({ ...empty, progressText: '0' }, {}), true);
});
test('errors in hidden fields or missing content reveal details', () => {
  for (const key of ['progress', 'note', 'content']) assert.equal(shouldExpandLogDetails({ progressText: '', note: '' }, { [key]: 'Corrija este campo' }), true);
  assert.equal(shouldExpandLogDetails({ progressText: '', note: '' }, { duration: 'Inválido' }), false);
});

test('each validation attempt reopens details after voluntary collapse even with identical errors', () => {
  assert.equal(typeof visibility.logDetailsVisibility, 'function');
  for (const key of ['progress', 'note', 'content']) {
    const errors = { [key]: 'Corrija este campo' };
    let expanded = visibility.logDetailsVisibility(false, { type: 'validate', errors });
    assert.equal(expanded, true);
    expanded = visibility.logDetailsVisibility(expanded, { type: 'toggle' });
    assert.equal(expanded, false);
    expanded = visibility.logDetailsVisibility(expanded, { type: 'validate', errors });
    assert.equal(expanded, true);
  }
  assert.equal(visibility.logDetailsVisibility(false, { type: 'validate', errors: { duration: 'Inválido' } }), false);
});
