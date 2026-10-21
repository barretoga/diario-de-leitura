import { isKOReaderLog, logPresentation } from "./logs/source";
import { KOReaderScreen } from "./koreader/KOReaderScreen";
import { colors, ui } from "./ui/tokens";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";
import { ScreenHeader } from "./ui/ScreenHeader";
import { Feedback } from "./ui/Feedback";
import { ActionMenu } from "./ui/Overlay";
import { ReadingLogForm } from "./logs/ReadingLogForm";
import { SettingsScreen } from "./settings/SettingsScreen";
import { MotionProvider } from "./ui/Motion";
import { backTarget, type Screen } from "./navigation/routes";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as SecureStore from "expo-secure-store";
import { clearLegacyGoogleCredentials } from "./catalog/googleCredentials";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import {
  addBook,
  addLog,
  addTimedLog,
  currentTimer,
  dailyGoal,
  deleteLog,
  discardTimer,
  initializeDatabase,
  getStore,
  listBooks,
  listBookMetadata,
  listGoogleBookLinks,
  listLogs,
  pauseTimer,
  resumeTimer,
  setDailyGoal,
  saveBookCatalog,
  saveBookGoogle,
  startTimer,
  updateLog,
  updateBook,
  type Book,
  type ReadingLog,
} from "./db";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSync } from "./sync/useSync";
import { SyncSettings } from "./sync/SyncSettings";
import { BackupScreen } from "./backup/BackupScreen";
import { KindleScreen } from "./kindle/KindleScreen";
import { StatisticsScreen } from "./statistics/StatisticsScreen";
import { dailyGoalStats, formatMinutes, saveFeedback } from "./statistics/readingStats";
import { useReadingClock } from "./statistics/useReadingClock";
import { TimerScreen } from "./timer/TimerScreen";
import { timerLogMinutes, type ReadingTimer } from "./timer/readingTimer";
import { HomeScreen } from "./home/HomeScreen";
import { HistoryScreen } from "./home/HistoryScreen";
import { LibraryScreen } from "./home/LibraryScreen";
import { BookDetailScreen } from "./catalog/BookDetailScreen";
import { BookRegistrationForm } from "./catalog/BookRegistrationForm";
import type { RegistrationDraft } from "./catalog/bookDraft";
import type { CatalogBook } from "./catalog/openLibrary";
import type { GoogleVolume } from "./catalog/googleBooks";
import type { BookMetadata, GoogleBookLink } from "./sync/store";
import { PrimaryNavigation, type PrimaryScreen } from "./home/PrimaryNavigation";
import { durationParts, parseDuration, parseProgress, validateLogDraft, type DurationMode, type LogFormErrors, type ProgressUnit, type LogDraft } from "./logForm";
import type { BookData, Issue, LogData, Snapshot } from "./sync/types";


type Unit = ProgressUnit;

const palette = { accent: colors.accent };

function mergeDateTime(current: Date, selected: Date, mode: "date" | "time"): Date {
  const next = new Date(current);
  if (mode === "date") {
    next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
  } else {
    next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
  }
  return next;
}

export default function App() {
  return <MotionProvider><ReadingApp /></MotionProvider>;
}

function ReadingApp() {
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>("history");
  const [books, setBooks] = useState<Book[]>([]);
  const [bookMetadata, setBookMetadataState] = useState<BookMetadata[]>([]);
  const [googleBookLinks, setGoogleBookLinks] = useState<GoogleBookLink[]>([]);
  const [detailBookId, setDetailBookId] = useState<string | null>(null);
  const [logs, setLogs] = useState<ReadingLog[]>([]);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [bookId, setBookId] = useState("");
  const [selectedAt, setSelectedAt] = useState(new Date());
  const [iosPickerMode, setIosPickerMode] = useState<"date" | "time" | null>(null);
  const [minutesText, setMinutesText] = useState("");
  const [durationMode, setDurationMode] = useState<DurationMode>("minutes");
  const [hoursText, setHoursText] = useState("");
  const [hourMinutesText, setHourMinutesText] = useState("");
  
  const [formErrors, setFormErrors] = useState<LogFormErrors>({});
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [unit, setUnit] = useState<Unit>("page");
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingBookId, setEditingBookId] = useState<string | null>(null);
  const [bookReturn, setBookReturn] = useState<Screen>("history");
  const [logReturn, setLogReturn] = useState<Screen>("history");
  const [detailReturn, setDetailReturn] = useState<PrimaryScreen>("library");
  const [settingsReturn, setSettingsReturn] = useState<PrimaryScreen>("history");
  const [startupError, setStartupError] = useState<string | null>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [goal, setGoal] = useState<number | null>(null);
  const [timer, setTimer] = useState<ReadingTimer | null>(null);
  const [timedDraft, setTimedDraft] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const operationLocked = useRef(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const onOperationBusyChange = useCallback((busy: boolean) => {
    operationLocked.current = busy;
    setOperationBusy(busy);
  }, []);
  const now = useReadingClock();

  const refresh = useCallback(async () => {
    const [nextBooks, nextLogs, nextGoal, nextTimer, nextMetadata, nextGoogleLinks] = await Promise.all([listBooks(), listLogs(), dailyGoal(), currentTimer(), listBookMetadata(), listGoogleBookLinks()]);
    setBooks(nextBooks);
    setGoogleBookLinks(nextGoogleLinks);
    setLogs(nextLogs);
    setGoal(nextGoal);
    setTimer(nextTimer);
    setBookMetadataState(nextMetadata);
  }, []);
  const sync = useSync(ready, refresh);

  async function saveGoal(minutes: number | null) {
    await setDailyGoal(minutes);
    setGoal(minutes);
  }

  useEffect(() => {
    void clearLegacyGoogleCredentials(key => SecureStore.deleteItemAsync(key)).catch(() => {});
    initializeDatabase()
      .then(refresh)
      .then(() => setReady(true))
      .catch((error) => {
        setStartupError("Não foi possível abrir o banco. Os dados foram preservados. Feche e reabra o app; se persistir, verifique a versão instalada.");
        Alert.alert("Erro ao abrir os dados", String(error));
      });
  }, [refresh]);

  const goBack = useCallback(() => {
    if (saving || operationLocked.current) return true;
    if (keyboardVisible) { Keyboard.dismiss(); return true; }
    const target = backTarget({ screen, bookReturn, logReturn, detailReturn, settingsReturn, timedDraft });
    if (!target) return false;
    setScreen(target); return true;
  }, [screen, bookReturn, logReturn, detailReturn, settingsReturn, timedDraft, keyboardVisible, saving]);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", goBack);
    return () => subscription.remove();
  }, [goBack]);

  useEffect(() => {
    const shown = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboardVisible(true));
    const hidden = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardVisible(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);

  function openNewBook(returnTo: Screen = "history") {
    setBookReturn(returnTo);
    setEditingBookId(null); setTitle(""); setAuthor(""); setScreen("new-book");
  }
  function openEditBook(book: Book, returnTo: Screen = "library") {
    setBookReturn(returnTo);
    setEditingBookId(book.id); setTitle(book.title); setAuthor(book.author); setScreen("new-book");
  }
  function editIssue(issue: Issue) {
    if (issue.entity === "annotation") { setEditingAnnotationId(issue.id); setScreen("kindle"); return; }
    if (issue.entity === "book") {
      const book = issue.local as Snapshot & BookData;
      setBookReturn("sync");
      setEditingBookId(book.id); setTitle(book.title); setAuthor(book.author); setScreen("new-book");
    } else {
      const log = issue.local as Snapshot & LogData;
      openEdit({ ...log, book_title: books.find(book => book.id === log.book_id)?.title ?? "Livro excluído" });
    }
  }

  function resetLogForm() {
    setEditingId(null);
    setTimedDraft(false);
    setSelectedAt(new Date());
    setIosPickerMode(null);
    setMinutesText("");
    setDurationMode("minutes");
    setHoursText("");
    setHourMinutesText("");

    setFormErrors({});
    setProgressText("");
    setUnit("page");
    setNote("");
  }

  function openNewLog(returnTo: Screen = "history") {
    setLogReturn(returnTo);
    resetLogForm();
    setBookId("");
    setScreen("new-log");
  }

  function openBookLog(book: Book) {
    openNewLog("book-detail");
    setBookId(book.id);
  }

  async function selectCatalogBook(book: Book, candidate: CatalogBook) {
    await saveBookCatalog(book, candidate.title, candidate.authors.length ? candidate.authors.join(", ") : book.author,
      { book_id: book.id, work_key: candidate.workKey, cover_id: candidate.coverId,
        subjects: candidate.subjects, first_publish_year: candidate.firstPublishYear });
    await refresh();
  }
  async function selectGoogleBook(book: Book, candidate: GoogleVolume) {
    await saveBookGoogle(book, candidate.title, candidate.authors.length ? candidate.authors.join(", ") : book.author,
      { book_id: book.id, volume_id: candidate.id });
    await refresh();
  }

  function openEdit(log: ReadingLog) {
    if (isKOReaderLog(log.id)) { Alert.alert("Leitura KOReader", "Atualizada pela integração. Você pode excluir este registro no histórico."); return; }
    setLogReturn(screen === "all-logs" || screen === "sync" || screen === "book-detail" ? screen : "history");
    setEditingId(log.id);
    setTimedDraft(false);
    setBookId(log.book_id);
    setSelectedAt(new Date(log.started_at));
    setIosPickerMode(null);
    setDurationMode("minutes");
    setMinutesText(log.minutes ? String(log.minutes) : "");
    const parts = durationParts(log.minutes);
    setHoursText(parts.hoursText);
    setHourMinutesText(parts.hourMinutesText);

    setFormErrors({});
    setProgressText(
      log.progress_value === null ? "" : String(log.progress_value),
    );
    setUnit(log.progress_unit ?? "page");
    setNote(log.note);
    setScreen("new-log");
  }

  async function beginReadingTimer() { setTimer(await startTimer()); }
  async function pauseReadingTimer() { setTimer(await pauseTimer()); }
  async function resumeReadingTimer() { setTimer(await resumeTimer()); }
  async function discardReadingTimer() { await discardTimer(); setTimer(null); }
  async function registerTimerReading() {
    const paused = await pauseTimer();
    setTimer(paused);
    resetLogForm();
    setBookId("");
    setSelectedAt(new Date(paused.started_at));
    const minutes = timerLogMinutes(paused, new Date());
    if (minutes === 0) throw new Error("Continue a sessão e aguarde ao menos um segundo antes de registrar. O cronômetro ficou pausado.");
    setMinutesText(minutes ? String(minutes) : "");
    setTimedDraft(true);
    setLogReturn("history");
    setScreen("new-log");
  }

  function openDateTimePicker(mode: "date" | "time") {
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: selectedAt,
        mode,
        is24Hour: true,
        onValueChange: (_event, date) => {
          setSelectedAt((current) => mergeDateTime(current, date, mode));
          setFormErrors((current) => ({ ...current, date: undefined }));
        },
      });
    } else {
      setIosPickerMode(mode);
    }
  }

  function switchDurationMode(next: DurationMode) {
    if (durationMode === next) return;
    const duration = parseDuration({ durationMode, minutesText, hoursText, hourMinutesText });
    if (duration.error) {
      setFormErrors(current => ({ ...current, duration: "Corrija a duração antes de trocar o formato." }));
      return;
    }
    if (next === "minutes") setMinutesText(duration.minutes ? String(duration.minutes) : "");
    else {
      const parts = durationParts(duration.minutes);
      setHoursText(parts.hoursText);
      setHourMinutesText(parts.hourMinutesText);
    }
    setDurationMode(next);
    setFormErrors(current => ({ ...current, duration: undefined }));
  }

  async function saveBook(draft?: RegistrationDraft) {
    const nextTitle = draft?.title ?? title;
    const nextAuthor = draft?.author ?? author;
    if (!nextTitle.trim()) return Alert.alert("Informe o título do livro");
    setSaving(true);
    try {
      if (editingBookId) await updateBook(editingBookId, nextTitle, nextAuthor);
      else await addBook(nextTitle, nextAuthor, draft?.catalog ?? null);
      setTitle("");
      setAuthor("");
      setEditingBookId(null);
      await refresh();
      setScreen(bookReturn);
    } catch (error) {
      Alert.alert("Não foi possível salvar o livro", String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveLog() {
    if (editingId && isKOReaderLog(editingId)) { Alert.alert("Leitura KOReader", "Atualizada pela integração"); return; }
    const { input, errors } = validateLogDraft({
      bookId, selectedAt, durationMode, minutesText, hoursText, hourMinutesText,
      progressText, unit, note,
    }, books.map(book => book.id));
    setFormErrors(errors);
    setValidationAttempt(current => current + 1);
    if (!input) return;
    setSaving(true);
    let saved = false;
    try {
      const before = await listLogs();
      if (editingId) await updateLog(editingId, input);
      else if (timedDraft) { await addTimedLog(input); setTimer(null); }
      else await addLog(input);
      saved = true;
      const after = await listLogs();
      const savedAt = new Date();
      const reachedGoal = goal !== null && !dailyGoalStats(before, savedAt, goal).reachedToday && dailyGoalStats(after, savedAt, goal).reachedToday;
      const readingFeedback = saveFeedback(before, after, input, !!editingId, savedAt);
      setFeedback(reachedGoal ? `Meta de hoje alcançada! ${readingFeedback}` : readingFeedback);
      await refresh();
      resetLogForm();
      setScreen(logReturn);
    } catch (error) {
      if (saved) {
        resetLogForm();
        setScreen(logReturn);
        Alert.alert("Leitura salva", "A leitura foi gravada, mas não foi possível atualizar a tela agora. Reabra o aplicativo para conferir o histórico.");
      } else Alert.alert("Não foi possível salvar a leitura", String(error));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(log: ReadingLog) {
    Alert.alert(
      "Excluir leitura?",
      `${logPresentation(log).deleteMessage}\n${log.book_title} · ${new Date(log.started_at).toLocaleDateString("pt-BR")}`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Excluir",
          style: "destructive",
          onPress: () => {
            deleteLog(log.id)
              .then(refresh)
              .then(() => setFeedback("Leitura excluída. Sua sequência e estatísticas foram recalculadas."))
              .catch((error) => Alert.alert("Erro ao excluir", String(error)));
          },
        },
      ],
    );
  }

  if (!ready)
    return (
      <SafeAreaView style={styles.loading}>
        {startupError ? <Text style={styles.empty}>{startupError}</Text> : <ActivityIndicator color={palette.accent} />}
      </SafeAreaView>
    );

  const isPrimary = screen === "history" || screen === "all-logs" || screen === "statistics" || screen === "library";

  let heading: string;
  if (screen === "history") {
    heading = "Início";
  } else if (screen === "all-logs") {
    heading = "Histórico";
  } else if (screen === "library") {
    heading = "Livros";
  } else if (screen === "book-detail") {
    heading = "Detalhes do livro";
  } else if (screen === "new-book") {
    heading = editingBookId ? "Editar livro" : "Novo livro";
  } else if (screen === "settings") {
    heading = "Configurações";
  } else if (screen === "sync") {
    heading = "Sincronização";
  } else if (screen === "backup") {
    heading = "Backup e restauração";
  } else if (screen === "koreader") {
    heading = "KOReader";
  } else if (screen === "kindle") {
    heading = "Anotações Kindle";
  } else if (screen === "statistics") {
    heading = "Estatísticas";
  } else if (screen === "timer") {
    heading = "Cronômetro de leitura";
  } else if (editingId) {
    heading = "Editar leitura";
  } else {
    heading = "Registrar leitura";
  }

  const detailBook = books.find(book => book.id === detailBookId);
  const draft: LogDraft = { bookId, selectedAt, durationMode, minutesText, hoursText, hourMinutesText, progressText, unit, note };
  function changeDraft(patch: Partial<LogDraft>) {
    if (patch.durationMode !== undefined) { switchDurationMode(patch.durationMode); return; }
    if (patch.bookId !== undefined) setBookId(patch.bookId);
    if (patch.selectedAt !== undefined) setSelectedAt(patch.selectedAt);
    if (patch.minutesText !== undefined) setMinutesText(patch.minutesText);
    if (patch.hoursText !== undefined) setHoursText(patch.hoursText);
    if (patch.hourMinutesText !== undefined) setHourMinutesText(patch.hourMinutesText);
    if (patch.progressText !== undefined) setProgressText(patch.progressText);
    if (patch.unit !== undefined) setUnit(patch.unit);
    if (patch.note !== undefined) setNote(patch.note);
    setFormErrors(current => ({ ...current,
      ...(patch.bookId !== undefined ? { book: undefined } : {}),
      ...(patch.selectedAt !== undefined ? { date: undefined } : {}),
      ...(patch.minutesText !== undefined || patch.hoursText !== undefined || patch.hourMinutesText !== undefined ? { duration: undefined, content: undefined } : {}),
      ...(patch.progressText !== undefined || patch.unit !== undefined ? { progress: undefined, content: undefined } : {}),
      ...(patch.note !== undefined ? { note: undefined, content: undefined } : {}),
    }));
  }
  const syncSummary = sync.settings?.fatal ? "Ação necessária" : !sync.settings?.url ? "Somente neste aparelho"
    : sync.settings.paused ? "Pausada" : sync.status.phase === "syncing" ? "Sincronizando…"
      : sync.pending ? sync.pending + " pendência(s)" : "Em dia";
  return <SafeAreaView style={styles.safe}>
    <StatusBar style="dark" />
    <ScreenHeader title={heading} backDisabled={saving || operationBusy} onBack={isPrimary ? undefined : () => { goBack(); }}
      onSettings={isPrimary ? () => { setSettingsReturn(screen as PrimaryScreen); setScreen("settings"); } : undefined}
      actions={screen === "book-detail" && detailBook ? <ActionMenu disabled={saving} label="Opções do livro" items={[{ label: "Editar livro", onPress: () => openEditBook(detailBook, "book-detail") }]} /> : undefined} />
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView key={screen} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {screen !== "history" && feedback && <Feedback kind="success" message={feedback} onDismiss={() => setFeedback(null)} />}
        {screen === "settings" && <SettingsScreen onKOReader={() => setScreen("koreader")} syncSummary={syncSummary} onSync={() => setScreen("sync")} onBackup={() => setScreen("backup")} onKindle={() => { setEditingAnnotationId(null); setScreen("kindle"); }} />}
        {screen === "sync" && <View style={ui.stack}>
          <Text style={ui.title}>{syncSummary}</Text>
          <Text style={ui.muted}>{sync.pending} pendência(s) · {sync.issues.filter(issue => issue.conflict).length} conflito(s)</Text>
          <Text style={ui.muted}>Última sincronização: {sync.settings?.lastSuccess ? new Date(sync.settings.lastSuccess).toLocaleString("pt-BR") : "ainda não concluída"}</Text>
          {!!(sync.settings?.fatal || sync.status.message) && <Text style={ui.error}>{sync.settings?.fatal || sync.status.message}</Text>}
          {!!sync.settings?.url && <Button label="Sincronizar agora" disabled={sync.status.phase === "syncing" || sync.configuring || sync.settings.paused || !!sync.settings.fatal} onPress={() => { void sync.sync(); }} />}
          <SyncSettings sync={sync} editIssue={editIssue} books={books} />
        </View>}
        {screen === "backup" && <BackupScreen onBusyChange={onOperationBusyChange} onBack={() => { goBack(); }} onRestored={refresh} />}
        {screen === "koreader" && <KOReaderScreen books={books} onOpenSync={() => setScreen("sync")} onCreateBook={() => openNewBook("koreader")} onSynchronize={async () => { await sync.syncChecked(); await refresh(); }} />}
        {screen === "kindle" && <KindleScreen onBusyChange={onOperationBusyChange} books={books} initialEditId={editingAnnotationId} onBack={() => { goBack(); }} onImported={refresh} />}
        {screen === "statistics" && <StatisticsScreen logs={logs} now={now} goal={goal} onSaveGoal={saveGoal} onRead={books.length ? () => openNewLog("statistics") : () => openNewBook("statistics")} />}
        {screen === "all-logs" && <HistoryScreen logs={logs} onEdit={openEdit} onDelete={confirmDelete} onRead={books.length ? () => openNewLog("all-logs") : () => openNewBook("all-logs")} />}
        {screen === "library" && <LibraryScreen books={books} logs={logs} metadata={bookMetadata} onAdd={() => openNewBook("library")} onOpen={book => { setDetailReturn("library"); setDetailBookId(book.id); setScreen("book-detail"); }} />}
        {screen === "book-detail" && (detailBook ? <BookDetailScreen key={detailBook.id} book={detailBook} logs={logs} metadata={bookMetadata.find(item => item.book_id === detailBook.id) ?? null}
          googleVolumeId={googleBookLinks.find(item => item.book_id === detailBook.id)?.volume_id ?? null} onBack={() => { goBack(); }}
          onEditBook={() => openEditBook(detailBook, "book-detail")} onRead={() => openBookLog(detailBook)} onEditLog={openEdit} onDeleteLog={confirmDelete}
          onSelectMetadata={candidate => selectCatalogBook(detailBook, candidate)} onSelectGoogle={candidate => selectGoogleBook(detailBook, candidate)} /> : <Button label="Voltar aos livros" onPress={() => setScreen("library")} />)}
        {screen === "timer" && <TimerScreen onBusyChange={onOperationBusyChange} timer={timer} onStart={beginReadingTimer} onPause={pauseReadingTimer} onResume={resumeReadingTimer} onRegister={registerTimerReading} onDiscard={discardReadingTimer} onBack={() => { goBack(); }} />}
        {screen === "history" && <HomeScreen books={books} logs={logs} now={now} goal={goal} timer={timer} feedback={feedback} onDismissFeedback={() => setFeedback(null)}
          sync={{ configured: !!sync.settings?.url, pending: sync.pending, conflicts: sync.issues.filter(issue => issue.conflict).length, phase: sync.status.phase, message: sync.settings?.fatal || sync.status.message }}
          onRead={() => openNewLog()} onNewBook={() => openNewBook()} onTimer={() => setScreen("timer")} onStatistics={() => setScreen("statistics")}
          onSync={() => { setSettingsReturn("history"); setScreen("sync"); }} onEditLog={openEdit} />}
        {screen === "new-book" && !editingBookId && <BookRegistrationForm saving={saving} onSave={saveBook} onBack={() => { goBack(); }} />}
        {screen === "new-book" && !!editingBookId && <View style={ui.stack}><Field label="Título" value={title} onChangeText={setTitle} editable={!saving} maxLength={500} placeholder="Nome do livro" /><Field label="Autor(a) · opcional" value={author} onChangeText={setAuthor} editable={!saving} maxLength={500} /><Button label="Salvar livro" busy={saving} onPress={() => { void saveBook(); }} /></View>}
        {screen === "new-log" && <ReadingLogForm books={books} draft={draft} errors={formErrors} validationAttempt={validationAttempt} saving={saving} editing={!!editingId} timedDraft={timedDraft} onChange={changeDraft}
          onSave={() => { void saveLog(); }} onCancel={() => { goBack(); }} onPickDateTime={openDateTimePicker} onAddBook={() => openNewBook("new-log")}
          dateTimeAccessory={Platform.OS === "ios" && iosPickerMode ? <View><DateTimePicker value={selectedAt} mode={iosPickerMode} onValueChange={(_event, date) => { setSelectedAt(current => mergeDateTime(current, date, iosPickerMode)); setFormErrors(current => ({ ...current, date: undefined })); }} /><Button label="Concluir" onPress={() => setIosPickerMode(null)} /></View> : undefined} />}
      </ScrollView>
    </KeyboardAvoidingView>
    {isPrimary && !keyboardVisible && <PrimaryNavigation current={screen as PrimaryScreen} onNavigate={setScreen} />}
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background }, flex: { flex: 1 },
  page: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 32, gap: 24 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background, padding: 24 },
  empty: { color: colors.muted, fontSize: 16, lineHeight: 24 },
});
