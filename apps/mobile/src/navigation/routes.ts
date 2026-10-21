export type PrimaryScreen = "history" | "all-logs" | "statistics" | "library";
export type Screen = PrimaryScreen | "book-detail" | "new-book" | "new-log" | "settings" | "sync" | "backup" | "kindle" | "koreader" | "timer";
export type BackContext = { screen: Screen; bookReturn: Screen; logReturn: Screen; detailReturn: PrimaryScreen; settingsReturn: PrimaryScreen; timedDraft: boolean };
export function backTarget(context: BackContext): Screen | null {
  switch (context.screen) {
    case "history": return null;
    case "settings": return context.settingsReturn;
    case "sync": case "backup": case "kindle": case "koreader": return "settings";
    case "new-book": return context.bookReturn;
    case "new-log": return context.timedDraft ? "timer" : context.logReturn;
    case "book-detail": return context.detailReturn;
    default: return "history";
  }
}
