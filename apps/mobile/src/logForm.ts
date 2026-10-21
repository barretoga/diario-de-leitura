import type { LogInput } from "./db";

export type DurationMode = "minutes" | "hours-minutes";
export type ProgressUnit = "page" | "location" | "percent";
export type LogDraft = {
  bookId: string;
  selectedAt: Date;
  durationMode: DurationMode;
  minutesText: string;
  hoursText: string;
  hourMinutesText: string;
  progressText: string;
  unit: ProgressUnit;
  note: string;
};
export type LogFormErrors = Partial<Record<"book" | "date" | "duration" | "progress" | "note" | "content", string>>;

function integer(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseDuration(draft: Pick<LogDraft, "durationMode" | "minutesText" | "hoursText" | "hourMinutesText">): { minutes: number; error: string | null } {
  if (draft.durationMode === "minutes") {
    const minutes = integer(draft.minutesText);
    if (minutes === null || minutes > 10080) return { minutes: 0, error: "Informe minutos inteiros de 0 a 10.080." };
    return { minutes, error: null };
  }
  const hours = integer(draft.hoursText);
  const minutes = integer(draft.hourMinutesText);
  if (hours === null || minutes === null || minutes > 59 || hours * 60 + minutes > 10080) {
    return { minutes: 0, error: "Informe horas inteiras e minutos de 0 a 59, até 168 horas no total." };
  }
  return { minutes: hours * 60 + minutes, error: null };
}

export function durationParts(minutes: number) {
  return { hoursText: minutes ? String(Math.floor(minutes / 60)) : "", hourMinutesText: minutes % 60 ? String(minutes % 60) : "" };
}

export function parseProgress(text: string, unit: ProgressUnit): { value: number | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { value: null, error: null };
  if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(trimmed)) {
    return { value: null, error: "Informe um número válido, como 45 ou 12,5." };
  }
  const value = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(value) || value < 0 || (unit === "percent" && value > 100)) {
    return { value: null, error: unit === "percent" ? "A porcentagem deve ficar entre 0 e 100." : "Informe um progresso válido a partir de zero." };
  }
  return { value, error: null };
}

export function validateLogDraft(draft: LogDraft, bookIds: readonly string[]): { input: LogInput | null; errors: LogFormErrors } {
  const errors: LogFormErrors = {};
  if (!draft.bookId || !bookIds.includes(draft.bookId)) errors.book = "Escolha um livro para esta leitura.";
  if (!Number.isFinite(draft.selectedAt.getTime())) errors.date = "Escolha uma data e hora válidas.";
  const duration = parseDuration(draft);
  if (duration.error) errors.duration = duration.error;
  const progress = parseProgress(draft.progressText, draft.unit);
  if (progress.error) errors.progress = progress.error;
  const note = draft.note.trim();
  if (note.length > 10000) errors.note = "A nota pode ter até 10.000 caracteres.";
  if (!errors.duration && !errors.progress && duration.minutes === 0 && (progress.value === null || progress.value === 0) && !note) {
    errors.content = "Informe tempo, progresso acima de zero ou uma nota para salvar.";
  }
  if (Object.keys(errors).length) return { input: null, errors };
  return { input: {
    book_id: draft.bookId,
    started_at: draft.selectedAt.toISOString(),
    minutes: duration.minutes,
    progress_value: progress.value,
    progress_unit: progress.value === null ? null : draft.unit,
    note,
  }, errors };
}
