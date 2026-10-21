import type { ReadingLog } from "../db";
export function normalizedSearch(text: string): string { return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR"); }
export function groupHistory(logs: readonly ReadingLog[], query: string, limit: number): { total: number; groups: { key: string; date: Date; logs: ReadingLog[] }[] } {
  const term = normalizedSearch(query.trim());
  const filtered = logs.filter(log => !term || normalizedSearch(`${log.book_title} ${log.note} ${new Date(log.started_at).toLocaleDateString("pt-BR")}`).includes(term))
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id));
  const groups = new Map<string, { key: string; date: Date; logs: ReadingLog[] }>();
  for (const log of filtered.slice(0, Math.max(0, limit))) {
    const date = new Date(log.started_at); const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (!groups.has(key)) groups.set(key, { key, date, logs: [] });
    groups.get(key)!.logs.push(log);
  }
  return { total: filtered.length, groups: [...groups.values()] };
}
