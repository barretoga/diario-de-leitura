import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { dailyGoalStats, formatMinutes, type StatsLog } from "./readingStats";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Feedback } from "../ui/Feedback";
import { Overlay } from "../ui/Overlay";
import { colors, ui } from "../ui/tokens";
import { IconBadge } from "../ui/ActionIcon";
import { ProgressBar } from "../ui/ProgressBar";
export function GoalCard({ logs, now, goal, onSave }: { logs: StatsLog[]; now: Date; goal: number | null; onSave: (minutes: number | null) => Promise<void> }) {
  const [editing, setEditing] = useState(false); const [value, setValue] = useState(""); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null);
  const locked = useRef(false); const trigger = useRef<View>(null);
  const stats = dailyGoalStats(logs, now, goal);
  async function save(next: number | null) {
    if (locked.current) return; locked.current = true; setBusy(true); setMessage(null);
    try { await onSave(next); setEditing(false); setMessage(next === null ? "Meta desativada." : "Meta salva: " + formatMinutes(next) + " por dia."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Não foi possível salvar a meta."); }
    finally { locked.current = false; setBusy(false); }
  }
  function submit() { const trimmed = value.trim(); const minutes = Number(trimmed); if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) { setMessage("Informe minutos inteiros de 1 a 1.440."); return; } void save(minutes); }
  return <View style={ui.stack}><Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={goal === null ? "Definir meta diária" : "Alterar meta diária: " + formatMinutes(goal)} onPress={() => { setValue(goal === null ? "20" : String(goal)); setMessage(null); setEditing(true); }} style={styles.row}><IconBadge name={stats.reachedToday ? "success" : "goal"} /><View style={styles.text}><Text style={ui.title}>Meta diária</Text><Text style={ui.muted}>{goal === null ? "Definir meta" : formatMinutes(stats.todayMinutes) + " de " + formatMinutes(goal) + (stats.reachedToday ? " · Alcançada" : "")}</Text></View><Text style={styles.link}>{goal === null ? "Definir" : "Alterar"}</Text></Pressable>
    {goal !== null && <ProgressBar fraction={stats.fraction} label="Meta de hoje" now={stats.todayMinutes} max={goal} />}
    {message && !editing && <Feedback kind="success" message={message} onDismiss={() => setMessage(null)} />}
    <Overlay visible={editing} title="Meta diária" returnFocusRef={trigger} onClose={() => { if (!busy) { setEditing(false); setMessage(null); } }}><ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={ui.stack}><Field label="Minutos por dia" value={value} onChangeText={next => { setValue(next); setMessage(null); }} editable={!busy} keyboardType="number-pad" placeholder="Ex.: 20" hint="De 1 a 1.440 minutos." error={message ?? undefined} /><Button label="Salvar meta" busy={busy} onPress={submit} />{goal !== null && <Button label="Desativar meta" variant="text" disabled={busy} onPress={() => { void save(null); }} />}</ScrollView></Overlay>
  </View>;
}
const styles = StyleSheet.create({ row: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12 }, text: { flex: 1, gap: 4 }, link: { color: colors.accent, fontSize: 14, fontWeight: "600" }, track: { height: 5, backgroundColor: colors.border, borderRadius: 3, overflow: "hidden" }, fill: { height: 5, backgroundColor: colors.accent } });
