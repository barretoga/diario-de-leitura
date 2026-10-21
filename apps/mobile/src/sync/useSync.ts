import { useEffect, useRef, useState } from "react";
import { syncConfirmed } from "./confirmed";
import { AppState } from "react-native";
import { readSyncToken as getToken, writeSyncToken } from "./credentials";
import { getStore, onLocalChange } from "../db";
import { SyncEngine } from "./engine";
import { AUTH_ERROR, MIGRATED, migrateServer, normalizeUrl, sendSync, SyncError } from "./transport";
import type { Issue, Settings, SyncStatus } from "./types";

export function useSync(ready: boolean, refresh: () => Promise<void>) {
  const engine = useRef<SyncEngine | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<SyncStatus>({ phase: "idle", message: null });
  const [configuring, setConfiguring] = useState(false);
  const configBusy = useRef(false);
  const testController = useRef<AbortController | null>(null);
  const reload = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const store = getStore();
    const current = new SyncEngine(store, getToken);
    engine.current = current;
    reload.current = async () => {
      try {
        const [nextSettings, nextIssues, count] = await Promise.all([store.settings(), store.issues(), store.pendingCount()]);
        if (!alive) return;
        setSettings(nextSettings); setIssues(nextIssues); setPending(count); setStatus({ ...current.status });
        await refresh();
      } catch { if (alive) setStatus({ phase: "blocked", message: "Não foi possível ler o estado local da sincronização." }); }
    };
    const unsubscribe = current.subscribe(() => { void reload.current(); });
    const local = onLocalChange(() => { void reload.current(); void current.request(); });
    const appState = AppState.addEventListener("change", state => {
      if (state !== "active") testController.current?.abort();
      current.setActive(state === "active" && !configBusy.current);
    });
    void reload.current();
    current.setActive(AppState.currentState === "active");
    return () => {
      alive = false; unsubscribe(); local(); appState.remove(); current.setActive(false);
      testController.current?.abort(); engine.current = null;
    };
  }, [ready, refresh]);

  async function configure(urlInput: string, tokenInput: string, save: boolean) {
    if (configBusy.current) return;
    configBusy.current = true; setConfiguring(true);
    const current = engine.current;
    current?.setActive(false);
    try {
      await current?.settled();
      const url = normalizeUrl(urlInput);
      const store = getStore();
      const existing = await store.settings();
      if (existing.url && existing.url !== url) throw new Error("Este banco já está vinculado a outro servidor");
      const token = tokenInput.trim() || await getToken();
      if (!token || token.length < 32) throw new Error("Informe um token de pelo menos 32 caracteres");
      if (AppState.currentState !== "active") throw new Error("Volte ao aplicativo para testar a conexão");
      testController.current = new AbortController();
      await sendSync(url, token, { cursor: 0, operations: [] }, { signal: testController.current.signal });
      if (save) {
        await writeSyncToken(token);
        await store.configure(url);
        await store.clearBlock(AUTH_ERROR);
      }
    } finally {
      testController.current = null; configBusy.current = false; setConfiguring(false);
      if (engine.current === current) current?.setActive(AppState.currentState === "active");
      await reload.current();
    }
  }
  async function migrate(urlInput: string) {
    if (configBusy.current) throw new Error("Aguarde o envio atual");
    configBusy.current = true; setConfiguring(true);
    const current = engine.current;
    current?.setActive(false);
    try {
      await current?.settled();
      const token = await getToken();
      if (!token) throw new SyncError("auth", AUTH_ERROR);
      if (AppState.currentState !== "active") throw new Error("Volte ao aplicativo para migrar o servidor");
      testController.current = new AbortController();
      await migrateServer(getStore(), urlInput, token, { signal: testController.current.signal });
    } finally {
      testController.current = null; configBusy.current = false; setConfiguring(false);
      if (engine.current === current) current?.setActive(AppState.currentState === "active");
      await reload.current();
    }
    void engine.current?.request();
    return MIGRATED;
  }
  return {
    settings, issues, pending, status, configuring, configure, migrate,
    sync: () => engine.current?.request(),
    syncChecked: async () => {
      if (configBusy.current || AppState.currentState !== "active") throw new Error("Sincronização pendente");
      await syncConfirmed(engine.current, getStore());
      if (AppState.currentState !== "active") throw new Error("Sincronização pendente");
    },
    pause: async (paused: boolean) => { await engine.current?.pause(paused); await reload.current(); },
    resolve: async (issue: Issue, choice: "local" | "remote") => {
      await getStore().resolve(issue.entity, issue.id, choice);
      await reload.current(); void engine.current?.request();
    },
  };
}
export type SyncControls = ReturnType<typeof useSync>;
