import { isKOReaderLog } from "../logs/source.ts";
export { formatMinutes } from "../format/duration.ts";
export type StatsLog = {
  id: string; book_id: string; book_title: string; started_at: string; created_at: string;
  minutes: number; progress_value: number | null; progress_unit: "page" | "location" | "percent" | null;
  note: string; deleted_at?: string | null;
};
export type Period = 7 | 30 | "all";
export const MILESTONES = [1, 3, 7, 14, 30, 60, 100, 365] as const;
const DAY_MS = 86400000;

// Civil-day ordinals, not elapsed 24-hour intervals: consecutive days survive DST changes.
export function localDay(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}
export function dayDate(day: number): Date {
  const utc = new Date(day * DAY_MS);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), 12);
}
export function isReading(log: Pick<StatsLog, "minutes" | "progress_value" | "progress_unit"> & { id?: string }): boolean {
  return (!!log.id && isKOReaderLog(log.id)) || (Number.isFinite(log.minutes) && log.minutes > 0) ||
    (log.progress_value !== null && Number.isFinite(log.progress_value) && log.progress_value > 0 &&
      ["page", "location", "percent"].includes(log.progress_unit ?? ""));
}
export function eligibleLogs(logs: StatsLog[], now: Date): StatsLog[] {
  return logs.filter(log => !log.deleted_at && isReading(log) &&
    Number.isFinite(Date.parse(log.started_at)) && Date.parse(log.started_at) <= now.getTime());
}
function minutesOf(log: StatsLog) { return Number.isFinite(log.minutes) && log.minutes > 0 ? log.minutes : 0; }
export function dailyGoalStats(logs: StatsLog[], now: Date, goal: number | null, period: Period = 30) {
  const today = localDay(now);
  const start = period === "all" ? Number.NEGATIVE_INFINITY : today - period + 1;
  const byDay = new Map<number, number>();
  for (const log of eligibleLogs(logs, now)) {
    const day = localDay(new Date(log.started_at));
    if (day >= start) byDay.set(day, (byDay.get(day) ?? 0) + minutesOf(log));
  }
  const todayMinutes = byDay.get(today) ?? 0;
  return {
    todayMinutes,
    remaining: goal === null ? null : Math.max(0, goal - todayMinutes),
    reachedToday: goal !== null && todayMinutes >= goal,
    daysReached: goal === null ? 0 : [...byDay.values()].filter(minutes => minutes >= goal).length,
    fraction: goal === null ? 0 : Math.min(1, todayMinutes / goal),
  };
}
export function progressLabel(value: number, unit: StatsLog["progress_unit"]): string {
  const formatted = value.toLocaleString("pt-BR");
  return unit === "percent" ? `${formatted}%` : unit === "page" ? `página ${formatted}` : `posição ${formatted}`;
}
export function streakStats(logs: StatsLog[], now: Date) {
  const today = localDay(now);
  const days = [...new Set(eligibleLogs(logs, now).map(log => localDay(new Date(log.started_at))))].sort((a, b) => a - b);
  const daySet = new Set(days);
  let best = 0, run = 0, previous = Number.NEGATIVE_INFINITY;
  for (const day of days) { run = day === previous + 1 ? run + 1 : 1; best = Math.max(best, run); previous = day; }
  const readToday = daySet.has(today);
  let current = 0, end = readToday ? today : today - 1;
  while (daySet.has(end)) { current++; end--; }
  return {
    current, best, readToday, activeDays: days.length,
    recentWeek: Array.from({ length: 7 }, (_, i) => ({ day: today - 6 + i, read: daySet.has(today - 6 + i) })),
    milestones: MILESTONES.map(days => ({ days, achieved: best >= days })),
    nextMilestone: MILESTONES.find(days => days > best) ?? null,
  };
}
export type Streak = ReturnType<typeof streakStats>;
export function streakMessage(streak: Streak): string {
  if (streak.readToday) return "Leitura de hoje registrada. Cada dia conta.";
  if (streak.current) return "Você leu ontem. Uma leitura hoje dá continuidade à sua sequência.";
  return streak.best ? "Uma nova sequência pode começar hoje, no seu ritmo." : "Registre sua primeira leitura para começar uma sequência.";
}
export function periodStats(logs: StatsLog[], now: Date, period: Period) {
  const today = localDay(now), start = period === "all" ? Number.NEGATIVE_INFINITY : today - period + 1;
  const eligible = eligibleLogs(logs, now);
  const selected = eligible.filter(log => localDay(new Date(log.started_at)) >= start);
  const timed = selected.filter(log => minutesOf(log) > 0);
  const minutes = timed.reduce((sum, log) => sum + minutesOf(log), 0);
  const activeDays = new Set(selected.map(log => localDay(new Date(log.started_at)))).size;
  const byBook = new Map<string, StatsLog[]>();
  for (const log of selected) { const entries = byBook.get(log.book_id) ?? []; entries.push(log); byBook.set(log.book_id, entries); }
  const books = [...byBook.entries()].map(([id, entries]) => {
    const recent = [...entries].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id));
    const progress: { unit: NonNullable<StatsLog["progress_unit"]>; value: number; at: string }[] = [];
    for (const unit of ["page", "location", "percent"] as const) {
      const latest = recent.find(log => log.progress_unit === unit && log.progress_value !== null && Number.isFinite(log.progress_value));
      if (latest) progress.push({ unit, value: latest.progress_value!, at: latest.started_at });
    }
    return { id, title: recent[0].book_title, minutes: recent.reduce((sum, log) => sum + minutesOf(log), 0),
      sessions: recent.length, activeDays: new Set(recent.map(log => localDay(new Date(log.started_at)))).size, progress, recent };
  }).sort((a, b) => b.minutes - a.minutes || b.sessions - a.sessions || a.title.localeCompare(b.title));
  const chartLength = period === 7 ? 7 : 30;
  const byDay = new Map<number, { minutes: number; sessions: number }>();
  for (const log of eligible) {
    const day = localDay(new Date(log.started_at)), bucket = byDay.get(day) ?? { minutes: 0, sessions: 0 };
    bucket.minutes += minutesOf(log); bucket.sessions++; byDay.set(day, bucket);
  }
  const daily = Array.from({ length: chartLength }, (_, index) => {
    const day = today - chartLength + 1 + index;
    return { day, ...(byDay.get(day) ?? { minutes: 0, sessions: 0 }) };
  });
  const previous = period === "all" ? null : eligible.filter(log => {
    const day = localDay(new Date(log.started_at)); return day >= start - period && day < start;
  }).reduce((sum, log) => sum + minutesOf(log), 0);
  return { minutes, sessions: selected.length, activeDays, timedSessions: timed.length,
    averageMinutes: timed.length ? minutes / timed.length : null, books, daily,
    comparison: previous === null ? null : { previousMinutes: previous, difference: minutes - previous },
  };
}
export function saveFeedback(before: StatsLog[], after: StatsLog[], saved: Pick<StatsLog, "started_at" | "minutes" | "progress_value" | "progress_unit">, editing: boolean, now: Date): string {
  if (editing) return "Leitura atualizada. Sua sequência e estatísticas foram recalculadas.";
  if (Date.parse(saved.started_at) > now.getTime()) return "Registro salvo com data futura. Ele contará nas estatísticas quando essa data e hora chegar.";
  if (!isReading(saved)) return "Nota salva. Para contar como dia de leitura, registre tempo ou progresso acima de zero.";
  const previous = streakStats(before, now), next = streakStats(after, now);
  const achieved = MILESTONES.filter(days => previous.best < days && next.best >= days).at(-1);
  if (achieved) return achieved === 1 ? (next.current ? "Primeiro dia de leitura registrado! Sua sequência começou." : "Primeiro dia de leitura no histórico! Estatísticas atualizadas.") : `Marco alcançado: ${achieved} dias consecutivos de leitura!`;
  if (next.current > previous.current) return `Leitura salva. Sua sequência chegou a ${next.current} dias!`;
  if (localDay(new Date(saved.started_at)) < localDay(now)) return "Leitura anterior registrada. Seu histórico e suas estatísticas foram atualizados.";
  return "Leitura salva. Seu dia já está contado na sequência e os totais foram atualizados.";
}
