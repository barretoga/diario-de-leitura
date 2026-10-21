export type ReadingTimer = {
  started_at: string;
  resumed_at: string | null;
  elapsed_ms: number;
};

export function timerElapsedMs(timer: ReadingTimer, at: Date): number {
  const current = timer.resumed_at ? Math.max(0, at.getTime() - Date.parse(timer.resumed_at)) : 0;
  return Math.max(0, timer.elapsed_ms + current);
}

export function timerLogMinutes(timer: ReadingTimer, at: Date): number {
  return Math.ceil(timerElapsedMs(timer, at) / 60000);
}

export function timerClock(timer: ReadingTimer, at: Date): string {
  const seconds = Math.floor(timerElapsedMs(timer, at) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}
