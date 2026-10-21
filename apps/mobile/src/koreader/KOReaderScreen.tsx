import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, ScrollView, Text, View } from "react-native";
import { getStore, type Book } from "../db";
import { readSyncToken } from "../sync/credentials";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { ListRow } from "../ui/ListRow";
import { Overlay } from "../ui/Overlay";
import { ui } from "../ui/tokens";
import { createKOReaderClient } from "./client";
import { KOReaderController } from "./state";
import type { DocumentSummary } from "./types";

export function KOReaderScreen({ books, onOpenSync, onCreateBook, onSynchronize }: {
  books: Book[]; onOpenSync: () => void; onCreateBook: () => void; onSynchronize: () => Promise<void>;
}) {
  const synchronize = useRef(onSynchronize); synchronize.current = onSynchronize;
  const [controller] = useState(() => new KOReaderController(createKOReaderClient({
    getUrl: async () => (await getStore().settings()).url, getToken: readSyncToken,
  }), () => synchronize.current()));
  const [state, setState] = useState(controller.snapshot);
  const [document, setDocument] = useState<DocumentSummary | null>(null);
  const [bookId, setBookId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  useEffect(() => {
    const unsubscribe = controller.subscribe(setState); void controller.load();
    const listener = AppState.addEventListener("change", value => {
      if (value === "active") void controller.load(); else controller.cancel();
    });
    return () => { unsubscribe(); listener.remove(); controller.dispose(); };
  }, [controller]);
  const busy = state.busyDocumentId !== null || syncBusy;
  async function associate() {
    if (!document || !bookId) return;
    await controller.link(document.id, bookId, document.associationVersion);
    if (controller.snapshot.documents.find(row => row.id === document.id)?.bookId === bookId) setDocument(null);
  }
  return <View style={ui.stack}>
    {state.error && <Text accessibilityLiveRegion="polite" style={ui.error}>{state.error.message}</Text>}
    {state.phase === "unconfigured" ? <Button label="Configurar sincronização pessoal" onPress={onOpenSync} /> : <>
      <Button label="Atualizar" icon="sync" variant="secondary" busy={state.phase === "loading"} disabled={busy} onPress={() => { void controller.load(); }} />
      {state.status && <Text style={ui.muted}>{state.status.counts.pending} pendente(s) · {state.status.counts.linked} associado(s){state.status.counts.blocked ? ` · ${state.status.counts.blocked} com problema` : ""}</Text>}
      {state.status?.lastReceiptAt && <Text style={ui.muted}>Último recebimento: {new Date(state.status.lastReceiptAt).toLocaleString("pt-BR")}</Text>}
      {!state.documents.length && state.phase === "ready" && <Text style={ui.muted}>Aguardando novas leituras do Kindle. Configure o plugin Books Project no KOReader.</Text>}
      {state.documents.map(row => <View key={row.id} style={ui.stack}>
        <ListRow title={row.title || "Documento sem título"} subtitle={[row.author, `Aparelho ${row.deviceId.slice(0, 8)}`, row.bookId ? `Associado: ${books.find(book => book.id === row.bookId)?.title ?? "livro no servidor"}` : "Associação pendente"].filter(Boolean).join(" · ")} />
        {row.error && <Text style={ui.error}>{row.error.message}</Text>}
        {!row.bookId && <Button label="Associar livro" variant="secondary" disabled={busy || state.phase !== "ready"} onPress={() => { setDocument(row); setBookId(null); setSearch(row.title); }} />}
      </View>)}
      {state.nextAfter !== null && <Button label="Carregar mais" variant="text" busy={state.loadingMore} disabled={busy} onPress={() => { void controller.loadMore(); }} />}
      <Button label="Configuração pessoal" variant="text" disabled={busy} onPress={onOpenSync} />
    </>}
    <Overlay visible={!!document} title="Associar à biblioteca" onClose={() => { if (!busy) setDocument(null); }}>
      <Text style={ui.body}>{document?.title}</Text>
      <Field label="Buscar livro cadastrado" value={search} onChangeText={setSearch} editable={!busy} />
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 260 }}>
        {books.filter(book => `${book.title} ${book.author}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim())).map(book => <ListRow key={book.id} title={`${book.id === bookId ? "✓ " : ""}${book.title}`} subtitle={book.author} onPress={busy ? undefined : () => setBookId(book.id)} />)}
      </ScrollView>
      {!books.length && <Text style={ui.muted}>Cadastre um livro e sincronize antes de associar.</Text>}
      {state.error && <Text accessibilityLiveRegion="polite" style={ui.error}>{state.error.message}</Text>}
      <Button label="Confirmar associação" busy={busy} disabled={!bookId} onPress={() => { void associate(); }} />
      {syncError && <Text accessibilityLiveRegion="polite" style={ui.error}>{syncError}</Text>}
      <Button label="Sincronizar biblioteca" variant="secondary" busy={syncBusy} disabled={busy} onPress={() => {
        setSyncError(null); setSyncBusy(true);
        void synchronize.current().then(() => controller.load()).catch(() => setSyncError("Sincronização pendente. Confira a conexão pessoal")).finally(() => setSyncBusy(false));
      }} />
      <Button label="Cadastrar livro" variant="text" disabled={busy} onPress={() => { setDocument(null); onCreateBook(); }} />
    </Overlay>
  </View>;
}
