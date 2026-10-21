import test from 'node:test';
import assert from 'node:assert/strict';
import { backTarget } from '../src/navigation/routes.ts';
const base = { screen: 'history', bookReturn: 'library', logReturn: 'book-detail', detailReturn: 'library', settingsReturn: 'statistics', timedDraft: false };
test('primary destinations return home and home releases system back', () => {
  assert.equal(backTarget(base), null);
  for (const screen of ['all-logs', 'statistics', 'library']) assert.equal(backTarget({ ...base, screen }), 'history');
});
test('tools return to settings and settings preserves originating tab', () => {
  for (const screen of ['sync', 'backup', 'kindle', 'koreader']) assert.equal(backTarget({ ...base, screen }), 'settings');
  assert.equal(backTarget({ ...base, screen: 'settings' }), 'statistics');
});
test('book and log edits preserve their origin including conflicts and timer', () => {
  assert.equal(backTarget({ ...base, screen: 'new-book', bookReturn: 'sync' }), 'sync');
  assert.equal(backTarget({ ...base, screen: 'new-book', bookReturn: 'koreader' }), 'koreader');
  assert.equal(backTarget({ ...base, screen: 'book-detail' }), 'library');
  assert.equal(backTarget({ ...base, screen: 'new-log' }), 'book-detail');
  assert.equal(backTarget({ ...base, screen: 'new-log', logReturn: 'sync' }), 'sync');
  assert.equal(backTarget({ ...base, screen: 'new-log', timedDraft: true }), 'timer');
  assert.equal(backTarget({ ...base, screen: 'timer' }), 'history');
});
