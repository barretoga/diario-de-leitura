import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { localDay, dayDate, streakStats, periodStats, dailyGoalStats, saveFeedback, isReading } from '../src/statistics/readingStats.ts';

const now = new Date(2026, 8, 21, 12);
function log(day, overrides = {}) {
  return { id: `log-${day}`, book_id: 'book', book_title: 'Livro',
    started_at: new Date(2026, 8, day, 10).toISOString(), created_at: now.toISOString(),
    minutes: 20, progress_value: null, progress_unit: null, note: '', ...overrides };
}

test('empty history has no streak, averages or achievements', () => {
  const streak = streakStats([], now);
  assert.equal(streak.current, 0); assert.equal(streak.best, 0);
  assert.equal(streak.nextMilestone, 1);
  assert.ok(streak.milestones.every(item => !item.achieved));
  const stats = periodStats([], now, 30);
  assert.equal(stats.averageMinutes, null); assert.equal(stats.daily.length, 30);
  assert.deepEqual(stats.comparison, { previousMinutes: 0, difference: 0 });
});
test('multiple readings on one day count once and yesterday keeps the streak active', () => {
  const logs = [log(18), log(19), log(20), log(20, { id: 'extra' })];
  const streak = streakStats(logs, now);
  assert.equal(streak.current, 3); assert.equal(streak.best, 3);
  assert.equal(streak.readToday, false); assert.equal(streak.activeDays, 3);
  assert.equal(streak.nextMilestone, 7);
  assert.equal(streakStats(logs, new Date(2026, 8, 22)).current, 0);
});
test('notes, zero progress, deleted, invalid and future records do not count', () => {
  const logs = [log(21, { minutes: 0, note: 'Nota' }),
    log(21, { minutes: 0, progress_value: 0, progress_unit: 'page' }),
    log(21, { deleted_at: now.toISOString() }), log(21, { started_at: 'invalid' }),
    log(21, { started_at: new Date(2026, 8, 21, 13).toISOString() })];
  assert.equal(streakStats(logs, now).best, 0);
  assert.equal(periodStats(logs, now, 'all').sessions, 0);
  assert.equal(streakStats(logs, new Date(2026, 8, 21, 13)).current, 1);
  assert.equal(isReading({ minutes: 0, progress_value: 12, progress_unit: null }), false);
});
test('progress alone counts as reading without inflating duration averages', () => {
  const stats = periodStats([log(20), log(21, { minutes: 0, progress_value: 50, progress_unit: 'page' })], now, 7);
  assert.equal(stats.sessions, 2); assert.equal(stats.activeDays, 2);
  assert.equal(stats.minutes, 20); assert.equal(stats.averageMinutes, 20);
  assert.equal(stats.timedSessions, 1);
});
test('historical gaps, retroactive additions and deletions recalculate achievements', () => {
  const logs = [log(1), log(2), log(4), log(5), log(6), log(7)];
  assert.equal(streakStats(logs, now).best, 4);
  const restored = [...logs, log(3)];
  assert.equal(streakStats(restored, now).best, 7);
  assert.equal(streakStats(restored, now).current, 0);
  assert.equal(streakStats(restored, now).milestones.find(m => m.days === 7).achieved, true);
  assert.equal(streakStats(restored.filter(l => l.id !== 'log-3'), now).best, 4);
});
test('seven day periods include today and six preceding days with adjacent comparison', () => {
  const stats = periodStats([log(7), log(8), log(14), log(15), log(21), log(22)], now, 7);
  assert.equal(stats.minutes, 40); assert.equal(stats.sessions, 2);
  assert.deepEqual(stats.comparison, { previousMinutes: 40, difference: 0 });
  assert.equal(stats.daily[0].day, localDay(new Date(2026, 8, 15)));
  assert.equal(stats.daily.at(-1).sessions, 1);
});
test('thirty day and all-history periods have distinct totals and bounded charts', () => {
  const logs = [log(-9), log(-8), log(21)]; // August 22 and 23: boundary for 30 days.
  const month = periodStats(logs, now, 30);
  assert.equal(month.sessions, 2); assert.equal(month.comparison.previousMinutes, 20);
  const all = periodStats(logs, now, 'all');
  assert.equal(all.sessions, 3); assert.equal(all.comparison, null); assert.equal(all.daily.length, 30);
});
test('books are grouped by ID and absolute progress uses the latest value per unit', () => {
  const logs = [log(18, { progress_value: 100, progress_unit: 'page' }),
    log(20, { progress_value: 90, progress_unit: 'page' }),
    log(21, { progress_value: 10, progress_unit: 'percent' }),
    log(21, { id: 'other', book_id: 'other', minutes: 5 })];
  const books = periodStats(logs, now, 'all').books;
  assert.equal(books.length, 2); assert.equal(books[0].minutes, 60);
  assert.deepEqual(books[0].progress.map(p => [p.unit, p.value]), [['page', 90], ['percent', 10]]);
  assert.equal(books[0].recent[0].id, 'log-21');
});
test('duration spanning midnight belongs to its recorded start day', () => {
  const stats = periodStats([log(20, { started_at: new Date(2026, 8, 20, 23, 50).toISOString(), minutes: 40 })], now, 7);
  assert.equal(stats.daily.at(-2).minutes, 40); assert.equal(stats.daily.at(-1).minutes, 0);
});
test('civil days survive DST and UTC timestamps use the device timezone', () => {
  const moduleUrl = new URL('../src/statistics/readingStats.ts', import.meta.url).href;
  const source = `import { localDay, streakStats } from ${JSON.stringify(moduleUrl)};
    const days = ['2026-03-07T17:00:00Z','2026-03-08T16:00:00Z','2026-03-09T16:00:00Z'];
    const logs = days.map((started_at, i) => ({id:String(i),started_at,minutes:1}));
    console.log(JSON.stringify({ days: days.map(d => localDay(new Date(d))), streak: streakStats(logs,new Date(days[2])).current,
      local: localDay(new Date('2026-09-21T02:00:00Z')), expected: localDay(new Date(2026,8,20)) }));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } }));
  assert.equal(result.days[1] - result.days[0], 1); assert.equal(result.days[2] - result.days[1], 1);
  assert.equal(result.streak, 3); assert.equal(result.local, result.expected);
  assert.equal(localDay(dayDate(localDay(now))), localDay(now));
});
test('save feedback celebrates milestones once and describes edits and future dates truthfully', () => {
  const today = log(21), before = [log(19), log(20)];
  assert.match(saveFeedback(before, [...before, today], today, false, now), /3 dias consecutivos/);
  assert.match(saveFeedback([today], [today, log(21, {id:'second'})], today, false, now), /já está contado/);
  assert.match(saveFeedback([], [log(1)], log(1), false, now), /no histórico/);
  assert.match(saveFeedback([], [today], today, false, now), /sequência começou/);
  assert.match(saveFeedback([], [today], today, true, now), /recalculadas/);
  assert.match(saveFeedback([], [log(22)], log(22), false, now), /data futura/);
  assert.match(saveFeedback([], [], log(21, {minutes:0}), false, now), /Nota salva/);
});

test('daily goal sums today only, counts met days by period and ignores future or progress-only records', () => {
  const logs = [log(14, { minutes: 30 }), log(20, { minutes: 15 }), log(20, { id: 'second', minutes: 10 }),
    log(21, { minutes: 15 }), log(21, { id: 'today-second', minutes: 10 }),
    log(21, { id: 'progress-only', minutes: 0, progress_value: 20, progress_unit: 'page' }),
    log(21, { id: 'future', minutes: 99, started_at: new Date(2026, 8, 21, 13).toISOString() })];
  const goal = dailyGoalStats(logs, now, 25, 7);
  assert.equal(goal.todayMinutes, 25); assert.equal(goal.remaining, 0);
  assert.equal(goal.reachedToday, true); assert.equal(goal.daysReached, 2); assert.equal(goal.fraction, 1);
  assert.equal(dailyGoalStats(logs, now, 25, 'all').daysReached, 3);
  assert.equal(dailyGoalStats(logs, now, null).reachedToday, false);
  assert.equal(dailyGoalStats(logs, now, 30).remaining, 5);
  assert.equal(dailyGoalStats(logs.filter(item => item.id !== 'today-second'), now, 25).reachedToday, false);
});
