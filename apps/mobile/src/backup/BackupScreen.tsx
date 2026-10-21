import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import { colors } from "../ui/tokens";
import { runWithNavigationLock } from "../navigation/operationLock";
import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { getStore, restoreBackup } from "../db";
import { pickBackup, shareBackup } from "./files";
import type { Backup, RestoreSummary } from "./format";

function Action({ label, onPress, disabled, secondary = false }: { label: string; onPress: () => void; disabled: boolean; secondary?: boolean }) { return <Button label={label} onPress={onPress} disabled={disabled} variant={secondary ? "text" : "primary"} />; }
function Summary({ summary, completed = false }: { summary: RestoreSummary; completed?: boolean }) {
  return <View style={styles.card}>
    <Text style={styles.title}>{completed ? "Restauração concluída" : "Prévia da restauração"}</Text>
    <Text style={styles.text}>{summary.booksAdded} livro(s) {completed ? "adicionado(s)" : "para adicionar"}</Text>
    <Text style={styles.text}>{summary.logsAdded} leitura(s) {completed ? "adicionada(s)" : "para adicionar"}</Text>
    <Text style={styles.text}>{summary.annotationsAdded} anotação(ões) {completed ? "adicionada(s)" : "para adicionar"}</Text>
    <Text style={styles.text}>{summary.metadataAdded} associação(ões) ao catálogo {completed ? "adicionada(s)" : "para adicionar"}</Text>
    <Text style={styles.text}>{summary.googleLinksAdded} vínculo(s) ao Google Books {completed ? "adicionado(s)" : "para adicionar"}</Text>
    <Text style={styles.text}>{summary.unchanged} registro(s) já presente(s), sem alterações</Text>
    <Text style={styles.text}>{summary.skipped.length} registro(s) {completed ? "ignorado(s)" : "que serão ignorados"}</Text>
    {summary.skipped.slice(0, 20).map(item => <View key={`${item.kind}:${item.id}`} style={styles.issue}>
      <Text style={styles.title}>{item.kind}: {item.label}</Text><Text style={styles.text}>{item.reason}</Text>
    </View>)}
    {summary.skipped.length > 20 && <Text style={styles.text}>E mais {summary.skipped.length - 20} registro(s) ignorado(s).</Text>}
  </View>;
}
export function BackupScreen({ onBack, onRestored, onBusyChange }: { onBack: () => void; onRestored: () => Promise<void>; onBusyChange: (busy: boolean) => void }) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ name: string; backup: Backup; summary: RestoreSummary } | null>(null);
  const [completed, setCompleted] = useState<RestoreSummary | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    await runWithNavigationLock(locked, busy => { setBusy(busy); onBusyChange(busy); }, async () => {
      try { await action(); }
      catch (error) { Alert.alert("Não foi possível concluir", error instanceof Error ? error.message : "Tente novamente. Seus registros existentes foram preservados."); }
    });
  }
  async function select() {
    setPreview(null); setCompleted(null);
    const selected = await pickBackup();
    if (selected) setPreview({ ...selected, summary: await getStore().previewRestore(selected.backup) });
  }
  async function restore() {
    if (!preview) return;
    const summary = await restoreBackup(preview.backup);
    setPreview(null); setCompleted(summary);
    await onRestored();
  }
  return <View style={styles.container}>
    
    <View style={styles.card}>
      <Text style={styles.title}>Exportar seus dados</Text>
      <Disclosure title="O que entra no backup">      <Text style={styles.text}>Inclui livros, leituras, datas, progresso, notas, anotações Kindle e vínculos aos catálogos. Capas e categorias do Google Books são consultadas novamente com internet. O arquivo não inclui token, chave de API ou configurações de sincronização. Registros excluídos não são exportados; os livros necessários aos registros ativos são incluídos.</Text></Disclosure>
      <Action label="Exportar backup" disabled={busy} onPress={() => { void run(async () => {
        setExported(null);
        const backup = await getStore().exportBackup();
        const name = await shareBackup(backup);
        setExported(name);
      }); }} />
      {exported && <Text style={styles.text}>Arquivo preparado: {exported}. Confira se você o salvou no destino escolhido; fechar o compartilhamento não confirma que uma cópia foi salva.</Text>}
    </View>
    <View style={styles.card}>
      <Text style={styles.title}>Restaurar de um arquivo</Text>
      <Text style={styles.text}>Somente registros ausentes serão adicionados. Dados diferentes e excluídos serão preservados.</Text>
      <Disclosure title="Como a restauração funciona"><Text style={styles.text}>Se um livro tiver diferenças, suas leituras ausentes também serão ignoradas. Confira a prévia antes de confirmar.</Text></Disclosure>
      <Action label="Selecionar backup" secondary disabled={busy} onPress={() => { void run(select); }} />
    </View>
    {preview && <>
      <Text style={styles.title}>{preview.name}</Text>
      <Text style={styles.text}>Exportado em {new Date(preview.backup.exportedAt).toLocaleString("pt-BR")}</Text>
      <Summary summary={preview.summary} />
      <Text style={styles.text}>A confirmação confere novamente os dados atuais. Se você usa sincronização, os registros adicionados entrarão na fila e poderão exigir resolução de conflitos.</Text>
      <Action label="Confirmar restauração" disabled={busy || preview.summary.booksAdded + preview.summary.logsAdded + preview.summary.annotationsAdded + preview.summary.metadataAdded + preview.summary.googleLinksAdded === 0}
        onPress={() => { void run(restore); }} />
      <Action label="Cancelar restauração" secondary disabled={busy} onPress={() => setPreview(null)} />
    </>}
    {completed && <Summary summary={completed} completed />}
    {busy && <ActivityIndicator accessibilityLabel="Processando arquivo" color={colors.accent} />}

  </View>;
}
const styles = StyleSheet.create({
  container: { gap: 14 }, card: { paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 12 },
  text: { color: colors.muted, fontSize: 14, lineHeight: 21 }, title: { color: colors.ink, fontWeight: "700", fontSize: 16 },
  button: { backgroundColor: colors.accent, borderRadius: 12, minHeight: 48, padding: 12, alignItems: "center", justifyContent: "center" },
  buttonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 }, secondary: { backgroundColor: colors.soft },
  secondaryText: { color: colors.accent }, disabled: { opacity: 0.5 }, issue: { borderTopWidth: 1, borderTopColor: colors.outline, paddingTop: 10, gap: 4 },
});
