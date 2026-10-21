import * as SecureStore from "expo-secure-store";
import { SyncError, AUTH_ERROR } from "./transport";
const TOKEN_KEY = "reading-log.sync-token";
export async function readSyncToken(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(TOKEN_KEY); } catch { throw new SyncError("auth", AUTH_ERROR); }
}
export async function writeSyncToken(token: string): Promise<void> {
  try { await SecureStore.setItemAsync(TOKEN_KEY, token); } catch { throw new Error("Não foi possível salvar o token no armazenamento seguro"); }
}
