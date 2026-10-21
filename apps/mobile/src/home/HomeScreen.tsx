import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Book, ReadingLog } from "../db";
import { dailyGoalStats, formatMinutes, streakStats } from "../statistics/readingStats";
import { timerClock, type ReadingTimer } from "../timer/readingTimer";
import { ReadingLogRow } from "../logs/ReadingLogRow";
import { Button } from "../ui/Button";
import { Feedback } from "../ui/Feedback";
import { Section } from "../ui/Section";
import { colors, typography, ui } from "../ui/tokens";
import { ActionIcon } from "../ui/ActionIcon";
import { ProgressBar } from "../ui/ProgressBar";

export type HomeSync = { configured: boolean; pending: number; conflicts: number; phase: "idle" | "syncing" | "offline" | "blocked"; message: string | null };
function ActiveSession({ timer }: { timer: ReadingTimer }) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => { if (!timer.resumed_at) return; const interval = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(interval); }, [timer.resumed_at]);
  return <View style={styles.session}><Text style={ui.muted}>{timer.resumed_at ? "Leitura em andamento" : "Leitura pausada"}</Text><Text style={styles.clock}>{timerClock(timer, clock)}</Text></View>;
}
export function HomeScreen({ books, logs, now, goal, timer, sync, feedback, onDismissFeedback, onRead, onNewBook, onTimer, onStatistics, onSync, onEditLog }: {
  books: Book[]; logs: ReadingLog[]; now: Date; goal: number | null; timer: ReadingTimer | null; sync: HomeSync; feedback: string | null; onDismissFeedback: () => void;
  onRead: () => void; onNewBook: () => void; onTimer: () => void; onStatistics: () => void; onSync: () => void; onEditLog: (log: ReadingLog) => void;
}) {
  const today = dailyGoalStats(logs, now, goal); const streak = streakStats(logs, now);
  const needsAttention = sync.conflicts > 0 || sync.phase === "blocked" || (sync.configured && sync.phase === "offline" && sync.pending > 0);
  return <View style={styles.container}>
    <View style={ui.stack}>
      {timer && <ActiveSession timer={timer} />}
      {!books.length && !timer && <Text style={ui.muted}>Adicione seu primeiro livro.</Text>}
      <Button icon={timer ? "timer" : books.length ? "edit" : "add"} label={timer ? "Abrir cronômetro" : books.length ? "Registrar leitura" : "Adicionar livro"} onPress={timer ? onTimer : books.length ? onRead : onNewBook} />
      {books.length > 0 && <Button icon={timer ? "edit" : "timer"} variant="text" label={timer ? "Registrar manualmente" : "Cronômetro"} onPress={timer ? onRead : onTimer} />}
    </View>
    {feedback && <Feedback kind="success" message={feedback} onDismiss={onDismissFeedback} />}
    <Pressable accessibilityRole="button" accessibilityLabel={["Estatísticas", formatMinutes(today.todayMinutes) + " hoje", streak.current + " dias seguidos", goal !== null ? "meta " + formatMinutes(goal) : ""].filter(Boolean).join(", ")} onPress={onStatistics} style={styles.today}>
      <View style={styles.metrics}><View style={styles.metric}><View style={styles.metricLabel}><ActionIcon name="clock" size={18} /><Text style={ui.muted}>Hoje</Text></View><Text style={styles.value}>{formatMinutes(today.todayMinutes)}</Text></View><View style={styles.metric}><View style={styles.metricLabel}><ActionIcon name="flame" size={18} color={colors.amber} /><Text style={ui.muted}>Sequência</Text></View><Text style={[styles.value, { color: colors.amber }]}>{streak.current} {streak.current === 1 ? "dia" : "dias"}</Text></View></View>
      {goal !== null && <><ProgressBar fraction={today.fraction} label="Meta de hoje" now={today.todayMinutes} max={goal} /><View style={styles.metricLabel}><ActionIcon name={today.reachedToday ? "success" : "goal"} size={16} /><Text style={ui.muted}>{today.reachedToday ? "Meta alcançada" : formatMinutes(today.todayMinutes) + " de " + formatMinutes(goal)}</Text></View></>}
    </Pressable>
    <Section title="Leituras recentes" icon="history">{logs.length ? logs.slice(0, 3).map(log => <ReadingLogRow key={log.id} log={log} onEdit={onEditLog} showDate />) : <Text style={ui.muted}>Suas leituras aparecerão aqui.</Text>}</Section>
    {needsAttention && <Pressable accessibilityRole="button" onPress={onSync} style={styles.notice}><Text style={ui.title}>{sync.conflicts ? sync.conflicts + " conflito(s) para resolver" : "Sincronização precisa de atenção"}</Text><Text style={ui.muted}>{sync.message || sync.pending + " pendência(s)"}</Text><Text style={styles.link}>Abrir sincronização</Text></Pressable>}
  </View>;
}
const styles = StyleSheet.create({ container: { gap: 28 }, session: { gap: 8 }, clock: { ...typography.metric, fontSize: 36, lineHeight: 44, color: colors.ink }, today: { gap: 16, padding: 20, backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: colors.border }, metrics: { flexDirection: "row", flexWrap: "wrap", gap: 16 }, metric: { flex: 1, minWidth: 110, gap: 6 }, metricLabel: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }, value: { ...typography.metric, color: colors.accent }, notice: { backgroundColor: colors.warm, borderRadius: 14, padding: 16, gap: 8, minHeight: 48 }, link: { color: colors.accent, fontSize: 14, fontWeight: "600" } });
