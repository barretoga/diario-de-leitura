import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Overlay } from "../ui/Overlay";
import { ActionIcon } from "../ui/ActionIcon";
import { Section } from "../ui/Section";
import { colors, typography, ui } from "../ui/tokens";
import { ReadingLogRow } from "../logs/ReadingLogRow";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Book, ReadingLog } from "../db";
import type { BookMetadata } from "../sync/store";
import { formatMinutes, progressLabel } from "../statistics/readingStats";
import { cachedCoverUri, cacheCover } from "./coverFiles";
import { coverUrl, workUrl, type CatalogBook, type CatalogLanguage } from "./openLibrary";
import { googleVolumeUrl, type GoogleVolume } from "./googleBooks";
import { getGoogleVolume, searchCatalog } from "./catalogClient";

export function BookCover({ coverId, size = "small" }: { coverId: number | null; size?: "small" | "large" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [coverId]);
  const local = cachedCoverUri(coverId);
  return <View style={[styles.cover, size === "large" && styles.coverLarge]}>
    {coverId && !failed ? <Image key={coverId} source={{ uri: local ?? coverUrl(coverId, size === "large" ? "M" : "S") }}
      resizeMode="cover" onError={() => setFailed(true)} style={styles.coverImage} />
      : <ActionIcon name="book" color={colors.muted} />}
  </View>;
}

export function BookDetailScreen({ book, logs, metadata, googleVolumeId, onBack, onEditBook, onRead, onEditLog, onDeleteLog, onSelectMetadata, onSelectGoogle }: {
  book: Book; logs: ReadingLog[]; metadata: BookMetadata | null; googleVolumeId: string | null;
  onBack: () => void; onEditBook: () => void; onRead: () => void;
  onEditLog: (log: ReadingLog) => void; onDeleteLog: (log: ReadingLog) => void;
  onSelectMetadata: (candidate: CatalogBook) => Promise<void>;
  onSelectGoogle: (candidate: GoogleVolume) => Promise<void>;
}) {
  const [queryTitle, setQueryTitle] = useState(book.title);
  const [queryAuthor, setQueryAuthor] = useState(book.author);
  const [language, setLanguage] = useState<CatalogLanguage>("pt");
  const [results, setResults] = useState<CatalogBook[] | null>(null);
  const [googleResults, setGoogleResults] = useState<GoogleVolume[] | null>(null);
  const [source, setSource] = useState<"openlibrary" | "google">(metadata ? "openlibrary" : "google");
  const [googleVolume, setGoogleVolume] = useState<GoogleVolume | null>(null);
  const [googleDetailError, setGoogleDetailError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coverRevision, setCoverRevision] = useState(0);
  const [limit, setLimit] = useState(20);
  const [infoOpen, setInfoOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTrigger = useRef<View>(null);
  function openSource(url: string) { void Linking.openURL(url).catch(() => setError("Não foi possível abrir a fonte.")); }
  const searchRevision = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  useEffect(() => () => { searchRevision.current++; searchController.current?.abort(); }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setGoogleVolume(null); setGoogleDetailError(null);
    if (googleVolumeId) void getGoogleVolume(googleVolumeId, controller.signal).then(volume => {
      if (active) setGoogleVolume(volume);
    }).catch(() => { if (active) setGoogleDetailError("Informações do Google Books indisponíveis. O livro e as leituras continuam acessíveis offline."); });
    return () => { active = false; controller.abort(); };
  }, [googleVolumeId]);
  useEffect(() => {
    if (metadata?.cover_id && !cachedCoverUri(metadata.cover_id)) {
      void cacheCover(metadata.cover_id).then(uri => { if (uri) setCoverRevision(value => value + 1); });
    }
  }, [metadata?.cover_id]);
  const bookLogs = useMemo(() => logs.filter(log => log.book_id === book.id).sort((a, b) =>
    Date.parse(b.started_at) - Date.parse(a.started_at) || Date.parse(b.created_at) - Date.parse(a.created_at)), [logs, book.id]);
  const totalMinutes = bookLogs.reduce((sum, log) => sum + Math.max(0, log.minutes), 0);
  const progress = (["page", "location", "percent"] as const).flatMap(unit => {
    const log = bookLogs.find(entry => entry.progress_unit === unit && entry.progress_value !== null);
    return log ? [progressLabel(log.progress_value!, unit)] : [];
  });

  async function search() {
    searchController.current?.abort();
    const controller = new AbortController(); searchController.current = controller;
    const revision = ++searchRevision.current;
    setSearching(true); setError(null); setResults(null); setGoogleResults(null);
    try {
      if (source === "google") {
        const found = await searchCatalog("google", queryTitle, queryAuthor, language, controller.signal);
        if (revision === searchRevision.current) setGoogleResults(found);
      } else {
        const found = await searchCatalog("openlibrary", queryTitle, queryAuthor, language, controller.signal);
        if (revision === searchRevision.current) setResults(found);
      }
    } catch (cause) {
      if (revision === searchRevision.current) setError(cause instanceof Error ? cause.message : "Não foi possível consultar o catálogo.");
    } finally { if (revision === searchRevision.current) setSearching(false); }
  }
  async function select(candidate: CatalogBook) {
    setSaving(true); setError(null);
    try {
      await onSelectMetadata(candidate);
      setGoogleVolume(null); setGoogleDetailError(null);
      setQueryTitle(candidate.title);
      if (candidate.authors.length) setQueryAuthor(candidate.authors.join(", "));
      setResults(null);
      setSearchOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar os dados do livro."); }
    finally { setSaving(false); }
  }
  async function selectGoogle(candidate: GoogleVolume) {
    setSaving(true); setError(null);
    try {
      await onSelectGoogle(candidate);
      setQueryTitle(candidate.title);
      if (candidate.authors.length) setQueryAuthor(candidate.authors.join(", "));
      setGoogleVolume(candidate); setGoogleResults(null); setSearchOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar os dados do livro."); }
    finally { setSaving(false); }
  }
  function invalidateSearch() {
    searchRevision.current++; searchController.current?.abort();
    setResults(null); setGoogleResults(null); setSearching(false); setError(null);
  }
  function confirmChoice(candidate: CatalogBook | GoogleVolume) {
    Alert.alert("Atualizar este livro?", `Título: ${candidate.title}\nAutor: ${candidate.authors.join(", ") || book.author || "Não informado"}\n\nSuas leituras continuarão vinculadas a este livro.`, [
      { text: "Cancelar", style: "cancel" },
      { text: "Usar dados", onPress: () => { if (candidate.source === "google") void selectGoogle(candidate); else void select(candidate); } },
    ]);
  }

  const candidates: (CatalogBook | GoogleVolume)[] = [...(results ?? []), ...(googleResults ?? [])];
  return <View style={styles.root}>
    <View style={styles.hero}>
      {googleVolume?.coverUri ? <CatalogCover uri={googleVolume.coverUri} large /> : <BookCover key={(metadata?.cover_id ?? "none") + "-" + coverRevision} coverId={metadata?.cover_id ?? null} size="large" />}
      <View style={styles.heroText}><Text accessibilityRole="header" style={styles.title}>{book.title}</Text>{!!book.author && <Text style={ui.muted}>{book.author}</Text>}</View>
    </View>
    {googleVolumeId && <Image source={require("../../assets/powered-by-google.png")} accessibilityLabel="Powered by Google" style={styles.googleAttribution} resizeMode="contain" />}
    <Button icon="edit" label="Registrar leitura" onPress={onRead} />
    <View style={ui.stack}><Text style={ui.body}>{formatMinutes(totalMinutes)} · {bookLogs.length} {bookLogs.length === 1 ? "leitura" : "leituras"}</Text>{progress.length > 0 && <Text style={ui.muted}>{progress.join(" · ")}</Text>}</View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: infoOpen }} onPress={() => setInfoOpen(!infoOpen)} style={styles.toggle}><Text style={ui.title}>Informações</Text><ActionIcon name={infoOpen ? "up" : "down"} size={20} /></Pressable>
    {infoOpen && <View style={ui.stack}>
      {metadata && <>{metadata.subjects.length ? <Text style={ui.body}>{metadata.subjects.join(" · ")}</Text> : <Text style={ui.muted}>Sem gêneros informados.</Text>}{!!metadata.first_publish_year && <Text style={ui.muted}>Publicação: {metadata.first_publish_year}</Text>}<Button label="Ver na Open Library ↗" variant="text" onPress={() => openSource(workUrl(metadata.work_key))} /></>}
      {googleVolumeId && <>{googleVolume?.categories.length ? <Text style={ui.body}>{googleVolume.categories.join(" · ")}</Text> : <Text style={ui.muted}>Sem categorias disponíveis.</Text>}{!!googleVolume?.publishedYear && <Text style={ui.muted}>Publicação: {googleVolume.publishedYear}</Text>}<Button label="Ver no Google Books ↗" variant="text" onPress={() => openSource(googleVolumeUrl(googleVolumeId))} /></>}
      {googleDetailError && <Text style={ui.muted}>Informações do Google Books indisponíveis.</Text>}
      <Text style={ui.muted}>{googleVolumeId ? "Dados Google consultados com internet. Português inclui Brasil e Portugal." : "Fonte: Open Library. Assuntos podem variar conforme a obra."}</Text>
    </View>}
    <Pressable ref={searchTrigger} accessibilityRole="button" onPress={() => { setError(null); setSearchOpen(true); }} style={styles.searchTrigger}><ActionIcon name="search" size={20} /><Text style={styles.choiceText}>{metadata || googleVolumeId ? "Atualizar informações" : "Buscar informações"}</Text></Pressable>
    {!searchOpen && error && <Text style={ui.error}>{error}</Text>}
    <Section title="Leituras" icon="history">{!bookLogs.length && <Text style={ui.muted}>Nenhuma leitura registrada.</Text>}<View>{bookLogs.slice(0, limit).map(log => <ReadingLogRow key={log.id} log={log} showDate showTitle={false} onEdit={onEditLog} onDelete={onDeleteLog} />)}</View>{bookLogs.length > limit && <Button label="Mostrar mais leituras" variant="text" onPress={() => setLimit(limit + 20)} />}</Section>
    <Overlay visible={searchOpen} title="Buscar informações" returnFocusRef={searchTrigger} onClose={() => { if (!saving) { invalidateSearch(); setSearchOpen(false); } }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={ui.stack}>
        <View style={styles.choices}>{([ ["google", "Google Books"], ["openlibrary", "Open Library"] ] as const).map(([value, label]) => <Pressable key={value} disabled={saving} accessibilityRole="button" accessibilityState={{ selected: source === value }} onPress={() => { invalidateSearch(); setSource(value); }} style={[styles.choice, source === value && styles.selected]}><Text style={styles.choiceText}>{label}</Text></Pressable>)}</View>
        {source === "google" && <Image source={require("../../assets/powered-by-google.png")} accessibilityLabel="Powered by Google" style={styles.googleAttribution} resizeMode="contain" />}
        <Field label="Título" value={queryTitle} editable={!saving} onChangeText={value => { invalidateSearch(); setQueryTitle(value); }} maxLength={200} />
        <Field label="Autor(a) · opcional" value={queryAuthor} editable={!saving} onChangeText={value => { invalidateSearch(); setQueryAuthor(value); }} maxLength={200} />
        <View style={styles.choices}>{([ ["pt", "Português"], ["all", "Todos os idiomas"] ] as const).map(([value, label]) => <Pressable key={value} disabled={saving} accessibilityRole="button" accessibilityState={{ selected: language === value }} onPress={() => { invalidateSearch(); setLanguage(value); }} style={[styles.choice, language === value && styles.selected]}><Text style={styles.choiceText}>{label}</Text></Pressable>)}</View>
        <Button icon="search" label="Pesquisar" disabled={saving} busy={searching} onPress={() => { void search(); }} />
        {error && <Text accessibilityLiveRegion="polite" style={ui.error}>{error}</Text>}
        {(results !== null || googleResults !== null) && !candidates.length && <Text style={ui.muted}>Nenhum resultado. Tente outro título ou idioma.</Text>}
        {candidates.map(candidate => <View key={candidate.source === "google" ? candidate.id : candidate.workKey} style={styles.result}>
          <View style={styles.resultBody}>{candidate.source === "google" ? <CatalogCover uri={candidate.coverUri} /> : <BookCover coverId={candidate.coverId} />}<View style={styles.heroText}><Text style={ui.body}>{candidate.title}</Text><Text style={ui.muted}>{candidate.authors.join(", ") || "A autoria atual será mantida."}</Text><Text style={ui.muted}>{candidate.source === "google" ? candidate.publishedYear : candidate.firstPublishYear}</Text></View></View>
          <Button label="Ver na fonte ↗" variant="text" onPress={() => openSource(candidate.sourceUrl)} />
          <Button label="Usar edição" variant="secondary" disabled={saving} onPress={() => confirmChoice(candidate)} />
        </View>)}
      </ScrollView>
    </Overlay>
  </View>;
}
function CatalogCover({ uri, large = false }: { uri: string | null; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  return <View style={[styles.cover, large && styles.coverLarge]}>{uri && !failed ? <Image source={{ uri }} style={styles.coverImage} resizeMode="cover" onError={() => setFailed(true)} /> : <ActionIcon name="book" color={colors.muted} />}</View>;
}
const styles = StyleSheet.create({
  root: { gap: 20 }, hero: { flexDirection: "row", alignItems: "center", gap: 16 }, heroText: { flex: 1, gap: 6 },
  searchTrigger: { minHeight: 52, flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "center", padding: 12 },
  title: { ...typography.screen, color: colors.ink },
  cover: { width: 40, height: 60, backgroundColor: colors.soft, borderRadius: 4, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  coverLarge: { width: 88, height: 132 }, coverImage: { width: "100%", height: "100%" }, googleAttribution: { width: 120, height: 24 },
  toggle: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, choice: { minHeight: 48, borderWidth: 1, borderColor: colors.outline, borderRadius: 8, padding: 12, justifyContent: "center" }, selected: { backgroundColor: colors.soft, borderColor: colors.accent }, choiceText: { color: colors.accent, fontSize: 14 },
  result: { gap: 8, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, resultBody: { flexDirection: "row", alignItems: "center", gap: 12 },
});
