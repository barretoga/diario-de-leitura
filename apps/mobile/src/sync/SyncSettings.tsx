import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import { colors, ui } from "../ui/tokens";
import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { AnnotationData, BookData, Issue, LogData, Snapshot } from "./types";
import type { SyncControls } from "./useSync";

function Action({ title, action, disabled }: { title: string; action: () => void; disabled?: boolean }) { return <Button label={title} onPress={action} disabled={disabled} variant={title === "Salvar conexão" || title === "Manter minha versão" ? "primary" : title === "Usar versão do servidor" ? "danger" : "text"} />; }
function Version({
  label,
  row,
  entity,
  books,
}: Readonly<{
  label: string;
  row: Snapshot | null;
  entity: Issue["entity"];
  books: { id: string; title: string }[];
}>) {
  return (
    <View style={styles.version}>
      <Text style={styles.bold}>
        {label}
        {row ? ` · versão ${row.version}` : ""}
      </Text>
      {!row ? (
        <Text style={ui.body}>Registro inexistente</Text>
      ) : (
        <>
          {!!row.deleted_at && <Text style={styles.error}>Excluído</Text>}
          {entity === "book" ? (
            <>
              <Text style={ui.body}>{(row as Snapshot & BookData).title}</Text>
              <Text style={ui.body}>{(row as Snapshot & BookData).author}</Text>
            </>
          ) : entity === "annotation" ? (
            <>
              <Text style={ui.body}>Livro: {books.find(book => book.id === (row as AnnotationData).book_id)?.title ?? (row as AnnotationData).book_id}</Text>
              <Text style={ui.body}>{({ highlight: "Destaque", note: "Nota", bookmark: "Marcador" })[(row as AnnotationData).kind]}</Text>
              <Text style={ui.body}>Página: {(row as AnnotationData).page ?? "—"} · Posição: {(row as AnnotationData).location ?? "—"}</Text>
              <Text style={ui.body}>Data no arquivo: {(row as AnnotationData).source_date ?? "—"}</Text>
              <Text style={ui.body}>{(row as AnnotationData).content}</Text>
            </>
          ) : (
            <>
              <Text style={ui.body}>
                Livro:{" "}
                {books.find(
                  (book) => book.id === (row as Snapshot & LogData).book_id,
                )?.title ?? (row as Snapshot & LogData).book_id}
              </Text>
              <Text style={ui.body}>
                Data:{" "}
                {new Date(
                  (row as Snapshot & LogData).started_at,
                ).toLocaleString("pt-BR")}
              </Text>
              <Text style={ui.body}>Minutos: {(row as Snapshot & LogData).minutes}</Text>
              <Text style={ui.body}>
                Progresso: {(row as Snapshot & LogData).progress_value ?? "—"}{" "}
                {
                  (
                    {
                      page: "páginas",
                      location: "posição",
                      percent: "%",
                    } as Record<string, string>
                  )[(row as Snapshot & LogData).progress_unit ?? ""]
                }
              </Text>
              <Text style={ui.body}>Nota: {(row as Snapshot & LogData).note || "—"}</Text>
            </>
          )}
        </>
      )}
    </View>
  );
}
export function SyncSettings({
  sync,
  editIssue,
  books,
}: Readonly<{
  sync: SyncControls;
  editIssue: (issue: Issue) => void;
  books: { id: string; title: string }[];
}>) {
  const [url, setUrl] = useState(sync.settings?.url ?? "");
  const [token, setToken] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [working, setWorking] = useState(false);
  useEffect(() => {
    setUrl(sync.settings?.url ?? "");
  }, [sync.settings?.url]);
  const busy = working || sync.configuring || sync.status.phase === "syncing";
  async function configure(save: boolean) {
    setWorking(true);
    try {
      await sync.configure(url, token, save);
      if (save) setToken("");
      Alert.alert(
        save ? "Conexão salva" : "Conexão autenticada",
        save
          ? "O token foi guardado no armazenamento seguro."
          : "O servidor respondeu corretamente. Nenhuma leitura foi enviada neste teste.",
      );
    } catch (error) {
      Alert.alert(
        "Não foi possível conectar",
        error instanceof Error
          ? error.message
          : "Verifique a conexão e o armazenamento seguro.",
      );
    } finally {
      setWorking(false);
    }
  }
  async function migrate() {
    setWorking(true);
    try {
      const message = await sync.migrate(newUrl);
      setNewUrl("");
      Alert.alert("Servidor migrado", message);
    } catch (error) {
      Alert.alert(
        "Não foi possível migrar",
        error instanceof Error ? error.message : "Nada foi alterado. Tente novamente.",
      );
    } finally {
      setWorking(false);
    }
  }
  async function resolve(issue: Issue, choice: "local" | "remote") {
    setWorking(true);
    try {
      await sync.resolve(issue, choice);
    } catch {
      Alert.alert(
        "Não foi possível resolver",
        "Os dados foram preservados. Tente novamente.",
      );
    } finally {
      setWorking(false);
    }
  }
  return (
    <View style={styles.container}>
      <Disclosure title="Conexão" initialOpen={!sync.settings?.url || !!sync.settings?.fatal}><Text style={styles.bold}>Servidor HTTPS</Text>
      <TextInput
        accessibilityLabel="URL do servidor"
        value={url}
        onChangeText={setUrl}
        editable={!sync.settings?.url && !busy}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://leituras.exemplo.com"
        style={styles.input}
      />
      {!!sync.settings?.url && (
        <>
          <Text style={ui.body}>
            Este banco está vinculado a este endereço. Para trocar de domínio,
            informe o novo endereço: ele só é aceito se levar ao mesmo servidor.
          </Text>
          <Text style={styles.bold}>Novo endereço</Text>
          <TextInput
            accessibilityLabel="Novo endereço do servidor"
            value={newUrl}
            onChangeText={setNewUrl}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://novo.exemplo.com"
            style={styles.input}
          />
          <Action
            title="Migrar servidor"
            action={() => void migrate()}
            disabled={busy || !newUrl.trim()}
          />
        </>
      )}
      <Text style={styles.bold}>Token</Text>
      <TextInput
        accessibilityLabel="Token do servidor"
        value={token}
        onChangeText={setToken}
        editable={!busy}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={
          sync.settings?.url
            ? "Deixe vazio para manter o token salvo"
            : "Token configurado no servidor"
        }
        style={styles.input}
      />
      <Action
        title="Testar conexão"
        action={() => void configure(false)}
        disabled={busy}
      />
      <Action
        title="Salvar conexão"
        action={() => void configure(true)}
        disabled={busy}
      />
      <Action
        title={
          sync.settings?.paused
            ? "Retomar sincronização"
            : "Pausar sincronização"
        }
        disabled={working || sync.configuring || !sync.settings?.url}
        action={() => {
          void sync
            .pause(!sync.settings?.paused)
            .catch(() => Alert.alert("Não foi possível alterar a pausa"));
        }}
      />
      </Disclosure><Text style={styles.bold}>Correções ({sync.issues.length})</Text>
      <Disclosure title="Sobre a sincronização"><Text style={ui.muted}>
        Livros com pendências precisam ser sincronizados antes dos seus logs.
        Seus registros continuam disponíveis offline.
      </Text></Disclosure>
      {sync.issues.length === 0 && (
        <Text style={ui.body}>Nenhum conflito ou erro de validação.</Text>
      )}
      {sync.issues.map((issue) => (
        <View key={`${issue.entity}:${issue.id}`} style={styles.card}>
          <Text style={styles.bold}>
            {issue.conflict ? "Conflito" : "Correção necessária"} ·{" "}
            {issue.entity === "book" ? "Livro" : issue.entity === "annotation" ? "Anotação" : "Log"}
          </Text>
          {!!issue.error && <Text style={styles.error}>{issue.error}</Text>}
          <Version
            label="Minha versão"
            row={issue.local}
            entity={issue.entity}
            books={books}
          />
          {issue.conflict && (
            <>
              <Version
                label="Servidor"
                row={issue.remote}
                entity={issue.entity}
                books={books}
              />
              <Action
                title="Manter minha versão"
                disabled={busy}
                action={() => void resolve(issue, "local")}
              />
              <Action
                title="Usar versão do servidor"
                disabled={busy}
                action={() =>
                  Alert.alert(
                    "Usar versão do servidor?",
                    "A alteração local deste registro será descartada.",
                    [
                      { text: "Cancelar", style: "cancel" },
                      {
                        text: "Usar servidor",
                        style: "destructive",
                        onPress: () => void resolve(issue, "remote"),
                      },
                    ],
                  )
                }
              />
            </>
          )}
          {!issue.local.deleted_at && (
            <Action
              title="Editar registro local"
              disabled={busy}
              action={() => editIssue(issue)}
            />
          )}
        </View>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { gap: 12 },
  bold: { fontSize: 16, fontWeight: "600", color: colors.ink },
  input: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: colors.outline,
    borderRadius: 11,
    minHeight: 52,
    fontSize: 16,
    color: colors.ink,
    padding: 12,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    minHeight: 48,
    padding: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: { color: "white", fontWeight: "700" },
  disabled: { opacity: 0.5 },
  card: { paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 12 },
  version: { backgroundColor: "#F7F5F0", padding: 12, borderRadius: 8, gap: 5 },
  error: { color: colors.danger },
});
