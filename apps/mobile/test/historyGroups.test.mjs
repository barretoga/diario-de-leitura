import test from 'node:test';
import assert from 'node:assert/strict';
import { groupHistory } from '../src/home/historyGroups.ts';
const log = (id, at, note = '') => ({ id, book_id: 'b1', book_title: 'Árvore', note, started_at: at.toISOString(), created_at: at.toISOString(), minutes: 0, progress_value: null, progress_unit: null });
test('search includes accents, local dates and note-only entries', () => {
  const at = new Date(2026, 9, 2, 10);
  const rows = [log('l1', at, 'Ótima reflexão')];
  for (const query of ['arvore', 'reflexao', at.toLocaleDateString('pt-BR')]) assert.equal(groupHistory(rows, query, 20).total, 1);
});
test('pagination limits displayed results without changing total', () => {
  const rows = Array.from({ length: 21 }, (_, i) => log(String(i), new Date(2026, 9, 2, 10, i)));
  assert.equal(groupHistory(rows, '', 20).total, 21);
  assert.equal(groupHistory(rows, '', 20).groups.flatMap(g => g.logs).length, 20);
  assert.equal(groupHistory(rows, '', 40).groups.flatMap(g => g.logs).length, 21);
});
test('days use local midnight and results have stable ordering', () => {
  const rows = [log('b', new Date(2026, 9, 1, 23, 55)), log('a', new Date(2026, 9, 2, 0, 5)), log('c', new Date(2026, 9, 2, 0, 5))];
  const groups = groupHistory(rows, '', 20).groups;
  assert.equal(groups.length, 2);
  assert.equal(groups[0].date.getDate(), 2);
  assert.deepEqual(groups[0].logs.map(l => l.id), ['a', 'c']);
  assert.equal(groups[1].logs[0].id, 'b');
  assert.deepEqual(rows.map(l => l.id), ['b', 'a', 'c']);
});
