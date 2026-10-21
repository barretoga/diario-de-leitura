import type { LogDraft, LogFormErrors } from "../logForm";
export function shouldExpandLogDetails(draft: Pick<LogDraft, "progressText" | "note">, errors: LogFormErrors): boolean {
  return draft.progressText.length > 0 || draft.note.length > 0 || !!(errors.progress || errors.note || errors.content);
}
export function logDetailsVisibility(expanded: boolean, event: { type: "toggle" } | { type: "validate"; errors: LogFormErrors }): boolean {
  if (event.type === "toggle") return !expanded;
  return expanded || !!(event.errors.progress || event.errors.note || event.errors.content);
}
