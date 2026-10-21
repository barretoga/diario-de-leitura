import test from 'node:test';
import assert from 'node:assert/strict';
import { durationParts, parseDuration, parseProgress, validateLogDraft } from '../src/logForm.ts';

const base = {
  bookId: 'book-0001', selectedAt: new Date('2026-09-22T12:00:00Z'),
  durationMode: 'minutes', minutesText: '', hoursText: '', hourMinutesText: '',
  progressText: '', unit: 'page', note: '',
};

test('switching from minutes to hours and back preserves the exact duration', () => {
  for (const minutes of [0, 1, 59, 60, 90, 10080]) {
    const parts = durationParts(minutes);
    assert.deepEqual(parseDuration({ ...base, durationMode: 'hours-minutes', ...parts }), { minutes, error: null });
    assert.deepEqual(parseDuration({ ...base, minutesText: minutes ? String(minutes) : '' }), { minutes, error: null });
  }
});

test('duration input rejects decimals, negative numbers, overflow and invalid hour-minute pairs', () => {
  for (const minutesText of ['1,5', '-3', '10081', 'abc', '1e2']) {
    assert.ok(parseDuration({ ...base, minutesText }).error);
  }
  for (const [hoursText, hourMinutesText] of [['1', '60'], ['168', '1'], ['-1', '2'], ['1.5', '0']]) {
    assert.ok(parseDuration({ ...base, durationMode: 'hours-minutes', hoursText, hourMinutesText }).error);
  }
  assert.equal(parseDuration({ ...base, durationMode: 'hours-minutes', hoursText: '', hourMinutesText: '30' }).minutes, 30);
});

test('optional duration, progress and note each independently allow a reading record', () => {
  const ids = ['book-0001'];
  const duration = validateLogDraft({ ...base, minutesText: '25' }, ids);
  assert.equal(duration.input.minutes, 25);
  assert.equal(duration.input.progress_value, null);
  const progress = validateLogDraft({ ...base, progressText: '12,5', unit: 'percent' }, ids);
  assert.equal(progress.input.minutes, 0); assert.equal(progress.input.progress_value, 12.5);
  assert.equal(progress.input.progress_unit, 'percent');
  const note = validateLogDraft({ ...base, note: '  Uma ideia  ' }, ids);
  assert.equal(note.input.note, 'Uma ideia'); assert.equal(note.input.minutes, 0);
  assert.equal(validateLogDraft(base, ids).errors.content !== undefined, true);
  assert.equal(validateLogDraft({ ...base, progressText: '0' }, ids).errors.content !== undefined, true);
});

test('numeric progress accepts decimal comma and checks percentage bounds', () => {
  assert.deepEqual(parseProgress('', 'page'), { value: null, error: null });
  assert.equal(parseProgress(',5', 'page').value, 0.5);
  assert.equal(parseProgress('100,1', 'percent').error !== null, true);
  assert.equal(parseProgress('100,1', 'page').value, 100.1);
  for (const value of ['-1', '1e2', 'x', '1,2,3']) assert.ok(parseProgress(value, 'page').error);
});

test('validation reports fields separately and avoids creating an invalid input', () => {
  const invalid = validateLogDraft({ ...base, bookId: 'deleted', selectedAt: new Date('bad'),
    hoursText: '1', durationMode: 'hours-minutes', hourMinutesText: '60',
    progressText: '101', unit: 'percent', note: 'x'.repeat(10001) }, ['book-0001']);
  assert.equal(invalid.input, null);
  assert.deepEqual(Object.keys(invalid.errors).sort(), ['book', 'date', 'duration', 'note', 'progress']);
  const edge = validateLogDraft({ ...base, minutesText: '10080', note: 'x'.repeat(10000) }, ['book-0001']);
  assert.equal(edge.input.minutes, 10080); assert.equal(edge.input.note.length, 10000);
});
