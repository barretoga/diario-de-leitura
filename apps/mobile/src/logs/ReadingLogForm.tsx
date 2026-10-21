import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { Book } from "../db";
import { parseDuration, parseProgress, type LogDraft, type LogFormErrors } from "../logForm";
import { formatMinutes } from "../statistics/readingStats";
import { logDetailsVisibility, shouldExpandLogDetails } from "./detailVisibility";
import { BookPicker } from "./BookPicker";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { ActionIcon } from "../ui/ActionIcon";
import { colors, ui } from "../ui/tokens";

export type ReadingLogFormProps = {
  books: Book[]; draft: LogDraft; errors: LogFormErrors; validationAttempt: number; saving: boolean; editing: boolean; timedDraft: boolean;
  onChange: (patch: Partial<LogDraft>) => void; onSave: () => void; onCancel: () => void;
  onPickDateTime: (mode: "date" | "time") => void; onAddBook: () => void; dateTimeAccessory?: ReactNode;
};
export function ReadingLogForm({ books, draft, errors, validationAttempt, saving, editing, timedDraft, onChange, onSave, onCancel, onPickDateTime, onAddBook, dateTimeAccessory }: ReadingLogFormProps) {
  const [choosing, setChoosing] = useState(false);
  const [expanded, dispatchDetails] = useReducer(logDetailsVisibility, shouldExpandLogDetails(draft, errors));
  const [noteFocused, setNoteFocused] = useState(false);
  const bookTrigger = useRef<View>(null); const noteInput = useRef<TextInput>(null); const progressInput = useRef<TextInput>(null);
  useEffect(() => {
    if (!(errors.progress || errors.note || errors.content)) return;
    dispatchDetails({ type: "validate", errors });
    const timeout = setTimeout(() => (errors.note ? noteInput : progressInput).current?.focus(), 150);
    return () => clearTimeout(timeout);
  }, [errors.progress, errors.note, errors.content, validationAttempt]);
  const book = books.find(item => item.id === draft.bookId);
  const duration = parseDuration(draft); const progress = parseProgress(draft.progressText, draft.unit);
  return <View style={styles.form}>
    {timedDraft && <Text style={ui.muted}>Tempo do cronômetro</Text>}
    <View style={ui.stack}><Text style={styles.label}>Livro</Text>
      <Pressable ref={bookTrigger} disabled={saving} accessibilityRole="button" accessibilityLabel={book ? `Trocar livro: ${book.title}` : "Escolher livro"} onPress={() => setChoosing(true)} style={styles.selector}><View style={styles.book}><Text numberOfLines={2} style={ui.body}>{book?.title ?? "Escolher livro"}</Text>{!!book?.author && <Text numberOfLines={1} style={ui.muted}>{book.author}</Text>}</View><ActionIcon name="chevron" /></Pressable>
      {errors.book && <Text accessibilityLiveRegion="polite" style={ui.error}>{errors.book}</Text>}
      {!books.length && <Button label="Adicionar livro" variant="secondary" disabled={saving} onPress={onAddBook} />}
    </View>
    <View style={styles.dateRow}>{(["date", "time"] as const).map(mode => <Pressable key={mode} disabled={saving} accessibilityRole="button" accessibilityLabel={(mode === "date" ? "Data: " : "Hora: ") + (mode === "date" ? draft.selectedAt.toLocaleDateString("pt-BR") : draft.selectedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }))} onPress={() => onPickDateTime(mode)} style={styles.dateButton}><Text style={ui.muted}>{mode === "date" ? "Data" : "Hora"}</Text><Text style={ui.body}>{mode === "date" ? draft.selectedAt.toLocaleDateString("pt-BR") : draft.selectedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</Text></Pressable>)}</View>
    {errors.date && <Text style={ui.error}>{errors.date}</Text>}{dateTimeAccessory}
    <View style={ui.stack}><Text style={styles.label}>Duração · opcional</Text>
      <View style={styles.segments}>{([ ["minutes", "Minutos"], ["hours-minutes", "Horas e minutos"] ] as const).map(([value, label]) => <Pressable key={value} disabled={saving} accessibilityRole="button" accessibilityState={{ selected: draft.durationMode === value }} onPress={() => onChange({ durationMode: value })} style={[styles.segment, draft.durationMode === value && styles.selected]}><Text style={[styles.segmentText, draft.durationMode === value && styles.selectedText]}>{label}</Text></Pressable>)}</View>
      {draft.durationMode === "minutes" ? <Field label="Minutos" value={draft.minutesText} editable={!saving} keyboardType="number-pad" placeholder="Ex.: 30" onChangeText={minutesText => onChange({ minutesText })} /> : <View style={styles.dateRow}><View style={styles.part}><Field label="Horas" value={draft.hoursText} editable={!saving} keyboardType="number-pad" placeholder="0" onChangeText={hoursText => onChange({ hoursText })} /></View><View style={styles.part}><Field label="Minutos" value={draft.hourMinutesText} editable={!saving} keyboardType="number-pad" placeholder="0–59" onChangeText={hourMinutesText => onChange({ hourMinutesText })} /></View></View>}
      {(errors.duration || duration.error) && <Text accessibilityLiveRegion="polite" style={ui.error}>{errors.duration || duration.error}</Text>}
      {!duration.error && duration.minutes > 0 && <Text style={ui.muted}>{formatMinutes(duration.minutes)} no total</Text>}
    </View>
    <View style={styles.details}><Pressable disabled={saving} accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => dispatchDetails({ type: "toggle" })} style={styles.detailToggle}><Text style={styles.detailTitle}>{expanded ? "Progresso e nota" : "Adicionar progresso ou nota"}</Text><ActionIcon name={expanded ? "up" : "down"} size={20} /></Pressable>
      {!expanded && (draft.progressText || draft.note) && <Text numberOfLines={2} style={ui.muted}>{[draft.progressText ? "Progresso: " + draft.progressText : "", draft.note].filter(Boolean).join(" · ")}</Text>}
      {expanded && <View style={ui.stack}>
        <Field icon="progress" ref={progressInput} label="Progresso · opcional" value={draft.progressText} editable={!saving} keyboardType="decimal-pad" placeholder={draft.unit === "percent" ? "Ex.: 45" : "Ex.: 120"} error={errors.progress || progress.error || undefined} onChangeText={progressText => onChange({ progressText })} />
        <View style={styles.segments}>{([ ["page", "Página"], ["location", "Posição"], ["percent", "%"] ] as const).map(([value, label]) => <Pressable key={value} disabled={saving} accessibilityRole="button" accessibilityLabel={value === "percent" ? "Porcentagem" : label} accessibilityState={{ selected: draft.unit === value }} onPress={() => onChange({ unit: value })} style={[styles.segment, draft.unit === value && styles.selected]}><Text style={[styles.segmentText, draft.unit === value && styles.selectedText]}>{label}</Text></Pressable>)}</View>
        <Field ref={noteInput} label="Nota · opcional" value={draft.note} editable={!saving} multiline placeholder="Uma lembrança da leitura" error={errors.note || (draft.note.trim().length > 10000 ? "A nota pode ter até 10.000 caracteres." : undefined)} onFocus={() => setNoteFocused(true)} onBlur={() => setNoteFocused(false)} hint={noteFocused || draft.note.length >= 9000 ? `${draft.note.length}/10.000` : undefined} onChangeText={note => onChange({ note })} />
      </View>}
    </View>
    {errors.content && <Text accessibilityLiveRegion="polite" style={ui.error}>Informe tempo, progresso ou uma nota.</Text>}
    <Button icon="save" label={editing ? "Salvar alterações" : "Salvar leitura"} busy={saving} onPress={onSave} /><Button label="Cancelar" variant="text" disabled={saving} onPress={onCancel} />
    <BookPicker visible={choosing} books={books} selectedId={draft.bookId} onSelect={bookId => { onChange({ bookId }); setChoosing(false); }} onClose={() => setChoosing(false)} returnFocusRef={bookTrigger} />
  </View>;
}
const styles = StyleSheet.create({ form: { gap: 24 }, label: { color: colors.ink, fontSize: 14, fontWeight: "600" }, selector: { borderWidth: 1, borderColor: colors.outline, borderRadius: 8, padding: 12, minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.surface }, book: { flex: 1, gap: 4 }, dateRow: { flexDirection: "row", gap: 12 }, dateButton: { flex: 1, minHeight: 64, padding: 12, borderWidth: 1, borderColor: colors.outline, borderRadius: 8, gap: 4, backgroundColor: colors.surface }, part: { flex: 1 }, segments: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, segment: { flex: 1, minWidth: 64, minHeight: 48, alignItems: "center", justifyContent: "center", padding: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.outline }, selected: { backgroundColor: colors.soft, borderColor: colors.accent }, segmentText: { fontSize: 14, color: colors.muted, textAlign: "center" }, selectedText: { color: colors.accent, fontWeight: "600" }, details: { gap: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }, detailToggle: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12 }, detailTitle: { flex: 1, color: colors.accent, fontSize: 16, fontWeight: "500" } });
