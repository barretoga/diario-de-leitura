import { Button } from "../ui/Button";
import { ActionMenu } from "../ui/Overlay";
import { IconBadge, ActionIcon } from "../ui/ActionIcon";
import { colors, ui } from "../ui/tokens";
import { useEffect, useRef, useState } from "react";
import { runWithNavigationLock } from "../navigation/operationLock";
import { ActivityIndicator, Alert, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { timerClock, timerLogMinutes } from "./readingTimer";
import type { ReadingTimer } from "./readingTimer";

export function TimerScreen({ timer, onStart, onPause, onResume, onRegister, onDiscard, onBack, onBusyChange }: {
  timer: ReadingTimer | null;
  onStart: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onRegister: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onBack: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    const listener = AppState.addEventListener("change", state => { if (state === "active") setNow(new Date()); });
    return () => { clearInterval(interval); listener.remove(); };
  }, []);
  async function run(action: () => Promise<void>) {
    await runWithNavigationLock(locked, busy => { setBusy(busy); onBusyChange(busy); }, async () => {
      setError(null);
      try { await action(); setNow(new Date()); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível atualizar o cronômetro."); }
    });
  }
  function confirmDiscard() {
    Alert.alert("Descartar cronômetro?", "O tempo desta sessão será perdido. Nenhuma leitura será excluída.", [
      { text: "Cancelar", style: "cancel" },
      { text: "Descartar", style: "destructive", onPress: () => { void run(onDiscard); } },
    ]);
  }
  const minutes = timer ? timerLogMinutes(timer, now) : 0;
  return <View style={styles.container}>
    <View style={styles.menu}><ActionMenu label="Opções da sessão" disabled={busy} items={[{ label: "Descartar sessão", danger: true, disabled: !timer, onPress: confirmDiscard }]} /></View>
    <View style={styles.clockArea}><IconBadge name="timer" size={52} warm={!!timer && !timer.resumed_at} /><Text accessibilityLabel={"Tempo de leitura: " + (timer ? timerClock(timer, now) : "00:00:00")} adjustsFontSizeToFit minimumFontScale={0.5} numberOfLines={1} style={styles.clock}>{timer ? timerClock(timer, now) : "00:00:00"}</Text><Text accessibilityLiveRegion="polite" style={ui.muted}>{timer ? timer.resumed_at ? "Em andamento" : "Pausado" : "Pronto para começar"}</Text></View>
    {timer && minutes > 10080 && <Text style={ui.error}>Ajuste a duração ao registrar: o limite é 168 horas.</Text>}
    {!timer ? <Button icon="play" label="Iniciar cronômetro" busy={busy} onPress={() => { void run(onStart); }} /> : <><Button icon={timer.resumed_at ? "pause" : "play"} label={timer.resumed_at ? "Pausar" : "Continuar"} busy={busy} onPress={() => { void run(timer.resumed_at ? onPause : onResume); }} /><Button icon="edit" label="Registrar leitura" disabled={busy} variant="secondary" onPress={() => { void run(onRegister); }} /></>}
    {error && <Text accessibilityLiveRegion="polite" style={ui.error}>{error}</Text>}
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: helpOpen }} onPress={() => setHelpOpen(!helpOpen)} style={styles.help}><Text style={ui.muted}>Sobre o cronômetro</Text><ActionIcon name={helpOpen ? "up" : "down"} size={20} color={colors.muted} /></Pressable>
    {helpOpen && <View style={ui.stack}><Text style={ui.muted}>O tempo continua contando com a tela apagada ou em outro aplicativo. Pause ao interromper a leitura.</Text><Text style={ui.muted}>Registrar abre o formulário para revisar livro e duração. O tempo entra no histórico depois de salvar. Cancelar mantém a sessão pausada.</Text>{timer && <Text style={ui.muted}>Início: {new Date(timer.started_at).toLocaleString("pt-BR")}</Text>}</View>}
  </View>;
}
const styles = StyleSheet.create({ container: { gap: 24 }, menu: { alignItems: "flex-end" }, clockArea: { alignItems: "center", gap: 16, paddingVertical: 32, paddingHorizontal: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 24 }, clock: { fontSize: 48, lineHeight: 60, fontWeight: "600", letterSpacing: -1, color: colors.accent, fontVariant: ["tabular-nums"], width: "100%", textAlign: "center" }, help: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between" } });
