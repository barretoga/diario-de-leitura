import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { ActionIcon } from "../ui/ActionIcon";
import { colors, ui } from "../ui/tokens";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { BookSuggestions, type SuggestionState } from "./bookSuggestions";
import { registrationDraft, type CatalogCandidate, type RegistrationDraft } from "./bookDraft";
import { coverUrl, type CatalogLanguage } from "./openLibrary";

function CandidateCover({ candidate }: { candidate: CatalogCandidate }) {
  const uri = candidate.source === "google" ? candidate.coverUri : candidate.coverId ? coverUrl(candidate.coverId, "S") : null;
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [uri]);
  return <View style={styles.cover}>
    {uri && !failed ? <Image source={{ uri }} resizeMode="cover" style={styles.coverImage} onError={() => setFailed(true)} />
      : <ActionIcon name="book" color={colors.muted} />}
  </View>;
}

export function BookRegistrationForm({ saving, onSave, onBack }: {
  saving: boolean; onSave: (draft: RegistrationDraft) => Promise<void>; onBack: () => void;
}) {
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [language, setLanguage] = useState<CatalogLanguage>("pt");
  const [lookup, setLookup] = useState<SuggestionState>({ phase: "idle", source: null, items: [], selection: null, message: null });
  const [suggestions] = useState(() => new BookSuggestions(setLookup));
  const [limit, setLimit] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const submitting = useRef(false);
  useEffect(() => () => suggestions.dispose(), [suggestions]);

  function changeTitle(value: string) {
    setTitle(value); setError(null); setLimit(3); suggestions.update(value, author, language);
  }
  function changeAuthor(value: string) {
    setAuthor(value); setError(null); setLimit(3); suggestions.update(title, value, language);
  }
  function changeLanguage(value: CatalogLanguage) {
    setLanguage(value); setLimit(3); suggestions.update(title, author, value);
  }
  function choose(candidate: CatalogCandidate) {
    suggestions.select(candidate);
    setTitle(candidate.title);
    if (candidate.authors.length) setAuthor(candidate.authors.join(", "));
    setError(null);
  }
  async function submit(manual: boolean) {
    if (submitting.current || saving) return;
    try {
      const draft = registrationDraft(title, author, manual ? null : candidate, suggestions.candidate());
      submitting.current = true; setError(null);
      await onSave(draft);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível cadastrar. Tente novamente."); }
    finally { submitting.current = false; }
  }
  function sourceLink(candidate: CatalogCandidate) {
    void Linking.openURL(candidate.sourceUrl).catch(() => setError("Não foi possível abrir a fonte do livro."));
  }
  const selected = lookup.phase === "selected" ? lookup.selection : null;
  const defaultCandidate = lookup.phase === "ready" ? lookup.items[0] ?? null : null;
  const candidate = selected ?? defaultCandidate;
  const pending = lookup.phase === "waiting" || lookup.phase === "searching";
  const results = selected ? [selected] : lookup.items.slice(0, limit);
  const sourceName = lookup.source === "openlibrary" ? "Open Library" : "Google Books";

  return <View style={styles.form}>
    <Field icon="search" label="Título" value={title} editable={!saving} maxLength={500} placeholder="Nome do livro" onChangeText={changeTitle} />
    {pending && <View accessibilityLiveRegion="polite" style={styles.loading}><ActivityIndicator size="small" color={colors.accent} /><Text style={ui.muted}>Buscando livro…</Text></View>}
    {lookup.message && <Text accessibilityLiveRegion="polite" style={ui.muted}>{lookup.message}</Text>}
    {lookup.phase === "error" && <Button label="Tentar novamente" variant="text" disabled={saving} onPress={() => suggestions.retry()} />}
    {lookup.phase === "ready" && !lookup.items.length && <Text style={ui.muted}>Nenhum livro encontrado. Você pode cadastrar manualmente.</Text>}
    {lookup.source === "google" && <Image source={require("../../assets/powered-by-google.png")} accessibilityLabel="Powered by Google" style={styles.attribution} resizeMode="contain" />}
    {!selected && !!results.length && <View style={styles.suggestions}>
      {results.map((item, index) => {
        const year = item.source === "google" ? item.publishedYear : item.firstPublishYear;
        return <View key={item.source === "google" ? item.id : item.workKey} style={styles.result}>
          <Pressable disabled={saving} accessibilityRole="button" accessibilityState={{ selected: index === 0, disabled: saving }}
            accessibilityLabel={["Selecionar " + item.title, item.authors.join(", "), year, index === 0 ? "Sugerido" : ""].filter(Boolean).join(", ")} onPress={() => choose(item)} style={styles.resultBody}>
            <CandidateCover candidate={item} /><View style={styles.resultText}><Text numberOfLines={2} style={styles.resultTitle}>{item.title}</Text>
              <Text numberOfLines={1} style={ui.muted}>{[item.authors.join(", "), year].filter(Boolean).join(" · ")}</Text>{index === 0 && <Text style={styles.tag}>Sugerido</Text>}
            </View>
          </Pressable>
          <Pressable accessibilityRole="link" accessibilityLabel={"Ver " + item.title + " no " + sourceName} onPress={() => sourceLink(item)} style={styles.sourceLink}><ActionIcon name="external" size={20} /></Pressable>
        </View>;
      })}
      {lookup.items.length > limit && <Button label="Ver mais sugestões" variant="text" disabled={saving} onPress={() => setLimit(lookup.items.length)} />}
    </View>}
    <Field label="Autor(a) · opcional" value={author} editable={!saving} maxLength={500} placeholder="Nome do autor" onChangeText={changeAuthor} />
    <Pressable disabled={saving} accessibilityRole="button" accessibilityState={{ expanded: optionsOpen }} onPress={() => setOptionsOpen(!optionsOpen)} style={styles.optionToggle}><Text style={styles.link}>Busca: {language === "pt" ? "Português" : "Todos os idiomas"}</Text><ActionIcon name={optionsOpen ? "up" : "down"} size={20} /></Pressable>
    {optionsOpen && <View style={styles.choices}>{([ ["pt", "Português"], ["all", "Todos os idiomas"] ] as const).map(([value, label]) => <Pressable key={value} disabled={saving} accessibilityRole="button" accessibilityState={{ selected: language === value, disabled: saving }} onPress={() => changeLanguage(value)} style={[styles.choice, language === value && styles.choiceSelected]}><Text style={styles.choiceText}>{label}</Text></Pressable>)}</View>}
    {!!candidate && <View style={styles.preview}><Text style={styles.tag}>{selected ? "Selecionado" : "Sugerido para cadastro"}</Text><View style={styles.previewBody}><CandidateCover candidate={candidate} /><View style={styles.resultText}><Text style={styles.resultTitle}>{candidate.title}</Text><Text style={ui.muted}>{candidate.authors.length ? candidate.authors.join(", ") : author}</Text></View><Pressable accessibilityRole="link" accessibilityLabel={"Ver " + candidate.title + " no " + (candidate.source === "google" ? "Google Books" : "Open Library")} onPress={() => sourceLink(candidate)} style={styles.sourceLink}><ActionIcon name="external" size={20} /></Pressable></View></View>}
    {error && <Text accessibilityLiveRegion="polite" style={ui.error}>{error}</Text>}
    <Button icon="add" label={candidate ? "Cadastrar livro" : "Cadastrar manualmente"} busy={saving} onPress={() => { void submit(false); }} />
    {!!candidate && <Button label="Cadastrar manualmente" variant="text" disabled={saving} onPress={() => { void submit(true); }} />}
  </View>;
}
const styles = StyleSheet.create({
  form: { gap: 16 }, loading: { flexDirection: "row", alignItems: "center", gap: 8 }, attribution: { width: 120, height: 24 },
  suggestions: { gap: 4, marginTop: -8 }, result: { flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  resultBody: { flex: 1, flexDirection: "row", alignItems: "center", paddingVertical: 12, gap: 12, minHeight: 72 }, resultText: { flex: 1, gap: 4 },
  resultTitle: { fontSize: 16, lineHeight: 23, fontWeight: "500", color: colors.ink }, tag: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  cover: { width: 40, height: 60, backgroundColor: colors.soft, borderRadius: 4, overflow: "hidden", alignItems: "center", justifyContent: "center" }, coverImage: { width: "100%", height: "100%" },
  sourceLink: { minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  preview: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 16, gap: 12 }, previewBody: { flexDirection: "row", gap: 12, alignItems: "center" },
  optionToggle: { minHeight: 48, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, link: { color: colors.accent, fontSize: 14 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, choice: { minHeight: 48, padding: 12, borderWidth: 1, borderColor: colors.outline, borderRadius: 8, justifyContent: "center" }, choiceSelected: { backgroundColor: colors.soft, borderColor: colors.accent }, choiceText: { color: colors.accent, fontSize: 14 },
});
