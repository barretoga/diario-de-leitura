import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { MAX_BACKUP_BYTES, parseBackup, serializeBackup } from "./format";
import type { Backup } from "./format";

export async function shareBackup(backup: Backup) {
  if (!await Sharing.isAvailableAsync()) throw new Error("O compartilhamento de arquivos não está disponível neste aparelho.");
  const text = serializeBackup(backup);
  const name = `leituras-backup-${backup.exportedAt.replace(/[:.]/g, "-")}.json`;
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(text);
  await Sharing.shareAsync(file.uri, { mimeType: "application/json", UTI: "public.json", dialogTitle: "Salvar backup das leituras" });
  // Keep the cache file available for receivers that read it after the share sheet closes.
  return name;
}
export async function pickBackup(): Promise<{ name: string; backup: Backup } | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: false, copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const file = new File(asset.uri);
  if ((asset.size ?? 0) > MAX_BACKUP_BYTES || file.size > MAX_BACKUP_BYTES) throw new Error("Escolha um backup de até 25 MB.");
  return { name: asset.name, backup: parseBackup(await file.text()) };
}
