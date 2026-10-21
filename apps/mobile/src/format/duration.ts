export function formatMinutes(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const remainder = rounded % 60;
  return `${Math.floor(rounded / 60)}h${remainder ? ` ${remainder}min` : ""}`;
}
