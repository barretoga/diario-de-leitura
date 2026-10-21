import { logPresentation } from "./source";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ReadingLog } from "../db";
import { formatMinutes, progressLabel } from "../statistics/readingStats";
import { ActionMenu } from "../ui/Overlay";
import { colors } from "../ui/tokens";
export function ReadingLogRow({ log, onEdit, onDelete, showDate = false, showTitle = true }: { log: ReadingLog; onEdit: (log: ReadingLog) => void; onDelete?: (log: ReadingLog) => void; showDate?: boolean; showTitle?: boolean }) {
  const presentation = logPresentation(log);
  const date = new Date(log.started_at).toLocaleString("pt-BR", showDate ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  const meta = [presentation.origin === "koreader" ? "KOReader" : null, date, presentation.origin === "koreader" || log.minutes > 0 ? presentation.duration : null, log.progress_value !== null && log.progress_unit ? progressLabel(log.progress_value, log.progress_unit) : null].filter(Boolean).join(" · ");
  return <View style={styles.row}><Pressable disabled={!presentation.editable} accessibilityRole={presentation.editable ? "button" : "text"} accessibilityLabel={`${presentation.editable ? "Editar leitura de" : "Leitura KOReader de"} ${log.book_title}, ${meta}${log.note ? `, ${log.note}` : ""}`} onPress={() => onEdit(log)} style={styles.content}>
    {showTitle && <Text numberOfLines={2} style={styles.title}>{log.book_title}</Text>}<Text style={styles.meta}>{meta}</Text>{!!log.note && <Text numberOfLines={2} style={styles.note}>{log.note}</Text>}
  </Pressable>{onDelete && <ActionMenu label={`Opções da leitura de ${log.book_title}`} items={[...(presentation.editable ? [{ label: "Editar", onPress: () => onEdit(log) }] : []), { label: "Excluir", danger: true, onPress: () => onDelete(log) }]} />}</View>;
}
const styles = StyleSheet.create({ row: { flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, content: { flex: 1, minHeight: 64, paddingVertical: 16, gap: 5 }, title: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: "600" }, meta: { color: colors.muted, fontSize: 14, lineHeight: 21 }, note: { color: colors.ink, fontSize: 14, lineHeight: 21 } });
