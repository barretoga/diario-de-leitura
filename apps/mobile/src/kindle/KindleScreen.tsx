import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import { ActionMenu } from "../ui/Overlay";
import { colors } from "../ui/tokens";
import { runWithNavigationLock } from "../navigation/operationLock";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { deleteAnnotation, getStore, importClippings, moveAnnotation } from "../db";
import type { Book } from "../db";
import type { AnnotationData, Snapshot } from "../sync/types";
import { normalizeName } from "./parser";
import type { Clippings } from "./parser";
import { pickClippings } from "./files";

export const kindLabel = { highlight: "Destaque", note: "Nota", bookmark: "Marcador" };
type Annotation = Snapshot & AnnotationData & { book_title: string };
function Action({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) { return <Button label={label} onPress={onPress} disabled={disabled} variant={label.startsWith("Selecionar") || label.startsWith("Importar") ? "primary" : "text"} />; }
function Detail({ row }: { row: Pick<AnnotationData, "kind" | "content" | "location" | "page" | "source_date"> }) {
  return <>
    <Text style={styles.title}>{kindLabel[row.kind]}</Text>
    <Text style={styles.text}>{[row.page !== null ? "Página " + row.page : "", row.location ? "Posição " + row.location : ""].filter(Boolean).join(" · ")}</Text>
    {row.source_date && <Text style={styles.text}>{row.source_date}</Text>}
    {!!row.content && <Text selectable style={styles.content}>{row.content}</Text>}
  </>;
}
export function KindleScreen({ books, initialEditId, onBack, onImported, onBusyChange }: {
  books: Book[]; initialEditId: string | null; onBack: () => void; onImported: () => Promise<void>; onBusyChange: (busy: boolean) => void;
}) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Annotation[]>([]);
  const [preview, setPreview] = useState<{ name: string; parsed: Clippings } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [known, setKnown] = useState(new Set<string>());
  const [groupPage, setGroupPage] = useState(0), [entryPage, setEntryPage] = useState(0), [listPage, setListPage] = useState(0);
  const [choosing, setChoosing] = useState<string | null>(null), [bookSearch, setBookSearch] = useState("");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState(initialEditId);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => { let live = true; getStore().listAnnotations().then(value => { if (live) setRows(value); }).catch(() => Alert.alert("Não foi possível ler as anotações")); return () => { live = false; }; }, [books]);
  async function refresh() { setRows(await getStore().listAnnotations()); }
  async function run(action: () => Promise<void>) {
    await runWithNavigationLock(locked, busy => { setBusy(busy); onBusyChange(busy); }, async () => {
      try { await action(); }
      catch (error) { Alert.alert("Não foi possível concluir", error instanceof Error ? error.message : "Tente novamente."); }
    });
  }
  async function selectFile() {
    setPreview(null); setResult(null); setChoosing(null); setEditingId(null);
    const selected = await pickClippings();
    if (!selected) return;
    const fingerprints = await getStore().annotationFingerprints();
    setKnown(new Set(fingerprints.map(row => row.fingerprint)));
    const next: Record<string, string> = {};
    for (const group of selected.parsed.groups) {
      const matches = books.filter(book => normalizeName(book.title) === normalizeName(group.title) && normalizeName(book.author) === normalizeName(group.author));
      next[group.key] = matches.length === 1 ? matches[0].id : matches.length ? "skip" : "new";
    }
    setMapping(next); setGroupPage(0); setEntryPage(0); setPreview(selected);
  }
  async function confirm() {
    if (!preview) return;
    const completed = await importClippings(preview.parsed, mapping);
    setPreview(null); setChoosing(null); setListPage(0);
    setResult(`${completed.added} anotação(ões) adicionada(s), ${completed.booksAdded} livro(s) criado(s), ${completed.duplicates} repetida(s) e ${completed.skipped} ignorada(s).`);
    await refresh(); await onImported();
  }
  const filtered = rows.filter(row => normalizeName(`${row.book_title} ${row.content}`).includes(normalizeName(search)));
  const displayedPage = Math.min(listPage, Math.max(0, Math.ceil(filtered.length / 20) - 1));
  const existingInFile = preview?.parsed.entries.filter(entry => known.has(entry.fingerprint)).length ?? 0;
  const importable = preview?.parsed.entries.filter(entry => !known.has(entry.fingerprint) && mapping[entry.group] && mapping[entry.group] !== "skip").length ?? 0;
  const editing = rows.find(row => row.id === editingId);
  const matchingBooks = books.filter(book => normalizeName(`${book.title} ${book.author}`).includes(normalizeName(bookSearch))).slice(0, 20);
  function bookChoices(group: string | null) {
    return <View style={styles.card}>
      <Text style={styles.title}>{group ? "Associar a um livro existente" : "Alterar livro da anotação"}</Text>
      {!group && editing && <Detail row={editing} />}
      <TextInput accessibilityLabel="Buscar livro para a anotação" placeholder="Buscar por título ou autor" value={bookSearch} onChangeText={setBookSearch} style={styles.input} editable={!busy} />
      {matchingBooks.map(book => <Action key={book.id} label={`${book.title} · ${book.author || "sem autor"}`} disabled={busy} onPress={() => {
        if (group) { setMapping(current => ({ ...current, [group]: book.id })); setChoosing(null); }
        else if (editingId) void run(async () => { await moveAnnotation(editingId, book.id); setEditingId(null); await refresh(); await onImported(); });
      }} />)}
      <Text style={styles.text}>Mostrando até 20 livros. Use a busca para refinar.</Text>
      <Action label="Cancelar escolha" disabled={busy} onPress={() => { setChoosing(null); setEditingId(null); }} />
    </View>;
  }

  return <View style={styles.container}>
    <Disclosure title="Como importar">    <Text style={styles.text}>Importe destaques, notas e marcadores do arquivo My Clippings.txt. As anotações ficam separadas do histórico e não criam tempo ou progresso de leitura.</Text>
    <Text style={styles.text}>Copie o arquivo do Kindle para o celular e selecione-o abaixo. Formatos em português e inglês; até 10 MB. Confira a prévia antes de importar.</Text>
</Disclosure>
    <Action label="Selecionar My Clippings.txt" disabled={busy} onPress={() => { void run(selectFile); }} />
    {busy && <ActivityIndicator accessibilityLabel="Processando anotações" color={colors.accent} />}
    {!!result && <Text accessibilityLiveRegion="polite" style={styles.title}>{result}</Text>}
    {preview && <>
      <Text style={styles.title}>Prévia: {preview.name}</Text>
      <Text style={styles.text}>{importable} para importar · {preview.parsed.duplicates + existingInFile} repetida(s) · {preview.parsed.rejected.length} trecho(s) não reconhecido(s)</Text>
      <Text style={styles.text}>Associe cada título a um livro. Títulos com mais de uma correspondência começam como “Ignorar”. A conferência de duplicatas inclui anotações excluídas.</Text>
      {preview.parsed.groups.slice(groupPage * 10, groupPage * 10 + 10).map(group => <View key={group.key} style={styles.card}>
        <Text style={styles.title}>{group.title}</Text><Text style={styles.text}>{group.author || "Autor não informado"}</Text>
        <Text style={styles.text}>Destino: {mapping[group.key] === "new" ? "Novo livro" : mapping[group.key] === "skip" ? "Ignorar" : books.find(book => book.id === mapping[group.key])?.title ?? "Livro indisponível"}</Text>
        <Action label="Criar livro" disabled={busy} onPress={() => setMapping(current => ({ ...current, [group.key]: "new" }))} />
        <Action label="Escolher livro existente" disabled={busy || !books.length} onPress={() => { setChoosing(group.key); setBookSearch(""); }} />
        <Action label="Ignorar este título" disabled={busy} onPress={() => setMapping(current => ({ ...current, [group.key]: "skip" }))} />
        {choosing === group.key && bookChoices(group.key)}
      </View>)}
      {preview.parsed.groups.length > 10 && <View style={styles.card}>
        <Text style={styles.text}>Livros: página {groupPage + 1} de {Math.ceil(preview.parsed.groups.length / 10)}</Text>
        <Action label="Livros anteriores" disabled={busy || groupPage === 0} onPress={() => setGroupPage(groupPage - 1)} />
        <Action label="Próximos livros" disabled={busy || (groupPage + 1) * 10 >= preview.parsed.groups.length} onPress={() => setGroupPage(groupPage + 1)} />
      </View>}
      {preview.parsed.entries.slice(entryPage * 20, entryPage * 20 + 20).map(entry => <View key={entry.fingerprint} style={styles.card}>
        <Text style={styles.title}>{entry.title}{known.has(entry.fingerprint) ? " · já importada ou excluída" : ""}</Text>
        <Detail row={entry} />
      </View>)}
      {preview.parsed.entries.length > 20 && <>
        <Text style={styles.text}>Trechos: página {entryPage + 1} de {Math.ceil(preview.parsed.entries.length / 20)}</Text>
        <Action label="Trechos anteriores" disabled={busy || !entryPage} onPress={() => setEntryPage(entryPage - 1)} />
        <Action label="Próximos trechos" disabled={busy || (entryPage + 1) * 20 >= preview.parsed.entries.length} onPress={() => setEntryPage(entryPage + 1)} />
      </>}
      {preview.parsed.rejected.slice(0, 20).map(item => <Text key={item.block} style={styles.text}>Trecho {item.block}: {item.reason}</Text>)}
      {preview.parsed.rejected.length > 20 && <Text style={styles.text}>Mais {preview.parsed.rejected.length - 20} trecho(s) não reconhecido(s). Preserve o arquivo original.</Text>}
      <Action label={`Importar ${importable} anotação(ões)`} disabled={busy || !importable} onPress={() => { void run(confirm); }} />
      <Action label="Cancelar importação" disabled={busy} onPress={() => { setPreview(null); setChoosing(null); }} />
    </>}
    {editingId && bookChoices(null)}
    {!preview && !editingId && <>
      <Text style={styles.title}>Suas anotações ({rows.length})</Text>
      <TextInput accessibilityLabel="Buscar anotações" value={search} onChangeText={value => { setSearch(value); setListPage(0); }} placeholder="Buscar por livro ou trecho" style={styles.input} />
      {!filtered.length && <Text style={styles.text}>Nenhuma anotação encontrada.</Text>}
      {filtered.slice(displayedPage * 20, displayedPage * 20 + 20).map(row => <View key={row.id} style={styles.card}>
        <Text style={styles.title}>{row.book_title}</Text><Detail row={row} />
        <ActionMenu label={"Opções da anotação de " + row.book_title} disabled={busy} items={[{ label: "Alterar livro", onPress: () => { setEditingId(row.id); setBookSearch(""); } }, { label: "Excluir anotação", danger: true, onPress: () => Alert.alert("Excluir anotação?", "Reimportar o mesmo trecho não desfaz esta exclusão.", [{ text: "Cancelar", style: "cancel" }, { text: "Excluir", style: "destructive", onPress: () => { void run(async () => { await deleteAnnotation(row.id); await refresh(); }); } }]) }]} />
      </View>)}
      {filtered.length > 20 && <>
        <Text style={styles.text}>Página {displayedPage + 1} de {Math.ceil(filtered.length / 20)}</Text>
        <Action label="Anteriores" disabled={busy || !displayedPage} onPress={() => setListPage(displayedPage - 1)} />
        <Action label="Próximas" disabled={busy || (displayedPage + 1) * 20 >= filtered.length} onPress={() => setListPage(displayedPage + 1)} />
      </>}
    </>}

  </View>;
}
const styles = StyleSheet.create({
  container: { gap: 12 }, card: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingVertical: 16, gap: 12 },
  text: { color: colors.muted, fontSize: 14, lineHeight: 21 }, content: { color: colors.ink, fontSize: 15, lineHeight: 23 },
  title: { color: colors.ink, fontSize: 16, fontWeight: "700" }, input: { fontSize: 16, color: colors.ink, backgroundColor: "white", borderColor: colors.outline, borderWidth: 1, padding: 12, minHeight: 48, borderRadius: 10 },
  button: { minHeight: 48, padding: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.soft, borderRadius: 12 },
  buttonText: { color: colors.accent, fontWeight: "700" }, disabled: { opacity: 0.5 },
});
