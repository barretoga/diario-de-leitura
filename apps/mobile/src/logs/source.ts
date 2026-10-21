import { formatMinutes } from "../format/duration.ts";
export function isKOReaderLog(id: string): boolean { return /^koreader-[a-f0-9]{64}$/.test(id); }
export function logPresentation(log: { id: string; minutes: number }) {
  const derived = isKOReaderLog(log.id);
  return { origin: derived ? "koreader" as const : "manual" as const, editable: !derived,
    duration: derived && log.minutes === 0 ? "Menos de 1 min" : formatMinutes(log.minutes),
    deleteMessage: derived ? "Excluir esta leitura do KOReader? Novos envios deste livro neste dia não vão recriá-la." : "Excluir esta leitura?" };
}
